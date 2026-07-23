// Per-kind Guided rule mappers (T14b). Each mapper is a typed projection +
// mutation adapter over an EXISTING Advanced card kind — it reads/writes the same
// `cardsByKind` records the Advanced editors do, and reuses each editor's own
// "is this record representable in a flat form" predicate
// (`isAdvanced*Card`/`isEditable*Card`) as the exact "Set in Advanced only"
// boundary, so Guided's fallback gate can never drift from Advanced's own.

import {
  type AffinityCard,
  type CountCard,
  type CoveringCard,
  type RequirementCard,
  type SuccessionCard,
} from "@/lib/scenario";
import { isValidWeightValue } from "@/components/card-editor/weight-field";
import {
  REQUIREMENT_MESSAGES,
  summarizeRefs as summarizeRequirementRefs,
} from "@/components/requirements/requirements-model";
import {
  SUCCESSION_MESSAGES,
  isEditableSuccessionCard,
  patternPositionsForDisplay,
  summarizeRefs as summarizeSuccessionRefs,
} from "@/components/successions/successions-model";
import {
  COUNT_MESSAGES,
  describeCountExpressionTarget,
  isEditableCountCard,
  summarizeRefs as summarizeCountRefs,
} from "@/components/counts/counts-model";
import {
  AFFINITY_MESSAGES,
  isAdvancedAffinityCard,
  summarizeRefs as summarizeAffinityRefs,
} from "@/components/affinities/affinities-model";
import {
  isAdvancedCoveringCard,
  summarizeRefs as summarizeCoveringRefs,
} from "@/components/coverings/coverings-model";
import type { GuidedQuickField, GuidedRuleMapper } from "./types";

/** Flatten a (possibly nested) shift-type ref tree — a single flat entry means
 *  the requirement targets exactly one shift type, the only shape the plain-
 *  English mapper renders without loss. */
function flattenShiftTypeCount(shiftType: RequirementCard["shiftType"]): number {
  const flatten = (node: unknown): unknown[] =>
    Array.isArray(node) ? node.flatMap(flatten) : [node];
  return flatten(shiftType).length;
}

function isSupportedRequirementCard(card: RequirementCard): boolean {
  return flattenShiftTypeCount(card.shiftType) === 1;
}

export const requirementsMapper: GuidedRuleMapper<RequirementCard> = {
  kind: "requirements",
  category: "Staffing",
  advancedRoute: "/shift-type-requirements",
  defaultTitle(card) {
    const trimmed = card.description?.trim();
    if (trimmed) return trimmed;
    return `${summarizeRequirementRefs(card.shiftType)} staffing requirement`;
  },
  summary(card) {
    const shiftLabel = summarizeRequirementRefs(card.shiftType);
    const dateLabel = card.date === undefined ? "every date" : summarizeRequirementRefs(card.date);
    const people = card.requiredNumPeople === 1 ? "1 person" : `${card.requiredNumPeople} people`;
    return `Needs ${people} for ${shiftLabel} on ${dateLabel}.`;
  },
  quickFields(card): GuidedQuickField[] {
    if (!isSupportedRequirementCard(card)) return [];
    return [
      {
        key: "requiredNumPeople",
        label: "Required people",
        value: card.requiredNumPeople,
        min: 0,
        validate: (value) =>
          Number.isFinite(value) && value >= 0 ? undefined : REQUIREMENT_MESSAGES.requiredMin,
      },
    ];
  },
  unsupportedReason(card) {
    return isSupportedRequirementCard(card)
      ? undefined
      : "This requirement targets more than one shift type — adjust it in Advanced.";
  },
  applyQuickField(card, key, value) {
    if (key === "requiredNumPeople") return { ...card, requiredNumPeople: value };
    return card;
  },
  rename: (card, title) => ({ ...card, description: title }),
};

export const successionsMapper: GuidedRuleMapper<SuccessionCard> = {
  kind: "successions",
  category: "Sequencing",
  advancedRoute: "/shift-type-successions",
  defaultTitle(card) {
    const trimmed = card.description?.trim();
    if (trimmed) return trimmed;
    return `${patternPositionsForDisplay(card.pattern).join(" → ")} sequence`;
  },
  summary(card) {
    const who = summarizeSuccessionRefs(card.person);
    const pattern = patternPositionsForDisplay(card.pattern).join(" → ");
    const when = card.date === undefined ? "every date" : summarizeSuccessionRefs(card.date);
    return `${who}: ${pattern} on ${when}.`;
  },
  quickFields(card): GuidedQuickField[] {
    if (!isEditableSuccessionCard(card)) return [];
    return [
      {
        key: "weight",
        label: "Weight",
        value: card.weight,
        allowsInfinity: true,
        validate: (value) =>
          isValidWeightValue(value) ? undefined : SUCCESSION_MESSAGES.weightInvalid,
      },
    ];
  },
  unsupportedReason(card) {
    return isEditableSuccessionCard(card)
      ? undefined
      : "This pattern includes a grouped (OR) shift step — adjust it in Advanced.";
  },
  applyQuickField(card, key, value) {
    if (key === "weight") return { ...card, weight: value };
    return card;
  },
  rename: (card, title) => ({ ...card, description: title }),
};

export const countsMapper: GuidedRuleMapper<CountCard> = {
  kind: "counts",
  category: "Hours",
  advancedRoute: "/shift-counts",
  defaultTitle(card) {
    const trimmed = card.description?.trim();
    if (trimmed) return trimmed;
    return `${summarizeCountRefs(card.countShiftTypes)} count`;
  },
  summary(card) {
    const who = summarizeCountRefs(card.person);
    const expr = describeCountExpressionTarget(card.expression, card.target);
    return `${who}: ${expr} across ${summarizeCountRefs(card.countDates)}.`;
  },
  quickFields(card): GuidedQuickField[] {
    // `isEditableCountCard` only excludes the contracted-hours/tagged shape; the
    // unmarked generic-array fallback (FR-PR-55a) still needs its own scalar
    // check, since `target`'s static type stays `number | number[]` either way.
    if (!isEditableCountCard(card) || typeof card.target !== "number") return [];
    return [
      {
        key: "target",
        label: "Target",
        value: card.target,
        min: 0,
        validate: (value) =>
          Number.isInteger(value) && value >= 0 ? undefined : COUNT_MESSAGES.target,
      },
    ];
  },
  unsupportedReason(card) {
    return isEditableCountCard(card) && typeof card.target === "number"
      ? undefined
      : "This count uses a contracted-hours or list-shaped target — adjust it in Advanced.";
  },
  applyQuickField(card, key, value) {
    if (key === "target" && isEditableCountCard(card)) return { ...card, target: value };
    return card;
  },
  rename: (card, title) => ({ ...card, description: title }),
};

export const affinitiesMapper: GuidedRuleMapper<AffinityCard> = {
  kind: "affinities",
  category: "Pairing",
  advancedRoute: "/shift-affinities",
  defaultTitle(card) {
    const trimmed = card.description?.trim();
    if (trimmed) return trimmed;
    return `${summarizeAffinityRefs(card.people1)} × ${summarizeAffinityRefs(card.people2)} pairing`;
  },
  summary(card) {
    const shiftLabel = summarizeAffinityRefs(card.shiftTypes);
    const dateLabel = summarizeAffinityRefs(card.date);
    return `${summarizeAffinityRefs(card.people1)} with ${summarizeAffinityRefs(card.people2)} on ${shiftLabel}, ${dateLabel}.`;
  },
  quickFields(card): GuidedQuickField[] {
    if (isAdvancedAffinityCard(card)) return [];
    return [
      {
        key: "weight",
        label: "Weight",
        value: card.weight,
        allowsInfinity: true,
        validate: (value) =>
          isValidWeightValue(value) ? undefined : AFFINITY_MESSAGES.weightInvalid,
      },
    ];
  },
  unsupportedReason(card) {
    return isAdvancedAffinityCard(card)
      ? "This affinity has more than one OR-group — adjust it in Advanced."
      : undefined;
  },
  applyQuickField(card, key, value) {
    if (key === "weight") return { ...card, weight: value };
    return card;
  },
  rename: (card, title) => ({ ...card, description: title }),
};

export const coveringsMapper: GuidedRuleMapper<CoveringCard> = {
  kind: "coverings",
  category: "Supervision",
  advancedRoute: "/shift-type-coverings",
  defaultTitle(card) {
    const trimmed = card.description?.trim();
    if (trimmed) return trimmed;
    return `${summarizeCoveringRefs(card.preceptees)} supervision`;
  },
  summary(card) {
    const shiftLabel = summarizeCoveringRefs(card.shiftTypes);
    const dateLabel = card.date === undefined ? "every date" : summarizeCoveringRefs(card.date);
    return `${summarizeCoveringRefs(card.preceptors)} supervise ${summarizeCoveringRefs(card.preceptees)} on ${shiftLabel}, ${dateLabel}.`;
  },
  // A covering's weight is a structural constant (COVERING_WEIGHT) the backend
  // ignores — there is no editable number to expose (tech-plan §3: display-only
  // pins are expected for records with no adjustable numbers).
  quickFields(): GuidedQuickField[] {
    return [];
  },
  unsupportedReason(card) {
    return isAdvancedCoveringCard(card)
      ? "This covering has more than one OR-group — adjust it in Advanced."
      : undefined;
  },
  applyQuickField(card) {
    return card;
  },
  rename: (card, title) => ({ ...card, description: title }),
};
