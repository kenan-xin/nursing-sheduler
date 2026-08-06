// The browser-default concrete persistence adapter (T04) and the roster storage
// schema (F1). This is the only module that declares the IndexedDB database, so
// it is strictly client-only — every construction path is lazy and never runs
// during SSR (the durable store uses `skipHydration` and hydrates from a client
// effect; the roster repositories are reached through `getRosterDb()`).
//
// Schema history:
//   v1 — `keyval`: the zustand `StateStorage` string facade for the scenario.
//   v2 — adds the blob-capable roster stores. `keyval` is carried over verbatim
//        (Dexie keeps prior stores unless a later version sets them to `null`),
//        so an upgrade from a POPULATED v1 database preserves every scenario row.

import { Dexie, type Table } from "dexie";
import type { StateStorage } from "zustand/middleware";

/** One key/value row — the persisted scenario payload lives under a single key. */
interface KeyValueRow {
  key: string;
  value: string;
}

/**
 * A stored roster document. F1 owns durability, not shape: the payload is an
 * opaque structured-cloneable value (it may embed a `Blob` such as `frozenXlsx`)
 * whose schema and validation belong to F3. `TDocument` defaults to `unknown` so
 * a caller that has a validated type can read it back typed without F1 inventing
 * one.
 */
export interface RosterRow<TDocument = unknown> {
  /** `working` or `candidate:<jobId>`. */
  key: string;
  document: TDocument;
  /**
   * The row's version token. Its allocation differs by row kind:
   *
   *   • `working` — a per-key compare-and-swap revision (1, 2, 3 …).
   *   • `candidate:<jobId>` — the `candidateVersion`, drawn from an ORIGIN-WIDE
   *     counter that is never reset and never reused. Deleting and recreating a
   *     candidate for the same job therefore cannot resurrect a previous version
   *     number, which is what makes it safe as a delete/promote authority (a
   *     per-key counter would restart at 1 and admit ABA).
   */
  revision: number;
  /** The clear epoch this row was written under (see `roster-storage.ts`). */
  clearEpoch: number;
}

/** An immutable submission snapshot row, keyed and authorized by `ownerId`. */
export interface SnapshotRow<TPayload = unknown> {
  /** `snapshot:<ownerId>`. */
  key: string;
  ownerId: string;
  submissionOrdinal: number;
  payload: TPayload;
}

/** One typed metadata row (origin-wide counters and pointers). */
export interface MetaRow<TValue = unknown> {
  key: string;
  value: TValue;
}

/** The IndexedDB database backing durable persistence. */
export class ScenarioPersistenceDb extends Dexie {
  keyval!: Table<KeyValueRow, string>;
  roster!: Table<RosterRow, string>;
  snapshot!: Table<SnapshotRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(databaseName: string) {
    super(databaseName);
    this.version(1).stores({ keyval: "key" });
    // Only the NEW stores are declared: Dexie carries `keyval` forward untouched,
    // so upgrading a populated v1 database never rewrites or drops its rows.
    // Out-of-line primary key only — the documents are opaque to Dexie and
    // nothing indexes into them.
    this.version(2).stores({ roster: "key", snapshot: "key", meta: "key" });
    this.keyval = this.table("keyval");
    this.roster = this.table("roster");
    this.snapshot = this.table("snapshot");
    this.meta = this.table("meta");
  }
}

/** Default IndexedDB database name. */
export const SCENARIO_DB_NAME = "nurse-scheduler";

/**
 * Thrown when a storage entry point is reached where IndexedDB does not exist —
 * i.e. on the server. Every roster repository call funnels through `getRosterDb`,
 * so an accidental server-side import fails loudly instead of silently degrading.
 */
export class IndexedDbUnavailableError extends Error {
  constructor() {
    super(
      "IndexedDB is unavailable in this environment. Roster storage is client-only; " +
        "call it from a client effect, never during SSR.",
    );
    this.name = "IndexedDbUnavailableError";
  }
}

/** Whether this environment can open an IndexedDB database at all. */
export function isIndexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

/** Lazily constructed per-database-name handles — one Dexie instance per name. */
const rosterDbCache = new Map<string, ScenarioPersistenceDb>();

/**
 * The lazily constructed roster database handle. Construction is deferred to the
 * first call (importing this module opens nothing), and it throws rather than
 * constructing when IndexedDB is absent, so importing the storage modules from a
 * server component can never reach IndexedDB.
 */
export function getRosterDb(databaseName: string = SCENARIO_DB_NAME): ScenarioPersistenceDb {
  if (!isIndexedDbAvailable()) throw new IndexedDbUnavailableError();
  const cached = rosterDbCache.get(databaseName);
  if (cached) return cached;
  const db = new ScenarioPersistenceDb(databaseName);
  rosterDbCache.set(databaseName, db);
  return db;
}

/** Drop a cached handle (tests open independent "tabs" against one database). */
export function forgetRosterDb(databaseName: string = SCENARIO_DB_NAME): void {
  rosterDbCache.delete(databaseName);
}

/**
 * Create the Dexie-backed `StateStorage`. Wrap with `createRevisionGuardedStorage`
 * before handing to `persist`. Each op is a single-row `keyval` read/write.
 */
export function createDexieStorage(databaseName: string = SCENARIO_DB_NAME): StateStorage {
  const db = new ScenarioPersistenceDb(databaseName);
  return {
    async getItem(key) {
      const row = await db.keyval.get(key);
      return row?.value ?? null;
    },
    async setItem(key, value) {
      await db.keyval.put({ key, value });
    },
    async removeItem(key) {
      await db.keyval.delete(key);
    },
  };
}
