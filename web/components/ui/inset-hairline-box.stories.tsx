import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { InsetHairlineReadout, InsetHairlineTile } from "./inset-hairline-box";

// Two boxes, one visual contract (`well` + `control` + `hairline`). Neither takes a
// `className` or `style` — the box owns its own paint and dimension — so any sizing
// lives on a plain wrapper.
const meta = {
  title: "UI/InsetHairlineBox",
  component: InsetHairlineTile,
} satisfies Meta<typeof InsetHairlineTile>;

export default meta;
type Story = StoryObj<typeof meta>;

function ReadoutRow() {
  return (
    <div className="w-80">
      <InsetHairlineReadout>
        <span className="text-meta font-medium text-ink">Early</span>
        <span className="text-meta text-ink3">08:00-15:00</span>
      </InsetHairlineReadout>
    </div>
  );
}

export const Tile: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <InsetHairlineTile>
        <span className="text-meta font-semibold text-ink2">LV</span>
      </InsetHairlineTile>
      <span className="text-body text-ink">Leave</span>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("LV")).toBeVisible();
    await expect(canvas.getByText("Leave")).toBeVisible();
  },
};

export const Readout: Story = {
  render: () => <ReadoutRow />,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Early")).toBeVisible();
    await expect(canvas.getByText("08:00-15:00")).toBeVisible();
  },
};

export const Dark: Story = {
  render: () => <ReadoutRow />,
  globals: { theme: "dark" },
};
