import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { createStateSpine, pickScenario, selectBackupStatus } from "@/lib/store";
import { createMemoryStorage } from "@/lib/store/persistence";
import { hydrateScenarioStore, resetToNewScenario } from "@/lib/store/lifecycle";
import { INITIAL_RUN_STATE } from "@/lib/store/types";

// Acceptance matrix row 3 (vitest half) — New-schedule resets EVERY slice. The
// New button (new-schedule-button.tsx) confirms, then calls resetToNewScenario;
// this proves that call restores the empty default across all scenario slices,
// clears undo/redo history, resets backup currentness, and resets the hot store.
// The Playwright half proves the confirm + button flow drives this same path.

describe("New-schedule reset — all slices", () => {
  it("resets scenario, history, backup currentness, and hot store", async () => {
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    // Hydration no longer invents a backup fingerprint (T17r review P0); record a
    // clean one (as a plain Download would) so the edit below is genuinely stale.
    spine.scenario.getState().recordBackup();

    // Dirty every axis: scenario data (one tracked mutation → one history entry),
    // plus hot-store ephemeral state that must not leak past a reset.
    spine.scenario.getState().mutateScenario({
      rangeStart: "2026-03-01",
      rangeEnd: "2026-03-31",
      staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
      meta: { ...createEmptyScenarioUiState().meta, description: "dirty ward" },
    });
    spine.hot.getState().setRun({ phase: "running" });
    spine.hot.getState().setUi({ selection: "cell-1" });

    expect(selectBackupStatus(spine.scenario.getState())).toBe("stale");
    expect(spine.scenario.temporal.getState().pastStates.length).toBeGreaterThan(0);

    await resetToNewScenario(spine.scenario, spine.hot);

    // Every scenario slice is back to the empty default (byte-for-byte).
    const empty = pickScenario(createEmptyScenarioUiState());
    expect(pickScenario(spine.scenario.getState())).toEqual(empty);

    // A fresh scenario has no recorded backup, and no undo/redo history to travel
    // back into.
    expect(selectBackupStatus(spine.scenario.getState())).toBe("none");
    expect(spine.scenario.temporal.getState().pastStates.length).toBe(0);
    expect(spine.scenario.temporal.getState().futureStates.length).toBe(0);

    // Hot-store ephemeral state is reset so scenario A's transients can't leak.
    expect(spine.hot.getState().run).toEqual(INITIAL_RUN_STATE);
    expect(spine.hot.getState().ui).toEqual({});
  });
});
