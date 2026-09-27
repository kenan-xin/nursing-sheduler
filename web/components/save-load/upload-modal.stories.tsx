import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, spyOn, waitFor } from "storybook/test";
import { UploadModal } from "./upload-modal";

// Portalled (Base UI Dialog): query with `screen`, never `canvas`.
const YAML = "workspaceVersion: 1\n";

const meta = {
  title: "SaveLoad/UploadModal",
  component: UploadModal,
  args: { open: true, onOpenChange: fn(), onFile: fn(), onLoadSample: fn() },
} satisfies Meta<typeof UploadModal>;

export default meta;
type Story = StoryObj<typeof meta>;

async function openModal() {
  const modal = await screen.findByTestId("upload-modal");
  await waitFor(() => expect(modal).toBeVisible());
  return modal;
}

export const Open: Story = {
  play: async ({ args, userEvent }) => {
    await openModal();
    await userEvent.upload(
      screen.getByTestId("upload-file-input"),
      new File([YAML], "ward.yaml", { type: "application/yaml" }),
    );
    await waitFor(() => expect(args.onFile).toHaveBeenCalledWith(YAML));
    await expect(args.onFile).toHaveBeenCalledOnce();
  },
};

// A drop bypasses the picker's `accept`, so the component re-checks the extension and alerts.
export const BadFile: Story = {
  beforeEach: () => {
    const alert = spyOn(window, "alert").mockImplementation(() => {});
    return () => alert.mockRestore();
  },
  play: async ({ args }) => {
    await openModal();
    const data = new DataTransfer();
    data.items.add(new File(["a,b"], "ward.csv", { type: "text/csv" }));
    screen
      .getByTestId("upload-dropzone")
      .dispatchEvent(
        new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith(
        "Please upload a file with one of these extensions: .yaml, .yml",
      ),
    );
    await expect(args.onFile).not.toHaveBeenCalled();
  },
};

export const LoadSample: Story = {
  play: async ({ args, userEvent }) => {
    await openModal();
    await userEvent.click(screen.getByTestId("upload-load-sample-button"));
    await expect(args.onLoadSample).toHaveBeenCalledOnce();
  },
};

export const Close: Story = {
  play: async ({ args, userEvent }) => {
    await openModal();
    await userEvent.click(screen.getByTestId("upload-modal-close"));
    await expect(args.onOpenChange).toHaveBeenCalledOnce();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  },
};

export const Closed: Story = {
  args: { open: false },
  play: async () => {
    await expect(screen.queryByTestId("upload-modal")).toBeNull();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
