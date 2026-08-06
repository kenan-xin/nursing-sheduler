// Shared fixtures for the repository contract suite. Not a test file (vitest
// collects `*.test.ts` only), so it may be imported freely.
//
// Everything time- and identity-dependent is INJECTED. Lease expiry is a
// wall-clock comparison, and a suite that slept through 20 real seconds to test
// it would be both slow and flaky; a controlled clock tests the exact boundary
// instead. Sequential ids make a failure message name the commit that broke.

import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { createScenarioRepository, type ScenarioRepository } from "./repository";
import { NurseSchedulerDb } from "./schema";

let databaseCounter = 0;

/** A fresh IndexedDB database name so no state bleeds between tests. */
export function freshDbName(): string {
  databaseCounter += 1;
  return `nurse-scheduler-repo-test-${databaseCounter}`;
}

export interface TestClock {
  now(): Date;
  advance(ms: number): void;
}

export function createTestClock(startIso = "2026-08-06T00:00:00.000Z"): TestClock {
  let millis = Date.parse(startIso);
  return {
    now: () => new Date(millis),
    advance: (ms) => {
      millis += ms;
    },
  };
}

export interface Harness {
  db: NurseSchedulerDb;
  repo: ScenarioRepository;
  clock: TestClock;
  dbName: string;
  /** Mint the next deterministic id without consuming it from the repository. */
  nextId(): string;
}

export function createHarness(options: { dbName?: string; historyLimit?: number } = {}): Harness {
  const dbName = options.dbName ?? freshDbName();
  const db = new NurseSchedulerDb(dbName);
  const clock = createTestClock();
  let counter = 0;
  const nextId = () => {
    counter += 1;
    return `id-${counter.toString().padStart(4, "0")}`;
  };
  const repo = createScenarioRepository({
    db,
    now: () => clock.now(),
    newId: nextId,
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
  });
  return { db, repo, clock, dbName, nextId };
}

/** A small authored scenario, including a HARD (infinite) weight. */
export function sampleScenario(rangeStart = "2026-04-01"): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart,
    rangeEnd: "2026-04-30",
    reqData: [
      { uid: "cell-1", person: "alice", date: "2026-04-02", kind: "leave" },
      // A signed infinity is a real authored value (a hard constraint), and it is
      // the one value plain JSON cannot represent — so every persistence path in
      // this suite carries one.
      {
        uid: "cell-2",
        person: "bob",
        date: "2026-04-03",
        kind: "off",
        weight: Number.POSITIVE_INFINITY,
      },
    ],
  };
}

/** Acquire a scenario for a tab and return the owner token plus the envelope. */
export async function ownScenario(repo: ScenarioRepository, scenarioId: string, tabId: string) {
  const result = await repo.acquireOrTakeover({ scenarioId, tabId });
  return { owner: result.owner, envelope: result.envelope };
}
