// Shared UTC range-span label (T10) — the single human identity for a roster
// range, used by BOTH the roster-period duration row and the calendar-card heading
// so they never disagree (audit MINOR 2). Mirrors the prototype's `rangeSpanLabel()`
// (docs/design_prototype/Nurse Scheduling.dc.html:1157-1166):
//
//   • unset            → "—"
//   • one month        → "July 2026"
//   • same year        → "Jul – Aug 2026"
//   • crosses a year   → "Jul 2026 – Aug 2027"
//
// All fields are read in UTC so the label is identical in every timezone.

import type { DateRange } from "@/lib/dates";

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

/** First-of-month UTC date for an ISO `YYYY-MM-DD` (or its `YYYY-MM` prefix). */
function monthDate(iso: string): Date {
  return new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
}

/** The human identity for a roster range (see file header for the shapes). */
export function rangeSpanLabel(range: DateRange): string {
  if (!range.start) return "—";
  const startFull = MONTH_YEAR.format(monthDate(range.start));
  if (!range.end || range.start.slice(0, 7) === range.end.slice(0, 7)) return startFull;

  const startShort = MONTH_SHORT.format(monthDate(range.start));
  const endShort = MONTH_SHORT.format(monthDate(range.end));
  const startYear = range.start.slice(0, 4);
  const endYear = range.end.slice(0, 4);
  return startYear === endYear
    ? `${startShort} – ${endShort} ${endYear}`
    : `${startShort} ${startYear} – ${endShort} ${endYear}`;
}
