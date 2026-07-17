// Date generation + ID-format-by-span (T10; spec 02 FR-DC-09..12).
//
// The roster range drives everything: per-day date items are DERIVED from the
// committed range (never hand-authored), and each item's id format varies with
// the range span so ids stay as short as possible while remaining unambiguous:
//
//   • within one UTC month  → `DD`          (e.g. `01`)
//   • within one UTC year   → `MM-DD`       (e.g. `07-01`)
//   • crossing a year       → `YYYY-MM-DD`  (e.g. `2026-07-01`)
//
// All computations are UTC (parsing, weekday, formatting) so ids/labels are
// identical regardless of the viewer's local timezone (spec 02 "UTC everywhere").

import type { IsoDate } from "@/lib/scenario";

/** A roster date range as ISO `YYYY-MM-DD` endpoints; `""` marks an unset side. */
export interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

/** A generated per-day date item derived from the range. */
export interface DateItem {
  /** Span-formatted id (`DD` / `MM-DD` / `YYYY-MM-DD`). */
  id: string;
  /** The underlying ISO `YYYY-MM-DD` key. */
  iso: IsoDate;
  /** Human label, e.g. `Wednesday, Jul 1, 2026`. */
  description: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a well-formed, real ISO `YYYY-MM-DD` calendar date. */
export function isValidIso(value: string): value is IsoDate {
  if (!ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  // Reject overflow like `2026-02-31` that `Date.parse` would silently roll over.
  return isoFromUtcMs(time) === value;
}

/** Whether both endpoints are valid ISO dates with `start <= end`. */
export function hasCompleteRange(range: DateRange): boolean {
  return isValidIso(range.start) && isValidIso(range.end) && range.start <= range.end;
}

/** ISO `YYYY-MM-DD` for a UTC-epoch millisecond value. */
function isoFromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse an ISO `YYYY-MM-DD` to its UTC-midnight epoch milliseconds. */
export function isoToUtcMs(iso: IsoDate): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

const DAY_MS = 86_400_000;

/**
 * The span class of a complete range — drives the id format. Endpoints are known
 * valid ISO here, so year/month can be sliced directly from the strings.
 */
type SpanClass = "same-month" | "same-year" | "cross-year";

function spanClass(range: DateRange): SpanClass {
  const sameYear = range.start.slice(0, 4) === range.end.slice(0, 4);
  if (!sameYear) return "cross-year";
  const sameMonth = range.start.slice(0, 7) === range.end.slice(0, 7);
  return sameMonth ? "same-month" : "same-year";
}

/** Format one ISO date's id for a given span class (spec 02 FR-DC-11). */
function formatId(iso: IsoDate, span: SpanClass): string {
  switch (span) {
    case "same-month":
      return iso.slice(8, 10); // DD
    case "same-year":
      return iso.slice(5); // MM-DD
    case "cross-year":
      return iso; // YYYY-MM-DD
  }
}

/**
 * The id an ISO date takes within `range`. When the range is incomplete the bare
 * ISO string is returned (nothing to compress against) — mirrors the prototype's
 * `getDateIdForRange` fallback.
 */
export function getDateIdForRange(iso: IsoDate, range: DateRange): string {
  if (!hasCompleteRange(range)) return iso;
  return formatId(iso, spanClass(range));
}

/** Every generated date id for the range, in chronological order (`[]` if unset). */
export function generateDateIds(range: DateRange): string[] {
  return generateDateItems(range).map((item) => item.id);
}

const WEEKDAY_LONG = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
const DATE_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Label a date as `Weekday, Mon D, YYYY` (spec 02 FR-DC-10). */
export function describeDate(iso: IsoDate): string {
  const date = new Date(isoToUtcMs(iso));
  return `${WEEKDAY_LONG.format(date)}, ${DATE_LABEL.format(date)}`;
}

/**
 * The read-only per-day items derived from the committed range, chronological and
 * inclusive of both endpoints. Empty when the range is incomplete.
 */
export function generateDateItems(range: DateRange): DateItem[] {
  if (!hasCompleteRange(range)) return [];
  const span = spanClass(range);
  const items: DateItem[] = [];
  const endMs = isoToUtcMs(range.end);
  for (let ms = isoToUtcMs(range.start); ms <= endMs; ms += DAY_MS) {
    const iso = isoFromUtcMs(ms);
    items.push({ id: formatId(iso, span), iso, description: describeDate(iso) });
  }
  return items;
}

/**
 * Parse a span-formatted date id back to its ISO `YYYY-MM-DD`, inferring the
 * missing parts from the range start (spec 02 FR-DC-12):
 *   • `YYYY-MM-DD` → itself
 *   • `MM-DD`      → year from `range.start`
 *   • `DD`         → month + year from `range.start`
 * Returns `null` when the id cannot be resolved (unset range for a partial id, or
 * an unrecognized string) — callers treat that as "not a generated date".
 */
export function dateIdToIso(id: string, range: DateRange): IsoDate | null {
  if (ISO_DATE.test(id)) return isValidIso(id) ? id : null;
  if (!isValidIso(range.start)) return null;
  if (/^\d{2}-\d{2}$/.test(id)) {
    const iso = `${range.start.slice(0, 4)}-${id}`;
    return isValidIso(iso) ? iso : null;
  }
  if (/^\d{1,2}$/.test(id)) {
    const iso = `${range.start.slice(0, 7)}-${id.padStart(2, "0")}`;
    return isValidIso(iso) ? iso : null;
  }
  return null;
}

/** UTC day-of-week for an ISO date (0 = Sunday … 6 = Saturday). */
export function utcDayOfWeek(iso: IsoDate): number {
  return new Date(isoToUtcMs(iso)).getUTCDay();
}

/** Inclusive day count of a complete range (`0` when incomplete). */
export function rangeDayCount(range: DateRange): number {
  if (!hasCompleteRange(range)) return 0;
  return Math.round((isoToUtcMs(range.end) - isoToUtcMs(range.start)) / DAY_MS) + 1;
}

/** The distinct UTC months a range spans, as first-of-month ISO keys, in order. */
export function spannedMonths(range: DateRange): IsoDate[] {
  if (!hasCompleteRange(range)) return [];
  const months: IsoDate[] = [];
  let year = Number(range.start.slice(0, 4));
  let month = Number(range.start.slice(5, 7)); // 1-12
  const endYear = Number(range.end.slice(0, 4));
  const endMonth = Number(range.end.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}
