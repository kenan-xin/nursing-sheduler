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
import { preferenceCardUids, toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import { withDefaultExportLayout } from "@/lib/scenario/default-export-layout";
import { applyCovers } from "@/lib/scenario/temporary-cover";
import { countEnabledRules } from "@/lib/scenario";
import {
  drainScenarioCommands,
  readAuthoritativeScenarioOwnership,
  scenarioCommands,
  useAuthorityStore,
  useScenarioStore,
} from "@/lib/store";
import { toast } from "sonner";
import { useOptimizeTimeoutOptions, LEGACY_OPTIMIZE_TIMEOUT } from "@/lib/query/optimize-options";
import type { OptimizeTimeoutOptions } from "@/app/api/optimize/options/validate";
import {
  acquireSessionStorage,
  noteOptimizeRunStarted,
  publishSolverTimeoutSeconds,
  createAttemptRegistry,
  createOptimizeObservability,
  deriveOptimizeReadiness,
  UNSUPPORTED_EXPRESSION_REASON,
  isActiveLifecycle,
  isRunStale,
  isSettledLifecycle,
  migrateLegacySession,
  reportOptimizeRunRequest,
  retireAbandonedRun,
  retireOnDocumentExit,
  takeOptimizeRunRequest,
  useOptimizeRun,
  useOptimizeServerInfo,
  useOptimizeTerminal,
  useRosterCapture,
  useRunRequestStore,
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
import { toCoverEntries } from "@/lib/roster/cover-sheet";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import { CaptureNotice } from "./capture-notice";
import { Callout } from "./callout";
import { CoverPreflight } from "./cover-preflight";
import { ReadinessBanner } from "./readiness-banner";
import { RunEventLog } from "./run-event-log";
import { RunOptionsForm } from "./run-options-form";
import { RunStatusPanel } from "./run-status-panel";
import { ServerIdentity } from "./server-identity";

/** v1's copy (eacd021), naming the deployment's own bounds. */
function timeoutErrorFor(bounds: OptimizeTimeoutOptions): string {
  return `Solver timeout must be an integer between ${bounds.minimum} and ${bounds.maximum} seconds.`;
}

/** The leave warning the shell's nav guard shows while a run is active (C-03). */
export const RUN_LEAVE_WARNING = "Leaving will cancel the running optimisation.";

// C-03 — set when the user left mid-run, so the NEXT visit can say the run was
// cancelled. Module scope because the mount that cancelled it is gone by then.
let runCancelledByExit = false;

/** A run leaving would cancel: its POST is in flight, or its job is live. */
function isRunLive(lifecycle: OptimizeRunView["lifecycle"]): boolean {
  return lifecycle === "submitting" || isActiveLifecycle(lifecycle);
}

/**
 * One message per real start-failure cause, each with a fix that addresses it (C-04).
 * Storage only blocks an Anonymized run (a plain run proceeds without recovery), so
 * turning Anonymize off is a genuine way out of every storage cause.
 */
function startFailedCopy(reason: string): string {
  switch (reason) {
    case "quota-exceeded":
      return "Optimisation could not start because browser storage is full. Free browser storage or turn off Anonymize, then click Optimize again.";
    case "storage-unavailable":
    case "read-back-failed":
      return "Optimisation could not start because this browser is blocking site storage. Allow storage for this site or turn off Anonymize, then click Optimize again.";
    case "invalid-record":
      return "Optimisation could not start because the run could not be prepared. Reload the page, then click Optimize again.";
    default:
      // `session-conflict` and `submission-in-progress`: an earlier start was still settling.
      return "Optimisation could not start because an earlier start was still finishing. Wait a moment, then click Optimize again.";
  }
}

/** Parse the timeout field, enforcing an integer within the backend's bounds. */
function parseTimeoutInput(
  raw: string,
  bounds: OptimizeTimeoutOptions,
): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < bounds.minimum || value > bounds.maximum) {
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
      if (isRunLive(controllerRef.current.view.lifecycle)) runCancelledByExit = true;
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
  const cardsByKind = useScenarioStore((state) => state.cardsByKind);
  const readiness = useMemo(
    () =>
      deriveOptimizeReadiness({
        staff,
        shifts,
        shiftGroups,
        rangeStart,
        rangeEnd,
        cardsByKind,
        counts: cardsByKind.counts,
      }),
    [staff, shifts, shiftGroups, rangeStart, rangeEnd, cardsByKind],
  );

  // B2-2 — the scenario stat grid (NURSES / DAYS / SHIFTS / RULES ON) rendered
  // with the run settings (proto ScreenGenerate.dc.html:32-37). RULES ON is the
  // ENABLED count, the same number the Guided Rules screen and Home report —
  // `countEnabledRules` is the one owner of that rule (lib/scenario/rule-counts.ts).
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
  // 2by.7 — the default and bounds come from the backend (`/api/optimize/options`),
  // falling back to the legacy ones. `null` means the user has not typed, so the
  // field shows the backend default once it arrives: derived, not copied by an
  // effect, so a submit in the same commit can never read a stale default.
  const timeoutOptions = useOptimizeTimeoutOptions();
  const timeoutBounds = timeoutOptions.data?.timeout ?? LEGACY_OPTIMIZE_TIMEOUT;
  const [typedTimeout, setTimeoutValue] = useState<string | null>(null);
  const timeoutValue = typedTimeout ?? String(timeoutBounds.default);
  const [timeoutError, setTimeoutError] = useState<string | null>(null);
  const [capturePending, setCapturePending] = useState(false);
  // Why the hidden pre-submit step refused to start, mapped to one plain-language
  // message per cause by `startFailedCopy`.
  const [startFailed, setStartFailed] = useState<string | null>(null);
  // C-03 — read once on entry, cleared in an effect (StrictMode-safe).
  const [cancelledOnReturn, setCancelledOnReturn] = useState(() => runCancelledByExit);
  useEffect(() => {
    runCancelledByExit = false;
  }, []);

  // ASSISTANT SEAM — publish the solver timeout this screen would submit, so every solve
  // the assistant starts uses the user's own timeout: the value typed here, else the
  // deployment default. Null before the options have answered and on unmount, so a reader
  // never mistakes this screen's legacy fallback for the deployment's own default (bd
  // memory assistant-respects-solver-timeout). A derived publish, not a copy: the value
  // is recomputed from the same state `buildSubmitInput` reads.
  useEffect(() => {
    if (typedTimeout !== null) {
      const parsed = parseTimeoutInput(typedTimeout, timeoutBounds);
      publishSolverTimeoutSeconds(parsed.ok ? parsed.value : null);
      return;
    }
    publishSolverTimeoutSeconds(timeoutOptions.data === undefined ? null : timeoutBounds.default);
  }, [typedTimeout, timeoutBounds, timeoutOptions.data]);

  // The published value belongs to the mounted visit: leaving the screen retires it.
  useEffect(() => () => publishSolverTimeoutSeconds(null), []);

  const view = controller.view;
  const active = isActiveLifecycle(view.lifecycle);

  // C-03 — while a run is live, leaving cancels it, so the shell's nav guard and
  // `beforeunload` guard both warn first (they read the same draft registry).
  const registerDraft = useNavGuardStore((s) => s.registerDraft);
  const runLive = isRunLive(view.lifecycle);
  useEffect(() => {
    if (!runLive) return;
    return registerDraft({
      id: "optimize:run",
      label: "Optimisation run",
      leaveWarning: RUN_LEAVE_WARNING,
    });
  }, [runLive, registerDraft]);

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
  // C-17 — a working roster was already there, so this result waits for a choice.
  const newResultNotLoaded =
    captureStateForView.status === "committed" &&
    captureStateForView.working.kind === "awaiting-choice";
  // C-12 — Undo/Redo or the assistant changed the schedule after this run started.
  const runRevision = useRunRequestStore((state) => state.runRevision);
  const documentRevision = useAuthorityStore((state) => state.documentRevision);
  const runStale = isRunStale(view.lifecycle, runRevision, documentRevision);

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
    const parsed = parseTimeoutInput(timeoutValue, timeoutBounds);
    if (!parsed.ok) {
      setTimeoutError(timeoutErrorFor(timeoutBounds));
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
    // ONE applyCovers run builds both the solver input and the ledger the roster
    // keeps, so the roster knows exactly what this solve subtracted (d582).
    const scenario = useScenarioStore.getState();
    const applied = applyCovers(scenario);
    // No saved layout: send v1's default one, so the XLSX keeps its count
    // rows/columns and unmet-request marks (audit C-01).
    const document = withDefaultExportLayout(toCanonicalScenarioDocument(applied.state));
    return {
      document,
      ruleUids: preferenceCardUids(applied.state),
      cover: {
        // The shared projection, so the entries staged with the submission and the
        // rows the raw download writes are built from ONE reading of the cards.
        entries: toCoverEntries(scenario.temporaryCover),
        decrements: applied.decrements,
      },
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
  }, [
    anonymize,
    prettify,
    timeoutValue,
    timeoutBounds,
    preflightAuthority,
    serverInfo.semanticProfile,
  ]);

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
  const inFlightSubmitRef = useRef<Promise<boolean> | null>(null);
  const [submitInFlight, setSubmitInFlight] = useState(false);

  // Resolves true when the attempt reached the server, false when it stopped short.
  const onSubmit = useCallback(async (): Promise<boolean> => {
    const joined = inFlightSubmitRef.current;
    if (joined !== null) {
      return joined;
    }
    const input = await buildSubmitInput();
    if (input === null) return false;
    setStartFailed(null);
    setCancelledOnReturn(false);

    // A deliberate new click supersedes whatever came before it, invisibly. This
    // is the same revocation route exit performs, and it happens BEFORE the new
    // attempt exists, so the old run can never observe itself as current again.
    abandonCurrentAttempt("spa");
    const attempt = attempts.start();
    // `buildSubmitInput` drained and reconciled, so this is the revision the run is built from.
    noteOptimizeRunStarted(useAuthorityStore.getState().documentRevision);

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
        return false;
      }
      // The one plain-language start failure. Only reported for the attempt that
      // is still current — an abandoned attempt has no screen to report to.
      // `revoked-before-post` is deliberately silent: the user left.
      if (attempt.isCurrent() && outcome.status === "blocked-before-post") {
        setStartFailed(outcome.reason);
      }
      return (
        outcome.status !== "invalid" &&
        outcome.status !== "blocked-before-post" &&
        outcome.status !== "revoked-before-post"
      );
    })();

    inFlightSubmitRef.current = flight;
    setSubmitInFlight(true);
    try {
      return await flight;
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
  // `Optimize` is gated on the form being ready, the backend being there, and THIS
  // visit's run: a POST in flight (`submitInFlight`) or a live job (`active`). v1
  // parity (C-02): a second click must not silently throw away a long run, so while
  // one is live the button reads "Optimizing…" and only Cancel acts on it. Nothing
  // about a PREVIOUS visit's run participates — that one was abandoned on exit.
  const runBusy = submitInFlight || active;
  const submitEnabled = readiness.ready && serverInfo.status === "online" && !runBusy;
  // The unsupported-expression issue is pushed last, so it leads only when it is
  // the sole reason; missing set-up keeps the generic sentence.
  const disabledReason = !readiness.ready
    ? readiness.issues[0].kind === "shift-counts"
      ? UNSUPPORTED_EXPRESSION_REASON
      : "Complete the missing schedule configuration before optimising."
    : serverInfo.status !== "online"
      ? "Backend unavailable. Check that the configured backend is running."
      : null;

  // ASSISTANT RUN REQUEST. The assistant's confirm card asks for exactly the run the
  // Optimize button starts, so this calls the SAME `onSubmit`: options, lease
  // preflight, basis, capture, download and cleanup are the button's, not a copy.
  // It waits while the backend check is still `checking`, and for the timeout
  // options, so an assistant run uses the backend's default and bounds exactly as a
  // click would. The request itself expires (`run-request.ts`), so a late mount
  // never starts a surprise run.
  const runRequested = useRunRequestStore((state) => state.pending !== null);
  const timeoutOptionsPending = timeoutOptions.isPending;
  useEffect(() => {
    if (!runRequested || serverInfo.status === "checking" || timeoutOptionsPending) return;
    if (!takeOptimizeRunRequest()) return;
    if (!readiness.ready) {
      reportOptimizeRunRequest("not-ready");
      return;
    }
    if (serverInfo.status !== "online") {
      reportOptimizeRunRequest("backend-offline");
      return;
    }
    if (runBusy) {
      reportOptimizeRunRequest("busy");
      return;
    }
    // Reported only once `onSubmit` settles: it can still stop short of a POST (bad
    // timeout, lost lease, blocked submit), and "started" would then be false.
    void onSubmit().then((started) => reportOptimizeRunRequest(started ? "started" : "blocked"));
  }, [runRequested, serverInfo.status, timeoutOptionsPending, readiness.ready, runBusy, onSubmit]);

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
      <CoverPreflight />
      {startFailed !== null ? (
        <Callout tone="error" placement="page" data-testid="optimize-start-failed" alert>
          {startFailedCopy(startFailed)}
        </Callout>
      ) : null}
      {cancelledOnReturn ? (
        <Callout tone="info" placement="page" data-testid="optimize-cancelled-on-exit">
          Your last optimisation was cancelled because you left this page while it was running.
          Click Optimize to run it again.
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
            timeoutBounds={timeoutBounds}
            timeoutError={timeoutError}
            // Locked while a run is live: they would not change it (C-02).
            optionsDisabled={runBusy}
            submitEnabled={submitEnabled}
            submitting={runBusy}
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
            newResultNotLoaded={newResultNotLoaded}
            stale={runStale}
          />
        </Section>
      </div>

      <RunEventLog log={view.log} active={active || controller.isSubmitting} />
    </Surface>
  );
}

export default OptimizeAndExportScreen;
