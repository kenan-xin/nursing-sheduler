// Singapore public-holiday dataset (T10; spec 02 FR-DC-22..34) — ENGLISH ONLY.
//
// Source: the data.gov.sg MOM consolidated public-holidays dataset (resource
// `d_8ef23381f9417e4d4254ee8b4dcdb176`). The upstream `" (Observed)"` suffix is parsed
// off the name into `isObserved` (FR-DC-23); names are kept exactly as upstream,
// including Unicode curly apostrophes (FR-DC-24).
//
// Three sources, best first (bead si4j): the LIVE list the server route
// `/api/public-holidays` fetches and caches for a day, the browser's LAST GOOD copy of
// it, and the BUNDLED snapshot below (offline fallback and test fixture). The loader
// (`lib/query/singapore-holidays.ts`) installs the best one with
// `setSingaporeHolidays`; every helper here reads that ACTIVE list synchronously, so
// they work from the bundle until the live list arrives.
//
// To refresh the bundle: `pnpm refresh:sg-holidays` (scripts/refresh-sg-holidays.mjs)
// regenerates the array between the GENERATED markers.

import { z } from "zod";
import type { IsoDate } from "@/lib/scenario";
import { isValidIso, utcDayOfWeek, type DateRange } from "./date-id";

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
 * The bundled English-only Singapore public holidays, chronological. A year is
 * covered when it has at least one row: MOM publishes whole years.
 */
export const SINGAPORE_HOLIDAYS: readonly SingaporeHolidayEntry[] = [
  // BEGIN GENERATED (scripts/refresh-sg-holidays.mjs)
  { date: "2020-01-01", name: "New Year's Day", isObserved: false },
  { date: "2020-01-25", name: "Chinese New Year", isObserved: false },
  { date: "2020-01-26", name: "Chinese New Year", isObserved: false },
  { date: "2020-01-27", name: "Chinese New Year", isObserved: true },
  { date: "2020-04-10", name: "Good Friday", isObserved: false },
  { date: "2020-05-01", name: "Labour Day", isObserved: false },
  { date: "2020-05-07", name: "Vesak Day", isObserved: false },
  { date: "2020-05-24", name: "Hari Raya Puasa", isObserved: false },
  { date: "2020-05-25", name: "Hari Raya Puasa", isObserved: true },
  { date: "2020-07-10", name: "Polling Day", isObserved: false },
  { date: "2020-07-31", name: "Hari Raya Haji", isObserved: false },
  { date: "2020-08-09", name: "National Day", isObserved: false },
  { date: "2020-08-10", name: "National Day", isObserved: true },
  { date: "2020-11-14", name: "Deepavali", isObserved: false },
  { date: "2020-12-25", name: "Christmas Day", isObserved: false },
  { date: "2021-01-01", name: "New Year's Day", isObserved: false },
  { date: "2021-02-12", name: "Chinese New Year", isObserved: false },
  { date: "2021-02-13", name: "Chinese New Year", isObserved: false },
  { date: "2021-04-02", name: "Good Friday", isObserved: false },
  { date: "2021-05-01", name: "Labour Day", isObserved: false },
  { date: "2021-05-13", name: "Hari Raya Puasa", isObserved: false },
  { date: "2021-05-26", name: "Vesak Day", isObserved: false },
  { date: "2021-07-20", name: "Hari Raya Haji", isObserved: false },
  { date: "2021-08-09", name: "National Day", isObserved: false },
  { date: "2021-11-04", name: "Deepavali", isObserved: false },
  { date: "2021-12-25", name: "Christmas Day", isObserved: false },
  { date: "2022-01-01", name: "New Year's Day", isObserved: false },
  { date: "2022-02-01", name: "Chinese New Year", isObserved: false },
  { date: "2022-02-02", name: "Chinese New Year", isObserved: false },
  { date: "2022-04-15", name: "Good Friday", isObserved: false },
  { date: "2022-05-01", name: "Labour Day", isObserved: false },
  { date: "2022-05-02", name: "Hari Raya Puasa", isObserved: false },
  { date: "2022-05-03", name: "Labour Day", isObserved: true },
  { date: "2022-05-15", name: "Vesak Day", isObserved: false },
  { date: "2022-07-10", name: "Hari Raya Haji", isObserved: false },
  { date: "2022-08-09", name: "National Day", isObserved: false },
  { date: "2022-10-24", name: "Deepavali", isObserved: false },
  { date: "2022-12-25", name: "Christmas Day", isObserved: false },
  { date: "2022-12-26", name: "Christmas Day", isObserved: true },
  { date: "2023-01-01", name: "New Year's Day", isObserved: false },
  { date: "2023-01-02", name: "New Year's Day", isObserved: true },
  { date: "2023-01-22", name: "Chinese New Year", isObserved: false },
  { date: "2023-01-23", name: "Chinese New Year", isObserved: false },
  { date: "2023-01-24", name: "Chinese New Year", isObserved: true },
  { date: "2023-04-07", name: "Good Friday", isObserved: false },
  { date: "2023-04-22", name: "Hari Raya Puasa", isObserved: false },
  { date: "2023-05-01", name: "Labour Day", isObserved: false },
  { date: "2023-06-02", name: "Vesak Day", isObserved: false },
  { date: "2023-06-29", name: "Hari Raya Haji", isObserved: false },
  { date: "2023-08-09", name: "National Day", isObserved: false },
  { date: "2023-09-01", name: "Polling Day", isObserved: false },
  { date: "2023-11-12", name: "Deepavali", isObserved: false },
  { date: "2023-11-13", name: "Deepavali", isObserved: true },
  { date: "2023-12-25", name: "Christmas Day", isObserved: false },
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
  // END GENERATED
] as const;

const OBSERVED_SUFFIX = " (Observed)";

/** An upstream `holiday` string as `{ name, isObserved }` (FR-DC-23). */
export function parseHolidayName(holiday: string): { name: string; isObserved: boolean } {
  return holiday.endsWith(OBSERVED_SUFFIX)
    ? { name: holiday.slice(0, -OBSERVED_SUFFIX.length), isObserved: true }
    : { name: holiday, isObserved: false };
}

/** One entry at a trust boundary (the route's answer, the browser's last-good copy). */
export const singaporeHolidayEntrySchema = z.strictObject({
  date: z.string().refine(isValidIso, "not a calendar date"),
  name: z.string().min(1),
  isObserved: z.boolean(),
});

export const singaporeHolidayListSchema = z.array(singaporeHolidayEntrySchema);

/** What `GET /api/public-holidays` answers. `bundled`: the live fetch failed. */
export const singaporeHolidaysResponseSchema = z.strictObject({
  source: z.enum(["live", "bundled"]),
  entries: singaporeHolidayListSchema,
});
export type SingaporeHolidaysResponse = z.infer<typeof singaporeHolidaysResponseSchema>;

const yearOf = (iso: string) => iso.slice(0, 4);

/**
 * Merge two lists BY YEAR: every year `primary` covers comes wholly from `primary`,
 * and `fallback` fills only the years `primary` lacks. Per year rather than per date,
 * so a holiday the live data MOVED does not survive as a stale bundled date.
 */
export function mergeSingaporeHolidays(
  primary: readonly SingaporeHolidayEntry[],
  fallback: readonly SingaporeHolidayEntry[],
): SingaporeHolidayEntry[] {
  const primaryYears = new Set(primary.map((e) => yearOf(e.date)));
  return [...primary, ...fallback.filter((e) => !primaryYears.has(yearOf(e.date)))].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
}

// The ACTIVE list every helper reads. Module state so the helpers stay synchronous
// and signature-stable; `useSingaporeHolidayList` subscribes React to it.
let active: readonly SingaporeHolidayEntry[] = SINGAPORE_HOLIDAYS;
let activeDates: ReadonlySet<IsoDate> = new Set(active.map((e) => e.date));
let activeYears: ReadonlySet<string> = new Set(active.map((e) => yearOf(e.date)));
const listeners = new Set<() => void>();

/** The list the helpers currently use (bundled until a better one is installed). */
export function getSingaporeHolidays(): readonly SingaporeHolidayEntry[] {
  return active;
}

/** Install the list the helpers use and notify subscribers. */
export function setSingaporeHolidays(list: readonly SingaporeHolidayEntry[]): void {
  if (list === active) return;
  active = list;
  activeDates = new Set(list.map((e) => e.date));
  activeYears = new Set(list.map((e) => yearOf(e.date)));
  for (const listener of listeners) listener();
}

export function subscribeSingaporeHolidays(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether an ISO date is a gazetted public holiday (actual or observed). */
export function isSingaporePublicHoliday(iso: IsoDate): boolean {
  return activeDates.has(iso);
}

/**
 * The official English holiday name for an ISO date, or `null` when it is not a
 * gazetted holiday. Actual and observed days share a name (FR-DC-23), so the first
 * matching entry is authoritative. Used to surface the name as a cell title/tooltip.
 */
export function getSingaporePublicHolidayName(iso: IsoDate): string | null {
  return active.find((e) => e.date === iso)?.name ?? null;
}

/**
 * Whether an ISO date is a NON-WORKDAY: a public holiday OR a UTC weekend
 * (Sat/Sun). This is the union that classifies the imported `NON-WORKDAY` group
 * (spec 02 FR-DC-32).
 */
export function isSingaporeNonWorkDay(iso: IsoDate): boolean {
  if (activeDates.has(iso)) return true;
  const dow = utcDayOfWeek(iso);
  return dow === 0 || dow === 6;
}

/**
 * The outer import window `{ start, end }` — whole calendar years of the list's
 * min/max (FR-DC-29). The dataset publishes complete years, so the days after the
 * last holiday of the final year are known to be non-holidays too.
 */
export function getSupportedRange(): { start: IsoDate; end: IsoDate } | null {
  if (active.length === 0) return null;
  return {
    start: `${yearOf(active[0].date)}-01-01`,
    end: `${yearOf(active[active.length - 1].date)}-12-31`,
  };
}

/** Human label for the supported window, e.g. `2024-01-01 to 2027-12-31`. */
export function getSupportLabel(): string {
  const supported = getSupportedRange();
  return supported ? `${supported.start} to ${supported.end}` : "no data loaded";
}

/** The calendar years inside `range` that the active list has no data for. */
export function missingHolidayYears(range: DateRange): string[] {
  if (!range.start || !range.end) return [];
  const missing: string[] = [];
  for (let y = Number(yearOf(range.start)); y <= Number(yearOf(range.end)); y++) {
    const year = String(y).padStart(4, "0");
    if (!activeYears.has(year)) missing.push(year);
  }
  return missing;
}

/**
 * The nurse-facing warning for a range with uncovered years, or `null` when every
 * year is covered. One sentence pair, shared by the Dates card and the assistant.
 */
export function holidayCoverageWarning(range: DateRange): string | null {
  const years = missingHolidayYears(range);
  if (years.length === 0) return null;
  const label = years.length > 2 ? `${years[0]}–${years[years.length - 1]}` : years.join(" and ");
  return `No public-holiday data for ${label} yet. Holidays in those dates are not marked.`;
}

/**
 * Whether a range is fully importable: both endpoints present and every calendar
 * year it touches covered by the active list (spec 02 FR-DC-30).
 */
export function isRangeSupported(range: DateRange): boolean {
  if (active.length === 0) return false;
  if (!range.start || !range.end) return false;
  return missingHolidayYears(range).length === 0;
}

/** Holiday entries whose date falls inside `[start, end]` (spec 02 FR-DC-31). */
export function getHolidaysInRange(range: DateRange): SingaporeHolidayEntry[] {
  if (!range.start || !range.end) return [];
  return active.filter((e) => e.date >= range.start && e.date <= range.end);
}
