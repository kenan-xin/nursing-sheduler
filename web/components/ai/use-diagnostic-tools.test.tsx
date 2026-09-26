// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useDiagnosticTools } from "./use-diagnostic-tools";
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
  useCopilotKit: () => ({ copilotkit: {} }),
}));

const fixture = vi.hoisted(() => ({
  scenario: null as unknown as ScenarioUiState,
  identity: vi.fn(async () => null),
}));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    pickScenario: () => fixture.scenario,
    readAuthoritativeScenarioIdentity: fixture.identity,
  };
});

const TURN = 7;
let boundTurn: TestTurnHandle;

function Host() {
  useDiagnosticTools("scheduler:thread-1", TURN);
  return null;
}

const handler = () => captured.find((t) => t.name === "test_feasibility_candidates")!.handler;

beforeEach(() => {
  captured.length = 0;
  fixture.identity.mockClear();
  fixture.scenario = SCENARIOS.restRuleTooTight();
  useAssistantStore.setState({ turnEpoch: TURN });
  boundTurn = bindTurnForTest({ turnEpoch: TURN });
  render(<Host />);
});
afterEach(() => {
  boundTurn.release();
  cleanup();
  assistantActions.resetForTest();
});

describe("test_feasibility_candidates enforces the safety floor", () => {
  it("tests nothing when a candidate deletes a rest rule, and says which floor it breaks", async () => {
    // Rest rules are guidance: softening or turning one off may be tested; deleting may not.
    const answer = await handler()(
      {
        compare: false,
        candidates: [
          {
            summary: "Maybe the rest rule is too tight.",
            operations: [
              { type: "remove_rule", ruleKind: "successions", ruleId: "no-double-night" },
            ],
          },
        ],
      },
      {},
    );
    expect(answer).toMatch(/Candidate 1/);
    expect(answer).toMatch(/rest rule/);
    expect(answer).toMatch(/Nothing was tested/);
    expect(fixture.identity).not.toHaveBeenCalled();
  });

  it("lets a safe candidate through to the normal search path", async () => {
    const answer = await handler()(
      {
        compare: false,
        candidates: [
          {
            summary: "A third nurse.",
            operations: [{ type: "add_person", name: "Borrowed nurse 1", groups: [] }],
          },
        ],
      },
      {},
    );
    expect(fixture.identity).toHaveBeenCalled();
    expect(answer).toMatch(/no retained Optimize run/);
  });
});
