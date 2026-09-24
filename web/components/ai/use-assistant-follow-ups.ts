"use client";

// The assistant carries on by itself after the user presses Apply, and after an
// optimiser run it offered finishes, instead of waiting for "continue".
//
// It does so with ONE ordinary user message through the composer's own send path, so
// the model gets no new authority: it reads what happened like any other message. At
// most one follow-up waits at a time. A turn still running holds it until idle; the
// user sending first drops it, because their message is the newer instruction. Each
// Apply (proposal revision) and each run is offered once.

import { useEffect, useRef, useState } from "react";
import type { ProposalDiff } from "@/lib/proposal";
import { useHotStore } from "@/lib/store";
import type { OptimizeRunView, RunLifecycle } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import type { ApplyOutcomeView } from "./use-assistant-proposals";

const FINISHED: ReadonlySet<RunLifecycle> = new Set(["completed", "cancelled", "failed"]);

/** A follow-up line never runs past this; a long rule body is cut with an ellipsis. */
const MAX_LINE = 120;

/** "I applied it: Roster period, 2026-10-01 to 2026-10-31." One line, no ids. */
export function describeAppliedChange(diff: ProposalDiff): string {
  const entries = diff.direct.length > 0 ? diff.direct : diff.cascade;
  const [first, ...rest] = entries;
  if (first === undefined) return "I applied it.";
  const prefix = "I applied it: ";
  const suffix =
    (rest.length === 0 ? "" : `, and ${rest.length} more change${rest.length === 1 ? "" : "s"}`) +
    ".";
  const detail = `${first.label}, ${first.after ?? "removed"}`;
  const room = MAX_LINE - prefix.length - suffix.length;
  const fitted = detail.length <= room ? detail : `${detail.slice(0, room - 1).trimEnd()}…`;
  return `${prefix}${fitted}${suffix}`;
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

interface Waiting {
  text: string;
  refused: boolean;
  sawBusy?: boolean;
}

/** A new fact joins whatever is still waiting, as one line; a refused one stays refused. */
const join = (current: Waiting | null, text: string): Waiting =>
  current === null ? { text, refused: false } : { ...current, text: `${current.text} ${text}` };

/**
 * Queue the follow-ups and send them through `send` when no turn is running.
 * `send` resolves false only when it was refused before preparing (a send already
 * in flight); the follow-up is then retried once the session next goes busy and back
 * to idle. Refusals during preparation or launch (revoked, not_writer, ...) resolve
 * true and are not retried: the session has already told the user why.
 * Follow-ups that land while one is waiting join it, so one turn hears both facts.
 * Returns the user's own send path, which drops a waiting follow-up first.
 */
export function useAssistantFollowUps(
  running: boolean,
  outcome: ApplyOutcomeView | null,
  send: (text: string) => Promise<boolean>,
): (text: string) => Promise<boolean> {
  // The one waiting follow-up. `refused`: a send was refused as busy, so it waits for
  // the session's next busy-to-idle report (`sawBusy` marks the busy half).
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  // Bumped on every user send, so a refusal that resolves later cannot requeue.
  const userSends = useRef(0);
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
    // The screen is out of step and must be reloaded; a turn now would be refused
    // against the stale revision, so there is nothing to carry on with.
    if (outcome.reloadRequired) return;
    setWaiting((current) => join(current, describeAppliedChange(outcome.diff)));
  }, [outcome, offered]);

  useEffect(() => {
    if (!fromCard || jobId === null || !FINISHED.has(lifecycle)) return;
    if (offered.has(runKey(jobId))) return;
    offered.add(runKey(jobId));
    setWaiting((current) => join(current, describeFinishedRun({ lifecycle, outcome: runOutcome })));
  }, [fromCard, jobId, lifecycle, runOutcome, offered]);

  useEffect(() => {
    if (waiting === null) return;
    if (waiting.refused) {
      if (running && !waiting.sawBusy) setWaiting({ ...waiting, sawBusy: true });
      if (!running && waiting.sawBusy) setWaiting({ text: waiting.text, refused: false });
      return;
    }
    if (running) return;
    setWaiting(null);
    const { text } = waiting;
    const sendsBefore = userSends.current;
    void send(text).then((accepted) => {
      if (accepted || userSends.current !== sendsBefore) return;
      // Anything queued meanwhile rides along after the refused text.
      setWaiting((current) => ({
        text: current === null ? text : `${text} ${current.text}`,
        refused: true,
      }));
    });
  }, [waiting, running, send]);

  return (text: string) => {
    userSends.current += 1;
    setWaiting(null);
    return send(text);
  };
}
