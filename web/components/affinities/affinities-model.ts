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
//   • `people1`/`people2`/`shiftTypes` persist as the same one-element nested
//     shape as Coverings' `preceptors`/`preceptees`/`shiftTypes`
//     (`NestedPersonRefList`/`NestedShiftTypeRefList` — canonical.ts:161-173),
//     while `date` is a flat, REQUIRED list (mirrors Counts' `countDates`, not
//     Coverings' optional `date`).

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
import { isValidWeightValue, type WeightFieldValue } from "@/components/card-editor/weight-field";
import { deriveDateGroups, generateDateItems } from "@/lib/dates";

/** Verbatim validation messages (spec 05 "Shift Affinities" validation table). */
export const AFFINITY_MESSAGES = {
  people1: "At least one person must be selected for People 1",
  people2: "At least one person must be selected for People 2",
  shiftTypes: "At least one shift type must be selected",
  date: "At least one date must be selected",
  weightInvalid: "Weight must be a valid number, Infinity, or -Infinity",
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

/** People options: staff items + people groups (spec 05 FR-PR-61) — unrestricted,
 *  shared by both People 1 and People 2. */
export function buildPeopleTransferOptions(state: ScenarioUiState): {
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
export function buildAffinityShiftTypeTransferOptions(state: ScenarioUiState): {
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
 * `people1`/`people2`/`shiftTypes` are each wrapped in a one-element outer array
 * (the same nested shape Coverings' `preceptors`/`preceptees`/`shiftTypes` use —
 * canonical.ts:161-173); `date` stays a FLAT list (never nested — Affinities'
 * `date` is required, unlike Coverings' optional one). `description` is stored
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
    people1: [form.people1] as NestedPersonRefList,
    people2: [form.people2] as NestedPersonRefList,
    shiftTypes: [form.shiftTypes] as NestedShiftTypeRefList,
    weight: form.weight as number,
  };
}

/**
 * Whether one selector is the single-term shape the flat form authors and can
 * losslessly round-trip: exactly ONE top-level element (a scalar ref or a flat
 * OR-group). `buildAffinityCard` always emits `[flat]` (outer length 1), and
 * `affinityToForm` flattens that single term back to a flat list — so any outer
 * array of length 1 round-trips. An outer length !== 1 (or a non-array) carries
 * MULTIPLE distinct affinity terms the single-term form cannot represent.
 */
function isSingleTermSelector(selector: unknown): boolean {
  return Array.isArray(selector) && selector.length === 1;
}

/**
 * Whether `card` is an "advanced" affinity the flat form cannot author without
 * loss (the affinity analogue of Counts' FR-PR-55a generic-array fallback). A
 * C3 affinity selector (`people1`/`people2`/`shiftTypes`) is
 * `Array<ref | ref[]>`: each top-level element is a SEPARATE constraint term.
 * The form only ever authors ONE term (`[flat]`); a card with two or more terms
 * — e.g. `people1: [["A"], ["B"]]` — would collapse to a single OR-aggregate
 * (`[["A", "B"]]`) if flattened+rebuilt, silently relaxing the constraint. Such
 * a card is therefore recognized as advanced so the editor renders it read-only
 * and preserves it byte-for-byte (never routed through `flattenRefs`/
 * `buildAffinityCard`). `date` is excluded from this check — it is a flat list
 * the form fully represents.
 */
export function isAdvancedAffinityCard(card: AffinityCard): boolean {
  return !(
    isSingleTermSelector(card.people1) &&
    isSingleTermSelector(card.people2) &&
    isSingleTermSelector(card.shiftTypes)
  );
}

/** Whether `card` can be opened in the single-term flat form — i.e. not an
 *  advanced multi-term affinity (FR-PR-55a-style fallback). Callers must guard
 *  {@link affinityToForm} with this so a multi-term card never reaches Edit. */
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
