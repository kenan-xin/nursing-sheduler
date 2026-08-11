// The ephemeral staffing-equation projection (G7).
//
// Ward 8 states its staffing through shift-type GROUPS (`AllMornings`) and
// qualification scopes (`long+` limited to `SeniorStaffNurses`), not through a
// per-shift headcount. F3's `context.baselineMinimums` deliberately refuses to
// invent a number for those shapes, so the Coverage lens had nothing to say
// about the one scenario it exists for.
//
// This module is the answer, and its boundary is the load-bearing part:
//
//   • It is EPHEMERAL. Nothing here is added to the persisted `RosterContext`,
//     whose derivation is roster-schema-versioned and byte-validated. The model
//     is re-derived from the IMMUTABLE `submission.canonicalYaml` and memoized
//     by the viewer; Save/Import/validation stay byte-compatible.
//   • It MIRRORS THE BACKEND. Normalization follows
//     `core/nurse_scheduling/preference_types.py:shift_type_requirements`
//     exactly — flat top-level lists are independent equations, group/nested
//     selectors are one aggregate equation, each resolved date is its own cell,
//     `qualifiedPeople` both filters the numerator AND forbids every unqualified
//     assignment, and `shiftTypeCoefficients` weight COVERAGE UNITS rather than
//     people. A shape the solver reads one way is never read another way here.
//   • It NEVER INVENTS A QUOTA. A group minimum is never divided across its
//     member shifts. An equation that cannot be resolved is explicitly
//     unavailable with a plain reason and never evaluates satisfied.

import {
  buildScenarioResolutionContext,
  PREFERENCE_TYPE,
  RESERVED_SHIFT_TYPE,
  type CanonicalScenarioDocument,
  type CanonicalShiftTypeRequirementPreference,
  type PersonRef,
  type ShiftTypeGroupMember,
  type ShiftTypeId,
} from "@/lib/scenario";
import { parseSubmissionDocument, typedIdKey } from "@/lib/roster";
import type { RosterContext, RosterDayGrid, RosterSubmission } from "@/lib/roster";

/**
 * One backend staffing equation: a single `sum(...) == / >= required` constraint
 * family, already normalized the way `_parse_shift_type_requirement_groups`
 * normalizes it. One authored requirement produces ONE equation for a scalar,
 * group or nested selector, and N independent equations for a flat top-level
 * list of N selectors.
 */
export interface RequirementEquation {
  /** Stable render/test key: `preferences[i]#g`. */
  readonly key: string;
  /** Index into `document.preferences` — the source-order authority. */
  readonly preferenceIndex: number;
  /** Which top-level requirement group of that preference this equation is. */
  readonly groupIndex: number;
  /** The authored `description`, when the scenario supplied one. */
  readonly description: string | null;
  /** The authored shift-type selector, rendered for display (`AllMornings`). */
  readonly scopeLabel: string;
  /** The authored date selector, rendered for display (`Every day` when ALL). */
  readonly dateLabel: string;
  /** Resolved worked-shift item indices, aligned to `context.shiftTypes`. */
  readonly shiftIndices: readonly number[];
  /** The same shifts as authored ids, for display. */
  readonly shiftIds: readonly ShiftTypeId[];
  /** Per-entry coverage weight, parallel to `shiftIndices`. */
  readonly coefficients: readonly number[];
  /** Whether any coefficient is not 1 — the numerator is UNITS, not people. */
  readonly weighted: boolean;
  /** The authored `qualifiedPeople` selector, rendered, or null when unscoped. */
  readonly qualifiedLabel: string | null;
  /** Resolved qualified person indices, or null when the equation is unscoped. */
  readonly qualifiedPeople: ReadonlySet<number> | null;
  /** The date indices this equation actually applies to. */
  readonly dateIndices: ReadonlySet<number>;
  /**
   * Whether the DATE selector itself resolved.
   *
   * Distinct from an empty `dateIndices`, which would otherwise conflate "known
   * to apply on no date here" with "applicability could not be determined at
   * all". Only the first licenses a `not-applicable` verdict; the second has to
   * fail closed, because an equation whose dates cannot be read might apply to
   * the day being rendered.
   */
  readonly dateScopeResolved: boolean;
  /** The hard lower (or exact) target. */
  readonly required: number;
  /** The soft upper target, or null when `required` is exact. */
  readonly preferred: number | null;
  /** Non-null when the equation cannot be evaluated, with a plain reason. */
  readonly unavailable: string | null;
}

/** The whole ephemeral model for one roster document. */
export interface RequirementModel {
  /** Every staffing equation, in authored source order. */
  readonly equations: readonly RequirementEquation[];
  /**
   * Non-null when the SUBMISSION itself could not be projected at all (a corrupt
   * or unparseable canonical document). Distinct from a per-equation
   * `unavailable`, which is a resolvable document with one bad selector.
   */
  readonly reason: string | null;
}

/** One equation's verdict on one day. */
export type RequirementCell =
  | { readonly status: "not-applicable" }
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "checked";
      /** The weighted coverage units contributed by counted assignees. */
      readonly units: number;
      readonly required: number;
      readonly preferred: number | null;
      /** How far below the lower/exact target, or 0. */
      readonly short: number;
      /** How far above the upper/exact target, or 0. */
      readonly over: number;
      /** Forbidden assignments outside the qualified set, or 0. */
      readonly unqualified: number;
      /** Whether ANY hard verdict failed. */
      readonly mismatch: boolean;
      /** People counted toward the numerator, in axis order. */
      readonly counted: readonly number[];
      /** Unqualified assignees on the selected shifts, in axis order. */
      readonly offenders: readonly number[];
    };

/** `[equationIdx][dateIdx]` — one verdict per equation per day. */
export type RequirementGrid = readonly (readonly RequirementCell[])[];

/**
 * Who is on each concrete (day, shift), in person-axis order.
 *
 * Built once per current-days grid and shared by the equation evaluator and the
 * Exact shifts plane, so both planes read the same assignments and a person can
 * never appear in one and not the other.
 */
export interface RosterAssignmentIndex {
  /** `[dateIdx][shiftIdx]` → person indices, ascending. */
  readonly byDateShift: readonly (readonly (readonly number[])[])[];
}

/** Build the (day, shift) → people index from the CURRENT (edited) assignments. */
export function buildAssignmentIndex(
  context: RosterContext,
  currentDays: RosterDayGrid,
): RosterAssignmentIndex {
  const shiftIdxByKey = new Map<string, number>();
  context.shiftTypes.forEach((shift, shiftIdx) => {
    shiftIdxByKey.set(typedIdKey(shift.id), shiftIdx);
  });
  const dateCount = context.calendar.length;
  const shiftCount = context.shiftTypes.length;
  const byDateShift: number[][][] = Array.from({ length: dateCount }, () =>
    Array.from({ length: shiftCount }, () => [] as number[]),
  );
  // Person-major so each lane comes out in ascending person-axis order without a
  // second sort — the order the Coverage and Day planes display people in.
  for (let personIdx = 0; personIdx < currentDays.length; personIdx++) {
    const row = currentDays[personIdx];
    for (let dateIdx = 0; dateIdx < dateCount; dateIdx++) {
      const cell = row[dateIdx];
      if (cell === undefined || cell.kind !== "shift") continue;
      const shiftIdx = shiftIdxByKey.get(typedIdKey(cell.shiftId));
      if (shiftIdx === undefined) continue;
      byDateShift[dateIdx][shiftIdx].push(personIdx);
    }
  }
  return { byDateShift };
}

// ---------------------------------------------------------------------------
// Derivation — the backend normalization, ported.
// ---------------------------------------------------------------------------

/** Render a selector (scalar or list) the way the scenario author wrote it. */
function selectorLabel(selector: unknown): string {
  if (Array.isArray(selector)) return `[${selector.map(selectorLabel).join(", ")}]`;
  return String(selector);
}

/**
 * Normalize `shiftType` into top-level requirement groups, mirroring
 * `_parse_shift_type_requirement_groups`:
 *
 *   `D` → `[[D]]`   •   `Group(D,E)` → `[[D,E]]`   •   `[D, E]` → `[[D],[E]]`
 *   `[[D, E]]` → `[[D,E]]`
 *
 * A non-list selector is ONE equation; each element of a top-level list is its
 * own independent equation, and a nested list inside it aggregates.
 */
function normalizeGroups(
  shiftType: CanonicalShiftTypeRequirementPreference["shiftType"],
): { selector: ShiftTypeGroupMember | readonly ShiftTypeGroupMember[]; label: string }[] {
  if (!Array.isArray(shiftType)) {
    return [{ selector: shiftType, label: selectorLabel(shiftType) }];
  }
  return shiftType.map((element) => ({
    selector: element as ShiftTypeGroupMember | readonly ShiftTypeGroupMember[],
    label: selectorLabel(element),
  }));
}

/** An equation that cannot be evaluated, carrying its plain-language reason. */
function unavailableEquation(
  base: Omit<RequirementEquation, "unavailable">,
  reason: string,
): RequirementEquation {
  return { ...base, unavailable: reason };
}

/**
 * Derive the ephemeral equation model from a roster document's immutable
 * submission.
 *
 * Pure and memoizable: the same `canonicalYaml` always yields the same model, so
 * the viewer keys its `useMemo` on `document.submission`.
 */
export function deriveRequirementModel(
  submission: Pick<RosterSubmission, "canonicalYaml">,
): RequirementModel {
  const parsed = parseSubmissionDocument(submission.canonicalYaml);
  if (!parsed.ok) return { equations: [], reason: parsed.reason };
  return { equations: buildEquations(parsed.document), reason: null };
}

/** The equation list for an already-parsed canonical document. */
export function buildEquations(document: CanonicalScenarioDocument): RequirementEquation[] {
  const items = document.shiftTypes.items;
  const resolver = buildScenarioResolutionContext({
    staff: document.people.items,
    staffGroups: document.people.groups ?? [],
    shifts: items,
    shiftGroups: document.shiftTypes.groups ?? [],
    rangeStart: document.dates.range.startDate,
    rangeEnd: document.dates.range.endDate,
    dateGroups: document.dates.groups ?? [],
  });
  const allDates = resolver.resolveDates(RESERVED_SHIFT_TYPE.all);

  const equations: RequirementEquation[] = [];
  document.preferences.forEach((preference, preferenceIndex) => {
    if (preference.type !== PREFERENCE_TYPE.shiftTypeRequirement) return;
    const requirement = preference as CanonicalShiftTypeRequirementPreference;
    const groups = normalizeGroups(requirement.shiftType);

    // Dates first: an absent selector means every day (the backend's
    // `ds = range(ctx.n_days)` default), and an unresolvable one makes every
    // equation of this requirement unavailable rather than empty.
    const dateResolution =
      requirement.date === undefined ? allDates : resolver.resolveDates(requirement.date);
    const dateLabel =
      requirement.date === undefined || requirement.date === RESERVED_SHIFT_TYPE.all
        ? "Every day"
        : selectorLabel(requirement.date);

    // Qualification next: it filters the numerator AND adds the backend's
    // separate `unqualified_n_people == 0` constraint per selected shift.
    //
    // A selector that resolves to EVERY person is not a qualification at all:
    // the filter is the identity and the exclusion constraint is vacuous. The
    // canonical serializer emits a scalar `ALL` for the ordinary unqualified
    // case, so treating it as a real scope would put a meaningless
    // "qualified: ALL" chip on every row and would wrongly disqualify the
    // equation from being an exact-shift target.
    const qualifiedResolutionRaw =
      requirement.qualifiedPeople === undefined
        ? null
        : resolver.resolvePeople(requirement.qualifiedPeople as PersonRef | readonly PersonRef[]);
    const vacuousQualification =
      qualifiedResolutionRaw?.resolved === true &&
      qualifiedResolutionRaw.values.size === document.people.items.length;
    const qualifiedResolution = vacuousQualification ? null : qualifiedResolutionRaw;
    const qualifiedLabel =
      requirement.qualifiedPeople === undefined || vacuousQualification
        ? null
        : selectorLabel(requirement.qualifiedPeople);

    // Coefficients are only legal when the selector normalizes to ONE group
    // (`_parse_shift_type_requirement_coefficients` raises otherwise).
    const coefficientEntries = requirement.shiftTypeCoefficients ?? [];
    const coefficientsIllegal = coefficientEntries.length > 0 && groups.length !== 1;

    groups.forEach((group, groupIndex) => {
      const resolved = resolver.resolveShiftTypes(group.selector);
      const shiftIndices = resolved.resolved ? [...resolved.values].sort((a, b) => a - b) : [];
      const base: Omit<RequirementEquation, "unavailable"> = {
        key: `preferences[${preferenceIndex}]#${groupIndex}`,
        preferenceIndex,
        groupIndex,
        description: requirement.description ?? null,
        scopeLabel: group.label,
        dateLabel,
        shiftIndices,
        shiftIds: shiftIndices
          .filter((index) => index >= 0 && index < items.length)
          .map((index) => items[index].id),
        coefficients: shiftIndices.map(() => 1),
        weighted: false,
        qualifiedLabel,
        qualifiedPeople: qualifiedResolution?.resolved === true ? qualifiedResolution.values : null,
        dateIndices: dateResolution.resolved ? dateResolution.values : new Set<number>(),
        dateScopeResolved: dateResolution.resolved,
        required: requirement.requiredNumPeople,
        preferred: requirement.preferredNumPeople ?? null,
      };

      const reason = equationFailure({
        resolvedShifts: resolved.resolved,
        shiftIndices,
        itemCount: items.length,
        dateResolved: dateResolution.resolved,
        qualifiedRequested: requirement.qualifiedPeople !== undefined && !vacuousQualification,
        qualifiedResolved: qualifiedResolutionRaw?.resolved === true,
        coefficientsIllegal,
        required: requirement.requiredNumPeople,
        scopeLabel: group.label,
      });
      if (reason !== null) {
        equations.push(unavailableEquation(base, reason));
        return;
      }

      const coefficients = resolveCoefficients(coefficientEntries, shiftIndices, resolver);
      if (coefficients === null) {
        equations.push(
          unavailableEquation(
            base,
            `the shift-type coefficients on ${group.label} are not covered by its selector`,
          ),
        );
        return;
      }
      equations.push({
        ...base,
        coefficients,
        weighted: coefficients.some((coefficient) => coefficient !== 1),
        unavailable: null,
      });
    });
  });
  return equations;
}

/** The first reason this equation cannot be evaluated, or null when it can. */
function equationFailure(input: {
  resolvedShifts: boolean;
  shiftIndices: readonly number[];
  itemCount: number;
  dateResolved: boolean;
  qualifiedRequested: boolean;
  qualifiedResolved: boolean;
  coefficientsIllegal: boolean;
  required: number;
  scopeLabel: string;
}): string | null {
  if (!input.resolvedShifts) {
    return `the shift-type selector ${input.scopeLabel} does not resolve in this scenario`;
  }
  if (input.shiftIndices.length === 0) {
    return `the shift-type selector ${input.scopeLabel} selects no shift`;
  }
  // Reserved sentinels are negative indices. The backend REJECTS OFF/LEAVE in a
  // staffing requirement outright, so a document containing one is invalid —
  // reporting that is truthful where evaluating it would not be.
  if (input.shiftIndices.some((index) => index < 0 || index >= input.itemCount)) {
    return `${input.scopeLabel} reaches the reserved OFF/LEAVE day-states, which cannot staff a shift`;
  }
  if (!input.dateResolved) return "its date selector does not resolve in this scenario";
  if (input.qualifiedRequested && !input.qualifiedResolved) {
    return "its qualified-people selector does not resolve in this scenario";
  }
  if (input.coefficientsIllegal) {
    return "shift-type coefficients are only defined when the selector is one requirement group";
  }
  if (!Number.isSafeInteger(input.required))
    return "its required number of people is not a whole number";
  return null;
}

/**
 * Per-shift coverage weights, mirroring
 * `_parse_shift_type_requirement_coefficients`: every selected shift starts at 1,
 * each entry expands through the shift map and must be a subset of the selection
 * with no duplicate coverage, and a coefficient below 1 is invalid. Returns null
 * when the backend would raise.
 */
function resolveCoefficients(
  entries: readonly (readonly [string, number])[],
  shiftIndices: readonly number[],
  resolver: ReturnType<typeof buildScenarioResolutionContext>,
): number[] | null {
  const coefficients = shiftIndices.map(() => 1);
  if (entries.length === 0) return coefficients;
  const selected = new Set(shiftIndices);
  const claimed = new Set<number>();
  for (const [shiftTypeId, coefficient] of entries) {
    if (!Number.isSafeInteger(coefficient) || coefficient < 1) return null;
    const expanded = resolver.resolveShiftTypes(shiftTypeId);
    if (!expanded.resolved) return null;
    for (const index of expanded.values) {
      if (!selected.has(index)) return null;
      if (claimed.has(index)) return null;
      claimed.add(index);
      coefficients[shiftIndices.indexOf(index)] = coefficient;
    }
  }
  return coefficients;
}

// ---------------------------------------------------------------------------
// Evaluation — the live verdict against the CURRENT (edited) assignments.
// ---------------------------------------------------------------------------

/**
 * Evaluate ONE equation on ONE day.
 *
 * Three verdicts can fail independently and may coexist, exactly as the backend
 * builds them: the lower/exact bound, the upper bound (`preferredNumPeople`, or
 * the same exact value when there is none), and the qualification exclusion
 * `unqualified_n_people == 0`. The last is why a qualified row can read `1/1`
 * and still be red — an ordinary nurse standing in a senior-only slot violates a
 * hard constraint the numerator cannot see.
 */
export function evaluateRequirementCell(
  equation: RequirementEquation,
  index: RosterAssignmentIndex,
  dateIdx: number,
): RequirementCell {
  // APPLICABILITY FIRST, WHENEVER IT IS KNOWABLE.
  //
  // A resolved date scope is a settled fact about this equation that survives
  // any OTHER selector failing: a rule scoped to the 1st simply does not govern
  // the 2nd, whether or not its shift or people selector resolves. Returning
  // `unavailable` before consulting the dates leaked one malformed rule onto
  // every off-scope day — painting those days `unknown`, counting them in the
  // unavailable total, and rendering a warning cell for a rule that does not
  // apply there.
  if (equation.dateScopeResolved && !equation.dateIndices.has(dateIdx)) {
    return { status: "not-applicable" };
  }
  // ...but when the DATE selector itself could not be resolved, applicability is
  // exactly what is unknown, so every date fails closed rather than quietly
  // excusing itself.
  if (equation.unavailable !== null) {
    return { status: "unavailable", reason: equation.unavailable };
  }

  const lane = index.byDateShift[dateIdx];
  if (lane === undefined) return { status: "not-applicable" };

  const qualified = equation.qualifiedPeople;
  const counted: number[] = [];
  const offenders: number[] = [];
  let units = 0;
  equation.shiftIndices.forEach((shiftIdx, entry) => {
    const people = lane[shiftIdx] ?? [];
    for (const personIdx of people) {
      if (qualified !== null && !qualified.has(personIdx)) {
        offenders.push(personIdx);
        continue;
      }
      counted.push(personIdx);
      units += equation.coefficients[entry] ?? 1;
    }
  });

  const upper = equation.preferred ?? equation.required;
  const short = Math.max(0, equation.required - units);
  const over = Math.max(0, units - upper);
  return {
    status: "checked",
    units,
    required: equation.required,
    preferred: equation.preferred,
    short,
    over,
    unqualified: offenders.length,
    mismatch: short > 0 || over > 0 || offenders.length > 0,
    counted,
    offenders,
  };
}

/** Evaluate every equation across every day. `[equationIdx][dateIdx]`. */
export function computeRequirementGrid(
  model: RequirementModel,
  index: RosterAssignmentIndex,
  dateCount: number,
): RequirementGrid {
  return model.equations.map((equation) =>
    Array.from({ length: dateCount }, (_unused, dateIdx) =>
      evaluateRequirementCell(equation, index, dateIdx),
    ),
  );
}

/** A roster-level statement about the declared equations. */
export interface RequirementSummary {
  /** (equation, day) cells whose hard constraints are violated. */
  readonly mismatched: number;
  /** (equation, day) cells that were actually evaluated. */
  readonly checked: number;
  /** (equation, day) cells that could not be evaluated. */
  readonly unavailable: number;
  /** Whether ANYTHING was checkable. False makes no staffing claim. */
  readonly anyCheckable: boolean;
}

/**
 * Summarise declared-equation health.
 *
 * UNKNOWN IS NOT GOOD NEWS: an unavailable equation is the absence of evidence,
 * so it is counted and named rather than absorbed into an all-clear.
 */
export function summariseRequirements(grid: RequirementGrid): RequirementSummary {
  let mismatched = 0;
  let checked = 0;
  let unavailable = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell.status === "checked") {
        checked++;
        if (cell.mismatch) mismatched++;
      } else if (cell.status === "unavailable") {
        unavailable++;
      }
    }
  }
  return { mismatched, checked, unavailable, anyCheckable: checked > 0 };
}

/** The worst declared-equation state for one day — the Day-strip health dot. */
export type RequirementHealth = "under" | "at" | "ok" | "unknown";

/**
 * `under` = at least one hard mismatch (Short, Over or Unqualified);
 * `unknown` = something applicable on this day could not be evaluated at all;
 * `at` = every applicable equation is satisfied but at least one sits below a
 * higher preferred target; `ok` = everything is comfortably satisfied.
 *
 * IT FAILS CLOSED ON MIXED STATES. A hard mismatch is still the worst answer and
 * wins outright — but if ANY applicable equation is unavailable, the day is
 * `unknown` even when every other equation is satisfied. Skipping unavailable
 * cells and reporting `ok` on the rest painted a green dot over a date carrying
 * a requirement nothing had checked, which is the false all-clear this lens
 * exists to refuse. Absence of evidence is not evidence of sufficiency.
 */
export function requirementDayHealth(grid: RequirementGrid, dateIdx: number): RequirementHealth {
  let checked = 0;
  let atFloor = false;
  let unavailable = false;
  for (const row of grid) {
    const cell = row[dateIdx];
    if (cell === undefined || cell.status === "not-applicable") continue;
    if (cell.status === "unavailable") {
      unavailable = true;
      continue;
    }
    checked++;
    // A hard mismatch outranks everything, including an unavailable sibling.
    if (cell.mismatch) return "under";
    if (cell.preferred !== null && cell.units < cell.preferred) atFloor = true;
  }
  if (unavailable || checked === 0) return "unknown";
  return atFloor ? "at" : "ok";
}

/**
 * The exact-shift required value for one shift ON ONE DAY.
 *
 * The rule is per `(shift, date)`, exactly as the settled contract states it:
 * exactly one equation, over exactly this one shift, APPLICABLE ON THIS DATE,
 * unweighted and unqualified. Anything aggregate, weighted, qualified or
 * unresolved is excluded, because copying such a target onto an exact-shift lane
 * is the invented per-shift quota this closure forbids.
 *
 * DAY-AWARENESS IS LOAD-BEARING. An earlier version demanded that the equation
 * apply to EVERY roster day, which quietly deleted a genuinely authored target:
 * a `D = 1` requirement scoped to one date showed in Declared requirements while
 * Grid and Day omitted `staffed/required` on the very date it governs, and two
 * disjoint date-scoped equations for the same shift were treated as globally
 * ambiguous even though exactly one applies on each day. Ambiguity is a property
 * of a single day, not of the calendar: only two equations applicable to the
 * SAME date leave no single number to show.
 */
export function exactShiftRequirement(
  model: RequirementModel,
  shiftIdx: number,
  dateIdx: number,
): number | null {
  let found: number | null = null;
  for (const equation of model.equations) {
    if (equation.unavailable !== null) continue;
    if (equation.shiftIndices.length !== 1 || equation.shiftIndices[0] !== shiftIdx) continue;
    if (equation.weighted) continue;
    if (equation.qualifiedPeople !== null) continue;
    if (!equation.dateIndices.has(dateIdx)) continue;
    // A second equation applicable to THIS day makes the target ambiguous; the
    // backend applies both constraints, so there is no single number to show.
    if (found !== null) return null;
    found = equation.required;
  }
  return found;
}
