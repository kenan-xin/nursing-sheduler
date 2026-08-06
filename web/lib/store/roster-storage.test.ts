// F1 storage-foundation tests against a real IndexedDB implementation
// (fake-indexeddb installs the globals). These are deliberately discriminating:
// the ordering, rollback and fencing cases each carry a negative control so they
// cannot pass vacuously — the control proves the same code path DOES commit when
// the hazard is absent.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ScenarioPersistenceDb } from "./dexie-storage";
import {
  candidateRosterKey,
  createRosterStorageForDb,
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

describe("working roster promotion", () => {
  it("promotes a candidate, keeping the candidate as the durable latest result", async () => {
    const { storage } = openTab(freshDbName());
    await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document: { tag: "candidate" },
      expectedClearEpoch: 0,
    });

    const promoted = await storage.promoteCandidateToWorking({
      jobId: "job-1",
      validate: acceptAll,
      expectedWorkingRevision: null,
      expectedClearEpoch: 0,
    });

    expect(promoted).toEqual({ status: "promoted", revision: 1 });
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
    expect(await storage.readWorking()).toBeNull();
  });
});

describe("revisioned compare-and-swap working writes", () => {
  it("accepts the expected revision and rejects a stale one", async () => {
    const { storage } = openTab(freshDbName());

    const created = await storage.writeWorking({
      document: { edits: [] },
      expectedRevision: null,
      expectedClearEpoch: 0,
    });
    expect(created).toEqual({ status: "written", revision: 1 });

    const updated = await storage.writeWorking({
      document: { edits: [1] },
      expectedRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(updated).toEqual({ status: "written", revision: 2 });

    // A writer still holding revision 1 loses; the stored document is untouched.
    const conflicted = await storage.writeWorking({
      document: { edits: ["stale"] },
      expectedRevision: 1,
      expectedClearEpoch: 0,
    });
    expect(conflicted).toEqual({ status: "conflict", currentRevision: 2 });
    expect(await storage.readWorking()).toMatchObject({ document: { edits: [1] }, revision: 2 });
  });

  it("a first write expecting no row loses to a row that already exists", async () => {
    const { storage } = openTab(freshDbName());
    await storage.writeWorking({
      document: { tag: "a" },
      expectedRevision: null,
      expectedClearEpoch: 0,
    });

    expect(
      await storage.writeWorking({
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

    await tabA.storage.writeWorking({
      document: { edits: ["existing"] },
      expectedRevision: null,
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
      await tabB.storage.writeWorking({
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
    // Crucially, the STALE document was not written to working.
    expect(await tabB.storage.readWorking()).toBeNull();
    expect((await tabB.storage.readCandidate<{ tag: string }>("job-1"))?.document.tag).toBe("B");

    // Negative control: promoting what is actually stored now succeeds, and it
    // is the recreated document that lands.
    expect(
      await tabA.storage.promoteCandidateToWorking({
        jobId: "job-1",
        validate: acceptAll,
        expectedWorkingRevision: null,
        expectedClearEpoch: 0,
      }),
    ).toEqual({ status: "promoted", revision: 1 });
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
    await storage.writeWorking({
      document: { tag: "working" },
      expectedRevision: null,
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

    await tabA.storage.writeWorking({
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
        return tabA.storage.writeWorking({
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

    await tabA.storage.writeWorking({
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
      await tabA.storage.writeWorking({
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
      await tabA.storage.writeWorking({
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
