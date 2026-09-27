import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { Input } from "./input";
import { Label } from "./label";

// Label is the uppercase eyebrow (DESIGN.md §3); its whole contract is the
// label/control association, so every story pairs it with the real Input.
const meta = {
  title: "UI/Label",
  component: Label,
  args: { children: "Ward name", htmlFor: "ward-name" },
  render: (args) => (
    <div className="flex w-80 flex-col gap-2">
      <Label {...args} />
      <Input id="ward-name" />
    </div>
  ),
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    // getByLabelText resolves THROUGH the association, so this fails if htmlFor and
    // the control's id ever drift apart.
    await expect(canvas.getByLabelText("Ward name")).toHaveAttribute("data-slot", "input");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
