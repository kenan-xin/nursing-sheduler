import { describe, expect, it } from "vitest";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView, type RunProgressPoint } from "./run-view";
import { formatRunStatus, formatScore, jobDetailLine, scoreLabel } from "./run-display";

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
