// Range-change cascade (T10; spec 02 FR-DC-41).
//
// Committing a new roster range re-derives the date items — and because ids are
// span-dependent (FR-DC-11), changing the span re-keys every id. Any date id no
// longer generated must be purged from date-group memberships AND every downstream
// reference (preferences, export layout, matrix). That purge is exactly the T07
// delete cascade, so we reuse `deleteEntity(state, "date", id)` per removed id
// rather than reimplementing reference integrity here.
//
// The whole thing is one pure transform returning a new `ScenarioUiState`; the
// store wires it as a single `mutateScenario` patch ⇒ one undo entry.

import type { IsoDate, ScenarioUiState } from "@/lib/scenario";
import { deleteEntity } from "@/lib/cascade";
import { generateDateIds, generateDateItems, type DateRange } from "./date-id";
import { buildSingaporeHolidayGroups, replaceDateGroups } from "./holiday-groups";
import { isRangeSupported } from "./holidays-sg";

/** Options for {@link applyRangeChange}. */
export interface RangeChangeOptions {
  /**
   * When `true` and the new range is within the supported window, (re)build and
   * overwrite the WORKDAY/NON-WORKDAY/PH groups from the new date items.
   */
  importSingaporeHolidays?: boolean;
}

/**
 * Apply a new roster range to `state`, cascading removed date ids out of every
 * reference and optionally (re)importing the Singapore holiday groups. Pure:
 * returns a new `ScenarioUiState`, never mutating the input.
 */
export function applyRangeChange(
  state: ScenarioUiState,
  newRange: DateRange,
  options: RangeChangeOptions = {},
): ScenarioUiState {
  const oldIds = new Set(generateDateIds({ start: state.rangeStart, end: state.rangeEnd }));
  const newIds = new Set(generateDateIds(newRange));
  const removed: string[] = [];
  for (const id of oldIds) {
    if (!newIds.has(id)) removed.push(id);
  }

  // Purge each removed date id through the shared delete cascade (reference
  // integrity across groups + preferences + export layout + matrix).
  let next = state;
  for (const id of removed) {
    next = deleteEntity(next, "date", id);
  }

  next = {
    ...next,
    rangeStart: newRange.start as IsoDate,
    rangeEnd: newRange.end as IsoDate,
  };

  if (options.importSingaporeHolidays && isRangeSupported(newRange)) {
    const imported = buildSingaporeHolidayGroups(generateDateItems(newRange));
    next = { ...next, dateGroups: replaceDateGroups(next.dateGroups, imported) };
  }

  return next;
}
