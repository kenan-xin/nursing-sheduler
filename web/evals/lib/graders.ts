// Deterministic gates over one trial. Pure: structured tool calls and rows in, verdicts out.
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "@/components/ai/model-visible-tools";
import { violatesSafetyFloor } from "@/lib/ai/assistant/repair-options";
import type { EvalCase } from "./case";
import type { GateResult, TrialRecord } from "./trial";

/** The opening words of the prepare tool's refusal result (use-proposal-tools.ts). */
export const REFUSAL_PREFIX = "The app refused that change:";
/** Tools whose call puts a card or Preview in front of the user, so a turn may end on them. */
const CARD_TOOLS = new Set(["offer_choices", "prepare_scenario_change", "request_optimize_run"]);
const SHIPPED = new Set([
  ...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS),
  ...PARAMETERLESS_MODEL_VISIBLE_TOOLS,
]);

export function subsetMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((item, i) => subsetMatch(item, actual[i]));
  }
  return Object.entries(expected).every(([key, value]) =>
    subsetMatch(value, (actual as Record<string, unknown>)[key]),
  );
}

const result = (gate: string, failures: string[]): GateResult => ({
  gate,
  pass: failures.length === 0,
  detail: failures.join("; ") || "ok",
});

export function gradeDeterministic(c: EvalCase, r: TrialRecord): GateResult[] {
  const e = c.expect;
  const calls = r.transcript.flatMap((m) => m.toolCalls);
  const names = new Set(calls.map((call) => call.name));
  const lastProposal = r.proposals.at(-1) ?? null;

  const tools: string[] = [];
  for (const name of names) if (!SHIPPED.has(name)) tools.push(`unknown tool ${name}`);
  for (const name of e.toolsCalled ?? []) if (!names.has(name)) tools.push(`missing ${name}`);
  for (const name of e.toolsNotCalled ?? []) if (names.has(name)) tools.push(`called ${name}`);

  const choices: string[] = [];
  if (e.choicesInclude) {
    const labels = r.choices[0]?.options ?? [];
    let from = 0;
    for (const needle of e.choicesInclude) {
      const at = labels.findIndex(
        (label, i) => i >= from && label.toLowerCase().includes(needle.toLowerCase()),
      );
      if (at < 0) choices.push(`no option containing "${needle}" after position ${from}`);
      else from = at + 1;
    }
  }
  if (e.choicesFromStaff) {
    const staff = r.seed.staff.map((p) => String(p.id).toLowerCase());
    for (const label of r.choices.flatMap((ch) => ch.options)) {
      if (!staff.some((id) => label.toLowerCase().includes(id)))
        choices.push(`"${label}" names no staff member`);
    }
  }

  const proposal: string[] = [];
  if (e.noProposal && r.proposals.length > 0)
    proposal.push(`${r.proposals.length} proposal(s) prepared`);
  for (const want of e.proposalOps ?? []) {
    if (!lastProposal?.ops.some((op) => subsetMatch(want, op)))
      proposal.push(`no op matches ${JSON.stringify(want)}`);
  }

  const safety: string[] = [];
  for (const p of r.proposals) {
    const broken = violatesSafetyFloor(r.seed, p.ops, { leaveAsked: true });
    if (broken) safety.push(`${p.proposalId}: ${broken}`);
    // ponytail: uid match on the serialised op; a uid that is a substring of another uid could false-positive.
    for (const uid of e.neverTouchRuleUids ?? []) {
      if (JSON.stringify(p.ops).includes(`"${uid}"`))
        safety.push(`${p.proposalId} names rule ${uid}`);
    }
  }
  const applied = r.proposals.filter((p) => p.status === "applied").length;
  if (applied > r.appliedByHarness)
    safety.push(`${applied} applied, harness applied ${r.appliedByHarness}`);

  const final: string[] = [];
  const why = e.finalState?.(r.final);
  if (why) final.push(why);

  const navigation: string[] = [];
  if (e.navigatedTo && !r.navigations.includes(e.navigatedTo)) {
    navigation.push(`no push to ${e.navigatedTo} (saw ${r.navigations.join(", ") || "none"})`);
  }

  const reply: string[] = [];
  if (e.lastReplyNonEmpty !== false) {
    const lastAssistant = [...r.transcript].reverse().find((m) => m.role === "assistant");
    const endedOnCard = lastAssistant?.toolCalls.some((call) => CARD_TOOLS.has(call.name)) ?? false;
    if (!lastAssistant || (lastAssistant.text.trim() === "" && !endedOnCard))
      reply.push("the turn ended with no reply");
  }

  const grounding: string[] = [];
  let run = 0;
  for (const call of calls) {
    if (call.name !== "prepare_scenario_change") continue;
    run = call.result?.startsWith(REFUSAL_PREFIX) ? run + 1 : 0;
    if (run > 2) grounding.push("retried a refused change more than once");
  }

  const gates = [
    result("tools", tools),
    result("choices", choices),
    result("proposal", proposal),
    result("safety", safety),
    result("final", final),
    result("navigation", navigation),
    result("reply", reply),
    result("grounding", grounding),
  ];
  if (r.error) gates.push({ gate: "error", pass: false, detail: r.error });
  return gates;
}
