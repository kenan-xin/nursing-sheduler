// Thin integration test of the REAL Dexie adapter against a real IndexedDB
// implementation (fake-indexeddb installs the globals). The in-memory double
// carries the heavy lifecycle/logic coverage elsewhere; this proves the concrete
// persistence wiring actually stores, reads back, and removes through IndexedDB —
// so the browser default is not merely eyeballed.

import "fake-indexeddb/auto";
import { Dexie } from "dexie";
import { describe, expect, it } from "vitest";
import { createStateSpine } from "./spine";
import { drainScenarioPersist, hydrateScenarioStore } from "./lifecycle";
import { createDexieStorage, ScenarioPersistenceDb } from "./dexie-storage";

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
    first.scenario.getState().recordBackup();
    // Await the guarded write queue instead of guessing a timeout.
    await drainScenarioPersist(first.scenario);

    const reloaded = createStateSpine({ createStorage: () => createDexieStorage(dbName) });
    await hydrateScenarioStore(reloaded.scenario, reloaded.hot);

    expect(reloaded.hot.getState().hydrationStatus).toBe("ready");
    expect(reloaded.scenario.getState().rangeStart).toBe("2026-04-01");
    expect(reloaded.scenario.getState().rangeEnd).toBe("2026-04-30");
  });
});

describe("v1 → v2 schema upgrade (F1)", () => {
  it("upgrading a POPULATED v1 database preserves every keyval row and adds the roster stores", async () => {
    const dbName = freshDbName();

    // A real v1 database, written by the pre-F1 build and left populated.
    const legacy = new Dexie(dbName);
    legacy.version(1).stores({ keyval: "key" });
    await legacy.open();
    expect(legacy.verno).toBe(1);
    await legacy.table("keyval").bulkPut([
      {
        key: "nurse-scheduler/scenario",
        value: '{"state":{"rangeStart":"2026-04-01"},"version":6}',
      },
      { key: "other", value: "kept" },
    ]);
    legacy.close();

    const upgraded = new ScenarioPersistenceDb(dbName);
    await upgraded.open();

    expect(upgraded.verno).toBe(2);
    expect(await upgraded.keyval.count()).toBe(2);
    expect((await upgraded.keyval.get("nurse-scheduler/scenario"))?.value).toBe(
      '{"state":{"rangeStart":"2026-04-01"},"version":6}',
    );
    expect((await upgraded.keyval.get("other"))?.value).toBe("kept");

    // The new stores exist and are empty on a freshly upgraded database.
    expect(await upgraded.roster.count()).toBe(0);
    expect(await upgraded.snapshot.count()).toBe(0);
    expect(await upgraded.meta.count()).toBe(0);
    upgraded.close();

    // The existing StateStorage consumer still reads the pre-upgrade rows.
    const storage = createDexieStorage(dbName);
    expect(await storage.getItem("other")).toBe("kept");
  });
});
