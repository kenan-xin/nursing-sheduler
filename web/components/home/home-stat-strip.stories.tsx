import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { HomeStatStrip, type HomeStat } from "./home-stat-strip";

// The ward summary Home passes (ScreenHome.dc.html:23-31). Values arrive pre-formatted.
const STATS: HomeStat[] = [
  { value: "12", label: "Nurses" },
  { value: "3", label: "Seniors" },
  { value: "5", label: "Shifts" },
  { value: "28", label: "Roster Days" },
];

const meta = {
  title: "Home/HomeStatStrip",
  component: HomeStatStrip,
  parameters: { layout: "padded" },
  args: { stats: STATS },
} satisfies Meta<typeof HomeStatStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("home-stat-strip")).toBeVisible();
    for (const stat of STATS) {
      await expect(canvas.getByText(stat.value)).toBeVisible();
      await expect(canvas.getByText(stat.label)).toBeVisible();
    }
  },
};

export const Zero: Story = {
  args: { stats: STATS.map((stat) => ({ ...stat, value: "0" })) },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByText("0")).toHaveLength(STATS.length);
  },
};

export const Dark: Story = {
  args: { ...Default.args },
  globals: { theme: "dark" },
};
