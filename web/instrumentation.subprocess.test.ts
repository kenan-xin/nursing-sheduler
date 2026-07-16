import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

// End-to-end proof that invalid BFF config makes the REAL standalone server
// process-fatal (not a live 500-serving process). Requires a prior `next build`
// (produces `.next/standalone/server.js`); skipped with a note when absent so it
// never silently "passes" without the artifact.
const SERVER = path.resolve(process.cwd(), ".next/standalone/server.js");
const hasBuild = existsSync(SERVER);

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

interface Outcome {
  exitCode: number | null;
  becameServiceable: boolean;
}

function runServer(
  env: Record<string, string | undefined>,
  port: number,
  timeoutMs = 8_000,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(process.execPath, [SERVER], {
      cwd: path.dirname(SERVER),
      env: { ...env, PORT: String(port) } as unknown as NodeJS.ProcessEnv,
      stdio: "ignore",
    });

    let settled = false;
    let becameServiceable = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve({ exitCode, becameServiceable });
    };

    child.once("exit", (code) => finish(code));

    const poll = setInterval(async () => {
      if (await tryConnect(port)) {
        becameServiceable = true;
        finish(child.exitCode);
      }
    }, 200);

    const timer = setTimeout(() => finish(child.exitCode), timeoutMs);
  });
}

describe.skipIf(!hasBuild)("standalone server config fail-fast (subprocess)", () => {
  it("exits non-zero and never binds when config is invalid", async () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.BACKEND_API_URL;
    delete env.PUBLIC_ORIGIN;
    env.NODE_ENV = "production";

    const outcome = await runServer(env, 34571);

    expect(outcome.becameServiceable).toBe(false);
    expect(outcome.exitCode).not.toBeNull();
    expect(outcome.exitCode).not.toBe(0);
  }, 20_000);

  it("binds and becomes serviceable when config is valid", async () => {
    const env: Record<string, string | undefined> = { ...process.env };
    env.NODE_ENV = "production";
    env.BACKEND_API_URL = "http://127.0.0.1:9";
    env.PUBLIC_ORIGIN = "http://localhost:34572";

    const outcome = await runServer(env, 34572);

    expect(outcome.becameServiceable).toBe(true);
  }, 20_000);
});

describe.skipIf(hasBuild)("standalone server config fail-fast (subprocess)", () => {
  it.skip("skipped: no .next/standalone/server.js — run `pnpm build` first", () => {});
});
