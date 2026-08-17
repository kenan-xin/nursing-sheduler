// THE MERGE OF TWO DEXIE LADDERS OVER ONE DATABASE NAME.
//
// `nurse-scheduler` was opened by two features that each declared their own version
// ladder against it, and both claimed VERSION 2 with a different store set:
//
//   repository ladder  1 keyval | 2 repository tables | 4 assistant + diagnostic | 5 clear
//   roster ladder      1 keyval | 2 roster / snapshot / meta
//
// Whichever opened second raised `VersionError` and its feature failed outright, so a
// browser that had reached version 5 could not open roster storage at all. The ladders
// are now one, declared in `schema.ts`, and this file is the evidence that BOTH real
// populations upgrade onto it without losing a row.
//
// EVERY population is seeded through a FROZEN HISTORICAL DECLARATION, never through
// `NurseSchedulerDb`. That class declares version 6, so seeding with it would create a
// v6 database outright and no upgrade would run -- the test would prove only that the
// current declaration is self-consistent, which is the one thing that cannot fail.
//
// The last test is the one that constrains the DESIGN rather than checking it. It
// measures what Dexie does to the naive merge -- roster stores declared only in the new
// top version -- against a real roster-ladder population, because "declare the new
// tables at the top, like every other addition" is the obvious thing to do here and it
// silently destroys user data.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Dexie } from "dexie";

import {
  MERGED_LADDER_VERSION,
  NurseSchedulerDb,
  REPOSITORY_SCHEMA_VERSION,
  ROSTER_STORAGE_TABLES_VERSION,
} from "./schema";
import {
  SHIPPED_ROSTER_V2_ROWS,
  SHIPPED_ROSTER_V2_STORES,
  openShippedRosterV2Database,
  seedShippedRosterV2,
} from "./shipped-roster-v2-support";
import { SHIPPED_V2_STORES, openShippedV2Database, shippedV1BasisRow } from "./shipped-v2-support";
import {
  SHIPPED_V4_ASSISTANT_STORES,
  SHIPPED_V4_DIAGNOSTIC_STORES,
  SHIPPED_V4_ROWS,
  SHIPPED_V4_V2_STORES,
  openShippedV4Database,
} from "./shipped-v4-support";
import { SHIPPED_V5_CLEAR_STORES, openShippedV5Database } from "./shipped-branch-v5-support";
import { freshDbName } from "./test-support";

/** The stores the merged ladder must end up with, whichever side it came from. */
const REPOSITORY_SIDE_TABLES = [
  "keyval",
  "scenarioEnvelopes",
  "tabSelections",
  "writerLeases",
  "scenarioCommits",
  "historyLinks",
  "assistantGenerations",
  "assistantProposals",
  "assistantReceipts",
  "optimizeBases",
  "repositoryMeta",
  "assistantSettings",
  "assistantThreads",
  "assistantTurns",
  "assistantMessages",
  "diagnosticSearches",
  "assistantClearOperations",
] as const;

const ROSTER_SIDE_TABLES = ["roster", "snapshot", "meta"] as const;

/** A complete structural description: every store, key path, flag and index. */
function schemaDescriptor(db: Dexie) {
  return db.tables
    .map((table) => ({
      name: table.name,
      primaryKey: {
        keyPath: JSON.stringify(table.schema.primKey.keyPath ?? null),
        auto: Boolean(table.schema.primKey.auto),
      },
      indexes: table.schema.indexes
        .map((index) => ({
          name: index.name,
          keyPath: JSON.stringify(index.keyPath ?? null),
          unique: Boolean(index.unique),
          multi: Boolean(index.multi),
          compound: Boolean(index.compound),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Open the merged declaration on `dbName`, run `body`, and always close. */
async function withMergedDb<T>(dbName: string, body: (db: NurseSchedulerDb) => Promise<T>) {
  const db = new NurseSchedulerDb(dbName);
  await db.open();
  try {
    return await body(db);
  } finally {
    db.close();
  }
}

describe("the merged ladder is declared where each side actually shipped it", () => {
  it("puts the roster stores at version 2, not at the new top version", () => {
    // The single most important fact in this file, pinned as a value so a later edit
    // that "tidies" the roster stores up to the top version fails here and reads the
    // last test in this file to find out why.
    expect(ROSTER_STORAGE_TABLES_VERSION).toBe(2);
    expect(MERGED_LADDER_VERSION).toBe(6);
    expect(REPOSITORY_SCHEMA_VERSION).toBe(MERGED_LADDER_VERSION);
  });

  it("declares every store from both sides", () => {
    const db = new NurseSchedulerDb("merged-ladder-declaration-probe");
    try {
      const names = db.tables.map((table) => table.name);
      for (const table of REPOSITORY_SIDE_TABLES) expect(names, table).toContain(table);
      for (const table of ROSTER_SIDE_TABLES) expect(names, table).toContain(table);
    } finally {
      db.close();
    }
  });
});

describe("a ROSTER-ladder version 2 browser upgrades onto the merged ladder", () => {
  it("keeps every roster row and gains every repository, assistant and clear store", async () => {
    const dbName = freshDbName();
    await seedShippedRosterV2(dbName);

    // The baseline is read back through the HISTORICAL declaration, so it is not itself
    // produced by the code under test.
    const before = await openShippedRosterV2Database(dbName);
    const baseline = {
      keyval: await before.table("keyval").toArray(),
      roster: await before.table("roster").toArray(),
      snapshot: await before.table("snapshot").toArray(),
      meta: await before.table("meta").toArray(),
    };
    before.close();
    // Non-vacuity: there really was something to lose.
    for (const rows of Object.values(baseline)) expect(rows).toHaveLength(1);

    await withMergedDb(dbName, async (db) => {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);

      // NOTHING WAS DROPPED. Compared as whole rows, because the optional
      // `candidateSource` is exactly the field a rebuilt store would lose.
      expect(await db.roster.toArray()).toEqual(baseline.roster);
      expect(await db.snapshot.toArray()).toEqual(baseline.snapshot);
      expect(await db.meta.toArray()).toEqual(baseline.meta);
      expect(await db.table("keyval").toArray()).toEqual(baseline.keyval);
      expect(await db.roster.get("working")).toEqual(SHIPPED_ROSTER_V2_ROWS.roster);

      // AND THE OTHER SIDE'S STORES NOW EXIST, empty.
      const names = db.tables.map((table) => table.name);
      for (const table of REPOSITORY_SIDE_TABLES) expect(names, table).toContain(table);
      expect(await db.scenarioEnvelopes.count()).toBe(0);
      expect(await db.assistantMessages.count()).toBe(0);
      expect(await db.diagnosticSearches.count()).toBe(0);
      expect(await db.assistantClearOperations.count()).toBe(0);
    });
  });
});

describe("every REPOSITORY-ladder population upgrades onto the merged ladder", () => {
  it("a version 2 browser keeps its repository rows and gains the roster stores", async () => {
    const dbName = freshDbName();
    const seed = await openShippedV2Database(dbName, SHIPPED_V2_STORES);
    await seed.table("keyval").put({ key: "legacy-key", value: "legacy-value" });
    await seed.table("optimizeBases").put(shippedV1BasisRow({ basisId: "basis-legacy-1" }));
    seed.close();

    await withMergedDb(dbName, async (db) => {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      // The legacy V1 basis row survives byte for byte -- the upgrade never rewrites rows.
      expect(await db.optimizeBases.get("basis-legacy-1")).toEqual(
        shippedV1BasisRow({ basisId: "basis-legacy-1" }),
      );
      expect(await db.table("keyval").get("legacy-key")).toEqual({
        key: "legacy-key",
        value: "legacy-value",
      });
      for (const table of ROSTER_SIDE_TABLES) {
        expect(
          db.tables.map((t) => t.name),
          table,
        ).toContain(table);
      }
      expect(await db.roster.count()).toBe(0);
    });
  });

  it("a shipped version 4 browser keeps every v4 row and gains the roster stores", async () => {
    const dbName = freshDbName();
    const seed = await openShippedV4Database(dbName);
    for (const [table, row] of Object.entries(SHIPPED_V4_ROWS)) {
      await seed.table(table).put(row);
    }
    seed.close();

    await withMergedDb(dbName, async (db) => {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      for (const [table, row] of Object.entries(SHIPPED_V4_ROWS)) {
        const stored = await db.table(table).toArray();
        expect(stored, table).toEqual([row]);
      }
      for (const table of ROSTER_SIDE_TABLES) {
        expect(
          db.tables.map((t) => t.name),
          table,
        ).toContain(table);
      }
    });
  });

  it("a version 5 browser -- the branch's own shipped top -- gains the roster stores", async () => {
    // The case a version bump is REQUIRED for. IndexedDB only fires `upgradeneeded` on a
    // version increase, so had the merged ladder kept 5 as its top, this browser would
    // have opened unchanged and roster storage would have found no `roster` store.
    const dbName = freshDbName();
    const seed = await openShippedV5Database(dbName);
    await seed.table("assistantSettings").put(SHIPPED_V4_ROWS.assistantSettings);
    await seed.table("assistantClearOperations").put({ operationId: "op-1", scope: "all" });
    seed.close();

    await withMergedDb(dbName, async (db) => {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      expect(await db.assistantSettings.get("local")).toEqual(SHIPPED_V4_ROWS.assistantSettings);
      expect(await db.assistantClearOperations.get("op-1")).toEqual({
        operationId: "op-1",
        scope: "all",
      });
      for (const table of ROSTER_SIDE_TABLES) {
        expect(
          db.tables.map((t) => t.name),
          table,
        ).toContain(table);
      }
      expect(await db.snapshot.count()).toBe(0);
    });
  });

  it("a version 1 keyval-only browser converges too", async () => {
    const dbName = freshDbName();
    const legacy = new Dexie(dbName);
    legacy.version(1).stores({ keyval: "key" });
    await legacy.open();
    expect(legacy.verno).toBe(1);
    await legacy.table("keyval").put({ key: "ancient", value: "still-here" });
    legacy.close();

    await withMergedDb(dbName, async (db) => {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      expect(await db.table("keyval").get("ancient")).toEqual({
        key: "ancient",
        value: "still-here",
      });
      const names = db.tables.map((table) => table.name);
      for (const table of [...REPOSITORY_SIDE_TABLES, ...ROSTER_SIDE_TABLES]) {
        expect(names, table).toContain(table);
      }
    });
  });
});

describe("all four populations and a fresh install agree on one schema", () => {
  it("produces an identical descriptor whichever ladder the browser came from", async () => {
    // If two populations upgraded to structurally different databases, the version
    // number would mean two different things and the next version's diff would be
    // computed against the wrong baseline in one of them.
    const freshName = freshDbName();
    const expected = await withMergedDb(freshName, async (db) => {
      const shape = schemaDescriptor(db);
      // Non-vacuity: a real description, with the indexes that make it one.
      expect(shape.length).toBeGreaterThan(15);
      expect(shape.some((t) => t.indexes.some((i) => i.compound))).toBe(true);
      expect(shape.some((t) => t.indexes.some((i) => i.unique))).toBe(true);
      expect(shape.some((t) => t.primaryKey.auto)).toBe(true);
      return shape;
    });

    const rosterName = freshDbName();
    await seedShippedRosterV2(rosterName);

    const v4Name = freshDbName();
    const v4 = await openShippedV4Database(v4Name);
    v4.close();

    const v5Name = freshDbName();
    const v5 = await openShippedV5Database(v5Name);
    v5.close();

    for (const [label, name] of [
      ["roster v2", rosterName],
      ["repository v4", v4Name],
      ["repository v5", v5Name],
    ] as const) {
      const actual = await withMergedDb(name, async (db) => schemaDescriptor(db));
      expect(actual, label).toEqual(expected);
    }
  });
});

describe("the naive merge is measured, not assumed", () => {
  it("DESTROYS the roster rows when the roster stores are declared only at the top", async () => {
    // WHAT THIS PROVES, AND WHY IT IS HERE. Adding new tables in a new top version is
    // the normal, safe, additive Dexie move, and it is what every other addition to this
    // database did. It is WRONG here, and nothing about the code says so.
    //
    // `updateTablesAndIndexes` runs every declared version from the installed one
    // upward, and after each one calls `deleteRemovedTables(thatVersionsCumulativeSchema)`
    // -- which drops every object store the real database has and that version's schema
    // does not name. A roster-ladder browser at version 2 walks 2 -> 4 -> 5 -> 6, and at
    // the version 2 step a naive ladder's cumulative schema is the REPOSITORY tables
    // only. So `roster`, `snapshot` and `meta` are deleted there, with every row in them,
    // and version 6 recreates them empty. The upgrade reports success.
    //
    // This is not a hypothetical: it is the shape the merge would take by default.
    class NaivelyMergedDb extends Dexie {
      constructor(name: string) {
        super(name);
        this.version(1).stores({ keyval: "key" });
        this.version(2).stores({ ...SHIPPED_V4_V2_STORES });
        this.version(4).stores({ ...SHIPPED_V4_ASSISTANT_STORES });
        this.version(4).stores({ ...SHIPPED_V4_DIAGNOSTIC_STORES });
        this.version(5).stores({ ...SHIPPED_V5_CLEAR_STORES });
        // THE MISTAKE: the roster stores at the top instead of at the version that
        // shipped them.
        this.version(6).stores({ ...SHIPPED_ROSTER_V2_STORES });
      }
    }

    const dbName = freshDbName();
    await seedShippedRosterV2(dbName);

    const naive = new NaivelyMergedDb(dbName);
    await naive.open();
    try {
      // It opens cleanly and reports the new version. Nothing warns.
      expect(naive.verno).toBe(6);
      expect(naive.tables.map((t) => t.name)).toContain("roster");
      // And the user's roster is gone.
      expect(await naive.table("roster").count()).toBe(0);
      expect(await naive.table("snapshot").count()).toBe(0);
      expect(await naive.table("meta").count()).toBe(0);
    } finally {
      naive.close();
    }

    // The SAME population, through the ladder that is actually shipped: every row intact.
    const shippedName = freshDbName();
    await seedShippedRosterV2(shippedName);
    await withMergedDb(shippedName, async (db) => {
      expect(await db.roster.get("working")).toEqual(SHIPPED_ROSTER_V2_ROWS.roster);
      expect(await db.snapshot.count()).toBe(1);
      expect(await db.meta.count()).toBe(1);
    });
  });
});
