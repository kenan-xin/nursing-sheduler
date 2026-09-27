import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import type { RunProgressPoint } from "@/lib/optimize";
import { ProgressChart } from "./progress-chart";

// Reference story, data-heavy interactive (bead w0e.2). Real Chromium has a real
// ResizeObserver, so none of the jsdom stubs in progress-chart.test.tsx are needed.
// `isActive` extrapolates on a wall-clock timer and is left to the unit suite.
function makePoint(elapsedSeconds: number, over: Partial<RunProgressPoint> = {}): RunProgressPoint {
  return {
    source: over.source ?? "ortools/cp-sat:solution-callback",
    currentBestScore: over.currentBestScore ?? 100,
    elapsedSeconds,
    solutionIndex: over.solutionIndex ?? null,
    commentCount: over.commentCount ?? null,
  };
}

const POINTS: RunProgressPoint[] = [
  makePoint(0.5, { currentBestScore: 12, commentCount: 4, solutionIndex: 2 }),
  makePoint(1, { currentBestScore: 9, commentCount: 2, solutionIndex: 3 }),
  makePoint(2.5, { currentBestScore: 7, commentCount: 1, solutionIndex: 4 }),
];

const meta = {
  title: "Optimize/ProgressChart",
  component: ProgressChart,
  // The chart fills its container; `centered` would collapse it to zero width.
  parameters: { layout: "padded" },
  args: { points: POINTS },
} satisfies Meta<typeof ProgressChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Settled: Story = {
  play: async ({ canvas, userEvent }) => {
    const chart = canvas.getByTestId("progress-chart");
    await expect(chart).toHaveAttribute("data-comments-shown", "true");
    await userEvent.click(canvas.getByRole("button", { name: "Hide comments panel" }));
    await expect(chart).toHaveAttribute("data-comments-shown", "false");
  },
};

export const Empty: Story = {
  args: { points: [] },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/waiting for the first progress frame/i)).toBeVisible();
  },
};
