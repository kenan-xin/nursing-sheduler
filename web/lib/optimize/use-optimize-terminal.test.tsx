// @vitest-environment jsdom
//
// `fake-indexeddb/auto` MUST load before the store modules: Dexie captures the
// IndexedDB API at open time, so a later import leaves the roster database
// unopenable and the capture assertions would degrade instead of running.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "./run-view";
import {
  useOptimizeTerminal,
  type CleanupCallOutcome,
  type UseOptimizeTerminalDeps,
} from "./use-optimize-terminal";
import type { OptimizeCleanupOutcome, OptimizeRecovery } from "./session-recovery";
import type { RunActivation } from "./use-optimize-run";
import { MAX_DISPLAY_FILENAME_BYTES } from "@/lib/query/sse-limits";
import { ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { createRosterStorageForDb, type RosterStorage } from "@/lib/store/roster-storage";
import { createRosterCapture, type CaptureRequest, type RosterCaptureGate } from "./roster-capture";
import { resetRosterCaptureGate } from "./roster-capture-app";
import { buildStagedSubmission, stageSubmissionSnapshot } from "./submission-snapshot";
import { ROSTER_SUBMISSION_VERSION } from "./roster-candidate-builder";

afterEach(() => cleanup());

const notify = {
  started: vi.fn(),
  succeeded: vi.fn(),
  unavailable: vi.fn(),
  failed: vi.fn(),
  cleanup: vi.fn(),
};
const recoveryCleanup = vi.fn((): OptimizeCleanupOutcome => ({ status: "removed" }));

beforeEach(() => {
  // Cleanup coalescing is app-lifetime (it must outlive a route unmount so a
  // remount cannot start a rival DELETE). Every test here drives job `opt_1`, so
  // without this reset one test's confirmed cleanup would be replayed by the next.
  resetRosterCaptureGate();
  for (const fn of Object.values(notify)) fn.mockClear();
  recoveryCleanup.mockClear();
});

function activation(over: Partial<RunActivation> = {}): RunActivation {
  return {
    jobId: "opt_1",
    anonymized: false,
    peopleCount: 2,
    reverseMap: [],
    reloadRecoveryAvailable: true,
    capture: { status: "staged", snapshotRef: "owner-1", submissionOrdinal: 1 },
    ...over,
  };
}

function controllerWith(view: OptimizeRunView, act: RunActivation | null) {
  return {
    view,
    activation: act,
    notifyDownloadStarted: notify.started,
    notifyDownloadSucceeded: notify.succeeded,
    notifyDownloadUnavailable: notify.unavailable,
    notifyDownloadFailed: notify.failed,
    notifyCleanup: notify.cleanup,
  };
}

function completedView(jobId: string, artifactAvailable: boolean): OptimizeRunView {
  return {
    ...INITIAL_OPTIMIZE_RUN_VIEW,
    lifecycle: "completed",
    jobId,
    download: {
      status: artifactAvailable ? "available" : "unavailable",
      artifactAvailable,
      filename: null,
    },
  };
}

const xlsxBlob = new Blob(["plain"], { type: "application/octet-stream" });

/** Wrap a REAL gate so a test can assert exactly which authorities reached it.
 *  The defect this closes is invisible in the outcome — it is about WHICH request
 *  the chain issued — so the calls themselves have to be observable. */
function spyGate(inner: RosterCaptureGate) {
  const captureCalls: CaptureRequest["capture"][] = [];
  const gate: RosterCaptureGate = {
    ...inner,
    capture(request) {
      captureCalls.push(request.capture);
      return inner.capture(request);
    },
  };
  return { gate, captureCalls };
}

/** Recovery holding a durable ACTIVE record for `jobId` whose activation has not
 *  been attached to the controller yet — the real remount handoff window. */
function resumable(jobId = "opt_1"): OptimizeRecovery {
  return { kind: "resumable", jobId, anonymized: false, peopleCount: 2 };
}

function render(
  deps: Omit<UseOptimizeTerminalDeps, "recovery">,
  view: OptimizeRunView,
  act: RunActivation | null,
  recoveryReady = true,
  recoveryState: OptimizeRecovery = { kind: "none" },
) {
  type Props = {
    view: OptimizeRunView;
    act: RunActivation | null;
    ready?: boolean;
    state?: OptimizeRecovery;
  };
  return renderHook(
    (props: Props) =>
      useOptimizeTerminal({
        ...deps,
        controller: controllerWith(props.view, props.act),
        recovery: {
          cleanup: recoveryCleanup,
          ready: props.ready ?? true,
          state: props.state ?? { kind: "none" },
        },
      }),
    { initialProps: { view, act, ready: recoveryReady, state: recoveryState } as Props },
  );
}

describe("useOptimizeTerminal — completed with artifact", () => {
  it("fetches, restores, saves the first download, retains the blob, then cleans up", async () => {
    const fetchXlsx = vi.fn(async () => ({ blob: xlsxBlob, filename: "schedule.xlsx" }));
    const restored = new Blob(["restored"], { type: "x" });
    const restore = vi.fn(async () => restored);
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));

    const view = INITIAL_OPTIMIZE_RUN_VIEW;
    const { result, rerender } = render(
      { controller: undefined as never, fetchXlsx, restore, saveBlob, deleteJob },
      view,
      activation({ anonymized: true, reverseMap: [["P1", 1]], peopleCount: 1 }),
    );

    rerender({
      view: completedView("opt_1", true),
      act: activation({ anonymized: true, reverseMap: [["P1", 1]], peopleCount: 1 }),
    });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(notify.started).toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith(xlsxBlob, {
      anonymized: true,
      reverseMap: [["P1", 1]],
      peopleCount: 1,
    });
    expect(saveBlob).toHaveBeenCalledWith(restored, "schedule.xlsx");
    expect(notify.succeeded).toHaveBeenCalledWith("schedule.xlsx");
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
    expect(recoveryCleanup).toHaveBeenCalledWith("opt_1");
    expect(notify.cleanup).toHaveBeenCalledWith("cleaned");
    expect(result.current.canDownloadAgain).toBe(true);
    expect(result.current.downloadAgainFilename).toBe("schedule.xlsx");
  });

  it("uses the AUTHORITATIVE filename for the immediate download but retains only the bounded display copy", async () => {
    // The backend stores upload names verbatim (uncapped). A pathological
    // multi-KiB filename must not pin unbounded memory in the retained React/ref
    // state, yet the FIRST browser download must save under the exact server name.
    const huge = "n".repeat(MAX_DISPLAY_FILENAME_BYTES + 500) + ".xlsx";
    const utf8 = (s: string) => new TextEncoder().encode(s).length;
    const fetchXlsx = vi.fn(async () => ({ blob: xlsxBlob, filename: huge }));
    const restored = new Blob(["restored"], { type: "x" });
    const restore = vi.fn(async () => restored);
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));

    const { result, rerender } = render(
      { controller: undefined as never, fetchXlsx, restore, saveBlob, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation({ anonymized: true, reverseMap: [["P1", 1]], peopleCount: 1 }),
    );
    rerender({
      view: completedView("opt_1", true),
      act: activation({ anonymized: true, reverseMap: [["P1", 1]], peopleCount: 1 }),
    });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    // Immediate download: exact authoritative filename (never truncated).
    expect(saveBlob).toHaveBeenCalledWith(restored, huge);
    // Retained display + run-view notification: bounded UTF-8-safe copy only.
    expect(utf8(result.current.downloadAgainFilename!)).toBe(MAX_DISPLAY_FILENAME_BYTES);
    expect(notify.succeeded).toHaveBeenCalledTimes(1);
    expect(utf8(notify.succeeded.mock.calls[0][0])).toBe(MAX_DISPLAY_FILENAME_BYTES);
  });

  it("keeps the plain download byte-path unchanged (same blob saved)", async () => {
    const fetchXlsx = vi.fn(async () => ({ blob: xlsxBlob, filename: "schedule.xlsx" }));
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));

    const { result, rerender } = render(
      { controller: undefined as never, fetchXlsx, saveBlob, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation(),
    );
    rerender({ view: completedView("opt_1", true), act: activation() });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    // Default restore bypass: the exact fetched blob is saved, never re-serialized.
    expect(saveBlob).toHaveBeenCalledWith(xlsxBlob, "schedule.xlsx");
  });

  it("never deletes the artifact when the download fails, and allows a manual retry", async () => {
    let attempt = 0;
    const fetchXlsx = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { blob: xlsxBlob, filename: "schedule.xlsx" };
    });
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));

    const { result, rerender } = render(
      { controller: undefined as never, fetchXlsx, saveBlob, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation(),
    );
    rerender({ view: completedView("opt_1", true), act: activation() });

    await waitFor(() => expect(notify.failed).toHaveBeenCalled());
    expect(deleteJob).not.toHaveBeenCalled();
    expect(result.current.cleanupPhase).toBe("idle");

    act(() => result.current.downloadArtifact());
    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(saveBlob).toHaveBeenCalledWith(xlsxBlob, "schedule.xlsx");
  });

  it("re-saves the retained blob for Download Again without re-fetching", async () => {
    const fetchXlsx = vi.fn(async () => ({ blob: xlsxBlob, filename: "schedule.xlsx" }));
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const { result, rerender } = render(
      { controller: undefined as never, fetchXlsx, saveBlob, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation(),
    );
    rerender({ view: completedView("opt_1", true), act: activation() });
    await waitFor(() => expect(result.current.canDownloadAgain).toBe(true));

    fetchXlsx.mockClear();
    saveBlob.mockClear();
    act(() => result.current.downloadAgain());
    expect(saveBlob).toHaveBeenCalledWith(xlsxBlob, "schedule.xlsx");
    expect(fetchXlsx).not.toHaveBeenCalled();
  });
});

describe("useOptimizeTerminal — cleanup requires BOTH server and local removal", () => {
  it("reports failed when the DELETE is confirmed but T16b cannot prove local removal", async () => {
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    recoveryCleanup.mockReturnValueOnce({ status: "unverified" });
    const failedView: OptimizeRunView = {
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "failed",
      jobId: "opt_1",
      resubmittable: true,
    };
    const { result } = render(
      { controller: undefined as never, deleteJob },
      failedView,
      activation(),
    );
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.cleanup();
    });
    // Server confirmed but local removal unproven → NOT a false "cleaned".
    expect(outcome).toBe("failed");
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
    expect(recoveryCleanup).toHaveBeenCalledWith("opt_1");
    expect(notify.cleanup).toHaveBeenLastCalledWith("failed");
    expect(result.current.cleanupPhase).toBe("failed");
  });

  it("reports failed and does NOT remove the local record when the DELETE is unconfirmed", async () => {
    const deleteJob = vi.fn(
      async (): Promise<CleanupCallOutcome> => ({ status: "failed", reason: "x" }),
    );
    const failedView: OptimizeRunView = {
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "failed",
      jobId: "opt_1",
    };
    const { result } = render(
      { controller: undefined as never, deleteJob },
      failedView,
      activation(),
    );
    await act(async () => {
      await result.current.cleanup();
    });
    // An unconfirmed server DELETE must not orphan the job by removing the local record.
    expect(recoveryCleanup).not.toHaveBeenCalled();
    expect(result.current.cleanupPhase).toBe("failed");
  });
});

describe("useOptimizeTerminal — Download Again is job-scoped", () => {
  it("does not offer run A's retained blob under run B's terminal result", async () => {
    const fetchXlsx = vi.fn(async () => ({ blob: xlsxBlob, filename: "a.xlsx" }));
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const { result, rerender } = render(
      { controller: undefined as never, fetchXlsx, saveBlob, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation({ jobId: "opt_A" }),
    );
    // Run A completes and retains its blob.
    rerender({ view: completedView("opt_A", true), act: activation({ jobId: "opt_A" }) });
    await waitFor(() => expect(result.current.canDownloadAgain).toBe(true));

    // Run B completes with an artifact, but its download fails (nothing retained for B).
    fetchXlsx.mockRejectedValueOnce(new Error("network"));
    rerender({ view: completedView("opt_B", true), act: activation({ jobId: "opt_B" }) });
    await waitFor(() => expect(notify.failed).toHaveBeenCalled());
    // A's blob must never be offered while viewing B's result.
    expect(result.current.canDownloadAgain).toBe(false);
    expect(result.current.downloadAgainFilename).toBeNull();
  });
});

describe("useOptimizeTerminal — job-gone cleanup", () => {
  it("cleans up a detached (job-gone) run via the last-known job id", async () => {
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const failedView: OptimizeRunView = {
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "failed",
      jobId: "opt_1",
      resubmittable: true,
    };
    const { result, rerender } = render(
      { controller: undefined as never, deleteJob },
      failedView,
      activation(),
    );
    // job-gone detaches the id (view.jobId → null, activation cleared) but the record persists.
    rerender({
      view: { ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "failed", jobId: null, resubmittable: true },
      act: null,
    });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.cleanup();
    });
    expect(outcome).toBe("cleaned");
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
    expect(recoveryCleanup).toHaveBeenCalledWith("opt_1");
  });
});

describe("useOptimizeTerminal — completed with no artifact", () => {
  it("marks the download unavailable and attempts cleanup", async () => {
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const { result, rerender } = render(
      { controller: undefined as never, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation(),
    );
    rerender({ view: completedView("opt_1", false), act: activation() });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(notify.unavailable).toHaveBeenCalled();
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
  });
});

describe("useOptimizeTerminal — cleanup failure and retry", () => {
  it("retains the record on a failed cleanup and allows retry to succeed", async () => {
    let attempt = 0;
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => {
      attempt += 1;
      return attempt === 1
        ? { status: "failed", reason: "delete-http-409" }
        : { status: "confirmed" };
    });
    const { result, rerender } = render(
      { controller: undefined as never, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation(),
    );
    rerender({ view: completedView("opt_1", false), act: activation() });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("failed"));
    expect(notify.cleanup).toHaveBeenLastCalledWith("failed");

    act(() => result.current.retryCleanup());
    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
  });
});

describe("useOptimizeTerminal — cancelled/failed dismiss cleanup", () => {
  it("cleans up on the exposed cleanup() action", async () => {
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const failedView: OptimizeRunView = {
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "failed",
      jobId: "opt_1",
      error: { source: "job", code: "worker_lost", message: "worker lost" },
      resubmittable: true,
    };
    const { result } = render(
      { controller: undefined as never, deleteJob },
      failedView,
      activation(),
    );
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.cleanup();
    });
    expect(outcome).toBe("cleaned");
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
    // A failed/cancelled run does NOT auto-download.
    expect(notify.started).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F2 — roster capture gating the terminal DELETE.
//
// These wire the REAL capture gate over a REAL IndexedDB, so the authority chain
// (snapshot → /roster → candidate commit → token → DELETE) is exercised end to end
// rather than through a double that could agree with a wrong gate.
// ---------------------------------------------------------------------------

describe("useOptimizeTerminal — roster capture gates cleanup", () => {
  let dbCounter = 0;

  function freshStore(): RosterStorage {
    const db = new ScenarioPersistenceDb(`terminal-capture-test-${dbCounter++}`);
    return createRosterStorageForDb(() => db);
  }

  async function stagedActivation(store: RosterStorage, ownerId = "owner-1") {
    const capture = await stageSubmissionSnapshot({
      ownerId,
      payload: buildStagedSubmission({
        canonicalYaml: "people: [P1]",
        reverseMap: [],
        schemaVersion: ROSTER_SUBMISSION_VERSION,
      }),
      store,
    });
    return activation({ capture });
  }

  /** The parity-download seams every branch below must leave untouched. */
  function downloadSeams() {
    const restored = new Blob(["restored"], { type: "x" });
    return {
      restored,
      fetchXlsx: vi.fn(async () => ({ blob: xlsxBlob, filename: "schedule.xlsx" })),
      restore: vi.fn(async () => restored),
      saveBlob: vi.fn(),
      deleteJob: vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" })),
    };
  }

  it("captures the roster BEFORE deleting, then cleans up exactly once", async () => {
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const order: string[] = [];
    const fetchRoster = vi.fn(async () => {
      order.push("roster");
      return { solvedDays: [] };
    });
    seams.deleteJob.mockImplementation(async () => {
      order.push("delete");
      return { status: "confirmed" as const };
    });
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(order).toEqual(["roster", "delete"]);
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
    expect(result.current.captureState.status).toBe("committed");
    // Parity download is unaffected.
    expect(seams.saveBlob).toHaveBeenCalledWith(seams.restored, "schedule.xlsx");
    expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "opt_1" });
  });

  it("a capture FETCH failure never deletes the job, and never blocks the download", async () => {
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    let attempt = 0;
    const gate = createRosterCapture({
      store,
      fetchRoster: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("roster unreachable");
        return { solvedDays: [] };
      },
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });

    await waitFor(() => expect(result.current.captureState.status).toBe("fetch-failed"));
    // The parity XLSX still reached the user …
    expect(seams.saveBlob).toHaveBeenCalledWith(seams.restored, "schedule.xlsx");
    expect(notify.succeeded).toHaveBeenCalledWith("schedule.xlsx");
    // … and the sole server artifact survives for the retry.
    expect(seams.deleteJob).not.toHaveBeenCalled();
    expect(result.current.cleanupPhase).toBe("idle");

    act(() => result.current.retryCapture());
    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
  });

  it("a capture COMMIT failure never deletes the job; its retry does not refetch /roster", async () => {
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const fetchRoster = vi.fn(async () => ({ solvedDays: [] }));
    let builds = 0;
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => {
        builds += 1;
        return builds === 1
          ? { ok: false, retryable: true, reason: "bad" }
          : { ok: true, document: { container } };
      },
    });

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });

    await waitFor(() => expect(result.current.captureState.status).toBe("commit-failed"));
    expect(seams.deleteJob).not.toHaveBeenCalled();
    expect(seams.saveBlob).toHaveBeenCalledTimes(1);

    act(() => result.current.retryCapture());
    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(fetchRoster).toHaveBeenCalledTimes(1);
  });

  it("a DEGRADED run downloads and cleans up exactly as before, with no roster capture", async () => {
    const store = freshStore();
    const seams = downloadSeams();
    const fetchRoster = vi.fn();
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: () => ({ ok: true, document: {} }),
    });
    const degraded = activation({
      capture: { status: "unavailable", reason: "snapshot_persist_failed" },
    });

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      degraded,
    );
    rerender({ view: completedView("opt_1", true), act: degraded });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(seams.saveBlob).toHaveBeenCalledWith(seams.restored, "schedule.xlsx");
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(result.current.captureState).toEqual({
      status: "unavailable",
      cause: "snapshot_persist_failed",
    });
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
  });

  it("the auto effect and a concurrent manual download share ONE capture and ONE delete", async () => {
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const rosterGate = Promise.withResolvers<unknown>();
    const fetchRoster = vi.fn(() => rosterGate.promise);
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });

    // The auto chain is parked in `fetching-roster`; the user hits Download.
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(1));
    act(() => result.current.downloadArtifact());
    rosterGate.resolve({ solvedDays: [] });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
    expect((await store.readCurrentCandidate())?.candidateVersion).toBe(1);
  });

  it("dismissing the candidate purges it and THAT explicit decision authorizes the delete", async () => {
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const gate = createRosterCapture({
      store,
      fetchRoster: async () => ({ solvedDays: [] }),
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });
    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));

    await act(async () => {
      await result.current.dismissCapture();
    });
    expect(await store.readCandidate("opt_1")).toBeNull();
    expect(await store.readCurrentCandidate()).toBeNull();
    expect(result.current.captureState).toEqual({ status: "dismissed", reason: "user" });
    // Still exactly one DELETE for this job across the whole lifecycle.
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
  });

  it("the dismiss/resubmit cleanup() path obtains a dismissal token before deleting", async () => {
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const fetchRoster = vi.fn(async () => ({ solvedDays: [] }));
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });
    const failedView: OptimizeRunView = {
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "failed",
      jobId: "opt_1",
      error: { source: "job", code: "worker_lost", message: "worker lost" },
      resubmittable: true,
    };

    const { result } = render(
      { controller: undefined as never, ...seams, capture: gate },
      failedView,
      act0,
    );

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.cleanup();
    });

    expect(outcome).toBe("cleaned");
    // A failed run produced no artifact, so it was never capture-capable: the token
    // records the roster fence as vacuous (`rosterAttempted: false`) rather than
    // silently skipped, which is the ONLY case allowed to carry that flag.
    expect(gate.getToken("opt_1")).toEqual({
      kind: "unavailable",
      jobId: "opt_1",
      cause: "no-artifact",
      rosterAttempted: false,
    });
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
  });
});

describe("useOptimizeTerminal — remount activation authority handoff", () => {
  let dbCounter = 0;
  function freshStore(): RosterStorage {
    const db = new ScenarioPersistenceDb(`terminal-handoff-test-${dbCounter++}`);
    return createRosterStorageForDb(() => db);
  }
  async function stagedActivation(store: RosterStorage, ownerId = "owner-1") {
    const capture = await stageSubmissionSnapshot({
      ownerId,
      payload: buildStagedSubmission({
        canonicalYaml: "people: [P1]",
        reverseMap: [],
        schemaVersion: ROSTER_SUBMISSION_VERSION,
      }),
      store,
    });
    return activation({ capture });
  }
  function downloadSeams() {
    const restored = new Blob(["restored"], { type: "x" });
    return {
      restored,
      fetchXlsx: vi.fn(async () => ({ blob: xlsxBlob, filename: "schedule.xlsx" })),
      restore: vi.fn(async () => restored),
      saveBlob: vi.fn(),
      deleteJob: vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" })),
    };
  }

  it("a completed no-artifact run remounted before recovery attaches DEFERS capture (no false snapshot_missing)", async () => {
    // The exact race the fixup closes. A remount's completed-job effect starts
    // before recovery has attached the activation; the OLD behaviour reached
    // capture with a null authority and the gate returned snapshot_missing +
    // DELETE. The fix defers the whole chain until recovery resolves, so the
    // intact snapshot stays usable and the server job is not destroyed early.
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const fetchRoster = vi.fn();
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });
    const noArtifactView = completedView("opt_1", false);

    // Remount state: completed run in view, activation null, recovery NOT ready.
    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      noArtifactView,
      null,
      false,
    );

    // The handoff window. The OLD behaviour would settle the gate as
    // snapshot_missing and delete; the fix leaves everything untouched.
    await waitFor(() => expect(result.current.cleanupPhase).toBe("idle"));
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(seams.deleteJob).not.toHaveBeenCalled();
    expect(gate.getState("opt_1")).toEqual({ status: "idle" });
    expect(gate.getToken("opt_1")).toBeNull();
    // NEGATIVE CONTROL: explicitly NOT the old false snapshot_missing.
    expect(gate.getState("opt_1")).not.toEqual({
      status: "unavailable",
      cause: "snapshot_missing",
    });

    // Recovery attaches the durable activation. The completed-job effect re-runs
    // and the intact snapshot drives capture to its real outcome.
    rerender({ view: noArtifactView, act: act0, ready: true, state: resumable() });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
    // A no-artifact run with a staged snapshot resolves to no-artifact, proving
    // the snapshot was read (not falsely declared missing).
    expect(gate.getToken("opt_1")).toMatchObject({
      kind: "unavailable",
      cause: "no-artifact",
    });
  });

  it("a completed artifact run remounted before recovery attaches defers the download too", async () => {
    // The download chain also reads activation; without the deferral it would
    // fail spuriously during the handoff. With the fix the whole terminal chain
    // waits, then runs cleanly once recovery attaches: one fetch, one commit,
    // one DELETE.
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const fetchRoster = vi.fn(async () => ({ solvedDays: [] }));
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });
    const completed = completedView("opt_1", true);

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      completed,
      null,
      false,
    );

    // Handoff: no download attempt, no spurious failure, no capture, no DELETE.
    await waitFor(() => expect(result.current.cleanupPhase).toBe("idle"));
    expect(seams.fetchXlsx).not.toHaveBeenCalled();
    expect(notify.failed).not.toHaveBeenCalled();
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(seams.deleteJob).not.toHaveBeenCalled();

    // Recovery attaches: exactly one download, one roster fetch, one commit.
    rerender({ view: completed, act: act0, ready: true, state: resumable() });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(seams.fetchXlsx).toHaveBeenCalledTimes(1);
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
    expect(result.current.captureState.status).toBe("committed");
  });

  it("RESTART: no-artifact, ready:true + null activation → exact activation re-enters the chain", async () => {
    // The once-guard defect: generic ready is not job-specific authority. With the
    // old behaviour the effect armed autoDoneRef on ready-alone, the gate deferred
    // the null authority, and the chain exited — so when the exact activation
    // arrived the once-guard blocked the restart and the run was stranded. The fix
    // leaves the guard open until capture is authorized, so the exact-activation
    // dep change re-enters and the chain runs to completion.
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const fetchRoster = vi.fn();
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });
    const noArtifactView = completedView("opt_1", false);

    // The intermediate state the prior tests never exercised: ready is TRUE but
    // activation is still null. Recovery holds this job's durable record, so the
    // classification is `pending` and the gate is not touched at all.
    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      noArtifactView,
      null,
      true,
      resumable(),
    );

    await waitFor(() => expect(result.current.cleanupPhase).toBe("idle"));
    expect(seams.deleteJob).not.toHaveBeenCalled();
    expect(gate.getState("opt_1")).toEqual({ status: "idle" });
    expect(gate.getToken("opt_1")).toBeNull();

    // The exact activation arrives while ready stays true. The authority dep moved
    // `pending` → `exact`, so the effect re-runs and the chain runs to completion.
    rerender({ view: noArtifactView, act: act0, ready: true, state: resumable() });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
    expect(gate.getToken("opt_1")).toMatchObject({
      kind: "unavailable",
      cause: "no-artifact",
    });
  });

  it("RESTART: artifact, ready:true + null activation → exact activation downloads and captures once", async () => {
    // The same restart, for an artifact run. Without exact authority the download
    // is skipped (it reads the activation's reverse map and would fail spuriously),
    // leaving the guard open. The exact activation then drives exactly one
    // download, one /roster fetch, one commit, and one DELETE.
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const fetchRoster = vi.fn(async () => ({ solvedDays: [] }));
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });
    const completed = completedView("opt_1", true);

    // ready:true + null activation: the download is skipped, no spurious failure.
    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      completed,
      null,
      true,
      resumable(),
    );

    await waitFor(() => expect(result.current.cleanupPhase).toBe("idle"));
    expect(seams.fetchXlsx).not.toHaveBeenCalled();
    expect(notify.failed).not.toHaveBeenCalled();
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(seams.deleteJob).not.toHaveBeenCalled();

    // Exact activation arrives: the chain restarts and runs exactly once.
    rerender({ view: completed, act: act0, ready: true, state: resumable() });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(seams.fetchXlsx).toHaveBeenCalledTimes(1);
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
    expect(result.current.captureState.status).toBe("committed");
  });

  it.each([
    ["null", (): RunActivation | null => null],
    ["mismatched", (): RunActivation | null => activation({ jobId: "opt_other" })],
  ])(
    "OVERLAP (%s activation): a ready recovery never opens a tokenless flight the exact activation joins",
    async (_label, initialActivation) => {
      // The defect this closes. `recovery.ready` is TRUE while the activation is
      // still null/mismatched, so the OLD code proceeded on generic readiness and
      // called capture with a null authority — which the gate turned into an
      // app-lifetime `inFlight` promise. An exact activation arriving before that
      // promise cleared would arm its once-guard and then JOIN the tokenless
      // request, exit without a token, and never run again.
      //
      // Readiness is not authority for THIS job: recovery's durable record names
      // opt_1 and its activation simply has not attached yet. Nothing may touch
      // the gate in that window.
      const store = freshStore();
      const act0 = await stagedActivation(store);
      const seams = downloadSeams();
      const fetchRoster = vi.fn();
      const real = createRosterCapture({
        store,
        fetchRoster,
        buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
      });
      const { gate, captureCalls } = spyGate(real);
      const noArtifactView = completedView("opt_1", false);

      const { result, rerender } = render(
        { controller: undefined as never, ...seams, capture: gate },
        noArtifactView,
        initialActivation(),
        true,
        resumable(),
      );

      await waitFor(() => expect(result.current.cleanupPhase).toBe("idle"));
      // THE discriminating assertion: the old code recorded a `null` here, and the
      // tokenless flight that call opened is what stranded the run.
      expect(captureCalls).toEqual([]);
      expect(fetchRoster).not.toHaveBeenCalled();
      expect(seams.fetchXlsx).not.toHaveBeenCalled();
      expect(seams.deleteJob).not.toHaveBeenCalled();
      expect(real.getState("opt_1")).toEqual({ status: "idle" });
      expect(real.getToken("opt_1")).toBeNull();

      // The exact activation attaches. The authority dep moves `pending` → `exact`,
      // so the chain enters ONCE and carries the real staged authority.
      rerender({ view: noArtifactView, act: act0, ready: true, state: resumable() });

      await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
      expect(captureCalls).toEqual([act0.capture]);
      // A no-artifact run has no roster to fetch; its cleanup is authorized by the
      // vacuous-fence token, not by a `/roster` attempt.
      expect(fetchRoster).not.toHaveBeenCalled();
      expect(seams.deleteJob).toHaveBeenCalledTimes(1);
      expect(real.getToken("opt_1")).toMatchObject({
        kind: "unavailable",
        cause: "no-artifact",
      });
    },
  );

  it("OVERLAP (artifact): nothing early, then exactly one download, /roster, commit and DELETE", async () => {
    // The same window for an artifact run, with `/roster` PARKED so the capture
    // flight is genuinely open across the assertions rather than already settled.
    const store = freshStore();
    const act0 = await stagedActivation(store);
    const seams = downloadSeams();
    const roster = Promise.withResolvers<unknown>();
    const fetchRoster = vi.fn(() => roster.promise);
    const real = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });
    const { gate, captureCalls } = spyGate(real);
    const completed = completedView("opt_1", true);

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      completed,
      null,
      true,
      resumable(),
    );

    await waitFor(() => expect(result.current.cleanupPhase).toBe("idle"));
    expect(captureCalls).toEqual([]);
    expect(seams.fetchXlsx).not.toHaveBeenCalled();
    expect(notify.failed).not.toHaveBeenCalled();
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(seams.deleteJob).not.toHaveBeenCalled();

    rerender({ view: completed, act: act0, ready: true, state: resumable() });

    // Mid-flight: the download has run and `/roster` is in flight but parked. No
    // token exists yet, so the sole server artifact must still be intact.
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(1));
    expect(seams.fetchXlsx).toHaveBeenCalledTimes(1);
    expect(real.getToken("opt_1")).toBeNull();
    expect(seams.deleteJob).not.toHaveBeenCalled();

    roster.resolve({ solvedDays: [] });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(captureCalls).toEqual([act0.capture]);
    expect(seams.fetchXlsx).toHaveBeenCalledTimes(1);
    expect(fetchRoster).toHaveBeenCalledTimes(1);
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
    expect(result.current.captureState.status).toBe("committed");
  });

  it("PROVEN absence: a completed no-artifact run with no durable record settles and cleans up", async () => {
    // The other side of the classification, and why `pending` and `proven-absent`
    // must be distinct. Recovery finished and its slot is EMPTY, so no activation
    // can ever attach for this job. Deferring here would strand the run with no
    // token and no cleanup forever; it settles instead and releases the server job.
    const store = freshStore();
    const seams = downloadSeams();
    const fetchRoster = vi.fn();
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });

    const { result } = render(
      { controller: undefined as never, ...seams, capture: gate },
      completedView("opt_1", false),
      null,
      true,
      { kind: "none" },
    );

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(gate.getToken("opt_1")).toEqual({
      kind: "unavailable",
      jobId: "opt_1",
      cause: "session_record_absent",
      rosterAttempted: false,
    });
    // Never capture-capable: no snapshot ref to reach, so no `/roster` attempt.
    expect(fetchRoster).not.toHaveBeenCalled();
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
  });

  // Every recovery state that is NOT an empty slot. `none` is the only one that
  // proves all three things a DELETE token needs at once — no record can attach, no
  // retained provisional's owner id could still name a staged snapshot, and
  // `recovery.cleanup(jobId)` answers `absent` so the LOCAL half can finish. Minting
  // a token from any of these confirms a server deletion whose local half can never
  // complete, leaving the terminal permanently `failed`.
  const NOT_ABSENCE: [string, OptimizeRecovery][] = [
    ["interrupted", { kind: "interrupted", anonymized: false, peopleCount: 2 }],
    ["resumable for ANOTHER job", resumable("opt_other")],
    ["unreadable", { kind: "unreadable" }],
    ["storage-error", { kind: "storage-error" }],
  ];

  it.each(NOT_ABSENCE)(
    "NOT absence (%s): nothing settles, no token is minted, and no DELETE is authorized",
    async (_label, state) => {
      const store = freshStore();
      const seams = downloadSeams();
      const fetchRoster = vi.fn();
      const real = createRosterCapture({
        store,
        fetchRoster,
        buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
      });
      const { gate, captureCalls } = spyGate(real);

      const { result } = render(
        { controller: undefined as never, ...seams, capture: gate },
        completedView("opt_1", false),
        null,
        true,
        state,
      );

      await waitFor(() => expect(result.current.cleanupPhase).toBe("idle"));
      expect(captureCalls).toEqual([]);
      expect(real.getState("opt_1")).toEqual({ status: "idle" });
      expect(real.getToken("opt_1")).toBeNull();
      expect(seams.deleteJob).not.toHaveBeenCalled();
      // Explicitly not the absence this used to be mistaken for.
      expect(real.getState("opt_1")).not.toEqual({
        status: "unavailable",
        cause: "session_record_absent",
      });
    },
  );

  it("an INTERRUPTED record may be this job's retained provisional — and its retirement reflows to cleanup", async () => {
    // The dangerous case, in full. `activation-persistence-failed` leaves the
    // provisional in the slot still carrying the owner id that names a staged
    // snapshot; after a remount the opaque degraded-cleanup capability is gone, so
    // it cannot be matched to the displayed job by job id. Minting a DELETE here
    // would destroy the server artifact for a run whose snapshot is sitting right
    // there, and `recovery.cleanup` would then answer `not-current` — leaving the
    // terminal `failed` with the provisional still blocking submission.
    const store = freshStore();
    await stagedActivation(store); // stages owner-1's snapshot, activation NOT attached
    const seams = downloadSeams();
    const fetchRoster = vi.fn();
    const real = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });
    const { gate } = spyGate(real);
    const noArtifactView = completedView("opt_1", false);

    const { result, rerender } = render(
      { controller: undefined as never, ...seams, capture: gate },
      noArtifactView,
      null,
      true,
      { kind: "interrupted", anonymized: false, peopleCount: 2 },
    );

    await waitFor(() => expect(result.current.cleanupPhase).toBe("idle"));
    expect(real.getToken("opt_1")).toBeNull();
    expect(seams.deleteJob).not.toHaveBeenCalled();
    // The staged snapshot that provisional still points at is untouched.
    expect(await store.readSubmissionSnapshot("owner-1")).not.toBeNull();
    expect(await store.listSubmissionOrdinals()).toEqual([1]);

    // THE ESCAPE, and why this is inertness rather than deadlock. Retiring it empties
    // the slot; `none` is the one provable absence, the classification is an effect
    // dependency, so the chain re-runs and cleanup completes — no second user
    // action on the terminal, no new UI.
    rerender({ view: noArtifactView, act: null, ready: true, state: { kind: "none" } });

    await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
    expect(real.getToken("opt_1")).toMatchObject({
      kind: "unavailable",
      cause: "session_record_absent",
    });
  });

  it.each([
    ["null", (): RunActivation | null => null],
    ["mismatched", (): RunActivation | null => activation({ jobId: "opt_other" })],
  ])(
    "OVERLAP (%s activation): a DISMISSAL during the handoff opens no flight and deletes exactly once",
    async (_label, initialActivation) => {
      // The same joinable-flight defect reached through Dismiss / cleanup() rather
      // than the automatic effect: the old `dismiss()` called `start()` with a null
      // authority, and the exact activation's capture joined that tokenless flight.
      const store = freshStore();
      const act0 = await stagedActivation(store);
      const seams = downloadSeams();
      const fetchRoster = vi.fn(async () => ({ solvedDays: [] }));
      const real = createRosterCapture({
        store,
        fetchRoster,
        buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
      });
      const { gate } = spyGate(real);
      const completed = completedView("opt_1", true);

      const { result, rerender } = render(
        { controller: undefined as never, ...seams, capture: gate },
        completed,
        initialActivation(),
        true,
        resumable(),
      );

      // The user dismisses inside the handoff window.
      let phase: string | undefined;
      await act(async () => {
        phase = await result.current.dismissCapture();
      });
      expect(phase).toBe("idle");
      expect(real.getState("opt_1")).toEqual({ status: "idle" });
      expect(real.getToken("opt_1")).toBeNull();
      expect(fetchRoster).not.toHaveBeenCalled();
      expect(seams.deleteJob).not.toHaveBeenCalled();

      // Exact activation attaches. The recorded intent is honoured by the flight
      // that has authority: one roster fence, one dismissal, one DELETE.
      rerender({ view: completed, act: act0, ready: true, state: resumable() });

      await waitFor(() => expect(result.current.cleanupPhase).toBe("cleaned"));
      expect(fetchRoster).toHaveBeenCalledTimes(1);
      expect(seams.deleteJob).toHaveBeenCalledTimes(1);
      expect(real.getToken("opt_1")).toMatchObject({ kind: "dismissed", reason: "user" });
      expect(await store.readCurrentCandidate()).toBeNull();
    },
  );
});
