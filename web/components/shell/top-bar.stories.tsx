import type { Decorator, Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor } from "storybook/test";
import { useModeStore } from "@/lib/mode/mode";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, scenarioCommands } from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { getNavItemForMode } from "./nav-config";
import { useSideCollapseStore } from "./side-collapse";
import { TopBar } from "./top-bar";

const named =
  (description: string): ScenarioSeed =>
  async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate((s) => ({ meta: { ...s.meta, description } }));
  };

// The collapse toggle's `aria-controls` target, which AppShell provides in the app.
const shellFrame: Decorator = (Story) => (
  <div className="w-[1100px]">
    <Story />
    <nav id="app-side-nav" aria-label="Main navigation" />
  </div>
);

const meta = {
  title: "Shell/TopBar",
  component: TopBar,
  parameters: {
    scenario: named("Ward 8 East"),
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/people" } },
  },
  decorators: [shellFrame],
} satisfies Meta<typeof TopBar>;

export default meta;
type Story = StoryObj<typeof meta>;

const path = (pathname: string) => ({ appDirectory: true, navigation: { pathname } });

export const Guided: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("route-crumb")).toHaveTextContent(
      `Step 2 · ${getNavItemForMode("/people", "guided")!.label}`,
    );
    await expect(canvas.getByTestId("scenario-context")).toHaveTextContent("Ward 8 East");
    await expect(canvas.getByTestId("persistence-status")).toHaveTextContent("Saved");
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeEnabled();
  },
};

export const Home: Story = {
  parameters: { nextjs: path("/") },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("route-crumb")).toHaveTextContent(/^Home$/);
  },
};

export const AdvancedRoute: Story = {
  parameters: { nextjs: path("/shift-counts") },
  beforeEach: () => {
    useModeStore.setState({ mode: "advanced" });
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("route-crumb")).toHaveTextContent(
      new RegExp(`^${getNavItemForMode("/shift-counts", "advanced")!.label}$`),
    );
  },
};

export const Untitled: Story = {
  parameters: { scenario: "empty" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("scenario-context")).toHaveTextContent("Untitled schedule");
  },
};

export const Collapse: Story = {
  play: async ({ canvas, userEvent }) => {
    const toggle = canvas.getByTestId("side-collapse-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAccessibleName("Collapse sidebar");
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "false"));
    await expect(toggle).toHaveAccessibleName("Expand sidebar");
    await expect(useSideCollapseStore.getState().collapsed).toBe(true);
  },
};

export const Mobile: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
    await expect(canvas.getByTestId("side-collapse-toggle")).not.toBeVisible();
  },
};

export const LongText: Story = {
  parameters: { scenario: named(LONG_TOKEN) },
  decorators: [
    (Story) => (
      <div className="w-[640px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("top-bar"));
    // KNOWN OVERFLOW nursing-sheduler-w0e.25: restore `await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();` when fixed
    await expect(canvas.getByTestId("scenario-context")).toHaveTextContent(LONG_TOKEN);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
