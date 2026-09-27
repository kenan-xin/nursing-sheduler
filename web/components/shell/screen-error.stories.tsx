import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { ScreenError } from "./screen-error";

const meta = {
  title: "Shell/ScreenError",
  component: ScreenError,
  parameters: { layout: "padded" },
  args: { onRetry: fn() },
} satisfies Meta<typeof ScreenError>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("This screen could not load");
    await userEvent.click(canvas.getByTestId("app-error-retry"));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const CustomCopy: Story = {
  args: {
    title: "The roster could not be rebuilt",
    message: "The saved run is no longer available in this browser.",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("The roster could not be rebuilt");
    await expect(canvas.getByTestId("app-error-retry")).toBeVisible();
  },
};

export const Dark: Story = {
  args: { ...CustomCopy.args },
  globals: { theme: "dark" },
};
