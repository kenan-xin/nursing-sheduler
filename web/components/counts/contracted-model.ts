// Contracted-Hours guided-authoring model (T12 M2a-2, spec 05 FR-PR-... contracted
// seam). Kept OUT of `counts-model.ts` — that module documents "M2 is OUT OF SCOPE
// here" and only ever builds an `OrdinaryCountCardBody`. This module is the sibling
// seam that authors the MARKED `ContractedHoursCountCardBody`
// (`tag: "contracted_hours"`, `policy`, `unit: "half-hour"`), with the locked
// policy encoding the backend requires:
//   • exact  → expression "x = T",              target <scalar>,     weight .inf
//   • range  → expression ["x >= T","x <= T"],  target [min, max],   weight .inf
//
// The coverage-bijection commit gate (`validateContractedHoursContract`) and the
// coefficient sub-editor are M2a-3 — NOT here. `buildContractedCard` still carries
// any coefficients the form state holds, but nothing in this module hard-blocks on
// exact coverage. All logic is side-effect-free so it is provable in `node` vitest.

import {
  type CoefficientEntry,
  type ContractedHoursCountCard,
  type ContractedHoursCountCardBody,
  type DateRef,
  type PersonRef,
  type ShiftTypeRef,
} from "@/lib/scenario";
import {
  sortIdsByEntryOrder,
  syncCoefficientPairs,
  validateCoefficientPairs,
  type CoefficientDomain,
  type CoefficientPair,
} from "@/components/card-editor/coefficient-fields";
import { COUNT_MESSAGES } from "./counts-model";
import { formatHalfHours, parseHalfHours } from "./half-hour-codec";

/** The flat draft the guided contracted form edits. Target values are held as the
 *  human hours STRINGS the author types (e.g. "160h", "8h 30m") and converted to
 *  integer half-hours via the codec on build; expression/weight are derived from
 *  `policy`, never free draft fields. */
export interface ContractedFormState {
  description: string;
  person: PersonRef[];
  countDates: DateRef[];
  countShiftTypes: ShiftTypeRef[];
  countShiftTypeCoefficients: CoefficientPair[];
  policy: "exact" | "range";
  /** Exact-policy target as authored (human hours). */
  targetExact: string;
  /** Range-policy minimum target as authored (human hours). */
  targetRangeMin: string;
  /** Range-policy maximum target as authored (human hours). */
  targetRangeMax: string;
}

/** Verbatim per-field messages for the contracted form. Selection messages reuse
 *  the shared count table; target messages describe the half-hour grid. */
export const CONTRACTED_MESSAGES = {
  person: COUNT_MESSAGES.person,
  countDates: COUNT_MESSAGES.countDates,
  countShiftTypes: COUNT_MESSAGES.countShiftTypes,
  target: "Enter contracted hours on the half-hour grid (e.g. 160h, 8h 30m, or 8.5h)",
  rangeOrder: "Minimum contracted hours must not exceed the maximum",
} as const;

/** A fresh contracted draft: exact policy, empty selections, blank targets. */
export function emptyContractedForm(): ContractedFormState {
  return {
    description: "",
    person: [],
    countDates: [],
    countShiftTypes: [],
    countShiftTypeCoefficients: [],
    policy: "exact",
    targetExact: "",
    targetRangeMin: "",
    targetRangeMax: "",
  };
}

/**
 * Load an existing marked contracted-hours card back into a flat draft. Reads the
 * `policy`, decodes the scalar-or-`[min, max]` target back to human hours via the
 * codec, and re-syncs coefficients against the current domain (a stale id from a
 * since-changed group is dropped; a newly-eligible id gets a blank slot). Callers
 * must guard with {@link isContractedHoursCard} first; a non-contracted card falls
 * back to exact/blank rather than throwing, so this stays total.
 */
export function toContractedForm(
  card: ContractedHoursCountCard,
  domain: CoefficientDomain,
): ContractedFormState {
  const policy = card.policy === "range" ? "range" : "exact";
  const countShiftTypes = Array.isArray(card.countShiftTypes)
    ? [...card.countShiftTypes]
    : [card.countShiftTypes];

  let targetExact = "";
  let targetRangeMin = "";
  let targetRangeMax = "";
  if (policy === "range" && Array.isArray(card.target)) {
    targetRangeMin = formatHalfHours(card.target[0]);
    targetRangeMax = formatHalfHours(card.target[1]);
  } else if (typeof card.target === "number") {
    targetExact = formatHalfHours(card.target);
  }

  return {
    description: card.description ?? "",
    person: Array.isArray(card.person) ? [...card.person] : [card.person],
    countDates: Array.isArray(card.countDates) ? [...card.countDates] : [card.countDates],
    countShiftTypes,
    countShiftTypeCoefficients: syncCoefficientPairs(
      countShiftTypes,
      (card.countShiftTypeCoefficients ?? []) as CoefficientPair[],
      domain,
    ),
    policy,
    targetExact,
    targetRangeMin,
    targetRangeMax,
  };
}

/** Per-field validation errors for the contracted form (empty ⇒ valid). Coverage
 *  bijection is deliberately NOT checked here (M2a-3). */
export interface ContractedErrors {
  person?: string;
  countDates?: string;
  countShiftTypes?: string;
  targetExact?: string;
  targetRangeMin?: string;
  targetRangeMax?: string;
}

/**
 * Validate a contracted draft for the minimal guided form: selections must be
 * non-empty and every active target must parse on the half-hour grid; a range's
 * minimum must not exceed its maximum. Does NOT enforce coverage bijection (M2a-3).
 */
export function validateContractedForm(form: ContractedFormState): ContractedErrors {
  const errors: ContractedErrors = {};
  if (form.person.length === 0) errors.person = CONTRACTED_MESSAGES.person;
  if (form.countDates.length === 0) errors.countDates = CONTRACTED_MESSAGES.countDates;
  if (form.countShiftTypes.length === 0)
    errors.countShiftTypes = CONTRACTED_MESSAGES.countShiftTypes;

  if (form.policy === "range") {
    const min = parseHalfHours(form.targetRangeMin);
    const max = parseHalfHours(form.targetRangeMax);
    if (min === null) errors.targetRangeMin = CONTRACTED_MESSAGES.target;
    if (max === null) errors.targetRangeMax = CONTRACTED_MESSAGES.target;
    if (min !== null && max !== null && min > max) {
      errors.targetRangeMax = CONTRACTED_MESSAGES.rangeOrder;
    }
  } else if (parseHalfHours(form.targetExact) === null) {
    errors.targetExact = CONTRACTED_MESSAGES.target;
  }

  return errors;
}

/**
 * Assemble the saved MARKED contracted-hours card from a draft. Encodes the locked
 * expression/target/weight per policy, stamps `tag`/`policy`/`unit: "half-hour"`,
 * re-sorts `countShiftTypes` to canonical entry order, and attaches coefficients
 * only when non-empty (mirroring `buildCountCard`). Save calls this after
 * {@link validateContractedForm} passes; an unparsable target defensively encodes
 * `0` so this stays total. `uid` is injectable for deterministic tests.
 */
export function buildContractedCard(
  form: ContractedFormState,
  domain: CoefficientDomain,
  uid: string = crypto.randomUUID(),
): ContractedHoursCountCard {
  const countShiftTypes = sortIdsByEntryOrder(form.countShiftTypes, domain) as ShiftTypeRef[];
  const { entries } = validateCoefficientPairs(
    countShiftTypes,
    form.countShiftTypeCoefficients,
    domain,
  );

  const isRange = form.policy === "range";
  const expression: string | string[] = isRange ? ["x >= T", "x <= T"] : "x = T";
  const target: number | number[] = isRange
    ? [parseHalfHours(form.targetRangeMin) ?? 0, parseHalfHours(form.targetRangeMax) ?? 0]
    : (parseHalfHours(form.targetExact) ?? 0);

  const body: ContractedHoursCountCardBody = {
    description: form.description,
    person: [...form.person],
    countDates: [...form.countDates],
    countShiftTypes,
    expression,
    target,
    // A contracted-hours target is a hard constraint — always the `.inf` weight.
    weight: Infinity,
    tag: "contracted_hours",
    policy: form.policy,
    // UI-only display hint; canonical maps `tag → hoursContract` and drops `unit`.
    unit: "half-hour",
  };
  if (entries.length > 0) body.countShiftTypeCoefficients = entries as CoefficientEntry[];
  return { uid, ...body };
}
