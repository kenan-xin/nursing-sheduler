// Bind a turn the way `useAssistantSession` does, for suites that drive tool handlers
// or the hop guard directly.
//
// NOT in `turn-authority.ts`: the binding only needs six fields of a `SendPlan`
// (`authorizeBoundIdentity` reads thread, scenario, lease epoch, revision, turn epoch
// and run id), and fabricating the rest would mean a cast in production code. Keeping
// the cast here means the shipped module stays honestly typed and the fixture stays
// obviously a fixture.
//
// This file is deliberately NOT named `*.test.ts`, so vitest does not collect it as a
// suite while still allowing the loose typing a fixture needs.

import type { SendPlan } from "@/lib/ai/assistant/send-gate";
import type { WriterContext } from "@/lib/ai/assistant/writer-context";
import { bindTurn, releaseTurn, type BoundTurn } from "./turn-authority";

export interface TestTurnFacts {
  threadId: string;
  scenarioId: string;
  documentRevision: number;
  leaseEpoch: number;
  turnEpoch: number;
  runId: string;
}

const DEFAULTS: TestTurnFacts = {
  threadId: "thread-1",
  scenarioId: "scenario-1",
  documentRevision: 7,
  leaseEpoch: 3,
  turnEpoch: 1,
  runId: "run-1",
};

export interface TestTurnHandle {
  turn: BoundTurn;
  /** The live facts the guard samples. Mutate to simulate authority moving. */
  live: {
    scenarioId: string | null;
    documentRevision: number;
    isOwner: boolean;
    liveTurnEpoch: number;
    interrupting: boolean;
    activeRunId: string | null;
  };
  release(): void;
}

/**
 * Bind a turn whose plan, claim and live projection all agree.
 *
 * Every refusal a suite wants to exercise is then one mutation of `live` (or of
 * `turn.claim`) away, which keeps each test's cause explicit rather than buried in a
 * bespoke fixture.
 */
export function bindTurnForTest(
  overrides: Partial<TestTurnFacts> & { agent?: object } = {},
): TestTurnHandle {
  const facts = { ...DEFAULTS, ...overrides };

  const plan = {
    threadId: facts.threadId,
    scenarioId: facts.scenarioId,
    documentRevision: facts.documentRevision,
    leaseEpoch: facts.leaseEpoch,
    turnEpoch: facts.turnEpoch,
    runId: facts.runId,
  } as SendPlan;

  const claim: WriterContext = {
    scenarioId: facts.scenarioId,
    documentRevision: facts.documentRevision,
    leaseEpoch: facts.leaseEpoch,
    scenario: {} as WriterContext["scenario"],
  };

  const live: TestTurnHandle["live"] = {
    scenarioId: facts.scenarioId,
    documentRevision: facts.documentRevision,
    isOwner: true,
    liveTurnEpoch: facts.turnEpoch,
    interrupting: false,
    activeRunId: facts.runId,
  };

  const turn: BoundTurn = {
    token: {
      // A plain object stands in for the concrete agent: the guard compares by
      // identity, so what it points at only matters when a test needs two of them.
      agent: overrides.agent ?? {},
      threadId: facts.threadId,
      scenarioId: facts.scenarioId,
      turnId: `turn-${facts.runId}`,
      runId: facts.runId,
      turnEpoch: facts.turnEpoch,
    },
    plan,
    boundThreadId: facts.threadId,
    claim,
    ownedRunIds: new Set([facts.runId]),
    refusal: null,
    liveNow: () => ({
      plan,
      boundThreadId: facts.threadId,
      liveTurnEpoch: live.liveTurnEpoch,
      interrupting: live.interrupting,
      // Launch-only, and never consulted by `authorizeBoundIdentity`.
      busy: false,
      activeRunId: live.activeRunId,
      live: {
        scenarioId: live.scenarioId,
        documentRevision: live.documentRevision,
        isOwner: live.isOwner,
      },
    }),
  };

  bindTurn(turn);
  return { turn, live, release: () => releaseTurn(turn) };
}
