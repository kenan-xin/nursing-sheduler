import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, waitFor } from "storybook/test";
import "./calendar.css";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { drainScenarioCommands, pickScenario, useScenarioStore } from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { clickCalendarDay } from "../../.storybook/story-helpers";
import { DatesScreen } from "./dates-screen";

// Zero-prop screen: the range and date groups come from a seeded scenario.
const VALID = makeValidUiState();
const POPULATED: ScenarioSeed = pickScenario(VALID);

const meta = {
  title: "Dates/DatesScreen",
  component: DatesScreen,
  parameters: {
    scenario: POPULATED,
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/dates" } },
  },
} satisfies Meta<typeof DatesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoRange: Story = {
  parameters: { scenario: "empty" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("calendar-empty")).toBeVisible();
    await expect(canvas.getByTestId("date-groups-empty")).toBeVisible();
  },
};

export const Populated: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByTestId("calendar-view")).toBeVisible();
    await waitFor(() =>
      expect(
        canvasElement.querySelector(
          `.ns-month-calendar--display [data-ns-date="${VALID.rangeStart}"]`,
        ),
      ).not.toBeNull(),
    );
  },
};

// A group created through the card lands in the durable scenario (the store round trip).
export const CreateGroup: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("date-group-add"));
    const editor = canvas.getByTestId("date-group-editor-new");
    await userEvent.type(canvas.getByTestId("date-group-name"), "AuditDays");
    await clickCalendarDay(editor, VALID.rangeStart);
    await waitFor(() =>
      expect(canvas.getByTestId("date-scope-picker-count")).toHaveTextContent("1 SELECTED"),
    );
    await userEvent.click(canvas.getByTestId("date-group-save"));
    await drainScenarioCommands();
    const group = useScenarioStore.getState().dateGroups.find((g) => g.id === "AuditDays");
    await expect(group?.members).toHaveLength(1);
    await expect(await canvas.findByTestId("editable-group-AuditDays")).toBeVisible();
  },
};

export const Continue: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("dates-continue"));
    await expect(getRouter().push).toHaveBeenCalledWith("/people");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
