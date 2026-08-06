"use client";

// Queue-head card-list commits for the card-editor family (T03).
//
// THE RACE THIS CLOSES. Every card operation — Save, duplicate, delete, reorder,
// disable — used to compute the WHOLE next list from the render snapshot it could
// see, then replace the live list with it. Before the cutover that was safe by
// construction: the write applied synchronously, so nothing could land between
// reading the snapshot and replacing the list.
//
// A durable command settles asynchronously. So an Undo, a Redo, or a cascade from
// another surface can commit in the window between a click and its write — and a
// whole-list replacement computed from the pre-Undo snapshot would then quietly
// undo the Undo. Two rapid actions from one render had the same defect: both
// carried the same baseline list, the first commit changed it, and the second was
// silently dropped (`superseded`) because its baseline no longer matched — the
// user's second action simply vanished.
//
// The fix is to apply the operation WHERE the answer is knowable: at the head of
// the command queue, against the list the previous command committed. `mutate`'s
// updater runs there, so a transform over `live.cardsByKind[kind]` composes two
// rapid duplicates instead of dropping the second.
//
// Reference identity is the right no-op test, and it is the same one the stale
// guard uses: the projection publishes through `shareStructure`, so an untouched
// slice keeps its reference across unrelated commits and a changed one does not.

import type { CardsByKind } from "@/lib/scenario";
import { scenarioCommands, type CommandOutcome } from "@/lib/store";

/**
 * Apply a queue-head transform to one card-kind list — add/remove/duplicate/
 * reorder/toggle. The transform runs at the command queue head against the list
 * the previous command committed, so rapid actions COMPOSE instead of
 * overwriting each other.
 *
 * The transform MUST return the SAME list reference for a semantically empty
 * operation (a no-op reorder, a toggle that lands on the value already held) —
 * that reference equality is how the commit is suppressed so a stray action never
 * spends an undo entry. Returning a new list always commits.
 *
 * Use {@link commitCardsSlice} for edit-save operations that intentionally
 * refuse a moved baseline; this function has no baseline and never returns
 * `superseded`.
 */
export function commitCardsTransform<TKind extends keyof CardsByKind>(
  kind: TKind,
  transform: (current: CardsByKind[TKind]) => CardsByKind[TKind],
): Promise<CommandOutcome> {
  return scenarioCommands.mutate((state) => {
    const current = state.cardsByKind[kind];
    const next = transform(current);
    // Same reference → no-op. Return an empty patch so `mutate` detects no changed
    // keys and reports `{ ok: true, committed: false }` rather than `superseded`.
    if (next === current) return {};
    return { cardsByKind: { ...state.cardsByKind, [kind]: next } };
  });
}

/**
 * Replace one card-kind list in a single durable commit — but only if the live
 * list is still the one `next` was computed from.
 *
 * `baseline` is the caller's render snapshot of that list. When it no longer
 * matches durable truth the write is REFUSED (`superseded`) rather than applied
 * on top. This is the edit-save seam: an operation that must not silently
 * overwrite a list that moved under it. The caller is expected to await and
 * surface the refusal (keeping its draft open) rather than closing on a dropped
 * write.
 *
 * Prefer {@link commitCardsTransform} for add/remove/duplicate/reorder/toggle,
 * which compose at the queue head and have no baseline to move.
 */
export function commitCardsSlice<TKind extends keyof CardsByKind>(
  kind: TKind,
  baseline: readonly CardsByKind[TKind][number][],
  next: CardsByKind[TKind],
): Promise<CommandOutcome> {
  return scenarioCommands.mutate((state) =>
    state.cardsByKind[kind] === baseline
      ? { cardsByKind: { ...state.cardsByKind, [kind]: next } }
      : null,
  );
}
