import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, spyOn, waitFor } from "storybook/test";
import { persistThreadMessages, selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY, TEST_MODEL } from "@/lib/ai/assistant/test-support";
import { useAuthorityStore } from "@/lib/store";
import { jsonResponse, withFetchRoutes } from "../../.storybook/story-helpers";
import { AssistantCopilotProvider } from "./assistant-copilot-provider";
import { AssistantPanel } from "./assistant-panel";
import { withAssistant } from "./assistant-story-harness.test-support";

// The panel under the same provider AssistantSurface mounts, with the runtime handshake
// answered by the fetch router (assistant-panel.test.tsx `installFetch`).
const RUNTIME_INFO = {
  agents: { scheduler: { description: "Scheduler" } },
  mode: "sse",
  runtimeInstanceId: "instance-1",
  telemetryDisabled: true,
};

/** Two stored messages on the scenario's active thread: restored history, no run. */
async function seedHistory() {
  const scenarioId = useAuthorityStore.getState().scenarioId!;
  const thread = await selectActiveThread(scenarioId);
  await persistThreadMessages(
    [
      { id: "m1", role: "user", content: "Why is the 15th short?" },
      { id: "m2", role: "assistant", content: "Two nurses are on leave that day." },
    ],
    {
      threadId: thread.threadId,
      scenarioId,
      modelId: TEST_MODEL,
      turnId: null,
      globalGeneration: 0,
      scenarioGeneration: 0,
      createdAt: new Date().toISOString(),
    },
  );
}

const meta = {
  title: "AI/AssistantPanel",
  component: AssistantPanel,
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/shift-requests" } },
  },
  decorators: [
    (Story) => (
      <AssistantCopilotProvider runtimeUrl="/api/copilotkit" headers={() => ({})}>
        <div className="flex h-[640px]">
          <div className="flex-1" />
          <Story />
        </div>
      </AssistantCopilotProvider>
    ),
  ],
  beforeEach: [
    withAssistant(),
    withFetchRoutes([["/api/copilotkit", () => jsonResponse(200, RUNTIME_INFO)]]),
    () => assistantActions.openPanel(),
  ],
} satisfies Meta<typeof AssistantPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Dock: Story = {
  play: async ({ canvas }) => {
    const dock = await canvas.findByTestId("assistant-dock");
    await expect(dock).toHaveAttribute("aria-label", "Schedule assistant");
    await expect(canvas.getByTestId("assistant-panel-subtitle")).toHaveTextContent(TEST_MODEL);
    await expect(await canvas.findByTestId("assistant-live-conversation")).toBeVisible();
  },
};

export const Sheet: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvas }) => {
    const sheet = await canvas.findByTestId("assistant-sheet");
    await expect(sheet.querySelector('[role="dialog"]')).toHaveAttribute("aria-modal", "true");
    await expect(canvas.queryByTestId("assistant-dock")).toBeNull();
  },
};

export const Close: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByTestId("assistant-close"));
    await expect(useAssistantStore.getState().panelOpen).toBe(false);
  },
};

// A thread with messages offers its transcript as a download (the Blob URL is spied).
export const Transcript: Story = {
  beforeEach: [
    seedHistory,
    () => {
      const create = spyOn(URL, "createObjectURL").mockImplementation(fn(() => "blob:story"));
      return () => create.mockRestore();
    },
  ],
  play: async ({ canvas, userEvent }) => {
    await waitFor(() =>
      expect(canvas.getByTestId("assistant-live-conversation")).toHaveTextContent(
        "Two nurses are on leave that day.",
      ),
    );
    await userEvent.click(await canvas.findByTestId("assistant-download-transcript"));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("assistant-dock")).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
