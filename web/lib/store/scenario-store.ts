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

// ---------------------------------------------------------------------------
// Non-finite weight codec — the JSON persistence boundary
// ---------------------------------------------------------------------------
//
// `Weight` is "an integer, or ±Infinity for a hard constraint" (lib/scenario/types.ts),
// and the product exposes both signs as real actions — the Guided Rules ±∞
// controls, and `LEAVE_PIN_WEIGHT`. Native `JSON.stringify` has no
// representation for a non-finite number and silently emits `null`, so every
// hard weight written to IndexedDB came back as `null`, `sanitizePersistedScenario`
// rejected it (`weight` must be a number), and the whole application landed in
// the destructive "Stored data could not be loaded" state.
//
// The repair belongs HERE, at the one shared serialization seam, and not in any
// route's value handling: `createJSONStorage` is the only place the scenario
// becomes JSON, and a route-local coercion would have to lie about the value.
//
// The representation is a single-key tagged OBJECT rather than a sentinel string,
// which is what makes it unambiguous in both directions:
//   • encoding only ever wraps a number, so an authored string that happens to
//     read `"Infinity"` — or even the envelope's own JSON text — round-trips as
//     exactly that string;
//   • decoding only ever unwraps an object carrying the reserved key, and the
//     durable scenario shape has no free-form record that could produce one.
//
// The codec is also SCOPED BY FIELD, because "a non-finite number" is not a
// property of the payload — it is a property of the DOMAIN a value sits in. A
// global codec revived a forged tag under `requiredNumPeople` into numeric
// `Infinity`, and the sanitizer's generic `typeof value === "number"` check
// happily accepted it, so a foreign record could hydrate `ready` in a state the
// producer schema forbids. The approved positions below were derived by auditing
// the persisted slice (`SCENARIO_KEYS`) against the producer/import schemas:
//
//   • `weight` — every `Weight`-typed field in the durable slice is spelled
//     exactly this: the five card kinds and the `off`/`request` matrix cells.
//     `zWeight` is "an integer, or ±Infinity".
//   • `weightRange` — `exportLayout.formatting[].when.preference.weightRange` is
//     an ARRAY of `zLooseNumber`, which the schema documents as "unlike a
//     preference weight — unrestricted", and whose sanitizer accepts any number.
//     It is reachable today through a Workspace Load, so scoping to `weight`
//     alone would have silently turned a valid infinite bound into `null`.
//
// Every other numeric field — `requiredNumPeople`, `preferredNumPeople`,
// `target`, `durationMinutes`, `restMinutes`, ids, coefficients — is finite-only,
// and a tag there is refused rather than decoded.
//
// Three deliberate non-goals:
//   • `NaN` is NOT encoded. It is not a representable `Weight`, so it keeps
//     serializing to `null` and keeps failing closed at the sanitizer — encoding
//     it would carry a corrupt value PAST the gate that exists to catch it.
//   • an already-corrupted `null` is left alone. Its sign is unrecoverable, and
//     guessing one would silently invent a hard constraint in a ward's roster.
//   • nothing here tries to out-validate the sanitizer on FOREIGN keys. A tag at
//     `meta.weight` still decodes, exactly as a plain `meta.weight: 5` would
//     already survive today — parity with an ordinary JSON number is the bar, and
//     stripping unknown nested keys is the sanitizer's job, not the codec's.

/** The reserved key tagging a non-finite number in the persisted JSON payload. */
export const NON_FINITE_PERSIST_TAG = "$nsNonFinite";

const POSITIVE_INFINITY_TAG = "Infinity";
const NEGATIVE_INFINITY_TAG = "-Infinity";

/** Scalar properties whose domain admits a signed infinity (see the audit above). */
const SIGNED_INFINITY_SCALAR_KEYS: ReadonlySet<string> = new Set(["weight"]);

/** Properties holding an ARRAY of numbers whose domain admits signed infinities. */
const SIGNED_INFINITY_LIST_KEYS: ReadonlySet<string> = new Set(["weightRange"]);

/** Whether `value` is an object carrying the reserved tag — well-formed or not. */
function isTagged(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, NON_FINITE_PERSIST_TAG)
  );
}

/** Wrap `±Infinity`; leave everything else (including `NaN`) exactly as it is. */
function encodeIfInfinite(value: unknown): unknown {
  // Only a number can be equal to an infinity, so no `typeof` guard is needed.
  if (value === Number.POSITIVE_INFINITY) {
    return { [NON_FINITE_PERSIST_TAG]: POSITIVE_INFINITY_TAG };
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return { [NON_FINITE_PERSIST_TAG]: NEGATIVE_INFINITY_TAG };
  }
  return value;
}

/** Unwrap a well-formed envelope; THROW on a tagged-but-malformed one. */
function decodeEnvelope(value: unknown): unknown {
  if (!isTagged(value)) return value;
  const tag = value[NON_FINITE_PERSIST_TAG];
  // Exactly one key: a tag carrying passengers is malformed, not a hard weight.
  if (Object.keys(value).length === 1) {
    if (tag === POSITIVE_INFINITY_TAG) return Number.POSITIVE_INFINITY;
    if (tag === NEGATIVE_INFINITY_TAG) return Number.NEGATIVE_INFINITY;
  }
  throw new Error(
    `Persisted scenario carries a malformed ${NON_FINITE_PERSIST_TAG} envelope ` +
      `(${JSON.stringify(value).slice(0, 120)}); refusing to guess a value.`,
  );
}

/**
 * `JSON.stringify` replacer for the durable payload. `stringify` applies the
 * replacer BEFORE it would coerce a non-finite number to `null`, so the tagged
 * envelope is what reaches storage.
 *
 * The replacer visits a holder BEFORE its children, which is why an
 * infinity-tolerant LIST is rewritten here at its own key rather than element by
 * element: an array element's own visit knows only its index, never which array it
 * belongs to. The rewritten array is walked afterwards, where each envelope is
 * already an object and passes straight through — so there is no recursion.
 *
 * An infinity at any other key is deliberately left alone, becomes `null`, and is
 * refused by the sanitizer on the next load: the app can therefore never author a
 * tag into a finite-only slot.
 */
export function encodeNonFiniteNumbers(key: string, value: unknown): unknown {
  if (SIGNED_INFINITY_SCALAR_KEYS.has(key)) return encodeIfInfinite(value);
  if (SIGNED_INFINITY_LIST_KEYS.has(key) && Array.isArray(value)) {
    return value.map((element) => encodeIfInfinite(element));
  }
  return value;
}

/**
 * `JSON.parse` reviver for the durable payload — the matching decode, which runs
 * inside `storage.getItem` and therefore strictly BEFORE `migrate` and the
 * sanitizing `merge`. Hydration sees real numeric infinities at the positions
 * whose domain admits them, exactly as the binding types say it should.
 *
 * Three outcomes, and every one of them is closed:
 *   • an approved position with a well-formed envelope decodes to the signed
 *     numeric infinity;
 *   • an approved position with a tagged-but-malformed envelope THROWS;
 *   • a FINITE-ONLY position carrying a tag THROWS — the value is refused rather
 *     than revived into a domain the schema forbids.
 *
 * A throw lands in `persist`'s hydrate chain, reaches `onRehydrateStorage` as an
 * error and routes to `recoverable-error` through the same contract a malformed
 * field already uses, leaving the stored record intact.
 *
 * `JSON.parse` walks bottom-up and binds `this` to the holder, so an ARRAY element
 * is passed over here and judged by its parent on the next visit — that is what
 * lets an infinity-tolerant list decode while an element of any other numeric
 * array is left as an object for the sanitizer to reject.
 *
 * Every value the codec never wrote — finite numbers, strings, `null`, ordinary
 * objects, and every pre-existing persisted envelope — passes through untouched,
 * so no migration or version bump is required.
 */
export function decodeNonFiniteNumbers(this: unknown, key: string, value: unknown): unknown {
  if (SIGNED_INFINITY_SCALAR_KEYS.has(key)) return decodeEnvelope(value);
  if (SIGNED_INFINITY_LIST_KEYS.has(key) && Array.isArray(value)) {
    return value.map((element) => decodeEnvelope(element));
  }
  // An array element is decided by its parent, which is visited next.
  if (Array.isArray(this)) return value;
  if (isTagged(value)) {
    throw new Error(
      `Persisted scenario carries a ${NON_FINITE_PERSIST_TAG} envelope at the finite-only ` +
        `field "${key}"; a signed infinity is only valid for a weight.`,
    );
  }
  return value;
}

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
        // The codec above is the whole repair: `guarded` (the FIFO write queue,
        // its revision/newest-wins bookkeeping and its drain) is untouched, and so
        // are `migrate`, `merge`, and the hydration-failure and reset paths.
        storage: createJSONStorage(() => guarded, {
          replacer: encodeNonFiniteNumbers,
          reviver: decodeNonFiniteNumbers,
        }),
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
 * disabled/incomplete records and export layout all count — a strict-projection
 * edit can never be misreported as a current backup.
 */
export function selectBackupStatus(state: ScenarioStoreState): BackupStatus {
  if (state.backupFingerprint === null) return "none";
  return computeScenarioFingerprint(pickScenario(state)) === state.backupFingerprint
    ? "current"
    : "stale";
}
