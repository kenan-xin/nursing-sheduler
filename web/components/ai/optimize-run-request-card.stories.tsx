import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, waitFor } from "storybook/test";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { useModeStore } from "@/lib/mode/mode";
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize";
import { useHotStore } from "@/lib/store";
import { withFetchRoutes } from "../../.storybook/story-helpers";
import { withAssistant } from "./assistant-story-harness.test-support";
import { OptimizeRunRequestCard } from "./optimize-run-request-card";

// The run offer, seeded through the store as optimize-run-request-card.test.tsx does.
// Run navigates through the shell's guarded push. Failed leaves the mode unadopted (as
// before the shell mounts), so the Optimise screen cannot be resolved and nothing is pushed.
const offer = () => assistantActions.showRunRequest(useAssistantStore.getState().turnEpoch);

const navigatedTo = () =>
  [...getRouter().push.mock.calls, ...getRouter().replace.mock.calls].map((call) => call[0]);

const meta = {
  title: "AI/OptimizeRunRequestCard",
  component: OptimizeRunRequestCard,
  parameters: { nextjs: { appDirectory: true, navigation: { pathname: "/rules" } } },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
  beforeEach: [
    withAssistant(),
    withFetchRoutes([]),
    () => {
      useHotStore.getState().resetRunView();
      return () => useHotStore.getState().resetRunView();
    },
  ],
} satisfies Meta<typeof OptimizeRunRequestCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// The shell adopts the stored mode after mount; with no shell here, the story does it.
export const Offered: Story = {
  beforeEach: [offer, () => useModeStore.getState().markAdopted()],
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByTestId("assistant-run-request")).toHaveAttribute(
      "data-status",
      "live",
    );
    await userEvent.click(canvas.getByTestId("run-request-run"));
    await waitFor(() => expect(navigatedTo()).toContain("/optimize-and-export"));
  },
};

export const Dismiss: Story = {
  beforeEach: offer,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("run-request-dismiss"));
    await expect(useAssistantStore.getState().activeRunRequest).toBeNull();
    await expect(navigatedTo()).toEqual([]);
  },
};

export const Live: Story = {
  beforeEach: [
    offer,
    () =>
      useHotStore
        .getState()
        .setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "running", jobId: "opt_1" }),
  ],
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("run-request-live")).toBeVisible();
    await expect(canvas.getByTestId("run-request-run")).toBeDisabled();
  },
};

export const Failed: Story = {
  beforeEach: offer,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("run-request-run"));
    await expect(
      await canvas.findByTestId("run-request-failed", {}, { timeout: 5000 }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  beforeEach: offer,
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-run-request")).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
