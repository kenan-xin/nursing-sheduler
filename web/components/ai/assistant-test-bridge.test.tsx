// @vitest-environment jsdom
// The assistant e2e seam must obey the SAME two-condition rule as the scenario
// bridge: compiled out of an ordinary production build, and still opt-in per page in
// a build that did include it.
//
// This matters more here than it does for the scenario bridge, not less. The surface
// below reaches the durable settings row -- the one place the OpenRouter credential
// lives -- so a seam that survived into a shipped bundle would put a credential read
// one `window` assignment away from any same-origin script.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// WARM THE MODULE GRAPH AT FILE SCOPE -- the fix for the 5 s timeout, not a raised
// budget.
//
// `renderBridge()` below re-imports the bridge after `vi.resetModules()` so the
// build-time compile-out constant is re-read for each case. The FIRST of those imports
// also pays Vite's transform of the entire assistant graph behind the component
// (`@/lib/ai/assistant/store` -> clear-repo, repair-options, interruption, lifecycle,
// runtime-stop, Dexie, zustand, `@ag-ui/client`). Measured under a full
// `vitest run lib/ai components/ai`: that cold transform costs ~6.1 s while it contends
// with the 96 other test files' transforms, and only ~60 ms once it is cached. Inside a
// test body it therefore blows the 5 s per-test budget for whichever case runs first --
// the flake this file was filed for. The dynamic import is not the slow part
// (re-evaluation is ~60 ms); the COLD TRANSFORM is.
//
// A static import here does that transform -- and one evaluation -- during the file's
// import phase, which no per-test timeout bounds. Every per-case dynamic import
// afterwards is the cheap re-evaluation, so each case is back to ~60 ms. The module is
// a pure component/constant definition with no import-time side effects, and nothing
// renders from this instance.
import "./assistant-test-bridge";

afterEach(() => {
  cleanup();
  delete window.__nsAssistant;
  delete window.__NS_ENABLE_TEST_BRIDGE;
  vi.unstubAllEnvs();
});

/** Import fresh, so the build-time constant is evaluated per test. */
async function renderBridge() {
  const { AssistantTestBridge } = await import("./assistant-test-bridge");
  render(<AssistantTestBridge />);
}

describe("the assistant bridge is compiled out of ordinary production", () => {
  beforeEach(() => {
    // Reset BEFORE the case, not after it. The file-scope warm import leaves an
    // instance in the registry that was evaluated with `NODE_ENV=test`, so the first
    // case has to invalidate it before its own dynamic import re-reads the constant;
    // an `afterEach`-only reset (the original shape) left that stale instance in place
    // for case one and only helped cases two and three.
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
  });

  it("exposes nothing when the build did not opt in -- even with the runtime flag set", async () => {
    vi.stubEnv("NEXT_PUBLIC_NS_TEST_BRIDGE", "");
    window.__NS_ENABLE_TEST_BRIDGE = true;

    await renderBridge();

    expect(window.__nsAssistant).toBeUndefined();
  });

  it("still requires the per-page opt-in when the build DID include it", async () => {
    vi.stubEnv("NEXT_PUBLIC_NS_TEST_BRIDGE", "1");

    await renderBridge();

    expect(window.__nsAssistant).toBeUndefined();
  });

  it("exposes only real repository operations when the build and page both opt in", async () => {
    vi.stubEnv("NEXT_PUBLIC_NS_TEST_BRIDGE", "1");
    window.__NS_ENABLE_TEST_BRIDGE = true;

    await renderBridge();

    const bridge = window.__nsAssistant;
    expect(bridge).toBeDefined();
    // Exactly this surface, so a later widening is a deliberate edit here too.
    expect(Object.keys(bridge!).sort()).toEqual([
      "activeDiagnostic",
      "appendMessage",
      "clearAll",
      "clearFacts",
      "clearHistory",
      "lastTurn",
      "optimizeBases",
      "ready",
      "selectThread",
      "settings",
      "tableCounts",
      "threadGenerations",
    ]);
    // Operations, not setters: there is nothing here that writes a projection
    // directly, so a spec cannot assert state the repository never committed.
    for (const key of Object.keys(bridge!) as (keyof typeof bridge)[]) {
      expect(typeof bridge![key]).toBe("function");
    }
  });
});
