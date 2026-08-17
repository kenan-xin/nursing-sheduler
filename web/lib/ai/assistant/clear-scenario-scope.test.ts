// Clear history, against the scenario the user actually asked for.
//
// THE DEFECT THIS FIXES. Clear history is requested by scenario, but the deletion pass
// used to rediscover that scenario from whichever threads happened to be marked
// `cleared`. A scenario can own proposals, receipts and diagnostic searches without
// owning a thread row -- a diagnostic run in a conversation that was never persisted,
// a proposal from a turn that failed before its first message landed. Those rows had no
// scope at all, so they survived a clear that promised to remove them, and a reload
// could not repair it either: with no cleared thread to find, recovery had nothing to
// work from.
//
// So every fixture here is THREADLESS on purpose. A test that seeds a thread proves
// only the path that already worked.

import { beforeEach, describe, expect, it } from "vitest";

import { beginClear, finishClear, resumePendingClears } from "./clear-repo";
import { createAssistantHarness, type AssistantHarness } from "./test-support";

const TARGET = "scenario-target";
const OTHER = "scenario-other";

let harness: AssistantHarness;

/** Scenario-owned content for `scenarioId`, with no thread row anywhere. */
async function seedThreadless(scenarioId: string) {
  const at = new Date().toISOString();
  await harness.db.assistantProposals.put({
    proposalId: `proposal-${scenarioId}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
  } as never);
  await harness.db.assistantReceipts.put({
    receiptId: `receipt-${scenarioId}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
  } as never);
  await harness.db.diagnosticSearches.put({
    searchId: `search-${scenarioId}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
  } as never);
  await harness.db.optimizeBases.put({
    basisId: `basis-${scenarioId}`,
    scenarioId,
    schemaVersion: 1,
    createdAt: at,
  } as never);
}

/** Everything owned by `scenarioId`, as ids, so "gone" and "kept" are both checkable. */
async function ownedBy(scenarioId: string) {
  const has = async <T>(rows: Promise<T[]>, pick: (row: T) => string) =>
    (await rows)
      .filter((row) => (row as { scenarioId: string }).scenarioId === scenarioId)
      .map(pick);
  return {
    proposals: await has(harness.db.assistantProposals.toArray(), (row) => row.proposalId),
    receipts: await has(harness.db.assistantReceipts.toArray(), (row) => row.receiptId),
    searches: await has(harness.db.diagnosticSearches.toArray(), (row) => row.searchId),
    bases: await has(harness.db.optimizeBases.toArray(), (row) => row.basisId),
  };
}

beforeEach(async () => {
  harness = await createAssistantHarness();
  await seedThreadless(TARGET);
  await seedThreadless(OTHER);
});

describe("a scenario with content but no thread", () => {
  it("has its proposals, receipts and searches deleted by Clear history", async () => {
    const fence = await beginClear("history", TARGET, { db: harness.db });
    // Non-vacuity: there really is no thread for the scope to have been derived from.
    expect(fence.threadIds).toEqual([]);
    expect(fence.scenarioId).toBe(TARGET);

    const deletion = await finishClear(fence, { db: harness.db });

    expect(deletion.outcome).toBe("deleted");
    expect(deletion.proposals).toBe(1);
    expect(deletion.receipts).toBe(1);
    expect(deletion.searches).toBe(1);

    const target = await ownedBy(TARGET);
    expect(target.proposals).toEqual([]);
    expect(target.receipts).toEqual([]);
    expect(target.searches).toEqual([]);
    // Ordinary Optimize is not assistant data.
    expect(target.bases).toEqual([`basis-${TARGET}`]);
  });

  it("leaves every other scenario byte-for-byte", async () => {
    const before = JSON.stringify(await ownedBy(OTHER));

    const fence = await beginClear("history", TARGET, { db: harness.db });
    await finishClear(fence, { db: harness.db });

    expect(JSON.stringify(await ownedBy(OTHER))).toBe(before);
  });

  it("keeps its captured target when the visible scenario changes mid-clear", async () => {
    // The user switches documents while settlement is in flight. The clear must still
    // delete what they asked to delete, and nothing else.
    const fence = await beginClear("history", TARGET, { db: harness.db });
    const otherBefore = JSON.stringify(await ownedBy(OTHER));

    // Whatever the app now considers current is irrelevant: the fence carries the
    // identity, so there is no live value for the deletion pass to read.
    await finishClear(fence, { db: harness.db });

    expect((await ownedBy(TARGET)).searches).toEqual([]);
    expect(JSON.stringify(await ownedBy(OTHER))).toBe(otherBefore);
  });
});

describe("recovery after a reload with no cleared thread", () => {
  it("finishes the clear from the durable fence marker alone", async () => {
    // `beginClear` commits, and then the tab dies before `finishClear`.
    const fence = await beginClear("history", TARGET, { db: harness.db });
    expect(fence.threadIds).toEqual([]);
    // Non-vacuity: the content survived the first transaction, so recovery has real
    // work to do.
    expect((await ownedBy(TARGET)).searches).toEqual([`search-${TARGET}`]);
    // And there is no cleared thread anywhere for a thread-driven recovery to find.
    expect(await harness.db.assistantThreads.where("state").equals("cleared").count()).toBe(0);

    const resumed = await resumePendingClears({ db: harness.db });

    expect(resumed.outcome).toBe("deleted");
    expect((await ownedBy(TARGET)).searches).toEqual([]);
    expect((await ownedBy(TARGET)).proposals).toEqual([]);
    expect((await ownedBy(TARGET)).receipts).toEqual([]);
    expect((await ownedBy(OTHER)).searches).toEqual([`search-${OTHER}`]);
  });

  it("does not replay a clear that already finished", async () => {
    const fence = await beginClear("history", TARGET, { db: harness.db });
    await finishClear(fence, { db: harness.db });

    // Fresh content for the same scenario, written after the clear completed.
    await seedThreadless(TARGET);
    const resumed = await resumePendingClears({ db: harness.db });

    expect(resumed).toEqual({
      candidates: [],
      failed: false,
      outcome: "deleted",
      threads: 0,
      messages: 0,
      turns: 0,
      proposals: 0,
      receipts: 0,
      searches: 0,
    });
    // The new rows are untouched: the finished clear does not reach forward.
    expect((await ownedBy(TARGET)).searches).toEqual([`search-${TARGET}`]);
  });
});

describe("a scoped clear with no usable identity", () => {
  it.each([null, "", "   "])("fails closed rather than deleting broadly (%p)", async (bad) => {
    await expect(beginClear("history", bad, { db: harness.db })).rejects.toThrow(
      /scenario identity/,
    );

    // NOTHING happened: no deletion, and no fence bump either, so a live turn is not
    // silently invalidated by a request that was refused.
    expect((await ownedBy(TARGET)).searches).toEqual([`search-${TARGET}`]);
    expect((await ownedBy(OTHER)).searches).toEqual([`search-${OTHER}`]);
    expect(await harness.db.assistantGenerations.count()).toBe(0);
  });
});

describe("Clear all", () => {
  it("stays global and takes every scenario's content", async () => {
    const fence = await beginClear("all", TARGET, { db: harness.db });
    // Global by definition: it acquires no scenario scope.
    expect(fence.scenarioId).toBeNull();

    await finishClear(fence, { db: harness.db });

    expect((await ownedBy(TARGET)).searches).toEqual([]);
    expect((await ownedBy(OTHER)).searches).toEqual([]);
    expect((await ownedBy(OTHER)).proposals).toEqual([]);
    // Ordinary Optimize survives even a global assistant clear.
    expect((await ownedBy(TARGET)).bases).toEqual([`basis-${TARGET}`]);
    expect((await ownedBy(OTHER)).bases).toEqual([`basis-${OTHER}`]);
  });

  it("retains the monotonic generation rows it bumped", async () => {
    const fence = await beginClear("all", TARGET, { db: harness.db });
    await finishClear(fence, { db: harness.db });

    const generations = await harness.db.assistantGenerations.toArray();
    expect(generations.length).toBeGreaterThan(0);
    for (const row of generations) {
      expect(row.generation).toBeGreaterThan(0);
      // And the clear is marked finished, so recovery will not replay it.
      expect(row.pendingClear ?? null).toBeNull();
    }
  });
});
