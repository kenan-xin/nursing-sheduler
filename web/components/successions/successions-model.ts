// Shift Successions editor — pure model (T12 M1 clone, spec 05 FR-PR-30..34, C3
// CON-SEM weight semantics). All authoring logic that must be *proven* lives here
// as side-effect-free functions so it is testable in the repo's `node` vitest env
// (no DOM). The React components in this dir are thin shells over these helpers.
// Nothing here touches the store; the editor wires each result through
// `mutateScenario` (T04) as one tracked mutation.
//
// Ground truth for the exact validation order/messages and defaults is the
// historical `shift-type-successions/page.tsx` (spec 05's authoring source); this
// module mirrors that behavior 1:1 onto the ScreenCards shell + shared card-editor
// controls. `pattern` (an ORDERED, duplicate-allowing shift-type sequence) is the
// one field with no shared control — its append/move/remove helpers live in the
// sibling `pattern-builder.tsx` (a new, editor-local control per the ticket).

import {
  RESERVED_SHIFT_TYPE,
  type DateRef,
  type PersonRef,
  type ScenarioUiState,
  type ShiftTypeRef,
  type SuccessionCard,
} from "@/lib/scenario";
import type { TransferOption } from "@/components/entity-editor/transfer-list";
import type { DateScopeOption, DateScopeItem } from "@/components/card-editor/date-scope-field";
import { isValidWeightValue, type WeightFieldValue } from "@/components/card-editor/weight-field";
import { deriveDateGroups, generateDateItems } from "@/lib/dates";

/** Verbatim validation messages (spec 05 "Shift Type Successions" validation table). */
export const SUCCESSION_MESSAGES = {
  person: "At least one person must be selected",
  pattern: "At least 2 shift types must be selected for a succession pattern",
  date: "At least one date must be selected",
  weightInvalid: "Weight must be a valid number, Infinity, or -Infinity",
  // A numeric shift-type ENTITY id has no valid `ShiftTypeRef` (pattern positions
  // are string-only — see `lib/scenario/types.ts`); the Python shift map keys the
  // raw numeric id, so a stringified "7" would not resolve it. Mirrors the same
  // structural constraint Counts/Coverings document for their own selectors.
  numericShiftId:
    "A numeric shift type ID cannot be used as a pattern entry; reference it by a string ID instead",
} as const;

/** The flat draft the form edits. */
export interface SuccessionFormState {
  description: string;
  person: PersonRef[];
  pattern: ShiftTypeRef[];
  date: DateRef[];
  weight: WeightFieldValue;
}

/** A fresh, empty draft (spec 05 FR-PR-30). */
export function emptySuccessionForm(): SuccessionFormState {
  return { description: "", person: [], pattern: [], date: [], weight: -1 };
}

// --- Selection helpers (exact Object.is identity, per T09 sameEntityId) ----

/** Whether `ref` is already in `selection` — EXACT identity, so a numeric and a
 *  same-spelling string ref never collapse (T09 `sameEntityId` parity). */
export function isInSelection<T>(selection: readonly T[], ref: T): boolean {
  return selection.some((r) => Object.is(r, ref));
}

/** Toggle `ref` in `selection`, returning a NEW array (order-preserving). Used by
 *  the People multi-select — NOT by Pattern, which appends/duplicates freely via
 *  `pattern-builder.tsx`. */
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

/** People options: staff items + people groups (spec 05 FR-PR-31) — unrestricted. */
export function buildPeopleTransferOptions(state: ScenarioUiState): {
  items: TransferOption<PersonRef>[];
  groups: TransferOption<PersonRef>[];
} {
  return {
    items: state.staff.map((p) => ({ value: p.id, label: labelFor(p.id, p.description) })),
    groups: state.staffGroups.map((g) => ({ value: g.id, label: labelFor(g.id, g.description) })),
  };
}

/** A pattern source option's value: `ShiftTypeRef` for every SELECTABLE entry; a
 *  numeric entity id is represented too (visible, not hidden) but always carries
 *  `disabled: true` since it can never resolve as a pattern position. */
export type PatternShiftTypeOptionValue = ShiftTypeRef | number;

const SYNTHETIC_SHIFT_ITEMS: readonly { id: ShiftTypeRef; description: string }[] = [
  { id: RESERVED_SHIFT_TYPE.off, description: "Day off (reserved)" },
  { id: RESERVED_SHIFT_TYPE.leave, description: "Leave (reserved)" },
];
const SYNTHETIC_SHIFT_GROUP = { id: RESERVED_SHIFT_TYPE.all, description: "Every shift type" };

/**
 * Pattern-builder shift-type sources (spec 05 FR-PR-32, EDGE-PR-08): authored
 * shift items + groups PLUS the synthetic OFF/LEAVE items and ALL group — every
 * entry is a clickable, append-only button (Successions does NOT exclude OFF/
 * LEAVE, unlike Requirements/Coverings). A numeric shift-type entity id is
 * disabled with an actionable reason (structural — see `SUCCESSION_MESSAGES.numericShiftId`).
 */
export function buildPatternShiftTypeOptions(state: ScenarioUiState): {
  items: TransferOption<PatternShiftTypeOptionValue>[];
  groups: TransferOption<PatternShiftTypeOptionValue>[];
} {
  const authoredItems: TransferOption<PatternShiftTypeOptionValue>[] = state.shifts.map((s) => {
    const numeric = typeof s.id === "number";
    return {
      value: s.id,
      label: labelFor(s.id, s.description),
      ...(numeric ? { disabled: true, disabledReason: SUCCESSION_MESSAGES.numericShiftId } : {}),
    };
  });
  const syntheticItems: TransferOption<PatternShiftTypeOptionValue>[] = SYNTHETIC_SHIFT_ITEMS.map(
    (s) => ({
      value: s.id,
      label: labelFor(s.id, s.description),
    }),
  );
  const authoredGroups: TransferOption<PatternShiftTypeOptionValue>[] = state.shiftGroups.map(
    (g) => ({
      value: g.id,
      label: labelFor(g.id, g.description),
    }),
  );
  const allGroup: TransferOption<PatternShiftTypeOptionValue> = {
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
export interface SuccessionErrors {
  person?: string;
  pattern?: string;
  date?: string;
  weight?: string;
}

/**
 * Validate a succession draft (spec 05 "Shift Type Successions" validation
 * table). Field order mirrors the historical `validateForm`: person, pattern,
 * date, weight.
 */
export function validateSuccessionForm(form: SuccessionFormState): SuccessionErrors {
  const errors: SuccessionErrors = {};
  if (form.person.length === 0) errors.person = SUCCESSION_MESSAGES.person;
  if (form.pattern.length < 2) errors.pattern = SUCCESSION_MESSAGES.pattern;
  if (form.date.length === 0) errors.date = SUCCESSION_MESSAGES.date;
  if (!isValidWeightValue(form.weight)) errors.weight = SUCCESSION_MESSAGES.weightInvalid;
  return errors;
}

/**
 * Assemble the saved succession card from a validated draft (spec 05
 * FR-PR-30..34). `uid` is injectable for deterministic tests. The description is
 * stored exactly as authored — it may be empty and is never trimmed (FR-PR-04,
 * mirroring the Counts seed).
 */
export function buildSuccessionCard(
  form: SuccessionFormState,
  uid: string = crypto.randomUUID(),
): SuccessionCard {
  return {
    uid,
    description: form.description,
    person: [...form.person],
    pattern: [...form.pattern],
    date: [...form.date],
    weight: form.weight as number,
  };
}

/**
 * Flatten a pattern position tree to a flat `ShiftTypeRef` sequence. This
 * editor's own `buildSuccessionCard` never authors a nested position (every
 * click appends a single id — FR-PR-32), and an ADVANCED card whose `pattern`
 * carries a nested-aggregate position never reaches this path (it is read-only —
 * see {@link isAdvancedSuccessionCard}). Flattening here (rather than throwing)
 * mirrors the coverings seed's `flattenRefs` — but for the editable, all-scalar
 * pattern this editor authors it is effectively a shallow copy, so no scalar
 * pattern is ever misread as a longer sequence.
 */
export function flattenPattern(pattern: unknown): ShiftTypeRef[] {
  if (Array.isArray(pattern)) return pattern.flatMap((node) => flattenPattern(node));
  return [pattern as ShiftTypeRef];
}

/**
 * Whether `card` carries an ADVANCED pattern (spec 05 C3 — a nested-aggregate
 * position). A backend pattern is `NestedShiftTypeRefList` — each position is a
 * single shift-type ref OR a nested aggregate (an inner array of terms, e.g.
 * `[["N", "AM"], "PM"]` meaning "an N-or-AM day, then a PM day"). The sequential
 * PatternBuilder can only author a flat sequence of single positions, so a card
 * with any nested-aggregate position CANNOT be represented in the form without
 * corrupting its semantics (flattening `["N","AM"]` into two sequential days).
 * Such a card is rendered READ-ONLY and never routed through `flattenPattern` /
 * `buildSuccessionCard`, preserved byte-for-byte through
 * duplicate/reorder/disable/save — the exact lossless-fallback contract the
 * Counts seed uses for its generic-array counts (FR-PR-55a).
 */
export function isAdvancedSuccessionCard(card: SuccessionCard): boolean {
  return Array.isArray(card.pattern) && card.pattern.some((position) => Array.isArray(position));
}

/** Whether `card` can be opened in this sequential form — i.e. every pattern
 *  position is a single shift-type ref (not a nested aggregate). Callers must
 *  guard `openEdit` with this so an advanced card never reaches `flattenPattern`. */
export function isEditableSuccessionCard(card: SuccessionCard): boolean {
  return !isAdvancedSuccessionCard(card);
}

/**
 * Render each pattern position for a card summary (FR-PR-34), faithful to the
 * stored shape: a scalar position renders as its id; a nested-aggregate position
 * renders its terms joined by ` + ` (an OR-group of shift types for that day).
 * The editor's own cards are all scalar; this keeps an ADVANCED card's aggregate
 * visible instead of silently flattening it into extra `→` steps.
 */
export function patternPositionsForDisplay(pattern: unknown): string[] {
  const positions = Array.isArray(pattern) ? pattern : [pattern];
  return positions.map((position) =>
    Array.isArray(position) ? position.map(String).join(" + ") : String(position),
  );
}

/** Load an editable card back into a flat form draft (mirrors the historical
 *  `handleStartEdit`). Callers must guard with {@link isEditableSuccessionCard}
 *  first — an advanced (nested-aggregate) pattern must never reach this path, or
 *  `flattenPattern` would collapse its aggregate positions into extra sequential
 *  days. `flattenPattern` stays total (never throws) so this is defensive, not a
 *  reachable UI path for an advanced card. */
export function successionToForm(card: SuccessionCard): SuccessionFormState {
  return {
    description: card.description ?? "",
    person: Array.isArray(card.person) ? [...card.person] : [card.person],
    pattern: flattenPattern(card.pattern),
    date: card.date === undefined ? [] : Array.isArray(card.date) ? [...card.date] : [card.date],
    weight: card.weight,
  };
}

/** Comma-joined ids for a card summary field (People / Dates). */
export function summarizeRefs(refs: PersonRef | DateRef | (PersonRef | DateRef)[]): string {
  const list = Array.isArray(refs) ? refs : [refs];
  return list.map(String).join(", ");
}

/**
 * Reorder a uid-keyed list for a drag-drop, honoring the pointer-half `position`
 * (FR-PR-12): `"before"` inserts the dragged card immediately before the hovered
 * card, `"after"` immediately after — computed against the ORIGINAL indices, then
 * corrected for the gap left by removing the dragged card. Pure + generic so the
 * insertion math is unit-testable without the store (mirrors `counts-model.ts`).
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
 *  (canonical.ts skips disabled cards regardless, so this is UI-only). */
export function withCardDisabled(card: SuccessionCard, value: boolean): SuccessionCard {
  if (value) return { ...card, disabled: true };
  const { disabled: _omit, ...rest } = card;
  return rest;
}
