// T08 — the closed mapping from backend lifecycle + solver facts to the product's
// outcome model (infeasibility evidence flow, "Closed outcome mapping").
//
// Lifecycle and solver evidence are SEPARATE AXES. `JobState` says whether the run
// happened; `result.outcome` says what the solver proved. Collapsing them is how a
// timeout gets reported as infeasible or a no-proof run gets reported as a crash.
//
// Everything here is fail-closed: an unknown state, outcome, or reason — including
// one a FUTURE backend introduces — becomes `failed` / `unclassified_failure` and
// carries NO evidence. It never becomes causal or feasibility evidence by default.

import type { JobResponse, JobState, OptimizationOutcome } from "@/lib/bff/types";
import { INCONCLUSIVE_REASONS } from "@/lib/bff/types";

/** The product-facing outcome a user and the assistant both reason about. */
export type ProductOutcome =
  | "not-started"
  | "cancelled"
  | "failed"
  | "inconclusive"
  | "tested-feasible"
  | "tested-still-infeasible";

/**
 * What this outcome PROVES about the exact submitted basis.
 *
 * `none` is not "we don't know yet" — it means this outcome may never be used as
 * evidence at all. `no-proof` is a real, usable fact: the solver ran and settled
 * neither way, which is different from never having run.
 */
export type OutcomeEvidence = "none" | "no-proof" | "feasibility" | "infeasibility";

export interface ProductOutcomeView {
  outcome: ProductOutcome;
  evidence: OutcomeEvidence;
  /** A stable machine-readable reason. Never free text, never an English match. */
  reason: string;
}

/** The fail-closed result for anything this map does not recognize. */
export const UNCLASSIFIED_FAILURE: ProductOutcomeView = {
  outcome: "failed",
  evidence: "none",
  reason: "unclassified_failure",
};

/** Reasons for a run that never reached the solver. */
export type NotStartedReason =
  | "invalid_input"
  | "diagnostic_capacity_reserved"
  | "transport_rejected";

/**
 * A submission that was rejected or never accepted. No job exists, so there is no
 * `JobResponse` to classify — the caller names the pre-acceptance reason.
 */
export function notStarted(reason: NotStartedReason): ProductOutcomeView {
  return { outcome: "not-started", evidence: "none", reason };
}

const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "completed",
  "cancelled",
  "failed",
]);

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<OptimizationOutcome>([
  "optimal",
  "feasible",
  "infeasible",
  "inconclusive",
]);

/** The lifecycle facts this map needs, so a caller need not hold a whole response. */
export interface OutcomeInput {
  state: JobState;
  terminal: boolean;
  result: JobResponse["result"];
  error: JobResponse["error"];
}

/**
 * Map one terminal job to its product outcome.
 *
 * Returns `null` for a job that has not settled: a live job has no outcome, and
 * inventing one ("probably feasible", "looks stuck") is exactly the kind of
 * unfounded claim the evidence contract forbids.
 */
export function mapJobToProductOutcome(job: OutcomeInput): ProductOutcomeView | null {
  // Trust the enum, not the flag: a `terminal: true` on a live state is a
  // contract violation, and the state is the authority for what happened.
  if (!TERMINAL_STATES.has(job.state)) return null;

  if (job.state === "cancelled") {
    return {
      outcome: "cancelled",
      evidence: "none",
      // The backend's only cancellation code today is `cancelled`; a turn-level
      // interruption is named by the caller that requested it, not inferred here.
      reason: job.error?.code ?? "user_cancelled",
    };
  }

  if (job.state === "failed") {
    // A failure keeps its stable backend code; an absent one is unclassified
    // rather than summarized as any particular fault.
    const code = job.error?.code;
    return code !== undefined && code !== ""
      ? { outcome: "failed", evidence: "none", reason: code }
      : UNCLASSIFIED_FAILURE;
  }

  // `completed` without a result is a broken contract, not a silent success.
  const result = job.result;
  if (result === null || !KNOWN_OUTCOMES.has(result.outcome)) return UNCLASSIFIED_FAILURE;

  switch (result.outcome) {
    case "optimal":
    case "feasible":
      // A timeout that RETURNED a schedule stays feasible: lack of optimality is
      // not lack of feasibility, and the schedule is real evidence for this basis.
      return {
        outcome: "tested-feasible",
        evidence: "feasibility",
        reason: result.termination_reason ?? result.outcome,
      };
    case "infeasible":
      return {
        outcome: "tested-still-infeasible",
        evidence: "infeasibility",
        reason: result.termination_reason ?? "infeasibility_proven",
      };
    case "inconclusive": {
      const reason = result.termination_reason;
      // The specific reason is preserved so the UI can distinguish "the budget ran
      // out" from "you stopped it" from "the solver said something we don't know".
      // A reason outside the closed set fails closed rather than being displayed.
      if (reason === null || !INCONCLUSIVE_REASONS.has(reason)) return UNCLASSIFIED_FAILURE;
      return { outcome: "inconclusive", evidence: "no-proof", reason };
    }
    default:
      return UNCLASSIFIED_FAILURE;
  }
}

/** Whether an outcome may be used as evidence about the exact submitted basis. */
export function isEvidenceBearing(view: ProductOutcomeView): boolean {
  return view.evidence !== "none";
}

/** Whether an outcome proves the submitted basis can be solved. */
export function provesFeasible(view: ProductOutcomeView): boolean {
  return view.evidence === "feasibility";
}
