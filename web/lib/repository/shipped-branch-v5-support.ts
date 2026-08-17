// A FROZEN transcript of the database this app shipped at version 5 -- the repository
// ladder's own top before the merge, and the version a developer browser that ran the
// T11 build is really sitting at (Dexie reports it as `nurse-scheduler@v50`).
//
// WHY IT IS NOT `NurseSchedulerDb`. That class declares version 6 today, so opening it
// creates a v6 database outright and the 5 -> 6 upgrade never runs. Seeding through the
// historical declaration is what makes an upgrade test an upgrade test.
//
// It reuses the v4 transcript's store strings rather than restating them: one frozen
// copy, so the two cannot drift apart.

import { Dexie } from "dexie";

import {
  SHIPPED_V4_ASSISTANT_STORES,
  SHIPPED_V4_DIAGNOSTIC_STORES,
  SHIPPED_V4_V2_STORES,
} from "./shipped-v4-support";

/** Verbatim transcript of the clear-operations store added in version 5 (T11-F1j). */
export const SHIPPED_V5_CLEAR_STORES: Readonly<Record<string, string>> = {
  assistantClearOperations: "operationId, scope",
};

/**
 * Open `dbName` at the historical v1 + v2 + v4 + v5 declaration.
 *
 * The caller closes it.
 */
export async function openShippedV5Database(dbName: string): Promise<Dexie> {
  const db = new Dexie(dbName);
  db.version(1).stores({ keyval: "key" });
  db.version(2).stores({ ...SHIPPED_V4_V2_STORES });
  db.version(4).stores({ ...SHIPPED_V4_ASSISTANT_STORES });
  db.version(4).stores({ ...SHIPPED_V4_DIAGNOSTIC_STORES });
  db.version(5).stores({ ...SHIPPED_V5_CLEAR_STORES });
  await db.open();
  if (db.verno !== 5) {
    throw new Error(`seeded database must really be at version 5, got ${db.verno}`);
  }
  return db;
}
