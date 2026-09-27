import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { ClearDataPanel } from "./clear-data-panel";

// Clear-data actions row (prototype ScreenRequests.dc.html:60-68). Each button carries its
// own handler, so the spies live inside `buttons` rather than at the meta top level.
const meta = {
  title: "Requests/ClearDataPanel",
  component: ClearDataPanel,
  parameters: { layout: "padded" },
  args: {
    buttons: [
      { label: "All people history", onClick: fn() },
      { label: "All requests", onClick: fn() },
      { label: "Person → individual dates", onClick: fn() },
    ],
  },
} satisfies Meta<typeof ClearDataPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("clear-data-panel")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "All people history" }));
    await userEvent.click(canvas.getByRole("button", { name: "All requests" }));
    await userEvent.click(canvas.getByRole("button", { name: "Person → individual dates" }));
    await expect(args.buttons[0].onClick).toHaveBeenCalledOnce();
    await expect(args.buttons[1].onClick).toHaveBeenCalledOnce();
    await expect(args.buttons[2].onClick).toHaveBeenCalledOnce();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
