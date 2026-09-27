import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import {
  appendSubmittedCandidate,
  closeSearch,
  openDiagnosticSearch,
  settleCandidate,
  type DiagnosticSearchRecordV1,
} from "@/lib/ai/diagnostic";
import {
  registerOwnedDiagnosticJob,
  resetOwnedDiagnosticJobsForTest,
} from "@/lib/ai/diagnostic/diagnostic-canceller";
import type { ProductOutcomeView } from "@/lib/optimize/outcome-mapping";
import { jsonResponse, withFetchRoutes } from "../../.storybook/story-helpers";
import { withAssistant } from "./assistant-story-harness.test-support";
import { DiagnosticSearchCard } from "./diagnostic-search-card";

// Search records built with the diagnostic lib, as assistant-diagnostic.test.tsx builds them.
const NOW = new Date("2026-08-07T12:00:00Z");
const PARENT = "p".repeat(64);
const FEASIBLE: ProductOutcomeView = {
  outcome: "tested-feasible",
  evidence: "feasibility",
  reason: "solved",
};

function searchWith(outcomes: readonly (ProductOutcomeView | null)[]): DiagnosticSearchRecordV1 {
  let search = openDiagnosticSearch({
    searchId: "search-1",
    scenarioId: "scenario-1",
    threadId: "thread-1",
    turnId: "turn-1",
    parent: { basisId: PARENT, jobId: "job_parent", scenarioId: "scenario-1", documentRevision: 5 },
    turnEpoch: 1,
    leaseEpoch: 1,
    globalGeneration: 0,
    scenarioGeneration: 0,
    compare: false,
    parentExpiresAt: null,
    now: NOW,
  });
  outcomes.forEach((outcome, index) => {
    search = appendSubmittedCandidate(
      search,
      {
        candidateId: `cand-${index}`,
        commands: [],
        commandsDigest: `d${index}`,
        transformDigest: `t${index}`,
        rationale: `fewer people needed on late+ (idea ${index})`,
        diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
        basisId: `b${index}`,
        inputSha256: `i${index}`,
        parentBasisId: PARENT,
        now: NOW,
      },
      `job-${index}`,
    );
    if (outcome !== null) search = settleCandidate(search, `cand-${index}`, outcome, NOW);
  });
  return search;
}

const publish = (search: DiagnosticSearchRecordV1) => () => {
  assistantActions.publishDiagnostic(search, useAssistantStore.getState().turnEpoch);
};

const cancelRoute = fn(() => jsonResponse(202, {}));

const meta = {
  title: "AI/DiagnosticSearchCard",
  component: DiagnosticSearchCard,
  // a11y violation tracked in nursing-sheduler-w0e.31; restore "error" when fixed
  parameters: { a11y: { test: "todo" } },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
  beforeEach: [
    withAssistant(),
    withFetchRoutes([["/api/optimize/job-0/cancel", cancelRoute]]),
    () => {
      cancelRoute.mockClear();
      resetOwnedDiagnosticJobsForTest();
      return () => resetOwnedDiagnosticJobsForTest();
    },
  ],
} satisfies Meta<typeof DiagnosticSearchCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  beforeEach: publish(searchWith([null])),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("diagnostic-running")).toBeVisible();
    await expect(canvas.getByTestId("diagnostic-cancel")).toBeVisible();
  },
};

export const Settled: Story = {
  beforeEach: publish(closeSearch(searchWith([FEASIBLE, FEASIBLE]), "first_feasible", null, NOW)),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("diagnostic-settled")).toHaveTextContent("Finished");
    await expect(canvas.getAllByTestId("diagnostic-candidate")).toHaveLength(2);
    await expect(canvas.getByTestId("diagnostic-summary")).toBeVisible();
    await expect(canvas.queryByTestId("diagnostic-cancel")).toBeNull();
  },
};

export const Capacity: Story = {
  beforeEach: publish(searchWith([null])),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("diagnostic-capacity")).toHaveTextContent(/reserved slot/i);
  },
};

// Cancel asks the backend to stop every diagnostic job this tab owns.
export const Cancel: Story = {
  beforeEach: [
    publish(searchWith([null])),
    () =>
      registerOwnedDiagnosticJob({
        jobId: "job-0",
        threadId: "thread-1",
        scenarioId: "scenario-1",
        turnEpoch: useAssistantStore.getState().turnEpoch,
      }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("diagnostic-cancel"));
    await waitFor(() => expect(cancelRoute).toHaveBeenCalledOnce());
  },
};

export const Dark: Story = {
  beforeEach: publish(closeSearch(searchWith([FEASIBLE]), "first_feasible", null, NOW)),
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-diagnostic")).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
