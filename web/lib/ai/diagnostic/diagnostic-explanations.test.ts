// T10 — nurse-facing explanation wording. The evidence/hypothesis/assumption
// distinction is a hard product requirement: a feasible copy proves only its exact
// document, never the cause; an untested idea stays a suggestion.

import { describe, expect, it } from "vitest";
import {
  CAUSE_UNAVAILABLE,
  candidateEvidenceLabel,
  explainCandidateOutcome,
  explainSearchSummary,
} from "./diagnostic-explanations";
import {
  openDiagnosticSearch,
  appendSubmittedCandidate,
  settleCandidate,
  closeSearch,
  type DiagnosticCandidate,
} from "./search-record";
import type { ProductOutcomeView } from "@/lib/optimize/outcome-mapping";

const NOW = new Date("2026-08-07T12:00:00Z");
const PARENT = "p".repeat(64);

function open() {
  return openDiagnosticSearch({
    searchId: "s1",
    scenarioId: "sc1",
    threadId: null,
    turnId: null,
    parent: { basisId: PARENT, jobId: "jp", scenarioId: "sc1", documentRevision: 1 },
    turnEpoch: 1,
    leaseEpoch: 1,
    globalGeneration: 0,
    scenarioGeneration: 0,
    compare: false,
    parentExpiresAt: null,
    now: NOW,
  });
}

function withCandidate(outcome: ProductOutcomeView | null, index = 0) {
  const c: DiagnosticCandidate = {
    candidateId: `c${index}`,
    index,
    commands: [],
    commandsDigest: "d",
    transformDigest: "t",
    rationale: null,
    diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
    basisId: "b",
    inputSha256: "i",
    parentBasisId: PARENT,
    submissionAttempted: true,
    jobId: "j",
    outcome: null,
    rejection: null,
    submittedAt: NOW.toISOString(),
    settledAt: null,
  };
  let search = open();
  search = appendSubmittedCandidate(
    search,
    {
      candidateId: c.candidateId,
      commands: [],
      commandsDigest: "d",
      transformDigest: "t",
      rationale: null,
      diff: c.diff,
      basisId: "b",
      inputSha256: "i",
      parentBasisId: PARENT,
      now: NOW,
    },
    "j",
  );
  if (outcome) search = settleCandidate(search, c.candidateId, outcome, NOW);
  return search;
}

describe("explainCandidateOutcome", () => {
  it("tested-feasible proves only the exact copy, not the cause", () => {
    const text = explainCandidateOutcome(
      {
        outcome: { outcome: "tested-feasible", evidence: "feasibility", reason: "feasible" },
      } as DiagnosticCandidate,
      0,
    );
    expect(text).toMatch(/solvable/i);
    expect(text).toMatch(/does not prove/i);
    // It must explicitly disclaim establishing the cause.
    expect(text).toMatch(/does not.*explains? why the original failed/i);
    expect(text).not.toMatch(/this is (the |why )/i);
  });

  it("tested-still-infeasible is real evidence without overclaiming", () => {
    const text = explainCandidateOutcome(
      {
        outcome: {
          outcome: "tested-still-infeasible",
          evidence: "infeasibility",
          reason: "infeasibility_proven",
        },
      } as DiagnosticCandidate,
      1,
    );
    expect(text).toMatch(/still proven infeasible/i);
    expect(text).toMatch(/real evidence/i);
  });

  it("inconclusive names the no-proof state and the reason", () => {
    const text = explainCandidateOutcome(
      {
        outcome: {
          outcome: "inconclusive",
          evidence: "no-proof",
          reason: "solver_timeout_no_solution",
        },
      } as DiagnosticCandidate,
      0,
    );
    expect(text).toMatch(/neither way/i);
    expect(text).toMatch(/timed out/i);
  });

  it("failed names the failure class and disclaims evidence", () => {
    const text = explainCandidateOutcome(
      {
        outcome: { outcome: "failed", evidence: "none", reason: "unclassified_failure" },
      } as DiagnosticCandidate,
      0,
    );
    expect(text).toMatch(/no evidence/i);
  });

  it("not-started capacity rejection names the reserved ordinary capacity", () => {
    const text = explainCandidateOutcome(
      {
        outcome: {
          outcome: "not-started",
          evidence: "none",
          reason: "diagnostic_capacity_reserved",
        },
      } as DiagnosticCandidate,
      0,
    );
    expect(text).toMatch(/diagnostic capacity/i);
    expect(text).toMatch(/never blocked by diagnostics/i);
  });
});

describe("explainSearchSummary", () => {
  it("a first-feasible search names the candidate and repeats the proof boundary", () => {
    let search = withCandidate({
      outcome: "tested-feasible",
      evidence: "feasibility",
      reason: "feasible",
    });
    search = closeSearch(search, "first_feasible", null, NOW);
    const text = explainSearchSummary(search);
    expect(text).toMatch(/candidate 1/i);
    expect(text).toMatch(/proves only/i);
  });

  it("an exhausted search with no feasible candidate ends with cause-unavailable", () => {
    let search = withCandidate({
      outcome: "tested-still-infeasible",
      evidence: "infeasibility",
      reason: "infeasibility_proven",
    });
    search = closeSearch(search, "exhausted", null, NOW);
    const text = explainSearchSummary(search);
    expect(text).toMatch(/none of the tested copies was solvable/i);
    expect(text).toContain(CAUSE_UNAVAILABLE);
  });

  it("a recovery-blocked search with no candidates surfaces the failure reason", () => {
    const search = closeSearch(open(), "recovery_blocked", "Run Optimize again.", NOW);
    expect(explainSearchSummary(search)).toMatch(/run optimize again/i);
  });

  it("an interrupted search with no candidates says it was stopped", () => {
    const search = closeSearch(open(), "interrupted", null, NOW);
    expect(explainSearchSummary(search)).toMatch(/stopped before any candidate/i);
  });
});

describe("candidateEvidenceLabel", () => {
  it("labels feasibility evidence as verified", () => {
    expect(
      candidateEvidenceLabel({ outcome: "tested-feasible", evidence: "feasibility", reason: "x" }),
    ).toMatch(/verified/i);
  });

  it("labels no-proof as inconclusive, not as a failure", () => {
    expect(
      candidateEvidenceLabel({ outcome: "inconclusive", evidence: "no-proof", reason: "x" }),
    ).toMatch(/inconclusive/i);
  });

  it("labels none as no solver evidence", () => {
    expect(candidateEvidenceLabel({ outcome: "failed", evidence: "none", reason: "x" })).toMatch(
      /no solver evidence/i,
    );
  });

  it("labels an unsettled candidate as not yet tested", () => {
    expect(candidateEvidenceLabel(null)).toMatch(/not yet tested/i);
  });
});
