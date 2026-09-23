// T10 — the pure decision logic for a DiagnosticSearch.
//
// Three questions, each closed and fail-closed:
//   1. MAY a search open for this failed run? (`mayOpenSearch`)
//   2. GIVEN the candidates that have settled, should the search submit the next
//      one, or stop — and why? (`deriveStopDecision`)
//   3. MAY this settled candidate become a Preview, and does its identity still
//      bind? (`candidateIdentityState`, `computeTransformDigest`)
//
// No I/O. No store. Every answer is a pure function of the inputs the orchestrator
// hands it. That is what makes every acceptance state, mismatch, limit, timeout
// and interruption stage testable without IndexedDB or a network — and what makes
// "unknown/mismatched facts fail closed" a structural property rather than a
// convention someone has to remember.

import { proposalDigest } from "@/lib/proposal/digest";
import { commandsDigest } from "@/lib/proposal/proposal";
import type { AssistantCommandV1 } from "@/lib/proposal/commands";
import type { ProposalDiff } from "@/lib/proposal/diff";
import type { EvidenceReference, ProposalOutcome } from "@/lib/proposal/proposal";
import type { RecoveryClassification } from "@/lib/optimize/basis/recovery";
import type { JobBasis } from "@/lib/bff/types";
import type {
  DiagnosticCandidate,
  DiagnosticSearchRecordV1,
  DiagnosticStopReason,
} from "./search-record";
import { isSearchActive, selectFirstFeasible, submissionsSpent } from "./search-record";

/**
 * The closed answer to "may a search open for this failed ordinary run?".
 *
 * Only a TRUSTED recovery whose basis still matches the CURRENT scenario may open a
 * search. Every other recovery state (local-only, server-only, semantic-mismatch,
 * integrity-mismatch) is readable history and nothing more — chat prose, a job id,
 * or "it looks like the same scenario" never upgrades it. A stale current scenario
 * (the user edited after the failed run) is the "Out of date" product state: the
 * old failure stays readable, but diagnosis and apply are blocked and a fresh
 * ordinary run is offered.
 */
export interface OpenSearchGateInput {
  recovery: RecoveryClassification;
  /** Whether the trusted basis still matches the current scenario identity + revision. */
  basisCurrent: boolean;
}

export type OpenSearchGateResult =
  | { ok: true }
  | { ok: false; reason: DiagnosticStopReason; message: string };

export function mayOpenSearch(input: OpenSearchGateInput): OpenSearchGateResult {
  if (!input.recovery.diagnosisEnabled) {
    return {
      ok: false,
      reason: "recovery_blocked",
      message: openBlockedMessage(input.recovery),
    };
  }
  if (!input.basisCurrent) {
    return {
      ok: false,
      reason: "recovery_blocked",
      message:
        "This schedule changed after the failed run, so the old result is out of date. " +
        "Run Optimize again to diagnose the current schedule.",
    };
  }
  return { ok: true };
}

/** Nurse-facing wording for each non-trusted recovery state. */
function openBlockedMessage(recovery: RecoveryClassification): string {
  switch (recovery.state) {
    case "local-only":
      return (
        "The failed run can no longer be diagnosed safely because its evidence is no longer " +
        "available on the server. Run Optimize again to get a fresh diagnosis."
      );
    case "server-only":
      return (
        "This browser does not hold the exact submitted document for that run, so it cannot be " +
        "diagnosed here. Run Optimize again from this tab to get a fresh diagnosis."
      );
    case "semantic-mismatch":
      return (
        "The scheduling rules changed since that run, so its result cannot be compared against " +
        "the current rules. Run Optimize again to get a fresh diagnosis."
      );
    case "integrity-mismatch":
      return (
        "The recorded identity of that run does not match what the server holds, so it has been " +
        "quarantined. Run Optimize again to get a fresh diagnosis."
      );
    case "trusted":
      return "The failed run may be diagnosed.";
  }
}

/**
 * The closed answer to "what should the search do next?".
 *
 * `submit` means the caller may prepare and submit the next proposed candidate (the
 * caller still re-checks interruption before doing so). Any other value means the
 * search is finished and must be closed with that reason. The decisions are
 * exhaustive and order them deliberately: an interruption always wins, then the
 * feasible-stop, then the cap, then exhaustion.
 */
export type StopDecision = { action: "submit" } | { action: "stop"; reason: DiagnosticStopReason };

export function deriveStopDecision(search: DiagnosticSearchRecordV1): StopDecision {
  if (!isSearchActive(search))
    return { action: "stop", reason: search.stopReason ?? "interrupted" };

  // First-feasible stop: unless the user explicitly asked to compare, the first
  // tested-feasible candidate ends the search. This is the bounded-budget contract.
  if (!search.compare && selectFirstFeasible(search) !== null) {
    return { action: "stop", reason: "first_feasible" };
  }

  // The five-candidate cap is on SUBMISSION ATTEMPTS, not on accepted jobs. A
  // candidate the backend refused for capacity still spent a slot — counting only
  // accepted jobs would let a saturated queue be retried without bound. A candidate
  // the host rejected before any request left the browser spends nothing.
  if (submissionsSpent(search) >= search.maxCandidates) {
    return { action: "stop", reason: search.compare ? "compare_complete" : "cap_reached" };
  }

  return { action: "submit" };
}

/**
 * Compute the transform digest over a candidate's validated commands and
 * host-derived diff.
 *
 * This binds the candidate to its exact EFFECT on the copied document, not just to
 * its commands: two different documents that happened to accept the same commands
 * but produce different cascades get different digests. Combined with the parent
 * basis id, this is what prevents one run's evidence being presented as another's.
 */
export function computeTransformDigest(
  commands: readonly AssistantCommandV1[],
  diff: ProposalDiff,
): string {
  return proposalDigest({
    kind: "diagnostic-transform-v1",
    commandsDigest: commandsDigest(commands),
    direct: diff.direct,
    cascade: diff.cascade,
    capabilityIds: diff.capabilityIds,
  });
}

/**
 * The closed identity check for a settled candidate.
 *
 * A candidate that the backend accepted must agree with the search's parent on
 * every identity axis: its own basis, its parent basis, its transform, and the
 * input digest the server echoes. A disagreement on ANY axis is an integrity
 * failure — the candidate is quarantined and can never display as tested evidence
 * or become Apply-capable. This is the structural enforcement of "candidate
 * input/basis/transform/parent mismatches cannot display as tested evidence".
 */
export type CandidateIdentityState =
  | { ok: true }
  | {
      ok: false;
      reason: "parent_mismatch" | "transform_mismatch" | "input_mismatch" | "unsettled";
    };

export function candidateIdentityState(
  search: DiagnosticSearchRecordV1,
  candidate: DiagnosticCandidate,
  serverBasis: JobBasis | null,
): CandidateIdentityState {
  if (candidate.outcome === null) return { ok: false, reason: "unsettled" };
  // A candidate with no accepted job carries no server identity and cannot be tested
  // evidence — host-rejected, capacity-refused, and transport-refused alike. Their
  // not-started outcomes already say so; this makes it structural.
  if (candidate.jobId === null) return { ok: false, reason: "unsettled" };

  if (candidate.parentBasisId !== search.parent.basisId) {
    return { ok: false, reason: "parent_mismatch" };
  }
  // The server MUST echo the basis it accepted. A candidate whose accepted job comes
  // back without one cannot be compared at all, so it fails closed rather than being
  // trusted on the browser's own word.
  if (serverBasis === null) return { ok: false, reason: "input_mismatch" };
  if ((serverBasis.parent_basis_id ?? null) !== candidate.parentBasisId) {
    return { ok: false, reason: "parent_mismatch" };
  }
  if ((serverBasis.transform_digest ?? null) !== candidate.transformDigest) {
    return { ok: false, reason: "transform_mismatch" };
  }
  // The digest of the exact bytes submitted. Empty on either side means "unknown",
  // which is a mismatch, not a pass.
  if (candidate.inputSha256 === "" || serverBasis.input_sha256 !== candidate.inputSha256) {
    return { ok: false, reason: "input_mismatch" };
  }
  if (serverBasis.basis_id !== candidate.basisId) {
    return { ok: false, reason: "input_mismatch" };
  }
  return { ok: true };
}

/**
 * Whether a settled candidate may feed a T07 Preview as tested evidence.
 *
 * Only a `tested-feasible` candidate whose identity still binds may become an
 * Apply-capable Preview. Everything else is readable history: an inconclusive
 * candidate may prepare a Preview labelled inconclusive (a suggestion, not proof),
 * but a failed/cancelled/not-started/mismatched candidate never becomes one.
 */
export function candidatePreviewEligibility(
  search: DiagnosticSearchRecordV1,
  candidate: DiagnosticCandidate,
  serverBasis: JobBasis | null,
): { eligible: boolean; outcome: ProposalOutcome; evidence: EvidenceReference[] } {
  const identity = candidateIdentityState(search, candidate, serverBasis);
  const evidence: EvidenceReference[] = candidateEvidenceReference(candidate);
  if (candidate.outcome === null) {
    return { eligible: false, outcome: "untested", evidence };
  }
  switch (candidate.outcome.outcome) {
    case "tested-feasible":
      return {
        eligible: identity.ok,
        outcome: "optimizer_tested",
        evidence,
      };
    case "inconclusive":
      // Inconclusive is real evidence (no proof either way), so it may prepare a
      // Preview, but it is labelled inconclusive — never as a tested fix.
      return {
        eligible: identity.ok,
        outcome: "inconclusive",
        evidence,
      };
    default:
      // tested-still-infeasible, failed, cancelled, not-started: never a Preview.
      return { eligible: false, outcome: "untested", evidence };
  }
}

/**
 * The typed evidence reference for a candidate's own basis id.
 *
 * `reference` is the candidate's basis id — an app-owned identity, never a URL and
 * never free text. The Preview renders it as the evidence chip that ties the
 * proposed change to the exact copied run that proved it.
 */
export function candidateEvidenceReference(candidate: DiagnosticCandidate): EvidenceReference[] {
  if (candidate.basisId === "") return [];
  return [
    {
      kind: "optimizer_basis",
      label: "Tested on a copy of this schedule",
      reference: candidate.basisId,
    },
  ];
}
