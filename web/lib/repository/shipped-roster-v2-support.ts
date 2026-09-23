// A FROZEN transcript of the database the ROSTER STORAGE FOUNDATION (F1) shipped, plus
// a full row in every one of its tables.
//
// This is the OTHER population. Until the ladders were merged there were two Dexie
// classes over the name `nurse-scheduler`: the scenario repository's, and F1's
// `ScenarioPersistenceDb` transcribed here. Both declared a version 2, with different
// store sets, so a browser that had run either build carries a version 2 whose actual
// object stores depend on which one it ran.
//
// Kept beside the v2 and v4 repository transcripts for the same reason those exist:
// exactly one frozen copy, because a drifted "shipped" shape proves nothing about real
// browsers. Not a test file (vitest collects `*.test.ts` only), so it may be imported
// freely.

import { Dexie } from "dexie";

import type { MetaRow, RosterRow, SnapshotRow } from "./types";

/**
 * Verbatim transcript of F1's version 2 store declaration.
 *
 * Out-of-line primary key only, no secondary index: the roster documents are opaque to
 * Dexie and nothing indexes into them.
 */
export const SHIPPED_ROSTER_V2_STORES: Readonly<Record<string, string>> = {
  roster: "key",
  snapshot: "key",
  meta: "key",
};

/** Explicit table-to-DTO map, so a wrong or missing field fails typecheck. */
export interface ShippedRosterV2RowMap {
  keyval: { key: string; value: string };
  roster: RosterRow;
  snapshot: SnapshotRow;
  meta: MetaRow;
}

/**
 * One full row per table, with a value on every field F1 actually writes.
 *
 * `candidateSource` is present deliberately: it is the optional field F1 added WITHOUT a
 * version bump, so an upgrade that quietly rebuilt the store rather than carrying it
 * forward would most likely lose exactly that.
 */
export const SHIPPED_ROSTER_V2_ROWS: ShippedRosterV2RowMap = {
  keyval: { key: "scenario-store", value: '{"state":{},"version":1}' },
  roster: {
    key: "working",
    document: { marker: "shipped-working-roster", days: [1, 2, 3] },
    revision: 4,
    clearEpoch: 2,
    candidateSource: { jobId: "job-77", candidateVersion: 9 },
  },
  snapshot: {
    key: "snapshot:owner-1",
    ownerId: "owner-1",
    submissionOrdinal: 3,
    payload: { marker: "shipped-submission-snapshot" },
  },
  meta: { key: "candidateVersionCounter", value: 9 },
};

/**
 * Open `dbName` at F1's historical v1 + v2 declaration.
 *
 * The caller closes it: two live Dexie connections to one database would let a write
 * land after a later reader's snapshot.
 */
export async function openShippedRosterV2Database(dbName: string): Promise<Dexie> {
  const db = new Dexie(dbName);
  db.version(1).stores({ keyval: "key" });
  db.version(2).stores({ ...SHIPPED_ROSTER_V2_STORES });
  await db.open();
  if (db.verno !== 2) {
    throw new Error(`seeded database must really be at version 2, got ${db.verno}`);
  }
  return db;
}

/** Seed `dbName` with a genuine F1 version 2 population, then close the connection. */
export async function seedShippedRosterV2(dbName: string): Promise<void> {
  const db = await openShippedRosterV2Database(dbName);
  try {
    for (const [table, row] of Object.entries(SHIPPED_ROSTER_V2_ROWS)) {
      await db.table(table).put(row);
    }
  } finally {
    db.close();
  }
}
