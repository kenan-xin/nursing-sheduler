import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor } from "storybook/test";
import {
  LONG_PROSE,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { InfoTip } from "./info-tip";

// InfoTip renders its own value, so it is one of the three `ui/*` primitives that
// gets a LongText story (Input, InfoTip, Combobox). The bubble is NOT portalled —
// it is a sibling of the trigger — so `canvas` can see it.
const meta = {
  title: "UI/InfoTip",
  component: InfoTip,
  args: {
    label: "Consecutive days",
    text: "A nurse may not work more than three consecutive long days without agreement.",
  },
} satisfies Meta<typeof InfoTip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: `${args.label}: ${args.text}` });
    // Focus opens it, so the tip is not mouse-only.
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await expect(await canvas.findByRole("tooltip")).toHaveTextContent(args.text ?? "");
    await userEvent.tab();
    await waitFor(() => expect(canvas.queryByRole("tooltip")).toBeNull());
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { text: LONG_PROSE },
  play: async ({ canvas, userEvent }) => {
    await userEvent.tab();
    const tooltip = await canvas.findByRole("tooltip");
    await expect(tooltip).toHaveTextContent(LONG_PROSE);
    // Prose slot: it wraps rather than truncating.
    await expectNoHorizontalOverflow(tooltip);
  },
};

// The trigger's icon tint is what dark axe can see without a play (there is no
// prop that opens the bubble on mount).
export const Dark: Story = {
  globals: { theme: "dark" },
};
