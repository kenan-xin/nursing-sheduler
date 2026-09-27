import type { ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

// Portalled (Base UI Dialog): every query goes through `screen`, never `canvas`.
const meta = {
  title: "UI/Dialog",
  component: Dialog,
  args: { onOpenChange: fn() },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo({
  defaultOpen,
  onOpenChange,
}: Pick<ComponentProps<typeof Dialog>, "defaultOpen" | "onOpenChange">) {
  return (
    <Dialog defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" />}>Edit shift type</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit shift type</DialogTitle>
          <DialogDescription>Hours apply to every roster period.</DialogDescription>
        </DialogHeader>
        <p className="text-body text-ink">Start 08:00, end 15:00.</p>
      </DialogContent>
    </Dialog>
  );
}

export const Open: Story = {
  render: (args) => <Demo defaultOpen onOpenChange={args.onOpenChange} />,
  play: async () => {
    // The accessible name comes from `DialogTitle`, so this also pins the wiring
    // that the portal a11y proof below removes.
    const dialog = await screen.findByRole("dialog", { name: "Edit shift type" });
    await waitFor(() => expect(dialog).toBeVisible());
  },
};

export const FromTrigger: Story = {
  render: (args) => <Demo onOpenChange={args.onOpenChange} />,
  play: async ({ userEvent }) => {
    await userEvent.click(screen.getByRole("button", { name: "Edit shift type" }));
    // The popup mounts carrying `data-starting-style`, so it is in the DOM before
    // the entry animation has made it visible. Wait for the fade to land.
    const dialog = await screen.findByRole("dialog", { name: "Edit shift type" });
    await waitFor(() => expect(dialog).toBeVisible());
  },
};

// The built-in close affordance in `DialogContent` (a `DialogPrimitive.Close`
// rendered as the icon Button, named by its sr-only "Close").
export const CloseButton: Story = {
  render: (args) => <Demo defaultOpen onOpenChange={args.onOpenChange} />,
  play: async ({ args, userEvent }) => {
    await screen.findByRole("dialog", { name: "Edit shift type" });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  },
};

export const Dark: Story = {
  render: (args) => <Demo defaultOpen onOpenChange={args.onOpenChange} />,
  globals: { theme: "dark" },
};
