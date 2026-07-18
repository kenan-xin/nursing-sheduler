// Guided rule projection registry (T14b). `projectGuidedRules` derives EVERY row
// from `cardsByKind` through the per-kind mapper (tech-plan §3) — Guided never
// owns a duplicate constraint value. A `GuidedRulePin` (T14a) is an optional
// overlay: when present, its `category`/`description`/`quickFields` override the
// mapper's defaults for that one row.

import type {
  AffinityCard,
  CountCard,
  CoveringCard,
  GuidedRuleConstraintKind,
  GuidedRulePin,
  RequirementCard,
  ScenarioUiState,
  SuccessionCard,
} from "@/lib/scenario";
import type { GuidedRuleMapper, GuidedRuleProjection, GuidedRuleRow } from "./types";
import {
  affinitiesMapper,
  countsMapper,
  coveringsMapper,
  requirementsMapper,
  successionsMapper,
} from "./mappers";
import { projectBuiltinRules } from "./builtins";

/** The five mappers keyed by kind — the registry's "one typed mapper per
 *  constraint kind" (T14b scope). */
export const GUIDED_RULE_MAPPERS = {
  requirements: requirementsMapper,
  successions: successionsMapper,
  counts: countsMapper,
  affinities: affinitiesMapper,
  coverings: coveringsMapper,
} as const;

export function guidedRuleMapperFor(kind: "requirements"): GuidedRuleMapper<RequirementCard>;
export function guidedRuleMapperFor(kind: "successions"): GuidedRuleMapper<SuccessionCard>;
export function guidedRuleMapperFor(kind: "counts"): GuidedRuleMapper<CountCard>;
export function guidedRuleMapperFor(kind: "affinities"): GuidedRuleMapper<AffinityCard>;
export function guidedRuleMapperFor(kind: "coverings"): GuidedRuleMapper<CoveringCard>;
export function guidedRuleMapperFor(
  kind: GuidedRuleConstraintKind,
): GuidedRuleMapper<RequirementCard | SuccessionCard | CountCard | AffinityCard | CoveringCard> {
  return GUIDED_RULE_MAPPERS[kind];
}

function projectCard<TCard extends { uid: string; disabled?: boolean }>(
  mapper: GuidedRuleMapper<TCard>,
  card: TCard,
  pin: GuidedRulePin | undefined,
): GuidedRuleRow {
  const unsupportedReason = mapper.unsupportedReason(card);
  const available = unsupportedReason ? [] : mapper.quickFields(card);
  const quickFields = pin
    ? available.filter((field) => pin.quickFields.includes(field.key))
    : available;
  return {
    id: `${mapper.kind}:${card.uid}`,
    source: "record",
    kind: mapper.kind,
    constraintId: card.uid,
    category: pin?.category ?? mapper.category,
    title: mapper.defaultTitle(card),
    summary: pin?.description ?? mapper.summary(card),
    enabled: !card.disabled,
    locked: false,
    advancedRoute: mapper.advancedRoute,
    quickFields,
    unsupportedReason,
    pin,
  };
}

/**
 * Project every enabled-or-disabled card of the five kinds into a `GuidedRuleRow`,
 * plus the built-in structural rows, overlaying any matching `GuidedRulePin`.
 * Pins whose source card no longer exists are reported in `stalePinIds` rather
 * than silently applied or dropped without signal — this should never happen in
 * practice (T14a prunes orphaned pins on every card mutation), but the read side
 * stays defensive rather than assuming that invariant holds.
 *
 * The same defensive posture applies to the one-pin-per-source invariant
 * (T14d): `pinConstraint` never appends a duplicate for an already-pinned
 * source, but the read side does not assume that holds either. A pin
 * superseded by a later duplicate for the same source is reported in
 * `stalePinIds` too — never rendered, and covered by the same stale-pin
 * cleanup action — so no hidden, unrenderable pin metadata can survive.
 */
export function projectGuidedRules(state: ScenarioUiState): GuidedRuleProjection {
  const rows: GuidedRuleRow[] = [...projectBuiltinRules(state)];
  const stalePinIds: string[] = [];

  const pinsByCard = new Map<string, GuidedRulePin>();
  for (const pin of state.guidedRulePins) {
    const exists = state.cardsByKind[pin.constraintKind].some(
      (card) => card.uid === pin.constraintId,
    );
    if (!exists) {
      stalePinIds.push(pin.id);
      continue;
    }
    const key = `${pin.constraintKind}:${pin.constraintId}`;
    const superseded = pinsByCard.get(key);
    if (superseded) stalePinIds.push(superseded.id);
    pinsByCard.set(key, pin);
  }

  for (const card of state.cardsByKind.requirements) {
    rows.push(projectCard(requirementsMapper, card, pinsByCard.get(`requirements:${card.uid}`)));
  }
  for (const card of state.cardsByKind.successions) {
    rows.push(projectCard(successionsMapper, card, pinsByCard.get(`successions:${card.uid}`)));
  }
  for (const card of state.cardsByKind.counts) {
    rows.push(projectCard(countsMapper, card, pinsByCard.get(`counts:${card.uid}`)));
  }
  for (const card of state.cardsByKind.affinities) {
    rows.push(projectCard(affinitiesMapper, card, pinsByCard.get(`affinities:${card.uid}`)));
  }
  for (const card of state.cardsByKind.coverings) {
    rows.push(projectCard(coveringsMapper, card, pinsByCard.get(`coverings:${card.uid}`)));
  }

  return { rows, stalePinIds };
}
