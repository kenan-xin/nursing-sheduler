import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useQueryClient } from "@tanstack/react-query";
import { expect } from "storybook/test";
import { useTheme } from "@/components/theme/theme-provider";

// Harness self-checks (bead w0e.2). Hidden from the sidebar (`!dev`), still run by
// `pnpm test:stories`.
function ProviderProbe() {
  const client = useQueryClient();
  const { theme, accent } = useTheme();
  const retry = String(client.getDefaultOptions().queries?.retry);
  return <p>{`retry:${retry} theme:${theme} accent:${accent}`}</p>;
}

const meta = {
  title: "Harness/Providers",
  tags: ["!dev"],
  render: () => <ProviderProbe />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// Declared BEFORE `Light` on purpose: stories in a file run in order in one page, so
// `Light` proves a story is not left in the previous story's theme.
export const Dark: Story = {
  globals: { theme: "dark", accent: "plum" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("retry:false theme:dark accent:plum")).toBeVisible();
    await expect(document.documentElement).toHaveClass("dark");
    await expect(document.documentElement).toHaveAttribute("data-accent", "plum");
  },
};

export const Light: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("retry:false theme:light accent:teal")).toBeVisible();
    await expect(document.documentElement).not.toHaveClass("dark");
  },
};

export const AppFonts: Story = {
  play: async ({ canvas }) => {
    const text = await canvas.findByText(/theme:light/);
    await document.fonts.ready;
    const family = getComputedStyle(text).fontFamily;
    // Contains the stack tail => `--ff-body` resolved, which needs `--font-hanken` on <html>.
    await expect(family).toContain("system-ui");
    // ...and a real face precedes it.
    await expect(family).not.toMatch(/^system-ui/);
    await expect([...document.fonts].some((face) => face.status === "loaded")).toBe(true);
  },
};
