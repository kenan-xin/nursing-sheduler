// T10 — the truthful capacity/queue/non-preemption view.
//
// The T09 queue contract (infeasibility evidence flow, "Diagnostic queue contract")
// makes these product guarantees:
//
//   • the backend reserves capacity so diagnostic work cannot cause all ordinary
//     submissions to be rejected (seven diagnostics leave one ordinary slot);
//   • a queued ordinary run is claimed before queued diagnostics;
//   • an already-running solver job is never silently pre-empted;
//   • if an active diagnostic occupies the needed worker when the user starts an
//     ordinary run, the app shows that fact and offers Cancel diagnostic while
//     admitting/retaining the ordinary request.
//
// This module DERIVES that view from the job facts the browser already holds. It
// owns no queue logic of its own — T09's atomic state machine is the authority —
// so it cannot drift from the real admission/claim policy. It only answers the
// narrow product question: is an ordinary run this tab owns waiting behind a
// running diagnostic, and may the user cancel that diagnostic to free the worker?

import type { JobPurpose, JobState } from "@/lib/bff/types";

/** The job facts this derivation needs. `owns` is this tab's diagnostic search ownership. */
export interface DiagnosticQueueJobFact {
  jobId: string;
  purpose: JobPurpose;
  state: JobState;
  /** Whether THIS tab owns the job (its diagnostic search submitted it). */
  owns: boolean;
}

/** The closed product view of capacity/non-preemption for one observed job set. */
export interface DiagnosticQueueView {
  /**
   * An ordinary job this tab owns is queued while a diagnostic is running on the
   * shared worker. The ordinary run was accepted and retained; it is simply waiting
   * its turn because a running solve is never pre-empted.
   */
  ordinaryBlockedByDiagnostic: boolean;
  /** The running diagnostic job occupying the worker, if any (owned or not). */
  blockingDiagnosticJobId: string | null;
  /**
   * Whether the user may cancel a running diagnostic to free the worker for the
   * waiting ordinary run. Only OWNED diagnostics may be cancelled here; a
   * diagnostic another tab owns is shown truthfully but cannot be cancelled from
   * here.
   */
  offerCancelDiagnostic: boolean;
  /** The owned running diagnostic job id a Cancel control would target. */
  cancelDiagnosticJobId: string | null;
}

/**
 * Derive the capacity/non-preemption view from observed job facts.
 *
 * Pure. The caller supplies every job it observes (its own diagnostic candidates
 * plus the ordinary run attached to this screen); this function never reaches into
 * a store. Unknown job purposes are ignored rather than guessed, so a future
 * backend purpose cannot be misread as a diagnostic.
 */
export function deriveDiagnosticQueueView(
  jobs: readonly DiagnosticQueueJobFact[],
): DiagnosticQueueView {
  const runningDiagnostic = jobs.find(
    (job) => job.purpose === "assistant_diagnostic" && job.state === "running",
  );
  const queuedOrdinaryOwned = jobs.find(
    (job) => job.purpose === "ordinary" && job.state === "queued" && job.owns,
  );

  if (runningDiagnostic === undefined || queuedOrdinaryOwned === undefined) {
    return {
      ordinaryBlockedByDiagnostic: false,
      blockingDiagnosticJobId: null,
      offerCancelDiagnostic: false,
      cancelDiagnosticJobId: null,
    };
  }

  return {
    ordinaryBlockedByDiagnostic: true,
    blockingDiagnosticJobId: runningDiagnostic.jobId,
    offerCancelDiagnostic: runningDiagnostic.owns,
    cancelDiagnosticJobId: runningDiagnostic.owns ? runningDiagnostic.jobId : null,
  };
}

/**
 * Whether a diagnostic submission should be shown as capacity-rejected.
 *
 * Mirrors the T09 reserved-slot policy: diagnostic admission succeeds only while
 * total pending is below the cap minus the reserve. A diagnostic that hits the
 * reserve is rejected with a stable code; this helper recognises that code so the
 * UI can show it truthfully rather than as a generic failure.
 */
export function isDiagnosticCapacityRejection(code: string | null | undefined): boolean {
  return code === DIAGNOSTIC_CAPACITY_REJECTION_CODE;
}

/**
 * The backend's stable code for the reserved-ordinary refusal
 * (`errors.py::DiagnosticCapacityError`). Distinct from `job_capacity_exceeded`:
 * this one means "the queue still has room, just not for you", so retrying as
 * though the whole queue were full would be wrong.
 */
export const DIAGNOSTIC_CAPACITY_REJECTION_CODE = "diagnostic_capacity_reserved";
