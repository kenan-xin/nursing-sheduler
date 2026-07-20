"use client";

// T16d — the optimization progress chart, rebuilt on the durable
// `RunProgressPoint` contract (T16a) and the rebuild's design tokens.
//
// Behavior is ported one-for-one from the old `OptimizationProgressChart`
// (score step-line, comment overlay/toggle, live extrapolated x-axis while
// active, range presets, dot threshold, synchronized hover) but presentation
// is rebuilt: a native-SVG chart (no `recharts` dependency), square corners,
// the ink/brand/semantic tokens, and the rebuild's accessibility rules.
//
// The component is feature-local: it accepts already-normalized progress
// points (finite score + elapsed) and renders. Transport, orchestration, and
// page composition live in T16a/T16e. SVG internals are `aria-hidden` because
// the surrounding figure already exposes a summary `aria-label`; meaningful
// interaction is via the labeled controls (range presets, comments toggle).

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RunProgressPoint } from "@/lib/optimize";
import { cn } from "@/lib/utils";
import {
  formatCompact,
  formatComments,
  formatElapsedSeconds,
  formatScore,
  formatSolutionIndex,
} from "./format";
import {
  DOT_THRESHOLD,
  getDomain,
  getVisibleRange,
  RANGE_PRESETS,
  shouldShowDots,
  type RangePreset,
} from "./range";
import {
  autoDomain,
  createLinearScale,
  generateTicks,
  pixelToScale,
  scaleToPixel,
  type LinearScale,
} from "./scales";

export interface ProgressChartProps {
  /**
   * Normalized progress points. T16a guarantees every point carries finite
   * `currentBestScore` + `elapsedSeconds`; `commentCount`, `solutionIndex` are
   * nullable. The chart does not defensively defend against non-finite axes —
   * the model already does.
   */
  points: readonly RunProgressPoint[];
  /**
   * Whether the run is currently active (queued / running / cancelling).
   * While true, the x-axis extrapolates forward in real time so the latest
   * point never sits on the right edge. When false, the axis is frozen at the
   * last extrapolated position.
   */
  isActive?: boolean;
  className?: string;
}

// Layout constants (mirror the old chart's vertical rhythm; redesigned on the
// rebuild's 4px density-aware scale via the Tailwind `text-*` / `p-*` utilities
// elsewhere in the component).
const SCORE_PANEL_HEIGHT = 250;
const COMMENT_PANEL_HEIGHT = 170;
const PLOT_LEFT = 60; // room for y-axis tick labels
const PLOT_RIGHT = 16;
const PLOT_TOP = 14;
const PLOT_BOTTOM_SCORE_SOLO = 30; // score panel own x-axis (comments hidden)
const PLOT_BOTTOM_SCORE_PAIRED = 8; // score panel when comments panel carries the x-axis
const PLOT_BOTTOM_COMMENTS = 30; // comments panel always owns its x-axis when shown
// Pointer slop, in *pixels*, around the plotted x-band. A pointer further than
// this outside the band (e.g. deep in the y-axis label gutter) is not snapped to
// a data point. Kept in pixel space so hover rejection is independent of the
// elapsed-time scale — comparing against domain (seconds) units made the
// threshold silently expand/contract with the run's duration.
const HOVER_EDGE_SLOP_PX = 24;

const TICK_COLOR_VAR = "var(--ink3)";
const AXIS_COLOR_VAR = "var(--line)";
const GRID_COLOR_VAR = "var(--line2)";
const SCORE_COLOR_VAR = "var(--brand)";
const COMMENT_COLOR_VAR = "var(--warn)";

/**
 * Default container width used until ResizeObserver reports a real pixel width
 * (also the width jsdom tests render at, since jsdom never lays out).
 */
const DEFAULT_CONTAINER_WIDTH = 800;

/**
 * Build a step-after SVG path for the given (x, y) pixel pairs.
 *
 * Step-after means the line runs horizontally to x[i], then vertically to
 * y[i] — the value displayed at x[i] is y[i], matching the old `recharts`
 * `type="stepAfter"` semantics for an incumbent score that holds until the
 * next improvement.
 */
function buildStepAfterPath(pixels: ReadonlyArray<{ x: number; y: number }>): string {
  if (pixels.length === 0) return "";
  if (pixels.length === 1) {
    const p = pixels[0];
    return `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  let d = `M ${pixels[0].x.toFixed(2)} ${pixels[0].y.toFixed(2)}`;
  for (let i = 1; i < pixels.length; i++) {
    d += ` H ${pixels[i].x.toFixed(2)}`;
    d += ` V ${pixels[i].y.toFixed(2)}`;
  }
  return d;
}

function nearestIndex(values: readonly number[], target: number): number {
  if (values.length === 0) return -1;
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (values[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  // Choose the closer of `lo` and `lo + 1`.
  if (lo + 1 < values.length && Math.abs(values[lo + 1] - target) < Math.abs(values[lo] - target)) {
    return lo + 1;
  }
  return lo;
}

export function ProgressChart({ points, isActive = false, className }: ProgressChartProps) {
  const reactLabelId = useId();
  const liveRegionId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Container width drives every pixel calculation. ResizeObserver updates it
  // in real browsers; jsdom keeps the DEFAULT_CONTAINER_WIDTH fallback so
  // geometry assertions are deterministic in unit tests.
  const [containerWidth, setContainerWidth] = useState<number>(DEFAULT_CONTAINER_WIDTH);
  const [rangePreset, setRangePreset] = useState<RangePreset>("full");
  const [showComments, setShowComments] = useState(true);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [liveElapsedSeconds, setLiveElapsedSeconds] = useState<number>(
    points.at(-1)?.elapsedSeconds ?? 0,
  );

  // ResizeObserver is intentionally mounted once per instance; the
  // `setContainerWidth` identity is stable so the effect won't churn.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = Math.floor(entry.contentRect.width);
      if (Number.isFinite(next) && next > 0) {
        setContainerWidth(next);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Live x-axis extrapolation: while active, the latest point's elapsed time
  // advances with wall-clock so it never sits on the right edge. When the run
  // goes idle (or unmounts), the interval stops and `liveElapsedSeconds`
  // retains its last value — so the axis freezes where it was, never snaps
  // backwards. This is the behavior the old chart pinned on.
  const latestElapsedSeconds = points.at(-1)?.elapsedSeconds ?? 0;
  useEffect(() => {
    if (!isActive) return;
    const startedAt = performance.now();
    const intervalId = window.setInterval(() => {
      setLiveElapsedSeconds(latestElapsedSeconds + (performance.now() - startedAt) / 1000);
    }, 250);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isActive, latestElapsedSeconds]);

  // Reset the live counter when points shrink / change identity so a new run
  // never inherits the previous run's extrapolated wall-clock position.
  useEffect(() => {
    setLiveElapsedSeconds(latestElapsedSeconds);
  }, [latestElapsedSeconds]);

  const visibleRange = useMemo(() => getVisibleRange(points, rangePreset), [points, rangePreset]);
  const visiblePoints = useMemo(
    () => points.slice(visibleRange.startIndex, visibleRange.endIndex + 1),
    [points, visibleRange.startIndex, visibleRange.endIndex],
  );
  const visiblePointCount = visiblePoints.length;
  const dotsEnabled = shouldShowDots(visiblePointCount);

  const domain = useMemo(
    () => getDomain(visiblePoints, rangePreset, liveElapsedSeconds),
    [visiblePoints, rangePreset, liveElapsedSeconds],
  );

  const xScale = useMemo(
    () => createLinearScale(domain.min, domain.max, PLOT_LEFT, containerWidth - PLOT_RIGHT),
    [domain.min, domain.max, containerWidth],
  );

  const scoreDomain = useMemo(
    () => autoDomain(visiblePoints.map((p) => p.currentBestScore)),
    [visiblePoints],
  );
  const scoreYScale = useMemo(
    () =>
      createLinearScale(
        scoreDomain.min,
        scoreDomain.max,
        PLOT_TOP,
        SCORE_PANEL_HEIGHT - (showComments ? PLOT_BOTTOM_SCORE_PAIRED : PLOT_BOTTOM_SCORE_SOLO),
      ),
    [scoreDomain.min, scoreDomain.max, showComments],
  );

  const commentValues = useMemo(
    () =>
      visiblePoints
        .map((p) => p.commentCount)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    [visiblePoints],
  );
  const commentDomain = useMemo(() => autoDomain(commentValues, true), [commentValues]);
  const commentYScale = useMemo(
    () =>
      createLinearScale(
        commentDomain.min,
        commentDomain.max,
        PLOT_TOP,
        COMMENT_PANEL_HEIGHT - PLOT_BOTTOM_COMMENTS,
      ),
    [commentDomain.min, commentDomain.max],
  );

  // Tick arrays drive both the gridlines and the numeric labels.
  const xTicks = useMemo(
    () => generateTicks(domain.min, domain.max, Math.max(Math.floor(containerWidth / 110), 3)),
    [domain.min, domain.max, containerWidth],
  );
  const scoreYTicks = useMemo(
    () => generateTicks(scoreDomain.min, scoreDomain.max, 5),
    [scoreDomain.min, scoreDomain.max],
  );
  const commentYTicks = useMemo(
    () => generateTicks(commentDomain.min, commentDomain.max, 4),
    [commentDomain.min, commentDomain.max],
  );

  const scorePixels = useMemo(
    () =>
      visiblePoints.map((p) => ({
        x: scaleToPixel(xScale, p.elapsedSeconds),
        y: scaleToPixel(scoreYScale, p.currentBestScore),
      })),
    [visiblePoints, xScale, scoreYScale],
  );
  const scorePath = useMemo(() => buildStepAfterPath(scorePixels), [scorePixels]);

  const commentSegments = useMemo(() => {
    // connectNulls semantics: drop null/non-finite comment counts and draw a
    // step-after path across the survivors, so a stream that loses comments
    // mid-run still renders an unbroken line for the points that had them.
    const survivors: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < visiblePoints.length; i++) {
      const value = visiblePoints[i].commentCount;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      survivors.push({
        x: scaleToPixel(xScale, visiblePoints[i].elapsedSeconds),
        y: scaleToPixel(commentYScale, value),
      });
    }
    return survivors;
  }, [visiblePoints, xScale, commentYScale]);
  const commentPath = useMemo(() => buildStepAfterPath(commentSegments), [commentSegments]);

  const latestPoint = points.at(-1);
  const latestVisiblePoint = visiblePoints.at(-1);
  const latestScorePixel = latestVisiblePoint
    ? {
        x: scaleToPixel(xScale, latestVisiblePoint.elapsedSeconds),
        y: scaleToPixel(scoreYScale, latestVisiblePoint.currentBestScore),
      }
    : null;
  const latestCommentPixel = (() => {
    if (!latestVisiblePoint) return null;
    const value = latestVisiblePoint.commentCount;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return {
      x: scaleToPixel(xScale, latestVisiblePoint.elapsedSeconds),
      y: scaleToPixel(commentYScale, value),
    };
  })();

  const hoveredPoint = hoveredIndex !== null ? visiblePoints[hoveredIndex] : null;
  const hoveredScorePixel = (() => {
    if (hoveredPoint === null) return null;
    return {
      x: scaleToPixel(xScale, hoveredPoint.elapsedSeconds),
      y: scaleToPixel(scoreYScale, hoveredPoint.currentBestScore),
    };
  })();
  const hoveredCommentPixel = (() => {
    if (hoveredPoint === null) return null;
    const value = hoveredPoint.commentCount;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return {
      x: scaleToPixel(xScale, hoveredPoint.elapsedSeconds),
      y: scaleToPixel(commentYScale, value),
    };
  })();
  // The crosshair x-position tracks the hovered point independently of any
  // panel's y-value. This keeps the comment panel's vertical guide synchronized
  // with the score panel even when the hovered point has `commentCount: null`
  // (the guide stays; only the tooltip value reads "N/A").
  const hoveredXPixel =
    hoveredPoint !== null ? scaleToPixel(xScale, hoveredPoint.elapsedSeconds) : null;

  // A touch/pen tap (or keyboard selection) "pins" the active point so the
  // shared pointer-leave — which fires the instant a finger lifts — does not
  // wipe the selection. Mouse hover leaves it unpinned (moving away clears, as
  // expected). Held in a ref because it must not trigger re-renders and the
  // leave handler needs the live value without re-subscribing.
  const pinnedRef = useRef(false);

  // Map a pointer event to the nearest in-band point index. Shared by hover
  // (mouse/pen) and tap (touch/pen) so both use the same CSS→viewBox mapping.
  const hitTestPointer = useCallback(
    (
      event: React.PointerEvent<SVGElement>,
    ): { kind: "point"; index: number } | "out" | "ignore" => {
      if (visiblePoints.length === 0) return "ignore";
      const svg = event.currentTarget as SVGSVGElement;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return "ignore";
      // Scale the CSS-pixel offset into the SVG's viewBox coordinate space so the
      // comparison against the plot pixel band holds even when the rendered SVG
      // is a different width than its `width`/viewBox (responsive scaling).
      let viewBoxWidth = rect.width;
      const vbw = svg.viewBox?.baseVal?.width;
      if (typeof vbw === "number" && vbw > 0) viewBoxWidth = vbw;
      const relativeX = ((event.clientX - rect.left) * viewBoxWidth) / rect.width;
      // Reject when the pointer is more than the edge slop *in pixels* outside
      // the plotted x-band (e.g. in the y-axis label gutter).
      const plotLeftPx = xScale.pixelMin;
      const plotRightPx = xScale.pixelMin + xScale.pixelSpan;
      if (
        relativeX < plotLeftPx - HOVER_EDGE_SLOP_PX ||
        relativeX > plotRightPx + HOVER_EDGE_SLOP_PX
      ) {
        return "out";
      }
      const elapsed = pixelToScale(xScale, relativeX);
      const idx = nearestIndex(
        visiblePoints.map((p) => p.elapsedSeconds),
        elapsed,
      );
      return idx >= 0 ? { kind: "point", index: idx } : "out";
    },
    [visiblePoints, xScale],
  );

  const handleScorePointerMove = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      // Touch is handled by tap (pointerdown); a touch-drag must not fight the
      // retained tap selection or the browser's vertical panning.
      if (event.pointerType === "touch") return;
      const hit = hitTestPointer(event);
      if (hit === "ignore") return;
      // Mouse / pen hover is transient — never pinned.
      pinnedRef.current = false;
      setHoveredIndex(hit === "out" ? null : hit.index);
    },
    [hitTestPointer],
  );
  const handlePointerLeave = useCallback(() => {
    // A pinned (tap/keyboard) selection survives the pointer leaving; only a
    // transient hover clears on leave.
    if (pinnedRef.current) return;
    setHoveredIndex(null);
  }, []);
  // Touch/pen tap: select the nearest point and retain it. A second tap on the
  // same point toggles it off; a tap outside the plot band clears it. Mouse
  // pointerdown is ignored — hover already covers the mouse.
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      const hit = hitTestPointer(event);
      if (hit === "ignore") return;
      if (hit === "out") {
        pinnedRef.current = false;
        setHoveredIndex(null);
        return;
      }
      setHoveredIndex((current) => {
        if (current === hit.index && pinnedRef.current) {
          pinnedRef.current = false;
          return null;
        }
        pinnedRef.current = true;
        return hit.index;
      });
    },
    [hitTestPointer],
  );

  // Keyboard inspection: the plot region is focusable, and arrow keys walk the
  // visible points. Because navigation drives the same `hoveredIndex` as the
  // pointer, the tooltip and both panel crosshairs stay synchronized with no
  // extra wiring — a keyboard-only user reaches every point's elapsed / score /
  // comments / solution / source, not just the latest-point summary.
  const stepHover = useCallback(
    (delta: number) => {
      const count = visiblePoints.length;
      if (count === 0) return;
      // A keyboard selection is retained just like a tap — a stray pointer-leave
      // (from an earlier mouse position) must not wipe it.
      pinnedRef.current = true;
      setHoveredIndex((current) => {
        if (current === null) return delta > 0 ? 0 : count - 1;
        return Math.max(0, Math.min(count - 1, current + delta));
      });
    },
    [visiblePoints.length],
  );
  const handlePlotKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const count = visiblePoints.length;
      if (count === 0) return;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowUp":
          event.preventDefault();
          stepHover(1);
          break;
        case "ArrowLeft":
        case "ArrowDown":
          event.preventDefault();
          stepHover(-1);
          break;
        case "Home":
          event.preventDefault();
          pinnedRef.current = true;
          setHoveredIndex(0);
          break;
        case "End":
          event.preventDefault();
          pinnedRef.current = true;
          setHoveredIndex(count - 1);
          break;
        case "Escape":
          pinnedRef.current = false;
          setHoveredIndex(null);
          break;
        default:
          break;
      }
    },
    [visiblePoints.length, stepHover],
  );
  // Focusing the plot with nothing selected snaps to the latest point so the
  // inspector always opens on a real reference; leaving it clears the selection.
  const handlePlotFocus = useCallback(() => {
    setHoveredIndex((current) => (current === null ? visiblePoints.length - 1 : current));
  }, [visiblePoints.length]);
  const handlePlotBlur = useCallback(() => {
    pinnedRef.current = false;
    setHoveredIndex(null);
  }, []);

  // Tooltip horizontal placement: keep inside the container so it never spills
  // off the right or left edge. Vertical position tracks the score dot.
  const tooltipStyle = useMemo<React.CSSProperties | null>(() => {
    if (!hoveredScorePixel) return null;
    const tooltipWidth = 240;
    const half = tooltipWidth / 2;
    let left = hoveredScorePixel.x - half;
    if (left < 4) left = 4;
    if (left + tooltipWidth > containerWidth - 4) left = containerWidth - tooltipWidth - 4;
    return {
      position: "absolute",
      left,
      // Place above the score dot by default; flip below if it would clip the
      // top of the panel.
      top: Math.max(hoveredScorePixel.y - 12, 4),
      transform: "translateY(-100%)",
      width: tooltipWidth,
    };
  }, [hoveredScorePixel, containerWidth]);

  // Stable, descriptive figure label. Updated as the latest point changes so a
  // screen-reader pass reflects the current incumbent, not just the title.
  const figureLabel = useMemo(() => {
    const count = points.length;
    if (count === 0) {
      return "Optimization progress chart, waiting for the first progress frame.";
    }
    const scoreText = formatScore(latestPoint?.currentBestScore ?? 0);
    const elapsedText = formatElapsedSeconds(latestPoint?.elapsedSeconds ?? 0);
    return `Optimization progress chart, ${count} progress ${
      count === 1 ? "frame" : "frames"
    }. Latest incumbent score ${scoreText} at ${elapsedText} elapsed.`;
  }, [points.length, latestPoint]);

  // Screen-reader announcement of the actively-inspected point, kept in a
  // polite live region so keyboard/AT users hear the full data (elapsed, score,
  // comments, solution, source) as they arrow through — the figure summary alone
  // only announces the latest point.
  const activeAnnouncement = useMemo(() => {
    if (hoveredIndex === null || !hoveredPoint) return "";
    const parts = [
      `Point ${hoveredIndex + 1} of ${visiblePointCount}`,
      `${formatElapsedSeconds(hoveredPoint.elapsedSeconds)} elapsed`,
      `score ${formatScore(hoveredPoint.currentBestScore)}`,
      `comments ${formatComments(hoveredPoint.commentCount)}`,
      `solution ${formatSolutionIndex(hoveredPoint.solutionIndex)}`,
    ];
    if (hoveredPoint.source) parts.push(`source ${hoveredPoint.source}`);
    return `${parts.join(", ")}.`;
  }, [hoveredIndex, hoveredPoint, visiblePointCount]);

  const emptyState = points.length === 0;

  return (
    <figure
      data-testid="progress-chart"
      data-empty={emptyState ? "true" : "false"}
      data-range={rangePreset}
      data-comments-shown={showComments ? "true" : "false"}
      data-dot-threshold={dotsEnabled ? "shown" : "hidden"}
      data-domain-min={domain.min.toFixed(4)}
      data-domain-max={domain.max.toFixed(4)}
      data-point-count={visiblePointCount}
      className={cn(
        // Square border, surface fill, no shadow on the figure itself — the
        // design system uses shadows only for overlays (toast/dialog/side).
        "flex flex-col border border-line bg-surface",
        className,
      )}
      ref={containerRef}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line2 px-4 py-3">
        <div>
          <h3 className="font-heading text-cardhead font-semibold tracking-tight">
            Incumbent Progress
          </h3>
          <p className="mt-1 text-meta text-ink2">
            Higher scores are better. Hover to inspect a solution.
          </p>
        </div>
        <button
          type="button"
          aria-pressed={showComments}
          aria-label={showComments ? "Hide comments panel" : "Show comments panel"}
          onClick={() => setShowComments((current) => !current)}
          className={cn(
            "inline-flex h-8 items-center gap-2 border px-3 text-meta font-medium transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-brand",
            showComments
              ? "border-line bg-panel text-ink2 hover:bg-panel/70"
              : "border-line bg-surface text-ink hover:bg-panel",
          )}
        >
          {showComments ? "Hide comments" : "Show comments"}
        </button>
      </header>

      {/* role="figure" is implicit on <figure>; the role="img" annotation lets
          AT read the summary as the chart's accessible name. The svg internals
          are aria-hidden so they don't double-read. */}
      <div className="relative select-none px-2 pt-3">
        {!emptyState && (
          <>
            {/* Focusable keyboard inspector. Wraps the visual summary so a
                keyboard user can Tab in and arrow through points; the summary's
                role="img" still keeps the SVG internals out of the AT tree. */}
            <div
              role="group"
              tabIndex={0}
              aria-label="Progress data points. Use Left and Right arrow keys to inspect each point; Home and End jump to the first and latest; Escape clears the selection."
              aria-describedby={liveRegionId}
              onKeyDown={handlePlotKeyDown}
              onFocus={handlePlotFocus}
              onBlur={handlePlotBlur}
              className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
            >
              <div role="img" id={reactLabelId} aria-label={figureLabel}>
                <div className="flex items-center justify-between px-2">
                  <p className="text-meta font-semibold" style={{ color: SCORE_COLOR_VAR }}>
                    Score
                  </p>
                  {!dotsEnabled && (
                    <p className="text-label text-ink3">Points hidden · hover to inspect</p>
                  )}
                </div>
                <ProgressPanel
                  testId="progress-chart-score-panel"
                  width={containerWidth}
                  height={SCORE_PANEL_HEIGHT}
                  plotTop={PLOT_TOP}
                  plotBottom={showComments ? PLOT_BOTTOM_SCORE_PAIRED : PLOT_BOTTOM_SCORE_SOLO}
                  xScale={xScale}
                  yScale={scoreYScale}
                  yTicks={scoreYTicks}
                  xTicks={showComments ? [] : xTicks}
                  yTickFormatter={formatCompact}
                  xTickFormatter={formatElapsedSeconds}
                  linePath={scorePath}
                  lineColorVar={SCORE_COLOR_VAR}
                  dotsEnabled={dotsEnabled}
                  pointPixels={scorePixels}
                  pointValues={visiblePoints}
                  latestPixel={latestScorePixel}
                  hoveredPixel={hoveredScorePixel}
                  hoveredX={hoveredXPixel}
                  hoveredColorVar={SCORE_COLOR_VAR}
                  onPointerMove={handleScorePointerMove}
                  onPointerDown={handlePointerDown}
                  onPointerLeave={handlePointerLeave}
                  label="Score"
                />

                {showComments && (
                  <div className="border-t border-line2 pt-2">
                    <div className="flex items-center justify-between px-2">
                      <p className="text-meta font-semibold" style={{ color: COMMENT_COLOR_VAR }}>
                        Comments
                      </p>
                      {commentSegments.length === 0 && visiblePointCount > 0 && (
                        <p className="text-label text-ink3">No comment frames in range</p>
                      )}
                    </div>
                    <ProgressPanel
                      testId="progress-chart-comment-panel"
                      width={containerWidth}
                      height={COMMENT_PANEL_HEIGHT}
                      plotTop={PLOT_TOP}
                      plotBottom={PLOT_BOTTOM_COMMENTS}
                      xScale={xScale}
                      yScale={commentYScale}
                      yTicks={commentYTicks}
                      xTicks={xTicks}
                      yTickFormatter={formatCompact}
                      xTickFormatter={formatElapsedSeconds}
                      linePath={commentPath}
                      lineColorVar={COMMENT_COLOR_VAR}
                      dotsEnabled={dotsEnabled && commentSegments.length > 0}
                      pointPixels={commentSegments}
                      pointValues={visiblePoints}
                      latestPixel={latestCommentPixel}
                      hoveredPixel={hoveredCommentPixel}
                      hoveredX={hoveredXPixel}
                      hoveredColorVar={COMMENT_COLOR_VAR}
                      onPointerMove={handleScorePointerMove}
                      onPointerDown={handlePointerDown}
                      onPointerLeave={handlePointerLeave}
                      label="Comments"
                    />
                  </div>
                )}
              </div>
            </div>

            {hoveredPoint && tooltipStyle && (
              <ProgressTooltip
                point={hoveredPoint}
                containerWidth={containerWidth}
                style={tooltipStyle}
              />
            )}
          </>
        )}
        {emptyState && (
          <div
            role="img"
            id={reactLabelId}
            aria-label={figureLabel}
            className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center"
          >
            <p className="text-body text-ink2">Waiting for the first progress frame.</p>
            <p className="text-meta text-ink3">
              The chart will populate as the solver reports incumbent solutions.
            </p>
          </div>
        )}
      </div>

      {/* Polite live region: announces the actively-inspected point for AT.
          Outside the role="img" summary so it is not pruned from the AT tree. */}
      <p id={liveRegionId} role="status" aria-live="polite" className="sr-only">
        {activeAnnouncement}
      </p>

      <footer
        className="flex flex-wrap items-center gap-1.5 border-t border-line2 bg-panel/40 px-4 py-2"
        data-testid="progress-chart-range-controls"
      >
        <span className="mr-1 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
          Range
        </span>
        {RANGE_PRESETS.map((preset) => {
          const active = rangePreset === preset.value;
          return (
            <button
              key={preset.value}
              type="button"
              aria-pressed={active}
              data-testid={`progress-chart-range-${preset.value}`}
              onClick={() => setRangePreset(preset.value)}
              className={cn(
                "inline-flex h-7 items-center px-2 text-meta font-medium transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-brand",
                active
                  ? "bg-brandtint text-brandink ring-1 ring-inset ring-brand/40"
                  : "text-ink2 hover:bg-panel hover:text-ink",
              )}
            >
              {preset.label}
            </button>
          );
        })}
        <span className="ml-auto text-label text-ink3" aria-hidden="true">
          {visiblePointCount} of {points.length} points
        </span>
      </footer>
    </figure>
  );
}

interface ProgressPanelProps {
  testId: string;
  width: number;
  height: number;
  plotTop: number;
  plotBottom: number;
  xScale: LinearScale;
  yScale: LinearScale;
  yTicks: number[];
  xTicks: number[];
  yTickFormatter: (value: number) => string;
  xTickFormatter: (value: number) => string;
  linePath: string;
  lineColorVar: string;
  dotsEnabled: boolean;
  pointPixels: ReadonlyArray<{ x: number; y: number }>;
  pointValues: readonly RunProgressPoint[];
  latestPixel: { x: number; y: number } | null;
  /** Active-point marker (the filled dot). Null when this panel has no value
   *  for the hovered point (e.g. a null comment count). */
  hoveredPixel: { x: number; y: number } | null;
  /** Crosshair x-position, independent of `hoveredPixel`, so the vertical guide
   *  stays in sync across panels even where the y-value is unavailable. */
  hoveredX: number | null;
  hoveredColorVar: string;
  onPointerMove: (event: React.PointerEvent<SVGElement>) => void;
  onPointerDown: (event: React.PointerEvent<SVGElement>) => void;
  onPointerLeave: () => void;
  label: string;
}

const ProgressPanel = function ProgressPanelImpl(props: ProgressPanelProps) {
  const {
    testId,
    width,
    height,
    plotTop,
    plotBottom,
    xScale,
    yScale,
    yTicks,
    xTicks,
    yTickFormatter,
    xTickFormatter,
    linePath,
    lineColorVar,
    dotsEnabled,
    pointPixels,
    pointValues,
    latestPixel,
    hoveredPixel,
    hoveredX,
    hoveredColorVar,
    onPointerMove,
    onPointerDown,
    onPointerLeave,
    label,
  } = props;

  const plotBottomLine = height - plotBottom;
  return (
    <svg
      data-testid={testId}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerLeave={onPointerLeave}
      style={{ display: "block", touchAction: "pan-y" }}
      className="outline-none"
    >
      {/* Horizontal gridlines at every y tick. */}
      {yTicks.map((tick) => {
        const y = scaleToPixel(yScale, tick);
        if (y < plotTop - 1 || y > plotBottomLine + 1) return null;
        return (
          <line
            key={`grid-y-${tick}`}
            x1={xScale.pixelMin}
            x2={xScale.pixelMin + xScale.pixelSpan}
            y1={y}
            y2={y}
            stroke={GRID_COLOR_VAR}
            strokeWidth={1}
            strokeDasharray="3 5"
          />
        );
      })}

      {/* X-axis baseline (only when this panel owns its x-axis). */}
      {xTicks.length > 0 && (
        <line
          x1={xScale.pixelMin}
          x2={xScale.pixelMin + xScale.pixelSpan}
          y1={plotBottomLine}
          y2={plotBottomLine}
          stroke={AXIS_COLOR_VAR}
          strokeWidth={1}
        />
      )}

      {/* Y-axis tick labels. */}
      {yTicks.map((tick) => {
        const y = scaleToPixel(yScale, tick);
        if (y < plotTop - 1 || y > plotBottomLine + 1) return null;
        return (
          <text
            key={`y-tick-${tick}`}
            x={xScale.pixelMin - 8}
            y={y + 3}
            textAnchor="end"
            fontSize={11}
            fill={TICK_COLOR_VAR}
            fontFamily="var(--ff-mono)"
          >
            {yTickFormatter(tick)}
          </text>
        );
      })}

      {/* X-axis tick marks + labels (shared between both panels via xScale). */}
      {xTicks.map((tick) => {
        const x = scaleToPixel(xScale, tick);
        if (x < xScale.pixelMin - 1 || x > xScale.pixelMin + xScale.pixelSpan + 1) {
          return null;
        }
        return (
          <g key={`x-tick-${tick}`}>
            <line
              x1={x}
              x2={x}
              y1={plotBottomLine}
              y2={plotBottomLine + 4}
              stroke={AXIS_COLOR_VAR}
              strokeWidth={1}
            />
            <text
              x={x}
              y={plotBottomLine + 18}
              textAnchor="middle"
              fontSize={11}
              fill={TICK_COLOR_VAR}
              fontFamily="var(--ff-mono)"
            >
              {xTickFormatter(tick)}
            </text>
          </g>
        );
      })}

      {/* Step-after line. */}
      {linePath && (
        <path
          d={linePath}
          fill="none"
          stroke={lineColorVar}
          strokeWidth={2.5}
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      )}

      {/* Per-point dots. */}
      {dotsEnabled &&
        pointPixels.map((pixel, i) => (
          <circle
            key={`dot-${i}-${pointValues[i]?.elapsedSeconds.toFixed(4)}`}
            cx={pixel.x}
            cy={pixel.y}
            r={3.25}
            fill={lineColorVar}
            stroke="var(--surface)"
            strokeWidth={2}
          />
        ))}

      {/* Hover crosshair — drawn for every hovered point, so the vertical guide
          stays synchronized across panels even when this panel has no value
          (e.g. a null comment count). */}
      {hoveredX !== null && (
        <line
          data-testid={`${testId}-crosshair`}
          x1={hoveredX}
          x2={hoveredX}
          y1={plotTop}
          y2={plotBottomLine}
          stroke="var(--ink3)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      )}

      {/* Active-point dot — only where this panel actually has a value. */}
      {hoveredPixel && (
        <circle
          cx={hoveredPixel.x}
          cy={hoveredPixel.y}
          r={6}
          fill={hoveredColorVar}
          stroke="var(--surface)"
          strokeWidth={2}
        />
      )}

      {/* Latest-point reference dot. */}
      {latestPixel && (
        <circle
          cx={latestPixel.x}
          cy={latestPixel.y}
          r={5.5}
          fill={lineColorVar}
          stroke="var(--surface)"
          strokeWidth={2}
          data-testid={`${testId}-latest-dot`}
        >
          <title>{`Latest ${label.toLowerCase()}`}</title>
        </circle>
      )}

      {/* Hover capture region: a transparent fill over the plot area so pointer
          moves resolve even over empty space. The pointer handlers live on the
          parent <svg> (its `currentTarget` exposes the viewBox used for the
          CSS→viewBox hover mapping), so this rect intentionally has none. */}
      <rect
        x={xScale.pixelMin}
        y={plotTop}
        width={Math.max(xScale.pixelSpan, 0)}
        height={Math.max(plotBottomLine - plotTop, 0)}
        fill="transparent"
        pointerEvents="none"
      />
    </svg>
  );
};

interface ProgressTooltipProps {
  point: RunProgressPoint;
  containerWidth: number;
  style: React.CSSProperties;
}

function ProgressTooltip({ point, style }: ProgressTooltipProps) {
  const commentText = formatComments(point.commentCount);
  const solutionText = formatSolutionIndex(point.solutionIndex);
  return (
    <div
      role="tooltip"
      data-testid="progress-chart-tooltip"
      style={style}
      className={cn("z-10 border border-line bg-surface px-3 py-2.5 text-meta", "shadow-dialog")}
    >
      <p className="mb-2 font-semibold text-ink">
        <span data-testid="progress-chart-tooltip-elapsed">
          {formatElapsedSeconds(point.elapsedSeconds)}
        </span>{" "}
        elapsed
      </p>
      <dl className="space-y-1.5">
        <div className="flex items-center justify-between gap-5">
          <dt className="flex items-center gap-1.5 text-ink2">
            <span
              aria-hidden="true"
              className="inline-block size-2"
              style={{ background: SCORE_COLOR_VAR }}
            />
            <span>Score</span>
            <span className="sr-only">:</span>
          </dt>
          <dd className="font-semibold tabular-nums" style={{ color: SCORE_COLOR_VAR }}>
            {formatScore(point.currentBestScore)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-5">
          <dt className="flex items-center gap-1.5 text-ink2">
            <span
              aria-hidden="true"
              className="inline-block size-2"
              style={{ background: COMMENT_COLOR_VAR }}
            />
            <span>Comments</span>
            <span className="sr-only">:</span>
          </dt>
          <dd className="font-semibold tabular-nums" style={{ color: COMMENT_COLOR_VAR }}>
            {commentText}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-5">
          <dt className="text-ink2">
            <span>Solution</span>
          </dt>
          <dd className="font-medium text-ink">{solutionText}</dd>
        </div>
        {point.source && (
          <div className="mt-1.5 border-t border-line2 pt-1.5">
            <dt className="sr-only">Source:</dt>
            <dd
              className="break-words text-label text-ink3"
              title={point.source}
              style={{ maxWidth: 220 }}
            >
              {point.source}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export { DOT_THRESHOLD };
