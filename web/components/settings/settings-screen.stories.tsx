import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { withFetchRoutes } from "../../.storybook/story-helpers";
import { withAssistant } from "../ai/assistant-story-harness.test-support";
import { SettingsScreen } from "./settings-screen";

// The Settings route. AI starts off, so the screen reaches no third party.
const meta = {
  title: "Settings/SettingsScreen",
  component: SettingsScreen,
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/settings" } },
  },
  beforeEach: [withAssistant({ ready: false }), withFetchRoutes([])],
} satisfies Meta<typeof SettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("ai-readiness")).toHaveTextContent("Off");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("ai-readiness")).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
