"use client";

// Store binding for the Shift Affinities editor (T12 M1 clone). Reads the
// affinity cards from the durable scenario slice and exposes CRUD + reorder as
// operations that each apply exactly one `mutateScenario` patch — so every op is
// one zundo/undo entry and one persisted revision (T04 store discipline). All
// logic lives in `affinities-model`; this hook is only the store glue (mirrors
// `use-counts.ts`'s `reorderByDrop` + `getUniqueCopyLabel` pattern).

import { useScenarioStore } from "@/lib/store";
import {
  pruneOrphanedGuidedRulePins,
  type AffinityCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import {
  buildAffinityCard,
  reorderByDrop,
  withCardDisabled,
  type AffinityFormState,
} from "./affinities-model";

/** Replace the affinities list in one tracked mutation (fresh refs for history).
 *  Also reconciles Guided rule pins (T14a): a removed card's pin is pruned in the
 *  SAME mutation, so no dangling pin can survive a direct delete. */
function commitAffinities(next: AffinityCard[]) {
  useScenarioStore.getState().mutateScenario((state) => {
    const cardsByKind = { ...state.cardsByKind, affinities: next };
    return {
      cardsByKind,
      guidedRulePins: pruneOrphanedGuidedRulePins(state.guidedRulePins, cardsByKind),
    };
  });
}

export interface AffinitiesController {
  state: ScenarioUiState;
  affinities: AffinityCard[];
  /** Read the LIVE affinities slice at call time (not a render snapshot) — the
   *  stale guard keys on its ref-identity change since the draft opened. */
  getCards: () => AffinityCard[];
  add: (form: AffinityFormState) => void;
  update: (uid: string, form: AffinityFormState) => void;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Swap a card one slot up (-1) or down (+1) — the keyboard-supplement control. */
  move: (uid: string, direction: -1 | 1) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half
   *  (`"before"`/`"after"`) — the primary DnD control (FR-PR-12). */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker. A disabled affinity is excluded from the
   *  canonical doc, so this is one tracked mutation — one zundo entry. */
  setDisabled: (uid: string, value: boolean) => void;
}

export function useAffinities(): AffinitiesController {
  // The durable store state is a superset of `ScenarioUiState`, so it satisfies
  // the pure model's input directly.
  const state: ScenarioUiState = useScenarioStore((s) => s);
  const affinities = useScenarioStore((s) => s.cardsByKind.affinities);

  return {
    state,
    affinities,
    getCards: () => useScenarioStore.getState().cardsByKind.affinities,
    add(form) {
      commitAffinities([...affinities, buildAffinityCard(form)]);
    },
    update(uid, form) {
      // Preserve the card's identity (uid) so it stays the same row on replace,
      // AND carry forward its UI markers (`disabled`/`applied`). Only the
      // dedicated Enable/Disable action changes `disabled`; an edit-save must NOT
      // silently re-enable an affinity the user turned off.
      const source = affinities.find((card) => card.uid === uid);
      const rebuilt = buildAffinityCard(form, uid);
      const markers: Pick<AffinityCard, "disabled" | "applied"> = {};
      if (source?.disabled) markers.disabled = true;
      if (source?.applied) markers.applied = true;
      const next = markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
      commitAffinities(affinities.map((card) => (card.uid === uid ? next : card)));
    },
    remove(uid) {
      commitAffinities(affinities.filter((card) => card.uid !== uid));
    },
    duplicate(uid) {
      const index = affinities.findIndex((card) => card.uid === uid);
      if (index === -1) return;
      const source = affinities[index];
      // FR-PR-13: derive a unique "… copy" description via the shared helper —
      // strip any trailing copy/copy N suffix, append " copy", dedupe with 2/3/…,
      // and fall back to "Copy" for an undescribed source.
      const descriptions = affinities.map((card) => card.description ?? "");
      const description = getUniqueCopyLabel(source.description ?? "", descriptions);
      const clone: AffinityCard = {
        ...structuredClone(source),
        uid: crypto.randomUUID(),
        description,
      };
      commitAffinities([...affinities.slice(0, index + 1), clone, ...affinities.slice(index + 1)]);
    },
    move(uid, direction) {
      const index = affinities.findIndex((card) => card.uid === uid);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= affinities.length) return;
      const next = [...affinities];
      [next[index], next[target]] = [next[target], next[index]];
      commitAffinities(next);
    },
    reorder(fromUid, toUid, position) {
      const next = reorderByDrop(affinities, fromUid, toUid, position);
      // A no-op reorder (same card / not found) returns an identical order — skip
      // the write so a stray drop never spends an undo entry.
      if (next.some((card, i) => card.uid !== affinities[i].uid)) commitAffinities(next);
    },
    setDisabled(uid, value) {
      commitAffinities(
        affinities.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
