// THE ONE FILESYSTEM USER in evals/ (ledgered exception, spec §9 row B):
// node:fs/promises readFile/writeFile/mkdir; evals/runs/latest/** and evals/baseline.json;
// UTF-8 JSON and Markdown; writes, never deletes; never opens .ts/.tsx.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Reporter, TestModule } from "vitest/node";
import { PLAYBOOK_VERSION } from "@/lib/ai/assistant/playbook";
import { CALIBRATION, RUBRIC_VERSION } from "./lib/judge";
import {
  containsSecret,
  promotionBlocker,
  renderReport,
  summarize,
  toBaseline,
  type Baseline,
  type ReportHeader,
} from "./lib/report";
import type { TrialMeta } from "./lib/trial";

const OUT = new URL("./runs/latest/", import.meta.url);
const BASELINE = new URL("./baseline.json", import.meta.url);

export default class EvalReporter implements Reporter {
  async onTestRunEnd(modules: ReadonlyArray<TestModule>): Promise<void> {
    const metas = modules.flatMap((m) =>
      [...m.children.allTests()]
        .map((t) => t.meta().eval)
        .filter((x): x is TrialMeta => x !== undefined),
    );
    const header: ReportHeader = {
      model: process.env.EVAL_MODEL ?? "anthropic/claude-sonnet-4.5",
      judgeModel: process.env.EVAL_JUDGE_MODEL ?? "openai/gpt-5-mini",
      playbookVersion: PLAYBOOK_VERSION,
      rubricVersion: RUBRIC_VERSION,
      gitSha: process.env.EVAL_GIT_SHA ?? "unknown",
      calibration: CALIBRATION,
      generatedAt: new Date().toISOString(),
    };
    let baseline: Baseline | null = null;
    try {
      const parsed = JSON.parse(await readFile(BASELINE, "utf8")) as Baseline;
      baseline = parsed.header ? parsed : null;
    } catch {
      baseline = null;
    }
    const results = JSON.stringify({ header, trials: metas }, null, 2);
    const report = renderReport(header, metas, baseline);
    const key = process.env.OPENROUTER_API_KEY ?? "";
    if (containsSecret(results, key) || containsSecret(report, key)) {
      process.exitCode = 1;
      throw new Error("eval output contains the API key; nothing was written");
    }
    await mkdir(OUT, { recursive: true });
    await writeFile(new URL("results.json", OUT), results);
    await writeFile(new URL("report.md", OUT), report);
    const blocker = process.env.EVAL_PROMOTE === "1" ? promotionBlocker(metas) : null;
    if (blocker) {
      process.exitCode = 1;
      console.error(`baseline not promoted: ${blocker}; baseline.json is unchanged`);
    } else if (process.env.EVAL_PROMOTE === "1") {
      await writeFile(
        BASELINE,
        `${JSON.stringify(toBaseline(header, summarize(metas)), null, 2)}\n`,
      );
    }
    console.log(`eval report: ${new URL("report.md", OUT).pathname}`);
  }
}
