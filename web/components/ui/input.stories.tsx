import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { Input } from "./input";

const meta = {
  title: "UI/Input",
  component: Input,
  args: { "aria-label": "Ward name", onChange: fn() },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const input = canvas.getByRole("textbox", { name: "Ward name" });
    await userEvent.type(input, "Ward 8");
    await expect(input).toHaveValue("Ward 8");
    await expect(args.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ value: "Ward 8" }),
      }),
    );
  },
};

export const Placeholder: Story = {
  args: { placeholder: "e.g. Ward 8 east" },
  play: async ({ canvas }) => {
    await expect(canvas.getByPlaceholderText("e.g. Ward 8 east")).toBeVisible();
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "Ward 8" },
  play: async ({ args, canvas, userEvent }) => {
    const input = canvas.getByRole("textbox", { name: "Ward name" });
    await expect(input).toBeDisabled();
    await userEvent.type(input, " east");
    await expect(input).toHaveValue("Ward 8");
    await expect(args.onChange).not.toHaveBeenCalled();
  },
};

export const Invalid: Story = {
  args: { "aria-invalid": true, defaultValue: "Ward 8" },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("textbox", { name: "Ward name" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  },
};

// The input renders the value itself, so it is one of the three `ui/*` primitives
// that gets a LongText story (Input, InfoTip, Combobox). A form control scrolls its
// own value rather than painting past its box, so only containment is asserted.
export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { defaultValue: LONG_TOKEN },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

// Invalid is the file's richest state: it is the only one that paints the error
// border and ring, which is the pair most at risk under the dark ramp.
export const Dark: Story = {
  args: { ...Invalid.args },
  globals: { theme: "dark" },
};
