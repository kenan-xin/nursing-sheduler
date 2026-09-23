import { afterEach, describe, expect, it, vi } from "vitest";

import { CONTAINMENT_ENV, applyRuntimeContainmentEnv } from "./containment";

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

describe("the single production runtime entry", () => {
  afterEach(() => {
    // Whatever the fresh-registry test did to the env, the rest of the process must
    // go back to being contained.
    applyRuntimeContainmentEnv();
    vi.resetModules();
  });

  it("applies containment by being imported at all, with the env starting unset", async () => {
    // THE CAUSAL CLAIM, replacing the old source-order scan. Delete `import
    // "./containment"` from `copilotkit-runtime.ts` and this fails: nothing else in
    // the import graph of that module sets the env.
    for (const name of Object.keys(CONTAINMENT_ENV)) delete process.env[name];
    vi.resetModules();

    await import("./copilotkit-runtime");

    for (const [name, value] of Object.entries(CONTAINMENT_ENV)) {
      expect(process.env[name], name).toBe(value);
    }
  });

  it("re-exports the runtime symbols production actually uses", async () => {
    // Non-vacuity for the test above: an entry module that re-exported nothing would
    // still "apply containment", and would also have quietly stopped being the route
    // to the runtime.
    const entry = await import("./copilotkit-runtime");
    for (const name of [
      "AgentRunner",
      "BuiltInAgent",
      "CopilotRuntime",
      "convertMessagesToVercelAISDKMessages",
      "convertToolsToVercelAITools",
      "createCopilotRuntimeHandler",
    ]) {
      expect(Reflect.get(entry, name), name).toBeTypeOf("function");
    }
  });
});

// MIGRATED IN TICKET 3. The dynamic/`require`/node_modules-relative acquisition of
// `@copilotkit/runtime` is now `ast-grep/rules/copilotkit-runtime-acquisition.yml`.
// Oxlint still owns the STATIC route and remains the primary mechanism; the rule covers
// the three DECLARED acquisition shapes it cannot see. It is not a claim that the bytes
// could not arrive some other way -- ticket 6 owns the repository-wide version.
