// The browser-default concrete persistence adapter (T04): a `StateStorage`
// backed by a single Dexie key/value object store in IndexedDB. This is the only
// module that touches IndexedDB, so it is strictly client-only — it is
// constructed lazily by the durable store's `createJSONStorage` factory, which
// never runs during SSR (the store uses `skipHydration` and hydrates from a
// client effect).

import type { StateStorage } from "zustand/middleware";
import { NURSE_SCHEDULER_DB_NAME, NurseSchedulerDb } from "@/lib/repository/schema";

/**
 * Default IndexedDB database name. Re-exported from the shared schema module so
 * this adapter and the transactional repository can never name two databases.
 */
export const SCENARIO_DB_NAME = NURSE_SCHEDULER_DB_NAME;

/**
 * Create the Dexie-backed `StateStorage`. Wrap with `createRevisionGuardedStorage`
 * before handing to `persist`. Each op is a single-row `keyval` read/write.
 *
 * The database class is the SHARED one (T02): the repository added tables in
 * schema version 2, and both openers must declare the same version or the lower
 * one fails to open. This adapter's behaviour is otherwise unchanged — it still
 * reads and writes exactly the one `keyval` row it always did, and remains the
 * live persistence authority until T03 performs the cutover.
 */
export function createDexieStorage(databaseName: string = SCENARIO_DB_NAME): StateStorage {
  const db = new NurseSchedulerDb(databaseName);
  return {
    async getItem(key) {
      const row = await db.keyval.get(key);
      return row?.value ?? null;
    },
    async setItem(key, value) {
      await db.keyval.put({ key, value });
    },
    async removeItem(key) {
      await db.keyval.delete(key);
    },
  };
}
