// T16d — pure range/domain tests. Node environment; no React, no DOM.

import { describe, expect, it } from "vitest";
import type { RunProgressPoint } from "@/lib/optimize";
import {
  DOT_THRESHOLD,
  getDomain,
  getVisibleRange,
  RANGE_PRESETS,
  shouldShowDots,
  type RangePreset,
} from "./range";

function pt(elapsedSeconds: number, over: Partial<RunProgressPoint> = {}): RunProgressPoint {
  return {
    source: over.source ?? "solver",
    currentBestScore: over.currentBestScore ?? 0,
    elapsedSeconds,
    solutionIndex: over.solutionIndex ?? null,
    commentCount: over.commentCount ?? null,
  };
}

// A representative stream: 6 points spaced 30s apart, scores descending
// (incumbent improves), comments present on the first 3 only.
const STREAM: RunProgressPoint[] = [
  pt(0, { currentBestScore: 100, commentCount: 0 }),
  pt(30, { currentBestScore: 90, commentCount: 1 }),
  pt(60, { currentBestScore: 80, commentCount: 2 }),
  pt(90, { currentBestScore: 75, commentCount: null }),
  pt(120, { currentBestScore: 72, commentCount: null }),
  pt(150, { currentBestScore: 71, commentCount: null }),
];

describe("getVisibleRange — Full", () => {
  it("returns the entire stream for Full", () => {
    expect(getVisibleRange(STREAM, "full")).toEqual({ startIndex: 0, endIndex: 5 });
  });

  it("returns endIndex=-1 for an empty input (no points exist)", () => {
    expect(getVisibleRange([], "full")).toEqual({ startIndex: 0, endIndex: -1 });
  });
});

describe("getVisibleRange — point-count windows", () => {
  it("Last 10 includes the last 10 points (or fewer when the stream is shorter)", () => {
    expect(getVisibleRange(STREAM, "last-10")).toEqual({ startIndex: 0, endIndex: 5 });
  });

  it("Last 50 includes the last 50 points (or fewer when the stream is shorter)", () => {
    expect(getVisibleRange(STREAM, "last-50")).toEqual({ startIndex: 0, endIndex: 5 });
  });

  it("Last 10 starts at length - 10 for a long stream", () => {
    const dense = Array.from({ length: 32 }, (_, i) => pt(i));
    expect(getVisibleRange(dense, "last-10")).toEqual({ startIndex: 22, endIndex: 31 });
  });

  it("handles a one-point stream without producing an empty slice", () => {
    expect(getVisibleRange([pt(5)], "last-10")).toEqual({ startIndex: 0, endIndex: 0 });
  });
});

describe("getVisibleRange — time windows", () => {
  it("Last 1 min includes only points within the trailing 60s", () => {
    // latest is 150s; threshold = 90s → first point ≥ 90s is index 3.
    expect(getVisibleRange(STREAM, "last-minute")).toEqual({ startIndex: 3, endIndex: 5 });
  });

  it("Last 10 min includes the whole stream when it is shorter than 10 min", () => {
    expect(getVisibleRange(STREAM, "last-ten-minutes")).toEqual({ startIndex: 0, endIndex: 5 });
  });

  it("always includes the latest point even when only the latest is within the window (sparse stream)", () => {
    // latest=10000s, threshold=9940s → only the latest point qualifies; we
    // never return an empty slice when points exist.
    const sparse = [pt(0), pt(10_000)];
    expect(getVisibleRange(sparse, "last-minute")).toEqual({ startIndex: 1, endIndex: 1 });
  });

  it("does not loop past the threshold when the first point already satisfies it", () => {
    const fresh = [pt(140), pt(145), pt(150)];
    expect(getVisibleRange(fresh, "last-minute")).toEqual({ startIndex: 0, endIndex: 2 });
  });
});

describe("getDomain", () => {
  it("Full starts at 0 and reaches at least the live elapsed time", () => {
    const d = getDomain(STREAM, "full", 200);
    expect(d.min).toBe(0);
    expect(d.max).toBe(200);
  });

  it("Full max is ≥ 1 even when both the live clock and the latest point are zero", () => {
    const d = getDomain([pt(0)], "full", 0);
    expect(d.min).toBe(0);
    expect(d.max).toBeGreaterThanOrEqual(1);
    expect(d.max).toBeGreaterThan(d.min);
  });

  it("last-1m starts at the first visible point's elapsed time", () => {
    const d = getDomain(STREAM.slice(3), "last-minute", 200);
    expect(d.min).toBe(90);
    expect(d.max).toBe(200);
  });

  it("last-10 (point window) starts at the first visible point's elapsed time", () => {
    const d = getDomain(STREAM.slice(0), "last-10", 200);
    expect(d.min).toBe(0);
    expect(d.max).toBe(200);
  });

  it("guarantees a non-zero span for a single-point slice (no NaN geometry)", () => {
    const d = getDomain([pt(120)], "last-minute", 120);
    expect(Number.isFinite(d.min)).toBe(true);
    expect(Number.isFinite(d.max)).toBe(true);
    expect(d.max).toBeGreaterThan(d.min);
  });

  it("guarantees a non-zero span when many points share the same elapsed time", () => {
    const duplicate = [pt(60, { currentBestScore: 10 }), pt(60, { currentBestScore: 8 })];
    const d = getDomain(duplicate, "full", 60);
    expect(d.min).toBeLessThan(d.max);
    expect(d.min).toBe(0); // Full always starts at 0
    expect(d.max).toBeGreaterThanOrEqual(60);
  });

  it("returns {0,1} when no points are visible (no NaN)", () => {
    const d = getDomain([], "full", 0);
    expect(d.min).toBe(0);
    expect(d.max).toBe(1);
  });
});

describe("shouldShowDots", () => {
  it("shows dots when the count is within the threshold", () => {
    expect(shouldShowDots(0)).toBe(false); // nothing to draw
    expect(shouldShowDots(1)).toBe(true);
    expect(shouldShowDots(DOT_THRESHOLD)).toBe(true);
  });

  it("hides dots when the count exceeds the threshold (dense histories)", () => {
    expect(shouldShowDots(DOT_THRESHOLD + 1)).toBe(false);
    expect(shouldShowDots(2000)).toBe(false);
  });
});

describe("RANGE_PRESETS — surface", () => {
  // Locks the five canonical presets + their labels so accidental renames
  // break tests, not production.
  it("exposes the exact five presets in display order", () => {
    expect(RANGE_PRESETS.map((p) => p.value)).toEqual<RangePreset[]>([
      "full",
      "last-minute",
      "last-ten-minutes",
      "last-10",
      "last-50",
    ]);
  });

  it("labels are stable and human-readable", () => {
    expect(RANGE_PRESETS.map((p) => p.label)).toEqual([
      "Full",
      "Last 1 min",
      "Last 10 min",
      "Last 10",
      "Last 50",
    ]);
  });

  it("exactly one of pointCount / elapsedSeconds is set for each non-full preset", () => {
    for (const preset of RANGE_PRESETS) {
      if (preset.value === "full") {
        expect(preset.pointCount).toBeNull();
        expect(preset.elapsedSeconds).toBeNull();
        continue;
      }
      const setCount = preset.pointCount !== null ? 1 : 0;
      const setSecs = preset.elapsedSeconds !== null ? 1 : 0;
      expect(setCount + setSecs).toBe(1);
    }
  });
});
