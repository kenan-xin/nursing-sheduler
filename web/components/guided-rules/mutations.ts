// Guided rule mutation adapters (T14b) — pure functions over a single card kind's
// array that return a structured `GuidedMutationOutcome` instead of throwing, so
// T14c can render missing-source/unsupported-field/invalid-value states directly
// (T14b scope: "structured outcomes ... so T14c can render actionable states
// without parsing prose"). Every function returns data only; the caller commits
// the result through the kind's existing store hook (one `mutateScenario` call —
// the "exact mutation adapter into the existing card controller" tech-plan §3
// calls for), so a quick edit/toggle/rename is exactly as tracked as any Advanced
// edit — one zundo entry, no Guided-only history.

import type {
  AffinityCard,
  CountCard,
  CoveringCard,
  RequirementCard,
  SuccessionCard,
} from "@/lib/scenario";
import type { GuidedMutationOutcome, GuidedRuleMapper } from "./types";
import {
  affinitiesMapper,
  countsMapper,
  coveringsMapper,
  requirementsMapper,
  successionsMapper,
} from "./mappers";

/** Return a copy of `card` with the shared UI-only `disabled` marker set to
 *  `!enabled` — identical semantics to every kind's own `withCardDisabled`
 *  (canonical.ts skips a disabled card regardless of kind). */
function withEnabled<TCard extends { disabled?: boolean }>(card: TCard, enabled: boolean): TCard {
  if (!enabled) return { ...card, disabled: true };
  const rest: Record<string, unknown> = { ...card };
  delete rest.disabled;
  return rest as TCard;
}

function findCard<TCard extends { uid: string }>(
  cards: readonly TCard[],
  constraintId: string,
): TCard | undefined {
  return cards.find((card) => card.uid === constraintId);
}

function quickEdit<TCard extends { uid: string; disabled?: boolean }>(
  mapper: GuidedRuleMapper<TCard>,
  cards: readonly TCard[],
  constraintId: string,
  fieldKey: string,
  rawValue: number,
): GuidedMutationOutcome<TCard> {
  const card = findCard(cards, constraintId);
  if (!card) return { kind: "missing-source" };
  const field = mapper.quickFields(card).find((f) => f.key === fieldKey);
  if (!field) return { kind: "unsupported-field" };
  const error = field.validate(rawValue);
  if (error) return { kind: "invalid-value", message: error };
  return { kind: "applied", card: mapper.applyQuickField(card, fieldKey, rawValue) };
}

function toggle<TCard extends { uid: string; disabled?: boolean }>(
  cards: readonly TCard[],
  constraintId: string,
  enabled: boolean,
): GuidedMutationOutcome<TCard> {
  const card = findCard(cards, constraintId);
  if (!card) return { kind: "missing-source" };
  return { kind: "applied", card: withEnabled(card, enabled) };
}

function rename<TCard extends { uid: string; disabled?: boolean }>(
  mapper: GuidedRuleMapper<TCard>,
  cards: readonly TCard[],
  constraintId: string,
  title: string,
): GuidedMutationOutcome<TCard> {
  const card = findCard(cards, constraintId);
  if (!card) return { kind: "missing-source" };
  return { kind: "applied", card: mapper.rename(card, title) };
}

// --- Requirements ------------------------------------------------------------

export function applyRequirementQuickEdit(
  cards: readonly RequirementCard[],
  constraintId: string,
  fieldKey: string,
  rawValue: number,
): GuidedMutationOutcome<RequirementCard> {
  return quickEdit(requirementsMapper, cards, constraintId, fieldKey, rawValue);
}
export function toggleRequirementRule(
  cards: readonly RequirementCard[],
  constraintId: string,
  enabled: boolean,
): GuidedMutationOutcome<RequirementCard> {
  return toggle(cards, constraintId, enabled);
}
export function renameRequirementRule(
  cards: readonly RequirementCard[],
  constraintId: string,
  title: string,
): GuidedMutationOutcome<RequirementCard> {
  return rename(requirementsMapper, cards, constraintId, title);
}

// --- Successions ---------------------------------------------------------

export function applySuccessionQuickEdit(
  cards: readonly SuccessionCard[],
  constraintId: string,
  fieldKey: string,
  rawValue: number,
): GuidedMutationOutcome<SuccessionCard> {
  return quickEdit(successionsMapper, cards, constraintId, fieldKey, rawValue);
}
export function toggleSuccessionRule(
  cards: readonly SuccessionCard[],
  constraintId: string,
  enabled: boolean,
): GuidedMutationOutcome<SuccessionCard> {
  return toggle(cards, constraintId, enabled);
}
export function renameSuccessionRule(
  cards: readonly SuccessionCard[],
  constraintId: string,
  title: string,
): GuidedMutationOutcome<SuccessionCard> {
  return rename(successionsMapper, cards, constraintId, title);
}

// --- Counts ----------------------------------------------------------------

export function applyCountQuickEdit(
  cards: readonly CountCard[],
  constraintId: string,
  fieldKey: string,
  rawValue: number,
): GuidedMutationOutcome<CountCard> {
  return quickEdit(countsMapper, cards, constraintId, fieldKey, rawValue);
}
export function toggleCountRule(
  cards: readonly CountCard[],
  constraintId: string,
  enabled: boolean,
): GuidedMutationOutcome<CountCard> {
  return toggle(cards, constraintId, enabled);
}
export function renameCountRule(
  cards: readonly CountCard[],
  constraintId: string,
  title: string,
): GuidedMutationOutcome<CountCard> {
  return rename(countsMapper, cards, constraintId, title);
}

// --- Affinities --------------------------------------------------------------

export function applyAffinityQuickEdit(
  cards: readonly AffinityCard[],
  constraintId: string,
  fieldKey: string,
  rawValue: number,
): GuidedMutationOutcome<AffinityCard> {
  return quickEdit(affinitiesMapper, cards, constraintId, fieldKey, rawValue);
}
export function toggleAffinityRule(
  cards: readonly AffinityCard[],
  constraintId: string,
  enabled: boolean,
): GuidedMutationOutcome<AffinityCard> {
  return toggle(cards, constraintId, enabled);
}
export function renameAffinityRule(
  cards: readonly AffinityCard[],
  constraintId: string,
  title: string,
): GuidedMutationOutcome<AffinityCard> {
  return rename(affinitiesMapper, cards, constraintId, title);
}

// --- Coverings ---------------------------------------------------------------

export function applyCoveringQuickEdit(
  cards: readonly CoveringCard[],
  constraintId: string,
  fieldKey: string,
  rawValue: number,
): GuidedMutationOutcome<CoveringCard> {
  return quickEdit(coveringsMapper, cards, constraintId, fieldKey, rawValue);
}
export function toggleCoveringRule(
  cards: readonly CoveringCard[],
  constraintId: string,
  enabled: boolean,
): GuidedMutationOutcome<CoveringCard> {
  return toggle(cards, constraintId, enabled);
}
export function renameCoveringRule(
  cards: readonly CoveringCard[],
  constraintId: string,
  title: string,
): GuidedMutationOutcome<CoveringCard> {
  return rename(coveringsMapper, cards, constraintId, title);
}
