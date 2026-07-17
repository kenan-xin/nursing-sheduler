"use client";

// Store binding for the Shift Counts editor (T12 seed). Reads the count cards from
// the durable scenario slice and exposes CRUD + reorder as operations that each
// apply exactly one `mutateScenario` patch — so every op is one zundo/undo entry
// and one persisted revision (T04 store discipline). All logic lives in
// `counts-model`; this hook is only the store glue.

import { useScenarioStore } from "@/lib/store";
import type { CountCard, ScenarioUiState } from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import {
  buildCountCard,
  buildCountShiftTypeDomain,
  reorderByDrop,
  withCardDisabled,
  type CountFormState,
} from "./counts-model";

/** Replace the counts list in one tracked mutation (fresh refs for history). */
function commitCounts(next: CountCard[]) {
  useScenarioStore.getState().mutateScenario((state) => ({
    cardsByKind: { ...state.cardsByKind, counts: next },
  }));
}

export interface CountsController {
  state: ScenarioUiState;
  counts: CountCard[];
  /** Read the LIVE counts slice at call time (not a render snapshot) — the stale
   *  guard keys on its ref-identity change since the draft opened. */
  getCards: () => CountCard[];
  add: (form: CountFormState) => void;
  update: (uid: string, form: CountFormState) => void;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Swap a card one slot up (-1) or down (+1) — the keyboard-supplement control. */
  move: (uid: string, direction: -1 | 1) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half
   *  (`"before"`/`"after"`) — the primary DnD control (FR-PR-12). */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker (M4). A disabled count is excluded from the
   *  canonical doc, so this is one tracked mutation — one zundo entry. */
  setDisabled: (uid: string, value: boolean) => void;
}

export function useCounts(): CountsController {
  // The durable store state is a superset of `ScenarioUiState`, so it satisfies
  // the pure model's input directly.
  const state: ScenarioUiState = useScenarioStore((s) => s);
  const counts = useScenarioStore((s) => s.cardsByKind.counts);

  return {
    state,
    counts,
    getCards: () => useScenarioStore.getState().cardsByKind.counts,
    add(form) {
      const domain = buildCountShiftTypeDomain(state);
      commitCounts([...counts, buildCountCard(form, domain)]);
    },
    update(uid, form) {
      // Preserve the card's identity (uid) so it stays the same row on replace,
      // AND carry forward its UI markers (`disabled`/`applied`). Only the
      // dedicated Enable/Disable action changes `disabled`; an edit-save must NOT
      // silently re-enable a count the user turned off.
      const domain = buildCountShiftTypeDomain(state);
      const source = counts.find((card) => card.uid === uid);
      const rebuilt = buildCountCard(form, domain, uid);
      const markers: Pick<CountCard, "disabled" | "applied"> = {};
      if (source?.disabled) markers.disabled = true;
      if (source?.applied) markers.applied = true;
      const next = markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
      commitCounts(counts.map((card) => (card.uid === uid ? next : card)));
    },
    remove(uid) {
      commitCounts(counts.filter((card) => card.uid !== uid));
    },
    duplicate(uid) {
      // A deep clone preserves ANY card shape verbatim — ordinary, contracted-
      // hours, or the unmarked generic-array fallback (FR-PR-55a) — since this
      // never routes through `buildCountCard`.
      const index = counts.findIndex((card) => card.uid === uid);
      if (index === -1) return;
      const source = counts[index];
      // FR-PR-13: derive a unique "… copy" description via the shared helper —
      // strip any trailing copy/copy N suffix, append " copy", dedupe with 2/3/…,
      // and fall back to "Copy" for an undescribed source.
      const descriptions = counts.map((card) => card.description ?? "");
      const description = getUniqueCopyLabel(source.description ?? "", descriptions);
      const clone: CountCard = {
        ...structuredClone(source),
        uid: crypto.randomUUID(),
        description,
      };
      commitCounts([...counts.slice(0, index + 1), clone, ...counts.slice(index + 1)]);
    },
    move(uid, direction) {
      const index = counts.findIndex((card) => card.uid === uid);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= counts.length) return;
      const next = [...counts];
      [next[index], next[target]] = [next[target], next[index]];
      commitCounts(next);
    },
    reorder(fromUid, toUid, position) {
      const next = reorderByDrop(counts, fromUid, toUid, position);
      // A no-op reorder (same card / not found) returns an identical order — skip
      // the write so a stray drop never spends an undo entry.
      if (next.some((card, i) => card.uid !== counts[i].uid)) commitCounts(next);
    },
    setDisabled(uid, value) {
      commitCounts(counts.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)));
    },
  };
}
