// Shared fixtures for the assistant suite. Not a test file (vitest collects
// `*.test.ts` only), so it may be imported freely.

import { NurseSchedulerDb } from "@/lib/repository";
import { setAssistantDb } from "./db";
import type {
  DiagnosticCanceller,
  DiagnosticCancellationAck,
  DiagnosticCancellationRequest,
} from "./diagnostic-cancellation";

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
 * A stand-in for T10's diagnostic cancellation owner (T05).
 *
 * Published here, beside the harness, because T10 needs the SAME fixture: this ticket
 * owns the interface and its settlement semantics, and a second fixture written later
 * against a remembered reading of them is how the two drift apart.
 *
 * The three shapes that matter to the controller:
 *   * `acks` alone -- an immediate answer, confirmed or not;
 *   * `delayMs` -- a slow but eventually-answering owner;
 *   * `hang` -- an owner that never answers, which must detach at 15 seconds and must
 *     observe the aborted signal rather than leaking a pending promise.
 */
export interface DiagnosticFixtureOptions {
  acks?: DiagnosticCancellationAck[];
  /** Answer after this many milliseconds instead of immediately. */
  delayMs?: number;
  /** Never answer. The controller must detach, and `aborted` must become true. */
  hang?: boolean;
}

export interface DiagnosticFixture extends DiagnosticCanceller {
  /** Every request the controller made. Bounded metadata, as the interface promises. */
  requests: DiagnosticCancellationRequest[];
  /** Whether the last request's settlement window was aborted. */
  aborted(): boolean;
}

export function createDiagnosticFixture(options: DiagnosticFixtureOptions = {}): DiagnosticFixture {
  const requests: DiagnosticCancellationRequest[] = [];

  return {
    requests,
    aborted: () => requests.at(-1)?.signal.aborted ?? false,
    cancelOwnedJobs(request) {
      requests.push(request);
      if (options.hang) return new Promise<DiagnosticCancellationAck[]>(() => {});
      const acks = options.acks ?? [];
      if (options.delayMs === undefined) return Promise.resolve(acks);
      return new Promise((resolve) => setTimeout(() => resolve(acks), options.delayMs));
    },
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
