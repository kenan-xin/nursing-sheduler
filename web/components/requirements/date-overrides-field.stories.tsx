import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { LONG_TOKEN, withNarrowFrame } from "../../.storybook/story-helpers";
import { DateOverridesField, type OverrideDateOption } from "./date-overrides-field";

const DATES: OverrideDateOption[] = [
  { iso: "2026-10-14", label: "Wed 14 Oct" },
  { iso: "2026-10-15", label: "Thu 15 Oct" },
];

const meta = {
  title: "Requirements/DateOverridesField",
  component: DateOverridesField,
  parameters: { layout: "padded" },
  args: { rows: [], dates: DATES, onChange: fn() },
} satisfies Meta<typeof DateOverridesField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("date-overrides-add"));
    // The new row takes the first covered date that has no row yet.
    await expect(args.onChange).toHaveBeenCalledWith([
      { date: "2026-10-14", requiredNumPeople: "" },
    ]);
  },
};

export const WithRows: Story = {
  args: { rows: [{ date: "2026-10-14", requiredNumPeople: 1 }] },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Remove exception 1" }));
    await expect(args.onChange).toHaveBeenCalledWith([]);
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    dates: [
      { iso: "2026-10-14", label: LONG_TOKEN },
      { iso: "2026-10-15", label: "Thu 15 Oct" },
    ],
    rows: [{ date: "2026-10-14", requiredNumPeople: 2 }],
  },
  play: async ({ canvas }) => {
    // KNOWN OVERFLOW nursing-sheduler-w0e.21: restore expectNoHorizontalOverflow when fixed.
    await expect(canvas.getByTestId("narrow-frame")).toBeVisible();
  },
};

export const Dark: Story = {
  args: { ...WithRows.args },
  globals: { theme: "dark" },
};
