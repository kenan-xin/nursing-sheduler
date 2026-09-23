import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// G6.1 durable root cause (2026-08-09). `scripts/dev.sh` defaulted BACKEND_REPO to
// a SIBLING checkout and started its backend, so a developer running this app was
// implicitly served by a foreign repository's route table. A sibling predating
// `GET /optimize/{job_id}/roster` answered that path with FastAPI's generic
// `404 {"detail":"Not Found"}` — every completed run downloaded its XLSX and then
// said its roster could not be saved, with nothing in the setup pointing at the
// real cause.
//
// These tests pin the inverted contract at the two boundaries that decide it:
// the resolved launch PLAN (which backend, from where) and the capability PROBE
// (does the thing actually answering serve rosters). Both script modes are
// side-effect free, so nothing here starts a server on :8000 or touches a
// developer's running stack.

const repoRoot = join(__dirname, "..");
const devScript = join(repoRoot, "scripts", "dev.sh");

interface Plan {
  backend_source: string;
  backend_dir: string;
  backend_cmd: string;
  backend_api_url: string;
  backend_bind_host: string;
  backend_bind_port: string;
  backend_launch_refused: string;
  web_dir: string;
}

// Run the script's pure `--plan` mode under an explicit environment. `env` values
// of `undefined` are removed, so "unset" is testable distinctly from "blank".
function plan(env: Record<string, string | undefined> = {}): Plan {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // Never inherit the developer's own selection — that would make the default
  // case untestable on a machine that happens to export BACKEND_REPO.
  delete childEnv.BACKEND_REPO;
  delete childEnv.BACKEND_API_URL;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }

  const result = spawnSync("bash", [devScript, "--plan"], {
    env: childEnv,
    encoding: "utf8",
    cwd: repoRoot,
  });
  expect(result.status, `--plan failed: ${result.stderr}`).toBe(0);

  const parsed: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) parsed[line.slice(0, at)] = line.slice(at + 1);
  }
  return parsed as unknown as Plan;
}

describe("dev.sh backend selection — this repo is the implicit default", () => {
  it("defaults to THIS repository's core/, not a sibling checkout", () => {
    const resolved = plan({ BACKEND_REPO: undefined });

    expect(resolved.backend_source).toBe("repo-core");
    expect(resolved.backend_dir).toBe(join(repoRoot, "core"));
    // Serves the same ASGI app the Docker image does, from this worktree.
    expect(resolved.backend_cmd).toContain("uvicorn");
    expect(resolved.backend_cmd).toContain("nurse_scheduling.serve:app");
    // The regression in one assertion: no sibling path may appear anywhere in the
    // resolved plan when nothing was explicitly selected.
    expect(resolved.backend_cmd).not.toContain("nurse-scheduling");
    expect(resolved.backend_dir).not.toContain("nurse-scheduling");
  });

  it("uses an external backend ONLY when BACKEND_REPO is explicitly set", () => {
    const resolved = plan({ BACKEND_REPO: "/tmp/some-other-backend" });

    expect(resolved.backend_source).toBe("external");
    expect(resolved.backend_dir).toBe("/tmp/some-other-backend");
    expect(resolved.backend_cmd).toBe("/tmp/some-other-backend/scripts/start_backend.sh");
  });

  it("treats an exported-but-blank BACKEND_REPO as no selection at all", () => {
    // A blank value is a misconfiguration, never a half-selection that would
    // leave the launcher with no path to start.
    expect(plan({ BACKEND_REPO: "" }).backend_source).toBe("repo-core");
  });

  // THE SOURCE-PATTERN BACKSTOP IS GONE. It read `scripts/dev.sh` as text and
  // regex-matched it for `${BACKEND_REPO:-…}` and a literal sibling path — a
  // repository-owned pseudo-parser over an implementation's spelling. What it claimed
  // is already owned, more strongly, by BEHAVIOUR: the `--plan` cases above prove the
  // resolved `backend_source` is `repo-core` for unset, blank and explicit selections,
  // and the live-launch cases below prove the script really starts THIS repository's
  // backend and refuses to adopt one it did not select. A sibling default reintroduced
  // under any variable name changes `backend_source`, so it fails there — by outcome,
  // not by spelling.

  it("honours BACKEND_API_URL and keeps the frontend pointed at web/", () => {
    const resolved = plan({ BACKEND_API_URL: "http://127.0.0.1:9123" });
    expect(resolved.backend_api_url).toBe("http://127.0.0.1:9123");
    expect(resolved.web_dir).toBe(join(repoRoot, "web"));
  });
});

// BACKEND_API_URL used to be advertised, probed and then ignored: the repo-core
// command hardcoded `127.0.0.1:8000`, so an override started the backend on 8000,
// waited on the override until it failed, and reported the backend unreachable.
// One variable decides both ends now — and a URL this script cannot serve is
// refused with a reason instead of quietly falling back to the default.
describe("dev.sh binds where BACKEND_API_URL says", () => {
  it("derives the uvicorn host and port from the override", () => {
    const resolved = plan({ BACKEND_API_URL: "http://127.0.0.1:9123" });
    expect(resolved.backend_bind_host).toBe("127.0.0.1");
    expect(resolved.backend_bind_port).toBe("9123");
    expect(resolved.backend_launch_refused).toBe("");
    // The exact regression, in one assertion: the command must name the
    // configured port and must NOT name the old hardcoded one.
    expect(resolved.backend_cmd).toContain("--port 9123");
    expect(resolved.backend_cmd).not.toContain("8000");
  });

  it("still defaults to 127.0.0.1:8000 when nothing is set", () => {
    const resolved = plan();
    expect(resolved.backend_bind_host).toBe("127.0.0.1");
    expect(resolved.backend_bind_port).toBe("8000");
    expect(resolved.backend_cmd).toContain("--port 8000");
  });

  it.each([
    ["a remote host", "http://api.example.com:8000", "remote-host"],
    ["an https URL", "https://127.0.0.1:8443", "tls"],
    ["a path prefix", "http://127.0.0.1:8000/api", "path"],
  ])("refuses %s with a reason and NO command", (_label, url, reason) => {
    const resolved = plan({ BACKEND_API_URL: url });
    expect(resolved.backend_launch_refused).toBe(reason);
    // The important half: no command at all, rather than one bound somewhere the
    // app is not looking.
    expect(resolved.backend_cmd).toBe("");
  });

  it("leaves an EXTERNAL backend's own start script alone", () => {
    // The override describes where to reach it, not how to start it.
    const resolved = plan({
      BACKEND_REPO: "/tmp/some-other-backend",
      BACKEND_API_URL: "http://api.example.com:8000",
    });
    expect(resolved.backend_source).toBe("external");
    expect(resolved.backend_cmd).toBe("/tmp/some-other-backend/scripts/start_backend.sh");
  });
});

// The second half of the fix. Selecting the right backend is not enough when a
// foreign process already owns the port: uvicorn cannot bind, and the app talks
// to the squatter. The launcher therefore probes whatever actually answers.
describe("dev.sh capability probe — what is actually answering the port", () => {
  let server: Server;
  let base: string;
  let document: unknown = null;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url !== "/openapi.json" || document === null) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "Not Found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(document));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Deliberately async: the stub upstream lives in THIS process, so a blocking
  // `spawnSync` would stall the event loop and the probe would time out against
  // a server that never gets to answer.
  function check(url: string): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn("bash", [devScript, "--check-backend", url], { cwd: repoRoot });
      child.on("close", (code) => resolve(code ?? -1));
    });
  }

  const paths = (...routes: string[]) => ({
    paths: Object.fromEntries(routes.map((route) => [route, { get: {} }])),
  });

  it("accepts a backend that serves the roster route", async () => {
    document = paths("/optimize", "/optimize/{job_id}/xlsx", "/optimize/{job_id}/roster");
    await expect(check(base)).resolves.toBe(0);
  });

  it("REJECTS the reproduced stale backend: xlsx present, roster absent", async () => {
    // Byte-for-byte the shape captured from the user's machine on 2026-08-09 —
    // the sibling checkout's route table, which is why the download worked and
    // the roster did not.
    document = paths(
      "/",
      "/info",
      "/optimize",
      "/optimize/{job_id}",
      "/optimize/{job_id}/cancel",
      "/optimize/{job_id}/events",
      "/optimize/{job_id}/finish-now",
      "/optimize/{job_id}/xlsx",
      "/ready",
    );
    await expect(check(base)).resolves.toBe(1);
  });

  it("reports 'nothing there' distinctly from 'there but unsupported'", async () => {
    // Distinct exit codes because they call for opposite actions: start a
    // backend, versus stop the wrong one that is already running.
    document = null;
    await expect(check(base)).resolves.toBe(2);
    await expect(check("http://127.0.0.1:1")).resolves.toBe(2);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    document = paths("/optimize/{job_id}/roster");
    await expect(check(`${base}/`)).resolves.toBe(0);
  });
});

// ROUTE COMPATIBILITY IS NOT PROVENANCE.
//
// Refusing an INCOMPATIBLE squatter (above) was only half the fix. A COMPATIBLE
// one answers `/openapi.json` exactly like this repository's backend does, and the
// launcher used to adopt it — in the implicit default too. That reproduces the
// G6.1 root cause one layer down: a foreign PROCESS becomes the source of truth
// for a launch that never selected it, where before it was a foreign REPOSITORY.
//
// These run the script for real against a stub that IS roster-capable, and pin
// the two halves of the contract: the default owns its backend and refuses; the
// explicit external selection may adopt, because a developer named it.
describe("dev.sh will not adopt a backend it did not select", () => {
  let squatter: Server;
  let port = 0;
  let shim = "";
  let externalRepo = "";

  beforeAll(async () => {
    squatter = createServer((request, response) => {
      if (request.url !== "/openapi.json") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "Not Found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      // Fully compatible: it serves the roster route. Nothing about this response
      // distinguishes it from this repo's own backend, which is the whole point.
      response.end(JSON.stringify({ paths: { "/optimize/{job_id}/roster": { get: {} } } }));
    });
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", () => resolve()));
    port = (squatter.address() as AddressInfo).port;

    // `pnpm` is shadowed so the frontend half never starts and never takes :3000.
    shim = mkdtempSync(join(tmpdir(), "dev-launcher-adopt-pnpm-"));
    writeFileSync(join(shim, "pnpm"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });

    // A minimal external checkout: the pre-flight only requires its start script
    // to be executable, and adoption means it is never run.
    externalRepo = mkdtempSync(join(tmpdir(), "dev-launcher-external-"));
    mkdirSync(join(externalRepo, "scripts"), { recursive: true });
    writeFileSync(
      join(externalRepo, "scripts", "start_backend.sh"),
      "#!/bin/sh\necho 'the external start script must NOT run when adopting' >&2\nexec sleep 600\n",
      { mode: 0o755 },
    );
  });

  afterAll(async () => {
    squatter.closeAllConnections?.();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    rmSync(shim, { recursive: true, force: true });
    rmSync(externalRepo, { recursive: true, force: true });
  });

  /**
   * Run the launcher for real against the squatter, collecting output until it
   * either exits or says something the caller is waiting for.
   *
   * Async on purpose: the stub lives in THIS process, so a blocking spawn would
   * stall the event loop and the launcher's probe would time out against a server
   * that never gets to answer.
   */
  function launch(
    env: Record<string, string>,
    settle: (output: string) => boolean,
  ): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn("bash", [devScript], {
        cwd: repoRoot,
        detached: true,
        env: {
          ...process.env,
          PATH: `${shim}:${process.env.PATH ?? ""}`,
          BACKEND_API_URL: `http://127.0.0.1:${port}`,
          BACKEND_REPO: "",
          ...env,
        },
      });
      let output = "";
      let done = false;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          // Already gone.
        }
        resolve({ code, output });
      };
      const observe = (chunk: Buffer) => {
        output += chunk.toString();
        if (settle(output)) finish(null);
      };
      child.stdout.on("data", observe);
      child.stderr.on("data", observe);
      child.on("close", (code) => finish(code));
      const timer = setTimeout(() => finish(null), 30_000);
    });
  }

  it("DEFAULT mode refuses a route-compatible process it did not start", async () => {
    const { code, output } = await launch({}, () => false);

    expect(code, "the default launch must stop rather than adopt").not.toBe(0);
    // The refusal has to say WHY, or it reads as the launcher being broken.
    expect(output).toContain("DOES provide");
    expect(output).toContain("cannot tell what it is");
    expect(output).toContain("not the same as being the right backend");
    // ...and name both ways forward.
    expect(output).toContain("lsof");
    expect(output).toContain("BACKEND_REPO=<path>");
    // It must NOT have gone on to the frontend.
    expect(output).not.toContain("Starting frontend");
  }, 60_000);

  it("EXPLICIT external mode may adopt the very same process", async () => {
    const { output } = await launch({ BACKEND_REPO: externalRepo }, (text) =>
      text.includes("Starting frontend"),
    );

    expect(output).toContain("reusing it");
    expect(output).toContain(`Adopted under the explicit selection BACKEND_REPO=${externalRepo}`);
    // Adoption means the external start script was never run — the port is taken.
    expect(output).not.toContain("the external start script must NOT run");
    expect(output).toContain("Starting frontend");
  }, 60_000);
});

// THE REAL LAUNCH. Everything above reads the script's own plan, which is exactly
// how the previous version of this bug survived: `--plan` printed the configured
// URL, the assertions agreed with it, and the command it would actually run bound
// somewhere else entirely. The only thing that can catch that is starting the
// backend for real and asking the CONFIGURED URL what it serves.
//
// `pnpm` is shadowed by a no-op for the duration. The frontend half is not under
// test and starting it would take port 3000 out from under whatever a developer
// already has running — which is a side effect a unit suite has no business
// having. The backend half is entirely real: this repository's uvicorn, its ASGI
// app, and the OpenAPI document it actually serves.
describe("dev.sh really starts the backend where BACKEND_API_URL points", () => {
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it("serves the roster route on a free NON-DEFAULT port", async () => {
    const port = await freePort();
    expect(port, "the whole point is a port that is not the hardcoded one").not.toBe(8000);

    const shim = mkdtempSync(join(tmpdir(), "dev-launcher-pnpm-"));
    writeFileSync(join(shim, "pnpm"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });

    const child = spawn("bash", [devScript], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${shim}:${process.env.PATH ?? ""}`,
        BACKEND_API_URL: `http://127.0.0.1:${port}`,
        BACKEND_REPO: "",
      },
    });

    try {
      const deadline = Date.now() + 90_000;
      let servedRoster = false;
      while (Date.now() < deadline && !servedRoster) {
        if (child.exitCode !== null) break;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/openapi.json`);
          if (response.ok) {
            const body = (await response.json()) as { paths?: Record<string, unknown> };
            servedRoster = Object.hasOwn(body.paths ?? {}, "/optimize/{job_id}/roster");
          }
        } catch {
          // Not up yet.
        }
        if (!servedRoster) await new Promise((resolve) => setTimeout(resolve, 500));
      }

      expect(
        servedRoster,
        `nothing served the roster route at the configured port ${port} — the launcher bound elsewhere`,
      ).toBe(true);
    } finally {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // Already gone.
      }
      rmSync(shim, { recursive: true, force: true });
    }
  }, 120_000);
});
