import { beforeEach, describe, expect, it } from "vitest";
import {
  RUN_REQUEST_TTL_MS,
  isRunLive,
  leavesLiveRun,
  publishSolverTimeoutSeconds,
  reportOptimizeRunRequest,
  requestOptimizeRun,
  takeOptimizeRunRequest,
  useRunRequestStore,
} from "./run-request";

beforeEach(() => {
  useRunRequestStore.setState({ pending: null, last: null, solverTimeoutSeconds: null });
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
    // And said, so the assistant can tell the user rather than go quiet.
    expect(useRunRequestStore.getState().last).toBe("expired");
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

  it("counts any move off the Optimise route during a live run as leaving it", () => {
    expect(leavesLiveRun("running", "shift-types")).toBe(true);
    expect(leavesLiveRun("running", undefined)).toBe(true);
    expect(leavesLiveRun("running", "optimize-and-export")).toBe(false);
    expect(leavesLiveRun("completed", "shift-types")).toBe(false);
  });
});

// The screen owns the typed timeout as component state, so it publishes the value it
// would submit here for the assistant's diagnostic candidate solves to read.
describe("the published solver timeout", () => {
  it("starts unknown, so a reader uses its own deployment default", () => {
    expect(useRunRequestStore.getState().solverTimeoutSeconds).toBeNull();
  });

  it("carries the screen's effective timeout and can be retired to unknown", () => {
    publishSolverTimeoutSeconds(45);
    expect(useRunRequestStore.getState().solverTimeoutSeconds).toBe(45);
    publishSolverTimeoutSeconds(null);
    expect(useRunRequestStore.getState().solverTimeoutSeconds).toBeNull();
  });
});
