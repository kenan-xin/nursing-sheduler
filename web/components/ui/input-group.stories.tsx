import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group";

const meta = {
  title: "UI/InputGroup",
  component: InputGroup,
  args: { onClick: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof InputGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

// Both addon alignments the addon cva publishes.
function aligned(align: "inline-start" | "inline-end") {
  return (
    <InputGroup className="w-80">
      {align === "inline-start" && <InputGroupAddon align="inline-start">£</InputGroupAddon>}
      <InputGroupInput aria-label="Weight" placeholder="0.0" />
      {align === "inline-end" && <InputGroupAddon align="inline-end">kg</InputGroupAddon>}
    </InputGroup>
  );
}

export const WithAddon: Story = {
  render: () => aligned("inline-start"),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("£")).toBeVisible();
    await expect(canvas.getByRole("textbox", { name: "Weight" })).toBeVisible();
  },
};

export const WithButton: Story = {
  render: (args) => (
    <InputGroup className="w-80">
      <InputGroupInput aria-label="Shift search" placeholder="Search shifts" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton onClick={args.onClick}>Search</InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Search" }));
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};

export const AddonInlineStart: Story = {
  render: () => aligned("inline-start"),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="input-group-addon"]')).toHaveAttribute(
      "data-align",
      "inline-start",
    );
  },
};

export const AddonInlineEnd: Story = {
  render: () => aligned("inline-end"),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="input-group-addon"]')).toHaveAttribute(
      "data-align",
      "inline-end",
    );
  },
};

export const Dark: Story = {
  render: () => aligned("inline-start"),
  globals: { theme: "dark" },
};
