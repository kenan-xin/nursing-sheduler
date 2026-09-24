import { describe, expect, it } from "vitest";
import type { TrialMeta } from "./trial";
import {
  containsSecret,
  isRegression,
  renderReport,
  summarize,
  toBaseline,
  type ReportHeader,
} from "./report";

const header: ReportHeader = {
  model: "m",
  judgeModel: "j",
  playbookVersion: "p",
  rubricVersion: "r",
  gitSha: "abc",
  calibration: null,
  generatedAt: "2026-09-24T00:00:00Z",
};

function meta(
  caseId: string,
  trial: number,
  pass: boolean,
  extra: Partial<TrialMeta> = {},
): TrialMeta {
  return {
    caseId,
    trial,
    tags: ["smoke"],
    transcript: [{ role: "user", text: "hi", toolCalls: [] }],
    choices: [],
    proposals: [],
    appliedByHarness: 0,
    navigations: [],
    usage: { inputTokens: 10, outputTokens: 5, usd: 0.01, estimated: false },
    hops: 2,
    ms: 100,
    error: null,
    gates: [{ gate: "tools", pass, detail: pass ? "ok" : "missing offer_choices" }],
    judge: [],
    pass,
    safetyPass: true,
    skipped: null,
    ...extra,
  };
}

describe("report", () => {
  it("summarises per case and leaves budget-skipped trials out of the count", () => {
    const [s] = summarize([
      meta("a", 0, true),
      meta("a", 1, false),
      meta("a", 2, false, { skipped: "budget" }),
    ]);
    expect(s).toMatchObject({ id: "a", trials: 2, passes: 1, skipped: 1 });
  });

  it("flags a loss of two passes or a new safety failure", () => {
    const now = {
      id: "a",
      tags: [],
      trials: 3,
      passes: 1,
      skipped: 0,
      safetyFailures: 0,
      usd: 0,
      meanHops: 0,
    };
    expect(isRegression(now, { passes: 3, trials: 3, safetyFailures: 0, usd: 0 })).toBe(true);
    expect(isRegression(now, { passes: 2, trials: 3, safetyFailures: 0, usd: 0 })).toBe(false);
    expect(
      isRegression(
        { ...now, passes: 3, safetyFailures: 1 },
        { passes: 3, trials: 3, safetyFailures: 0, usd: 0 },
      ),
    ).toBe(true);
    expect(isRegression(now, undefined)).toBe(false);
  });

  it("renders the suite table, the baseline arrow and the failing gate", () => {
    const metas = [meta("a", 0, true), meta("a", 1, false)];
    const baseline = toBaseline(header, summarize([meta("a", 0, true), meta("a", 1, true)]));
    const md = renderReport(header, metas, baseline);
    expect(md).toContain("| a | 1/2 |");
    expect(md).toContain("2/2 → 1/2");
    expect(md).toContain("missing offer_choices");
    expect(md).toContain("<details>");
  });

  it("finds the secret anywhere in the text", () => {
    expect(containsSecret('{"k":"sk-or-v1-abc"}', "sk-or-v1-abc")).toBe(true);
    expect(containsSecret("clean", "sk-or-v1-abc")).toBe(false);
    expect(containsSecret("anything", "")).toBe(false);
  });
});
