// @vitest-environment jsdom
//
// The assistant carries on by itself after an Apply and after a run it offered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ProposalDiff, ProposalDiffEntry } from "@/lib/proposal";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import type { ApplyOutcomeView } from "./use-assistant-proposals";
import {
  describeAppliedChange,
  describeFinishedRun,
  useAssistantFollowUps,
} from "./use-assistant-follow-ups";

const entry = (label: string, after: string | null): ProposalDiffEntry => ({
  key: label,
  scope: "roster-period",
  label,
  before: null,
  after,
  kind: "changed",
});

const diff = (...direct: ProposalDiffEntry[]): ProposalDiff => ({
  direct,
  cascade: [],
  capabilityIds: [],
  needsReview: [],
});

const ROSTER = diff(entry("Roster period", "2026-10-01 to 2026-10-31"));

const applied = (proposalId = "p1", proposalRevision = 1): ApplyOutcomeView => ({
  kind: "applied",
  receiptId: `r-${proposalId}-${proposalRevision}-${Math.random()}`,
  proposalId,
  proposalRevision,
  documentRevision: 2,
  reloadRequired: false,
  diff: ROSTER,
});

interface Props {
  running: boolean;
  outcome: ApplyOutcomeView | null;
}

function mount(initial: Props = { running: false, outcome: null }) {
  const send = vi.fn();
  const hook = renderHook(
    ({ running, outcome }: Props) => useAssistantFollowUps(running, outcome, send),
    { initialProps: initial },
  );
  return { send, ...hook };
}

const setRun = (overrides: Partial<OptimizeRunView>) =>
  act(() => useHotStore.getState().setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, ...overrides }));

beforeEach(() => {
  useHotStore.getState().resetRunView();
  useRunRequestStore.setState({ pending: null, last: null });
});
afterEach(() => {
  useHotStore.getState().resetRunView();
});

describe("describeAppliedChange", () => {
  it("names the first change in one line", () => {
    expect(describeAppliedChange(ROSTER)).toBe(
      "I applied it: Roster period, 2026-10-01 to 2026-10-31.",
    );
  });

  it("counts the rest and says removed for a removal", () => {
    expect(
      describeAppliedChange(diff(entry("Shift “EVE”", null), entry("a", "x"), entry("b", "y"))),
    ).toBe("I applied it: Shift “EVE”, removed, and 2 more changes.");
  });
});

describe("describeFinishedRun", () => {
  it.each([
    ["completed", "infeasible", "no roster could be built"],
    ["completed", "optimal", "a roster was made"],
    ["completed", "feasible", "a roster was made"],
    ["completed", "inconclusive", "no roster was found in the time limit"],
    ["cancelled", null, "it was stopped"],
    ["failed", null, "it ended with an error"],
  ] as const)("%s / %s", (lifecycle, outcome, plain) => {
    expect(describeFinishedRun({ lifecycle, outcome })).toBe(
      `The optimiser run finished: ${plain}.`,
    );
  });
});

describe("after Apply", () => {
  it("sends exactly one message with the human summary", () => {
    const { send, rerender } = mount();
    rerender({ running: false, outcome: applied() });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("I applied it: Roster period, 2026-10-01 to 2026-10-31.");
  });

  it("sends once for two Apply events of the same proposal revision", () => {
    const { send, rerender } = mount();
    rerender({ running: false, outcome: applied("p1", 1) });
    rerender({ running: false, outcome: null });
    rerender({ running: false, outcome: applied("p1", 1) });
    expect(send).toHaveBeenCalledTimes(1);
    rerender({ running: false, outcome: applied("p1", 2) });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing for Cancel, Revise, Undo or a failed Apply (no applied outcome)", () => {
    const { send, rerender } = mount();
    rerender({ running: false, outcome: { kind: "failed", message: "no" } });
    rerender({ running: false, outcome: null });
    expect(send).not.toHaveBeenCalled();
  });

  it("waits for a running turn, then sends once when idle", () => {
    const { send, rerender } = mount({ running: true, outcome: null });
    rerender({ running: true, outcome: applied() });
    expect(send).not.toHaveBeenCalled();
    rerender({ running: false, outcome: applied() });
    expect(send).toHaveBeenCalledTimes(1);
    rerender({ running: true, outcome: null });
    rerender({ running: false, outcome: null });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops the waiting message when the user sends first", () => {
    const { send, rerender, result } = mount({ running: true, outcome: null });
    rerender({ running: true, outcome: applied() });
    act(() => result.current("actually, change the nights"));
    expect(send).toHaveBeenCalledWith("actually, change the nights");
    rerender({ running: false, outcome: applied() });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("after an optimiser run", () => {
  it("sends one message when a run the assistant card started finishes", () => {
    const { send } = mount();
    setRun({ lifecycle: "running", jobId: "opt_1" });
    act(() => useRunRequestStore.setState({ last: "started" }));
    expect(send).not.toHaveBeenCalled();
    setRun({ lifecycle: "completed", jobId: "opt_1", outcome: "infeasible" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("The optimiser run finished: no roster could be built.");
    setRun({ lifecycle: "completed", jobId: "opt_1", outcome: "infeasible" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for a run started from the Optimize button", () => {
    const { send } = mount();
    setRun({ lifecycle: "running", jobId: "opt_2" });
    setRun({ lifecycle: "completed", jobId: "opt_2", outcome: "optimal" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not report a run that had already finished before it mounted", () => {
    useRunRequestStore.setState({ last: "started" });
    useHotStore
      .getState()
      .setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "failed", jobId: "opt_3" });
    const { send } = mount();
    expect(send).not.toHaveBeenCalled();
  });
});
