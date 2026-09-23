// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useAssistantStore, assistantActions } from "@/lib/ai/assistant/store";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import { buildFeasibilityReport } from "@/lib/ai/assistant/repair-options";
import type { ScenarioUiState } from "@/lib/scenario";
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

const fixture = vi.hoisted(() => ({ scenario: null as unknown as ScenarioUiState }));
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
