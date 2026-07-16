// Thin integration test of the REAL Dexie adapter against a real IndexedDB
// implementation (fake-indexeddb installs the globals). The in-memory double
// carries the heavy lifecycle/logic coverage elsewhere; this proves the concrete
// persistence wiring actually stores, reads back, and removes through IndexedDB —
// so the browser default is not merely eyeballed.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createStateSpine } from "./spine";
import { drainScenarioPersist, hydrateScenarioStore } from "./lifecycle";
import { createDexieStorage } from "./dexie-storage";

let dbCounter = 0;
/** A fresh IndexedDB database name per test so state never bleeds across tests. */
function freshDbName() {
  return `nurse-scheduler-test-${dbCounter++}`;
}

describe("Dexie StateStorage adapter (fake-indexeddb)", () => {
  it("round-trips set → get → remove through IndexedDB", async () => {
    const storage = createDexieStorage(freshDbName());

    expect(await storage.getItem("k")).toBeNull();
    await storage.setItem("k", "hello");
    expect(await storage.getItem("k")).toBe("hello");
    await storage.setItem("k", "world"); // key overwrite
    expect(await storage.getItem("k")).toBe("world");
    await storage.removeItem("k");
    expect(await storage.getItem("k")).toBeNull();
  });

  it("persists the durable store and rehydrates a reload from real IndexedDB", async () => {
    const dbName = freshDbName();

    const first = createStateSpine({ createStorage: () => createDexieStorage(dbName) });
    await hydrateScenarioStore(first.scenario, first.hot);
    first.scenario.getState().mutateScenario({ rangeStart: "2026-04-01", rangeEnd: "2026-04-30" });
    first.scenario.getState().markSaved();
    // Await the guarded write queue instead of guessing a timeout.
    await drainScenarioPersist(first.scenario);

    const reloaded = createStateSpine({ createStorage: () => createDexieStorage(dbName) });
    await hydrateScenarioStore(reloaded.scenario, reloaded.hot);

    expect(reloaded.hot.getState().hydrationStatus).toBe("ready");
    expect(reloaded.scenario.getState().rangeStart).toBe("2026-04-01");
    expect(reloaded.scenario.getState().rangeEnd).toBe("2026-04-30");
  });
});
