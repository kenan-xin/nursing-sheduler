// Bring-up must never spin forever (bead nursing-sheduler-dna).
//
// Every await in `initialize()` is an IndexedDB transaction, and IndexedDB queues a
// transaction behind any overlapping readwrite transaction on ANY connection -- including
// one held by another tab that is hung or frozen by the browser. Nothing in this tab can
// break that lock, so the gate has to say so instead of showing skeletons forever, and it
// has to finish on its own the moment the lock clears.

import "fake-indexeddb/auto";
import { Dexie } from "dexie";
import { afterEach, expect, it } from "vitest";
import { initializeScenarioAuthority } from "./lifecycle";
import { clearTestAuthority, freshAuthorityDbName, installTestAuthority } from "./test-authority";
import { setScenarioAuthority, useHotStore } from "./spine";

afterEach(() => clearTestAuthority());

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
