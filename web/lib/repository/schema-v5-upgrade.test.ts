// The version 4 -> 5 upgrade, driven from a database genuinely already at 4.
//
// Version 5 adds one store and mentions no existing one, which SHOULD mean every prior
// table and index carries forward untouched. "Should" is the reason this exists: the
// claim is about what IndexedDB does to a real database, and the only way to know is to
// build one at the old declaration, upgrade it with the shipped class, and read every
// row back.
//
// Full rows, not ids. An upgrade that quietly rebuilt a store would most likely lose an
// indexed path or a nested field rather than a whole record, so the comparison is
// structured-clone equality over the complete row.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Dexie } from "dexie";
import {
  CLEAR_OPERATIONS_VERSION,
  MERGED_LADDER_VERSION,
  NurseSchedulerDb,
  REPOSITORY_SCHEMA_VERSION,
} from "./schema";
import { openShippedV4Database, SHIPPED_V4_ROWS, type ShippedV4RowMap } from "./shipped-v4-support";
import { freshDbName } from "./test-support";

describe("the v4 fixture is an exact contract, with no escapes", () => {
  // A FIXTURE THAT CANNOT FAIL PROVES NOTHING. `value: unknown` accepted any shape at
  // all, and `scenario: {} as ...` satisfied the compiler while carrying none of the
  // nested content an upgrade could lose. The negatives below are the contract: each
  // `@ts-expect-error` FAILS TYPECHECK if the type is ever loosened enough to accept
  // the bad value, because an unused expect-error is itself an error.

  it("rejects a row missing a required durable field", () => {
    const { documentRevision: _dropped, ...missingRevision } = SHIPPED_V4_ROWS.scenarioEnvelopes;
    // @ts-expect-error -- documentRevision is required on ScenarioEnvelopeV3
    const rejected: ShippedV4RowMap["scenarioEnvelopes"] = missingRevision;
    expect(rejected).toBeDefined();

    const { commandsDigest: _digest, ...missingDigest } = SHIPPED_V4_ROWS.assistantProposals;
    // @ts-expect-error -- commandsDigest is required on AssistantProposalV1
    const rejectedProposal: ShippedV4RowMap["assistantProposals"] = missingDigest;
    expect(rejectedProposal).toBeDefined();
  });

  it("rejects a key/value row whose value is not a scenario snapshot", () => {
    // @ts-expect-error -- the legacy slot stored a snapshot, not an arbitrary value
    const rejected: ShippedV4RowMap["keyval"] = { key: "legacy-key", value: "legacy-value" };
    expect(rejected).toBeDefined();
  });

  it("carries a real scenario value, not an empty cast", () => {
    // The nested content an upgrade could silently rebuild is genuinely present.
    expect(SHIPPED_V4_ROWS.scenarioEnvelopes.scenario.meta.apiVersion).toBe("alpha");
    expect(SHIPPED_V4_ROWS.scenarioEnvelopes.scenario.cardsByKind).toBeDefined();
    expect(SHIPPED_V4_ROWS.keyval.value.scenario.meta.apiVersion).toBe("alpha");
  });
});

/** Every table a v4 database has, in the order the transcript declares them. */
const V4_TABLES = Object.keys(SHIPPED_V4_ROWS);

async function seedShippedV4(dbName: string): Promise<void> {
  const db = await openShippedV4Database(dbName);
  for (const [table, row] of Object.entries(SHIPPED_V4_ROWS)) {
    await db.table(table).put({ ...row });
  }
  db.close();
}

/**
 * The complete schema, as Dexie itself describes it.
 *
 * Every store, its primary key (key path, auto-increment) and every index with its key
 * path and flags. Comparing tables and rows proves the DATA survived; this proves the
 * SHAPE did -- an upgrade that rebuilt a store could keep every row while losing a
 * unique constraint, a multi-entry flag or a compound key path, and nothing about the
 * rows would show it.
 */
function schemaDescriptor(db: Dexie) {
  return db.tables
    .map((table) => ({
      name: table.name,
      primaryKey: {
        keyPath: table.schema.primKey.keyPath ?? null,
        auto: table.schema.primKey.auto === true,
        unique: table.schema.primKey.unique === true,
      },
      indexes: table.schema.indexes
        .map((index) => ({
          name: index.name,
          keyPath: index.keyPath ?? null,
          unique: index.unique === true,
          multi: index.multi === true,
          compound: index.compound === true,
          auto: index.auto === true,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Every row of every named table, as complete structured clones. */
async function readAll(db: Dexie, tables: readonly string[]) {
  const out: Record<string, unknown[]> = {};
  for (const table of tables) out[table] = structuredClone(await db.table(table).toArray());
  return out;
}

describe("a real version 4 database upgraded by the shipped class", () => {
  it("keeps every table, index and full row, and adds an empty usable store", async () => {
    const dbName = freshDbName();
    await seedShippedV4(dbName);

    // What the database held before anything touched it, read through the historical
    // declaration so the baseline is not itself produced by the code under test.
    const legacy = await openShippedV4Database(dbName);
    const before = await readAll(legacy, V4_TABLES);
    legacy.close();
    // Non-vacuity: the baseline is not empty.
    for (const table of V4_TABLES) expect(before[table], table).toHaveLength(1);

    const db = new NurseSchedulerDb(dbName);
    await db.open();
    try {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      // The clear-operations table is still a version 5 addition; the ladder's TOP is
      // now the version-6 merge marker, which adds no store of its own.
      expect(CLEAR_OPERATIONS_VERSION).toBe(5);
      expect(REPOSITORY_SCHEMA_VERSION).toBe(MERGED_LADDER_VERSION);

      // EVERY V4 TABLE STILL EXISTS.
      const names = db.tables.map((table) => table.name);
      for (const table of V4_TABLES) expect(names, table).toContain(table);
      // And the new one was created by this upgrade.
      expect(names).toContain("assistantClearOperations");

      // EVERY ROW, BYTE FOR BYTE.
      expect(await readAll(db, V4_TABLES)).toEqual(before);

      // EVERY INDEX still resolves -- including the compound, unique, nested and
      // auto-incremented ones, which are what a rebuilt store would lose.
      expect(
        await db.assistantThreads
          .where("[scenarioId+state]")
          .equals(["scenario-1", "active"])
          .count(),
      ).toBe(1);
      expect(
        await db.assistantMessages.where("[threadId+seq]").equals(["thread-1", 0]).count(),
      ).toBe(1);
      expect(
        await db.scenarioCommits
          .where("[scenarioId+documentRevision]")
          .equals(["scenario-1", 7])
          .count(),
      ).toBe(1);
      expect(await db.scenarioCommits.where("idempotencyKey").equals("idem-9").count()).toBe(1);
      expect(await db.diagnosticSearches.where("parent.basisId").equals("basis-1").count()).toBe(1);
      expect(await db.historyLinks.where("sourceCommitId").equals("commit-8").count()).toBe(1);
      expect(
        await db.optimizeBases
          .where("[scenarioId+documentRevision]")
          .equals(["scenario-1", 7])
          .count(),
      ).toBe(1);

      // THE NEW STORE IS EMPTY AND USABLE, including its own secondary index.
      expect(await db.assistantClearOperations.count()).toBe(0);
      await db.assistantClearOperations.put({
        operationId: "op-1",
        version: 3,
        scope: "all",
        scenarioId: null,
        captured: [{ scopeKey: "global", generation: 1 }],
        commitment: { count: 1, canonical: '[["global",1]]' },
        startedAt: "2026-08-01T00:00:00.000Z",
        outcome: "pending",
      });
      expect(await db.assistantClearOperations.where("scope").equals("all").count()).toBe(1);
      expect((await db.assistantClearOperations.get("op-1"))?.captured).toEqual([
        { scopeKey: "global", generation: 1 },
      ]);

      // And the upgrade did not touch the rows while proving that.
      expect(await readAll(db, V4_TABLES)).toEqual(before);

      // INDEXES NOT EXERCISED BY ANY QUERY ABOVE, so a declaration mutation has an
      // anchor here rather than passing unnoticed.
      const shape = schemaDescriptor(db);
      const named = (name: string) => shape.find((table) => table.name === name)!;
      expect(
        named("scenarioCommits").indexes.find((index) => index.name === "idempotencyKey"),
      ).toMatchObject({ unique: true });
      expect(named("historyLinks").primaryKey).toMatchObject({ keyPath: "seq", auto: true });
      expect(
        named("assistantMessages").indexes.find((index) => index.name === "[threadId+seq]"),
      ).toMatchObject({ compound: true, unique: false });
      expect(
        named("diagnosticSearches").indexes.find((index) => index.name === "parent.basisId"),
      ).toMatchObject({ keyPath: "parent.basisId" });
      expect(named("writerLeases").indexes.map((index) => index.name)).toEqual([
        "expiresAt",
        "ownerTabId",
      ]);
      expect(named("tabSelections").indexes.map((index) => index.name)).toEqual(["scenarioId"]);
      expect(named("assistantClearOperations").primaryKey).toMatchObject({
        keyPath: "operationId",
        auto: false,
      });
    } finally {
      db.close();
    }
  });

  it("creates the same shape from scratch, so fresh and upgraded agree", async () => {
    const fresh = new NurseSchedulerDb(freshDbName());
    await fresh.open();
    try {
      expect(fresh.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      const freshShape = schemaDescriptor(fresh);
      // Non-vacuity: the descriptor is a real description, not an empty one.
      expect(freshShape.length).toBeGreaterThan(10);
      expect(freshShape.some((table) => table.indexes.some((index) => index.compound))).toBe(true);
      expect(freshShape.some((table) => table.indexes.some((index) => index.unique))).toBe(true);
      expect(freshShape.some((table) => table.primaryKey.auto)).toBe(true);

      const upgradedName = freshDbName();
      await seedShippedV4(upgradedName);
      const upgraded = new NurseSchedulerDb(upgradedName);
      await upgraded.open();
      try {
        // A browser that upgraded and one that installed today must not diverge --
        // otherwise a later version's declaration means two different things. Compared
        // as the FULL descriptor: every store, key path, flag and index.
        expect(schemaDescriptor(upgraded)).toEqual(freshShape);
      } finally {
        upgraded.close();
      }
    } finally {
      fresh.close();
    }
  });

  it("chains from a really-shipped version 2 database through to 5", async () => {
    // The longest real path: a browser that never opened a v4 build at all.
    const dbName = freshDbName();
    const legacy = new Dexie(dbName);
    legacy.version(1).stores({ keyval: "key" });
    await legacy.open();
    expect(legacy.verno).toBe(1);
    await legacy.table("keyval").put({ key: "ancient", value: "still-here" });
    legacy.close();

    const db = new NurseSchedulerDb(dbName);
    await db.open();
    try {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      expect(await db.table("keyval").get("ancient")).toEqual({
        key: "ancient",
        value: "still-here",
      });
      expect(await db.assistantClearOperations.count()).toBe(0);
    } finally {
      db.close();
    }
  });
});
