// Preview readiness, staleness, and the Apply idempotency key (T07).
//
// This is the ticket's "exact stale/target/interruption/takeover invalidation"
// requirement stated as one table: every basis a proposal binds to is moved in turn,
// and each one must block Apply on its own. A test that only moved the revision
// would let a takeover through.

import { describe, expect, it } from "vitest";
import { deriveAssumptions } from "./assumptions";
import { deriveProposalDiff } from "./diff";
import { applyAssistantCommands } from "./operations";
import { prepareProposal, reviseProposal } from "./prepare";
import {
  deriveIdempotencyKey,
  describeProposalReadiness,
  type LiveProposalBasis,
  type PreparedProposalV1,
} from "./proposal";
import { FIXTURE_STAMP, octoberWard, proposalScenario } from "./test-support";

const COMMANDS = [
  { type: "set_staffing_requirement_people" as const, ruleId: "req-day", requiredNumPeople: 4 },
];

function prepared(overrides: Partial<Parameters<typeof prepareProposal>[0]> = {}) {
  const result = prepareProposal({
    proposalId: "prop-1",
    revision: 1,
    scenarioId: "scenario-1",
    threadId: "thread-1",
    turnId: "turn-1",
    document: proposalScenario(),
    baseDocumentRevision: 7,
    baseCommitId: "commit-7",
    leaseEpoch: 3,
    registryStamp: FIXTURE_STAMP,
    commands: COMMANDS,
    rationale: "You said the Day shift needs another pair of hands.",
    evidence: [{ kind: "user_statement", label: "You said so", reference: null }],
    outcome: "untested",
    globalGeneration: 0,
    scenarioGeneration: 0,
    now: new Date("2026-08-06T00:00:00.000Z"),
    ...overrides,
  });
  if (!result.ok) throw new Error(`fixture refused: ${result.rejection.message}`);
  return result.proposal;
}

const LIVE: LiveProposalBasis = {
  scenarioId: "scenario-1",
  documentRevision: 7,
  topCommitId: "commit-7",
  leaseEpoch: 3,
  isOwner: true,
  conflictingDraft: null,
  invalidated: false,
  registryStamp: FIXTURE_STAMP,
};

describe("prepareProposal", () => {
  it("binds the basis and carries the host-derived change set", () => {
    const proposal = prepared();
    expect(proposal).toMatchObject({
      baseDocumentRevision: 7,
      baseCommitId: "commit-7",
      leaseEpoch: 3,
      status: "preview_ready",
      confirmations: [],
    });
    // The diff and the assumptions on the row are the SAME values the pure
    // derivations produce, so the Preview and the Apply transaction agree by
    // construction rather than by two implementations meeting in the middle.
    const applied = applyAssistantCommands(proposalScenario(), COMMANDS);
    if (!applied.ok) throw new Error("fixture");
    expect(proposal.diff).toEqual(deriveProposalDiff(proposalScenario(), applied.next, COMMANDS));
    expect(proposal.assumptions).toEqual(
      deriveAssumptions(proposalScenario(), applied.next, COMMANDS),
    );
  });

  it("opens as confirmation_required when the change carries an agreement", () => {
    const proposal = prepared({
      commands: [{ type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" }],
    });
    expect(proposal.status).toBe("confirmation_required");
    expect(describeProposalReadiness(proposal, LIVE).applyEnabled).toBe(false);
  });

  it("opens as confirmation_required when a request change clears someone's leave", () => {
    const proposal = prepared({
      document: octoberWard(),
      commands: [
        { type: "clear_requests", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
      ],
    });
    expect(proposal.status).toBe("confirmation_required");
    expect(proposal.assumptions.map((a) => a.question)).toEqual([
      "Has Ana agreed to give up their leave on 14?",
    ]);
  });

  it("refuses an empty change rather than rendering a live Apply over nothing", () => {
    const result = prepareProposal({
      proposalId: "p",
      revision: 1,
      scenarioId: "s",
      threadId: null,
      turnId: null,
      document: proposalScenario(),
      baseDocumentRevision: 1,
      baseCommitId: null,
      leaseEpoch: 1,
      registryStamp: FIXTURE_STAMP,
      commands: [],
      rationale: null,
      evidence: [],
      outcome: "untested",
      globalGeneration: 0,
      scenarioGeneration: 0,
      now: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("no_effect");
  });

  it("a revision keeps the identity, moves the revision, and starts with no answers", () => {
    const first = prepared({
      commands: [{ type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" }],
    });
    const answered: PreparedProposalV1 = {
      ...first,
      confirmations: [
        {
          assumptionId: first.assumptions[0].assumptionId,
          type: first.assumptions[0].type,
          person: first.assumptions[0].person,
          date: first.assumptions[0].date,
          toDate: first.assumptions[0].toDate,
          proposalRevision: 1,
          confirmedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
    };
    expect(describeProposalReadiness(answered, LIVE).applyEnabled).toBe(true);

    const revised = reviseProposal(answered, {
      scenarioId: "scenario-1",
      threadId: "thread-1",
      turnId: "turn-2",
      document: proposalScenario(),
      baseDocumentRevision: 7,
      baseCommitId: "commit-7",
      leaseEpoch: 3,
      registryStamp: FIXTURE_STAMP,
      commands: [{ type: "move_leave", personId: "ana", fromDate: "02", toDate: "12" }],
      rationale: null,
      evidence: [],
      outcome: "untested",
      globalGeneration: 0,
      scenarioGeneration: 0,
      now: new Date("2026-08-06T00:01:00.000Z"),
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.proposal.proposalId).toBe(first.proposalId);
    expect(revised.proposal.revision).toBe(2);
    // The agreement about moving to the 10th is not authorisation for the 12th.
    expect(revised.proposal.confirmations).toEqual([]);
    expect(describeProposalReadiness(revised.proposal, LIVE).applyEnabled).toBe(false);
  });
});

describe("describeProposalReadiness", () => {
  it("enables Apply only when every binding still holds", () => {
    const readiness = describeProposalReadiness(prepared(), LIVE);
    expect(readiness.status).toBe("preview_ready");
    expect(readiness.applyEnabled).toBe(true);
    expect(readiness.blocks).toEqual([]);
  });

  // Each row moves exactly ONE thing. If any of them stopped blocking, this table is
  // where it shows up, rather than in a support ticket about a change that applied
  // to the wrong document.
  const invalidations: [string, Partial<LiveProposalBasis>, string][] = [
    ["an edit landed", { documentRevision: 8 }, "document_changed"],
    ["the top commit moved", { topCommitId: "commit-9" }, "document_changed"],
    ["a different schedule is open", { scenarioId: "scenario-2" }, "scenario_changed"],
    ["editing was taken over", { leaseEpoch: 4 }, "lease_changed"],
    ["this tab is read-only", { isOwner: false }, "not_owner"],
    ["the turn was interrupted", { invalidated: true }, "interrupted"],
    ["a form draft is open", { conflictingDraft: "shift-type-editor" }, "conflicting_draft"],
    [
      "the app was redeployed",
      { registryStamp: { appBuildVersion: "next", manifestSha256: "other" } },
      "registry_changed",
    ],
  ];

  for (const [name, over, code] of invalidations) {
    it(`blocks Apply when ${name}`, () => {
      const readiness = describeProposalReadiness(prepared(), { ...LIVE, ...over });
      expect(readiness.applyEnabled).toBe(false);
      expect(readiness.status).toBe("stale");
      expect(readiness.blocks.map((block) => block.code)).toContain(code);
    });
  }

  it("reports staleness INSTEAD of asking for a confirmation it cannot use", () => {
    const proposal = prepared({
      commands: [{ type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" }],
    });
    const readiness = describeProposalReadiness(proposal, { ...LIVE, documentRevision: 8 });
    expect(readiness.blocks.map((block) => block.code)).not.toContain("confirmation_required");
    expect(readiness.status).toBe("stale");
  });

  it("keeps a settled proposal settled", () => {
    for (const status of ["applied", "cancelled"] as const) {
      const readiness = describeProposalReadiness({ ...prepared(), status }, LIVE);
      expect(readiness.applyEnabled).toBe(false);
      expect(readiness.status).toBe(status);
    }
  });
});

describe("deriveIdempotencyKey", () => {
  it("is stable for the same Apply and different for every input that changes it", () => {
    const base = prepared();
    const key = deriveIdempotencyKey(base);
    expect(deriveIdempotencyKey(prepared())).toBe(key);

    const variants: Partial<PreparedProposalV1>[] = [
      { revision: 2 },
      { proposalId: "prop-2" },
      { baseDocumentRevision: 8 },
      { baseCommitId: "commit-9" },
      { leaseEpoch: 4 },
      { commandsDigest: "different" },
    ];
    for (const over of variants) {
      expect(deriveIdempotencyKey({ ...base, ...over }), JSON.stringify(over)).not.toBe(key);
    }
  });

  it("changes when the recorded confirmations change", () => {
    const proposal = prepared({
      commands: [{ type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" }],
    });
    const withAnswer: PreparedProposalV1 = {
      ...proposal,
      confirmations: [
        {
          assumptionId: proposal.assumptions[0].assumptionId,
          type: proposal.assumptions[0].type,
          person: proposal.assumptions[0].person,
          date: proposal.assumptions[0].date,
          toDate: proposal.assumptions[0].toDate,
          proposalRevision: 1,
          confirmedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
    };
    expect(deriveIdempotencyKey(withAnswer)).not.toBe(deriveIdempotencyKey(proposal));
  });
});
