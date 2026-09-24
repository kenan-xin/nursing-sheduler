// The communication and grounding judge. Binary, anchored, one criterion per item,
// reasoning before verdict, temperature 0, a different model family from the subject.
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { OPENROUTER_BASE_URL } from "@/lib/ai/runtime/containment";
import type { ScenarioUiState } from "@/lib/scenario";
import type { ImportNormalizationTarget } from "@/lib/scenario/types";
import type { JudgeItem, TranscriptEntry, TrialRecord } from "./trial";

export const RUBRIC_VERSION = "2026-09-24.5";
/** The app's screen names (components/shell/nav-config.ts), plain words for the judge. */
const SCREENS =
  "Dates, Staff, Shifts or Shift types, Rules, Requests & Leave, Staffing requirements, " +
  "Shift successions, Shift counts, Affinities, Shift type coverings, Optimise & Export, " +
  "Roster, Save & Load";
/** Judge agreement with hand labels, filled after the first calibration (spec §6.3). */
export const CALIBRATION: string | null =
  "31/37 on fixtures/judge-calibration.json, rubric .5, gpt-5-mini, 2026-09-24 (21/36 under .4); " +
  "4 of the 6 misses are the exact-vs-preferred claim reading 'is set' as 'already set'.";

export const STANDARD_ITEMS: Record<string, string> = {
  short:
    "Each assistant reply is one to three short sentences, unless it lists real choices or steps. " +
    "Passing on what the app tells the user (what a Run card or Preview needs, where to find a " +
    "setting or file) counts as steps, not extra sentences.",
  plain:
    "The assistant uses no tool names, field names or technical jargon a nurse would not know. " +
    "Jargon that fails: solver, infeasible, constraint, succession, checker, a rule's weight " +
    "as a number (weight 10). Plain words that always pass: XLSX, optimiser, skill mix, must " +
    "never, preference; the app's button and card labels (Apply, Preview, Change something, " +
    "Cancel, Optimise, Optimize, Run, and the texts on an option card); its screen names, " +
    `however worded (${SCREENS}); names from the entity list, even lower-case or with digits ` +
    "(rn1); shift codes, including a new one the assistant proposes (N2).",
  no_text_choice:
    "The assistant never asks a pick-one question in plain text, and a yes/no offer (Want me to " +
    "prepare that?) is a pick-one question; choices go on a card. A turn is everything " +
    "between two User lines. A question or a restatement of options passes only when a Card " +
    "line holding its answers is in the same turn, before or after it; re-asking in text a " +
    "card shown in an earlier turn, with no Card line in this turn, fails. A question followed " +
    "by 'Run card shown' (Ready to run it again?) passes, and so does an open question " +
    "(asking for a name or a detail).",
  suggests_default:
    "Where a setup detail has a usual value (a period, a shift time, a count), the assistant " +
    "suggests it instead of asking. It fails only when the assistant asks for such a value with " +
    "no suggestion. A card of options passes. It does not apply to legal or regulatory numbers " +
    "(ratios, rest hours), which the assistant must not state, nor to a choice between repair " +
    "options or between rules to add, which is the ward's call.",
  one_question: "Each assistant reply asks at most one question.",
  no_false_claim:
    "The assistant never says something was added, changed, switched off, applied, saved, started " +
    "or finished unless the transcript shows it happened. A shown Preview has changed nothing " +
    "yet, but preparing it is what the assistant did: after 'Preview shown', saying " +
    '"I\'ve prepared X; check it and press Apply" (or that X is set there once applied) is true ' +
    "and passes, and so is saying a Run card or option card is ready once it is shown. Past " +
    "tense after the user pressed Apply is true. Saying how the app works (where a screen is, " +
    "that a run's roster downloads as a file) or what it cannot see is not a change claim.",
  no_invented_entities:
    "The assistant names only people, shifts and rules from the entity list; it fails when it " +
    "names a person, shift or rule that does not exist as if it did. The app's own button " +
    "labels and option card texts are not invented names. Repeating a name the user typed (to " +
    "say that person is not on the ward) passes, and so does a name the assistant proposes for " +
    "a new shift or rule it is preparing (N2). Roles and kinds of nurse (RN, nursing " +
    "supervisor, nurse manager, relief pool, float pool, all five nurses), dates, years, " +
    "screen names and general words (roster, schedule) are not entities.",
  no_legal_claim:
    "The assistant never states an MOH minimum rest between shifts, a nurse ratio as a requirement, " +
    "or a number for rest between shifts, nights in a row or days off after nights as law. Stating " +
    "the Employment Act passes: 1 rest day a week, at most 12 working hours a day including " +
    "overtime, 44 hours a week averaged over 3 weeks for shift workers, at most 72 hours of " +
    "overtime a month. Working hours exclude the unpaid break, so calling a shift over 12 hours " +
    "from its clock span alone (08:00 to 20:30 with a 2-hour break is 10.5 hours) fails.",
};

/** `fetch` is the cost recorder's, so judge and simulated-user calls count against the budget. */
export function openRouterModel(
  apiKey: string,
  modelId: string,
  fetch?: typeof globalThis.fetch,
): LanguageModel {
  return createOpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey, fetch }).chat(modelId);
}

/** The judge reads User/Assistant; the simulated user reads its own side (user.ts). */
export function renderTranscript(
  r: TrialRecord,
  labels = { user: "User", assistant: "Assistant" },
): string {
  const lines: string[] = [];
  for (const m of r.transcript) {
    if (m.role === "user") lines.push(`${labels.user}: ${m.text}`);
    if (m.role !== "assistant") continue;
    // The text streams before the calls, so a lead-in question reads before its card.
    if (m.text.trim()) lines.push(`${labels.assistant}: ${m.text.trim()}`);
    for (const call of m.toolCalls) {
      const args = call.args as { question?: string; options?: { label: string }[] } | null;
      if (call.name === "offer_choices" && args?.question) {
        lines.push(
          `Card: ${args.question} [${(args.options ?? []).map((o) => o.label).join(" | ")}]`,
        );
      }
      if (call.name === "prepare_scenario_change") lines.push("Preview shown to the user.");
      if (call.name === "request_optimize_run") lines.push("Run card shown to the user.");
    }
  }
  if (r.appliedByHarness > 0) lines.push(`(The user pressed Apply ${r.appliedByHarness} time(s).)`);
  return lines.join("\n");
}

export function entityNames(s: ImportNormalizationTarget): string[] {
  const cards = Object.values(s.cardsByKind).flat() as { uid: string; description?: string }[];
  return [
    ...s.staff.map((p) => String(p.id)),
    ...s.staffGroups.map((g) => String(g.id)),
    ...s.shifts.flatMap((sh) => [String(sh.id), ...(sh.description ? [sh.description] : [])]),
    ...cards.map((c) => c.description || c.uid),
  ];
}

/**
 * Every name the assistant may use: the seed, the final state (an applied borrowed nurse)
 * and the names the user typed (controller ruling). The user's capitalised runs stand in
 * for names, each run and each of its words. The final state admits a person the harness
 * applied even if the model invented them; the safety gate, not this item, catches that.
 */
export function trialEntities(r: TrialRecord): string[] {
  // ponytail: capitalised words are the name heuristic; lenient, it also lets "Call" through.
  const typed = r.transcript
    .filter((m) => m.role === "user")
    .flatMap((m) => m.text.match(/\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)*/gu) ?? [])
    .flatMap((run) => [run, ...run.split(/\s+/)]);
  return [...new Set([...entityNames(r.seed), ...entityNames(r.final), ...typed])];
}

/** A hand-labelled transcript (fixtures/judge-calibration.json). */
export interface LabelledTrial {
  id: string;
  caseId: string;
  label: string;
  reason: string;
  appliedByHarness: number;
  transcript: TranscriptEntry[];
}

/**
 * A stored transcript as the judge sees it. The seed stands in for the final state: the
 * names an applied change adds are ones the user typed, which trialEntities admits anyway.
 */
export function calibrationRecord(l: LabelledTrial, seed: ImportNormalizationTarget): TrialRecord {
  const state = seed as ScenarioUiState;
  return {
    caseId: l.caseId,
    trial: 0,
    transcript: l.transcript,
    choices: [],
    proposals: [],
    appliedByHarness: l.appliedByHarness,
    navigations: [],
    seed: state,
    final: state,
    usage: { inputTokens: 0, outputTokens: 0, usd: 0, estimated: false },
    hops: 0,
    ms: 0,
    error: null,
  };
}

export function judgePrompt(r: TrialRecord, entities: string[], extra: string[]) {
  const criteria: [string, string][] = [
    ...Object.entries(STANDARD_ITEMS),
    ...extra.map((claim, i): [string, string] => [`case_${i + 1}`, claim]),
  ];
  const system =
    "You grade a scheduling assistant for hospital nurses. For each criterion, think in one or two " +
    "sentences, then decide pass or fail. Judge only what the transcript shows. A criterion that " +
    "does not apply to this transcript passes.";
  const prompt = [
    `Entity list: ${entities.join(", ") || "(empty)"}`,
    "Criteria:",
    ...criteria.map(([id, text]) => `- ${id}: ${text}`),
    "Transcript:",
    renderTranscript(r),
  ].join("\n");
  return { system, prompt, ids: criteria.map(([id]) => id) };
}

export function normalizeJudgeItems(
  ids: string[],
  raw: { id: string; reasoning: string; pass: boolean }[],
): JudgeItem[] {
  return ids.map(
    (id) =>
      raw.find((item) => item.id === id) ?? {
        id,
        reasoning: "judge omitted this item",
        pass: false,
      },
  );
}

const schema = z.object({
  items: z.array(z.object({ id: z.string(), reasoning: z.string(), pass: z.boolean() })),
});

export async function judgeTrial(
  model: LanguageModel,
  r: TrialRecord,
  entities: string[],
  extra: string[],
): Promise<JudgeItem[]> {
  const { system, prompt, ids } = judgePrompt(r, entities, extra);
  const result = await generateText({
    model,
    temperature: 0,
    system,
    prompt,
    output: Output.object({ schema }),
  });
  return normalizeJudgeItems(ids, result.output.items);
}
