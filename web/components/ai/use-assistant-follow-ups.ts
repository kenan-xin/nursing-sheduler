"use client";

// The assistant carries on by itself after the user presses Apply, and after an
// optimiser run it offered finishes, instead of waiting for "continue".
//
// It does so with ONE ordinary user message through the composer's own send path, so
// the model gets no new authority: it reads what happened like any other message. At
// most one follow-up waits at a time. A turn still running holds it until idle; the
// user sending first drops it, because their message is the newer instruction. Each
// Apply (proposal revision) and each run is offered once.

import { useEffect, useState } from "react";
import type { ProposalDiff } from "@/lib/proposal";
import { useHotStore } from "@/lib/store";
import type { OptimizeRunView, RunLifecycle } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import type { ApplyOutcomeView } from "./use-assistant-proposals";

const FINISHED: ReadonlySet<RunLifecycle> = new Set(["completed", "cancelled", "failed"]);

/** "I applied it: Roster period, 2026-10-01 to 2026-10-31." One line, no ids. */
export function describeAppliedChange(diff: ProposalDiff): string {
  const entries = diff.direct.length > 0 ? diff.direct : diff.cascade;
  const [first, ...rest] = entries;
  if (first === undefined) return "I applied it.";
  const more =
    rest.length === 0 ? "" : `, and ${rest.length} more change${rest.length === 1 ? "" : "s"}`;
  return `I applied it: ${first.label}, ${first.after ?? "removed"}${more}.`;
}

/** "The optimiser run finished: no roster could be built." */
export function describeFinishedRun(view: Pick<OptimizeRunView, "lifecycle" | "outcome">): string {
  const plain =
    view.lifecycle === "cancelled"
      ? "it was stopped"
      : view.lifecycle === "failed"
        ? "it ended with an error"
        : view.outcome === "optimal" || view.outcome === "feasible"
          ? "a roster was made"
          : view.outcome === "infeasible"
            ? "no roster could be built"
            : view.outcome === "inconclusive"
              ? "no roster was found in the time limit"
              : "it ended without a roster";
  return `The optimiser run finished: ${plain}.`;
}

const runKey = (jobId: string) => `run:${jobId}`;

/**
 * Queue the follow-ups and send them through `send` when no turn is running.
 * Returns the user's own send path, which drops a waiting follow-up first.
 */
export function useAssistantFollowUps(
  running: boolean,
  outcome: ApplyOutcomeView | null,
  send: (text: string) => void,
): (text: string) => void {
  const [pending, setPending] = useState<string | null>(null);
  // A run that had already finished when this conversation mounted is old news.
  const [offered] = useState(() => {
    const { lifecycle, jobId } = useHotStore.getState().runView;
    return new Set(FINISHED.has(lifecycle) && jobId !== null ? [runKey(jobId)] : []);
  });

  const lifecycle = useHotStore((state) => state.runView.lifecycle);
  const jobId = useHotStore((state) => state.runView.jobId);
  const runOutcome = useHotStore((state) => state.runView.outcome);
  // "started" is reported only for a run the assistant's card requested; every run
  // start clears it first, so a run from the Optimize button never matches.
  const fromCard = useRunRequestStore((state) => state.last === "started");

  useEffect(() => {
    if (outcome?.kind !== "applied") return;
    const key = `apply:${outcome.proposalId}:${outcome.proposalRevision}`;
    if (offered.has(key)) return;
    offered.add(key);
    setPending(describeAppliedChange(outcome.diff));
  }, [outcome, offered]);

  useEffect(() => {
    if (!fromCard || jobId === null || !FINISHED.has(lifecycle)) return;
    if (offered.has(runKey(jobId))) return;
    offered.add(runKey(jobId));
    setPending(describeFinishedRun({ lifecycle, outcome: runOutcome }));
  }, [fromCard, jobId, lifecycle, runOutcome, offered]);

  useEffect(() => {
    if (pending === null || running) return;
    setPending(null);
    send(pending);
  }, [pending, running, send]);

  return (text: string) => {
    setPending(null);
    send(text);
  };
}
