// T16d — pure range + domain logic for the optimization progress chart.
//
// These functions never touch the DOM or React and never mutate their inputs.
// They take the already-normalized `RunProgressPoint[]` (T16a guarantees every
// point carries finite `currentBestScore` + `elapsedSeconds`) and return finite
// slice indices and a finite [min, max] domain — so the chart never renders
// NaN geometry, even for a single-point, duplicate-time, or sparse stream.
//
// The semantics mirror the old `OptimizationProgressChart` exactly:
//   • Full           — every point, domain starts at 0.
//   • Last 1m / 10m  — points whose elapsedSeconds ≥ (latest − window), with
//                      the domain clamped to start at the first visible point.
//   • Last 10 / 50   — the last N points, domain starts at the first visible.
// The domain's max is always max(live, latest, 1), and the span is guaranteed
// non-zero (≥ max(max×0.01, 0.1)) so a one-point "Last 1m" slice still draws.

import type { RunProgressPoint } from "@/lib/optimize";

export type RangePreset = "full" | "last-minute" | "last-ten-minutes" | "last-10" | "last-50";

export interface RangePresetDef {
  value: RangePreset;
  label: string;
  /** Point-count window; null for full / time-window presets. */
  pointCount: number | null;
  /** Time window in seconds; null for full / point-count presets. */
  elapsedSeconds: number | null;
}

/**
 * The five range presets, in display order. `label` is the visible button text;
 * the matching `aria-pressed` state communicates the active selection
 * non-visually (see progress-chart.tsx).
 */
export const RANGE_PRESETS: readonly RangePresetDef[] = [
  { value: "full", label: "Full", pointCount: null, elapsedSeconds: null },
  { value: "last-minute", label: "Last 1 min", pointCount: null, elapsedSeconds: 60 },
  { value: "last-ten-minutes", label: "Last 10 min", pointCount: null, elapsedSeconds: 600 },
  { value: "last-10", label: "Last 10", pointCount: 10, elapsedSeconds: null },
  { value: "last-50", label: "Last 50", pointCount: 50, elapsedSeconds: null },
];

/** Above this visible-point count, individual dots are suppressed. */
export const DOT_THRESHOLD = 30;

export interface VisibleRange {
  startIndex: number;
  endIndex: number;
}

/**
 * Compute the [startIndex, endIndex] slice into `points` for the given preset.
 * Returns endIndex = -1 for an empty input so callers can branch cleanly.
 */
export function getVisibleRange(
  points: readonly RunProgressPoint[],
  preset: RangePreset,
): VisibleRange {
  if (points.length === 0) {
    return { startIndex: 0, endIndex: -1 };
  }
  const def = RANGE_PRESETS.find((candidate) => candidate.value === preset);
  const endIndex = points.length - 1;

  if (def?.pointCount && def.pointCount > 0) {
    return { startIndex: Math.max(points.length - def.pointCount, 0), endIndex };
  }

  if (def?.elapsedSeconds && def.elapsedSeconds > 0) {
    const latest = points[endIndex].elapsedSeconds;
    const threshold = latest - def.elapsedSeconds;
    // First point whose elapsedSeconds ≥ threshold; if every point is older
    // (a sparse stream), fall back to index 0 — we never return an empty slice
    // when points exist.
    let startIndex = 0;
    for (let i = 0; i < points.length; i++) {
      if (points[i].elapsedSeconds >= threshold) {
        startIndex = i;
        break;
      }
    }
    return { startIndex, endIndex };
  }

  return { startIndex: 0, endIndex };
}

export interface Domain {
  min: number;
  max: number;
}

/**
 * Compute the finite [min, max] x-axis domain for the visible slice.
 *
 * `liveElapsedSeconds` carries the wall-clock-extrapolated latest elapsed time
 * while the run is active; pass the latest point's elapsedSeconds when the run
 * is idle so the domain is stable. The max is always ≥ 1 to keep the axis
 * readable for very short runs.
 */
export function getDomain(
  visible: readonly RunProgressPoint[],
  preset: RangePreset,
  liveElapsedSeconds: number,
): Domain {
  const latest = visible.at(-1)?.elapsedSeconds ?? 0;
  const max = Math.max(liveElapsedSeconds, latest, 1);
  const min = preset === "full" ? 0 : (visible[0]?.elapsedSeconds ?? 0);

  // Guarantee a non-zero span even when the slice contains a single point or
  // many points at the same elapsedSeconds.
  const span = Math.max(max * 0.01, 0.1);
  if (min >= max - span) {
    return { min: max - span, max };
  }
  return { min, max };
}

/** Whether to draw individual dots over a slice of this many points. */
export function shouldShowDots(visiblePointCount: number): boolean {
  return visiblePointCount > 0 && visiblePointCount <= DOT_THRESHOLD;
}
