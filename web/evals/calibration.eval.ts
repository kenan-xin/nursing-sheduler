// Re-judges the hand-labelled transcripts and prints agreement (spec §6.3). Opt-in: it is
// not a case run, so `pnpm eval` skips it unless EVAL_CALIBRATE=1.
import { describe, expect, test } from "vitest";
import { ALL_CASES } from "./cases";
import labelledJson from "./fixtures/judge-calibration.json";
import { Ledger, recordingFetch } from "./lib/budget";
import { buildSeed } from "./lib/harness";
import {
  calibrationRecord,
  judgeTrial,
  openRouterModel,
  trialEntities,
  type LabelledTrial,
} from "./lib/judge";

const labelled = labelledJson as LabelledTrial[];

describe.skipIf(!process.env.EVAL_CALIBRATE)("judge calibration", () => {
  test("agreement with hand labels", { timeout: 600_000 }, async () => {
    const judge = process.env.EVAL_JUDGE_MODEL ?? "openai/gpt-5-mini";
    const rec = recordingFetch(judge, new Ledger(1));
    const model = openRouterModel(process.env.OPENROUTER_API_KEY ?? "", judge, rec.fetch);
    const rows = await Promise.all(
      labelled.map(async (l) => {
        const c = ALL_CASES.find((x) => x.id === l.caseId);
        if (!c) throw new Error(`unknown case ${l.caseId}`);
        const r = calibrationRecord(l, buildSeed(c.seed));
        const { items, judgeError } = await judgeTrial(
          model,
          r,
          trialEntities(r),
          c.expect.judge ?? [],
        );
        const pass = items.every((i) => i.pass);
        const failed = items.filter((i) => !i.pass);
        return {
          id: l.id,
          label: l.label,
          pass,
          agree: pass === (l.label === "pass"),
          failed,
          judgeError,
        };
      }),
    );
    for (const row of rows)
      console.log(
        `${row.agree ? "agree   " : "DISAGREE"} ${row.id} label=${row.label} judge=${row.pass ? "pass" : "fail"}${row.judgeError ? " JUDGE ERROR" : ""}` +
          row.failed.map((i) => `\n    ${i.id}: ${i.reasoning}`).join(""),
      );
    const agreed = rows.filter((r) => r.agree).length;
    console.log(
      `AGREEMENT ${agreed}/${rows.length}, cost $${(await rec.settled()).usd.toFixed(3)}`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
