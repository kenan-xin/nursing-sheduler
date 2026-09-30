// Recent schedules (plq5 P1): list order, metadata writes, delete cleanup and the
// 30-unpinned limit, against a real IndexedDB.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { RECENT_SCHEDULES_LIMIT } from "@/lib/scenario";
import { isRepositoryError } from "./errors";
import { LEASE_TTL_MS } from "./leases";
import { migrateLegacyScenarioRecord } from "./migration";
import { createHarness, sampleScenario, type Harness } from "./test-support";
import { scenarioGenerationScope, type LeaseOwner } from "./types";

/** Load a non-blank schedule as `tabId`, moving the clock so `updatedAt` orders. */
async function load(h: Harness, tabId: string, currentOwner?: LeaseOwner | null, month = "04") {
  h.clock.advance(1000);
  const selection = await h.repo.selectOrSwitchScenario({
    tabId,
    target: {
      kind: "load",
      scenario: { ...sampleScenario(`2026-${month}-01`), rangeEnd: `2026-${month}-28` },
    },
    ...(currentOwner ? { currentOwner } : {}),
  });
  return selection;
}

describe("listSchedules", () => {
  it("lists newest first, keeps every past schedule, and hides blank ones not open here", async () => {
    const h = createHarness();
    const a = await load(h, "tab-1");
    const b = await load(h, "tab-1", a.owner, "05");
    h.clock.advance(1000);
    const blank = await h.repo.selectOrSwitchScenario({
      tabId: "tab-1",
      target: { kind: "new" },
      currentOwner: b.owner!,
    });

    const rows = await h.repo.listSchedules({ tabId: "tab-1" });
    expect(rows.map((row) => row.scenarioId)).toEqual([
      blank.envelope.scenarioId,
      b.envelope.scenarioId,
      a.envelope.scenarioId,
    ]);
    expect(rows[0]).toMatchObject({ blank: true, title: null });
    expect(rows[1]!.autoName).toBe("Untitled ward · 1 May to 28 May 2026");

    // Another tab does not see this tab's blank schedule.
    const other = await h.repo.listSchedules({ tabId: "tab-2" });
    expect(other.map((row) => row.scenarioId)).not.toContain(blank.envelope.scenarioId);
    expect(other.find((row) => row.scenarioId === blank.envelope.scenarioId)).toBeUndefined();
    expect(other[0]).toMatchObject({ scenarioId: b.envelope.scenarioId, heldByOtherTab: false });
  });

  it("marks a schedule another live tab holds", async () => {
    const h = createHarness();
    const a = await load(h, "tab-1");
    const rows = await h.repo.listSchedules({ tabId: "tab-2" });
    expect(rows).toMatchObject([{ scenarioId: a.envelope.scenarioId, heldByOtherTab: true }]);
    h.clock.advance(LEASE_TTL_MS + 1);
    expect((await h.repo.listSchedules({ tabId: "tab-2" }))[0]!.heldByOtherTab).toBe(false);
  });
});

describe("rename and pin", () => {
  it("are metadata-only: recordRevision moves, documentRevision and updatedAt do not", async () => {
    const h = createHarness();
    const a = await load(h, "tab-1");
    const before = await h.repo.read(a.envelope.scenarioId);

    await h.repo.renameSchedule({ scenarioId: a.envelope.scenarioId, title: "  Ward 3 Nov  " });
    await h.repo.setSchedulePinned({ scenarioId: a.envelope.scenarioId, pinned: true });
    const after = await h.repo.read(a.envelope.scenarioId);
    expect(after).toMatchObject({ title: "Ward 3 Nov", pinned: true });
    expect(after.recordRevision).toBe(before.recordRevision + 2);
    expect(after.documentRevision).toBe(before.documentRevision);
    expect(after.updatedAt).toBe(before.updatedAt);

    // Clearing the name brings back the auto-name; unpinning removes the flag.
    await h.repo.renameSchedule({ scenarioId: a.envelope.scenarioId, title: "   " });
    await h.repo.setSchedulePinned({ scenarioId: a.envelope.scenarioId, pinned: false });
    const cleared = await h.repo.read(a.envelope.scenarioId);
    expect("title" in cleared).toBe(false);
    expect("pinned" in cleared).toBe(false);
  });

  it("survives the owner's next content commit", async () => {
    const h = createHarness();
    const a = await load(h, "tab-1");
    await h.repo.renameSchedule({ scenarioId: a.envelope.scenarioId, title: "Kept" });
    await h.repo.commit({
      owner: a.owner!,
      expectedScenarioId: a.envelope.scenarioId,
      expectedDocumentRevision: 1,
      command: { type: "patch_scenario", patch: { rangeEnd: "2026-04-29" } },
    });
    expect((await h.repo.read(a.envelope.scenarioId)).title).toBe("Kept");
  });
});

describe("deleteSchedule", () => {
  it("removes the schedule's rows from every table and bumps its assistant fence", async () => {
    const h = createHarness();
    const a = await load(h, "tab-1");
    const id = a.envelope.scenarioId;
    // Some history, and assistant rows keyed to it (shape-light: only keys matter here).
    await h.repo.commit({
      owner: a.owner!,
      expectedScenarioId: id,
      expectedDocumentRevision: 1,
      command: { type: "patch_scenario", patch: { rangeEnd: "2026-04-29" } },
    });
    await h.repo.undo({ owner: a.owner!, expectedDocumentRevision: 2 });
    await h.db.assistantThreads.put({ threadId: "t1", scenarioId: id, state: "active" } as never);
    await h.db.assistantTurns.put({ turnId: "u1", threadId: "t1", scenarioId: id } as never);
    await h.db.assistantMessages.put({ messageId: "m1", threadId: "t1", seq: 1 } as never);
    await h.db.assistantProposals.put({ proposalId: "p1", scenarioId: id } as never);
    await h.db.assistantReceipts.put({ receiptId: "r1", scenarioId: id } as never);
    await h.db.diagnosticSearches.put({ searchId: "s1", scenarioId: id } as never);
    await h.db.optimizeBases.put({ basisId: "b1", scenarioId: id } as never);
    await h.db.tabSelections.put({ tabId: "stale-tab", scenarioId: id, selectedAt: "x" });
    const fenceBefore = (await h.db.assistantGenerations.get(scenarioGenerationScope(id)))!;

    // tab-1 moves on, then deletes it.
    const b = await load(h, "tab-1", a.owner, "05");
    await h.repo.deleteSchedule({ scenarioId: id, tabId: "tab-1" });

    const byScenario = <T>(rows: T[]) =>
      rows.filter((row) => (row as { scenarioId?: string }).scenarioId === id);
    expect(await h.db.scenarioEnvelopes.get(id)).toBeUndefined();
    expect(byScenario(await h.db.scenarioCommits.toArray())).toEqual([]);
    expect(byScenario(await h.db.historyLinks.toArray())).toEqual([]);
    expect(await h.db.assistantThreads.count()).toBe(0);
    expect(await h.db.assistantTurns.count()).toBe(0);
    expect(await h.db.assistantMessages.count()).toBe(0);
    expect(await h.db.assistantProposals.count()).toBe(0);
    expect(await h.db.assistantReceipts.count()).toBe(0);
    expect(await h.db.diagnosticSearches.count()).toBe(0);
    expect(await h.db.optimizeBases.count()).toBe(0);
    expect(byScenario(await h.db.tabSelections.toArray())).toEqual([]);
    expect(await h.db.writerLeases.get(id)).toBeUndefined();
    const fenceAfter = (await h.db.assistantGenerations.get(scenarioGenerationScope(id)))!;
    expect(fenceAfter.generation).toBe(fenceBefore.generation + 1);
    // The other schedule is untouched.
    expect(await h.db.scenarioEnvelopes.get(b.envelope.scenarioId)).toBeDefined();
  });

  it("keeps the legacy migration done when the migrated schedule is removed", async () => {
    const h = createHarness();
    const migrated = await migrateLegacyScenarioRecord({ db: h.db, now: () => h.clock.now() });
    const first = await h.repo.selectOrSwitchScenario({
      tabId: "tab-1",
      target: { kind: "existing", scenarioId: migrated.scenarioId! },
    });
    // The migrated schedule is blank, so the next create removes it.
    const next = await load(h, "tab-1", first.owner);
    expect(await h.db.scenarioEnvelopes.get(migrated.scenarioId!)).toBeUndefined();

    const reboot = await migrateLegacyScenarioRecord({ db: h.db, now: () => h.clock.now() });
    expect(reboot).toMatchObject({
      status: "already-complete",
      scenarioId: next.envelope.scenarioId,
    });
    expect(await h.db.scenarioEnvelopes.count()).toBe(1);
  });

  it("refuses the schedule open in this tab, and one another tab is editing", async () => {
    const h = createHarness();
    const a = await load(h, "tab-1");
    const refusedHere = await h.repo
      .deleteSchedule({ scenarioId: a.envelope.scenarioId, tabId: "tab-1" })
      .catch((error: unknown) => error);
    expect(isRepositoryError(refusedHere, "schedule_open")).toBe(true);

    const refusedThere = await h.repo
      .deleteSchedule({ scenarioId: a.envelope.scenarioId, tabId: "tab-2" })
      .catch((error: unknown) => error);
    expect(isRepositoryError(refusedThere, "target_owned")).toBe(true);
    expect(await h.db.scenarioEnvelopes.get(a.envelope.scenarioId)).toBeDefined();
  });
});

describe("the 30-unpinned limit", () => {
  it("removes blank schedules first, then the oldest unpinned, never pinned or held ones", async () => {
    const h = createHarness();
    // A blank one (New) left behind, then LIMIT + 1 loads; the first load is pinned.
    let owner: LeaseOwner | null = (
      await h.repo.selectOrSwitchScenario({ tabId: "tab-1", target: { kind: "new" } })
    ).owner;
    const blankId = owner!.scenarioId;
    const loaded: string[] = [];
    for (let index = 0; index <= RECENT_SCHEDULES_LIMIT; index += 1) {
      const selection = await load(h, "tab-1", owner);
      owner = selection.owner;
      loaded.push(selection.envelope.scenarioId);
      expect(selection.removed).toEqual([]);
      if (index === 0) {
        await h.repo.setSchedulePinned({ scenarioId: selection.envelope.scenarioId, pinned: true });
      }
      // The first create after the blank one removes it, silently.
      if (index === 0) {
        expect(await h.db.scenarioEnvelopes.get(blankId)).toBeUndefined();
        expect(selection.removed).toEqual([]);
      }
    }
    await h.repo.renameSchedule({ scenarioId: loaded[1]!, title: "Oldest unpinned" });
    // Another live tab holds the second-oldest unpinned one.
    await h.repo.acquireOrTakeover({ scenarioId: loaded[2]!, tabId: "tab-9", mode: "takeover" });

    // 30 unpinned now (loaded[1..30]). One more create goes over.
    const next = await load(h, "tab-1", owner);
    expect(next.removed).toEqual([{ scenarioId: loaded[1], name: "Oldest unpinned" }]);
    expect(await h.db.scenarioEnvelopes.get(loaded[0]!)).toBeDefined(); // pinned
    expect(await h.db.scenarioEnvelopes.get(loaded[2]!)).toBeDefined(); // held

    // Next one skips the held schedule and takes the next oldest.
    const after = await load(h, "tab-1", next.owner);
    expect(after.removed.map((removed) => removed.scenarioId)).toEqual([loaded[3]]);
    const unpinned = (await h.db.scenarioEnvelopes.toArray()).filter((row) => !row.pinned);
    expect(unpinned).toHaveLength(RECENT_SCHEDULES_LIMIT);
  });

  it("removes nothing when a schedule is merely opened", async () => {
    const h = createHarness();
    const a = await load(h, "tab-1");
    const b = await load(h, "tab-1", a.owner);
    const reopened = await h.repo.selectOrSwitchScenario({
      tabId: "tab-1",
      target: { kind: "existing", scenarioId: a.envelope.scenarioId },
      currentOwner: b.owner!,
    });
    expect(reopened.removed).toEqual([]);
    expect(await h.db.scenarioEnvelopes.count()).toBe(2);
  });
});
