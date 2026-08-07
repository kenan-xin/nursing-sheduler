"use client";

// T16e — terminal-outcome orchestration: download, restoration, first browser
// download, tab-lifetime Download Again, and deterministic best-effort cleanup.
//
// This hook owns the ticket's terminal-outcome table. It never reads or writes the
// durable session record directly (that is T16b/T16q); it drives the controller's
// notify* signals and calls T16b's `cleanup(jobId)` for record removal. The exact
// ordering it guarantees for a completed job with a downloadable artifact:
//
//   fetch artifact → restore original ids when anonymized → complete the FIRST
//   browser download → retain a tab-lifetime blob for Download Again → attempt a
//   best-effort terminal DELETE.
//
// The only server artifact is NEVER deleted before a successful local
// restoration/download: a failed download leaves the artifact available to retry
// and does not attempt cleanup. Cleanup is confirmed only on a DELETE 204 or an
// exact code-first job-not-found; any other outcome retains the record (the slot
// stays occupied and blocks repeat) and offers explicit retry or abandon — without
// ever resetting the successful terminal view or the Download Again blob.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOptimizeXlsx } from "@/lib/query/optimize";
import { isExactJobGoneResponse } from "@/lib/bff/errors";
import { MAX_DISPLAY_FILENAME_BYTES, truncateUtf8 } from "@/lib/query/sse-limits";
import {
  applyPeopleIdRestoration,
  type PeopleIdRestorationInput,
} from "./restore-people-ids-in-xlsx";
import type { OptimizeRunController } from "./use-optimize-run";
import type { OptimizeSessionRecovery } from "./session-recovery";
import type { OptimizeObservability } from "./optimize-observability";
import type { CaptureRequest, RosterCaptureGate, RosterCaptureState } from "./roster-capture";
import { getCleanupCoordinator, type CleanupCoordinator } from "./roster-capture-app";

/** Best-effort terminal DELETE result. `confirmed` ⇒ 204 or exact job-not-found. */
export type CleanupCallOutcome = { status: "confirmed" } | { status: "failed"; reason: string };

/** The terminal cleanup progression the screen renders. */
export type CleanupPhase = "idle" | "cleaning" | "cleaned" | "failed";

/** The controller surface the terminal orchestration drives. */
type TerminalController = Pick<
  OptimizeRunController,
  | "view"
  | "activation"
  | "notifyDownloadStarted"
  | "notifyDownloadSucceeded"
  | "notifyDownloadUnavailable"
  | "notifyDownloadFailed"
  | "notifyCleanup"
>;

/**
 * What this tab can prove about the capture authority for ONE completed job.
 *
 * Generic `recovery.ready` is deliberately NOT a member of this type. Readiness
 * says the boot inspection finished, not what it found for THIS job, and starting
 * the chain on it opens a tokenless capture flight that a later exact activation
 * JOINS — the joined result carries no token, so the exact pass exits with its own
 * once-guard armed and no dependency left to change, stranding the run.
 */
export type JobCaptureAuthority = "exact" | "proven-absent" | "pending";

/**
 * Classify the capture authority for `jobId` from the attached activation and
 * recovery's boot inspection. Pure, so the completed-job effect can hold its
 * result as a primitive dependency and observe every transition into it.
 */
export function classifyJobCaptureAuthority(
  jobId: string,
  activationJobId: string | null,
  recovery: Pick<OptimizeSessionRecovery, "ready" | "state">,
): JobCaptureAuthority {
  if (activationJobId === jobId) return "exact";
  if (!recovery.ready) return "pending";
  switch (recovery.state.kind) {
    case "none":
      // The ONLY safe absence, because an empty slot proves all three things a
      // DELETE token needs at once: no active record can attach, no retained
      // provisional's owner id could still name a staged snapshot, and there is
      // nothing for `recovery.cleanup(jobId)` to preserve — it answers `absent`,
      // so the LOCAL half of cleanup can actually finish. Every other state below
      // fails at least one of those, and a token that only completes its server
      // half leaves the terminal permanently `failed` with the local record intact.
      return "proven-absent";
    case "resumable":
    case "interrupted":
    case "unreadable":
    case "storage-error":
      // Everything else is inert — no token, no DELETE, the server artifact intact:
      //
      //   • `resumable` naming THIS job — its activation is still in flight;
      //     recovery attaches it from a passive effect that runs after this hook's.
      //   • `resumable` naming ANOTHER job — this job has no record, but that one
      //     must be PRESERVED, and `cleanup(jobId)` answers `not-current`.
      //   • `interrupted` — may be THIS accepted job's retained provisional after an
      //     `activation-persistence-failed` write, still carrying the owner id that
      //     names a staged snapshot. After a remount the opaque degraded-cleanup
      //     capability is gone, so it cannot be matched to this job by job id and
      //     its absence is simply not provable.
      //   • `unreadable` / `storage-error` — a read that failed proves nothing.
      //
      // None of these deadlocks. Each has an EXISTING escape — the next Optimize
      // click retires an interrupted record, or the other job resolves — that empties the
      // slot; `recovery.state` then becomes `none`, this classification flips, and
      // because it is an effect dependency the chain re-runs and cleanup completes
      // with no second user action and no new UI.
      return "pending";
  }
}

export interface UseOptimizeTerminalDeps {
  controller: TerminalController;
  /**
   * `cleanup` drives the durable record removal after a confirmed server DELETE;
   * `ready` and `state` together give this hook a JOB-SPECIFIC classification of
   * the capture authority (see `classifyJobCaptureAuthority`). A remount starts
   * with component-local activation null and recovery attaches the durable record
   * from a passive effect that runs AFTER this hook's completed-job effect, so the
   * chain waits for exact activation or a proven absence — never for readiness
   * alone, which says nothing about this job.
   */
  recovery: Pick<OptimizeSessionRecovery, "cleanup" | "ready" | "state">;
  observability?: OptimizeObservability;
  /** Defaults to `fetchOptimizeXlsx`. */
  fetchXlsx?: (jobId: string) => Promise<{ blob: Blob; filename: string }>;
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
  cleanupPhase: CleanupPhase;
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
  /** Best-effort terminal cleanup for the current job (dismiss/resubmit path):
   *  server DELETE AND T16b local record removal. Resolves `cleaned` ONLY when the
   *  server confirmed and T16b proved local removal (`removed`/`absent`). */
  cleanup(): Promise<CleanupPhase>;
  retryCleanup(): void;
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
 * completed job with no artifact attempts cleanup only. Cancelled/failed runs
 * defer cleanup to the dismiss/resubmit path (`cleanup()`), matching the ticket's
 * row semantics. Retry/abandon never reset the successful terminal view.
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

  const [cleanupPhase, setCleanupPhase] = useState<CleanupPhase>("idle");
  // The phase is also mirrored in a ref so the stable async callbacks can report the
  // CURRENT phase without re-creating themselves on every phase change.
  const phaseRef = useRef<CleanupPhase>("idle");
  const [captureState, setCaptureState] = useState<RosterCaptureState>({ status: "idle" });
  const [retained, setRetained] = useState<{ jobId: string; filename: string } | null>(null);
  const retainRef = useRef<RetainedDownload | null>(null);
  // Jobs whose terminal auto-chain has already fired (download+cleanup runs once).
  const autoDoneRef = useRef<Set<string>>(new Set());
  // The last non-null job id seen. `job-gone`/`control-job-gone` detach the job id
  // (view.jobId → null, activation cleared) while the durable record still occupies
  // the slot; cleanup/resubmit must still target that id so a DELETE returns
  // job-not-found (confirmed cleanup) and frees the record. Cleared on a fresh run.
  const lastJobIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  // Cleanup coalescing lives at APP lifetime, alongside the capture tokens it
  // consumes — not in this hook's refs. The token survives a route unmount, so a
  // mount-local coalescer would let the old route's finishing chain and a remounted
  // manual action each read the same token and each start a DELETE.
  const cleanupCoordinator = deps.cleanup ?? getCleanupCoordinator();

  const applyPhase = useCallback((phase: CleanupPhase): CleanupPhase => {
    phaseRef.current = phase;
    if (mountedRef.current) setCleanupPhase(phase);
    return phase;
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
  const runDownload = useCallback(async (jobId: string): Promise<boolean> => {
    const { controller } = ref.current;
    const activation = controller.activation;
    if (!activation || activation.jobId !== jobId) {
      // Without the retained reverse map we cannot safely restore/deliver the file.
      controller.notifyDownloadFailed("The restoration data for this run is unavailable.");
      return false;
    }
    controller.notifyDownloadStarted();
    try {
      const { blob, filename } = await seams.current.fetchXlsx(jobId);
      const restored = await seams.current.restore(blob, {
        anonymized: activation.anonymized,
        reverseMap: activation.reverseMap,
        peopleCount: activation.peopleCount,
      });
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
      controller.notifyDownloadFailed(
        error instanceof Error ? error.message : "Unable to download the schedule.",
      );
      return false;
    }
  }, []);

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
  const captureRequest = useCallback((jobId: string): CaptureRequest => {
    const { controller, recovery } = ref.current;
    const activation = controller.activation;
    const entry = retainRef.current;
    let capture: CaptureRequest["capture"] = null;
    if (activation !== null && activation.jobId === jobId) {
      capture = activation.capture;
    } else if (
      classifyJobCaptureAuthority(jobId, activation?.jobId ?? null, recovery) === "proven-absent"
    ) {
      capture = { status: "absent" };
    }
    return {
      jobId,
      capture,
      frozenXlsx: entry !== null && entry.jobId === jobId ? entry.blob : null,
    };
  }, []);

  // Run (or join) capture and report whether a terminal DELETE is now authorized.
  // With no gate wired this is vacuously true, preserving the pre-capture chain.
  const runCapture = useCallback(
    async (jobId: string): Promise<boolean> => {
      const gate = ref.current.capture;
      if (!gate) return true;
      const outcome = await gate.capture(captureRequest(jobId));
      if (mountedRef.current) setCaptureState(outcome.state);
      return outcome.token !== null;
    },
    [captureRequest],
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
          const { controller, recovery, observability } = ref.current;
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
          const local = recovery.cleanup(jobId);
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

  // Auto terminal chain: a completed job downloads (when an artifact exists) then
  // cleans up; a completed job with no artifact cleans up only. Runs once per job.
  const lifecycle = deps.controller.view.lifecycle;
  const viewJobId = deps.controller.view.jobId;
  const artifactAvailable = deps.controller.view.download.artifactAvailable;

  // Authority handoff. A remount starts with component-local activation null,
  // and recovery attaches the durable record from a passive effect that runs
  // AFTER this hook's completed-job effect. Running the chain before authority
  // resolves would pass `capture: null` to the gate — which defers, but ALSO
  // opened a joinable app-lifetime flight that the exact activation would then
  // join, taking its tokenless outcome while arming its own once-guard.
  //
  // So the proceed condition is JOB-SPECIFIC, never generic readiness: either the
  // exact activation is attached, or recovery has PROVEN no record can attach for
  // this job. `authority` is a plain string, so every transition into it (and any
  // change of attached job) is an observable dependency that restarts the chain.
  const activationJobId = deps.controller.activation?.jobId ?? null;
  const authority: JobCaptureAuthority =
    viewJobId === null
      ? "pending"
      : classifyJobCaptureAuthority(viewJobId, activationJobId, deps.recovery);

  // Remember the last non-null job id (survives a `job-gone` detach) and clear it
  // on a fresh run so cleanup never targets a superseded job.
  if (viewJobId !== null) lastJobIdRef.current = viewJobId;
  else if (lifecycle === "submitting" || lifecycle === "idle") lastJobIdRef.current = null;
  useEffect(() => {
    if (viewJobId === null || lifecycle !== "completed") return;
    if (autoDoneRef.current.has(viewJobId)) return;
    // Nothing is proven about this job yet — do not touch the gate at all.
    if (authority === "pending") return;
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
        const ok = await runDownload(jobId);
        if (!ok) return;
      } else {
        ref.current.controller.notifyDownloadUnavailable();
      }
      // Capture runs BEFORE any DELETE and is the gate on it. A `fetch-failed` /
      // `commit-failed` capture issues no token, so the job survives for Retry — and
      // the once-guard is armed only once capture is authorized, so an unauthorized
      // outcome leaves the guard open for an explicit retry.
      const authorized = await runCapture(jobId);
      if (!authorized) return;
      autoDoneRef.current.add(jobId);
      await attemptCleanup(jobId);
    })();
  }, [
    lifecycle,
    viewJobId,
    artifactAvailable,
    authority,
    activationJobId,
    runDownload,
    runCapture,
    attemptCleanup,
  ]);

  // A fresh submission resets the cleanup affordance; the Download Again blob is
  // deliberately tab-lifetime and is NOT cleared here.
  useEffect(() => {
    if (lifecycle === "submitting" || lifecycle === "idle") {
      phaseRef.current = "idle";
      setCleanupPhase("idle");
      setCaptureState({ status: "idle" });
    }
  }, [lifecycle]);

  const downloadArtifact = useCallback(() => {
    const jobId = currentJobId();
    if (jobId === null) return;
    void (async () => {
      const ok = await runDownload(jobId);
      if (!ok) return;
      // Shares the auto effect's coalesced per-job capture promise: entering here
      // while the auto chain is mid-capture joins it rather than starting a second
      // `/roster` fetch or a rival commit.
      const authorized = await runCapture(jobId);
      if (authorized) await attemptCleanup(jobId);
    })();
  }, [attemptCleanup, currentJobId, runCapture, runDownload]);

  const retryCapture = useCallback(() => {
    const jobId = currentJobId();
    if (jobId === null) return;
    const gate = ref.current.capture;
    if (!gate) return;
    void (async () => {
      const outcome = await gate.retry(captureRequest(jobId));
      if (mountedRef.current) setCaptureState(outcome.state);
      if (outcome.token !== null) await attemptCleanup(jobId);
    })();
  }, [attemptCleanup, captureRequest, currentJobId]);

  const dismissCapture = useCallback(async (): Promise<CleanupPhase> => {
    const jobId = currentJobId();
    if (jobId === null) return "idle";
    const gate = ref.current.capture;
    if (gate) {
      // Serializes with any in-flight capture inside the gate AND enforces the
      // roster-attempt fence for a capture-capable job that has not captured yet.
      const outcome = await gate.dismiss(captureRequest(jobId));
      if (mountedRef.current) setCaptureState(gate.getState(jobId));
      // No proven local removal ⇒ no token ⇒ no DELETE. Deleting the server job
      // while the real-identity candidate is still durable would strand it.
      if (outcome.status !== "dismissed") return phaseRef.current;
    }
    return attemptCleanup(jobId);
  }, [attemptCleanup, captureRequest, currentJobId]);

  const downloadAgain = useCallback(() => {
    const entry = retainRef.current;
    if (entry === null) return;
    seams.current.saveBlob(entry.blob, entry.filename);
  }, []);

  // The dismiss/resubmit path. With capture wired this IS an explicit decline of the
  // candidate, so it goes through the gate to obtain a dismissal token rather than
  // deleting on no authority at all (the pre-capture behaviour).
  const cleanup = useCallback(async (): Promise<CleanupPhase> => {
    const jobId = currentJobId();
    if (jobId === null) return "idle";
    if (ref.current.capture) return dismissCapture();
    return attemptCleanup(jobId);
  }, [attemptCleanup, currentJobId, dismissCapture]);

  const retryCleanup = useCallback(() => {
    const jobId = currentJobId();
    if (jobId === null) return;
    void attemptCleanup(jobId);
  }, [attemptCleanup, currentJobId]);

  // Download Again is offered ONLY for the run currently in view: a prior run's
  // retained blob must never be handed out under a later job's terminal result.
  const liveJobId = viewJobId ?? deps.controller.activation?.jobId ?? null;
  const downloadAgainForLiveJob = retained !== null && retained.jobId === liveJobId;

  return {
    cleanupPhase,
    captureState,
    retryCapture,
    dismissCapture,
    canDownloadAgain: downloadAgainForLiveJob,
    downloadAgainFilename: downloadAgainForLiveJob ? retained.filename : null,
    downloadAgain,
    downloadArtifact,
    cleanup,
    retryCleanup,
  };
}
