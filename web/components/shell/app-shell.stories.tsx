import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, screen, waitFor } from "storybook/test";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario } from "@/lib/store";
import { AppShell } from "./app-shell";
import { useNavGuardStore } from "./nav-guard-store";

// The whole chrome around a screen. AI is off (the "AI is optional" state): the
// assistant surface draws nothing, so no launcher and no dock.
const meta = {
  title: "Shell/AppShell",
  component: AppShell,
  parameters: {
    scenario: pickScenario(makeValidUiState()),
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/dates" } },
  },
  // Every real screen holds a control; a bare <p> would leave the scroll region
  // with nothing focusable (axe scrollable-region-focusable at mobile widths).
  args: {
    children: (
      <>
        <p>Screen content</p>
        <button type="button">Screen action</button>
      </>
    ),
  },
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("desktop-sidebar")).toBeVisible();
    await expect(canvas.getByTestId("top-bar")).toBeVisible();
    await expect(await canvas.findByText("Screen content")).toBeVisible();
    await expect(screen.queryByTestId("assistant-launcher")).toBeNull();
    await expect(screen.queryByTestId("assistant-dock")).toBeNull();
  },
};

export const Collapsed: Story = {
  play: async ({ canvas, userEvent }) => {
    const sidebar = canvas.getByTestId("desktop-sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    await userEvent.click(canvas.getByTestId("side-collapse-toggle"));
    await waitFor(() => expect(sidebar).toHaveAttribute("data-collapsed", "true"));
  },
};

export const Mobile: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvas }) => {
    // Past the hydration gate, so the screen (and its control) is mounted.
    await expect(await canvas.findByRole("button", { name: "Screen action" })).toBeVisible();
    await expect(canvas.getByTestId("desktop-sidebar")).not.toBeVisible();
    await expect(canvas.getByTestId("mobile-nav-trigger")).toBeVisible();
  },
};

// A losable draft makes navigation ask first; Stay keeps the user where they are.
export const GuardedNavigation: Story = {
  beforeEach: () =>
    useNavGuardStore.getState().registerDraft({ id: "story-draft", label: "Story draft" }),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("nav-link-/people"));
    const stay = await screen.findByRole("button", { name: "Stay" });
    await waitFor(() => expect(stay).toBeVisible());
    await userEvent.click(stay);
    await expect(getRouter().push).not.toHaveBeenCalled();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
