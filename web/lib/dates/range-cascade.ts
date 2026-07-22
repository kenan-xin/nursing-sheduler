// Range-change cascade (T10; spec 02 FR-DC-41).
//
// Committing a new roster range re-derives the date items — and because ids are
// span-dependent (FR-DC-11), changing the span class re-keys every id even for
// dates that stay in range. We compare old vs new items by their span-INDEPENDENT
// ISO key so we can tell the two cases apart:
//   • a date that LEFT the range → purge its references through the shared T07
//     delete cascade (`deleteEntity(state, "date", oldId)`), unchanged behaviour;
//   • a date that STAYS but is re-keyed → MIGRATE its references old-id → new-id
//     (`remapDateReferences`) so matrix cells, date-group members, and export-
//     layout date rows/columns follow the new format instead of being destroyed.
// (Full-ISO preference-card date fields are not span ids, so neither the delete
// nor the migrate ever matches them — they are out of scope by construction.)
//
// The whole thing is one pure transform returning a new `ScenarioUiState`; the
// store wires it as a single `mutateScenario` patch ⇒ one undo entry.

import type { IsoDate, ScenarioUiState } from "@/lib/scenario";
import { deleteEntity, remapDateReferences } from "@/lib/cascade";
import { generateDateItems, type DateRange } from "./date-id";
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
 * Apply a new roster range to `state`: purge references for dates that left the
 * range, migrate references for still-in-range dates the span change re-keyed, and
 * optionally (re)import the Singapore holiday groups. Pure: returns a new
 * `ScenarioUiState`, never mutating the input.
 */
export function applyRangeChange(
  state: ScenarioUiState,
  newRange: DateRange,
  options: RangeChangeOptions = {},
): ScenarioUiState {
  const oldItems = generateDateItems({ start: state.rangeStart, end: state.rangeEnd });
  const newIdByIso = new Map(newItemsByIso(newRange));

  // Partition the old ids by ISO membership in the new range: a date absent from
  // the new range genuinely LEFT (purge), a date present under a different id was
  // re-keyed by a span-class change and STAYS (migrate); an unchanged id is a
  // no-op.
  const removed: string[] = [];
  const migration = new Map<string, string>();
  for (const item of oldItems) {
    const newId = newIdByIso.get(item.iso);
    if (newId === undefined) {
      removed.push(item.id);
    } else if (newId !== item.id) {
      migration.set(item.id, newId);
    }
  }

  // Both operate on the pre-range-set state. Purge dates that left the range
  // through the shared delete cascade (reference integrity across groups +
  // preferences + export layout + matrix), then migrate the still-in-range
  // re-keyed dates old-id → new-id across the three span-id surfaces. The removed
  // and migrated id-spaces are disjoint, so order between them is irrelevant.
  let next = state;
  for (const id of removed) {
    next = deleteEntity(next, "date", id);
  }
  next = remapDateReferences(next, migration);

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

/** New-range date items as `[iso, id]` entries for the ISO→new-id lookup. */
function newItemsByIso(range: DateRange): [IsoDate, string][] {
  return generateDateItems(range).map((item) => [item.iso, item.id]);
}
