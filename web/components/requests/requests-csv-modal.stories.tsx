import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { RequestsCsvModal } from "./requests-csv-modal";

// Portalled (Base UI Dialog): query with `screen`, never `canvas`.
const CSV = "person,2026-07-03\nP1,late+\n";

const meta = {
  title: "Requests/RequestsCsvModal",
  component: RequestsCsvModal,
  args: { open: true, kind: "requests", onFileText: fn(), onClose: fn() },
} satisfies Meta<typeof RequestsCsvModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Requests: Story = {
  play: async ({ args, userEvent }) => {
    const modal = await screen.findByTestId("requests-csv-modal");
    await waitFor(() => expect(modal).toBeVisible());
    await expect(screen.getByText("Requests CSV")).toBeVisible();
    await userEvent.upload(
      screen.getByTestId("requests-csv-file-input"),
      new File([CSV], "requests.csv", { type: "text/csv" }),
    );
    await waitFor(() => expect(args.onFileText).toHaveBeenCalledWith(CSV));
    await expect(args.onFileText).toHaveBeenCalledOnce();
  },
};

export const History: Story = {
  args: { kind: "history" },
  play: async () => {
    const modal = await screen.findByTestId("requests-csv-modal");
    await waitFor(() => expect(modal).toBeVisible());
    await expect(screen.getByText("History CSV")).toBeVisible();
    await expect(modal).toHaveTextContent("Exactly 3 columns, no header");
  },
};

export const Close: Story = {
  play: async ({ args, userEvent }) => {
    const modal = await screen.findByTestId("requests-csv-modal");
    await waitFor(() => expect(modal).toBeVisible());
    await userEvent.click(screen.getByTestId("requests-csv-modal-close"));
    await expect(args.onClose).toHaveBeenCalledOnce();
  },
};

export const Closed: Story = {
  args: { open: false },
  play: async () => {
    await expect(screen.queryByTestId("requests-csv-modal")).toBeNull();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
