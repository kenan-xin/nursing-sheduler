// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useRunRequestStore } from "@/lib/optimize/run-request";
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
  identity: vi.fn(async (): Promise<unknown> => null),
  scenarioBasis: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    pickScenario: () => fixture.scenario,
    readAuthoritativeScenarioIdentity: fixture.identity,
    assistantProposalCommands: {
      ...actual.assistantProposalCommands,
      readScenarioBasis: fixture.scenarioBasis,
    },
  };
});

// The retained failed run the tool diagnoses, read through the scenario-authority spine.
const spineFixture = vi.hoisted(() => ({
  readLatestOrdinaryBasis: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("@/lib/store/spine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/spine")>();
  return {
    ...actual,
    getScenarioAuthority: () => ({ readLatestOrdinaryBasis: spineFixture.readLatestOrdinaryBasis }),
  };
});

// The deployment default the tool fetches when the Optimize screen has published none.
const optionsFixture = vi.hoisted(() => ({ default: 15 }));
vi.mock("@/lib/query/optimize-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query/optimize-options")>();
  return {
    ...actual,
    fetchOptimizeTimeoutOptions: async () => ({
      source: "backend" as const,
      timeout: { default: optionsFixture.default, minimum: 1, maximum: 600 },
    }),
  };
});

// The search itself, stubbed: this suite pins the timeout the tool HANDS it.
const runtimeFixture = vi.hoisted(() => ({ calls: [] as { timeoutSeconds: number }[] }));
vi.mock("@/lib/ai/diagnostic/diagnostic-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/diagnostic/diagnostic-runtime")>();
  return {
    ...actual,
    runDiagnosticSearchForTurn: async (input: { timeoutSeconds: number }) => {
      runtimeFixture.calls.push({ timeoutSeconds: input.timeoutSeconds });
      return {
        search: { candidates: [], stopReason: "recovery_blocked", failureReason: "stub" },
        previewCandidate: null,
      };
    },
  };
});

const TURN = 7;
let boundTurn: TestTurnHandle;

function Host() {
  useDiagnosticTools("scheduler:thread-1", TURN);
  return null;
}

const handler = () => captured.find((t) => t.name === "test_feasibility_candidates")!.handler;

/** The model-facing text of a tool result; every handler answers with an object (bead 3eve). */
const text = (answer: unknown) => (answer as { guidance: string }).guidance;

beforeEach(() => {
  captured.length = 0;
  runtimeFixture.calls.length = 0;
  fixture.identity.mockClear();
  fixture.identity.mockResolvedValue(null);
  fixture.scenarioBasis.mockClear();
  fixture.scenarioBasis.mockResolvedValue(null);
  spineFixture.readLatestOrdinaryBasis.mockClear();
  spineFixture.readLatestOrdinaryBasis.mockResolvedValue(null);
  useRunRequestStore.setState({ solverTimeoutSeconds: null });
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
    expect(text(answer)).toMatch(/Candidate 1/);
    expect(text(answer)).toMatch(/rest rule/);
    expect(text(answer)).toMatch(/Nothing was tested/);
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
    expect(text(answer)).toMatch(/no retained Optimize run/);
  });
});

// bd memory assistant-respects-solver-timeout: every solve the assistant starts uses the
// user's solver timeout — the value the Optimize screen published, else the deployment
// default from /optimize/options. Never a fixed budget.
describe("test_feasibility_candidates respects the solver timeout", () => {
  const safeCandidate = {
    compare: false,
    candidates: [
      {
        summary: "A third nurse.",
        operations: [{ type: "add_person", name: "Borrowed nurse 1", groups: [] }],
      },
    ],
  };

  function withRetainedParent(): void {
    fixture.identity.mockResolvedValue({ scenarioId: "scenario-1", documentRevision: 7 });
    fixture.scenarioBasis.mockResolvedValue({ leaseEpoch: 3 });
    spineFixture.readLatestOrdinaryBasis.mockResolvedValue({
      basisId: "p".repeat(64),
      jobId: "job_parent",
      expiresAt: null,
    });
  }

  it("uses the deployment default when the screen has published nothing", async () => {
    withRetainedParent();
    await handler()(safeCandidate, {});
    expect(runtimeFixture.calls).toEqual([{ timeoutSeconds: 15 }]);
  });

  it("uses the timeout the Optimize screen published, over the default", async () => {
    withRetainedParent();
    useRunRequestStore.setState({ solverTimeoutSeconds: 45 });
    await handler()(safeCandidate, {});
    expect(runtimeFixture.calls).toEqual([{ timeoutSeconds: 45 }]);
  });
});
