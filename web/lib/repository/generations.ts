// Permanent assistant write fences ("generations").
//
// THE FAILURE THIS PREVENTS. A user clears AI history while a run is in flight.
// The local gate closes and the visible records are deleted — but a detached
// callback, a late tool result, or a reconnect after reload can still arrive with
// a perfectly valid-looking write. If the only defence is an in-memory flag, a
// reload clears the flag and the late write RECREATES data the user deleted.
//
// THE FENCE. A generation row is a NON-CONTENT counter that only ever increases,
// is never deleted by any clear path, and is checked inside the same transaction
// as the write it guards. An operation captures the generation before it starts;
// if a clear bumped it in the meantime, the write is refused. Reload does not
// help the late writer — the fence is durable, not in memory.
//
// TWO SCOPES because clears have two shapes: "Clear all AI data" bumps `global`,
// "clear this scenario's history" bumps `scenario:<id>`. A guard normally captures
// both, so either clear fences it.
//
// T02 owns the durable fence and these helpers. T05 owns wiring every assistant
// callback through them and the interruption orchestration around them.

import { RepositoryError } from "./errors";
import type { NurseSchedulerDb } from "./schema";
import {
  type AssistantWriteFenceV1,
  type CapturedGeneration,
  type GenerationScopeKey,
  GLOBAL_GENERATION_SCOPE,
  scenarioGenerationScope,
} from "./types";

/**
 * Read a fence, creating it at generation 0 if absent. Creation is idempotent and
 * carries no content, so a first read can safely mint it.
 */
export async function ensureGeneration(
  db: NurseSchedulerDb,
  scopeKey: GenerationScopeKey,
  now: Date,
): Promise<AssistantWriteFenceV1> {
  const existing = await db.assistantGenerations.get(scopeKey);
  if (existing) return existing;
  const created: AssistantWriteFenceV1 = {
    scopeKey,
    generation: 0,
    clearedAt: null,
    createdAt: now.toISOString(),
  };
  await db.assistantGenerations.put(created);
  return created;
}

/** The `global` + `scenario:<id>` pair an interruptible operation should capture. */
export function generationScopesFor(scenarioId: string): GenerationScopeKey[] {
  return [GLOBAL_GENERATION_SCOPE, scenarioGenerationScope(scenarioId)];
}

/**
 * Assert that no captured generation has moved. Because generations are monotonic,
 * "moved" can only mean "a clear happened after this operation started", which is
 * precisely the condition that must refuse the write.
 *
 * A capture naming a scope that does not exist yet is treated as generation 0,
 * which is the value `ensureGeneration` would have minted — so a guard cannot be
 * defeated by racing the row into existence.
 */
export async function assertGenerationsUnchanged(
  db: NurseSchedulerDb,
  captured: readonly CapturedGeneration[],
): Promise<void> {
  for (const capture of captured) {
    const fence = await db.assistantGenerations.get(capture.scopeKey);
    const current = fence?.generation ?? 0;
    if (current !== capture.generation) {
      throw new RepositoryError(
        "generation_fenced",
        "an assistant clear superseded this operation; the write is refused",
        { scopeKey: capture.scopeKey, captured: capture.generation, current },
      );
    }
  }
}
