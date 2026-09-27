import type { ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { FaCircleInfo } from "@/components/icons";
import { Button } from "./button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";

// Portalled (Base UI AlertDialog): every query goes through `screen`, never `canvas`.
const meta = {
  title: "UI/AlertDialog",
  component: AlertDialog,
  args: { onOpenChange: fn() },
} satisfies Meta<typeof AlertDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo({
  defaultOpen,
  onOpenChange,
  tone = "brand",
}: Pick<ComponentProps<typeof AlertDialog>, "defaultOpen" | "onOpenChange"> & {
  tone?: "brand" | "warn" | "error";
}) {
  return (
    <AlertDialog defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <AlertDialogTrigger render={<Button variant="outline" />}>Disable card</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia tone={tone}>
            <FaCircleInfo aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle>Disable this card?</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>
            A disabled card stays in the scenario, but the solver ignores it until it is re-enabled.
          </AlertDialogDescription>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep enabled</AlertDialogCancel>
          <AlertDialogAction>Disable card</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export const Open: Story = {
  render: (args) => <Demo defaultOpen onOpenChange={args.onOpenChange} />,
  play: async ({ args, userEvent }) => {
    const dialog = await screen.findByRole("alertdialog", { name: "Disable this card?" });
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "Keep enabled" }));
    await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  },
};

export const FromTrigger: Story = {
  render: (args) => <Demo onOpenChange={args.onOpenChange} />,
  play: async ({ userEvent }) => {
    await userEvent.click(screen.getByRole("button", { name: "Disable card" }));
    // The popup mounts carrying `data-starting-style`, so it is in the DOM before
    // the entry animation has made it visible. Wait for the fade to land.
    const dialog = await screen.findByRole("alertdialog", { name: "Disable this card?" });
    await waitFor(() => expect(dialog).toBeVisible());
  },
};

export const WithMedia: Story = {
  render: (args) => <Demo defaultOpen tone="brand" onOpenChange={args.onOpenChange} />,
  play: async () => {
    const dialog = await screen.findByRole("alertdialog", { name: "Disable this card?" });
    await expect(dialog.querySelector("[data-slot='alert-dialog-media']")).toHaveAttribute(
      "data-tone",
      "brand",
    );
  },
};

export const WithMediaError: Story = {
  render: (args) => <Demo defaultOpen tone="error" onOpenChange={args.onOpenChange} />,
  play: async () => {
    const dialog = await screen.findByRole("alertdialog", { name: "Disable this card?" });
    await expect(dialog.querySelector("[data-slot='alert-dialog-media']")).toHaveAttribute(
      "data-tone",
      "error",
    );
  },
};

// The media header plus the footer band is the file's richest state.
export const Dark: Story = {
  render: (args) => <Demo defaultOpen tone="brand" onOpenChange={args.onOpenChange} />,
  globals: { theme: "dark" },
};
