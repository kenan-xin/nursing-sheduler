// Singapore public-holiday dataset (T10; spec 02 FR-DC-22..34) — ENGLISH ONLY.
//
// The prototype fetched this live from data.gov.sg with an IndexedDB cache. This
// rebuild bundles a STATIC, offline, deterministic snapshot instead (ticket T10
// decision): no runtime network, no IndexedDB, no bilingual column. The entries
// below were taken verbatim from the data.gov.sg MOM consolidated public-holidays
// dataset (resource `d_8ef23381f9417e4d4254ee8b4dcdb176`) for 2024–2027, with the
// upstream `" (Observed)"` suffix parsed off the name into `isObserved` (FR-DC-23).
// Names are kept exactly as upstream, including Unicode curly apostrophes (FR-DC-24).
//
// To refresh: re-fetch the dataset and regenerate this array (see the ticket notes).

import type { IsoDate } from "@/lib/scenario";
import { utcDayOfWeek, type DateRange } from "./date-id";

/** One public-holiday record — exactly three fields, no second-language name. */
export interface SingaporeHolidayEntry {
  /** ISO `YYYY-MM-DD`. */
  date: IsoDate;
  /** Official English holiday name (verbatim upstream). */
  name: string;
  /** `true` for a substitute "(Observed)" day; the suffix is stripped from `name`. */
  isObserved: boolean;
}

/**
 * The bundled English-only Singapore public holidays (2024–2027), chronological.
 * The supported import window is derived from this array's min/max (FR-DC-29), so
 * extending coverage is a matter of appending rows here.
 */
export const SINGAPORE_HOLIDAYS: readonly SingaporeHolidayEntry[] = [
  { date: "2024-01-01", name: "New Year's Day", isObserved: false },
  { date: "2024-02-10", name: "Chinese New Year", isObserved: false },
  { date: "2024-02-11", name: "Chinese New Year", isObserved: false },
  { date: "2024-02-12", name: "Chinese New Year", isObserved: true },
  { date: "2024-03-29", name: "Good Friday", isObserved: false },
  { date: "2024-04-10", name: "Hari Raya Puasa", isObserved: false },
  { date: "2024-05-01", name: "Labour Day", isObserved: false },
  { date: "2024-05-22", name: "Vesak Day", isObserved: false },
  { date: "2024-06-17", name: "Hari Raya Haji", isObserved: false },
  { date: "2024-08-09", name: "National Day", isObserved: false },
  { date: "2024-10-31", name: "Deepavali", isObserved: false },
  { date: "2024-12-25", name: "Christmas Day", isObserved: false },
  { date: "2025-01-01", name: "New Year's Day", isObserved: false },
  { date: "2025-01-29", name: "Chinese New Year", isObserved: false },
  { date: "2025-01-30", name: "Chinese New Year", isObserved: false },
  { date: "2025-03-31", name: "Hari Raya Puasa", isObserved: false },
  { date: "2025-04-18", name: "Good Friday", isObserved: false },
  { date: "2025-05-01", name: "Labour Day", isObserved: false },
  { date: "2025-05-03", name: "Polling Day", isObserved: false },
  { date: "2025-05-12", name: "Vesak Day", isObserved: false },
  { date: "2025-06-07", name: "Hari Raya Haji", isObserved: false },
  { date: "2025-08-09", name: "National Day", isObserved: false },
  { date: "2025-10-20", name: "Deepavali", isObserved: false },
  { date: "2025-12-25", name: "Christmas Day", isObserved: false },
  { date: "2026-01-01", name: "New Year’s Day", isObserved: false },
  { date: "2026-02-17", name: "Chinese New Year", isObserved: false },
  { date: "2026-02-18", name: "Chinese New Year", isObserved: false },
  { date: "2026-03-21", name: "Hari Raya Puasa", isObserved: false },
  { date: "2026-04-03", name: "Good Friday", isObserved: false },
  { date: "2026-05-01", name: "Labour Day", isObserved: false },
  { date: "2026-05-27", name: "Hari Raya Haji", isObserved: false },
  { date: "2026-05-31", name: "Vesak Day", isObserved: false },
  { date: "2026-06-01", name: "Vesak Day", isObserved: true },
  { date: "2026-08-09", name: "National Day", isObserved: false },
  { date: "2026-08-10", name: "National Day", isObserved: true },
  { date: "2026-11-08", name: "Deepavali", isObserved: false },
  { date: "2026-11-09", name: "Deepavali", isObserved: true },
  { date: "2026-12-25", name: "Christmas Day", isObserved: false },
  { date: "2027-01-01", name: "New Year’s Day", isObserved: false },
  { date: "2027-02-06", name: "Chinese New Year", isObserved: false },
  { date: "2027-02-07", name: "Chinese New Year", isObserved: false },
  { date: "2027-02-08", name: "Chinese New Year", isObserved: true },
  { date: "2027-03-10", name: "Hari Raya Puasa", isObserved: false },
  { date: "2027-03-26", name: "Good Friday", isObserved: false },
  { date: "2027-05-01", name: "Labour Day", isObserved: false },
  { date: "2027-05-17", name: "Hari Raya Haji", isObserved: false },
  { date: "2027-05-20", name: "Vesak Day", isObserved: false },
  { date: "2027-08-09", name: "National Day", isObserved: false },
  { date: "2027-10-28", name: "Deepavali", isObserved: false },
  { date: "2027-12-25", name: "Christmas Day", isObserved: false },
] as const;

/** The set of ISO dates that are gazetted public holidays (incl. observed days). */
const HOLIDAY_DATES: ReadonlySet<IsoDate> = new Set(SINGAPORE_HOLIDAYS.map((e) => e.date));

/** Whether an ISO date is a gazetted public holiday (actual or observed). */
export function isSingaporePublicHoliday(iso: IsoDate): boolean {
  return HOLIDAY_DATES.has(iso);
}

/**
 * The official English holiday name for an ISO date, or `null` when it is not a
 * gazetted holiday. Actual and observed days share a name (FR-DC-23), so the first
 * matching entry is authoritative. Used to surface the name as a cell title/tooltip.
 */
export function getSingaporePublicHolidayName(iso: IsoDate): string | null {
  return SINGAPORE_HOLIDAYS.find((e) => e.date === iso)?.name ?? null;
}

/**
 * Whether an ISO date is a NON-WORKDAY: a public holiday OR a UTC weekend
 * (Sat/Sun). This is the union that classifies the imported `NON-WORKDAY` group
 * (spec 02 FR-DC-32).
 */
export function isSingaporeNonWorkDay(iso: IsoDate): boolean {
  if (HOLIDAY_DATES.has(iso)) return true;
  const dow = utcDayOfWeek(iso);
  return dow === 0 || dow === 6;
}

/** The supported import window `{ start, end }` — the dataset's min/max (FR-DC-29). */
export function getSupportedRange(): { start: IsoDate; end: IsoDate } | null {
  if (SINGAPORE_HOLIDAYS.length === 0) return null;
  return {
    start: SINGAPORE_HOLIDAYS[0].date,
    end: SINGAPORE_HOLIDAYS[SINGAPORE_HOLIDAYS.length - 1].date,
  };
}

/** Human label for the supported window, e.g. `2024-01-01 to 2027-12-25`. */
export function getSupportLabel(): string {
  const supported = getSupportedRange();
  return supported ? `${supported.start} to ${supported.end}` : "no data loaded";
}

/**
 * Whether a range is fully importable: both endpoints present and within the
 * dataset's min/max (lexicographic ISO comparison — spec 02 FR-DC-30).
 */
export function isRangeSupported(range: DateRange): boolean {
  const supported = getSupportedRange();
  if (!supported) return false;
  if (!range.start || !range.end) return false;
  return range.start >= supported.start && range.end <= supported.end;
}

/** Holiday entries whose date falls inside `[start, end]` (spec 02 FR-DC-31). */
export function getHolidaysInRange(range: DateRange): SingaporeHolidayEntry[] {
  if (!range.start || !range.end) return [];
  return SINGAPORE_HOLIDAYS.filter((e) => e.date >= range.start && e.date <= range.end);
}
