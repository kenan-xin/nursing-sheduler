// C2F3 — schema-V1 basis rows, driven through the REAL v2 -> v3 upgrade and the
// REAL authority boot sweep.
//
// WHAT WENT WRONG. `optimizeBases` has existed since T02 and its rows are never
// rewritten, so a browser that ran a pre-T08 build still holds `schemaVersion: 1`
// rows. The upgrade test proved they survive; nothing proved anyone could READ
// them. The authority cast every stored row to V2 and `planReap` partitioned
// solely on the V2-only `ownerKind`, so a real expired legacy row matched neither
// candidates nor ordinaries and produced an empty reap plan — forever.
//
// So this suite starts from a database that genuinely IS at the shipped version 2,
// seeds genuinely legacy rows through the historical declaration, and then brings
// the authority up exactly as the app brings it up. Every assertion below is about
// the real upgrade, the real boot sweep, and the real recovery classifier — not
// about raw Dexie access.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShippedV2Database, shippedV1BasisRow } from "@/lib/repository/shipped-v2-support";
import { REPOSITORY_SCHEMA_VERSION } from "@/lib/repository";
import { isOptimizeBasisRecordV2 } from "@/lib/optimize/basis/basis-row";
import type { OptimizeBasisRecordV2, StoredOptimizeBasisRow } from "@/lib/optimize/basis/basis-row";
import { classifyRecovery } from "@/lib/optimize/basis/recovery";
import type { JobBasis } from "@/lib/bff/types";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import {
  clearTestAuthority,
  freshAuthorityDbName,
  installTestAuthority,
  type TestAuthority,
} from "./test-authority";

const PAST = "2026-07-20T00:00:00.000Z";
const FUTURE = "2099-07-21T00:00:00.000Z";
const DIGEST = "a".repeat(64);
const YAML = "workspaceVersion: 1\n";

const LIVE_PROFILE: InfoSemanticProfile = {
  submission_contract_version: "optimize-yaml-v1",
  solver_semantic_version: "ortools/cp-sat@1",
  backend_capability_version: "nurse-scheduling-backend@1",
};

function currentRow(over: Partial<OptimizeBasisRecordV2> = {}): OptimizeBasisRecordV2 {
  return {
    basisId: "current",
    schemaVersion: 2,
    scenarioId: "scenario-1",
    documentRevision: 1,
    submissionDigest: DIGEST,
    basis: {
      schemaVersion: 2,
      submissionContractVersion: LIVE_PROFILE.submission_contract_version,
      workspaceSchemaVersion: "1",
      serializerVersion: "canonical-strict-yaml-v1",
      anonymizationMode: "none",
      inputSha256: DIGEST,
      normalizedOptions: { solver: "ortools/cp-sat", prettify: false, timeoutSeconds: 300 },
      solverSemanticVersion: LIVE_PROFILE.solver_semantic_version,
      backendCapabilityVersion: LIVE_PROFILE.backend_capability_version,
    },
    ownerKind: "ordinary",
    attemptId: "attempt",
    jobId: "job",
    parentBasisId: null,
    transformDigest: null,
    submittedYaml: null,
    createdAt: PAST,
    expiresAt: FUTURE,
    ...over,
  };
}

/**
 * Seed a genuinely-shipped version 2 database, then bring the real authority up on
 * it (which performs the real 2 -> 3 upgrade) and await the boot sweep.
 */
async function bootFromShippedV2(rows: StoredOptimizeBasisRow[]): Promise<TestAuthority> {
  const databaseName = freshAuthorityDbName();
  const seed = await openShippedV2Database(databaseName);
  await seed.table("optimizeBases").bulkPut(rows);
  seed.close();

  const harness = await installTestAuthority({ databaseName });
  await harness.authority.basisSweepSettled;
  return harness;
}

async function remainingIds(harness: TestAuthority): Promise<string[]> {
  const rows = await harness.db.optimizeBases.toArray();
  return rows.map((row) => row.basisId).sort();
}

let harness: TestAuthority | null = null;

beforeEach(() => {
  harness = null;
});

afterEach(() => {
  harness?.db.close();
  clearTestAuthority();
});

describe("legacy schema-V1 basis rows across the real v2 -> v3 upgrade (C2F3)", () => {
  it("deletes an EXPIRED legacy row during the real authority boot sweep", async () => {
    harness = await bootFromShippedV2([
      shippedV1BasisRow({ basisId: "legacy-expired", expiresAt: PAST }),
      shippedV1BasisRow({ basisId: "legacy-live", expiresAt: FUTURE }),
    ]);

    // The upgrade really ran, so this is the integrated schema reading legacy rows.
    expect(harness.db.verno).toBe(REPOSITORY_SCHEMA_VERSION);
    expect(await harness.authority.basisSweepSettled).toEqual([
      { kind: "delete-row", basisId: "legacy-expired", reason: "legacy-expired" },
    ]);
    expect(await remainingIds(harness)).toEqual(["legacy-live"]);
  });

  it("treats a legacy row with an absent expiry as expired, never as forever", async () => {
    // An unreadable retention bound must not become unbounded retention. A pre-T08
    // row with no advertised expiry has nothing to honour, so it goes.
    harness = await bootFromShippedV2([
      shippedV1BasisRow({ basisId: "legacy-no-expiry", expiresAt: null }),
      shippedV1BasisRow({ basisId: "legacy-unparseable", expiresAt: "not-a-timestamp" }),
    ]);

    expect(await remainingIds(harness)).toEqual([]);
  });

  it("compacts an unexpired legacy row that somehow holds raw material", async () => {
    harness = await bootFromShippedV2([
      shippedV1BasisRow({ basisId: "legacy-live", expiresAt: FUTURE, submittedYaml: YAML }),
    ]);

    expect(await harness.authority.basisSweepSettled).toEqual([
      { kind: "clear-payload", basisId: "legacy-live", reason: "legacy-unreadable" },
    ]);
    const row = await harness.authority.readOptimizeBasis("legacy-live");
    // Compacted, not deleted: the identity stays readable until its own expiry.
    expect(row).not.toBeNull();
    expect((row as { submittedYaml?: unknown }).submittedYaml).toBeNull();
    expect((row as { semanticBasisDigest?: unknown }).semanticBasisDigest).toBe(
      "sha256:legacy-semantic-basis",
    );
  });

  it("does not rewrite a legacy row that never held raw material", async () => {
    const seeded = shippedV1BasisRow({ basisId: "legacy-live", expiresAt: FUTURE });
    harness = await bootFromShippedV2([seeded]);

    expect(await harness.authority.basisSweepSettled).toEqual([]);
    // Byte for byte: a compaction pass must not grow a `submittedYaml` field on a
    // row whose shape never had one.
    expect(await harness.db.optimizeBases.get("legacy-live")).toEqual(seeded);
  });

  it("reaps legacy and current rows in the same pass without confusing them", async () => {
    harness = await bootFromShippedV2([
      shippedV1BasisRow({ basisId: "legacy-expired", expiresAt: PAST }),
      shippedV1BasisRow({ basisId: "legacy-live", expiresAt: FUTURE }),
      currentRow({ basisId: "current-expired", expiresAt: PAST }),
      currentRow({ basisId: "current-live", expiresAt: FUTURE }),
    ]);

    expect(await remainingIds(harness)).toEqual(["current-live", "legacy-live"]);
  });
});

describe("legacy rows can never become trusted evidence (C2F3)", () => {
  it("an unexpired legacy row read back through the authority is not a V2 record", async () => {
    harness = await bootFromShippedV2([
      shippedV1BasisRow({ basisId: "legacy-live", expiresAt: FUTURE }),
    ]);

    const row = await harness.authority.readOptimizeBasis("legacy-live");
    expect(row).not.toBeNull();
    // The discrimination the reaper and the classifier both depend on.
    expect(isOptimizeBasisRecordV2(row!)).toBe(false);
  });

  it("recovery refuses it even when the server offers a perfectly matching job", async () => {
    harness = await bootFromShippedV2([
      shippedV1BasisRow({ basisId: "legacy-live", expiresAt: FUTURE }),
    ]);
    const local = await harness.authority.readOptimizeBasis("legacy-live");

    // The MOST favourable server facts available: the id lines up, the digest lines
    // up, the profile is current, and the evidence has not expired. A row that
    // cannot be verified must still refuse, or "fails closed" means nothing.
    const serverBasis: JobBasis = {
      basis_id: "legacy-live",
      schema_version: 2,
      submission_contract_version: LIVE_PROFILE.submission_contract_version,
      workspace_schema_version: "1",
      serializer_version: "canonical-strict-yaml-v1",
      anonymization_mode: "none",
      input_sha256: DIGEST,
      normalized_options: { solver: "ortools/cp-sat", prettify: false, timeout_seconds: 300 },
      solver_semantic_version: LIVE_PROFILE.solver_semantic_version,
      backend_capability_version: LIVE_PROFILE.backend_capability_version,
      parent_basis_id: null,
      transform_digest: null,
    };

    const classification = classifyRecovery({
      local,
      server: { kind: "present", basis: serverBasis, expiresAt: FUTURE },
      liveProfile: LIVE_PROFILE,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(classification.state).toBe("integrity-mismatch");
    expect(classification.reason).toBe("legacy_basis_schema");
    expect(classification.diagnosisEnabled).toBe(false);
  });

  it("an accepted job cannot be bound to a legacy row", async () => {
    harness = await bootFromShippedV2([
      shippedV1BasisRow({ basisId: "legacy-live", expiresAt: FUTURE }),
    ]);

    // The verifier would accept anything; the refusal has to come from the store
    // discriminating the row, not from the caller remembering to check.
    const bound = await harness.authority.bindOptimizeBasisJob("legacy-live", (row) => row);

    expect(bound).toBeNull();
  });
});
