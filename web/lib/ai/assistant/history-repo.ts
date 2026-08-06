// Scenario-bound local conversation history (T04 boundary, T05 fencing).
//
// THE SCENARIO BOUNDARY. A thread belongs to exactly ONE scenario identity. That is
// a CORRECTNESS boundary, not a privacy one: it stops facts and tool results from a
// replaced document being presented as true of the current one. So:
//
//   * `selectActiveThread` never creates a thread for scenario A while looking at
//     scenario B -- it suspends every other active thread in the same transaction
//     that activates this scenario's, so "at most one active thread" is a
//     transactional property rather than a convention;
//   * a suspended thread becomes `historical` and stays readable. Rendering it
//     read-only is the panel's job; keeping it out of the ACTIVE slot is this
//     file's;
//   * a `cleared` thread is never resumed. Clear marks it in its first transaction
//     and deletes it after settlement, so the window in between cannot hand a
//     doomed thread back as the live one;
//   * restoring a prior scenario identity restores its exact thread, because the
//     lookup key is the scenario id and nothing else. A new/replaced scenario
//     mints a new identity upstream (T02), so it can only ever find no thread and
//     start clean. There is no merge path to get wrong.
//
// THE WRITE FENCE (T05). Every mutating function here runs its write inside a
// transaction that first rereads the generations the operation captured -- see
// `./fence` for why a check before the transaction is an optimisation and never an
// authorisation. Each function therefore reports `"fenced"` as an ordinary outcome:
// a late callback whose data the user has since cleared is DROPPED, not failed.
//
// `seq` is allocated INSIDE the append transaction. A timestamp would not do:
// two messages accepted in the same millisecond would have no defined order, and
// the transport replays a thread positionally.

import {
  ASSISTANT_WRITE_TABLES,
  ensureGeneration,
  generationScopesFor,
  type CapturedGeneration,
  type NurseSchedulerDb,
} from "@/lib/repository";
import { getAssistantDb } from "./db";
import {
  captureAssistantGenerations,
  fromGenerationPair,
  runFenced,
  toGenerationPair,
  type AssistantGenerationPair,
} from "./fence";
import type { AssistantSettlement, InterruptionTrigger } from "./lifecycle";
import { toCanonical, type CanonicalizeContext } from "./messages";
import type {
  AssistantMessageV1,
  AssistantThreadV1,
  AssistantTurnState,
  AssistantTurnV1,
} from "./records";
import type { Message } from "@ag-ui/client";

/** The turn states that describe work nothing has settled yet. */
export const UNSETTLED_TURN_STATES: readonly AssistantTurnState[] = [
  "preparing",
  "streaming",
  "stopping",
  "settling",
];

/** How a fenced write reports itself. `fenced` is a designed outcome, not a failure. */
export type WriteOutcome = "accepted" | "fenced" | "missing";

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
 * The generation fences are captured at creation, so a thread minted after a clear
 * carries the POST-clear generations -- which is what stops the clear's own
 * deletion pass, or a later late callback, from touching it.
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
    // second thread for one identity would silently orphan the first. A `cleared`
    // thread is deliberately NOT eligible -- it is awaiting deletion.
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

/** Every thread for one scenario identity. Read-only material. */
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
 * Persist the transport's current view of a thread, subject to the fence.
 *
 * Called after each accepted lifecycle update rather than per streamed chunk: the
 * transport publishes a whole message list, and reconciling it wholesale is what
 * makes a mid-stream reload restore the text already accepted without inventing a
 * terminal result for the turn that produced it.
 *
 * Existing rows are updated in place, keeping their original `seq`, so a message
 * whose content grew during streaming does not jump position.
 *
 * THE LATE-CALLBACK CASE this returns `"fenced"` for is the whole reason the fence
 * exists: a stream that flushes one last message list after Clear must not recreate
 * the conversation the user just deleted.
 */
export async function persistThreadMessages(
  messages: readonly Message[],
  context: CanonicalizeContext,
  config: HistoryRepoConfig = {},
): Promise<WriteOutcome> {
  const { db, now } = resolve(config);
  if (messages.length === 0) return "accepted";

  const captured = fromGenerationPair(context.scenarioId, context);
  const result = await runFenced(db, ASSISTANT_WRITE_TABLES, captured, async () => {
    // The thread itself is rechecked: a thread marked `cleared` is awaiting
    // deletion, and appending to it would leave orphaned messages behind after the
    // deletion pass ran.
    const thread = await db.assistantThreads.get(context.threadId);
    if (!thread || thread.state === "cleared") return "missing" as const;

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
    return "accepted" as const;
  });

  return result.outcome === "fenced" ? "fenced" : result.value;
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
 * Persist a `preparing` turn, capturing its generations in the SAME transaction.
 *
 * Written BEFORE the run starts, so a turn that never reaches the runtime is still
 * visible as an unsettled local fact rather than vanishing. Capturing atomically
 * with the row is what makes the capture trustworthy: a value read in an earlier
 * transaction could already be stale by the time the row lands.
 *
 * `null` means the thread is gone or cleared -- there is nothing to prepare against.
 */
export async function recordPreparingTurn(
  input: RecordTurnInput,
  config: HistoryRepoConfig = {},
): Promise<AssistantTurnV1 | null> {
  const { db, now, newId } = resolve(config);
  return db.transaction("rw", ASSISTANT_WRITE_TABLES, async () => {
    const thread = await db.assistantThreads.get(input.threadId);
    if (!thread || thread.state === "cleared") return null;

    const at = now();
    const captured = await captureAssistantGenerations(db, input.scenarioId, at);
    const turn: AssistantTurnV1 = {
      ...input,
      ...toGenerationPair(captured),
      turnId: newId(),
      schemaVersion: 1,
      state: "preparing",
      terminalReason: null,
      interruptionTrigger: null,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
    await db.assistantTurns.put(turn);
    return turn;
  });
}

export interface SetTurnStateInput {
  state: AssistantTurnState;
  settlement?: AssistantSettlement | null;
  trigger?: InterruptionTrigger | null;
}

/**
 * Advance a turn's lifecycle, fenced on the generations the TURN captured.
 *
 * Using the turn's own stored pair rather than a fresh read is what makes this
 * reload-proof: the authority for "which generations was this work authorised
 * under?" is the durable row, not a JavaScript closure that a reload destroyed.
 *
 * A missing turn is `"missing"`, never a throw: a stop aimed at a turn a clear
 * already deleted is an ordinary idempotent no-op.
 */
export async function setTurnState(
  turnId: string,
  input: SetTurnStateInput,
  config: HistoryRepoConfig = {},
): Promise<WriteOutcome> {
  const { db, now } = resolve(config);
  const turn = await db.assistantTurns.get(turnId);
  if (!turn) return "missing";

  const captured = fromGenerationPair(turn.scenarioId, turn);
  const result = await runFenced(db, ASSISTANT_WRITE_TABLES, captured, async () => {
    // Reread inside the transaction: the row read above is only a precheck.
    const current = await db.assistantTurns.get(turnId);
    if (!current) return "missing" as const;
    await db.assistantTurns.put({
      ...current,
      state: input.state,
      terminalReason: input.settlement ?? current.terminalReason,
      interruptionTrigger: input.trigger ?? current.interruptionTrigger,
      updatedAt: now().toISOString(),
    });
    return "accepted" as const;
  });

  return result.outcome === "fenced" ? "fenced" : result.value;
}

/**
 * Which unsettled turns an operation is about.
 *
 * Three cases rather than a nullable thread id, because the three interruption shapes
 * genuinely differ: Stop is about one thread, Clear history is about one scenario
 * (whose thread the caller may not have in hand), and Clear all / Disable are about
 * everything. Collapsing the middle case into "all" would let clearing one scenario's
 * conversation settle another scenario's live turn.
 */
export type TurnScope =
  | { kind: "all" }
  | { kind: "thread"; threadId: string }
  | { kind: "scenario"; scenarioId: string };

/** Turns nothing has settled, newest first, within `scope`. */
export async function readUnsettledTurns(
  scope: TurnScope,
  config: HistoryRepoConfig = {},
): Promise<AssistantTurnV1[]> {
  const { db } = resolve(config);
  const turns = await db.assistantTurns
    .where("state")
    .anyOf(UNSETTLED_TURN_STATES as string[])
    .toArray();
  const scoped = turns.filter((turn) => {
    if (scope.kind === "all") return true;
    if (scope.kind === "thread") return turn.threadId === scope.threadId;
    return turn.scenarioId === scope.scenarioId;
  });
  return scoped.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Settle every turn left mid-flight by a previous page lifetime as `detached`.
 *
 * Run once at bring-up, AFTER any interrupted clear has finished deleting. The
 * transient runner keeps active run state in the Next process's memory only (T01),
 * so a reload cannot reattach to a run it did not start -- and a turn stuck at
 * `streaming` forever would read as live work that nothing will ever finish.
 *
 * Fenced per turn, so a turn belonging to cleared data is skipped rather than
 * rewritten (and therefore recreated) by this sweep.
 */
export async function detachStaleTurns(config: HistoryRepoConfig = {}): Promise<number> {
  const unsettled = await readUnsettledTurns({ kind: "all" }, config);
  let detached = 0;
  for (const turn of unsettled) {
    const outcome = await setTurnState(
      turn.turnId,
      { state: "detached", settlement: "detached_reload" },
      config,
    );
    if (outcome === "accepted") detached += 1;
  }
  return detached;
}

/** The most recent turn on a thread, or `null`. Drives the lifecycle notice. */
export async function readLatestTurn(
  threadId: string,
  config: HistoryRepoConfig = {},
): Promise<AssistantTurnV1 | null> {
  const { db } = resolve(config);
  const turns = await db.assistantTurns.where("threadId").equals(threadId).toArray();
  if (turns.length === 0) return null;
  return turns.reduce((latest, turn) => (turn.createdAt >= latest.createdAt ? turn : latest));
}

/** The generation pair a caller should stamp on writes for an existing thread. */
export function threadGenerations(thread: AssistantThreadV1): AssistantGenerationPair {
  return {
    globalGeneration: thread.globalGeneration,
    scenarioGeneration: thread.scenarioGeneration,
  };
}

/** Re-export for callers that hold a capture rather than a row. */
export type { CapturedGeneration };
