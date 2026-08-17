// T10 — nurse-facing wording for diagnostic outcomes and search summaries.
//
// The evidence contract (infeasibility evidence flow, "Evidence contract") is the
// load-bearing product requirement this module implements:
//
//   1. Deterministic evidence, when available, may name a cause.
//   2. The immutable submitted scenario and terminal Optimize outcome are evidence.
//   3. Terminal copied-simulation outcomes are evidence FOR THE EXACT CANDIDATE.
//   4. Model-proposed pressure points are HYPOTHESES, explicitly labelled.
//
// A feasible counterfactual proves only that the changed copy can be solved. It
// does not prove why the original failed, that every changed field was necessary,
// that the result is clinically safe, or that an external person agreed. No result
// establishes a unique cause unless a separate deterministic diagnostic exists —
// and Phase 1 does not ship one. So the first-class message when the solver gave
// no causal explanation is exactly that.
//
// Everything here is plain language suitable for a non-technical ward manager. It
// never overclaims, never disguises the absence of proof as a result, and always
// separates what was tested from what is merely suggested.

import type { ProductOutcomeView } from "@/lib/optimize/outcome-mapping";
import type { DiagnosticCandidate, DiagnosticSearchRecordV1 } from "./search-record";
import { selectFirstFeasible } from "./search-record";

/**
 * The first-class message when no causal explanation is available.
 *
 * The current solver provides no deterministic infeasibility diagnosis, so this is
 * the honest baseline. Pressure points the assistant suggests are worth testing,
 * not reported causes.
 */
export const CAUSE_UNAVAILABLE =
  "The current solver did not give a reason this schedule cannot be solved. " +
  "These are pressure points worth testing on copies, not reported causes. " +
  "A feasible copy only proves that exact copy can be solved — not why the original failed.";

/**
 * What one settled candidate proves, in ward language.
 *
 * The wording is chosen so a nurse can tell apart:
 *   • verified copied-run evidence (tested-feasible / tested-still-infeasible),
 *   • a real but inconclusive run (inconclusive), and
 *   • a candidate that produced no evidence at all (failed / cancelled / not-started).
 */
export function explainCandidateOutcome(candidate: DiagnosticCandidate, index: number): string {
  const view = candidate.outcome;
  const ordinal = index + 1;
  if (view === null) {
    return `Candidate ${ordinal} has not settled yet.`;
  }
  switch (view.outcome) {
    case "tested-feasible":
      return (
        `Candidate ${ordinal} — the copy with this change — was solvable. ` +
        "That proves only this exact copied schedule can be solved; it does not prove the change " +
        "is the only fix, that it is clinically safe, or that it explains why the original failed."
      );
    case "tested-still-infeasible":
      return (
        `Candidate ${ordinal} was still proven infeasible on the copy. ` +
        "That is real evidence: this exact change does not make the schedule solvable."
      );
    case "inconclusive":
      return (
        `Candidate ${ordinal} ran but settled neither way (${reasonPhrase(view.reason)}). ` +
        "There is no proof either way for this exact copied schedule."
      );
    case "failed":
      return (
        `Candidate ${ordinal} could not be tested because the run failed (${reasonPhrase(view.reason)}). ` +
        "This produced no evidence about the schedule."
      );
    case "cancelled":
      return `Candidate ${ordinal} was cancelled before it settled, so it produced no evidence.`;
    case "not-started":
      return notStartedMessage(view.reason, ordinal);
    default:
      return `Candidate ${ordinal} settled to an unknown state and produced no evidence.`;
  }
}

/** Nurse-facing wording for each not-started reason. */
function notStartedMessage(reason: string, ordinal: number): string {
  switch (reason) {
    case "diagnostic_capacity_reserved":
      return (
        `Candidate ${ordinal} could not be submitted because all diagnostic capacity is in use. ` +
        "Ordinary work is never blocked by diagnostics. Try again shortly."
      );
    case "invalid_input":
      return `Candidate ${ordinal} could not be submitted because the change was not valid against the copied schedule.`;
    case "transport_rejected":
      return `Candidate ${ordinal} was rejected before it reached the solver.`;
    default:
      return `Candidate ${ordinal} was not started (${reasonPhrase(reason)}).`;
  }
}

/** A short human phrase for a stable machine reason. Never overclaims. */
function reasonPhrase(reason: string): string {
  switch (reason) {
    case "solver_timeout_no_solution":
      return "the solver timed out with no schedule";
    case "no_proof":
      return "the run was stopped with no result";
    case "solver_unknown":
      return "the solver reported an unknown status";
    case "unclassified_failure":
      return "an unclassified failure";
    default:
      return reason.replace(/_/g, " ");
  }
}

/**
 * The overall summary of a finished search, in ward language.
 *
 * Distinguishes the three terminal shapes: a feasible candidate was found, no
 * candidate was feasible, or the search was stopped/failed before completing. The
 * summary always closes with the cause-unavailable baseline when no deterministic
 * evidence exists.
 */
export function explainSearchSummary(search: DiagnosticSearchRecordV1): string {
  if (search.candidates.length === 0) {
    return noCandidatesMessage(search);
  }

  const feasible = selectFirstFeasible(search);
  const tested = search.candidates.filter(
    (c) =>
      c.outcome?.outcome === "tested-feasible" || c.outcome?.outcome === "tested-still-infeasible",
  );
  const anyInconclusive = search.candidates.some((c) => c.outcome?.outcome === "inconclusive");

  if (feasible !== null && search.stopReason === "first_feasible") {
    const ordinal = feasible.index + 1;
    return (
      `I tested ${search.candidates.length} change${search.candidates.length === 1 ? "" : "s"} on copies. ` +
      `Candidate ${ordinal} produced a solvable copy. ` +
      "You can review that exact change below — but remember it proves only that the copied schedule " +
      "with that change can be solved, not that it is the only fix or that it is clinically safe."
    );
  }

  if (tested.length > 0) {
    return (
      `I tested ${search.candidates.length} change${search.candidates.length === 1 ? "" : "s"} on copies. ` +
      "None of the tested copies was solvable. " +
      (anyInconclusive
        ? "Some copies settled neither way, so they are inconclusive rather than proven infeasible. "
        : "") +
      CAUSE_UNAVAILABLE
    );
  }

  return (
    `I tested ${search.candidates.length} change${search.candidates.length === 1 ? "" : "s"} on copies, ` +
    "but none produced usable solver evidence. " +
    CAUSE_UNAVAILABLE
  );
}

/** Wording for a search that ended before any candidate settled. */
function noCandidatesMessage(search: DiagnosticSearchRecordV1): string {
  switch (search.stopReason) {
    case "recovery_blocked":
      return search.failureReason ?? CAUSE_UNAVAILABLE;
    case "interrupted":
      return "The diagnosis was stopped before any candidate was tested.";
    case "parent_untrusted":
      return (
        "The failed run's evidence expired or changed mid-diagnosis, so testing was stopped. " +
        "Run Optimize again to get a fresh diagnosis."
      );
    default:
      return CAUSE_UNAVAILABLE;
  }
}

/**
 * The label for a candidate's evidence chip, distinguishing verified copied-run
 * evidence from a hypothesis.
 */
export function candidateEvidenceLabel(view: ProductOutcomeView | null): string {
  if (view === null) return "Not yet tested";
  switch (view.evidence) {
    case "feasibility":
      return "Verified: solvable on a copy";
    case "infeasibility":
      return "Verified: still infeasible on a copy";
    case "no-proof":
      return "Inconclusive on a copy";
    case "none":
    default:
      return "No solver evidence";
  }
}
