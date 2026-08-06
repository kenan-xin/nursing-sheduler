// T08 — the Optimize basis reaper's LIFECYCLE CALLER.
//
// `basis/reaper.test.ts` proves the plan is correct. This proves the plan is
// actually EXECUTED: rows are seeded into a real IndexedDB, the authority is
// brought up exactly as the app brings it up, and the durable table is read back.
// A test that called `sweepOptimizeBases` directly would still pass if nobody
// ever invoked it — precisely the gap this closes — so the central cases go
// through `initialize()`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NurseSchedulerDb } from "@/lib/repository";
import type { OptimizeBasisRecordV2 } from "@/lib/optimize/basis/basis-row";
import {
  clearTestAuthority,
  freshAuthorityDbName,
  installTestAuthority,
  type TestAuthority,
} from "./test-authority";

const PAST = "2026-07-20T00:00:00.000Z";
const FUTURE = "2099-07-21T00:00:00.000Z";
const YAML = "workspaceVersion: 1\n";

function basisRow(
  over: Partial<OptimizeBasisRecordV2> & { basisId: string },
): OptimizeBasisRecordV2 {
  return {
    schemaVersion: 2,
    scenarioId: "scenario-1",
    documentRevision: 1,
    submissionDigest: "a".repeat(64),
    basis: {
      schemaVersion: 2,
      submissionContractVersion: "optimize-yaml-v1",
      workspaceSchemaVersion: "1",
      serializerVersion: "canonical-strict-yaml-v1",
      anonymizationMode: "none",
      inputSha256: "a".repeat(64),
      normalizedOptions: { solver: "ortools/cp-sat", prettify: false, timeoutSeconds: 300 },
      solverSemanticVersion: "ortools/cp-sat@1",
      backendCapabilityVersion: "nurse-scheduling-backend@1",
    },
    ownerKind: "ordinary",
    attemptId: "attempt",
    jobId: "job",
    parentBasisId: null,
    transformDigest: null,
    submittedYaml: YAML,
    createdAt: PAST,
    expiresAt: FUTURE,
    ...over,
  };
}

/**
 * Seed rows into a database BEFORE the authority opens it, then bring the
 * authority up on that same database and await the boot sweep.
 *
 * The seeding db is closed first: two live Dexie connections to one database in
 * the same process would let a write land after the sweep read, which would make
 * the assertions race rather than describe the sweep.
 */
async function bootWithRows(rows: OptimizeBasisRecordV2[]): Promise<TestAuthority> {
  const databaseName = freshAuthorityDbName();
  const seed = new NurseSchedulerDb(databaseName);
  await seed.optimizeBases.bulkPut(rows);
  seed.close();

  const harness = await installTestAuthority({ databaseName });
  await harness.authority.basisSweepSettled;
  return harness;
}

async function remaining(harness: TestAuthority): Promise<OptimizeBasisRecordV2[]> {
  const rows = await harness.db.optimizeBases.toArray();
  return rows.sort((a, b) => a.basisId.localeCompare(b.basisId));
}

let harness: TestAuthority | null = null;

beforeEach(() => {
  harness = null;
});

afterEach(() => {
  harness?.db.close();
  clearTestAuthority();
});

describe("Optimize basis reaping runs on authority initialization (T08)", () => {
  it("deletes an expired row during boot, without anyone calling the sweep", async () => {
    harness = await bootWithRows([
      basisRow({ basisId: "expired", expiresAt: PAST, submittedYaml: null }),
      basisRow({ basisId: "live", submittedYaml: null }),
    ]);

    expect((await remaining(harness)).map((row) => row.basisId)).toEqual(["live"]);
  });

  it("clears unreferenced raw payload but KEEPS the compact identity readable", async () => {
    harness = await bootWithRows([basisRow({ basisId: "live" })]);

    const [row] = await remaining(harness);
    // The submitted document is gone…
    expect(row.submittedYaml).toBeNull();
    // …but everything history needs to describe the run survives.
    expect(row.basisId).toBe("live");
    expect(row.submissionDigest).toBe("a".repeat(64));
    expect(row.basis.solverSemanticVersion).toBe("ortools/cp-sat@1");
    expect(row.jobId).toBe("job");
  });

  it("deletes an orphaned candidate whose parent row no longer exists", async () => {
    harness = await bootWithRows([
      basisRow({
        basisId: "orphan",
        ownerKind: "candidate",
        parentBasisId: "vanished",
        transformDigest: "t",
        submittedYaml: null,
      }),
    ]);

    expect(await remaining(harness)).toEqual([]);
  });

  it("reaps the candidate before the parent, and never the parent alone", async () => {
    harness = await bootWithRows([
      basisRow({ basisId: "parent", expiresAt: PAST, submittedYaml: null }),
      basisRow({
        basisId: "child",
        ownerKind: "candidate",
        parentBasisId: "parent",
        transformDigest: "t",
        expiresAt: PAST,
        submittedYaml: null,
      }),
    ]);

    // Both are expired, so both go — but the plan's ordering is what guarantees
    // the child never outlives the row it derives its meaning from.
    expect(await remaining(harness)).toEqual([]);
  });

  it("a candidate's expiry does not take its unexpired ordinary parent with it", async () => {
    harness = await bootWithRows([
      basisRow({ basisId: "parent", submittedYaml: null }),
      basisRow({
        basisId: "child",
        ownerKind: "candidate",
        parentBasisId: "parent",
        transformDigest: "t",
        expiresAt: PAST,
        submittedYaml: null,
      }),
    ]);

    expect((await remaining(harness)).map((row) => row.basisId)).toEqual(["parent"]);
  });

  it("boot succeeds and publishes a scenario even with no basis rows at all", async () => {
    harness = await bootWithRows([]);

    expect(await harness.authority.basisSweepSettled).toEqual([]);
    expect(harness.authorityStore.getState().scenarioId).not.toBeNull();
  });

  it("an active reference does NOT extend validity past the advertised expiry", async () => {
    // The one rule the reference set must never be able to break: a reference
    // protects raw payload, not evidence lifetime.
    harness = await bootWithRows([]);
    // Seeded AFTER boot on purpose: the boot sweep passes an empty reference set,
    // so it would delete the row before this case could exercise the reference.
    await harness.db.optimizeBases.put(basisRow({ basisId: "expired", expiresAt: PAST }));

    const actions = await harness.authority.sweepOptimizeBases(
      new Set(["expired"]),
      new Date("2026-07-20T12:00:00Z"),
    );
    expect(actions).toEqual([{ kind: "delete-row", basisId: "expired", reason: "expired" }]);
    expect(await remaining(harness)).toEqual([]);
  });

  it("a reference protects raw payload only while the row is still unexpired", async () => {
    harness = await bootWithRows([basisRow({ basisId: "live" })]);
    // The boot sweep already cleared it (nothing was referenced at boot), so
    // re-seed the payload to isolate the reference behaviour itself.
    await harness.db.optimizeBases.update("live", { submittedYaml: YAML });

    const actions = await harness.authority.sweepOptimizeBases(
      new Set(["live"]),
      new Date("2026-07-20T12:00:00Z"),
    );
    expect(actions).toEqual([]);
    expect((await remaining(harness))[0].submittedYaml).toBe(YAML);
  });

  it("a failing durable read never breaks the sweep's caller", async () => {
    harness = await bootWithRows([basisRow({ basisId: "live", submittedYaml: null })]);
    // Retention hygiene must not be able to fail a boot. A closed database is the
    // bluntest available durable failure.
    harness.db.close();

    await expect(harness.authority.sweepOptimizeBases()).resolves.toEqual([]);
  });
});
