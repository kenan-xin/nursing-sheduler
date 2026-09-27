import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_PROSE,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { ImportWarningsBanner } from "./import-warnings-banner";

const meta = {
  title: "SaveLoad/ImportWarningsBanner",
  component: ImportWarningsBanner,
  parameters: { layout: "padded" },
  args: { warnings: ["Count 1: the shift type was not recognised."], onDismiss: fn() },
} satisfies Meta<typeof ImportWarningsBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneWarning: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("import-warnings-dismiss"));
    await expect(args.onDismiss).toHaveBeenCalledOnce();
  },
};

export const ManyWarnings: Story = {
  args: {
    warnings: [
      "Count 1: the shift type was not recognised.",
      "Succession 2: the pattern refers to an unknown shift id.",
      "The imported file used a newer scenario schema version.",
    ],
  },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { warnings: [LONG_PROSE] },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: { ...ManyWarnings.args },
  globals: { theme: "dark" },
};
