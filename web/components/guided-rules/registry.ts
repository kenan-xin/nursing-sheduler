// Guided rule projection registry (T14b). `projectGuidedRules` derives EVERY row
// from `cardsByKind` through the per-kind mapper (tech-plan §3) — Guided never
// owns a duplicate constraint value, and there is no opt-in step between a
// constraint existing and its rule appearing here.

import type {
  AffinityCard,
  CountCard,
  CoveringCard,
  GuidedRuleConstraintKind,
  RequirementCard,
  ScenarioUiState,
  SuccessionCard,
} from "@/lib/scenario";
import type { GuidedRuleMapper, GuidedRuleRow } from "./types";
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
): GuidedRuleRow {
  const unsupportedReason = mapper.unsupportedReason(card);
  const quickFields = unsupportedReason ? [] : mapper.quickFields(card);
  return {
    id: `${mapper.kind}:${card.uid}`,
    source: "record",
    kind: mapper.kind,
    constraintId: card.uid,
    category: mapper.category,
    title: mapper.defaultTitle(card),
    summary: mapper.summary(card),
    enabled: !card.disabled,
    locked: false,
    advancedRoute: mapper.advancedRoute,
    quickFields,
    unsupportedReason,
  };
}

/**
 * Project every card of the five kinds — enabled or disabled, natively
 * renderable or "Set in Advanced only" — into a `GuidedRuleRow`, preceded by the
 * built-in structural rows. Row order fixes the heading order the screen groups
 * by: Always on, then Staffing levels → Shift sequences → Hours & contracts →
 * Who works together → Supervision.
 */
export function projectGuidedRules(state: ScenarioUiState): GuidedRuleRow[] {
  const rows: GuidedRuleRow[] = [...projectBuiltinRules(state)];

  for (const card of state.cardsByKind.requirements) {
    rows.push(projectCard(requirementsMapper, card));
  }
  for (const card of state.cardsByKind.successions) {
    rows.push(projectCard(successionsMapper, card));
  }
  for (const card of state.cardsByKind.counts) {
    rows.push(projectCard(countsMapper, card));
  }
  for (const card of state.cardsByKind.affinities) {
    rows.push(projectCard(affinitiesMapper, card));
  }
  for (const card of state.cardsByKind.coverings) {
    rows.push(projectCard(coveringsMapper, card));
  }

  return rows;
}
