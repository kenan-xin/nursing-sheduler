// F2 write-ahead submission-snapshot tests against a REAL IndexedDB
// (fake-indexeddb installs the globals), so ordinal allocation, immutability, and
// epoch fencing are exercised through F1's actual transactions rather than a
// hand-written double that could agree with a wrong mental model.
//
// Every hazard case carries a negative control: the same code path is shown to
// succeed when the hazard is absent, so a test cannot pass vacuously.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { createRosterStorageForDb, type RosterStorage } from "@/lib/store/roster-storage";
import {
  buildStagedSubmission,
  isStagedSubmission,
  purgeSubmissionSnapshot,
  readStagedSubmissionSnapshot,
  stageSubmissionSnapshot,
  type SubmissionSnapshotStore,
} from "./submission-snapshot";
import { ROSTER_SUBMISSION_VERSION } from "./roster-candidate-builder";

let dbCounter = 0;
function freshDbName() {
  return `submission-snapshot-test-${dbCounter++}`;
}

/** One "tab": its own Dexie instance over the given database name. */
function openTab(databaseName: string): RosterStorage {
  const db = new ScenarioPersistenceDb(databaseName);
  return createRosterStorageForDb(() => db);
}

const payload = (yaml = "people: [P1]") =>
  buildStagedSubmission({
    canonicalYaml: yaml,
    reverseMap: [["P1", "Alice"]],
    // The version comes from the ONE composition module — F2 owns no version
    // authority, so nothing here asserts a literal version string.
    schemaVersion: ROSTER_SUBMISSION_VERSION,
  });

/**
 * The staged snapshot, or null when the read PROVED there is nothing consumable.
 * A failed read is deliberately NOT collapsed into null here — the tests that care
 * about that distinction assert the outcome directly.
 */
async function readProven(ownerId: string, store: SubmissionSnapshotStore) {
  const outcome = await readStagedSubmissionSnapshot(ownerId, store);
  if (outcome.status === "unavailable")
    throw new Error(`unexpected failed read: ${outcome.message}`);
  return outcome.status === "found" ? outcome.snapshot : null;
}

/** A store whose every method rejects — IndexedDB denied or quota-exhausted. */
function deniedStore(): SubmissionSnapshotStore {
  const deny = () => Promise.reject(new Error("QuotaExceededError"));
  return {
    getClearEpoch: deny,
    allocateSubmissionSnapshot: deny,
    readSubmissionSnapshot: deny,
    deleteSubmissionSnapshot: deny,
  } as unknown as SubmissionSnapshotStore;
}

describe("stageSubmissionSnapshot — write-ahead allocation", () => {
  it("allocates a monotonic ordinal and writes the exact submission immutably", async () => {
    const store = openTab(freshDbName());

    const first = await stageSubmissionSnapshot({ ownerId: "own-1", payload: payload("a"), store });
    const second = await stageSubmissionSnapshot({
      ownerId: "own-2",
      payload: payload("b"),
      store,
    });

    expect(first).toEqual({ status: "staged", snapshotRef: "own-1", submissionOrdinal: 1 });
    expect(second).toEqual({ status: "staged", snapshotRef: "own-2", submissionOrdinal: 2 });

    const read = await readProven("own-1", store);
    expect(read?.submissionOrdinal).toBe(1);
    expect(read?.payload.canonicalYaml).toBe("a");
    expect(read?.payload.reverseMap).toEqual([["P1", "Alice"]]);
  });

  it("two tabs allocate unique, monotonic ordinals over one database", async () => {
    const name = freshDbName();
    const tabA = openTab(name);
    const tabB = openTab(name);

    const [a, b, c] = await Promise.all([
      stageSubmissionSnapshot({ ownerId: "own-a", payload: payload(), store: tabA }),
      stageSubmissionSnapshot({ ownerId: "own-b", payload: payload(), store: tabB }),
      stageSubmissionSnapshot({ ownerId: "own-c", payload: payload(), store: tabA }),
    ]);

    const ordinals = [a, b, c].map((state) =>
      state.status === "staged" ? state.submissionOrdinal : -1,
    );
    expect([...ordinals].sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it("DEGRADES rather than throwing when storage is denied — the POST must not be gated", async () => {
    const state = await stageSubmissionSnapshot({
      ownerId: "own-x",
      payload: payload(),
      store: deniedStore(),
    });
    expect(state).toEqual({ status: "unavailable", reason: "snapshot_persist_failed" });
  });

  it("negative control: the same call against a healthy store stages successfully", async () => {
    const state = await stageSubmissionSnapshot({
      ownerId: "own-x",
      payload: payload(),
      store: openTab(freshDbName()),
    });
    expect(state.status).toBe("staged");
  });

  it("a repeated owner id degrades instead of adopting bytes it cannot prove are ours", async () => {
    const store = openTab(freshDbName());
    await stageSubmissionSnapshot({ ownerId: "own-dup", payload: payload("first"), store });

    // Snapshots are write-once. The stored YAML is NOT provably the document this
    // second call is about to submit, so adopting its ordinal could de-anonymize a
    // result against the wrong submission.
    const again = await stageSubmissionSnapshot({
      ownerId: "own-dup",
      payload: payload("second"),
      store,
    });
    expect(again).toEqual({ status: "unavailable", reason: "snapshot_persist_failed" });
    // And the original is untouched — the conflict consumed nothing.
    expect((await readProven("own-dup", store))?.payload.canonicalYaml).toBe("first");
    expect(await store.listSubmissionOrdinals()).toEqual([1]);
  });

  it("a Clear committed before the write degrades the run (nothing is staged)", async () => {
    const store = openTab(freshDbName());
    // Advance the epoch, then present the pre-Clear epoch through a store whose
    // `getClearEpoch` lies about the current value.
    await store.clearRosterData();
    const staleEpochStore: SubmissionSnapshotStore = {
      ...store,
      getClearEpoch: async () => 0,
    };

    const state = await stageSubmissionSnapshot({
      ownerId: "own-clear",
      payload: payload(),
      store: staleEpochStore,
    });
    expect(state).toEqual({ status: "unavailable", reason: "snapshot_persist_failed" });
    expect(await store.listSubmissionOrdinals()).toEqual([]);
  });
});

describe("readStagedSubmissionSnapshot — fail-closed consumption", () => {
  it("returns null for an absent snapshot (a crash cut, or one already consumed)", async () => {
    const store = openTab(freshDbName());
    expect(await readProven("never-staged", store)).toBeNull();
  });

  it("returns null for a structurally broken envelope rather than half-consuming it", async () => {
    const store = openTab(freshDbName());
    await store.allocateSubmissionSnapshot({
      ownerId: "own-broken",
      payload: { ...payload(), canonicalYaml: "" },
      expectedClearEpoch: await store.getClearEpoch(),
    });
    expect(await readProven("own-broken", store)).toBeNull();
  });

  it("negative control: a well-formed row IS consumable", async () => {
    const store = openTab(freshDbName());
    await store.allocateSubmissionSnapshot({
      ownerId: "own-ok",
      payload: payload(),
      expectedClearEpoch: await store.getClearEpoch(),
    });
    expect(await readProven("own-ok", store)).not.toBeNull();
  });

  it("carries an UNKNOWN submission version through verbatim — F2 owns no version authority", async () => {
    // The version is F3's contract, enforced inside `assembleRosterDocument`. If F2
    // second-guessed it here, a snapshot staged by a newer build would be silently
    // dropped by the OLD half of the system instead of failing at the assembler,
    // and the two version authorities could drift apart unnoticed.
    const store = openTab(freshDbName());
    const foreign = { ...payload(), schemaVersion: "roster-submission/from-the-future" };
    await stageSubmissionSnapshot({ ownerId: "own-future", payload: foreign, store });

    const read = await readProven("own-future", store);
    expect(read?.payload.schemaVersion).toBe("roster-submission/from-the-future");
  });

  it("rejects envelopes that are structurally unusable by the assembler", () => {
    expect(isStagedSubmission({ ...payload(), canonicalYaml: "" })).toBe(false);
    expect(isStagedSubmission({ ...payload(), schemaVersion: "" })).toBe(false);
    expect(isStagedSubmission({ ...payload(), reverseMap: "nope" })).toBe(false);
    expect(isStagedSubmission({ ...payload(), reverseMap: [["P1"]] })).toBe(false);
    expect(isStagedSubmission({ ...payload(), reverseMap: [[1, "Alice"]] })).toBe(false);
    expect(isStagedSubmission(null)).toBe(false);
    expect(isStagedSubmission([payload()])).toBe(false);
    // Negative control: the real envelope passes.
    expect(isStagedSubmission(payload())).toBe(true);
  });

  it("a FAILED read is reported as unavailable, never as proven absence", async () => {
    // The distinction the whole cleanup-authority chain rests on: a rejected read
    // proves nothing about the snapshot, so it must not look like "there is nothing
    // here" — that is what would hand out a vacuous-fence DELETE token.
    const outcome = await readStagedSubmissionSnapshot("own", deniedStore());
    expect(outcome.status).toBe("unavailable");

    // Negative control: a genuinely absent row IS proven absence.
    const store = openTab(freshDbName());
    expect((await readStagedSubmissionSnapshot("own-nothing", store)).status).toBe("absent");
    // ...and a present-but-unusable row is its own proven verdict.
    await store.allocateSubmissionSnapshot({
      ownerId: "own-junk",
      payload: { nope: true },
      expectedClearEpoch: await store.getClearEpoch(),
    });
    expect((await readStagedSubmissionSnapshot("own-junk", store)).status).toBe("unusable");
  });
});

describe("purgeSubmissionSnapshot — proven authority only", () => {
  it("deletes under a proven authority and reports which one was presented", async () => {
    const store = openTab(freshDbName());
    await stageSubmissionSnapshot({ ownerId: "own-1", payload: payload(), store });

    const result = await purgeSubmissionSnapshot({
      ownerId: "own-1",
      expectedClearEpoch: await store.getClearEpoch(),
      authority: "candidate-committed",
      store,
    });

    expect(result).toEqual({ authority: "candidate-committed", outcome: { status: "deleted" } });
    expect(await readProven("own-1", store)).toBeNull();
  });

  it("a purge started before a Clear is fenced off instead of acting post-purge", async () => {
    const store = openTab(freshDbName());
    await stageSubmissionSnapshot({ ownerId: "own-1", payload: payload(), store });
    const staleEpoch = await store.getClearEpoch();
    await store.clearRosterData();

    const result = await purgeSubmissionSnapshot({
      ownerId: "own-1",
      expectedClearEpoch: staleEpoch,
      authority: "candidate-dismissed",
      store,
    });
    expect(result.outcome.status).toBe("stale-epoch");
  });

  it("a failing delete is reported, never thrown — a retained snapshot is harmless", async () => {
    const result = await purgeSubmissionSnapshot({
      ownerId: "own-1",
      expectedClearEpoch: 0,
      authority: "cleared",
      store: deniedStore(),
    });
    expect(result.outcome.status).toBe("error");
  });

  it("CRASH CUT: a snapshot with no session record is retained — there is no sweep or expiry", async () => {
    // A crash between the snapshot write and the session staging leaves an
    // orphan-LOOKING snapshot. Nothing in this module may reclaim it: tab-scoped
    // state cannot prove origin-wide orphanhood, and a wrong delete destroys
    // another tab's in-flight submission. Reads must therefore be non-destructive
    // and repeatable, and only Clear (or a proven per-run outcome) may retire it.
    const store = openTab(freshDbName());
    await stageSubmissionSnapshot({ ownerId: "own-orphan", payload: payload("orphan"), store });

    for (let i = 0; i < 3; i += 1) {
      const read = await readProven("own-orphan", store);
      expect(read?.payload.canonicalYaml).toBe("orphan");
    }
    // Reading OTHER owners (a fresh tab probing its own record) never touches it.
    await readProven("own-someone-else", store);
    expect(await readProven("own-orphan", store)).not.toBeNull();

    // Only a verified Clear reclaims it.
    expect((await store.clearRosterData()).status).toBe("cleared");
    expect(await readProven("own-orphan", store)).toBeNull();
  });

  it("TAB ISOLATION: one tab's staging snapshot survives another tab's whole lifecycle", async () => {
    // The cross-tab safety property: tab B stages, captures, commits, and purges
    // its OWN snapshot; tab A's in-flight submission snapshot is untouched, because
    // nothing in this module infers orphanhood from tab-scoped state.
    const name = freshDbName();
    const tabA = openTab(name);
    const tabB = openTab(name);

    await stageSubmissionSnapshot({ ownerId: "own-A", payload: payload("A"), store: tabA });
    await stageSubmissionSnapshot({ ownerId: "own-B", payload: payload("B"), store: tabB });

    await purgeSubmissionSnapshot({
      ownerId: "own-B",
      expectedClearEpoch: await tabB.getClearEpoch(),
      authority: "candidate-committed",
      store: tabB,
    });

    expect(await readProven("own-B", tabA)).toBeNull();
    const survivor = await readProven("own-A", tabB);
    expect(survivor?.payload.canonicalYaml).toBe("A");
  });
});
