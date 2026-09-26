"use client";

// Store binding for the Shift Counts editor (T12 seed). Reads the count cards from
// the durable scenario slice and exposes CRUD + reorder as operations that each
// apply exactly one `scenarioCommands.mutate` patch — so every op is one undo entry
// and one persisted revision (T04 store discipline). All logic lives in
// `counts-model`; this hook is only the store glue.

import { useShallow } from "zustand/react/shallow";
import { useScenarioStore, type ScenarioStoreState } from "@/lib/store";
import type { CommandOutcome } from "@/lib/store";
import { commitCardsSlice, commitCardsTransform } from "@/components/card-editor/commit-cards";
import type { CountCard } from "@/lib/scenario";
import { getUniqueCopyLabel } from "@/components/entity-editor/core";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";
import {
  buildCountCard,
  buildCountShiftTypeDomain,
  reorderByDrop,
  withCardDisabled,
  type CountFormState,
  type CountScenarioInput,
} from "./counts-model";
import { buildContractedCard, type ContractedFormState } from "./contracted-model";

export interface CountsController {
  state: CountScenarioInput;
  counts: CountCard[];
  /** Read the LIVE counts slice at call time (not a render snapshot) — the stale
   *  guard keys on its ref-identity change since the draft opened. */
  getCards: () => CountCard[];
  add: (form: CountFormState) => void;
  /** Edit-save. Awaits the baseline-guarded commit so the caller can surface a
   *  `superseded` refusal WITHOUT closing the draft. Returns the outcome. */
  update: (uid: string, form: CountFormState) => Promise<CommandOutcome>;
  /** Author a MARKED contracted-hours card (M2a-2) — one tracked mutation. */
  addContracted: (form: ContractedFormState) => void;
  /** Replace a contracted-hours card, preserving its uid + `disabled`/`applied`
   *  markers exactly like the ordinary {@link CountsController.update} path.
   *  Awaits so the caller can surface a refusal. */
  updateContracted: (uid: string, form: ContractedFormState) => Promise<CommandOutcome>;
  /** Swap a card for an already-built one in place — same uid + list index, with
   *  `disabled`/`applied` carried forward (mirrors {@link CountsController.updateContracted}'s
   *  marker discipline). The Convert ↔ generic entry point (M2a-4); one tracked
   *  mutation, so one undo entry. */
  replaceCard: (uid: string, nextCard: CountCard) => void;
  remove: (uid: string) => void;
  duplicate: (uid: string) => void;
  /** Move the `from` card relative to the `to` card, honoring the pointer half
   *  (`"before"`/`"after"`) — the primary DnD control (FR-PR-12). */
  reorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Set the UI-only `disabled` marker (M4). A disabled count is excluded from the
   * canonical doc, so this is one tracked mutation — one undo entry. */
  setDisabled: (uid: string, value: boolean) => void;
}

/** The slices the Counts screen reads — the people/shift domains its selectors
 *  offer, the dates it scopes them by, and the request pins its leave advisory
 *  consults. `cardsByKind` is deliberately NOT among them: the count cards arrive
 *  from their own subscription, so editing a covering or affinity card must not
 *  re-render this editor (nor recompute its leave guard). */
function pickCountScenario(state: ScenarioStoreState): CountScenarioInput {
  return {
    staff: state.staff,
    staffGroups: state.staffGroups,
    shifts: state.shifts,
    shiftGroups: state.shiftGroups,
    rangeStart: state.rangeStart,
    rangeEnd: state.rangeEnd,
    dateGroups: state.dateGroups,
    reqData: state.reqData,
  };
}

export function useCounts(): CountsController {
  // `useShallow` compares the picked references, not the fresh wrapper object's
  // identity — without it zustand v5 reads a new snapshot every render. The
  // wrapper is otherwise stable, so a mutation outside these slices leaves `state`
  // untouched and the screen neither re-renders nor re-runs its derivations.
  const state = useScenarioStore(useShallow(pickCountScenario));
  const counts = useScenarioStore((s) => s.cardsByKind.counts);

  return {
    state,
    counts,
    getCards: () => useScenarioStore.getState().cardsByKind.counts,
    add(form) {
      const domain = buildCountShiftTypeDomain(state);
      // Queue-head transform: appends against the list the previous command
      // committed, so two rapid adds both land (T03F1 round-2).
      void commitCardsTransform("counts", (current) => [...current, buildCountCard(form, domain)]);
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
      // Edit-save: baseline-guarded so a moved list refuses (`superseded`) and the
      // caller can keep the draft open. Awaits and returns the outcome.
      return commitCardsSlice(
        "counts",
        counts,
        counts.map((card) => (card.uid === uid ? next : card)),
      );
    },
    addContracted(form) {
      void commitCardsTransform("counts", (current) => [
        ...current,
        buildContractedCard(form, state),
      ]);
    },
    updateContracted(uid, form) {
      // Same identity/marker discipline as the ordinary update: preserve the uid so
      // the row is replaced in place, and carry forward `disabled`/`applied` — an
      // edit-save must never silently re-enable a card the user turned off.
      const source = counts.find((card) => card.uid === uid);
      const rebuilt = buildContractedCard(form, state, uid);
      const markers: Pick<CountCard, "disabled" | "applied"> = {};
      if (source?.disabled) markers.disabled = true;
      if (source?.applied) markers.applied = true;
      const next = markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
      return commitCardsSlice(
        "counts",
        counts,
        counts.map((card) => (card.uid === uid ? next : card)),
      );
    },
    replaceCard(uid, nextCard) {
      // Swap the card in place: keep the uid + list index, and carry forward the UI
      // markers so a convert never silently re-enables a card the user turned off —
      // the same discipline as update/updateContracted.
      void commitCardsTransform("counts", (current) => {
        const source = current.find((card) => card.uid === uid);
        if (!source) return current;
        const markers: Pick<CountCard, "disabled" | "applied"> = {};
        if (source.disabled) markers.disabled = true;
        if (source.applied) markers.applied = true;
        const rebuilt = { ...nextCard, uid } as CountCard;
        const next = markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
        return current.map((card) => (card.uid === uid ? next : card));
      });
    },
    remove(uid) {
      void commitCardsTransform("counts", (current) => current.filter((card) => card.uid !== uid));
    },
    duplicate(uid) {
      // A deep clone preserves ANY card shape verbatim — ordinary, contracted-
      // hours, or the unmarked generic-array fallback (FR-PR-55a) — since this
      // never routes through `buildCountCard`.
      void commitCardsTransform("counts", (current) => {
        const index = current.findIndex((card) => card.uid === uid);
        if (index === -1) return current;
        const source = current[index];
        // FR-PR-13: derive a unique "… copy" description via the shared helper —
        // strip any trailing copy/copy N suffix, append " copy", dedupe with 2/3/…,
        // and fall back to "Copy" for an undescribed source.
        const descriptions = current.map((card) => card.description ?? "");
        const description = getUniqueCopyLabel(source.description ?? "", descriptions);
        const clone: CountCard = {
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
      // command committed. A no-op (same card / not found) returns the same
      // reference so the write is suppressed.
      void commitCardsTransform("counts", (current) => {
        const next = reorderByDrop(current, fromUid, toUid, position);
        return next.some((card, i) => card.uid !== current[i].uid) ? next : current;
      });
    },
    setDisabled(uid, value) {
      void commitCardsTransform("counts", (current) =>
        current.map((card) => (card.uid === uid ? withCardDisabled(card, value) : card)),
      );
    },
  };
}
