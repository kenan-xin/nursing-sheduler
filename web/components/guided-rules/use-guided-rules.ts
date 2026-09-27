"use client";

// Store binding for the Guided Rules screen (T14c). Reads the durable scenario
// slice, projects it into `GuidedRuleRow`s via the T14b registry, and exposes
// toggle/adjust/rename as operations that each apply exactly one
// `mutateScenario` patch — so a Guided edit is exactly as tracked as its Advanced
// equivalent (one undo entry, one persisted revision), mirroring every other
// card hook's `commitX` discipline (`components/counts/use-counts.ts`).
//
// `rename` writes the source constraint's OWN `description` (the built-in row's
// `maxOneShiftPerDay.description`), exactly as an Advanced edit does — so the
// Rules screen never becomes a second source of truth for a rule's label.

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useScenarioStore, scenarioCommands, type ScenarioStoreState } from "@/lib/store";
import type {
  AffinityCard,
  CardsByKind,
  CountCard,
  CoveringCard,
  GuidedRuleConstraintKind,
  RequirementCard,
  SuccessionCard,
} from "@/lib/scenario";
import { projectGuidedRules } from "./registry";
import {
  affinitiesMapper,
  countsMapper,
  coveringsMapper,
  requirementsMapper,
  successionsMapper,
} from "./mappers";
import {
  applyAffinityQuickEdit,
  applyCountQuickEdit,
  applyCoveringQuickEdit,
  applyRequirementQuickEdit,
  applySuccessionQuickEdit,
  toggleAffinityRule,
  toggleCountRule,
  toggleCoveringRule,
  toggleRequirementRule,
  toggleSuccessionRule,
} from "./mutations";
import type { GuidedMutationOutcome, GuidedRuleRow, GuidedRulesScenario } from "./types";

function replaceInPlace<TCard extends { uid: string }>(
  cards: readonly TCard[],
  constraintId: string,
  next: TCard,
): TCard[] {
  return cards.map((card) => (card.uid === constraintId ? next : card));
}

/**
 * Apply one guided rule operation: answer the UI now, and write it as a QUEUE-HEAD
 * TRANSFORM.
 *
 * The operation used to be resolved once against the render snapshot and the whole
 * resulting per-kind array handed to the command bus. Two rapid toggles then both
 * carried a full array built from the SAME pre-first-toggle snapshot, so the second
 * write replaced the first instead of building on it — the first toggle simply
 * vanished, with both reporting success.
 *
 * So the pure operation is re-run at the queue head, against the array the previous
 * command committed. `operate` is a pure function of the card list, which is what
 * makes running it twice safe: the first run is only used to answer the caller (so
 * an inline validation error still renders without a round trip), and the second is
 * the one that decides what is written. A card that has since been deleted, or an
 * operation the live state now rejects, withdraws the write instead of resurrecting
 * a stale list.
 */
function commitOutcome<TCard extends { uid: string }>(
  kind: GuidedRuleConstraintKind,
  cards: readonly TCard[],
  constraintId: string,
  operate: (cards: readonly TCard[]) => GuidedMutationOutcome<TCard>,
): GuidedMutationOutcome<TCard> {
  const outcome = operate(cards);
  if (outcome.kind !== "applied") return outcome;
  void scenarioCommands.mutate((live) => {
    const liveCards = live.cardsByKind[kind] as unknown as readonly TCard[];
    const settled = operate(liveCards);
    if (settled.kind !== "applied") return null;
    return {
      cardsByKind: {
        ...live.cardsByKind,
        [kind]: replaceInPlace(liveCards, constraintId, settled.card),
      } as CardsByKind,
    };
  });
  return outcome;
}

/** Recompute `cardsByKind` with the source card's title (its `description`)
 *  set to `title` — or `undefined` when the card is missing or `title` already
 *  matches its current default title, so an unchanged title never spends a
 *  history entry on a no-op write. */
function renamedCardsByKind(
  cardsByKind: CardsByKind,
  kind: GuidedRuleConstraintKind,
  constraintId: string,
  title: string,
): CardsByKind | undefined {
  switch (kind) {
    case "requirements": {
      const card = cardsByKind.requirements.find((c) => c.uid === constraintId);
      if (!card || requirementsMapper.defaultTitle(card) === title) return undefined;
      return {
        ...cardsByKind,
        requirements: replaceInPlace(
          cardsByKind.requirements,
          constraintId,
          requirementsMapper.rename(card, title),
        ),
      };
    }
    case "successions": {
      const card = cardsByKind.successions.find((c) => c.uid === constraintId);
      if (!card || successionsMapper.defaultTitle(card) === title) return undefined;
      return {
        ...cardsByKind,
        successions: replaceInPlace(
          cardsByKind.successions,
          constraintId,
          successionsMapper.rename(card, title),
        ),
      };
    }
    case "counts": {
      const card = cardsByKind.counts.find((c) => c.uid === constraintId);
      if (!card || countsMapper.defaultTitle(card) === title) return undefined;
      return {
        ...cardsByKind,
        counts: replaceInPlace(cardsByKind.counts, constraintId, countsMapper.rename(card, title)),
      };
    }
    case "affinities": {
      const card = cardsByKind.affinities.find((c) => c.uid === constraintId);
      if (!card || affinitiesMapper.defaultTitle(card) === title) return undefined;
      return {
        ...cardsByKind,
        affinities: replaceInPlace(
          cardsByKind.affinities,
          constraintId,
          affinitiesMapper.rename(card, title),
        ),
      };
    }
    case "coverings": {
      const card = cardsByKind.coverings.find((c) => c.uid === constraintId);
      if (!card || coveringsMapper.defaultTitle(card) === title) return undefined;
      return {
        ...cardsByKind,
        coverings: replaceInPlace(
          cardsByKind.coverings,
          constraintId,
          coveringsMapper.rename(card, title),
        ),
      };
    }
  }
}

export interface GuidedRulesController {
  state: GuidedRulesScenario;
  rows: GuidedRuleRow[];
  /** Toggle a rule's enabled state — writes the source card's `disabled`
   *  marker. A no-op (returns `missing-source`) for a built-in/locked row. */
  toggle(kind: GuidedRuleConstraintKind, constraintId: string, enabled: boolean): void;
  /** Apply a numeric quick edit; returns the outcome so the caller can render an
   *  inline validation error without a second round-trip. */
  adjust(
    kind: GuidedRuleConstraintKind,
    constraintId: string,
    fieldKey: string,
    rawValue: number,
  ): GuidedMutationOutcome<unknown>;
  /**
   * Relabel a rule by writing the source constraint's own `description` — the
   * card's for a record row, `maxOneShiftPerDay.description` for the built-in.
   * Available on every row, including locked and "Set in Advanced only" ones:
   * a label is not the constraint's shape. Exactly one tracked mutation, and a
   * blank or unchanged title writes nothing at all.
   */
  rename(row: GuidedRuleRow, title: string): void;
}

/** The two slices the Rules screen reads. Kept next to the hook rather than in
 *  `lib/store` because it is this screen's read list, not a store concept. */
function pickGuidedRulesScenario(state: ScenarioStoreState): GuidedRulesScenario {
  return { cardsByKind: state.cardsByKind, maxOneShiftPerDay: state.maxOneShiftPerDay };
}

export function useGuidedRules(): GuidedRulesController {
  // `useShallow` compares the picked REFERENCES rather than the fresh wrapper
  // object's identity — without it, zustand v5 reads a new snapshot on every
  // render ("getSnapshot should be cached"). The wrapper is otherwise stable, so
  // a mutation to another slice (a staff edit, say) leaves `state` untouched and
  // the screen does not re-render or reproject.
  const state = useScenarioStore(useShallow(pickGuidedRulesScenario));
  const rows = useMemo(() => projectGuidedRules(state), [state]);

  return {
    state,
    rows,
    toggle(kind, constraintId, enabled) {
      switch (kind) {
        case "requirements":
          commitOutcome(kind, state.cardsByKind.requirements, constraintId, (cards) =>
            toggleRequirementRule(cards, constraintId, enabled),
          );
          return;
        case "successions":
          commitOutcome(kind, state.cardsByKind.successions, constraintId, (cards) =>
            toggleSuccessionRule(cards, constraintId, enabled),
          );
          return;
        case "counts":
          commitOutcome(kind, state.cardsByKind.counts, constraintId, (cards) =>
            toggleCountRule(cards, constraintId, enabled),
          );
          return;
        case "affinities":
          commitOutcome(kind, state.cardsByKind.affinities, constraintId, (cards) =>
            toggleAffinityRule(cards, constraintId, enabled),
          );
          return;
        case "coverings":
          commitOutcome(kind, state.cardsByKind.coverings, constraintId, (cards) =>
            toggleCoveringRule(cards, constraintId, enabled),
          );
          return;
      }
    },
    adjust(kind, constraintId, fieldKey, rawValue) {
      switch (kind) {
        case "requirements":
          return commitOutcome<RequirementCard>(
            kind,
            state.cardsByKind.requirements,
            constraintId,
            (cards) => applyRequirementQuickEdit(cards, constraintId, fieldKey, rawValue),
          );
        case "successions":
          return commitOutcome<SuccessionCard>(
            kind,
            state.cardsByKind.successions,
            constraintId,
            (cards) => applySuccessionQuickEdit(cards, constraintId, fieldKey, rawValue),
          );
        case "counts":
          return commitOutcome<CountCard>(kind, state.cardsByKind.counts, constraintId, (cards) =>
            applyCountQuickEdit(cards, constraintId, fieldKey, rawValue),
          );
        case "affinities":
          return commitOutcome<AffinityCard>(
            kind,
            state.cardsByKind.affinities,
            constraintId,
            (cards) => applyAffinityQuickEdit(cards, constraintId, fieldKey, rawValue),
          );
        case "coverings":
          return commitOutcome<CoveringCard>(
            kind,
            state.cardsByKind.coverings,
            constraintId,
            (cards) => applyCoveringQuickEdit(cards, constraintId, fieldKey, rawValue),
          );
      }
    },
    rename(row, title) {
      const next = title.trim();
      // A blank title would leave the rule with no label at all; treat it as a
      // cancelled edit rather than writing an empty description.
      if (!next || next === row.title) return;

      if (row.source === "builtin") {
        scenarioCommands.mutate((s) => ({
          maxOneShiftPerDay: { ...s.maxOneShiftPerDay, description: next },
        }));
        return;
      }
      if (!row.kind || !row.constraintId) return;
      const kind = row.kind;
      const constraintId = row.constraintId;
      // Nothing to rename in the snapshot — answer without touching the queue.
      if (!renamedCardsByKind(state.cardsByKind, kind, constraintId, next)) return;
      // The rename is re-derived at the queue head so it lands on the card as the
      // previous command left it, rather than restoring a stale per-kind array.
      void scenarioCommands.mutate((live) => {
        const renamed = renamedCardsByKind(live.cardsByKind, kind, constraintId, next);
        return renamed ? { cardsByKind: renamed } : null;
      });
    },
  };
}
