import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { WorkingTimeFields } from "./working-time-fields";

const meta = {
  title: "EntityEditor/WorkingTimeFields",
  component: WorkingTimeFields,
  parameters: { layout: "padded" },
  args: {
    value: { startTime: "08:00", endTime: "17:00", restMinutes: 60, durationMinutes: 480 },
    onChange: fn(),
    idPrefix: "wt",
  },
} satisfies Meta<typeof WorkingTimeFields>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // A clock edit re-derives the paid minutes and writes the whole value back.
    await userEvent.selectOptions(canvas.getByTestId("wt-start"), "10:00");
    await expect(args.onChange).toHaveBeenCalledWith({
      startTime: "10:00",
      endTime: "17:00",
      restMinutes: 60,
      durationMinutes: 360,
    });
  },
};

export const NoRest: Story = {
  args: { value: { startTime: "09:00", endTime: "17:00", durationMinutes: 480 } },
  play: async ({ canvas }) => {
    // Zero rest is canonically omitted; the readout reads the paid span.
    await expect(canvas.getByTestId("wt-duration")).toHaveTextContent("8h");
  },
};

export const Overnight: Story = {
  args: { value: { startTime: "19:00", endTime: "07:00", durationMinutes: 720 } },
  play: async ({ canvas }) => {
    // An end at or before the start rolls past midnight and marks it once.
    await expect(canvas.getByText("+1 day")).toBeVisible();
    await expect(canvas.getByTestId("wt-duration")).toHaveTextContent("12h");
  },
};

export const Unset: Story = {
  args: { value: {} },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("wt-duration")).toHaveTextContent("—");
  },
};

export const Invalid: Story = {
  args: { value: { startTime: "09:00", endTime: "09:00" } },
  play: async ({ canvas }) => {
    const error = canvas.getByTestId("wt-wt-error");
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toHaveTextContent(/must differ/i);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
