import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, fn } from "storybook/test";
import { FaXmark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { AppSideNav } from "./app-side-nav";
import { useNavGuardStore } from "./nav-guard-store";

// The desktop rail: 280px wide, fixed height so the nav list scrolls inside it.
const meta = {
  title: "Shell/AppSideNav",
  component: AppSideNav,
  parameters: { nextjs: { appDirectory: true, navigation: { pathname: "/people" } } },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[280px]">
        <Story />
      </div>
    ),
  ],
  args: { onAfterNavigate: fn() },
} satisfies Meta<typeof AppSideNav>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("nav-link-/people")).toHaveAttribute("aria-current", "page");
    // Same guard as app-shell-rebuild.spec.ts: the identity line fits unwrapped.
    const name = canvas.getByTestId("sidebar-identity-name");
    await expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    await userEvent.click(canvas.getByTestId("nav-link-/dates"));
    await expect(getRouter().push).toHaveBeenCalledWith("/dates");
    await expect(args.onAfterNavigate).toHaveBeenCalledOnce();
  },
};

export const Collapsed: Story = {
  args: { collapsed: true },
  decorators: [
    (Story) => (
      <div className="w-[60px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("sidebar-brand-mark")).toHaveAttribute(
      "title",
      "Genie Rota · Nurse Scheduling",
    );
    await expect(canvas.getByTestId("mode-toggle")).toHaveAttribute("data-compact", "true");
    await expect(canvas.queryByTestId("sidebar-identity")).toBeNull();
  },
};

export const WithHeaderActions: Story = {
  args: {
    headerActions: (
      <Button variant="ghost" size="icon" aria-label="Close navigation menu">
        <FaXmark />
      </Button>
    ),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Close navigation menu" })).toBeVisible();
  },
};

export const ThemeFromFooter: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Switch to dark theme" }));
    await expect(document.documentElement).toHaveClass("dark");
  },
};

export const GuardedByDraft: Story = {
  beforeEach: () =>
    useNavGuardStore.getState().registerDraft({ id: "story-draft", label: "Unsaved card" }),
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("nav-link-/dates"));
    await expect(getRouter().push).not.toHaveBeenCalled();
    await expect(useNavGuardStore.getState().pendingIntent?.kind).toBe("push");
    // Current behaviour: `onAfterNavigate` runs even when the push is only staged, so the
    // mobile drawer closes behind the shell's confirm dialog.
    await expect(args.onAfterNavigate).toHaveBeenCalledOnce();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
