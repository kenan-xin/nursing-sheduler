import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { Badge } from "./badge";

// DESIGN.md §5: status reads as text (`DONE` / `CURRENT` / `TO DO`); the tint, its
// matching semantic ink and the border carry the tier. No glyphs, no leader dots.
const meta = {
  title: "UI/Badge",
  component: Badge,
  args: { children: "TO DO" },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {
  args: { variant: "neutral" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("TO DO")).toHaveAttribute("data-variant", "neutral");
  },
};

export const Brand: Story = {
  args: { variant: "brand", children: "CURRENT" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("CURRENT")).toHaveAttribute("data-variant", "brand");
  },
};

export const Success: Story = {
  args: { variant: "success", children: "DONE" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("DONE")).toHaveAttribute("data-variant", "success");
  },
};

export const Warn: Story = {
  args: { variant: "warn" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("TO DO")).toHaveAttribute("data-variant", "warn");
  },
};

export const Error: Story = {
  args: { variant: "error" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("TO DO")).toHaveAttribute("data-variant", "error");
  },
};

export const Outline: Story = {
  args: { variant: "outline", children: "CURRENT" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("CURRENT")).toHaveAttribute("data-variant", "outline");
  },
};

// `casing: "normal"` exists so authored data reads exactly as the user typed it.
export const NormalCase: Story = {
  args: { children: "Ward 8", casing: "normal" },
  play: async ({ canvas }) => {
    const badge = canvas.getByText("Ward 8");
    await expect(badge).toHaveAttribute("data-variant", "neutral");
    await expect(badge).toHaveClass("normal-case");
  },
};

// Warn is the tightest tint/ink pair in light mode (4.88:1 — see badge.tsx), so it
// is the file's riskiest state under the dark ramp.
export const Dark: Story = {
  args: { ...Warn.args },
  globals: { theme: "dark" },
};
