import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { withFetchRoutes } from "../../.storybook/story-helpers";
import { withAssistant } from "./assistant-story-harness.test-support";
import { AssistantLauncher, formatAttentionCount } from "./assistant-launcher";

// The launcher reads the assistant store only. Each story installs its own assistant
// (Ready or not) on a fresh database; no request may leave the page.
const epoch = () => useAssistantStore.getState().turnEpoch;

const meta = {
  title: "AI/AssistantLauncher",
  component: AssistantLauncher,
  beforeEach: withFetchRoutes([]),
} satisfies Meta<typeof AssistantLauncher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotReady: Story = {
  beforeEach: withAssistant({ ready: false }),
  play: async ({ canvas }) => {
    await expect(canvas.queryByTestId("assistant-launcher")).toBeNull();
  },
};

export const Ready: Story = {
  beforeEach: withAssistant(),
  play: async ({ canvas, userEvent }) => {
    const launcher = await canvas.findByTestId("assistant-launcher");
    await expect(launcher).toHaveAccessibleName("Show assistant");
    await userEvent.click(launcher);
    await expect(useAssistantStore.getState().panelOpen).toBe(true);
    await expect(launcher).toHaveAttribute("aria-pressed", "true");
  },
};

export const Attention: Story = {
  beforeEach: [
    withAssistant(),
    () => {
      assistantActions.showProposal("proposal-1", epoch());
      assistantActions.showRunRequest(epoch());
    },
  ],
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("assistant-launcher-badge")).toHaveTextContent(
      formatAttentionCount(2),
    );
    await expect(canvas.getByTestId("assistant-launcher")).toHaveAccessibleName(
      "Show assistant, 2 items need you",
    );
  },
};

export const Working: Story = {
  beforeEach: [withAssistant(), () => assistantActions.beginTurn("turn-1", epoch())],
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("assistant-launcher-working")).toBeInTheDocument();
    await expect(canvas.getByTestId("assistant-launcher")).toHaveAccessibleName(
      "Show assistant, working",
    );
  },
};

export const Dark: Story = {
  beforeEach: [withAssistant(), () => assistantActions.showProposal("proposal-1", epoch())],
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("assistant-launcher-badge")).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
