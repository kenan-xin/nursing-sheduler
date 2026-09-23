import { beforeEach, describe, expect, it } from "vitest";
import {
  RUN_REQUEST_TTL_MS,
  isRunLive,
  reportOptimizeRunRequest,
  requestOptimizeRun,
  takeOptimizeRunRequest,
  useRunRequestStore,
} from "./run-request";

beforeEach(() => {
  useRunRequestStore.setState({ pending: null, last: null });
});

describe("the assistant's run request", () => {
  it("is taken exactly once", () => {
    requestOptimizeRun(1_000);
    expect(takeOptimizeRunRequest(1_000)).toBe(true);
    expect(takeOptimizeRunRequest(1_000)).toBe(false);
  });

  it("expires rather than starting a run on a later visit", () => {
    requestOptimizeRun(1_000);
    expect(takeOptimizeRunRequest(1_000 + RUN_REQUEST_TTL_MS + 1)).toBe(false);
    // Consumed either way: an expired request must not linger for the next mount.
    expect(useRunRequestStore.getState().pending).toBeNull();
  });

  it("forgets the previous outcome when a new request is made", () => {
    reportOptimizeRunRequest("backend-offline");
    requestOptimizeRun(1_000);
    expect(useRunRequestStore.getState().last).toBeNull();
  });

  it("treats a POST in flight and every server-active lifecycle as live", () => {
    for (const lifecycle of ["submitting", "queued", "running", "cancelling"] as const) {
      expect(isRunLive(lifecycle), lifecycle).toBe(true);
    }
    for (const lifecycle of [
      "idle",
      "submit-blocked",
      "submit-rejected",
      "submit-unknown",
      "completed",
      "cancelled",
      "failed",
    ] as const) {
      expect(isRunLive(lifecycle), lifecycle).toBe(false);
    }
  });
});
