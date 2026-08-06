// Clear history and Clear all AI data (T05).
//
// TWO TRANSACTIONS, IN THIS ORDER, AND THE ORDER IS THE FEATURE.
//
//   1. {@link beginClear} -- BEFORE any cancellation is requested. It increments the
//      affected write generations, stamps `clearedAt`, marks the affected threads
//      `cleared`, and (for Clear all) deletes the configuration row outright. From
//      the moment this commits, every in-flight assistant write is already fenced:
//      a late callback holding the previous generation cannot land, whether it
//      arrives in a millisecond, after the 15-second detachment, or after a reload.
//
//   2. {@link finishClear} -- AFTER settlement or detachment. It rereads the exact
//      generations step 1 produced and deletes the scoped user content. Deferring
//      the delete is what lets the panel show honest settlement instead of deleting
//      a conversation that is still visibly streaming.
//
// WHAT IS NEVER DELETED: the `assistantGenerations` rows. They are non-content
// monotonic counters -- a scope key and a small integer, no prompt, scenario, tool
// payload or credential -- and they are the ONLY thing standing between a detached
// callback and recreating deleted data after a reload. Deleting them would hand a
// late writer a fresh generation 0 that matches its stale capture. Only an external
// browser-storage reset removes them.
//
// WHY CLEAR ALL DELETES THE WHOLE CONFIGURATION ROW IN STEP 1 rather than deferring
// it: the contract requires the credential gone before cancellation begins, and the
// runtime's info/connect/stop routes are keyless by design (T01) so settlement does
// not need it. Splitting the row -- key now, preferences later -- would need a
// durable "a clear-all is half-done" marker to survive a reload during settlement,
// and that marker would itself be new AI state for the next Clear all to handle.
// Deleting the row in one step removes the state machine instead of managing it.

import {
  GLOBAL_GENERATION_SCOPE,
  scenarioGenerationScope,
  type CapturedGeneration,
  type GenerationScopeKey,
  type NurseSchedulerDb,
} from "@/lib/repository";
import { getAssistantDb } from "./db";
import { bumpAssistantGeneration, readAllGenerationScopes, runFenced } from "./fence";
import { ASSISTANT_SETTINGS_KEY } from "./records";

/** Every table a clear may read or delete from. Deliberately explicit. */
export const ASSISTANT_CLEAR_TABLES = [
  "assistantThreads",
  "assistantTurns",
  "assistantMessages",
  "assistantGenerations",
  "assistantSettings",
  "assistantProposals",
  "assistantReceipts",
] as const;

export type ClearScope =
  /** One scenario's conversation. Key, preferences and other scenarios survive. */
  | "history"
  /** Every local AI setting, credential and conversation. Scenario/roster survive. */
  | "all";

export interface ClearRepoConfig {
  db?: NurseSchedulerDb;
  now?: () => Date;
}

function resolve(config: ClearRepoConfig = {}) {
  return { db: config.db ?? getAssistantDb(), now: config.now ?? (() => new Date()) };
}

export interface ClearFence {
  scope: ClearScope;
  /** The generations as they are AFTER the increment. The deletion pass rereads these. */
  captured: CapturedGeneration[];
  /** The threads marked `cleared`. A count-bearing fact; ids are local, not content. */
  threadIds: string[];
  /** Whether the configuration row (credential included) was deleted. */
  configurationDeleted: boolean;
}

/**
 * Step 1: fence, mark, and -- for Clear all -- delete the configuration.
 *
 * One transaction, so "the generation moved" and "these threads are doomed" become
 * true together. There is no window in which the threads are marked but a late write
 * would still pass the fence.
 */
export async function beginClear(
  scope: ClearScope,
  scenarioId: string | null,
  config: ClearRepoConfig = {},
): Promise<ClearFence> {
  const { db, now } = resolve(config);

  if (scope === "history" && !scenarioId) {
    throw new Error("clear history requires a scenario identity");
  }

  return db.transaction("rw", ASSISTANT_CLEAR_TABLES, async () => {
    const at = now();
    const captured: CapturedGeneration[] = [];

    if (scope === "all") {
      // Every scope that has ever existed, plus the global one. The fence table is
      // the only durable record of which scenarios have had assistant data -- which
      // is precisely why it is never deleted.
      const scopes = new Set<GenerationScopeKey>([
        GLOBAL_GENERATION_SCOPE,
        ...(await readAllGenerationScopes(db)),
      ]);
      if (scenarioId) scopes.add(scenarioGenerationScope(scenarioId));
      for (const scopeKey of scopes) {
        captured.push(await bumpAssistantGeneration(db, scopeKey, at));
      }
    } else if (scenarioId) {
      // Deliberately NOT the global scope: clearing one scenario's conversation must
      // not fence writes belonging to another scenario's live turn. Every assistant
      // record captures BOTH scopes, so moving this one alone is sufficient to fence
      // everything that belongs to this scenario and nothing that does not.
      captured.push(await bumpAssistantGeneration(db, scenarioGenerationScope(scenarioId), at));
    }

    const threads =
      scope === "all" || !scenarioId
        ? await db.assistantThreads.toArray()
        : await db.assistantThreads.where("scenarioId").equals(scenarioId).toArray();

    for (const thread of threads) {
      await db.assistantThreads.put({
        ...thread,
        state: "cleared",
        updatedAt: at.toISOString(),
      });
    }

    let configurationDeleted = false;
    if (scope === "all") {
      await db.assistantSettings.delete(ASSISTANT_SETTINGS_KEY);
      configurationDeleted = true;
    }

    return {
      scope,
      captured,
      threadIds: threads.map((thread) => thread.threadId),
      configurationDeleted,
    };
  });
}

export interface ClearDeletion {
  outcome: "deleted" | "superseded";
  threads: number;
  messages: number;
  turns: number;
  proposals: number;
  receipts: number;
}

const NOTHING_DELETED: Omit<ClearDeletion, "outcome"> = {
  threads: 0,
  messages: 0,
  turns: 0,
  proposals: 0,
  receipts: 0,
};

/**
 * Step 2: delete the scoped user content, fenced on step 1's exact generations.
 *
 * `superseded` means a SECOND clear ran while this one was settling. That is not a
 * failure and must not delete anything here: the newer clear's own deletion pass
 * owns a strictly larger scope, so doing nothing is both correct and idempotent.
 */
export async function finishClear(
  fence: ClearFence,
  config: ClearRepoConfig = {},
): Promise<ClearDeletion> {
  const { db } = resolve(config);

  const result = await runFenced(db, ASSISTANT_CLEAR_TABLES, fence.captured, () =>
    deleteClearedThreadContent(db, fence.scope),
  );

  return result.outcome === "fenced"
    ? { outcome: "superseded", ...NOTHING_DELETED }
    : { outcome: "deleted", ...result.value };
}

/**
 * Finish any clear whose deletion pass never ran -- a reload, a crash, or a closed
 * tab during settlement.
 *
 * Deliberately not fenced against a remembered capture: after a reload there is no
 * remembered capture, and inventing one would be a lie. It does not need one either.
 * The set it deletes is defined by durable state (`state === "cleared"`), a state
 * only {@link beginClear} ever writes and only deletion ever removes -- so replaying
 * it deletes exactly what some earlier Clear already committed to deleting, no more.
 * A clear that lands concurrently only ADDS threads to that set.
 */
export async function resumePendingClears(config: ClearRepoConfig = {}): Promise<ClearDeletion> {
  const { db } = resolve(config);
  const pending = await db.assistantThreads.where("state").equals("cleared").count();
  if (pending === 0) return { outcome: "deleted", ...NOTHING_DELETED };

  const deleted = await db.transaction("rw", ASSISTANT_CLEAR_TABLES, () =>
    // Scope `history`: a resumed pass deletes conversation content only. A Clear all
    // had already deleted the configuration row in its first transaction, so there is
    // nothing left of it to delete here.
    deleteClearedThreadContent(db, "history"),
  );
  return { outcome: "deleted", ...deleted };
}

/**
 * Delete every record belonging to a thread marked `cleared`.
 *
 * Scoped by thread state rather than by scenario id or by generation comparison, and
 * that matters: a thread minted AFTER the clear carries the post-clear generations
 * and is `active`, so a conversation the user has already started again during
 * settlement is untouched.
 */
async function deleteClearedThreadContent(
  db: NurseSchedulerDb,
  scope: ClearScope,
): Promise<Omit<ClearDeletion, "outcome">> {
  const threads = await db.assistantThreads.where("state").equals("cleared").toArray();
  const threadIds = new Set(threads.map((thread) => thread.threadId));
  const scenarioIds = new Set(threads.map((thread) => thread.scenarioId));

  const messages = await db.assistantMessages.toArray();
  const doomedMessages = messages.filter((message) => threadIds.has(message.threadId));
  for (const message of doomedMessages) await db.assistantMessages.delete(message.messageId);

  const turns = await db.assistantTurns.toArray();
  const doomedTurns = turns.filter((turn) => threadIds.has(turn.threadId));
  for (const turn of doomedTurns) await db.assistantTurns.delete(turn.turnId);

  // Proposals and receipts are T07's behaviour but this ticket's retention rule:
  // "delete local messages, tool displays, receipts, and diagnostic UI state after
  // detachment". They are keyed by scenario, not by thread, so the cleared threads'
  // scenarios define the set. Under Clear all that is every scenario that had data.
  const proposals = (await db.assistantProposals.toArray()).filter((proposal) =>
    scenarioIds.has(proposal.scenarioId),
  );
  for (const proposal of proposals) await db.assistantProposals.delete(proposal.proposalId);

  const receipts = (await db.assistantReceipts.toArray()).filter((receipt) =>
    scenarioIds.has(receipt.scenarioId),
  );
  for (const receipt of receipts) await db.assistantReceipts.delete(receipt.receiptId);

  for (const threadId of threadIds) await db.assistantThreads.delete(threadId);

  // Clear all deletes the configuration row in `beginClear`; this is a defensive
  // re-check for the case where a row was written between the two transactions (a
  // probe that completed while settlement was in flight).
  if (scope === "all") await db.assistantSettings.delete(ASSISTANT_SETTINGS_KEY);

  return {
    threads: threadIds.size,
    messages: doomedMessages.length,
    turns: doomedTurns.length,
    proposals: proposals.length,
    receipts: receipts.length,
  };
}
