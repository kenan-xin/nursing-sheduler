import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { CellPreferenceEditor, type WeightTarget } from "./cell-preference-editor";

// Worked shift types + groups, mirroring the orchestrator's cellEditorTargets shape.
const TARGETS: WeightTarget[] = [
  { id: "early1", name: "Early shift", isGroup: false },
  { id: "late+", name: "Late shift", isGroup: false },
  { id: "N12", name: "Night 12h", isGroup: true },
];

// Portalled (Base UI Dialog): query with `screen`, never `canvas`.
const meta = {
  title: "Requests/CellPreferenceEditor",
  component: CellPreferenceEditor,
  args: {
    open: true,
    personLabel: "1. Kevin Ong",
    dateLabel: "2026-01-05",
    cells: [],
    targets: TARGETS,
    onSave: fn(),
    onClear: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof CellPreferenceEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  play: async ({ args, userEvent }) => {
    // The popup fades in, so wait for the animation to settle before asserting visibility.
    await waitFor(() => expect(screen.getByTestId("cell-preference-editor")).toBeVisible());
    await expect(screen.getByTestId("cell-editor-tab-available")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const weight = screen.getByTestId("cell-editor-weight-input-early1");
    await userEvent.clear(weight);
    await userEvent.type(weight, "5");
    await userEvent.click(screen.getByTestId("cell-editor-save"));
    await expect(args.onSave).toHaveBeenCalledWith({
      kind: "requests",
      prefs: [{ shiftType: "early1", weight: 5 }],
    });
    // Save commits and closes.
    await expect(args.onClose).toHaveBeenCalledOnce();
  },
};

export const Off: Story = {
  play: async ({ args, userEvent }) => {
    await waitFor(() => expect(screen.getByTestId("cell-preference-editor")).toBeVisible());
    await userEvent.click(screen.getByTestId("cell-editor-tab-off"));
    await expect(screen.getByTestId("cell-editor-off")).toBeVisible();
    await expect(screen.getByTestId("cell-editor-off-weight-input")).toHaveValue("20");
    await userEvent.click(screen.getByTestId("cell-editor-save"));
    await expect(args.onSave).toHaveBeenCalledWith({ kind: "off", weight: 20 });
  },
};

export const Leave: Story = {
  play: async ({ args, userEvent }) => {
    await waitFor(() => expect(screen.getByTestId("cell-preference-editor")).toBeVisible());
    await userEvent.click(screen.getByTestId("cell-editor-tab-leave"));
    await expect(screen.getByTestId("cell-editor-leave-note")).toBeVisible();
    await userEvent.click(screen.getByTestId("cell-editor-save"));
    await expect(args.onSave).toHaveBeenCalledWith({ kind: "leave" });
    await userEvent.click(screen.getByTestId("cell-editor-clear"));
    await expect(args.onClear).toHaveBeenCalledOnce();
  },
};

export const WithError: Story = {
  play: async ({ args, userEvent }) => {
    await waitFor(() => expect(screen.getByTestId("cell-preference-editor")).toBeVisible());
    const weight = screen.getByTestId("cell-editor-weight-input-early1");
    await userEvent.clear(weight);
    await userEvent.type(weight, "not-a-number");
    await userEvent.click(screen.getByTestId("cell-editor-save"));
    await expect(screen.getByTestId("cell-editor-error")).toHaveTextContent(
      "Weight must be a whole number from -1t to 1t (1,000,000,000,000), Infinity, or -Infinity",
    );
    await expect(args.onSave).not.toHaveBeenCalled();
    // Cancel discards the draft and closes.
    await userEvent.click(screen.getByTestId("cell-editor-cancel"));
    await expect(args.onClose).toHaveBeenCalledOnce();
  },
};

export const LongText: Story = {
  args: { personLabel: LONG_TOKEN },
  play: async () => {
    await expectNoHorizontalOverflow(await screen.findByTestId("cell-preference-editor"));
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
