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

import Dexie from "dexie";

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
import {
  completeToolPairs,
  toCanonical,
  toTransportThread,
  type CanonicalizeContext,
} from "./messages";
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

export interface PersistConfig extends HistoryRepoConfig {
  /**
   * Whether the caller may still write, evaluated at the COMMIT boundary.
   *
   * Returning `false` aborts before any row is touched and reports `"fenced"` -- the
   * same vocabulary a generation mismatch uses, because it is the same kind of
   * outcome: a write that was correctly refused, not one that failed.
   */
  authorizeCommit?: () => boolean;
  /**
   * The turn this write belongs to, compared DURABLY inside the transaction.
   *
   * Set only by turn-owned writes. A settled or deleted turn row aborts the write, and
   * because interruption settles that row in its own transaction over the same tables,
   * IndexedDB's serialisation -- not a hopeful pre-check -- is what orders the two.
   */
  requireUnsettledTurn?: string;
  /**
   * Test seam: awaited at each named point INSIDE the transaction.
   *
   * Here rather than around the call because the window that matters is the one after
   * a TRUE authority check, which a wrapper outside the repository cannot enter. Unset
   * in production, and the awaits it would introduce do not exist when it is unset.
   */
  barrier?: (point: PersistBarrier) => Promise<void> | void;
}

/** The points {@link PersistConfig.barrier} can suspend a write at. */
export type PersistBarrier = "thread-read" | "turn-read" | "history-read" | "put" | "before-return";

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
 * Thrown to abort a write whose turn lost authority mid-transaction.
 *
 * A private sentinel rather than a subclass: it is caught by identity one frame up and
 * turned into `"fenced"`, and nothing outside this module should be able to forge it.
 */
const REVOKED = Symbol("assistant-history-write-revoked");

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
 * PROVENANCE IS WRITTEN ONCE, BY THE TURN THAT CREATED THE MESSAGE. The transport
 * publishes the WHOLE hydrated thread at every settled boundary, so a later turn's
 * persist re-canonicalises every earlier message under the CURRENT turn's model,
 * turn id and generations. Taking those would relabel every previous answer as the
 * newest model's -- destroying the per-turn model record the setup, privacy and
 * thread contracts promise. So an existing row keeps its own ownership fields and
 * only what a stream can legitimately grow is taken from the new projection.
 *
 * THE LATE-CALLBACK CASE this returns `"fenced"` for is the whole reason the fence
 * exists: a stream that flushes one last message list after Clear must not recreate
 * the conversation the user just deleted.
 */
export async function persistThreadMessages(
  messages: readonly Message[],
  context: CanonicalizeContext,
  config: PersistConfig = {},
): Promise<WriteOutcome> {
  const { db, now } = resolve(config);
  if (messages.length === 0) return "accepted";

  const captured = fromGenerationPair(context.scenarioId, context);
  let result;
  try {
    result = await runFenced(db, ASSISTANT_WRITE_TABLES, captured, async () => {
      // THE LINEARIZATION POINT, and it is this transaction's own commit.
      //
      // Authority is asked for again after EVERY await below, and a failed check throws
      // rather than returning. That distinction is the fix: a `return` at that depth
      // ends the callback normally, so Dexie commits whatever rows the loop had already
      // put -- a partial prefix of a revoked turn's answer, which is worse than either
      // outcome. A throw aborts the transaction, so the write is all or nothing.
      //
      // Two sources are compared, and they cover different failures:
      //
      //   * `authorizeCommit` is the in-memory gate. It is synchronous and immediate,
      //     which is what makes it able to see a Stop that has not reached disk yet.
      //     Optional, because most callers are the interruption controller settling its
      //     own work -- which must write precisely when authority is gone.
      //
      //   * `requireUnsettledTurn` is the DURABLE one, and it is what makes revocation
      //     transactionally comparable. Interruption settles the turn row in its own
      //     `rw` transaction over these same tables, and IndexedDB serialises the two:
      //     either this write commits first and its rows are legitimate pre-settlement
      //     history, or the settlement commits first and this read sees it and rolls
      //     the whole write back. There is no interleaving to lose, which is why the
      //     callback-return-to-commit gap needs no provisional-write scheme -- the
      //     store's own ordering already decides it. The settlement write runs over
      //     the SAME table set as this one, so a write already open finishes before
      //     settlement can begin, and one not yet open starts after the gate closed and
      //     is refused here. There is no third case.
      const check = () => {
        if (config.authorizeCommit && !config.authorizeCommit()) throw REVOKED;
      };
      // `Dexie.waitFor` because awaiting a foreign promise inside a transaction would
      // otherwise let Dexie's zone consider the transaction idle and commit it early --
      // which would turn the barrier into the very partial-prefix bug it exists to catch.
      const pause = async (point: PersistBarrier) => {
        if (config.barrier) {
          // The keep-alive request `waitFor` issues is itself abortable, and a revocation
          // that lands while the barrier is held aborts the transaction underneath it.
          // That rejection is the expected outcome, not a failure to report.
          await Dexie.waitFor(config.barrier(point)).catch(() => {});
        }
        check();
      };
      check();

      // The thread itself is rechecked: a thread marked `cleared` is awaiting
      // deletion, and appending to it would leave orphaned messages behind after the
      // deletion pass ran.
      const thread = await db.assistantThreads.get(context.threadId);
      await pause("thread-read");
      if (!thread || thread.state === "cleared") return "missing" as const;

      if (config.requireUnsettledTurn) {
        const turn = await db.assistantTurns.get(config.requireUnsettledTurn);
        await pause("turn-read");
        // A missing row is a revocation too: Clear deletes the turn this write belongs
        // to, and recreating history under it is the case the fence exists for.
        if (!turn || turn.terminalReason !== null) throw REVOKED;
      }

      const at = now();
      const existing = await readThreadMessages(context.threadId, { db, now });
      await pause("history-read");
      const byId = new Map(existing.map((record) => [record.messageId, record]));
      let nextSeq = existing.reduce((max, record) => Math.max(max, record.seq), -1) + 1;

      for (const message of messages) {
        const canonical = toCanonical(message, { ...context, createdAt: at.toISOString() });
        if (!canonical) continue;
        const prior = byId.get(canonical.messageId);
        await db.assistantMessages.put(
          prior
            ? {
                // Slot, timestamp, turn, model and generation pair all belong to the
                // turn that first wrote this message. See the note above.
                ...prior,
                // The three fields a stream grows. Each falls back to the stored value
                // when the new projection has nothing, so a re-canonicalised older
                // message can never blank content it already had.
                content: canonical.content || prior.content,
                toolCalls: canonical.toolCalls ?? prior.toolCalls,
                toolCallId: canonical.toolCallId ?? prior.toolCallId,
              }
            : { ...canonical, seq: nextSeq++ },
        );
        // Per row, not per write: the loop is the only place a partial prefix could
        // form, so the check that prevents one has to run inside it.
        await pause("put");
      }
      // The last thing before the callback returns. From here Dexie owns the commit,
      // and the durable comparison above is what covers that remaining step.
      await pause("before-return");
      return "accepted" as const;
    });
  } catch (error) {
    if (error === REVOKED) return "fenced";
    throw error;
  }

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
 * Delete every message on a thread that a normalized history would not contain.
 *
 * WHY SKIPPING IS NOT ENOUGH. `persistThreadMessages` upserts what it is given and
 * never removes what it omits, so a dangling call already on disk -- written by an
 * older build, a crash, or a malformed import -- survives every sanitized write and is
 * replayed into every later turn. Filtering publication stops NEW damage; only a
 * delete repairs the old.
 *
 * Fenced and thread-scoped: it runs under the same generation capture as any other
 * assistant write, and touches only rows whose `threadId` matches. A clear that moved
 * the generation drops it, and no other thread's or scenario's rows are visible to it.
 */
export async function scrubThreadHistory(
  threadId: string,
  config: HistoryRepoConfig = {},
): Promise<{ removed: number } | "fenced" | "missing"> {
  const { db } = resolve(config);
  const thread = await db.assistantThreads.get(threadId);
  if (!thread) return "missing";

  const captured = fromGenerationPair(thread.scenarioId, thread);
  const result = await runFenced(db, ASSISTANT_WRITE_TABLES, captured, async () => {
    const rows = await db.assistantMessages.where("threadId").equals(threadId).toArray();
    const ordered = [...rows].sort((left, right) => left.seq - right.seq);
    const keep = new Set(
      completeToolPairs(toTransportThread(ordered)).map((message) => message.id),
    );
    const doomed = ordered.filter((row) => !keep.has(row.messageId));
    if (doomed.length > 0) {
      await db.assistantMessages.bulkDelete(doomed.map((row) => row.messageId));
    }
    return { removed: doomed.length };
  });

  return result.outcome === "fenced" ? "fenced" : result.value;
}

/**
 * Settle a turn ONLY if it is still unsettled at the moment of the write.
 *
 * ONE TRANSACTION, and that is the whole point. The obvious shape -- read the row,
 * see it is unsettled, then write -- has an await between the two halves, and Stop's
 * own truthful settlement can land in it. The second write would then replace
 * "detached, stopped by the user" with this function's weaker `revoked`, so the
 * durable record would disagree with what the user was told.
 *
 * Used by a turn whose orphaned promise finally resolved long after an interruption
 * settled it. If the interruption got there first, this is a no-op and reports so.
 */
export async function settleTurnIfUnsettled(
  turnId: string,
  settlement: AssistantSettlement,
  config: HistoryRepoConfig = {},
): Promise<"settled" | "already-settled" | "missing" | "fenced"> {
  const { db, now } = resolve(config);
  const turn = await db.assistantTurns.get(turnId);
  if (!turn) return "missing";

  const captured = fromGenerationPair(turn.scenarioId, turn);
  const result = await runFenced(db, ASSISTANT_WRITE_TABLES, captured, async () => {
    // The compare and the set are both INSIDE the transaction, so no interruption can
    // interleave between them.
    const current = await db.assistantTurns.get(turnId);
    if (!current) return "missing" as const;
    if (!UNSETTLED_TURN_STATES.includes(current.state)) return "already-settled" as const;
    await db.assistantTurns.put({
      ...current,
      state: "terminal",
      terminalReason: settlement,
      updatedAt: now().toISOString(),
    });
    return "settled" as const;
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

/**
 * One turn row, or `null`. The durable half of the final launch authorization: a
 * prepared turn that a clear deleted, or that an interruption already settled, is no
 * longer a turn anything may run (see `./send-gate`).
 */
export async function readTurn(
  turnId: string,
  config: HistoryRepoConfig = {},
): Promise<AssistantTurnV1 | null> {
  const { db } = resolve(config);
  return (await db.assistantTurns.get(turnId)) ?? null;
}

/** One thread row, or `null`. `active` is the only state a send may append to. */
export async function readThread(
  threadId: string,
  config: HistoryRepoConfig = {},
): Promise<AssistantThreadV1 | null> {
  const { db } = resolve(config);
  return (await db.assistantThreads.get(threadId)) ?? null;
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
