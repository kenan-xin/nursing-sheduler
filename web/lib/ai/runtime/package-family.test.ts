import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const webRoot = join(__dirname, "..", "..", "..");

// T01 acceptance: record the ACTUALLY RESOLVED family rather than an assumed
// compatibility matrix. A silent float in any of these is a package-family change
// that has to go back through the plan, not a lockfile refresh.
const PINNED = {
  "@copilotkit/react-core": "1.66.2",
  "@copilotkit/runtime": "1.66.2",
  ai: "6.0.104",
  "@ai-sdk/openai": "3.0.36",
  "@ag-ui/client": "0.0.57",
  rxjs: "7.8.1",
} as const;

function resolvedVersion(name: string): string {
  return (require(`${name}/package.json`) as { version: string }).version;
}

describe("locked CopilotKit package family", () => {
  it("resolves each direct dependency to the exact pinned version", () => {
    for (const [name, version] of Object.entries(PINNED)) {
      expect(resolvedVersion(name), `${name} drifted`).toBe(version);
    }
  });

  it("declares them as exact pins, never ranges", () => {
    const manifest = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(PINNED)) {
      expect(manifest.dependencies[name], `${name} is not an exact pin`).toBe(version);
    }
  });

  it("keeps the runtime's own AI SDK on the same version this app calls", () => {
    // The runtime pulls `ai` and `@ai-sdk/openai` transitively. A split here would
    // mean CopilotKit's converters and this app's `streamText` were built against
    // different SDK behaviour, not just different peer brands.
    const runtimeRequire = createRequire(require.resolve("@copilotkit/runtime/package.json"));
    expect((runtimeRequire("ai/package.json") as { version: string }).version).toBe(PINNED.ai);
    expect((runtimeRequire("@ai-sdk/openai/package.json") as { version: string }).version).toBe(
      PINNED["@ai-sdk/openai"],
    );
  });

  it("crosses the dual-`ai`-instance boundary via Standard Schema, not a shared brand", async () => {
    // Load-bearing for `toAppToolSet` in openrouter-agent.ts, and the single place
    // the locked family is genuinely awkward: TWO copies of `ai@6.0.104` are
    // installed because @copilotkit/runtime peers zod 3 while this app uses zod 4.
    //
    // CopilotKit's converter emits a zod-3 schema object, which this app's
    // zod-4-peered `streamText` accepts because it carries the Standard Schema v1
    // interface -- a version-independent protocol, not an AI-SDK-internal brand. If
    // an upgrade ever drops `~standard`, tool definitions would stop validating
    // across the boundary, and this is the test that says so.
    const { convertToolsToVercelAITools } = await import("@copilotkit/runtime/v2");
    const converted = convertToolsToVercelAITools([
      {
        name: "probe",
        description: "probe",
        parameters: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      },
    ]);

    const schema = converted.probe.inputSchema as unknown as {
      "~standard"?: { version: number; vendor: string };
    };
    expect(schema["~standard"]).toMatchObject({ version: 1, vendor: "zod" });
    // The dynamic import evaluates the whole `@copilotkit/runtime/v2` entrypoint --
    // by far the heaviest module load in the suite. Under the full parallel run that
    // cold load alone can exceed the 5s default, so this ONE test gets an explicit
    // budget instead of the global `testTimeout` being raised for every test.
  }, 30_000);
});
