// The one seam through which something OUTSIDE the Optimize screen can ask it to run.
//
// The assistant's confirm card calls `requestOptimizeRun` after the user presses Run;
// the screen takes the request and calls its own `onSubmit`, the exact function the
// Optimize button calls. So an assistant-started run IS a manual run: same options,
// same lease preflight, same basis, capture, download and cleanup.
//
// The same seam also carries the screen's effective solver timeout
// (`publishSolverTimeoutSeconds`), because the assistant's diagnostic candidate solves
// must respect the timeout the user set for their own runs.
//
// It lives here, not in lib/ai, because scheduling code may never import assistant
// code (`.oxlintrc.json`, "AI IS OPTIONAL"). The dependency points the allowed way:
// the assistant imports this; this imports nothing of the assistant's.

import { create } from "zustand";
import { isActiveLifecycle, type RunLifecycle } from "./run-view";

/** How long a Run click waits for the Optimize screen to pick it up. */
// ponytail: fixed TTL. A request the screen did not see in time is dropped so it can
// never start a surprise run on a later visit; make it configurable only if slow
// route transitions show up in practice.
export const RUN_REQUEST_TTL_MS = 15_000;

/** What the screen did with the last request it took. `blocked`: the Optimize path
 *  itself stopped before posting (bad timeout, lost editing lease, blocked submit).
 *  `expired`: the request outlived its TTL before the screen could act on it. */
export type RunRequestOutcome =
  | "started"
  | "not-ready"
  | "backend-offline"
  | "busy"
  | "blocked"
  | "expired";

export interface RunRequestState {
  pending: { requestedAt: number } | null;
  last: RunRequestOutcome | null;
  /** The schedule's document revision the latest run was built from; null before any run. */
  runRevision: number | null;
  /**
   * The solver timeout the Optimize screen would submit — the value typed on the
   * Optimize & Export screen, else the deployment default it read from
   * `GET /api/optimize/options`. Null when the screen has published none (it is not
   * mounted, or its options have not answered), which means "use the deployment
   * default the reader knows" — never a fixed budget.
   *
   * Published here because the screen owns the typed value as component state, and the
   * assistant's diagnostic candidate solves must use the SAME timeout as the user's own
   * run (bd memory assistant-respects-solver-timeout). This module is the seam the
   * assistant already reads for run identity, and it imports nothing of the assistant's.
   */
  solverTimeoutSeconds: number | null;
}

export const useRunRequestStore = create<RunRequestState>()(() => ({
  pending: null,
  last: null,
  runRevision: null,
  solverTimeoutSeconds: null,
}));

export function requestOptimizeRun(now: number = Date.now()): void {
  useRunRequestStore.setState({ pending: { requestedAt: now }, last: null });
}

/** Consume the pending request. True only when it was still fresh. */
export function takeOptimizeRunRequest(now: number = Date.now()): boolean {
  const { pending } = useRunRequestStore.getState();
  if (pending === null) return false;
  const fresh = now - pending.requestedAt <= RUN_REQUEST_TTL_MS;
  useRunRequestStore.setState(fresh ? { pending: null } : { pending: null, last: "expired" });
  return fresh;
}

export function reportOptimizeRunRequest(outcome: RunRequestOutcome): void {
  useRunRequestStore.setState({ last: outcome });
}

/**
 * A run started (by any route) from the schedule at `documentRevision`: an earlier
 * refusal no longer describes the screen, and a later edit makes its result stale.
 */
export function noteOptimizeRunStarted(documentRevision: number): void {
  useRunRequestStore.setState({ last: null, runRevision: documentRevision });
}

/**
 * Publish the solver timeout the Optimize screen would submit.
 *
 * Called by the screen whenever its effective timeout changes, and with `null` on
 * unmount (the typed value and the loaded default both belong to the mounted visit).
 * A reader that finds `null` must fall back to the deployment default it fetched —
 * never to a hard-coded budget.
 */
export function publishSolverTimeoutSeconds(seconds: number | null): void {
  useRunRequestStore.setState({ solverTimeoutSeconds: seconds });
}

/** A POST in flight, or a server job that is queued, running or cancelling. */
export function isRunLive(lifecycle: RunLifecycle): boolean {
  return lifecycle === "submitting" || isActiveLifecycle(lifecycle);
}

/**
 * Whether moving to `targetRouteId` would abandon a live run: leaving the Optimise
 * screen stops its run (the visit is the unit). `undefined` is a target that did not
 * resolve, which counts as leaving. Only host moves the user did not ask for consult
 * this; the user can still navigate freely.
 */
export function leavesLiveRun(lifecycle: RunLifecycle, targetRouteId: string | undefined): boolean {
  return isRunLive(lifecycle) && targetRouteId !== "optimize-and-export";
}
