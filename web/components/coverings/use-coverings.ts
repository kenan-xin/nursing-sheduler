"use client";

// Store binding for the coverings editor (T13). Reads the covering cards from the
// durable scenario slice and exposes CRUD + reorder as operations that each apply
// exactly one `mutateScenario` patch — so every op is one zundo/undo entry and one
// persisted revision (T04 store discipline). All logic lives in `coverings-model`;
// this hook is only the store glue.

import { useScenarioStore } from "@/lib/store";
import {
  pruneOrphanedGuidedRulePins,
  type CoveringCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import {
  buildCoveringCard,
  reorderByDrop,
  withCardDisabled,
  type CoveringFormState,
} from "./coverings-model";

/** Replace the coverings list in one tracked mutation (fresh refs for history).
 *  Also reconciles Guided rule pins (T14a): a removed card's pin is pruned in the
 *  SAME mutation, so no dangling pin can survive a direct delete. */
function commitCoverings(next: CoveringCard[]) {
  useScenarioStore.getState().mutateScenario((state) => {
    const cardsByKind = { ...state.cardsByKind, coverings: next };
    return {
      cardsByKind,
      guidedRulePins: pruneOrphanedGuidedRulePins(state.guidedRulePins, cardsByKind),
    };
  });
}

export interface CoveringsController {
  state: ScenarioUiState;
  coverings: CoveringCard[];
  /** Read the LIVE coverings slice at call time (not a render snapshot) — the
   *  stale guard keys on its ref-identity change since the draft opened. */
  getCards: () => CoveringCard[];
  add: (form: CoveringFormState) => void;
  update: (uid: string, form: CoveringFormState) => void;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Swap a card one slot up (-1) or down (+1) — the keyboard-supplement control. */
  move: (uid: string, direction: -1 | 1) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half. */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker (M4). A disabled covering is excluded from
   *  the canonical doc (canonical.ts drops `card.disabled`), so this is one tracked
   *  mutation — one zundo entry, one persisted revision. */
  setDisabled: (uid: string, value: boolean) => void;
}

export function useCoverings(): CoveringsController {
  // The durable store state is a superset of `ScenarioUiState`, so it satisfies
  // the pure model's input directly.
  const state: ScenarioUiState = useScenarioStore((s) => s);
  const coverings = useScenarioStore((s) => s.cardsByKind.coverings);

  return {
    state,
    coverings,
    getCards: () => useScenarioStore.getState().cardsByKind.coverings,
    add(form) {
      commitCoverings([...coverings, buildCoveringCard(form)]);
    },
    update(uid, form) {
      // Preserve the card's identity (uid) so it stays the same row on replace,
      // AND carry forward its UI markers (`disabled`/`applied`). Only the dedicated
      // Enable/Disable action changes `disabled`; an edit-save must NOT silently
      // re-enable a covering the user turned off — canonical.ts drops disabled
      // coverings, so losing the marker would change solver input (cold-review M1).
      const source = coverings.find((card) => card.uid === uid);
      const rebuilt = buildCoveringCard(form, uid);
      const markers: Pick<CoveringCard, "disabled" | "applied"> = {};
      if (source?.disabled) markers.disabled = true;
      if (source?.applied) markers.applied = true;
      const next = markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
      commitCoverings(coverings.map((card) => (card.uid === uid ? next : card)));
    },
    remove(uid) {
      commitCoverings(coverings.filter((card) => card.uid !== uid));
    },
    duplicate(uid) {
      const index = coverings.findIndex((card) => card.uid === uid);
      if (index === -1) return;
      const source = coverings[index];
      const descriptions = coverings.map((card) => card.description ?? "");
      const clone: CoveringCard = {
        ...structuredClone(source),
        uid: crypto.randomUUID(),
        description: getUniqueCopyLabel(source.description ?? "", descriptions),
      };
      commitCoverings([...coverings.slice(0, index + 1), clone, ...coverings.slice(index + 1)]);
    },
    move(uid, direction) {
      const index = coverings.findIndex((card) => card.uid === uid);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= coverings.length) return;
      const next = [...coverings];
      [next[index], next[target]] = [next[target], next[index]];
      commitCoverings(next);
    },
    reorder(fromUid, toUid, position) {
      const next = reorderByDrop(coverings, fromUid, toUid, position);
      if (next.some((card, index) => card.uid !== coverings[index].uid)) commitCoverings(next);
    },
    setDisabled(uid, value) {
      commitCoverings(
        coverings.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
