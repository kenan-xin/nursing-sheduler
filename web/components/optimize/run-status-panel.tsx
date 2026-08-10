"use client";

// T16e / B2-1 — the result panel, rendered per job-state against the prototype
// (ScreenGenerate.dc.html) and the run→outcome flow. States:
//   • idle         — centered empty state (wand + "Ready to optimise"), not a bare
//                     score skeleton.
//   • active       — live incumbent score, status badge, job detail, progress chart,
//                     and the server-authoritative cancel / get-results-now controls.
//   • success      — terminal outcome heading + a SOLVER STATUS / FINAL SCORE /
//                     ELAPSED summary grid, then the download affordance.
//   • infeasible   — dedicated panel: heading, plain explanation, and the
//                     solver-verdict reason as a compact label (never a diagnosis),
//                     plus Adjust rules (a self-contained GuardedLink). No conflict list.
//   • cancelled    — "Run cancelled" heading.
//   • failed       — structured error callout.
//
// G6.2a: the terminal ACTIONS are gone — Resubmit / Try again, Dismiss, and the
// cleanup Retry. Every one of them existed to serve the single-slot design, where a
// terminal run occupied the one session record and had to be released before another
// could start. Records are owner-keyed now; nothing occupies anything, and a second
// run is simply the exact `Optimize` action again. A second button offering to do
// the same thing would contradict the settled single-action contract.
//
// R6 v2: the terminal eyebrow lost its leading ● — DESIGN.md §5 retires decorative
// ornament on status ("no coloured leader dots on eyebrows"); the uppercase label
// and the semantic ink carry the state. Headings drop v1's `font-extrabold` /
// `tracking-tight` for the v2 weights and -0.015em (§3), and every semantic text
// tone moves from the base tier to the ink tier (see `toneTextClass`).
//
// R6 Round 9B — the DATA-BEARING values on this panel are set in the mono face.
// DESIGN.md §3 reserves Spline Sans Mono for "IDs, counts, hours and solver
// expressions — so a number always reads as data, never as prose in the wrong
// face", and D8 puts that explicit rule above the prototype's display-face
// example. Four values on this panel are data: the live incumbent score, and the
// terminal grid's SOLVER STATUS (a solver expression), FINAL SCORE and ELAPSED
// (a duration). Only the FACE changes — size, weight, tracking and the semantic
// ink tier are all retained — and the surrounding prose labels ("Higher scores
// are better.", the eyebrow, the cell captions, the job detail sentence) stay on
// the body face, because they are prose and not data.
//
// All lifecycle/controls are server-authoritative — nothing here infers a capability.
// The infeasible "Try again" and the idle CTA reuse the run-start path; "Adjust rules"
// is a GuardedLink so the panel needs no new orchestrator callback (file-disjoint from
// the run-settings/event-log work).

import {
  FaBan,
  FaBolt,
  FaCalendarCheck,
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
  type OptimizeRunView,
  type RunStatusTone,
} from "@/lib/optimize";
import { cn } from "@/lib/utils";
import { Callout } from "./callout";

export interface RunStatusPanelProps {
  view: OptimizeRunView;
  submitting: boolean;
  canDownloadAgain: boolean;
  downloadAgainFilename: string | null;
  onCancel(): void;
  onFinishNow(): void;
  onDownloadArtifact(): void;
  onDownloadAgain(): void;
  /**
   * Start a fresh run from the idle empty state (and as the in-panel Optimize CTA).
   * Optional so this component stays file-disjoint from the screen wiring — when
   * omitted, the idle panel renders its empty state without a duplicate run button
   * (the settings column already owns the primary Optimize action).
   */
  onStartRun?: () => void;
  /**
   * Whether a loadable roster was captured for the run in view. Drives the
   * `Open & adjust roster` CTA inside the completed artifact block (G4). The
   * flag is owned by the screen, which is the only place that can prove a
   * roster exists — `capture.stateFor(view.jobId).status === "committed"` —
   * so this panel renders the CTA exactly when the screen says a loadable
   * roster is on hand, and is silent for every other terminal outcome.
   */
  loadableRoster?: boolean;
}

/**
 * The status-eyebrow / summary-numeral text colour for a terminal heading.
 *
 * R6 v2: the INK tier, not the base tier. DESIGN.md §2 assigns base to "text or
 * icon **on its own tint**" and ink to the "deepest treatment — headings,
 * emphasised numerals". Both call sites here paint straight onto the L1 card, and
 * in dark mode the two tiers diverge (`--error #e58164` vs `--errorink #f09b80`),
 * so the base tier was both the wrong role and the weaker contrast.
 */
function toneTextClass(tone: RunStatusTone): string {
  switch (tone) {
    case "success":
      return "text-successink";
    case "warn":
      return "text-warnink";
    case "error":
      return "text-errorink";
    case "brand":
      return "text-brandink";
    default:
      return "text-ink3";
  }
}

export function RunStatusPanel({
  view,
  submitting,
  canDownloadAgain,
  downloadAgainFilename,
  onCancel,
  onFinishNow,
  onDownloadArtifact,
  onDownloadAgain,
  onStartRun,
  loadableRoster,
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
          {/* Prototype :62 — a dashed placeholder tile, not a solid box. */}
          <div className="mb-4 flex size-14 items-center justify-center rounded-control border border-dashed border-line text-ink3">
            <FaBolt className="size-5" aria-hidden />
          </div>
          <h3 className="font-heading text-title font-semibold tracking-[-0.015em] text-ink">
            Ready to optimise
          </h3>
          <p className="mt-1.5 max-w-[40ch] text-meta text-ink2">
            The solver searches for the highest-scoring roster that satisfies every hard rule,
            within the timeout.
          </p>
          {onStartRun ? (
            <Button onClick={onStartRun} className="mt-5" data-testid="optimize-start">
              <FaBolt aria-hidden /> Optimize
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
  const isTerminalError =
    view.lifecycle === "failed" || view.lifecycle === "cancelled" || isSubmitPre;
  // NO TERMINAL ACTIONS. `Resubmit` / `Try again` and `Dismiss` used to live here.
  //
  // Both existed to serve the single-slot design: a terminal run OCCUPIED the one
  // record, so the user needed a way to release it before starting another, and
  // `Resubmit` had to wait on that release before it could submit. Records are
  // owner-keyed now and nothing occupies anything, so a second run is just the
  // exact `Optimize` action again — which is the settled contract, and which a
  // second button beside it would quietly contradict.
  //
  // The error message stays. It is the honest report of what happened to the run
  // the user is looking at; what is gone is asking them to do something about it.

  return (
    <div className="space-y-4" data-testid="optimize-run-status">
      {/* Terminal outcome heading (completed success/infeasible + cancelled). Failed
          keeps its Callout-only presentation, so terminalHeading returns null for it. */}
      {heading !== null ? (
        <div>
          <p
            data-testid="optimize-terminal-eyebrow"
            className={cn(
              "text-meta font-semibold uppercase tracking-[0.03em]",
              toneTextClass(status.tone),
            )}
          >
            {status.label}
          </p>
          <h3 className="mt-2 font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
            {heading}
          </h3>
        </div>
      ) : null}

      {/* Success summary grid: SOLVER STATUS · FINAL SCORE · ELAPSED (proto :93-97).
          FINAL SCORE is the terminal result.score (not the progress currentBestScore);
          ELAPSED is derived from the job timestamps via @/lib/optimize. */}
      {isSuccess ? (
        <div className="flex border border-line2" data-testid="optimize-summary-grid">
          <SummaryCell
            label="Solver status"
            tone={status.tone}
            testId="optimize-summary-solver-status"
          >
            {view.result?.solverStatus ?? "—"}
          </SummaryCell>
          <SummaryCell label="Final score" testId="optimize-summary-final-score">
            {view.result?.score !== null && view.result?.score !== undefined
              ? formatScore(view.result.score)
              : "—"}
          </SummaryCell>
          <SummaryCell label="Elapsed" testId="optimize-summary-elapsed">
            {elapsedLabel(view)}
          </SummaryCell>
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
            <div className="rounded-control border border-line2 bg-panel px-2.5 py-2 font-mono text-label text-ink2 shadow-well">
              verdict: {view.result.terminationReason}
            </div>
          ) : null}
          {/* Adjust rules only. `Try again` stood beside it, and on an INFEASIBLE
              result it was the least useful button on the screen: the solver proved
              no roster satisfies the rules, so re-running the same scenario proves
              it again. The actionable move is the one that is left — change a rule,
              then use the exact `Optimize` action. */}
          <div className="flex flex-wrap gap-2">
            <GuardedLink
              href="/rules"
              className={cn(buttonVariants({ variant: "default", size: "default" }))}
              data-testid="optimize-adjust-rules"
            >
              <FaSliders className="size-4" aria-hidden /> Adjust rules
            </GuardedLink>
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
              {/* The score is data, so it takes the mono face — but the same
                  element also renders the "No incumbent yet" PROSE placeholder,
                  which is not. The face therefore follows the content: mono for a
                  real numeral, the display face for the sentence. Size, weight,
                  leading, tracking and ink are identical either way. */}
              <p
                className={cn(
                  "mt-1 text-display font-bold leading-none tracking-[-0.015em] text-ink",
                  view.latestScore !== null ? "font-mono" : "font-heading",
                )}
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
              // The VALUE carries the testid, not the line: the assembled gate's
              // ownership recovery reads this back as the volatile authority for the
              // `activation-persistence-failed` path (a real 202 whose id lives only in
              // controller state), and a hook anchored on the value cannot be defeated
              // by the "Job ID:" copy changing. Presentation is unchanged — a bare
              // <span> in a text line renders identically.
              <p className="mt-0.5 font-mono text-label text-ink3">
                Job ID: <span data-testid="optimize-job-id">{view.jobId}</span>
              </p>
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
              Schedule optimised and downloaded successfully!
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
            {/* G4 — the prototype's "Open & adjust roster" CTA. The flag is
                supplied by the screen so the panel cannot claim a roster exists
                for a non-loadable run outcome — idle, running, failed,
                infeasible-without-incumbent, capture-failed, dismissed, etc.
                The CTA targets the dedicated /roster route through the same
                guarded navigation boundary the rest of the panel uses. */}
            {loadableRoster === true ? (
              <GuardedLink
                href="/roster"
                className={cn(buttonVariants({ variant: "default", size: "default" }))}
                data-testid="optimize-open-roster"
              >
                <FaCalendarCheck className="size-4" aria-hidden /> Open &amp; adjust roster
              </GuardedLink>
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
          alert
        >
          {view.error?.message ?? "The optimisation did not complete."}
        </Callout>
      ) : null}

      {/* NO CLEANUP SURFACE. “Couldn't finish tidying up the last run” with a Retry
          stood here, and it was the clearest statement of the retired model: it
          named an internal housekeeping step, asked the user to drive it, and
          (because cleanup gated submission) made finishing it a prerequisite for
          optimising again. Cleanup is owner-keyed and invisible now — it cannot
          stand in a new run's way, so there is nothing here for a user to decide. */}
    </div>
  );
}

/**
 * One cell of the terminal success summary grid.
 *
 * All three cells carry a DATA value — a solver expression (`OPTIMAL`), a solver
 * numeral, and a duration — so the value takes the mono face (DESIGN.md §3) while
 * the caption below it stays a prose label on the body face. The testid is on the
 * VALUE element, not the cell, for the same reason the job id's is (Round 9A): a
 * hook anchored on the value cannot be defeated by the caption copy changing.
 */
function SummaryCell({
  label,
  tone,
  testId,
  children,
}: {
  label: string;
  tone?: RunStatusTone;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 border-r border-line2 px-3.5 py-3 last:border-r-0">
      <div
        data-testid={testId}
        className={cn(
          "font-mono text-title font-semibold tracking-[-0.015em]",
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
