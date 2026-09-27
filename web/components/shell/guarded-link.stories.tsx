import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, fn } from "storybook/test";
import { GuardedLink } from "./guarded-link";
import { useNavGuardStore } from "./nav-guard-store";

// next/navigation is the nextjs-vite mock: `pathname` comes from parameters, and
// getRouter() is a fresh set of fn() spies per story.
const meta = {
  title: "Shell/GuardedLink",
  component: GuardedLink,
  parameters: { nextjs: { appDirectory: true, navigation: { pathname: "/dates" } } },
  args: { href: "/people", children: "Staff", onClick: fn() },
} satisfies Meta<typeof GuardedLink>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A window-level bubble listener runs AFTER React's root listener, so GuardedLink still
 * sees an un-prevented event and decides for itself; this only stops the browser from
 * then unloading the story iframe on a native (non-intercepted) activation.
 */
function blockNativeNavigation(): () => void {
  const block = (event: MouseEvent) => event.preventDefault();
  window.addEventListener("click", block);
  return () => window.removeEventListener("click", block);
}

export const Internal: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Staff" }));
    await expect(args.onClick).toHaveBeenCalledOnce();
    await expect(getRouter().push).toHaveBeenCalledOnce();
    await expect(getRouter().push).toHaveBeenCalledWith("/people");
  },
};

export const SameRoute: Story = {
  args: { href: "/dates", children: "Dates" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Dates" }));
    await expect(getRouter().push).not.toHaveBeenCalled();
  },
};

export const External: Story = {
  args: { href: "https://example.org/rostering-guide", children: "Rostering guide" },
  beforeEach: blockNativeNavigation,
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Rostering guide" }));
    await expect(args.onClick).toHaveBeenCalledOnce();
    await expect(getRouter().push).not.toHaveBeenCalled();
  },
};

export const NewTab: Story = {
  args: { target: "_blank" },
  beforeEach: blockNativeNavigation,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Staff" }));
    await expect(getRouter().push).not.toHaveBeenCalled();
  },
};

export const GuardedByDraft: Story = {
  beforeEach: () =>
    useNavGuardStore.getState().registerDraft({ id: "story-draft", label: "Unsaved card" }),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Staff" }));
    await expect(getRouter().push).not.toHaveBeenCalled();
    await expect(useNavGuardStore.getState().pendingIntent?.kind).toBe("push");
    useNavGuardStore.getState().confirm();
    await expect(getRouter().push).toHaveBeenCalledWith("/people");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
