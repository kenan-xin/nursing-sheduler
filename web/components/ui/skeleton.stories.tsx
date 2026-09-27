import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { Skeleton, SkeletonCard, SkeletonLine, SkeletonText } from "./skeleton";

// "Shimmer from structure": each helper reproduces the box it stands in for. The
// skeleton is `aria-hidden`, so every assertion counts nodes rather than querying
// by role.
const meta = {
  title: "UI/Skeleton",
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

function countSkeletons(el: HTMLElement): number {
  return el.querySelectorAll('[data-slot="skeleton"]').length;
}

export const Bare: Story = {
  render: () => (
    <div className="w-80">
      <Skeleton className="h-10 w-40" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(countSkeletons(canvasElement)).toBe(1);
  },
};

export const Line: Story = {
  render: () => (
    <div className="w-80">
      <SkeletonLine className="text-body w-full" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(countSkeletons(canvasElement)).toBe(1);
  },
};

export const Text: Story = {
  render: () => (
    <div className="w-80">
      <SkeletonText lines={3} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(countSkeletons(canvasElement)).toBe(3);
  },
};

export const Card: Story = {
  render: () => (
    <div className="w-80">
      <SkeletonCard />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // Two header lines, two body lines and one footer control placeholder — the
    // resolved card's own structure.
    await expect(countSkeletons(canvasElement)).toBe(5);
  },
};

export const Dark: Story = {
  render: () => (
    <div className="w-80">
      <SkeletonCard />
    </div>
  ),
  globals: { theme: "dark" },
};
