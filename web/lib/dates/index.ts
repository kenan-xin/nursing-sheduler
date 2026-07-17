// Dates domain logic (T10) — public surface. Pure, UTC-consistent helpers for
// range-driven date generation, span-formatted ids, the static Singapore holiday
// dataset, imported/derived date groups, and the range-change cascade. No store
// or React dependencies live here.

export {
  type DateRange,
  type DateItem,
  isValidIso,
  hasCompleteRange,
  isoToUtcMs,
  getDateIdForRange,
  generateDateIds,
  generateDateItems,
  describeDate,
  dateIdToIso,
  utcDayOfWeek,
  rangeDayCount,
  spannedMonths,
} from "./date-id";

export {
  type SingaporeHolidayEntry,
  SINGAPORE_HOLIDAYS,
  isSingaporePublicHoliday,
  getSingaporePublicHolidayName,
  isSingaporeNonWorkDay,
  getSupportedRange,
  getSupportLabel,
  isRangeSupported,
  getHolidaysInRange,
} from "./holidays-sg";

export {
  type DerivedDateGroup,
  DERIVED_DATE_GROUP_IDS,
  isDerivedDateGroupId,
  isDateLiteralGroupId,
  isReservedDateGroupId,
  deriveDateGroups,
} from "./derived-groups";

export {
  SINGAPORE_WORKDAY_GROUP_ID,
  SINGAPORE_NONWORKDAY_GROUP_ID,
  SINGAPORE_PH_GROUP_ID,
  buildSingaporeHolidayGroups,
  replaceDateGroups,
} from "./holiday-groups";

export { type RangeChangeOptions, applyRangeChange } from "./range-cascade";
