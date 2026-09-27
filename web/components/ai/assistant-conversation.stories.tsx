import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState } from "react";
import { expect, fn, waitFor } from "storybook/test";
import { persistThreadMessages, selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY, TEST_MODEL } from "@/lib/ai/assistant/test-support";
import { useAuthorityStore } from "@/lib/store";
import { jsonResponse, withFetchRoutes } from "../../.storybook/story-helpers";
import {
  AssistantActivityStatus,
  AssistantHistoricalConversation,
  AssistantLiveConversation,
  CompactionNotice,
  LifecycleNotice,
  RefusalNotice,
} from "./assistant-conversation";
import { AssistantCopilotProvider } from "./assistant-copilot-provider";
import { withAssistant } from "./assistant-story-harness.test-support";

// The conversation module's renderings and notices, under the provider the panel mounts.
// The thread is the scenario's active one, resolved after mount as the panel does.
const RUNTIME_INFO = {
  agents: { scheduler: { description: "Scheduler" } },
  mode: "sse",
  runtimeInstanceId: "instance-1",
  telemetryDisabled: true,
};

function useThreadId(): string | null {
  const scenarioId = useAuthorityStore((state) => state.scenarioId);
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (scenarioId) void selectActiveThread(scenarioId).then((t) => setThreadId(t.threadId));
  }, [scenarioId]);
  return threadId;
}

function Live() {
  const threadId = useThreadId();
  return threadId ? (
    <AssistantLiveConversation threadId={threadId} routePath="/dates" routeLabel="Dates" />
  ) : null;
}

function Historical() {
  const threadId = useThreadId();
  return threadId ? (
    <AssistantHistoricalConversation
      threadId={threadId}
      reason="This schedule is being edited in another tab, so this conversation is read-only."
    />
  ) : null;
}

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
  title: "AI/AssistantConversation",
  parameters: { nextjs: { appDirectory: true, navigation: { pathname: "/dates" } } },
  decorators: [
    (Story) => (
      <AssistantCopilotProvider runtimeUrl="/api/copilotkit" headers={() => ({})}>
        <div className="flex h-[560px] w-[420px] flex-col">
          <Story />
        </div>
      </AssistantCopilotProvider>
    ),
  ],
  beforeEach: [
    withAssistant(),
    withFetchRoutes([["/api/copilotkit", () => jsonResponse(200, RUNTIME_INFO)]]),
  ],
  render: () => <Live />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Welcome: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("assistant-live-conversation")).toBeVisible();
    await expect(canvas.getByTestId("assistant-welcome")).toHaveTextContent(
      /nothing changes until you say so/i,
    );
  },
};

export const HistoricalThread: Story = {
  beforeEach: seedHistory,
  render: () => <Historical />,
  play: async ({ canvas }) => {
    const history = await canvas.findByTestId("assistant-historical-conversation");
    await waitFor(() => expect(history).toHaveTextContent("Two nurses are on leave that day."));
    await expect(history).toHaveTextContent("read-only");
  },
};

export const Refusal: Story = {
  beforeEach: () => {
    useAssistantStore.setState({ lastRefusal: "busy" });
  },
  render: () => <RefusalNotice />,
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-refusal")).toBeVisible();
  },
};

const onRetry = fn();

export const Lifecycle: Story = {
  beforeEach: () => {
    onRetry.mockClear();
    useAssistantStore.setState({ lastSettlement: { trigger: null, settlement: "run_failed" } });
  },
  render: () => <LifecycleNotice onRetry={onRetry} />,
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByTestId("assistant-settlement")).toHaveAttribute(
      "data-settlement",
      "run_failed",
    );
    await userEvent.click(canvas.getByTestId("assistant-retry"));
    await expect(onRetry).toHaveBeenCalledOnce();
  },
};

export const Compacted: Story = {
  render: () => <CompactionNotice show />,
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-compacted")).toBeVisible();
  },
};

export const Activity: Story = {
  render: () => <AssistantActivityStatus activity={{ kind: "tool", name: "get_roster" }} />,
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-activity")).toHaveTextContent("Reading the roster…");
  },
};

// The composer's file input is `hidden` (the add menu clicks it), so the story sets its
// files and fires the change the browser would.
function attach(input: HTMLElement, file: File) {
  const data = new DataTransfer();
  data.items.add(file);
  (input as HTMLInputElement).files = data.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// A text file queues with the privacy note (assistant-composer-attachments.test.tsx).
export const Attachment: Story = {
  play: async ({ canvas }) => {
    await canvas.findByTestId("assistant-live-conversation");
    attach(
      canvas.getByTestId("assistant-file-input"),
      new File(["Ana,leave"], "leave.csv", { type: "text/csv" }),
    );
    await expect(await canvas.findByTestId("assistant-attach-privacy")).toHaveTextContent(
      "Attachments go to OpenRouter with your message",
    );
  },
};

// An image is refused, with the reason, while the model's image support is unknown.
export const AttachmentRefused: Story = {
  play: async ({ canvas }) => {
    await canvas.findByTestId("assistant-live-conversation");
    attach(
      canvas.getByTestId("assistant-file-input"),
      new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "ward.png", {
        type: "image/png",
      }),
    );
    await expect(await canvas.findByTestId("assistant-attach-error")).toHaveTextContent(
      /^This model cannot read images\./,
    );
  },
};

export const Dark: Story = {
  beforeEach: seedHistory,
  render: () => <Historical />,
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    const history = await canvas.findByTestId("assistant-historical-conversation");
    await waitFor(() => expect(history).toHaveTextContent("Why is the 15th short?"));
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
