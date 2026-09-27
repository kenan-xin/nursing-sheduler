import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, screen, waitFor, within } from "storybook/test";
import { EXAMPLE_SCHEDULE_PATH } from "@/components/shell/new-schedule-button";
import { serializeScenario } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { drainScenarioCommands, pickScenario, useScenarioStore } from "@/lib/store";
import { withToaster } from "../../.storybook/harness";
import { withFetchRoutes } from "../../.storybook/story-helpers";
import { SaveLoadWorkspace } from "./save-load-workspace";

// Zero-prop screen over the seeded scenario. The bundled example schedule is a static
// asset fetched by StartOverCard; it is routed here to a small valid document.
const VALID = makeValidUiState();
const EXAMPLE_YAML = serializeScenario({
  ...VALID,
  staff: [...VALID.staff, { id: "Zed Example", history: [] }],
});

const staffIds = async () => {
  await drainScenarioCommands();
  return useScenarioStore.getState().staff.map((p) => p.id);
};

const meta = {
  title: "SaveLoad/SaveLoadWorkspace",
  component: SaveLoadWorkspace,
  decorators: [withToaster],
  beforeEach: withFetchRoutes([[EXAMPLE_SCHEDULE_PATH, () => new Response(EXAMPLE_YAML)]]),
  parameters: {
    scenario: pickScenario(VALID),
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/save-and-load" } },
  },
} satisfies Meta<typeof SaveLoadWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("scenario-file-card")).toBeVisible();
    await expect(canvas.getByTestId("scenario-yaml-preview")).toBeVisible();
    await expect(canvas.getByTestId("start-over-card")).toBeVisible();
  },
};

export const ImportInvalid: Story = {
  play: async ({ canvas, userEvent }) => {
    const before = await staffIds();
    await userEvent.click(canvas.getByTestId("scenario-upload-button"));
    const modal = await screen.findByTestId("upload-modal");
    await waitFor(() => expect(modal).toBeVisible());
    await userEvent.upload(
      screen.getByTestId("upload-file-input"),
      new File(["preferences: [unterminated, flow"], "bad.yaml", { type: "application/yaml" }),
    );
    await expect(
      await within(canvas.getByTestId("scenario-file-card")).findByTestId("scenario-export-issues"),
    ).toBeVisible();
    await expect(await staffIds()).toEqual(before);
  },
};

export const LoadExample: Story = {
  play: async ({ canvas, userEvent }) => {
    await expect(await staffIds()).not.toContain("Zed Example");
    await userEvent.click(canvas.getByTestId("new-schedule-example"));
    // The unstamped Storybook build meets the version gate's confirm first.
    const proceed = await screen.findByRole("button", { name: "Continue" });
    await waitFor(() => expect(proceed).toBeVisible());
    await userEvent.click(proceed);
    await waitFor(async () => expect(await staffIds()).toContain("Zed Example"));
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
