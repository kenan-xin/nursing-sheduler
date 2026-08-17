// T10 — the DiagnosticCanceller the T05 interruption controller calls.
//
// T05 published the contract and a no-op default (`diagnostic-cancellation.ts`).
// This module implements the real one: it tracks the diagnostic job ids this tab's
// search owns, and when the interruption controller calls `cancelOwnedJobs`, it
// requests backend cancellation of every owned NON-TERMINAL job and reports each
// one's settlement state within the caller's 15-second window.
//
// THE CONTRACT T10 HONOURS (from diagnostic-cancellation.ts):
//   * cancel every non-terminal job the interrupted turn OWNS, and nothing else;
//   * resolve with one acknowledgement per job (`unconfirmed` is a valid answer);
//   * never throw for "the job was already terminal" (that is `terminal_other`);
//   * a job that reaches a terminal outcome during settlement may stay in ordinary
//     job history, but this app will not forward it to the model or let it revive a
//     proposal — the controller already closed the epoch before this is called.
//
// OWNERSHIP REGISTRY: the orchestrator registers each submitted diagnostic job id
// here, and unregisters it when the job settles. The registry is in-memory only:
// it tracks LIVE work, and a reload has no live work (a search is readable history
// but never resumed). That mirrors the turn/proposal in-memory authority in T04/T07.

import type { JobState, JobResponse } from "@/lib/bff/types";
import {
  summarizeCancellations,
  type DiagnosticCancellationAck,
  type DiagnosticCancellationRequest,
  type DiagnosticCanceller,
  type DiagnosticCancellationState,
} from "@/lib/ai/assistant/diagnostic-cancellation";

/** One owned diagnostic job with the scope it belongs to. */
interface OwnedDiagnosticJob {
  jobId: string;
  threadId: string | null;
  scenarioId: string | null;
  turnEpoch: number;
}

/** The effect seams the canceller needs. */
export interface DiagnosticCancellerDeps {
  /** Request the backend cancel one job. Best-effort; never throws. */
  cancelJob(jobId: string, signal: AbortSignal): Promise<void>;
  /** Poll one job's current state. Returns null when the job is gone/unreadable. */
  readJob(jobId: string, signal: AbortSignal): Promise<JobResponse | null>;
}

/**
 * The owned-job registry. The orchestrator registers a job when it is submitted and
 * unregisters it when it settles, so the registry always reflects NON-TERMINAL
 * owned work. Module-level (not a class) because there is exactly one diagnostic
 * search surface in the app, and the canceller + orchestrator + tool all reach it
 * through these functions.
 */
const owned: OwnedDiagnosticJob[] = [];

/** Record that this tab owns a non-terminal diagnostic job. */
export function registerOwnedDiagnosticJob(job: {
  jobId: string;
  threadId: string | null;
  scenarioId: string | null;
  turnEpoch: number;
}): void {
  if (!owned.some((entry) => entry.jobId === job.jobId)) {
    owned.push({ ...job });
  }
}

/** Record that an owned job has settled (terminal) and may be dropped from cancellation. */
export function unregisterOwnedDiagnosticJob(jobId: string): void {
  const index = owned.findIndex((entry) => entry.jobId === jobId);
  if (index >= 0) owned.splice(index, 1);
}

/** Test seam: clear the registry between cases. */
export function resetOwnedDiagnosticJobsForTest(): void {
  owned.length = 0;
}

/** Read the current owned jobs (a snapshot copy). */
export function readOwnedDiagnosticJobs(): readonly OwnedDiagnosticJob[] {
  return [...owned];
}

const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["completed", "cancelled", "failed"]);

/**
 * Build the real DiagnosticCanceller from the effect seams.
 *
 * The returned canceller is installed once at assistant bring-up via
 * `setDiagnosticCanceller` (T05's contract). It cancels every owned non-terminal
 * job matching the request's scope, then polls each one once for settlement within
 * the caller's signal window.
 */
export function createDiagnosticCanceller(deps: DiagnosticCancellerDeps): DiagnosticCanceller {
  return {
    async cancelOwnedJobs(
      request: DiagnosticCancellationRequest,
    ): Promise<DiagnosticCancellationAck[]> {
      const targets = selectOwnedTargets(request);
      if (targets.length === 0) return [];

      // Request cancellation of every owned non-terminal job in parallel.
      await Promise.all(
        targets.map(async (job) => {
          try {
            await deps.cancelJob(job.jobId, request.signal);
          } catch {
            // Best-effort: a failed cancel request still leaves the job able to
            // settle on its own; the poll below reports the actual state.
          }
        }),
      );

      // Poll each job once for settlement. The controller's 15-second window bounds
      // this: an aborted signal means we report `unconfirmed` for what is left.
      const acks = await Promise.all(
        targets.map((job) => classifyOwnedJob(job.jobId, deps, request.signal)),
      );
      return acks;
    },
  };
}

/** Select the owned jobs matching the request's scope (thread/scenario/epoch). */
function selectOwnedTargets(request: DiagnosticCancellationRequest): OwnedDiagnosticJob[] {
  return owned.filter((job) => {
    if (request.threadId !== null && job.threadId !== request.threadId) return false;
    if (request.scenarioId !== null && job.scenarioId !== request.scenarioId) return false;
    // An interruption that closed a later epoch leaves older turns' jobs inert too:
    // anything this tab owns under an epoch at or below the closed one is in scope.
    return job.turnEpoch <= request.closedTurnEpoch;
  });
}

/** Classify one owned job's settlement state after a cancellation request. */
async function classifyOwnedJob(
  jobId: string,
  deps: DiagnosticCancellerDeps,
  signal: AbortSignal,
): Promise<DiagnosticCancellationAck> {
  try {
    const job = await deps.readJob(jobId, signal);
    if (job === null) {
      // The job is gone (expired/deleted). Treat as terminal_other: there is nothing
      // left to cancel and no evidence to forward.
      return { jobId, state: "terminal_other" };
    }
    if (!TERMINAL_STATES.has(job.state)) {
      // Still non-terminal after the window: unconfirmed is the honest answer.
      return { jobId, state: "unconfirmed" };
    }
    const state: DiagnosticCancellationState =
      job.state === "cancelled" ? "cancelled" : "terminal_other";
    // The job has settled; drop it from the live registry.
    unregisterOwnedDiagnosticJob(jobId);
    return { jobId, state };
  } catch {
    // A poll failure (network, abort) is unconfirmed rather than a throw: the
    // controller detaches on unconfirmed rather than waiting.
    return { jobId, state: "unconfirmed" };
  }
}

/**
 * Cancel every diagnostic job this tab currently owns, on the user's explicit
 * request rather than as part of an interruption.
 *
 * This is the "Cancel diagnostic" control's action: an ordinary run is waiting
 * behind a running diagnostic, and a running solve is never pre-empted, so freeing
 * the worker requires actually cancelling it. The turn is NOT closed — the user
 * stopped a test, not the conversation — so this deliberately does not go through
 * the T05 interruption controller.
 */
export async function cancelOwnedDiagnosticsNow(
  deps: Pick<DiagnosticCancellerDeps, "cancelJob">,
  signal: AbortSignal,
): Promise<string[]> {
  const targets = readOwnedDiagnosticJobs();
  await Promise.all(
    targets.map(async (job) => {
      try {
        await deps.cancelJob(job.jobId, signal);
      } catch {
        // Best-effort. The orchestrator's own poll observes the real settlement.
      }
    }),
  );
  return targets.map((job) => job.jobId);
}

/** Re-export the summary helper for the controller's display. */
export { summarizeCancellations };
