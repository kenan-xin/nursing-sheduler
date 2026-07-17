// Imported Singapore holiday groups (T10; spec 02 FR-DC-34, FR-DC-40).
//
// On import the app creates/overwrites exactly three EDITABLE date groups from the
// generated date items: WORKDAY, NON-WORKDAY, PH. Unlike the auto-derived groups
// (`./derived-groups`), these are ordinary `UiDateGroup`s — once written the user
// may edit or delete them; they are only (re)built at import time.

import type { GroupId, UiDateGroup } from "@/lib/scenario";
import type { DateItem } from "./date-id";
import { isSingaporeNonWorkDay, isSingaporePublicHoliday } from "./holidays-sg";

/** Group id + fixed description for the three importable Singapore groups. */
export const SINGAPORE_WORKDAY_GROUP_ID: GroupId = "WORKDAY";
export const SINGAPORE_NONWORKDAY_GROUP_ID: GroupId = "NON-WORKDAY";
export const SINGAPORE_PH_GROUP_ID: GroupId = "PH";

const WORKDAY_DESCRIPTION =
  "Singapore workdays (weekdays excluding public holidays) imported from the data.gov.sg public holidays dataset";
const NONWORKDAY_DESCRIPTION =
  "Singapore non-work days (public holidays and weekends) imported from the data.gov.sg public holidays dataset";
const PH_DESCRIPTION =
  "Singapore public holidays imported from the data.gov.sg public holidays dataset";

/**
 * Build the three imported groups from the generated date items. Each item is
 * classified by its ISO date: a NON-WORKDAY is a public holiday OR a weekend; a
 * WORKDAY is neither; PH is the public-holiday subset (both actual and observed
 * days). A date may appear in more than one group (every holiday is also a
 * non-work day). Members carry the span-formatted item id.
 */
export function buildSingaporeHolidayGroups(items: readonly DateItem[]): UiDateGroup[] {
  const workday: string[] = [];
  const nonWorkday: string[] = [];
  const publicHolidays: string[] = [];

  for (const item of items) {
    if (isSingaporePublicHoliday(item.iso)) publicHolidays.push(item.id);
    if (isSingaporeNonWorkDay(item.iso)) nonWorkday.push(item.id);
    else workday.push(item.id);
  }

  return [
    { id: SINGAPORE_WORKDAY_GROUP_ID, description: WORKDAY_DESCRIPTION, members: workday },
    { id: SINGAPORE_NONWORKDAY_GROUP_ID, description: NONWORKDAY_DESCRIPTION, members: nonWorkday },
    { id: SINGAPORE_PH_GROUP_ID, description: PH_DESCRIPTION, members: publicHolidays },
  ];
}

/**
 * Merge `incoming` groups into `existing`, replacing any group whose id matches
 * case-insensitively (spec 02 FR-DC-40 — a user group named `workday` is replaced
 * by the imported `WORKDAY`). The FIRST alias of each incoming group keeps its
 * slot; any further aliases of the SAME incoming group (e.g. a scenario that
 * legitimately carries both `workday` and `WORKDAY`, since the producer/backend
 * treats date-group ids as case-SENSITIVE for duplicate detection) are DROPPED so
 * the result never contains two identical canonical ids. Genuinely new incoming
 * groups are appended in `incoming` order.
 */
export function replaceDateGroups(
  existing: readonly UiDateGroup[],
  incoming: readonly UiDateGroup[],
): UiDateGroup[] {
  const byLowerId = new Map(incoming.map((g) => [g.id.toLowerCase(), g]));
  const placedIncoming = new Set<string>();
  const merged: UiDateGroup[] = [];

  for (const group of existing) {
    const key = group.id.toLowerCase();
    const replacement = byLowerId.get(key);
    if (!replacement) {
      // Unrelated user group — preserved untouched.
      merged.push(group);
      continue;
    }
    // An alias of an imported group: place the canonical group ONCE (first alias
    // wins its original slot) and drop later aliases to avoid duplicate exact ids.
    if (!placedIncoming.has(key)) {
      merged.push(replacement);
      placedIncoming.add(key);
    }
  }

  for (const group of incoming) {
    if (!placedIncoming.has(group.id.toLowerCase())) {
      merged.push(group);
      placedIncoming.add(group.id.toLowerCase());
    }
  }
  return merged;
}
