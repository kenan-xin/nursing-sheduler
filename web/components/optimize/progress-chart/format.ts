// T16d — pure formatters for the optimization progress chart.
//
// All formatters are deterministic, locale-aware via `Intl.NumberFormat`, and
// free of any DOM/React — so they are unit-testable in the node environment
// and produce identical output on the server and the client. The Intl instances
// are created once (module scope) and reused for every format call.

const SCORE_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

const COMPACT_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Placeholder shown for a nullable field that has no value. The old
 * `OptimizationProgressChart` and FR-OE-64 require the literal `N/A` (not a
 * dash), so tooltip and screen-reader announcements share this constant.
 */
export const MISSING_VALUE_TEXT = "N/A";

/** Format a score / comment count with up to 2 fractional digits. */
export function formatScore(value: number): string {
  return SCORE_FORMATTER.format(value);
}

/** Comment count for the tooltip / announcement; `N/A` when absent. */
export function formatComments(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatScore(value)
    : MISSING_VALUE_TEXT;
}

/** Solution index for the tooltip / announcement; `N/A` when absent. */
export function formatSolutionIndex(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `#${value}` : MISSING_VALUE_TEXT;
}

/** Compact format for axis ticks (e.g. 12k, 1.2M). */
export function formatCompact(value: number): string {
  return COMPACT_FORMATTER.format(value);
}

/**
 * Format an elapsed-seconds value for axis ticks and the tooltip header.
 * Mirrors the old `OptimizationProgressChart` ladder:
 *   • < 10s    → "x.x s"
 *   • < 60s    → "x s"
 *   • < 1h     → "Xm YYs"
 *   • ≥ 1h     → "Xh YYm"
 */
export function formatElapsedSeconds(value: number): string {
  if (value < 10) return `${value.toFixed(1)}s`;
  if (value < 60) return `${Math.round(value)}s`;
  // Round to whole seconds *before* decomposing into minutes/seconds. Rounding
  // the remainder alone lets a value like 3599.5 render as "59m 60s"; rounding
  // the total first carries it to "1h 00m" and never produces a 60s remainder.
  const totalSeconds = Math.round(value);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}
