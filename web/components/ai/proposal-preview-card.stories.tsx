import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { useModeStore } from "@/lib/mode/mode";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { proposalScenario } from "@/lib/proposal/test-support";
import { assistantProposalCommands, useScenarioStore } from "@/lib/store";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import { loadScenario } from "@/lib/store/lifecycle";
import {
  LONG_PROSE,
  expectNoHorizontalOverflow,
  withFetchRoutes,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { withAssistant } from "./assistant-story-harness.test-support";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { useAssistantProposals } from "./use-assistant-proposals";

// The Preview driven by the REAL repository, adapter and controller, as
// assistant-proposal.test.tsx drives it: a proposal is prepared, then shown.
const SHRINK: AssistantCommandV1[] = [
  { type: "set_roster_range", start: "2026-04-01", end: "2026-04-15", importPublicHolidays: false },
];
const MOVE_LEAVE: AssistantCommandV1[] = [
  { type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" },
];

const prepared =
  (commands: AssistantCommandV1[], rationale = "Shortening the period is what you asked for.") =>
  async () => {
    const outcome = await assistantProposalCommands.prepare({
      proposalId: crypto.randomUUID(),
      threadId: "thread-1",
      turnId: "turn-1",
      registryStamp: capabilityRegistryStamp(),
      commands,
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

/** The card bound to its controller exactly as the panel binds it. */
function Host({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  return (
    <ProposalPreviewCard controller={useAssistantProposals()} onSend={onSend} disabled={disabled} />
  );
}

const meta = {
  title: "AI/ProposalPreviewCard",
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
      // Affected-screen names resolve once the stored mode is adopted (the shell does it).
      useModeStore.setState({ mode: "guided", adoption: "ready" });
      await loadScenario(proposalScenario());
    },
  ],
  args: { onSend: fn(), disabled: false },
} satisfies Meta<typeof Host>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Preview: Story = {
  beforeEach: prepared(SHRINK),
  play: async ({ canvas, userEvent }) => {
    const card = await canvas.findByTestId("assistant-proposal");
    await expect(card).toHaveAttribute("data-status", "preview_ready");
    await expect(canvas.getByTestId("proposal-direct")).toHaveTextContent(
      "2026-04-01 to 2026-04-15",
    );
    await expect(canvas.getByTestId("proposal-cascade")).toHaveTextContent("Removed");
    await expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
    await userEvent.click(canvas.getByTestId("proposal-apply"));
    await waitFor(() => expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-15"));
    await waitFor(() => expect(canvas.queryByTestId("assistant-proposal")).toBeNull());
  },
};

export const Details: Story = {
  beforeEach: prepared(SHRINK),
  play: async ({ canvas, userEvent }) => {
    await canvas.findByTestId("assistant-proposal");
    await expect(canvas.queryByTestId("proposal-needs-review")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Show details" }));
    await expect(await canvas.findByTestId("proposal-needs-review")).toHaveTextContent(
      "Leave and requests",
    );
    await expect(canvas.getByTestId("proposal-screens")).toHaveTextContent(
      "Affects: Requests & Leave, Dates",
    );
    await expect(canvas.getByTestId("proposal-outcome")).toHaveTextContent(
      "Not tested by the optimiser",
    );
  },
};

export const Assumption: Story = {
  beforeEach: prepared(MOVE_LEAVE),
  play: async ({ canvas, userEvent }) => {
    await expect(await canvas.findByTestId("proposal-assumption")).toHaveTextContent(
      "Has ana agreed to move their leave from 2 Apr to 10 Apr?",
    );
    await expect(canvas.getByTestId("proposal-apply")).toBeDisabled();
    await userEvent.click(canvas.getByTestId("assumption-confirm"));
    await waitFor(() => expect(canvas.getByTestId("proposal-apply")).toBeEnabled());
    await userEvent.click(canvas.getByTestId("assumption-withdraw"));
    await waitFor(() => expect(canvas.getByTestId("proposal-apply")).toBeDisabled());
  },
};

// An open editor draft blocks Apply, and the card names it.
export const Blocked: Story = {
  beforeEach: [
    prepared(SHRINK),
    () => useNavGuardStore.getState().registerDraft({ id: "shift-types", label: "Shifts editor" }),
  ],
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("proposal-apply")).toBeDisabled();
    await expect(canvas.getByTestId("proposal-blocks")).toHaveTextContent("Shifts editor");
  },
};

export const Cancel: Story = {
  beforeEach: prepared(SHRINK),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByTestId("proposal-cancel"));
    await waitFor(() => expect(canvas.queryByTestId("assistant-proposal")).toBeNull());
    await expect(useScenarioStore.getState().rangeEnd).toBe("2026-04-30");
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  beforeEach: prepared(SHRINK, LONG_PROSE),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Show details" }));
    await expect(await canvas.findByTestId("proposal-rationale")).toHaveTextContent(LONG_PROSE);
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  beforeEach: prepared(MOVE_LEAVE),
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("assistant-proposal")).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
