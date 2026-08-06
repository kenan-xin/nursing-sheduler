// T08 — building the local basis row and its submission fields from ONE prepared
// submission, and the one-time job binding.

import { describe, expect, it } from "vitest";
import type { JobBasis } from "@/lib/bff/types";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import {
  bindAcceptedJob,
  BasisOwnershipError,
  buildOptimizeBasis,
  OPTIMIZE_SERIALIZER_VERSION,
  type BuildBasisInput,
} from "./basis-record";
import { computeBasisId } from "./optimize-basis";

const PROFILE: InfoSemanticProfile = {
  submission_contract_version: "optimize-yaml-v1",
  solver_semantic_version: "ortools/cp-sat@1",
  backend_capability_version: "nurse-scheduling-backend@1",
};

const YAML = "workspaceVersion: 1\napiVersion: alpha\n";
const NOW = new Date("2026-07-20T12:00:00Z");

function input(over: Partial<BuildBasisInput> = {}): BuildBasisInput {
  return {
    yaml: YAML,
    anonymized: false,
    profile: PROFILE,
    options: { prettify: false, timeoutSeconds: 300 },
    scenarioId: "scenario-1",
    documentRevision: 7,
    ownerKind: "ordinary",
    attemptId: "attempt-1",
    now: NOW,
    ...over,
  };
}

describe("buildOptimizeBasis", () => {
  it("derives the row, the fields, and the id from the SAME bytes", async () => {
    const built = await buildOptimizeBasis(input());
    expect(built.fields.basis_id).toBe(built.basisId);
    expect(built.fields.input_sha256).toBe(built.basis.inputSha256);
    expect(built.record.submissionDigest).toBe(built.basis.inputSha256);
    expect(built.record.basis.inputSha256).toBe(built.basis.inputSha256);
    await expect(computeBasisId(built.basis)).resolves.toBe(built.basisId);
  });

  it("records the anonymization transform that actually produced the bytes", async () => {
    const plain = await buildOptimizeBasis(input({ anonymized: false }));
    const anonymized = await buildOptimizeBasis(input({ anonymized: true }));
    expect(plain.fields.anonymization_mode).toBe("none");
    expect(anonymized.fields.anonymization_mode).toBe("people");
    // Different transforms are different evidence even for the same scenario.
    expect(anonymized.basisId).not.toBe(plain.basisId);
  });

  it("binds the profile it was handed, not a hard-coded one", async () => {
    const moved = await buildOptimizeBasis(
      input({ profile: { ...PROFILE, solver_semantic_version: "ortools/cp-sat@2" } }),
    );
    const original = await buildOptimizeBasis(input());
    expect(moved.basis.solverSemanticVersion).toBe("ortools/cp-sat@2");
    expect(moved.basisId).not.toBe(original.basisId);
  });

  it("changes identity when an option changes", async () => {
    const a = await buildOptimizeBasis(input());
    const b = await buildOptimizeBasis(input({ options: { prettify: true, timeoutSeconds: 300 } }));
    const c = await buildOptimizeBasis(input({ options: { prettify: false, timeoutSeconds: 60 } }));
    expect(new Set([a.basisId, b.basisId, c.basisId]).size).toBe(3);
  });

  it("stamps the serializer version so provenance is explicit", async () => {
    const built = await buildOptimizeBasis(input());
    expect(built.basis.serializerVersion).toBe(OPTIMIZE_SERIALIZER_VERSION);
  });

  it("starts unbound, retaining the raw payload and no job", async () => {
    const built = await buildOptimizeBasis(input());
    expect(built.record.jobId).toBeNull();
    expect(built.record.expiresAt).toBeNull();
    expect(built.record.submittedYaml).toBe(YAML);
    expect(built.record.createdAt).toBe(NOW.toISOString());
  });

  it("requires a candidate to own both a parent and a transform", async () => {
    await expect(buildOptimizeBasis(input({ ownerKind: "candidate" }))).rejects.toThrow(
      BasisOwnershipError,
    );
    await expect(
      buildOptimizeBasis(input({ ownerKind: "candidate", parentBasisId: "p" })),
    ).rejects.toThrow(BasisOwnershipError);
  });

  it("forbids an ordinary run from carrying candidate ownership", async () => {
    await expect(buildOptimizeBasis(input({ parentBasisId: "p" }))).rejects.toThrow(
      BasisOwnershipError,
    );
    await expect(buildOptimizeBasis(input({ transformDigest: "t" }))).rejects.toThrow(
      BasisOwnershipError,
    );
  });

  it("carries candidate ownership through to the row and the fields", async () => {
    const built = await buildOptimizeBasis(
      input({ ownerKind: "candidate", parentBasisId: "p", transformDigest: "t" }),
    );
    expect(built.record.parentBasisId).toBe("p");
    expect(built.record.transformDigest).toBe("t");
    expect(built.fields.parent_basis_id).toBe("p");
    expect(built.fields.transform_digest).toBe("t");
  });

  it("omits ownership fields entirely for an ordinary run", async () => {
    const built = await buildOptimizeBasis(input());
    expect(built.fields.parent_basis_id).toBeUndefined();
    expect(built.fields.transform_digest).toBeUndefined();
  });
});

describe("bindAcceptedJob", () => {
  async function unbound() {
    return (await buildOptimizeBasis(input())).record;
  }

  function accepted(row: Awaited<ReturnType<typeof unbound>>, over: Partial<JobBasis> = {}) {
    return {
      jobId: "job_1",
      basisId: over.basis_id ?? row.basisId,
      inputSha256: over.input_sha256 ?? row.submissionDigest,
      expiresAt: "2026-07-21T12:00:00Z",
    };
  }

  it("binds the job and its advertised expiry on an exact identity match", async () => {
    const row = await unbound();
    const bound = bindAcceptedJob(row, accepted(row));
    expect(bound).not.toBeNull();
    expect(bound!.jobId).toBe("job_1");
    expect(bound!.expiresAt).toBe("2026-07-21T12:00:00Z");
    // Every other field is untouched: binding is the only permitted mutation.
    expect({ ...bound!, jobId: null, expiresAt: null }).toEqual(row);
  });

  it("refuses a mismatched echoed basis id", async () => {
    const row = await unbound();
    expect(bindAcceptedJob(row, accepted(row, { basis_id: "z".repeat(64) }))).toBeNull();
  });

  it("refuses a mismatched echoed input digest", async () => {
    const row = await unbound();
    expect(bindAcceptedJob(row, accepted(row, { input_sha256: "z".repeat(64) }))).toBeNull();
  });

  it("refuses when the backend echoed no basis at all", async () => {
    const row = await unbound();
    expect(
      bindAcceptedJob(row, { jobId: "job_1", basisId: null, inputSha256: null, expiresAt: null }),
    ).toBeNull();
  });

  it("refuses to rebind an already-bound row", async () => {
    const row = await unbound();
    const bound = bindAcceptedJob(row, accepted(row))!;
    // Rebinding would let one submission's evidence be attributed to another job.
    expect(bindAcceptedJob(bound, { ...accepted(row), jobId: "job_2" })).toBeNull();
  });
});
