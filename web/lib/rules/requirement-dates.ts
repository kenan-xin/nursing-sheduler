// The date scope of a requirement card: which dates it covers, and its count on each.
//
// Lifted out of `shortfalls.ts` verbatim (d582). The static staffing check applies a
// temporary cover by reading `cardNeedOn`, and the cover module reads a card's resolved
// dates and its authored count -- so each would import the other. `import/no-cycle` is an
// error, so what both need lives here instead. `shortfalls.ts` re-exports the public
// names, so every existing importer of them is unchanged.

import {
  RESERVED_SHIFT_TYPE,
  type DateRef,
  type RequirementCard,
  type ScenarioUiState,
} from "@/lib/scenario/types";
import { generateDateItems, getDateIdForRange, isValidIso } from "@/lib/dates/date-id";
import { deriveDateGroups } from "@/lib/dates/derived-groups";
import { expandDateRefs } from "./expansion";

export type Range = { start: string; end: string };

const asList = <T>(value: T | T[] | null | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

/** An in-range ISO date becomes its span id; every other ref is returned as written. */
export function toDateId(ref: DateRef, range: Range): string {
  const key = String(ref);
  return isValidIso(key) ? getDateIdForRange(key, range) : key;
}

/** The date fields `makeDates` reads — a `Pick`, like the expansion helpers, so a
 *  caller that holds only the date slice (the Requirements editor's store
 *  subscription) can expand a card's dates without a whole scenario. */
export type DateScopeState = Pick<ScenarioUiState, "rangeStart" | "rangeEnd" | "dateGroups">;

export function makeDates(state: DateScopeState) {
  const range = { start: state.rangeStart, end: state.rangeEnd };
  const items = generateDateItems(range);
  const allDateIds = items.map((item) => item.id);
  const derived = deriveDateGroups(items);
  const expand = (refs: DateRef[]) =>
    expandDateRefs(
      refs.map((ref) => toDateId(ref, range)),
      state,
      allDateIds,
      derived,
    );
  return { range, items, allDateIds, expand };
}

/** The span ids a requirement covers in this roster period. */
export function requirementDateIds(
  state: DateScopeState,
  card: Pick<RequirementCard, "date">,
): string[] {
  const { allDateIds, expand } = makeDates(state);
  const covered = expand(card.date == null ? [RESERVED_SHIFT_TYPE.all] : asList(card.date));
  return allDateIds.filter((id) => covered.has(id));
}

/** The ISO dates a requirement covers in this roster period, in order. */
export function requirementDateIsos(
  state: DateScopeState,
  card: Pick<RequirementCard, "date">,
): string[] {
  const { items, expand } = makeDates(state);
  const covered = expand(card.date == null ? [RESERVED_SHIFT_TYPE.all] : asList(card.date));
  return items.filter((item) => covered.has(item.id)).map((item) => item.iso);
}

/** A requirement's head count on one date: its override there, else `requiredNumPeople`. */
export function requiredOn(
  card: Pick<RequirementCard, "requiredNumPeople" | "requiredNumPeopleOverrides">,
  iso: string,
): number {
  return (
    card.requiredNumPeopleOverrides?.find(([date]) => date === iso)?.[1] ?? card.requiredNumPeople
  );
}
