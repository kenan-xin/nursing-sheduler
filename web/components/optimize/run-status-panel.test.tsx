// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { INITIAL_OPTIMIZE_RUN_VIEW, type CleanupPhase, type OptimizeRunView } from "@/lib/optimize";
import { RunStatusPanel, type RunStatusPanelProps } from "./run-status-panel";

afterEach(() => cleanup());

const handlers = {
  onCancel: vi.fn(),
  onFinishNow: vi.fn(),
  onResubmit: vi.fn(),
  onDismiss: vi.fn(),
  onDownloadArtifact: vi.fn(),
  onDownloadAgain: vi.fn(),
  onRetryCleanup: vi.fn(),
  onAbandonCleanup: vi.fn(),
};

function view(over: Partial<OptimizeRunView>): OptimizeRunView {
  return { ...INITIAL_OPTIMIZE_RUN_VIEW, ...over };
}

function setup(v: OptimizeRunView, over: Partial<RunStatusPanelProps> = {}) {
  const props: RunStatusPanelProps = {
    view: v,
    submitting: false,
    cleanupPhase: "idle" as CleanupPhase,
    canDownloadAgain: false,
    downloadAgainFilename: null,
    ...handlers,
    ...over,
  };
  render(<RunStatusPanel {...props} />);
  return props;
}

describe("RunStatusPanel — status and score", () => {
  it("shows the idle status and no-incumbent score", () => {
    setup(INITIAL_OPTIMIZE_RUN_VIEW);
    expect(screen.getByTestId("optimize-status")).toHaveTextContent("Idle");
    expect(screen.getByTestId("optimize-score")).toHaveTextContent("No incumbent yet");
    expect(screen.getByTestId("optimize-job-detail")).toHaveTextContent(
      "No optimization has been started.",
    );
  });

  it("shows the live incumbent and queue position", () => {
    setup(view({ lifecycle: "queued", jobId: "opt_1", queuePosition: 3, latestScore: 12 }));
    expect(screen.getByTestId("optimize-status")).toHaveTextContent("Queued, position 3");
    expect(screen.getByTestId("optimize-score")).toHaveTextContent("12");
    expect(screen.getByText("Job ID: opt_1")).toBeInTheDocument();
  });
});

describe("RunStatusPanel — controls", () => {
  it("gates cancel and finish-now on server controls", async () => {
    const props = setup(
      view({
        lifecycle: "running",
        jobId: "opt_1",
        controls: { cancellable: true, earlyCompletionAvailable: false },
      }),
    );
    const finish = screen.getByTestId("optimize-finish-now");
    const cancel = screen.getByTestId("optimize-cancel");
    expect(finish).toBeDisabled();
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(props.onCancel).toHaveBeenCalled();
  });

  it("shows the cancelling label", () => {
    setup(
      view({
        lifecycle: "cancelling",
        jobId: "opt_1",
        controls: { cancellable: false, earlyCompletionAvailable: false },
      }),
    );
    expect(screen.getByTestId("optimize-cancel")).toHaveTextContent("Cancelling…");
  });
});

describe("RunStatusPanel — terminal outcomes", () => {
  it("row 1: completed with a downloaded artifact shows success and Download Again", () => {
    setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        result: { outcome: "optimal", score: 42, solverStatus: "OPTIMAL", terminationReason: null },
        latestScore: 42,
        download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
      }),
      { canDownloadAgain: true, downloadAgainFilename: "schedule.xlsx" },
    );
    expect(screen.getByTestId("optimize-completed-artifact")).toHaveTextContent(
      "Schedule optimized and downloaded successfully!",
    );
    expect(screen.getByTestId("optimize-download-again")).toHaveTextContent("schedule.xlsx");
  });

  it("row 1 retry: a failed download offers a manual Download", async () => {
    const props = setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        download: { status: "available", artifactAvailable: true, filename: null },
        error: { source: "job", code: null, message: "network hiccup" },
      }),
    );
    await userEvent.click(screen.getByTestId("optimize-download"));
    expect(props.onDownloadArtifact).toHaveBeenCalled();
  });

  it("row 2: completed with no artifact shows the outcome reason", () => {
    setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        result: {
          outcome: "infeasible",
          score: null,
          solverStatus: "INFEASIBLE",
          terminationReason: "no_solution",
        },
        download: { status: "unavailable", artifactAvailable: false, filename: null },
      }),
    );
    expect(screen.getByTestId("optimize-no-artifact")).toHaveTextContent(
      "No downloadable schedule is available. Job outcome: infeasible (no_solution).",
    );
  });

  it("row 3: worker-lost failure shows the error and Resubmit", async () => {
    const props = setup(
      view({
        lifecycle: "failed",
        jobId: "opt_1",
        error: { source: "job", code: "worker_lost", message: "Worker lost." },
        resubmittable: true,
      }),
    );
    expect(screen.getByTestId("optimize-terminal-error")).toHaveTextContent("Worker lost.");
    const resubmit = screen.getByTestId("optimize-resubmit");
    expect(resubmit).toHaveTextContent("Resubmit");
    await userEvent.click(resubmit);
    expect(props.onResubmit).toHaveBeenCalled();
  });

  it("row 3: a cancelled run offers Dismiss (release) but no Resubmit", async () => {
    const props = setup(
      view({
        lifecycle: "cancelled",
        jobId: "opt_1",
        error: { source: "job", code: "cancelled", message: "Optimization cancelled." },
        resubmittable: false,
      }),
    );
    expect(screen.getByTestId("optimize-terminal-error")).toHaveTextContent(
      "Optimization cancelled.",
    );
    expect(screen.queryByTestId("optimize-resubmit")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("optimize-dismiss"));
    expect(props.onDismiss).toHaveBeenCalled();
  });

  it("row 3: a non-resubmittable process_timeout failure still has a Dismiss release path", () => {
    setup(
      view({
        lifecycle: "failed",
        jobId: "opt_1",
        error: { source: "job", code: "process_timeout", message: "Solver process timed out." },
        resubmittable: false,
      }),
    );
    expect(screen.getByTestId("optimize-terminal-error")).toHaveTextContent(
      "Solver process timed out.",
    );
    expect(screen.getByTestId("optimize-dismiss")).toBeInTheDocument();
    expect(screen.queryByTestId("optimize-resubmit")).not.toBeInTheDocument();
  });

  it("row 3: worker_lost offers BOTH Resubmit and Dismiss", () => {
    setup(
      view({
        lifecycle: "failed",
        jobId: "opt_1",
        error: { source: "job", code: "worker_lost", message: "Worker lost." },
        resubmittable: true,
      }),
    );
    expect(screen.getByTestId("optimize-resubmit")).toHaveTextContent("Resubmit");
    expect(screen.getByTestId("optimize-dismiss")).toBeInTheDocument();
  });
});

describe("RunStatusPanel — cleanup retry/abandon", () => {
  it("offers retry and abandon on a failed cleanup without hiding the success view", async () => {
    const props = setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
      }),
      { cleanupPhase: "failed", canDownloadAgain: true, downloadAgainFilename: "schedule.xlsx" },
    );
    // The successful terminal view is preserved alongside the cleanup failure.
    expect(screen.getByTestId("optimize-download-again")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("optimize-cleanup-retry"));
    expect(props.onRetryCleanup).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("optimize-cleanup-abandon"));
    expect(props.onAbandonCleanup).toHaveBeenCalled();
  });

  it("notes an abandoned cleanup", () => {
    setup(view({ lifecycle: "completed", jobId: "opt_1" }), { cleanupPhase: "abandoned" });
    expect(screen.getByTestId("optimize-cleanup-abandoned")).toBeInTheDocument();
  });
});

describe("RunStatusPanel — transient error", () => {
  it("shows a non-terminal control/stream error while active", () => {
    setup(
      view({
        lifecycle: "running",
        jobId: "opt_1",
        error: { source: "stream", code: null, message: "stream disconnected" },
        controls: { cancellable: true, earlyCompletionAvailable: false },
      }),
    );
    expect(screen.getByTestId("optimize-transient-error")).toHaveTextContent("stream disconnected");
  });
});
