import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  computeScenarioFingerprint,
  pickScenario,
  selectBackupStatus,
  scenarioCommands,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";

import { INITIAL_RUN_STATE } from "@/lib/store/types";
import { resetScenarioForTest, undoDepth, redoDepth } from "@/lib/store/test-authority";

// Acceptance matrix row 3 (vitest half) — New-schedule resets EVERY slice. The
// New button (new-schedule-button.tsx) confirms, then calls resetToNewScenario;
// this proves that call restores the empty default across all scenario slices,
// clears undo/redo history, resets backup currentness, and resets the hot store.
// The Playwright half proves the confirm + button flow drives this same path.

describe("New-schedule reset — all slices", () => {
  it("resets scenario, history, backup currentness, and hot store", async () => {
    // The APP projection singletons: that is what the installed authority
    // publishes into, and what the product's own components read.
    await resetScenarioForTest();

    // Hydration no longer invents a backup fingerprint (T17r review P0); record a
    // clean one (as a plain Download would) so the edit below is genuinely stale.
    await scenarioCommands.recordBackup(
      computeScenarioFingerprint(pickScenario(useScenarioStore.getState())),
    );

    // Dirty every axis: scenario data (one tracked mutation → one history entry),
    // plus hot-store ephemeral state that must not leak past a reset.
    await scenarioCommands.mutate({
      rangeStart: "2026-03-01",
      rangeEnd: "2026-03-31",
      staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
      meta: { ...createEmptyScenarioUiState().meta, description: "dirty ward" },
    });
    useHotStore.getState().setRun({ phase: "running" });
    useHotStore.getState().setUi({ selection: "cell-1" });

    expect(selectBackupStatus(useScenarioStore.getState())).toBe("stale");
    expect(await undoDepth()).toBeGreaterThan(0);

    await resetScenarioForTest();

    // Every scenario slice is back to the empty default (byte-for-byte).
    const empty = pickScenario(createEmptyScenarioUiState());
    expect(pickScenario(useScenarioStore.getState())).toEqual(empty);

    // A fresh scenario has no recorded backup, and no undo/redo history to travel
    // back into.
    expect(selectBackupStatus(useScenarioStore.getState())).toBe("none");
    expect(await undoDepth()).toBe(0);
    expect(await redoDepth()).toBe(0);

    // Hot-store ephemeral state is reset so scenario A's transients can't leak.
    expect(useHotStore.getState().run).toEqual(INITIAL_RUN_STATE);
    expect(useHotStore.getState().ui).toEqual({});
  });
});
