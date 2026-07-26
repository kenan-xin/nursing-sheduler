"use client";

// Store binding for the Shift Successions editor (T12 M1 clone). Reads the
// succession cards from the durable scenario slice and exposes CRUD + reorder as
// operations that each apply exactly one `mutateScenario` patch — so every op is
// one zundo/undo entry and one persisted revision (T04 store discipline). All
// logic lives in `successions-model`; this hook is only the store glue (mirrors
// `use-counts.ts`).

import { useScenarioStore } from "@/lib/store";
import type { ScenarioUiState, SuccessionCard } from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import {
  buildSuccessionCard,
  reorderByDrop,
  withCardDisabled,
  type SuccessionFormState,
} from "./successions-model";

/** Replace the successions list in one tracked mutation (fresh refs for history). */
function commitSuccessions(next: SuccessionCard[]) {
  useScenarioStore.getState().mutateScenario((state) => ({
    cardsByKind: { ...state.cardsByKind, successions: next },
  }));
}

export interface SuccessionsController {
  state: ScenarioUiState;
  successions: SuccessionCard[];
  /** Read the LIVE successions slice at call time (not a render snapshot) — the
   *  stale guard keys on its ref-identity change since the draft opened. */
  getCards: () => SuccessionCard[];
  add: (form: SuccessionFormState) => void;
  update: (uid: string, form: SuccessionFormState) => void;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Swap a card one slot up (-1) or down (+1) — the keyboard-supplement control. */
  move: (uid: string, direction: -1 | 1) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half
   *  (`"before"`/`"after"`) — the primary DnD control (FR-PR-12). */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker. A disabled succession is excluded from the
   *  canonical doc, so this is one tracked mutation — one zundo entry. */
  setDisabled: (uid: string, value: boolean) => void;
}

export function useSuccessions(): SuccessionsController {
  // The durable store state is a superset of `ScenarioUiState`, so it satisfies
  // the pure model's input directly.
  const state: ScenarioUiState = useScenarioStore((s) => s);
  const successions = useScenarioStore((s) => s.cardsByKind.successions);

  return {
    state,
    successions,
    getCards: () => useScenarioStore.getState().cardsByKind.successions,
    add(form) {
      commitSuccessions([...successions, buildSuccessionCard(form)]);
    },
    update(uid, form) {
      // Preserve the card's identity (uid) so it stays the same row on replace,
      // AND carry forward its UI markers (`disabled`/`applied`). Only the
      // dedicated Enable/Disable action changes `disabled`; an edit-save must NOT
      // silently re-enable a succession the user turned off.
      const source = successions.find((card) => card.uid === uid);
      const rebuilt = buildSuccessionCard(form, uid);
      const markers: Pick<SuccessionCard, "disabled" | "applied"> = {};
      if (source?.disabled) markers.disabled = true;
      if (source?.applied) markers.applied = true;
      const next = markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
      commitSuccessions(successions.map((card) => (card.uid === uid ? next : card)));
    },
    remove(uid) {
      commitSuccessions(successions.filter((card) => card.uid !== uid));
    },
    duplicate(uid) {
      const index = successions.findIndex((card) => card.uid === uid);
      if (index === -1) return;
      const source = successions[index];
      // FR-PR-13: derive a unique "… copy" description via the shared helper —
      // strip any trailing copy/copy N suffix, append " copy", dedupe with 2/3/…,
      // and fall back to "Copy" for an undescribed source.
      const descriptions = successions.map((card) => card.description ?? "");
      const description = getUniqueCopyLabel(source.description ?? "", descriptions);
      const clone: SuccessionCard = {
        ...structuredClone(source),
        uid: crypto.randomUUID(),
        description,
      };
      commitSuccessions([
        ...successions.slice(0, index + 1),
        clone,
        ...successions.slice(index + 1),
      ]);
    },
    move(uid, direction) {
      const index = successions.findIndex((card) => card.uid === uid);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= successions.length) return;
      const next = [...successions];
      [next[index], next[target]] = [next[target], next[index]];
      commitSuccessions(next);
    },
    reorder(fromUid, toUid, position) {
      const next = reorderByDrop(successions, fromUid, toUid, position);
      // A no-op reorder (same card / not found) returns an identical order — skip
      // the write so a stray drop never spends an undo entry.
      if (next.some((card, i) => card.uid !== successions[i].uid)) commitSuccessions(next);
    },
    setDisabled(uid, value) {
      commitSuccessions(
        successions.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
