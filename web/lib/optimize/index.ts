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
  type CleanupState,
  type CleanupStatus,
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
  type SessionRecoveryState,
} from "./run-view";

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
  type CursorPersistenceProvider,
  type OptimizeRunController,
  type OptimizeRunSubmitInput,
  type OptimizeRunSubmitOutcome,
  type OptimizeRunResubmitOutcome,
  type PreparedRecoveryAttachment,
  type RunActivation,
  type UseOptimizeRunDeps,
} from "./use-optimize-run";

export {
  activateSession,
  buildProvisionalSession,
  removeInspectedSession,
  inspectPersistedSession,
  runSubmissionTransaction,
  stageProvisionalSession,
  updateActiveCursor,
  type PreparedDegradedCleanup,
  type DegradedCleanupOutcome,
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
  clearRetirementPending,
  OPTIMIZE_TIMEOUT_MAX_SECONDS,
  OPTIMIZE_TIMEOUT_MIN_SECONDS,
  type ActivateOutcome,
  type ActiveOptimizeSession,
  type RemoveInspectedSessionOutcome,
  type InspectedSession,
  type OptimizeRunOptions,
  type OptimizeSessionRecord,
  type ProvisionalOptimizeSession,
  type SessionRecordIdentity,
  type SessionCodec,
  type SessionTransactionStorage,
  type CaptureUnavailableReason,
  type SessionCaptureState,
  type StageProvisionalOutcome,
  type SubmissionTransactionOutcome,
  type SubmitResult,
  type UpdateActiveCursorOutcome,
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
  buildRecoveryAttachment,
  interpretInspectedSession,
  useOptimizeSessionRecovery,
  type CursorPersistenceState,
  type OptimizeCleanupOutcome,
  type OptimizePrepareOutcome,
  type OptimizeRecovery,
  type OptimizeResumeOutcome,
  type OptimizeSessionRecovery,
  type UseOptimizeSessionRecoveryDeps,
} from "./session-recovery";

export {
  deriveOptimizeReadiness,
  type OptimizeReadiness,
  type OptimizeReadinessIssue,
  type OptimizeReadinessSource,
} from "./optimize-readiness";

export {
  createOptimizeObservability,
  OPTIMIZE_OBSERVABILITY_MAX_EVENTS,
  OPTIMIZE_OBSERVABILITY_TAG,
  type ObservedOptimizeEvent,
  type OptimizeObservability,
  type OptimizeObservabilitySink,
  type OptimizeObservation,
} from "./optimize-observability";

export {
  classifyOptimizeServerInfo,
  useOptimizeServerInfo,
  type FetchOptimizeInfo,
  type OptimizeServerInfo,
  type OptimizeServerStatus,
  type UseOptimizeServerInfoDeps,
} from "./optimize-server-info";

export {
  useOptimizeTerminal,
  type CleanupCallOutcome,
  type CleanupPhase,
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
