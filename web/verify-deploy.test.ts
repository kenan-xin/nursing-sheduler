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
    const up = executableCommand("$COMPOSE up -d ");
    const ref = up.match(/PUBLIC_ORIGIN="\$([A-Z_]+)"/);
    if (!ref || !ref[1]) {
      throw new Error('compose-up command lacks a PUBLIC_ORIGIN="$…" env prefix');
    }
    expectValidAbsoluteHttpOrigin(resolvePorts(scriptConstant(ref[1])));
  });

  it("passes a valid absolute origin to the deliberate-mismatch container", () => {
    const run = executableCommand("docker run ");
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
});
