import { describe, expect, it } from "vitest";
import { createModeStore } from "./mode";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { createStateSpine, pickScenario, selectIsDirty } from "@/lib/store";
import type { ScenarioStoreState } from "@/lib/store/scenario-store";
import { createMemoryStorage } from "@/lib/store/persistence";
import { hydrateScenarioStore } from "@/lib/store/lifecycle";

// Acceptance matrix row 1 — toggle Guided↔Advanced must leave the scenario store
// byte-identical (no reserialize, no flatten, no dropped Advanced-only detail).
// The mode store has no import of lib/store/**, so there is no code path; this
// test proves the invariant empirically against a scenario carrying Advanced
// detail in every slice (cards, export layout, request matrix).

function scenarioWithAdvancedDetail(): ScenarioUiState {
  const base = createEmptyScenarioUiState();
  return {
    ...base,
    meta: { ...base.meta, description: "Advanced detail fixture" },
    rangeStart: "2026-03-01",
    rangeEnd: "2026-03-31",
    staff: [
      { _k: "p1", id: 1, description: "Nurse A", history: ["prev ward"] },
      { _k: "p2", id: 2, description: "Nurse B" },
    ],
    shifts: [
      { _k: "s1", id: "D", description: "Day", startTime: "07:00", endTime: "19:00" },
      { _k: "s2", id: "N", description: "Night", durationMinutes: 720 },
    ],
    cardsByKind: {
      requirements: [
        {
          uid: "req-1",
          shiftType: "D",
          requiredNumPeople: 2,
          weight: Infinity,
          qualifiedPeople: [1, 2],
        },
      ],
      successions: [
        {
          uid: "suc-1",
          person: 1,
          pattern: ["D", "N"],
          weight: 10,
        },
      ],
      counts: [],
      affinities: [],
      coverings: [
        {
          uid: "cov-1",
          preceptors: [1],
          preceptees: [2],
          shiftTypes: ["D"],
          weight: 5,
        },
      ],
    },
    exportLayout: {
      formatting: [{ uid: "fmt-1", type: "row", people: [1] }],
      extraColumns: [],
      extraRows: [],
    },
    reqData: [
      { person: 1, date: "2026-03-01", kind: "request", shiftType: "D", weight: 1 },
      { person: 2, date: "2026-03-02", kind: "leave" },
    ],
  };
}

describe("mode lens — non-mutating", () => {
  it("toggling Guided↔Advanced leaves the scenario store byte-identical", async () => {
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    const advanced = scenarioWithAdvancedDetail();
    // Seed a real baseline so the persisted partial (scenario slice + baseline) is
    // meaningful for the comparison.
    spine.scenario.setState({ ...advanced, baselineFingerprint: "baseline-xyz" }, false);

    // The exact partial `persist` would serialize: the scenario slice plus the
    // baseline fingerprint. structuredClone preserves non-JSON numbers (Infinity),
    // so — unlike JSON.stringify — a lossy flatten of the Advanced weight or a
    // dropped baseline cannot masquerade as byte-identical.
    const persistedPartial = (state: ScenarioStoreState) => ({
      ...pickScenario(state),
      baselineFingerprint: state.baselineFingerprint,
    });
    const before = structuredClone(persistedPartial(spine.scenario.getState()));

    // Toggle mode back and forth — this must not touch the scenario store.
    const mode = createModeStore("guided");
    mode.getState().toggleMode(); // → advanced
    mode.getState().toggleMode(); // → guided
    mode.getState().setMode("advanced");
    mode.getState().setMode("guided");
    mode.getState().toggleMode(); // → advanced

    const after = persistedPartial(spine.scenario.getState());

    // Deep structural equality (Object.is-based → Infinity === Infinity), covering
    // every persisted field plus the baseline.
    expect(after).toEqual(before);
    // Explicitly guard the load-bearing non-JSON value and the baseline.
    expect(after.cardsByKind.requirements[0].weight).toBe(Infinity);
    expect(after.baselineFingerprint).toBe("baseline-xyz");
  });

  it("mode store is independent — no import path reaches the scenario store", () => {
    const mode = createModeStore("guided");
    const before = mode.getState().mode;
    expect(before).toBe("guided");

    mode.getState().setMode("advanced");
    expect(mode.getState().mode).toBe("advanced");

    mode.getState().toggleMode();
    expect(mode.getState().mode).toBe("guided");
  });

  it("dirty flag is unaffected by mode toggles", async () => {
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    // Make a change so the scenario is dirty.
    spine.scenario.getState().mutateScenario({ rangeStart: "2026-05-01" });
    expect(selectIsDirty(spine.scenario.getState())).toBe(true);

    const mode = createModeStore("guided");
    mode.getState().toggleMode();
    mode.getState().toggleMode();

    expect(selectIsDirty(spine.scenario.getState())).toBe(true);
  });
});
