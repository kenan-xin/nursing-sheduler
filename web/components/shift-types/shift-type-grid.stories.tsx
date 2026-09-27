import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, waitFor } from "storybook/test";
import type { ScenarioUiState } from "@/lib/scenario";
import { drainScenarioCommands, useScenarioStore } from "@/lib/store";
import { withToaster } from "../../.storybook/harness";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { ShiftTypeGrid } from "./shift-type-grid";

// Zero-prop screen: the shift catalogue comes from the seeded scenario.
const SEED: Partial<ScenarioUiState> = {
  shifts: [
    { id: "early1", description: "Early", startTime: "07:00", endTime: "15:00" },
    { id: "late+", description: "Late", startTime: "13:00", endTime: "21:00" },
    { id: "N12", description: "Night", startTime: "20:00", endTime: "08:00" },
  ],
};

const sk = (id: string) => `string:${id}`;

const meta = {
  title: "ShiftTypes/ShiftTypeGrid",
  component: ShiftTypeGrid,
  decorators: [withToaster],
  parameters: {
    scenario: SEED,
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/shift-types" } },
  },
} satisfies Meta<typeof ShiftTypeGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

// Only the reserved OFF / LEAVE cards remain.
export const Empty: Story = {
  parameters: { scenario: "empty" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("synthetic-OFF")).toBeVisible();
    await expect(canvas.queryByTestId(`shift-card-${sk("early1")}`)).toBeNull();
  },
};

export const Populated: Story = {
  play: async ({ canvas }) => {
    const grid = canvas.getByTestId("shift-grid");
    for (const id of ["early1", "late+", "N12"]) {
      await expect(canvas.getByTestId(`shift-code-${sk(id)}`)).toHaveTextContent(id);
    }
    await expect(grid).toContainElement(canvas.getByTestId("synthetic-LEAVE"));
  },
};

export const AddShift: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("add-shift-toggle"));
    await userEvent.type(canvas.getByTestId("shift-add-code"), "twi");
    await userEvent.type(canvas.getByTestId("shift-add-name"), "Twilight");
    await userEvent.selectOptions(canvas.getByTestId("shift-add-start"), "16:00");
    await userEvent.selectOptions(canvas.getByTestId("shift-add-end"), "22:00");
    await expect(canvas.getByTestId("shift-add-duration")).toHaveTextContent("6h");
    await userEvent.click(canvas.getByTestId("shift-add-save"));
    // The code input stores its value uppercase.
    await waitFor(() => expect(canvas.getByTestId(`shift-code-${sk("TWI")}`)).toBeVisible());
    await drainScenarioCommands();
    await expect(useScenarioStore.getState().shifts.find((s) => s.id === "TWI")).toMatchObject({
      description: "Twilight",
      startTime: "16:00",
      endTime: "22:00",
    });
  },
};

export const Continue: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("shift-types-continue"));
    await expect(getRouter().push).toHaveBeenCalledWith("/rules");
  },
};

export const LongText: Story = {
  parameters: { scenario: { shifts: [{ id: LONG_TOKEN, description: LONG_TOKEN }] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId(`shift-code-${sk(LONG_TOKEN)}`)).toBeInTheDocument();
    await expectNoHorizontalOverflow(canvas.getByTestId(`shift-card-${sk(LONG_TOKEN)}`));
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
