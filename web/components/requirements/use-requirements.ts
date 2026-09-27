"use client";

// Store binding for the Staffing Requirements editor (T12 M1 clone). Reads the
// requirement cards from the durable scenario slice and exposes CRUD + reorder as
// operations that each apply exactly one `mutateScenario` patch — so every op is
// one undo entry and one persisted revision (T04 store discipline). All
// logic lives in `requirements-model`; this hook is only the store glue (mirrors
// `use-counts.ts`).

import { useShallow } from "zustand/react/shallow";
import { useScenarioStore, scenarioCommands, type ScenarioStoreState } from "@/lib/store";
import type { RequirementCard } from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import {
  reorderByDrop,
  withCardDisabled,
  type RequirementFormState,
  type RequirementScenarioInput,
} from "./requirements-model";
import { applyRequirementPatch } from "./requirement-patch";
import { commitCardsTransform } from "@/components/card-editor/commit-cards";

/** Replace the requirements list in one tracked mutation (fresh refs for history). */

export interface RequirementsController {
  state: RequirementScenarioInput;
  requirements: RequirementCard[];
  /** Read the LIVE requirements slice at call time (not a render snapshot) — the
   *  stale guard keys on its ref-identity change since the draft opened. */
  getCards: () => RequirementCard[];
  add: (form: RequirementFormState) => void;
  update: (uid: string, form: RequirementFormState) => void;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half
   *  (`"before"`/`"after"`) — the primary DnD control (FR-PR-12). */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker (M1). A disabled requirement is excluded
   *  from the canonical doc, so this is one tracked mutation — one undo entry. */
  setDisabled: (uid: string, value: boolean) => void;
}

/** The slices the Requirements screen reads — the people/shift domains it offers
 *  and the dates it scopes them by. `cardsByKind` is deliberately NOT among them:
 *  the screen's own cards arrive from their own subscription, so editing a
 *  covering card must not re-render this editor (nor recompute its coverage). */
function pickRequirementScenario(state: ScenarioStoreState): RequirementScenarioInput {
  return {
    staff: state.staff,
    staffGroups: state.staffGroups,
    shifts: state.shifts,
    shiftGroups: state.shiftGroups,
    rangeStart: state.rangeStart,
    rangeEnd: state.rangeEnd,
    dateGroups: state.dateGroups,
  };
}

export function useRequirements(): RequirementsController {
  // `useShallow` compares the picked references, not the fresh wrapper object's
  // identity — without it zustand v5 reads a new snapshot every render. The
  // wrapper is otherwise stable, so a mutation outside these slices leaves `state`
  // (and the editor's `computeCoverageWarnings` memo keyed on it) untouched.
  const state = useScenarioStore(useShallow(pickRequirementScenario));
  const requirements = useScenarioStore((s) => s.cardsByKind.requirements);

  return {
    state,
    requirements,
    getCards: () => useScenarioStore.getState().cardsByKind.requirements,
    add(form) {
      scenarioCommands.mutate((live) => applyRequirementPatch(live, { type: "add", form }));
    },
    update(uid, form) {
      scenarioCommands.mutate((live) => applyRequirementPatch(live, { type: "update", uid, form }));
    },
    remove(uid) {
      // Queue-head transform: filters against the list the previous command
      // committed, so two rapid removes both land (T03F1 round-2).
      void commitCardsTransform("requirements", (current) =>
        current.filter((card) => card.uid !== uid),
      );
    },
    duplicate(uid) {
      void commitCardsTransform("requirements", (current) => {
        const index = current.findIndex((card) => card.uid === uid);
        if (index === -1) return current;
        const source = current[index];
        // FR-PR-13: derive a unique "… copy" description via the shared helper —
        // strip any trailing copy/copy N suffix, append " copy", dedupe with 2/3/…,
        // and fall back to "Copy" for an undescribed source.
        const descriptions = current.map((card) => card.description ?? "");
        const description = getUniqueCopyLabel(source.description ?? "", descriptions);
        const clone: RequirementCard = {
          ...structuredClone(source),
          uid: crypto.randomUUID(),
          description,
        };
        return [...current.slice(0, index + 1), clone, ...current.slice(index + 1)];
      });
    },
    // INTEGRATION: `move` replaced by `reorder` on main; see use-affinities.ts.
    reorder(fromUid, toUid, position) {
      // Queue-head transform: re-derives the order from the list the previous
      // command committed. A no-op returns the same reference (no commit).
      void commitCardsTransform("requirements", (current) => {
        const next = reorderByDrop(current, fromUid, toUid, position);
        return next.some((card, i) => card.uid !== current[i].uid) ? next : current;
      });
    },
    setDisabled(uid, value) {
      void commitCardsTransform("requirements", (current) =>
        current.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
