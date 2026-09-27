import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { LONG_PROSE, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { ClearConfirmDialog } from "./clear-confirm-dialog";

// Portalled (Base UI AlertDialog): query with `screen`, never `canvas`.
const meta = {
  title: "Requests/ClearConfirmDialog",
  component: ClearConfirmDialog,
  args: {
    open: true,
    text: "Clear all shift requests? This cannot be undone.",
    onConfirm: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ClearConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  play: async ({ args, userEvent }) => {
    // The popup fades in, so wait for the animation to settle before asserting visibility.
    await waitFor(() => expect(screen.getByTestId("clear-confirm-dialog")).toBeVisible());
    await userEvent.click(screen.getByTestId("clear-confirm-confirm"));
    await expect(args.onConfirm).toHaveBeenCalledOnce();
    await expect(args.onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("clear-confirm-cancel"));
    await expect(args.onCancel).toHaveBeenCalledOnce();
    await expect(args.onConfirm).toHaveBeenCalledOnce();
  },
};

export const Closed: Story = {
  args: { open: false },
  play: async () => {
    await expect(screen.queryByTestId("clear-confirm-dialog")).toBeNull();
  },
};

export const LongText: Story = {
  args: { text: LONG_PROSE },
  play: async () => {
    await expectNoHorizontalOverflow(await screen.findByTestId("clear-confirm-dialog"));
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
