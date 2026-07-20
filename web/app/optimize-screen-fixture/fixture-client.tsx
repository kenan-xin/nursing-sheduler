"use client";

// T16e — client body of the Optimize & Export screen TEST FIXTURE.
//
// Renders the screen's pure presentational components in fixed, representative
// states so a real browser can exercise responsiveness, keyboard/accessibility,
// dark-mode/token behavior, recovery notices, server-authoritative controls, and
// terminal cleanup actions deterministically — with NO controller, transport, or
// direct stream. The route is gated off in production by `page.tsx`.

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
    versionMismatch: false,
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

const noArtifactView = view({
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

function Panel({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section data-testid={id} className="border border-line bg-surface p-5">
      <h2 className="mb-4 font-heading text-cardhead text-ink">{title}</h2>
      {children}
    </section>
  );
}

export default function OptimizeScreenFixtureClient() {
  return (
    <div
      data-testid="optimize-fixture"
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8"
    >
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-title text-ink">Optimize screen fixture</h1>
        <ThemeToggle />
      </header>

      <Panel id="fx-readiness" title="Required-data readiness">
        <ReadinessBanner issues={readiness.issues} />
      </Panel>

      <Panel id="fx-server-online" title="Server identity — online">
        <ServerIdentity info={serverInfo({})} />
      </Panel>
      <Panel id="fx-server-mismatch" title="Server identity — version mismatch">
        <ServerIdentity info={serverInfo({ versionMismatch: true, backendVersion: "9.9.9" })} />
      </Panel>
      <Panel id="fx-server-offline" title="Server identity — offline">
        <ServerIdentity
          info={serverInfo({ status: "offline", unavailableReason: "backend_unreachable" })}
        />
      </Panel>

      <Panel id="fx-options" title="Run options">
        <RunOptionsForm
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

      <Panel id="fx-eventlog" title="Event log">
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
      </Panel>
    </div>
  );
}
