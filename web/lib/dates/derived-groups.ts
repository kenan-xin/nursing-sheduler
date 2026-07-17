// Read-only auto-derived date groups (T10; spec 02 FR-DC-35/36).
//
// ALL / WEEKDAY / WEEKEND and the seven single-weekday groups are RESERVED
// keywords (see `lib/cascade/domain.ts` + the producer schema): the backend
// understands them intrinsically, so they are never stored in `state.dateGroups`
// nor serialized. They are computed here purely for display in the Dates UI, and
// are non-editable/non-deletable. Membership uses UTC weekday, matching the id
// round-trip (FR-DC-12); ALL contains every generated item regardless.

import type { GroupId } from "@/lib/scenario";
import { utcDayOfWeek, type DateItem } from "./date-id";

/** A computed, read-only date group for display. */
export interface DerivedDateGroup {
  id: GroupId;
  description: string;
  members: string[];
}

const ALL_GROUP_ID: GroupId = "ALL";
const WEEKDAY_GROUP_ID: GroupId = "WEEKDAY";
const WEEKEND_GROUP_ID: GroupId = "WEEKEND";

// UTC weekday index (0 = Sunday) → single-weekday group id, in display order.
const WEEKDAY_NAME_GROUPS: readonly { id: GroupId; dow: number }[] = [
  { id: "SUNDAY", dow: 0 },
  { id: "MONDAY", dow: 1 },
  { id: "TUESDAY", dow: 2 },
  { id: "WEDNESDAY", dow: 3 },
  { id: "THURSDAY", dow: 4 },
  { id: "FRIDAY", dow: 5 },
  { id: "SATURDAY", dow: 6 },
];

/** The set of every reserved auto-derived date-group id (upper-case). */
export const DERIVED_DATE_GROUP_IDS: ReadonlySet<string> = new Set([
  ALL_GROUP_ID,
  WEEKDAY_GROUP_ID,
  WEEKEND_GROUP_ID,
  ...WEEKDAY_NAME_GROUPS.map((g) => g.id),
]);

/** Whether a group id names a reserved, read-only auto-derived date group. */
export function isDerivedDateGroupId(id: string): boolean {
  return DERIVED_DATE_GROUP_IDS.has(id.toUpperCase());
}

// A date-group id must not look like a concrete date (`D`, `MM-DD`, `YYYY-MM-DD`),
// else it collides with a generated in-range date reference. These patterns mirror
// the producer (`lib/scenario/schemas/producer.ts`) and T07 (`lib/cascade/domain.ts`)
// authority verbatim so CREATE rejects exactly what rename/export reject.
const DATE_LITERAL_PATTERNS = [/^\d{1,2}$/, /^\d{2}-\d{2}$/, /^\d{4}-\d{2}-\d{2}$/];

/** Whether `id` is shaped like a concrete date literal (`D` / `MM-DD` / `YYYY-MM-DD`). */
export function isDateLiteralGroupId(id: string): boolean {
  return DATE_LITERAL_PATTERNS.some((re) => re.test(id));
}

/**
 * Whether `id` is a reserved date-group id — a derived keyword (case-insensitive)
 * OR a concrete-date literal. The single authority the Dates UI + descriptor use to
 * reject a custom-group name at CREATE and rename, matching producer + T07.
 */
export function isReservedDateGroupId(id: string): boolean {
  return isDerivedDateGroupId(id) || isDateLiteralGroupId(id);
}

function isWeekend(dow: number): boolean {
  return dow === 0 || dow === 6;
}

/**
 * Compute the read-only derived groups for the generated items. With no items
 * every group (including WEEKDAY/WEEKEND) is empty — matching FR-DC-36 (weekday
 * groups are empty without a committed range).
 */
export function deriveDateGroups(items: readonly DateItem[]): DerivedDateGroup[] {
  const groups: DerivedDateGroup[] = [
    { id: ALL_GROUP_ID, description: "All dates", members: items.map((i) => i.id) },
    {
      id: WEEKDAY_GROUP_ID,
      description: "All weekdays (Mon–Fri)",
      members: items.filter((i) => !isWeekend(utcDayOfWeek(i.iso))).map((i) => i.id),
    },
    {
      id: WEEKEND_GROUP_ID,
      description: "All weekends (Sat–Sun)",
      members: items.filter((i) => isWeekend(utcDayOfWeek(i.iso))).map((i) => i.id),
    },
  ];

  for (const { id, dow } of WEEKDAY_NAME_GROUPS) {
    groups.push({
      id,
      description: `All ${id.charAt(0) + id.slice(1).toLowerCase()}s`,
      members: items.filter((i) => utcDayOfWeek(i.iso) === dow).map((i) => i.id),
    });
  }

  return groups;
}
