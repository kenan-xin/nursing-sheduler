// T16e — pure presentation helpers for the run status panel. Kept free of React so
// the status label/tone, score label, and job-detail line are unit-testable and
// stay faithful to the old application's copy (page.tsx `formatRunStatus`,
// `formatProgressSummary`, and the job-detail line).

import type { OptimizeRunView, RunProgressPoint } from "./run-view";
import { WORKER_LOST_CODE } from "./run-view";

export type RunStatusTone = "neutral" | "brand" | "success" | "warn" | "error";

export interface RunStatusDisplay {
  label: string;
  tone: RunStatusTone;
}

/** A compact number format (up to two fraction digits), matching the old page. */
export function formatScore(score: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(score);
}

/** The heading above the score, mirroring the old app's live/final distinction. */
export function scoreLabel(view: OptimizeRunView): string {
  if (isRunActive(view)) return "Live Incumbent Score";
  if (view.result?.score !== null && view.result?.score !== undefined) return "Final Score";
  return "Score";
}

/** Whether the run is in a live, server-attached phase. */
function isRunActive(view: OptimizeRunView): boolean {
  return (
    view.lifecycle === "submitting" ||
    view.lifecycle === "queued" ||
    view.lifecycle === "running" ||
    view.lifecycle === "cancelling"
  );
}

/** The status badge label + tone for the current run view. */
export function formatRunStatus(view: OptimizeRunView, submitting: boolean): RunStatusDisplay {
  switch (view.lifecycle) {
    case "idle":
      return submitting ? { label: "Starting", tone: "brand" } : { label: "Idle", tone: "neutral" };
    case "submitting":
      return { label: "Starting", tone: "brand" };
    case "submit-blocked":
      return { label: "Blocked", tone: "error" };
    case "submit-rejected":
      return { label: "Rejected", tone: "error" };
    case "submit-unknown":
      return { label: "Interrupted", tone: "warn" };
    case "queued":
      return {
        label: view.queuePosition !== null ? `Queued, position ${view.queuePosition}` : "Queued",
        tone: "brand",
      };
    case "running":
      return { label: "Running", tone: "brand" };
    case "cancelling":
      return { label: "Cancelling", tone: "warn" };
    case "completed":
      if (view.result?.outcome === "infeasible") return { label: "Infeasible", tone: "warn" };
      return { label: view.result?.solverStatus ?? "Completed", tone: "success" };
    case "cancelled":
      return { label: "Cancelled", tone: "warn" };
    case "failed":
      return {
        label: view.error?.code === WORKER_LOST_CODE ? "Worker lost" : "Failed",
        tone: "error",
      };
  }
}

/** The most recent progress point (the live incumbent), or null. */
function latestProgress(view: OptimizeRunView): RunProgressPoint | null {
  return view.progress.length > 0 ? view.progress[view.progress.length - 1] : null;
}

/**
 * The one-line job detail beneath the score, mirroring the old app's phrasing for
 * the queue, the pre-first-solution wait, the live incumbent summary, and the
 * terminal state.
 */
export function jobDetailLine(view: OptimizeRunView, submitting: boolean): string {
  if (view.jobId === null && !submitting && view.lifecycle === "idle") {
    return "No optimization has been started.";
  }
  if (view.lifecycle === "submitting" || view.lifecycle === "queued") {
    return view.queuePosition !== null
      ? `Waiting in optimization queue at position ${view.queuePosition}.`
      : "Waiting in optimization queue.";
  }
  if (
    (view.lifecycle === "running" || view.lifecycle === "cancelling") &&
    view.latestScore === null
  ) {
    return "Waiting for first feasible solution…";
  }
  const point = latestProgress(view);
  if (point !== null) {
    const parts = [
      point.solutionIndex !== null ? `Solution #${point.solutionIndex}` : "Incumbent",
      `${point.elapsedSeconds}s elapsed`,
    ];
    if (point.commentCount !== null) parts.push(`${point.commentCount} comments`);
    parts.push(point.source);
    return parts.join(" · ");
  }
  if (view.jobId !== null) return `Job ${view.jobId}`;
  return "No optimization has been started.";
}
