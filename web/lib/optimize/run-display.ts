// T16e — pure presentation helpers for the run status panel. Kept free of React so
// the status label/tone, score label, and job-detail line are unit-testable and
// stay faithful to the old application's copy (page.tsx `formatRunStatus`,
// `formatProgressSummary`, and the job-detail line).

import { parseIsoDateTime } from "@/lib/time/iso-date-time";
import type { OptimizeRunView, RunProgressPoint } from "./run-view";
import { WORKER_LOST_CODE } from "./run-view";

/** Placeholder shown when a value cannot be derived (a missing timestamp). */
const MISSING_ELAPSED_TEXT = "—";

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

/**
 * Format an elapsed-seconds value like the live timer (the progress chart's
 * `formatElapsedSeconds` ladder, reimplemented here so `@/lib/optimize` stays
 * free of a `components/` dependency):
 *   • < 10s    → "x.x s"
 *   • < 60s    → "x s"
 *   • < 1h     → "Xm YYs"
 *   • ≥ 1h     → "Xh YYm"
 */
export function formatElapsedSeconds(value: number): string {
  if (value < 10) return `${value.toFixed(1)}s`;
  if (value < 60) return `${Math.round(value)}s`;
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

/**
 * ELAPSED for the terminal success grid: `max(0, finished_at − started_at)`
 * from the job's timestamps (Contract C2 `JobResponse`) — NEVER the last
 * progress frame's `elapsedSeconds` (a fast run may have no progress frame at
 * all, and a queued wait must not be counted). Shows `—` when either
 * timestamp is absent or fails to parse.
 */
export function elapsedLabel(view: OptimizeRunView): string {
  if (view.startedAt === null || view.finishedAt === null) return MISSING_ELAPSED_TEXT;
  const started = parseIsoDateTime(view.startedAt);
  const finished = parseIsoDateTime(view.finishedAt);
  if (started === null || finished === null) return MISSING_ELAPSED_TEXT;
  const seconds =
    finished.seconds - started.seconds + (finished.nanoseconds - started.nanoseconds) / 1e9;
  return formatElapsedSeconds(Math.max(0, seconds));
}

/**
 * The large terminal-outcome heading (proto `ScreenGenerate.dc.html:88-89,315`),
 * shown above the success grid / infeasible panel / cancelled notice — not just
 * the status Badge. Null for every non-terminal lifecycle and for `failed`
 * (which keeps its existing Callout-only presentation).
 */
export function terminalHeading(view: OptimizeRunView): string | null {
  if (view.lifecycle === "completed") {
    switch (view.result?.outcome) {
      case "optimal":
        return "Optimal roster found";
      case "feasible":
        return "A feasible roster was found";
      case "infeasible":
        return "This roster can't be built";
      default:
        return null;
    }
  }
  if (view.lifecycle === "cancelled") return "Run cancelled";
  return null;
}
