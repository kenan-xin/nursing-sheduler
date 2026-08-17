// T16 Optimize feature — public surface.
//
//   • run view + reducer   — the typed feature-local run model (T16a)
//   • run controller        — the orchestration hook wiring T16q + T06 (T16a)
//   • submission glue       — pure classification / normalization helpers (T16a)
//   • session transaction   — the durable pre/post-POST recovery record (T16q)
//   • roster capture        — the write-ahead submission snapshot and the terminal
//                             capture state machine that gates cleanup (F2)
//
// The T04 hot store imports `./run-view` DIRECTLY (a pure, React-free module) so it
// never pulls the controller hook into the store bundle.

export {
  INITIAL_OPTIMIZE_RUN_VIEW,
  MAX_LOG_ENTRIES,
  MAX_PHASE_ENTRIES,
  MAX_PROGRESS_POINTS,
  WORKER_LOST_CODE,
  isActiveLifecycle,
  isSettledLifecycle,
  reduceRunView,
  reduceRunViewAll,
  type CursorRecoveryReason,
  type CursorRecoveryState,
  type DownloadState,
  type DownloadStatus,
  type OptimizeRunView,
  type RunControls,
  type RunError,
  type RunErrorSource,
  type RunLifecycle,
  type RunLogEntry,
  type RunLogKind,
  type RunPhaseEntry,
  type RunProgressPoint,
  type RunResult,
  type RunSignal,
} from "./run-view";

export { purgeRetiredSubmissionSnapshot, type RetiredSnapshotOutcome } from "./submission-snapshot";

export {
  buildStreamCallbacks,
  classifySubmitError,
  durableFrameSignal,
  frameToSignal,
  normalizePhaseFrame,
  normalizeProgressFrame,
  outcomeToSignals,
  type RunStreamCallbacks,
} from "./submission";

export { compareIsoDateTimes, isIsoDateTime, parseIsoDateTime } from "@/lib/time/iso-date-time";

export {
  OPTIMIZE_POLL_INTERVAL_MS,
  useOptimizeRun,
  type AttachmentToken,
  type OptimizeRunController,
  type OptimizeRunSubmitInput,
  type OptimizeBasisStore,
  type OptimizeRunSubmitOutcome,
  type OptimizeSubmitOptions,
  type RunActivation,
  type UseOptimizeRunDeps,
} from "./use-optimize-run";

// G6.2 — the visit fence and the invisible retirement lane that replaced the
// cross-visit recovery machinery.
export {
  createAttemptRegistry,
  isAbortError,
  type AttemptRegistry,
  type VisitAttempt,
} from "./visit-attempt";

export {
  retireAbandonedRun,
  retireOnDocumentExit,
  type RetireAbandonedRunDeps,
  type RetireAbandonedRunInput,
  type RetirementReport,
} from "./visit-retirement";

export {
  activateSession,
  buildProvisionalSession,
  decodeSessionRecord,
  runSubmissionTransaction,
  stageProvisionalSession,
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  OPTIMIZE_SESSION_KEY_PREFIX,
  optimizeSessionKeyFor,
  listOptimizeSessionKeys,
  readOwnerSession,
  removeOwnerSession,
  migrateLegacySession,
  clearAllOptimizeSessions,
  type SessionKeyListing,
  type OwnerSessionRead,
  type RemoveOwnerSessionOutcome,
  type LegacyMigrationOutcome,
  type ClearAllSessionsOutcome,
  OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
  clearRetirementPending,
  OPTIMIZE_TIMEOUT_MAX_SECONDS,
  OPTIMIZE_TIMEOUT_MIN_SECONDS,
  type ActivateOutcome,
  type ActiveOptimizeSession,
  type OptimizeRunOptions,
  type OptimizeSessionRecord,
  type ProvisionalOptimizeSession,
  type SessionCodec,
  type SessionTransactionStorage,
  type CaptureUnavailableReason,
  type SessionCaptureState,
  type StageProvisionalOutcome,
  type SubmissionTransactionOutcome,
  type SubmitResult,
  type VolatileActivation,
} from "./session-transaction";

export { acquireSessionStorage } from "./session-storage";

export {
  RESTORED_XLSX_MIME_TYPE,
  XlsxRestorationError,
  applyPeopleIdRestoration,
  restorePeopleIdsInXlsx,
  type PeopleIdRestorationInput,
} from "./restore-people-ids-in-xlsx";

export {
  deriveOptimizeReadiness,
  type OptimizeReadiness,
  type OptimizeReadinessIssue,
  type OptimizeReadinessSource,
} from "./optimize-readiness";

export {
  createOptimizeObservability,
  OPTIMIZE_BASIS_DEGRADATIONS,
  OPTIMIZE_OBSERVABILITY_MAX_EVENTS,
  OPTIMIZE_OBSERVABILITY_TAG,
  type ObservedOptimizeEvent,
  type OptimizeBasisDegradation,
  type OptimizeObservability,
  type OptimizeObservabilitySink,
  type OptimizeObservation,
} from "./optimize-observability";

// T08 — immutable submission basis, closed recovery, retention, and the product
// outcome model. The canonical encoder is paired byte-for-byte with the Python
// half through `contracts/optimize-basis-v2.golden.json`.
export {
  ANONYMIZATION_MODES,
  BASIS_ENCODING_VERSION,
  BASIS_SCHEMA_VERSION,
  computeBasisId,
  encodeOptimizeBasisV2,
  encodeOptimizeBasisV2Bytes,
  OptimizeBasisError,
  sha256Hex,
  sha256HexOfUtf8,
  type AnonymizationMode,
  type NormalizedOptimizeOptions,
  type OptimizeBasisV2,
} from "./basis/optimize-basis";

export {
  basisRowPayload,
  isOptimizeBasisRecordV2,
  withClearedBasisPayload,
  type OptimizeBasisOwnerKind,
  type OptimizeBasisRecordFields,
  type OptimizeBasisRecordV1,
  type OptimizeBasisRecordV2,
  type StoredOptimizeBasisRow,
} from "./basis/basis-row";

export {
  BasisOwnershipError,
  bindAcceptedJob,
  buildOptimizeBasis,
  OPTIMIZE_SERIALIZER_VERSION,
  OPTIMIZE_SOLVER,
  type AcceptedJobIdentity,
  type BasisSubmissionFields,
  type BuildBasisInput,
  type BuiltBasis,
} from "./basis/basis-record";

export {
  classifyRecovery,
  isBasisCurrent,
  type RecoveryClassification,
  type RecoveryInput,
  type RecoveryState,
  type ServerJobFacts,
} from "./basis/recovery";

export {
  mayRetainPayload,
  planReap,
  type ReapAction,
  type ReapInput,
  type ReapReason,
} from "./basis/reaper";

export {
  isEvidenceBearing,
  mapJobToProductOutcome,
  notStarted,
  provesFeasible,
  UNCLASSIFIED_FAILURE,
  type NotStartedReason,
  type OutcomeEvidence,
  type OutcomeInput,
  type ProductOutcome,
  type ProductOutcomeView,
} from "./outcome-mapping";

export {
  classifyOptimizeServerInfo,
  useOptimizeServerInfo,
  type FetchOptimizeInfo,
  type OptimizeServerInfo,
  type OptimizeServerStatus,
  type UseOptimizeServerInfoDeps,
} from "./optimize-server-info";

export {
  classifyJobCaptureAuthority,
  useOptimizeTerminal,
  type CleanupCallOutcome,
  type CleanupPhase,
  type JobCaptureAuthority,
  type OptimizeTerminal,
  type UseOptimizeTerminalDeps,
} from "./use-optimize-terminal";

export {
  buildStagedSubmission,
  isStagedSubmission,
  purgeSubmissionSnapshot,
  readStagedSubmissionSnapshot,
  stageSubmissionSnapshot,
  type SnapshotPurgeAuthority,
  type SnapshotReadOutcome,
  type SnapshotPurgeResult,
  type StagedSubmission,
  type StagedSubmissionSnapshot,
  type SubmissionSnapshotStore,
} from "./submission-snapshot";

export {
  createRosterCapture,
  TERMINAL_UNAVAILABLE_CAUSES,
  type BuildCandidateDocument,
  type CandidateBuildInput,
  type CandidateBuildResult,
  type CaptureCleanupToken,
  type CaptureDismissalReason,
  type CaptureOutcome,
  type CaptureRequest,
  type CaptureUnavailableCause,
  type DismissOutcome,
  type DurableCandidateRef,
  type DurableDismissOutcome,
  type PreFetchUnavailableCause,
  type RosterCaptureDeps,
  type RosterCaptureGate,
  type RosterCaptureState,
} from "./roster-capture";

export {
  getCleanupCoordinator,
  getRosterCaptureGate,
  notifyRosterCaptureCleared,
  resetRosterCaptureGate,
  type CleanupCoordinator,
  type RosterCaptureGateDeps,
} from "./roster-capture-app";

export {
  ROSTER_SUBMISSION_VERSION,
  productionCandidateBuilder,
  rosterAppBuild,
} from "./roster-candidate-builder";

export {
  useRosterCapture,
  type RosterCaptureSurface,
  type UseRosterCaptureDeps,
} from "./use-roster-capture";

export {
  elapsedLabel,
  formatElapsedSeconds,
  formatRunStatus,
  formatScore,
  jobDetailLine,
  scoreLabel,
  terminalHeading,
  type RunStatusDisplay,
  type RunStatusTone,
} from "./run-display";
