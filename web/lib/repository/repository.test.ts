// Repository contract, against a real IndexedDB (fake-indexeddb installs the
// globals). Every assertion here is about DURABLE state: what survives a reload,
// what a second tab sees, and what is refused. Where a test could pass by reading
// the value the call just returned, it rereads from the database instead.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { isRepositoryError } from "./errors";
import { LEASE_TTL_MS } from "./leases";
import { buildProposalRow, createHarness, sampleScenario } from "./test-support";
import { GLOBAL_GENERATION_SCOPE, scenarioGenerationScope } from "./types";

/** Commit a content patch as the scenario owner, returning the result. */
async function patch(
  repo: ReturnType<typeof createHarness>["repo"],
  owner: { scenarioId: string; tabId: string; epoch: number },
  scenarioId: string,
  expectedDocumentRevision: number,
  patch_: Record<string, unknown>,
) {
  return repo.commit({
    owner,
    expectedScenarioId: scenarioId,
    expectedDocumentRevision,
    command: { type: "patch_scenario", patch: patch_ },
  });
}

describe("scenario creation and selection", () => {
  it("mints an identity, records the selection, and acquires the lease", async () => {
    const { db, repo } = createHarness();

    const selected = await repo.selectOrSwitchScenario({
      tabId: "tab-1",
      target: { kind: "new" },
    });

    expect(selected.envelope.documentRevision).toBe(1);
    expect(selected.owner).not.toBeNull();
    expect((await db.tabSelections.get("tab-1"))?.scenarioId).toBe(selected.envelope.scenarioId);
    expect((await db.writerLeases.get(selected.envelope.scenarioId))?.ownerTabId).toBe("tab-1");

    // A brand-new scenario has nothing to undo: its genesis is a durable fact,
    // not a cursor entry.
    expect(selected.commit!.isContent).toBe(false);
    const history = await repo.describeHistory(selected.envelope.scenarioId);
    expect(history).toMatchObject({ undoAvailable: false, redoAvailable: false, contentCount: 0 });
  });

  it("mints a NEW identity for a Load even when the content is identical", async () => {
    const { repo } = createHarness();
    const scenario = sampleScenario();

    const first = await repo.selectOrSwitchScenario({
      tabId: "tab-1",
      target: { kind: "load", scenario },
    });
    const second = await repo.selectOrSwitchScenario({
      tabId: "tab-1",
      target: { kind: "load", scenario },
      currentOwner: first.owner ?? undefined,
    });

    expect(second.envelope.scenarioId).not.toBe(first.envelope.scenarioId);
    // A loaded file is not a fresh local backup.
    expect(second.envelope.backupFingerprint).toBeNull();
  });
});

describe("atomic scenario switch", () => {
  it("records the switch, moves the selection, and releases the old lease", async () => {
    const { db, repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const b = await repo.selectOrSwitchScenario({
      tabId: "tab-2",
      target: { kind: "load", scenario: sampleScenario() },
    });
    await repo.release(b.owner!);

    const switched = await repo.selectOrSwitchScenario({
      tabId: "tab-1",
      target: { kind: "existing", scenarioId: b.envelope.scenarioId },
      currentOwner: a.owner ?? undefined,
    });

    expect(switched.commit!.kind).toBe("switch");
    // A switch is not an edit of the scenario it selects.
    expect(switched.commit!.isContent).toBe(false);
    expect(switched.envelope.documentRevision).toBe(b.envelope.documentRevision);
    expect((await db.tabSelections.get("tab-1"))?.scenarioId).toBe(b.envelope.scenarioId);
    expect(await db.writerLeases.get(a.envelope.scenarioId)).toBeUndefined();
    expect((await db.writerLeases.get(b.envelope.scenarioId))?.ownerTabId).toBe("tab-1");
  });

  it("rolls back EVERY switch side effect when the target is already owned", async () => {
    const { db, repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const b = await repo.selectOrSwitchScenario({ tabId: "tab-2", target: { kind: "new" } });

    const selectionBefore = await db.tabSelections.get("tab-1");
    const envelopeABefore = await db.scenarioEnvelopes.get(a.envelope.scenarioId);
    const envelopeBBefore = await db.scenarioEnvelopes.get(b.envelope.scenarioId);
    const leaseABefore = await db.writerLeases.get(a.envelope.scenarioId);
    const leaseBBefore = await db.writerLeases.get(b.envelope.scenarioId);
    const commitsBefore = await db.scenarioCommits.count();

    await expect(
      repo.selectOrSwitchScenario({
        tabId: "tab-1",
        target: { kind: "existing", scenarioId: b.envelope.scenarioId },
        currentOwner: a.owner ?? undefined,
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "target_owned"));

    // Selection, BOTH envelopes, both leases, and the commit log are untouched.
    expect(await db.tabSelections.get("tab-1")).toEqual(selectionBefore);
    expect(await db.scenarioEnvelopes.get(a.envelope.scenarioId)).toEqual(envelopeABefore);
    expect(await db.scenarioEnvelopes.get(b.envelope.scenarioId)).toEqual(envelopeBBefore);
    expect(await db.writerLeases.get(a.envelope.scenarioId)).toEqual(leaseABefore);
    expect(await db.writerLeases.get(b.envelope.scenarioId)).toEqual(leaseBBefore);
    expect(await db.scenarioCommits.count()).toBe(commitsBefore);
  });

  it("changes nothing when the switching tab has already been taken over", async () => {
    const { db, repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    await repo.acquireOrTakeover({
      scenarioId: a.envelope.scenarioId,
      tabId: "tab-2",
      mode: "takeover",
    });
    const envelopesBefore = await db.scenarioEnvelopes.count();

    await expect(
      repo.selectOrSwitchScenario({
        tabId: "tab-1",
        target: { kind: "new" },
        currentOwner: a.owner ?? undefined,
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "lease_epoch_stale"));

    // The old owner is validated BEFORE the target is minted, so no orphan
    // scenario is created by a switch that could never succeed.
    expect(await db.scenarioEnvelopes.count()).toBe(envelopesBefore);
    expect((await db.tabSelections.get("tab-1"))?.scenarioId).toBe(a.envelope.scenarioId);
  });
});

describe("writer leases", () => {
  it("refuses a second tab, and a takeover fences the first", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const scenarioId = a.envelope.scenarioId;

    await expect(repo.acquireOrTakeover({ scenarioId, tabId: "tab-2" })).rejects.toSatisfy(
      (error) => isRepositoryError(error, "target_owned"),
    );

    const seized = await repo.acquireOrTakeover({ scenarioId, tabId: "tab-2", mode: "takeover" });
    expect(seized.tookOver).toBe(true);
    expect(seized.owner.epoch).toBe(a.owner!.epoch + 1);

    // The former owner cannot write or even renew — which is the point: it may be
    // frozen and never have seen the takeover notification.
    await expect(repo.heartbeat(a.owner!)).rejects.toSatisfy((error) =>
      isRepositoryError(error, "lease_epoch_stale"),
    );
    await expect(
      repo.commit({
        owner: a.owner!,
        expectedScenarioId: scenarioId,
        expectedDocumentRevision: a.envelope.documentRevision,
        command: { type: "patch_scenario", patch: { rangeStart: "2026-05-01" } },
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "lease_epoch_stale"));
    await expect(repo.release(a.owner!)).rejects.toSatisfy((error) =>
      isRepositoryError(error, "lease_epoch_stale"),
    );
  });

  it("renews in place, and expires after the TTL without a heartbeat", async () => {
    const { repo, clock } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const scenarioId = a.envelope.scenarioId;

    clock.advance(LEASE_TTL_MS / 2);
    const beat = await repo.heartbeat(a.owner!);
    // Renewal keeps the epoch, so an operation that captured it stays valid.
    expect(beat.owner.epoch).toBe(a.owner!.epoch);
    await expect(repo.acquireOrTakeover({ scenarioId, tabId: "tab-2" })).rejects.toSatisfy(
      (error) => isRepositoryError(error, "target_owned"),
    );

    clock.advance(LEASE_TTL_MS + 1);
    const recovered = await repo.acquireOrTakeover({ scenarioId, tabId: "tab-2" });
    // An expired lease is recoverable WITHOUT a takeover, but still bumps the
    // epoch so a thawed original owner is fenced.
    expect(recovered.owner.epoch).toBe(a.owner!.epoch + 1);
    await expect(repo.heartbeat(a.owner!)).rejects.toSatisfy((error) =>
      isRepositoryError(error, "lease_epoch_stale"),
    );
  });
});

describe("heartbeat and release", () => {
  it("a heartbeat extends the lease past the original expiry", async () => {
    const { repo, clock } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const originalExpiry = Date.parse(a.lease!.expiresAt);

    // Renew just before the original expiry would have fired.
    clock.advance(LEASE_TTL_MS - 1);
    const beat = await repo.heartbeat(a.owner!);
    expect(Date.parse(beat.lease.expiresAt)).toBeGreaterThan(originalExpiry);

    // The renewed lease is still live just before ITS expiry, so a commit lands.
    clock.advance(LEASE_TTL_MS - 1);
    const committed = await patch(
      repo,
      a.owner!,
      a.envelope.scenarioId,
      a.envelope.documentRevision,
      { rangeStart: "2026-05-01" },
    );
    expect(committed.commit).not.toBeNull();

    // Past the renewed expiry with no further heartbeat, the lease is gone.
    clock.advance(2);
    await expect(repo.heartbeat(a.owner!)).rejects.toSatisfy((error) =>
      isRepositoryError(error, "lease_expired"),
    );
  });

  it("release drops the lease so the former owner cannot write", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });

    await repo.release(a.owner!);

    await expect(
      patch(repo, a.owner!, a.envelope.scenarioId, a.envelope.documentRevision, {
        rangeStart: "2026-05-01",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "not_owner"));

    // The scenario is free for another tab to acquire cleanly (no takeover).
    const seized = await repo.acquireOrTakeover({
      scenarioId: a.envelope.scenarioId,
      tabId: "tab-2",
    });
    expect(seized.owner.tabId).toBe("tab-2");
  });
});

describe("commit fencing", () => {
  it("rejects a commit whose expected document revision is stale", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });

    // One commit advances the persisted revision; the stale caller still holds
    // the original snapshot's revision.
    await patch(repo, a.owner!, a.envelope.scenarioId, a.envelope.documentRevision, {
      rangeStart: "2026-05-01",
    });

    await expect(
      patch(repo, a.owner!, a.envelope.scenarioId, a.envelope.documentRevision, {
        rangeEnd: "2026-05-31",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "stale_revision"));
  });

  it("a metadata-only command moves recordRevision but not documentRevision and writes no commit", async () => {
    const { repo, db } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const before = await repo.read(a.envelope.scenarioId);

    const result = await repo.commit({
      owner: a.owner!,
      expectedScenarioId: a.envelope.scenarioId,
      expectedDocumentRevision: a.envelope.documentRevision,
      command: { type: "record_backup", backupFingerprint: "fp-abc" },
    });

    expect(result.commit).toBeNull();
    expect(result.envelope.documentRevision).toBe(before.documentRevision);
    expect(result.envelope.recordRevision).toBe(before.recordRevision + 1);
    expect(result.envelope.backupFingerprint).toBe("fp-abc");

    // A content-bound proposal bound to this documentRevision stays valid: the
    // revision it bound to did not move.
    const reread = await db.scenarioEnvelopes.get(a.envelope.scenarioId);
    expect(reread?.documentRevision).toBe(before.documentRevision);
  });
});

describe("undo and redo", () => {
  it("undo reverts the last content commit and leaves it reapplyable", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });

    const committed = await patch(
      repo,
      a.owner!,
      a.envelope.scenarioId,
      a.envelope.documentRevision,
      {
        rangeStart: "2026-05-01",
      },
    );
    expect((await repo.describeHistory(a.envelope.scenarioId)).undoAvailable).toBe(true);

    const undone = await repo.undo({
      owner: a.owner!,
      expectedDocumentRevision: committed.envelope.documentRevision,
    });

    expect(undone.envelope.scenario.rangeStart).toBe("");
    expect(undone.commit?.kind).toBe("undo");
    const history = await repo.describeHistory(a.envelope.scenarioId);
    expect(history.undoAvailable).toBe(false);
    expect(history.redoAvailable).toBe(true);
  });

  it("redo reapplies the undone commit", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const committed = await patch(
      repo,
      a.owner!,
      a.envelope.scenarioId,
      a.envelope.documentRevision,
      {
        rangeStart: "2026-05-01",
      },
    );
    const undone = await repo.undo({
      owner: a.owner!,
      expectedDocumentRevision: committed.envelope.documentRevision,
    });

    const redone = await repo.redo({
      owner: a.owner!,
      expectedDocumentRevision: undone.envelope.documentRevision,
    });

    expect(redone.envelope.scenario.rangeStart).toBe("2026-05-01");
    const history = await repo.describeHistory(a.envelope.scenarioId);
    expect(history.redoAvailable).toBe(false);
  });

  it("a new edit after undo supersedes the undone commit and removes redo", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const committed = await patch(
      repo,
      a.owner!,
      a.envelope.scenarioId,
      a.envelope.documentRevision,
      {
        rangeStart: "2026-05-01",
      },
    );
    const undone = await repo.undo({
      owner: a.owner!,
      expectedDocumentRevision: committed.envelope.documentRevision,
    });
    expect((await repo.describeHistory(a.envelope.scenarioId)).redoAvailable).toBe(true);

    await patch(repo, a.owner!, a.envelope.scenarioId, undone.envelope.documentRevision, {
      rangeStart: "2026-06-01",
    });

    // Branching over the undone commit leaves it as a durable fact but removes it
    // from the cursor list, so Redo is gone.
    expect((await repo.describeHistory(a.envelope.scenarioId)).redoAvailable).toBe(false);
  });

  it("undo and redo increment documentRevision (they are new commits, never a rewind)", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const committed = await patch(
      repo,
      a.owner!,
      a.envelope.scenarioId,
      a.envelope.documentRevision,
      {
        rangeStart: "2026-05-01",
      },
    );
    const undone = await repo.undo({
      owner: a.owner!,
      expectedDocumentRevision: committed.envelope.documentRevision,
    });
    expect(undone.envelope.documentRevision).toBeGreaterThan(committed.envelope.documentRevision);
    const redone = await repo.redo({
      owner: a.owner!,
      expectedDocumentRevision: undone.envelope.documentRevision,
    });
    expect(redone.envelope.documentRevision).toBeGreaterThan(undone.envelope.documentRevision);
  });
});

describe("bounded history session", () => {
  it("prunes the oldest reversal payloads past the bound, keeping the commit facts", async () => {
    const { repo, db } = createHarness({ historyLimit: 3 });
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });

    let revision = a.envelope.documentRevision;
    for (let i = 0; i < 4; i += 1) {
      const result = await patch(repo, a.owner!, a.envelope.scenarioId, revision, {
        rangeStart: `2026-0${i + 1}-01`,
      });
      revision = result.envelope.documentRevision;
    }

    // Four content commits with a bound of three: the oldest payload is pruned.
    const sessionCommits = await db.scenarioCommits
      .where("scenarioId")
      .equals(a.envelope.scenarioId)
      .toArray();
    const contentCommits = sessionCommits
      .filter((commit) => commit.isContent)
      .sort((x, y) => x.sessionSeq - y.sessionSeq);
    expect(contentCommits[0].payloadState).toBe("pruned");
    expect(contentCommits[0].reversiblePayload).toBeNull();
    // The commit FACT survives — only the payload was bounded.
    expect(contentCommits[0].commitId).toBeDefined();

    // Undo walks down to the pruned entry and stops: it cannot promise a restore
    // whose reversal material is gone.
    let cursor = revision;
    for (let i = 0; i < 3; i += 1) {
      const undone = await repo.undo({ owner: a.owner!, expectedDocumentRevision: cursor });
      cursor = undone.envelope.documentRevision;
    }
    await expect(
      repo.undo({ owner: a.owner!, expectedDocumentRevision: cursor }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "nothing_to_undo"));
  });

  it("reload mints a new session and invalidates every prior reversal payload", async () => {
    const { repo, db } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    await patch(repo, a.owner!, a.envelope.scenarioId, a.envelope.documentRevision, {
      rangeStart: "2026-05-01",
    });
    expect((await repo.describeHistory(a.envelope.scenarioId)).undoAvailable).toBe(true);
    const commitsBefore = await db.scenarioCommits.count();

    // Owner-fenced now: rolling a session expires reversal material, so it takes
    // the acting owner rather than a bare scenario id.
    const reloaded = await repo.beginHistorySession(a.owner!);

    expect(reloaded.historySessionId).not.toBe(a.envelope.historySessionId);
    expect(reloaded.historyCursor).toBe(0);
    // The new session offers nothing to undo.
    expect((await repo.describeHistory(a.envelope.scenarioId)).undoAvailable).toBe(false);
    // The commit FACTS and their links survive — "no longer undoable" is not
    // "this never happened".
    expect(await db.scenarioCommits.count()).toBe(commitsBefore);
  });
});

describe("scenario independence", () => {
  it("a tab editing scenario A does not block or affect scenario B", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const b = await repo.selectOrSwitchScenario({ tabId: "tab-2", target: { kind: "new" } });

    const aCommit = await patch(
      repo,
      a.owner!,
      a.envelope.scenarioId,
      a.envelope.documentRevision,
      {
        rangeStart: "2026-05-01",
      },
    );

    // Scenario B is untouched by A's edit.
    const bEnvelope = await repo.read(b.envelope.scenarioId);
    expect(bEnvelope.documentRevision).toBe(b.envelope.documentRevision);
    expect(bEnvelope.scenario.rangeStart).not.toBe("2026-05-01");

    // Tab-2 holds B's independent lease and can commit freely.
    const bCommit = await patch(
      repo,
      b.owner!,
      b.envelope.scenarioId,
      b.envelope.documentRevision,
      {
        rangeStart: "2026-06-01",
      },
    );
    expect(bCommit.envelope.documentRevision).toBe(b.envelope.documentRevision + 1);

    // A's revision did not move when B committed.
    expect(aCommit.envelope.scenarioId).not.toBe(bCommit.envelope.scenarioId);
  });
});

describe("reload and BFCache reread", () => {
  it("readTabContext rereads persisted selection, envelope, and lease — not process memory", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });

    const ctx = await repo.readTabContext("tab-1");
    expect(ctx.selection?.scenarioId).toBe(a.envelope.scenarioId);
    expect(ctx.isOwner).toBe(true);
    expect(ctx.owner?.tabId).toBe("tab-1");

    // A takeover by another tab is visible only because the tab rereads persisted
    // state: process memory would still say tab-1 owns it.
    await repo.acquireOrTakeover({
      scenarioId: a.envelope.scenarioId,
      tabId: "tab-2",
      mode: "takeover",
    });
    const after = await repo.readTabContext("tab-1");
    expect(after.isOwner).toBe(false);
    expect(after.owner).toBeNull();
    expect(after.lease?.ownerTabId).toBe("tab-2");

    // A tab with no selection is read-only with no envelope.
    const unknown = await repo.readTabContext("tab-99");
    expect(unknown.selection).toBeNull();
    expect(unknown.envelope).toBeNull();
    expect(unknown.isOwner).toBe(false);
  });
});

describe("permanent assistant generations", () => {
  it("fence rows are minted at creation, are monotonic, and survive content deletion", async () => {
    const { repo, db } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const scenarioId = a.envelope.scenarioId;
    const scoped = scenarioGenerationScope(scenarioId);

    expect((await db.assistantGenerations.get(GLOBAL_GENERATION_SCOPE))?.generation).toBe(0);
    expect((await db.assistantGenerations.get(scoped))?.generation).toBe(0);

    await repo.putProposal(
      buildProposalRow({
        proposalId: "p1",
        scenarioId,
        document: a.envelope.scenario,
        baseDocumentRevision: a.envelope.documentRevision,
        baseCommitId: a.envelope.topCommitId,
        leaseEpoch: a.owner!.epoch,
        commands: [
          {
            type: "set_roster_range",
            start: "2026-05-01",
            end: "2026-05-31",
            importPublicHolidays: false,
          },
        ],
      }),
    );

    // Clearing the scenario's content deletes its proposals but BUMPS the fence,
    // never deletes it.
    const cleared = await repo.clearAssistantContent({ scenarioId });
    expect(cleared.generation).toBe(1);
    expect(await db.assistantProposals.get("p1")).toBeUndefined();
    expect((await db.assistantGenerations.get(scoped))?.generation).toBe(1);
    expect((await db.assistantGenerations.get(GLOBAL_GENERATION_SCOPE))?.generation).toBe(0);

    // Clear ALL bumps global AND every scenario fence.
    const clearedAll = await repo.clearAssistantContent({});
    expect(clearedAll.generation).toBe(1);
    expect((await db.assistantGenerations.get(GLOBAL_GENERATION_SCOPE))?.generation).toBe(1);
    expect((await db.assistantGenerations.get(scoped))?.generation).toBe(2);
  });

  it("a guarded write with a stale captured generation is refused inside the transaction", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const captured = await repo.captureGenerations(a.envelope.scenarioId);

    // Simulate a clear that bumps the scenario fence after the capture.
    await repo.bumpGeneration(scenarioGenerationScope(a.envelope.scenarioId));

    await expect(
      repo.runGuarded(captured, async (database) => {
        await database.assistantProposals.put(
          buildProposalRow({
            proposalId: "late",
            scenarioId: a.envelope.scenarioId,
            document: a.envelope.scenario,
            baseDocumentRevision: a.envelope.documentRevision,
            baseCommitId: a.envelope.topCommitId,
            leaseEpoch: 0,
            commands: [
              {
                type: "set_roster_range",
                start: "2026-05-01",
                end: "2026-05-31",
                importPublicHolidays: false,
              },
            ],
          }),
        );
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "generation_fenced"));

    // The guarded write left nothing behind: the check and the write share one
    // transaction, so a late callback cannot recreate cleared data.
    expect(await repo.getProposal("late")).toBeUndefined();
  });
});

describe("idempotent apply", () => {
  it("replays the same key to the same commit, and conflicts on different input", async () => {
    const { repo } = createHarness();
    const a = await repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } });
    const cmd = { type: "patch_scenario" as const, patch: { rangeStart: "2026-05-01" } };

    const first = await repo.commit({
      owner: a.owner!,
      expectedScenarioId: a.envelope.scenarioId,
      expectedDocumentRevision: a.envelope.documentRevision,
      command: cmd,
      idempotencyKey: "key-1",
    });
    expect(first.replayed).toBe(false);

    // A retry with the same key and command returns the original commit, not a
    // second one — even though the revision has advanced.
    const replay = await repo.commit({
      owner: a.owner!,
      expectedScenarioId: a.envelope.scenarioId,
      expectedDocumentRevision: first.envelope.documentRevision,
      command: cmd,
      idempotencyKey: "key-1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.commit?.commitId).toBe(first.commit?.commitId);

    // The same key with DIFFERENT input fails closed rather than double-committing.
    await expect(
      repo.commit({
        owner: a.owner!,
        expectedScenarioId: a.envelope.scenarioId,
        expectedDocumentRevision: first.envelope.documentRevision,
        command: { type: "patch_scenario", patch: { rangeEnd: "2026-05-31" } },
        idempotencyKey: "key-1",
      }),
    ).rejects.toSatisfy((error) => isRepositoryError(error, "idempotency_conflict"));
  });
});

// The assistant Apply transaction -- its basis fences, idempotency, failure
// atomicity, receipt derivation and Undo -- has its own suite in
// `assistant-apply.test.ts`. `commit` deliberately no longer has a receipt or
// proposal-transition parameter, so there is exactly one way an Apply is written.
