import { describe, expect, it } from "vitest";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView, type RunProgressPoint } from "./run-view";
import {
  elapsedLabel,
  formatElapsedSeconds,
  formatRunStatus,
  formatScore,
  jobDetailLine,
  scoreLabel,
  terminalHeading,
} from "./run-display";

function view(over: Partial<OptimizeRunView>): OptimizeRunView {
  return { ...INITIAL_OPTIMIZE_RUN_VIEW, ...over };
}

const point = (over: Partial<RunProgressPoint> = {}): RunProgressPoint => ({
  source: "solver",
  currentBestScore: 10,
  elapsedSeconds: 5,
  solutionIndex: 3,
  commentCount: 2,
  ...over,
});

describe("formatScore", () => {
  it("formats to at most two fraction digits", () => {
    expect(formatScore(42)).toBe("42");
    expect(formatScore(42.129)).toBe("42.13");
  });
});

describe("formatRunStatus", () => {
  it("is Idle when nothing has run", () => {
    expect(formatRunStatus(INITIAL_OPTIMIZE_RUN_VIEW, false)).toEqual({
      label: "Idle",
      tone: "neutral",
    });
  });
  it("shows the queue position", () => {
    expect(formatRunStatus(view({ lifecycle: "queued", queuePosition: 4 }), false)).toEqual({
      label: "Queued, position 4",
      tone: "brand",
    });
  });
  it("shows the solver status on a successful completion", () => {
    const v = view({
      lifecycle: "completed",
      result: { outcome: "optimal", score: 9, solverStatus: "OPTIMAL", terminationReason: null },
    });
    expect(formatRunStatus(v, false)).toEqual({ label: "OPTIMAL", tone: "success" });
  });
  it("marks an infeasible completion as a warning", () => {
    const v = view({
      lifecycle: "completed",
      result: {
        outcome: "infeasible",
        score: null,
        solverStatus: "INFEASIBLE",
        terminationReason: null,
      },
    });
    expect(formatRunStatus(v, false)).toEqual({ label: "Infeasible", tone: "warn" });
  });
  it("distinguishes a worker-lost failure", () => {
    const v = view({
      lifecycle: "failed",
      error: { source: "job", code: "worker_lost", message: "lost" },
    });
    expect(formatRunStatus(v, false)).toEqual({ label: "Worker lost", tone: "error" });
  });
});

describe("scoreLabel", () => {
  it("is live while running and final on completion", () => {
    expect(scoreLabel(view({ lifecycle: "running" }))).toBe("Live Incumbent Score");
    expect(
      scoreLabel(
        view({
          lifecycle: "completed",
          result: {
            outcome: "optimal",
            score: 9,
            solverStatus: "OPTIMAL",
            terminationReason: null,
          },
        }),
      ),
    ).toBe("Final Score");
    expect(scoreLabel(INITIAL_OPTIMIZE_RUN_VIEW)).toBe("Score");
  });
});

describe("jobDetailLine", () => {
  it("reports no run when idle", () => {
    expect(jobDetailLine(INITIAL_OPTIMIZE_RUN_VIEW, false)).toBe(
      "No optimization has been started.",
    );
  });
  it("reports the queue wait with a position", () => {
    expect(
      jobDetailLine(view({ lifecycle: "queued", jobId: "opt_1", queuePosition: 2 }), false),
    ).toBe("Waiting in optimization queue at position 2.");
  });
  it("waits for the first solution while running with no incumbent", () => {
    expect(
      jobDetailLine(view({ lifecycle: "running", jobId: "opt_1", latestScore: null }), false),
    ).toBe("Waiting for first feasible solution…");
  });
  it("summarizes the live incumbent from the latest progress point", () => {
    const v = view({ lifecycle: "running", jobId: "opt_1", latestScore: 10, progress: [point()] });
    expect(jobDetailLine(v, false)).toBe("Solution #3 · 5s elapsed · 2 comments · solver");
  });
});

describe("formatElapsedSeconds", () => {
  it("uses a tenth-second ladder below 10s", () => {
    expect(formatElapsedSeconds(0)).toBe("0.0s");
    expect(formatElapsedSeconds(8.46)).toBe("8.5s");
  });
  it("rounds whole seconds under a minute", () => {
    expect(formatElapsedSeconds(42)).toBe("42s");
    expect(formatElapsedSeconds(59.6)).toBe("60s");
  });
  it("formats sub-hour durations as Xm YYs", () => {
    expect(formatElapsedSeconds(125)).toBe("2m 05s");
  });
  it("formats hour-plus durations as Xh YYm", () => {
    expect(formatElapsedSeconds(3725)).toBe("1h 02m");
  });
});

describe("elapsedLabel (terminal grid)", () => {
  it("derives max(0, finished − started) from the job timestamps", () => {
    const v = view({
      lifecycle: "completed",
      startedAt: "2026-07-20T00:00:01+00:00",
      finishedAt: "2026-07-20T00:00:19.4+00:00",
    });
    // 18.4s — the final duration, never the last progress frame's elapsedSeconds.
    // The ladder rounds to whole seconds once ≥ 10s.
    expect(elapsedLabel(v)).toBe("18s");
  });
  it("clamps a clock-skew (finished before started) to zero, not negative", () => {
    const v = view({
      lifecycle: "completed",
      startedAt: "2026-07-20T00:00:10+00:00",
      finishedAt: "2026-07-20T00:00:05+00:00",
    });
    expect(elapsedLabel(v)).toBe("0.0s");
  });
  it("shows — when a timestamp is absent", () => {
    expect(elapsedLabel(view({ lifecycle: "completed", startedAt: null, finishedAt: null }))).toBe(
      "—",
    );
    expect(
      elapsedLabel(
        view({ lifecycle: "completed", startedAt: "2026-07-20T00:00:01+00:00", finishedAt: null }),
      ),
    ).toBe("—");
  });
  it("shows — when a timestamp fails to parse", () => {
    expect(
      elapsedLabel(
        view({ lifecycle: "completed", startedAt: "not-a-date", finishedAt: "2026-07-20+00:00" }),
      ),
    ).toBe("—");
  });
});

describe("terminalHeading", () => {
  it("names an optimal / feasible completion", () => {
    expect(
      terminalHeading(
        view({
          lifecycle: "completed",
          result: {
            outcome: "optimal",
            score: 1,
            solverStatus: "OPTIMAL",
            terminationReason: null,
          },
        }),
      ),
    ).toBe("Optimal roster found");
    expect(
      terminalHeading(
        view({
          lifecycle: "completed",
          result: {
            outcome: "feasible",
            score: 1,
            solverStatus: "FEASIBLE",
            terminationReason: "solver_timeout",
          },
        }),
      ),
    ).toBe("A feasible roster was found");
  });
  it("names an infeasible completion", () => {
    expect(
      terminalHeading(
        view({
          lifecycle: "completed",
          result: {
            outcome: "infeasible",
            score: null,
            solverStatus: "INFEASIBLE",
            terminationReason: "infeasibility_proven",
          },
        }),
      ),
    ).toBe("This roster can't be built");
  });
  it("names a cancellation", () => {
    expect(terminalHeading(view({ lifecycle: "cancelled" }))).toBe("Run cancelled");
  });
  it("is null for failed, active, and idle lifecycles", () => {
    expect(terminalHeading(view({ lifecycle: "failed" }))).toBeNull();
    expect(terminalHeading(view({ lifecycle: "running" }))).toBeNull();
    expect(terminalHeading(INITIAL_OPTIMIZE_RUN_VIEW)).toBeNull();
  });
});
