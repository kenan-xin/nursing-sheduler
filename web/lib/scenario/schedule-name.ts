// Recent schedules naming (plq5 P1). Pure, so the repository (removal notices) and
// the Save & Load card (the list) name a schedule the same way.

import type { ScenarioUiState } from "./types";

/** How many UNPINNED schedules Recent schedules keeps (plq5 user decision 2). */
export const RECENT_SCHEDULES_LIMIT = 30;

const MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "November 2025" for exactly one calendar month, else "3 Nov to 30 Nov 2025". */
export function schedulePeriod(rangeStart: string, rangeEnd: string): string {
  const start = parseDay(rangeStart);
  const end = parseDay(rangeEnd);
  if (!start || !end) return "No dates yet";
  const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  if (start.getUTCDate() === 1 && end.getTime() === monthEnd.getTime()) {
    return MONTH_YEAR.format(start);
  }
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${(sameYear ? DAY_MONTH : DAY_MONTH_YEAR).format(start)} to ${DAY_MONTH_YEAR.format(end)}`;
}

/** The ward name the top bar shows, or a stand-in when it is empty. */
export function scheduleWard(scenario: Pick<ScenarioUiState, "meta">): string {
  return scenario.meta.description?.trim() || "Untitled ward";
}

/** `<ward> · <period>` — the name a schedule has until the user renames it. */
export function scheduleAutoName(
  scenario: Pick<ScenarioUiState, "meta" | "rangeStart" | "rangeEnd">,
): string {
  return `${scheduleWard(scenario)} · ${schedulePeriod(scenario.rangeStart, scenario.rangeEnd)}`;
}

/**
 * Give duplicate names the created date, "(created 2 Oct)", so two rows never read
 * the same. Order-preserving.
 */
export function disambiguateScheduleNames(
  rows: readonly { name: string; createdAt: string }[],
): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  return rows.map((row) =>
    (counts.get(row.name) ?? 0) > 1
      ? `${row.name} (created ${DAY_MONTH.format(new Date(row.createdAt))})`
      : row.name,
  );
}
