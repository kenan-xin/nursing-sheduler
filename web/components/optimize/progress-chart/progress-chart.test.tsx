// @vitest-environment jsdom
//
// T16d — ProgressChart component tests (jsdom).
//
// jsdom never lays out, so:
//   • ResizeObserver is stubbed (the chart falls back to DEFAULT_CONTAINER_WIDTH).
//   • SVG getBoundingClientRect is stubbed to a non-zero rect for hover tests.
//
// The pure helpers (range/domain/format/scales) have their own focused node-env
// suites; these tests cover the React surface: rendering, interaction, and the
// live-x-axis effect.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RunProgressPoint } from "@/lib/optimize";
import { ProgressChart } from "./progress-chart";

// jsdom has no ResizeObserver; the chart must still render at the default
// width so its geometry assertions are deterministic.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makePoint(elapsedSeconds: number, over: Partial<RunProgressPoint> = {}): RunProgressPoint {
  return {
    source: over.source ?? "ortools/cp-sat:solution-callback",
    currentBestScore: over.currentBestScore ?? 100,
    elapsedSeconds,
    solutionIndex: over.solutionIndex ?? null,
    commentCount: over.commentCount ?? null,
  };
}

const TWO_POINTS: RunProgressPoint[] = [
  makePoint(0.5, { currentBestScore: 12, commentCount: 4, solutionIndex: 2 }),
  makePoint(1, { currentBestScore: 9, commentCount: 2, solutionIndex: 3 }),
];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProgressChart — empty state", () => {
  it("renders an empty state when no points have arrived yet", () => {
    render(<ProgressChart points={[]} />);
    const chart = screen.getByTestId("progress-chart");
    expect(chart).toHaveAttribute("data-empty", "true");
    expect(screen.getByText(/waiting for the first progress frame/i)).toBeInTheDocument();
    // No score/comment panels render in the empty state.
    expect(screen.queryByTestId("progress-chart-score-panel")).not.toBeInTheDocument();
  });
});

describe("ProgressChart — rendering", () => {
  it("renders score + comment panels with step-after path geometry by default", () => {
    render(<ProgressChart points={TWO_POINTS} />);
    const chart = screen.getByTestId("progress-chart");
    expect(chart).toHaveAttribute("data-empty", "false");
    expect(chart).toHaveAttribute("data-comments-shown", "true");

    const scorePanel = screen.getByTestId("progress-chart-score-panel");
    const commentPanel = screen.getByTestId("progress-chart-comment-panel");
    expect(scorePanel).toBeInTheDocument();
    expect(commentPanel).toBeInTheDocument();

    // The score panel renders a step-after <path>.
    const scorePath = scorePanel.querySelector("path");
    expect(scorePath).not.toBeNull();
    const d = scorePath?.getAttribute("d") ?? "";
    expect(d.startsWith("M ")).toBe(true);
    // Two points → stepAfter produces M + H + V segments.
    expect(d).toContain("H");
    expect(d).toContain("V");
  });

  it("renders the latest-point reference dot in both panels", () => {
    render(<ProgressChart points={TWO_POINTS} />);
    expect(screen.getByTestId("progress-chart-score-panel-latest-dot")).toBeInTheDocument();
    expect(screen.getByTestId("progress-chart-comment-panel-latest-dot")).toBeInTheDocument();
  });

  it("exposes the visible point count and current range on the figure", () => {
    render(<ProgressChart points={TWO_POINTS} />);
    const chart = screen.getByTestId("progress-chart");
    expect(chart).toHaveAttribute("data-point-count", "2");
    expect(chart).toHaveAttribute("data-range", "full");
  });
});

describe("ProgressChart — comments toggle", () => {
  it("hides the comments panel and reclaims the score x-axis when toggled off", () => {
    render(<ProgressChart points={TWO_POINTS} />);
    const toggle = screen.getByRole("button", { name: /hide comments panel/i });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);

    expect(screen.getByTestId("progress-chart")).toHaveAttribute("data-comments-shown", "false");
    expect(screen.queryByTestId("progress-chart-comment-panel")).not.toBeInTheDocument();
    // The score panel now carries the x-axis (x ticks render). React
    // serializes the `textAnchor` JSX prop as the kebab-case `text-anchor` DOM
    // attribute, so the selector uses the DOM form.
    const scorePanel = screen.getByTestId("progress-chart-score-panel");
    const xTicks = scorePanel.querySelectorAll('text[text-anchor="middle"]');
    expect(xTicks.length).toBeGreaterThan(0);

    // The button label and aria-pressed reflect the new state.
    const showBtn = screen.getByRole("button", { name: /show comments panel/i });
    expect(showBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("can be toggled back on, restoring the comments panel", () => {
    render(<ProgressChart points={TWO_POINTS} />);
    fireEvent.click(screen.getByRole("button", { name: /hide comments panel/i }));
    fireEvent.click(screen.getByRole("button", { name: /show comments panel/i }));
    expect(screen.getByTestId("progress-chart")).toHaveAttribute("data-comments-shown", "true");
    expect(screen.getByTestId("progress-chart-comment-panel")).toBeInTheDocument();
  });
});

describe("ProgressChart — range presets", () => {
  const DENSE = Array.from({ length: 32 }, (_, i) =>
    makePoint(i, { currentBestScore: 1000 - i, commentCount: 32 - i, solutionIndex: i }),
  );

  it("switching to Last 10 narrows the visible slice and shows dots again", () => {
    render(<ProgressChart points={DENSE} />);
    const chart = screen.getByTestId("progress-chart");
    expect(chart).toHaveAttribute("data-dot-threshold", "hidden");
    expect(chart).toHaveAttribute("data-point-count", "32");

    fireEvent.click(screen.getByTestId("progress-chart-range-last-10"));

    expect(chart).toHaveAttribute("data-range", "last-10");
    expect(chart).toHaveAttribute("data-point-count", "10");
    expect(chart).toHaveAttribute("data-dot-threshold", "shown");
  });

  it("Last 1 min narrows the domain to the trailing 60s window", () => {
    render(<ProgressChart points={DENSE} />);
    fireEvent.click(screen.getByTestId("progress-chart-range-last-minute"));
    const chart = screen.getByTestId("progress-chart");
    expect(chart).toHaveAttribute("data-range", "last-minute");

    // latest elapsed = 31s, window = 60s, so first visible index is 0 — every
    // point in DENSE is within the trailing minute. The domain's min still
    // reflects the visible slice's first point (elapsed=0).
    const minAttr = Number(chart.getAttribute("data-domain-min"));
    const maxAttr = Number(chart.getAttribute("data-domain-max"));
    expect(Number.isFinite(minAttr)).toBe(true);
    expect(Number.isFinite(maxAttr)).toBe(true);
    expect(maxAttr).toBeGreaterThanOrEqual(31);
  });

  it("Last 1 min correctly narrows when earlier points fall outside the window", () => {
    const wide = [
      makePoint(0, { currentBestScore: 100 }),
      makePoint(120, { currentBestScore: 80 }),
    ];
    render(<ProgressChart points={wide} />);
    fireEvent.click(screen.getByTestId("progress-chart-range-last-minute"));
    const chart = screen.getByTestId("progress-chart");
    expect(chart).toHaveAttribute("data-point-count", "1");
    // Single visible point — domain still has a finite non-zero span.
    const minAttr = Number(chart.getAttribute("data-domain-min"));
    const maxAttr = Number(chart.getAttribute("data-domain-max"));
    expect(minAttr).toBeLessThan(maxAttr);
    expect(maxAttr).toBeGreaterThanOrEqual(120);
  });

  it("exposes exactly the five canonical range buttons in order", () => {
    render(<ProgressChart points={DENSE} />);
    const footer = screen.getByTestId("progress-chart-range-controls");
    const buttons = within(footer).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Full",
      "Last 1 min",
      "Last 10 min",
      "Last 10",
      "Last 50",
    ]);
  });

  it("each range button reflects its active state via aria-pressed (non-color-only)", () => {
    render(<ProgressChart points={DENSE} />);
    const full = screen.getByTestId("progress-chart-range-full");
    const last10 = screen.getByTestId("progress-chart-range-last-10");
    expect(full).toHaveAttribute("aria-pressed", "true");
    expect(last10).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(last10);

    expect(full).toHaveAttribute("aria-pressed", "false");
    expect(last10).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ProgressChart — sparse + duplicate-time + no-comment safety", () => {
  it("renders a single point without producing NaN geometry", () => {
    render(<ProgressChart points={[makePoint(5, { currentBestScore: 42, commentCount: 1 })]} />);
    const chart = screen.getByTestId("progress-chart");
    expect(chart).toHaveAttribute("data-point-count", "1");

    const scorePath = screen.getByTestId("progress-chart-score-panel").querySelector("path");
    expect(scorePath).not.toBeNull();
    const d = scorePath?.getAttribute("d") ?? "";
    // A single point collapses to a "M x y" move with finite numeric coordinates.
    expect(d).toMatch(/^M /);
    expect(d).not.toContain("NaN");

    // Domain has a finite non-zero span.
    const min = Number(chart.getAttribute("data-domain-min"));
    const max = Number(chart.getAttribute("data-domain-max"));
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(min).toBeLessThan(max);
  });

  it("renders duplicate-time points without NaN", () => {
    const dup = [
      makePoint(60, { currentBestScore: 10, commentCount: 0 }),
      makePoint(60, { currentBestScore: 8, commentCount: 1 }),
    ];
    render(<ProgressChart points={dup} />);
    const d =
      screen.getByTestId("progress-chart-score-panel").querySelector("path")?.getAttribute("d") ??
      "";
    expect(d).not.toContain("NaN");
    expect(d.startsWith("M ")).toBe(true);
  });

  it("renders a no-comment stream (all commentCount=null) without crashing", () => {
    const noComments = [
      makePoint(0, { commentCount: null }),
      makePoint(10, { commentCount: null }),
    ];
    render(<ProgressChart points={noComments} />);
    // Comment panel still renders, with a "No comment frames in range" hint.
    expect(screen.getByText(/no comment frames in range/i)).toBeInTheDocument();
    // No comment latest dot.
    expect(screen.queryByTestId("progress-chart-comment-panel-latest-dot")).not.toBeInTheDocument();
  });
});

describe("ProgressChart — live x-axis extrapolation", () => {
  it("advances the x-axis max while the run is active (250ms tick)", () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValue(2250);

    try {
      render(<ProgressChart points={TWO_POINTS} isActive />);
      const chart = screen.getByTestId("progress-chart");
      // Before the interval fires, max is at least the latest point (elapsed=1).
      const initialMax = Number(chart.getAttribute("data-domain-max"));
      expect(initialMax).toBeGreaterThanOrEqual(1);

      act(() => {
        vi.advanceTimersByTime(250);
      });

      const advancedMax = Number(chart.getAttribute("data-domain-max"));
      expect(advancedMax).toBeGreaterThan(initialMax);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("freezes the x-axis at the last extrapolated position when the run goes idle", () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValue(2250);

    try {
      const { rerender } = render(<ProgressChart points={TWO_POINTS} isActive />);
      act(() => {
        vi.advanceTimersByTime(250);
      });
      const chart = screen.getByTestId("progress-chart");
      const activeMax = Number(chart.getAttribute("data-domain-max"));
      expect(activeMax).toBeGreaterThan(1);

      // isActive flips to false → interval stops, max stays at the last extrapolated value.
      rerender(<ProgressChart points={TWO_POINTS} />);
      act(() => {
        vi.advanceTimersByTime(1000); // would advance ~1s if interval were still running
      });
      expect(Number(chart.getAttribute("data-domain-max"))).toBe(activeMax);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("ProgressChart — tooltip content", () => {
  // jsdom's getBoundingClientRect returns all zeros; stub it to a realistic
  // plot rect so pointermove resolves to a meaningful point on the score panel.
  function stubBoundingRect() {
    const original = SVGElement.prototype.getBoundingClientRect;
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: SVGElement) {
        // Only the score panel uses the rect for hover; return a 800-wide rect
        // positioned at the origin so clientX maps directly to data-x.
        if (this.getAttribute("data-testid") === "progress-chart-score-panel") {
          return {
            width: 800,
            height: 250,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: 250,
            right: 800,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return original.call(this);
      },
    );
  }

  it("renders score, comments, solution index, and source on hover", () => {
    stubBoundingRect();
    render(<ProgressChart points={TWO_POINTS} />);

    const scorePanel = screen.getByTestId("progress-chart-score-panel");
    // Hover near the right edge → nearest point is the second one (x=1s).
    fireEvent.pointerMove(scorePanel, { clientX: 700, clientY: 100 });

    const tooltip = screen.getByTestId("progress-chart-tooltip");
    expect(tooltip).toBeInTheDocument();
    // Each row has a text label (non-color-only semantics).
    expect(within(tooltip).getByText("Score")).toBeInTheDocument();
    expect(within(tooltip).getByText("Comments")).toBeInTheDocument();
    expect(within(tooltip).getByText("Solution")).toBeInTheDocument();
    // Source is always present per the T16a contract; it appears with sr-only label.
    expect(within(tooltip).getByText(/ortools/i)).toBeInTheDocument();
    // Header shows formatted elapsed time.
    expect(within(tooltip).getByText(/1\.0s|1s elapsed/i)).toBeInTheDocument();
  });

  it("shows 'N/A' for missing comment count and missing solution index", () => {
    stubBoundingRect();
    const sparse = [
      makePoint(1, { commentCount: null, solutionIndex: null }),
      makePoint(2, { commentCount: null, solutionIndex: null }),
    ];
    render(<ProgressChart points={sparse} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");
    fireEvent.pointerMove(scorePanel, { clientX: 700, clientY: 100 });
    const tooltip = screen.getByTestId("progress-chart-tooltip");
    // The canonical old chart / FR-OE-64 require "N/A" (not a dash): one for
    // comments, one for solution.
    const placeholders = within(tooltip).getAllByText("N/A");
    expect(placeholders).toHaveLength(2);
    // The dash must be gone entirely.
    expect(within(tooltip).queryByText("—")).not.toBeInTheDocument();
  });

  it("clears the tooltip on pointer leave", () => {
    stubBoundingRect();
    render(<ProgressChart points={TWO_POINTS} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");
    fireEvent.pointerMove(scorePanel, { clientX: 700, clientY: 100 });
    expect(screen.getByTestId("progress-chart-tooltip")).toBeInTheDocument();
    fireEvent.pointerLeave(scorePanel);
    expect(screen.queryByTestId("progress-chart-tooltip")).not.toBeInTheDocument();
  });
});

describe("ProgressChart — keyboard inspection", () => {
  const THREE = [
    makePoint(0, { currentBestScore: 100, commentCount: 5, solutionIndex: 0 }),
    makePoint(10, { currentBestScore: 80, commentCount: 3, solutionIndex: 1 }),
    makePoint(20, { currentBestScore: 60, commentCount: 1, solutionIndex: 2 }),
  ];

  function plotGroup() {
    return screen.getByRole("group", { name: /use left and right arrow keys/i });
  }

  it("exposes a focusable plot group with an accessible instruction label", () => {
    render(<ProgressChart points={THREE} />);
    const group = plotGroup();
    expect(group).toHaveAttribute("tabindex", "0");
    expect(group.getAttribute("aria-label")?.toLowerCase()).toContain("arrow");
  });

  // The tooltip header renders the elapsed value in a dedicated testid span, so
  // reading it uniquely identifies the actively-inspected point.
  function activeElapsed(): string {
    return screen.getByTestId("progress-chart-tooltip-elapsed").textContent?.trim() ?? "";
  }

  it("focusing the plot selects the latest point and opens the tooltip", () => {
    render(<ProgressChart points={THREE} />);
    fireEvent.focus(plotGroup());
    // Latest point elapsed = 20s.
    expect(activeElapsed()).toBe("20s");
  });

  it("Arrow keys walk points and Home/End jump to the ends", () => {
    render(<ProgressChart points={THREE} />);
    const group = plotGroup();
    fireEvent.focus(group); // → latest (index 2, 20s)
    expect(activeElapsed()).toBe("20s");

    fireEvent.keyDown(group, { key: "ArrowLeft" }); // → index 1 (10s)
    expect(activeElapsed()).toBe("10s");

    fireEvent.keyDown(group, { key: "Home" }); // → index 0 (0.0s)
    expect(activeElapsed()).toBe("0.0s");

    fireEvent.keyDown(group, { key: "ArrowRight" }); // → index 1 (10s)
    expect(activeElapsed()).toBe("10s");

    fireEvent.keyDown(group, { key: "End" }); // → index 2 (20s)
    expect(activeElapsed()).toBe("20s");
  });

  it("Escape clears the selection and blur exits the inspector", () => {
    render(<ProgressChart points={THREE} />);
    const group = plotGroup();
    fireEvent.focus(group);
    expect(screen.getByTestId("progress-chart-tooltip")).toBeInTheDocument();

    fireEvent.keyDown(group, { key: "Escape" });
    expect(screen.queryByTestId("progress-chart-tooltip")).not.toBeInTheDocument();

    fireEvent.focus(group);
    expect(screen.getByTestId("progress-chart-tooltip")).toBeInTheDocument();
    fireEvent.blur(group);
    expect(screen.queryByTestId("progress-chart-tooltip")).not.toBeInTheDocument();
  });

  it("announces the active point's full data (elapsed/score/comments/solution) in a live region", () => {
    const { container } = render(<ProgressChart points={THREE} />);
    const group = plotGroup();
    fireEvent.focus(group);
    fireEvent.keyDown(group, { key: "Home" }); // first point

    const describedBy = group.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const live = container.querySelector(`#${describedBy}`);
    expect(live).not.toBeNull();
    expect(live).toHaveAttribute("role", "status");
    const text = live?.textContent ?? "";
    expect(text).toContain("Point 1 of 3");
    expect(text).toContain("comments");
    expect(text).toContain("solution #0");
  });
});

describe("ProgressChart — synchronized crosshair on null comments", () => {
  function stubBoundingRect() {
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: SVGElement) {
        if (this.getAttribute("data-testid") === "progress-chart-score-panel") {
          return {
            width: 800,
            height: 250,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: 250,
            right: 800,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 0,
          right: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  }

  it("keeps the comment-panel crosshair when the hovered point has a null comment count", () => {
    stubBoundingRect();
    // First point has a comment; second point's comment is null.
    const points = [
      makePoint(1, { currentBestScore: 10, commentCount: 4, solutionIndex: 0 }),
      makePoint(2, { currentBestScore: 8, commentCount: null, solutionIndex: 1 }),
    ];
    render(<ProgressChart points={points} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");

    // Hover far right → nearest point is the second one (null comment).
    fireEvent.pointerMove(scorePanel, { clientX: 780, clientY: 100 });

    // Both panels keep the vertical crosshair (synchronized inspection line).
    expect(screen.getByTestId("progress-chart-score-panel-crosshair")).toBeInTheDocument();
    expect(screen.getByTestId("progress-chart-comment-panel-crosshair")).toBeInTheDocument();

    // The two crosshairs share the same x (vertical sync across panels).
    const scoreX = screen.getByTestId("progress-chart-score-panel-crosshair").getAttribute("x1");
    const commentX = screen
      .getByTestId("progress-chart-comment-panel-crosshair")
      .getAttribute("x1");
    expect(scoreX).toBe(commentX);

    // Tooltip still reads the comment value as N/A for the null point.
    const tooltip = screen.getByTestId("progress-chart-tooltip");
    expect(within(tooltip).getByText("N/A")).toBeInTheDocument();
  });
});

describe("ProgressChart — touch / pen tap inspection", () => {
  function stubScoreRect() {
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: SVGElement) {
        if (this.getAttribute("data-testid") === "progress-chart-score-panel") {
          return {
            width: 800,
            height: 250,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: 250,
            right: 800,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 0,
          right: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  }

  it("a touch tap selects the nearest point and retains it after the finger lifts", () => {
    stubScoreRect();
    render(<ProgressChart points={TWO_POINTS} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");

    // Tap near the right edge → nearest point is the second (x=1s). A touch tap
    // fires pointerdown then pointerup/pointerleave when the finger lifts.
    fireEvent.pointerDown(scorePanel, { pointerType: "touch", clientX: 700, clientY: 100 });
    fireEvent.pointerLeave(scorePanel);

    // Selection is RETAINED — the tooltip and both crosshairs stay visible.
    const tooltip = screen.getByTestId("progress-chart-tooltip");
    expect(tooltip).toBeInTheDocument();
    expect(screen.getByTestId("progress-chart-score-panel-crosshair")).toBeInTheDocument();
    expect(screen.getByTestId("progress-chart-comment-panel-crosshair")).toBeInTheDocument();
  });

  it("a second tap on the same point clears the retained selection", () => {
    stubScoreRect();
    render(<ProgressChart points={TWO_POINTS} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");

    fireEvent.pointerDown(scorePanel, { pointerType: "touch", clientX: 700, clientY: 100 });
    fireEvent.pointerLeave(scorePanel);
    expect(screen.getByTestId("progress-chart-tooltip")).toBeInTheDocument();

    fireEvent.pointerDown(scorePanel, { pointerType: "touch", clientX: 700, clientY: 100 });
    expect(screen.queryByTestId("progress-chart-tooltip")).not.toBeInTheDocument();
  });

  it("a tap in the y-axis gutter (outside the plot band) clears the selection", () => {
    stubScoreRect();
    render(<ProgressChart points={TWO_POINTS} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");

    fireEvent.pointerDown(scorePanel, { pointerType: "touch", clientX: 700, clientY: 100 });
    fireEvent.pointerLeave(scorePanel);
    expect(screen.getByTestId("progress-chart-tooltip")).toBeInTheDocument();

    // clientX=5 is left of the plot-left gutter (PLOT_LEFT=60) beyond the slop.
    fireEvent.pointerDown(scorePanel, { pointerType: "touch", clientX: 5, clientY: 100 });
    expect(screen.queryByTestId("progress-chart-tooltip")).not.toBeInTheDocument();
  });

  it("a pen tap retains selection identically to touch", () => {
    stubScoreRect();
    render(<ProgressChart points={TWO_POINTS} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");
    fireEvent.pointerDown(scorePanel, { pointerType: "pen", clientX: 700, clientY: 100 });
    fireEvent.pointerLeave(scorePanel);
    expect(screen.getByTestId("progress-chart-tooltip")).toBeInTheDocument();
  });

  it("does not regress mouse hover: moving away still clears (mouse is never pinned)", () => {
    stubScoreRect();
    render(<ProgressChart points={TWO_POINTS} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");
    fireEvent.pointerMove(scorePanel, { pointerType: "mouse", clientX: 700, clientY: 100 });
    expect(screen.getByTestId("progress-chart-tooltip")).toBeInTheDocument();
    fireEvent.pointerLeave(scorePanel);
    expect(screen.queryByTestId("progress-chart-tooltip")).not.toBeInTheDocument();
  });

  it("a touch tap on a null-comment point keeps the comment crosshair and reads N/A", () => {
    stubScoreRect();
    const points = [
      makePoint(1, { currentBestScore: 10, commentCount: 4, solutionIndex: 0 }),
      makePoint(2, { currentBestScore: 8, commentCount: null, solutionIndex: 1 }),
    ];
    render(<ProgressChart points={points} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");

    fireEvent.pointerDown(scorePanel, { pointerType: "touch", clientX: 780, clientY: 100 });
    fireEvent.pointerLeave(scorePanel);

    // Comment crosshair persists; no comment dot; tooltip comment reads N/A.
    expect(screen.getByTestId("progress-chart-comment-panel-crosshair")).toBeInTheDocument();
    const tooltip = screen.getByTestId("progress-chart-tooltip");
    expect(within(tooltip).getByText("N/A")).toBeInTheDocument();
  });
});

describe("ProgressChart — accessibility", () => {
  it("exposes a role=img figure label that summarizes the current state", () => {
    const { container } = render(<ProgressChart points={TWO_POINTS} />);
    const img = container.querySelector('[role="img"]');
    expect(img).not.toBeNull();
    const label = img?.getAttribute("aria-label") ?? "";
    expect(label.toLowerCase()).toContain("optimization progress chart");
    expect(label.toLowerCase()).toContain("frames");
  });

  it("reflects the empty-state label when there are no points yet", () => {
    const { container } = render(<ProgressChart points={[]} />);
    const label = container.querySelector('[role="img"]')?.getAttribute("aria-label") ?? "";
    expect(label.toLowerCase()).toContain("waiting");
  });

  it("keeps the SVG internals aria-hidden so they don't double-read", () => {
    render(<ProgressChart points={TWO_POINTS} />);
    const scorePanel = screen.getByTestId("progress-chart-score-panel");
    expect(scorePanel).toHaveAttribute("aria-hidden", "true");
  });
});
