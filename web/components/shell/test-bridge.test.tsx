// @vitest-environment jsdom
// T03F1 finding 7 — the test bridge must not exist in an ordinary production build,
// and what it does expose must not be able to write.
//
// The reviewed bridge shipped in every production bundle behind a runtime `window`
// flag and published the Zustand store api itself. Both halves were bypasses: any
// same-origin script that set the flag could call `.setState` and publish scenario
// state with no repository commit behind it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return actual;
});

afterEach(() => {
  cleanup();
  delete window.__nsStore;
  delete window.__NS_ENABLE_TEST_BRIDGE;
  vi.resetModules();
  vi.unstubAllEnvs();
});

/** Import the bridge fresh, so its build-time constant is evaluated per test. */
async function renderBridge() {
  const { TestBridge } = await import("./test-bridge");
  render(<TestBridge />);
}

describe("the bridge is compiled out of ordinary production", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  it("exposes nothing when the build did not opt in — even with the runtime flag set", async () => {
    // The old escape hatch: a production bundle plus an early script setting the
    // flag. There is no bridge code in that build to switch on now.
    vi.stubEnv("NEXT_PUBLIC_NS_TEST_BRIDGE", "");
    window.__NS_ENABLE_TEST_BRIDGE = true;

    await renderBridge();

    expect(window.__nsStore).toBeUndefined();
  });

  it("still requires the per-page opt-in when the build DID include it", async () => {
    // Both conditions must hold: an e2e build without the harness's init script
    // exposes nothing either.
    vi.stubEnv("NEXT_PUBLIC_NS_TEST_BRIDGE", "1");

    await renderBridge();

    expect(window.__nsStore).toBeUndefined();
  });

  it("exposes a READ-ONLY surface when the build and the page both opt in", async () => {
    vi.stubEnv("NEXT_PUBLIC_NS_TEST_BRIDGE", "1");
    window.__NS_ENABLE_TEST_BRIDGE = true;

    await renderBridge();

    const bridge = window.__nsStore;
    expect(bridge).toBeDefined();
    // Snapshot FUNCTIONS, not store handles — so there is no `.setState` to reach.
    expect(typeof bridge!.scenario).toBe("function");
    expect(typeof bridge!.authority).toBe("function");
    expect(typeof bridge!.hot).toBe("function");
    for (const key of ["scenario", "authority", "hot"] as const) {
      expect((bridge![key] as unknown as Record<string, unknown>).setState).toBeUndefined();
    }
    // And the snapshot itself is plain state, carrying no writer.
    expect((bridge!.scenario() as unknown as Record<string, unknown>).setState).toBeUndefined();
    // The command bus IS exposed — that is the point; it is fenced by the repository.
    expect(typeof bridge!.commands.mutate).toBe("function");
  });
});
