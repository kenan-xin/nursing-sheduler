"use client";

// T16e — the live-result panel: score, status, job detail, the progress chart,
// server-authoritative controls (cancel / get-results-now), the terminal-outcome
// rendering (success download, no-artifact reason, structured error, resubmit),
// tab-lifetime Download Again, and the cleanup retry/abandon affordances. All
// lifecycle/controls are server-authoritative — nothing here infers a capability.

import { FaBan, FaCircleCheck, FaDownload, FaSpinner } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressChart } from "@/components/optimize/progress-chart";
import {
  formatRunStatus,
  formatScore,
  isActiveLifecycle,
  jobDetailLine,
  scoreLabel,
  WORKER_LOST_CODE,
  type CleanupPhase,
  type OptimizeRunView,
} from "@/lib/optimize";
import { Callout } from "./callout";

export interface RunStatusPanelProps {
  view: OptimizeRunView;
  submitting: boolean;
  cleanupPhase: CleanupPhase;
  canDownloadAgain: boolean;
  downloadAgainFilename: string | null;
  onCancel(): void;
  onFinishNow(): void;
  onResubmit(): void;
  /** Clean up (release) a terminal run and return to idle. */
  onDismiss(): void;
  onDownloadArtifact(): void;
  onDownloadAgain(): void;
  onRetryCleanup(): void;
  onAbandonCleanup(): void;
}

export function RunStatusPanel({
  view,
  submitting,
  cleanupPhase,
  canDownloadAgain,
  downloadAgainFilename,
  onCancel,
  onFinishNow,
  onResubmit,
  onDismiss,
  onDownloadArtifact,
  onDownloadAgain,
  onRetryCleanup,
  onAbandonCleanup,
}: RunStatusPanelProps) {
  const status = formatRunStatus(view, submitting);
  const active = isActiveLifecycle(view.lifecycle);
  const download = view.download;
  const isCompleted = view.lifecycle === "completed";
  const isTerminalError =
    view.lifecycle === "failed" ||
    view.lifecycle === "cancelled" ||
    view.lifecycle === "submit-blocked" ||
    view.lifecycle === "submit-rejected" ||
    view.lifecycle === "submit-unknown";
  const workerLost = view.error?.code === WORKER_LOST_CODE;
  // Every cancelled/failed run (including non-resubmittable ordinary cancel and
  // process_timeout) must have a safe release path — a Dismiss that cleans up the
  // occupied slot and returns to idle. Resubmit is offered additionally when the
  // server marked the run resubmittable (worker_lost / a clean submit rejection).
  const canDismiss = view.lifecycle === "cancelled" || view.lifecycle === "failed";
  const terminalActions =
    view.resubmittable || canDismiss ? (
      <>
        {view.resubmittable ? (
          <Button size="sm" onClick={onResubmit} data-testid="optimize-resubmit">
            {workerLost ? "Resubmit" : "Try again"}
          </Button>
        ) : null}
        {canDismiss ? (
          <Button size="sm" variant="outline" onClick={onDismiss} data-testid="optimize-dismiss">
            Dismiss
          </Button>
        ) : null}
      </>
    ) : undefined;

  return (
    <div className="space-y-4" data-testid="optimize-run-status">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            {scoreLabel(view)}
          </p>
          <p
            className="mt-1 font-heading text-display leading-none text-ink"
            data-testid="optimize-score"
          >
            {view.latestScore !== null ? formatScore(view.latestScore) : "No incumbent yet"}
          </p>
          <p className="mt-1 text-meta text-ink3">Higher scores are better.</p>
        </div>
        <Badge variant={status.tone} data-testid="optimize-status">
          {status.label}
        </Badge>
      </div>

      <div>
        <p className="text-meta text-ink2" data-testid="optimize-job-detail">
          {jobDetailLine(view, submitting)}
        </p>
        {view.jobId !== null ? (
          <p className="mt-0.5 font-mono text-label text-ink3">Job ID: {view.jobId}</p>
        ) : null}
      </div>

      {view.progress.length >= 2 ? (
        <ProgressChart points={view.progress} isActive={active} />
      ) : null}

      {active ? (
        <div className="flex flex-wrap gap-2" data-testid="optimize-controls">
          <Button
            variant="secondary"
            onClick={onFinishNow}
            disabled={!view.controls.earlyCompletionAvailable || view.lifecycle === "cancelling"}
            data-testid="optimize-finish-now"
          >
            <FaDownload aria-hidden /> Get Results Now
          </Button>
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={!view.controls.cancellable || view.lifecycle === "cancelling"}
            data-testid="optimize-cancel"
          >
            <FaBan aria-hidden />
            {view.lifecycle === "cancelling" ? "Cancelling…" : "Cancel"}
          </Button>
        </div>
      ) : null}

      {/* Non-terminal transport/control error (server lifecycle unchanged). */}
      {view.error !== null && active ? (
        <Callout tone="warn" data-testid="optimize-transient-error" alert>
          {view.error.message}
        </Callout>
      ) : null}

      {isCompleted && download.artifactAvailable ? (
        <div className="space-y-2" data-testid="optimize-completed-artifact">
          {download.status === "downloaded" ? (
            <Callout tone="success" icon={FaCircleCheck}>
              Schedule optimized and downloaded successfully!
            </Callout>
          ) : download.status === "downloading" ? (
            <Callout tone="info" icon={FaSpinner}>
              Preparing your schedule download…
            </Callout>
          ) : (
            <Callout tone="error" alert>
              {view.error?.message ?? "The schedule download did not complete."}
            </Callout>
          )}
          <div className="flex flex-wrap gap-2">
            {download.status !== "downloading" && download.status !== "downloaded" ? (
              <Button onClick={onDownloadArtifact} data-testid="optimize-download">
                <FaDownload aria-hidden /> Download schedule
              </Button>
            ) : null}
            {canDownloadAgain ? (
              <Button
                variant="outline"
                onClick={onDownloadAgain}
                data-testid="optimize-download-again"
              >
                <FaDownload aria-hidden /> Download Again
                {downloadAgainFilename !== null ? (
                  <span className="text-ink3">· {downloadAgainFilename}</span>
                ) : null}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {isCompleted && !download.artifactAvailable ? (
        <Callout tone="warn" data-testid="optimize-no-artifact" alert>
          No downloadable schedule is available. Job outcome:{" "}
          {view.result?.outcome ?? view.lifecycle}
          {view.result?.terminationReason !== null && view.result?.terminationReason !== undefined
            ? ` (${view.result.terminationReason})`
            : ""}
          .
        </Callout>
      ) : null}

      {isTerminalError ? (
        <Callout
          tone={view.lifecycle === "cancelled" ? "warn" : "error"}
          data-testid="optimize-terminal-error"
          actions={terminalActions}
          alert
        >
          {view.error?.message ?? "The optimization did not complete."}
        </Callout>
      ) : null}

      {cleanupPhase === "failed" ? (
        <Callout
          tone="warn"
          data-testid="optimize-cleanup-failed"
          title="Couldn't release the finished run on the server"
          actions={
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={onRetryCleanup}
                data-testid="optimize-cleanup-retry"
              >
                Retry cleanup
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onAbandonCleanup}
                data-testid="optimize-cleanup-abandon"
              >
                Abandon
              </Button>
            </>
          }
          alert
        >
          This run stays reserved until cleanup succeeds or you abandon it. Abandoning frees this
          browser to start a new run; the server job remains until it is released by retention.
        </Callout>
      ) : null}

      {cleanupPhase === "abandoned" ? (
        <Callout tone="info" data-testid="optimize-cleanup-abandoned">
          Cleanup abandoned. The server job will be released by retention.
        </Callout>
      ) : null}
    </div>
  );
}
