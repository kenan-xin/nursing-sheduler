"use client";

// Store binding for the Staffing Requirements editor (T12 M1 clone). Reads the
// requirement cards from the durable scenario slice and exposes CRUD + reorder as
// operations that each apply exactly one `mutateScenario` patch — so every op is
// one zundo/undo entry and one persisted revision (T04 store discipline). All
// logic lives in `requirements-model`; this hook is only the store glue (mirrors
// `use-counts.ts`).

import { useScenarioStore } from "@/lib/store";
import {
  pruneOrphanedGuidedRulePins,
  type RequirementCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import { reorderByDrop, withCardDisabled, type RequirementFormState } from "./requirements-model";
import { applyRequirementPatch } from "./requirement-patch";

/** Replace the requirements list in one tracked mutation (fresh refs for history).
 *  Also reconciles Guided rule pins (T14a): a removed card's pin is pruned in the
 *  SAME mutation, so no dangling pin can survive a direct delete. */
function commitRequirements(next: RequirementCard[]) {
  useScenarioStore.getState().mutateScenario((state) => {
    const cardsByKind = { ...state.cardsByKind, requirements: next };
    return {
      cardsByKind,
      guidedRulePins: pruneOrphanedGuidedRulePins(state.guidedRulePins, cardsByKind),
    };
  });
}

export interface RequirementsController {
  state: ScenarioUiState;
  requirements: RequirementCard[];
  /** Read the LIVE requirements slice at call time (not a render snapshot) — the
   *  stale guard keys on its ref-identity change since the draft opened. */
  getCards: () => RequirementCard[];
  add: (form: RequirementFormState) => void;
  update: (uid: string, form: RequirementFormState) => void;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Swap a card one slot up (-1) or down (+1) — the keyboard-supplement control. */
  move: (uid: string, direction: -1 | 1) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half
   *  (`"before"`/`"after"`) — the primary DnD control (FR-PR-12). */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker (M1). A disabled requirement is excluded
   *  from the canonical doc, so this is one tracked mutation — one zundo entry. */
  setDisabled: (uid: string, value: boolean) => void;
}

export function useRequirements(): RequirementsController {
  // The durable store state is a superset of `ScenarioUiState`, so it satisfies
  // the pure model's input directly.
  const state: ScenarioUiState = useScenarioStore((s) => s);
  const requirements = useScenarioStore((s) => s.cardsByKind.requirements);

  return {
    state,
    requirements,
    getCards: () => useScenarioStore.getState().cardsByKind.requirements,
    add(form) {
      useScenarioStore
        .getState()
        .mutateScenario((live) => applyRequirementPatch(live, { type: "add", form }));
    },
    update(uid, form) {
      useScenarioStore
        .getState()
        .mutateScenario((live) => applyRequirementPatch(live, { type: "update", uid, form }));
    },
    remove(uid) {
      commitRequirements(requirements.filter((card) => card.uid !== uid));
    },
    duplicate(uid) {
      const index = requirements.findIndex((card) => card.uid === uid);
      if (index === -1) return;
      const source = requirements[index];
      // FR-PR-13: derive a unique "… copy" description via the shared helper —
      // strip any trailing copy/copy N suffix, append " copy", dedupe with 2/3/…,
      // and fall back to "Copy" for an undescribed source.
      const descriptions = requirements.map((card) => card.description ?? "");
      const description = getUniqueCopyLabel(source.description ?? "", descriptions);
      const clone: RequirementCard = {
        ...structuredClone(source),
        uid: crypto.randomUUID(),
        description,
      };
      commitRequirements([
        ...requirements.slice(0, index + 1),
        clone,
        ...requirements.slice(index + 1),
      ]);
    },
    move(uid, direction) {
      const index = requirements.findIndex((card) => card.uid === uid);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= requirements.length) return;
      const next = [...requirements];
      [next[index], next[target]] = [next[target], next[index]];
      commitRequirements(next);
    },
    reorder(fromUid, toUid, position) {
      const next = reorderByDrop(requirements, fromUid, toUid, position);
      // A no-op reorder (same card / not found) returns an identical order — skip
      // the write so a stray drop never spends an undo entry.
      if (next.some((card, i) => card.uid !== requirements[i].uid)) commitRequirements(next);
    },
    setDisabled(uid, value) {
      commitRequirements(
        requirements.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
