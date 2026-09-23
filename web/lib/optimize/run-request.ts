// The one seam through which something OUTSIDE the Optimize screen can ask it to run.
//
// The assistant's confirm card calls `requestOptimizeRun` after the user presses Run;
// the screen takes the request and calls its own `onSubmit`, the exact function the
// Optimize button calls. So an assistant-started run IS a manual run: same options,
// same lease preflight, same basis, capture, download and cleanup.
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
}

export const useRunRequestStore = create<RunRequestState>()(() => ({
  pending: null,
  last: null,
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

/** A run started (by any route), so an earlier refusal no longer describes the screen. */
export function clearOptimizeRunRequestOutcome(): void {
  useRunRequestStore.setState({ last: null });
}

/** A POST in flight, or a server job that is queued, running or cancelling. */
export function isRunLive(lifecycle: RunLifecycle): boolean {
  return lifecycle === "submitting" || isActiveLifecycle(lifecycle);
}
