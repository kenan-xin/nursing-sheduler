// T10 — discriminating tests for the pure search record + policy decisions.
//
// Covers every acceptance state that must be testable without IndexedDB or a
// network: trusted/stale/mismatched open gating, first-feasible stop, explicit
// compare, five-candidate cap, exhaustion, identity binding (parent/transform/
// input mismatch fail closed), and Preview eligibility.

import { describe, expect, it } from "vitest";
import type { JobBasis } from "@/lib/bff/types";
import type { RecoveryClassification } from "@/lib/optimize/basis/recovery";
import type { AssistantCommandV1 } from "@/lib/proposal/commands";
import {
  appendSubmittedCandidate,
  closeSearch,
  openDiagnosticSearch,
  settleCandidate,
  type DiagnosticCandidate,
  type DiagnosticSearchRecordV1,
} from "./search-record";
import {
  candidateIdentityState,
  candidatePreviewEligibility,
  computeTransformDigest,
  deriveStopDecision,
  mayOpenSearch,
} from "./search-policy";

const NOW = new Date("2026-08-07T12:00:00Z");
const PARENT_BASIS = "p".repeat(64);

function trusted(): RecoveryClassification {
  return { state: "trusted", diagnosisEnabled: true, reason: "basis_match" };
}

function recovery(state: RecoveryClassification["state"]): RecoveryClassification {
  return { state, diagnosisEnabled: false, reason: `${state}_reason` };
}

function openSearch(over: Partial<DiagnosticSearchRecordV1> = {}): DiagnosticSearchRecordV1 {
  return {
    ...openDiagnosticSearch({
      searchId: "search-1",
      scenarioId: "scenario-1",
      threadId: "thread-1",
      turnId: "turn-1",
      parent: {
        basisId: PARENT_BASIS,
        jobId: "job_parent",
        scenarioId: "scenario-1",
        documentRevision: 5,
      },
      turnEpoch: 3,
      leaseEpoch: 1,
      globalGeneration: 1,
      scenarioGeneration: 1,
      compare: false,
      parentExpiresAt: "2026-08-08T00:00:00Z",
      now: NOW,
    }),
    ...over,
  };
}

function candidate(over: Partial<DiagnosticCandidate> = {}): DiagnosticCandidate {
  return {
    candidateId: "cand-1",
    index: 0,
    commands: [],
    commandsDigest: "d".repeat(32),
    transformDigest: "t".repeat(32),
    rationale: null,
    diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
    basisId: "c".repeat(64),
    inputSha256: "i".repeat(64),
    parentBasisId: PARENT_BASIS,
    submissionAttempted: true,
    jobId: "job_cand_1",
    outcome: null,
    rejection: null,
    submittedAt: NOW.toISOString(),
    settledAt: null,
    ...over,
  };
}

function serverBasis(over: Partial<JobBasis> = {}): JobBasis {
  return {
    basis_id: "c".repeat(64),
    schema_version: 2,
    submission_contract_version: "optimize-yaml-v1",
    workspace_schema_version: "1",
    serializer_version: "canonical-strict-yaml-v1",
    anonymization_mode: "none",
    input_sha256: "i".repeat(64),
    normalized_options: { solver: "ortools/cp-sat", prettify: false, timeout_seconds: 90 },
    solver_semantic_version: "ortools/cp-sat@1",
    backend_capability_version: "nurse-scheduling-backend@1",
    parent_basis_id: PARENT_BASIS,
    transform_digest: "t".repeat(32),
    ...over,
  };
}

const FEASIBLE = {
  outcome: "tested-feasible" as const,
  evidence: "feasibility" as const,
  reason: "feasible",
};
const STILL_INFEASIBLE = {
  outcome: "tested-still-infeasible" as const,
  evidence: "infeasibility" as const,
  reason: "infeasibility_proven",
};
const INCONCLUSIVE = {
  outcome: "inconclusive" as const,
  evidence: "no-proof" as const,
  reason: "solver_timeout_no_solution",
};
const FAILED = {
  outcome: "failed" as const,
  evidence: "none" as const,
  reason: "unclassified_failure",
};
const CANCELLED = {
  outcome: "cancelled" as const,
  evidence: "none" as const,
  reason: "user_cancelled",
};
const NOT_STARTED = {
  outcome: "not-started" as const,
  evidence: "none" as const,
  reason: "diagnostic_capacity_reserved",
};

// --- Open gate -------------------------------------------------------------

describe("mayOpenSearch", () => {
  it("opens for a trusted basis that matches the current scenario", () => {
    expect(mayOpenSearch({ recovery: trusted(), basisCurrent: true })).toEqual({ ok: true });
  });

  it("blocks when recovery is not trusted, regardless of scenario match", () => {
    const result = mayOpenSearch({ recovery: recovery("local-only"), basisCurrent: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("recovery_blocked");
      expect(result.message).toMatch(/no longer be diagnosed/i);
    }
  });

  it.each(["local-only", "server-only", "semantic-mismatch", "integrity-mismatch"] as const)(
    "blocks every non-trusted recovery state (%s)",
    (state) => {
      const result = mayOpenSearch({ recovery: recovery(state), basisCurrent: true });
      expect(result.ok).toBe(false);
    },
  );

  it("blocks a trusted basis when the scenario has moved (out of date)", () => {
    const result = mayOpenSearch({ recovery: trusted(), basisCurrent: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/out of date/i);
      expect(result.message).toMatch(/run optimize again/i);
    }
  });
});

// --- Stop decisions --------------------------------------------------------

describe("deriveStopDecision", () => {
  it("submits when no candidate has settled feasible and the cap is not reached", () => {
    const search = openSearch({ candidates: [candidate({ outcome: STILL_INFEASIBLE })] });
    expect(deriveStopDecision(search)).toEqual({ action: "submit" });
  });

  it("stops at the first tested-feasible candidate when compare is false", () => {
    const search = openSearch({ candidates: [candidate({ outcome: FEASIBLE })] });
    expect(deriveStopDecision(search)).toEqual({ action: "stop", reason: "first_feasible" });
  });

  it("continues past a feasible candidate when compare is true", () => {
    const search = openSearch({ compare: true, candidates: [candidate({ outcome: FEASIBLE })] });
    expect(deriveStopDecision(search)).toEqual({ action: "submit" });
  });

  it("stops with cap_reached when five candidates were submitted", () => {
    const submitted = Array.from({ length: 5 }, (_, index) =>
      candidate({
        candidateId: `cand-${index}`,
        index,
        jobId: `job-${index}`,
        outcome: STILL_INFEASIBLE,
      }),
    );
    const search = openSearch({ candidates: submitted });
    expect(deriveStopDecision(search)).toEqual({ action: "stop", reason: "cap_reached" });
  });

  it("stops with compare_complete when five candidates were submitted under compare", () => {
    const submitted = Array.from({ length: 5 }, (_, index) =>
      candidate({
        candidateId: `cand-${index}`,
        index,
        jobId: `job-${index}`,
        outcome: index === 0 ? FEASIBLE : STILL_INFEASIBLE,
      }),
    );
    const search = openSearch({ compare: true, candidates: submitted });
    expect(deriveStopDecision(search)).toEqual({ action: "stop", reason: "compare_complete" });
  });

  it("a host-rejected candidate never reached the backend, so it spends no slot", () => {
    const search = openSearch({
      candidates: [
        candidate({
          candidateId: "rej",
          submissionAttempted: false,
          jobId: null,
          outcome: NOT_STARTED,
          rejection: { code: "unknown_target", message: "no" },
        }),
        candidate({ candidateId: "sub", outcome: STILL_INFEASIBLE }),
      ],
    });
    expect(deriveStopDecision(search)).toEqual({ action: "submit" });
  });

  it("a capacity-refused candidate DID spend a slot, so five of them reach the cap", () => {
    // The refusal came from the backend, which means a request was made and the
    // bounded budget was spent. Counting only ACCEPTED jobs here would let a
    // saturated queue be retried without limit — the exact unbounded behaviour the
    // five-candidate cap exists to prevent.
    const refused = Array.from({ length: 5 }, (_, index) =>
      candidate({
        candidateId: `cand-${index}`,
        index,
        jobId: null,
        outcome: {
          outcome: "not-started",
          evidence: "none",
          reason: "diagnostic_capacity_reserved",
        },
      }),
    );
    const search = openSearch({ candidates: refused });
    expect(deriveStopDecision(search)).toEqual({ action: "stop", reason: "cap_reached" });
  });

  it("returns the recorded stop reason for an already-closed search", () => {
    const closed = closeSearch(openSearch(), "interrupted", null, NOW);
    expect(deriveStopDecision(closed)).toEqual({ action: "stop", reason: "interrupted" });
  });
});

// --- Identity binding ------------------------------------------------------

describe("candidateIdentityState", () => {
  it("passes when basis, parent, transform and input digest all agree", () => {
    const search = openSearch({ candidates: [candidate({ outcome: FEASIBLE })] });
    expect(candidateIdentityState(search, search.candidates[0], serverBasis())).toEqual({
      ok: true,
    });
  });

  it("fails closed when the server echoed no basis at all", () => {
    // An accepted job that comes back without the basis it was accepted under cannot
    // be compared to anything. Trusting the browser's own word here would make the
    // whole identity chain decorative.
    const search = openSearch({ candidates: [candidate({ outcome: FEASIBLE })] });
    expect(candidateIdentityState(search, search.candidates[0], null)).toEqual({
      ok: false,
      reason: "input_mismatch",
    });
  });

  it("fails closed when the server reports different submitted bytes", () => {
    const search = openSearch({ candidates: [candidate({ outcome: FEASIBLE })] });
    const result = candidateIdentityState(
      search,
      search.candidates[0],
      serverBasis({ input_sha256: "z".repeat(64) }),
    );
    expect(result).toEqual({ ok: false, reason: "input_mismatch" });
  });

  it("fails closed when the server reports a different candidate basis id", () => {
    const search = openSearch({ candidates: [candidate({ outcome: FEASIBLE })] });
    const result = candidateIdentityState(
      search,
      search.candidates[0],
      serverBasis({ basis_id: "y".repeat(64) }),
    );
    expect(result).toEqual({ ok: false, reason: "input_mismatch" });
  });

  it("fails closed on a parent mismatch (candidate hung off a different parent)", () => {
    const search = openSearch({
      candidates: [candidate({ outcome: FEASIBLE, parentBasisId: "x".repeat(64) })],
    });
    const result = candidateIdentityState(search, search.candidates[0], serverBasis());
    expect(result).toEqual({ ok: false, reason: "parent_mismatch" });
  });

  it("fails closed when the server reports a different parent", () => {
    const search = openSearch({ candidates: [candidate({ outcome: FEASIBLE })] });
    const result = candidateIdentityState(
      search,
      search.candidates[0],
      serverBasis({ parent_basis_id: "other".repeat(8) }),
    );
    expect(result).toEqual({ ok: false, reason: "parent_mismatch" });
  });

  it("fails closed when the server reports a different transform digest", () => {
    const search = openSearch({ candidates: [candidate({ outcome: FEASIBLE })] });
    const result = candidateIdentityState(
      search,
      search.candidates[0],
      serverBasis({ transform_digest: "z".repeat(32) }),
    );
    // transform mismatch surfaces before input mismatch (parent check passes).
    expect(result).toEqual({ ok: false, reason: "transform_mismatch" });
  });

  it("fails closed for an unsettled candidate", () => {
    const search = openSearch({ candidates: [candidate({ outcome: null })] });
    const result = candidateIdentityState(search, search.candidates[0], serverBasis());
    expect(result).toEqual({ ok: false, reason: "unsettled" });
  });

  it("fails closed for a candidate with no jobId (host-rejected)", () => {
    const search = openSearch({
      candidates: [candidate({ jobId: null, outcome: NOT_STARTED })],
    });
    const result = candidateIdentityState(search, search.candidates[0], serverBasis());
    expect(result).toEqual({ ok: false, reason: "unsettled" });
  });
});

// --- Preview eligibility ---------------------------------------------------

describe("candidatePreviewEligibility", () => {
  it("a tested-feasible candidate whose identity binds is an optimizer_tested Preview", () => {
    const c = candidate({ outcome: FEASIBLE });
    const search = openSearch({ candidates: [c] });
    const result = candidatePreviewEligibility(search, c, serverBasis());
    expect(result.eligible).toBe(true);
    expect(result.outcome).toBe("optimizer_tested");
    expect(result.evidence[0]).toMatchObject({ kind: "optimizer_basis", reference: c.basisId });
  });

  it("an inconclusive candidate is eligible for an inconclusive Preview", () => {
    const c = candidate({ outcome: INCONCLUSIVE });
    const search = openSearch({ candidates: [c] });
    const result = candidatePreviewEligibility(search, c, serverBasis());
    expect(result.eligible).toBe(true);
    expect(result.outcome).toBe("inconclusive");
  });

  it.each([STILL_INFEASIBLE, FAILED, CANCELLED, NOT_STARTED])(
    "a non-feasible/non-inconclusive candidate is never Preview-eligible (%s)",
    (outcome) => {
      const c = candidate({ outcome });
      const search = openSearch({ candidates: [c] });
      const result = candidatePreviewEligibility(search, c, serverBasis());
      expect(result.eligible).toBe(false);
    },
  );

  it("a feasible candidate whose bytes the server does not confirm is NOT eligible", () => {
    const c = candidate({ outcome: FEASIBLE });
    const search = openSearch({ candidates: [c] });
    const result = candidatePreviewEligibility(
      search,
      c,
      serverBasis({ input_sha256: "z".repeat(64) }),
    );
    expect(result.eligible).toBe(false);
  });

  it("a feasible candidate with a parent mismatch is NOT eligible (cannot become Apply-capable)", () => {
    const c = candidate({ outcome: FEASIBLE, parentBasisId: "x".repeat(64) });
    const search = openSearch({ candidates: [c] });
    const result = candidatePreviewEligibility(search, c, serverBasis());
    expect(result.eligible).toBe(false);
  });
});

// --- Transform digest ------------------------------------------------------

describe("computeTransformDigest", () => {
  it("is stable for the same commands + diff", () => {
    const commands: AssistantCommandV1[] = [
      { type: "set_rule_enabled", ruleKind: "requirements", ruleId: "r1", enabled: false },
    ];
    const diff = { direct: [], cascade: [], capabilityIds: ["rules"], needsReview: [] };
    expect(computeTransformDigest(commands, diff)).toBe(computeTransformDigest(commands, diff));
  });

  it("changes when the commands change", () => {
    const diff = { direct: [], cascade: [], capabilityIds: [], needsReview: [] };
    const a: AssistantCommandV1[] = [
      { type: "set_rule_enabled", ruleKind: "requirements", ruleId: "r1", enabled: false },
    ];
    const b: AssistantCommandV1[] = [
      { type: "set_rule_enabled", ruleKind: "requirements", ruleId: "r1", enabled: true },
    ];
    expect(computeTransformDigest(a, diff)).not.toBe(computeTransformDigest(b, diff));
  });

  it("changes when the diff changes (same commands, different effect)", () => {
    const commands: AssistantCommandV1[] = [];
    const d1 = { direct: [], cascade: [], capabilityIds: ["rules"], needsReview: [] };
    const d2 = { direct: [], cascade: [], capabilityIds: ["staff"], needsReview: [] };
    expect(computeTransformDigest(commands, d1)).not.toBe(computeTransformDigest(commands, d2));
  });
});

// --- Record transitions ----------------------------------------------------

describe("search-record transitions", () => {
  it("appendSubmittedCandidate assigns sequential indices and preserves order", () => {
    let search = openSearch();
    search = appendSubmittedCandidate(
      search,
      {
        candidateId: "c1",
        commands: [],
        commandsDigest: "d1",
        transformDigest: "t1",
        rationale: null,
        diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
        basisId: "b1",
        inputSha256: "i1",
        parentBasisId: PARENT_BASIS,
        now: NOW,
      },
      "job-1",
    );
    search = appendSubmittedCandidate(
      search,
      {
        candidateId: "c2",
        commands: [],
        commandsDigest: "d2",
        transformDigest: "t2",
        rationale: null,
        diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
        basisId: "b2",
        inputSha256: "i2",
        parentBasisId: PARENT_BASIS,
        now: NOW,
      },
      "job-2",
    );
    expect(search.candidates.map((c) => c.index)).toEqual([0, 1]);
    expect(search.candidates.map((c) => c.jobId)).toEqual(["job-1", "job-2"]);
  });

  it("settleCandidate updates only the named candidate", () => {
    let search = openSearch();
    search = appendSubmittedCandidate(
      search,
      {
        candidateId: "c1",
        commands: [],
        commandsDigest: "d1",
        transformDigest: "t1",
        rationale: null,
        diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
        basisId: "b1",
        inputSha256: "i1",
        parentBasisId: PARENT_BASIS,
        now: NOW,
      },
      "job-1",
    );
    search = settleCandidate(search, "c1", FEASIBLE, NOW);
    expect(search.candidates[0].outcome).toEqual(FEASIBLE);
    expect(search.candidates[0].settledAt).toBe(NOW.toISOString());
  });

  it("closeSearch with interrupted marks the status interrupted", () => {
    const closed = closeSearch(openSearch(), "interrupted", null, NOW);
    expect(closed.status).toBe("interrupted");
    expect(closed.stopReason).toBe("interrupted");
  });

  it("closeSearch with recovery_blocked marks the status failed", () => {
    const closed = closeSearch(openSearch(), "recovery_blocked", "no trust", NOW);
    expect(closed.status).toBe("failed");
    expect(closed.failureReason).toBe("no trust");
  });

  it("closeSearch with first_feasible marks the status completed", () => {
    const closed = closeSearch(openSearch(), "first_feasible", null, NOW);
    expect(closed.status).toBe("completed");
  });
});
