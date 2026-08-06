// The adapter half of Preview -> Confirm -> Apply (T07).
//
// The repository suite proves the transaction is atomic. This one proves the things
// only the ADAPTER can be wrong about:
//
//   • a proposal is prepared against the PERSISTED document, not the projection;
//   • the projection changes only AFTER the durable commit returns;
//   • a commit whose publication fails is reported as saved-and-reload-required,
//     never as a failed Apply;
//   • confirmations and cancellation go through the same fenced path;
//   • a retry reconciles to one commit even though the caller asked twice.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposalScenario } from "@/lib/proposal/test-support";
import { useScenarioStore } from "./spine";
import { useAuthorityStore } from "./authority";
import { assistantProposalCommands, scenarioCommands } from "./commands";
import { loadScenario } from "./lifecycle";
import { clearTestAuthority, installTestAuthority, type TestAuthority } from "./test-authority";

const STAMP = { appBuildVersion: "test-build", manifestSha256: "test-manifest" };

const SHRINK = [
  {
    type: "set_roster_range" as const,
    start: "2026-04-01",
    end: "2026-04-15",
    importPublicHolidays: false,
  },
];

let harness: TestAuthority;

beforeEach(async () => {
  harness = await installTestAuthority();
  await loadScenario(proposalScenario());
});

afterEach(() => {
  clearTestAuthority();
});

async function prepare(commands = SHRINK) {
  return assistantProposalCommands.prepare({
    proposalId: crypto.randomUUID(),
    threadId: "thread-1",
    turnId: "turn-1",
    registryStamp: STAMP,
    commands,
    rationale: "Because you asked.",
    evidence: [],
    outcome: "untested",
  });
}

describe("prepare", () => {
  it("binds to the persisted basis and changes nothing", async () => {
    const before = useAuthorityStore.getState().documentRevision;
    const outcome = await prepare();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const envelope = await harness.db.scenarioEnvelopes.get(outcome.proposal.scenarioId);
    expect(outcome.proposal.baseDocumentRevision).toBe(envelope!.documentRevision);
    expect(outcome.proposal.baseCommitId).toBe(envelope!.topCommitId);
    // Preparing is not mutating.
    expect(useAuthorityStore.getState().documentRevision).toBe(before);
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
  });

  it("returns the host's own refusal for an operation the document cannot take", async () => {
    const outcome = await prepare([
      { type: "set_staffing_requirement_people", ruleId: "req-multi", requiredNumPeople: 4 },
    ] as typeof SHRINK extends never ? never : never as unknown as typeof SHRINK);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "rejected") {
      expect(outcome.rejection.code).toBe("unsupported_shape");
      expect(outcome.rejection.message).toContain("more than one shift type");
    } else {
      throw new Error("expected a product rejection, not a failure");
    }
  });

  it("refuses to prepare from a tab that does not own the scenario", async () => {
    const scenarioId = useAuthorityStore.getState().scenarioId!;
    // A peer takes over; this tab's next persisted operation must fail closed.
    const peer = await installTestAuthority({
      databaseName: harness.databaseName,
      tabId: "peer",
      install: false,
    });
    await peer.authority.repository.acquireOrTakeover({
      scenarioId,
      tabId: "peer",
      mode: "takeover",
    });

    const outcome = await prepare();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason !== "rejected") {
      expect(["not-owner", "stale"]).toContain(outcome.reason);
    }
  });
});

describe("apply", () => {
  it("publishes the committed document only after the transaction returns", async () => {
    const prepared = await prepare();
    if (!prepared.ok) throw new Error("prepare failed");

    const result = await assistantProposalCommands.apply({
      proposalId: prepared.proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reloadRequired).toBe(false);
    // The projection now holds exactly what was committed.
    const envelope = await harness.db.scenarioEnvelopes.get(prepared.proposal.scenarioId);
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-15");
    expect(useAuthorityStore.getState().documentRevision).toBe(envelope!.documentRevision);
    expect(useAuthorityStore.getState().canUndo).toBe(true);

    const receipts = await assistantProposalCommands.describeReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].undo).toBe("available");
  });

  it("reports a publication failure as SAVED and reload-required, not as a failure", async () => {
    const prepared = await prepare();
    if (!prepared.ok) throw new Error("prepare failed");

    // Break the projection write. The durable transaction is untouched, so the
    // change genuinely lands -- and telling the user it failed would invite them to
    // apply it a second time.
    const store = harness.scenario;
    const original = store.setState;
    store.setState = (() => {
      throw new Error("injected projection failure");
    }) as typeof store.setState;

    const result = await assistantProposalCommands.apply({
      proposalId: prepared.proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });
    store.setState = original;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reloadRequired).toBe(true);
    expect(useAuthorityStore.getState().reloadRequired).toBe(true);

    // The commit is durable regardless of what the view managed to show.
    const envelope = await harness.db.scenarioEnvelopes.get(prepared.proposal.scenarioId);
    expect(envelope!.scenario.rangeEnd).toBe("2026-04-15");
    expect(await harness.db.assistantReceipts.count()).toBe(1);
  });

  it("reconciles a retry to ONE commit and ONE receipt", async () => {
    const prepared = await prepare();
    if (!prepared.ok) throw new Error("prepare failed");
    const proposalId = prepared.proposal.proposalId;

    const first = await assistantProposalCommands.apply({
      proposalId,
      receiptId: crypto.randomUUID(),
    });
    const second = await assistantProposalCommands.apply({
      proposalId,
      receiptId: crypto.randomUUID(),
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.commitId).toBe(first.commitId);
    expect(await harness.db.assistantReceipts.count()).toBe(1);
    expect(
      (await harness.db.scenarioCommits.toArray()).filter((c) => c.kind === "assistant_apply"),
    ).toHaveLength(1);
  });

  it("refuses after a manual edit moved the document, leaving it unchanged", async () => {
    const prepared = await prepare();
    if (!prepared.ok) throw new Error("prepare failed");

    await scenarioCommands.mutate({ meta: { apiVersion: "alpha", description: "edited" } });
    const revisionAfterEdit = useAuthorityStore.getState().documentRevision;

    const result = await assistantProposalCommands.apply({
      proposalId: prepared.proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale");
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
    expect(useAuthorityStore.getState().documentRevision).toBe(revisionAfterEdit);
    expect(await harness.db.assistantReceipts.count()).toBe(0);
  });
});

describe("confirmations and cancellation", () => {
  const MOVE = [{ type: "move_leave" as const, personId: "ana", fromDate: "02", toDate: "10" }];

  it("records an answer against the proposal's own revision, and can withdraw it", async () => {
    const prepared = await prepare(MOVE as unknown as typeof SHRINK);
    if (!prepared.ok) throw new Error("prepare failed");
    const { proposalId, assumptions } = prepared.proposal;
    expect(assumptions).toHaveLength(1);

    const confirmed = await assistantProposalCommands.confirm({
      proposalId,
      assumptionId: assumptions[0].assumptionId,
    });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.proposal.confirmations).toHaveLength(1);
      expect(confirmed.proposal.confirmations[0].proposalRevision).toBe(prepared.proposal.revision);
    }

    const withdrawn = await assistantProposalCommands.withdrawConfirmation({
      proposalId,
      assumptionId: assumptions[0].assumptionId,
    });
    expect(withdrawn.ok).toBe(true);
    if (withdrawn.ok) expect(withdrawn.proposal.confirmations).toEqual([]);

    // And the Apply now fails closed at the durable boundary too, not merely in UI.
    const result = await assistantProposalCommands.apply({
      proposalId,
      receiptId: crypto.randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("confirmation-missing");
  });

  it("ignores an answer to a question the proposal does not ask", async () => {
    const prepared = await prepare();
    if (!prepared.ok) throw new Error("prepare failed");
    const outcome = await assistantProposalCommands.confirm({
      proposalId: prepared.proposal.proposalId,
      assumptionId: "leave_moved:invented",
    });
    expect(outcome.ok).toBe(false);
  });

  it("revising keeps the identity, moves the revision, and voids the old answers", async () => {
    const first = await prepare(MOVE as unknown as typeof SHRINK);
    if (!first.ok) throw new Error("prepare failed");
    await assistantProposalCommands.confirm({
      proposalId: first.proposal.proposalId,
      assumptionId: first.proposal.assumptions[0].assumptionId,
    });

    // The user says "the 12th, not the 10th". The assistant re-prepares the SAME
    // change; the agreement about the 10th must not authorise the 12th.
    const revised = await assistantProposalCommands.prepare({
      proposalId: crypto.randomUUID(),
      previousProposalId: first.proposal.proposalId,
      threadId: "thread-1",
      turnId: "turn-2",
      registryStamp: STAMP,
      commands: [{ type: "move_leave", personId: "ana", fromDate: "02", toDate: "12" }],
      rationale: null,
      evidence: [],
      outcome: "untested",
    });

    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.proposal.proposalId).toBe(first.proposal.proposalId);
    expect(revised.proposal.revision).toBe(first.proposal.revision + 1);
    expect(revised.proposal.confirmations).toEqual([]);

    const result = await assistantProposalCommands.apply({
      proposalId: revised.proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("confirmation-missing");
  });

  it("never revises a settled proposal — an applied change is a record, not a draft", async () => {
    const applied = await prepare();
    if (!applied.ok) throw new Error("prepare failed");
    const result = await assistantProposalCommands.apply({
      proposalId: applied.proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });
    expect(result.ok).toBe(true);

    const next = await assistantProposalCommands.prepare({
      proposalId: "fresh-identity",
      previousProposalId: applied.proposal.proposalId,
      threadId: "thread-1",
      turnId: "turn-2",
      registryStamp: STAMP,
      commands: [
        { type: "set_staffing_requirement_people", ruleId: "req-day", requiredNumPeople: 4 },
      ],
      rationale: null,
      evidence: [],
      outcome: "untested",
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    // A new identity, so the applied row and its receipt still describe each other.
    expect(next.proposal.proposalId).toBe("fresh-identity");
    expect(next.proposal.revision).toBe(1);
    const stored = await assistantProposalCommands.read(applied.proposal.proposalId);
    expect(stored?.status).toBe("applied");
    expect(stored?.revision).toBe(applied.proposal.revision);
  });

  it("a cancelled proposal can never be applied", async () => {
    const prepared = await prepare();
    if (!prepared.ok) throw new Error("prepare failed");
    await assistantProposalCommands.cancel(prepared.proposal.proposalId);

    const result = await assistantProposalCommands.apply({
      proposalId: prepared.proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("proposal-conflict");
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
  });
});

describe("undo through the adapter", () => {
  it("reverses the applied change and republishes the committed document", async () => {
    const prepared = await prepare();
    if (!prepared.ok) throw new Error("prepare failed");
    const applied = await assistantProposalCommands.apply({
      proposalId: prepared.proposal.proposalId,
      receiptId: crypto.randomUUID(),
    });
    if (!applied.ok) throw new Error("apply failed");

    const outcome = await assistantProposalCommands.undoReceipt(applied.receipt.receiptId);
    expect(outcome.ok).toBe(true);
    expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
    expect(useScenarioStore.getState().reqData.some((cell) => cell.uid === "cell-off")).toBe(true);

    const [standing] = await assistantProposalCommands.describeReceipts();
    expect(standing.undo).not.toBe("available");
  });
});
