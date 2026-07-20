import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "./persistence";
import { createScenarioStore, selectBackupStatus } from "./scenario-store";
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

  it("tracks guidedRulePins mutations through undo/redo (T14a)", () => {
    const { scenario } = spine;
    expect(scenario.getState().guidedRulePins).toEqual([]);

    const pin = {
      id: "pin1",
      constraintKind: "counts" as const,
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    scenario.getState().mutateScenario({ guidedRulePins: [pin] });
    expect(scenario.getState().guidedRulePins).toEqual([pin]);
    expect(temporal(scenario).pastStates.length).toBe(1);

    temporal(scenario).undo();
    expect(scenario.getState().guidedRulePins).toEqual([]);

    temporal(scenario).redo();
    expect(scenario.getState().guidedRulePins).toEqual([pin]);
  });

  it("backup freshness reacts to a Guided-pin-only change (normalized Workspace fingerprint)", () => {
    // T17r review P1 #139: the fingerprint hashes the Workspace projection, which
    // preserves Guided metadata — so a pin-only edit makes the backup stale, unlike
    // the old strict-projection hash that stripped it.
    const { scenario } = spine;
    scenario.getState().recordBackup();
    expect(selectBackupStatus(scenario.getState())).toBe("current");

    scenario.getState().mutateScenario({
      guidedRulePins: [
        {
          id: "p",
          constraintKind: "counts" as const,
          constraintId: "c1",
          category: "Hours",
          quickFields: [],
        },
      ],
    });
    expect(selectBackupStatus(scenario.getState())).toBe("stale");
  });

  it("records only the scenario slice — never the backup fingerprint or action functions", () => {
    const { scenario } = spine;
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });

    const snapshot = temporal(scenario).pastStates[0] as Record<string, unknown>;
    expect("backupFingerprint" in snapshot).toBe(false);
    expect("mutateScenario" in snapshot).toBe(false);
    expect(typeof snapshot.reqData).toBe("object");
  });

  it("does not add a history entry for recording a backup (fingerprint-only change)", () => {
    const { scenario } = spine;
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    const before = temporal(scenario).pastStates.length;

    scenario.getState().recordBackup();

    expect(temporal(scenario).pastStates.length).toBe(before);
  });
});

describe("durable scenario store — backup currentness", () => {
  it("is current at the recorded backup and stale after an edit", async () => {
    const { scenario } = await readySpine();
    scenario.getState().recordBackup();
    expect(selectBackupStatus(scenario.getState())).toBe("current");

    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    expect(selectBackupStatus(scenario.getState())).toBe("stale");

    scenario.getState().recordBackup();
    expect(selectBackupStatus(scenario.getState())).toBe("current");
  });

  it("backup → edit → undo-to-backup returns to current", async () => {
    const { scenario } = await readySpine();
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    scenario.getState().recordBackup();
    expect(selectBackupStatus(scenario.getState())).toBe("current");

    scenario.getState().mutateScenario({ rangeStart: "2026-03-01" });
    expect(selectBackupStatus(scenario.getState())).toBe("stale");

    temporal(scenario).undo();
    expect(scenario.getState().rangeStart).toBe("2026-02-01");
    expect(selectBackupStatus(scenario.getState())).toBe("current");
  });
});

describe("ready gate", () => {
  it("has no backup recorded before any hydration", () => {
    const scenario = createScenarioStore({ createStorage: () => createMemoryStorage() });
    expect(scenario.getState().backupFingerprint).toBeNull();
    expect(selectBackupStatus(scenario.getState())).toBe("none");
  });

  it("mutating actions are no-ops until the spine reports ready", () => {
    // A spine whose hot store is never marked ready.
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    expect(spine.hot.getState().hydrationStatus).toBe("unhydrated");

    spine.scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    spine.scenario.getState().setReqData([{ kind: "leave", person: "p1", date: "2026-01-01" }]);
    spine.scenario.getState().recordBackup();

    expect(spine.scenario.getState().rangeStart).toBe("");
    expect(spine.scenario.getState().reqData).toEqual([]);
    expect(spine.scenario.getState().backupFingerprint).toBeNull();
    expect(spine.scenario.temporal.getState().pastStates.length).toBe(0);
  });
});
