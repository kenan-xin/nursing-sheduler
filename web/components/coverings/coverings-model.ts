// Coverings editor — pure model (T13, spec 11).
//
// All authoring logic that must be *proven* lives here as side-effect-free
// functions so it is testable in the repo's `node` vitest env (no DOM). The React
// components in this dir are thin shells over these helpers. Nothing here touches
// the store; the editor wires each result through `mutateScenario` (T04) as one
// tracked mutation.
//
// The four acceptance-critical rules this module owns:
//   • the weight is INERT — a covering is always enforced, so the editor never
//     exposes an editable weight; `buildCoveringCard` stamps `COVERING_WEIGHT`
//     and the solver never reads it (spec 11 EDGE-CV-04, CON-SEM-07);
//   • OFF/LEAVE are rejected in the shift-type selector — both as individual
//     items and as any group that (transitively) contains one (spec 11 FR-CV-15,
//     backend E26b);
//   • an empty date selection serializes as an OMITTED `date` (= all dates), never
//     `date: []` (a no-op) — so `buildCoveringCard` leaves `date` unset when empty
//     and the T05 boundary drops it (spec 11 FR-CV-12, DL08);
//   • the canonical single-equation save shape wraps each flat person/shift-type
//     selection in a one-element outer array (spec 11 EDGE-CV-01).

import {
  isDayStateSelector,
  type CoveringCard,
  type DateRef,
  type NestedPersonRefList,
  type PersonRef,
  type ScenarioUiState,
  type ShiftTypeRef,
} from "@/lib/scenario";
import type { TransferOption } from "@/components/entity-editor/transfer-list";
import type { DateScopeOption, DateScopeItem } from "@/components/card-editor/date-scope-field";
import { deriveDateGroups, generateDateItems } from "@/lib/dates";

/**
 * The single, non-editable weight every covering card serializes with. A covering
 * is a hard OR reification the backend applies regardless of weight (spec 11
 * EDGE-CV-04), so the editor hides the weight field and stamps this constant. `1`
 * matches the prototype's `DEFAULT_WEIGHT` (spec 11 FR-CV-06) and is always
 * producer-valid (a finite integer).
 */
export const COVERING_WEIGHT = 1;

/** A person / shift-type / date reference as authored (the backend `int | str`). */
export type CoveringRef = PersonRef | ShiftTypeRef | DateRef;

/** The three multi-select domains that reject nothing plus the shift-type one. */
export type CoveringSelectField = "preceptors" | "preceptees" | "shiftTypes" | "dates";

/** Verbatim validation messages (spec 11 "Validation Rules & Messages"). */
export const COVERING_MESSAGES = {
  preceptors: "At least one preceptor must be selected",
  preceptees: "At least one preceptee must be selected",
  shiftTypes: "At least one shift type must be selected",
  // Backend E26b, surfaced in the UI as a hard reject (spec 11 FR-CV-15).
  offLeave:
    "OFF and LEAVE are not allowed in shift type covering preferences; covering applies to worked shifts only",
  // A numeric shift-type entity id is a valid `ShiftTypeId`, but a covering
  // selector is string-only (`ShiftTypeRef`); the Python shift map keys the raw
  // numeric id, so `String(7)` would not resolve. The entity is therefore
  // unselectable here, not silently stringified.
  numericShiftId:
    "A numeric shift type ID cannot be used as a covering selector; reference it by a string ID instead",
} as const;

/** The flat draft the form edits. Note: NO weight — a covering is always enforced. */
export interface CoveringFormState {
  description: string;
  preceptors: CoveringRef[];
  preceptees: CoveringRef[];
  /** String-only selectors — a `ShiftTypeRef` is never numeric (the editor
   *  disables numeric shift-type ids so they cannot be authored here). */
  shiftTypes: ShiftTypeRef[];
  /** Optional; an empty selection means "all dates" (serialized as omitted). */
  dates: CoveringRef[];
}

/** A selectable option in a multi-select (an entity item or a named group). */
export interface CoveringOption {
  /** The authored ref stored in the card (kept as `int | str`). */
  ref: CoveringRef;
  label: string;
  /** True when the option cannot be selected (an OFF/LEAVE-tainted shift group). */
  disabled?: boolean;
  disabledReason?: string;
}

/** Items + groups split, so a selector can render the two sections separately. */
export interface CoveringOptionGroups {
  items: CoveringOption[];
  groups: CoveringOption[];
}

/** A fresh, empty form draft (spec 11 FR-CV-06 — all fields empty). */
export function emptyCoveringForm(): CoveringFormState {
  return { description: "", preceptors: [], preceptees: [], shiftTypes: [], dates: [] };
}

/** Stable string presentation key for a ref (React keys / labels). NOTE: a
 *  numeric id and a same-spelling string id are DISTINCT authorable refs (a
 *  numeric person `1` beside a people-group named `"1"`), so this is a DISPLAY
 *  key only — NEVER a logical-membership key. Membership uses exact `Object.is`
 *  identity (`isSelected`/`toggleRef`), mirroring T09's `sameEntityId` authority. */
export function refValue(ref: CoveringRef): string {
  return String(ref);
}

function labelFor(id: CoveringRef, description?: string): string {
  const base = String(id);
  return description ? `${base} — ${description}` : base;
}

/** Whether `ref` is already in `selection` — EXACT typed identity (`Object.is`),
 *  so numeric `1` and string `"1"` are distinct members (T09 `sameEntityId`). */
export function isSelected(selection: readonly CoveringRef[], ref: CoveringRef): boolean {
  return selection.some((r) => Object.is(r, ref));
}

/** Toggle `ref` in `selection`, returning a NEW array (order-preserving). Uses
 *  exact `Object.is` identity so a numeric and a same-spelling string ref never
 *  collapse into one selection entry. */
export function toggleRef(selection: readonly CoveringRef[], ref: CoveringRef): CoveringRef[] {
  return isSelected(selection, ref)
    ? selection.filter((r) => !Object.is(r, ref))
    : [...selection, ref];
}

// --- Option builders --------------------------------------------------------

/** People options: staff items + people groups (spec 11 FR-CV-13/14). */
export function buildPeopleOptions(state: ScenarioUiState): CoveringOptionGroups {
  return {
    items: state.staff.map((p) => ({
      ref: p.id,
      label: labelFor(p.id, p.description),
    })),
    groups: state.staffGroups.map((g) => ({
      ref: g.id,
      label: labelFor(g.id, g.description),
    })),
  };
}

/**
 * Whether a shift-type group (transitively) contains a reserved OFF/LEAVE
 * day-state. Members may reference nested group ids, so this walks the group graph
 * with a cycle guard (spec 11 FR-CV-15 — "groups containing them").
 */
export function shiftGroupContainsDayState(
  groupId: CoveringRef,
  state: ScenarioUiState,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const key = refValue(groupId);
  if (seen.has(key)) return false;
  const nextSeen = new Set(seen).add(key);
  const group = state.shiftGroups.find((g) => refValue(g.id) === key);
  if (!group) return false;
  return group.members.some((member) => {
    if (isDayStateSelector(String(member))) return true;
    // A member that names another group recurses; a shift-item member does not.
    if (state.shiftGroups.some((g) => refValue(g.id) === refValue(member))) {
      return shiftGroupContainsDayState(member, state, nextSeen);
    }
    return false;
  });
}

/**
 * Shift-type options: shift items + shift groups, with OFF/LEAVE rejected. An
 * individual item whose id is a day-state (defensive — such ids are reserved and
 * never authored) and any group that reaches OFF/LEAVE are marked `disabled` so
 * they cannot be selected (spec 11 FR-CV-15). A NUMERIC shift-type id is also
 * disabled: a covering selector is string-only (`ShiftTypeRef`), and the Python
 * shift map keys the raw numeric id, so `"7"` would not resolve it.
 */
export function buildShiftTypeOptions(state: ScenarioUiState): CoveringOptionGroups {
  return {
    items: state.shifts.map((s) => {
      const reserved = isDayStateSelector(String(s.id));
      const numeric = typeof s.id === "number";
      const disabled = reserved || numeric;
      const disabledReason = reserved
        ? COVERING_MESSAGES.offLeave
        : numeric
          ? COVERING_MESSAGES.numericShiftId
          : undefined;
      return {
        ref: s.id,
        label: labelFor(s.id, s.description),
        ...(disabled ? { disabled: true, disabledReason } : {}),
      };
    }),
    groups: state.shiftGroups.map((g) => {
      const tainted = shiftGroupContainsDayState(g.id, state);
      return {
        ref: g.id,
        label: labelFor(g.id, g.description),
        ...(tainted ? { disabled: true, disabledReason: COVERING_MESSAGES.offLeave } : {}),
      };
    }),
  };
}

/** Expand an inclusive ISO `YYYY-MM-DD` range into its concrete dates. Returns
 *  `[]` for a missing/invalid/reversed range. The full range is returned with no
 *  silent truncation — a cap belongs at the owning Dates boundary as an explicit
 *  contract, not hidden inside this editor's selector builder. */
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

// --- Validation, build, and load -------------------------------------------

/** Per-field validation errors, keyed by form field (empty ⇒ valid). */
export type CoveringErrors = Partial<Record<CoveringSelectField, string>>;

/**
 * Validate a draft against spec 11. Empty preceptors/preceptees/shiftTypes each
 * set their verbatim message; a shift-type selection reaching a reserved OFF/LEAVE
 * (item or tainted group) sets the `shiftTypes` error to the E26b message. Dates
 * are optional and never produce an error.
 */
export function validateCoveringForm(
  form: CoveringFormState,
  state: ScenarioUiState,
): CoveringErrors {
  const errors: CoveringErrors = {};
  if (form.preceptors.length === 0) errors.preceptors = COVERING_MESSAGES.preceptors;
  if (form.preceptees.length === 0) errors.preceptees = COVERING_MESSAGES.preceptees;
  if (form.shiftTypes.length === 0) {
    errors.shiftTypes = COVERING_MESSAGES.shiftTypes;
  } else if (selectionReachesDayState(form.shiftTypes, state)) {
    errors.shiftTypes = COVERING_MESSAGES.offLeave;
  }
  return errors;
}

/** Whether any selected shift-type ref is (or expands to) an OFF/LEAVE day-state. */
export function selectionReachesDayState(
  shiftTypes: readonly ShiftTypeRef[],
  state: ScenarioUiState,
): boolean {
  return shiftTypes.some(
    (ref) => isDayStateSelector(String(ref)) || shiftGroupContainsDayState(ref, state),
  );
}

/**
 * Assemble the saved covering card from a validated draft (spec 11 FR-CV-07,
 * EDGE-CV-01). Each flat person/shift-type selection is wrapped in a one-element
 * outer array (the canonical single-equation shape); the weight is the inert
 * `COVERING_WEIGHT`; an empty date selection leaves `date` **omitted** (never
 * `date: []`) so the T05 boundary serializes it as "all dates" (DL08). `uid` is
 * injectable for deterministic tests.
 */
export function buildCoveringCard(
  form: CoveringFormState,
  uid: string = crypto.randomUUID(),
): CoveringCard {
  const card: CoveringCard = {
    uid,
    preceptors: [form.preceptors] as NestedPersonRefList,
    preceptees: [form.preceptees] as NestedPersonRefList,
    shiftTypes: [form.shiftTypes],
    weight: COVERING_WEIGHT,
  };
  const description = form.description.trim();
  if (description) card.description = description;
  // Dates are a flat list (spec 11 FR-CV-19 renders `date.join`), OMITTED when
  // empty — the crux of the empty-dates→all-dates serialization (DL08).
  if (form.dates.length > 0) card.date = [...form.dates] as DateRef[];
  return card;
}

/**
 * Flatten a nested reference tree to a flat ref list (spec 11 EDGE-CV-01 load).
 * Generic over the element kind so a string-only tree (e.g. `shiftTypes`) yields
 * `ShiftTypeRef[]` rather than the broad `CoveringRef[]`; defaults to `CoveringRef`
 * so existing callers are unaffected.
 */
export function flattenRefs<T extends CoveringRef = CoveringRef>(tree: unknown): T[] {
  if (Array.isArray(tree)) return tree.flatMap((node) => flattenRefs<T>(node));
  return [tree as T];
}

/** Load an existing card back into a flat form draft (spec 11 FR-CV-08). */
export function coveringToForm(card: CoveringCard): CoveringFormState {
  return {
    description: card.description ?? "",
    preceptors: flattenRefs(card.preceptors),
    preceptees: flattenRefs(card.preceptees),
    shiftTypes: flattenRefs<ShiftTypeRef>(card.shiftTypes),
    dates: card.date === undefined ? [] : flattenRefs(card.date),
  };
}

/** Comma-joined flattened ids for a card summary; empty ⇒ `(all)` (spec 11 FR-CV-19). */
export function summarizeRefs(tree: unknown): string {
  const flat = flattenRefs(tree).filter((r) => r !== "" && r !== undefined);
  return flat.length > 0 ? flat.map(String).join(", ") : "(all)";
}

// --- Adapters to the shared transfer + date-scope controls ------------------
//
// The ScreenCards rebuild (M2/M3) drives selection through the shared
// `TransferList` (people / shift types) and `DateScopeField` (dates). These
// adapters are pure shape conversions over the proven `build*Options` builders
// so the OFF/LEAVE-disabled logic stays in ONE place and the existing unit
// tests keep guarding it. Nothing here touches the store.

/** Convert one authored option to a transfer-list row. The row carries the RAW
 *  ref (`int | str`) as its value — not the stringified `refValue` — so a numeric
 *  person id survives selection as a number and is never silently `String()`-ed
 *  (the same reason numeric shift-type ids are disabled as selectors above). The
 *  transfer lists are wired (`covering-form.tsx`) with `keyOf={entityKey}` +
 *  `sameValue={sameEntityId}` from the T09 entity-editor core — exact `Object.is`
 *  identity, NOT String coercion — so a numeric person `1` and a people-group
 *  named `"1"` (both producer-valid) stay distinct members of one selection. This
 *  mirrors `isSelected`/`toggleRef`'s own `Object.is` membership below. */
function toTransferOption(o: CoveringOption): TransferOption<CoveringRef> {
  const row: TransferOption<CoveringRef> = { value: o.ref, label: o.label };
  if (o.disabled) {
    row.disabled = true;
    if (o.disabledReason) row.disabledReason = o.disabledReason;
  }
  return row;
}

/** People options as transfer-list `items` + `groups` arrays (M2). */
export function buildPeopleTransferOptions(state: ScenarioUiState): {
  items: TransferOption<CoveringRef>[];
  groups: TransferOption<CoveringRef>[];
} {
  const o = buildPeopleOptions(state);
  return { items: o.items.map(toTransferOption), groups: o.groups.map(toTransferOption) };
}

/** Shift-type options as transfer-list `items` + `groups` arrays (M2). OFF/LEAVE
 *  + numeric-id options arrive already `disabled` from `buildShiftTypeOptions`. */
export function buildShiftTypeTransferOptions(state: ScenarioUiState): {
  items: TransferOption<CoveringRef>[];
  groups: TransferOption<CoveringRef>[];
} {
  const o = buildShiftTypeOptions(state);
  return { items: o.items.map(toTransferOption), groups: o.groups.map(toTransferOption) };
}

/** The auto-derived date-scope chips (ALL / WEEKDAY / WEEKEND / day-of-week) for M3.
 *  Sourced from the same `deriveDateGroups` + `generateDateItems` helpers the Dates
 *  screen uses, so the labels and membership match the rest of the app. Empty when
 *  no range is set. Only the group `id`/`description` cross the boundary (the stored
 *  chip value is the group id); members are used solely to drop empty scopes. */
export function buildDateScopeAutoScopes(state: ScenarioUiState): DateScopeOption[] {
  const items = generateDateItems({ start: state.rangeStart, end: state.rangeEnd });
  return deriveDateGroups(items)
    .filter((g) => g.members.length > 0)
    .map((g) => ({ id: g.id, label: g.description ?? g.id }));
}

/** Authored date groups as date-scope chips (M3). */
export function buildDateScopeDateGroups(state: ScenarioUiState): DateScopeOption[] {
  return state.dateGroups.map((g) => ({
    id: refValue(g.id),
    label: labelFor(g.id, g.description),
  }));
}

/** In-range concrete dates for the "specific dates" text field (M3), chronological. */
export function buildDateScopeDateItems(state: ScenarioUiState): DateScopeItem[] {
  return expandDateRange(state.rangeStart, state.rangeEnd).map((iso) => ({
    id: iso,
    dayOfMonth: Number(iso.slice(8)),
  }));
}

/** Return a copy of `card` with the UI-only `disabled` marker set to `value`
 *  (M4 Enable/Disable). Stripping the marker when re-enabling keeps the card body
 *  clean; `canonical.ts` skips disabled cards regardless, so this is UI-only. */
export function withCardDisabled(card: CoveringCard, value: boolean): CoveringCard {
  if (value) return { ...card, disabled: true };
  const { disabled: _omit, ...rest } = card;
  return rest;
}
