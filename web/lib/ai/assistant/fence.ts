// The transactional write fence every assistant write passes through (T05).
//
// T02 owns the durable `AssistantWriteFenceV1` rows and the three primitives
// (`ensureGeneration`, `generationScopesFor`, `assertGenerationsUnchanged`). This
// module owns what the tech plan requires of T05: that every assistant write --
// message, tool display, proposal, confirmation, receipt, diagnostic ownership, and
// turn-state -- performs the check INSIDE the same Dexie transaction as the write.
//
// THE RULE, and it is the whole point: a check performed BEFORE the transaction is
// an optimisation and never an authorisation. A callback can pass an
// out-of-transaction precheck and then lose the race to a Clear that increments the
// generation before its write commits; only a check inside the write's own
// transaction rejects that. So there is deliberately no exported "is it safe to
// write?" predicate here -- the only way to use this module is to hand it the work.
//
// A FENCED WRITE IS NOT AN ERROR. It is the designed outcome of "the user cleared
// this while you were away", so {@link runFenced} returns it as a value. Throwing
// would push a normal, expected quarantine into every caller's error path, where it
// would sooner or later be reported to the user as a failure or -- worse -- retried.

import {
  assertGenerationsUnchanged,
  ensureGeneration,
  generationScopesFor,
  GLOBAL_GENERATION_SCOPE,
  isRepositoryError,
  type CapturedGeneration,
  type GenerationScopeKey,
  type NurseSchedulerDb,
} from "@/lib/repository";

/** The outcome of an attempted fenced write. `fenced` means "dropped, correctly". */
export type FenceResult<T> = { outcome: "accepted"; value: T } | { outcome: "fenced" };

/**
 * The generation pair a turn (and therefore every write belonging to it) captures.
 *
 * Stored on the durable turn/message rows rather than only held in a closure, which
 * is what makes the fence survive a reload: a late write reloaded into a new page
 * lifetime still knows which generations it was prepared under.
 */
export interface AssistantGenerationPair {
  globalGeneration: number;
  scenarioGeneration: number;
}

/**
 * Capture `global` + `scenario:<id>` as they are right now, minting either row at
 * generation 0 if it has never existed.
 *
 * Must be called inside a read-write transaction that includes
 * `assistantGenerations` (minting is a write). A scenario-less capture takes the
 * global scope alone.
 */
export async function captureAssistantGenerations(
  db: NurseSchedulerDb,
  scenarioId: string | null,
  at: Date,
): Promise<CapturedGeneration[]> {
  const scopes: GenerationScopeKey[] = scenarioId
    ? generationScopesFor(scenarioId)
    : [GLOBAL_GENERATION_SCOPE];
  const captured: CapturedGeneration[] = [];
  for (const scopeKey of scopes) {
    const fence = await ensureGeneration(db, scopeKey, at);
    captured.push({ scopeKey, generation: fence.generation });
  }
  return captured;
}

/** The same capture in the shape the durable turn/message rows store it. */
export function toGenerationPair(captured: readonly CapturedGeneration[]): AssistantGenerationPair {
  const global = captured.find((entry) => entry.scopeKey === GLOBAL_GENERATION_SCOPE);
  const scenario = captured.find((entry) => entry.scopeKey !== GLOBAL_GENERATION_SCOPE);
  return {
    globalGeneration: global?.generation ?? 0,
    scenarioGeneration: scenario?.generation ?? 0,
  };
}

/** Rebuild a capture from a durable row's stored pair plus its scenario identity. */
export function fromGenerationPair(
  scenarioId: string,
  pair: AssistantGenerationPair,
): CapturedGeneration[] {
  const [global, scenario] = generationScopesFor(scenarioId);
  return [
    { scopeKey: global, generation: pair.globalGeneration },
    { scopeKey: scenario, generation: pair.scenarioGeneration },
  ];
}

/**
 * Run `work` in one transaction that first rereads every captured generation.
 *
 * The assert runs FIRST and inside the transaction, so a mismatch aborts before any
 * row is touched -- the write is rolled back by IndexedDB rather than undone by
 * application code.
 */
export async function runFenced<T>(
  db: NurseSchedulerDb,
  tables: readonly string[],
  captured: readonly CapturedGeneration[],
  work: () => Promise<T>,
): Promise<FenceResult<T>> {
  try {
    const value = await db.transaction("rw", [...tables], async () => {
      await assertGenerationsUnchanged(db, captured);
      return work();
    });
    return { outcome: "accepted", value };
  } catch (error) {
    // ONLY the fence is swallowed. A storage failure is a different fact and must
    // keep propagating, or an unavailable IndexedDB would masquerade as "the user
    // cleared this" and the app would silently stop persisting.
    if (isRepositoryError(error, "generation_fenced")) return { outcome: "fenced" };
    throw error;
  }
}

/**
 * Increment one scope's generation and stamp `clearedAt`.
 *
 * Monotonic by construction: it only ever reads and adds one. Must be called inside
 * the clear's own read-write transaction, which is what makes "bump the fence" and
 * "mark the threads cleared" one atomic fact rather than two.
 */
export async function bumpAssistantGeneration(
  db: NurseSchedulerDb,
  scopeKey: GenerationScopeKey,
  at: Date,
): Promise<CapturedGeneration> {
  const fence = await ensureGeneration(db, scopeKey, at);
  const next = fence.generation + 1;
  await db.assistantGenerations.put({
    ...fence,
    generation: next,
    clearedAt: at.toISOString(),
  });
  return { scopeKey, generation: next };
}

/**
 * Every scope key that currently has a fence row.
 *
 * Clear all has to bump the global scope AND every affected scenario scope, and the
 * only durable record of "which scenarios have ever had assistant data" is the fence
 * table itself -- which is exactly why these rows are never deleted.
 */
export async function readAllGenerationScopes(db: NurseSchedulerDb): Promise<GenerationScopeKey[]> {
  const rows = await db.assistantGenerations.toArray();
  return rows.map((row) => row.scopeKey);
}
