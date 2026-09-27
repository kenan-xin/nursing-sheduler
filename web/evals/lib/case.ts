import type { AssistantCommandV1 } from "@/lib/proposal";
import type { ScenarioName } from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import type { SavedRosterRows } from "./saved-roster";

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
  /** Some assistant reply says the rest rule is a recommended practice, not a legal rule. */
  restWarning?: boolean;
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
  /** A roster the last run made and the app saved, as a successful Optimize run leaves it. */
  savedRoster?: SavedRosterRows;
  optimizer?: { outcome: "infeasible" | "optimal" };
  afterRunFinished?: boolean;
  user: UserPolicy | { simulated: SimulatedUser };
  limits?: { maxUserTurns?: number; maxHops?: number; timeoutMs?: number };
  expect: Expect;
  trials?: number;
}
