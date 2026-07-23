// T16 Optimize feature — public surface.
//
//   • run view + reducer   — the typed feature-local run model (T16a)
//   • run controller        — the orchestration hook wiring T16q + T06 (T16a)
//   • submission glue       — pure classification / normalization helpers (T16a)
//   • session transaction   — the durable pre/post-POST recovery record (T16q)
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
  forgetInspectedSession,
  inspectPersistedSession,
  runSubmissionTransaction,
  stageProvisionalSession,
  updateActiveCursor,
  type PreparedDegradedCleanup,
  type DegradedCleanupOutcome,
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  OPTIMIZE_TIMEOUT_MAX_SECONDS,
  OPTIMIZE_TIMEOUT_MIN_SECONDS,
  FORGET_OPTIMIZE_SESSION_WARNING,
  type ActivateOutcome,
  type ActiveOptimizeSession,
  type ForgetInspectedSessionOutcome,
  type InspectedSession,
  type OptimizeRunOptions,
  type OptimizeSessionRecord,
  type ProvisionalOptimizeSession,
  type SessionRecordIdentity,
  type SessionCodec,
  type SessionTransactionStorage,
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
  type OptimizeForgetOutcome,
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
