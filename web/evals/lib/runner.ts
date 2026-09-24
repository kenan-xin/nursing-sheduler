// Registers one Vitest test per case trial. Trials in a file run in sequence: the stores
// are singletons. Each *.eval.ts file is its own worker, with its share of the budget.
import { describe, expect, test } from "vitest";
import { Ledger, plus, recordingFetch } from "./budget";
import type { EvalCase } from "./case";
import { gradeDeterministic } from "./graders";
import { runTrial, type Seams } from "./harness";
import { judgeTrial, openRouterModel, trialEntities } from "./judge";
import { toMeta } from "./trial";

export const EVAL_FILES = 5;
/**
 * The global cap, split evenly over the eval files. Each file's share must cover 3 trials
 * of its costliest case: repair-understaffed-night measured $0.46 a trial, so $1.60 a file.
 * Smoke runs one trial (`pnpm eval:smoke`).
 */
export const DEFAULT_MAX_USD = 8;

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
  maxUsd: positive("EVAL_MAX_USD", DEFAULT_MAX_USD) / EVAL_FILES,
});

export function runCases(cases: EvalCase[], seams: Seams): void {
  const e = env();
  const ledger = new Ledger(e.maxUsd);
  const selected = cases.filter((c) => !e.tags || c.tags.some((t) => e.tags!.includes(t)));
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
            };
            skip("budget");
          }
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
          const gates = gradeDeterministic(evalCase, record);
          const judge = record.error
            ? []
            : await judgeTrial(
                openRouterModel(e.key, e.judge, judgeRec.fetch),
                record,
                trialEntities(record),
                evalCase.expect.judge ?? [],
              ).catch((err: unknown) => [
                { id: "judge", reasoning: `judge call failed: ${String(err)}`, pass: false },
              ]);
          record.usage = plus(
            record.usage,
            plus(await userRec.settled(), await judgeRec.settled()),
          );
          task.meta.eval = toMeta(evalCase, record, gates, judge);
          expect(gates.filter((g) => !g.pass)).toEqual([]);
          expect(judge.filter((j) => !j.pass)).toEqual([]);
        },
        (evalCase.limits?.timeoutMs ?? 180_000) + 90_000,
      );
    }
  });
}
