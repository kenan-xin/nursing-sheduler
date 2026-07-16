// The browser-default concrete persistence adapter (T04): a `StateStorage`
// backed by a single Dexie key/value object store in IndexedDB. This is the only
// module that touches IndexedDB, so it is strictly client-only — it is
// constructed lazily by the durable store's `createJSONStorage` factory, which
// never runs during SSR (the store uses `skipHydration` and hydrates from a
// client effect).

import { Dexie, type Table } from "dexie";
import type { StateStorage } from "zustand/middleware";

/** One key/value row — the persisted scenario payload lives under a single key. */
interface KeyValueRow {
  key: string;
  value: string;
}

/** The IndexedDB database backing durable persistence. */
class ScenarioPersistenceDb extends Dexie {
  keyval!: Table<KeyValueRow, string>;

  constructor(databaseName: string) {
    super(databaseName);
    this.version(1).stores({ keyval: "key" });
    this.keyval = this.table("keyval");
  }
}

/** Default IndexedDB database name. */
export const SCENARIO_DB_NAME = "nurse-scheduler";

/**
 * Create the Dexie-backed `StateStorage`. Wrap with `createRevisionGuardedStorage`
 * before handing to `persist`. Each op is a single-row `keyval` read/write.
 */
export function createDexieStorage(databaseName: string = SCENARIO_DB_NAME): StateStorage {
  const db = new ScenarioPersistenceDb(databaseName);
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
