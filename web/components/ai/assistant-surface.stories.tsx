import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import { assistantActions } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { jsonResponse, withFetchRoutes } from "../../.storybook/story-helpers";
import { withAssistant } from "./assistant-story-harness.test-support";
import { AssistantSurface } from "./assistant-surface";

// The whole assistant mount (covers AssistantCopilotProvider, which draws nothing itself).
// The CopilotKit runtime handshake is answered by the fetch router with the runtime info
// assistant-panel.test.tsx's `installFetch` returns; any other /api/ call fails the story.
const runtime = fn(() =>
  jsonResponse(200, {
    agents: { scheduler: { description: "Scheduler" } },
    mode: "sse",
    runtimeInstanceId: "instance-1",
    telemetryDisabled: true,
  }),
);

const meta = {
  title: "AI/AssistantSurface",
  component: AssistantSurface,
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/shift-requests" } },
  },
  beforeEach: () => runtime.mockClear(),
} satisfies Meta<typeof AssistantSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

// AI is optional: with the assistant off, nothing is drawn and nothing is fetched.
export const NotReady: Story = {
  beforeEach: [withAssistant({ ready: false }), withFetchRoutes([])],
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-testid^="assistant-"]')).toBeNull();
  },
};

export const Ready: Story = {
  beforeEach: [
    withAssistant(),
    withFetchRoutes([["/api/copilotkit", runtime]]),
    () => assistantActions.openPanel(),
  ],
  play: async ({ canvas }) => {
    const dock = await canvas.findByTestId("assistant-dock");
    await waitFor(() => expect(dock).toBeVisible());
    // The provider handshakes with the runtime (so the check below is not vacuous)...
    await waitFor(() => expect(runtime).toHaveBeenCalled());
    // ...and every request the mounted assistant made went to that runtime.
    const paths = (globalThis.fetch as unknown as ReturnType<typeof fn>).mock.calls.map(
      ([input]) => new URL(String(input), location.origin).pathname,
    );
    await expect(paths.every((path) => path.startsWith("/api/copilotkit"))).toBe(true);
  },
};

export const Dark: Story = {
  beforeEach: [
    withAssistant(),
    withFetchRoutes([["/api/copilotkit", runtime]]),
    () => assistantActions.openPanel(),
  ],
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("assistant-dock")).toBeInTheDocument();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
