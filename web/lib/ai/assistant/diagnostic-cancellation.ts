// The diagnostic cancellation ownership interface (T05 supplies it, T10 implements
// it).
//
// WHY THIS SEAM EXISTS NOW. The interruption contract is "close the local gate, then
// request provider abort AND cancellation of every owned non-terminal diagnostic job,
// then settle or detach within 15 seconds". Two of those three are T05's; the third
// belongs to T10. Publishing the interface and its default here is what lets the ONE
// controller be complete and tested against slow-job fixtures today, instead of T10
// later adding a second cancellation path beside it -- which is the exact duplication
// the tech plan forbids.
//
// THE CONTRACT T10 MUST HONOUR:
//   * cancel every non-terminal job the interrupted turn OWNS, and nothing else. A
//     user-started ordinary Optimize run is never affected;
//   * resolve with one acknowledgement per job. `unconfirmed` is a legitimate,
//     expected answer -- the controller detaches on it rather than waiting;
//   * never throw for "the job was already terminal"; that is `terminal_other`;
//   * a job that reaches a terminal outcome during settlement may stay in ordinary
//     job history, but this app will not forward it to the model or let it revive a
//     proposal. The controller enforces that by having already closed the epoch and
//     the generation before this is called.

import type { InterruptionTrigger } from "./lifecycle";

/** What became of one owned job. `unconfirmed` is an answer, not a failure. */
export type DiagnosticCancellationState =
  /** The backend confirmed the job is terminally cancelled. */
  | "cancelled"
  /** The job reached some other terminal outcome first (feasible, failed, ...). */
  | "terminal_other"
  /** Cancellation could not be confirmed within the caller's window. */
  | "unconfirmed";

export interface DiagnosticCancellationAck {
  /** The backend job identity. Bounded metadata; never job content. */
  jobId: string;
  state: DiagnosticCancellationState;
}

export interface DiagnosticCancellationRequest {
  trigger: InterruptionTrigger;
  /** The thread whose owned jobs must stop, or `null` for "every owned job". */
  threadId: string | null;
  scenarioId: string | null;
  /** The epoch that has just been closed. Nothing authorised under it may publish. */
  closedTurnEpoch: number;
  /** Aborted when the 15-second settlement window elapses. */
  signal: AbortSignal;
}

export interface DiagnosticCanceller {
  cancelOwnedJobs(request: DiagnosticCancellationRequest): Promise<DiagnosticCancellationAck[]>;
}

/**
 * The default: there are no diagnostics before T10, so there is nothing to cancel.
 *
 * An empty array rather than a throw or a `null` canceller, so the controller has ONE
 * code path whether or not diagnostics exist -- and so "no diagnostics" settles
 * immediately instead of waiting out the window for a capability the app lacks.
 */
export const NO_DIAGNOSTICS: DiagnosticCanceller = {
  cancelOwnedJobs: () => Promise.resolve([]),
};

let canceller: DiagnosticCanceller = NO_DIAGNOSTICS;

/** Install the owner of diagnostic cancellation. T10 calls this once at bring-up. */
export function setDiagnosticCanceller(next: DiagnosticCanceller | null): void {
  canceller = next ?? NO_DIAGNOSTICS;
}

export function readDiagnosticCanceller(): DiagnosticCanceller {
  return canceller;
}

/** How the controller summarises a cancellation round. Counts only. */
export interface DiagnosticCancellationSummary {
  requested: number;
  confirmed: number;
  unresolved: number;
}

export function summarizeCancellations(
  acks: readonly DiagnosticCancellationAck[],
): DiagnosticCancellationSummary {
  const confirmed = acks.filter(
    (ack) => ack.state === "cancelled" || ack.state === "terminal_other",
  ).length;
  return {
    requested: acks.length,
    confirmed,
    unresolved: acks.length - confirmed,
  };
}
