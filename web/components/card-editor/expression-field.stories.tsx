import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { ExpressionField } from "./expression-field";

// The six-expression selector + Target + "reads as" preview. Fully controlled.
const meta = {
  title: "CardEditor/ExpressionField",
  component: ExpressionField,
  args: { expression: "|x - T|^2", target: 5, onChange: fn() },
} satisfies Meta<typeof ExpressionField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /At least T/ }));
    await expect(args.onChange).toHaveBeenCalledWith({ expression: "x >= T", target: 5 });
  },
};

export const WithError: Story = {
  args: { error: "A squared expression needs a non-positive weight" },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "A squared expression needs a non-positive weight",
    );
  },
};

// Last on purpose: the next light story would prove the theme reset.
export const Dark: Story = {
  args: { ...WithError.args },
  globals: { theme: "dark" },
};
