// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useAssistantStore, assistantActions } from "@/lib/ai/assistant/store";
import {
  SCENARIOS,
  cards,
  leave,
  people,
  requirement,
  ward,
} from "@/lib/rules/ward-fixtures.test-support";
import { PREFERENCE_TYPE } from "@/lib/scenario/types";
import { buildFeasibilityReport } from "@/lib/ai/assistant/repair-options";
import type { ScenarioUiState } from "@/lib/scenario";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize/run-view";
import { useFeasibilityTools } from "./use-feasibility-tools";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

// Tools are exercised through their REGISTERED definitions, as in use-optimize-tools.test.
interface CapturedTool {
  name: string;
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
  scenario: null as unknown as ScenarioUiState,
}));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, pickScenario: () => fixture.scenario };
});

const TURN = 7;
let boundTurn: TestTurnHandle;

function Host() {
  useFeasibilityTools("scheduler:thread-1", TURN);
  return null;
}

function tool(name: string): CapturedTool {
  const found = captured.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool "${name}" was never registered`);
  return found;
}

beforeEach(() => {
  captured.length = 0;
  fixture.scenario = SCENARIOS.onlyRnOnLeave();
  useAssistantStore.setState({ turnEpoch: TURN });
  boundTurn = bindTurnForTest({ turnEpoch: TURN });
  render(<Host />);
});

afterEach(() => {
  useHotStore.getState().resetRunView();
  boundTurn.release();
  cleanup();
  assistantActions.resetForTest();
});

describe("suggest_feasibility_options", () => {
  it("returns the same report buildFeasibilityReport computes for the live scenario", async () => {
    const answer = await tool("suggest_feasibility_options").handler(
      { afterInfeasibleRun: true },
      {},
    );
    expect(answer).toEqual(buildFeasibilityReport(fixture.scenario, true));
  });
});

describe("afterInfeasibleRun comes from the run the host shows, not the model", () => {
  // No certain gap, one hard request: options appear only after an infeasible run.
  const unexplained = (): ScenarioUiState => ({
    ...SCENARIOS.restRuleTooTight(),
    reqData: [
      {
        uid: "never-ana",
        person: "ana",
        date: "03",
        kind: "request",
        shiftType: "N",
        weight: -Infinity,
      },
    ],
  });

  it("uses the infeasible run view even when the model says false", async () => {
    fixture.scenario = unexplained();
    useHotStore.getState().setRunView({
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "completed",
      outcome: "infeasible",
    });
    const answer = await tool("suggest_feasibility_options").handler(
      { afterInfeasibleRun: false },
      {},
    );
    expect(answer).toEqual(buildFeasibilityReport(fixture.scenario, true));
    expect(answer).not.toEqual(buildFeasibilityReport(fixture.scenario, false));
  });

  it("passes the run's proven core, so a leave day the solver names gets a leave repair (msnp)", async () => {
    // No static gap: 2 a day from 3 nurses. Only the core names cara's leave on the 5th.
    fixture.scenario = ward({
      staff: people("ana", "ben", "cara"),
      reqData: [leave("cara", "05")],
      cardsByKind: cards({
        requirements: [requirement("day", "D", 1), requirement("night", "N", 1)],
      }),
    });
    useHotStore.getState().setRunView({
      ...INITIAL_OPTIMIZE_RUN_VIEW,
      lifecycle: "completed",
      outcome: "infeasible",
      result: {
        outcome: "infeasible",
        score: null,
        solverStatus: "INFEASIBLE",
        terminationReason: null,
        explanation: {
          kind: "infeasible",
          proof: "main_run",
          core: {
            members: [{ rule: 0, kind: "leave", nurse: "P3", date: "2026-11-05" }],
            minimal: true,
            solves: 1,
            guards: 1,
            seconds: 0.1,
          },
        },
      },
      explainContext: {
        sources: [
          {
            ruleId: "leave-cara-05",
            type: PREFERENCE_TYPE.shiftRequest,
            label: "cara",
            hard: true,
          },
        ],
        people: [["P3", "cara"]],
      },
    });
    // The core names her through the anonymised id the run submitted.
    const answer = (await tool("suggest_feasibility_options").handler(
      { afterInfeasibleRun: true },
      {},
    )) as ReturnType<typeof buildFeasibilityReport>;
    expect(answer.options.map((o) => o.repairId)).toContain("ask_nurse_on_leave");
    expect(answer.options.find((o) => o.repairId === "ask_nurse_on_leave")?.evidence).toBe(
      "hypothesis",
    );
  });

  it("ignores a model claim of an infeasible run when none is showing", async () => {
    fixture.scenario = unexplained();
    const answer = await tool("suggest_feasibility_options").handler(
      { afterInfeasibleRun: true },
      {},
    );
    expect(answer).toEqual(buildFeasibilityReport(fixture.scenario, false));
  });
});
