// The assistant's handle on the browser database (T04).
//
// Constructed LAZILY, for the same reason `lib/store/spine.ts` defers its own
// controller: opening IndexedDB does not work during SSR, and the app renders the
// shell on the server.
//
// Holding a second `NurseSchedulerDb` instance beside the scenario authority's is
// the established pattern here, not a new one -- `schema.ts` already documents two
// live consumers in one tab, and it works precisely because both construct the
// SAME class and therefore agree on the declared version.

import { NurseSchedulerDb } from "@/lib/repository";

let db: NurseSchedulerDb | null = null;

/** The app-wide assistant database handle, opened on first use (client only). */
export function getAssistantDb(): NurseSchedulerDb {
  db ??= new NurseSchedulerDb();
  return db;
}

/**
 * Bind the assistant to a specific database. Tests point it at an isolated
 * in-memory database; passing `null` drops the handle so the next call
 * reconstructs the default one.
 */
export function setAssistantDb(next: NurseSchedulerDb | null): void {
  db = next;
}
