// The assistant Apply transaction (T07).
//
// The claims under test are the ones a user's trust actually rests on:
//
//   • a successful Apply is ONE repository temporal entry and ONE receipt derived
//     from committed state;
//   • a failure at ANY table write leaves every table exactly as it was -- so
//     "nothing was applied" is a fact rather than a hope;
//   • a retry reconciles to the original commit, and a conflicting reuse of the same
//     key fails closed rather than double-applying;
//   • Undo is offered only for the exact current reversible top, and becomes
//     truthfully unavailable the moment that stops being true.
//
// The failure injection is deliberately at the DEXIE TABLE, not at a seam the
// implementation could route around: each table's writer is replaced with one that
// throws, which is as close to "the browser refused this write" as a test can get.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { deriveIdempotencyKey } from "@/lib/proposal";
import { proposalScenario } from "@/lib/proposal/test-support";
import { isRepositoryError } from "./errors";
import { buildProposalRow, createHarness } from "./test-support";
import type { AssistantProposalV1 } from "./types";

const SHRINK = [
  {
    type: "set_roster_range" as const,
    start: "2026-04-01",
    end: "2026-04-15",
    importPublicHolidays: false,
  },
];

const MOVE_LEAVE = [{ type: "move_leave" as const, personId: "ana", fromDate: "02", toDate: "10" }];

/** A scenario loaded with the shared fixture ward, owned by `tab-1`. */
async function seed(options: { historyLimit?: number } = {}) {
  const harness = createHarness(options);
  const selection = await harness.repo.selectOrSwitchScenario({
    tabId: "tab-1",
    target: { kind: "load", scenario: proposalScenario() },
  });
  return { ...harness, selection, owner: selection.owner!, envelope: selection.envelope };
}

async function seedProposal(
  harness: Awaited<ReturnType<typeof seed>>,
  commands: AssistantProposalV1["commands"],
  over: Partial<Parameters<typeof buildProposalRow>[0]> = {},
): Promise<AssistantProposalV1> {
  const envelope = await harness.repo.read(harness.envelope.scenarioId);
  const row = buildProposalRow({
    proposalId: "prop-1",
    scenarioId: envelope.scenarioId,
    document: envelope.scenario,
    baseDocumentRevision: envelope.documentRevision,
    baseCommitId: envelope.topCommitId,
    leaseEpoch: harness.owner.epoch,
    commands,
    ...over,
  });
  await harness.repo.putProposal(row);
  return row;
}

/** The confirmation a `move_leave` proposal needs before it may be applied. */
function answered(proposal: AssistantProposalV1): AssistantProposalV1 {
  return {
    ...proposal,
    confirmations: proposal.assumptions.map((assumption) => ({
      assumptionId: assumption.assumptionId,
      type: assumption.type,
      person: assumption.person,
      date: assumption.date,
      toDate: assumption.toDate,
      proposalRevision: proposal.revision,
      confirmedAt: "2026-08-06T00:00:00.000Z",
    })),
  };
}

describe("a successful Apply", () => {
  it("writes exactly one temporal entry and a receipt derived from committed state", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);

    const commitsBefore = await harness.db.scenarioCommits.count();
    const result = await harness.repo.commitAssistantProposal({
      owner: harness.owner,
      proposal,
      idempotencyKey: deriveIdempotencyKey(proposal),
      receiptId: "receipt-1",
    });

    expect(result.replayed).toBe(false);
    expect(await harness.db.scenarioCommits.count()).toBe(commitsBefore + 1);
    expect(result.commit.kind).toBe("assistant_apply");
    expect(result.history.undoAvailable).toBe(true);
    expect(result.history.undoTargetCommitId).toBe(result.commit.commitId);

    // The document really moved, and the cascade really ran.
    const envelope = await harness.repo.read(harness.envelope.scenarioId);
    expect(envelope.scenario.rangeEnd).toBe("2026-04-15");
    expect(envelope.scenario.reqData.some((cell) => cell.uid === "cell-off")).toBe(false);

    // The receipt describes what was COMMITTED, including the knock-on effect.
    const receipt = await harness.db.assistantReceipts.get("receipt-1");
    expect(receipt?.commitId).toBe(result.commit.commitId);
    expect(receipt?.documentRevision).toBe(envelope.documentRevision);
    expect(receipt?.proposalRevision).toBe(proposal.revision);
    expect(receipt?.summary.some((entry) => entry.key === 'cell:"bo"|"29"')).toBe(true);
    expect(receipt?.capabilityIds).toContain("roster-period");

    // "Applied" and "there is a receipt proving it" landed together.
    const stored = await harness.db.assistantProposals.get(proposal.proposalId);
    expect(stored?.status).toBe("applied");
    expect(stored?.appliedCommitId).toBe(result.commit.commitId);
    expect(stored?.receiptId).toBe("receipt-1");
  });
});

describe("failure atomicity", () => {
  // Every table the transaction touches, injected in turn. A partial write would
  // show up as a moved revision, an orphan commit, a receipt with no commit, or a
  // proposal that says applied with nothing behind it.
  const tables = [
    "scenarioEnvelopes",
    "scenarioCommits",
    "assistantProposals",
    "assistantReceipts",
  ] as const;

  for (const table of tables) {
    it(`leaves every table unchanged when the ${table} write fails`, async () => {
      const harness = await seed();
      const proposal = await seedProposal(harness, SHRINK);
      const before = await harness.repo.read(harness.envelope.scenarioId);
      const commitsBefore = await harness.db.scenarioCommits.toArray();

      const target = harness.db[table];
      const original = target.put.bind(target);
      target.put = (() =>
        Promise.reject(new Error(`injected ${table} failure`))) as unknown as typeof target.put;

      await expect(
        harness.repo.commitAssistantProposal({
          owner: harness.owner,
          proposal,
          idempotencyKey: deriveIdempotencyKey(proposal),
          receiptId: "receipt-1",
        }),
      ).rejects.toThrow();

      target.put = original;

      const after = await harness.repo.read(harness.envelope.scenarioId);
      expect(after.documentRevision).toBe(before.documentRevision);
      expect(after.topCommitId).toBe(before.topCommitId);
      expect(after.scenario).toEqual(before.scenario);
      expect(await harness.db.scenarioCommits.toArray()).toEqual(commitsBefore);
      expect(await harness.db.assistantReceipts.count()).toBe(0);
      expect((await harness.db.assistantProposals.get(proposal.proposalId))?.status).not.toBe(
        "applied",
      );
    });
  }
});

describe("idempotency", () => {
  it("replays the same key to the original commit and receipt", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);
    const key = deriveIdempotencyKey(proposal);

    const first = await harness.repo.commitAssistantProposal({
      owner: harness.owner,
      proposal,
      idempotencyKey: key,
      receiptId: "receipt-1",
    });

    // The retry presents the SAME stored proposal -- whose basis the first Apply has
    // already invalidated. Replay is checked before the basis for exactly this case.
    const stored = (await harness.repo.getProposal(proposal.proposalId))!;
    const replay = await harness.repo.commitAssistantProposal({
      owner: harness.owner,
      proposal: stored,
      idempotencyKey: key,
      receiptId: "receipt-2",
    });

    expect(replay.replayed).toBe(true);
    expect(replay.commit.commitId).toBe(first.commit.commitId);
    expect(replay.receipt.receiptId).toBe("receipt-1");
    // One Apply, one commit, one receipt -- however many times it was retried.
    expect(
      (await harness.db.scenarioCommits.toArray()).filter(
        (commit) => commit.kind === "assistant_apply",
      ),
    ).toHaveLength(1);
    expect(await harness.db.assistantReceipts.count()).toBe(1);
  });

  it("fails closed when a consumed key is reused for different input", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);
    const key = deriveIdempotencyKey(proposal);
    await harness.repo.commitAssistantProposal({
      owner: harness.owner,
      proposal,
      idempotencyKey: key,
      receiptId: "receipt-1",
    });

    const envelope = await harness.repo.read(harness.envelope.scenarioId);
    const other = buildProposalRow({
      proposalId: "prop-2",
      scenarioId: envelope.scenarioId,
      document: envelope.scenario,
      baseDocumentRevision: envelope.documentRevision,
      baseCommitId: envelope.topCommitId,
      leaseEpoch: harness.owner.epoch,
      commands: [
        { type: "set_staffing_requirement_people", ruleId: "req-day", requiredNumPeople: 5 },
      ],
    });
    await harness.repo.putProposal(other);

    await expect(
      harness.repo.commitAssistantProposal({
        owner: harness.owner,
        proposal: other,
        idempotencyKey: key,
        receiptId: "receipt-3",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "idempotency_conflict"));

    expect(await harness.db.assistantReceipts.count()).toBe(1);
  });
});

describe("the basis is re-checked inside the transaction", () => {
  it("refuses when the document moved after the proposal was prepared", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);

    // A manual edit lands between Preview and Apply.
    await harness.repo.commit({
      owner: harness.owner,
      expectedScenarioId: harness.envelope.scenarioId,
      expectedDocumentRevision: harness.envelope.documentRevision,
      command: {
        type: "patch_scenario",
        patch: { meta: { apiVersion: "alpha", description: "x" } },
      },
    });

    await expect(
      harness.repo.commitAssistantProposal({
        owner: harness.owner,
        proposal,
        idempotencyKey: deriveIdempotencyKey(proposal),
        receiptId: "receipt-1",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "stale_revision"));
  });

  it("refuses after a takeover, even presenting the new epoch", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);
    const seized = await harness.repo.acquireOrTakeover({
      scenarioId: harness.envelope.scenarioId,
      tabId: "tab-2",
      mode: "takeover",
    });

    await expect(
      harness.repo.commitAssistantProposal({
        owner: seized.owner,
        proposal,
        idempotencyKey: deriveIdempotencyKey(proposal),
        receiptId: "receipt-1",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "lease_epoch_stale"));
  });

  it("refuses a proposal that is not the one currently prepared", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);
    // A caller holding a stale copy: same id, older revision.
    const stale: AssistantProposalV1 = { ...proposal, revision: proposal.revision - 1 };

    await expect(
      harness.repo.commitAssistantProposal({
        owner: harness.owner,
        proposal: stale,
        idempotencyKey: "some-other-key",
        receiptId: "receipt-1",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "proposal_conflict"));
  });

  it("refuses a second Apply of an already-applied proposal under a new key", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);
    await harness.repo.commitAssistantProposal({
      owner: harness.owner,
      proposal,
      idempotencyKey: deriveIdempotencyKey(proposal),
      receiptId: "receipt-1",
    });
    const stored = (await harness.repo.getProposal(proposal.proposalId))!;

    await expect(
      harness.repo.commitAssistantProposal({
        owner: harness.owner,
        proposal: stored,
        idempotencyKey: "a-different-key",
        receiptId: "receipt-9",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "proposal_conflict"));
  });

  it("refuses when an operational assumption has no confirmation", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, MOVE_LEAVE);
    expect(proposal.assumptions).toHaveLength(1);

    await expect(
      harness.repo.commitAssistantProposal({
        owner: harness.owner,
        proposal,
        idempotencyKey: deriveIdempotencyKey(proposal),
        receiptId: "receipt-1",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "confirmation_missing"));

    // With the answer recorded, the same Apply lands.
    const confirmed = answered(proposal);
    await harness.repo.putProposal(confirmed);
    const result = await harness.repo.commitAssistantProposal({
      owner: harness.owner,
      proposal: confirmed,
      idempotencyKey: deriveIdempotencyKey(confirmed),
      receiptId: "receipt-1",
    });
    expect(result.commit.kind).toBe("assistant_apply");
  });

  it("refuses when the stored commands no longer validate against the document", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, MOVE_LEAVE);
    const confirmed = answered(proposal);
    await harness.repo.putProposal(confirmed);

    // The leave the proposal moves is deleted directly in the envelope, WITHOUT
    // moving the document revision -- a state the fences alone would not catch.
    const envelope = await harness.repo.read(harness.envelope.scenarioId);
    await harness.db.scenarioEnvelopes.put({
      ...envelope,
      scenario: {
        ...envelope.scenario,
        reqData: envelope.scenario.reqData.filter((cell) => cell.uid !== "cell-leave"),
      },
    });

    await expect(
      harness.repo.commitAssistantProposal({
        owner: harness.owner,
        proposal: confirmed,
        idempotencyKey: deriveIdempotencyKey(confirmed),
        receiptId: "receipt-1",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "proposal_rejected"));
  });

  it("refuses a write fenced by an assistant clear", async () => {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);
    const captured = await harness.repo.captureGenerations(harness.envelope.scenarioId);
    await harness.repo.clearAssistantContent({ scenarioId: harness.envelope.scenarioId });
    // The clear deleted the row too; put it back so the ONLY thing refusing the
    // Apply is the fence.
    await harness.repo.putProposal(proposal);

    await expect(
      harness.repo.commitAssistantProposal({
        owner: harness.owner,
        proposal,
        idempotencyKey: deriveIdempotencyKey(proposal),
        receiptId: "receipt-1",
        guardGenerations: captured,
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "generation_fenced"));

    expect(await harness.db.assistantReceipts.count()).toBe(0);
  });
});

describe("receipt Undo", () => {
  async function applied() {
    const harness = await seed();
    const proposal = await seedProposal(harness, SHRINK);
    const result = await harness.repo.commitAssistantProposal({
      owner: harness.owner,
      proposal,
      idempotencyKey: deriveIdempotencyKey(proposal),
      receiptId: "receipt-1",
    });
    return { harness, proposal, result };
  }

  it("is available for the exact current reversible top, and reverses it atomically", async () => {
    const { harness } = await applied();
    const [standing] = await harness.repo.describeReceipts(harness.envelope.scenarioId);
    expect(standing.undo).toBe("available");
    expect(standing.reason).toBeNull();

    const undone = await harness.repo.undoAssistantReceipt({
      owner: harness.owner,
      receiptId: "receipt-1",
    });
    // The document is back, and the reversal is a NEW commit -- history is
    // append-only, so nothing was rewound.
    expect(undone.envelope.scenario.rangeEnd).toBe("2026-04-30");
    expect(undone.envelope.scenario.reqData.some((cell) => cell.uid === "cell-off")).toBe(true);
    expect(undone.commit?.kind).toBe("undo");
    expect(undone.envelope.documentRevision).toBeGreaterThan(
      (await harness.db.assistantReceipts.get("receipt-1"))!.documentRevision,
    );

    const links = await harness.db.historyLinks.toArray();
    expect(links.at(-1)).toMatchObject({ kind: "undo", linkCommitId: undone.commit!.commitId });
  });

  it("becomes superseded once a later change lands on top of it", async () => {
    const { harness, result } = await applied();
    await harness.repo.commit({
      owner: harness.owner,
      expectedScenarioId: harness.envelope.scenarioId,
      expectedDocumentRevision: result.envelope.documentRevision,
      command: {
        type: "patch_scenario",
        patch: { meta: { apiVersion: "alpha", description: "later" } },
      },
    });

    const [standing] = await harness.repo.describeReceipts(harness.envelope.scenarioId);
    expect(standing.undo).toBe("superseded");
    await expect(
      harness.repo.undoAssistantReceipt({ owner: harness.owner, receiptId: "receipt-1" }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "receipt_not_undoable"));
  });

  it("becomes unavailable after a reload starts a new history session", async () => {
    const { harness } = await applied();
    // A reload rolls the session: the commit fact and the receipt survive, the
    // reversal payload does not.
    await harness.repo.beginHistorySession(harness.owner);

    const [standing] = await harness.repo.describeReceipts(harness.envelope.scenarioId);
    expect(standing.undo).toBe("unavailable");
    expect(standing.reason).toContain("no longer available");
    // The receipt itself is KEPT -- "you cannot undo this" is not "this never
    // happened".
    expect(standing.receipt.receiptId).toBe("receipt-1");

    await expect(
      harness.repo.undoAssistantReceipt({ owner: harness.owner, receiptId: "receipt-1" }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "receipt_not_undoable"));
  });

  it("becomes unavailable once the bounded session evicts its payload", async () => {
    const harness = await seed({ historyLimit: 1 });
    const proposal = await seedProposal(harness, SHRINK);
    await harness.repo.commitAssistantProposal({
      owner: harness.owner,
      proposal,
      idempotencyKey: deriveIdempotencyKey(proposal),
      receiptId: "receipt-1",
    });
    const current = await harness.repo.read(harness.envelope.scenarioId);
    await harness.repo.commit({
      owner: harness.owner,
      expectedScenarioId: current.scenarioId,
      expectedDocumentRevision: current.documentRevision,
      command: {
        type: "patch_scenario",
        patch: { meta: { apiVersion: "alpha", description: "z" } },
      },
    });

    const [standing] = await harness.repo.describeReceipts(harness.envelope.scenarioId);
    expect(standing.undo).not.toBe("available");
  });

  it("refuses an Undo from a tab that does not own the scenario", async () => {
    const { harness } = await applied();
    const seized = await harness.repo.acquireOrTakeover({
      scenarioId: harness.envelope.scenarioId,
      tabId: "tab-2",
      mode: "takeover",
    });
    await expect(
      harness.repo.undoAssistantReceipt({ owner: harness.owner, receiptId: "receipt-1" }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "lease_epoch_stale"));
    // The new owner can, because the commit is still the reversible top.
    const undone = await harness.repo.undoAssistantReceipt({
      owner: seized.owner,
      receiptId: "receipt-1",
    });
    expect(undone.commit?.kind).toBe("undo");
  });
});
