// T08 — the closed recovery classification. Exactly one state enables diagnosis;
// every other input, including a plausible-looking near-match, must not.

import { describe, expect, it } from "vitest";
import type { JobBasis } from "@/lib/bff/types";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import type { OptimizeBasisRecordV1, OptimizeBasisRecordV2 } from "./basis-row";
import { classifyRecovery, isBasisCurrent, type ServerJobFacts } from "./recovery";

const NOW = new Date("2026-07-20T12:00:00Z");
const FUTURE = "2026-07-21T00:00:00Z";
const PAST = "2026-07-20T00:00:00Z";

const BASIS_ID = "a".repeat(64);
const INPUT_SHA = "b".repeat(64);

const PROFILE: InfoSemanticProfile = {
  submission_contract_version: "optimize-yaml-v1",
  solver_semantic_version: "ortools/cp-sat@1",
  backend_capability_version: "nurse-scheduling-backend@1",
};

function localRow(over: Partial<OptimizeBasisRecordV2> = {}): OptimizeBasisRecordV2 {
  return {
    basisId: BASIS_ID,
    schemaVersion: 2,
    scenarioId: "scenario-1",
    documentRevision: 7,
    submissionDigest: INPUT_SHA,
    basis: {
      schemaVersion: 2,
      submissionContractVersion: PROFILE.submission_contract_version,
      workspaceSchemaVersion: "1",
      serializerVersion: "canonical-strict-yaml-v1",
      anonymizationMode: "none",
      inputSha256: INPUT_SHA,
      normalizedOptions: { solver: "ortools/cp-sat", prettify: false, timeoutSeconds: 300 },
      solverSemanticVersion: PROFILE.solver_semantic_version,
      backendCapabilityVersion: PROFILE.backend_capability_version,
    },
    ownerKind: "ordinary",
    attemptId: "attempt-1",
    jobId: "job_1",
    parentBasisId: null,
    transformDigest: null,
    submittedYaml: "workspaceVersion: 1\n",
    createdAt: PAST,
    expiresAt: FUTURE,
    ...over,
  };
}

function serverBasis(over: Partial<JobBasis> = {}): JobBasis {
  return {
    basis_id: BASIS_ID,
    schema_version: 2,
    submission_contract_version: PROFILE.submission_contract_version,
    workspace_schema_version: "1",
    serializer_version: "canonical-strict-yaml-v1",
    anonymization_mode: "none",
    input_sha256: INPUT_SHA,
    normalized_options: { solver: "ortools/cp-sat", prettify: false, timeout_seconds: 300 },
    solver_semantic_version: PROFILE.solver_semantic_version,
    backend_capability_version: PROFILE.backend_capability_version,
    parent_basis_id: null,
    transform_digest: null,
    ...over,
  };
}

function present(over: Partial<JobBasis> = {}, expiresAt: string | null = FUTURE): ServerJobFacts {
  return { kind: "present", basis: serverBasis(over), expiresAt };
}

/** A pre-T08 row: its digest came from an encoder this build no longer has. */
function legacyRow(over: Partial<OptimizeBasisRecordV1> = {}): OptimizeBasisRecordV1 {
  return {
    basisId: BASIS_ID,
    schemaVersion: 1,
    scenarioId: "scenario-1",
    documentRevision: 7,
    submissionDigest: INPUT_SHA,
    semanticBasisDigest: "sha256:legacy-semantic-basis",
    createdAt: PAST,
    expiresAt: FUTURE,
    ...over,
  };
}

describe("classifyRecovery on a legacy schema-V1 row (C2F3)", () => {
  it("quarantines it even against the most favourable server facts", () => {
    // Id, digest, ownership, profile, and expiry all line up. Nothing about a V1
    // row can actually be VERIFIED, so agreement here is coincidence, not evidence.
    expect(
      classifyRecovery({
        local: legacyRow(),
        server: present(),
        liveProfile: PROFILE,
        now: NOW,
      }),
    ).toEqual({
      state: "integrity-mismatch",
      diagnosisEnabled: false,
      reason: "legacy_basis_schema",
    });
  });

  it("refuses before presence, so a missing server job cannot soften it", () => {
    // Order matters: reporting `local-only` would read as "retry and it works",
    // which is not what an unverifiable row means.
    expect(
      classifyRecovery({
        local: legacyRow(),
        server: { kind: "missing" },
        liveProfile: PROFILE,
        now: NOW,
      }).reason,
    ).toBe("legacy_basis_schema");
  });

  it("refuses a row that merely CLAIMS to be V2 without the fields to prove it", () => {
    const { ownerKind: _dropped, ...malformed } = localRow();
    expect(
      classifyRecovery({
        local: malformed as OptimizeBasisRecordV2,
        server: present(),
        liveProfile: PROFILE,
        now: NOW,
      }).state,
    ).toBe("integrity-mismatch");
  });
});

describe("classifyRecovery", () => {
  it("trusts a run only when local, server, and live semantics all agree", () => {
    expect(
      classifyRecovery({ local: localRow(), server: present(), liveProfile: PROFILE, now: NOW }),
    ).toEqual({ state: "trusted", diagnosisEnabled: true, reason: "basis_match" });
  });

  it("is local-only when the server job is gone", () => {
    const result = classifyRecovery({
      local: localRow(),
      server: { kind: "missing" },
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(result).toEqual({
      state: "local-only",
      diagnosisEnabled: false,
      reason: "server_job_missing",
    });
  });

  it("is server-only when the local row was reaped", () => {
    const result = classifyRecovery({
      local: null,
      server: present(),
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(result.state).toBe("server-only");
    expect(result.diagnosisEnabled).toBe(false);
  });

  it("is local-only when neither side retained anything", () => {
    const result = classifyRecovery({
      local: null,
      server: { kind: "missing" },
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(result).toEqual({
      state: "local-only",
      diagnosisEnabled: false,
      reason: "nothing_retained",
    });
  });

  it("is server-only when the server job carries no basis to compare", () => {
    const result = classifyRecovery({
      local: localRow(),
      server: { kind: "present", basis: null, expiresAt: FUTURE },
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(result.state).toBe("server-only");
    expect(result.reason).toBe("server_basis_absent");
  });

  it("reports a differing basis id as an integrity failure, not a version drift", () => {
    const result = classifyRecovery({
      local: localRow(),
      server: present({ basis_id: "c".repeat(64) }),
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(result).toEqual({
      state: "integrity-mismatch",
      diagnosisEnabled: false,
      reason: "basis_id_mismatch",
    });
  });

  it("reports differing submitted bytes as an integrity failure", () => {
    const result = classifyRecovery({
      local: localRow(),
      server: present({ input_sha256: "d".repeat(64) }),
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(result.reason).toBe("input_digest_mismatch");
    expect(result.state).toBe("integrity-mismatch");
  });

  it("reports a rebound parent or transform as an ownership failure", () => {
    const rebound = classifyRecovery({
      local: localRow({ parentBasisId: "e".repeat(64), transformDigest: "t1" }),
      server: present({ parent_basis_id: "f".repeat(64), transform_digest: "t1" }),
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(rebound.reason).toBe("ownership_mismatch");

    const retransformed = classifyRecovery({
      local: localRow({ parentBasisId: "e".repeat(64), transformDigest: "t1" }),
      server: present({ parent_basis_id: "e".repeat(64), transform_digest: "t2" }),
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(retransformed.reason).toBe("ownership_mismatch");
  });

  it("checks integrity BEFORE semantics, so mismatched bytes are never called stale", () => {
    // Both are wrong. Reporting this as a version drift would invite a retry that
    // silently re-submits different content.
    const result = classifyRecovery({
      local: localRow({ submissionDigest: "9".repeat(64) }),
      server: present(),
      liveProfile: { ...PROFILE, solver_semantic_version: "ortools/cp-sat@2" },
      now: NOW,
    });
    expect(result.state).toBe("integrity-mismatch");
  });

  it("reports a moved backend profile as a semantic mismatch", () => {
    const result = classifyRecovery({
      local: localRow(),
      server: present(),
      liveProfile: { ...PROFILE, solver_semantic_version: "ortools/cp-sat@2" },
      now: NOW,
    });
    expect(result).toEqual({
      state: "semantic-mismatch",
      diagnosisEnabled: false,
      reason: "semantic_profile_changed",
    });
  });

  it("reports a server job solved under an older profile as stale", () => {
    const result = classifyRecovery({
      local: localRow(),
      server: present({ solver_semantic_version: "ortools/cp-sat@0" }),
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(result.reason).toBe("server_profile_stale");
  });

  it("fails closed when the live profile cannot be read", () => {
    // "We cannot check" is not "it matches".
    const result = classifyRecovery({
      local: localRow(),
      server: present(),
      liveProfile: null,
      now: NOW,
    });
    expect(result).toEqual({
      state: "semantic-mismatch",
      diagnosisEnabled: false,
      reason: "live_profile_unknown",
    });
  });

  it("stops trusting a run past its advertised expiry even while readable", () => {
    const result = classifyRecovery({
      local: localRow(),
      server: present({}, PAST),
      liveProfile: PROFILE,
      now: NOW,
    });
    expect(result).toEqual({
      state: "server-only",
      diagnosisEnabled: false,
      reason: "server_evidence_expired",
    });
  });

  it("treats an absent or unparseable server expiry as expired", () => {
    for (const expiresAt of [null, "not-a-date"]) {
      const result = classifyRecovery({
        local: localRow(),
        server: present({}, expiresAt),
        liveProfile: PROFILE,
        now: NOW,
      });
      expect(result.reason).toBe("server_evidence_expired");
    }
  });

  it("never enables diagnosis outside the trusted state", () => {
    const cases: Parameters<typeof classifyRecovery>[0][] = [
      { local: null, server: present(), liveProfile: PROFILE, now: NOW },
      { local: localRow(), server: { kind: "missing" }, liveProfile: PROFILE, now: NOW },
      {
        local: localRow(),
        server: present({ basis_id: "c".repeat(64) }),
        liveProfile: PROFILE,
        now: NOW,
      },
      { local: localRow(), server: present(), liveProfile: null, now: NOW },
      { local: localRow(), server: present({}, PAST), liveProfile: PROFILE, now: NOW },
    ];
    for (const input of cases) {
      expect(classifyRecovery(input).diagnosisEnabled).toBe(false);
    }
  });
});

describe("isBasisCurrent", () => {
  it("is current only for the exact scenario AND document revision", () => {
    const row = localRow();
    expect(isBasisCurrent(row, { scenarioId: "scenario-1", documentRevision: 7 })).toBe(true);
    expect(isBasisCurrent(row, { scenarioId: "scenario-1", documentRevision: 8 })).toBe(false);
    expect(isBasisCurrent(row, { scenarioId: "scenario-2", documentRevision: 7 })).toBe(false);
  });
});
