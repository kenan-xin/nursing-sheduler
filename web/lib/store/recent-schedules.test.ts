// Recent schedules through the authority (plq5 P1): opening a past schedule is the
// same atomic switch as Load, so it honours leases and the A-02 peer banner, and a
// tab whose schedule was deleted elsewhere falls back to the latest one.

import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { useAuthorityStore, type OwnershipHint } from "./authority";
import { scenarioCommands } from "./commands";
import { loadScenario } from "./lifecycle";
import { stateSpine } from "./spine";
import { installTestAuthority, type TestAuthority } from "./test-authority";

let harness: TestAuthority;
const hints: OwnershipHint[] = [];

async function loadMonth(month: string): Promise<string> {
  const outcome = await loadScenario({
    ...createEmptyScenarioUiState(),
    rangeStart: `2026-${month}-01`,
    rangeEnd: `2026-${month}-28`,
  });
  expect(outcome.ok).toBe(true);
  return useAuthorityStore.getState().scenarioId!;
}

beforeEach(async () => {
  hints.length = 0;
  harness = await installTestAuthority({ broadcast: (hint) => hints.push(hint) });
});

describe("opening a past schedule", () => {
  it("switches this tab to it, releases the one it left, and offers no Undo across the switch", async () => {
    const april = await loadMonth("04");
    await scenarioCommands.mutate({ rangeEnd: "2026-04-29" });
    const may = await loadMonth("05");

    const outcome = await scenarioCommands.openSchedule(april);
    expect(outcome.ok).toBe(true);
    expect(useAuthorityStore.getState()).toMatchObject({
      scenarioId: april,
      ownership: "owner",
      canUndo: false,
    });
    expect(stateSpine.scenario.getState().rangeEnd).toBe("2026-04-29");
    expect(await harness.db.writerLeases.get(may)).toBeUndefined();
    expect((await harness.db.writerLeases.get(april))?.ownerTabId).toBe(harness.tabId);
    // Peers still on May are told this tab moved on (A-02 banner).
    expect(hints.at(-1)).toMatchObject({
      kind: "acquired",
      scenarioId: april,
      fromScenarioId: may,
    });
  });

  it("opens read-only, with Take over, when another live tab is editing it", async () => {
    const april = await loadMonth("04");
    await loadMonth("05");
    const peer = await installTestAuthority({ databaseName: harness.databaseName, install: false });
    await peer.authority.initialize();
    expect((await peer.authority.openSchedule(april)).ok).toBe(true);
    expect(peer.authorityStore.getState().ownership).toBe("owner");

    await scenarioCommands.openSchedule(april);
    expect(useAuthorityStore.getState()).toMatchObject({
      scenarioId: april,
      ownership: "read-only",
      heldByTabId: peer.tabId,
    });
    expect((await scenarioCommands.mutate({ rangeEnd: "2026-04-27" })).ok).toBe(false);
    expect((await scenarioCommands.takeover()).ok).toBe(true);
    expect(useAuthorityStore.getState().ownership).toBe("owner");
  });
});

describe("rename, pin and delete", () => {
  it("delete refuses the open schedule and one another tab is editing", async () => {
    const april = await loadMonth("04");
    expect(await scenarioCommands.deleteSchedule(april)).toEqual({
      ok: false,
      reason: "open-here",
    });

    const may = await loadMonth("05");
    const peer = await installTestAuthority({ databaseName: harness.databaseName, install: false });
    await peer.authority.initialize();
    await peer.authority.openSchedule(april);
    expect(await scenarioCommands.deleteSchedule(april)).toEqual({
      ok: false,
      reason: "open-elsewhere",
    });
    expect(await harness.db.scenarioEnvelopes.get(may)).toBeDefined();
  });

  it("renaming this tab's schedule keeps recordRevision honest and lists the new name", async () => {
    const april = await loadMonth("04");
    const before = useAuthorityStore.getState().recordRevision;
    expect(await scenarioCommands.renameSchedule(april, "April draft")).toEqual({ ok: true });
    expect(useAuthorityStore.getState().recordRevision).toBe(before + 1);
    expect(await scenarioCommands.setSchedulePinned(april, true)).toEqual({ ok: true });
    const [row] = await scenarioCommands.listSchedules();
    expect(row).toMatchObject({ scenarioId: april, title: "April draft", pinned: true });
  });

  it("a tab whose schedule was deleted elsewhere falls back to the latest one on its next reread", async () => {
    const april = await loadMonth("04");
    const may = await loadMonth("05");
    const peer = await installTestAuthority({ databaseName: harness.databaseName, install: false });
    await peer.authority.initialize();
    await peer.authority.openSchedule(april);
    await peer.authority.release(); // the peer still has April selected, but no lease

    expect(await scenarioCommands.deleteSchedule(april)).toEqual({ ok: true });
    await peer.authority.reconcile();
    expect(peer.authorityStore.getState()).toMatchObject({
      scenarioId: may,
      ownership: "read-only",
      heldByTabId: harness.tabId,
    });
    expect(peer.scenario.getState().rangeStart).toBe("2026-05-01");
  });
});
