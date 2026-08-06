import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTAINMENT_ENV, applyRuntimeContainmentEnv } from "./containment";

const runtimeDir = __dirname;
const webRoot = join(runtimeDir, "..", "..", "..");

describe("containment env", () => {
  it("is already applied by the time this suite's runtime modules are loaded", () => {
    // `copilot-runtime.test.ts` imports the handler, which imports containment.ts
    // first; this asserts the resulting process state directly.
    for (const [name, value] of Object.entries(CONTAINMENT_ENV)) {
      expect(process.env[name]).toBe(value);
    }
  });

  it("overrides an operator attempt to re-enable telemetry", () => {
    process.env.COPILOTKIT_TELEMETRY_DISABLED = "false";
    applyRuntimeContainmentEnv();
    expect(process.env.COPILOTKIT_TELEMETRY_DISABLED).toBe("true");
  });
});

describe("import-order guard", () => {
  // Load-bearing and invisible at runtime: @copilotkit/runtime's telemetry client
  // snapshots the opt-out env when its module is first evaluated, so containment.ts
  // has to be evaluated first. ESM evaluates imports in declaration order, which
  // makes this a source-level property worth pinning rather than rediscovering.
  it("puts ./containment before any @copilotkit import in every runtime module", () => {
    const modules = readdirSync(runtimeDir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(modules.length).toBeGreaterThan(0);

    for (const name of modules) {
      const source = readFileSync(join(runtimeDir, name), "utf8");
      const copilotImport = source.search(/^import\b[^;]*"@copilotkit\//m);
      if (copilotImport === -1) continue;

      const containmentImport = source.search(/^import\b[^;]*"\.\/containment"/m);
      expect(containmentImport, `${name} imports @copilotkit without ./containment`).not.toBe(-1);
      expect(containmentImport, `${name} imports @copilotkit before ./containment`).toBeLessThan(
        copilotImport,
      );
    }
  });

  it("keeps the CopilotKit runtime out of every module outside lib/ai/runtime", () => {
    // Phase 1 mounts exactly one runtime, from one place. A stray import elsewhere
    // would bypass both the containment env ordering and the single-runtime
    // instance identity.
    const offenders = walk(webRoot).filter((file) => {
      if (file.startsWith(runtimeDir)) return false;
      return /from "@copilotkit\/runtime/.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});

const SKIP_DIRS = new Set(["node_modules", ".next", "public", "test-results", "playwright-report"]);

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}
