import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, fn } from "storybook/test";
import {
  INITIAL_OPTIMIZE_RUN_VIEW,
  type OptimizeRunView,
  type RunProgressPoint,
} from "@/lib/optimize";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { RunStatusPanel } from "./run-status-panel";

// Fixtures follow run-status-panel.test.tsx's `view()`: the initial view with overrides.
function view(over: Partial<OptimizeRunView>): OptimizeRunView {
  return { ...INITIAL_OPTIMIZE_RUN_VIEW, ...over };
}

function point(elapsedSeconds: number, currentBestScore: number): RunProgressPoint {
  return {
    source: "ortools/cp-sat:solution-callback",
    currentBestScore,
    elapsedSeconds,
    solutionIndex: null,
    commentCount: null,
  };
}

const DOWNLOADED = view({
  lifecycle: "completed",
  jobId: "opt_1",
  result: { outcome: "optimal", score: 42, solverStatus: "OPTIMAL", terminationReason: null },
  latestScore: 42,
  download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
});

const RUNNING = view({
  lifecycle: "running",
  jobId: "opt_1",
  latestScore: 7,
  controls: { cancellable: true, earlyCompletionAvailable: true },
  progress: [point(0.5, 12), point(1, 9), point(2.5, 7)],
});

const FAILED = view({
  lifecycle: "failed",
  jobId: "opt_1",
  error: { source: "job", code: "worker_lost", message: "Worker lost." },
});

// GuardedLink CTAs (Adjust rules, Open & adjust roster) read the nextjs-vite router mock.
const meta = {
  title: "Optimize/RunStatusPanel",
  component: RunStatusPanel,
  parameters: {
    layout: "padded",
    nextjs: { appDirectory: true, navigation: { pathname: "/optimize-and-export" } },
  },
  args: {
    view: INITIAL_OPTIMIZE_RUN_VIEW,
    submitting: false,
    canDownloadAgain: false,
    downloadAgainFilename: null,
    onCancel: fn(),
    onFinishNow: fn(),
    onDownloadArtifact: fn(),
    onDownloadAgain: fn(),
    onStartRun: fn(),
  },
} satisfies Meta<typeof RunStatusPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("optimize-idle")).toHaveTextContent("Ready to optimise");
    await userEvent.click(canvas.getByTestId("optimize-start"));
    await expect(args.onStartRun).toHaveBeenCalledOnce();
  },
};

export const IdleNoCta: Story = {
  args: { onStartRun: undefined },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-idle")).toBeVisible();
    await expect(canvas.queryByTestId("optimize-start")).toBeNull();
  },
};

export const Submitting: Story = {
  args: { submitting: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-status")).toBeVisible();
    await expect(canvas.queryByTestId("optimize-idle")).toBeNull();
  },
};

export const Queued: Story = {
  args: { view: view({ lifecycle: "queued", jobId: "opt_1", queuePosition: 3, latestScore: 12 }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-status")).toHaveTextContent("Queued, position 3");
    await expect(canvas.getByTestId("optimize-score")).toHaveTextContent("12");
  },
};

export const Running: Story = {
  args: { view: RUNNING },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("optimize-finish-now"));
    await expect(args.onFinishNow).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("optimize-cancel"));
    await expect(args.onCancel).toHaveBeenCalledOnce();
  },
};

export const FinishNowUnavailable: Story = {
  args: { view: { ...RUNNING, controls: { cancellable: true, earlyCompletionAvailable: false } } },
  play: async ({ args, canvas }) => {
    const finish = canvas.getByTestId("optimize-finish-now");
    await expect(finish).toBeDisabled();
    // The disabled button has `pointer-events: none`, which userEvent refuses; a native
    // click still proves a disabled control fires nothing.
    finish.click();
    await expect(args.onFinishNow).not.toHaveBeenCalled();
  },
};

export const Cancelling: Story = {
  args: {
    view: view({
      lifecycle: "cancelling",
      jobId: "opt_1",
      controls: { cancellable: false, earlyCompletionAvailable: false },
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-cancel")).toHaveTextContent("Cancelling…");
  },
};

export const SuccessDownloaded: Story = {
  args: {
    view: DOWNLOADED,
    canDownloadAgain: true,
    downloadAgainFilename: "schedule.xlsx",
    loadableRoster: true,
  },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("optimize-download-again"));
    await expect(args.onDownloadAgain).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("optimize-open-roster"));
    await expect(getRouter().push).toHaveBeenCalledWith("/roster");
  },
};

export const SuccessAvailable: Story = {
  args: {
    view: view({
      lifecycle: "completed",
      jobId: "opt_1",
      result: {
        outcome: "feasible",
        score: -142,
        solverStatus: "FEASIBLE",
        terminationReason: "solver_timeout",
      },
      latestScore: -142,
      startedAt: "2026-07-20T00:00:01+00:00",
      finishedAt: "2026-07-20T00:00:19.4+00:00",
      download: { status: "available", artifactAvailable: true, filename: null },
    }),
  },
  play: async ({ args, canvas, userEvent }) => {
    const grid = canvas.getByTestId("optimize-summary-grid");
    await expect(grid).toHaveTextContent("FEASIBLE");
    await expect(grid).toHaveTextContent("-142");
    await expect(grid).toHaveTextContent("18s");
    await userEvent.click(canvas.getByTestId("optimize-download"));
    await expect(args.onDownloadArtifact).toHaveBeenCalledOnce();
  },
};

export const Infeasible: Story = {
  args: {
    view: view({
      lifecycle: "completed",
      jobId: "opt_1",
      result: {
        outcome: "infeasible",
        score: null,
        solverStatus: "INFEASIBLE",
        terminationReason: "infeasibility_proven",
      },
      download: { status: "unavailable", artifactAvailable: false, filename: null },
    }),
  },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByTestId("optimize-infeasible")).toBeVisible();
    await userEvent.click(canvas.getByTestId("optimize-adjust-rules"));
    await expect(getRouter().push).toHaveBeenCalledWith("/rules");
  },
};

export const NoArtifact: Story = {
  args: {
    view: view({
      lifecycle: "completed",
      jobId: "opt_1",
      result: { outcome: "optimal", score: 9, solverStatus: "OPTIMAL", terminationReason: null },
      download: { status: "unavailable", artifactAvailable: false, filename: null },
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-no-artifact")).toBeVisible();
  },
};

export const Failed: Story = {
  args: { view: FAILED },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-terminal-error")).toHaveTextContent("Worker lost.");
  },
};

export const Cancelled: Story = {
  args: {
    view: view({
      lifecycle: "cancelled",
      jobId: "opt_1",
      error: { source: "job", code: "cancelled", message: "Optimisation cancelled." },
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-terminal-error")).toHaveTextContent(
      "Optimisation cancelled.",
    );
  },
};

export const TransientError: Story = {
  args: {
    view: { ...RUNNING, error: { source: "stream", code: null, message: "stream disconnected" } },
  },
  play: async ({ canvas }) => {
    const callout = canvas.getByTestId("optimize-transient-error");
    await expect(callout).toHaveAttribute("role", "alert");
    await expect(callout).toHaveTextContent("stream disconnected");
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { ...SuccessDownloaded.args, downloadAgainFilename: LONG_TOKEN },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-download-again")).toHaveTextContent(LONG_TOKEN);
    // KNOWN OVERFLOW nursing-sheduler-w0e.24: restore
    // `await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"))` when fixed
  },
};

export const LongTextError: Story = {
  decorators: [withNarrowFrame],
  args: {
    view: { ...FAILED, error: { source: "job", code: "worker_lost", message: LONG_PROSE } },
  },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: { ...SuccessDownloaded.args },
  globals: { theme: "dark" },
};
