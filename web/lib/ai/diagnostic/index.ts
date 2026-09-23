// T10 — bounded infeasibility diagnostics. Public surface.
//
// This barrel is the one import path for everything T10 owns: the durable search
// record, the pure policy/explanation/queue decisions, the orchestrator, and the
// diagnostic cancellation ownership. Modules outside T10 import from here.

export type {
  DiagnosticCandidate,
  DiagnosticParentBasis,
  DiagnosticSearchRecordV1,
  DiagnosticSearchStatus,
  DiagnosticStopReason,
} from "./search-record";
export {
  DIAGNOSTIC_CANDIDATE_TIMEOUT_SECONDS,
  DIAGNOSTIC_SEARCH_SCHEMA_VERSION,
  MAX_DIAGNOSTIC_CANDIDATES,
  appendRejectedCandidate,
  appendSubmittedCandidate,
  closeSearch,
  isSearchActive,
  openDiagnosticSearch,
  selectFirstFeasible,
  settleCandidate,
  submissionsSpent,
} from "./search-record";

export type {
  CandidateIdentityState,
  OpenSearchGateInput,
  OpenSearchGateResult,
  StopDecision,
} from "./search-policy";
export {
  candidateEvidenceReference,
  candidateIdentityState,
  candidatePreviewEligibility,
  computeTransformDigest,
  deriveStopDecision,
  mayOpenSearch,
} from "./search-policy";

export {
  CAUSE_UNAVAILABLE,
  candidateEvidenceLabel,
  explainCandidateOutcome,
  explainSearchSummary,
} from "./diagnostic-explanations";

export type { DiagnosticQueueJobFact, DiagnosticQueueView } from "./queue-state";
export { deriveDiagnosticQueueView, isDiagnosticCapacityRejection } from "./queue-state";

export type {
  CapturedGeneration,
  DiagnosticRuntime,
  DiagnosticSearchResult,
  ProposedCandidate,
  SubmitCandidateTransport,
  SubmitCandidateTransportResult,
} from "./diagnostic-orchestrator";
export { runDiagnosticSearch } from "./diagnostic-orchestrator";

export {
  createDiagnosticCanceller,
  readOwnedDiagnosticJobs,
  registerOwnedDiagnosticJob,
  resetOwnedDiagnosticJobsForTest,
  unregisterOwnedDiagnosticJob,
} from "./diagnostic-canceller";
export type { DiagnosticCancellerDeps } from "./diagnostic-canceller";
