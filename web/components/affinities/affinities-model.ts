// Shift Affinities editor — pure model (T12 M1 clone, spec 05 FR-PR-60..62).
// All authoring logic that must be *proven* lives here as side-effect-free
// functions so it is testable in the repo's `node` vitest env (no DOM). The React
// components in this dir are thin shells over these helpers. Nothing here touches
// the store; the editor wires each result through `mutateScenario` (T04) as one
// tracked mutation.
//
// The four acceptance-critical facts this module owns:
//   • ALL FOUR selectors are required — People 1, People 2, Shift Types, AND
//     Dates each set their own verbatim empty-selection message (FR-PR-61,
//     unlike Coverings' optional `date`);
//   • the weight defaults to +1 (encourage) — the odd one out among the four
//     card editors, which otherwise default to -1 (EDGE-PR-06/EDGE-PR-15) —
//     and is validity-only (no sign restriction, unlike Counts' squared rule);
//   • OFF/LEAVE/ALL are INCLUDED (not excluded) in the shift-type picker, same
//     as Counts and unlike Requirements/Coverings (EDGE-PR-07);
//   • `people1`/`people2`/`shiftTypes` persist as FLAT lists, v1's shape: core
//     scores each element on its own, so "together" = the same shift on the
//     same day (bead rqfx). `date` is a flat, REQUIRED list (mirrors Counts'
//     `countDates`, not Coverings' optional `date`).

import {
  RESERVED_SHIFT_TYPE,
  type AffinityCard,
  type DateRef,
  type NestedPersonRefList,
  type NestedShiftTypeRefList,
  type PersonRef,
  type ScenarioUiState,
  type ShiftTypeRef,
} from "@/lib/scenario";
import type { TransferOption } from "@/components/entity-editor/transfer-list";
import type { DateScopeOption, DateScopeItem } from "@/components/card-editor/date-scope-field";
import { isValidWeightValue, type WeightFieldValue } from "@/components/card-editor/weight-value";
import { deriveDateGroups, generateDateItems } from "@/lib/dates";

/** Verbatim validation messages (spec 05 "Shift Affinities" validation table). */
export const AFFINITY_MESSAGES = {
  people1: "At least one person must be selected for People 1",
  people2: "At least one person must be selected for People 2",
  shiftTypes: "At least one shift type must be selected",
  date: "At least one date must be selected",
  weightInvalid:
    "Weight must be a whole number from -1t to 1t (1,000,000,000,000), Infinity, or -Infinity",
  // A numeric shift-type entity id has no valid `ShiftTypeRef` (selectors are
  // string-only — see `lib/scenario/types.ts`); the Python shift map keys the raw
  // numeric id, so a stringified "7" would not resolve it. Mirrors the same
  // structural constraint the Counts/Coverings editors document for their own
  // selectors.
  numericShiftId:
    "A numeric shift type ID cannot be used as an affinity selector; reference it by a string ID instead",
} as const;

/** The flat draft the form edits. */
export interface AffinityFormState {
  description: string;
  people1: PersonRef[];
  people2: PersonRef[];
  shiftTypes: ShiftTypeRef[];
  date: DateRef[];
  weight: WeightFieldValue;
}

/** A fresh, empty affinity draft (spec 05 FR-PR-60). Note `weight` defaults to
 *  `+1` (encourage) — the other three card editors default to `-1`
 *  (EDGE-PR-06/EDGE-PR-15). */
export function emptyAffinityForm(): AffinityFormState {
  return { description: "", people1: [], people2: [], shiftTypes: [], date: [], weight: 1 };
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

/**
 * The scenario fields the Affinities screen reads: the people and shift-type
 * domains its selectors offer, and the dates it scopes them by. A `Pick` rather
 * than the whole `ScenarioUiState` because it is ALSO the shape of the screen's
 * store subscription (`useAffinities`) and of its form's `state` prop: narrowing
 * all three to the SAME set is what keeps an edit to any OTHER slice (a shift's
 * working time, the scenario name) from re-rendering — and reprojecting — this
 * screen.
 */
export type AffinitiesScenarioInput = Pick<
  ScenarioUiState,
  "staff" | "staffGroups" | "shifts" | "shiftGroups" | "rangeStart" | "rangeEnd" | "dateGroups"
>;

/** People options: staff items + people groups (spec 05 FR-PR-61) — unrestricted,
 *  shared by both People 1 and People 2. */
export function buildPeopleTransferOptions(state: Pick<ScenarioUiState, "staff" | "staffGroups">): {
  items: TransferOption<PersonRef>[];
  groups: TransferOption<PersonRef>[];
} {
  return {
    items: state.staff.map((p) => ({ value: p.id, label: labelFor(p.id, p.description) })),
    groups: state.staffGroups.map((g) => ({ value: g.id, label: labelFor(g.id, g.description) })),
  };
}

/** An affinity shift-type transfer option's value: `ShiftTypeRef` for every
 *  SELECTABLE option; a numeric entity id is represented too (so it is visible,
 *  not hidden) but always carries `disabled: true` since it can never resolve as
 *  a selector. */
export type AffinityShiftTypeOptionValue = ShiftTypeRef | number;

const SYNTHETIC_SHIFT_ITEMS: readonly { id: ShiftTypeRef; description: string }[] = [
  { id: RESERVED_SHIFT_TYPE.off, description: "Day off (reserved)" },
  { id: RESERVED_SHIFT_TYPE.leave, description: "Leave (reserved)" },
];
const SYNTHETIC_SHIFT_GROUP = { id: RESERVED_SHIFT_TYPE.all, description: "Every shift type" };

/**
 * Shift-type options for Shift Types (spec 05 FR-PR-61, EDGE-PR-07): authored
 * shift items + groups PLUS the synthetic OFF/LEAVE items and ALL group — all
 * enabled (Affinities, like Counts and Successions, does NOT exclude OFF/LEAVE).
 * A numeric shift-type entity id is disabled with an actionable reason
 * (structural — see `AFFINITY_MESSAGES.numericShiftId`).
 */
export function buildAffinityShiftTypeTransferOptions(
  state: Pick<ScenarioUiState, "shifts" | "shiftGroups">,
): {
  items: TransferOption<AffinityShiftTypeOptionValue>[];
  groups: TransferOption<AffinityShiftTypeOptionValue>[];
} {
  const authoredItems: TransferOption<AffinityShiftTypeOptionValue>[] = state.shifts.map((s) => {
    const numeric = typeof s.id === "number";
    return {
      value: s.id,
      label: labelFor(s.id, s.description),
      ...(numeric ? { disabled: true, disabledReason: AFFINITY_MESSAGES.numericShiftId } : {}),
    };
  });
  const syntheticItems: TransferOption<AffinityShiftTypeOptionValue>[] = SYNTHETIC_SHIFT_ITEMS.map(
    (s) => ({
      value: s.id,
      label: labelFor(s.id, s.description),
    }),
  );
  const authoredGroups: TransferOption<AffinityShiftTypeOptionValue>[] = state.shiftGroups.map(
    (g) => ({
      value: g.id,
      label: labelFor(g.id, g.description),
    }),
  );
  const allGroup: TransferOption<AffinityShiftTypeOptionValue> = {
    value: SYNTHETIC_SHIFT_GROUP.id,
    label: labelFor(SYNTHETIC_SHIFT_GROUP.id, SYNTHETIC_SHIFT_GROUP.description),
  };
  return { items: [...authoredItems, ...syntheticItems], groups: [...authoredGroups, allGroup] };
}

/** The auto-derived date-scope chips (ALL / WEEKDAY / WEEKEND / day-of-week). */
export function buildDateScopeAutoScopes(
  state: Pick<ScenarioUiState, "rangeStart" | "rangeEnd">,
): DateScopeOption[] {
  const items = generateDateItems({ start: state.rangeStart, end: state.rangeEnd });
  return deriveDateGroups(items)
    .filter((g) => g.members.length > 0)
    .map((g) => ({ id: g.id, label: g.description ?? g.id }));
}

/** Authored date groups as date-scope chips. */
export function buildDateScopeDateGroups(
  state: Pick<ScenarioUiState, "dateGroups">,
): DateScopeOption[] {
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
export function buildDateScopeDateItems(
  state: Pick<ScenarioUiState, "rangeStart" | "rangeEnd">,
): DateScopeItem[] {
  return expandDateRange(state.rangeStart, state.rangeEnd).map((iso) => ({
    id: iso,
    dayOfMonth: Number(iso.slice(8)),
  }));
}

// --- Validation, build, and load --------------------------------------------

/** Per-field validation errors (empty ⇒ valid). */
export interface AffinityErrors {
  people1?: string;
  people2?: string;
  shiftTypes?: string;
  date?: string;
  weight?: string;
}

/**
 * Validate an affinity draft (spec 05 "Shift Affinities" validation table). All
 * four multi-selects are required — unlike Coverings, whose `date` is optional.
 * Weight validity is the only weight rule (no squared-expression sign
 * restriction — Affinities has no expression/target).
 */
export function validateAffinityForm(form: AffinityFormState): AffinityErrors {
  const errors: AffinityErrors = {};
  if (form.people1.length === 0) errors.people1 = AFFINITY_MESSAGES.people1;
  if (form.people2.length === 0) errors.people2 = AFFINITY_MESSAGES.people2;
  if (form.shiftTypes.length === 0) errors.shiftTypes = AFFINITY_MESSAGES.shiftTypes;
  if (form.date.length === 0) errors.date = AFFINITY_MESSAGES.date;
  if (!isValidWeightValue(form.weight)) errors.weight = AFFINITY_MESSAGES.weightInvalid;
  return errors;
}

/**
 * Assemble the saved affinity card from a validated draft (spec 05 FR-PR-60/61).
 * `people1`/`people2`/`shiftTypes`/`date` are all FLAT lists. `description` is stored
 * exactly as authored, never trimmed nor omitted when empty (FR-PR-04 — shared
 * with Requirements/Successions/Counts). `uid` is injectable for deterministic
 * tests.
 */
export function buildAffinityCard(
  form: AffinityFormState,
  uid: string = crypto.randomUUID(),
): AffinityCard {
  return {
    uid,
    description: form.description,
    date: [...form.date] as DateRef[],
    // Flat lists, as v1 saves them: core makes one group per element, so each
    // person and each shift is scored on its own and "together" means the
    // same shift on the same day (bead rqfx).
    people1: [...form.people1] as NestedPersonRefList,
    people2: [...form.people2] as NestedPersonRefList,
    shiftTypes: [...form.shiftTypes] as NestedShiftTypeRefList,
    weight: form.weight as number,
  };
}

/**
 * Whether one selector means "each element on its own" (v1's shape), which the
 * flat form round-trips: every top-level element is a scalar ref or a
 * one-member group (`["A"]` scores exactly like `"A"` in core). A group of two
 * or more (`["A", "B"]`) is ONE OR-term — "any of A/B" — which flattening would
 * split into separate terms, changing what the solver scores.
 */
function isPerElementSelector(selector: unknown): boolean {
  return (
    Array.isArray(selector) && selector.every((term) => !Array.isArray(term) || term.length === 1)
  );
}

/**
 * Whether `card` is an "advanced" (grouped) affinity the flat form cannot author
 * without changing its meaning. Core makes one term per top-level selector
 * element (`_compile_nested_groups`). A card holding a multi-member group —
 * e.g. the pre-rqfx v2 form's `people1: [["A", "B"]]` ("any of A/B, on any of
 * these shifts, scored once a day") — would become per-person/per-shift terms
 * if flattened+rebuilt. It is NOT migrated: it renders read-only with an honest
 * description and is preserved byte-for-byte. `date` is excluded — it is a flat
 * list the form fully represents.
 */
export function isAdvancedAffinityCard(card: AffinityCard): boolean {
  return !(
    isPerElementSelector(card.people1) &&
    isPerElementSelector(card.people2) &&
    isPerElementSelector(card.shiftTypes)
  );
}

/** The v1 meaning the flat form authors (each person, each shift on its own). */
export const AFFINITY_SAME_SHIFT = "on the same shift on the same day";

/** v1: ALL or a shift group is one term, so any of its shifts that day counts. */
export const AFFINITY_ANY_SHIFT =
  "on the same day, where ALL or a shift group counts as one shift, so different shifts in it still count as together";

/** v1: ALL or a staff group is one term, so any one member counts for it. */
export const AFFINITY_ANY_MEMBER =
  "ALL or a staff group counts as one person, so any one of its members counts";

/** The groups a flat card may name; absent = none known (only ALL is recognised). */
export type AffinityGroups = Partial<Pick<ScenarioUiState, "staffGroups" | "shiftGroups">>;

/**
 * What "together" means for `card`, as core scores it (bug hunt B2): one term per
 * selector element, so a concrete shift means the same shift, but ALL or a shift group
 * means any of its shifts that day, and ALL or a staff group means any of its members.
 */
export function affinityTogetherMeaning(card: AffinityCard, groups: AffinityGroups = {}): string {
  if (isAdvancedAffinityCard(card)) return AFFINITY_GROUPED_MEANING;
  const isOneTerm = (list: readonly { id: unknown }[] = []) => {
    const ids = new Set(list.map((group) => String(group.id)));
    return (ref: unknown) =>
      String(ref).toUpperCase() === RESERVED_SHIFT_TYPE.all || ids.has(String(ref));
  };
  const anyShift = flattenRefs(card.shiftTypes).some(isOneTerm(groups.shiftGroups));
  const anyMember = [...flattenRefs(card.people1), ...flattenRefs(card.people2)].some(
    isOneTerm(groups.staffGroups),
  );
  const shift = anyShift ? AFFINITY_ANY_SHIFT : AFFINITY_SAME_SHIFT;
  return anyMember ? `${shift}; ${AFFINITY_ANY_MEMBER}` : shift;
}

/** What a grouped (pre-rqfx v2) card actually scores, stated honestly. */
export const AFFINITY_GROUPED_MEANING =
  "Grouped rule: anyone from each group on any of these shifts on the same day counts, even on different shifts, scored once a day. Edit via Save & Load (YAML).";

/** Whether `card` can be opened in the flat form — i.e. not a grouped (advanced)
 *  affinity. Callers must guard {@link affinityToForm} with this so a grouped
 *  card never reaches Edit. */
export function isEditableAffinityCard(card: AffinityCard): boolean {
  return !isAdvancedAffinityCard(card);
}

/**
 * Flatten a nested reference tree to a flat ref list (mirrors Coverings'
 * `flattenRefs` — spec 05/11 EDGE-CV-01-style load). Generic over the element
 * kind so a string-only tree (e.g. `shiftTypes`) yields `ShiftTypeRef[]` rather
 * than the broad union; also handles the FLAT `date` field (a scalar or array
 * with no nested elements simply flattens to itself).
 */
export function flattenRefs<T = PersonRef | ShiftTypeRef | DateRef>(tree: unknown): T[] {
  if (Array.isArray(tree)) return tree.flatMap((node) => flattenRefs<T>(node));
  return [tree as T];
}

/** Load an existing card back into a flat form draft (spec 05 FR-PR-08/62). */
export function affinityToForm(card: AffinityCard): AffinityFormState {
  return {
    description: card.description ?? "",
    people1: flattenRefs<PersonRef>(card.people1),
    people2: flattenRefs<PersonRef>(card.people2),
    shiftTypes: flattenRefs<ShiftTypeRef>(card.shiftTypes),
    date: flattenRefs<DateRef>(card.date),
    weight: card.weight,
  };
}

/** Comma-joined flattened ids for a card summary field (FR-PR-62). */
export function summarizeRefs(tree: unknown): string {
  return flattenRefs(tree).map(String).join(", ");
}

/**
 * Reorder a uid-keyed list for a drag-drop, honoring the pointer-half `position`
 * (FR-PR-12): `"before"` inserts the dragged card immediately before the hovered
 * card, `"after"` immediately after — computed against the ORIGINAL indices, then
 * corrected for the gap left by removing the dragged card. Pure + generic so the
 * insertion math is unit-testable without the store.
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
 *  (Enable/Disable). Stripping the marker when re-enabling keeps the card body
 *  clean; `canonical.ts` skips disabled cards regardless, so this is UI-only. */
export function withCardDisabled(card: AffinityCard, value: boolean): AffinityCard {
  if (value) return { ...card, disabled: true };
  const { disabled: _omit, ...rest } = card;
  return rest;
}
