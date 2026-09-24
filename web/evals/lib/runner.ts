// Registers one Vitest test per case trial. Trials in a file run in sequence: the stores
// are singletons. Each *.eval.ts file is its own worker, with its share of the budget.
import { describe, expect, test } from "vitest";
import baselineJson from "../baseline.json";
import { ALL_CASES } from "../cases";
import { cutByBudget, Ledger, plannedUsd, plus, recordingFetch, selectCases } from "./budget";
import type { EvalCase } from "./case";
import { gradeDeterministic } from "./graders";
import { runTrial, type Seams } from "./harness";
import { judgeTrial, openRouterModel, trialEntities } from "./judge";
import type { Baseline } from "./report";
import { toMeta, type JudgeItem } from "./trial";

/**
 * The global cap. A complete 3-trial run measured about $15. Each file gets the share of it
 * its selected cases are planned to cost, so every worker works out the same split from
 * static imports, with no state shared between workers.
 */
export const DEFAULT_MAX_USD = 16;
const BASELINE = baselineJson as Baseline;

/** A positive number from the environment, or a loud failure: NaN would pass silently. */
function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!(value > 0)) throw new Error(`${name} must be a positive number`);
  return value;
}

const env = () => ({
  key: process.env.OPENROUTER_API_KEY ?? "",
  model: process.env.EVAL_MODEL ?? "anthropic/claude-sonnet-4.5",
  judge: process.env.EVAL_JUDGE_MODEL ?? "openai/gpt-5-mini",
  user: process.env.EVAL_USER_MODEL ?? "anthropic/claude-haiku-4.5",
  trials: positive("EVAL_TRIALS", 3),
  tags: process.env.EVAL_TAGS ? process.env.EVAL_TAGS.split(",") : null,
  maxUsd: positive("EVAL_MAX_USD", DEFAULT_MAX_USD),
});

export function runCases(cases: EvalCase[], seams: Seams): void {
  const e = env();
  const total = plannedUsd(selectCases(ALL_CASES, e.tags), e.trials, BASELINE);
  if (total > e.maxUsd) {
    // Loud, before any spend: a silent partial run is worse than none.
    throw new Error(
      `planned eval cost $${total.toFixed(2)} is over EVAL_MAX_USD $${e.maxUsd}; raise the cap or narrow EVAL_TAGS`,
    );
  }
  const selected = selectCases(cases, e.tags);
  const ledger = new Ledger(
    total > 0 ? (e.maxUsd * plannedUsd(selected, e.trials, BASELINE)) / total : 0,
  );
  describe.sequential.each(selected)("$id", (evalCase) => {
    const n = evalCase.trials ?? e.trials;
    for (let t = 0; t < n; t += 1) {
      test(
        `trial ${t + 1}`,
        async ({ task, skip }) => {
          if (ledger.over) {
            task.meta.eval = {
              caseId: evalCase.id,
              trial: t,
              tags: evalCase.tags,
              transcript: [],
              choices: [],
              proposals: [],
              appliedByHarness: 0,
              navigations: [],
              usage: { inputTokens: 0, outputTokens: 0, usd: 0, estimated: false },
              hops: 0,
              ms: 0,
              error: null,
              gates: [],
              judge: [],
              pass: false,
              safetyPass: true,
              skipped: "budget",
              judgeError: false,
            };
            skip("budget");
          }
          const refusedBefore = ledger.refused;
          const userRec = recordingFetch(e.user, ledger);
          const judgeRec = recordingFetch(e.judge, ledger);
          const userModel =
            "simulated" in evalCase.user ? openRouterModel(e.key, e.user, userRec.fetch) : null;
          const record = await runTrial({
            evalCase,
            trial: t,
            seams,
            ledger,
            apiKey: e.key,
            model: e.model,
            userModel,
          });
          // Read before the judge spends: a trial that ended over budget was cut, not finished.
          let cut = cutByBudget(ledger, refusedBefore);
          const gates = gradeDeterministic(evalCase, record);
          const judgeOutcome =
            record.error || cut
              ? { items: [] as JudgeItem[], judgeError: false }
              : await judgeTrial(
                  openRouterModel(e.key, e.judge, judgeRec.fetch),
                  record,
                  trialEntities(record),
                  evalCase.expect.judge ?? [],
                ).catch((err: unknown) => ({
                  items: [
                    { id: "judge", reasoning: `judge call failed: ${String(err)}`, pass: false },
                  ],
                  judgeError: true,
                }));
          const judge = judgeOutcome.items;
          record.usage = plus(
            record.usage,
            plus(await userRec.settled(), await judgeRec.settled()),
          );
          task.meta.eval = toMeta(evalCase, record, gates, judge, judgeOutcome.judgeError);
          // After the judge, only a refusal cuts: its own spend going over does not.
          cut ||= ledger.refused > refusedBefore;
          if (cut) {
            // The budget cut a hop or the judge short: not a verdict on the assistant.
            task.meta.eval = { ...task.meta.eval, pass: false, skipped: "budget" };
            skip("budget");
          }
          expect(gates.filter((g) => !g.pass)).toEqual([]);
          expect(judge.filter((j) => !j.pass)).toEqual([]);
        },
        (evalCase.limits?.timeoutMs ?? 180_000) + 90_000,
      );
    }
  });
}
