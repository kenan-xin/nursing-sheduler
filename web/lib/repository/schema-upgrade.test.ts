// The Dexie 2 -> 3 UPGRADE path, driven from a database that is genuinely already
// at the shipped version 2 (T02/T03) rather than from a fresh one.
//
// WHY THIS CANNOT USE `NurseSchedulerDb` TO SEED. That class declares version 3
// today, so opening it creates a v3 database outright and the upgrade never runs.
// A test built that way proves only that the current declaration is
// self-consistent — exactly the thing that cannot fail. So the database under test
// is opened first at the LITERAL, frozen transcript of what commit c283b72 shipped
// (`shipped-v2-support.ts`, shared with the store-level upgrade suite). That is
// what makes this an upgrade test: the browser really was at 2, and then the
// integrated code opens it at 3.
//
// This file stops at RAW DEXIE ACCESS on purpose. That the upgraded rows are then
// read correctly by the real authority boot sweep and the recovery classifier is
// proven in `lib/store/optimize-basis-legacy.test.ts`, which owns those readers.
//
// WHAT IS ACTUALLY AT RISK. T04 added the four assistant stores in a NEW version
// 3, which is the safe, additive shape. T08 changed the `optimizeBases` ROW TYPE
// (`OptimizeBasisV1` -> `OptimizeBasisRecordV2`) but NOT its index string and NOT
// its version — the store itself has existed since T02. The danger a future change
// could introduce is adding a store to the ALREADY-INSTALLED version 2 block,
// which a browser sitting at 2 would never re-run. The second test pins Dexie's
// real behaviour for that case so the assumption is measured, not believed.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { NurseSchedulerDb, REPOSITORY_SCHEMA_VERSION } from "./schema";
import { SHIPPED_V2_STORES, openShippedV2Database, shippedV1BasisRow } from "./shipped-v2-support";
import { freshDbName } from "./test-support";

/** The stores version 3 adds on top of version 2 (T04). */
const ASSISTANT_STORES = [
  "assistantSettings",
  "assistantThreads",
  "assistantTurns",
  "assistantMessages",
] as const;

/**
 * A basis row exactly as a pre-T08 build wrote it. Seeded through the historical
 * schema so the row in the database is a real legacy row, not a V2 row in disguise.
 */
const LEGACY_BASIS_ROW = shippedV1BasisRow({ basisId: "basis-legacy-1" });

const LEGACY_ENVELOPE_ROW = {
  scenarioId: "scenario-1",
  schemaVersion: 3,
  documentRevision: 7,
  recordRevision: 11,
  acceptedLeaseEpoch: 2,
  topCommitId: "commit-9",
  historySessionId: "session-a",
  historyCursor: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  scenario: { marker: "legacy-scenario-content" },
  backupFingerprint: "fingerprint-legacy",
} as const;

/** Open `dbName` at the historical v1+v2 declaration and seed it, then close. */
async function seedShippedV2Database(
  dbName: string,
  stores: Readonly<Record<string, string>> = SHIPPED_V2_STORES,
): Promise<void> {
  const db = await openShippedV2Database(dbName, stores);

  expect(db.verno, "seeded database must really be at version 2").toBe(2);

  await db.table("keyval").put({ key: "legacy-key", value: "legacy-value" });
  await db.table("scenarioEnvelopes").put({ ...LEGACY_ENVELOPE_ROW });
  if ("optimizeBases" in stores) {
    await db.table("optimizeBases").put({ ...LEGACY_BASIS_ROW });
  }
  db.close();
}

describe("Dexie 2 -> current upgrade from a really-shipped version 2 database", () => {
  it("upgrades, keeps optimizeBases, and adds the assistant and diagnostic stores", async () => {
    const dbName = freshDbName();
    await seedShippedV2Database(dbName);

    const db = new NurseSchedulerDb(dbName);
    await db.open();
    try {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      // Pinned so a version bump has to come here and say what it added. T10 moved
      // this to 4 by declaring `diagnosticSearches` in a NEW version block; the
      // hazard the second test guards is doing it in an already-installed one.
      expect(REPOSITORY_SCHEMA_VERSION).toBe(4);

      const tableNames = db.tables.map((t) => t.name);
      // The v4 store, created by the same upgrade rather than left for a later bump.
      expect(tableNames, "the v4 diagnostic-search store must be created").toContain(
        "diagnosticSearches",
      );
      expect(await db.diagnosticSearches.count()).toBe(0);
      // The v2 store carried forward, not recreated empty or dropped.
      expect(tableNames).toContain("optimizeBases");
      expect(tableNames).toContain("keyval");
      for (const store of Object.keys(SHIPPED_V2_STORES)) {
        expect(tableNames, `v2 store ${store} must survive the upgrade`).toContain(store);
      }
      for (const store of ASSISTANT_STORES) {
        expect(tableNames, `v3 store ${store} must be created`).toContain(store);
      }

      // The four new stores are genuinely usable, not merely declared.
      await db.assistantSettings.put({ key: "settings" } as never);
      expect(await db.assistantSettings.get("settings")).toEqual({ key: "settings" });
      for (const store of ASSISTANT_STORES) {
        expect(await db.table(store).count(), `${store} must be readable`).toBeGreaterThanOrEqual(
          0,
        );
      }

      // Pre-existing data survives byte for byte. The upgrade must not rewrite
      // rows: a legacy `schemaVersion: 1` basis stays a V1 row, which is why
      // readers discriminate on that field rather than assuming V2.
      expect(await db.table("optimizeBases").get(LEGACY_BASIS_ROW.basisId)).toEqual(
        LEGACY_BASIS_ROW,
      );
      expect(await db.table("keyval").get("legacy-key")).toEqual({
        key: "legacy-key",
        value: "legacy-value",
      });
      expect(await db.table("scenarioEnvelopes").get(LEGACY_ENVELOPE_ROW.scenarioId)).toEqual(
        LEGACY_ENVELOPE_ROW,
      );

      // The v2 indexes still resolve, so the reaper's `expiresAt` scan and the
      // compound identity lookup are not silently gone.
      expect(
        await db
          .table("optimizeBases")
          .where("expiresAt")
          .below("2026-12-01T00:00:00.000Z")
          .count(),
      ).toBe(1);
      expect(
        await db
          .table("optimizeBases")
          .where("[scenarioId+documentRevision]")
          .equals([LEGACY_BASIS_ROW.scenarioId, LEGACY_BASIS_ROW.documentRevision])
          .count(),
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("creates a store that an already-installed version 2 never declared", async () => {
    // The hazard this guards: someone adds a store to the version 2 block. A
    // browser already at 2 never re-runs that version, so the store would have to
    // be created by the 2 -> 3 upgrade or not at all. Seed a v2 WITHOUT
    // `optimizeBases` and let the integrated v3 schema open it.
    const { optimizeBases: _omitted, ...v2WithoutOptimizeBases } = SHIPPED_V2_STORES;
    const dbName = freshDbName();
    await seedShippedV2Database(dbName, v2WithoutOptimizeBases);

    const db = new NurseSchedulerDb(dbName);
    await db.open();
    try {
      expect(db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
      // Dexie applies the FINAL schema on any version bump, so a store missing
      // from the installed version is created by the upgrade rather than left
      // absent until the next bump.
      expect(db.tables.map((t) => t.name)).toContain("optimizeBases");

      // Usable, and empty — nothing was fabricated into it.
      expect(await db.optimizeBases.count()).toBe(0);
      await db.optimizeBases.put({ ...LEGACY_BASIS_ROW } as never);
      expect(await db.optimizeBases.get(LEGACY_BASIS_ROW.basisId)).toEqual(LEGACY_BASIS_ROW);

      // Data written under the narrower v2 is still intact alongside it.
      expect(await db.table("keyval").get("legacy-key")).toEqual({
        key: "legacy-key",
        value: "legacy-value",
      });
    } finally {
      db.close();
    }
  });
});
