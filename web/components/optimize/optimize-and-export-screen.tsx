"use client";

// T16e — the Optimize & Export screen. Composes the T16a run controller, T16b
// session recovery, the T16c/T16e terminal download+cleanup orchestration, the
// T16d progress chart, backend version identity, required-data readiness, and the
// bounded client observability into the old application's run experience, adapted
// to the same-origin durable BFF. It owns no protocol machinery: it projects the
// controller's authoritative view and drives server-authoritative controls.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaBolt } from "@/components/icons";
import { toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import { useScenarioStore } from "@/lib/store";
import { confirmDialog } from "@/components/shell/confirm-store";
import {
  OPTIMIZE_TIMEOUT_MAX_SECONDS,
  OPTIMIZE_TIMEOUT_MIN_SECONDS,
  createOptimizeObservability,
  deriveOptimizeReadiness,
  isActiveLifecycle,
  isSettledLifecycle,
  useOptimizeRun,
  useOptimizeServerInfo,
  useOptimizeSessionRecovery,
  useOptimizeTerminal,
  type OptimizeObservability,
  type OptimizeRunSubmitInput,
  type OptimizeRunView,
  type UseOptimizeRunDeps,
  type UseOptimizeServerInfoDeps,
  type UseOptimizeSessionRecoveryDeps,
  type UseOptimizeTerminalDeps,
} from "@/lib/optimize";
import { ReadinessBanner } from "./readiness-banner";
import { RecoveryNotice } from "./recovery-notice";
import { RunEventLog } from "./run-event-log";
import { RunOptionsForm } from "./run-options-form";
import { RunStatusPanel } from "./run-status-panel";
import { ServerIdentity } from "./server-identity";

const TIMEOUT_ERROR = "Solver timeout must be a valid positive integer.";

/** Parse the timeout field, enforcing an integer within the settled bounds. */
function parseTimeoutInput(raw: string): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false };
  const value = Number(trimmed);
  if (
    !Number.isInteger(value) ||
    value < OPTIMIZE_TIMEOUT_MIN_SECONDS ||
    value > OPTIMIZE_TIMEOUT_MAX_SECONDS
  ) {
    return { ok: false };
  }
  return { ok: true, value };
}

export interface OptimizeAndExportScreenProps {
  /** Test seams — all optional; production uses the real hooks/transport. */
  controllerDeps?: UseOptimizeRunDeps;
  recoveryDeps?: UseOptimizeSessionRecoveryDeps;
  serverInfoDeps?: UseOptimizeServerInfoDeps;
  terminalDeps?: Partial<
    Omit<UseOptimizeTerminalDeps, "controller" | "recovery" | "observability">
  >;
  observability?: OptimizeObservability;
  confirm?: (request: {
    title: string;
    description: string;
    variant?: "default" | "destructive";
    consequences?: string[];
  }) => Promise<boolean>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-line bg-surface p-5">
      <h2 className="mb-4 font-heading text-cardhead text-ink">{title}</h2>
      {children}
    </section>
  );
}

export function OptimizeAndExportScreen({
  controllerDeps,
  recoveryDeps,
  serverInfoDeps,
  terminalDeps,
  observability: observabilityProp,
  confirm = confirmDialog,
}: OptimizeAndExportScreenProps) {
  const controller = useOptimizeRun(controllerDeps);
  const recovery = useOptimizeSessionRecovery(controller, recoveryDeps);
  const serverInfo = useOptimizeServerInfo(serverInfoDeps);

  const observabilityRef = useRef<OptimizeObservability | null>(null);
  if (observabilityRef.current === null) {
    observabilityRef.current = observabilityProp ?? createOptimizeObservability();
  }
  const observability = observabilityRef.current;

  const terminal = useOptimizeTerminal({
    controller,
    recovery,
    observability,
    ...terminalDeps,
  });

  // Required-data readiness derived from the durable scenario state. Each field is
  // selected by stable reference (never a fresh object) so zustand's
  // `useSyncExternalStore` snapshot stays cached; the derivation is memoized.
  const staff = useScenarioStore((state) => state.staff);
  const shifts = useScenarioStore((state) => state.shifts);
  const shiftGroups = useScenarioStore((state) => state.shiftGroups);
  const rangeStart = useScenarioStore((state) => state.rangeStart);
  const rangeEnd = useScenarioStore((state) => state.rangeEnd);
  const readiness = useMemo(
    () => deriveOptimizeReadiness({ staff, shifts, shiftGroups, rangeStart, rangeEnd }),
    [staff, shifts, shiftGroups, rangeStart, rangeEnd],
  );

  const [prettify, setPrettify] = useState(true);
  const [anonymize, setAnonymize] = useState(true);
  const [timeoutValue, setTimeoutValue] = useState("300");
  const [timeoutError, setTimeoutError] = useState<string | null>(null);
  const [forgetPending, setForgetPending] = useState(false);

  const view = controller.view;
  const active = isActiveLifecycle(view.lifecycle);

  // --- observability emissions (bounded, client-only) ------------------------
  const runStartRef = useRef<number | null>(null);
  const lastQueueRef = useRef<number | null>(null);
  const emittedTerminalRef = useRef<string | null>(null);
  const emittedRecoveryRef = useRef<OptimizeRunView["cursorRecovery"]>(null);

  useEffect(() => {
    if (
      view.jobId !== null &&
      view.queuePosition !== null &&
      view.queuePosition !== lastQueueRef.current
    ) {
      lastQueueRef.current = view.queuePosition;
      observability.emit({
        kind: "queue-position",
        jobId: view.jobId,
        position: view.queuePosition,
      });
    }
  }, [view.jobId, view.queuePosition, observability]);

  useEffect(() => {
    // `cursorRecovery` is a fresh object only on an actual recovery signal (other
    // signals spread the same reference forward), so a reference compare dedupes
    // per recovery — comparing on `seq` would re-emit on every following frame.
    if (view.cursorRecovery !== null && view.cursorRecovery !== emittedRecoveryRef.current) {
      emittedRecoveryRef.current = view.cursorRecovery;
      observability.emit({
        kind: "cursor-recovery",
        jobId: view.jobId,
        reason: view.cursorRecovery.reason,
      });
    }
  }, [view.cursorRecovery, view.jobId, observability]);

  useEffect(() => {
    if (!isSettledLifecycle(view.lifecycle) || view.jobId === null) return;
    if (emittedTerminalRef.current === view.jobId) return;
    if (
      view.lifecycle === "completed" ||
      view.lifecycle === "cancelled" ||
      view.lifecycle === "failed"
    ) {
      emittedTerminalRef.current = view.jobId;
      const durationMs = runStartRef.current !== null ? Date.now() - runStartRef.current : null;
      observability.emit({
        kind: "job-duration",
        jobId: view.jobId,
        outcome: view.lifecycle,
        durationMs,
      });
      if (view.error?.code === "worker_lost") {
        observability.emit({ kind: "worker-loss", jobId: view.jobId });
      }
    }
  }, [view.lifecycle, view.jobId, view.error, observability]);

  // --- actions ---------------------------------------------------------------
  const buildSubmitInput = useCallback((): OptimizeRunSubmitInput | null => {
    const parsed = parseTimeoutInput(timeoutValue);
    if (!parsed.ok) {
      setTimeoutError(TIMEOUT_ERROR);
      return null;
    }
    setTimeoutError(null);
    const document = toCanonicalScenarioDocument(useScenarioStore.getState());
    return { document, anonymize, prettify, timeout: parsed.value };
  }, [anonymize, prettify, timeoutValue]);

  const onSubmit = useCallback(async () => {
    const input = buildSubmitInput();
    if (input === null) return;
    runStartRef.current = Date.now();
    emittedTerminalRef.current = null;
    lastQueueRef.current = null;
    await controller.submit(input);
  }, [buildSubmitInput, controller]);

  const onResubmit = useCallback(async () => {
    // Release the occupied slot FIRST and resubmit only if cleanup actually
    // succeeded. A failed/unproven cleanup leaves the authoritative terminal result
    // in place and surfaces retry/abandon — never an occupied-record `submit-blocked`
    // overwriting the real (e.g. worker_lost) result.
    const released = await terminal.cleanup();
    if (released !== "cleaned") return;
    const input = buildSubmitInput();
    if (input === null) return;
    runStartRef.current = Date.now();
    emittedTerminalRef.current = null;
    lastQueueRef.current = null;
    await controller.resubmit(input);
  }, [buildSubmitInput, controller, terminal]);

  // Dismiss a terminal run: release the occupied slot and return to idle. A failed
  // cleanup keeps the terminal result and shows the retry/abandon surface.
  const onDismiss = useCallback(async () => {
    const released = await terminal.cleanup();
    if (released === "cleaned") controller.reset();
  }, [controller, terminal]);

  // Explicit abandon: destructive confirmation with the server-retention warning,
  // then free the local slot (leaving the server job to retention).
  const onAbandonCleanup = useCallback(async () => {
    const confirmed = await confirm({
      title: "Abandon cleanup and free this browser?",
      description:
        "The finished run could not be released on the server. Abandoning lets you start a new run here, but the server job and any result may remain until the server releases them.",
      variant: "destructive",
      consequences: [
        "The server job/artifact may remain until it finishes or the server releases it.",
        "This browser will stop tracking the run and can start a new one.",
      ],
    });
    if (!confirmed) return;
    terminal.abandonCleanup();
  }, [confirm, terminal]);

  const onCancel = useCallback(async () => {
    if (view.jobId !== null) observability.emit({ kind: "cancellation", jobId: view.jobId });
    await controller.cancel();
  }, [controller, observability, view.jobId]);

  const onForget = useCallback(async () => {
    const confirmed = await confirm({
      title: "Forget this run and start over?",
      description: recovery.forgetWarning,
      variant: "destructive",
      consequences: [
        "An unknown backend optimization may keep running until it finishes or the server releases it.",
        "This browser will forget the run and can start a new one.",
      ],
    });
    if (!confirmed) return;
    setForgetPending(true);
    try {
      recovery.forget();
    } finally {
      setForgetPending(false);
    }
  }, [confirm, recovery]);

  // --- derived UI state ------------------------------------------------------
  // A booting recovery inspection, a blocking interrupted/unreadable record that
  // still requires Forget, OR a terminal cleanup that is still cleaning or has
  // failed to prove local record release must each block a new submission —
  // otherwise Optimize is enabled only to predictably fail with `submit-blocked`
  // from T16q's occupied slot, overwriting the authoritative terminal view.
  const recoveryBooting = !recovery.ready;
  const recoveryBlocking =
    recovery.state.kind === "interrupted" || recovery.state.kind === "unreadable";
  const cleanupBlocking =
    terminal.cleanupPhase === "cleaning" || terminal.cleanupPhase === "failed";
  const submitEnabled =
    readiness.ready &&
    serverInfo.status === "online" &&
    !active &&
    !recoveryBooting &&
    !recoveryBlocking &&
    !cleanupBlocking;
  const disabledReason = recoveryBooting
    ? "Checking for a previous optimization run…"
    : recoveryBlocking
      ? "Resolve the recovered run above (Forget it) before starting a new one."
      : cleanupBlocking
        ? "Release the finished run above (Retry cleanup or Abandon) before starting a new one."
        : !readiness.ready
          ? "Complete the missing schedule configuration before optimizing."
          : serverInfo.status !== "online"
            ? "Backend unavailable. Check that the configured backend is running."
            : null;
  const reloadRecoveryUnavailable = controller.activation?.reloadRecoveryAvailable === false;

  return (
    <div data-testid="screen" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8">
      <header className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center border border-line bg-panel">
          <FaBolt className="size-4 text-brandink" aria-hidden />
        </span>
        <div>
          <h1 className="font-heading text-title text-ink">Optimize and Export</h1>
          <p className="mt-0.5 text-meta text-ink2">
            Send the current schedule to the backend and download the generated XLSX result.
          </p>
        </div>
      </header>

      <ReadinessBanner issues={readiness.issues} />
      <RecoveryNotice
        state={recovery.state}
        resume={recovery.resume}
        reloadRecoveryUnavailable={reloadRecoveryUnavailable}
        onForget={onForget}
        forgetPending={forgetPending}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-6">
          <Section title="Setup and Run">
            <div className="space-y-5">
              <ServerIdentity info={serverInfo} />
              <RunOptionsForm
                prettify={prettify}
                anonymize={anonymize}
                timeout={timeoutValue}
                timeoutError={timeoutError}
                optionsDisabled={active || controller.isSubmitting}
                submitEnabled={submitEnabled}
                submitting={controller.isSubmitting}
                disabledReason={disabledReason}
                onPrettifyChange={setPrettify}
                onAnonymizeChange={setAnonymize}
                onTimeoutChange={setTimeoutValue}
                onSubmit={onSubmit}
              />
            </div>
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Live Result">
            <RunStatusPanel
              view={view}
              submitting={controller.isSubmitting}
              cleanupPhase={terminal.cleanupPhase}
              canDownloadAgain={terminal.canDownloadAgain}
              downloadAgainFilename={terminal.downloadAgainFilename}
              onCancel={onCancel}
              onFinishNow={controller.finishNow}
              onResubmit={onResubmit}
              onDismiss={onDismiss}
              onDownloadArtifact={terminal.downloadArtifact}
              onDownloadAgain={terminal.downloadAgain}
              onRetryCleanup={terminal.retryCleanup}
              onAbandonCleanup={onAbandonCleanup}
            />
          </Section>
        </div>
      </div>

      <RunEventLog log={view.log} active={active || controller.isSubmitting} />
    </div>
  );
}

export default OptimizeAndExportScreen;
