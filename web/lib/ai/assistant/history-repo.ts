// Scenario-bound local conversation history (T04, tech-plan "Scenario-bound
// history").
//
// THE BOUNDARY. A thread belongs to exactly ONE scenario identity. That is a
// CORRECTNESS boundary, not a privacy one: it stops facts and tool results from a
// replaced document being presented as true of the current one. So:
//
//   * `selectActiveThread` never creates a thread for scenario A while looking at
//     scenario B -- it suspends every other active thread in the same transaction
//     that activates this scenario's, so "at most one active thread" is a
//     transactional property rather than a convention;
//   * a suspended thread becomes `historical` and stays readable. Rendering it
//     read-only is the panel's job; keeping it out of the ACTIVE slot is this
//     file's;
//   * restoring a prior scenario identity restores its exact thread, because the
//     lookup key is the scenario id and nothing else. A new/replaced scenario
//     mints a new identity upstream (T02), so it can only ever find no thread and
//     start clean. There is no merge path to get wrong.
//
// `seq` is allocated INSIDE the append transaction. A timestamp would not do:
// two messages accepted in the same millisecond would have no defined order, and
// the transport replays a thread positionally.

import {
  ASSISTANT_WRITE_TABLES,
  ensureGeneration,
  generationScopesFor,
  type NurseSchedulerDb,
} from "@/lib/repository";
import { getAssistantDb } from "./db";
import { toCanonical, type CanonicalizeContext } from "./messages";
import type {
  AssistantMessageV1,
  AssistantThreadV1,
  AssistantTurnState,
  AssistantTurnV1,
} from "./records";
import type { Message } from "@ag-ui/client";

export interface HistoryRepoConfig {
  db?: NurseSchedulerDb;
  now?: () => Date;
  newId?: () => string;
}

type Resolved = { db: NurseSchedulerDb; now: () => Date; newId: () => string };

function resolve(config: HistoryRepoConfig = {}): Resolved {
  return {
    db: config.db ?? getAssistantDb(),
    now: config.now ?? (() => new Date()),
    newId: config.newId ?? (() => crypto.randomUUID()),
  };
}

/**
 * The active thread for `scenarioId`, creating it if this identity has never had
 * one, and suspending any other scenario's active thread in the same transaction.
 *
 * The generation fences are captured at creation so T05's clear paths have a
 * durable value to compare against; T04 itself never bumps them.
 */
export async function selectActiveThread(
  scenarioId: string,
  config: HistoryRepoConfig = {},
): Promise<AssistantThreadV1> {
  const { db, now, newId } = resolve(config);
  return db.transaction("rw", ASSISTANT_WRITE_TABLES, async () => {
    const at = now();

    // Suspend first. Doing it before the lookup means the invariant holds even if
    // a previous interruption left two rows marked active.
    const others = await db.assistantThreads.where("state").equals("active").toArray();
    for (const thread of others) {
      if (thread.scenarioId === scenarioId) continue;
      await db.assistantThreads.put({
        ...thread,
        state: "historical",
        updatedAt: at.toISOString(),
      });
    }

    const existing = await db.assistantThreads
      .where("[scenarioId+state]")
      .equals([scenarioId, "active"])
      .first();
    if (existing) return existing;

    // A previously suspended thread for this exact identity is RESUMED, not
    // replaced: restoring a scenario must restore its own history, and minting a
    // second thread for one identity would silently orphan the first.
    const suspended = await db.assistantThreads
      .where("[scenarioId+state]")
      .equals([scenarioId, "historical"])
      .first();
    if (suspended) {
      const resumed: AssistantThreadV1 = {
        ...suspended,
        state: "active",
        updatedAt: at.toISOString(),
      };
      await db.assistantThreads.put(resumed);
      return resumed;
    }

    const [global, scenario] = generationScopesFor(scenarioId);
    const created: AssistantThreadV1 = {
      threadId: newId(),
      schemaVersion: 1,
      scenarioId,
      state: "active",
      globalGeneration: (await ensureGeneration(db, global, at)).generation,
      scenarioGeneration: (await ensureGeneration(db, scenario, at)).generation,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
    await db.assistantThreads.put(created);
    return created;
  });
}

/** Every thread for one scenario identity, newest first. Read-only material. */
export function readThreadsForScenario(
  scenarioId: string,
  config: HistoryRepoConfig = {},
): Promise<AssistantThreadV1[]> {
  const { db } = resolve(config);
  return db.assistantThreads.where("scenarioId").equals(scenarioId).toArray();
}

/** A thread's canonical messages in `seq` order -- the hydration source. */
export async function readThreadMessages(
  threadId: string,
  config: HistoryRepoConfig = {},
): Promise<AssistantMessageV1[]> {
  const { db } = resolve(config);
  return db.assistantMessages
    .where("[threadId+seq]")
    .between([threadId, -Infinity], [threadId, Infinity])
    .toArray();
}

/**
 * Persist the transport's current view of a thread.
 *
 * Called after each accepted lifecycle update rather than per streamed chunk: the
 * transport publishes a whole message list, and reconciling it wholesale is what
 * makes a mid-stream reload restore the text already accepted without inventing a
 * terminal result for the turn that produced it.
 *
 * Existing rows are updated in place, keeping their original `seq`, so a message
 * whose content grew during streaming does not jump position.
 */
export async function persistThreadMessages(
  messages: readonly Message[],
  context: CanonicalizeContext,
  config: HistoryRepoConfig = {},
): Promise<void> {
  const { db, now } = resolve(config);
  if (messages.length === 0) return;

  await db.transaction("rw", ASSISTANT_WRITE_TABLES, async () => {
    const at = now();
    const existing = await readThreadMessages(context.threadId, { db, now });
    const byId = new Map(existing.map((record) => [record.messageId, record]));
    let nextSeq = existing.reduce((max, record) => Math.max(max, record.seq), -1) + 1;

    for (const message of messages) {
      const canonical = toCanonical(message, { ...context, createdAt: at.toISOString() });
      if (!canonical) continue;
      const prior = byId.get(canonical.messageId);
      await db.assistantMessages.put({
        ...canonical,
        // A known message keeps its slot AND its original timestamp; only its
        // content and tool calls may have grown.
        seq: prior ? prior.seq : nextSeq++,
        createdAt: prior ? prior.createdAt : canonical.createdAt,
      });
    }
  });
}

export interface RecordTurnInput {
  threadId: string;
  scenarioId: string;
  basisDocumentRevision: number;
  leaseEpoch: number;
  modelId: string;
  runId: string;
  turnEpoch: number;
  runtimeInstanceId: string | null;
}

/**
 * Persist a `preparing` turn. Written BEFORE the run starts, so a turn that never
 * reaches the runtime is still visible as an unsettled local fact rather than
 * vanishing.
 */
export async function recordPreparingTurn(
  input: RecordTurnInput,
  config: HistoryRepoConfig = {},
): Promise<AssistantTurnV1> {
  const { db, now, newId } = resolve(config);
  const at = now();
  const turn: AssistantTurnV1 = {
    ...input,
    turnId: newId(),
    schemaVersion: 1,
    state: "preparing",
    terminalReason: null,
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
  };
  await db.assistantTurns.put(turn);
  return turn;
}

/** Advance a turn's lifecycle. A missing turn is a no-op, never a throw. */
export async function setTurnState(
  turnId: string,
  state: AssistantTurnState,
  terminalReason: string | null = null,
  config: HistoryRepoConfig = {},
): Promise<void> {
  const { db, now } = resolve(config);
  const turn = await db.assistantTurns.get(turnId);
  if (!turn) return;
  await db.assistantTurns.put({
    ...turn,
    state,
    terminalReason,
    updatedAt: now().toISOString(),
  });
}

/**
 * Settle every turn left mid-flight by a previous page lifetime as `detached`.
 *
 * Run once at bring-up. The transient runner keeps active run state in the Next
 * process's memory only (T01), so a reload cannot reattach to a run it did not
 * start -- and a turn stuck at `streaming` forever would read as live work that
 * nothing will ever finish.
 */
export async function detachStaleTurns(
  reason: string,
  config: HistoryRepoConfig = {},
): Promise<number> {
  const { db, now } = resolve(config);
  const at = now().toISOString();
  const unsettled = await db.assistantTurns
    .where("state")
    .anyOf("preparing", "streaming", "stopping", "settling")
    .toArray();
  for (const turn of unsettled) {
    await db.assistantTurns.put({
      ...turn,
      state: "detached",
      terminalReason: reason,
      updatedAt: at,
    });
  }
  return unsettled.length;
}

/** The most recent turn on a thread, or `null`. Drives the Detached notice. */
export async function readLatestTurn(
  threadId: string,
  config: HistoryRepoConfig = {},
): Promise<AssistantTurnV1 | null> {
  const { db } = resolve(config);
  const turns = await db.assistantTurns.where("threadId").equals(threadId).toArray();
  if (turns.length === 0) return null;
  return turns.reduce((latest, turn) => (turn.createdAt >= latest.createdAt ? turn : latest));
}
