// CROSS-LAYER: is a just-finished infeasible run actually diagnosable?
//
// The bounded diagnostic needs three layers to agree, and each was tested alone while
// the composition was not — which is how the product shipped with the diagnostic
// unreachable for EVERY run on EVERY deployment:
//
//   1. the Optimize terminal chain decides whether the server job survives the run
//      (`use-optimize-terminal.ts`);
//   2. `classifyRecovery` turns the surviving — or absent — job into a recovery state;
//   3. `mayOpenSearch` turns that state into permission to diagnose.
//
// Layer 1 deleted the job seconds after it settled, so layer 2 always saw a 404 and
// answered `local-only`, and layer 3 always refused. Every unit test passed: layer 2's
// suite asserts `local-only` for a missing job, which is correct — it was the input
// that was wrong, and no test owned the join.
//
// This file owns the join, expressed as the three facts that actually matter to a
// user: it is diagnosable IMMEDIATELY, it stays diagnosable for the window the server
// advertised, and it stops being diagnosable when that window closes.

import { describe, expect, it } from "vitest";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import type { JobBasis } from "@/lib/bff/types";
import {
  buildOptimizeBasis,
  classifyRecovery,
  type OptimizeBasisRecordV2,
  type ServerJobFacts,
} from "@/lib/optimize";
import { mayOpenSearch } from "./search-policy";

const PROFILE: InfoSemanticProfile = {
  submission_contract_version: "optimize-yaml-v1",
  solver_semantic_version: "ortools/cp-sat@1",
  backend_capability_version: "nurse-scheduling-backend@1",
};

const SUBMITTED_AT = new Date("2026-09-01T00:00:00.000Z");
/** The backend stamps `expires_at = now + retention_seconds` at admission. */
const RETENTION_HOURS = 24;
const EXPIRES_AT = new Date(SUBMITTED_AT.getTime() + RETENTION_HOURS * 3600_000).toISOString();

async function submittedRun(): Promise<OptimizeBasisRecordV2> {
  const built = await buildOptimizeBasis({
    yaml: "workspaceVersion: 1\napiVersion: alpha\npeople:\n  items:\n    - id: a\n",
    anonymized: false,
    profile: PROFILE,
    options: { prettify: true, timeoutSeconds: 300 },
    scenarioId: "scenario-1",
    documentRevision: 7,
    ownerKind: "ordinary",
    attemptId: "attempt-1",
    now: SUBMITTED_AT,
  });
  // Bound exactly as an accepted job binds it.
  return { ...built.record, jobId: "job_1", expiresAt: EXPIRES_AT };
}

/** The facts the BFF reports for a job the client did NOT delete. */
function serverStillHasIt(local: OptimizeBasisRecordV2): ServerJobFacts {
  const basis: JobBasis = {
    basis_id: local.basisId,
    input_sha256: local.submissionDigest,
    submission_contract_version: local.basis.submissionContractVersion,
    workspace_schema_version: local.basis.workspaceSchemaVersion,
    serializer_version: local.basis.serializerVersion,
    anonymization_mode: local.basis.anonymizationMode,
    solver_semantic_version: local.basis.solverSemanticVersion,
    backend_capability_version: local.basis.backendCapabilityVersion,
    parent_basis_id: local.parentBasisId,
    transform_digest: local.transformDigest,
  } as JobBasis;
  return { kind: "present", basis, expiresAt: EXPIRES_AT };
}

/** Ask all three layers, the way the diagnostic runtime does. */
function mayDiagnose(local: OptimizeBasisRecordV2, server: ServerJobFacts, now: Date) {
  const recovery = classifyRecovery({ local, server, liveProfile: PROFILE, now });
  return { recovery, gate: mayOpenSearch({ recovery, basisCurrent: true }) };
}

describe("a completed infeasible run is diagnosable for exactly its advertised window", () => {
  it("is diagnosable IMMEDIATELY, because the terminal chain left the job in place", async () => {
    const local = await submittedRun();
    // One second after it settled -- the moment the assistant is asked about it.
    const now = new Date(SUBMITTED_AT.getTime() + 1000);

    const { recovery, gate } = mayDiagnose(local, serverStillHasIt(local), now);

    expect(recovery.state).toBe("trusted");
    expect(recovery.diagnosisEnabled).toBe(true);
    expect(gate.ok).toBe(true);
  });

  it("is still diagnosable late in the window", async () => {
    const local = await submittedRun();
    const now = new Date(SUBMITTED_AT.getTime() + (RETENTION_HOURS - 1) * 3600_000);

    expect(mayDiagnose(local, serverStillHasIt(local), now).gate.ok).toBe(true);
  });

  it("stops being diagnosable once the advertised expiry passes", async () => {
    // The window is BOUNDED, and the server's expiry is what bounds it. Retaining the
    // job is not retaining it forever.
    const local = await submittedRun();
    const now = new Date(SUBMITTED_AT.getTime() + (RETENTION_HOURS + 1) * 3600_000);

    const { recovery, gate } = mayDiagnose(local, serverStillHasIt(local), now);

    expect(recovery.state).toBe("server-only");
    expect(recovery.reason).toBe("server_evidence_expired");
    expect(gate.ok).toBe(false);
  });

  it("is NOT diagnosable when the job was deleted — the shipped defect, pinned", async () => {
    // Exactly what the terminal chain used to cause, one second after the run settled.
    // The local basis row is perfect; the diagnostic still cannot open. This is the
    // state the repair exists to prevent, and it must keep classifying this way — the
    // fix is that the input never occurs, not that the rule got softer.
    const local = await submittedRun();
    const now = new Date(SUBMITTED_AT.getTime() + 1000);

    const { recovery, gate } = mayDiagnose(local, { kind: "missing" }, now);

    expect(recovery.state).toBe("local-only");
    expect(recovery.reason).toBe("server_job_missing");
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.message).toContain("no longer available on the server");
  });
});
