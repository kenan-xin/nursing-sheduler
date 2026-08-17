"use client";

// T16e — terminal-outcome orchestration: download, restoration, first browser
// download, tab-lifetime Download Again, and deterministic best-effort cleanup.
//
// This hook owns the ticket's terminal-outcome table. It never reads or writes the
// durable session record directly; it drives the controller's notify* signals and
// calls the controller's owner-keyed `retireSessionRecord(jobId)` for record
// removal. The exact ordering it guarantees for a completed job with a
// downloadable artifact:
//
//   fetch artifact → restore original ids when anonymized → complete the FIRST
//   browser download → retain a tab-lifetime blob for Download Again → attempt a
//   best-effort terminal DELETE.
//
// The only server artifact is NEVER deleted before a successful local
// restoration/download: a failed download leaves the artifact available to retry
// and does not attempt cleanup. Cleanup is confirmed only on a DELETE 204 or an
// exact code-first job-not-found; any other outcome leaves the record in place and
// reports `failed` rather than a false `cleaned`.
//
// G6.2b — cleanup is INVISIBLE. It used to end at a user-facing retry/abandon
// surface, because records were single-slot and an uncleaned one blocked the next
// run. Records are owner-keyed now, so a retained record blocks nothing: the next
// run simply starts, and a record cleanup could not remove stays for verified
// Clear. Nothing here ever resets the successful terminal view or the Download
// Again blob.
//
// ONE OUTCOME IS EXEMPT FROM THE SERVER DELETE: `infeasible`.
//
// An infeasible run produces no artifact, so the chain above used to read it as
// "nothing to keep" and DELETE it the instant it settled. But that job IS the thing
// worth keeping: it is the only server-side evidence T10's bounded infeasibility
// diagnostic can diagnose against. `classifyRecovery` asks the server for the job,
// got a 404, classified the run `local-only`, and `mayOpenSearch` refused — so the
// diagnostic could never open a search for ANY run, on any deployment. The basis row
// in the browser was intact the whole time; the server half had already been deleted
// by this hook, seconds earlier.
//
// So for `infeasible` the chain retires the run LOCALLY — the owner-keyed
// `retireSessionRecord`, the same half `attemptCleanup` runs — and leaves the server
// job to the backend's OWN retention. (Pre-integration this reused `abandonCleanup`;
// visit scoping removed that surface, and the owner-keyed retirement replaces it.)
// That retention is
// already bounded and already authoritative — the controller stamps
// `expires_at = now + retention_seconds` at admission, retention maintenance deletes
// on `finished_at`, and `classifyRecovery` independently refuses evidence past
// `server.expiresAt`. Nothing here extends a lifetime, adds a TTL, or stores more:
// it stops ending one early.
//
// Narrow on purpose. `optimal` and `feasible` still download-then-delete, and
// `inconclusive` still deletes — the diagnostic is defined only over a run the solver
// PROVED infeasible, so only that outcome buys retention.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOptimizeXlsx } from "@/lib/query/optimize";
import { isExactJobGoneResponse } from "@/lib/bff/errors";
import { MAX_DISPLAY_FILENAME_BYTES, truncateUtf8 } from "@/lib/query/sse-limits";
import {
  applyPeopleIdRestoration,
  type PeopleIdRestorationInput,
} from "./restore-people-ids-in-xlsx";
import type { OptimizeRunController } from "./use-optimize-run";
import type { OptimizeObservability } from "./optimize-observability";
import type { CaptureRequest, RosterCaptureGate, RosterCaptureState } from "./roster-capture";
import { getCleanupCoordinator, type CleanupCoordinator } from "./roster-capture-app";
import { isAbortError, type AttemptRegistry, type VisitAttempt } from "./visit-attempt";

/** Best-effort terminal DELETE result. `confirmed` ⇒ 204 or exact job-not-found. */
export type CleanupCallOutcome = { status: "confirmed" } | { status: "failed"; reason: string };

/**
 * The terminal cleanup progression.
 *
 * NOT a rendered state. G6.2c removed the `cleanupPhase` field this used to
 * publish: cleanup is invisible — owner-keyed records block nothing, so there is
 * no phase for a user to act on — and the only readers left were tests, which is
 * not a reason to keep public product state or the re-renders it causes. What the
 * type still names is the ANSWER `dismissCapture()` returns to the caller that
 * asked for it, and the internal ref the async chains serialize on.
 */
export type CleanupPhase = "idle" | "cleaning" | "cleaned" | "failed";

/** The controller surface the terminal orchestration drives. */
type TerminalController = Pick<
  OptimizeRunController,
  | "view"
  | "activation"
  | "retireSessionRecord"
  | "notifyDownloadStarted"
  | "notifyDownloadSucceeded"
  | "notifyDownloadUnavailable"
  | "notifyDownloadFailed"
  | "notifyCleanup"
>;

/**
 * What this tab can prove about the capture authority for ONE completed job.
 *
 * G6.2 COLLAPSED this from three states to two. The third — `pending` — existed
 * solely because a remount used to start with activation null and have a durable
 * record attach from a LATER passive effect, so "no activation yet" and "no
 * activation ever" were indistinguishable and the chain had to wait. Nothing
 * attaches after the fact any more: a job in view with no matching activation is a
 * job whose authority will never arrive, which is a proven absence, not a wait.
 */
export type JobCaptureAuthority = "exact" | "proven-absent";

/**
 * Classify the capture authority for `jobId` from the attached activation. Pure,
 * so the completed-job effect can hold its result as a primitive dependency.
 */
export function classifyJobCaptureAuthority(
  jobId: string,
  activationJobId: string | null,
): JobCaptureAuthority {
  return activationJobId === jobId ? "exact" : "proven-absent";
}

export interface UseOptimizeTerminalDeps {
  controller: TerminalController;
  /**
   * The visit's attempt authority.
   *
   * Every user-facing effect below — `saveBlob`, the roster fetch, the candidate
   * commit, each state dispatch — is checked against the attempt that started the
   * chain, at every awaited boundary. `mountedRef` alone was never enough: it
   * suppresses React state after unmount and nothing else, so the asynchronous
   * chain carried on and could still hand the user a download for a run they had
   * walked away from.
   *
   * Optional so a test that is not exercising abandonment need not wire one; when
   * absent the chain behaves as it did before the fence existed. Production always
   * wires it.
   */
  attempts?: AttemptRegistry;
  observability?: OptimizeObservability;
  /** Defaults to `fetchOptimizeXlsx`. */
  fetchXlsx?: (jobId: string, signal?: AbortSignal) => Promise<{ blob: Blob; filename: string }>;
  /** Defaults to a same-origin `DELETE /api/optimize/{id}`. */
  deleteJob?: (jobId: string) => Promise<CleanupCallOutcome>;
  /** Defaults to a throwaway anchor-click browser download. */
  saveBlob?: (blob: Blob, filename: string) => void;
  /** Defaults to `applyPeopleIdRestoration` (plain path is a byte-identical bypass). */
  restore?: (blob: Blob, input: PeopleIdRestorationInput) => Promise<Blob>;
  /**
   * The F2 roster capture gate. When omitted the terminal chain behaves exactly as
   * it did before roster capture existed (download, then cleanup) — the viewer
   * chain wires a real gate. When present it becomes the SOLE authority for the
   * terminal DELETE: no committed-or-dismissed token, no delete.
   */
  capture?: RosterCaptureGate;
  /** Defaults to the app-lifetime cleanup coordinator. */
  cleanup?: CleanupCoordinator;
}

/** The terminal surface consumed by the screen. */
export interface OptimizeTerminal {
  /** Whether the tab retains a restored blob for a re-download without re-fetch. */
  canDownloadAgain: boolean;
  downloadAgainFilename: string | null;
  /** The roster capture state for the job in view (`idle` with no gate wired). */
  captureState: RosterCaptureState;
  /** Retry capture: a server refetch after `fetch-failed`, a purely local retry
   *  with the container and bytes already in hand after `commit-failed`. */
  retryCapture(): void;
  /**
   * The user declines the captured candidate. Removes it through F1's exact-version
   * authority and, ONLY once that removal is proven, uses the resulting dismissal
   * token to authorize cleanup. A local removal that cannot be proven leaves the
   * candidate, the server job, and the cleanup phase untouched, and surfaces
   * `captureState: "dismiss-failed"` for a retry.
   */
  dismissCapture(): Promise<CleanupPhase>;
  /** Re-save the retained blob (no re-fetch, no re-validation). */
  downloadAgain(): void;
  /** (Re)attempt the completed-artifact download flow, then cleanup on success. */
  downloadArtifact(): void;
}

async function defaultDeleteJob(jobId: string): Promise<CleanupCallOutcome> {
  try {
    const response = await fetch(`/api/optimize/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      cache: "no-store",
    });
    if (response.status === 204) return { status: "confirmed" };
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (isExactJobGoneResponse(response.status, body)) return { status: "confirmed" };
    return { status: "failed", reason: `delete-http-${response.status}` };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "delete-failed" };
  }
}

function defaultSaveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer the revoke: revoking the object URL on the same synchronous tick can
  // cancel or truncate the download before the browser has taken over the stream.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface RetainedDownload {
  jobId: string;
  blob: Blob;
  filename: string;
}

/**
 * Drive the terminal-outcome table. A completed job with a downloadable artifact
 * runs the download→restore→first-download→retain→cleanup chain exactly once; a
 * completed job with no artifact attempts cleanup only. A cancelled/failed run has
 * no artifact to release, so its record is retired by the visit's retirement lane
 * rather than by anything the user presses.
 */
export function useOptimizeTerminal(deps: UseOptimizeTerminalDeps): OptimizeTerminal {
  // Everything the callbacks need is read through refs so the callbacks stay stable
  // and a per-render controller identity never staleness-traps the async chains.
  const ref = useRef(deps);
  ref.current = deps;
  const fetchXlsx = deps.fetchXlsx ?? fetchOptimizeXlsx;
  const deleteJob = deps.deleteJob ?? defaultDeleteJob;
  const saveBlob = deps.saveBlob ?? defaultSaveBlob;
  const restore = deps.restore ?? applyPeopleIdRestoration;
  const seams = useRef({ fetchXlsx, deleteJob, saveBlob, restore });
  seams.current = { fetchXlsx, deleteJob, saveBlob, restore };

  // The cleanup phase lives in a ref and NOWHERE else. It is read by the stable
  // async callbacks (so they never re-create themselves on a phase change) and
  // returned by `dismissCapture`; it is not React state, because nothing renders
  // it and a setState nothing reads is a re-render nothing needed.
  const phaseRef = useRef<CleanupPhase>("idle");
  const [captureState, setCaptureState] = useState<RosterCaptureState>({ status: "idle" });
  const [retained, setRetained] = useState<{ jobId: string; filename: string } | null>(null);
  const retainRef = useRef<RetainedDownload | null>(null);
  // Jobs whose terminal auto-chain has already fired (download+cleanup runs once).
  const autoDoneRef = useRef<Set<string>>(new Set());
  // The last non-null job id seen. `job-gone`/`control-job-gone` detach the job id
  // (view.jobId → null, activation cleared) while the durable record still exists;
  // a capture retry, a dismissal or a manual download must still target that id so
  // a DELETE returns job-not-found (confirmed cleanup) and frees the record.
  // Cleared on a fresh run.
  const lastJobIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  // Cleanup coalescing lives at APP lifetime, alongside the capture tokens it
  // consumes — not in this hook's refs. The token survives a route unmount, so a
  // mount-local coalescer would let the old route's finishing chain and a remounted
  // manual action each read the same token and each start a DELETE.
  const cleanupCoordinator = deps.cleanup ?? getCleanupCoordinator();

  const applyPhase = useCallback((phase: CleanupPhase): CleanupPhase => {
    phaseRef.current = phase;
    return phase;
  }, []);

  // --- the visit fence ------------------------------------------------------
  //
  // `beginAttempt` is called ONCE at the head of each async chain and returns the
  // attempt that owns it; `stillOwned` is re-checked after every await. With no
  // registry wired, both degrade to "always live", which is the pre-fence
  // behaviour tests without abandonment expect.
  const beginAttempt = useCallback((): VisitAttempt | null => {
    return ref.current.attempts?.current() ?? null;
  }, []);

  const stillOwned = useCallback((attempt: VisitAttempt | null): boolean => {
    // No registry ⇒ no visit fence to fail.
    if (ref.current.attempts === undefined) return true;
    return attempt !== null && attempt.isCurrent();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const currentJobId = useCallback((): string | null => {
    const { view, activation } = ref.current.controller;
    return view.jobId ?? activation?.jobId ?? lastJobIdRef.current;
  }, []);

  // Fetch → restore → first browser download → retain. Returns whether it succeeded.
  const runDownload = useCallback(
    async (jobId: string, attempt: VisitAttempt | null): Promise<boolean> => {
      const { controller } = ref.current;
      const activation = controller.activation;
      if (!activation || activation.jobId !== jobId) {
        // Without the retained reverse map we cannot safely restore/deliver the file.
        controller.notifyDownloadFailed("The restoration data for this run is unavailable.");
        return false;
      }
      if (!stillOwned(attempt)) return false;
      controller.notifyDownloadStarted();
      try {
        const { blob, filename } = await seams.current.fetchXlsx(jobId, attempt?.signal);
        if (!stillOwned(attempt)) return false;
        const restored = await seams.current.restore(blob, {
          anonymized: activation.anonymized,
          reverseMap: activation.reverseMap,
          peopleCount: activation.peopleCount,
        });
        // THE LAST CHECK BEFORE THE DOWNLOAD PRIMITIVE. No browser API can retract a
        // download once `saveBlob` has been called, so the contract is stated at the
        // only place it can be kept: a call already made is not undone, and no call
        // is made after revocation linearizes.
        if (!stillOwned(attempt)) return false;
        // The immediate browser download uses the AUTHORITATIVE server filename
        // (backend stores upload names verbatim, uncapped). Everything RETAINED —
        // the tab-lifetime Download Again copy and the React display state — stores
        // only the UTF-8-safe bounded copy so a pathological filename cannot pin
        // unbounded memory. The run view bounds its own copy from this same value.
        seams.current.saveBlob(restored, filename);
        const displayFilename = truncateUtf8(filename, MAX_DISPLAY_FILENAME_BYTES);
        retainRef.current = { jobId, blob: restored, filename: displayFilename };
        if (mountedRef.current) setRetained({ jobId, filename: displayFilename });
        controller.notifyDownloadSucceeded(displayFilename);
        return true;
      } catch (error) {
        // A stale attempt's abort is SILENCE. The user walked away; an error card
        // about a download they abandoned is noise, and reporting it would also be
        // a user-facing effect after revocation, which is exactly what is forbidden.
        if (isAbortError(error) || !stillOwned(attempt)) return false;
        controller.notifyDownloadFailed(
          error instanceof Error ? error.message : "Unable to download the schedule.",
        );
        return false;
      }
    },
    [stillOwned],
  );

  const markCleanupFailed = useCallback(
    (jobId: string): CleanupPhase => {
      const { controller, observability } = ref.current;
      controller.notifyCleanup("failed");
      observability?.emit({ kind: "cleanup", jobId, result: "failed" });
      return applyPhase("failed");
    },
    [applyPhase],
  );

  // What the capture gate needs to know about this job: the pre-POST capture
  // authority (only when the CURRENT activation is this exact job — a superseded
  // attachment's authority must never de-anonymize another job's roster) and the
  // restored bytes already in hand, so capture never refetches the workbook.
  //
  // Without an exact activation the authority is whatever recovery can PROVE:
  // a proven absence settles the gate, while an unresolved classification stays
  // null so the gate defers without opening a joinable flight.
  const captureRequest = useCallback(
    (jobId: string, attempt: VisitAttempt | null): CaptureRequest => {
      const { controller } = ref.current;
      const activation = controller.activation;
      const entry = retainRef.current;
      const capture: CaptureRequest["capture"] =
        activation !== null && activation.jobId === jobId
          ? activation.capture
          : // No exact activation, and none can arrive later now that nothing
            // attaches after the fact. That is a PROVEN absence, so the gate settles
            // it honestly rather than deferring forever.
            { status: "absent" };
      return {
        jobId,
        capture,
        frozenXlsx: entry !== null && entry.jobId === jobId ? entry.blob : null,
        signal: attempt?.signal,
      };
    },
    [],
  );

  // Run (or join) capture and report whether a terminal DELETE is now authorized.
  // With no gate wired this is vacuously true, preserving the pre-capture chain.
  const runCapture = useCallback(
    async (jobId: string, attempt: VisitAttempt | null): Promise<boolean> => {
      const gate = ref.current.capture;
      if (!gate) return true;
      if (!stillOwned(attempt)) return false;
      const outcome = await gate.capture(captureRequest(jobId, attempt));
      // A capture that resolved after the visit ended may still have committed a
      // candidate — that is durable product data and is deliberately kept. What it
      // may NOT do is publish a notice or authorize the terminal DELETE from here.
      if (!stillOwned(attempt)) return false;
      if (mountedRef.current) setCaptureState(outcome.state);
      return outcome.token !== null;
    },
    [captureRequest, stillOwned],
  );

  // Cleanup is TWO distinct required steps: an exact server DELETE confirmation
  // (204 / job-not-found) AND a T16b local record removal proven `removed`/`absent`.
  // Anything else — an unconfirmed DELETE, or a `not-current`/`changed`/`unverified`
  // local outcome — leaves the slot occupied (or its absence unproven), so it stays
  // `failed` (a blocking retry/abandon surface), never a false `cleaned`.
  const attemptCleanup = useCallback(
    async (jobId: string): Promise<CleanupPhase> => {
      // The last-line DELETE invariant. With capture wired, the sole server artifact
      // may only be destroyed once this job holds a `committed(jobId,candidateVersion)`
      // or an explicit `dismissed(jobId)` token. An unresolved capture leaves the job
      // and its artifact alone so Retry still has something to retry against.
      const gate = ref.current.capture;
      if (gate && gate.getToken(jobId) === null) return phaseRef.current;

      // One DELETE per job for the whole app lifetime: a confirmed result is
      // replayed, an in-flight one is joined, and only a non-terminal (failed)
      // result leaves the job retryable. This coordinator outlives the mount, so a
      // remounted terminal joins the SAME attempt rather than starting a rival one.
      const phase = await cleanupCoordinator.run(
        jobId,
        async (): Promise<CleanupPhase> => {
          const { controller, observability } = ref.current;
          applyPhase("cleaning");
          // Only the SERVER half is idempotently remembered here. A cleanup whose
          // DELETE was confirmed but whose local removal could not be proven stays
          // retryable, and that retry must re-run the local half ONLY — re-issuing a
          // DELETE the server already confirmed is pure noise against a job that is
          // provably gone.
          if (!cleanupCoordinator.serverDeleted(jobId)) {
            const server = await seams.current.deleteJob(jobId);
            if (server.status !== "confirmed") return markCleanupFailed(jobId);
            cleanupCoordinator.markServerDeleted(jobId);
          }
          // Owner-keyed record removal. `unknown-owner` is a genuine failure, not a
          // shrug: it means this controller cannot name the key, and inventing one
          // is how another run's record gets deleted.
          const local = controller.retireSessionRecord(jobId);
          if (local.status !== "removed" && local.status !== "absent") {
            return markCleanupFailed(jobId);
          }
          controller.notifyCleanup("cleaned");
          observability?.emit({ kind: "cleanup", jobId, result: "cleaned" });
          return "cleaned";
        },
        (result) => result === "cleaned",
      );
      // Reflect the shared result locally — including when this mount JOINED or
      // REPLAYED another's attempt and so never ran the body above.
      return applyPhase(phase);
    },
    [applyPhase, cleanupCoordinator, markCleanupFailed],
  );

  /**
   * Free the LOCAL slot and deliberately leave the server job in place.
   *
   * The same two-step shape as `attemptCleanup` minus the DELETE, and it keeps the
   * same proof obligation on the local half: an unproven local removal is still
   * `failed`, because an occupied record that nobody can prove is gone must not read
   * as success. The cleanup AFFORDANCE lands on `idle` rather than `abandoned` —
   * there is nothing for the user to retry or abandon — while the run view records
   * `retained`, which is the fact.
   */
  const retainForDiagnosis = useCallback(
    (jobId: string): CleanupPhase => {
      const { controller, observability } = ref.current;
      // INTEGRATION: retirement is the OWNER-KEYED `retireSessionRecord`, not the
      // pre-visit-scoping `recovery.cleanup`. Same proof obligation — an
      // `unknown-owner` result means this controller cannot name the key, and
      // inventing one is how another run's record gets removed.
      const local = controller.retireSessionRecord(jobId);
      if (local.status !== "removed" && local.status !== "absent") {
        return markCleanupFailed(jobId);
      }
      controller.notifyCleanup("retained");
      observability?.emit({ kind: "cleanup", jobId, result: "retained" });
      return applyPhase("idle");
    },
    [applyPhase, markCleanupFailed],
  );

  // Auto terminal chain: a completed job downloads (when an artifact exists) then
  // cleans up; a completed job with no artifact cleans up only -- EXCEPT an
  // `infeasible` one, whose server record is the diagnostic's only parent evidence
  // (see the module note). Runs once per job.
  const lifecycle = deps.controller.view.lifecycle;
  const viewJobId = deps.controller.view.jobId;
  const artifactAvailable = deps.controller.view.download.artifactAvailable;

  // Job-specific capture authority. `authority` is a plain string, so every
  // transition into it (and any change of attached job) is an observable
  // dependency of the chain below.
  const activationJobId = deps.controller.activation?.jobId ?? null;
  const authority: JobCaptureAuthority | null =
    viewJobId === null ? null : classifyJobCaptureAuthority(viewJobId, activationJobId);

  // Remember the last non-null job id (survives a `job-gone` detach) and clear it
  // on a fresh run so cleanup never targets a superseded job.
  if (viewJobId !== null) lastJobIdRef.current = viewJobId;
  else if (lifecycle === "submitting" || lifecycle === "idle") lastJobIdRef.current = null;
  useEffect(() => {
    if (viewJobId === null || lifecycle !== "completed" || authority === null) return;
    if (autoDoneRef.current.has(viewJobId)) return;
    // The visit that started this run is over. The terminal chain is entirely
    // user-facing — a download, a capture notice, a CTA — so there is nothing here
    // to do for an abandoned run. Its retirement lane runs elsewhere.
    const attempt = beginAttempt();
    if (!stillOwned(attempt)) return;
    const jobId = viewJobId;
    const exactAuthority = authority === "exact";
    // Arm the once-guard SYNCHRONOUSLY only for exact activation: the download
    // reads the activation's reverse map and a StrictMode replay must not start a
    // rival fetch. `proven-absent` does not arm — the gate settles it durably, so
    // a replay is a harmless no-op that returns the settled outcome.
    if (exactAuthority) autoDoneRef.current.add(jobId);
    void (async () => {
      if (artifactAvailable) {
        // Under `proven-absent` this fails honestly: the reverse map the restore
        // needs will never exist. The failed-download path preserves the artifact
        // for a manual retry and authorizes no DELETE, so the only server copy
        // still outlives a run whose restoration data is gone.
        const ok = await runDownload(jobId, attempt);
        if (!ok) return;
      } else {
        if (!stillOwned(attempt)) return;
        ref.current.controller.notifyDownloadUnavailable();
      }

      // INTENT 4 (T10) — an infeasible run's SERVER record is the only parent evidence
      // the bounded diagnostic can classify against. Deleting it, as this chain used
      // to, made `classifyRecovery` see a 404, answer `local-only`, and `mayOpenSearch`
      // refuse — so no run on any deployment could ever be diagnosed, while the browser
      // basis row sat there intact.
      //
      // Retire LOCALLY and leave the server job to the backend's own bounded retention
      // (`expires_at` at admission, reaped on `finished_at`, and `classifyRecovery`
      // independently refuses evidence past that expiry). Nothing here extends a
      // lifetime or stores more; it stops ending one early.
      //
      // Placed BEFORE the capture gate deliberately: that gate exists to stop a sole
      // ARTIFACT being deleted before it is captured, and an infeasible run has no
      // artifact and no candidate to capture. Reaching cleanup at all here would be
      // asking permission to do the one thing this branch must not do.
      //
      // The outcome is read from the LIVE view: the frame that sets
      // `lifecycle: "completed"` and the one carrying the solver result are not
      // guaranteed to be the same render.
      if (ref.current.controller.view.result?.outcome === "infeasible") {
        if (!stillOwned(attempt)) return;
        autoDoneRef.current.add(jobId);
        retainForDiagnosis(jobId);
        return;
      }
      // Capture runs BEFORE any DELETE and is the gate on it. A `fetch-failed` /
      // `commit-failed` capture issues no token, so the job survives for Retry — and
      // the once-guard is armed only once capture is authorized, so an unauthorized
      // outcome leaves the guard open for an explicit retry.
      const authorized = await runCapture(jobId, attempt);
      if (!authorized) return;
      autoDoneRef.current.add(jobId);
      // Cleanup is the retirement half and is allowed to finish either way: it is
      // invisible, and the token that authorizes it was issued to THIS job.
      await attemptCleanup(jobId);
    })();
  }, [
    lifecycle,
    viewJobId,
    artifactAvailable,
    authority,
    activationJobId,
    beginAttempt,
    stillOwned,
    runDownload,
    runCapture,
    attemptCleanup,
    retainForDiagnosis,
  ]);

  // A fresh submission resets the cleanup affordance; the Download Again blob is
  // deliberately tab-lifetime and is NOT cleared here.
  useEffect(() => {
    if (lifecycle === "submitting" || lifecycle === "idle") {
      phaseRef.current = "idle";
      setCaptureState({ status: "idle" });
    }
  }, [lifecycle]);

  const downloadArtifact = useCallback(() => {
    const jobId = currentJobId();
    if (jobId === null) return;
    const attempt = beginAttempt();
    if (!stillOwned(attempt)) return;
    void (async () => {
      const ok = await runDownload(jobId, attempt);
      if (!ok) return;
      // Shares the auto effect's coalesced per-job capture promise: entering here
      // while the auto chain is mid-capture joins it rather than starting a second
      // `/roster` fetch or a rival commit.
      const authorized = await runCapture(jobId, attempt);
      if (authorized) await attemptCleanup(jobId);
    })();
  }, [attemptCleanup, beginAttempt, currentJobId, runCapture, runDownload, stillOwned]);

  const retryCapture = useCallback(() => {
    const jobId = currentJobId();
    if (jobId === null) return;
    const gate = ref.current.capture;
    if (!gate) return;
    const attempt = beginAttempt();
    if (!stillOwned(attempt)) return;
    void (async () => {
      const outcome = await gate.retry(captureRequest(jobId, attempt));
      if (!stillOwned(attempt)) return;
      if (mountedRef.current) setCaptureState(outcome.state);
      if (outcome.token !== null) await attemptCleanup(jobId);
    })();
  }, [attemptCleanup, beginAttempt, captureRequest, currentJobId, stillOwned]);

  const dismissCapture = useCallback(async (): Promise<CleanupPhase> => {
    const jobId = currentJobId();
    if (jobId === null) return "idle";
    const gate = ref.current.capture;
    if (gate) {
      const attempt = beginAttempt();
      // Serializes with any in-flight capture inside the gate AND enforces the
      // roster-attempt fence for a capture-capable job that has not captured yet.
      const outcome = await gate.dismiss(captureRequest(jobId, attempt));
      if (mountedRef.current) setCaptureState(gate.getState(jobId));
      // No proven local removal ⇒ no token ⇒ no DELETE. Deleting the server job
      // while the real-identity candidate is still durable would strand it.
      if (outcome.status !== "dismissed") return phaseRef.current;
    }
    return attemptCleanup(jobId);
  }, [attemptCleanup, beginAttempt, captureRequest, currentJobId]);

  const downloadAgain = useCallback(() => {
    const entry = retainRef.current;
    if (entry === null) return;
    seams.current.saveBlob(entry.blob, entry.filename);
  }, []);

  // Download Again is offered ONLY for the run currently in view: a prior run's
  // retained blob must never be handed out under a later job's terminal result.
  const liveJobId = viewJobId ?? deps.controller.activation?.jobId ?? null;
  const downloadAgainForLiveJob = retained !== null && retained.jobId === liveJobId;

  return {
    captureState,
    retryCapture,
    dismissCapture,
    canDownloadAgain: downloadAgainForLiveJob,
    downloadAgainFilename: downloadAgainForLiveJob ? retained.filename : null,
    downloadAgain,
    downloadArtifact,
  };
}
