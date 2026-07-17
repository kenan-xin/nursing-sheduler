// Staffing Requirements editor — pure model (T12 M1 clone, spec 05 FR-PR-20..29,
// 40..42, 70..76; C3 CON-SEM `requiredNumPeople`/`preferredNumPeople` interplay).
// All authoring logic that must be *proven* lives here as side-effect-free
// functions so it is testable in the repo's `node` vitest env (no DOM). The React
// components in this dir are thin shells over these helpers. Nothing here touches
// the store; the editor wires each result through `mutateScenario` (T04) as one
// tracked mutation.
//
// This is the most complex of the three T12 clones:
//   • the Shift Type selector is SINGLE-select (a radio, not a multi-select) and
//     structurally EXCLUDES OFF/LEAVE (and any group reaching them) — FR-PR-21,
//     EDGE-PR-07, matching the backend rejection (C3 E26/E26a);
//   • the weight dial is CONDITIONAL: shown only when `preferredNumPeople` differs
//     from `requiredNumPeople`; otherwise it is forced to `-1` and `preferredNumPeople`
//     is forced `undefined` on save, regardless of what the (hidden) field held —
//     FR-PR-24/25, EDGE-PR-03;
//   • a coverage-warning banner (FR-PR-28/40..42) is derived from ALL current
//     requirements against the scenario's worked shift types — undefined
//     (uncovered) `(date, shiftType)` pairs and duplicate coverage.

import {
  RESERVED_SHIFT_TYPE,
  isDayStateSelector,
  type CoefficientEntry,
  type DateRef,
  type NestedShiftTypeRefList,
  type PersonRef,
  type RequirementCard,
  type RequirementCardBody,
  type ScenarioUiState,
  type ShiftTypeRef,
  type UiDateGroup,
} from "@/lib/scenario";
import type { TransferOption } from "@/components/entity-editor/transfer-list";
import type { DateScopeOption, DateScopeItem } from "@/components/card-editor/date-scope-field";
import {
  syncCoefficientPairs,
  validateCoefficientPairs,
  type CoefficientDomain,
  type CoefficientPair,
} from "@/components/card-editor/coefficient-fields";
import {
  isValidWeightValue,
  isWeightNonPositive,
  type WeightFieldValue,
} from "@/components/card-editor/weight-field";
import { deriveDateGroups, generateDateItems } from "@/lib/dates";

/** Verbatim validation messages (spec 05 "Shift Type Requirements" validation table). */
export const REQUIREMENT_MESSAGES = {
  shiftTypeEmpty: "At least one shift type must be selected",
  shiftTypeMultiple: "Select exactly one shift type or group",
  requiredInvalid: "Required number of people must be a valid number",
  requiredMin: "Required number of people must be at least 0",
  preferredInvalid: "Preferred number of people must be a valid number",
  preferredMin: "Preferred number of people must be at least 1",
  preferredLessThanRequired:
    "Preferred number of people must be greater than required number of people",
  qualifiedEmpty: "At least one person must be selected",
  dateEmpty: "At least one date must be selected",
  weightInvalid: "Weight must be a valid number, Infinity, or -Infinity",
  weightPositive: "Weight must be 0 or less (including -Infinity)",
  // OFF/LEAVE are structurally EXCLUDED from the single-select's options (never
  // merely disabled) — see `buildRequirementShiftTypeOptions` — so this message
  // is defensive documentation, not a reachable per-option tooltip.
  offLeave: "OFF and LEAVE cannot be required shift types",
  // A numeric shift-type entity id has no valid `ShiftTypeRef` (selectors are
  // string-only — see `lib/scenario/types.ts`); mirrors the same structural
  // constraint the Counts/Coverings editors document for their own selectors.
  numericShiftId:
    "A numeric shift type ID cannot be used as a requirement selector; reference it by a string ID instead",
} as const;

/** A number-or-blank draft value: an integer, `""` (blank), or a raw invalid
 *  string kept verbatim (mirrors the shared Target/Weight number-field contract). */
export type RequirementNumberValue = number | string;

/** The flat draft the form edits. `shiftType` holds 0 or 1 refs — the single-select
 *  invariant (FR-PR-21) — but is typed as an array so it slots into the shared
 *  `CoefficientFields`/validation helpers unchanged; a loaded card with >1 refs
 *  (malformed/imported data) is preserved verbatim until the user picks a new
 *  radio option, at which point it collapses to exactly one. */
export interface RequirementFormState {
  description: string;
  shiftType: ShiftTypeRef[];
  shiftTypeCoefficients: CoefficientPair[];
  requiredNumPeople: RequirementNumberValue;
  qualifiedPeople: PersonRef[];
  /** `""` means unset/blank (FR-PR-20 `preferred_num_people=undefined`). */
  preferredNumPeople: RequirementNumberValue;
  date: DateRef[];
  weight: WeightFieldValue;
}

/** A fresh, empty draft (spec 05 FR-PR-20, in-form weight default per the current
 *  prototype default `−50` — distinct from the `-1` FORCED save value when the
 *  weight is inert; see `buildRequirementCard`). */
export function emptyRequirementForm(): RequirementFormState {
  return {
    description: "",
    shiftType: [],
    shiftTypeCoefficients: [],
    requiredNumPeople: 1,
    qualifiedPeople: [],
    preferredNumPeople: "",
    date: [],
    weight: -50,
  };
}

function labelFor(id: PersonRef | ShiftTypeRef, description?: string): string {
  const base = String(id);
  return description ? `${base} — ${description}` : base;
}

// --- People (Qualified) options ---------------------------------------------

const SYNTHETIC_ALL_PEOPLE = { id: RESERVED_SHIFT_TYPE.all, description: "Every person" };

/**
 * Qualified-people options: staff items + people groups PLUS a synthetic `ALL`
 * group (spec 05 FR-PR-26 — the backend treats an omitted `qualifiedPeople` as
 * every person, and the editor lets that be authored explicitly as `[ALL]`).
 */
export function buildQualifiedPeopleTransferOptions(state: ScenarioUiState): {
  items: TransferOption<PersonRef>[];
  groups: TransferOption<PersonRef>[];
} {
  return {
    items: state.staff.map((p) => ({ value: p.id, label: labelFor(p.id, p.description) })),
    groups: [
      ...state.staffGroups.map((g) => ({ value: g.id, label: labelFor(g.id, g.description) })),
      {
        value: SYNTHETIC_ALL_PEOPLE.id,
        label: labelFor(SYNTHETIC_ALL_PEOPLE.id, SYNTHETIC_ALL_PEOPLE.description),
      },
    ],
  };
}

// --- Shift Type single-select options (FR-PR-21, EDGE-PR-07) ---------------

/** One option in the shift-type single-select. `value` may be numeric (an
 *  entity id) so a numeric shift type is still VISIBLE, just disabled — matching
 *  the Counts/Coverings numeric-id treatment. */
export interface ShiftTypeSingleSelectOption {
  value: ShiftTypeRef | number;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * Whether a shift-type group (transitively) reaches a reserved OFF/LEAVE
 * day-state. Members may reference nested group ids, so this walks the group
 * graph with a cycle guard (mirrors the Coverings FR-CV-15 helper).
 */
export function shiftGroupReachesDayState(
  groupId: ShiftTypeRef,
  state: ScenarioUiState,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const key = String(groupId);
  if (seen.has(key)) return false;
  const nextSeen = new Set(seen).add(key);
  const group = state.shiftGroups.find((g) => String(g.id) === key);
  if (!group) return false;
  return group.members.some((member) => {
    if (isDayStateSelector(String(member))) return true;
    if (state.shiftGroups.some((g) => String(g.id) === String(member))) {
      return shiftGroupReachesDayState(member as ShiftTypeRef, state, nextSeen);
    }
    return false;
  });
}

/**
 * Shift-type options for the requirement single-select (FR-PR-21/EDGE-PR-07):
 * authored shift items + groups, with OFF/LEAVE items and any OFF/LEAVE-tainted
 * group EXCLUDED ENTIRELY (never merely disabled — unlike Coverings, which keeps
 * them visible-but-inert). A numeric shift-type entity id remains visible but
 * `disabled` (a covering/count-style structural constraint: selectors are
 * string-only).
 */
export function buildRequirementShiftTypeOptions(state: ScenarioUiState): {
  items: ShiftTypeSingleSelectOption[];
  groups: ShiftTypeSingleSelectOption[];
} {
  const items: ShiftTypeSingleSelectOption[] = state.shifts
    .filter((s) => !isDayStateSelector(String(s.id)))
    .map((s) => {
      const numeric = typeof s.id === "number";
      return {
        value: s.id,
        label: labelFor(s.id, s.description),
        ...(numeric ? { disabled: true, disabledReason: REQUIREMENT_MESSAGES.numericShiftId } : {}),
      };
    });
  const groups: ShiftTypeSingleSelectOption[] = state.shiftGroups
    .filter((g) => !shiftGroupReachesDayState(g.id, state))
    .map((g) => ({ value: g.id, label: labelFor(g.id, g.description) }));
  return { items, groups };
}

/**
 * The coefficient domain for the requirement shift-type selection: authored
 * STRING shift items (a numeric id can never be a coefficient source) that are
 * not a reserved day-state, plus authored groups that do not reach OFF/LEAVE.
 * Structurally excludes OFF/LEAVE/ALL entirely — Requirements has no synthetic
 * keyword rows, unlike Counts (FR-PR-70, EDGE-PR-07).
 */
export function buildRequirementShiftTypeDomain(state: ScenarioUiState): CoefficientDomain {
  const stringItemIds = state.shifts
    .filter((s): s is typeof s & { id: string } => typeof s.id === "string")
    .filter((s) => !isDayStateSelector(s.id))
    .map((s) => s.id);
  return {
    items: stringItemIds.map((id) => ({ id })),
    groups: state.shiftGroups
      .filter((g) => !shiftGroupReachesDayState(g.id, state))
      .map((g) => ({ id: g.id, members: [...g.members] })),
  };
}

/** Replace the shift-type selection with exactly `[value]` (FR-PR-21 — selecting
 *  an option always REPLACES, never toggles/accumulates). */
export function selectShiftType(value: ShiftTypeRef): ShiftTypeRef[] {
  return [value];
}

// --- Date-scope adapters (identical shape to the Counts/Coverings seeds) ---

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

/** Per-field validation errors (empty ⇒ valid). */
export interface RequirementErrors {
  shiftType?: string;
  /** `\n`-joined per-id messages, OR the overlap message when every id is valid. */
  coefficients?: string;
  coefficientErrorsById?: Record<string, string>;
  requiredNumPeople?: string;
  preferredNumPeople?: string;
  qualifiedPeople?: string;
  date?: string;
  weight?: string;
}

/** Whether the weight dial is meaningful for this draft (FR-PR-24): preferred is
 *  defined, non-empty, and (numerically) not equal to required. Mirrors the
 *  historical `diff` calc exactly, including its edge behavior when `required`
 *  itself is blank/invalid (`Number("")` is `0`, `Number("abc")` is `NaN` — either
 *  way a numeric `preferred` reads as "different"). */
export function preferredDiffersFromRequired(
  form: Pick<RequirementFormState, "requiredNumPeople" | "preferredNumPeople">,
): boolean {
  const prefRaw = form.preferredNumPeople;
  if (prefRaw === "" || prefRaw === undefined || prefRaw === null) return false;
  const pref = Number(prefRaw);
  if (Number.isNaN(pref)) return false;
  return pref !== Number(form.requiredNumPeople);
}

/**
 * Validate a draft against spec 05's Shift Type Requirements table. Field order:
 * shift type (empty), coefficients (per-id, then overlap), shift type ("select
 * exactly one" — suppressed while a per-id coefficient error exists), required,
 * preferred, qualified, date, weight (only when preferred differs from required).
 */
export function validateRequirementForm(
  form: RequirementFormState,
  domain: CoefficientDomain,
): RequirementErrors {
  const errors: RequirementErrors = {};

  const coefficientValidation = validateCoefficientPairs(
    form.shiftType,
    form.shiftTypeCoefficients,
    domain,
  );
  const hasPerIdCoefficientErrors = Object.keys(coefficientValidation.errorsById).length > 0;
  if (hasPerIdCoefficientErrors) {
    errors.coefficients = Object.values(coefficientValidation.errorsById).join("\n");
    errors.coefficientErrorsById = coefficientValidation.errorsById;
  } else if (coefficientValidation.overlapError) {
    errors.coefficients = coefficientValidation.overlapError;
  }

  if (form.shiftType.length === 0) {
    errors.shiftType = REQUIREMENT_MESSAGES.shiftTypeEmpty;
  } else if (form.shiftType.length > 1 && !hasPerIdCoefficientErrors) {
    errors.shiftType = REQUIREMENT_MESSAGES.shiftTypeMultiple;
  }

  if (
    form.requiredNumPeople === "" ||
    typeof form.requiredNumPeople !== "number" ||
    !Number.isFinite(form.requiredNumPeople)
  ) {
    errors.requiredNumPeople = REQUIREMENT_MESSAGES.requiredInvalid;
  } else if (form.requiredNumPeople < 0) {
    errors.requiredNumPeople = REQUIREMENT_MESSAGES.requiredMin;
  }

  const prefRaw = form.preferredNumPeople;
  const prefPresent = prefRaw !== "" && prefRaw !== undefined && prefRaw !== null;
  if (prefPresent) {
    if (typeof prefRaw !== "number" || !Number.isFinite(prefRaw)) {
      errors.preferredNumPeople = REQUIREMENT_MESSAGES.preferredInvalid;
    } else if (prefRaw < 1) {
      errors.preferredNumPeople = REQUIREMENT_MESSAGES.preferredMin;
    } else if (
      typeof form.requiredNumPeople === "number" &&
      Number.isFinite(form.requiredNumPeople) &&
      prefRaw < form.requiredNumPeople
    ) {
      errors.preferredNumPeople = REQUIREMENT_MESSAGES.preferredLessThanRequired;
    }
  }

  if (form.qualifiedPeople.length === 0)
    errors.qualifiedPeople = REQUIREMENT_MESSAGES.qualifiedEmpty;
  if (form.date.length === 0) errors.date = REQUIREMENT_MESSAGES.dateEmpty;

  if (preferredDiffersFromRequired(form)) {
    if (!isValidWeightValue(form.weight)) {
      errors.weight = REQUIREMENT_MESSAGES.weightInvalid;
    } else if (!isWeightNonPositive(form.weight)) {
      errors.weight = REQUIREMENT_MESSAGES.weightPositive;
    }
  }

  return errors;
}

/** Flatten a (possibly nested, possibly scalar) shift-type ref tree to a flat
 *  list — defensive for imported data; this UI only ever WRITES a flat `[id]`. */
function flattenShiftTypeRefs(tree: ShiftTypeRef | NestedShiftTypeRefList): ShiftTypeRef[] {
  if (Array.isArray(tree)) return tree.flatMap((node) => flattenShiftTypeRefs(node));
  return [tree];
}

/**
 * Assemble the saved requirement card from a validated draft (spec 05 FR-PR-20..26,
 * EDGE-PR-03). The weight/preferred pair is FORCED when preferred does not differ
 * from required — `preferredNumPeople` omitted and `weight` stamped `-1` — even if
 * the (hidden) weight field held something else. `uid` is injectable for
 * deterministic tests.
 */
export function buildRequirementCard(
  form: RequirementFormState,
  domain: CoefficientDomain,
  uid: string = crypto.randomUUID(),
): RequirementCard {
  const diff = preferredDiffersFromRequired(form);
  const { entries } = validateCoefficientPairs(form.shiftType, form.shiftTypeCoefficients, domain);
  const body: RequirementCardBody = {
    // FR-PR-04: stored as-is (may be empty) — never trimmed/omitted.
    description: form.description,
    shiftType: [...form.shiftType],
    requiredNumPeople: form.requiredNumPeople as number,
    qualifiedPeople: [...form.qualifiedPeople],
    date: [...form.date],
    weight: diff ? (form.weight as number) : -1,
  };
  if (entries.length > 0) body.shiftTypeCoefficients = entries as CoefficientEntry[];
  if (diff) body.preferredNumPeople = form.preferredNumPeople as number;
  return { uid, ...body };
}

/**
 * Load an existing card back into a flat form draft (spec 05 FR-PR-26). A
 * `qualifiedPeople` of `undefined` OR explicit `null` normalizes to `["ALL"]`
 * (the backend treats both as all-people — the C3 null-as-all contract); an
 * omitted/null `date` normalizes the same way. Coefficients are re-synced
 * against the current domain so a stale id from a since-changed group
 * membership is dropped.
 */
export function requirementToForm(
  card: RequirementCard,
  domain: CoefficientDomain,
): RequirementFormState {
  const shiftType = flattenShiftTypeRefs(card.shiftType);
  return {
    description: card.description ?? "",
    shiftType,
    shiftTypeCoefficients: syncCoefficientPairs(
      shiftType,
      (card.shiftTypeCoefficients ?? []) as CoefficientPair[],
      domain,
    ),
    requiredNumPeople: card.requiredNumPeople,
    qualifiedPeople:
      card.qualifiedPeople == null
        ? [RESERVED_SHIFT_TYPE.all]
        : Array.isArray(card.qualifiedPeople)
          ? [...card.qualifiedPeople]
          : [card.qualifiedPeople],
    preferredNumPeople: card.preferredNumPeople ?? "",
    date:
      card.date == null
        ? [RESERVED_SHIFT_TYPE.all]
        : Array.isArray(card.date)
          ? [...card.date]
          : [card.date],
    weight: card.weight,
  };
}

/** Return a copy of `card` with the UI-only `disabled` marker set to `value`
 *  (M1 Enable/Disable — mirrors the Counts/Coverings seed). Stripping the marker
 *  when re-enabling keeps the card body clean; `canonical.ts` skips disabled
 *  requirements regardless, so this is UI-only. */
export function withCardDisabled(card: RequirementCard, value: boolean): RequirementCard {
  if (value) return { ...card, disabled: true };
  const rest: Record<string, unknown> = { ...card };
  delete rest.disabled;
  return rest as unknown as RequirementCard;
}

/** Comma-joined ids for a card summary field (Qualified / Dates / Shift types).
 *  Generic over `unknown` so it also accepts the (possibly nested)
 *  `NestedShiftTypeRefList` shape of `card.shiftType` without a cast at call sites. */
export function summarizeRefs(refs: unknown): string {
  if (Array.isArray(refs)) return refs.map((r) => summarizeRefs(r)).join(", ");
  return String(refs);
}

/**
 * Reorder a uid-keyed list for a drag-drop, honoring the pointer-half `position`
 * (FR-PR-12): `"before"` inserts the dragged card immediately before the hovered
 * card, `"after"` immediately after. Identical to the Counts seed's helper.
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
  if (from < insertAt) insertAt -= 1;
  next.splice(insertAt, 0, moved);
  return next;
}

// --- Coverage warnings (FR-PR-28/40..42) ------------------------------------

export interface CoverageSection {
  count: number;
  message: string;
  items: string[];
}

export interface CoverageWarnings {
  undefinedSection: CoverageSection | null;
  duplicateSection: CoverageSection | null;
}

/** Whether `warnings` has anything to show. */
export function hasCoverageWarnings(warnings: CoverageWarnings): boolean {
  return warnings.undefinedSection !== null || warnings.duplicateSection !== null;
}

const DUPLICATE_EXAMPLE_LIMIT = 5;

interface DerivedGroupLike {
  id: string;
  members: readonly string[];
}

function expandDateRefs(
  refs: readonly DateRef[],
  state: ScenarioUiState,
  allDateIds: readonly string[],
  derivedGroups: readonly DerivedGroupLike[],
): Set<string> {
  const set = new Set<string>();
  const derivedByUpper = new Map(derivedGroups.map((g) => [g.id.toUpperCase(), g.members]));
  const authoredById = new Map(state.dateGroups.map((g) => [String(g.id), g.members.map(String)]));
  for (const ref of refs) {
    const key = String(ref);
    if (key.toUpperCase() === RESERVED_SHIFT_TYPE.all) {
      allDateIds.forEach((d) => set.add(d));
      continue;
    }
    const derived = derivedByUpper.get(key.toUpperCase());
    if (derived) {
      derived.forEach((d) => set.add(d));
      continue;
    }
    const authored = authoredById.get(key);
    if (authored) {
      authored.forEach((d) => set.add(d));
      continue;
    }
    set.add(key);
  }
  return set;
}

function expandShiftTypeRefs(
  refs: readonly ShiftTypeRef[],
  state: ScenarioUiState,
  seen: ReadonlySet<string> = new Set(),
): Set<string> {
  const set = new Set<string>();
  const itemIds = new Set(state.shifts.map((s) => String(s.id)));
  for (const ref of refs) {
    const key = String(ref);
    if (itemIds.has(key)) {
      set.add(key);
      continue;
    }
    if (seen.has(key)) continue;
    const group = state.shiftGroups.find((g) => String(g.id) === key);
    if (group) {
      const nextSeen = new Set(seen).add(key);
      expandShiftTypeRefs(group.members.map(String), state, nextSeen).forEach((id) => set.add(id));
    }
  }
  return set;
}

/** EDGE-PR-14: label a missing-dates set as `ALL` when it's the full range, an
 *  authored/derived group id when it exactly matches that group's expansion,
 *  else the concrete date ids comma-joined in chronological order. */
function labelForDateSet(
  missing: ReadonlySet<string>,
  allDateIds: readonly string[],
  derivedGroups: readonly DerivedGroupLike[],
  dateGroups: readonly UiDateGroup[],
): string {
  if (missing.size === allDateIds.length) return RESERVED_SHIFT_TYPE.all;
  for (const g of derivedGroups) {
    if (g.members.length === missing.size && g.members.every((m) => missing.has(m))) return g.id;
  }
  for (const g of dateGroups) {
    const members = g.members.map(String);
    if (members.length === missing.size && members.every((m) => missing.has(m)))
      return String(g.id);
  }
  const order = new Map(allDateIds.map((id, index) => [id, index]));
  return [...missing].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).join(", ");
}

/**
 * Compute the coverage-warning banner contents (FR-PR-28/40..42): expand every
 * ACTIVE requirement's `date`/`shiftType` selectors to concrete `(date, shiftType)`
 * pairs, then report (a) every worked shift type with at least one uncovered
 * date, and (b) every pair covered by more than one requirement. Returns `null`
 * sections when there is nothing to warn about, or when there is no date range /
 * no worked shift types to check coverage against.
 *
 * A `disabled` requirement is skipped entirely — the canonical projection drops
 * it before the solver sees it, so it cannot cover anything (M2) — while its
 * original 1-based card index is retained so duplicate messages still name the
 * right card numbers. OFF/LEAVE are reserved day states a requirement can never
 * staff, so they are excluded from the coverage domain (M5, FR-PR-40), matching
 * the editor's own selector filter and the canonical projection.
 */
export function computeCoverageWarnings(
  state: ScenarioUiState,
  requirements: readonly RequirementCard[],
): CoverageWarnings {
  const dateItems = generateDateItems({ start: state.rangeStart, end: state.rangeEnd });
  const allDateIds = dateItems.map((d) => d.id);
  // Worked shift types only — OFF/LEAVE are reserved day states a requirement can
  // never staff, so they are excluded from the coverage domain.
  const workedIds = state.shifts.map((s) => String(s.id)).filter((id) => !isDayStateSelector(id));
  if (allDateIds.length === 0 || workedIds.length === 0) {
    return { undefinedSection: null, duplicateSection: null };
  }
  const derivedGroups = deriveDateGroups(dateItems);

  const coveredBy = new Map<string, number[]>();
  // A JSON tuple key survives shift-type ids that contain the display delimiter
  // (a space) — e.g. "Long Day" — which a naive `date + " " + shiftId` would split
  // back into the wrong parts (FR-PR-40).
  const pairKey = (date: string, shiftType: string) => JSON.stringify([date, shiftType]);

  requirements.forEach((req, index) => {
    // A disabled requirement is dropped by the canonical projection, so it cannot
    // cover anything — skip it here while RETAINING the original 1-based card index
    // so duplicate messages still name the right card numbers (M2).
    if (req.disabled) return;
    const dateRefs: DateRef[] =
      req.date == null
        ? [RESERVED_SHIFT_TYPE.all]
        : Array.isArray(req.date)
          ? req.date
          : [req.date];
    const shiftTypeRefs = flattenShiftTypeRefs(req.shiftType);
    const dates = expandDateRefs(dateRefs, state, allDateIds, derivedGroups);
    const shiftTypes = expandShiftTypeRefs(shiftTypeRefs, state);
    for (const date of dates) {
      for (const shiftType of shiftTypes) {
        // Defensive: even an imported requirement that references a reserved day
        // state can't staff it — never count it toward coverage (M5).
        if (isDayStateSelector(shiftType)) continue;
        const key = pairKey(date, shiftType);
        const owners = coveredBy.get(key);
        if (owners) owners.push(index + 1);
        else coveredBy.set(key, [index + 1]);
      }
    }
  });

  const uncovered: { shiftType: string; missing: Set<string> }[] = [];
  let undefinedCount = 0;
  for (const shiftType of workedIds) {
    const missing = new Set<string>();
    for (const date of allDateIds) {
      if (!coveredBy.has(pairKey(date, shiftType))) missing.add(date);
    }
    if (missing.size > 0) {
      uncovered.push({ shiftType, missing });
      undefinedCount += missing.size;
    }
  }
  const undefinedSection: CoverageSection | null =
    uncovered.length === 0
      ? null
      : {
          count: undefinedCount,
          message: `Undefined staffing requirements: ${undefinedCount} date/shift type pairs have no requirement, so the solver may assign an arbitrary number of people.`,
          items: uncovered.map(
            ({ shiftType, missing }) =>
              `${shiftType}: ${labelForDateSet(missing, allDateIds, derivedGroups, state.dateGroups)}`,
          ),
        };

  const duplicateEntries: string[] = [];
  let duplicatePairCount = 0;
  for (const [key, owners] of coveredBy) {
    if (owners.length > 1) {
      duplicatePairCount += 1;
      const [date, shiftType] = JSON.parse(key) as [string, string];
      duplicateEntries.push(`${date} / ${shiftType} (requirements ${owners[0]} and ${owners[1]})`);
    }
  }
  const duplicateSection: CoverageSection | null =
    duplicatePairCount === 0
      ? null
      : {
          count: duplicatePairCount,
          message: `Duplicate staffing requirements: ${duplicatePairCount} date/shift type pairs are covered by more than one requirement. The solver will apply all matching requirements.`,
          items:
            duplicateEntries.length > DUPLICATE_EXAMPLE_LIMIT
              ? [...duplicateEntries.slice(0, DUPLICATE_EXAMPLE_LIMIT), "..."]
              : duplicateEntries,
        };

  return { undefinedSection, duplicateSection };
}
