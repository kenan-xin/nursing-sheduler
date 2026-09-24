import type { AssistantCommandV1 } from "@/lib/proposal";
import type { ScenarioUiState } from "@/lib/scenario";
import type { EvalCase } from "./case";

export interface ToolCallRecord {
  toolCallId: string;
  name: string;
  args: unknown;
  result: string | null;
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
