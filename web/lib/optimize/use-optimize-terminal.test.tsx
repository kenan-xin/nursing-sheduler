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
import type { RemoveOwnerSessionOutcome } from "./session-transaction";
import type { RunActivation } from "./use-optimize-run";
import { MAX_DISPLAY_FILENAME_BYTES } from "@/lib/query/sse-limits";
import { ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { createRosterStorageForDb, type RosterStorage } from "@/lib/store/roster-storage";
import { createRosterCapture } from "./roster-capture";
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
// The owner-keyed record removal the terminal chain drives. Named for what it is
// now: the controller's exact-owner retirement, not a recovery cleanup.
const retireRecord = vi.fn((): RemoveOwnerSessionOutcome | { status: "unknown-owner" } => ({
  status: "removed",
}));

beforeEach(() => {
  // Cleanup coalescing is app-lifetime (it must outlive a route unmount so a
  // remount cannot start a rival DELETE). Every test here drives job `opt_1`, so
  // without this reset one test's confirmed cleanup would be replayed by the next.
  resetRosterCaptureGate();
  for (const fn of Object.values(notify)) fn.mockClear();
  retireRecord.mockClear();
  retireRecord.mockReturnValue({ status: "removed" });
});

function activation(over: Partial<RunActivation> = {}): RunActivation {
  return {
    jobId: "opt_1",
    ownerId: "owner-1",
    anonymized: false,
    peopleCount: 2,
    reverseMap: [],
    capture: { status: "staged", snapshotRef: "owner-1", submissionOrdinal: 1 },
    ...over,
  };
}

function controllerWith(view: OptimizeRunView, act: RunActivation | null) {
  return {
    view,
    activation: act,
    retireSessionRecord: retireRecord,
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

function render(
  deps: Omit<UseOptimizeTerminalDeps, "controller">,
  view: OptimizeRunView,
  act: RunActivation | null,
) {
  type Props = { view: OptimizeRunView; act: RunActivation | null };
  return renderHook(
    (props: Props) =>
      useOptimizeTerminal({
        ...deps,
        controller: controllerWith(props.view, props.act),
      }),
    { initialProps: { view, act } as Props },
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
      { fetchXlsx, restore, saveBlob, deleteJob },
      view,
      activation({ anonymized: true, reverseMap: [["P1", 1]], peopleCount: 1 }),
    );

    rerender({
      view: completedView("opt_1", true),
      act: activation({ anonymized: true, reverseMap: [["P1", 1]], peopleCount: 1 }),
    });

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
    expect(notify.started).toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith(xlsxBlob, {
      anonymized: true,
      reverseMap: [["P1", 1]],
      peopleCount: 1,
    });
    expect(saveBlob).toHaveBeenCalledWith(restored, "schedule.xlsx");
    expect(notify.succeeded).toHaveBeenCalledWith("schedule.xlsx");
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
    expect(retireRecord).toHaveBeenCalledWith("opt_1");
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
      { fetchXlsx, restore, saveBlob, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation({ anonymized: true, reverseMap: [["P1", 1]], peopleCount: 1 }),
    );
    rerender({
      view: completedView("opt_1", true),
      act: activation({ anonymized: true, reverseMap: [["P1", 1]], peopleCount: 1 }),
    });

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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

    const { rerender } = render(
      { fetchXlsx, saveBlob, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation(),
    );
    rerender({ view: completedView("opt_1", true), act: activation() });

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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
      { fetchXlsx, saveBlob, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation(),
    );
    rerender({ view: completedView("opt_1", true), act: activation() });

    await waitFor(() => expect(notify.failed).toHaveBeenCalled());
    expect(deleteJob).not.toHaveBeenCalled();
    expect(notify.cleanup).not.toHaveBeenCalled();

    act(() => result.current.downloadArtifact());
    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
    expect(saveBlob).toHaveBeenCalledWith(xlsxBlob, "schedule.xlsx");
  });

  it("re-saves the retained blob for Download Again without re-fetching", async () => {
    const fetchXlsx = vi.fn(async () => ({ blob: xlsxBlob, filename: "schedule.xlsx" }));
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const { result, rerender } = render(
      { fetchXlsx, saveBlob, deleteJob },
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

// G6.2b re-pointed the entry: these drive `attemptCleanup` through the SURVIVING
// public action rather than the retired generic `cleanup()`. With no capture gate
// wired `dismissCapture()` reaches the identical code path, so the invariants below
// are unchanged — only the door they come through is.
describe("useOptimizeTerminal — cleanup requires BOTH server and local removal", () => {
  it("reports failed when the DELETE is confirmed but T16b cannot prove local removal", async () => {
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    retireRecord.mockReturnValueOnce({ status: "unverified" });
    const failedView: OptimizeRunView = {
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "failed",
      jobId: "opt_1",
    };
    const { result } = render({ deleteJob }, failedView, activation());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.dismissCapture();
    });
    // Server confirmed but local removal unproven → NOT a false "cleaned".
    expect(outcome).toBe("failed");
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
    expect(retireRecord).toHaveBeenCalledWith("opt_1");
    expect(notify.cleanup).toHaveBeenLastCalledWith("failed");
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
    const { result } = render({ deleteJob }, failedView, activation());
    await act(async () => {
      await result.current.dismissCapture();
    });
    // An unconfirmed server DELETE must not orphan the job by removing the local record.
    expect(retireRecord).not.toHaveBeenCalled();
    expect(notify.cleanup).toHaveBeenLastCalledWith("failed");
  });
});

describe("useOptimizeTerminal — Download Again is job-scoped", () => {
  it("does not offer run A's retained blob under run B's terminal result", async () => {
    const fetchXlsx = vi.fn(async () => ({ blob: xlsxBlob, filename: "a.xlsx" }));
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const { result, rerender } = render(
      { fetchXlsx, saveBlob, deleteJob },
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
    };
    const { result, rerender } = render({ deleteJob }, failedView, activation());
    // job-gone detaches the id (view.jobId → null, activation cleared) but the record persists.
    rerender({
      view: { ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "failed", jobId: null },
      act: null,
    });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.dismissCapture();
    });
    expect(outcome).toBe("cleaned");
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
    expect(retireRecord).toHaveBeenCalledWith("opt_1");
  });
});

describe("useOptimizeTerminal — completed with no artifact", () => {
  it("marks the download unavailable and attempts cleanup", async () => {
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const { rerender } = render({ deleteJob }, INITIAL_OPTIMIZE_RUN_VIEW, activation());
    rerender({ view: completedView("opt_1", false), act: activation() });

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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
    const { result, rerender } = render({ deleteJob }, INITIAL_OPTIMIZE_RUN_VIEW, activation());
    rerender({ view: completedView("opt_1", false), act: activation() });

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("failed"));
    expect(notify.cleanup).toHaveBeenLastCalledWith("failed");

    // The retry is the same surviving action: the coordinator remembers the failure
    // as retryable and did NOT mark the server deleted, so this re-runs both halves.
    await act(async () => {
      await result.current.dismissCapture();
    });
    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
  });
});

describe("useOptimizeTerminal — cancelled/failed dismiss cleanup", () => {
  it("cleans up a failed run on dismissal without ever auto-downloading", async () => {
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const failedView: OptimizeRunView = {
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "failed",
      jobId: "opt_1",
      error: { source: "job", code: "worker_lost", message: "worker lost" },
    };
    const { result } = render({ deleteJob }, failedView, activation());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.dismissCapture();
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
      { ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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
      { ...seams, capture: gate },
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
    expect(notify.cleanup).not.toHaveBeenCalled();

    act(() => result.current.retryCapture());
    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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
      { ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });

    await waitFor(() => expect(result.current.captureState.status).toBe("commit-failed"));
    expect(seams.deleteJob).not.toHaveBeenCalled();
    expect(seams.saveBlob).toHaveBeenCalledTimes(1);

    act(() => result.current.retryCapture());
    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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
      { ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      degraded,
    );
    rerender({ view: completedView("opt_1", true), act: degraded });

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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
      { ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });

    // The auto chain is parked in `fetching-roster`; the user hits Download.
    await waitFor(() => expect(fetchRoster).toHaveBeenCalledTimes(1));
    act(() => result.current.downloadArtifact());
    rosterGate.resolve({ solvedDays: [] });

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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
      { ...seams, capture: gate },
      INITIAL_OPTIMIZE_RUN_VIEW,
      act0,
    );
    rerender({ view: completedView("opt_1", true), act: act0 });
    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));

    await act(async () => {
      await result.current.dismissCapture();
    });
    expect(await store.readCandidate("opt_1")).toBeNull();
    expect(await store.readCurrentCandidate()).toBeNull();
    expect(result.current.captureState).toEqual({ status: "dismissed", reason: "user" });
    // Still exactly one DELETE for this job across the whole lifecycle.
    expect(seams.deleteJob).toHaveBeenCalledTimes(1);
  });

  it("dismissing a run that was never capture-capable still obtains a token before deleting", async () => {
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
    };

    const { result } = render({ ...seams, capture: gate }, failedView, act0);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.dismissCapture();
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

describe("useOptimizeTerminal — capture authority with no attached activation", () => {
  let dbCounter = 0;
  function freshStore(): RosterStorage {
    const db = new ScenarioPersistenceDb(`terminal-authority-test-${dbCounter++}`);
    return createRosterStorageForDb(() => db);
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

  // G6.2 REPLACED the remount-handoff battery that stood here. Those tests drove a
  // three-valued authority whose middle state, `pending`, existed for exactly one
  // situation: a remount whose activation was null NOW but would be attached LATER
  // by recovery's passive effect. Nothing attaches later any more, so `pending` is
  // unreachable and the deferral it caused would be a permanent stall rather than a
  // wait. What remains is the case that is still real and still needs proving.
  it("no activation for the job in view is a PROVEN absence: it settles and cleans up", async () => {
    const store = freshStore();
    const seams = downloadSeams();
    const fetchRoster = vi.fn();
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });

    render({ ...seams, capture: gate }, completedView("opt_1", false), null);

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
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

  it("an activation for a DIFFERENT job is not this job's authority", async () => {
    const store = freshStore();
    const seams = downloadSeams();
    const fetchRoster = vi.fn();
    const gate = createRosterCapture({
      store,
      fetchRoster,
      buildCandidate: ({ container }) => ({ ok: true, document: { container } }),
    });

    render(
      { ...seams, capture: gate },
      completedView("opt_1", false),
      activation({ jobId: "opt_other", ownerId: "owner-other" }),
    );

    await waitFor(() => expect(notify.cleanup).toHaveBeenLastCalledWith("cleaned"));
    // Settled from ABSENCE, not from the other job's staged snapshot: a
    // superseded attachment must never de-anonymize another job's roster.
    expect(gate.getToken("opt_1")).toMatchObject({ cause: "session_record_absent" });
    expect(fetchRoster).not.toHaveBeenCalled();
  });
});
