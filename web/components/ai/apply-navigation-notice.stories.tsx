import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, waitFor } from "storybook/test";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { useModeStore } from "@/lib/mode/mode";
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize";
import type { AssistantCommandV1 } from "@/lib/proposal";
import { proposalScenario } from "@/lib/proposal/test-support";
import { assistantProposalCommands, useHotStore } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import { withFetchRoutes } from "../../.storybook/story-helpers";
import { ApplyNavigationNotice, describeStep } from "./apply-navigation-notice";
import { withAssistant } from "./assistant-story-harness.test-support";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { useAssistantProposals } from "./use-assistant-proposals";

// The notice follows a REAL Apply: each play applies a prepared Preview (shortening the
// roster period, which lands on Dates and on Requests & Leave), then the notice walks the
// user to the change. The story sits on /people. The Storybook router records the push
// but the page never arrives, so an unhindered walk ends "could not be opened".
const SHRINK: AssistantCommandV1[] = [
  { type: "set_roster_range", start: "2026-04-01", end: "2026-04-15", importPublicHolidays: false },
];

async function prepare() {
  const outcome = await assistantProposalCommands.prepare({
    proposalId: crypto.randomUUID(),
    threadId: "thread-1",
    turnId: "turn-1",
    registryStamp: capabilityRegistryStamp(),
    commands: SHRINK,
    rationale: "Shortening the period is what you asked for.",
    evidence: [{ kind: "user_statement", label: "You said so", reference: null }],
    outcome: "untested",
  });
  if (!outcome.ok) throw new Error("fixture proposal was refused");
  assistantActions.showProposal(
    outcome.proposal.proposalId,
    useAssistantStore.getState().turnEpoch,
  );
}

function Host() {
  const controller = useAssistantProposals();
  return (
    <>
      <ProposalPreviewCard controller={controller} onSend={() => {}} disabled={false} />
      <ApplyNavigationNotice controller={controller} />
    </>
  );
}

const DATES = { capabilityId: "roster-period", directCount: 1, keys: [], announcement: "" };
const named = (status: Parameters<typeof describeStep>[0]["status"]) =>
  describeStep({ screen: DATES, name: "Dates", status });

const meta = {
  title: "AI/ApplyNavigationNotice",
  component: Host,
  parameters: { nextjs: { appDirectory: true, navigation: { pathname: "/people" } } },
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
      useHotStore.getState().resetRunView();
      await loadScenario(proposalScenario());
      await prepare();
      return () => useHotStore.getState().resetRunView();
    },
  ],
} satisfies Meta<typeof Host>;

export default meta;
type Story = StoryObj<typeof meta>;

async function apply(canvas: { findByTestId: (id: string) => Promise<HTMLElement> }) {
  (await canvas.findByTestId("proposal-apply")).click();
  return canvas.findByTestId("apply-navigation");
}

export const Opening: Story = {
  play: async ({ canvas }) => {
    await apply(canvas);
    await expect(await canvas.findByTestId("apply-navigation-step")).toHaveTextContent(
      /^Opening Dates…|could not be opened/,
    );
    await waitFor(() => expect(getRouter().push).toHaveBeenCalledWith("/dates"));
  },
};

export const Failed: Story = {
  play: async ({ canvas }) => {
    await apply(canvas);
    await waitFor(
      () =>
        expect(canvas.getByTestId("apply-navigation-step")).toHaveTextContent(
          "Dates could not be opened.",
        ),
      { timeout: 5000 },
    );
  },
};

// An open draft stages the shell's confirm; choosing Stay keeps the user here.
export const Stayed: Story = {
  beforeEach: () =>
    useNavGuardStore.getState().registerDraft({ id: "story-draft", label: "Story draft" }),
  play: async ({ canvas }) => {
    await apply(canvas);
    await waitFor(() => expect(useNavGuardStore.getState().open).toBe(true));
    useNavGuardStore.getState().cancel();
    await waitFor(() =>
      expect(canvas.getByTestId("apply-navigation-step")).toHaveTextContent(
        named("stayed").split(".")[0]!,
      ),
    );
    await expect(getRouter().push).not.toHaveBeenCalled();
  },
};

// A live optimiser run is never left by the host on the user's behalf.
export const RunLive: Story = {
  parameters: {
    nextjs: { appDirectory: true, navigation: { pathname: "/optimize-and-export" } },
  },
  beforeEach: () =>
    useHotStore
      .getState()
      .setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "running", jobId: "opt_1" }),
  play: async ({ canvas }) => {
    await apply(canvas);
    await expect(await canvas.findByTestId("apply-navigation-step")).toHaveTextContent(
      "Stayed here so the optimiser run keeps going.",
    );
    await expect(getRouter().push).not.toHaveBeenCalled();
  },
};

export const LinkAndDone: Story = {
  play: async ({ canvas, userEvent }) => {
    await apply(canvas);
    const link = (await canvas.findAllByTestId("apply-navigation-link"))[0]!;
    await userEvent.click(link);
    await waitFor(() => expect(getRouter().push).toHaveBeenCalledTimes(2));
    await userEvent.click(canvas.getByTestId("apply-navigation-done"));
    await expect(canvas.queryByTestId("apply-navigation")).toBeNull();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(await apply(canvas)).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
