"use client";

// T16e — the Optimize & Export screen. Composes the T16a run controller, the
// T16c/T16e terminal download+cleanup orchestration, the T16d progress chart,
// backend version identity, required-data readiness, and the bounded client
// observability into the old application's run experience, adapted to the
// same-origin durable BFF. It owns no protocol machinery: it projects the
// controller's authoritative view and drives server-authoritative controls.
//
// G6.2 — THE VISIT IS THE UNIT. Arriving here is always a fresh start: nothing is
// inspected, resumed, polled, downloaded or captured because of a previous run,
// and no previous run can disable `Optimize`. Leaving abandons the current run
// from the user's point of view immediately — the attempt is revoked
// synchronously, so no late callback can download a file, publish a notice, or
// mutate a later mount — and hands the exact job and owner to an invisible
// retirement lane. The recovery hook, the “still running” notice, the pre-submit
// retirement and the boot auto-download that used to live here are gone, not
// hidden; what replaced them is the attempt registry below.
//
// G4 closure — the roster viewer moved to its own `/roster` route. This screen
// no longer mounts the F4 surface; the prototype-faithful `Open & adjust roster`
// CTA surfaces the result and routes through the shared guarded navigation
// boundary to the dedicated page. The capture gate itself still lives here
// (it is app-lifetime and shared with the /roster screen).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { rangeDayCount } from "@/lib/dates";
import { toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import type { CardsByKind } from "@/lib/scenario";
import {
  drainScenarioCommands,
  readAuthoritativeScenarioOwnership,
  scenarioCommands,
  useAuthorityStore,
  useScenarioStore,
} from "@/lib/store";
import { toast } from "sonner";
import {
  OPTIMIZE_TIMEOUT_MAX_SECONDS,
  OPTIMIZE_TIMEOUT_MIN_SECONDS,
  acquireSessionStorage,
  createAttemptRegistry,
  createOptimizeObservability,
  deriveOptimizeReadiness,
  isActiveLifecycle,
  isSettledLifecycle,
  migrateLegacySession,
  retireAbandonedRun,
  retireOnDocumentExit,
  useOptimizeRun,
  useOptimizeServerInfo,
  useOptimizeTerminal,
  useRosterCapture,
  type AttemptRegistry,
  type OptimizeObservability,
  type RetireAbandonedRunDeps,
  type UseRosterCaptureDeps,
  type OptimizeRunSubmitInput,
  type OptimizeRunView,
  type UseOptimizeRunDeps,
  type UseOptimizeServerInfoDeps,
  type UseOptimizeTerminalDeps,
} from "@/lib/optimize";
import { CaptureNotice } from "./capture-notice";
import { Callout } from "./callout";
import { ReadinessBanner } from "./readiness-banner";
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
  serverInfoDeps?: UseOptimizeServerInfoDeps;
  terminalDeps?: Partial<
    Omit<UseOptimizeTerminalDeps, "controller" | "attempts" | "observability">
  >;
  /** Seams for the invisible retirement lane a route exit / new click enqueues. */
  retirementDeps?: Partial<RetireAbandonedRunDeps>;
  /**
   * Seams for the roster capture gate's three collaborators (F1 storage, the B3
   * `/roster` client, F3's assembler). The gate ITSELF is always created here —
   * the app-lifetime singleton survives navigation to /roster (the dedicated
   * screen reaches the SAME gate through `useRosterCapture`), so there is no
   * way to run Optimize without a real capture gate wired into the real
   * terminal chain, which is what makes the production path the tested path.
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
  serverInfoDeps,
  terminalDeps,
  captureDeps,
  retirementDeps,
  observability: observabilityProp,
}: OptimizeAndExportScreenProps) {
  // INTENT 5 — the observability instance is built BEFORE the controller so the
  // controller can report basis degradations into the SAME bounded buffer the
  // terminal orchestration and the run emissions below use. An explicitly injected
  // `controllerDeps.observability` still wins.
  const observabilityRef = useRef<OptimizeObservability | null>(null);
  if (observabilityRef.current === null) {
    observabilityRef.current = observabilityProp ?? createOptimizeObservability();
  }
  const observability = observabilityRef.current;

  const controller = useOptimizeRun({ observability, ...controllerDeps });
  const serverInfo = useOptimizeServerInfo(serverInfoDeps);

  // The visit's attempt registry. Mount-scoped ON PURPOSE: this is the authority
  // that says "the user is still here for this run", and a route unmount is
  // exactly the event that ends it. (The capture gate below is app-lifetime for
  // the opposite reason — its tokens must outlive a remount so a second DELETE is
  // never authorized. The two lifetimes encode the two-lane split.)
  const attemptsRef = useRef<AttemptRegistry | null>(null);
  if (attemptsRef.current === null) attemptsRef.current = createAttemptRegistry();
  const attempts = attemptsRef.current;

  // The one app-lifetime capture gate. It is created BEFORE the terminal hook and
  // passed in, so the default production path fetches `/roster`, assembles and
  // commits a candidate, and gates the terminal DELETE on the resulting token.
  const capture = useRosterCapture(captureDeps);

  const terminal = useOptimizeTerminal({
    controller,
    attempts,
    observability,
    capture: capture.gate,
    ...terminalDeps,
  });

  // --- abandonment ----------------------------------------------------------
  //
  // One function for both events that end a run's audience: navigating away, and
  // clicking Optimize again. They differ only in what happens next.
  //
  // The ordering is the contract. Revocation is FIRST and synchronous, so by the
  // time anything else runs there is already no path by which a late callback can
  // download, dispatch, or publish. The gate fence is second, for the same reason
  // one level down. Only then is the invisible retirement enqueued, and it is
  // never awaited by anything the user is waiting on.
  const retirementRef = useRef(retirementDeps);
  retirementRef.current = retirementDeps;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const captureRef = useRef(capture);
  captureRef.current = capture;

  /**
   * End the current attempt's audience.
   *
   * `exit` names WHICH teardown this is, and it is not cosmetic: the two orderings
   * are opposites. An SPA unmount leaves the page alive, so retirement purges the
   * snapshot first and removes the record second — the record is the only durable
   * handle to that row, so losing it first would strand the reverse map. A DOCUMENT
   * teardown has no "second": an awaited IndexedDB purge may simply never resume,
   * so the record must be cut synchronously first and the snapshot left to Clear.
   */
  const abandonCurrentAttempt = useCallback(
    (exit: "spa" | "document"): void => {
      const ctrl = controllerRef.current;
      const prior = attempts.current();
      if (prior === null) return;
      // Read the identities BEFORE revoking — afterwards `getLiveJobId` is null by
      // design, and an owner we cannot name is an owner we cannot clean up.
      const jobId = ctrl.getLiveJobId() ?? ctrl.activation?.jobId ?? null;
      const ownerId = prior.ownerId() ?? (jobId !== null ? ctrl.ownerFor(jobId) : null);
      const stillRunning = isActiveLifecycle(ctrl.view.lifecycle);

      attempts.revoke();
      if (jobId !== null) captureRef.current.gate.abandon(jobId);

      // Drop the run view too. It lives in the app-lifetime hot store, which is what
      // makes the live route survive a rerender — but it also means it survives
      // NAVIGATION, and a returning visit would otherwise find the previous run's
      // completed result, its capture notice and its CTA still on screen. "Leaving
      // abandons the run" has to include what the user can see when they come back.
      ctrl.reset();

      if (jobId === null && ownerId === null) return;

      const retirementDepsNow = {
        storage: retirementRef.current?.storage ?? acquireSessionStorage(),
        cancelJob: retirementRef.current?.cancelJob,
        purgeSnapshot: retirementRef.current?.purgeSnapshot,
      };
      if (exit === "document") {
        // Synchronous, and its result is not a promise on purpose: nothing here may
        // depend on a continuation the browser is not obliged to run.
        retireOnDocumentExit({ jobId, ownerId, stillRunning }, retirementDepsNow);
        return;
      }
      void retireAbandonedRun({ jobId, ownerId, stillRunning }, retirementDepsNow);
    },
    [attempts],
  );

  // Route exit, both ways it can happen.
  //
  // In-app navigation unmounts this component, and the cleanup below runs
  // synchronously during that unmount — which is what makes “leaving abandons the
  // run” true at the instant the user leaves rather than whenever a microtask
  // happens to run. That is the path a user actually takes, and the only one where
  // the whole retirement (including the async snapshot purge) can finish.
  //
  // A DOCUMENT navigation — typing a URL, a reload, closing the tab — destroys the
  // page instead, and React cleanup is not guaranteed to run at all. `pagehide` is
  // the reliable hook for it, and it takes the `document` ordering: the owner-keyed
  // record (which carries the real-identity reverse map) is cut synchronously, and
  // the IndexedDB snapshot is left as the residue verified Clear is documented to
  // reclaim. Awaiting the purge first would mean neither happened.
  useEffect(() => {
    const onPageHide = () => abandonCurrentAttempt("document");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      abandonCurrentAttempt("spa");
    };
  }, [abandonCurrentAttempt]);

  // --- fresh-entry cleanup lane ---------------------------------------------
  //
  // The ONLY thing route entry does about a previous run, and it is deliberately
  // invisible: a readable record left in the legacy single slot by an earlier build
  // is moved to its owner key. Nothing is rendered, polled, downloaded, captured or
  // gated from it — the migration exists so exact-owner retirement and prefix-scoped
  // Clear can REACH that record at all. Without this, identity-bearing legacy state
  // would sit in a key nothing owner-scoped can name.
  //
  // Idempotent and read-back verified, so a StrictMode double-invoke is a no-op and
  // an interrupted run simply repeats. Unreadable bytes name no owner, so they are
  // left exactly where they are for verified Clear.
  const migrateRef = useRef(false);
  useEffect(() => {
    if (migrateRef.current) return;
    migrateRef.current = true;
    try {
      migrateLegacySession(retirementRef.current?.storage ?? acquireSessionStorage());
    } catch {
      // A storage that cannot be read leaves the legacy bytes exactly as they were,
      // which is the same outcome as an unreadable record: Clear's to reclaim.
    }
  }, []);

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

  // G4 — the prototype's `Open & adjust roster` CTA. Only a completed run
  // whose F2 capture committed a loadable candidate may claim a roster
  // exists. `stateFor(view.jobId)` is the in-memory capture outcome for the
  // run in view; a fresh app process has no entries, so this is honest only
  // for the run the screen currently sees — a separately persisted durable
  // candidate is reached from the /roster screen directly. Idle, running,
  // failed, infeasible-without-incumbent, capture-failed and dismissed
  // outcomes all stay silent.
  const captureStateForView = capture.stateFor(view.jobId);
  const hasLoadableRoster =
    view.lifecycle === "completed" && captureStateForView.status === "committed";

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
  /**
   * The final pre-submit AUTHORITY check (T03), preserved through the integration.
   *
   * Not a readiness gate — Optimize's readiness rules, payload shape, error copy and
   * run semantics are unchanged. What it guarantees is that the bytes submitted are
   * the COMMITTED document, sent by the tab that actually holds the lease. The
   * projection can say "owner" while the persisted lease names a peer that took over
   * without writing content, and an unchanged revision does not reconcile that away.
   */
  const preflightAuthority = useCallback(async (): Promise<boolean> => {
    // Drain so the committed document — not an in-flight frame — is what the payload
    // is built from.
    await drainScenarioCommands();
    const ownership = await readAuthoritativeScenarioOwnership();
    if (ownership === null || !ownership.isOwner) return false;
    // Bind the persisted revision to payload preparation: if the projection is behind
    // durable truth, refresh it FIRST so the document is built from committed state.
    if (ownership.documentRevision !== useAuthorityStore.getState().documentRevision) {
      await scenarioCommands.reconcile();
      // Re-check the persisted owner after reconcile: reconciling is itself a
      // lifecycle operation that can discover a takeover.
      const reread = await readAuthoritativeScenarioOwnership();
      if (reread === null || !reread.isOwner) return false;
    }
    return true;
  }, []);

  const buildSubmitInput = useCallback(async (): Promise<OptimizeRunSubmitInput | null> => {
    const parsed = parseTimeoutInput(timeoutValue);
    if (!parsed.ok) {
      setTimeoutError(TIMEOUT_ERROR);
      return null;
    }
    setTimeoutError(null);
    // Validation stays FIRST, so an invalid timeout still reports itself without
    // touching the repository or the run.
    if (!(await preflightAuthority())) {
      toast.error(
        "This schedule is being edited in another tab. Take over editing before optimising.",
      );
      return null;
    }
    const document = toCanonicalScenarioDocument(useScenarioStore.getState());
    return {
      document,
      anonymize,
      prettify,
      timeout: parsed.value,
      // INTENT 1 — the backend semantic profile from the SAME `/api/info` read the
      // status bar renders. Omitting it is what a run does when the profile is
      // unreadable, and the controller degrades to an ordinary un-claimed run — which
      // is precisely why leaving it out was invisible: every run looked healthy and
      // every run silently recorded no submission basis, so T10's bounded diagnostic
      // had no parent to diagnose.
      semanticProfile: serverInfo.semanticProfile,
    };
  }, [anonymize, prettify, timeoutValue, preflightAuthority, serverInfo.semanticProfile]);

  // The click boundary. One click owns one attempt until its POST settles.
  //
  // Repeated events belonging to that ONE click — StrictMode replay, a double
  // click, a stray second handler call — join this promise and produce exactly one
  // request. Once it settles the promise is cleared, so a LATER deliberate click
  // is a new attempt with a new owner and a new POST, and it never waits on the
  // previous run's cleanup to finish.
  //
  // The ref is claimed SYNCHRONOUSLY, before the first `await` in the handler.
  // That is what makes the coalescing a property of the code rather than of how
  // fast the machine is: two events dispatched in the same task cannot both see it
  // empty, whatever the scheduler does afterwards.
  const inFlightSubmitRef = useRef<Promise<void> | null>(null);
  const [submitInFlight, setSubmitInFlight] = useState(false);

  const onSubmit = useCallback(async () => {
    const joined = inFlightSubmitRef.current;
    if (joined !== null) {
      await joined;
      return;
    }
    const input = await buildSubmitInput();
    if (input === null) return;
    setStartFailed(false);

    // A deliberate new click supersedes whatever came before it, invisibly. This
    // is the same revocation route exit performs, and it happens BEFORE the new
    // attempt exists, so the old run can never observe itself as current again.
    abandonCurrentAttempt("spa");
    const attempt = attempts.start();

    runStartRef.current = Date.now();
    emittedTerminalRef.current = null;
    lastQueueRef.current = null;

    const flight = (async () => {
      const outcome = await controller.submit(input, {
        onOwnerId: (ownerId) => attempt.claimOwner(ownerId),
        isCurrent: () => attempt.isCurrent(),
      });
      // A `202` that landed after this attempt was revoked. Its record activated
      // under its own owner key — which is exactly what makes the exact job
      // nameable — and it goes straight to the retirement lane: never polled,
      // never rendered, never downloaded.
      if (outcome.status === "stale-accepted") {
        captureRef.current.gate.abandon(outcome.jobId);
        void retireAbandonedRun(
          {
            jobId: outcome.jobId,
            ownerId: attempt.ownerId(),
            stillRunning: true,
          },
          {
            storage: retirementRef.current?.storage ?? acquireSessionStorage(),
            cancelJob: retirementRef.current?.cancelJob,
            purgeSnapshot: retirementRef.current?.purgeSnapshot,
          },
        );
        return;
      }
      // The one plain-language start failure. Only reported for the attempt that
      // is still current — an abandoned attempt has no screen to report to.
      // `revoked-before-post` is deliberately silent: the user left.
      if (attempt.isCurrent() && outcome.status === "blocked-before-post") {
        setStartFailed(true);
      }
    })();

    inFlightSubmitRef.current = flight;
    setSubmitInFlight(true);
    try {
      await flight;
    } finally {
      if (inFlightSubmitRef.current === flight) {
        inFlightSubmitRef.current = null;
        setSubmitInFlight(false);
      }
    }
  }, [abandonCurrentAttempt, attempts, buildSubmitInput, controller]);

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
  //
  // `Optimize` is ALWAYS CLICKABLE except for two facts about the present: the form
  // is not ready, or the backend is not there. Nothing about any run — previous or
  // current — participates.
  //
  // Four gates have been deleted here, each of which was a way a run could hold the
  // button down: `recoveryBooting` (a boot inspection that no longer happens),
  // `recoveryBlocking` (the “still running” state this ticket exists for),
  // `cleanupBlocking` (an old run's unproven cleanup), and now `!active` — which
  // disabled the button for every queued/running/cancelling lifecycle and so made
  // “a later deliberate click supersedes the current run” unreachable in the product
  // even though the contract describes it.
  //
  // What remains is `submitInFlight`, and it is a different thing entirely: not a
  // RUN in progress but a REQUEST in flight. It exists so the settled promise, not
  // the wall clock, decides when a second gesture becomes a second attempt.
  const submitEnabled = readiness.ready && serverInfo.status === "online" && !submitInFlight;
  const disabledReason = !readiness.ready
    ? "Complete the missing schedule configuration before optimising."
    : serverInfo.status !== "online"
      ? "Backend unavailable. Check that the configured backend is running."
      : null;

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
            // Editable whenever a new run could be started, so the options a later
            // deliberate click sends are the ones the user can actually change.
            optionsDisabled={submitInFlight}
            submitEnabled={submitEnabled}
            submitting={submitInFlight}
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
            canDownloadAgain={terminal.canDownloadAgain}
            downloadAgainFilename={terminal.downloadAgainFilename}
            onCancel={onCancel}
            onFinishNow={controller.finishNow}
            onDownloadArtifact={terminal.downloadArtifact}
            onDownloadAgain={terminal.downloadAgain}
            // The idle-panel CTA must respect the SAME submission gates as the
            // settings-form Optimize button — wire it only when a run is actually
            // permitted, so an offline / not-ready / recovery- or cleanup-blocked
            // idle screen can't submit through it (which would risk overwriting a
            // retained terminal view with `submit-blocked`). When not submittable
            // the idle panel shows the explainer only; the settings button carries
            // the disabled reason.
            onStartRun={submitEnabled ? onSubmit : undefined}
            // G4 — drives the `Open & adjust roster` CTA inside the
            // completed artifact block. True only for a completed run whose
            // capture committed a loadable candidate.
            loadableRoster={hasLoadableRoster}
          />
        </Section>
      </div>

      <RunEventLog log={view.log} active={active || controller.isSubmitting} />
    </Surface>
  );
}

export default OptimizeAndExportScreen;
