import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { getNavGroupsForMode } from "@/components/shell/nav-config";
import { expectNoHorizontalOverflow, withNarrowFrame } from "../../.storybook/story-helpers";
import { HomeAdvanced } from "./home-advanced";

const meta = {
  title: "Home/HomeAdvanced",
  component: HomeAdvanced,
  parameters: { layout: "padded" },
  args: { onNavigate: fn() },
} satisfies Meta<typeof HomeAdvanced>;

export default meta;
type Story = StoryObj<typeof meta>;

const editorCount = getNavGroupsForMode("advanced")
  .flatMap((group) => group.items)
  .filter((item) => item.path !== "/").length;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getAllByTestId(/^home-adv-\//)).toHaveLength(editorCount);
    await userEvent.click(canvas.getByTestId("home-adv-/shift-counts"));
    await expect(args.onNavigate).toHaveBeenCalledOnce();
    await expect(args.onNavigate).toHaveBeenCalledWith("/shift-counts");
  },
};

// The grid's column ladder keys off VIEWPORT media queries (`sm:`, `grid3:`), so a narrow
// frame alone still lays out three columns; the 320px `mobile1` viewport is the real case.
export const Narrow: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
