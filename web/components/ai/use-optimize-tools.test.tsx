// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useOptimizeTools } from "./use-optimize-tools";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

// Tools are exercised through their REGISTERED definitions, as in use-help-tools.test:
// what matters is the object the model is offered and what its handler answers.
interface CapturedTool {
  name: string;
  description: string;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}
const captured: CapturedTool[] = [];
vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (definition: CapturedTool) => {
    if (!captured.some((tool) => tool.name === definition.name)) captured.push(definition);
  },
  useCopilotKit: () => ({ copilotkit: SCOPE }),
}));
const SCOPE = {};

const fixture = vi.hoisted(() => ({
  scenario: null as unknown,
  isOwner: true,
  capture: "idle",
}));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    pickScenario: () => fixture.scenario,
    readAuthoritativeScenarioOwnership: async () => ({
      isOwner: fixture.isOwner,
      documentRevision: 1,
    }),
  };
});
vi.mock("@/lib/optimize/roster-capture-app", () => ({
  getRosterCaptureGate: () => ({ getState: () => ({ status: fixture.capture }) }),
}));

const TURN = 7;
let boundTurn: TestTurnHandle;

function readyScenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-10-01",
    rangeEnd: "2026-10-14",
    staff: [{ id: "p1" }] as ScenarioUiState["staff"],
    shifts: [{ id: "D" }] as ScenarioUiState["shifts"],
    ...overrides,
  };
}

function view(overrides: Partial<OptimizeRunView>): OptimizeRunView {
  return { ...INITIAL_OPTIMIZE_RUN_VIEW, ...overrides };
}

function Host() {
  useOptimizeTools("scheduler:thread-1", TURN);
  return null;
}

function tool(name: string): CapturedTool {
  const found = captured.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool "${name}" was never registered`);
  return found;
}

beforeEach(() => {
  captured.length = 0;
  fixture.scenario = readyScenario();
  fixture.isOwner = true;
  fixture.capture = "idle";
  useAssistantStore.setState({ turnEpoch: TURN });
  useRunRequestStore.setState({ pending: null, last: null });
  useHotStore.getState().resetRunView();
  boundTurn = bindTurnForTest({ turnEpoch: TURN });
  render(<Host />);
});

afterEach(() => {
  boundTurn.release();
  cleanup();
  assistantActions.resetForTest();
  useHotStore.getState().resetRunView();
});

describe("the optimiser tools", () => {
  it("registers exactly the two tools", () => {
    expect(captured.map((t) => t.name).sort()).toEqual([
      "get_optimize_result",
      "request_optimize_run",
    ]);
  });
});

describe("request_optimize_run", () => {
  it("shows a card stamped with the turn and starts nothing", async () => {
    const answer = await tool("request_optimize_run").handler({}, {});
    expect(answer).toMatch(/Nothing has started/);
    // dt9: "I've set up the run card" read as a claim of work done.
    expect(answer).toMatch(/never that you set it up/);
    expect(useAssistantStore.getState().activeRunRequest).toEqual({ turnEpoch: TURN });
    expect(useRunRequestStore.getState().pending).toBeNull();
  });

  it("refuses and names what is missing when set-up is incomplete", async () => {
    fixture.scenario = readyScenario({ staff: [] });
    const answer = await tool("request_optimize_run").handler({}, {});
    expect(answer).toMatch(/Staff/);
    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
  });

  it("refuses in a tab that does not hold the schedule", async () => {
    fixture.isOwner = false;
    const answer = await tool("request_optimize_run").handler({}, {});
    expect(answer).toMatch(/another tab/);
    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
  });

  it("refuses a second run while one is live", async () => {
    useHotStore.getState().setRunView(view({ lifecycle: "running", jobId: "opt_1" }));
    const answer = await tool("request_optimize_run").handler({}, {});
    expect(answer).toMatch(/already going/);
    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
  });
});

describe("get_optimize_result", () => {
  it("reports an idle screen and how to get a run", async () => {
    const summary = (await tool("get_optimize_result").handler({}, {})) as {
      status: string;
      guidance: string;
    };
    expect(summary.status).toBe("idle");
    expect(summary.guidance).toMatch(/request_optimize_run/);
    expect(summary.guidance).toMatch(/leaving it stops the run/);
  });

  it("says why a requested run did not start", async () => {
    useRunRequestStore.setState({ last: "backend-offline" });
    const summary = (await tool("get_optimize_result").handler({}, {})) as { guidance: string };
    expect(summary.guidance).toMatch(/not reachable/);
  });

  it("says when the Optimise screen stopped a requested run before sending it", async () => {
    useRunRequestStore.setState({ last: "blocked" });
    const summary = (await tool("get_optimize_result").handler({}, {})) as { guidance: string };
    expect(summary.guidance).toMatch(/did not start: the Optimise screen stopped it/);
  });

  it("says when a requested run expired before the screen could take it", async () => {
    useRunRequestStore.setState({ last: "expired" });
    const summary = (await tool("get_optimize_result").handler({}, {})) as { guidance: string };
    expect(summary.guidance).toMatch(/did not start: it waited too long/);
  });

  it("tells the model a live run has no result yet", async () => {
    useHotStore
      .getState()
      .setRunView(view({ lifecycle: "queued", jobId: "opt_1", queuePosition: 2 }));
    const summary = (await tool("get_optimize_result").handler({}, {})) as {
      queuePosition: number;
      guidance: string;
    };
    expect(summary.queuePosition).toBe(2);
    expect(summary.guidance).toMatch(/still going/);
  });

  it("points an infeasible run at the feasibility options, then the bounded diagnostic", async () => {
    useHotStore.getState().setRunView(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        outcome: "infeasible",
        result: {
          outcome: "infeasible",
          score: null,
          solverStatus: "INFEASIBLE",
          terminationReason: null,
        },
      }),
    );
    const summary = (await tool("get_optimize_result").handler({}, {})) as {
      heading: string;
      guidance: string;
    };
    expect(summary.heading).toBe("This roster can't be built");
    // WIDENED DELIBERATELY (2026-09-24, plan assistant-guided-setup-and-repair): the static
    // staffing check is deterministic evidence, so a CERTAIN gap may be named; nothing else may.
    expect(summary.guidance).toMatch(/suggest_feasibility_options/);
    expect(summary.guidance).toMatch(/test_feasibility_candidates/);
    expect(summary.guidance).toMatch(/only when it reports a certain gap/);
    expect(summary.guidance).not.toMatch(/never name a cause/);
  });

  it("reports a saved roster for a solved run", async () => {
    fixture.capture = "committed";
    useHotStore.getState().setRunView(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        outcome: "optimal",
        result: {
          outcome: "optimal",
          score: 42,
          solverStatus: "OPTIMAL",
          terminationReason: "optimality_proven",
        },
      }),
    );
    const summary = (await tool("get_optimize_result").handler({}, {})) as {
      rosterSaved: boolean;
      score: number;
      guidance: string;
    };
    expect(summary.rosterSaved).toBe(true);
    expect(summary.score).toBe(42);
    expect(summary.guidance).toMatch(/Open & adjust roster/);
  });
});
