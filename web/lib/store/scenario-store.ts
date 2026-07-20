// The durable scenario store (T04): `ScenarioUiState` (T18) + the persisted
// Workspace-backup fingerprint, wrapped in `persist(temporal(...))`.
//
// Middleware order (documented zundo pattern): `persist` OUTER, `temporal` INNER.
// zundo keeps undo history in a *separate* `.temporal` store, not in main state,
// so persist only ever serializes the scenario slice — history is never
// persisted. Both `.persist` and `.temporal` are attached to the same store api.
//
//   • temporal is partialized to the scenario slice only (never the backup
//     fingerprint or actions) and depth-limited to 50, so undo/redo restores
//     scenario data and nothing else.
//   • persist is partialized to the scenario slice + the backup fingerprint,
//     uses `skipHydration` (hydration is a client-only manual protocol — see
//     `lifecycle.ts`), a `version` + `migrate`, a sanitizing `merge`, and the
//     guarded storage queue.
//
// READY GATE (persistence-correctness): the durable store is created empty. Since
// `persist` writes on EVERY `setState`, an edit before manual rehydrate would
// clobber the not-yet-read saved record. So the mutating actions are no-ops until
// the spine reports `ready` (`isReady`); the lifecycle controller replaces state
// through the privileged `store.setState` path, which bypasses the gate.

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { temporal } from "zundo";
import {
  createEmptyScenarioUiState,
  type ScenarioUiState,
  type UiRequestCell,
} from "@/lib/scenario";
import { computeScenarioFingerprint, pickScenario, scenarioShallowEqual } from "./fingerprint";
import { createDexieStorage } from "./dexie-storage";
import {
  createGuardedStorage,
  type GuardedStorage,
  migrateScenarioState,
  sanitizePersistedScenario,
  SCENARIO_PERSIST_KEY,
  SCENARIO_PERSIST_VERSION,
} from "./persistence";

/**
 * Backup currentness of the live scenario relative to the last recorded Workspace
 * backup. A display-only tri-state (No backup / Backup current / Backup out of
 * date); never blocks navigation or unload. See {@link selectBackupStatus}.
 */
export type BackupStatus = "none" | "current" | "stale";

/**
 * The durable store's state: the scenario slice, the persisted Workspace-backup
 * fingerprint, and the spine mutation primitives. Editor-specific CRUD actions
 * (staff/shift/card editors) are added by their own tickets; T04 provides the
 * generic tracked-mutation primitives. All mutating actions no-op until `ready`.
 */
export interface ScenarioStoreState extends ScenarioUiState {
  /**
   * Fingerprint of the Workspace document at the last successful plain Download —
   * the emitted local backup. `null` means "no backup recorded" (unknown): a fresh
   * store, a loaded/replaced scenario, or a migrated legacy record. Only a real
   * plain Download sets it (DL12/T17r review P0); hydration/New/Load never do.
   */
  backupFingerprint: string | null;

  /**
   * Apply a scenario patch as one tracked mutation (the editor primitive).
   * No-op unless the spine is `ready`. Every changed field must be given a fresh
   * reference so history/dirty stay accurate.
   */
  mutateScenario(
    patch: Partial<ScenarioUiState> | ((state: ScenarioUiState) => Partial<ScenarioUiState>),
  ): void;

  /**
   * Overwrite the person×date matrix in a single tracked write — the paint
   * gesture's atomic commit target (one write ⇒ one zundo entry ⇒ one revision).
   * No-op unless the spine is `ready`.
   */
  setReqData(reqData: UiRequestCell[]): void;

  /**
   * Record the current scenario as the emitted Workspace backup — called only
   * after a successful plain Download, which writes exactly this state. Sets
   * `backupFingerprint` to the current scenario's fingerprint. No-op unless `ready`.
   */
  recordBackup(): void;
}

/** Zustand store api for the durable scenario store, incl. persist + temporal. */
export type ScenarioStore = ReturnType<typeof createScenarioStore>;

/** Config for {@link createScenarioStore}; omit `createStorage` for the Dexie default. */
export interface ScenarioStoreConfig {
  /**
   * Lazy raw-`StateStorage` factory, wrapped by the guarded queue internally.
   * Called lazily, so the Dexie default is only constructed on the client at first
   * read/write. Tests inject an in-memory storage here.
   */
  createStorage?: () => StateStorage;
  /**
   * Ready predicate for the mutation gate. Defaults to always-ready; the spine
   * wires this to the hot store's hydration status so edits before `ready` are
   * refused. See {@link createStateSpine}.
   */
  isReady?: () => boolean;
}

// Per-store side tables, keyed by the store api, so the lifecycle controller can
// read the last hydration error, reach the guarded storage (for awaited clears /
// pagehide drain), and check readiness (for the flush gate) without polluting the
// store's public shape.
const hydrationErrors = new WeakMap<object, { error: unknown }>();
const guardedStorages = new WeakMap<object, GuardedStorage>();
const readinessChecks = new WeakMap<object, () => boolean>();

/** Read and clear the last hydration error recorded for a store (or `null`). */
export function consumeHydrationError(store: ScenarioStore): unknown {
  const holder = hydrationErrors.get(store);
  if (!holder) return null;
  const { error } = holder;
  holder.error = null;
  return error ?? null;
}

/** The guarded storage backing a store — for awaited clears and pagehide drain. */
export function getScenarioStorage(store: ScenarioStore): GuardedStorage | undefined {
  return guardedStorages.get(store);
}

/**
 * Whether the store's spine readiness gate currently passes (the paired hot
 * store reports `ready`). Pre-hydration and recoverable-error states return
 * `false` so `flushScenarioPersist` cannot serialize the empty/error store over
 * a protected record.
 */
export function isScenarioReady(store: ScenarioStore): boolean {
  return readinessChecks.get(store)?.() ?? true;
}

/**
 * Create a durable scenario store instance. Exposed as a factory so tests get an
 * isolated store with injected storage; the app uses the {@link createStateSpine}
 * singletons.
 */
export function createScenarioStore(config: ScenarioStoreConfig = {}) {
  const createStorage = config.createStorage ?? (() => createDexieStorage());
  const isReady = config.isReady ?? (() => true);
  const holder = { error: null as unknown };
  const guarded = createGuardedStorage(createStorage);

  const store = create<ScenarioStoreState>()(
    persist(
      temporal(
        (set, get) => ({
          ...createEmptyScenarioUiState(),
          backupFingerprint: null,

          mutateScenario: (patch) => {
            if (!isReady()) return;
            const delta = typeof patch === "function" ? patch(get()) : patch;
            set(delta as Partial<ScenarioStoreState>, false);
          },

          setReqData: (reqData) => {
            if (!isReady()) return;
            set({ reqData }, false);
          },

          recordBackup: () => {
            if (!isReady()) return;
            set({ backupFingerprint: computeScenarioFingerprint(pickScenario(get())) }, false);
          },
        }),
        {
          // Depth ~50; scenario slice only — never the backup fingerprint/actions.
          limit: 50,
          partialize: (state) => pickScenario(state),
          // Skip recording no-op sets (e.g. recordBackup, pagehide flush) that leave
          // the scenario slice's references untouched.
          equality: (past, current) => scenarioShallowEqual(past, current),
        },
      ),
      {
        name: SCENARIO_PERSIST_KEY,
        version: SCENARIO_PERSIST_VERSION,
        storage: createJSONStorage(() => guarded),
        // Persist the scenario slice + the backup fingerprint (so a reload can tell
        // whether the restored work matches its last downloaded backup). Actions
        // are dropped.
        partialize: (state) => ({
          ...pickScenario(state),
          backupFingerprint: state.backupFingerprint,
        }),
        skipHydration: true,
        migrate: (persisted, version) => migrateScenarioState(persisted, version),
        // Allowlist the persisted payload to the known scenario keys before it is
        // spread into live state (persist applies this with `replace: true`), so a
        // malformed payload can neither overwrite action fns nor inject foreign
        // state. A malformed field throws here → routes to `recoverable-error`.
        merge: (persisted, current) => ({
          ...current,
          ...sanitizePersistedScenario(persisted),
        }),
        onRehydrateStorage: () => (_state, error) => {
          holder.error = error ?? null;
        },
      },
    ),
  );

  hydrationErrors.set(store, holder);
  guardedStorages.set(store, guarded);
  readinessChecks.set(store, isReady);
  return store;
}

/**
 * Backup currentness of the live scenario against the last recorded Workspace
 * backup — a nonblocking display state, never a guard input:
 *
 *   • `"none"`    — no backup recorded (`backupFingerprint === null`): a fresh,
 *                   loaded, replaced, or migrated-legacy workspace.
 *   • `"current"` — the live scenario matches the last downloaded backup.
 *   • `"stale"`   — the live scenario has diverged from the last downloaded backup.
 *
 * Computed from the canonical Workspace V1 fingerprint (see `fingerprint.ts`), so
 * Guided pins, disabled/incomplete records, and export layout all count — a
 * strict-projection edit can never be misreported as a current backup.
 */
export function selectBackupStatus(state: ScenarioStoreState): BackupStatus {
  if (state.backupFingerprint === null) return "none";
  return computeScenarioFingerprint(pickScenario(state)) === state.backupFingerprint
    ? "current"
    : "stale";
}
