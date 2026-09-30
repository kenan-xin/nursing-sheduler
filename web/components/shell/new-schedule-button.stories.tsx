import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor, within } from "storybook/test";
import type { resetToNewSchedule, RosterClearOutcome } from "@/lib/roster";
import { serializeScenario } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { drainScenarioCommands, pickScenario, useScenarioStore } from "@/lib/store";
import { withToaster, type ScenarioSeed } from "../../.storybook/harness";
import { EXAMPLE_SCHEDULE_FAILED_MESSAGE, StartOverCard } from "./new-schedule-button";

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
/** A backend-valid YAML the example seam returns in place of the bundled file. */
const EXAMPLE_YAML = serializeScenario(makeValidUiState());
/** A one-nurse scenario, so loading the two-nurse example is observable. */
const ONE_NURSE: ScenarioSeed = { staff: [{ id: "Nurse A" }] };

const meta = {
  title: "Shell/StartOverCard",
  component: StartOverCard,
  parameters: { scenario: VALID, layout: "padded" },
  args: {
    onResetComplete: fn(),
    onExampleLoaded: fn(),
    resetNewSchedule: fn<typeof resetToNewSchedule>(async () => ({
      status: "reset",
      storedData: CLEARED,
    })),
    fetchExampleSchedule: fn(async () => EXAMPLE_YAML),
  },
  decorators: [withToaster],
} satisfies Meta<typeof StartOverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const openStartOver = async (canvas: { getByTestId: typeof screen.getByTestId }) => {
  canvas.getByTestId("new-schedule-button").click();
  const dialog = await screen.findByRole("alertdialog", { name: "Start a new schedule?" });
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
};

const staffIds = async () => {
  await drainScenarioCommands();
  return useScenarioStore.getState().staff.map((person) => person.id);
};

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(
      within(canvas.getByTestId("start-over-card")).getByRole("heading", { name: "Start over" }),
    ).toBeVisible();
  },
};

export const ResetConfirmed: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const dialog = await openStartOver(canvas);
    await expect(within(dialog).getAllByRole("listitem")).toHaveLength(4);
    await userEvent.click(within(dialog).getByRole("button", { name: "Start new schedule" }));
    const toast = await screen.findByText("New schedule created");
    await waitFor(() => expect(toast).toBeVisible());
    await expect(args.resetNewSchedule).toHaveBeenCalledTimes(1);
    await expect(args.onResetComplete).toHaveBeenCalledTimes(1);
  },
};

export const ResetCancelled: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const dialog = await openStartOver(canvas);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await expect(args.resetNewSchedule).not.toHaveBeenCalled();
    await expect(await staffIds()).toEqual(["Alice", "Bob"]);
  },
};

export const ResetNotOwner: Story = {
  args: {
    resetNewSchedule: fn<typeof resetToNewSchedule>(async () => ({
      status: "failed",
      failure: "scenario",
      storedData: null,
      scenarioReason: "not-owner",
    })),
  },
  play: async ({ args, canvas, userEvent }) => {
    const dialog = await openStartOver(canvas);
    await userEvent.click(within(dialog).getByRole("button", { name: "Start new schedule" }));
    const toast = await screen.findByText(
      "This schedule is being edited in another tab. Take over editing, then start over.",
    );
    await waitFor(() => expect(toast).toBeVisible());
    await expect(args.onResetComplete).not.toHaveBeenCalled();
  },
};

export const ExampleLoaded: Story = {
  parameters: { scenario: ONE_NURSE },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("new-schedule-example"));
    const proceed = await screen.findByRole("button", { name: "Continue" });
    await waitFor(() => expect(proceed).toBeVisible());
    await userEvent.click(proceed);
    await waitFor(async () => expect(await staffIds()).toEqual(["Alice", "Bob"]));
    await expect(args.onExampleLoaded).toHaveBeenCalledTimes(1);
  },
};

export const ExampleFetchFailed: Story = {
  args: {
    fetchExampleSchedule: fn(async (): Promise<string> => {
      throw new Error("network down");
    }),
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("new-schedule-example"));
    await expect(await canvas.findByTestId("new-schedule-example-error")).toHaveTextContent(
      EXAMPLE_SCHEDULE_FAILED_MESSAGE,
    );
    await expect(await staffIds()).toEqual(["Alice", "Bob"]);
  },
};

export const ExampleInvalid: Story = {
  args: { fetchExampleSchedule: fn(async () => "::not a scenario::") },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("new-schedule-example"));
    await expect(await canvas.findByTestId("scenario-export-issues")).toBeVisible();
  },
};

export const ExampleLoading: Story = {
  args: { fetchExampleSchedule: fn(() => new Promise<string>(() => {})) },
  play: async ({ canvas, userEvent }) => {
    const button = canvas.getByTestId("new-schedule-example");
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await expect(button).toHaveTextContent("Loading example…");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
