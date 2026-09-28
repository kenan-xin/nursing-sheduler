// Bring-up must never spin forever (bead nursing-sheduler-dna).
//
// Every await in `initialize()` is an IndexedDB transaction, and IndexedDB queues a
// transaction behind any overlapping readwrite transaction on ANY connection -- including
// one held by another tab that is hung or frozen by the browser. Nothing in this tab can
// break that lock, so the gate has to say so instead of showing skeletons forever, and it
// has to finish on its own the moment the lock clears.

import "fake-indexeddb/auto";
import { Dexie } from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import { initializeScenarioAuthority, registerScenarioLifecycle } from "./lifecycle";
import { clearTestAuthority, freshAuthorityDbName, installTestAuthority } from "./test-authority";
import { setScenarioAuthority, useHotStore } from "./spine";

afterEach(() => {
  vi.unstubAllGlobals();
  clearTestAuthority();
});

// Bead d854: a page entering BFCache must not strand its lease for the next document.
it("a BFCache pagehide releases the lease, and the persisted pageshow re-acquires it", async () => {
  const tab = await installTestAuthority();
  const scenarioId = tab.authorityStore.getState().scenarioId!;
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  const unregister = registerScenarioLifecycle();
  const transition = (type: string) =>
    window.dispatchEvent(Object.assign(new Event(type), { persisted: true }));

  transition("pagehide");
  await tab.authority.drain();
  expect(await tab.db.writerLeases.get(scenarioId)).toBeUndefined();

  transition("pageshow");
  await tab.authority.drain();
  expect(tab.authorityStore.getState().ownership).toBe("owner");
  expect((await tab.db.writerLeases.get(scenarioId))?.ownerTabId).toBe(tab.tabId);
  unregister();
});

/** Another connection holding a readwrite lock on the scenario stores until released. */
async function holdScenarioLock(databaseName: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const { db: peer } = await installTestAuthority({ databaseName, install: false });
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  const done = peer.transaction("rw", peer.scenarioEnvelopes, async () => {
    await peer.scenarioEnvelopes.count();
    started();
    await Dexie.waitFor(released);
  });
  return { holding, release: () => (release(), done.finally(() => peer.close())) };
}

it("reports a stalled restore, then completes once the lock clears", async () => {
  const databaseName = freshAuthorityDbName();
  // A real, already-used database: a first tab brings it up and goes away.
  const first = await installTestAuthority({ databaseName });
  clearTestAuthority();
  first.db.close();

  // The reloaded tab, blocked behind the peer's lock.
  const lock = await holdScenarioLock(databaseName);
  await lock.holding;
  const tab = await installTestAuthority({ databaseName, install: false });
  setScenarioAuthority(tab.authority);

  const hot = useHotStore;
  const settled = initializeScenarioAuthority(hot, { stallAfterMs: 50 });
  await expect.poll(() => hot.getState().hydrationStatus, { timeout: 2000 }).toBe("stalled");

  await lock.release();
  await settled;
  expect(hot.getState().hydrationStatus).toBe("ready");
});

// u2o hypothesis (d). Dexie's default `versionchange` handler closes THIS app's own
// connections for a peer's upgrade, but a connection that ignores the event (an old
// build frozen in the background, a foreign page script) leaves the open `blocked`.
// That open is inside bring-up, after the stall timer is armed, so it must surface.
it("reports a stalled restore while an older connection blocks the upgrade", async () => {
  const databaseName = freshAuthorityDbName();
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 10); // Dexie schema v1 = IDB v10
    request.onupgradeneeded = () => request.result.createObjectStore("keyval", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tab = await installTestAuthority({ databaseName, install: false });
  setScenarioAuthority(tab.authority);

  const hot = useHotStore;
  const settled = initializeScenarioAuthority(hot, { stallAfterMs: 50 });
  await expect.poll(() => hot.getState().hydrationStatus, { timeout: 2000 }).toBe("stalled");

  old.close();
  await settled;
  expect(hot.getState().hydrationStatus).toBe("ready");
});
