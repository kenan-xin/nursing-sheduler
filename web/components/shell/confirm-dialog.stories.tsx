import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { LONG_PROSE, LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { ConfirmDialog } from "./confirm-dialog";

// Portalled (Base UI AlertDialog): query with `screen`, never `canvas`.
const meta = {
  title: "Shell/ConfirmDialog",
  component: ConfirmDialog,
  args: {
    open: true,
    title: "Discard unsaved changes?",
    description: "Your edits to this card will be lost.",
    onOpenChange: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, userEvent }) => {
    const dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    // The popup mounts at opacity 0 and fades in (`motion: "overlay"`), so a bare
    // `toBeVisible` right after `findBy…` can catch it mid-animation.
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await expect(args.onConfirm).toHaveBeenCalledOnce();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false);
  },
};

export const Cancel: Story = {
  play: async ({ args, userEvent }) => {
    await userEvent.click(await screen.findByTestId("confirm-dialog-cancel"));
    await expect(args.onConfirm).not.toHaveBeenCalled();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  },
};

export const Destructive: Story = {
  args: { variant: "destructive", confirmLabel: "Delete card" },
  play: async () => {
    const confirm = await screen.findByRole("button", { name: "Delete card" });
    await waitFor(() => expect(confirm).toBeVisible());
  },
};

export const WithDetailAndConsequences: Story = {
  args: {
    detail: "late+ → N12\nearly1 → off",
    consequences: ["2 requests will be removed", "1 count card will be disabled"],
  },
  play: async () => {
    const detail = await screen.findByTestId("confirm-dialog-detail");
    await waitFor(() => expect(detail).toBeVisible());
    await expect(screen.getByTestId("confirm-dialog-consequences").children).toHaveLength(2);
  },
};

export const LongText: Story = {
  args: { title: LONG_PROSE, description: LONG_PROSE, detail: LONG_TOKEN },
  play: async () => {
    await expectNoHorizontalOverflow(await screen.findByTestId("confirm-dialog"));
  },
};

export const Dark: Story = {
  args: { ...WithDetailAndConsequences.args },
  globals: { theme: "dark" },
};
