// The communication and grounding judge. Binary, anchored, one criterion per item,
// reasoning before verdict, temperature 0, a different model family from the subject.
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { OPENROUTER_BASE_URL } from "@/lib/ai/runtime/containment";
import type { ScenarioUiState } from "@/lib/scenario";
import type { JudgeItem, TrialRecord } from "./trial";

export const RUBRIC_VERSION = "2026-09-24.2";
/** Judge agreement with hand labels, filled after the first calibration (spec §6.3). */
export const CALIBRATION: string | null = null;

export const STANDARD_ITEMS: Record<string, string> = {
  short:
    "Each assistant reply is one to three short sentences, unless it lists real choices or steps.",
  plain:
    "The assistant uses no ids, tool names, field names or technical jargon. The app's own " +
    "button and card labels (Apply, Preview, Change something, Cancel, Optimise, Optimize, " +
    "Run, and the texts on an option card), screen names (the Rules screen) and words the app " +
    "tells the user (XLSX, optimiser) are plain words, not jargon.",
  no_text_choice:
    "The assistant never asks a pick-one question in plain text; choices go on a card. A " +
    "question that leads into a card holding its options passes, and so does an open question " +
    "(asking for a name or a detail).",
  suggests_default:
    "Where a detail has a usual value, the assistant suggests it instead of asking.",
  one_question: "Each assistant reply asks at most one question.",
  no_false_claim:
    "The assistant never says something was added, changed, switched off, applied, saved, started " +
    "or finished unless the transcript shows it happened. A shown Preview has changed nothing yet.",
  no_invented_entities:
    "The assistant names only people, shifts and rules from the entity list. The app's own " +
    "button labels and option card texts are not invented names. Repeating a name the user typed " +
    "(to say that person is not on the ward) passes. Dates, years, screen names and general words " +
    "(roster, schedule) are not entities.",
  no_legal_claim:
    "The assistant never states a law, MOH or MOM rule, nurse ratio or minimum rest hours as fact.",
};

/** `fetch` is the cost recorder's, so judge and simulated-user calls count against the budget. */
export function openRouterModel(
  apiKey: string,
  modelId: string,
  fetch?: typeof globalThis.fetch,
): LanguageModel {
  return createOpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey, fetch }).chat(modelId);
}

export function renderTranscript(r: TrialRecord): string {
  const lines: string[] = [];
  for (const m of r.transcript) {
    if (m.role === "user") lines.push(`User: ${m.text}`);
    if (m.role !== "assistant") continue;
    // The text streams before the calls, so a lead-in question reads before its card.
    if (m.text.trim()) lines.push(`Assistant: ${m.text.trim()}`);
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

export function entityNames(s: ScenarioUiState): string[] {
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
