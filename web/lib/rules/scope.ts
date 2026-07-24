// Requirement scope predicates — pure, React-free (DR-H).
//
// Two "is this selector all-covering?" questions, split by whether the answer
// needs scenario context:
//
//   • `isAllScope` — keyword/shape only. Usable for a `shiftType` OR a
//     `qualifiedPeople` selector. It CANNOT decide full-range dates (that needs
//     state), and deliberately does not try.
//   • `isAllDates` — context-aware. True for the same keyword shapes AND when a
//     date ref enumerates the entire roster range / all-covering date groups,
//     decided by reusing the shared `expandDateRefs` expansion.

import { RESERVED_SHIFT_TYPE, type DateRef, type UiDateGroup } from "@/lib/scenario";
import { deriveDateGroups, generateDateItems, type DateRange } from "@/lib/dates";
import { expandDateRefs } from "./expansion";

/** A person / shift-type selector as it appears on a card (scalar or list, possibly nested). */
export type ScopeRef =
  | number
  | string
  | ReadonlyArray<number | string | ReadonlyArray<number | string>>
  | null
  | undefined;

/** Whether a single (non-array) value is the reserved `ALL` keyword, case-folded. */
function isAllKeyword(value: number | string): boolean {
  return String(value).toUpperCase() === RESERVED_SHIFT_TYPE.all;
}

/** Whether an array element (scalar or nested list) contributes an `ALL` keyword. */
function elementIsAll(value: number | string | ReadonlyArray<number | string>): boolean {
  if (Array.isArray(value)) return value.some((el) => elementIsAll(el));
  return isAllKeyword(value as number | string);
}

/**
 * Context-FREE all-scope predicate (keyword/shape only). True for:
 *   • an absent selector — `undefined` or `null` (the backend treats an omitted
 *     `qualifiedPeople`/`date` as every person / every date);
 *   • the scalar `ALL` keyword, `String()`-coerced + case-folded (`"all"`, `"ALL"`);
 *   • a list containing `ALL` — `["ALL"]` or `["ALL", x]` (ALL dominates).
 *
 * A non-`ALL` scalar (including a numeric id) is NOT all-scope, and an EMPTY list
 * `[]` is explicitly NOT all-scope (it selects nothing, not everything).
 */
export function isAllScope(ref: ScopeRef): boolean {
  if (ref === undefined || ref === null) return true;
  if (Array.isArray(ref)) return ref.some((el) => elementIsAll(el));
  return isAllKeyword(ref as number | string);
}

/** The roster range + authored date groups an `isAllDates` decision reads. */
export interface DateScopeContext {
  /** The roster date range (drives the full set of generated date ids). */
  range: DateRange;
  /** Authored date groups (a group id may itself enumerate the whole range). */
  dateGroups: readonly UiDateGroup[];
}

/** A `date` selector as it appears on a card: scalar, list, or absent. */
export type DateScopeRef = DateRef | readonly DateRef[] | null | undefined;

/**
 * Context-AWARE all-dates predicate. True for every keyword shape `isAllScope`
 * accepts, AND — decided against the roster range — when the ref's expansion
 * covers every generated date id: a full-range enumeration of concrete dates, a
 * union of all-covering derived groups (`WEEKDAY` + `WEEKEND`), or an authored
 * date group that spans the whole range.
 *
 * A strict subset is NOT all-dates. An empty range yields all-date ids `[]`, so a
 * non-keyword ref is never all-dates without a committed range (keyword shapes
 * still short-circuit to true — `ALL` means all dates regardless of range).
 */
export function isAllDates(dateRef: DateScopeRef, ctx: DateScopeContext): boolean {
  if (isAllScope(dateRef as ScopeRef)) return true;

  const items = generateDateItems(ctx.range);
  const allDateIds = items.map((d) => d.id);
  if (allDateIds.length === 0) return false;

  const derivedGroups = deriveDateGroups(items);
  const refs: DateRef[] = dateRef == null ? [] : Array.isArray(dateRef) ? [...dateRef] : [dateRef];
  const expanded = expandDateRefs(refs, { dateGroups: ctx.dateGroups }, allDateIds, derivedGroups);
  return allDateIds.every((id) => expanded.has(id));
}
