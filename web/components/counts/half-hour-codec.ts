// Half-hour target codec (T12 M2a-2). A contracted-hours shift count stores its
// target as an integer number of HALF-HOURS (the backend's day-state grid unit):
// a scalar for an exact policy, a `[min, max]` pair for a range. Humans think in
// hours, so the guided form authors hours and we convert here. Pure arithmetic —
// no DOM, no store — so the round-trip is provable in the `node` vitest env.
//
// Encoding: 1 hour = 2 half-hours. `320` half-hours ↔ `"160h"`, `17` ↔ `"8h 30m"`,
// `300` ↔ `"150h"`. Off-grid amounts (anything not a whole multiple of 30 minutes)
// and negatives are rejected as `null` so the caller can surface a field error.

/** Half-hours in one hour — the grid resolution the backend targets. */
export const HALF_HOURS_PER_HOUR = 2;

/** Minutes represented by one half-hour grid step. */
const MINUTES_PER_HALF_HOUR = 30;

/**
 * Default paid-leave credit, in half-hours (8h). A LEAVE day contributes this much
 * toward a contracted-hours target unless the author overrides its coefficient.
 * The coefficient sub-editor is M2a-3; this constant is the seed default it will use.
 */
export const LEAVE_CREDIT_HALF_HOURS = 16;

/**
 * Format an integer half-hour count as a human hours string: `320 → "160h"`,
 * `17 → "8h 30m"`, `0 → "0h"`. A whole-hour amount omits the minutes segment.
 */
export function formatHalfHours(halfHours: number): string {
  const totalMinutes = halfHours * MINUTES_PER_HALF_HOUR;
  const hours = Math.trunc(totalMinutes / 60);
  const minutes = Math.abs(totalMinutes % 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Parse a human hours amount into integer half-hours, or `null` when it is
 * off-grid (not a whole multiple of 30 minutes), negative, or unrecognized.
 * Accepts `"160h"`, a bare `"160"` (read as hours), `"8h 30m"`, `"8.5h"`, and a
 * minutes-only `"30m"`. The round-trip with {@link formatHalfHours} is lossless
 * for every on-grid value.
 */
export function parseHalfHours(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text === "") return null;

  let hours = 0;
  let minutes = 0;
  const hoursAndMinutes = text.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m)?$/);
  const minutesOnly = text.match(/^(\d+)\s*m$/);
  const bareNumber = text.match(/^\d+(?:\.\d+)?$/);
  if (hoursAndMinutes) {
    hours = Number.parseFloat(hoursAndMinutes[1]);
    if (hoursAndMinutes[2] !== undefined) minutes = Number.parseInt(hoursAndMinutes[2], 10);
  } else if (minutesOnly) {
    minutes = Number.parseInt(minutesOnly[1], 10);
  } else if (bareNumber) {
    hours = Number.parseFloat(text);
  } else {
    return null;
  }

  const totalMinutes = hours * 60 + minutes;
  const halfHours = totalMinutes / MINUTES_PER_HALF_HOUR;
  // `Number.isSafeInteger` (not merely `isInteger`) rejects magnitudes past 2^53,
  // where `parseFloat` has already rounded the input — so a target that survives
  // here always round-trips losslessly through `formatHalfHours`.
  if (halfHours < 0 || !Number.isSafeInteger(halfHours)) return null;
  return halfHours;
}

/**
 * Format a `[min, max]` half-hour range as a single hours string with the unit
 * emitted once when the minimum lands on a whole hour: `[300, 340] → "150–170h"`.
 * A minimum with a minutes remainder keeps its full segment (e.g. `"8h 30m–9h"`).
 */
export function formatHalfHourRange([min, max]: readonly [number, number]): string {
  const minWhole = (min * MINUTES_PER_HALF_HOUR) % 60 === 0;
  const minText = minWhole ? String((min * MINUTES_PER_HALF_HOUR) / 60) : formatHalfHours(min);
  return `${minText}–${formatHalfHours(max)}`;
}

/**
 * Parse a `"150–170h"` (en-dash, em-dash, hyphen, or " to ") range into a
 * `[min, max]` half-hour pair, or `null` when either bound is off-grid/invalid or
 * the shape is not exactly two bounds. Does not enforce `min <= max` — ordering is
 * a form-validation concern, not a codec one.
 */
export function parseHalfHourRange(raw: string): [number, number] | null {
  const parts = raw.trim().split(/\s*(?:–|—|-|\bto\b)\s*/i);
  if (parts.length !== 2) return null;
  const min = parseHalfHours(parts[0]);
  const max = parseHalfHours(parts[1]);
  if (min === null || max === null) return null;
  return [min, max];
}
