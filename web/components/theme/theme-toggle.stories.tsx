import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { ACCENTS } from "./theme-store";
import { AccentControl, ThemeToggle } from "./theme-toggle";

// The harness drives the REAL theme store from the toolbar globals before each story,
// so a click here flips <html> exactly as it does in the app.
const meta = {
  title: "Theme/ThemeToggle",
  component: ThemeToggle,
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Switch to dark theme" }));
    await expect(document.documentElement).toHaveClass("dark");
    await expect(canvas.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
  },
};

export const FromDark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Switch to light theme" }));
    await expect(document.documentElement).not.toHaveClass("dark");
  },
};

export const Accent: Story = {
  render: () => <AccentControl />,
  play: async ({ canvas, userEvent }) => {
    const swatches = canvas.getAllByRole("button");
    await expect(swatches.map((swatch) => swatch.getAttribute("aria-label"))).toEqual(
      ACCENTS.map((accent) => `${accent} accent`),
    );
    await expect(swatches).toHaveLength(4);
    await expect(swatches[0]).toHaveAccessibleName("teal accent");
    await expect(swatches[3]).toHaveAccessibleName("plum accent");
    await expect(swatches[0]).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(canvas.getByRole("button", { name: "plum accent" }));
    await expect(document.documentElement).toHaveAttribute("data-accent", "plum");
  },
};

// Re-pressing the active swatch re-asserts it; an accent can never be unset.
export const AccentRepin: Story = {
  render: () => <AccentControl />,
  play: async ({ canvas, userEvent }) => {
    const teal = canvas.getByRole("button", { name: "teal accent" });
    await userEvent.click(teal);
    await expect(document.documentElement).toHaveAttribute("data-accent", "teal");
    await expect(teal).toHaveAttribute("aria-pressed", "true");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
