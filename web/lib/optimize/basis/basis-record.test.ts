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
  toTransmittedYaml,
  type BuildBasisInput,
} from "./basis-record";
import { computeBasisId, sha256HexOfUtf8 } from "./optimize-basis";

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
    // The TRANSMITTED bytes, not the string handed in. `submittedYaml` is the row's
    // raw material for recovery, and it must reproduce the row's own
    // `submissionDigest` -- which is taken over what the multipart serializer really
    // sends. See "the claimed digest describes the bytes that are actually
    // transmitted" below for why those two differ.
    expect(built.record.submittedYaml).toBe(toTransmittedYaml(YAML));
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

describe("the claimed digest describes the bytes that are actually transmitted", () => {
  // THE CONTRACT THIS PINS, and why it is worth a test that looks this indirect.
  //
  // `input_sha256` is verified server-side by re-hashing the bytes the request
  // carried. Both basis-claiming paths post their YAML as a multipart STRING FIELD,
  // and the `multipart/form-data` encoding algorithm normalizes every lone LF and CR
  // in a string field's value to CRLF. So the client and the server hash different
  // byte sequences for any multi-line document, and the backend answers with a
  // pre-job 422 -- Optimize fails outright, for every real submission.
  //
  // Nothing caught this: the backend's own admission tests post through Python, which
  // does not normalize, and in the browser no submission ever carried a claim at all.
  //
  // The test therefore refuses to restate the rule as "replace \n with \r\n". It runs
  // the REAL FormData serializer, reads back what a server would parse, and hashes
  // that. If the platform's normalization ever differs from what `toTransmittedYaml`
  // assumes, this fails rather than agreeing with itself.
  const MULTILINE = "workspaceVersion: 1\napiVersion: alpha\npeople:\n  items:\n    - id: a\n";

  /** What a server parsing this multipart body actually receives for the field. */
  async function transmittedFieldValue(yaml: string): Promise<string> {
    const form = new FormData();
    form.set("yaml_content", yaml);
    const parsed = await new Request("http://localhost/optimize", {
      method: "POST",
      body: form,
    }).formData();
    return String(parsed.get("yaml_content"));
  }

  it("hashes what the multipart serializer really sends, not the string handed in", async () => {
    const received = await transmittedFieldValue(MULTILINE);

    // SENSITIVITY. If the platform stopped normalizing, the assertion below would hold
    // trivially and prove nothing. This is the line that says the hazard is real.
    expect(received).not.toBe(MULTILINE);
    expect(received).toContain("\r\n");

    const built = await buildOptimizeBasis(input({ yaml: MULTILINE }));
    expect(built.fields.input_sha256).toBe(await sha256HexOfUtf8(received));
  });

  it("stores a row whose payload re-hashes to its own digest", async () => {
    // Recovery re-reads `submittedYaml`. A row whose stored payload does not reproduce
    // its own `submissionDigest` cannot be checked against anything.
    const built = await buildOptimizeBasis(input({ yaml: MULTILINE }));
    expect(await sha256HexOfUtf8(built.record.submittedYaml!)).toBe(built.record.submissionDigest);
    expect(built.record.submissionDigest).toBe(built.fields.input_sha256);
  });

  it("is idempotent, so an already-CRLF document is not double-normalized", async () => {
    const crlf = MULTILINE.replace(/\n/g, "\r\n");
    expect(toTransmittedYaml(crlf)).toBe(crlf);
    const fromLf = await buildOptimizeBasis(input({ yaml: MULTILINE }));
    const fromCrlf = await buildOptimizeBasis(input({ yaml: crlf }));
    // The same document submitted either way is the same submission on the wire.
    expect(fromCrlf.fields.input_sha256).toBe(fromLf.fields.input_sha256);
  });
});
