import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { LONG_PROSE, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { VersionConfirmModal } from "./version-confirm-modal";

// Wraps the portalled shell `ConfirmDialog` (Base UI AlertDialog): query with `screen`.
const meta = {
  title: "SaveLoad/VersionConfirmModal",
  component: VersionConfirmModal,
  args: {
    open: true,
    title: "Load this scenario?",
    description: "The scenario currently open in this browser will be replaced.",
    onOpenChange: fn(),
    onContinue: fn(),
  },
} satisfies Meta<typeof VersionConfirmModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, userEvent }) => {
    const dialog = await screen.findByRole("alertdialog", { name: "Load this scenario?" });
    // The popup mounts at opacity 0 and fades in, so wait for the fade.
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await expect(args.onContinue).toHaveBeenCalledOnce();
    // The busy confirm holds the dialog open until `onContinue` settles, then closes.
    await waitFor(() => expect(args.onOpenChange).toHaveBeenCalledWith(false));
  },
};

export const Cancel: Story = {
  play: async ({ args, userEvent }) => {
    await userEvent.click(await screen.findByTestId("confirm-dialog-cancel"));
    await expect(args.onContinue).not.toHaveBeenCalled();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  },
};

export const WithDetail: Story = {
  args: { detail: "File app version: 1.0.0\nCurrent app version: 1.4.0" },
  play: async () => {
    const detail = await screen.findByTestId("confirm-dialog-detail");
    await waitFor(() => expect(detail).toBeVisible());
  },
};

export const LongText: Story = {
  args: { title: LONG_PROSE, description: LONG_PROSE },
  play: async () => {
    await expectNoHorizontalOverflow(await screen.findByTestId("confirm-dialog"));
  },
};

export const Dark: Story = {
  args: { ...WithDetail.args },
  globals: { theme: "dark" },
};
