import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor } from "storybook/test";
import {
  drainScenarioCommands,
  scenarioCommands,
  useAuthorityStore,
  useScenarioStore,
} from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { UndoRedoControls } from "./undo-redo-controls";

// History is durable now: availability comes from committed facts, so every state
// here is reached by real commands on a fresh IndexedDB (parameters.scenario).
const ONE_EDIT: ScenarioSeed = { staff: [{ id: "Nurse A" }] };
const UNDONE: ScenarioSeed = async () => {
  await scenarioCommands.mutate({ staff: [{ id: "Nurse A" }] });
  await scenarioCommands.undo();
};

const meta = {
  title: "Shell/UndoRedoControls",
  component: UndoRedoControls,
  parameters: { scenario: "empty" },
} satisfies Meta<typeof UndoRedoControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoHistory: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Redo" })).toBeDisabled();
  },
};

export const CanUndo: Story = {
  parameters: { scenario: ONE_EDIT },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }));
    await drainScenarioCommands();
    await expect(useScenarioStore.getState().staff).toHaveLength(0);
    await waitFor(() => expect(canvas.getByRole("button", { name: "Redo" })).toBeEnabled());
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeDisabled();
  },
};

export const CanRedo: Story = {
  parameters: { scenario: UNDONE },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Redo" }));
    await drainScenarioCommands();
    await expect(useScenarioStore.getState().staff).toHaveLength(1);
    await waitFor(() => expect(canvas.getByRole("button", { name: "Redo" })).toBeDisabled());
  },
};

export const ReadOnlyTab: Story = {
  parameters: { scenario: ONE_EDIT },
  // Stands in for a second tab coming up read-only (Shell/OwnershipBanner proves the peer path).
  beforeEach: () => {
    useAuthorityStore.setState({ ownership: "read-only" });
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeDisabled();
  },
};

export const Dark: Story = {
  parameters: { scenario: ONE_EDIT },
  globals: { theme: "dark" },
};
