import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fireEvent, fn } from "storybook/test";
import { RequestsToolbar } from "./requests-toolbar";

const meta = {
  title: "Requests/RequestsToolbar",
  component: RequestsToolbar,
  parameters: { layout: "padded" },
  args: {
    mode: "normal",
    onSetMode: fn(),
    onOpenRequestsCsv: fn(),
    onOpenHistoryCsv: fn(),
    onDownloadCsv: fn(),
    clearOpen: false,
    onToggleClear: fn(),
  },
} satisfies Meta<typeof RequestsToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Normal: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("requests-tab-normal")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(canvas.getByTestId("requests-tab-quick"));
    await expect(args.onSetMode).toHaveBeenCalledOnce();
    await expect(args.onSetMode).toHaveBeenCalledWith("quick");
    // Download reads the matrix, so it is available in both modes.
    await userEvent.click(canvas.getByTestId("requests-download-csv"));
    await expect(args.onDownloadCsv).toHaveBeenCalledOnce();
  },
};

export const Quick: Story = {
  args: { mode: "quick" },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("requests-tab-quick")).toHaveAttribute("aria-selected", "true");
    await userEvent.click(canvas.getByTestId("requests-open-requests-csv"));
    await expect(args.onOpenRequestsCsv).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("requests-open-history-csv"));
    await expect(args.onOpenHistoryCsv).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("requests-toggle-clear"));
    await expect(args.onToggleClear).toHaveBeenCalledOnce();
  },
};

export const ClearOpen: Story = {
  args: { clearOpen: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("requests-toggle-clear")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const CsvDisabled: Story = {
  args: {
    mode: "quick",
    requestsCsvDisabled: true,
    requestsCsvDisabledReason: "Set a valid weight to import shift requests.",
  },
  play: async ({ args, canvas }) => {
    const requestsCsv = canvas.getByTestId("requests-open-requests-csv");
    await expect(requestsCsv).toBeDisabled();
    await expect(requestsCsv).toHaveAttribute(
      "title",
      "Set a valid weight to import shift requests.",
    );
    // The button is `pointer-events-none` while disabled, so drive the event directly.
    fireEvent.click(requestsCsv);
    await expect(args.onOpenRequestsCsv).not.toHaveBeenCalled();
    await expect(canvas.getByTestId("requests-open-history-csv")).not.toBeDisabled();
  },
};

export const Dark: Story = {
  args: { ...Quick.args },
  globals: { theme: "dark" },
};
