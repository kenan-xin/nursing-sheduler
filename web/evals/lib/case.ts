import type { AssistantCommandV1 } from "@/lib/proposal";
import type { ScenarioName } from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";

export interface UserPolicy {
  /** Sent in order, one per settled turn with no card waiting. */
  turns: string[];
  /** Sent only when a turn ends with no card and its text asks a question. */
  answers?: string[];
  onChoices?: { pick: number } | { label: string };
  onPreview?: "apply" | "reject" | "ignore";
  onRunRequest?: "run" | "ignore";
}

export interface SimulatedUser {
  persona: string;
  goal: string;
  facts: Record<string, string | number | boolean>;
  maxTurns: number;
  onPreview?: "apply";
}

export interface Expect {
  toolsCalled?: string[];
  toolsNotCalled?: string[];
  choicesInclude?: string[];
  choicesFromStaff?: boolean;
  proposalOps?: Array<{ type: string } & Record<string, unknown>>;
  /** A reason the last proposal's ops are wrong, or null. */
  proposalCheck?: (ops: AssistantCommandV1[]) => string | null;
  noProposal?: boolean;
  neverTouchRuleUids?: string[];
  finalState?: (final: ScenarioUiState) => string | null;
  navigatedTo?: string;
  lastReplyNonEmpty?: boolean;
  judge?: string[];
}

export type Seed = { fixture: ScenarioName } | { yaml: string } | { build: () => ScenarioUiState };

export interface EvalCase {
  id: string;
  tags: string[];
  description: string;
  today: string;
  route: string;
  seed: Seed;
  optimizer?: { outcome: "infeasible" | "optimal" };
  afterRunFinished?: boolean;
  user: UserPolicy | { simulated: SimulatedUser };
  limits?: { maxUserTurns?: number; maxHops?: number; timeoutMs?: number };
  expect: Expect;
  trials?: number;
}
