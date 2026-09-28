import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor } from "storybook/test";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { useModeStore } from "@/lib/mode/mode";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { proposalScenario } from "@/lib/proposal/test-support";
import { assistantProposalCommands, useScenarioStore } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import {
  LONG_PROSE,
  expectNoHorizontalOverflow,
  withFetchRoutes,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { withAssistant } from "./assistant-story-harness.test-support";
import { AssistantReceipts } from "./assistant-receipts";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { useAssistantProposals } from "./use-assistant-proposals";

// A receipt exists only after a real durable Apply, so each play applies a prepared
// Preview first (assistant-proposal.test.tsx "Apply"), then works the receipt bar.
const SHRINK: AssistantCommandV1[] = [
  { type: "set_roster_range", start: "2026-04-01", end: "2026-04-15", importPublicHolidays: false },
];

const prepared =
  (rationale = "Shortening the period is what you asked for.") =>
  async () => {
    const outcome = await assistantProposalCommands.prepare({
      proposalId: crypto.randomUUID(),
      threadId: "thread-1",
      turnId: "turn-1",
      registryStamp: capabilityRegistryStamp(),
      commands: SHRINK,
      rationale,
      evidence: [{ kind: "user_statement", label: "You said so", reference: null }],
      outcome: "untested",
    });
    if (!outcome.ok) throw new Error("fixture proposal was refused");
    assistantActions.showProposal(
      outcome.proposal.proposalId,
      useAssistantStore.getState().turnEpoch,
    );
  };

/** Both host surfaces bound to one controller, exactly as the panel binds them. */
function Host() {
  const controller = useAssistantProposals();
  return (
    <>
      <ProposalPreviewCard controller={controller} onSend={() => {}} disabled={false} />
      <AssistantReceipts controller={controller} />
    </>
  );
}

const meta = {
  title: "AI/AssistantReceipts",
  component: Host,
  parameters: { nextjs: { appDirectory: true, navigation: { pathname: "/dates" } } },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
  beforeEach: [
    withAssistant(),
    withFetchRoutes([]),
    async () => {
      useModeStore.setState({ mode: "guided", adoption: "ready" });
      await loadScenario(proposalScenario());
    },
    prepared(),
  ],
} satisfies Meta<typeof Host>;

export default meta;
type Story = StoryObj<typeof meta>;

async function apply(canvas: { findByTestId: (id: string) => Promise<HTMLElement> }) {
  const button = await canvas.findByTestId("proposal-apply");
  button.click();
  return canvas.findByTestId("assistant-receipts");
}

export const Collapsed: Story = {
  play: async ({ canvas }) => {
    await expect(await apply(canvas)).toHaveTextContent("1 change applied");
    await expect(await canvas.findByTestId("receipt-undo")).toBeVisible();
  },
};

export const Expanded: Story = {
  play: async ({ canvas, userEvent }) => {
    await apply(canvas);
    await userEvent.click(canvas.getByTestId("assistant-receipts-toggle"));
    await expect(await canvas.findByTestId("assistant-receipts-list")).toBeVisible();
    // Expanded, Undo lives in the receipt's own detail.
    await userEvent.click(await canvas.findByTestId("receipt-row-toggle"));
    await userEvent.click(await canvas.findByTestId("receipt-undo"));
    await waitFor(() => expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30"));
  },
};

// Once undone, the receipt stays with an honest reason instead of an Undo.
export const UndoUnavailable: Story = {
  play: async ({ canvas, userEvent }) => {
    await apply(canvas);
    await userEvent.click(await canvas.findByTestId("receipt-undo"));
    await waitFor(() => expect(canvas.queryByTestId("receipt-undo")).toBeNull());
    await userEvent.click(canvas.getByTestId("assistant-receipts-toggle"));
    await userEvent.click(await canvas.findByTestId("receipt-row-toggle"));
    await expect(await canvas.findByTestId("assistant-receipt")).not.toHaveAttribute(
      "data-undo",
      "available",
    );
    await expect(canvas.getByTestId("receipt-undo-reason")).toBeVisible();
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  beforeEach: prepared(LONG_PROSE),
  play: async ({ canvas, userEvent }) => {
    await apply(canvas);
    await userEvent.click(canvas.getByTestId("assistant-receipts-toggle"));
    await userEvent.click(await canvas.findByTestId("receipt-row-toggle"));
    await canvas.findByTestId("assistant-receipt");
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(await apply(canvas)).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
