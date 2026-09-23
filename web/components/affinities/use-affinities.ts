"use client";

// Store binding for the Shift Affinities editor (T12 M1 clone). Reads the
// affinity cards from the durable scenario slice and exposes CRUD + reorder as
// operations that each apply exactly one `mutateScenario` patch — so every op is
// one undo entry and one persisted revision (T04 store discipline). All
// logic lives in `affinities-model`; this hook is only the store glue (mirrors
// `use-counts.ts`'s `reorderByDrop` + `getUniqueCopyLabel` pattern).

import { useScenarioStore } from "@/lib/store";
import type { CommandOutcome } from "@/lib/store";
import { commitCardsSlice, commitCardsTransform } from "@/components/card-editor/commit-cards";
import type { AffinityCard, ScenarioUiState } from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import {
  buildAffinityCard,
  reorderByDrop,
  withCardDisabled,
  type AffinityFormState,
} from "./affinities-model";

/** Replace the affinities list in one tracked mutation (fresh refs for history). */

export interface AffinitiesController {
  state: ScenarioUiState;
  affinities: AffinityCard[];
  /** Read the LIVE affinities slice at call time (not a render snapshot) — the
   *  stale guard keys on its ref-identity change since the draft opened. */
  getCards: () => AffinityCard[];
  add: (form: AffinityFormState) => void;
  /** Edit-save. Awaits the baseline-guarded commit so the caller can surface a
   *  `superseded` refusal WITHOUT closing the draft. */
  update: (uid: string, form: AffinityFormState) => Promise<CommandOutcome>;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half
   *  (`"before"`/`"after"`) — the primary DnD control (FR-PR-12). */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker. A disabled affinity is excluded from the
   * canonical doc, so this is one tracked mutation — one undo entry. */
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
      // Queue-head transform: appends against the list the previous command
      // committed, so two rapid adds both land (T03F1 round-2).
      void commitCardsTransform("affinities", (current) => [...current, buildAffinityCard(form)]);
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
      // Edit-save: baseline-guarded so a moved list refuses (`superseded`) and the
      // caller can keep the draft open. Awaits and returns the outcome.
      return commitCardsSlice(
        "affinities",
        affinities,
        affinities.map((card) => (card.uid === uid ? next : card)),
      );
    },
    remove(uid) {
      void commitCardsTransform("affinities", (current) =>
        current.filter((card) => card.uid !== uid),
      );
    },
    duplicate(uid) {
      void commitCardsTransform("affinities", (current) => {
        const index = current.findIndex((card) => card.uid === uid);
        if (index === -1) return current;
        const source = current[index];
        // FR-PR-13: derive a unique "… copy" description via the shared helper —
        // strip any trailing copy/copy N suffix, append " copy", dedupe with 2/3/…,
        // and fall back to "Copy" for an undescribed source.
        const descriptions = current.map((card) => card.description ?? "");
        const description = getUniqueCopyLabel(source.description ?? "", descriptions);
        const clone: AffinityCard = {
          ...structuredClone(source),
          uid: crypto.randomUUID(),
          description,
        };
        return [...current.slice(0, index + 1), clone, ...current.slice(index + 1)];
      });
    },
    // INTEGRATION: the old `move(uid, direction)` nudge is gone. It was replaced by
    // `reorder` below (drag + keyboard drop positions); nothing calls `.move(` any
    // more and the API no longer declares it. The T03 boundary the assistant branch
    // gave `move` is not lost — every method here commits through
    // `commitCardsTransform`, never a projection setter.
    reorder(fromUid, toUid, position) {
      // Queue-head transform: re-derives the order from the list the previous
      // command committed. A no-op returns the same reference (no commit).
      void commitCardsTransform("affinities", (current) => {
        const next = reorderByDrop(current, fromUid, toUid, position);
        return next.some((card, i) => card.uid !== current[i].uid) ? next : current;
      });
    },
    setDisabled(uid, value) {
      void commitCardsTransform("affinities", (current) =>
        current.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
