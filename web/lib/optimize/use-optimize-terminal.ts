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

/** Best-effort terminal DELETE result. `confirmed` ⇒ 204 or exact job-not-found. */
export type CleanupCallOutcome = { status: "confirmed" } | { status: "failed"; reason: string };

/** The terminal cleanup progression the screen renders. */
export type CleanupPhase = "idle" | "cleaning" | "cleaned" | "failed" | "abandoned";

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

export interface UseOptimizeTerminalDeps {
  controller: TerminalController;
  recovery: Pick<OptimizeSessionRecovery, "cleanup">;
  observability?: OptimizeObservability;
  /** Defaults to `fetchOptimizeXlsx`. */
  fetchXlsx?: (jobId: string) => Promise<{ blob: Blob; filename: string }>;
  /** Defaults to a same-origin `DELETE /api/optimize/{id}`. */
  deleteJob?: (jobId: string) => Promise<CleanupCallOutcome>;
  /** Defaults to a throwaway anchor-click browser download. */
  saveBlob?: (blob: Blob, filename: string) => void;
  /** Defaults to `applyPeopleIdRestoration` (plain path is a byte-identical bypass). */
  restore?: (blob: Blob, input: PeopleIdRestorationInput) => Promise<Blob>;
}

/** The terminal surface consumed by the screen. */
export interface OptimizeTerminal {
  cleanupPhase: CleanupPhase;
  /** Whether the tab retains a restored blob for a re-download without re-fetch. */
  canDownloadAgain: boolean;
  downloadAgainFilename: string | null;
  /** Re-save the retained blob (no re-fetch, no re-validation). */
  downloadAgain(): void;
  /** (Re)attempt the completed-artifact download flow, then cleanup on success. */
  downloadArtifact(): void;
  /** Best-effort terminal cleanup for the current job (dismiss/resubmit path):
   *  server DELETE AND T16b local record removal. Resolves `cleaned` ONLY when the
   *  server confirmed and T16b proved local removal (`removed`/`absent`). */
  cleanup(): Promise<CleanupPhase>;
  retryCleanup(): void;
  /** Explicit abandon: free the local slot (leaving the server job to retention).
   *  Returns `abandoned` only when T16b proved local removal; otherwise `failed`
   *  (the record could not be proven gone). The screen gates this behind a
   *  destructive confirmation. */
  abandonCleanup(): CleanupPhase;
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

  const markCleanupFailed = useCallback((jobId: string): CleanupPhase => {
    const { controller, observability } = ref.current;
    controller.notifyCleanup("failed");
    observability?.emit({ kind: "cleanup", jobId, result: "failed" });
    if (mountedRef.current) setCleanupPhase("failed");
    return "failed";
  }, []);

  // Cleanup is TWO distinct required steps: an exact server DELETE confirmation
  // (204 / job-not-found) AND a T16b local record removal proven `removed`/`absent`.
  // Anything else — an unconfirmed DELETE, or a `not-current`/`changed`/`unverified`
  // local outcome — leaves the slot occupied (or its absence unproven), so it stays
  // `failed` (a blocking retry/abandon surface), never a false `cleaned`.
  const attemptCleanup = useCallback(
    async (jobId: string): Promise<CleanupPhase> => {
      const { controller, recovery, observability } = ref.current;
      if (mountedRef.current) setCleanupPhase("cleaning");
      const server = await seams.current.deleteJob(jobId);
      if (server.status !== "confirmed") return markCleanupFailed(jobId);
      const local = recovery.cleanup(jobId);
      if (local.status !== "removed" && local.status !== "absent") {
        return markCleanupFailed(jobId);
      }
      controller.notifyCleanup("cleaned");
      observability?.emit({ kind: "cleanup", jobId, result: "cleaned" });
      if (mountedRef.current) setCleanupPhase("cleaned");
      return "cleaned";
    },
    [markCleanupFailed],
  );

  // Auto terminal chain: a completed job downloads (when an artifact exists) then
  // cleans up; a completed job with no artifact cleans up only. Runs once per job.
  const lifecycle = deps.controller.view.lifecycle;
  const viewJobId = deps.controller.view.jobId;
  const artifactAvailable = deps.controller.view.download.artifactAvailable;

  // Remember the last non-null job id (survives a `job-gone` detach) and clear it
  // on a fresh run so cleanup never targets a superseded job.
  if (viewJobId !== null) lastJobIdRef.current = viewJobId;
  else if (lifecycle === "submitting" || lifecycle === "idle") lastJobIdRef.current = null;
  useEffect(() => {
    if (viewJobId === null || lifecycle !== "completed") return;
    if (autoDoneRef.current.has(viewJobId)) return;
    autoDoneRef.current.add(viewJobId);
    const jobId = viewJobId;
    void (async () => {
      if (artifactAvailable) {
        const ok = await runDownload(jobId);
        // Never delete the only server artifact before a successful local download.
        if (!ok) {
          autoDoneRef.current.delete(jobId);
          return;
        }
        await attemptCleanup(jobId);
      } else {
        ref.current.controller.notifyDownloadUnavailable();
        await attemptCleanup(jobId);
      }
    })();
  }, [lifecycle, viewJobId, artifactAvailable, runDownload, attemptCleanup]);

  // A fresh submission resets the cleanup affordance; the Download Again blob is
  // deliberately tab-lifetime and is NOT cleared here.
  useEffect(() => {
    if (lifecycle === "submitting" || lifecycle === "idle") setCleanupPhase("idle");
  }, [lifecycle]);

  const downloadArtifact = useCallback(() => {
    const jobId = currentJobId();
    if (jobId === null) return;
    void (async () => {
      const ok = await runDownload(jobId);
      if (ok) await attemptCleanup(jobId);
    })();
  }, [attemptCleanup, currentJobId, runDownload]);

  const downloadAgain = useCallback(() => {
    const entry = retainRef.current;
    if (entry === null) return;
    seams.current.saveBlob(entry.blob, entry.filename);
  }, []);

  const cleanup = useCallback(async (): Promise<CleanupPhase> => {
    const jobId = currentJobId();
    if (jobId === null) return "idle";
    return attemptCleanup(jobId);
  }, [attemptCleanup, currentJobId]);

  const retryCleanup = useCallback(() => {
    const jobId = currentJobId();
    if (jobId === null) return;
    void attemptCleanup(jobId);
  }, [attemptCleanup, currentJobId]);

  // Explicit abandon: give up on the server DELETE and free the LOCAL slot so a new
  // run can start, leaving the server job/artifact to retention. It still requires a
  // proven local removal (`removed`/`absent`); if T16b cannot prove the record is
  // gone (`not-current`/`changed`/`unverified`) the slot stays occupied and the
  // surface remains `failed`. Confirmation/warning is owned by the screen.
  const abandonCleanup = useCallback((): CleanupPhase => {
    const jobId = currentJobId();
    if (jobId === null) return "idle";
    const { controller, recovery, observability } = ref.current;
    const local = recovery.cleanup(jobId);
    if (local.status !== "removed" && local.status !== "absent") {
      return markCleanupFailed(jobId);
    }
    controller.notifyCleanup("retained");
    observability?.emit({ kind: "cleanup", jobId, result: "abandoned" });
    setCleanupPhase("abandoned");
    return "abandoned";
  }, [currentJobId, markCleanupFailed]);

  // Download Again is offered ONLY for the run currently in view: a prior run's
  // retained blob must never be handed out under a later job's terminal result.
  const liveJobId = viewJobId ?? deps.controller.activation?.jobId ?? null;
  const downloadAgainForLiveJob = retained !== null && retained.jobId === liveJobId;

  return {
    cleanupPhase,
    canDownloadAgain: downloadAgainForLiveJob,
    downloadAgainFilename: downloadAgainForLiveJob ? retained.filename : null,
    downloadAgain,
    downloadArtifact,
    cleanup,
    retryCleanup,
    abandonCleanup,
  };
}
