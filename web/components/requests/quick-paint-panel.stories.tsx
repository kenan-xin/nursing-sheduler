import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fireEvent, fn } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { QuickPaintPanel, type PaintTarget } from "./quick-paint-panel";

// Shift types + reserved targets, mirroring the orchestrator's paintTargets order.
const TARGETS: PaintTarget[] = [
  { id: "early1", name: "Early shift" },
  { id: "late+", name: "Late shift" },
  { id: "N12", name: "Night 12h" },
  { id: "OFF", name: "Off / rest day" },
  { id: "LEAVE", name: "Paid leave" },
];

const meta = {
  title: "Requests/QuickPaintPanel",
  component: QuickPaintPanel,
  parameters: { layout: "padded" },
  args: {
    targets: TARGETS,
    selectedIds: [],
    weight: "5",
    onToggle: fn(),
    onWeightChange: fn(),
    onSetPosInf: fn(),
    onSetNegInf: fn(),
  },
} satisfies Meta<typeof QuickPaintPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoneSelected: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("quick-paint-status")).toHaveTextContent(
      "Drag over cells to clear existing requests or history. Empty cells will not change.",
    );
    await userEvent.click(canvas.getByTestId("quick-paint-chip-early1"));
    await expect(args.onToggle).toHaveBeenCalledOnce();
    await expect(args.onToggle).toHaveBeenCalledWith("early1");
  },
};

export const Selected: Story = {
  args: { selectedIds: ["early1"] },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("quick-paint-chip-early1")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByTestId("quick-paint-status")).toHaveTextContent(
      "Drag over cells to apply early1 with weight +5.",
    );

    // `weight` is a controlled prop the story does not update, so one full-value change
    // event is the only reliable way to reach the handler (typing appends to the pinned value).
    fireEvent.change(canvas.getByTestId("quick-paint-weight-input"), { target: { value: "9" } });
    await expect(args.onWeightChange).toHaveBeenCalledOnce();
    await expect(args.onWeightChange).toHaveBeenCalledWith("9");

    await userEvent.click(canvas.getByTestId("quick-paint-pos-inf"));
    await expect(args.onSetPosInf).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("quick-paint-neg-inf"));
    await expect(args.onSetNegInf).toHaveBeenCalledOnce();
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    targets: [{ id: LONG_TOKEN, name: LONG_TOKEN }],
    selectedIds: [LONG_TOKEN],
  },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();
  },
};

export const Dark: Story = {
  args: { ...Selected.args },
  globals: { theme: "dark" },
};
