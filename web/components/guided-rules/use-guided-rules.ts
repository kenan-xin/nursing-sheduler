"use client";

// Store binding for the Guided Rules screen (T14c). Reads the durable scenario
// slice, projects it into `GuidedRuleRow`s via the T14b registry, and exposes
// toggle/adjust/pin CRUD as operations that each apply exactly one
// `mutateScenario` patch — so a Guided edit is exactly as tracked as its Advanced
// equivalent (one zundo entry, one persisted revision), mirroring every other
// card hook's `commitX` discipline (`components/counts/use-counts.ts`).
//
// `submitPin` (T14d) composes the optional source-title rename with the
// pin/repin metadata write into that SAME single patch, so one Pin/Repin form
// submit is exactly one tracked mutation — never two — and the rename half is
// skipped entirely when the submitted title matches the source's current title.

import { useScenarioStore } from "@/lib/store";
import {
  pruneOrphanedGuidedRulePins,
  removeGuidedRulePins,
  type AffinityCard,
  type CardsByKind,
  type CountCard,
  type CoveringCard,
  type GuidedRuleConstraintKind,
  type RequirementCard,
  type ScenarioUiState,
  type SuccessionCard,
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
import {
  listPinnableRecords,
  pinConstraint,
  repinConstraint,
  unpinConstraint,
} from "./pin-catalog";
import type {
  GuidedMutationOutcome,
  GuidedPinOutcome,
  GuidedRuleProjection,
  PinnableRecord,
} from "./types";

/** Replace one card kind's array in a single tracked mutation, reconciling any
 *  orphaned pin in the SAME commit (T14a's `pruneOrphanedGuidedRulePins`) —
 *  identical shape to every existing per-kind hook's `commitX`. Every caller
 *  pairs `kind` with that exact kind's own card array by construction (the
 *  per-kind switch branches below), so the internal cast is safe. */
function commitCards(kind: GuidedRuleConstraintKind, next: readonly { uid: string }[]) {
  useScenarioStore.getState().mutateScenario((state) => {
    const cardsByKind = { ...state.cardsByKind, [kind]: next } as CardsByKind;
    return {
      cardsByKind,
      guidedRulePins: pruneOrphanedGuidedRulePins(state.guidedRulePins, cardsByKind),
    };
  });
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

/** The fields a Pin/Repin form submit carries for the pin's own shortcut
 *  metadata — mirrors `PinConstraintInput` minus the source identity, which
 *  `submitPin` supplies from `kind`/`constraintId` (add) or resolves from the
 *  pin being edited (repin). */
export interface GuidedPinMetadataPatch {
  category: string;
  description?: string;
  quickFields: string[];
}

/** Recompute `cardsByKind` with the source card's title (its `description`)
 *  set to `title` — or `undefined` when the card is missing or `title` already
 *  matches its current default title, so `submitPin` can skip an unnecessary
 *  rename half entirely (T14d: "skip source updates when unchanged"). */
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
  projection: GuidedRuleProjection;
  pinnableRecords: PinnableRecord[];
  /** Toggle a linked rule's enabled state — writes the source card's `disabled`
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
   * One Pin/Repin form submit, as one tracked mutation (T14d). Validates and
   * applies the pin/repin metadata patch exactly like `pinConstraint`/
   * `repinConstraint` — a repin when `editingPinId` is given, else a new pin
   * for `(kind, constraintId)`. When that succeeds AND `title` differs from
   * the source's current title, the rename is folded into the SAME
   * `mutateScenario` patch — so Undo restores both together, and an unchanged
   * title never spends an extra history entry on a no-op rename.
   */
  submitPin(
    kind: GuidedRuleConstraintKind,
    constraintId: string,
    title: string,
    patch: GuidedPinMetadataPatch,
    editingPinId?: string,
  ): GuidedPinOutcome;
  unpin(id: string): void;
  /** Remove every currently-stale pin (orphaned or superseded-duplicate, per
   *  `projection.stalePinIds`) in one atomic tracked mutation — the Rules
   *  screen's "clear stale pins" cleanup (T14d). A no-op for an empty list. */
  cleanupStalePins(staleIds: readonly string[]): void;
}

export function useGuidedRules(): GuidedRulesController {
  const state: ScenarioUiState = useScenarioStore((s) => s);
  const projection = projectGuidedRules(state);
  const pinnableRecords = listPinnableRecords(state);

  return {
    state,
    projection,
    pinnableRecords,
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
    submitPin(kind, constraintId, title, patch, editingPinId) {
      const outcome = editingPinId
        ? repinConstraint(state.cardsByKind, state.guidedRulePins, editingPinId, patch)
        : pinConstraint(state.cardsByKind, state.guidedRulePins, {
            constraintKind: kind,
            constraintId,
            ...patch,
          });
      if (outcome.kind !== "applied") return outcome;

      const cardsByKind = renamedCardsByKind(state.cardsByKind, kind, constraintId, title);
      useScenarioStore
        .getState()
        .mutateScenario(
          cardsByKind
            ? { cardsByKind, guidedRulePins: outcome.pins }
            : { guidedRulePins: outcome.pins },
        );
      return outcome;
    },
    unpin(id) {
      useScenarioStore.getState().mutateScenario({
        guidedRulePins: unpinConstraint(state.guidedRulePins, id),
      });
    },
    cleanupStalePins(staleIds) {
      if (staleIds.length === 0) return;
      useScenarioStore.getState().mutateScenario((s) => ({
        guidedRulePins: removeGuidedRulePins(s.guidedRulePins, staleIds),
      }));
    },
  };
}
