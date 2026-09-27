import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { useAuthorityStore, useHotStore } from "@/lib/store";
import { PersistenceBadge, PersistenceStatus } from "./persistence-status";

// Both surfaces read the hydration lifecycle and the repository write status. `Saved` is
// the real post-bring-up state; the others are set on the projection in `beforeEach`,
// standing in for an in-flight or failed transaction, or a slow or failed bring-up.
const meta = {
  title: "Shell/PersistenceStatus",
  component: PersistenceStatus,
  parameters: { scenario: "empty" },
  render: () => (
    <div className="flex gap-3">
      <PersistenceStatus />
      <PersistenceBadge />
    </div>
  ),
} satisfies Meta<typeof PersistenceStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {
  play: async ({ canvas }) => {
    const chip = canvas.getByTestId("persistence-status");
    const badge = canvas.getByTestId("persistence-badge");
    await expect(chip).toHaveAttribute("data-status", "saved");
    await expect(badge).toHaveAttribute("data-status", "saved");
    await expect(chip).toHaveTextContent("Saved");
    await expect(badge).toHaveTextContent("Saved");
    // The chip is the shell's one live region; the badge must not double-announce.
    await expect(canvas.getAllByRole("status")).toEqual([chip]);
  },
};

export const Saving: Story = {
  // Stands in for a repository transaction in flight.
  beforeEach: () => {
    useAuthorityStore.setState({ writeStatus: "writing" });
  },
  play: async ({ canvas }) => {
    const chip = canvas.getByTestId("persistence-status");
    await expect(chip).toHaveTextContent("Saving");
    await expect(chip.querySelector("svg")).toHaveClass("animate-spin-slow");
  },
};

// Stands in for a failed repository transaction.
const saveFailed = () => {
  useAuthorityStore.setState({ writeStatus: "error" });
};

export const SaveFailed: Story = {
  beforeEach: saveFailed,
  play: async ({ canvas }) => {
    const chip = canvas.getByTestId("persistence-status");
    await expect(chip).toHaveTextContent("Save failed");
    await expect(chip).toHaveAttribute("data-status", "error");
  },
};

export const Restoring: Story = {
  // Stands in for authority bring-up still resolving.
  beforeEach: () => {
    useHotStore.getState().setHydrationStatus("hydrating");
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("persistence-status")).toHaveTextContent("Restoring");
  },
};

export const Stalled: Story = {
  // Stands in for a bring-up that never settled.
  beforeEach: () => {
    useHotStore.getState().setHydrationStatus("stalled");
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("persistence-status")).toHaveTextContent("Restore stalled");
  },
};

export const LoadFailed: Story = {
  // Stands in for stored data that could not be loaded.
  beforeEach: () => {
    useHotStore.getState().setHydrationStatus("recoverable-error");
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("persistence-status")).toHaveTextContent("Save failed");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  beforeEach: saveFailed,
};
