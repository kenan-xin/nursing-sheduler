// The T03 authority contract: every mutation class is exactly one durable
// repository commit, a failed transaction never changes the committed projection,
// Undo/Redo are monotonic commits, and the per-scenario writer lease fences a
// stale tab.
//
// SCOPE NOTE. These run against `fake-indexeddb`, which is a faithful IndexedDB
// implementation but a SINGLE JavaScript context: a "second tab" here is a second
// controller over the same database, not a second real browser context. That is
// enough to prove the fencing LOGIC (epochs, expiry, compare-and-swap), and
// deliberately not claimed as proof of real cross-context concurrency —
// `e2e/scenario-ownership.spec.ts` covers that with two real browser contexts.

import { beforeEach, describe, expect, it } from "vitest";
import { isRepositoryError, LEASE_TTL_MS } from "@/lib/repository";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { useAuthorityStore } from "./authority";
import { drainScenarioCommands, scenarioCommands } from "./commands";
import { loadScenario, newScenario } from "./lifecycle";
import { commitPaintGesture } from "./paint";
import { stateSpine } from "./spine";
import { freshAuthorityDbName, installTestAuthority, type TestAuthority } from "./test-authority";

const { scenario, hot } = stateSpine;

let harness: TestAuthority;

beforeEach(async () => {
  harness = await installTestAuthority();
});

/** Durable commits for the currently selected scenario, oldest first. */
async function commits() {
  const scenarioId = useAuthorityStore.getState().scenarioId!;
  return (await harness.db.scenarioCommits.where("scenarioId").equals(scenarioId).toArray()).sort(
    (a, b) => a.documentRevision - b.documentRevision,
  );
}

async function contentCommitCount(): Promise<number> {
  return (await commits()).filter((commit) => commit.isContent).length;
}

async function envelope() {
  return harness.db.scenarioEnvelopes.get(useAuthorityStore.getState().scenarioId!);
}

describe("one mutation class, one durable commit", () => {
  it("an editor patch commits exactly once and advances documentRevision by one", async () => {
    const before = useAuthorityStore.getState().documentRevision;

    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    expect(await contentCommitCount()).toBe(1);
    expect(useAuthorityStore.getState().documentRevision).toBe(before + 1);
    expect(scenario.getState().rangeStart).toBe("2026-04-01");
    expect((await envelope())?.scenario.rangeStart).toBe("2026-04-01");
  });

  it("a card operation composed as one patch is still one commit", async () => {
    await scenarioCommands.mutate((state) => ({
      staff: [...state.staff, { id: "alice" }],
      staffGroups: [{ id: "Team", members: ["alice"] }],
    }));

    expect(await contentCommitCount()).toBe(1);
  });

  it("a paint gesture over many cells is one commit", async () => {
    hot.getState().beginPaint();
    for (const date of ["d1", "d2", "d3"]) {
      hot.getState().stagePaintDayState("p1", date, { kind: "leave" });
    }
    await commitPaintGesture(hot);

    expect(await contentCommitCount()).toBe(1);
  });

  it("recording a backup is METADATA only: recordRevision moves, documentRevision does not", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    const afterEdit = (await envelope())!;

    await scenarioCommands.recordBackup("fingerprint-of-the-emitted-bytes");
    const afterBackup = (await envelope())!;

    expect(afterBackup.documentRevision).toBe(afterEdit.documentRevision);
    expect(afterBackup.recordRevision).toBeGreaterThan(afterEdit.recordRevision);
    expect(afterBackup.backupFingerprint).not.toBeNull();
    // A metadata write is not an Undo step.
    expect(await contentCommitCount()).toBe(1);
  });

  it("New mints a fresh scenario identity rather than editing the current one", async () => {
    const original = useAuthorityStore.getState().scenarioId;
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    await newScenario();

    const next = useAuthorityStore.getState().scenarioId;
    expect(next).not.toBe(original);
    expect(scenario.getState().rangeStart).toBe("");
    // The prior identity's content survives under its own envelope.
    expect((await harness.db.scenarioEnvelopes.get(original!))?.scenario.rangeStart).toBe(
      "2026-04-01",
    );
  });

  it("Load mints a fresh identity and leaves the backup baseline unknown", async () => {
    await scenarioCommands.recordBackup("fingerprint-of-the-emitted-bytes");
    const original = useAuthorityStore.getState().scenarioId;

    await loadScenario({
      ...createEmptyScenarioUiState(),
      rangeStart: "2026-05-01",
      rangeEnd: "2026-05-31",
    });

    expect(useAuthorityStore.getState().scenarioId).not.toBe(original);
    expect(scenario.getState().rangeStart).toBe("2026-05-01");
    expect(scenario.getState().backupFingerprint).toBeNull();
  });

  it("releases the previous scenario's lease when the switch commits", async () => {
    const original = useAuthorityStore.getState().scenarioId!;
    await newScenario();

    expect(await harness.db.writerLeases.get(original)).toBeUndefined();
    expect(
      (await harness.db.writerLeases.get(useAuthorityStore.getState().scenarioId!))?.ownerTabId,
    ).toBe(harness.tabId);
  });
});

describe("a failed transaction leaves the committed projection unchanged", () => {
  it("a refused write does not publish, and the durable envelope is untouched", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    const revisionBefore = useAuthorityStore.getState().documentRevision;

    // Simulate the tab having been taken over: bump the persisted epoch out from
    // under it, exactly as a peer's takeover would.
    const scenarioId = useAuthorityStore.getState().scenarioId!;
    const lease = (await harness.db.writerLeases.get(scenarioId))!;
    await harness.db.writerLeases.put({
      ...lease,
      ownerTabId: "other-tab",
      epoch: lease.epoch + 1,
    });

    const outcome = await scenarioCommands.mutate({ rangeStart: "2026-09-09" });

    expect(outcome.ok).toBe(false);
    expect(scenario.getState().rangeStart).toBe("2026-04-01");
    expect((await envelope())?.scenario.rangeStart).toBe("2026-04-01");
    expect(useAuthorityStore.getState().documentRevision).toBe(revisionBefore);
    expect(await contentCommitCount()).toBe(1);
  });

  it("an IndexedDB failure surfaces as an error and commits nothing", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    harness.db.close();

    const outcome = await scenarioCommands.mutate({ rangeStart: "2026-12-12" });

    expect(outcome.ok).toBe(false);
    expect(scenario.getState().rangeStart).toBe("2026-04-01");
    expect(useAuthorityStore.getState().writeStatus).toBe("error");
  });
});

describe("Undo and Redo are monotonic repository commits", () => {
  it("Undo restores prior content with a NEW, higher document revision", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    const afterEdit = useAuthorityStore.getState().documentRevision;

    const outcome = await scenarioCommands.undo();

    expect(outcome.ok).toBe(true);
    expect(scenario.getState().rangeStart).toBe("");
    expect(useAuthorityStore.getState().documentRevision).toBeGreaterThan(afterEdit);
  });

  it("Redo reapplies with a further, higher revision — the counter never rewinds", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    await scenarioCommands.undo();
    const afterUndo = useAuthorityStore.getState().documentRevision;

    await scenarioCommands.redo();

    expect(scenario.getState().rangeStart).toBe("2026-04-01");
    expect(useAuthorityStore.getState().documentRevision).toBeGreaterThan(afterUndo);

    const revisions = (await commits()).map((commit) => commit.documentRevision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
  });

  it("a new edit while undone supersedes the redo path", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    await scenarioCommands.undo();
    expect(useAuthorityStore.getState().canRedo).toBe(true);

    await scenarioCommands.mutate({ rangeEnd: "2026-06-30" });

    expect(useAuthorityStore.getState().canRedo).toBe(false);
  });

  it("availability is truthful at the ends", async () => {
    expect(useAuthorityStore.getState().canUndo).toBe(false);
    expect(useAuthorityStore.getState().canRedo).toBe(false);

    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    expect(useAuthorityStore.getState().canUndo).toBe(true);

    await scenarioCommands.undo();
    expect(useAuthorityStore.getState().canUndo).toBe(false);
    expect(useAuthorityStore.getState().canRedo).toBe(true);
  });

  it("a reload starts a new history session, so prior reversals are unavailable", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    expect(useAuthorityStore.getState().canUndo).toBe(true);

    // Same tab id, same database: exactly what a reload of this tab looks like.
    const reloaded = await installTestAuthority({
      databaseName: harness.databaseName,
      tabId: harness.tabId,
    });
    harness = reloaded;

    expect(scenario.getState().rangeStart).toBe("2026-04-01"); // content survives
    expect(useAuthorityStore.getState().canUndo).toBe(false); // the reversal does not

    const refused = await scenarioCommands.undo();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("history-unavailable");
  });

  it("history eviction past the session bound disables the reversal truthfully", async () => {
    const bounded = await installTestAuthority({ databaseName: freshAuthorityDbName() });
    harness = bounded;
    // The default bound is 50 live payloads; 52 edits evicts the oldest two.
    for (let index = 0; index < 52; index++) {
      await scenarioCommands.mutate({
        rangeEnd: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
      });
    }
    const all = await commits();
    const evicted = all.filter((commit) => commit.payloadState === "pruned");
    expect(evicted.length).toBe(2);
    // The commit FACTS survive eviction — only the reversal material is bounded.
    expect(evicted.every((commit) => commit.reversiblePayload === null)).toBe(true);
  });
});

describe("per-scenario single-writer lease", () => {
  it("a second tab on the SAME scenario comes up read-only", async () => {
    // A reversible commit the peer may not perform.
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    const peer = await installTestAuthority({
      databaseName: harness.databaseName,
      install: false,
    });
    await peer.authority.initialize();

    expect(peer.authorityStore.getState().ownership).toBe("read-only");
    expect(peer.authorityStore.getState().scenarioId).toBe(useAuthorityStore.getState().scenarioId);
    // Undo availability is gated on OWNERSHIP too, not on the commit facts alone:
    // offering a reversal this tab cannot perform would be the same lie the
    // process-memory stack told, just from the other direction.
    expect(peer.authorityStore.getState().canUndo).toBe(false);
    expect(peer.authorityStore.getState().canRedo).toBe(false);
  });

  it("an explicit takeover seizes the lease and fences the former owner", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    const peer = await installTestAuthority({
      databaseName: harness.databaseName,
      install: false,
    });
    await peer.authority.initialize();
    const seized = await peer.authority.takeover();
    expect(seized.ok).toBe(true);

    // The former owner's next persisted write fails the epoch check, even though
    // it was never told anything.
    const refused = await scenarioCommands.mutate({ rangeStart: "2026-07-07" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("not-owner");
    expect(useAuthorityStore.getState().ownership).toBe("taken-over");
    expect(scenario.getState().rangeStart).toBe("2026-04-01");
  });

  it("losing the lease cancels an in-flight paint gesture rather than committing it", async () => {
    hot.getState().beginPaint();
    hot.getState().stagePaintDayState("p1", "d1", { kind: "leave" });

    const peer = await installTestAuthority({
      databaseName: harness.databaseName,
      install: false,
    });
    await peer.authority.initialize();
    await peer.authority.takeover();

    // The former owner notices on its next heartbeat, which is how a tab that
    // received no broadcast still stops writing.
    expect(await harness.authority.heartbeat()).toBe(false);
    expect(hot.getState().paint).toBeNull();
    expect(useAuthorityStore.getState().ownership).toBe("taken-over");

    const refused = await commitPaintGesture(hot);
    expect(refused.ok).toBe(true); // nothing staged any more — a no-op, not a write
    expect(scenario.getState().reqData).toEqual([]);
  });

  it("an expired lease is recoverable by explicit takeover after the TTL", async () => {
    let millis = Date.parse("2026-08-06T00:00:00.000Z");
    const expiring = await installTestAuthority({ now: () => new Date(millis) });
    harness = expiring;
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    millis += LEASE_TTL_MS + 1_000; // the tab was suspended past its lease
    expect(await expiring.authority.heartbeat()).toBe(false);
    expect(useAuthorityStore.getState().ownership).toBe("expired");

    const refused = await scenarioCommands.mutate({ rangeStart: "2026-04-02" });
    expect(refused.ok).toBe(false);

    const recovered = await expiring.authority.takeover();
    expect(recovered.ok).toBe(true);
    expect(useAuthorityStore.getState().ownership).toBe("owner");
    expect((await scenarioCommands.mutate({ rangeStart: "2026-04-03" })).ok).toBe(true);
  });

  it("a clean release frees the scenario for a peer without waiting out the TTL", async () => {
    const scenarioId = useAuthorityStore.getState().scenarioId!;
    await scenarioCommands.release();

    expect(await harness.db.writerLeases.get(scenarioId)).toBeUndefined();
    expect(useAuthorityStore.getState().ownership).toBe("read-only");

    const peer = await installTestAuthority({
      databaseName: harness.databaseName,
      install: false,
    });
    await peer.authority.initialize();
    expect(peer.authorityStore.getState().ownership).toBe("owner");
  });

  it("a tab editing scenario A does not block a tab editing scenario B", async () => {
    const shared = freshAuthorityDbName();
    const tabA = await installTestAuthority({ databaseName: shared, install: false });
    await tabA.authority.initialize();

    // Tab B selects a DIFFERENT scenario by creating one, which is what New does.
    const tabB = await installTestAuthority({ databaseName: shared, install: false });
    await tabB.authority.initialize();
    expect(tabB.authorityStore.getState().ownership).toBe("read-only");
    await tabB.authority.newScenario();

    expect(tabB.authorityStore.getState().ownership).toBe("owner");
    expect(tabB.authorityStore.getState().scenarioId).not.toBe(
      tabA.authorityStore.getState().scenarioId,
    );

    // Both write concurrently, each to its own scenario, and neither is refused.
    const [a, b] = await Promise.all([
      tabA.authority.mutate({ rangeStart: "2026-01-01" }),
      tabB.authority.mutate({ rangeStart: "2026-02-02" }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(tabA.scenario.getState().rangeStart).toBe("2026-01-01");
    expect(tabB.scenario.getState().rangeStart).toBe("2026-02-02");
  });
});

describe("authoritative reread on resumption", () => {
  it("reconcile discovers a takeover that happened while this tab was suspended", async () => {
    const peer = await installTestAuthority({
      databaseName: harness.databaseName,
      install: false,
    });
    await peer.authority.initialize();
    await peer.authority.takeover();
    await peer.authority.mutate({ rangeStart: "2026-11-11" });

    // The suspended tab still believes it is the owner until it rereads.
    expect(useAuthorityStore.getState().ownership).toBe("owner");

    await harness.authority.reconcile();

    expect(useAuthorityStore.getState().ownership).toBe("taken-over");
    expect(useAuthorityStore.getState().heldByTabId).toBe(peer.tabId);
    // And it now shows durable truth, not the state it remembered.
    expect(scenario.getState().rangeStart).toBe("2026-11-11");
  });

  it("a broadcast hint is advisory: it triggers a reread, and its content is not trusted", async () => {
    const peer = await installTestAuthority({
      databaseName: harness.databaseName,
      install: false,
    });
    await peer.authority.initialize();

    // A forged hint claiming a takeover that never happened changes nothing,
    // because the reread it triggers finds this tab still holding the lease.
    await harness.authority.onHint({
      kind: "acquired",
      scenarioId: useAuthorityStore.getState().scenarioId!,
      tabId: peer.tabId,
      epoch: 99,
    });

    expect(useAuthorityStore.getState().ownership).toBe("owner");
    expect((await scenarioCommands.mutate({ rangeStart: "2026-03-03" })).ok).toBe(true);
  });

  it("a hint about a DIFFERENT scenario is ignored entirely", async () => {
    const before = useAuthorityStore.getState().documentRevision;
    await harness.authority.onHint({
      kind: "committed",
      scenarioId: "some-other-scenario",
      tabId: "elsewhere",
      epoch: 1,
    });
    expect(useAuthorityStore.getState().documentRevision).toBe(before);
    expect(useAuthorityStore.getState().ownership).toBe("owner");
  });
});

describe("command ordering", () => {
  it("concurrent commands serialize instead of racing the compare-and-swap", async () => {
    const outcomes = await Promise.all([
      scenarioCommands.mutate((s) => ({ staff: [...s.staff, { id: "a" }] })),
      scenarioCommands.mutate((s) => ({ staff: [...s.staff, { id: "b" }] })),
      scenarioCommands.mutate((s) => ({ staff: [...s.staff, { id: "c" }] })),
    ]);

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    // Each updater ran against the state the previous command committed, so no
    // edit was lost to a stale read.
    expect(scenario.getState().staff.map((person) => person.id)).toEqual(["a", "b", "c"]);
    expect(await contentCommitCount()).toBe(3);
  });

  it("drain resolves only once every queued command has settled", async () => {
    void scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    void scenarioCommands.mutate({ rangeEnd: "2026-04-30" });
    await drainScenarioCommands();

    expect(scenario.getState().rangeStart).toBe("2026-04-01");
    expect(scenario.getState().rangeEnd).toBe("2026-04-30");
  });
});

describe("a patch that changes nothing is a no-op", () => {
  it("an unchanged patch writes no commit and moves no revision", async () => {
    // "Zero changed actions add zero history entries." The editor transforms return
    // the SAME references for a semantically empty operation (a re-upload of
    // identical people, a drop back on the same slot) precisely so this is
    // decidable, and the pre-cutover history used exactly this rule.
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    const revision = useAuthorityStore.getState().documentRevision;
    const commitsBefore = await contentCommitCount();

    const outcome = await scenarioCommands.mutate((state) => ({
      rangeStart: state.rangeStart,
      staff: state.staff,
    }));

    expect(outcome).toMatchObject({ ok: true, commitId: null });
    expect(await contentCommitCount()).toBe(commitsBefore);
    expect(useAuthorityStore.getState().documentRevision).toBe(revision);
    expect(useAuthorityStore.getState().canUndo).toBe(true); // still the earlier edit
  });

  it("an updater that returns null is a REFUSAL, distinct from a no-op", async () => {
    // The seam a card editor uses to withdraw a write whose baseline moved under it:
    // the updater is the only place that can see the state the previous command
    // committed, so that is where the refusal has to happen.
    //
    // It reports `ok: false`, not a successful no-op. Conflating the two is what let
    // a card editor close its form and toast "saved" over an action that had been
    // silently dropped — the user's second rapid duplicate simply vanished.
    const revision = useAuthorityStore.getState().documentRevision;
    const commitsBefore = await contentCommitCount();

    const outcome = await scenarioCommands.mutate(() => null);

    expect(outcome).toMatchObject({ ok: false, reason: "superseded" });
    expect(await contentCommitCount()).toBe(commitsBefore);
    expect(useAuthorityStore.getState().documentRevision).toBe(revision);
  });

  it("distinguishes a semantic no-op from a refusal in the OUTCOME", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    // Nothing changed — an honest success that wrote no commit.
    const noop = await scenarioCommands.mutate((state) => ({ rangeStart: state.rangeStart }));
    expect(noop).toMatchObject({ ok: true, committed: false, commitId: null });

    // A real change — a success that DID write one.
    const real = await scenarioCommands.mutate({ rangeStart: "2026-05-01" });
    expect(real.ok).toBe(true);
    expect(real).toMatchObject({ committed: true });
    if (real.ok) expect(real.commitId).not.toBeNull();
  });
});

describe("the write status arms at ENQUEUE, not at transaction start", () => {
  it("a queued command reports `writing` synchronously", () => {
    // The shell's unload guard arms on this. A command sitting in the queue is a
    // durable write the user already asked for, so a tab closed in that window must
    // be guarded — publishing `writing` only once the transaction began would leave
    // the edit discardable while the badge said "Saved".
    expect(useAuthorityStore.getState().writeStatus).toBe("saved");

    void scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    expect(useAuthorityStore.getState().writeStatus).toBe("writing");
  });

  it("stays `writing` until the LAST queued command settles", async () => {
    const first = scenarioCommands.mutate({ rangeStart: "2026-04-01" });
    const second = scenarioCommands.mutate({ rangeEnd: "2026-04-30" });

    await first;
    // An earlier command settling must not disarm the guard while another waits.
    expect(useAuthorityStore.getState().writeStatus).toBe("writing");

    await second;
    expect(useAuthorityStore.getState().writeStatus).toBe("saved");
  });
});

describe("the projection keeps identity where the value did not change", () => {
  it("an untouched slice survives an unrelated commit at the same reference", async () => {
    // A durable commit structured-clones the whole document, so every slice comes
    // back with a fresh identity. The app reads reference inequality as "this
    // changed elsewhere" — open-form staleness guards most of all — so the adapter
    // republishes through `shareStructure`. Without it, a rename of one shift would
    // close every open editor on the screen.
    await scenarioCommands.mutate({
      staff: [{ id: "P1" }],
      shifts: [{ id: "D" }],
    });
    const staff = scenario.getState().staff;
    const shifts = scenario.getState().shifts;

    await scenarioCommands.mutate({ shifts: [{ id: "E" }] });

    expect(scenario.getState().staff).toBe(staff);
    expect(scenario.getState().shifts).not.toBe(shifts);
    expect(scenario.getState().shifts).toEqual([{ id: "E" }]);
  });
});

describe("authoritative Optimize preflight identity", () => {
  it("reads scenario identity and revision from PERSISTED state", async () => {
    await scenarioCommands.mutate({ rangeStart: "2026-04-01" });

    const identity = await harness.authority.readAuthoritativeIdentity();
    const persisted = (await envelope())!;

    expect(identity).toEqual({
      scenarioId: persisted.scenarioId,
      documentRevision: persisted.documentRevision,
      recordRevision: persisted.recordRevision,
    });
  });

  it("does not report an identity a reread cannot confirm", async () => {
    harness.db.close();
    expect(await harness.authority.readAuthoritativeIdentity()).toBeNull();
  });
});

describe("repository error typing", () => {
  it("a stale-revision refusal is distinguishable from an ownership loss", async () => {
    const scenarioId = useAuthorityStore.getState().scenarioId!;
    const owner = { scenarioId, tabId: harness.tabId, epoch: 1 };
    await expect(
      harness.authority.repository.commit({
        owner,
        expectedScenarioId: scenarioId,
        expectedDocumentRevision: 999,
        command: { type: "patch_scenario", patch: { rangeStart: "x" } },
      }),
    ).rejects.toSatisfy((error: unknown) => isRepositoryError(error, "stale_revision"));
  });
});
