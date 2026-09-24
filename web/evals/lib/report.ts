// Trial metadata in, Markdown and a small committed baseline out. Pure.
import { passHatK } from "./reliability";
import type { TrialMeta } from "./trial";

export interface ReportHeader {
  model: string;
  judgeModel: string;
  playbookVersion: string;
  rubricVersion: string;
  gitSha: string;
  calibration: string | null;
  generatedAt: string;
}
export interface CaseSummary {
  id: string;
  tags: string[];
  trials: number;
  passes: number;
  skipped: number;
  safetyFailures: number;
  usd: number;
  meanHops: number;
}
export interface Baseline {
  header: ReportHeader;
  /** Why no row is a pass/fail reference; only `usd / trials` is used, to plan the budget. */
  provisional?: string;
  cases: Record<string, { passes: number; trials: number; safetyFailures: number; usd: number }>;
}

export function summarize(metas: TrialMeta[]): CaseSummary[] {
  const byCase = new Map<string, TrialMeta[]>();
  for (const m of metas) byCase.set(m.caseId, [...(byCase.get(m.caseId) ?? []), m]);
  return [...byCase.entries()].map(([id, all]) => {
    const ran = all.filter((m) => m.skipped === null);
    return {
      id,
      tags: all[0]?.tags ?? [],
      trials: ran.length,
      passes: ran.filter((m) => m.pass).length,
      skipped: all.length - ran.length,
      safetyFailures: ran.filter((m) => !m.safetyPass).length,
      usd: ran.reduce((sum, m) => sum + m.usage.usd, 0),
      meanHops: ran.length ? ran.reduce((sum, m) => sum + m.hops, 0) / ran.length : 0,
    };
  });
}

export function isRegression(
  now: CaseSummary,
  then: Baseline["cases"][string] | undefined,
): boolean {
  if (!then || now.trials === 0) return false;
  if (now.safetyFailures > 0 && then.safetyFailures === 0) return true;
  const lost = (then.passes / then.trials) * now.trials - now.passes;
  return lost >= 2 - 1e-9;
}

/** Why this run must not become the baseline, or null. A partial run hides regressions. */
export function promotionBlocker(metas: TrialMeta[]): string | null {
  const skipped = metas.filter((m) => m.skipped !== null).length;
  const errored = metas.filter((m) => m.error !== null).length;
  return skipped || errored
    ? `${skipped} skipped and ${errored} errored trial(s); only a complete run is promoted`
    : null;
}

export function toBaseline(header: ReportHeader, summaries: CaseSummary[]): Baseline {
  return {
    header,
    cases: Object.fromEntries(
      summaries
        .filter((s) => s.trials > 0)
        .map((s) => [
          s.id,
          { passes: s.passes, trials: s.trials, safetyFailures: s.safetyFailures, usd: s.usd },
        ]),
    ),
  };
}

export function containsSecret(text: string, secret: string): boolean {
  return secret.length > 0 && text.includes(secret);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function renderReport(
  header: ReportHeader,
  metas: TrialMeta[],
  baseline: Baseline | null,
): string {
  const summaries = summarize(metas);
  const withTrials = summaries.filter((s) => s.trials > 0);
  const mean = (f: (s: CaseSummary) => number) =>
    withTrials.length ? withTrials.reduce((sum, s) => sum + f(s), 0) / withTrials.length : 0;
  const usd = summaries.reduce((sum, s) => sum + s.usd, 0);
  const estimated = metas.some((m) => m.usage.estimated);
  const lines = [
    "# Assistant eval report",
    "",
    `Model ${header.model}, judge ${header.judgeModel}, playbook ${header.playbookVersion}, rubric ${header.rubricVersion}, git ${header.gitSha}, ${header.generatedAt}.`,
    `Cost $${usd.toFixed(2)}${estimated ? " (partly estimated)" : ""}. Judge calibration: ${header.calibration ?? "not calibrated yet"}.`,
    "With 3 trials, a drop of one pass is noise.",
    ...(baseline?.provisional
      ? [`The baseline is provisional, so no case is compared: ${baseline.provisional}`]
      : []),
    "",
    "| Suite | pass^1 | pass^k | safety failures | mean hops |",
    "|---|---|---|---|---|",
    `| all | ${pct(mean((s) => passHatK(s.trials, s.passes, 1)))} | ${pct(mean((s) => passHatK(s.trials, s.passes, s.trials)))} | ${summaries.reduce((n, s) => n + s.safetyFailures, 0)} | ${mean((s) => s.meanHops).toFixed(1)} |`,
    "",
    "| Case | passes | pass^k | vs baseline | safety | $ |",
    "|---|---|---|---|---|---|",
  ];
  for (const s of summaries) {
    const then = baseline?.provisional ? undefined : baseline?.cases[s.id];
    const trend = then
      ? `${then.passes}/${then.trials} → ${s.passes}/${s.trials}${isRegression(s, then) ? " REGRESSION" : ""}`
      : "new";
    const k = s.trials ? pct(passHatK(s.trials, s.passes, s.trials)) : "skipped";
    lines.push(
      `| ${s.id} | ${s.passes}/${s.trials} | ${k} | ${trend} | ${s.safetyFailures} | ${s.usd.toFixed(3)} |`,
    );
  }
  lines.push("", "## Failures", "");
  for (const m of metas.filter((x) => !x.pass && x.skipped === null)) {
    const failed = [
      ...m.gates.filter((g) => !g.pass).map((g) => `${g.gate}: ${g.detail}`),
      ...m.judge.filter((j) => !j.pass).map((j) => `judge ${j.id}: ${j.reasoning}`),
    ];
    lines.push(`### ${m.caseId} trial ${m.trial + 1}`, "", ...failed.map((f) => `- ${f}`), "");
    const transcript = m.transcript
      .map((t) => `${t.role}: ${t.text}${t.toolCalls.map((c) => ` [${c.name}]`).join("")}`)
      .join("\n");
    lines.push(
      "<details><summary>Transcript</summary>",
      "",
      "```",
      transcript,
      "```",
      "</details>",
      "",
    );
  }
  return lines.join("\n");
}
