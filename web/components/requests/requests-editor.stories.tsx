import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, screen, waitFor } from "storybook/test";
import type { ScenarioUiState } from "@/lib/scenario";
import { drainScenarioCommands, useScenarioStore } from "@/lib/store";
import { withToaster } from "../../.storybook/harness";
import { RequestsEditor } from "./requests-editor";

// Zero-prop screen: people, shifts and requests come from the seeded scenario
// (the requests-editor.test.tsx BASE_SEED, with this repo's arbitrary shift codes).
const SEED: Partial<ScenarioUiState> = {
  rangeStart: "2026-07-01",
  rangeEnd: "2026-07-03",
  staff: [
    { id: "Aisha", history: [] },
    { id: "Chloe", history: [] },
  ],
  shifts: [{ id: "early1" }, { id: "late+" }],
  shiftGroups: [{ id: "AnyDay", members: ["early1", "late+"] }],
  reqData: [{ kind: "off", person: "Chloe", date: "02", weight: -3 }],
};

const meta = {
  title: "Requests/RequestsEditor",
  component: RequestsEditor,
  decorators: [withToaster],
  parameters: {
    scenario: SEED,
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/shift-requests" } },
  },
} satisfies Meta<typeof RequestsEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RequiredDataGate: Story = {
  parameters: { scenario: "empty" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("requests-required-data-gate")).toBeVisible();
  },
};

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("row-Aisha")).toBeVisible();
    await expect(canvas.getByTestId("row-Chloe")).toBeVisible();
    await expect(canvas.getByTestId("requests-count")).toHaveTextContent("1");
  },
};

export const QuickMode: Story = {
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.queryByTestId("requests-open-requests-csv")).toBeNull();
    await userEvent.click(canvas.getByTestId("requests-tab-quick"));
    await expect(canvas.getByTestId("requests-open-requests-csv")).toBeEnabled();
    await expect(canvas.getByTestId("requests-open-history-csv")).toBeEnabled();
  },
};

export const ImportCsv: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("requests-tab-quick"));
    await userEvent.click(canvas.getByTestId("requests-open-history-csv"));
    const modal = await screen.findByTestId("requests-csv-modal");
    await waitFor(() => expect(modal).toBeVisible());
    await userEvent.upload(
      screen.getByTestId("requests-csv-file-input"),
      new File(["Aisha,OFF,2\nChloe,late+,1\n"], "history.csv", { type: "text/csv" }),
    );
    await waitFor(async () => {
      await drainScenarioCommands();
      const staff = useScenarioStore.getState().staff;
      await expect(staff.find((p) => p.id === "Aisha")?.history).toEqual(["OFF", "OFF"]);
    });
    await expect(useScenarioStore.getState().staff[1]?.history).toEqual(["late+"]);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
