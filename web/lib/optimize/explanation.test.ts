import { describe, expect, it } from "vitest";

import { summarizeOptimizeRun } from "@/components/ai/use-optimize-tools";
import type { JobResponse } from "@/lib/bff/types";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { toCanonicalScenarioDocument } from "@/lib/scenario";
import { preferenceCardUids } from "@/lib/scenario/canonical";
import {
  coreText,
  diffLedgers,
  preferenceSources,
  resolveCore,
  resolveLedger,
  summarizeLedger,
  type ExplainContext,
  type InfeasibleCore,
  type Ledger,
  type RunExplanation,
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
  it("names each submitted rule by its card uid, index-aligned", () => {
    const state = makeValidUiState();
    const doc = toCanonicalScenarioDocument(state);
    const sources = preferenceSources(doc, preferenceCardUids(state));
    expect(sources).toHaveLength(doc.preferences.length);
    expect(sources.map((s) => s.ruleId)).toEqual(["fixed:one per day", "r1", "c1", "c2", "c3"]);
    expect(sources[0]).toMatchObject({ type: "at most one shift per day", hard: true });
  });

  it("keeps a rule's id when the rule is renamed or another rule is added before it", () => {
    const state = makeValidUiState();
    const before = preferenceSources(toCanonicalScenarioDocument(state), preferenceCardUids(state));
    state.cardsByKind.requirements[0]!.description = "Renamed";
    state.cardsByKind.requirements.unshift({
      uid: "r0",
      shiftType: "N",
      requiredNumPeople: 1,
      qualifiedPeople: "ALL",
      date: "ALL",
      weight: -1,
    });
    const after = preferenceSources(toCanonicalScenarioDocument(state), preferenceCardUids(state));
    expect(after.find((s) => s.ruleId === "r1")).toMatchObject({ label: "Renamed" });
    expect(after.at(-1)!.ruleId).toBe(before.at(-1)!.ruleId);
  });

  it("falls back to the cell or the label without uids", () => {
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    const sources = preferenceSources(doc);
    expect(new Set(sources.map((s) => s.ruleId)).size).toBe(sources.length);
    expect(sources.at(-1)!.ruleId).toBe("request:Bob:2026-05-16:OFF");
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

const core: InfeasibleCore = {
  members: [
    { rule: 1, kind: "staffing", date: "2026-11-03", shift: ["N"], need: 1 },
    { rule: 2, kind: "leave", nurse: "P1", date: "2026-11-03", shift: ["LEAVE"] },
  ],
  minimal: true,
  solves: 3,
  guards: 4,
  seconds: 0.01,
};

describe("infeasibility core", () => {
  it("names rules by id and people by their real id, in one sentence per date", () => {
    const members = resolveCore(core, ctx);
    expect(members[1]).toMatchObject({ ruleId: "request:Ana:2026-10-02:OFF", nurse: "Ana" });
    expect(coreText(members)).toBe(
      "These cannot all hold. On 2026-11-03: 1 needed on N; Ana is on leave.",
    );
  });
});

function completedJob(
  explanation: Ledger | RunExplanation,
  outcome: "optimal" | "infeasible" = "optimal",
): JobResponse {
  const wrapped: RunExplanation =
    "kind" in explanation ? explanation : { kind: "ledger", ledger: explanation };
  const infeasible = outcome === "infeasible";
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
      outcome,
      score: wrapped.kind === "ledger" ? wrapped.ledger.objective : null,
      solver_status: infeasible ? "INFEASIBLE" : "OPTIMAL",
      termination_reason: infeasible ? "infeasibility_proven" : "optimality_proven",
      explanation: wrapped,
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

  it("gives the assistant the proven clash and tells it the cause is solver-proven", () => {
    let view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "submit-started",
      anonymized: true,
      peopleCount: 1,
      explainContext: ctx,
    });
    view = reduceRunView(view, {
      type: "job-snapshot",
      job: completedJob({ kind: "infeasible", proof: "main_run", core }, "infeasible"),
    });
    const summary = summarizeOptimizeRun(view, false, "started");
    expect(summary.explanation?.why?.text).toContain("Ana is on leave");
    expect(summary.guidance).toContain("PROVED");

    view = reduceRunView(view, {
      type: "job-snapshot",
      job: completedJob({ kind: "infeasible", proof: "main_run", core: null }, "infeasible"),
    });
    expect(summarizeOptimizeRun(view, false, "started").guidance).toContain("does not");
  });
});
