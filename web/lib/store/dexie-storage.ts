// The ROSTER STORAGE ACCESSOR (F1), over the one declared browser database.
//
// This module used to declare its own Dexie class -- `ScenarioPersistenceDb`, with
// its own version ladder -- against the database name `nurse-scheduler`. So did
// `lib/repository/schema.ts`. Both claimed VERSION 2, with different store sets, so
// whichever opened second hit IndexedDB's `VersionError` and its whole feature died.
// A browser that had reached the repository ladder's version 5 could not open roster
// storage at all.
//
// The declaration now lives in exactly one place. `NurseSchedulerDb` owns the name
// and one monotonic ladder that is the union of both sides, and this module is
// reduced to what F1 actually needs from it: a lazily constructed, per-name handle,
// the client-only guard, and the row DTOs. Roster storage code imports the same
// names from the same specifier and is otherwise untouched.
//
// `createDexieStorage` is deliberately GONE rather than re-exported. It fed the
// zustand `persist` seam, and the T03 cutover removed that seam: durable scenario
// writes go through the repository transaction and are PUBLISHED into a read-only
// projection afterwards. Re-exporting a `StateStorage` factory here would advertise
// a persistence path the app no longer has, and `.oxlintrc.json` closes the `persist`
// import that was its only consumer.

import { NurseSchedulerDb, NURSE_SCHEDULER_DB_NAME } from "@/lib/repository";

// Re-exported at their original specifier so roster storage still names them here.
// They are DEFINED in the repository's DTO module because the class this file hands
// out is declared there: defining them here as well would make the import cycle real
// rather than type-only.
export type { MetaRow, RosterRow, SnapshotRow } from "@/lib/repository";

/**
 * The persistence database, under the name F1 knows it by.
 *
 * An ALIAS, not a second class. Anything that constructs it gets the single declared
 * ladder, which is the entire point: two classes over one database name is the defect
 * this replaced.
 */
export { NurseSchedulerDb as ScenarioPersistenceDb } from "@/lib/repository";

/** Default IndexedDB database name. One name, one declaration. */
export const SCENARIO_DB_NAME = NURSE_SCHEDULER_DB_NAME;

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
const rosterDbCache = new Map<string, NurseSchedulerDb>();

/**
 * The lazily constructed roster database handle. Construction is deferred to the
 * first call (importing this module opens nothing), and it throws rather than
 * constructing when IndexedDB is absent, so importing the storage modules from a
 * server component can never reach IndexedDB.
 */
export function getRosterDb(databaseName: string = SCENARIO_DB_NAME): NurseSchedulerDb {
  if (!isIndexedDbAvailable()) throw new IndexedDbUnavailableError();
  const cached = rosterDbCache.get(databaseName);
  if (cached) return cached;
  const db = new NurseSchedulerDb(databaseName);
  rosterDbCache.set(databaseName, db);
  return db;
}

/** Drop a cached handle (tests open independent "tabs" against one database). */
export function forgetRosterDb(databaseName: string = SCENARIO_DB_NAME): void {
  rosterDbCache.delete(databaseName);
}
