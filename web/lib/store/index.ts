// State spine (T04) — public surface. Two firm stores (durable scenario + hot
// ephemeral) wired by the spine, zundo undo/redo on the durable slice, the
// paint-gesture commit protocol, and the Dexie persistence lifecycle. See
// tech-plan §4.
//
//   • wired spine    — `useScenarioStore` / `useHotStore` / `createStateSpine`
//   • undo/redo       — `store.temporal.getState()` (zundo)
//   • backup freshness— `selectBackupStatus`, `recordBackup`
//   • lifecycle       — `hydrateScenarioStore`, `loadScenario`, `newScenario`,
//                       `resetToNewScenario`, `registerPagehideFlush`
//   • paint gesture   — `commitPaintGesture` (+ hot-store `beginPaint` /
//                       `stagePaintDayState` / `stagePaintRequestDelta` / `stagePaintErase`)

export {
  createStateSpine,
  stateSpine,
  useScenarioStore,
  useHotStore,
  type StateSpine,
  type StateSpineConfig,
} from "./spine";

export {
  createScenarioStore,
  selectBackupStatus,
  consumeHydrationError,
  getScenarioStorage,
  type BackupStatus,
  type ScenarioStore,
  type ScenarioStoreState,
  type ScenarioStoreConfig,
} from "./scenario-store";

export { createHotStore, type HotStore, type HotStoreState } from "./hot-store";

export { commitPaintGesture } from "./paint";

export {
  hydrateScenarioStore,
  loadScenario,
  newScenario,
  resetToNewScenario,
  flushScenarioPersist,
  drainScenarioPersist,
  registerPagehideFlush,
} from "./lifecycle";

export {
  computeScenarioFingerprint,
  isScenarioSliceEmpty,
  pickScenario,
  scenarioShallowEqual,
  SCENARIO_KEYS,
} from "./fingerprint";

export {
  SCENARIO_PERSIST_KEY,
  SCENARIO_PERSIST_VERSION,
  migrateScenarioState,
  sanitizePersistedScenario,
  createGuardedStorage,
  createMemoryStorage,
  type PersistedScenarioState,
  type GuardedStorage,
  type MemoryStateStorage,
} from "./persistence";

export { createDexieStorage, SCENARIO_DB_NAME } from "./dexie-storage";

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
