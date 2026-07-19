import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static guard for the completion-audit P0 (2026-07-18): verify-deploy.sh started
// the production Compose stack without PUBLIC_ORIGIN, compose.yml injected it as
// a present-but-blank value, and the web runtime correctly refused to boot — so
// `make verify-deploy` could never go green. These checks pin the repaired
// contract without running Docker: the gate supplies a valid absolute origin to
// every web container it starts, while Compose and `make build` keep the
// production rules (blank fails closed; no runtime origin needed to build).
// Runtime validation behavior stays covered by lib/backend.test.ts and
// instrumentation.test.ts, which this guard must not weaken. Origin checks bind
// to the EXECUTABLE commands (comments/blank lines excluded, continuations
// joined), so a commented-out or merely-mentioned invocation cannot pass.

const repoRoot = join(__dirname, "..");
const script = readFileSync(join(repoRoot, "docker", "verify-deploy.sh"), "utf8");
const compose = readFileSync(join(repoRoot, "docker", "compose.yml"), "utf8");
const makefile = readFileSync(join(repoRoot, "Makefile"), "utf8");

// A `NAME=value` line in verify-deploy.sh (quotes optional).
function scriptConstant(name: string): string {
  const match = script.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, "m"));
  if (!match || !match[1]) {
    throw new Error(`no ${name}=… assignment in verify-deploy.sh`);
  }
  return match[1];
}

// Substitute ${WEB_PORT} / ${MIS_PORT} from the script's own constants so the
// resulting origin can be URL-parsed.
function resolvePorts(value: string): string {
  return value.replace(/\$\{(WEB_PORT|MIS_PORT)\}/g, (_m, name) => scriptConstant(name));
}

function expectValidAbsoluteHttpOrigin(value: string): void {
  // URL throws on a non-absolute or unparseable value, failing the test.
  const url = new URL(value);
  expect(["http:", "https:"]).toContain(url.protocol);
}

// Logical executable commands in verify-deploy.sh: continuation lines joined,
// comments and blank lines dropped.
function executableCommands(): string[] {
  return script
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// The single executable command containing `marker`.
function executableCommand(marker: string): string {
  const matches = executableCommands().filter((line) => line.includes(marker));
  if (matches.length !== 1) {
    throw new Error(`expected 1 executable '${marker}' command, found ${matches.length}`);
  }
  return matches[0];
}

describe("verify-deploy PUBLIC_ORIGIN contract", () => {
  it("passes a valid absolute origin to the Compose stack it starts", () => {
    // Match the full-stack bring-up specifically: it redirects with `>` right after
    // `-d`, while the single-service recovery ups are `$COMPOSE up -d redis`.
    const up = executableCommand("$COMPOSE up -d >");
    const ref = up.match(/PUBLIC_ORIGIN="\$([A-Z_]+)"/);
    if (!ref || !ref[1]) {
      throw new Error('compose-up command lacks a PUBLIC_ORIGIN="$…" env prefix');
    }
    expectValidAbsoluteHttpOrigin(resolvePorts(scriptConstant(ref[1])));
  });

  it("passes a valid absolute origin to the deliberate-mismatch container", () => {
    // Match the detached mismatch container (`docker run -d …`); the network
    // reachability probes are foreground `docker run --rm --network …` with no `-d`.
    const run = executableCommand("docker run -d ");
    const env = run.match(/-e PUBLIC_ORIGIN="([^"]+)"/);
    if (!env || !env[1]) {
      throw new Error("deliberate-mismatch container is started without -e PUBLIC_ORIGIN");
    }
    expectValidAbsoluteHttpOrigin(resolvePorts(env[1]));
  });

  it("keeps Compose blank-injection — no silent origin fallback", () => {
    expect(compose).toContain("PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:-}");
  });

  it("keeps `make build` independent of the runtime origin", () => {
    const recipe = makefile.match(/^build:[^\n]*(?:\n\t[^\n]*)*/m);
    if (!recipe) throw new Error("no build target in Makefile");
    expect(recipe[0]).not.toContain("PUBLIC_ORIGIN");
  });

  it("bounds and cleans every named network probe", () => {
    expect(script).toContain('timeout --foreground --kill-after="${PROBE_KILL_GRACE_SECONDS}s"');
    expect(script).toContain('docker run --rm --name "$name" --network "$net"');
    expect(script).toContain('docker rm -f "$name"');
    expect(script).toContain('name="${PROJECT}-probe-${id}"');
    expect(script).toContain("trap 'exit 130' INT");
    expect(script).toContain("trap 'exit 143' TERM");

    const reachabilityCalls = executableCommands().filter((line) =>
      line.startsWith("expect_reach "),
    );
    expect(reachabilityCalls).toHaveLength(6);
    const probeIds = reachabilityCalls.map((line) => line.split(/\s+/)[1]);
    expect(new Set(probeIds).size).toBe(probeIds.length);
  });

  it("keeps timeout and ordinary-failure sensitivity checks load-bearing", () => {
    expect(script).toContain("'import time; time.sleep(60)'");
    expect(script).toContain('"$timeout_probe" 1 "${PROJECT}_app"');
    expect(script).toContain('"$timeout_result" = probe-timeout');
    expect(script).toContain('! docker inspect "$timeout_probe"');
    expect(script).toContain("'raise SystemExit(7)'");
    expect(script).toContain('"$failure_result" = probe-error');
    expect(script).toContain('! docker inspect "$failure_probe"');
  });
});

// Node WHATWG `URL.origin` differential (closure review F5). This corpus lives in
// the test rather than the validator so production and oracle inputs cannot drift
// together. Each case invokes the same CLI used by the Make guards.
const PYTHON = process.env.PYTHON ?? "python3";
const VALIDATOR = join(repoRoot, "docker", "validate_origin.py");
type OriginMode = "direct" | "cloudflare";
type OriginCase = readonly [value: string, mode: OriginMode];

const requiredBareBrackets: readonly OriginCase[] = [
  ["https://a[b", "direct"],
  ["https://a[b", "cloudflare"],
  ["https://a]b", "direct"],
  ["https://a]b", "cloudflare"],
];

const originCasesByCategory = {
  bareBrackets: [
    ["https://a[b", "direct"],
    ["https://a[b", "cloudflare"],
    ["https://a]b", "direct"],
    ["https://a]b", "cloudflare"],
  ],
  zones: [
    ["https://[fe80::1%eth0]", "direct"],
    ["https://[fe80::1%eth0]", "cloudflare"],
    ["https://[fe80::1%25eth0]", "direct"],
    ["https://[fe80::1%25eth0]", "cloudflare"],
  ],
  malformedAuthorities: [
    ["", "direct"],
    ["https://", "cloudflare"],
    ["https://:3000", "direct"],
    ["https://[::1", "cloudflare"],
    ["https://[gggg::1]", "cloudflare"],
    ["https://[::1]tail", "cloudflare"],
    ["https://host:", "cloudflare"],
    ["https://host:notaport", "cloudflare"],
    ["https://host:99999", "cloudflare"],
  ],
  oddDns: [
    ["https://foo_bar.example", "cloudflare"],
    ["https://foo~bar.example", "cloudflare"],
    ["https://-x.example", "cloudflare"],
    ["https://x-.example", "cloudflare"],
    ["https://a..b", "cloudflare"],
    ["https://example..", "cloudflare"],
    ["https://example.com.", "cloudflare"],
    ["https://EXAMPLE.COM", "cloudflare"],
    ["https://ho^st", "cloudflare"],
    ["https://ho|st", "cloudflare"],
    ["https://bücher.example", "cloudflare"],
  ],
  ipv4: [
    ["http://127.0.0.1", "direct"],
    ["http://192.168.1.50:3000", "direct"],
    ["http://999.999.999.999", "direct"],
    ["http://192.168.001.1", "direct"],
    ["http://0x7f.0.0.1", "direct"],
    ["http://192.168.1.50.", "direct"],
  ],
  ipv6: [
    ["https://[::1]", "direct"],
    ["https://[2001:db8::1]", "cloudflare"],
    ["https://[2001:db8::1]:8443", "cloudflare"],
    ["https://[0:0:0:0:0:0:0:1]", "cloudflare"],
    ["https://[::ffff:c000:280]", "cloudflare"],
    ["https://[::ffff:192.0.2.128]", "cloudflare"],
  ],
  ports: [
    ["https://example.com:8443", "cloudflare"],
    ["https://example.com:443", "cloudflare"],
    ["http://example.com:80", "direct"],
    ["https://example.com:0443", "cloudflare"],
    ["https://example.com:65535", "cloudflare"],
    ["https://example.com:0", "cloudflare"],
  ],
  controlsAndPercentEncoding: [
    ["  https://host", "cloudflare"],
    ["https://host\x01", "direct"],
    ["https://host\x7f", "cloudflare"],
    ["https://host\x85", "cloudflare"],
    ["https://ex%41mple.com", "cloudflare"],
    ["https://example%2ecom", "cloudflare"],
    ["https://ho%5Est", "cloudflare"],
  ],
  userinfoAndSuffixes: [
    ["https://user:pass@host", "cloudflare"],
    ["https://host/", "cloudflare"],
    ["https://host/path", "cloudflare"],
    ["https://host?q=1", "cloudflare"],
    ["https://host#frag", "cloudflare"],
  ],
  schemes: [
    ["http://localhost:3000", "direct"],
    ["http://localhost:3000", "cloudflare"],
    ["https://scheduler.example.com", "direct"],
    ["https://scheduler.example.com", "cloudflare"],
    ["ftp://host", "direct"],
    ["scheduler.example.com", "direct"],
    ["HTTPS://example.com", "cloudflare"],
  ],
} as const satisfies Record<string, readonly OriginCase[]>;

const originCases = Object.values(originCasesByCategory).flat();

// The browser oracle: a raw origin is valid iff it parses, its scheme fits the
// mode, it carries no userinfo, and it already equals its own `URL.origin`.
function browserOriginValid(value: string, mode: OriginMode): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (mode === "cloudflare" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return url.origin === value;
}

describe("validate_origin.py matches Node URL.origin (WHATWG parity)", () => {
  it("retains the reviewed bare-bracket cases in both modes", () => {
    expect(originCasesByCategory.bareBrackets).toEqual(requiredBareBrackets);
  });

  it("agrees with the browser for the independent adversarial corpus", () => {
    const divergences = originCases.flatMap(([value, mode]) => {
      const result = spawnSync(PYTHON, [VALIDATOR, mode], {
        encoding: "utf-8",
        env: { ...process.env, PUBLIC_ORIGIN: value },
      });
      expect([0, 1], result.stderr).toContain(result.status);
      const validatorValid = result.status === 0;
      if (!validatorValid && value !== "") {
        expect(result.stderr).not.toContain(value);
      }
      return validatorValid === browserOriginValid(value, mode)
        ? []
        : [{ value, mode, validatorValid }];
    });
    expect(divergences, `python/browser divergence: ${JSON.stringify(divergences)}`).toEqual([]);
  });
});
