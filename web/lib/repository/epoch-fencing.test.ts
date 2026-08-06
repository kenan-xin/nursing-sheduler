// T03F1 finding 1 — the lease epoch is a fencing token, so it must never repeat.
//
// Every test here FAILS against the reviewed implementation, which derived the next
// epoch from the current lease row alone. A clean release DELETES that row, so the
// counter restarted and a callback the previous takeover had already fenced became
// valid a second time.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { isRepositoryError } from "./errors";
import { createHarness, sampleScenario } from "./test-support";

/** Mint a scenario owned by `tabId`. */
async function ownedScenario(repo: ReturnType<typeof createHarness>["repo"], tabId: string) {
  const selection = await repo.selectOrSwitchScenario({
    tabId,
    target: { kind: "load", scenario: sampleScenario() },
  });
  return { scenarioId: selection.envelope.scenarioId, owner: selection.owner! };
}

describe("lease epochs are permanently monotonic", () => {
  it("a release-then-reacquire cycle never reissues an epoch", async () => {
    const { repo } = createHarness();
    const { scenarioId, owner: first } = await ownedScenario(repo, "tab-1");

    const takenOver = await repo.acquireOrTakeover({
      scenarioId,
      tabId: "tab-2",
      mode: "takeover",
    });
    expect(takenOver.owner.epoch).toBeGreaterThan(first.epoch);

    // A CLEAN RELEASE deletes the lease row — the state that used to carry the
    // counter. The high-water mark has to survive it.
    await repo.release(takenOver.owner);
    const reacquired = await repo.acquireOrTakeover({ scenarioId, tabId: "tab-3" });

    expect(reacquired.owner.epoch).toBeGreaterThan(takenOver.owner.epoch);
  });

  it("a fenced callback from an earlier epoch cannot become valid again", async () => {
    // The exact defect: revision unchanged, the epoch-1 tab's lease long gone, and
    // after release/reacquire a NEW epoch-1 lease existed — so the fenced tab's
    // pending write matched again and committed.
    const { repo } = createHarness();
    const { scenarioId, owner: stale } = await ownedScenario(repo, "tab-1");

    const second = await repo.acquireOrTakeover({ scenarioId, tabId: "tab-2", mode: "takeover" });
    await repo.release(second.owner);
    await repo.acquireOrTakeover({ scenarioId, tabId: "tab-3" });

    const envelope = await repo.read(scenarioId);
    await expect(
      repo.commit({
        owner: stale,
        expectedScenarioId: scenarioId,
        expectedDocumentRevision: envelope.documentRevision,
        command: { type: "patch_scenario", patch: { rangeStart: "2099-01-01" } },
      }),
    ).rejects.toSatisfy((error: unknown) => isRepositoryError(error, "lease_epoch_stale"));

    expect((await repo.read(scenarioId)).scenario.rangeStart).not.toBe("2099-01-01");
  });

  it("the envelope's accepted epoch never moves backwards", async () => {
    const { repo, db } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo, "tab-1");
    const high = (await repo.acquireOrTakeover({ scenarioId, tabId: "tab-2", mode: "takeover" }))
      .owner.epoch;
    expect((await db.scenarioEnvelopes.get(scenarioId))?.acceptedLeaseEpoch).toBe(high);

    // An acquisition by the ORIGINAL tab after expiry still only ever raises it.
    await repo.release({ scenarioId, tabId: "tab-2", epoch: high });
    const next = await repo.acquireOrTakeover({ scenarioId, tabId: owner.tabId });
    expect(next.owner.epoch).toBeGreaterThan(high);
    expect((await db.scenarioEnvelopes.get(scenarioId))?.acceptedLeaseEpoch).toBeGreaterThanOrEqual(
      high,
    );
  });

  it("renewing your OWN live lease keeps the epoch, so in-flight work stays valid", async () => {
    // The counterweight: monotonicity must not mean "every acquire invalidates the
    // caller's own captured owner token".
    const { repo } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo, "tab-1");

    const renewed = await repo.acquireOrTakeover({ scenarioId, tabId: "tab-1" });

    expect(renewed.owner.epoch).toBe(owner.epoch);
    expect(renewed.tookOver).toBe(false);
  });
});

describe("history-session rollover is owner-fenced", () => {
  it("a superseded owner cannot expire the new owner's reversal material", async () => {
    // B acquires → C takes over → B's rollover arrives late. Unfenced, B replaced C's
    // session and expired the payloads C was relying on.
    const { repo } = createHarness();
    const { scenarioId, owner: b } = await ownedScenario(repo, "tab-b");
    const c = await repo.acquireOrTakeover({ scenarioId, tabId: "tab-c", mode: "takeover" });

    // C makes a reversible edit.
    await repo.commit({
      owner: c.owner,
      expectedScenarioId: scenarioId,
      expectedDocumentRevision: c.envelope.documentRevision,
      command: { type: "patch_scenario", patch: { rangeStart: "2026-06-01" } },
    });
    expect((await repo.describeHistory(scenarioId)).undoAvailable).toBe(true);

    await expect(repo.beginHistorySession(b)).rejects.toSatisfy((error: unknown) =>
      isRepositoryError(error, "lease_epoch_stale"),
    );

    // C's Undo is still available: nothing was expired.
    expect((await repo.describeHistory(scenarioId)).undoAvailable).toBe(true);
  });

  it("acquisition can roll the session inside its own fenced transaction", async () => {
    const { repo } = createHarness();
    const { scenarioId, owner } = await ownedScenario(repo, "tab-1");
    await repo.commit({
      owner,
      expectedScenarioId: scenarioId,
      expectedDocumentRevision: (await repo.read(scenarioId)).documentRevision,
      command: { type: "patch_scenario", patch: { rangeStart: "2026-06-01" } },
    });
    const before = await repo.read(scenarioId);
    expect((await repo.describeHistory(scenarioId)).undoAvailable).toBe(true);

    const taken = await repo.acquireOrTakeover({
      scenarioId,
      tabId: "tab-2",
      mode: "takeover",
      rollHistorySession: true,
    });

    // One transaction: the new owner holds the lease AND a fresh session.
    expect(taken.envelope.historySessionId).not.toBe(before.historySessionId);
    expect(taken.envelope.historyCursor).toBe(0);
    expect((await repo.describeHistory(scenarioId)).undoAvailable).toBe(false);
  });
});

describe("a non-acquiring selection writes no scenario-scoped fact", () => {
  it("read-only selection updates only the tab selection row", async () => {
    // The reviewed code appended a `switch` commit before it skipped acquisition, so
    // a NON-OWNER mutated commit history — and, because the envelope's `topCommitId`
    // and record revision were left alone, the fact was orphaned from the chain too.
    const { repo, db } = createHarness();
    const { scenarioId } = await ownedScenario(repo, "owner-tab");
    const commitsBefore = await db.scenarioCommits.count();
    const envelopeBefore = await repo.read(scenarioId);

    const selection = await repo.selectOrSwitchScenario({
      tabId: "reader-tab",
      target: { kind: "existing", scenarioId },
      acquire: false,
    });

    expect(selection.owner).toBeNull();
    expect(selection.commit).toBeNull();
    expect(await db.scenarioCommits.count()).toBe(commitsBefore);
    const envelopeAfter = await repo.read(scenarioId);
    expect(envelopeAfter.recordRevision).toBe(envelopeBefore.recordRevision);
    expect(envelopeAfter.topCommitId).toBe(envelopeBefore.topCommitId);
    // The selection row IS written — that is the one thing a reader may do.
    expect((await db.tabSelections.get("reader-tab"))?.scenarioId).toBe(scenarioId);
  });

  it("an OWNER's switch fact is linked into the chain atomically", async () => {
    const { repo, db } = createHarness();
    const { scenarioId } = await ownedScenario(repo, "tab-1");
    await repo.release({
      scenarioId,
      tabId: "tab-1",
      epoch: (await db.writerLeases.get(scenarioId))!.epoch,
    });

    const selection = await repo.selectOrSwitchScenario({
      tabId: "tab-2",
      target: { kind: "existing", scenarioId },
    });

    expect(selection.commit).not.toBeNull();
    // Linked, not orphaned: the envelope points at the fact it just wrote.
    expect(selection.envelope.topCommitId).toBe(selection.commit!.commitId);
    expect(selection.commit!.isContent).toBe(false);
  });
});
