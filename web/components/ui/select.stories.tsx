import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { Select } from "./select";

const meta = {
  title: "UI/Select",
  component: Select,
  args: { "aria-label": "Shift type", defaultValue: "day" },
  render: (args) => (
    <Select {...args}>
      <option value="day">Day</option>
      <option value="evening">Evening</option>
      <option value="night">Night</option>
    </Select>
  ),
} satisfies Meta<typeof Select>;

export default meta;

export const Default: StoryObj<typeof meta> = {
  play: async ({ canvas, userEvent }) => {
    const select = canvas.getByRole("combobox", { name: "Shift type" });
    await userEvent.selectOptions(select, "night");
    await expect(select).toHaveValue("night");
  },
};
