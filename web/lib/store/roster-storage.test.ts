// F1 storage-foundation tests against a real IndexedDB implementation
// (fake-indexeddb installs the globals). These are deliberately discriminating:
// the ordering, rollback and fencing cases each carry a negative control so they
// cannot pass vacuously — the control proves the same code path DOES commit when
// the hazard is absent.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Dexie } from "dexie";
import { ScenarioPersistenceDb } from "./dexie-storage";
import {
  candidateRosterKey,
  createRosterStorageForDb,
  isWorkingRosterFromCandidate,
  WORKING_ROSTER_KEY,
  type CandidateCommitOutcome,
  type RosterStorage,
} from "./roster-storage";

let dbCounter = 0;
/** A fresh IndexedDB database name per test so state never bleeds across tests. */
function freshDbName() {
  return `roster-storage-test-${dbCounter++}`;
}

/** One "tab": its own Dexie instance over the given database name. */
function openTab(databaseName: string): { db: ScenarioPersistenceDb; storage: RosterStorage } {
  const db = new ScenarioPersistenceDb(databaseName);
  return { db, storage: createRosterStorageForDb(() => db) };
}

/** Always-accepting validator — F3 owns the real whole-document validation. */
const acceptAll = (document: unknown) => ({ ok: true as const, document });

/**
 * The invariant every valid serialization of a newer/older candidate pair must
 * end at, whatever transient results the individual commits returned: the
 * durable pointer and payload name the newer submission, and the older
 * candidate's payload is gone. A `committed` outcome is a statement about the
 * moment it returned, never a claim to still be current.
 */
async function expectNewerIsDurablyCurrent(storage: RosterStorage) {
  const pointer = await storage.readCurrentCandidate();
  expect(pointer?.jobId).toBe("job-new");
  expect(pointer?.submissionOrdinal).toBe(5);
  expect((await storage.readCandidate<{ tag: string }>("job-new"))?.document.tag).toBe("new");
  expect(await storage.readCandidate("job-old")).toBeNull();
}

/**
 * A manual barrier. Promotion's validation callback is the one real suspension
 * point in these flows, so parking it there holds a promotion genuinely in
 * flight while another Dexie instance commits — a true overlap, not a sequence
 * of completed operations replayed with stale tokens.
 */
function createBarrier() {
  let release!: () => void;
  const reached = Promise.withResolvers<void>();
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    /** Await inside the validator: signals arrival, then blocks until released. */
    async wait() {
      reached.resolve();
      await gate;
    },
    /** Resolves once the guarded operation has actually reached the barrier. */
    reached: reached.promise,
    release: () => release(),
  };
}

describe("submission snapshot + ordinal allocation", () => {
  it("allocates the ordinal and writes the snapshot in one commit", async () => {
    const { storage } = openTab(freshDbName());

    const first = await storage.allocateSubmissionSnapshot({
      ownerId: "owner-a",
      payload: { canonicalYaml: "a: 1", reverseMap: [["P1", "Alice"]] },
      expectedClearEpoch: 0,
    });
    const second = await storage.allocateSubmissionSnapshot({
      ownerId: "owner-b",
      payload: { canonicalYaml: "b: 2", reverseMap: [] },
      expectedClearEpoch: 0,
    });

    expect(first.status).toBe("allocated");
    expect(second.status).toBe("allocated");
    if (first.status !== "allocated" || second.status !== "allocated") return;
    expect(first.snapshot.submissionOrdinal).toBe(1);
    expect(second.snapshot.submissionOrdinal).toBe(2);

    const stored = await storage.readSubmissionSnapshot<{ canonicalYaml: string }>("owner-a");
    expect(stored?.payload.canonicalYaml).toBe("a: 1");
    expect(stored?.submissionOrdinal).toBe(1);
  });

  it("treats a second write for the same owner as an immutable-snapshot conflict, spending no ordinal", async () => {
    const { storage } = openTab(freshDbName());

    await storage.allocateSubmissionSnapshot({
      ownerId: "owner-a",
      payload: { canonicalYaml: "original" },
      expectedClearEpoch: 0,
    });
    const conflict = await storage.allocateSubmissionSnapshot({
      ownerId: "owner-a",
      payload: { canonicalYaml: "overwrite attempt" },
      expectedClearEpoch: 0,
    });

    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") return;
    // The stored snapshot is untouched — immutable, not last-write-wins.
    expect(conflict.snapshot.payload).toEqual({ canonicalYaml: "original" });
    const stored = await storage.readSubmissionSnapshot<{ canonicalYaml: string }>("owner-a");
    expect(stored?.payload.canonicalYaml).toBe("original");

    // Negative control: the rejected write burned no ordinal, so the next owner
    // still gets 2 rather than 3.
    const next = await storage.allocateSubmissionSnapshot({
      ownerId: "owner-b",
      payload: {},
      expectedClearEpoch: 0,
    });
    expect(next.status === "allocated" && next.snapshot.submissionOrdinal).toBe(2);
  });

  it("allocates unique monotonic ordinals across two Dexie instances on one database", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);
    // Two independent handles on one database — the cross-tab case.
    expect(tabA.db).not.toBe(tabB.db);

    const requests = Array.from({ length: 24 }, (_, index) => {
      const tab = index % 2 === 0 ? tabA : tabB;
      return tab.storage.allocateSubmissionSnapshot({
        ownerId: `owner-${index}`,
        payload: { index },
        expectedClearEpoch: 0,
      });
    });
    const results = await Promise.all(requests);

    const ordinals = results.map((result) =>
      result.status === "allocated" ? result.snapshot.submissionOrdinal : -1,
    );
    expect(ordinals).not.toContain(-1);
    expect(new Set(ordinals).size).toBe(24);
    expect([...ordinals].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    // The persisted rows agree with what the callers were handed.
    expect(await tabA.storage.listSubmissionOrdinals()).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
  });

  it("never deletes a snapshot implicitly — only an explicit delete removes it", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    await tabA.storage.allocateSubmissionSnapshot({
      ownerId: "owner-a",
      payload: {},
      expectedClearEpoch: 0,
    });

    // A second tab doing a full round of reads (the "reload recovery" path) has
    // no cleanup authority over another tab's snapshot.
    const tabB = openTab(dbName);
    await tabB.storage.readCurrentCandidate();
    await tabB.storage.readWorking();
    await tabB.storage.listSubmissionOrdinals();
    expect(await tabB.storage.readSubmissionSnapshot("owner-a")).not.toBeNull();

    expect(
      await tabB.storage.deleteSubmissionSnapshot({ ownerId: "owner-a", expectedClearEpoch: 0 }),
    ).toEqual({ status: "deleted" });
    expect(await tabA.storage.readSubmissionSnapshot("owner-a")).toBeNull();
    expect(
      await tabB.storage.deleteSubmissionSnapshot({ ownerId: "owner-a", expectedClearEpoch: 0 }),
    ).toEqual({ status: "already-absent" });
  });
});

describe("blob-capable roster documents", () => {
  it("round-trips a Blob (frozenXlsx) through the roster store", async () => {
    const { storage } = openTab(freshDbName());
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    const frozenXlsx = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const outcome = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { schemaVersion: "roster-file/1", frozenXlsx },
      expectedClearEpoch: 0,
    });
    expect(outcome.status).toBe("committed");

    const stored = await storage.readCandidate<{ schemaVersion: string; frozenXlsx: Blob }>(
      "job-1",
    );
    expect(stored?.document.schemaVersion).toBe("roster-file/1");
    const roundTripped = stored?.document.frozenXlsx;
    expect(roundTripped).toBeInstanceOf(Blob);
    expect(roundTripped?.type).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(new Uint8Array(await (roundTripped as Blob).arrayBuffer())).toEqual(bytes);
  });
});

describe("candidate supersession", () => {
  it("a newer candidate takes the pointer and deletes the prior candidate payload", async () => {
    const { storage } = openTab(freshDbName());

    await storage.commitCandidate({
      jobId: "job-old",
      submissionOrdinal: 3,
      document: { tag: "old" },
      expectedClearEpoch: 0,
    });
    const newer = await storage.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 5,
      document: { tag: "new" },
      expectedClearEpoch: 0,
    });

    expect(newer.status).toBe("committed");
    if (newer.status !== "committed") return;
    expect(newer.replaced?.jobId).toBe("job-old");
    expect(await storage.readCurrentCandidate()).toEqual({
      jobId: "job-new",
      candidateVersion: 2,
      submissionOrdinal: 5,
    });
    // Dismissal of the superseded payload happened in the same transaction.
    expect(await storage.readCandidate("job-old")).toBeNull();
  });

  it("an older submission completing LAST is superseded and writes nothing", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    // Newer submission (ordinal 5) commits first; the older one (ordinal 3)
    // completes afterwards — completion order is not the ordering authority.
    await tabA.storage.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 5,
      document: { tag: "new" },
      expectedClearEpoch: 0,
    });
    const late = await tabB.storage.commitCandidate({
      jobId: "job-old",
      submissionOrdinal: 3,
      document: { tag: "old" },
      expectedClearEpoch: 0,
    });

    expect(late.status).toBe("superseded");
    if (late.status !== "superseded") return;
    expect(late.current.jobId).toBe("job-new");
    // No storage movement whatsoever: no candidate row, pointer untouched.
    expect(await tabA.storage.readCandidate("job-old")).toBeNull();
    expect(await tabA.storage.readCurrentCandidate()).toEqual({
      jobId: "job-new",
      candidateVersion: 1,
      submissionOrdinal: 5,
    });
    expect(await tabA.storage.readCandidate<{ tag: string }>("job-new")).not.toBeNull();

    // Reload (a third fresh handle) resolves Load from the durable pointer.
    const reloaded = openTab(dbName);
    const pointer = await reloaded.storage.readCurrentCandidate();
    expect(pointer?.jobId).toBe("job-new");
    const record = await reloaded.storage.readCandidate<{ tag: string }>(pointer!.jobId);
    expect(record?.document.tag).toBe("new");
  });

  it("negative control: the same two commits in the other order DO move the pointer", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    await tabB.storage.commitCandidate({
      jobId: "job-old",
      submissionOrdinal: 3,
      document: { tag: "old" },
      expectedClearEpoch: 0,
    });
    const newer = await tabA.storage.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 5,
      document: { tag: "new" },
      expectedClearEpoch: 0,
    });

    expect(newer.status).toBe("committed");
    expect((await tabB.storage.readCurrentCandidate())?.jobId).toBe("job-new");
    expect(await tabB.storage.readCandidate("job-old")).toBeNull();
  });

  it("a rival job at the same ordinal is superseded, but the same job re-commits idempotently", async () => {
    const { storage } = openTab(freshDbName());
    await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 7,
      document: { attempt: 1 },
      expectedClearEpoch: 0,
    });

    const rival = await storage.commitCandidate({
      jobId: "job-2",
      submissionOrdinal: 7,
      document: { attempt: "rival" },
      expectedClearEpoch: 0,
    });
    expect(rival.status).toBe("superseded");
    expect(await storage.readCandidate("job-2")).toBeNull();

    // A capture retry for the SAME job re-commits and bumps candidateVersion.
    const retry = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 7,
      document: { attempt: 2 },
      expectedClearEpoch: 0,
    });
    expect(retry.status).toBe("committed");
    expect(await storage.readCurrentCandidate()).toEqual({
      jobId: "job-1",
      candidateVersion: 2,
      submissionOrdinal: 7,
    });
    expect((await storage.readCandidate<{ attempt: number }>("job-1"))?.document.attempt).toBe(2);
  });

  it("a candidate commit that aborts leaves the prior pointer and payload intact", async () => {
    const { storage } = openTab(freshDbName());
    await storage.commitCandidate({
      jobId: "job-old",
      submissionOrdinal: 3,
      document: { tag: "old" },
      expectedClearEpoch: 0,
    });

    // A genuinely un-storable document (functions are not structured-cloneable)
    // aborts the transaction exactly like a quota failure would — no injected
    // test seam, a real IndexedDB abort.
    await expect(
      storage.commitCandidate({
        jobId: "job-new",
        submissionOrdinal: 5,
        document: { tag: "new", notCloneable: () => "boom" },
        expectedClearEpoch: 0,
      }),
    ).rejects.toThrow();

    expect(await storage.readCurrentCandidate()).toEqual({
      jobId: "job-old",
      candidateVersion: 1,
      submissionOrdinal: 3,
    });
    expect((await storage.readCandidate<{ tag: string }>("job-old"))?.document.tag).toBe("old");
    expect(await storage.readCandidate("job-new")).toBeNull();

    // Negative control: the same commit with a storable document succeeds.
    const ok = await storage.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 5,
      document: { tag: "new" },
      expectedClearEpoch: 0,
    });
    expect(ok.status).toBe("committed");
    expect((await storage.readCurrentCandidate())?.jobId).toBe("job-new");
  });

  it("dismissing the pointed candidate drops its payload and clears the pointer", async () => {
    const { storage } = openTab(freshDbName());
    const committed = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: {},
      expectedClearEpoch: 0,
    });
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") return;

    expect(
      await storage.dismissCandidate({
        jobId: "job-1",
        candidateVersion: committed.pointer.candidateVersion,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "dismissed", clearedPointer: true });

    expect(await storage.readCandidate("job-1")).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();
  });

  it("a dismissal captured for an older capture cannot delete the retry that replaced it", async () => {
    const { storage } = openTab(freshDbName());
    const first = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { attempt: 1 },
      expectedClearEpoch: 0,
    });
    expect(first.status).toBe("committed");
    if (first.status !== "committed") return;
    const staleAuthority = first.pointer.candidateVersion;

    const retry = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { attempt: 2 },
      expectedClearEpoch: 0,
    });
    expect(retry.status).toBe("committed");
    if (retry.status !== "committed") return;
    // The version counter is origin-wide, so the retry can never reuse the number
    // the stale dismissal is holding.
    expect(retry.pointer.candidateVersion).not.toBe(staleAuthority);

    expect(
      await storage.dismissCandidate({
        jobId: "job-1",
        candidateVersion: staleAuthority,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "version-conflict", currentVersion: retry.pointer.candidateVersion });

    // The retry survived intact, pointer included.
    expect((await storage.readCandidate<{ attempt: number }>("job-1"))?.document.attempt).toBe(2);
    expect(await storage.readCurrentCandidate()).toEqual(retry.pointer);

    // Negative control: the CURRENT authority does dismiss it.
    expect(
      await storage.dismissCandidate({
        jobId: "job-1",
        candidateVersion: retry.pointer.candidateVersion,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "dismissed", clearedPointer: true });
    expect(await storage.readCandidate("job-1")).toBeNull();
  });

  it("dismissal and snapshot deletion begun before a Clear report stale-epoch", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    const committed = await tabA.storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: {},
      expectedClearEpoch: 0,
    });
    await tabA.storage.allocateSubmissionSnapshot({
      ownerId: "owner-a",
      payload: {},
      expectedClearEpoch: 0,
    });
    if (committed.status !== "committed") return;

    await tabB.storage.clearRosterData();

    expect(
      await tabA.storage.dismissCandidate({
        jobId: "job-1",
        candidateVersion: committed.pointer.candidateVersion,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "stale-epoch", currentEpoch: 1 });
    expect(
      await tabA.storage.deleteSubmissionSnapshot({ ownerId: "owner-a", expectedClearEpoch: 0 }),
    ).toEqual({ status: "stale-epoch", currentEpoch: 1 });
  });
});

describe("fill empty, never overwrite (the working-slot CAS inside candidate commit)", () => {
  it("fills a PROVEN-empty working slot from the same transaction and says so", async () => {
    const { storage } = openTab(freshDbName());

    const outcome = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "solved" },
      expectedClearEpoch: 0,
    });

    expect(outcome).toMatchObject({
      status: "committed",
      working: { kind: "loaded-empty", workingRevision: 1 },
    });
    // No Load click, no second transaction: the viewer is populated already.
    expect(await storage.readWorking()).toMatchObject({
      document: { tag: "solved" },
      revision: 1,
      clearEpoch: 0,
    });
    // And the candidate is still the durable latest result, as ever.
    expect((await storage.readCandidate<{ tag: string }>("job-1"))?.document.tag).toBe("solved");
    expect((await storage.readCurrentCandidate())?.jobId).toBe("job-1");
  });

  it("preserves an existing working roster BYTE-FOR-BYTE and leaves the candidate awaiting a choice", async () => {
    const { storage } = openTab(freshDbName());
    const existingBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x07, 0x00, 0xff]);
    await storage.promoteDocumentToWorking({
      document: { tag: "hand-edited", frozenXlsx: new Blob([existingBytes]) },
      validate: acceptAll,
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });

    const outcome = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "new-result" },
      expectedClearEpoch: 0,
    });

    expect(outcome).toMatchObject({
      status: "committed",
      working: { kind: "awaiting-choice", reason: "working-present" },
    });
    // Byte-for-byte, not merely "still a roster": the row was not rewritten (the
    // revision is untouched) and its embedded blob round-trips unchanged.
    const kept = await storage.readWorking<{ tag: string; frozenXlsx: Blob }>();
    expect(kept?.revision).toBe(1);
    expect(kept?.document.tag).toBe("hand-edited");
    expect(new Uint8Array(await kept!.document.frozenXlsx.arrayBuffer())).toEqual(existingBytes);
    // The exact new result is durable and reachable for an explicit Load/Replace.
    expect((await storage.readCandidate<{ tag: string }>("job-1"))?.document.tag).toBe(
      "new-result",
    );
  });

  it("never treats an UNREADABLE working slot as empty, and still commits the candidate", async () => {
    const { db, storage } = openTab(freshDbName());
    const realGet = db.roster.get.bind(db.roster);
    // Throws synchronously on purpose: awaiting a foreign rejected promise inside
    // a Dexie transaction would leave its zone and commit it early, which would be
    // testing the harness rather than the fence.
    db.roster.get = ((key: string) => {
      if (key === WORKING_ROSTER_KEY) throw new Error("the working row could not be read");
      return realGet(key);
    }) as typeof db.roster.get;

    const outcome = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "new-result" },
      expectedClearEpoch: 0,
    });

    db.roster.get = realGet as typeof db.roster.get;

    // Fail closed on the PROMOTION only. "Empty" means proven absent, and a failed
    // read proves nothing — but the candidate's own durability is not collateral.
    expect(outcome).toMatchObject({
      status: "committed",
      working: { kind: "awaiting-choice", reason: "working-unreadable" },
    });
    expect(await storage.readWorking()).toBeNull();
    expect((await storage.readCandidate<{ tag: string }>("job-1"))?.document.tag).toBe(
      "new-result",
    );

    // Negative control: with the read working again, the SAME call fills the slot.
    // Without this the test would pass just as well if promotion were removed.
    const retry = await storage.commitCandidate({
      jobId: "job-2",
      submissionOrdinal: 2,
      document: { tag: "later-result" },
      expectedClearEpoch: 0,
    });
    expect(retry).toMatchObject({ status: "committed", working: { kind: "loaded-empty" } });
  });

  it("does not fill the slot for a SUPERSEDED (older) completion", async () => {
    const { storage } = openTab(freshDbName());
    await storage.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 5,
      document: { tag: "newer" },
      expectedClearEpoch: 0,
    });
    // The newer run already filled the empty slot; put an unrelated document there
    // so the only reason the late run could fail to promote is supersession itself.
    // Through PROMOTION, because that is what replacing the whole document is — and
    // it clears the fill-empty row's candidate source, so the replacement cannot
    // inherit an identity it has nothing to do with.
    const replaced = await storage.promoteDocumentToWorking({
      document: { tag: "whatever" },
      validate: acceptAll,
      expectedWorkingRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(replaced).toEqual({ status: "promoted", revision: 2 });
    expect((await storage.readWorking())?.candidateSource).toBeUndefined();

    const late = await storage.commitCandidate({
      jobId: "job-old",
      submissionOrdinal: 4,
      document: { tag: "older" },
      expectedClearEpoch: 0,
    });

    expect(late.status).toBe("superseded");
    expect(await storage.readWorking()).toMatchObject({
      document: { tag: "whatever" },
      revision: 2,
    });
    expect(await storage.readCandidate("job-old")).toBeNull();
  });

  it("rolls the WHOLE commit back when the working write fails — no candidate, no pointer, no roster", async () => {
    const { db, storage } = openTab(freshDbName());
    const realPut = db.roster.put.bind(db.roster);
    db.roster.put = ((row: { key: string }) => {
      if (row.key === WORKING_ROSTER_KEY) throw new Error("quota exceeded");
      return realPut(row as never);
    }) as typeof db.roster.put;

    await expect(
      storage.commitCandidate({
        jobId: "job-1",
        submissionOrdinal: 1,
        document: { tag: "solved" },
        expectedClearEpoch: 0,
      }),
    ).rejects.toThrow(/quota exceeded/);

    db.roster.put = realPut as typeof db.roster.put;

    // One transaction means one outcome. A check-then-write would have left the
    // candidate and its pointer behind, reporting a durable capture that is not.
    expect(await storage.readWorking()).toBeNull();
    expect(await storage.readCandidate("job-1")).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();

    // Negative control: the retry, unobstructed, commits and fills.
    expect(
      await storage.commitCandidate({
        jobId: "job-1",
        submissionOrdinal: 1,
        document: { tag: "solved" },
        expectedClearEpoch: 0,
      }),
    ).toMatchObject({ status: "committed", working: { kind: "loaded-empty" } });
  });

  it("lets only ONE of two concurrent tabs fill the empty slot", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    // Both start while the slot is empty and overlap in IndexedDB. A check-then-write
    // would let both observe "empty" and the second would clobber the first.
    const [first, second] = await Promise.all([
      tabA.storage.commitCandidate({
        jobId: "job-a",
        submissionOrdinal: 1,
        document: { tag: "A" },
        expectedClearEpoch: 0,
      }),
      tabB.storage.commitCandidate({
        jobId: "job-b",
        submissionOrdinal: 2,
        document: { tag: "B" },
        expectedClearEpoch: 0,
      }),
    ]);

    const filled = [first, second].filter(
      (outcome) => outcome.status === "committed" && outcome.working.kind === "loaded-empty",
    );
    expect(filled).toHaveLength(1);

    // Exactly one write ever reached the slot, so it is still at its first revision.
    const working = await tabA.storage.readWorking<{ tag: string }>();
    expect(working?.revision).toBe(1);
    // And the slot holds the document of the commit that CLAIMED the fill — not
    // whichever tab happened to run last.
    const winner = filled[0];
    if (winner.status !== "committed") throw new Error("unreachable");
    expect(working?.document.tag).toBe(winner.pointer.jobId === "job-a" ? "A" : "B");

    // IndexedDB decides which of the two above ran first, so one of them may have
    // been refused for SUPERSESSION rather than by the slot fence. This third
    // commit removes that ambiguity deterministically: it is strictly newer than
    // both, so nothing but the filled slot can stop it — and it must not overwrite.
    const newer = await tabB.storage.commitCandidate({
      jobId: "job-c",
      submissionOrdinal: 3,
      document: { tag: "C" },
      expectedClearEpoch: 0,
    });
    expect(newer).toMatchObject({
      status: "committed",
      working: { kind: "awaiting-choice", reason: "working-present" },
    });
    expect(await tabA.storage.readWorking()).toMatchObject({ ...working, revision: 1 });
  });
});

describe("exact candidate provenance on the working row", () => {
  it("records the EXACT candidate a fill-empty promotion came from", async () => {
    const { storage } = openTab(freshDbName());

    const outcome = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "solved" },
      expectedClearEpoch: 0,
    });
    if (outcome.status !== "committed") throw new Error("unreachable");

    const working = await storage.readWorking();
    expect(working?.candidateSource).toEqual({
      jobId: "job-1",
      candidateVersion: outcome.pointer.candidateVersion,
    });
    // The recorded source IS the pointer, which is what makes the comparison exact
    // rather than a guess from document content.
    expect(isWorkingRosterFromCandidate(working?.candidateSource, outcome.pointer)).toBe(true);
  });

  it("records the exact promoted version on an explicit Load, replacing any earlier source", async () => {
    const { storage } = openTab(freshDbName());
    // A first run fills the empty slot and stamps its own source.
    const first = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "first" },
      expectedClearEpoch: 0,
    });
    if (first.status !== "committed") throw new Error("unreachable");

    // A second, newer run only becomes a candidate — the slot is occupied.
    const second = await storage.commitCandidate({
      jobId: "job-2",
      submissionOrdinal: 2,
      document: { tag: "second" },
      expectedClearEpoch: 0,
    });
    if (second.status !== "committed") throw new Error("unreachable");

    const promoted = await storage.promoteCandidateToWorking({
      jobId: "job-2",
      expectedCandidateVersion: second.pointer.candidateVersion,
      validate: acceptAll,
      expectedWorkingRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(promoted).toEqual({ status: "promoted", revision: 2 });

    // Replaced wholesale, not merged: the first run's source must not survive.
    const working = await storage.readWorking();
    expect(working?.candidateSource).toEqual({
      jobId: "job-2",
      candidateVersion: second.pointer.candidateVersion,
    });
    expect(isWorkingRosterFromCandidate(working?.candidateSource, first.pointer)).toBe(false);
    expect(isWorkingRosterFromCandidate(working?.candidateSource, second.pointer)).toBe(true);
  });

  it("records NO source for an imported or otherwise manual document", async () => {
    const { storage } = openTab(freshDbName());
    // Start from a candidate-promoted row so the absence below is a real removal,
    // not just a field that was never written.
    const commit = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "from-run" },
      expectedClearEpoch: 0,
    });
    if (commit.status !== "committed") throw new Error("unreachable");
    expect((await storage.readWorking())?.candidateSource).toBeDefined();

    const imported = await storage.promoteDocumentToWorking({
      document: { tag: "imported" },
      validate: acceptAll,
      expectedWorkingRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(imported).toEqual({ status: "promoted", revision: 2 });

    const working = await storage.readWorking();
    expect(working?.candidateSource).toBeUndefined();
    // So an import can never be mistaken for the candidate whose grid it matches.
    expect(isWorkingRosterFromCandidate(working?.candidateSource, commit.pointer)).toBe(false);
  });

  it("carries the source forward across autosave revisions", async () => {
    const { storage } = openTab(freshDbName());
    const commit = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "solved", edits: [] },
      expectedClearEpoch: 0,
    });
    if (commit.status !== "committed") throw new Error("unreachable");

    // Two autosaves, as editing produces. An edited roster is still the SAME
    // result, so dropping the source here would make every edit look imported.
    const first = await storage.writeWorkingEdit({
      document: { tag: "solved", edits: [{ personIdx: 0 }] },
      expectedRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(first).toEqual({ status: "written", revision: 2 });
    await storage.writeWorkingEdit({
      document: { tag: "solved", edits: [{ personIdx: 0 }, { personIdx: 1 }] },
      expectedRevision: 2,
      expectedClearEpoch: 0,
    });

    const working = await storage.readWorking();
    expect(working?.revision).toBe(3);
    expect(isWorkingRosterFromCandidate(working?.candidateSource, commit.pointer)).toBe(true);
  });

  it("leaves a row with no source alone, and Clear removes the source with the row", async () => {
    const { storage } = openTab(freshDbName());
    // COMPATIBILITY: a row written without the field — as every row predating it
    // was — reads back normally and simply carries no source.
    await storage.promoteDocumentToWorking({
      document: { tag: "legacy" },
      validate: acceptAll,
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });
    const legacy = await storage.readWorking();
    expect(legacy).toMatchObject({ document: { tag: "legacy" }, revision: 1 });
    expect(legacy?.candidateSource).toBeUndefined();
    // An edit of that row stays sourceless rather than inventing one.
    await storage.writeWorkingEdit({
      document: { tag: "legacy-edited" },
      expectedRevision: 1,
      expectedClearEpoch: 0,
    });
    expect((await storage.readWorking())?.candidateSource).toBeUndefined();

    // Clear takes the row, and with it the source — there is no orphan provenance.
    const commit = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "solved" },
      expectedClearEpoch: 0,
    });
    expect(commit.status).toBe("committed");
    expect(await storage.clearRosterData()).toMatchObject({ status: "cleared" });
    expect(await storage.readWorking()).toBeNull();
  });

  it("the equality rule is exact: same job, newer version does not match", async () => {
    // The whole point of carrying `candidateVersion`. A same-job re-capture is a
    // different result the user has not decided about.
    const source = { jobId: "job-1", candidateVersion: 1 };
    expect(
      isWorkingRosterFromCandidate(source, {
        jobId: "job-1",
        candidateVersion: 1,
        submissionOrdinal: 9,
      }),
    ).toBe(true);
    expect(
      isWorkingRosterFromCandidate(source, {
        jobId: "job-1",
        candidateVersion: 2,
        submissionOrdinal: 9,
      }),
    ).toBe(false);
    expect(
      isWorkingRosterFromCandidate(source, {
        jobId: "job-2",
        candidateVersion: 1,
        submissionOrdinal: 9,
      }),
    ).toBe(false);
    // Absent source, or no candidate at all: never a match, so neither can hide
    // anything by inference.
    expect(isWorkingRosterFromCandidate(undefined, { ...source, submissionOrdinal: 1 })).toBe(
      false,
    );
    expect(isWorkingRosterFromCandidate(source, null)).toBe(false);
  });
});

describe("the working-write boundary: edits preserve, replacements decide", () => {
  /** The source recorded on the current working row, if any. */
  async function sourceOf(storage: RosterStorage) {
    return (await storage.readWorking())?.candidateSource;
  }

  it("exposes NO general working write — only the edit operation and the two promotions", () => {
    // DEAD SURFACE. A general `writeWorking` always carried the row's
    // `candidateSource` into whatever document it was handed, so one
    // replacement-shaped caller was enough to give a roster the PREVIOUS roster's
    // exact candidate identity — after which the UI hid the Load/Replace action for
    // a candidate the working roster never came from. Removing that surface is the
    // fix, so its absence is the assertion.
    const surface = openTab(freshDbName()).storage as unknown as Record<string, unknown>;
    expect("writeWorking" in surface).toBe(false);
    expect(typeof surface.writeWorkingEdit).toBe("function");
    expect(typeof surface.promoteCandidateToWorking).toBe("function");
    expect(typeof surface.promoteDocumentToWorking).toBe("function");
  });

  it("transitions the source correctly across edit, candidate replacement, and import", async () => {
    const { storage } = openTab(freshDbName());

    // 1. AUTO-PROMOTED. The fill-empty CAS stamps its own exact source.
    const first = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "run-1" },
      expectedClearEpoch: 0,
    });
    if (first.status !== "committed") throw new Error("unreachable");
    expect(isWorkingRosterFromCandidate(await sourceOf(storage), first.pointer)).toBe(true);

    // 2. AN EDIT keeps it — a new revision of the same roster.
    expect(
      await storage.writeWorkingEdit({
        document: { tag: "run-1", edits: [1] },
        expectedRevision: 1,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "written", revision: 2 });
    expect(isWorkingRosterFromCandidate(await sourceOf(storage), first.pointer)).toBe(true);

    // 3. A CANDIDATE REPLACEMENT moves it to the exact version promoted.
    const second = await storage.commitCandidate({
      jobId: "job-2",
      submissionOrdinal: 2,
      document: { tag: "run-2" },
      expectedClearEpoch: 0,
    });
    if (second.status !== "committed") throw new Error("unreachable");
    expect(
      await storage.promoteCandidateToWorking({
        jobId: "job-2",
        expectedCandidateVersion: second.pointer.candidateVersion,
        validate: acceptAll,
        expectedWorkingRevision: 2,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "promoted", revision: 3 });
    expect(isWorkingRosterFromCandidate(await sourceOf(storage), first.pointer)).toBe(false);
    expect(isWorkingRosterFromCandidate(await sourceOf(storage), second.pointer)).toBe(true);

    // 4. AN IMPORT clears it — so the current candidate stays something the user
    //    can choose to load, whatever its assignments happen to look like. This is
    //    the transition the old general write could silently skip.
    expect(
      await storage.promoteDocumentToWorking({
        document: { tag: "imported" },
        validate: acceptAll,
        expectedWorkingRevision: 3,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "promoted", revision: 4 });
    expect(await sourceOf(storage)).toBeUndefined();
    expect(isWorkingRosterFromCandidate(await sourceOf(storage), second.pointer)).toBe(false);

    // 5. AND AN EDIT OF THAT IMPORT stays sourceless — it cannot acquire one.
    await storage.writeWorkingEdit({
      document: { tag: "imported", edits: [1] },
      expectedRevision: 4,
      expectedClearEpoch: 0,
    });
    expect(await sourceOf(storage)).toBeUndefined();
  });
});

describe("working roster promotion", () => {
  it("promotes a candidate over an existing roster, keeping the candidate as the durable latest result", async () => {
    const { storage } = openTab(freshDbName());
    // A working roster already exists, so the commit itself cannot fill the slot.
    // This is precisely the path explicit promotion exists for — with an EMPTY
    // slot the commit fills it and no Load click is involved at all.
    await storage.promoteDocumentToWorking({
      document: { tag: "existing" },
      validate: acceptAll,
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });
    const commit = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "candidate" },
      expectedClearEpoch: 0,
    });
    expect(commit).toMatchObject({
      status: "committed",
      working: { kind: "awaiting-choice", reason: "working-present" },
    });
    expect((await storage.readWorking<{ tag: string }>())?.document.tag).toBe("existing");

    const promoted = await storage.promoteCandidateToWorking({
      jobId: "job-1",
      expectedCandidateVersion: 1,
      validate: acceptAll,
      expectedWorkingRevision: 1,
      expectedClearEpoch: 0,
    });

    expect(promoted).toEqual({ status: "promoted", revision: 2 });
    expect((await storage.readWorking<{ tag: string }>())?.document.tag).toBe("candidate");
    // Promotion is a copy, not a move: the candidate stays loadable.
    expect(await storage.readCandidate("job-1")).not.toBeNull();
    expect((await storage.readCurrentCandidate())?.jobId).toBe("job-1");
  });

  it("stores the validator's normalized document and rejects an invalid one without touching working", async () => {
    const { storage } = openTab(freshDbName());
    await storage.promoteDocumentToWorking({
      document: { tag: "first" },
      validate: acceptAll,
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });

    const rejected = await storage.promoteDocumentToWorking({
      document: { tag: "second" },
      validate: () => ({ ok: false as const, reason: "unsupported schemaVersion" }),
      expectedWorkingRevision: 1,
      expectedClearEpoch: 0,
    });

    expect(rejected).toEqual({ status: "rejected", reason: "unsupported schemaVersion" });
    expect((await storage.readWorking<{ tag: string }>())?.document.tag).toBe("first");

    // The validator's returned value is what gets stored (the F3 boundary).
    const normalized = await storage.promoteDocumentToWorking({
      document: { tag: "second" },
      validate: async (document) => ({
        ok: true as const,
        document: { ...(document as object), normalized: true },
      }),
      expectedWorkingRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(normalized).toEqual({ status: "promoted", revision: 2 });
    expect(await storage.readWorking()).toMatchObject({
      document: { tag: "second", normalized: true },
      revision: 2,
    });
  });

  it("a commit failure during promotion keeps BOTH the current working roster and the source candidate", async () => {
    const { db, storage } = openTab(freshDbName());
    await storage.promoteDocumentToWorking({
      document: { tag: "current" },
      validate: acceptAll,
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });
    await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "incoming" },
      expectedClearEpoch: 0,
    });

    // Fail the working-row write the way a quota error would: a throwing CRUD
    // hook aborts the surrounding transaction.
    const quotaFailure = (_modifications: unknown, primaryKey: string) => {
      if (primaryKey === WORKING_ROSTER_KEY) {
        throw new DOMException("simulated quota failure", "QuotaExceededError");
      }
    };
    db.roster.hook("updating", quotaFailure);

    await expect(
      storage.promoteCandidateToWorking({
        jobId: "job-1",
        expectedCandidateVersion: 1,
        validate: acceptAll,
        expectedWorkingRevision: 1,
        expectedClearEpoch: 0,
      }),
    ).rejects.toThrow();

    db.roster.hook("updating").unsubscribe(quotaFailure);

    // Both sides survive: the old working roster and the source candidate.
    expect(await storage.readWorking()).toMatchObject({
      document: { tag: "current" },
      revision: 1,
    });
    expect((await storage.readCandidate<{ tag: string }>("job-1"))?.document.tag).toBe("incoming");
    expect((await storage.readCurrentCandidate())?.jobId).toBe("job-1");

    // Negative control: with the fault removed the identical promotion commits.
    expect(
      await storage.promoteCandidateToWorking({
        jobId: "job-1",
        expectedCandidateVersion: 1,
        validate: acceptAll,
        expectedWorkingRevision: 1,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "promoted", revision: 2 });
    expect((await storage.readWorking<{ tag: string }>())?.document.tag).toBe("incoming");
  });

  it("reports a missing or concurrently replaced source instead of promoting it", async () => {
    const { db, storage } = openTab(freshDbName());

    expect(
      await storage.promoteCandidateToWorking({
        jobId: "absent",
        expectedCandidateVersion: 1,
        validate: acceptAll,
        expectedWorkingRevision: null,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "source-missing" });

    await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "v1" },
      expectedClearEpoch: 0,
    });
    // The candidate is re-captured (revision bumps) while validation is running.
    const promoted = await storage.promoteCandidateToWorking({
      jobId: "job-1",
      expectedCandidateVersion: 1,
      validate: async (document) => {
        await db.roster.put({
          key: candidateRosterKey("job-1"),
          document: { tag: "v2" },
          revision: 2,
          clearEpoch: 0,
        });
        return { ok: true as const, document };
      },
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });

    expect(promoted).toEqual({ status: "source-changed" });
    // The commit's own fill-empty put `v1` in the slot. The re-captured `v2` the
    // validator planted never reached it, and no second write happened at all —
    // which the unchanged revision proves, not the document alone.
    expect(await storage.readWorking()).toMatchObject({ document: { tag: "v1" }, revision: 1 });
  });
});

describe("revisioned compare-and-swap working writes", () => {
  it("accepts the expected revision and rejects a stale one", async () => {
    const { storage } = openTab(freshDbName());

    const created = await storage.writeWorkingEdit({
      document: { edits: [] },
      expectedRevision: null,
      expectedClearEpoch: 0,
    });
    expect(created).toEqual({ status: "written", revision: 1 });

    const updated = await storage.writeWorkingEdit({
      document: { edits: [1] },
      expectedRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(updated).toEqual({ status: "written", revision: 2 });

    // A writer still holding revision 1 loses; the stored document is untouched.
    const conflicted = await storage.writeWorkingEdit({
      document: { edits: ["stale"] },
      expectedRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(conflicted).toEqual({ status: "conflict", currentRevision: 2 });
    expect(await storage.readWorking()).toMatchObject({ document: { edits: [1] }, revision: 2 });
  });

  it("a first write expecting no row loses to a row that already exists", async () => {
    const { storage } = openTab(freshDbName());
    await storage.writeWorkingEdit({
      document: { tag: "a" },
      expectedRevision: null,
      expectedClearEpoch: 0,
    });

    expect(
      await storage.writeWorkingEdit({
        document: { tag: "b" },
        expectedRevision: null,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "conflict", currentRevision: 1 });
  });
});

describe("barrier-controlled two-instance races", () => {
  it("an autosave committed while validation is parked yields a working conflict, losing nothing", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    await tabA.storage.promoteDocumentToWorking({
      document: { edits: ["existing"] },
      validate: acceptAll,
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });
    await tabA.storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "incoming" },
      expectedClearEpoch: 0,
    });

    // Tab A reads the working revision, then starts a promotion whose validation
    // parks at the barrier — the promotion is genuinely in flight from here.
    const expectedWorkingRevision = (await tabA.storage.readWorking())?.revision ?? null;
    expect(expectedWorkingRevision).toBe(1);
    const barrier = createBarrier();
    const promotion = tabA.storage.promoteCandidateToWorking({
      jobId: "job-1",
      expectedCandidateVersion: 1,
      validate: async (document) => {
        await barrier.wait();
        return { ok: true as const, document };
      },
      expectedWorkingRevision,
      expectedClearEpoch: 0,
    });

    // Tab B autosaves an edit into the overlap window.
    await barrier.reached;
    expect(
      await tabB.storage.writeWorkingEdit({
        document: { edits: ["existing", "autosaved"] },
        expectedRevision: 1,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "written", revision: 2 });

    barrier.release();

    expect(await promotion).toEqual({ status: "working-conflict", currentRevision: 2 });
    // The autosaved edit survived, and so did the candidate it lost to.
    expect(await tabB.storage.readWorking()).toMatchObject({
      document: { edits: ["existing", "autosaved"] },
      revision: 2,
    });
    expect((await tabB.storage.readCandidate<{ tag: string }>("job-1"))?.document.tag).toBe(
      "incoming",
    );

    // Negative control: retried against the revision it now observes, the same
    // promotion commits — so the conflict above was the CAS, not a broken path.
    expect(
      await tabA.storage.promoteCandidateToWorking({
        jobId: "job-1",
        expectedCandidateVersion: 1,
        validate: acceptAll,
        expectedWorkingRevision: 2,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "promoted", revision: 3 });
  });

  it("a candidate deleted and recreated while validation is parked cannot pass as unchanged (ABA)", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    const first = await tabA.storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "A" },
      expectedClearEpoch: 0,
    });
    if (first.status !== "committed") return;

    const barrier = createBarrier();
    const promotion = tabA.storage.promoteCandidateToWorking({
      jobId: "job-1",
      expectedCandidateVersion: 1,
      validate: async (document) => {
        await barrier.wait();
        return { ok: true as const, document };
      },
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });

    // Tab B dismisses the candidate and recaptures the SAME job id. A per-key
    // version counter would restart at 1 here and the stale validated document
    // would pass the source check; the origin-wide counter cannot repeat.
    await barrier.reached;
    expect(
      await tabB.storage.dismissCandidate({
        jobId: "job-1",
        candidateVersion: first.pointer.candidateVersion,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "dismissed", clearedPointer: true });
    const recreated = await tabB.storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 2,
      document: { tag: "B" },
      expectedClearEpoch: 0,
    });
    if (recreated.status !== "committed") return;
    expect(recreated.pointer.candidateVersion).not.toBe(first.pointer.candidateVersion);

    barrier.release();

    expect(await promotion).toEqual({ status: "source-changed" });
    // Crucially, the STALE promotion did not write. The slot holds tab A's own
    // fill-empty row from its commit; since that row's document is also `A`, the
    // REVISION is what discriminates — a stale write would have bumped it to 2.
    expect(await tabB.storage.readWorking()).toMatchObject({ document: { tag: "A" }, revision: 1 });
    expect((await tabB.storage.readCandidate<{ tag: string }>("job-1"))?.document.tag).toBe("B");

    // Negative control: promoting what is actually stored now succeeds, and it
    // is the recreated document that lands. The version named is the RECREATED
    // one — under the exact-version fence, asking for the original version here
    // would (correctly) be refused rather than silently promoting the new row.
    expect(
      await tabA.storage.promoteCandidateToWorking({
        jobId: "job-1",
        expectedCandidateVersion: recreated.pointer.candidateVersion,
        validate: acceptAll,
        expectedWorkingRevision: 1,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "promoted", revision: 2 });
    expect((await tabA.storage.readWorking<{ tag: string }>())?.document.tag).toBe("B");
  });

  it("a promotion whose validation spans a Clear is fenced and repopulates nothing", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    await tabA.storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "real nurse identities" },
      expectedClearEpoch: 0,
    });

    const barrier = createBarrier();
    const promotion = tabA.storage.promoteCandidateToWorking({
      jobId: "job-1",
      expectedCandidateVersion: 1,
      validate: async (document) => {
        await barrier.wait();
        return { ok: true as const, document };
      },
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });

    // Clear lands entirely inside the promotion's validation window.
    await barrier.reached;
    expect(await tabB.storage.clearRosterData()).toEqual({ status: "cleared", epoch: 1 });

    barrier.release();

    expect(await promotion).toEqual({ status: "stale-epoch", currentEpoch: 1 });
    expect(await tabB.storage.readWorking()).toBeNull();
    expect(await tabB.storage.readCandidate("job-1")).toBeNull();
    expect(await tabB.storage.readCurrentCandidate()).toBeNull();
  });

  // The two commits below are ordered explicitly rather than left to the
  // scheduler, because BOTH serializations are legal and they produce different
  // transient results. Only the durable invariant is common to both, so that is
  // what every case asserts through `expectNewerIsDurablyCurrent`.
  it("newer-first: the older commit arriving later is superseded and writes nothing", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    const newer = await tabA.storage.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 5,
      document: { tag: "new" },
      expectedClearEpoch: 0,
    });
    const older = await tabB.storage.commitCandidate({
      jobId: "job-old",
      submissionOrdinal: 3,
      document: { tag: "old" },
      expectedClearEpoch: 0,
    });

    expect(newer.status).toBe("committed");
    expect(older.status).toBe("superseded");
    if (older.status !== "superseded") return;
    expect(older.current.jobId).toBe("job-new");
    await expectNewerIsDurablyCurrent(tabA.storage);
  });

  it("older-first: the older commit succeeds transiently, then the newer one supersedes it durably", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    const older = await tabB.storage.commitCandidate({
      jobId: "job-old",
      submissionOrdinal: 3,
      document: { tag: "old" },
      expectedClearEpoch: 0,
    });
    // This IS a real commit at the moment it returns — it is briefly current.
    expect(older.status).toBe("committed");
    expect((await tabB.storage.readCurrentCandidate())?.jobId).toBe("job-old");

    const newer = await tabA.storage.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 5,
      document: { tag: "new" },
      expectedClearEpoch: 0,
    });
    expect(newer.status).toBe("committed");

    // ...and a `committed` result is NOT durable-current authority: the older
    // candidate's own successful outcome tells it nothing about what survived.
    await expectNewerIsDurablyCurrent(tabA.storage);
  });

  it.each([
    ["the newer commit issued first", "newer" as const],
    ["the older commit issued first", "older" as const],
  ])(
    "two genuinely overlapping commits leave the newer submission current, with %s",
    async (_label, issuedFirst) => {
      // Real two-instance overlap: both transactions are opened before either
      // resolves, so IndexedDB — not the test — picks the serialization. Repeated
      // rounds sample the scheduler instead of assuming it. The assertions below
      // therefore admit BOTH legal transient outcome sets.
      for (let round = 0; round < 4; round += 1) {
        const dbName = freshDbName();
        const tabA = openTab(dbName);
        const tabB = openTab(dbName);

        const commitNewer = () =>
          tabA.storage.commitCandidate({
            jobId: "job-new",
            submissionOrdinal: 5,
            document: { tag: "new" },
            expectedClearEpoch: 0,
          });
        const commitOlder = () =>
          tabB.storage.commitCandidate({
            jobId: "job-old",
            submissionOrdinal: 3,
            document: { tag: "old" },
            expectedClearEpoch: 0,
          });

        let newer: CandidateCommitOutcome;
        let older: CandidateCommitOutcome;
        if (issuedFirst === "newer") {
          [newer, older] = await Promise.all([commitNewer(), commitOlder()]);
        } else {
          [older, newer] = await Promise.all([commitOlder(), commitNewer()]);
        }

        // The newer submission always ends up committed: it wins outright when it
        // serializes first, and supersedes the older one when it serializes
        // second. The older submission's transient result depends on the order
        // and both values are correct.
        expect(newer.status).toBe("committed");
        expect(["committed", "superseded"]).toContain(older.status);

        await expectNewerIsDurablyCurrent(tabA.storage);
      }
    },
  );

  it("a failure at prior-candidate deletion rolls back the winner put and the pointer write too", async () => {
    const { db, storage } = openTab(freshDbName());
    const older = await storage.commitCandidate({
      jobId: "job-old",
      submissionOrdinal: 3,
      document: { tag: "old" },
      expectedClearEpoch: 0,
    });
    if (older.status !== "committed") return;

    // Fail at the LAST step of the supersession transaction — after the winner
    // row and the pointer have already been written — so this proves rollback of
    // partial work, not merely a failure on the transaction's first operation.
    const failPriorDelete = (primaryKey: string) => {
      if (primaryKey === candidateRosterKey("job-old")) {
        throw new DOMException("simulated failure deleting the prior candidate", "AbortError");
      }
    };
    db.roster.hook("deleting", failPriorDelete);

    await expect(
      storage.commitCandidate({
        jobId: "job-new",
        submissionOrdinal: 5,
        document: { tag: "new" },
        expectedClearEpoch: 0,
      }),
    ).rejects.toThrow();

    db.roster.hook("deleting").unsubscribe(failPriorDelete);

    // Everything the transaction had already done is undone.
    expect(await storage.readCurrentCandidate()).toEqual(older.pointer);
    expect((await storage.readCandidate<{ tag: string }>("job-old"))?.document.tag).toBe("old");
    expect(await storage.readCandidate("job-new")).toBeNull();

    // Negative control, and proof the rolled-back transaction consumed no
    // candidate version: the retry gets the very number the aborted one held.
    const retry = await storage.commitCandidate({
      jobId: "job-new",
      submissionOrdinal: 5,
      document: { tag: "new" },
      expectedClearEpoch: 0,
    });
    expect(retry.status).toBe("committed");
    if (retry.status !== "committed") return;
    expect(retry.pointer.candidateVersion).toBe(older.pointer.candidateVersion + 1);
    expect(await storage.readCandidate("job-old")).toBeNull();
  });
});

describe("clear epoch fencing", () => {
  it("Clear purges the sensitive stores, verifies the purge, and keeps ordinals monotonic", async () => {
    const { storage } = openTab(freshDbName());
    await storage.allocateSubmissionSnapshot({
      ownerId: "owner-a",
      payload: { canonicalYaml: "real nurse identities" },
      expectedClearEpoch: 0,
    });
    await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "candidate" },
      expectedClearEpoch: 0,
    });
    await storage.promoteDocumentToWorking({
      document: { tag: "working" },
      validate: acceptAll,
      expectedWorkingRevision: 1,
      expectedClearEpoch: 0,
    });

    const cleared = await storage.clearRosterData();

    expect(cleared).toEqual({ status: "cleared", epoch: 1 });
    expect(await storage.readWorking()).toBeNull();
    expect(await storage.readCandidate("job-1")).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();
    expect(await storage.readSubmissionSnapshot("owner-a")).toBeNull();
    expect(await storage.getClearEpoch()).toBe(1);

    // Ordinals stay monotonic across a Clear — they carry no personal data, and
    // resetting them would let a pre-Clear submission look newer than it is.
    const next = await storage.allocateSubmissionSnapshot({
      ownerId: "owner-b",
      payload: {},
      expectedClearEpoch: 1,
    });
    expect(next.status === "allocated" && next.snapshot.submissionOrdinal).toBe(2);
  });

  it("a write committed under the NEW epoch survives the Clear that published it", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    await tabA.storage.writeWorkingEdit({
      document: { tag: "pre-clear" },
      expectedRevision: null,
      expectedClearEpoch: 0,
    });

    // Tab A races the Clear: it polls for the new epoch and writes the instant
    // that epoch becomes observable. The epoch is only observable once the purge
    // is part of the same commit, so a write that reports `written` here is a
    // legitimate POST-Clear write — the purge must never sweep it up, and the
    // survivor check must never mistake it for something that outlived the purge.
    const clearing = tabB.storage.clearRosterData();
    const racing = (async () => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const epoch = await tabA.storage.getClearEpoch();
        if (epoch === 0) continue;
        return tabA.storage.writeWorkingEdit({
          document: { tag: "post-clear" },
          expectedRevision: null,
          expectedClearEpoch: epoch,
        });
      }
      throw new Error("the new clear epoch never became observable");
    })();
    const [cleared, written] = await Promise.all([clearing, racing]);

    expect(cleared).toEqual({ status: "cleared", epoch: 1 });
    expect(written).toEqual({ status: "written", revision: 1 });
    expect((await tabB.storage.readWorking<{ tag: string }>())?.document.tag).toBe("post-clear");
  });

  it("a write in flight across a Clear is rejected and cannot repopulate any store", async () => {
    const dbName = freshDbName();
    const tabA = openTab(dbName);
    const tabB = openTab(dbName);

    await tabA.storage.writeWorkingEdit({
      document: { tag: "working" },
      expectedRevision: null,
      expectedClearEpoch: 0,
    });
    // Tab A captured epoch 0 before Clear ran in tab B.
    const capturedEpoch = await tabA.storage.getClearEpoch();
    expect(capturedEpoch).toBe(0);

    expect(await tabB.storage.clearRosterData()).toEqual({ status: "cleared", epoch: 1 });

    // Every mutating entry point is fenced by the epoch, so none of them can put
    // sensitive data back after the verified purge.
    expect(
      await tabA.storage.writeWorkingEdit({
        document: { tag: "stale autosave" },
        expectedRevision: 1,
        expectedClearEpoch: capturedEpoch,
      }),
    ).toEqual({ status: "stale-epoch", currentEpoch: 1 });
    expect(
      await tabA.storage.commitCandidate({
        jobId: "job-late",
        submissionOrdinal: 9,
        document: { tag: "stale capture" },
        expectedClearEpoch: capturedEpoch,
      }),
    ).toEqual({ status: "stale-epoch", currentEpoch: 1 });
    expect(
      await tabA.storage.allocateSubmissionSnapshot({
        ownerId: "owner-late",
        payload: { canonicalYaml: "real nurse identities" },
        expectedClearEpoch: capturedEpoch,
      }),
    ).toEqual({ status: "stale-epoch", currentEpoch: 1 });
    expect(
      await tabA.storage.promoteDocumentToWorking({
        document: { tag: "stale import" },
        validate: acceptAll,
        expectedWorkingRevision: 1,
        expectedClearEpoch: capturedEpoch,
      }),
    ).toEqual({ status: "stale-epoch", currentEpoch: 1 });

    // Nothing landed — the stores are still empty after every stale attempt.
    expect(await tabB.storage.readWorking()).toBeNull();
    expect(await tabB.storage.readCandidate("job-late")).toBeNull();
    expect(await tabB.storage.readCurrentCandidate()).toBeNull();
    expect(await tabB.storage.readSubmissionSnapshot("owner-late")).toBeNull();
    expect(await tabB.storage.listSubmissionOrdinals()).toEqual([]);

    // Negative control: the same writes re-issued under the CURRENT epoch land,
    // so the rejections above were the epoch fence, not a broken write path.
    expect(
      await tabA.storage.writeWorkingEdit({
        document: { tag: "fresh" },
        expectedRevision: null,
        expectedClearEpoch: 1,
      }),
    ).toEqual({ status: "written", revision: 1 });
    expect(
      (
        await tabA.storage.commitCandidate({
          jobId: "job-late",
          submissionOrdinal: 9,
          document: { tag: "fresh" },
          expectedClearEpoch: 1,
        })
      ).status,
    ).toBe("committed");
  });
});

// ---------------------------------------------------------------------------
// The visit fence, INSIDE the transaction
// ---------------------------------------------------------------------------
//
// A caller checking "am I still wanted?" before calling `commitCandidate` is not
// the same as the transaction checking it. The method invocation and the write are
// two different moments, and a route exit landing between them used to still move
// the pointer and auto-fill a proven-empty working slot for a user who had gone.
// `isAbandoned` is evaluated inside the transaction, immediately before the first
// write, which is the only place the answer cannot go stale.

describe("commitCandidate — the caller's visit fence", () => {
  it("writes NOTHING when the predicate answers true inside the transaction", async () => {
    const { storage } = openTab(freshDbName());

    const outcome = await storage.commitCandidate({
      jobId: "job-abandoned",
      submissionOrdinal: 1,
      document: { tag: "abandoned" },
      expectedClearEpoch: await storage.getClearEpoch(),
      isAbandoned: () => true,
    });

    expect(outcome).toEqual({ status: "abandoned" });
    // Every write the transaction would have made, proven absent one at a time.
    expect(await storage.readCandidate("job-abandoned")).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();
    expect(await storage.readWorking()).toBeNull();
  });

  it("NEGATIVE CONTROL: the same call commits when the predicate answers false", async () => {
    const { storage } = openTab(freshDbName());

    const outcome = await storage.commitCandidate({
      jobId: "job-wanted",
      submissionOrdinal: 1,
      document: { tag: "wanted" },
      expectedClearEpoch: await storage.getClearEpoch(),
      isAbandoned: () => false,
    });

    expect(outcome.status).toBe("committed");
    expect(await storage.readCurrentCandidate()).toMatchObject({ jobId: "job-wanted" });
    // ...and the proven-empty working slot was filled, which is exactly the write
    // an abandoned commit must not perform.
    expect(await storage.readWorking()).not.toBeNull();
  });

  it("an ABANDONED commit spends no candidate version, so a later real one is not skipped", async () => {
    // The ordinal/version allocation sits after the fence on purpose: a refusal
    // must cost nothing, exactly like a superseded commit.
    const { storage } = openTab(freshDbName());
    const epoch = await storage.getClearEpoch();

    await storage.commitCandidate({
      jobId: "job-abandoned",
      submissionOrdinal: 1,
      document: { tag: "x" },
      expectedClearEpoch: epoch,
      isAbandoned: () => true,
    });
    const real = await storage.commitCandidate({
      jobId: "job-real",
      submissionOrdinal: 1,
      document: { tag: "y" },
      expectedClearEpoch: epoch,
      isAbandoned: () => false,
    });

    expect(real.status).toBe("committed");
    if (real.status !== "committed") throw new Error("unreachable");
    expect(real.pointer.candidateVersion).toBe(1);
  });

  // THE ADJACENCY, not merely the presence, of the fence.
  //
  // Every case above answers the predicate the same way for the whole call, so any
  // of them would pass with the check sitting anywhere in the transaction. That is
  // how the fence shipped one line too high: above the awaited
  // `nextCandidateVersion` read, leaving exactly one suspension in which a
  // revocation could land after the predicate had already said "still wanted".
  //
  // These two park that read for real — `Dexie.waitFor` is the supported way to
  // await a non-Dexie promise inside a transaction, so the transaction stays alive
  // and this is a genuine suspension rather than a simulated one — and differ only
  // in whether the visit ends while it is parked.
  function parkVersionRead(db: ScenarioPersistenceDb) {
    const gate = Promise.withResolvers<void>();
    const realGet = db.meta.get.bind(db.meta);
    let entered = false;
    const table = db.meta as unknown as { get: (key: string) => Promise<unknown> };
    table.get = async (key: string) => {
      if (key === "nextCandidateVersion" && !entered) {
        entered = true;
        await Dexie.waitFor(gate.promise);
      }
      return realGet(key);
    };
    return {
      release: () => gate.resolve(),
      restore: () => {
        table.get = realGet;
      },
      async entered() {
        for (let i = 0; i < 200 && !entered; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(entered, "the version read was never reached").toBe(true);
      },
    };
  }

  it("a revocation landing DURING the post-predicate version read still writes nothing", async () => {
    const { db, storage } = openTab(freshDbName());
    const epoch = await storage.getClearEpoch();
    const park = parkVersionRead(db);

    // Still wanted when the commit starts. Nothing about this call is abandoned
    // until the park below, which is the whole point: a predicate that answers
    // `true` from the outset cannot tell a fence at the write from a fence three
    // awaits earlier.
    let abandoned = false;
    const commit = storage.commitCandidate({
      jobId: "job-parked",
      submissionOrdinal: 1,
      document: { tag: "parked" },
      expectedClearEpoch: epoch,
      isAbandoned: () => abandoned,
    });

    await park.entered();
    // The user leaves while the read is in flight, then it completes.
    abandoned = true;
    park.release();

    expect(await commit).toEqual({ status: "abandoned" });
    park.restore();

    // Every write the transaction would have made, proven absent one at a time.
    expect(await storage.readCandidate("job-parked")).toBeNull();
    expect(await storage.readCurrentCandidate()).toBeNull();
    expect(await storage.readWorking()).toBeNull();
    // ...including the counter: an aborted commit spends no version, so the next
    // real one still gets the first.
    const later = await storage.commitCandidate({
      jobId: "job-after",
      submissionOrdinal: 2,
      document: { tag: "after" },
      expectedClearEpoch: epoch,
      isAbandoned: () => false,
    });
    expect(later.status).toBe("committed");
    if (later.status !== "committed") throw new Error("unreachable");
    expect(later.pointer.candidateVersion).toBe(1);
  });

  it("NEGATIVE CONTROL: the same parked read commits in full when the visit never ends", async () => {
    // Without this, the test above would pass just as well against a commit that
    // aborts whenever its version read is slow.
    const { db, storage } = openTab(freshDbName());
    const park = parkVersionRead(db);

    const commit = storage.commitCandidate({
      jobId: "job-stayed",
      submissionOrdinal: 1,
      document: { tag: "stayed" },
      expectedClearEpoch: await storage.getClearEpoch(),
      isAbandoned: () => false,
    });

    await park.entered();
    park.release();

    const outcome = await commit;
    park.restore();

    expect(outcome.status).toBe("committed");
    expect(await storage.readCurrentCandidate()).toMatchObject({
      jobId: "job-stayed",
      candidateVersion: 1,
    });
    expect(await storage.readWorking()).not.toBeNull();
  });

  it("omitting the predicate leaves the commit exactly as it was", async () => {
    // Optional by design: the many callers that have no visit to speak of must not
    // have to opt out of a fence they cannot answer.
    const { storage } = openTab(freshDbName());
    const outcome = await storage.commitCandidate({
      jobId: "job-plain",
      submissionOrdinal: 1,
      document: { tag: "plain" },
      expectedClearEpoch: await storage.getClearEpoch(),
    });
    expect(outcome.status).toBe("committed");
  });
});
