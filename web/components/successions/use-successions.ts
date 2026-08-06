"use client";

// Store binding for the Shift Successions editor (T12 M1 clone). Reads the
// succession cards from the durable scenario slice and exposes CRUD + reorder as
// operations that each apply exactly one `mutateScenario` patch — so every op is
// one undo entry and one persisted revision (T04 store discipline). All
// logic lives in `successions-model`; this hook is only the store glue (mirrors
// `use-counts.ts`).

import { useScenarioStore } from "@/lib/store";
import type { CommandOutcome } from "@/lib/store";
import { commitCardsSlice, commitCardsTransform } from "@/components/card-editor/commit-cards";
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

export interface SuccessionsController {
  state: ScenarioUiState;
  successions: SuccessionCard[];
  /** Read the LIVE successions slice at call time (not a render snapshot) — the
   *  stale guard keys on its ref-identity change since the draft opened. */
  getCards: () => SuccessionCard[];
  add: (form: SuccessionFormState) => void;
  /** Edit-save. Awaits the baseline-guarded commit so the caller can surface a
   *  `superseded` refusal WITHOUT closing the draft. */
  update: (uid: string, form: SuccessionFormState) => Promise<CommandOutcome>;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Swap a card one slot up (-1) or down (+1) — the keyboard-supplement control. */
  move: (uid: string, direction: -1 | 1) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half
   *  (`"before"`/`"after"`) — the primary DnD control (FR-PR-12). */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker. A disabled succession is excluded from the
   * canonical doc, so this is one tracked mutation — one undo entry. */
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
      // Queue-head transform: appends against the list the previous command
      // committed, so two rapid adds both land (T03F1 round-2).
      void commitCardsTransform("successions", (current) => [
        ...current,
        buildSuccessionCard(form),
      ]);
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
      // Edit-save: baseline-guarded so a moved list refuses (`superseded`) and the
      // caller can keep the draft open. Awaits and returns the outcome.
      return commitCardsSlice(
        "successions",
        successions,
        successions.map((card) => (card.uid === uid ? next : card)),
      );
    },
    remove(uid) {
      void commitCardsTransform("successions", (current) =>
        current.filter((card) => card.uid !== uid),
      );
    },
    duplicate(uid) {
      void commitCardsTransform("successions", (current) => {
        const index = current.findIndex((card) => card.uid === uid);
        if (index === -1) return current;
        const source = current[index];
        // FR-PR-13: derive a unique "… copy" description via the shared helper —
        // strip any trailing copy/copy N suffix, append " copy", dedupe with 2/3/…,
        // and fall back to "Copy" for an undescribed source.
        const descriptions = current.map((card) => card.description ?? "");
        const description = getUniqueCopyLabel(source.description ?? "", descriptions);
        const clone: SuccessionCard = {
          ...structuredClone(source),
          uid: crypto.randomUUID(),
          description,
        };
        return [...current.slice(0, index + 1), clone, ...current.slice(index + 1)];
      });
    },
    move(uid, direction) {
      void commitCardsTransform("successions", (current) => {
        const index = current.findIndex((card) => card.uid === uid);
        const target = index + direction;
        if (index === -1 || target < 0 || target >= current.length) return current;
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    },
    reorder(fromUid, toUid, position) {
      // Queue-head transform: re-derives the order from the list the previous
      // command committed. A no-op returns the same reference (no commit).
      void commitCardsTransform("successions", (current) => {
        const next = reorderByDrop(current, fromUid, toUid, position);
        return next.some((card, i) => card.uid !== current[i].uid) ? next : current;
      });
    },
    setDisabled(uid, value) {
      void commitCardsTransform("successions", (current) =>
        current.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
