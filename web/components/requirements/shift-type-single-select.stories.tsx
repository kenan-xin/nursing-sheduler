import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { ShiftTypeSingleSelect } from "./shift-type-single-select";
import { buildRequirementShiftTypeOptions } from "./requirements-model";

// Fixtures from the requirements model's own option builder.
const OPTIONS = buildRequirementShiftTypeOptions(makeValidUiState());

const meta = {
  title: "Requirements/ShiftTypeSingleSelect",
  component: ShiftTypeSingleSelect,
  args: {
    items: OPTIONS.items,
    groups: OPTIONS.groups,
    selected: [],
    onSelect: fn(),
  },
} satisfies Meta<typeof ShiftTypeSingleSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { groups: [] },
  play: async ({ args, canvas, userEvent }) => {
    // Selecting REPLACES the selection with exactly this one value.
    await userEvent.click(canvas.getByRole("radio", { name: "N — Night" }));
    await expect(args.onSelect).toHaveBeenCalledWith("N");
  },
};

export const Selected: Story = {
  args: { groups: [], selected: ["N"] },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("radio", { name: "N — Night" })).toBeChecked();
    await expect(canvas.getByRole("radio", { name: "D — Day" })).not.toBeChecked();
  },
};

export const WithGroups: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("radio", { name: "DayOrEvening" }));
    await expect(args.onSelect).toHaveBeenCalledWith("DayOrEvening");
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { groups: [], items: [{ value: "long", label: LONG_TOKEN }] },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    // KNOWN OVERFLOW nursing-sheduler-w0e.20: restore getByTitle(LONG_TOKEN) when fixed.
  },
};

export const Dark: Story = {
  args: { ...WithGroups.args },
  globals: { theme: "dark" },
};
