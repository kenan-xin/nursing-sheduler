// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "./run-view";
import {
  useOptimizeTerminal,
  type CleanupCallOutcome,
  type UseOptimizeTerminalDeps,
} from "./use-optimize-terminal";
import type { OptimizeCleanupOutcome } from "./session-recovery";
import type { RunActivation } from "./use-optimize-run";
import { MAX_DISPLAY_FILENAME_BYTES } from "@/lib/query/sse-limits";

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

function render(
  deps: Omit<UseOptimizeTerminalDeps, "recovery">,
  view: OptimizeRunView,
  act: RunActivation | null,
) {
  return renderHook(
    (props: { view: OptimizeRunView; act: RunActivation | null }) =>
      useOptimizeTerminal({
        ...deps,
        controller: controllerWith(props.view, props.act),
        recovery: { cleanup: recoveryCleanup },
      }),
    { initialProps: { view, act } },
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

describe("useOptimizeTerminal — abandon requires proven local removal", () => {
  it("abandons only when T16b proves removal", async () => {
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
    // Get to the failed cleanup surface first.
    await act(async () => {
      await result.current.cleanup();
    });
    let phase: string | undefined;
    act(() => {
      phase = result.current.abandonCleanup();
    });
    expect(phase).toBe("abandoned");
    expect(recoveryCleanup).toHaveBeenCalledWith("opt_1");
    expect(notify.cleanup).toHaveBeenLastCalledWith("retained");
    expect(result.current.cleanupPhase).toBe("abandoned");
  });

  it("stays failed when abandon cannot prove local removal", async () => {
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
    recoveryCleanup.mockReturnValueOnce({ status: "unverified" });
    let phase: string | undefined;
    act(() => {
      phase = result.current.abandonCleanup();
    });
    expect(phase).toBe("failed");
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

describe("useOptimizeTerminal — cleanup failure, retry and abandon", () => {
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

  it("abandon frees the local slot and marks the server job retained", async () => {
    const deleteJob = vi.fn(
      async (): Promise<CleanupCallOutcome> => ({ status: "failed", reason: "x" }),
    );
    const { result, rerender } = render(
      { controller: undefined as never, deleteJob },
      INITIAL_OPTIMIZE_RUN_VIEW,
      activation(),
    );
    rerender({ view: completedView("opt_1", false), act: activation() });
    await waitFor(() => expect(result.current.cleanupPhase).toBe("failed"));

    act(() => result.current.abandonCleanup());
    expect(recoveryCleanup).toHaveBeenCalledWith("opt_1");
    expect(notify.cleanup).toHaveBeenLastCalledWith("retained");
    expect(result.current.cleanupPhase).toBe("abandoned");
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
