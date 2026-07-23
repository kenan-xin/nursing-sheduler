"use client";

// T16e / B2-1 — the result panel, rendered per job-state against the prototype
// (ScreenGenerate.dc.html) and the run→outcome flow. States:
//   • idle         — centered empty state (wand + "Ready to optimise"), not a bare
//                     score skeleton.
//   • active       — live incumbent score, status badge, job detail, progress chart,
//                     and the server-authoritative cancel / get-results-now controls.
//   • success      — terminal outcome heading + a SOLVER STATUS / FINAL SCORE /
//                     ELAPSED summary grid, then the download affordance.
//   • infeasible   — dedicated panel: heading, plain explanation, the solver-verdict
//                     reason as a compact label (never a diagnosis), and Adjust rules
//                     (a self-contained GuardedLink) + Try again CTAs. No conflict list.
//   • cancelled    — "Run cancelled" heading + the release affordance (Dismiss).
//   • failed       — structured error callout; worker_lost additionally offers Resubmit.
//
// All lifecycle/controls are server-authoritative — nothing here infers a capability.
// The infeasible "Try again" and the idle CTA reuse the run-start path; "Adjust rules"
// is a GuardedLink so the panel needs no new orchestrator callback (file-disjoint from
// the run-settings/event-log work).

import {
  FaArrowRotateRight,
  FaBan,
  FaBolt,
  FaCircleCheck,
  FaDownload,
  FaSliders,
  FaSpinner,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { GuardedLink } from "@/components/shell/guarded-link";
import { ProgressChart } from "@/components/optimize/progress-chart";
import {
  elapsedLabel,
  formatRunStatus,
  formatScore,
  isActiveLifecycle,
  jobDetailLine,
  scoreLabel,
  terminalHeading,
  WORKER_LOST_CODE,
  type CleanupPhase,
  type OptimizeRunView,
  type RunStatusTone,
} from "@/lib/optimize";
import { cn } from "@/lib/utils";
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
  /**
   * Start a fresh run from the idle empty state (and as the in-panel Optimize CTA).
   * Optional so this component stays file-disjoint from the screen wiring — when
   * omitted, the idle panel renders its empty state without a duplicate run button
   * (the settings column already owns the primary Optimize action).
   */
  onStartRun?: () => void;
}

/** The status-eyebrow text colour for a terminal heading. */
function toneTextClass(tone: RunStatusTone): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "warn":
      return "text-warn";
    case "error":
      return "text-error";
    case "brand":
      return "text-brandink";
    default:
      return "text-ink3";
  }
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
  onStartRun,
}: RunStatusPanelProps) {
  const status = formatRunStatus(view, submitting);
  const active = isActiveLifecycle(view.lifecycle);
  const download = view.download;

  // Truly idle: nothing has been started (the controller's submitting flag masks the
  // brief window before the reducer flips lifecycle to "submitting"). Show the centered
  // empty state instead of the bare "No incumbent yet" score skeleton.
  if (view.lifecycle === "idle" && !submitting) {
    return (
      <div className="space-y-4" data-testid="optimize-run-status">
        <div
          className="flex flex-col items-center justify-center px-6 py-11 text-center"
          data-testid="optimize-idle"
        >
          <div className="mb-4 flex size-14 items-center justify-center border border-line text-ink3">
            <FaBolt className="size-5" aria-hidden />
          </div>
          <h3 className="font-heading text-title font-extrabold tracking-tight text-ink">
            Ready to optimise
          </h3>
          <p className="mt-1.5 max-w-[40ch] text-meta text-ink2">
            The solver searches for the highest-scoring roster that satisfies every hard rule,
            within the timeout.
          </p>
          {onStartRun ? (
            <Button onClick={onStartRun} className="mt-5" data-testid="optimize-start">
              <FaBolt aria-hidden /> Optimize roster
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const isCompleted = view.lifecycle === "completed";
  const outcome = view.result?.outcome;
  const isSuccess = isCompleted && (outcome === "optimal" || outcome === "feasible");
  const isInfeasible = isCompleted && outcome === "infeasible";
  const isSubmitPre =
    view.lifecycle === "submit-blocked" ||
    view.lifecycle === "submit-rejected" ||
    view.lifecycle === "submit-unknown";
  // The live score header (label + incumbent + badge + detail) renders for every
  // non-idle state EXCEPT the terminal success/infeasible outcomes, which present a
  // dedicated outcome block instead.
  const showLiveHeader = !isSuccess && !isInfeasible;
  const heading = terminalHeading(view);
  const workerLost = view.error?.code === WORKER_LOST_CODE;
  // Every cancelled/failed run (including non-resubmittable ordinary cancel and
  // process_timeout) must have a safe release path — a Dismiss that cleans up the
  // occupied slot and returns to idle. Resubmit is offered additionally when the
  // server marked the run resubmittable (worker_lost / a clean submit rejection).
  const canDismiss = view.lifecycle === "cancelled" || view.lifecycle === "failed";
  const isTerminalError =
    view.lifecycle === "failed" || view.lifecycle === "cancelled" || isSubmitPre;
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
      {/* Terminal outcome heading (completed success/infeasible + cancelled). Failed
          keeps its Callout-only presentation, so terminalHeading returns null for it. */}
      {heading !== null ? (
        <div>
          <p
            className={cn(
              "text-meta font-semibold uppercase tracking-[0.03em]",
              toneTextClass(status.tone),
            )}
          >
            ● {status.label}
          </p>
          <h3 className="mt-2 font-heading text-cardhead font-extrabold tracking-tight text-ink">
            {heading}
          </h3>
        </div>
      ) : null}

      {/* Success summary grid: SOLVER STATUS · FINAL SCORE · ELAPSED (proto :93-97).
          FINAL SCORE is the terminal result.score (not the progress currentBestScore);
          ELAPSED is derived from the job timestamps via @/lib/optimize. */}
      {isSuccess ? (
        <div className="flex border border-line2" data-testid="optimize-summary-grid">
          <SummaryCell label="Solver status" tone={status.tone}>
            {view.result?.solverStatus ?? "—"}
          </SummaryCell>
          <SummaryCell label="Final score">
            {view.result?.score !== null && view.result?.score !== undefined
              ? formatScore(view.result.score)
              : "—"}
          </SummaryCell>
          <SummaryCell label="Elapsed">{elapsedLabel(view)}</SummaryCell>
        </div>
      ) : null}

      {/* Infeasible dedicated panel: explanation + the solver verdict as a compact
          label + Adjust rules / Try again. NO per-conflict list (no backend source). */}
      {isInfeasible ? (
        <div className="space-y-3" data-testid="optimize-infeasible">
          <p className="text-meta text-ink2">
            The solver proved no roster satisfies every hard rule. Loosen a hard rule and try again.
          </p>
          {view.result?.terminationReason !== null &&
          view.result?.terminationReason !== undefined ? (
            <div className="border border-line2 bg-panel px-2.5 py-2 font-mono text-label text-ink2">
              verdict: {view.result.terminationReason}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <GuardedLink
              href="/rules"
              className={cn(buttonVariants({ variant: "default", size: "default" }))}
              data-testid="optimize-adjust-rules"
            >
              <FaSliders className="size-4" aria-hidden /> Adjust rules
            </GuardedLink>
            <Button variant="outline" onClick={onResubmit} data-testid="optimize-try-again">
              <FaArrowRotateRight aria-hidden /> Try again
            </Button>
          </div>
        </div>
      ) : null}

      {/* Live score header + status badge + job detail (active / submitting / pre-job
          / cancelled / failed). Hidden for the dedicated success/infeasible blocks. */}
      {showLiveHeader ? (
        <>
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
        </>
      ) : null}

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

      {/* A completed run that is neither infeasible nor carrying an artifact: a rare
          anomaly (infeasible is handled by its dedicated panel above). */}
      {isCompleted && !download.artifactAvailable && !isInfeasible ? (
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

/** One cell of the terminal success summary grid. */
function SummaryCell({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: RunStatusTone;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 border-r border-line2 px-3.5 py-3 last:border-r-0">
      <div
        className={cn(
          "font-heading text-title font-extrabold",
          tone !== undefined ? toneTextClass(tone) : "text-ink",
        )}
      >
        {children}
      </div>
      <div className="mt-0.5 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
        {label}
      </div>
    </div>
  );
}
