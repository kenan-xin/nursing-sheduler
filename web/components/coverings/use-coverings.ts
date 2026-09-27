"use client";

// Store binding for the coverings editor (T13). Reads the covering cards from the
// durable scenario slice and exposes CRUD + reorder as operations that each apply
// exactly one `scenarioCommands.mutate` patch — so every op is one undo entry and one
// persisted revision (T04 store discipline). All logic lives in `coverings-model`;
// this hook is only the store glue.

import { useShallow } from "zustand/react/shallow";
import { useScenarioStore, type ScenarioStoreState } from "@/lib/store";
import type { CommandOutcome } from "@/lib/store";
import { commitCardsSlice, commitCardsTransform } from "@/components/card-editor/commit-cards";
import type { CoveringCard } from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import {
  buildCoveringCard,
  reorderByDrop,
  withCardDisabled,
  type CoveringFormState,
  type CoveringsScenarioInput,
} from "./coverings-model";

/** Replace the coverings list in one tracked mutation (fresh refs for history). */

export interface CoveringsController {
  state: CoveringsScenarioInput;
  coverings: CoveringCard[];
  /** Read the LIVE coverings slice at call time (not a render snapshot) — the
   *  stale guard keys on its ref-identity change since the draft opened. */
  getCards: () => CoveringCard[];
  add: (form: CoveringFormState) => void;
  /** Edit-save. Awaits the baseline-guarded commit so the caller can surface a
   *  `superseded` refusal WITHOUT closing the draft. */
  update: (uid: string, form: CoveringFormState) => Promise<CommandOutcome>;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half. */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker (M4). A disabled covering is excluded from
   *  the canonical doc (canonical.ts drops `card.disabled`), so this is one tracked
   *  mutation — one undo entry, one persisted revision. */
  setDisabled: (uid: string, value: boolean) => void;
}

/** The slices the Coverings screen reads — the people/shift domains its selectors
 *  offer and the dates it scopes them by. `cardsByKind` is deliberately NOT among
 *  them: the covering cards arrive from their own subscription, so editing a count
 *  or affinity card must not re-render this editor. */
function pickCoveringsScenario(state: ScenarioStoreState): CoveringsScenarioInput {
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

export function useCoverings(): CoveringsController {
  // `useShallow` compares the picked references, not the fresh wrapper object's
  // identity — without it zustand v5 reads a new snapshot every render. The
  // wrapper is otherwise stable, so a mutation outside these slices leaves `state`
  // untouched and the screen neither re-renders nor reprojects.
  const state = useScenarioStore(useShallow(pickCoveringsScenario));
  const coverings = useScenarioStore((s) => s.cardsByKind.coverings);

  return {
    state,
    coverings,
    getCards: () => useScenarioStore.getState().cardsByKind.coverings,
    add(form) {
      // Queue-head transform: appends against the list the previous command
      // committed, so two rapid adds both land (T03F1 round-2).
      void commitCardsTransform("coverings", (current) => [...current, buildCoveringCard(form)]);
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
      // Edit-save: baseline-guarded so a moved list refuses (`superseded`) and the
      // caller can keep the draft open. Awaits and returns the outcome.
      return commitCardsSlice(
        "coverings",
        coverings,
        coverings.map((card) => (card.uid === uid ? next : card)),
      );
    },
    remove(uid) {
      void commitCardsTransform("coverings", (current) =>
        current.filter((card) => card.uid !== uid),
      );
    },
    duplicate(uid) {
      void commitCardsTransform("coverings", (current) => {
        const index = current.findIndex((card) => card.uid === uid);
        if (index === -1) return current;
        const source = current[index];
        const descriptions = current.map((card) => card.description ?? "");
        const clone: CoveringCard = {
          ...structuredClone(source),
          uid: crypto.randomUUID(),
          description: getUniqueCopyLabel(source.description ?? "", descriptions),
        };
        return [...current.slice(0, index + 1), clone, ...current.slice(index + 1)];
      });
    },
    // INTEGRATION: `move` replaced by `reorder` on main; see use-affinities.ts.
    reorder(fromUid, toUid, position) {
      // Queue-head transform: re-derives the order from the list the previous
      // command committed. A no-op returns the same reference (no commit).
      void commitCardsTransform("coverings", (current) => {
        const next = reorderByDrop(current, fromUid, toUid, position);
        return next.some((card, index) => card.uid !== current[index].uid) ? next : current;
      });
    },
    setDisabled(uid, value) {
      void commitCardsTransform("coverings", (current) =>
        current.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
