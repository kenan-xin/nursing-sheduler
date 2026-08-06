// Shared fixtures for the assistant suite. Not a test file (vitest collects
// `*.test.ts` only), so it may be imported freely.

import { NurseSchedulerDb } from "@/lib/repository";
import { setAssistantDb } from "./db";

/** The one string that must never appear outside the assistant-settings row. */
export const SENTINEL_KEY = "sk-or-SENTINEL-DO-NOT-LOG-0001";
export const TEST_MODEL = "anthropic/claude-sonnet-4.5";

let counter = 0;

export interface AssistantHarness {
  db: NurseSchedulerDb;
  now: () => Date;
  advance(ms: number): void;
  newId(): string;
  config: { db: NurseSchedulerDb; now: () => Date; newId: () => string };
}

/**
 * A fresh isolated database plus a controlled clock and deterministic ids.
 *
 * Everything time- and identity-dependent is injected so a failure message names
 * the row that broke, and so ordering assertions are not a race against the real
 * clock's millisecond resolution.
 */
export function createAssistantHarness(): AssistantHarness {
  counter += 1;
  const db = new NurseSchedulerDb(`nurse-scheduler-assistant-test-${counter}`);
  let millis = Date.parse("2026-08-06T00:00:00.000Z");
  let ids = 0;

  const now = () => new Date(millis);
  const newId = () => {
    ids += 1;
    return `id-${ids.toString().padStart(4, "0")}`;
  };

  // Bind the module-level handle too, so code paths that do not take an injected
  // config (the store's actions) hit this database rather than the real one.
  setAssistantDb(db);

  return {
    db,
    now,
    advance: (ms) => {
      millis += ms;
    },
    newId,
    config: { db, now, newId },
  };
}

/**
 * Every value stored in the database, grouped by table. The credential-containment
 * scan reads this: the sentinel may appear under `assistantSettings` and nowhere
 * else.
 */
export async function dumpDatabase(db: NurseSchedulerDb): Promise<Record<string, string>> {
  const dump: Record<string, string> = {};
  for (const table of db.tables) {
    dump[table.name] = JSON.stringify(await table.toArray());
  }
  return dump;
}
