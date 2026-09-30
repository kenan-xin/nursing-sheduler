import { describe, expect, it } from "vitest";

import { summarizeOptimizeRun } from "@/components/ai/use-optimize-tools";
import type { JobResponse } from "@/lib/bff/types";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { toCanonicalScenarioDocument } from "@/lib/scenario";
import {
  diffLedgers,
  preferenceSources,
  resolveLedger,
  summarizeLedger,
  type ExplainContext,
  type Ledger,
} from "./explanation";
import { INITIAL_OPTIMIZE_RUN_VIEW, reduceRunView, resolvedLedgerOf } from "./run-view";

const ctx: ExplainContext = {
  sources: [
    { ruleId: "fixed:fixed", type: "at most one shift per day", label: "fixed", hard: true },
    { ruleId: "count:Balance nights", type: "shift count", label: "Balance nights", hard: false },
    {
      ruleId: "request:Ana:2026-10-02:OFF",
      type: "shift request",
      label: "Ana OFF on 2026-10-02",
      hard: false,
    },
  ],
  people: [["P1", "Ana"]],
};

function ledger(matches: Ledger["matches"]): Ledger {
  const rules = new Map<number, { rule: number; points: number; matches: number }>();
  for (const m of matches) {
    const r = rules.get(m.rule) ?? { rule: m.rule, points: 0, matches: 0 };
    r.points += m.points;
    r.matches += 1;
    rules.set(m.rule, r);
  }
  const objective = matches.reduce((sum, m) => sum + m.points, 0);
  return {
    objective,
    balanced: true,
    terms: matches.length,
    rules: [...rules.values()],
    matches,
    truncated: false,
    seconds: 0,
  };
}

const first = ledger([
  { rule: 1, nurse: "P1", points: -16 },
  { rule: 2, nurse: "P1", date: "2026-10-02", shift: "OFF", points: 20 },
]);
const second = ledger([{ rule: 1, nurse: "P1", points: -4 }]);

describe("preferenceSources", () => {
  it("is index-aligned with the submitted preferences and gives unique ids", () => {
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    const sources = preferenceSources(doc);
    expect(sources).toHaveLength(doc.preferences.length);
    expect(new Set(sources.map((s) => s.ruleId)).size).toBe(sources.length);
    expect(sources[0]).toMatchObject({ type: "at most one shift per day", hard: true });
  });

  it("keeps a rule's id when another rule is added before it", () => {
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    const before = preferenceSources(doc).at(-1)!.ruleId;
    doc.preferences.splice(1, 0, {
      type: "shift request",
      person: "Bob",
      date: "2026-05-15",
      shiftType: "OFF",
      weight: 3,
    });
    expect(preferenceSources(doc).at(-1)!.ruleId).toBe(before);
  });
});

describe("ledger read-out", () => {
  it("names rules by id and anonymised people by their real id", () => {
    const resolved = resolveLedger(first, ctx);
    expect(resolved.matches[0]).toEqual({
      ruleId: "count:Balance nights",
      nurse: "Ana",
      date: null,
      shift: null,
      points: -16,
    });
  });

  it("summarises lost and earned points by rule, nurse and date", () => {
    const summary = summarizeLedger(resolveLedger(first, ctx));
    expect(summary).toMatchObject({ score: 4, lost: -16, earned: 20, partial: false });
    expect(summary.rules).toEqual([
      { ruleId: "count:Balance nights", label: "Balance nights", points: -16, matches: 1 },
    ]);
    expect(summary.byNurse).toEqual([{ nurse: "Ana", points: -16 }]);
  });

  it("diffs two runs by rule id", () => {
    const diff = diffLedgers(resolveLedger(first, ctx), resolveLedger(second, ctx));
    expect(diff.scoreDelta).toBe(-8);
    expect(diff.rules).toEqual([
      {
        ruleId: "request:Ana:2026-10-02:OFF",
        label: "Ana OFF on 2026-10-02",
        delta: -20,
        added: 0,
        removed: 1,
      },
      {
        ruleId: "count:Balance nights",
        label: "Balance nights",
        // Same rule, nurse, date and shift: the same match with fewer points lost.
        delta: 12,
        added: 0,
        removed: 0,
      },
    ]);
  });
});

function completedJob(explanation: Ledger): JobResponse {
  return {
    id: "opt_1",
    state: "completed",
    terminal: true,
    queue_position: null,
    created_at: "2026-09-30T00:00:00Z",
    expires_at: null,
    started_at: "2026-09-30T00:00:01Z",
    finished_at: "2026-09-30T00:00:02Z",
    request: {
      input_name: "x.yaml",
      solver: "ortools/cp-sat",
      prettify: false,
      timeout_seconds: 30,
      purpose: "ordinary",
      basis: null,
    },
    result: {
      outcome: "optimal",
      score: explanation.objective,
      solver_status: "OPTIMAL",
      termination_reason: "optimality_proven",
      explanation: { kind: "ledger", ledger: explanation },
    },
    error: null,
    controls: { cancellable: false, early_completion_available: false },
    links: {
      self: "/api/optimize/opt_1",
      events: "/api/optimize/opt_1/events",
      cancellation: "/api/optimize/opt_1/cancellation",
      early_completion: "/api/optimize/opt_1/early-completion",
      schedule: "/api/optimize/opt_1/schedule",
    },
  } as JobResponse;
}

describe("run view", () => {
  it("keeps the last run's ledger across a new submission", () => {
    let view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "submit-started",
      anonymized: true,
      peopleCount: 1,
      explainContext: ctx,
    });
    view = reduceRunView(view, { type: "job-snapshot", job: completedJob(first) });
    expect(resolvedLedgerOf(view)?.objective).toBe(4);
    view = reduceRunView(view, {
      type: "submit-started",
      anonymized: true,
      peopleCount: 1,
      explainContext: ctx,
    });
    expect(view.result).toBeNull();
    expect(view.previousLedger?.objective).toBe(4);

    view = reduceRunView(view, { type: "job-snapshot", job: completedJob(second) });
    const summary = summarizeOptimizeRun(view, true, "started");
    expect(summary.explanation?.score).toMatchObject({ score: -4, lost: -4 });
    expect(summary.explanation?.sinceLastRun?.scoreDelta).toBe(-8);
    // A stale result says nothing about the schedule now, so no breakdown either.
    expect(summarizeOptimizeRun(view, true, "started", true).explanation).toBeNull();
  });
});
