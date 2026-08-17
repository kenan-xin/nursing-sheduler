// T10 — the durable DiagnosticSearch record and its pure transitions.
//
// A DiagnosticSearch owns one bounded counterfactual investigation of a single
// failed ordinary Optimize run. It is the browser's durable ownership of:
//   • the exact parent basis the failed run was submitted under;
//   • the ordered candidate specs the model proposed (typed commands only);
//   • the candidate/job identifiers the backend accepted;
//   • the turn/lease/generation epochs that fence every late callback; and
//   • the closed outcome each candidate settled to.
//
// NOTHING HERE CONTACTS THE BACKEND OR THE SOLVER. This module is the state
// machine's bookkeeping; the orchestrator (`diagnostic-orchestrator`) drives it
// through injected seams, and the policy module (`search-policy`) decides what to
// do next. Splitting them is what lets every acceptance state, mismatch, limit and
// interruption stage be tested without IndexedDB or a network.
//
// IDENTITY IS A BINDING, NOT A LABEL. A candidate carries its own basis id, its
// parent's basis id, and the transform digest over its validated commands and
// host-derived diff. A mismatch on any of the three — or on the input digest the
// backend echoes back — fails closed: the candidate can never display as tested
// evidence or become Apply-capable. That check lives in `search-policy`, against
// the fields recorded here.

import type { AssistantCommandV1 } from "@/lib/proposal/commands";
import type { ProposalDiff } from "@/lib/proposal/diff";
import type { ProductOutcomeView } from "@/lib/optimize/outcome-mapping";

/** The schema version of the durable row. Bump on any shape change. */
export const DIAGNOSTIC_SEARCH_SCHEMA_VERSION = 1 as const;

/** The hard ceiling on submitted candidates per search (tech-plan "Diagnostic budget"). */
export const MAX_DIAGNOSTIC_CANDIDATES = 5;

/** The per-candidate solver timeout (tech-plan "Diagnostic budget"). */
export const DIAGNOSTIC_CANDIDATE_TIMEOUT_SECONDS = 90;

/**
 * Why a search stopped. Each value is a distinct product-visible state, never a
 * free-form string — the explanation module maps these to nurse-facing wording.
 */
export type DiagnosticStopReason =
  /** A tested-feasible candidate was found and the user did not ask to compare. */
  | "first_feasible"
  /** All proposed candidates settled without a feasible result. */
  | "exhausted"
  /** The five-candidate cap was reached. */
  | "cap_reached"
  /** The user asked to compare, and every proposed candidate has settled. */
  | "compare_complete"
  /** A T05 interruption closed the turn while the search was active. */
  | "interrupted"
  /** The parent basis became non-trusted mid-search (expired/deleted/mismatched). */
  | "parent_untrusted"
  /** The search could not be opened: recovery was not trusted. */
  | "recovery_blocked";

/** The lifecycle of one search. Only terminal values stop candidate submission. */
export type DiagnosticSearchStatus = "open" | "completed" | "interrupted" | "failed";

/**
 * One counterfactual candidate.
 *
 * A candidate that the host REJECTED before submission (commands did not validate
 * against the copied document) has `jobId === null`, `outcome` set to a
 * `not-started` view, and `rejection` populated. A candidate the backend REJECTED
 * at admission (capacity reserved for ordinary work) likewise settles to
 * `not-started` with the capacity reason, and `rejection` left null — the commands
 * were valid; the queue was full.
 */
export interface DiagnosticCandidate {
  candidateId: string;
  /** 0-based submission order. */
  index: number;
  commands: AssistantCommandV1[];
  commandsDigest: string;
  /** Over the validated commands AND the host-derived diff. Binds effect, not just intent. */
  transformDigest: string;
  rationale: string | null;
  /** The host-derived change set, retained compactly for Preview handoff. */
  diff: ProposalDiff;
  /** This candidate's own basis id (computed before submission). */
  basisId: string;
  /**
   * The digest of the exact copied bytes this candidate submitted.
   *
   * Retained on the ROW (not only on the basis table) because the identity check
   * must still bind after the basis payload is compacted by the expiry reaper: the
   * digest is an identifier, not evidence, so keeping it costs nothing and losing it
   * would silently downgrade every later identity comparison to "unavailable".
   */
  inputSha256: string;
  /** The exact parent basis this candidate hangs off. Must match the search's parent. */
  parentBasisId: string;
  /**
   * Whether this candidate consumed one of the search's bounded submission slots.
   *
   * TRUE the moment a POST is attempted — including one the backend refuses for
   * capacity. A refused attempt still spent budget, so counting only ACCEPTED jobs
   * would let a saturated queue be retried without limit. FALSE only for a candidate
   * the host rejected before any request left the browser.
   */
  submissionAttempted: boolean;
  /** Bound only after the backend echoes a matching identity. Null when never accepted. */
  jobId: string | null;
  /** Null until the candidate reaches a terminal backend/lifecycle fact. */
  outcome: ProductOutcomeView | null;
  /** Host-side rejection (commands did not validate). Null for backend-rejected or settled candidates. */
  rejection: { code: string; message: string } | null;
  submittedAt: string | null;
  settledAt: string | null;
}

/** The fields captured at open time that bind the search to one failed run. */
export interface DiagnosticParentBasis {
  /** The failed ordinary run's basis id. */
  basisId: string;
  /** The failed ordinary run's job id. */
  jobId: string;
  /** The scenario the failed run belonged to. A search only opens when it is still current. */
  scenarioId: string;
  /** The document revision the failed run was submitted under. */
  documentRevision: number;
}

/**
 * The durable search row.
 *
 * Persisted to the `diagnosticSearches` Dexie table. On reload a search is readable
 * history — its settled candidates and outcomes remain — but it is never resumed:
 * like an assistant turn, a search owns in-flight polling that a page lifetime
 * cannot inherit.
 */
export interface DiagnosticSearchRecordV1 {
  searchId: string;
  schemaVersion: typeof DIAGNOSTIC_SEARCH_SCHEMA_VERSION;
  scenarioId: string;
  threadId: string | null;
  turnId: string | null;

  parent: DiagnosticParentBasis;
  /** The closed product outcome of the parent run. Always `infeasible` for an opened search. */
  parentOutcome: "infeasible";

  /** Captured at open time; every late write compares them inside its transaction. */
  turnEpoch: number;
  leaseEpoch: number;
  globalGeneration: number;
  scenarioGeneration: number;

  /** Whether to continue past the first tested-feasible candidate. */
  compare: boolean;
  candidateTimeoutSeconds: number;
  maxCandidates: number;

  status: DiagnosticSearchStatus;
  candidates: DiagnosticCandidate[];
  stopReason: DiagnosticStopReason | null;
  /** A stable machine-readable reason for a failed/closed-open state (recovery). */
  failureReason: string | null;

  createdAt: string;
  updatedAt: string;
  /** The advertised expiry of the parent's evidence; the search is invalid after it. */
  expiresAt: string | null;
}

/** Input for opening a search. Every field is host-derived; none come from chat prose. */
export interface OpenDiagnosticSearchInput {
  searchId: string;
  scenarioId: string;
  threadId: string | null;
  turnId: string | null;
  parent: DiagnosticParentBasis;
  turnEpoch: number;
  leaseEpoch: number;
  globalGeneration: number;
  scenarioGeneration: number;
  compare: boolean;
  /** When the parent's server evidence expires, so the search knows it is stale after. */
  parentExpiresAt: string | null;
  now: Date;
}

export function openDiagnosticSearch(input: OpenDiagnosticSearchInput): DiagnosticSearchRecordV1 {
  const timestamp = input.now.toISOString();
  return {
    searchId: input.searchId,
    schemaVersion: DIAGNOSTIC_SEARCH_SCHEMA_VERSION,
    scenarioId: input.scenarioId,
    threadId: input.threadId,
    turnId: input.turnId,
    parent: input.parent,
    parentOutcome: "infeasible",
    turnEpoch: input.turnEpoch,
    leaseEpoch: input.leaseEpoch,
    globalGeneration: input.globalGeneration,
    scenarioGeneration: input.scenarioGeneration,
    compare: input.compare,
    candidateTimeoutSeconds: DIAGNOSTIC_CANDIDATE_TIMEOUT_SECONDS,
    maxCandidates: MAX_DIAGNOSTIC_CANDIDATES,
    status: "open",
    candidates: [],
    stopReason: null,
    failureReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: input.parentExpiresAt,
  };
}

/** Input for appending a candidate that the host has validated and is about to submit. */
export interface AppendCandidateInput {
  candidateId: string;
  commands: readonly AssistantCommandV1[];
  commandsDigest: string;
  transformDigest: string;
  rationale: string | null;
  diff: ProposalDiff;
  basisId: string;
  inputSha256: string;
  parentBasisId: string;
  now: Date;
}

/**
 * Append a validated candidate that has SPENT a submission slot.
 *
 * `jobId` is the accepted job, or `null` when the POST was made but refused (queue
 * capacity reserved for ordinary work, or a transport rejection). Either way the
 * attempt counted against the bounded budget, which is why both paths land here
 * rather than in `appendRejectedCandidate`: only a candidate the host refused BEFORE
 * any request left the browser is free.
 */
export function appendSubmittedCandidate(
  search: DiagnosticSearchRecordV1,
  input: AppendCandidateInput,
  jobId: string | null,
): DiagnosticSearchRecordV1 {
  const timestamp = input.now.toISOString();
  const candidate: DiagnosticCandidate = {
    candidateId: input.candidateId,
    index: search.candidates.length,
    commands: [...input.commands],
    commandsDigest: input.commandsDigest,
    transformDigest: input.transformDigest,
    rationale: input.rationale,
    diff: input.diff,
    basisId: input.basisId,
    inputSha256: input.inputSha256,
    parentBasisId: input.parentBasisId,
    submissionAttempted: true,
    jobId,
    outcome: null,
    rejection: null,
    submittedAt: timestamp,
    settledAt: null,
  };
  return {
    ...search,
    candidates: [...search.candidates, candidate],
    updatedAt: timestamp,
  };
}

/**
 * Record a host-side rejection for a candidate that never reached the backend.
 *
 * The candidate is appended with a `not-started` outcome so the search history is
 * complete, but it never receives a `jobId`, never counts as tested evidence, and —
 * because no request left the browser — never spends a submission slot.
 */
export function appendRejectedCandidate(
  search: DiagnosticSearchRecordV1,
  input: Omit<
    AppendCandidateInput,
    "basisId" | "inputSha256" | "parentBasisId" | "transformDigest" | "diff"
  > & {
    rejection: { code: string; message: string };
  },
): DiagnosticSearchRecordV1 {
  const timestamp = input.now.toISOString();
  const candidate: DiagnosticCandidate = {
    candidateId: input.candidateId,
    index: search.candidates.length,
    commands: [...input.commands],
    commandsDigest: input.commandsDigest,
    transformDigest: "",
    rationale: input.rationale,
    diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
    basisId: "",
    inputSha256: "",
    parentBasisId: search.parent.basisId,
    submissionAttempted: false,
    jobId: null,
    outcome: { outcome: "not-started", evidence: "none", reason: "invalid_input" },
    rejection: input.rejection,
    submittedAt: null,
    settledAt: timestamp,
  };
  return {
    ...search,
    candidates: [...search.candidates, candidate],
    updatedAt: timestamp,
  };
}

/**
 * Settle a submitted candidate to its closed product outcome.
 *
 * `candidateId` identifies the candidate; an unknown id is a no-op (defensive). The
 * outcome is taken verbatim from the closed `mapJobToProductOutcome` mapping, so an
 * unknown backend fact is already `failed/unclassified` by the time it reaches here.
 */
export function settleCandidate(
  search: DiagnosticSearchRecordV1,
  candidateId: string,
  outcome: ProductOutcomeView,
  now: Date,
): DiagnosticSearchRecordV1 {
  const timestamp = now.toISOString();
  const candidates = search.candidates.map((candidate) =>
    candidate.candidateId === candidateId
      ? { ...candidate, outcome, settledAt: timestamp }
      : candidate,
  );
  return { ...search, candidates, updatedAt: timestamp };
}

/** Mark a search terminal with a stop reason. A terminal search accepts no new candidates. */
export function closeSearch(
  search: DiagnosticSearchRecordV1,
  reason: DiagnosticStopReason,
  failureReason: string | null,
  now: Date,
): DiagnosticSearchRecordV1 {
  const status: DiagnosticSearchStatus =
    reason === "interrupted"
      ? "interrupted"
      : reason === "recovery_blocked" || reason === "parent_untrusted"
        ? "failed"
        : "completed";
  return {
    ...search,
    status,
    stopReason: reason,
    failureReason,
    updatedAt: now.toISOString(),
  };
}

/** The candidate that found a feasible result, if any (the first one in order). */
export function selectFirstFeasible(search: DiagnosticSearchRecordV1): DiagnosticCandidate | null {
  for (const candidate of search.candidates) {
    if (candidate.outcome?.outcome === "tested-feasible") return candidate;
  }
  return null;
}

/** Whether a search is still accepting / running candidates. */
export function isSearchActive(search: DiagnosticSearchRecordV1): boolean {
  return search.status === "open";
}

/**
 * How many of the search's bounded submission slots have been spent.
 *
 * Counts ATTEMPTS, not accepted jobs — see `DiagnosticCandidate.submissionAttempted`.
 */
export function submissionsSpent(search: DiagnosticSearchRecordV1): number {
  return search.candidates.filter((candidate) => candidate.submissionAttempted).length;
}
