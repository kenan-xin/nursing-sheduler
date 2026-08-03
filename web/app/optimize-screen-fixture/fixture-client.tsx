"use client";

// T16e — client body of the Optimize & Export screen TEST FIXTURE.
//
// Renders the screen's pure presentational components in fixed, representative
// states so a real browser can exercise responsiveness, keyboard/accessibility,
// dark-mode/token behavior, recovery notices, server-authoritative controls, and
// terminal cleanup actions deterministically — with NO controller, transport, or
// direct stream. The route is gated off in production by `page.tsx`.

import { Surface, surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { ReadinessBanner } from "@/components/optimize/readiness-banner";
import { RecoveryNotice } from "@/components/optimize/recovery-notice";
import { RunEventLog } from "@/components/optimize/run-event-log";
import { RunOptionsForm } from "@/components/optimize/run-options-form";
import { RunStatusPanel } from "@/components/optimize/run-status-panel";
import { ServerIdentity } from "@/components/optimize/server-identity";
import {
  INITIAL_OPTIMIZE_RUN_VIEW,
  deriveOptimizeReadiness,
  type OptimizeRunView,
  type OptimizeServerInfo,
  type RunLogEntry,
} from "@/lib/optimize";

const noop = () => {};

function view(over: Partial<OptimizeRunView>): OptimizeRunView {
  return { ...INITIAL_OPTIMIZE_RUN_VIEW, ...over };
}

function serverInfo(over: Partial<OptimizeServerInfo>): OptimizeServerInfo {
  return {
    status: "online",
    apiVersion: "alpha",
    backendVersion: "1.0.0",
    clientVersion: "1.0.0",
    versionTier: "identical",
    unavailableReason: null,
    recheck: noop,
    ...over,
  };
}

const statusHandlers = {
  onCancel: noop,
  onFinishNow: noop,
  onResubmit: noop,
  onDismiss: noop,
  onDownloadArtifact: noop,
  onDownloadAgain: noop,
  onRetryCleanup: noop,
  onAbandonCleanup: noop,
};

const logEntry = (over: Partial<RunLogEntry>): RunLogEntry => ({
  seq: 1,
  kind: "lifecycle",
  label: "submitting",
  event: null,
  cursor: null,
  payload: null,
  detail: null,
  elapsedSeconds: null,
  occurredAt: null,
  eventTime: 1_700_000_000_000,
  ...over,
});

const runningView = view({
  lifecycle: "running",
  jobId: "opt_1",
  latestScore: 12,
  controls: { cancellable: true, earlyCompletionAvailable: true },
  progress: [
    { source: "solver", currentBestScore: 8, elapsedSeconds: 2, solutionIndex: 1, commentCount: 0 },
    {
      source: "solver",
      currentBestScore: 12,
      elapsedSeconds: 5,
      solutionIndex: 2,
      commentCount: 1,
    },
  ],
});

const completedView = view({
  lifecycle: "completed",
  jobId: "opt_1",
  latestScore: 42,
  result: {
    outcome: "optimal",
    score: 42,
    solverStatus: "OPTIMAL",
    terminationReason: "optimality_proven",
  },
  download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
});

const infeasibleView = view({
  lifecycle: "completed",
  jobId: "opt_1",
  result: {
    outcome: "infeasible",
    score: null,
    solverStatus: "INFEASIBLE",
    terminationReason: "infeasibility_proven",
  },
  download: { status: "unavailable", artifactAvailable: false, filename: null },
});

// A completed run whose artifact is genuinely absent WITHOUT being infeasible —
// the rare anomaly the generic no-artifact callout still covers (infeasible now
// has its own dedicated panel).
const noArtifactView = view({
  lifecycle: "completed",
  jobId: "opt_1",
  latestScore: 30,
  result: {
    outcome: "feasible",
    score: 30,
    solverStatus: "FEASIBLE",
    terminationReason: "limit_or_stop",
  },
  download: { status: "unavailable", artifactAvailable: false, filename: null },
});

const workerLostView = view({
  lifecycle: "failed",
  jobId: "opt_1",
  error: { source: "job", code: "worker_lost", message: "Worker lost." },
  resubmittable: true,
});

const readiness = deriveOptimizeReadiness({
  rangeStart: "",
  rangeEnd: "",
  staff: [],
  shifts: [],
  shiftGroups: [],
});

/** Same L1 card + hairline head band as the route's own `Section` (R6 v2). */
function Panel({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section
      data-testid={id}
      className={cn(
        surfaceVariants({ role: "surface", geometry: "card" }),
        // No `overflow-hidden` — see the route's own `Section`.
        "flex flex-col",
      )}
    >
      <div className="border-b border-line2 px-5 py-4">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export default function OptimizeScreenFixtureClient() {
  return (
    <Surface
      level="page"
      geometry="square"
      data-testid="optimize-fixture"
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8"
    >
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-title font-semibold tracking-[-0.015em] text-ink">
          Optimize screen fixture
        </h1>
        <ThemeToggle />
      </header>

      <Panel id="fx-readiness" title="Required-data readiness">
        <ReadinessBanner issues={readiness.issues} />
      </Panel>

      <Panel id="fx-server-online" title="Server identity — online">
        <ServerIdentity info={serverInfo({})} />
      </Panel>
      <Panel id="fx-server-mismatch" title="Server identity — version mismatch">
        <ServerIdentity
          info={serverInfo({ versionTier: "incompatible", backendVersion: "9.9.9" })}
        />
      </Panel>
      {/* The quiet informational compatibility tier — the one neutral `info`
          callout state on this screen. It was missing from the harness, so the
          neutral well had no deterministic browser coverage at all. */}
      <Panel id="fx-server-note" title="Server identity — compatibility note">
        <ServerIdentity info={serverInfo({ versionTier: "compatible", backendVersion: "1.0.1" })} />
      </Panel>
      <Panel id="fx-server-offline" title="Server identity — offline">
        <ServerIdentity
          info={serverInfo({ status: "offline", unavailableReason: "backend_unreachable" })}
        />
      </Panel>

      <Panel id="fx-options" title="Run options">
        <RunOptionsForm
          stats={{ nurses: 12, days: 28, shifts: 3, rulesOn: 5 }}
          prettify
          anonymize
          timeout="300"
          timeoutError={null}
          optionsDisabled={false}
          submitEnabled
          submitting={false}
          disabledReason={null}
          onPrettifyChange={noop}
          onAnonymizeChange={noop}
          onTimeoutChange={noop}
          onSubmit={noop}
        />
      </Panel>

      <Panel id="fx-running" title="Running with controls + chart">
        <RunStatusPanel
          view={runningView}
          submitting={false}
          cleanupPhase="idle"
          canDownloadAgain={false}
          downloadAgainFilename={null}
          {...statusHandlers}
        />
      </Panel>

      <Panel id="fx-completed" title="Completed with artifact">
        <RunStatusPanel
          view={completedView}
          submitting={false}
          cleanupPhase="idle"
          canDownloadAgain
          downloadAgainFilename="schedule.xlsx"
          {...statusHandlers}
        />
      </Panel>

      <Panel id="fx-no-artifact" title="Completed, no artifact">
        <RunStatusPanel
          view={noArtifactView}
          submitting={false}
          cleanupPhase="idle"
          canDownloadAgain={false}
          downloadAgainFilename={null}
          {...statusHandlers}
        />
      </Panel>

      <Panel id="fx-infeasible" title="Completed, infeasible">
        <RunStatusPanel
          view={infeasibleView}
          submitting={false}
          cleanupPhase="idle"
          canDownloadAgain={false}
          downloadAgainFilename={null}
          {...statusHandlers}
        />
      </Panel>

      <Panel id="fx-worker-lost" title="Worker lost — resubmit + dismiss + cleanup failed">
        <RunStatusPanel
          view={workerLostView}
          submitting={false}
          cleanupPhase="failed"
          canDownloadAgain={false}
          downloadAgainFilename={null}
          {...statusHandlers}
        />
      </Panel>

      <Panel id="fx-recovery-interrupted" title="Recovery — interrupted (Forget)">
        <RecoveryNotice
          state={{ kind: "interrupted", anonymized: true, peopleCount: 3 }}
          resume={null}
          reloadRecoveryUnavailable={false}
          onForget={noop}
          forgetPending={false}
        />
      </Panel>
      <Panel id="fx-recovery-unreadable" title="Recovery — unreadable">
        <RecoveryNotice
          state={{ kind: "unreadable" }}
          resume={null}
          reloadRecoveryUnavailable={false}
          onForget={noop}
          forgetPending={false}
        />
      </Panel>
      <Panel id="fx-recovery-degraded" title="Recovery — reload unavailable (degraded)">
        <RecoveryNotice
          state={{ kind: "none" }}
          resume={null}
          reloadRecoveryUnavailable
          onForget={noop}
          forgetPending={false}
        />
      </Panel>

      {/* NOT a Panel. `RunEventLog` is itself an L1 card (it is a top-level sibling
          on the real route), and DESIGN.md §4 rule 5 forbids stacking two surfaces of
          the same tone — wrapping it in the L1 harness Panel would have put an L1
          card inside an L1 card. The label sits on the page plane instead. */}
      <section data-testid="fx-eventlog" className="flex flex-col gap-4">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          Event log
        </h2>
        <RunEventLog
          active
          log={[
            logEntry({ seq: 1, kind: "lifecycle", label: "submitting", detail: "anonymized=true" }),
            logEntry({
              seq: 2,
              kind: "progress",
              label: "progress",
              detail: "score=12, elapsed=5s",
            }),
            logEntry({
              seq: 3,
              kind: "phase",
              label: "phase:solve",
              detail: "solve: building model",
            }),
            logEntry({
              seq: 4,
              kind: "result",
              label: "download-succeeded",
              detail: "schedule.xlsx",
            }),
          ]}
        />
      </section>
    </Surface>
  );
}
