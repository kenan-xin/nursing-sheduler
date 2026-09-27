import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { Separator } from "./separator";

// Base UI publishes orientation as `data-orientation` AND `aria-orientation`; the
// component's own doc comment explains why the preset's `data-horizontal:`
// variants are deliberately unused.
const meta = {
  title: "UI/Separator",
  component: Separator,
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

function Ruled() {
  return (
    <div className="w-80">
      <p className="text-body text-ink">Before the rule</p>
      <Separator />
      <p className="text-body text-ink">After the rule</p>
    </div>
  );
}

export const Horizontal: Story = {
  render: () => <Ruled />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("separator")).toHaveAttribute("aria-orientation", "horizontal");
  },
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-16 items-center gap-3">
      <span className="text-body text-ink">Roster</span>
      <Separator orientation="vertical" />
      <span className="text-body text-ink">Requests</span>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
  },
};

export const Dark: Story = {
  render: () => <Ruled />,
  globals: { theme: "dark" },
};
