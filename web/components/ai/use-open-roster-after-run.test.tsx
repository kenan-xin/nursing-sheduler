// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import type { NavigateToCapabilityOptions } from "./use-capability-navigation";
import { useOpenRosterAfterRun } from "./use-open-roster-after-run";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("./use-capability-navigation", () => ({
  useCapabilityNavigation: () => navigate,
}));

// The capture gate is app-lifetime; the test drives its per-job status and notifies.
const gate = vi.hoisted(() => ({
  status: "idle",
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/optimize/roster-capture-app", () => ({
  getRosterCaptureGate: () => ({
    getState: () => ({ status: gate.status }),
    subscribe: (listener: () => void) => {
      gate.listeners.add(listener);
      return () => gate.listeners.delete(listener);
    },
  }),
}));

const NAVIGATED = { status: "navigated", capabilityId: "roster-viewer" };

function setView(overrides: Partial<OptimizeRunView>) {
  act(() => useHotStore.getState().setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, ...overrides }));
}

function commitCapture() {
  act(() => {
    gate.status = "committed";
    for (const listener of gate.listeners) listener();
  });
}

const followUp = () => useAssistantStore.getState().runFollowUp;

/** The user pressed Run on the card, and the Optimise screen started the run. */
function startAssistantRun(jobId = "opt_1") {
  act(() => assistantActions.setRunFollowUp("requested"));
  setView({ lifecycle: "submitting" });
  setView({ lifecycle: "running", jobId });
}

function finishWithRoster(jobId = "opt_1") {
  setView({ lifecycle: "completed", jobId, outcome: "feasible" });
  commitCapture();
}

beforeEach(() => {
  navigate.mockReset();
  navigate.mockResolvedValue(NAVIGATED);
  gate.status = "idle";
  gate.listeners.clear();
  useRunRequestStore.setState({ pending: null, last: null, runRevision: null });
  useHotStore.getState().resetRunView();
});

afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
  useHotStore.getState().resetRunView();
});

describe("useOpenRosterAfterRun", () => {
  it("opens the Roster page once an assistant-started run's roster is saved", async () => {
    renderHook(() => useOpenRosterAfterRun());
    startAssistantRun();
    setView({ lifecycle: "completed", jobId: "opt_1", outcome: "optimal" });
    // Not before the roster is saved: the Roster page would have nothing to show.
    expect(navigate).not.toHaveBeenCalled();

    commitCapture();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toBe("roster-viewer");
    await vi.waitFor(() => expect(followUp()).toBe("opened"));
  });

  it("does nothing for a run the user started on the Optimise screen", () => {
    renderHook(() => useOpenRosterAfterRun());
    setView({ lifecycle: "running", jobId: "opt_1" });
    finishWithRoster();
    expect(navigate).not.toHaveBeenCalled();
    expect(followUp()).toBeNull();
  });

  it.each([
    ["infeasible", { lifecycle: "completed", outcome: "infeasible" }],
    ["inconclusive", { lifecycle: "completed", outcome: "inconclusive" }],
    ["failed", { lifecycle: "failed" }],
    ["cancelled", { lifecycle: "cancelled" }],
    ["abandoned (left the screen)", { lifecycle: "idle" }],
  ] as const)("keeps today's behaviour when the run ends %s", (_, end) => {
    renderHook(() => useOpenRosterAfterRun());
    startAssistantRun();
    setView({ jobId: "opt_1", ...end });
    commitCapture();
    expect(navigate).not.toHaveBeenCalled();
    expect(followUp()).toBeNull();
  });

  it("ignores an earlier finished run still on screen when Run is pressed", () => {
    renderHook(() => useOpenRosterAfterRun());
    finishWithRoster("opt_old");
    act(() => assistantActions.setRunFollowUp("requested"));
    commitCapture();
    expect(navigate).not.toHaveBeenCalled();
    expect(followUp()).toBe("requested");
  });

  it("forgets the request when the Optimise screen did not start it", () => {
    renderHook(() => useOpenRosterAfterRun());
    act(() => assistantActions.setRunFollowUp("requested"));
    act(() => useRunRequestStore.setState({ last: "blocked" }));
    expect(followUp()).toBeNull();
  });

  it("leaves the user in place when they keep an unsaved edit", async () => {
    navigate.mockResolvedValue({
      status: "capability_unavailable",
      reason: "navigation_cancelled",
    });
    renderHook(() => useOpenRosterAfterRun());
    startAssistantRun();
    finishWithRoster();
    await vi.waitFor(() => expect(followUp()).toBe("stayed"));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("records a navigation that failed", async () => {
    navigate.mockResolvedValue({ status: "capability_unavailable", reason: "route_not_reached" });
    renderHook(() => useOpenRosterAfterRun());
    startAssistantRun();
    finishWithRoster();
    await vi.waitFor(() => expect(followUp()).toBe("failed"));
  });

  it("voids an in-flight navigation on unmount", async () => {
    let settle: (value: unknown) => void = () => {};
    navigate.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const hook = renderHook(() => useOpenRosterAfterRun());
    startAssistantRun();
    finishWithRoster();
    const options = navigate.mock.calls[0][1] as NavigateToCapabilityOptions;
    expect(options.authorize?.()).toBe(true);

    hook.unmount();

    // The navigation may not push after unmount, and its late result changes nothing.
    expect(options.authorize?.()).toBe(false);
    await act(async () => settle(NAVIGATED));
    expect(followUp()).toBeNull();
  });

  it("clears an old outcome when a later run starts", async () => {
    renderHook(() => useOpenRosterAfterRun());
    startAssistantRun();
    finishWithRoster();
    await vi.waitFor(() => expect(followUp()).toBe("opened"));
    setView({ lifecycle: "running", jobId: "opt_2" });
    expect(followUp()).toBeNull();
  });
});
