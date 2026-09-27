import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { openDiagnosticSearch } from "@/lib/ai/diagnostic";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { useModeStore } from "@/lib/mode/mode";
import { proposalScenario } from "@/lib/proposal/test-support";
import { assistantProposalCommands } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import { jsonResponse, withFetchRoutes } from "../../.storybook/story-helpers";
import { CardDockContext, DockedComposer } from "./assistant-card-dock";
import { AssistantCopilotProvider } from "./assistant-copilot-provider";
import { withAssistant } from "./assistant-story-harness.test-support";
import { useAssistantProposals } from "./use-assistant-proposals";

// The composer slot: whichever card is up docks above the library composer. Mounted
// under the same provider the panel uses; one story per card kind the dock routes to.
const RUNTIME_INFO = {
  agents: { scheduler: { description: "Scheduler" } },
  mode: "sse",
  runtimeInstanceId: "instance-1",
  telemetryDisabled: true,
};
const onSend = fn();
const epoch = () => useAssistantStore.getState().turnEpoch;

function Dock() {
  const proposals = useAssistantProposals();
  return (
    <CardDockContext.Provider value={{ onSend, disabled: false, proposals }}>
      <DockedComposer />
    </CardDockContext.Provider>
  );
}

const meta = {
  title: "AI/AssistantCardDock",
  component: Dock,
  parameters: {
    nextjs: { appDirectory: true, navigation: { pathname: "/dates" } },
    // a11y violation tracked in nursing-sheduler-w0e.34; restore "error" when fixed
    a11y: { test: "todo" },
  },
  decorators: [
    (Story) => (
      <AssistantCopilotProvider runtimeUrl="/api/copilotkit" headers={() => ({})}>
        <div className="w-[420px]">
          <Story />
        </div>
      </AssistantCopilotProvider>
    ),
  ],
  beforeEach: [
    withAssistant(),
    withFetchRoutes([["/api/copilotkit", () => jsonResponse(200, RUNTIME_INFO)]]),
    () => {
      onSend.mockClear();
      useModeStore.setState({ mode: "guided", adoption: "ready" });
    },
  ],
} satisfies Meta<typeof Dock>;

export default meta;
type Story = StoryObj<typeof meta>;

async function dockReady(canvas: { findByTestId: (id: string) => Promise<HTMLElement> }) {
  await expect(await canvas.findByTestId("assistant-card-dock")).toBeVisible();
  const announcer = await canvas.findByTestId("assistant-dock-announcer");
  await expect(announcer).toHaveAttribute("aria-live", "polite");
}

export const Choices: Story = {
  beforeEach: () =>
    assistantActions.showChoices(
      {
        question: "Which Ana?",
        options: [
          { label: "Ana Lim", detail: "" },
          { label: "Ana Tan", detail: "" },
        ],
        multiple: false,
      },
      epoch(),
    ),
  play: async ({ canvas }) => {
    await dockReady(canvas);
    await expect(canvas.getByTestId("assistant-choices")).toBeVisible();
  },
};

export const Diagnostic: Story = {
  beforeEach: () =>
    assistantActions.publishDiagnostic(
      openDiagnosticSearch({
        searchId: "search-1",
        scenarioId: "scenario-1",
        threadId: "thread-1",
        turnId: "turn-1",
        parent: {
          basisId: "p".repeat(64),
          jobId: "job_parent",
          scenarioId: "scenario-1",
          documentRevision: 5,
        },
        turnEpoch: 1,
        leaseEpoch: 1,
        globalGeneration: 0,
        scenarioGeneration: 0,
        compare: false,
        parentExpiresAt: null,
        now: new Date("2026-08-07T12:00:00Z"),
      }),
      epoch(),
    ),
  play: async ({ canvas }) => {
    await dockReady(canvas);
    await expect(canvas.getByTestId("assistant-diagnostic")).toBeVisible();
  },
};

export const RunRequest: Story = {
  beforeEach: () => assistantActions.showRunRequest(epoch()),
  play: async ({ canvas }) => {
    await dockReady(canvas);
    await expect(canvas.getByTestId("assistant-run-request")).toBeVisible();
  },
};

export const RosterChange: Story = {
  // Braced: showRosterChange returns a boolean, which Storybook would call as a cleanup.
  beforeEach: () => {
    assistantActions.showRosterChange(
      {
        request: { solvedBaselineId: "a".repeat(64), cells: [] },
        view: {
          heading: "Swap shifts?",
          stepLabel: "Step 1 · Swap or cover within the ward",
          title: "SN-Priya and SN-Cara, 8 Oct",
          summary: "",
          rows: [],
          leaveRows: [],
          notes: [],
          worthKnowing: [],
          notChecked: [],
          agreement: null,
        },
      },
      epoch(),
    );
  },
  play: async ({ canvas }) => {
    await dockReady(canvas);
    await expect(canvas.getByTestId("assistant-roster-change")).toBeVisible();
  },
};

export const Proposal: Story = {
  beforeEach: async () => {
    await loadScenario(proposalScenario());
    const outcome = await assistantProposalCommands.prepare({
      proposalId: crypto.randomUUID(),
      threadId: "thread-1",
      turnId: "turn-1",
      registryStamp: capabilityRegistryStamp(),
      commands: [
        {
          type: "set_roster_range",
          start: "2026-04-01",
          end: "2026-04-15",
          importPublicHolidays: false,
        },
      ],
      rationale: "Shortening the period is what you asked for.",
      evidence: [{ kind: "user_statement", label: "You said so", reference: null }],
      outcome: "untested",
    });
    if (!outcome.ok) throw new Error("fixture proposal was refused");
    assistantActions.showProposal(outcome.proposal.proposalId, epoch());
  },
  play: async ({ canvas }) => {
    await dockReady(canvas);
    await expect(await canvas.findByTestId("assistant-proposal")).toBeVisible();
  },
};

export const Dark: Story = {
  beforeEach: () => assistantActions.showRunRequest(epoch()),
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await dockReady(canvas);
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
