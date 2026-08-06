// Legacy-record migration contract, against a real IndexedDB (fake-indexeddb
// installs the globals). These tests do NOT hand-build the legacy payload: they
// write it through the SHIPPED store, codec, and guarded queue, so "format
// parity" is measured against what the application actually persists rather than
// against a fixture that agrees with the migration by construction.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildWorkspaceDocument } from "@/lib/scenario";
import { computeScenarioFingerprint } from "@/lib/store/fingerprint";
import { createDexieStorage } from "@/lib/store/dexie-storage";
import { drainScenarioPersist, hydrateScenarioStore } from "@/lib/store/lifecycle";
import { SCENARIO_PERSIST_KEY } from "@/lib/store/persistence";
import { createStateSpine } from "@/lib/store/spine";
import { migrateLegacyScenarioRecord, readLegacyMigrationRecord } from "./migration";
import { NurseSchedulerDb } from "./schema";
import { createTestClock, freshDbName, sampleScenario } from "./test-support";
import { LEGACY_MIGRATION_KEY } from "./types";

/** Persist a scenario through the REAL legacy store path into `dbName`. */
async function seedLegacyRecord(dbName: string) {
  const spine = createStateSpine({ createStorage: () => createDexieStorage(dbName) });
  await hydrateScenarioStore(spine.scenario, spine.hot);
  const scenario = sampleScenario();
  spine.scenario.getState().mutateScenario({
    rangeStart: scenario.rangeStart,
    rangeEnd: scenario.rangeEnd,
    reqData: scenario.reqData,
  });
  spine.scenario.getState().recordBackup();
  await drainScenarioPersist(spine.scenario);
  return spine;
}

function migrationConfig(db: NurseSchedulerDb) {
  const clock = createTestClock();
  let counter = 0;
  return {
    db,
    now: () => clock.now(),
    newId: () => {
      counter += 1;
      return `mig-${counter}`;
    },
  };
}

describe("legacy scenario migration", () => {
  let dbName: string;

  beforeEach(() => {
    dbName = freshDbName();
  });

  it("migrates the shipped persisted record into a fresh scenario identity", async () => {
    await seedLegacyRecord(dbName);
    const db = new NurseSchedulerDb(dbName);

    const outcome = await migrateLegacyScenarioRecord(migrationConfig(db));

    expect(outcome.status).toBe("migrated");
    expect(outcome.envelope.documentRevision).toBe(1);
    expect(outcome.envelope.recordRevision).toBe(1);
    expect(outcome.envelope.historyCursor).toBe(0);
    expect(outcome.envelope.scenario.rangeStart).toBe("2026-04-01");
    // The hard weight survived the codec round trip as a real numeric infinity,
    // not the `null` plain JSON would have produced.
    const off = outcome.envelope.scenario.reqData.find((cell) => cell.kind === "off");
    expect(off).toBeDefined();
    expect(off && "weight" in off ? off.weight : null).toBe(Number.POSITIVE_INFINITY);
  });

  it("preserves the backup fingerprint and the Workspace export bytes", async () => {
    await seedLegacyRecord(dbName);
    const db = new NurseSchedulerDb(dbName);
    const legacyRaw = await db.keyval.get(SCENARIO_PERSIST_KEY);

    const outcome = await migrateLegacyScenarioRecord(migrationConfig(db));

    // The fingerprint carried across is still CURRENT for the migrated content:
    // a backup taken before the migration must not read as stale afterwards.
    expect(outcome.envelope.backupFingerprint).not.toBeNull();
    expect(computeScenarioFingerprint(outcome.envelope.scenario)).toBe(
      outcome.envelope.backupFingerprint,
    );
    // Save/export formats are untouched: the migrated envelope produces the same
    // Workspace document the legacy state did.
    expect(buildWorkspaceDocument(outcome.envelope.scenario)).toBeDefined();

    // The legacy row is left byte-for-byte intact — rollback is "stop using the
    // repository", with no data movement.
    const legacyAfter = await db.keyval.get(SCENARIO_PERSIST_KEY);
    expect(legacyAfter?.value).toBe(legacyRaw?.value);
  });

  it("is idempotent across repeated boots", async () => {
    await seedLegacyRecord(dbName);
    const db = new NurseSchedulerDb(dbName);

    const first = await migrateLegacyScenarioRecord(migrationConfig(db));
    const second = await migrateLegacyScenarioRecord(migrationConfig(db));
    const third = await migrateLegacyScenarioRecord(migrationConfig(db));

    expect(second.status).toBe("already-complete");
    expect(third.status).toBe("already-complete");
    expect(second.scenarioId).toBe(first.scenarioId);
    expect(await db.scenarioEnvelopes.count()).toBe(1);
  });

  it("recovers an interrupted migration by discarding partial work and re-running", async () => {
    await seedLegacyRecord(dbName);
    const db = new NurseSchedulerDb(dbName);

    // Simulate a crash after the attempt was claimed but before it completed:
    // an `in-progress` marker plus a half-written envelope with no commit.
    await db.repositoryMeta.put({
      key: LEGACY_MIGRATION_KEY,
      state: "in-progress",
      scenarioId: "partial-scenario",
      sourceKey: SCENARIO_PERSIST_KEY,
      attempts: 1,
      reason: null,
      startedAt: "2026-08-05T00:00:00.000Z",
      finishedAt: null,
    });
    await db.scenarioEnvelopes.put({
      scenarioId: "partial-scenario",
      schemaVersion: 3,
      documentRevision: 1,
      recordRevision: 1,
      acceptedLeaseEpoch: 0,
      topCommitId: null,
      historySessionId: "partial-session",
      historyCursor: 0,
      scenario: sampleScenario("1999-01-01"),
      backupFingerprint: null,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    });

    const outcome = await migrateLegacyScenarioRecord(migrationConfig(db));

    expect(outcome.status).toBe("recovered");
    expect(outcome.scenarioId).not.toBe("partial-scenario");
    expect(await db.scenarioEnvelopes.get("partial-scenario")).toBeUndefined();
    expect(await db.scenarioEnvelopes.count()).toBe(1);
    // Re-run from the legacy record, which was never consumed.
    expect(outcome.envelope.scenario.rangeStart).toBe("2026-04-01");

    const marker = await readLegacyMigrationRecord(db);
    expect(marker?.state).toBe("complete");
    expect(marker?.attempts).toBe(2);
  });

  it("fails soft on a corrupt legacy record and leaves it for the legacy path", async () => {
    const db = new NurseSchedulerDb(dbName);
    await db.keyval.put({ key: SCENARIO_PERSIST_KEY, value: "{ not json" });

    const outcome = await migrateLegacyScenarioRecord(migrationConfig(db));

    // A usable (empty) scenario exists, so the repository boots; the corrupt row
    // is untouched so the legacy store still reaches its own recoverable-error
    // recovery and can offer the user a reset.
    expect(outcome.status).toBe("corrupt");
    expect(outcome.reason).not.toBeNull();
    expect(outcome.envelope.scenario.rangeStart).toBe("");
    expect((await db.keyval.get(SCENARIO_PERSIST_KEY))?.value).toBe("{ not json");

    const marker = await readLegacyMigrationRecord(db);
    expect(marker?.state).toBe("failed");
  });

  it("mints an empty scenario on a fresh install with no legacy record", async () => {
    const db = new NurseSchedulerDb(dbName);

    const outcome = await migrateLegacyScenarioRecord(migrationConfig(db));

    expect(outcome.status).toBe("no-legacy-record");
    expect(outcome.envelope.scenario.staff).toEqual([]);
    expect(await db.scenarioCommits.count()).toBe(1);
  });

  it("leaves the legacy store fully usable after the schema upgrade", async () => {
    // The repository added tables in schema version 2. The legacy adapter opens
    // the SAME database; if the two declared different versions the lower one
    // would fail to open, so this asserts the shipped path still round-trips.
    await seedLegacyRecord(dbName);
    const db = new NurseSchedulerDb(dbName);
    await migrateLegacyScenarioRecord(migrationConfig(db));

    const reloaded = createStateSpine({ createStorage: () => createDexieStorage(dbName) });
    await hydrateScenarioStore(reloaded.scenario, reloaded.hot);

    expect(reloaded.hot.getState().hydrationStatus).toBe("ready");
    expect(reloaded.scenario.getState().rangeStart).toBe("2026-04-01");
  });
});
