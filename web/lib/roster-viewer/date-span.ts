// Span-aware date labels (F4).
//
// The prototype assumes a single month; the ticket changes this to full
// date-range span-aware labels (DD / MM-DD / YYYY-MM-DD) with visible month/year
// boundaries. The label format depends on context:
//
//   • Within the SAME month as the previous day → "DD"
//   • First day of a NEW month (not January) → "MM-DD"
//   • First day of a NEW year → "YYYY-MM-DD"
//
// The grid header and the Day/Coverage strips both use these labels. Month and
// year boundaries are flagged so the grid can draw a visible separator edge.

import type { RosterCalendarDay } from "@/lib/roster/types";

/** Whether a calendar day is the first in a new month relative to its predecessor. */
export function isNewMonth(calendar: readonly RosterCalendarDay[], dateIdx: number): boolean {
  if (dateIdx === 0) return false;
  return monthOf(calendar[dateIdx].iso) !== monthOf(calendar[dateIdx - 1].iso);
}

/** Whether a calendar day is the first in a new year relative to its predecessor. */
export function isNewYear(calendar: readonly RosterCalendarDay[], dateIdx: number): boolean {
  if (dateIdx === 0) return false;
  return yearOf(calendar[dateIdx].iso) !== yearOf(calendar[dateIdx - 1].iso);
}

/**
 * The span-aware label for one day, given the calendar and the day's index.
 *
 * The first day of the range always shows its full year-aware label so the
 * roster's start is unambiguous; thereafter the label expands only at a month or
 * year boundary.
 */
export function dateLabel(calendar: readonly RosterCalendarDay[], dateIdx: number): string {
  const iso = calendar[dateIdx].iso;
  const [, month, day] = splitIso(iso);
  if (dateIdx === 0) return `${iso.slice(0, 4)}-${month}-${day}`;
  if (isNewYear(calendar, dateIdx)) return `${iso.slice(0, 4)}-${month}-${day}`;
  if (isNewMonth(calendar, dateIdx)) return `${month}-${day}`;
  return day;
}

/**
 * A human-readable title for one day's header cell: the full ISO date plus the
 * weekday, e.g. "2026-07-03 · Fri". Used for `title` attributes and screen
 * readers so a bare "03" always has its full context one hover/announcement away.
 */
export function dateTitle(day: RosterCalendarDay): string {
  return `${day.iso} · ${day.weekday}`;
}

/**
 * The roster's span title: a compact "start → end" using full ISO dates, plus
 * month/year when the range crosses a boundary. Used in the viewer header and
 * the provenance banner.
 */
export function rosterSpanTitle(calendar: readonly RosterCalendarDay[]): string {
  if (calendar.length === 0) return "";
  const first = calendar[0].iso;
  const last = calendar[calendar.length - 1].iso;
  return `${first} → ${last}`;
}

function splitIso(iso: string): [year: string, month: string, day: string] {
  return [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)];
}

function monthOf(iso: string): string {
  return iso.slice(5, 7);
}

function yearOf(iso: string): string {
  return iso.slice(0, 4);
}
