"use client";

// T16e — the Optimize & Export screen. Composes the T16a run controller, T16b
// session recovery, the T16c/T16e terminal download+cleanup orchestration, the
// T16d progress chart, backend version identity, required-data readiness, and the
// bounded client observability into the old application's run experience, adapted
// to the same-origin durable BFF. It owns no protocol machinery: it projects the
// controller's authoritative view and drives server-authoritative controls.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { rangeDayCount } from "@/lib/dates";
import { toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import type { CardsByKind } from "@/lib/scenario";
import { useScenarioStore } from "@/lib/store";
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
  useRosterCapture,
  type OptimizeObservability,
  type UseRosterCaptureDeps,
  type OptimizeRunSubmitInput,
  type OptimizeRunView,
  type UseOptimizeRunDeps,
  type UseOptimizeServerInfoDeps,
  type UseOptimizeSessionRecoveryDeps,
  type UseOptimizeTerminalDeps,
} from "@/lib/optimize";
import { CaptureNotice } from "./capture-notice";
import { Callout } from "./callout";
import { RosterSection } from "@/components/roster-viewer/roster-section";
import { ReadinessBanner } from "./readiness-banner";
import { RecoveryNotice } from "./recovery-notice";
import { RunEventLog } from "./run-event-log";
import { RunOptionsForm } from "./run-options-form";
import { RunStatusPanel } from "./run-status-panel";
import { ServerIdentity } from "./server-identity";

const TIMEOUT_ERROR = "Solver timeout must be a valid positive integer.";

/**
 * RULES ON — the count of ENABLED rule cards (not the total), mirroring the
 * Guided Rules screen's own "{onCount} OF {total} RULES ON" semantics
 * (`components/guided-rules/rules-screen.tsx`): the always-on built-in
 * structural rule (`components/guided-rules/builtins.ts` — exactly one today,
 * "at most one shift per day", never disableable) plus every card across the
 * five constraint kinds whose `disabled` flag is not set.
 */
function countEnabledRules(cardsByKind: CardsByKind): number {
  const BUILTIN_RULE_COUNT = 1;
  const enabledCards =
    cardsByKind.requirements.filter((card) => !card.disabled).length +
    cardsByKind.successions.filter((card) => !card.disabled).length +
    cardsByKind.counts.filter((card) => !card.disabled).length +
    cardsByKind.affinities.filter((card) => !card.disabled).length +
    cardsByKind.coverings.filter((card) => !card.disabled).length;
  return BUILTIN_RULE_COUNT + enabledCards;
}

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
  /**
   * Seams for the roster capture gate's three collaborators (F1 storage, the B3
   * `/roster` client, F3's assembler). The gate ITSELF is always created here —
   * there is no way to run this screen without a real capture gate wired into the
   * real terminal chain, which is what makes the production path the tested path.
   */
  captureDeps?: UseRosterCaptureDeps;
  observability?: OptimizeObservability;
}

/**
 * One L1 route card (DESIGN.md §4): `--surface` + `--line` hairline + `--sh-1` on
 * `--r-card`, with the prototype's hairline-separated head band
 * (ScreenGenerate.dc.html:30-31) rather than v1's flat bordered box. The head band
 * draws only a bottom edge, so it needs no radius of its own and leaves no corner
 * sliver inside the rounded card.
 */
function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={cn(
        surfaceVariants({ role: "surface", geometry: "card" }),
        // No `overflow-hidden`: the head band draws only a bottom edge, so nothing
        // paints into the rounded corners and needs clipping — and the nested
        // chart's absolutely-positioned tooltip must be free to escape the card.
        "flex flex-col",
      )}
    >
      <div className="border-b border-line2 px-5 py-4">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
      </div>
      <div className="flex-1 p-5">{children}</div>
    </section>
  );
}

export function OptimizeAndExportScreen({
  controllerDeps,
  recoveryDeps,
  serverInfoDeps,
  terminalDeps,
  captureDeps,
  observability: observabilityProp,
}: OptimizeAndExportScreenProps) {
  const controller = useOptimizeRun(controllerDeps);
  const recovery = useOptimizeSessionRecovery(controller, recoveryDeps);
  const serverInfo = useOptimizeServerInfo(serverInfoDeps);

  const observabilityRef = useRef<OptimizeObservability | null>(null);
  if (observabilityRef.current === null) {
    observabilityRef.current = observabilityProp ?? createOptimizeObservability();
  }
  const observability = observabilityRef.current;

  // The one app-lifetime capture gate. It is created BEFORE the terminal hook and
  // passed in, so the default production path fetches `/roster`, assembles and
  // commits a candidate, and gates the terminal DELETE on the resulting token.
  const capture = useRosterCapture(captureDeps);

  const terminal = useOptimizeTerminal({
    controller,
    recovery,
    observability,
    capture: capture.gate,
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

  // B2-2 — the scenario stat grid (NURSES / DAYS / SHIFTS / RULES ON) rendered
  // with the run settings (proto ScreenGenerate.dc.html:32-37).
  const cardsByKind = useScenarioStore((state) => state.cardsByKind);
  const runOptionsStats = useMemo(
    () => ({
      nurses: staff.length,
      days: rangeDayCount({ start: rangeStart, end: rangeEnd }),
      shifts: shifts.length,
      rulesOn: countEnabledRules(cardsByKind),
    }),
    [staff, rangeStart, rangeEnd, shifts, cardsByKind],
  );

  const [prettify, setPrettify] = useState(true);
  const [anonymize, setAnonymize] = useState(true);
  const [timeoutValue, setTimeoutValue] = useState("300");
  const [timeoutError, setTimeoutError] = useState<string | null>(null);
  const [capturePending, setCapturePending] = useState(false);
  // The one plain-language failure the hidden pre-submit step can produce. It is a
  // boolean, not a message from the protocol: the copy is settled and must never
  // vary with the internal reason.
  const [startFailed, setStartFailed] = useState(false);

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
    setStartFailed(false);
    // ONE attempt per tab, spanning the hidden pre-submit housekeeping AND the
    // request. The gate cannot be mount-local: between the POST leaving and the job
    // activating, this run's own durable record is still provisional, so a route
    // remount in that window would read it as a prior interrupted attempt, retire it,
    // and send a second POST. Joining the tab's in-flight attempt is what prevents
    // that; a genuinely new run is gated by the record itself (active ⇒ blocked).
    const prepared = await recovery.runOptimizeAttempt(async () => {
      runStartRef.current = Date.now();
      emittedTerminalRef.current = null;
      lastQueueRef.current = null;
      await controller.submit(input);
    });
    // A prior attempt this click joined has already reported its own outcome; showing
    // the failure again here is still correct, because nothing was submitted either way.
    if (prepared.status !== "ready") setStartFailed(true);
  }, [buildSubmitInput, controller, recovery]);

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

  // Discard the saved roster for the run in view. The gate proves the local removal
  // before any server cleanup is authorized, so a failure here leaves both the
  // candidate and the job alone and surfaces a retry.
  const onDismissCapture = useCallback(async () => {
    setCapturePending(true);
    try {
      await terminal.dismissCapture();
    } finally {
      setCapturePending(false);
    }
  }, [terminal]);

  const onCancel = useCallback(async () => {
    if (view.jobId !== null) observability.emit({ kind: "cancellation", jobId: view.jobId });
    await controller.cancel();
  }, [controller, observability, view.jobId]);

  // --- derived UI state ------------------------------------------------------
  // A booting inspection, a still-running previous run, OR a terminal cleanup that is
  // still cleaning or has failed to prove local record release must each block a new
  // submission — otherwise Optimize is enabled only to predictably fail with
  // `submit-blocked` from T16q's occupied slot, overwriting the authoritative
  // terminal view.
  //
  // An INTERRUPTED record is deliberately NOT blocking any more: Optimize retires it
  // invisibly. An UNREADABLE one is not blocking either — the button stays live and
  // the click reports plainly that optimisation could not start, rather than the
  // screen explaining a recovery record the user was never meant to know about.
  const recoveryBooting = !recovery.ready;
  const recoveryBlocking = recovery.state.kind === "resumable";
  const cleanupBlocking =
    terminal.cleanupPhase === "cleaning" || terminal.cleanupPhase === "failed";
  const submitEnabled =
    readiness.ready &&
    serverInfo.status === "online" &&
    !active &&
    !recoveryBooting &&
    !recoveryBlocking &&
    !cleanupBlocking;
  // `cleanupBlocking` is checked BEFORE `recoveryBlocking`: a terminal run whose
  // local release failed still occupies the record slot, so both are true at once,
  // and the actionable one — the retry/abandon surface already on screen — is the
  // one worth naming.
  const disabledReason = recoveryBooting
    ? "Checking for a previous optimisation run…"
    : cleanupBlocking
      ? "Finish tidying up the last run above before starting a new one."
      : recoveryBlocking
        ? "An optimisation from this browser is still running. Wait for it to finish before starting another."
        : !readiness.ready
          ? "Complete the missing schedule configuration before optimising."
          : serverInfo.status !== "online"
            ? "Backend unavailable. Check that the configured backend is running."
            : null;
  const reloadRecoveryUnavailable = controller.activation?.reloadRecoveryAvailable === false;

  return (
    <Surface
      level="page"
      geometry="square"
      data-testid="screen"
      data-screen="Optimize and Export"
      className="flex flex-col gap-4"
    >
      {/* v2 page head (ScreenGenerate.dc.html:11-15): label eyebrow in `--brandink`,
          then the Display step — Figtree 700 / 1.15 / -0.015em (DESIGN.md §3). v1 ran
          this screen at Title weight behind an icon tile the prototype does not have. */}
      <header className="flex flex-col gap-2">
        <div className="text-label font-semibold uppercase tracking-[0.03em] text-brandink">
          Output · Optimise &amp; Export
        </div>
        <h1 className="font-heading text-display font-bold leading-[1.15] tracking-[-0.015em] text-ink">
          Optimise and Export
        </h1>
        <p className="max-w-[66ch] text-ink2">
          Send the current schedule to the backend and download the generated XLSX result.
        </p>
      </header>

      {/* Backend status bar (prototype :19-27) — hoisted out of the run-settings
          card so server identity reads across the whole route, as designed. */}
      <div
        data-testid="optimize-server-bar"
        className={cn(surfaceVariants({ role: "surface", geometry: "card" }), "px-4 py-3")}
      >
        <ServerIdentity info={serverInfo} />
      </div>

      <ReadinessBanner issues={readiness.issues} />
      {startFailed ? (
        <Callout tone="error" placement="page" data-testid="optimize-start-failed" alert>
          Optimisation could not start. Click Optimize to try again. If it keeps happening, start a
          New schedule.
        </Callout>
      ) : null}
      <RecoveryNotice
        state={recovery.state}
        resume={recovery.resume}
        reloadRecoveryUnavailable={reloadRecoveryUnavailable}
      />
      <CaptureNotice
        state={capture.stateFor(view.jobId)}
        onRetry={terminal.retryCapture}
        onDismiss={onDismissCapture}
        dismissPending={capturePending}
      />

      {/* `.ns-grid2` — an even two-up at 900px with a `--space-4` gap, items-start
          (ScreenGenerate.dc.html:27). This had drifted on three counts: `lg` (1024px)
          held one column for 124px longer than the design, `gap-6` ran 8px wide, and
          the 1fr/1.1fr split gave the right pane 5% more than the class allows. */}
      <div className="grid items-stretch gap-4 grid2:grid-cols-2">
        <Section title="Setup and Run" testId="optimize-run-settings-card">
          <RunOptionsForm
            stats={runOptionsStats}
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
        </Section>

        <Section title="Live Result" testId="optimize-live-result-card">
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
            // The idle-panel CTA must respect the SAME submission gates as the
            // settings-form Optimize button — wire it only when a run is actually
            // permitted, so an offline / not-ready / recovery- or cleanup-blocked
            // idle screen can't submit through it (which would risk overwriting a
            // retained terminal view with `submit-blocked`). When not submittable
            // the idle panel shows the explainer only; the settings button carries
            // the disabled reason.
            onStartRun={submitEnabled ? onSubmit : undefined}
          />
        </Section>
      </div>

      <RunEventLog log={view.log} active={active || controller.isSubmitting} />

      {/* F4 — the read-only roster surface. Renders the working roster in the
          three lenses, or the empty/candidate states. Candidate Load/Retry/
          Dismiss are roster-result actions wired through the F2 capture gate. */}
      {/* The section's candidate actions are keyed to the DURABLE pointer's
          `{jobId, candidateVersion}`, not to whatever run is in the panel above.
          It therefore does not receive this screen's current-run callbacks. */}
      <RosterSection capture={capture} />
    </Surface>
  );
}

export default OptimizeAndExportScreen;
