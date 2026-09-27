import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor, within } from "storybook/test";
import {
  NEW_SCHEDULE_FAILED_MESSAGE,
  type resetToNewSchedule,
  type RosterClearOutcome,
} from "@/lib/roster";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, useHotStore, type HydrationStatus } from "@/lib/store";
import { withToaster, type ScenarioSeed } from "../../.storybook/harness";
import { HydrationGate } from "./hydration-gate";

const VALID: ScenarioSeed = pickScenario(makeValidUiState());
/** A verified Clear report, so the reset seam's success is the real outcome shape. */
const CLEARED: RosterClearOutcome = {
  status: "cleared",
  epoch: 1,
  remaining: { roster: 0, snapshot: 0 },
  captureNotified: true,
  sessionResidue: { sessionCleared: true, sessionRemaining: [], retireMarkerCleared: true },
  viewMetadataCleared: true,
};

// The gate re-runs bring-up on mount against the installed scenario. Every play first
// waits for it to settle (`Ward content`), then sets the non-ready status directly,
// standing in for a slow, stalled or corrupt bring-up the harness cannot fake.
const meta = {
  title: "Shell/HydrationGate",
  component: HydrationGate,
  parameters: {
    scenario: VALID,
    layout: "padded",
    nextjs: { appDirectory: true, navigation: { pathname: "/dates" } },
  },
  args: {
    children: <p>Ward content</p>,
    resetNewSchedule: fn<typeof resetToNewSchedule>(async () => ({
      status: "reset",
      storedData: CLEARED,
    })),
  },
  decorators: [withToaster],
} satisfies Meta<typeof HydrationGate>;

export default meta;
type Story = StoryObj<typeof meta>;

const settleThen = async (
  canvas: { findByText: typeof screen.findByText },
  status: HydrationStatus,
) => {
  await canvas.findByText("Ward content");
  useHotStore.getState().setHydrationStatus(status);
};

const openReset = async (canvas: { findByRole: typeof screen.findByRole }) => {
  (await canvas.findByRole("button", { name: "Reset to new schedule" })).click();
  const dialog = await screen.findByRole("alertdialog", { name: "Reset Data" });
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
};

export const Ready: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Ward content")).toBeVisible();
    await expect(canvas.queryByTestId("hydration-loading")).toBeNull();
    await expect(useHotStore.getState().hydrationStatus).toBe("ready");
  },
};

export const Loading: Story = {
  play: async ({ canvas }) => {
    await settleThen(canvas, "hydrating");
    await expect(await canvas.findByTestId("hydration-loading")).toBeVisible();
    await expect(canvas.queryByText("Ward content")).toBeNull();
  },
};

export const Stalled: Story = {
  play: async ({ canvas }) => {
    await settleThen(canvas, "stalled");
    const stalled = await canvas.findByTestId("hydration-stalled");
    // Not clicked: it reloads the preview iframe.
    await expect(within(stalled).getByRole("button", { name: "Reload" })).toBeVisible();
  },
};

export const LoadError: Story = {
  play: async ({ canvas }) => {
    await settleThen(canvas, "recoverable-error");
    await expect(await canvas.findByTestId("hydration-error-heading")).toHaveTextContent(
      "Stored data could not be loaded",
    );
  },
};

export const ResetConfirmed: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await settleThen(canvas, "recoverable-error");
    const dialog = await openReset(canvas);
    await userEvent.click(within(dialog).getByRole("button", { name: "Reset Data" }));
    const toast = await screen.findByText("New schedule created");
    await waitFor(() => expect(toast).toBeVisible());
    await expect(args.resetNewSchedule).toHaveBeenCalledTimes(1);
  },
};

export const ResetFailed: Story = {
  args: {
    resetNewSchedule: fn<typeof resetToNewSchedule>(async () => ({
      status: "failed",
      failure: "stored-data",
      storedData: null,
    })),
  },
  play: async ({ canvas, userEvent }) => {
    await settleThen(canvas, "recoverable-error");
    const dialog = await openReset(canvas);
    await userEvent.click(within(dialog).getByRole("button", { name: "Reset Data" }));
    const toast = await screen.findByText(NEW_SCHEDULE_FAILED_MESSAGE);
    await waitFor(() => expect(toast).toBeVisible());
  },
};

// The gate's richest surface is reached only by a play; this one only sets it, so axe
// sees the dark stalled surface.
export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await settleThen(canvas, "stalled");
    await canvas.findByTestId("hydration-stalled");
  },
};
