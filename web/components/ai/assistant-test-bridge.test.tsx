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

afterEach(() => {
  cleanup();
  delete window.__nsAssistant;
  delete window.__NS_ENABLE_TEST_BRIDGE;
  vi.resetModules();
  vi.unstubAllEnvs();
});

/** Import fresh, so the build-time constant is evaluated per test. */
async function renderBridge() {
  const { AssistantTestBridge } = await import("./assistant-test-bridge");
  render(<AssistantTestBridge />);
}

describe("the assistant bridge is compiled out of ordinary production", () => {
  beforeEach(() => {
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
