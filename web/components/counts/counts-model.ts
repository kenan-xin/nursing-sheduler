// Shift Counts editor — pure model (T12 seed, spec 05 FR-PR-50..55a/70..74, C3
// CON-SEM squared-weight rule). All authoring logic that must be *proven* lives
// here as side-effect-free functions so it is testable in the repo's `node` vitest
// env (no DOM). The React components in this dir are thin shells over these
// helpers. Nothing here touches the store; the editor wires each result through
// `mutateScenario` (T04) as one tracked mutation.
//
// Ground truth for the exact validation order/messages, coefficient sync, and the
// generic-array lossless fallback is the historical `shift-counts/page.tsx` +
// `countShiftTypeCoefficients.ts` (spec 05's authoring source); this module mirrors
// that behavior 1:1 onto the ScreenCards shell + shared card-editor controls.
//
// M2 (Contracted Hours guided authoring) is OUT OF SCOPE here — this module only
// ever BUILDS an `OrdinaryCountCardBody` (no `tag`/`policy`). Existing
// contracted-hours cards (`tag: "contracted_hours"`) and unmarked generic-array
// cards (FR-PR-55a) are recognized so the editor can render them read-only, but
// this module never authors either shape — that is the seam M2 will fill.

import {
  RESERVED_SHIFT_TYPE,
  type CountCard,
  type ContractedHoursCountCard,
  type CoefficientEntry,
  type DateRef,
  type OrdinaryCountCard,
  type OrdinaryCountCardBody,
  type PersonRef,
  type ScenarioUiState,
  type ShiftTypeRef,
  type UiShiftType,
} from "@/lib/scenario";
import type { TransferOption } from "@/components/entity-editor/transfer-list";
import type { DateScopeOption, DateScopeItem } from "@/components/card-editor/date-scope-field";
import {
  eligibleCoefficientIds,
  sortIdsByEntryOrder,
  syncCoefficientPairs,
  validateCoefficientPairs,
  type CoefficientDomain,
  type CoefficientPair,
} from "@/components/card-editor/coefficient-fields";
import {
  isSquaredExpression,
  isSupportedExpression,
  substituteTarget,
  type ExpressionTargetValue,
} from "@/components/card-editor/expression-field";
import {
  isValidWeightValue,
  isWeightNonPositive,
  type WeightFieldValue,
} from "@/components/card-editor/weight-field";
import { deriveDateGroups, generateDateItems } from "@/lib/dates";

/** Verbatim validation messages (spec 05 "Shift Counts" validation table). */
export const COUNT_MESSAGES = {
  person: "At least one person must be selected",
  countDates: "At least one date must be selected",
  countShiftTypes: "At least one shift type must be selected",
  expression: "Please select a valid expression",
  target: "Target must be a non-negative integer",
  weightInvalid: "Weight must be a valid number, Infinity, or -Infinity",
  weightSquaredPositive: 'Weight must be non-positive for shift count with "|x - T|^2"',
  // A numeric shift-type ENTITY id has no valid `ShiftTypeRef` (selectors are
  // string-only — see `lib/scenario/types.ts`); the Python shift map keys the raw
  // numeric id, so a stringified "7" would not resolve it. Mirrors the same
  // structural constraint the coverings editor documents for its own selector.
  numericShiftId:
    "A numeric shift type ID cannot be used as a count selector; reference it by a string ID instead",
} as const;

/** The flat draft the form edits. */
export interface CountFormState {
  description: string;
  person: PersonRef[];
  countDates: DateRef[];
  countShiftTypes: ShiftTypeRef[];
  countShiftTypeCoefficients: CoefficientPair[];
  expression: string;
  target: ExpressionTargetValue;
  weight: WeightFieldValue;
}

/** A fresh, empty generic-count draft (spec 05 FR-PR-50). */
export function emptyCountForm(): CountFormState {
  return {
    description: "",
    person: [],
    countDates: [],
    countShiftTypes: [],
    countShiftTypeCoefficients: [],
    expression: "x >= T",
    target: 0,
    weight: -1,
  };
}

// --- Selection helpers (exact Object.is identity, per T09 sameEntityId) ----

/** Whether `ref` is already in `selection` — EXACT identity, so a numeric and a
 *  same-spelling string ref never collapse (T09 `sameEntityId` parity). */
export function isInSelection<T>(selection: readonly T[], ref: T): boolean {
  return selection.some((r) => Object.is(r, ref));
}

/** Toggle `ref` in `selection`, returning a NEW array (order-preserving). */
export function toggleInSelection<T>(selection: readonly T[], ref: T): T[] {
  return isInSelection(selection, ref)
    ? selection.filter((r) => !Object.is(r, ref))
    : [...selection, ref];
}

// --- Option builders --------------------------------------------------------

function labelFor(id: PersonRef | ShiftTypeRef, description?: string): string {
  const base = String(id);
  return description ? `${base} — ${description}` : base;
}

/** People options: staff items + people groups (spec 05 FR-PR-51) — unrestricted,
 *  unlike the shift-type selector below. */
export function buildPeopleTransferOptions(state: ScenarioUiState): {
  items: TransferOption<PersonRef>[];
  groups: TransferOption<PersonRef>[];
} {
  return {
    items: state.staff.map((p) => ({ value: p.id, label: labelFor(p.id, p.description) })),
    groups: state.staffGroups.map((g) => ({ value: g.id, label: labelFor(g.id, g.description) })),
  };
}

/** A shift-type transfer option's value: `ShiftTypeRef` for every SELECTABLE
 *  option; a numeric entity id is represented too (so it is visible, not hidden)
 *  but always carries `disabled: true` since it can never resolve as a selector. */
export type CountShiftTypeOptionValue = ShiftTypeRef | number;

const SYNTHETIC_SHIFT_ITEMS: readonly { id: ShiftTypeRef; description: string }[] = [
  { id: RESERVED_SHIFT_TYPE.off, description: "Day off (reserved)" },
  { id: RESERVED_SHIFT_TYPE.leave, description: "Leave (reserved)" },
];
const SYNTHETIC_SHIFT_GROUP = { id: RESERVED_SHIFT_TYPE.all, description: "Every shift type" };

/**
 * Shift-type options for Count Shift Types (spec 05 FR-PR-51/78): authored shift
 * items + groups PLUS the synthetic OFF/LEAVE items and ALL group — all enabled
 * (unlike Requirements/Coverings, Counts does NOT exclude OFF/LEAVE). A numeric
 * shift-type entity id is disabled with an actionable reason (structural — see
 * `COUNT_MESSAGES.numericShiftId`).
 */
export function buildCountShiftTypeTransferOptions(state: ScenarioUiState): {
  items: TransferOption<CountShiftTypeOptionValue>[];
  groups: TransferOption<CountShiftTypeOptionValue>[];
} {
  const authoredItems: TransferOption<CountShiftTypeOptionValue>[] = state.shifts.map((s) => {
    const numeric = typeof s.id === "number";
    return {
      value: s.id,
      label: labelFor(s.id, s.description),
      ...(numeric ? { disabled: true, disabledReason: COUNT_MESSAGES.numericShiftId } : {}),
    };
  });
  const syntheticItems: TransferOption<CountShiftTypeOptionValue>[] = SYNTHETIC_SHIFT_ITEMS.map(
    (s) => ({
      value: s.id,
      label: labelFor(s.id, s.description),
    }),
  );
  const authoredGroups: TransferOption<CountShiftTypeOptionValue>[] = state.shiftGroups.map(
    (g) => ({
      value: g.id,
      label: labelFor(g.id, g.description),
    }),
  );
  const allGroup: TransferOption<CountShiftTypeOptionValue> = {
    value: SYNTHETIC_SHIFT_GROUP.id,
    label: labelFor(SYNTHETIC_SHIFT_GROUP.id, SYNTHETIC_SHIFT_GROUP.description),
  };
  return { items: [...authoredItems, ...syntheticItems], groups: [...authoredGroups, allGroup] };
}

/**
 * The coefficient domain for Count Shift Types: authored STRING shift items (a
 * numeric id can never be a coefficient source — see above) plus the synthetic
 * OFF/LEAVE items, and authored groups plus the synthetic ALL group. Every id here
 * is structurally coefficient-eligible per FR-PR-70 — Counts has no special-case
 * exclusion (LEAVE, OFF, and even ALL each get a coefficient row once selected).
 */
export function buildCountShiftTypeDomain(state: ScenarioUiState): CoefficientDomain {
  // Coefficient SOURCES are string-only (`CoefficientEntry`/`ShiftTypeRef`): only
  // string shift items + the synthetic OFF/LEAVE keywords can be selected/persisted.
  const stringItemIds = state.shifts
    .filter((s): s is UiShiftType & { id: string } => typeof s.id === "string")
    .map((s) => s.id);
  const sourceItemIds = [...stringItemIds, ...SYNTHETIC_SHIFT_ITEMS.map((s) => s.id)];
  // Group members keep their AUTHORED type (M1): a numeric shift id stays numeric so
  // expansion/coverage/overlap compare with the same typed identity the backend uses
  // — a group `G -> [1]` must NOT make the unrelated string shift `"1"` eligible.
  const allMemberIds: (number | string)[] = [
    ...state.shifts.map((s) => s.id),
    ...SYNTHETIC_SHIFT_ITEMS.map((s) => s.id),
  ];
  return {
    items: sourceItemIds.map((id) => ({ id })),
    groups: [
      ...state.shiftGroups.map((g) => ({ id: g.id, members: [...g.members] })),
      { id: SYNTHETIC_SHIFT_GROUP.id, members: allMemberIds },
    ],
  };
}

/** The auto-derived date-scope chips (ALL / WEEKDAY / WEEKEND / day-of-week). */
export function buildDateScopeAutoScopes(state: ScenarioUiState): DateScopeOption[] {
  const items = generateDateItems({ start: state.rangeStart, end: state.rangeEnd });
  return deriveDateGroups(items)
    .filter((g) => g.members.length > 0)
    .map((g) => ({ id: g.id, label: g.description ?? g.id }));
}

/** Authored date groups as date-scope chips. */
export function buildDateScopeDateGroups(state: ScenarioUiState): DateScopeOption[] {
  return state.dateGroups.map((g) => ({ id: String(g.id), label: labelFor(g.id, g.description) }));
}

/** Expand an inclusive ISO `YYYY-MM-DD` range into its concrete dates. Returns
 *  `[]` for a missing/invalid/reversed range. */
export function expandDateRange(rangeStart: string, rangeEnd: string): string[] {
  if (!rangeStart || !rangeEnd) return [];
  const start = Date.parse(`${rangeStart}T00:00:00Z`);
  const end = Date.parse(`${rangeEnd}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return [];
  const dates: string[] = [];
  const DAY = 86_400_000;
  for (let t = start; t <= end; t += DAY) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

/** In-range concrete dates for the "specific dates" text field, chronological. */
export function buildDateScopeDateItems(state: ScenarioUiState): DateScopeItem[] {
  return expandDateRange(state.rangeStart, state.rangeEnd).map((iso) => ({
    id: iso,
    dayOfMonth: Number(iso.slice(8)),
  }));
}

// --- Validation, build, and load --------------------------------------------

/** Per-field validation errors (empty ⇒ valid). Mirrors the historical
 *  `ShiftCountErrors` shape: coefficient errors are a SEPARATE field from
 *  `countShiftTypes` (never overwrite each other). */
export interface CountErrors {
  person?: string;
  countDates?: string;
  countShiftTypes?: string;
  /** `\n`-joined per-id messages, OR the overlap message when every id is valid. */
  coefficients?: string;
  coefficientErrorsById?: Record<string, string>;
  expression?: string;
  target?: string;
  weight?: string;
}

/**
 * Validate a generic-count draft (spec 05 "Shift Counts" validation table). Field
 * order mirrors the historical `validateForm`: person, dates, shift types,
 * coefficients, expression, target, weight (incl. the squared-weight rule).
 */
export function validateCountForm(form: CountFormState, domain: CoefficientDomain): CountErrors {
  const errors: CountErrors = {};
  if (form.person.length === 0) errors.person = COUNT_MESSAGES.person;
  if (form.countDates.length === 0) errors.countDates = COUNT_MESSAGES.countDates;
  if (form.countShiftTypes.length === 0) errors.countShiftTypes = COUNT_MESSAGES.countShiftTypes;

  const coefficientValidation = validateCoefficientPairs(
    form.countShiftTypes,
    form.countShiftTypeCoefficients,
    domain,
  );
  if (Object.keys(coefficientValidation.errorsById).length > 0) {
    errors.coefficients = Object.values(coefficientValidation.errorsById).join("\n");
    errors.coefficientErrorsById = coefficientValidation.errorsById;
  } else if (coefficientValidation.overlapError) {
    errors.coefficients = coefficientValidation.overlapError;
  }

  if (!isSupportedExpression(form.expression)) errors.expression = COUNT_MESSAGES.expression;

  if (typeof form.target !== "number" || !Number.isInteger(form.target) || form.target < 0) {
    errors.target = COUNT_MESSAGES.target;
  }

  if (!isValidWeightValue(form.weight)) {
    errors.weight = COUNT_MESSAGES.weightInvalid;
  } else if (isSquaredExpression(form.expression) && !isWeightNonPositive(form.weight)) {
    errors.weight = COUNT_MESSAGES.weightSquaredPositive;
  }

  return errors;
}

/**
 * Assemble the saved generic count card from a validated draft (spec 05
 * FR-PR-50..55). `countShiftTypes` is re-sorted to canonical entry order
 * (FR-PR-54); coefficients are synced/validated one more time (defensive — Save
 * only calls this after `validateCountForm` reports no errors) and attached only
 * when non-empty (FR-PR-74). `uid` is injectable for deterministic tests. Builds
 * only the `OrdinaryCountCardBody` shape — never a `tag`/`policy` marker (M2 seam).
 */
export function buildCountCard(
  form: CountFormState,
  domain: CoefficientDomain,
  uid: string = crypto.randomUUID(),
): CountCard {
  const countShiftTypes = sortIdsByEntryOrder(form.countShiftTypes, domain) as ShiftTypeRef[];
  const { entries } = validateCoefficientPairs(
    countShiftTypes,
    form.countShiftTypeCoefficients,
    domain,
  );
  const body: OrdinaryCountCardBody = {
    // FR-PR-04: the description is stored exactly as authored (it may be empty and
    // is never trimmed) — the historical `buildShiftCountFromForm` is lossless here.
    description: form.description,
    person: [...form.person],
    countDates: [...form.countDates],
    countShiftTypes,
    expression: form.expression,
    target: form.target as number,
    weight: form.weight as number,
  };
  if (entries.length > 0) body.countShiftTypeCoefficients = entries as CoefficientEntry[];
  return { uid, ...body };
}

/** Whether `card` is a contracted-hours variant (M2's marker — not authored here,
 *  only recognized so the card list can render its badge, per the ticket seam). */
export function isContractedHoursCard(card: CountCard): card is ContractedHoursCountCard {
  return card.tag === "contracted_hours";
}

/**
 * The lossless generic-array fallback (spec 05 FR-PR-55a): a backend-valid,
 * UNMARKED count whose `expression`/`target` is an array. Such a card cannot enter
 * the scalar form — Edit is blocked/read-only; duplicate/reorder/save must
 * preserve the arrays exactly (never routed through this module's build/validate
 * path, which only ever produces scalars).
 */
export function isAdvancedCountCard(card: CountCard): boolean {
  return (
    !isContractedHoursCard(card) && (Array.isArray(card.expression) || Array.isArray(card.target))
  );
}

/** Whether `card` can be opened in this generic scalar form — neither a
 *  contracted-hours card (M2, not built here) nor an unmarked advanced/list count
 *  (FR-PR-55a). */
export function isEditableCountCard(card: CountCard): card is OrdinaryCountCard {
  return !isContractedHoursCard(card) && !isAdvancedCountCard(card);
}

/**
 * Load an existing EDITABLE card back into a flat form draft (mirrors the
 * historical `handleStartEdit`). Coefficients are re-synced against the current
 * domain so a stale id from a since-changed group membership is dropped and any
 * newly-eligible id gets a blank slot (FR-PR-73). Callers must guard with
 * {@link isEditableCountCard} first — an advanced/contracted-hours card falls back
 * to a scalar expression/target of `0` here rather than throwing, so this stays
 * total, but such a card should never actually reach this function in the editor.
 */
export function countToForm(card: CountCard, domain: CoefficientDomain): CountFormState {
  const expression = Array.isArray(card.expression) ? "x >= T" : card.expression;
  const target = typeof card.target === "number" ? card.target : 0;
  const countShiftTypes = Array.isArray(card.countShiftTypes)
    ? [...card.countShiftTypes]
    : [card.countShiftTypes];
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
    expression,
    target,
    weight: card.weight,
  };
}

/** Render a count's expression(s)/target(s) for the card summary (FR-PR-55, the
 *  historical `describeExpressionTarget`): `T` is textually substituted per
 *  indexed pair; a scalar renders once, a list (contracted-hours range, or an
 *  opaque advanced rule) renders each bound comma-joined. A shape mismatch (opaque
 *  advanced rule with uneven array lengths) shows both sides raw rather than guess. */
export function describeCountExpressionTarget(
  expression: string | string[],
  target: number | number[],
): string {
  const expressions = Array.isArray(expression) ? expression : [expression];
  const targets = Array.isArray(target) ? target : [target];
  if (expressions.length === targets.length) {
    return expressions.map((expr, i) => substituteTarget(expr, targets[i])).join(", ");
  }
  return `${expressions.join(", ")} (target ${targets.join(", ")})`;
}

/** Comma-joined ids for a card summary field (People / Count shift types / Dates). */
export function summarizeRefs(
  refs: PersonRef | DateRef | ShiftTypeRef | (PersonRef | DateRef | ShiftTypeRef)[],
): string {
  const list = Array.isArray(refs) ? refs : [refs];
  return list.map(String).join(", ");
}

/** Eligible coefficient ids for a saved card's current selection, in canonical
 *  order — used by the card list to size/label the coefficient chip row. */
export function coefficientIdsFor(
  countShiftTypes: readonly ShiftTypeRef[],
  domain: CoefficientDomain,
): string[] {
  return eligibleCoefficientIds(countShiftTypes, domain);
}

/**
 * Reorder a uid-keyed list for a drag-drop, honoring the pointer-half `position`
 * (FR-PR-12): `"before"` inserts the dragged card immediately before the hovered
 * card, `"after"` immediately after — computed against the ORIGINAL indices, then
 * corrected for the gap left by removing the dragged card. Pure + generic so the
 * insertion math is unit-testable without the store (M5).
 */
export function reorderByDrop<T extends { uid: string }>(
  list: readonly T[],
  fromUid: string,
  toUid: string,
  position: "before" | "after",
): T[] {
  const from = list.findIndex((c) => c.uid === fromUid);
  const to = list.findIndex((c) => c.uid === toUid);
  if (from === -1 || to === -1 || from === to) return [...list];
  let insertAt = position === "before" ? to : to + 1;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  // Removing `from` shifts every later index left by one.
  if (from < insertAt) insertAt -= 1;
  next.splice(insertAt, 0, moved);
  return next;
}

/** Return a copy of `card` with the UI-only `disabled` marker set to `value`
 *  (M4 Enable/Disable). Stripping the marker when re-enabling keeps the card body
 *  clean; `canonical.ts` skips disabled cards regardless, so this is UI-only. */
export function withCardDisabled(card: CountCard, value: boolean): CountCard {
  if (value) return { ...card, disabled: true } as CountCard;
  const rest: Record<string, unknown> = { ...card };
  delete rest.disabled;
  return rest as unknown as CountCard;
}
