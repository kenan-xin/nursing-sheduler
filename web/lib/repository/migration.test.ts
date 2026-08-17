// Legacy-record migration contract, against a real IndexedDB (fake-indexeddb
// installs the globals).
//
// The legacy payload is not hand-authored: it is written through the SHIPPED
// encode chain that a pre-T03 build used — `SCENARIO_PERSIST_KEY`,
// `SCENARIO_PERSIST_VERSION` and `encodeNonFiniteNumbers` — so "format parity" is
// still measured against the real codec and not against a fixture that agrees
// with the migration by construction. T03 retired the Zustand `persist` write
// path itself, so the wrapper around that codec (the storage seam and its
// serialized queue) no longer exists to drive; what it produced does, and that is
// what a legacy record actually is.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildWorkspaceDocument } from "@/lib/scenario";
import { computeScenarioFingerprint } from "@/lib/store/fingerprint";

import {
  encodeNonFiniteNumbers,
  SCENARIO_PERSIST_KEY,
  SCENARIO_PERSIST_VERSION,
} from "@/lib/store/persistence";
import { migrateLegacyScenarioRecord, readLegacyMigrationRecord } from "./migration";
import { NurseSchedulerDb } from "./schema";
import { createTestClock, freshDbName, sampleScenario } from "./test-support";
import { LEGACY_MIGRATION_KEY } from "./types";
import { installTestAuthority, clearTestAuthority } from "@/lib/store/test-authority";

/**
 * Write the record a pre-T03 build left behind into `dbName`, through the shipped
 * codec at the shipped key and version. The backup fingerprint is recorded as a
 * plain Download would have: over the same scenario, so a backup taken before the
 * migration must still read as current after it.
 */
async function seedLegacyRecord(dbName: string) {
  const db = new NurseSchedulerDb(dbName);
  const scenario = sampleScenario();
  const state = {
    ...scenario,
    backupFingerprint: computeScenarioFingerprint(scenario),
  };
  await db.keyval.put({
    key: SCENARIO_PERSIST_KEY,
    value: JSON.stringify({ state, version: SCENARIO_PERSIST_VERSION }, encodeNonFiniteNumbers),
  });
  db.close();
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

  beforeEach(async () => {
    dbName = freshDbName();
  });

  it("migrates the shipped persisted record into a fresh scenario identity", async () => {
    await seedLegacyRecord(dbName);
    const db = new NurseSchedulerDb(dbName);

    const outcome = await migrateLegacyScenarioRecord(migrationConfig(db));

    expect(outcome.status).toBe("migrated");
    expect(outcome.envelope!.documentRevision).toBe(1);
    expect(outcome.envelope!.recordRevision).toBe(1);
    expect(outcome.envelope!.historyCursor).toBe(0);
    expect(outcome.envelope!.scenario.rangeStart).toBe("2026-04-01");
    // The hard weight survived the codec round trip as a real numeric infinity,
    // not the `null` plain JSON would have produced.
    const off = outcome.envelope!.scenario.reqData.find((cell) => cell.kind === "off");
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
    expect(outcome.envelope!.backupFingerprint).not.toBeNull();
    expect(computeScenarioFingerprint(outcome.envelope!.scenario)).toBe(
      outcome.envelope!.backupFingerprint,
    );
    // Save/export formats are untouched: the migrated envelope produces the same
    // Workspace document the legacy state did.
    expect(buildWorkspaceDocument(outcome.envelope!.scenario)).toBeDefined();

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
    expect(outcome.envelope!.scenario.rangeStart).toBe("2026-04-01");

    const marker = await readLegacyMigrationRecord(db);
    expect(marker?.state).toBe("complete");
    expect(marker?.attempts).toBe(2);
  });

  it("reports corruption and mints NOTHING, preserving the legacy bytes", async () => {
    const db = new NurseSchedulerDb(dbName);
    await db.keyval.put({ key: SCENARIO_PERSIST_KEY, value: "{ not json" });

    const outcome = await migrateLegacyScenarioRecord(migrationConfig(db));

    // No editable replacement is published. An empty envelope here read to the user
    // as a healthy blank workspace, invited edits into it, and let the next boot
    // delete those edits as "partial migration work"; the caller routes this to the
    // recoverable-error/reset surface instead.
    expect(outcome.status).toBe("corrupt");
    expect(outcome.reason).not.toBeNull();
    expect(outcome.envelope).toBeNull();
    expect(outcome.scenarioId).toBeNull();
    expect(await db.scenarioEnvelopes.count()).toBe(0);
    // The bytes are preserved for a future recovery.
    expect((await db.keyval.get(SCENARIO_PERSIST_KEY))?.value).toBe("{ not json");

    const marker = await readLegacyMigrationRecord(db);
    expect(marker?.state).toBe("failed");
  });

  it("re-reports corruption on a later boot instead of minting over it", async () => {
    // The retry path was the destructive one: a second boot found the `failed`
    // marker, treated the interim scenario as partial work, deleted it, and minted
    // another — taking any edits the user had made after the apparent recovery with
    // it. Corruption is reported again, and nothing is created or destroyed.
    const db = new NurseSchedulerDb(dbName);
    await db.keyval.put({ key: SCENARIO_PERSIST_KEY, value: "{ not json" });

    await migrateLegacyScenarioRecord(migrationConfig(db));
    const second = await migrateLegacyScenarioRecord(migrationConfig(db));

    expect(second.status).toBe("corrupt");
    expect(second.envelope).toBeNull();
    expect(await db.scenarioEnvelopes.count()).toBe(0);
    expect((await db.keyval.get(SCENARIO_PERSIST_KEY))?.value).toBe("{ not json");
  });

  it("two concurrent first boots converge on ONE scenario identity", async () => {
    // Claiming the marker outside the data transaction split authority: both
    // connections saw no marker, each minted its own scenario, the last marker won,
    // and the two tabs came up on different identities — so neither was read-only,
    // because they were never contending for the same lease.
    await seedLegacyRecord(dbName);
    const first = new NurseSchedulerDb(dbName);
    const second = new NurseSchedulerDb(dbName);
    try {
      const [a, b] = await Promise.all([
        migrateLegacyScenarioRecord(migrationConfig(first)),
        migrateLegacyScenarioRecord(migrationConfig(second)),
      ]);

      expect(a.scenarioId).not.toBeNull();
      expect(b.scenarioId).toBe(a.scenarioId);
      // Exactly one envelope exists, and it is the one both callers were handed.
      const audit = new NurseSchedulerDb(dbName);
      try {
        expect(await audit.scenarioEnvelopes.count()).toBe(1);
        expect((await audit.scenarioEnvelopes.toArray())[0].scenarioId).toBe(a.scenarioId);
      } finally {
        audit.close();
      }
      // One of the two adopted the other's work rather than migrating again.
      expect([a.status, b.status]).toContain("already-complete");
    } finally {
      first.close();
      second.close();
    }
  });

  it("mints an empty scenario on a fresh install with no legacy record", async () => {
    const db = new NurseSchedulerDb(dbName);

    const outcome = await migrateLegacyScenarioRecord(migrationConfig(db));

    expect(outcome.status).toBe("no-legacy-record");
    expect(outcome.envelope!.scenario.staff).toEqual([]);
    expect(await db.scenarioCommits.count()).toBe(1);
  });

  it("boots the repository authority on the migrated record", async () => {
    // Post-T03 the migration is not a side-show run beside a legacy adapter: it is
    // the FIRST step of `ScenarioAuthority.initialize()`. So the end-to-end claim
    // is that a tab opened on a database holding only a legacy record comes up
    // owning a migrated scenario and projecting its content — no separate legacy
    // read path is involved, or exists.
    await seedLegacyRecord(dbName);

    const harness = await installTestAuthority({ databaseName: dbName });
    try {
      expect(harness.hot.getState().hydrationStatus).toBe("ready");
      expect(harness.authorityStore.getState().ownership).toBe("owner");
      expect(harness.scenario.getState().rangeStart).toBe("2026-04-01");
      // The pre-migration backup is still current for the projected content.
      expect(harness.scenario.getState().backupFingerprint).toBe(
        computeScenarioFingerprint(harness.scenario.getState()),
      );
    } finally {
      clearTestAuthority();
    }
  });
});
