// State spine (T03) — public surface.
//
// The scenario projection, the hot ephemeral store, and the repository-backed
// command bus that is now the only way to change durable scenario state.
//
//   • projection   — `useScenarioStore` (read-only: no setters are exported)
//   • ephemeral    — `useHotStore`
//   • authority    — `useAuthorityStore`, `canMutateScenario`
//   • commands     — `scenarioCommands` (mutate / setReqData / recordBackup /
//                    undo / redo / takeover / release / reconcile)
//   • lifecycle    — `initializeScenarioAuthority`, `newScenario`, `loadScenario`,
//                    `resetToNewScenario`, `registerScenarioLifecycle`
//   • paint        — `commitPaintGesture`
//
// Deliberately NOT exported any more, because they no longer exist: the persist
// storage seam (`createDexieStorage`, `createGuardedStorage`, `createMemoryStorage`),
// the durable store's mutating actions, and zundo's `temporal` handle.

export {
  createStateSpine,
  getScenarioAuthority,
  setScenarioAuthority,
  stateSpine,
  useScenarioStore,
  useHotStore,
  type StateSpine,
} from "./spine";

export {
  canMutateScenario,
  resolveTabId,
  ScenarioAuthority,
  useAuthorityStore,
  type ApplyAssistantProposalOutcome,
  type AssistantProposalV1,
  type AssistantReceiptV1,
  type AssistantScenarioBasis,
  type AuthorityState,
  type CommandFailureReason,
  type CommandOutcome,
  type OwnershipHint,
  type PrepareAssistantProposalInput,
  type PrepareAssistantProposalOutcome,
  type ReceiptStanding,
  type ScenarioAuthorityConfig,
  type ScenarioOwnership,
  type WriteStatus,
} from "./authority";

export {
  assistantProposalCommands,
  drainScenarioCommands,
  readAuthoritativeScenarioIdentity,
  readAuthoritativeScenarioOwnership,
  readConflictingEditorDraft,
  readScenarioHistoryDepth,
  scenarioCommands,
} from "./commands";

export { useOwnershipController } from "./ownership";

export {
  createScenarioStore,
  selectBackupStatus,
  type BackupStatus,
  type ScenarioStore,
  type ScenarioStoreState,
} from "./scenario-store";

export { createHotStore, type HotStore, type HotStoreState } from "./hot-store";

export { commitPaintGesture } from "./paint";

export {
  initializeScenarioAuthority,
  loadScenario,
  newScenario,
  registerScenarioLifecycle,
  resetToNewScenario,
} from "./lifecycle";

export {
  computeScenarioFingerprint,
  isScenarioSliceEmpty,
  pickScenario,
  scenarioShallowEqual,
  SCENARIO_KEYS,
} from "./fingerprint";

// `./persistence` is deliberately NOT re-exported. What survives there is the
// LEGACY record's decode chain, and its one caller — the repository's one-time
// migration — imports it directly. Re-exporting it from the store's public surface
// would advertise a persistence path the app no longer has.

export {
  paintCellKey,
  INITIAL_RUN_STATE,
  type HydrationStatus,
  type RunPhase,
  type RunState,
  type RunProgressEvent,
  type PaintCellKey,
  type StagedCoordinate,
  type StagedDayState,
} from "./types";
