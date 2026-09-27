import type { AssistantCommandV1 } from "@/lib/proposal";
import type { ScenarioUiState } from "@/lib/scenario";
import type { EvalCase } from "./case";

export interface ToolCallRecord {
  toolCallId: string;
  name: string;
  args: unknown;
  result: string | null;
}

/**
 * The model-facing text of one tool result.
 *
 * CopilotKit hands a STRING result to the model verbatim and JSON-encodes anything else
 * (`@copilotkit/core` 1.66.2), so a handler that answered in a sentence put a ward-supplied
 * name into the model's own text. Every shipped handler now answers with an object, which
 * makes the persisted result JSON and its words a `guidance` field. A bare string -- a
 * fixture written before that change, or a truncated capture -- is read as it stands, so
 * both shapes mean the same thing to a grader.
 */
export function toolResultText(result: string | null): string {
  if (!result) return "";
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const guidance = (parsed as { guidance?: unknown }).guidance;
      if (typeof guidance === "string") return guidance;
    }
  } catch {
    // A bare string result: read it as it stands.
  }
  return result;
}
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls: ToolCallRecord[];
}
export interface ChoiceRecord {
  question: string;
  options: string[];
}
export interface ProposalRecord {
  proposalId: string;
  ops: AssistantCommandV1[];
  status: string;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  estimated: boolean;
}
/** One user-visible turn: a send, an Apply or a finished run, until the assistant settles. */
export interface TurnLatency {
  ttftMs: number | null;
  ms: number;
}
export interface TrialRecord {
  caseId: string;
  trial: number;
  transcript: TranscriptEntry[];
  choices: ChoiceRecord[];
  proposals: ProposalRecord[];
  appliedByHarness: number;
  navigations: string[];
  seed: ScenarioUiState;
  final: ScenarioUiState;
  usage: Usage;
  hops: number;
  ms: number;
  /** Turns that settled; a timed-out turn is in `error`, not here. */
  turns?: TurnLatency[];
  /** The assistant model's own spend; `usage` adds the judge and the simulated user. */
  assistantUsd?: number;
  error: string | null;
}
export interface GateResult {
  gate: string;
  pass: boolean;
  detail: string;
}
export interface JudgeItem {
  id: string;
  reasoning: string;
  pass: boolean;
}
/** What reaches the reporter. No scenarios: `Infinity` weights do not survive JSON. */
export interface TrialMeta extends Omit<TrialRecord, "seed" | "final"> {
  tags: string[];
  gates: GateResult[];
  judge: JudgeItem[];
  pass: boolean;
  safetyPass: boolean;
  skipped: "budget" | null;
  /** The judge's verdict was empty or unparsable on both tries; judge items are the fail fallback. */
  judgeError: boolean;
}

declare module "vitest" {
  interface TaskMeta {
    eval?: TrialMeta;
  }
}

export function toMeta(
  c: EvalCase,
  r: TrialRecord,
  gates: GateResult[],
  judge: JudgeItem[],
  judgeError = false,
): TrialMeta {
  const { seed: _seed, final: _final, ...rest } = r;
  const safetyPass = gates.every((g) => g.gate !== "safety" || g.pass);
  return {
    ...rest,
    tags: c.tags,
    gates,
    judge,
    pass: r.error === null && gates.every((g) => g.pass) && judge.every((j) => j.pass),
    safetyPass,
    skipped: null,
    judgeError,
  };
}
