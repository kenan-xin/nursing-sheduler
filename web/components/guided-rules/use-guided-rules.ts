"use client";

// Store binding for the Guided Rules screen (T14c). Reads the durable scenario
// slice, projects it into `GuidedRuleRow`s via the T14b registry, and exposes
// toggle/adjust/rename as operations that each apply exactly one
// `mutateScenario` patch — so a Guided edit is exactly as tracked as its Advanced
// equivalent (one zundo entry, one persisted revision), mirroring every other
// card hook's `commitX` discipline (`components/counts/use-counts.ts`).
//
// `rename` writes the source constraint's OWN `description` (the built-in row's
// `maxOneShiftPerDay.description`), exactly as an Advanced edit does — so the
// Rules screen never becomes a second source of truth for a rule's label.

import { useScenarioStore } from "@/lib/store";
import type {
  AffinityCard,
  CardsByKind,
  CountCard,
  CoveringCard,
  GuidedRuleConstraintKind,
  RequirementCard,
  ScenarioUiState,
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
import type { GuidedMutationOutcome, GuidedRuleRow } from "./types";

/** Replace one card kind's array in a single tracked mutation — identical shape to
 *  every existing per-kind hook's `commitX`. Every caller pairs `kind` with that
 *  exact kind's own card array by construction (the per-kind switch branches
 *  below), so the internal cast is safe. */
function commitCards(kind: GuidedRuleConstraintKind, next: readonly { uid: string }[]) {
  useScenarioStore.getState().mutateScenario((state) => ({
    cardsByKind: { ...state.cardsByKind, [kind]: next } as CardsByKind,
  }));
}

function replaceInPlace<TCard extends { uid: string }>(
  cards: readonly TCard[],
  constraintId: string,
  next: TCard,
): TCard[] {
  return cards.map((card) => (card.uid === constraintId ? next : card));
}

function commitOutcome<TCard extends { uid: string }>(
  kind: GuidedRuleConstraintKind,
  cards: readonly TCard[],
  constraintId: string,
  outcome: GuidedMutationOutcome<TCard>,
): GuidedMutationOutcome<TCard> {
  if (outcome.kind === "applied") {
    commitCards(kind, replaceInPlace(cards, constraintId, outcome.card));
  }
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
  state: ScenarioUiState;
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

export function useGuidedRules(): GuidedRulesController {
  const state: ScenarioUiState = useScenarioStore((s) => s);
  const rows = projectGuidedRules(state);

  return {
    state,
    rows,
    toggle(kind, constraintId, enabled) {
      switch (kind) {
        case "requirements":
          commitOutcome(
            kind,
            state.cardsByKind.requirements,
            constraintId,
            toggleRequirementRule(state.cardsByKind.requirements, constraintId, enabled),
          );
          return;
        case "successions":
          commitOutcome(
            kind,
            state.cardsByKind.successions,
            constraintId,
            toggleSuccessionRule(state.cardsByKind.successions, constraintId, enabled),
          );
          return;
        case "counts":
          commitOutcome(
            kind,
            state.cardsByKind.counts,
            constraintId,
            toggleCountRule(state.cardsByKind.counts, constraintId, enabled),
          );
          return;
        case "affinities":
          commitOutcome(
            kind,
            state.cardsByKind.affinities,
            constraintId,
            toggleAffinityRule(state.cardsByKind.affinities, constraintId, enabled),
          );
          return;
        case "coverings":
          commitOutcome(
            kind,
            state.cardsByKind.coverings,
            constraintId,
            toggleCoveringRule(state.cardsByKind.coverings, constraintId, enabled),
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
            applyRequirementQuickEdit(
              state.cardsByKind.requirements,
              constraintId,
              fieldKey,
              rawValue,
            ),
          );
        case "successions":
          return commitOutcome<SuccessionCard>(
            kind,
            state.cardsByKind.successions,
            constraintId,
            applySuccessionQuickEdit(
              state.cardsByKind.successions,
              constraintId,
              fieldKey,
              rawValue,
            ),
          );
        case "counts":
          return commitOutcome<CountCard>(
            kind,
            state.cardsByKind.counts,
            constraintId,
            applyCountQuickEdit(state.cardsByKind.counts, constraintId, fieldKey, rawValue),
          );
        case "affinities":
          return commitOutcome<AffinityCard>(
            kind,
            state.cardsByKind.affinities,
            constraintId,
            applyAffinityQuickEdit(state.cardsByKind.affinities, constraintId, fieldKey, rawValue),
          );
        case "coverings":
          return commitOutcome<CoveringCard>(
            kind,
            state.cardsByKind.coverings,
            constraintId,
            applyCoveringQuickEdit(state.cardsByKind.coverings, constraintId, fieldKey, rawValue),
          );
      }
    },
    rename(row, title) {
      const next = title.trim();
      // A blank title would leave the rule with no label at all; treat it as a
      // cancelled edit rather than writing an empty description.
      if (!next || next === row.title) return;

      if (row.source === "builtin") {
        useScenarioStore.getState().mutateScenario((s) => ({
          maxOneShiftPerDay: { ...s.maxOneShiftPerDay, description: next },
        }));
        return;
      }
      if (!row.kind || !row.constraintId) return;
      const cardsByKind = renamedCardsByKind(state.cardsByKind, row.kind, row.constraintId, next);
      if (!cardsByKind) return;
      commitCards(row.kind, cardsByKind[row.kind]);
    },
  };
}
