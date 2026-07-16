import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "./persistence";
import { createScenarioStore, selectIsDirty } from "./scenario-store";
import { createStateSpine, type StateSpine } from "./spine";
import { hydrateScenarioStore } from "./lifecycle";

/** A spine hydrated to `ready` over fresh in-memory storage. */
async function readySpine(): Promise<StateSpine> {
  const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
  await hydrateScenarioStore(spine.scenario, spine.hot);
  return spine;
}

function temporal(store: StateSpine["scenario"]) {
  return store.temporal.getState();
}

describe("durable scenario store — undo/redo", () => {
  let spine: StateSpine;
  beforeEach(async () => {
    spine = await readySpine();
  });

  it("restores the scenario slice on undo and reapplies on redo", () => {
    const { scenario } = spine;
    expect(scenario.getState().rangeStart).toBe("");

    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    expect(scenario.getState().rangeStart).toBe("2026-02-01");
    expect(temporal(scenario).pastStates.length).toBe(1);

    temporal(scenario).undo();
    expect(scenario.getState().rangeStart).toBe("");

    temporal(scenario).redo();
    expect(scenario.getState().rangeStart).toBe("2026-02-01");
  });

  it("records only the scenario slice — never baseline or action functions", () => {
    const { scenario } = spine;
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });

    const snapshot = temporal(scenario).pastStates[0] as Record<string, unknown>;
    expect("baselineFingerprint" in snapshot).toBe(false);
    expect("mutateScenario" in snapshot).toBe(false);
    expect(typeof snapshot.reqData).toBe("object");
  });

  it("does not add a history entry for a save (baseline-only change)", () => {
    const { scenario } = spine;
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    const before = temporal(scenario).pastStates.length;

    scenario.getState().markSaved();

    expect(temporal(scenario).pastStates.length).toBe(before);
  });
});

describe("durable scenario store — dirty vs baseline", () => {
  it("is clean at the saved fingerprint and dirty after an edit", async () => {
    const { scenario } = await readySpine();
    scenario.getState().markSaved();
    expect(selectIsDirty(scenario.getState())).toBe(false);

    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    expect(selectIsDirty(scenario.getState())).toBe(true);

    scenario.getState().markSaved();
    expect(selectIsDirty(scenario.getState())).toBe(false);
  });

  it("save → edit → undo-to-saved returns to clean", async () => {
    const { scenario } = await readySpine();
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    scenario.getState().markSaved();
    expect(selectIsDirty(scenario.getState())).toBe(false);

    scenario.getState().mutateScenario({ rangeStart: "2026-03-01" });
    expect(selectIsDirty(scenario.getState())).toBe(true);

    temporal(scenario).undo();
    expect(scenario.getState().rangeStart).toBe("2026-02-01");
    expect(selectIsDirty(scenario.getState())).toBe(false);
  });
});

describe("ready gate", () => {
  it("is not dirty and has no baseline before any hydration", () => {
    const scenario = createScenarioStore({ createStorage: () => createMemoryStorage() });
    expect(scenario.getState().baselineFingerprint).toBeNull();
    expect(selectIsDirty(scenario.getState())).toBe(false);
  });

  it("mutating actions are no-ops until the spine reports ready", () => {
    // A spine whose hot store is never marked ready.
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    expect(spine.hot.getState().hydrationStatus).toBe("unhydrated");

    spine.scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    spine.scenario.getState().setReqData([{ kind: "leave", person: "p1", date: "2026-01-01" }]);
    spine.scenario.getState().markSaved();

    expect(spine.scenario.getState().rangeStart).toBe("");
    expect(spine.scenario.getState().reqData).toEqual([]);
    expect(spine.scenario.getState().baselineFingerprint).toBeNull();
    expect(spine.scenario.temporal.getState().pastStates.length).toBe(0);
  });
});
