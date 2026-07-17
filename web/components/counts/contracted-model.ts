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
  buildShiftTypeIndexMap,
  expandShiftTypeSelector,
  RESERVED_SHIFT_TYPE,
  ShiftTypeMapError,
  validateContractedHoursContract,
  type CoefficientEntry,
  type ContractedHoursCountCard,
  type ContractedHoursCountCardBody,
  type ContractedHoursInput,
  type DateRef,
  type PersonRef,
  type ScenarioUiState,
  type ShiftTypeRef,
} from "@/lib/scenario";
import {
  sortIdsByEntryOrder,
  syncCoefficientPairs,
  validateCoefficientPairs,
  type CoefficientDomain,
  type CoefficientPair,
} from "@/components/card-editor/coefficient-fields";
import { buildCountShiftTypeDomain, COUNT_MESSAGES } from "./counts-model";
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
 * The CONCRETE coefficient domain for a contracted-hours draft — the exact
 * day-state set the coverage bijection is defined over. Unlike the M1
 * {@link buildCountShiftTypeDomain} (which deliberately makes a selected
 * GROUP/`ALL` id itself coefficient-eligible), this expands the selected
 * `countShiftTypes` under BACKEND semantics ({@link buildShiftTypeIndexMap}) and
 * returns ONLY the concrete leaf sources — authored STRING shift ids plus `LEAVE`
 * when reached, never a group/`ALL`, and `OFF` excluded — as `items` with
 * `groups: []`. Feeding this (with its own {@link contractedCoefficientIds} as the
 * `selection`) to `CoefficientFields` makes its eligibility, coverage strip, and
 * `syncCoefficientPairs` line up 1:1 with `validateContractedHoursContract`. A
 * malformed scenario map yields an empty domain — the commit gate surfaces the map
 * error separately rather than throwing here.
 */
export function buildContractedCoefficientDomain(
  state: ScenarioUiState,
  selection: readonly ShiftTypeRef[],
): CoefficientDomain {
  let map: ReturnType<typeof buildShiftTypeIndexMap>;
  try {
    map = buildShiftTypeIndexMap(state.shifts, state.shiftGroups);
  } catch {
    return { items: [], groups: [] };
  }
  // Expand the selectors to concrete day-state indices, exactly as the validator's
  // coverage check does — a group/`ALL` selector contributes its member indices.
  const expanded = new Set<number>();
  for (const selector of selection) {
    const indices = expandShiftTypeSelector(selector, map);
    if (indices) for (const s of indices) expanded.add(s);
  }
  // Candidate concrete leaf SOURCES, in canonical order: authored string shift ids
  // (a numeric shift id can never be a coefficient source), then `LEAVE`. `OFF` is
  // never a valid contracted coefficient, so it is excluded even when reached.
  const leafSources: string[] = [
    ...state.shifts.filter((s) => typeof s.id === "string").map((s) => s.id as string),
    RESERVED_SHIFT_TYPE.leave,
  ];
  const items = leafSources
    .filter((id) => {
      const indices = expandShiftTypeSelector(id, map);
      return indices != null && indices.length === 1 && expanded.has(indices[0]);
    })
    .map((id) => ({ id }));
  return { items, groups: [] };
}

/** The concrete coefficient ids of a contracted domain (its `items`, in order) —
 *  the `selection` a `CoefficientFields` fed that domain must receive. */
export function contractedCoefficientIds(domain: CoefficientDomain): string[] {
  return domain.items.map((item) => item.id);
}

/**
 * Load an existing marked contracted-hours card back into a flat draft. Reads the
 * `policy`, decodes the scalar-or-`[min, max]` target back to human hours via the
 * codec, and re-syncs coefficients against the CONCRETE domain (a stale id from a
 * since-changed group is dropped; a newly-eligible id gets a blank slot). Callers
 * must guard with {@link isContractedHoursCard} first; a non-contracted card falls
 * back to exact/blank rather than throwing, so this stays total.
 */
export function toContractedForm(
  card: ContractedHoursCountCard,
  state: ScenarioUiState,
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

  const domain = buildContractedCoefficientDomain(state, countShiftTypes);
  return {
    description: card.description ?? "",
    person: Array.isArray(card.person) ? [...card.person] : [card.person],
    countDates: Array.isArray(card.countDates) ? [...card.countDates] : [card.countDates],
    countShiftTypes,
    countShiftTypeCoefficients: syncCoefficientPairs(
      contractedCoefficientIds(domain),
      (card.countShiftTypeCoefficients ?? []) as CoefficientPair[],
      domain,
    ),
    policy,
    targetExact,
    targetRangeMin,
    targetRangeMax,
  };
}

/** Per-field validation errors for the contracted form (empty ⇒ valid). The
 *  coverage bijection maps onto the coefficient slots: per-id integer/duplicate
 *  errors keyed by shift-type id, and the incomplete/extra-coverage aggregate. */
export interface ContractedErrors {
  person?: string;
  countDates?: string;
  countShiftTypes?: string;
  targetExact?: string;
  targetRangeMin?: string;
  targetRangeMax?: string;
  /** Per-coefficient errors keyed by shift-type id (CoefficientFields `errorsById`). */
  coefficientErrorsById?: Record<string, string>;
  /** Whole-control coverage error — incomplete/extra coverage (CoefficientFields
   *  `aggregateError`). Newline-joined when both incomplete AND extra fire. */
  coefficientAggregate?: string;
  /** Defensive slots for the locked encoding — expression/weight are not editable,
   *  so these should never surface from user input, but are mapped for completeness. */
  expression?: string;
  weight?: string;
}

/**
 * Validate a contracted draft for the minimal guided form: selections must be
 * non-empty and every active target must parse on the half-hour grid; a range's
 * minimum must not exceed its maximum. Does NOT enforce coverage bijection — that
 * is the shared-validator commit gate in {@link validateContractedCommit}.
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

/** Encode a draft's policy target the way {@link buildContractedCard} does: an
 *  exact scalar or a `[min, max]` range, unparsable bounds defensively `0`. */
function encodeContractedTarget(form: ContractedFormState): number | number[] {
  return form.policy === "range"
    ? [parseHalfHours(form.targetRangeMin) ?? 0, parseHalfHours(form.targetRangeMax) ?? 0]
    : (parseHalfHours(form.targetExact) ?? 0);
}

/** The locked expression the policy implies (mirrors {@link buildContractedCard}). */
function encodeContractedExpression(policy: "exact" | "range"): string | string[] {
  return policy === "range" ? ["x >= T", "x <= T"] : "x = T";
}

/**
 * Coverage-gated commit validation: the single source of truth for whether a
 * contracted draft may be saved. Runs the {@link validateContractedForm} field
 * checks first, then builds the {@link ContractedHoursInput} the draft would
 * serialize (weight `.inf`; locked expression/target per policy; coefficients
 * coerced to `[id, number]` with blanks dropped) and hands it to the SHARED
 * `validateContractedHoursContract` — the exact same helper the producer schema
 * refinement calls — so the editor never re-implements the coverage bijection.
 * The returned errors are mapped onto the editor slots: per-coefficient →
 * `coefficientErrorsById`, incomplete/extra coverage → `coefficientAggregate`,
 * shift-type selector → `countShiftTypes`, and the defensive target/expression/
 * weight slots. A malformed scenario map surfaces one aggregate error rather than
 * throwing, so the draft always stays recoverable.
 */
export function validateContractedCommit(
  form: ContractedFormState,
  state: ScenarioUiState,
): ContractedErrors {
  const errors = validateContractedForm(form);

  let map: ReturnType<typeof buildShiftTypeIndexMap>;
  try {
    map = buildShiftTypeIndexMap(state.shifts, state.shiftGroups);
  } catch (error) {
    if (error instanceof ShiftTypeMapError) {
      errors.coefficientAggregate = error.message;
      return errors;
    }
    throw error;
  }

  // Validate the coefficients over the CONCRETE domain exactly as buildContractedCard
  // will when it saves — so the coverage the shared helper checks is the SAME entry
  // set that gets persisted. Without this, a non-integer/`Infinity` value satisfies
  // the helper's `< 1` check yet is later dropped by validateCoefficientPairs, and
  // the save silently writes a card with missing coverage.
  const concreteDomain = buildContractedCoefficientDomain(state, form.countShiftTypes);
  const coefficientValidation = validateCoefficientPairs(
    contractedCoefficientIds(concreteDomain),
    form.countShiftTypeCoefficients,
    concreteDomain,
  );
  const coefficientErrorsById: Record<string, string> = { ...coefficientValidation.errorsById };
  const aggregateMessages: string[] = [];
  if (coefficientValidation.overlapError)
    aggregateMessages.push(coefficientValidation.overlapError);

  const input: ContractedHoursInput = {
    weight: Infinity,
    expression: encodeContractedExpression(form.policy),
    target: encodeContractedTarget(form),
    policy: form.policy,
    countShiftTypes: form.countShiftTypes,
    // The exact entries buildContractedCard will persist (integer-checked, blanks
    // dropped) — validate ≡ persist.
    countShiftTypeCoefficients: coefficientValidation.entries,
  };
  const groupIds = new Set(state.shiftGroups.map((g) => g.id));
  const { errors: contractErrors } = validateContractedHoursContract(input, map, groupIds);

  for (const err of contractErrors) {
    switch (err.field) {
      case "countShiftTypeCoefficients":
        // A per-id integer error from validateCoefficientPairs takes precedence over
        // the helper's coverage view of the same id (the drop is why it's incomplete).
        if (err.shiftTypeId !== undefined) coefficientErrorsById[err.shiftTypeId] ??= err.message;
        else aggregateMessages.push(err.message);
        break;
      case "countShiftTypes":
        errors.countShiftTypes ??= err.message;
        break;
      case "target":
        if (form.policy === "range") errors.targetRangeMax ??= err.message;
        else errors.targetExact ??= err.message;
        break;
      case "expression":
        errors.expression ??= err.message;
        break;
      case "weight":
        errors.weight ??= err.message;
        break;
    }
  }
  if (Object.keys(coefficientErrorsById).length > 0)
    errors.coefficientErrorsById = coefficientErrorsById;
  if (aggregateMessages.length > 0) errors.coefficientAggregate = aggregateMessages.join("\n");
  return errors;
}

/** Whether a mapped {@link ContractedErrors} carries any error (blocks commit). */
export function hasContractedErrors(errors: ContractedErrors): boolean {
  return Object.values(errors).some((value) => value !== undefined);
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
  state: ScenarioUiState,
  uid: string = crypto.randomUUID(),
): ContractedHoursCountCard {
  // Selectors keep their FULL-domain canonical order (a group/`ALL` sorts among the
  // groups); coefficients are validated/persisted over the CONCRETE leaf domain so
  // the saved `[id, value]` set is exactly the coverage bijection's day-state set.
  const fullDomain = buildCountShiftTypeDomain(state);
  const countShiftTypes = sortIdsByEntryOrder(form.countShiftTypes, fullDomain) as ShiftTypeRef[];
  const concreteDomain = buildContractedCoefficientDomain(state, countShiftTypes);
  const { entries } = validateCoefficientPairs(
    contractedCoefficientIds(concreteDomain),
    form.countShiftTypeCoefficients,
    concreteDomain,
  );

  const expression = encodeContractedExpression(form.policy);
  const target = encodeContractedTarget(form);

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
