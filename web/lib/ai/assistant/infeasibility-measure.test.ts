// Opt-in measurement (bead l3m): when a schedule is infeasible, how often does the
// assistant's diagnosis end "cause unknown"?
//
// No model calls. The deterministic halves of the diagnosis run directly: the static
// check (buildFeasibilityReport) says whether a certain cause exists, and the ranked
// options' operations stand in for the candidates the model would test. Each candidate
// goes through the diagnostic path (applyAssistantCommands -> withCoverOverrides ->
// canonical -> prepareOptimizeSubmission) and the REAL solver, one at a time, stopping
// at the first feasible copy, as test_feasibility_candidates does without `compare`.
//
// Run (needs a Python with ortools; ~7 min on 32 cores, ~1 min of it the app path):
//   PYTHON=/usr/bin/python3 pnpm measure:infeasibility
// MEASURE_TIMEOUT_S (default 90, the app's per-candidate budget) and MEASURE_POOL
// (scenarios solved in parallel, default 4) tune it. Results print as JSON + a table.
//
// Parallel solves never meet the backend's per-client queue cap (JOB_MAX_PENDING_PER_CLIENT,
// default 2): each solve is its own oracle.py process calling `nurse_scheduling.schedule`
// directly, with no job server or client id. A variant that posts to a real backend
// must start it with JOB_MAX_PENDING_PER_CLIENT=0, or MEASURE_POOL > 2 gets 429s.

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import flowC from "@/evals/fixtures/flow-c-infeasible-demo.yaml?raw";
import basicInfeasible from "../../../../core/tests/testcases/basics/01_1nurse_1shift_1day_infeasible.yaml?raw";
import sgWard from "../../../../core/tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml?raw";
import ward8 from "../../../../core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml?raw";
import { applyAssistantCommands } from "@/lib/proposal/operations";
import type { AssistantCommandV1 } from "@/lib/proposal/commands";
import {
  cards,
  leave,
  nightCap,
  people,
  requirement,
  SCENARIOS,
  ward,
} from "@/lib/rules/ward-fixtures.test-support";
import {
  importScenarioYaml,
  prepareOptimizeSubmission,
  toCanonicalScenarioDocument,
  type CountCard,
  type ImportNormalizationTarget,
  type ScenarioUiState,
  type SuccessionCard,
  type UiRequestCell,
} from "@/lib/scenario";
// Direct path: the barrel re-exports repair-options and `@/lib/scenario` would cycle.
import { withCoverOverrides } from "@/lib/scenario/temporary-cover";
import { ORACLE, PYTHON } from "@/lib/scenario/differential/oracle-client";
import { MAX_DIAGNOSTIC_CANDIDATES } from "@/lib/ai/diagnostic";
import { buildFeasibilityReport, violatesSafetyFloor } from "./repair-options";
import {
  preferenceSources,
  resolveRemedies,
  type RunExplanation,
} from "@/lib/optimize/explanation";

const GATED = !!process.env.RUN_INFEASIBILITY_MEASURE;
const TIMEOUT_S = Number(process.env.MEASURE_TIMEOUT_S ?? 90);
const POOL = Number(process.env.MEASURE_POOL ?? 4);

/** The cause the scenario was built around (ground truth, not what the app sees). */
type Cause =
  | "head_count"
  | "skill_mix"
  | "count_cap"
  | "rest_rule"
  | "hard_request"
  | "leave_cluster"
  | "requirement_conflict"
  | "hours_contract";

interface Scenario {
  name: string;
  source: "scripted" | "eval_yaml" | "core_testcase" | "generated_small" | "generated_real";
  cause: Cause;
  build: () => ScenarioUiState;
}

// --- Building blocks -----------------------------------------------------------

const rest = (uid: string, pattern: string[], person: string[] = ["ALL"]): SuccessionCard => ({
  uid,
  description: uid,
  person,
  pattern,
  weight: -Infinity,
});
const cap = (uid: string, person: string[], shifts: string[], target: number): CountCard => ({
  uid,
  description: `At most ${target} ${shifts.join("/")}`,
  person,
  countDates: ["ALL"],
  countShiftTypes: shifts,
  expression: "x <= T",
  target,
  weight: Infinity,
});
const hardOff = (person: string, date: string): UiRequestCell => ({
  uid: `off-${person}-${date}`,
  person,
  date,
  kind: "off",
  weight: Infinity,
});
const never = (person: string, date: string, shiftType: string): UiRequestCell => ({
  uid: `never-${person}-${date}-${shiftType}`,
  person,
  date,
  kind: "request",
  shiftType,
  weight: -Infinity,
});
const must = (person: string, date: string, shiftType: string): UiRequestCell => ({
  uid: `must-${person}-${date}-${shiftType}`,
  person,
  date,
  kind: "request",
  shiftType,
  weight: Infinity,
});
const DAYS = ["01", "02", "03", "04", "05", "06", "07"];
const DEN = [
  { id: "D", description: "Day" },
  { id: "E", description: "Evening" },
  { id: "N", description: "Night" },
];
const noND = rest("no-day-after-night", ["N", "D"]);
const noNN = rest("no-double-night", ["N", "N"]);
const noNE = rest("no-evening-after-night", ["N", "E"]);
const noED = rest("no-day-after-evening", ["E", "D"]);
const noDN = rest("no-night-after-day", ["D", "N"]);
const max3Nights = rest("max-3-nights-in-a-row", ["N", "N", "N", "N"]);
const max5Days = rest("max-5-days-in-a-row", ["ALL", "ALL", "ALL", "ALL", "ALL", "ALL"]);
/** Two clear days after a night: a night is followed by a night or OFF, OFF. */
const recovery = rest("night-recovery", ["N", "OFF", "ALL"]);

/** The store's load step (lifecycle.ts hydrateImportTarget), with stable ids. */
function hydrate(target: ImportNormalizationTarget): ScenarioUiState {
  const withIds =
    <T extends { uid?: string }>(kind: string) =>
    (body: T, i: number) => ({
      ...body,
      uid: body.uid ?? `${kind}-${i}`,
    });
  const k = target.cardsByKind;
  return {
    ...target,
    reqData: target.reqData.map(withIds("cell")),
    cardsByKind: {
      requirements: k.requirements.map(withIds("req")),
      successions: k.successions.map(withIds("seq")),
      counts: k.counts.map(withIds("count")),
      affinities: k.affinities.map(withIds("aff")),
      coverings: k.coverings.map(withIds("cov")),
    },
  };
}

function fromYaml(text: string): ScenarioUiState {
  const imported = importScenarioYaml(text);
  if (!imported.ok) throw new Error(`YAML did not import: ${JSON.stringify(imported.issues)}`);
  return hydrate(imported.target);
}

const isoDays = (start: string, from: number, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `${start.slice(0, 8)}${String(from + i).padStart(2, "0")}`,
  );
const leaveDays = (person: string, dates: string[]): UiRequestCell[] =>
  dates.map((date) => ({ uid: `leave-${person}-${date}`, person, date, kind: "leave" }));

function editCard<K extends "requirements" | "successions" | "counts">(
  s: ScenarioUiState,
  kind: K,
  match: string,
  patch: Partial<ScenarioUiState["cardsByKind"][K][number]>,
): ScenarioUiState {
  const list = s.cardsByKind[kind] as ScenarioUiState["cardsByKind"][K];
  if (!list.some((c) => (c.description ?? "").includes(match))) throw new Error(`no ${match}`);
  return {
    ...s,
    cardsByKind: {
      ...s.cardsByKind,
      [kind]: list.map((c) => ((c.description ?? "").includes(match) ? { ...c, ...patch } : c)),
    },
  };
}
const addCells = (s: ScenarioUiState, cells: UiRequestCell[]): ScenarioUiState => ({
  ...s,
  reqData: [...s.reqData, ...cells],
});
const addSuccessions = (s: ScenarioUiState, list: SuccessionCard[]): ScenarioUiState => ({
  ...s,
  cardsByKind: { ...s.cardsByKind, successions: [...s.cardsByKind.successions, ...list] },
});

// --- The corpus -------------------------------------------------------------------

const SCRIPTED: Record<Exclude<keyof typeof SCENARIOS, "empty">, Cause> = {
  understaffedNight: "head_count",
  onlyRnOnLeave: "skill_mix",
  rnMixOnLeave: "skill_mix",
  ruleTooStrict: "count_cap",
  tooFewNurses: "head_count",
  personalCapsTooLow: "count_cap",
  conflictingRequirements: "requirement_conflict",
  busyNightsWithRestRule: "head_count",
  shortOnLeaveDay: "leave_cluster",
  restRuleTooTight: "rest_rule",
};

const small = (
  n: number,
  reqs: Record<string, number>,
  extra: Partial<ScenarioUiState> & {
    successions?: SuccessionCard[];
    counts?: CountCard[];
    requirements?: ReturnType<typeof requirement>[];
  } = {},
): ScenarioUiState => {
  const ids = Array.from({ length: n }, (_, i) => `n${i + 1}`);
  const { successions = [], counts = [], requirements = [], ...patch } = extra;
  return ward({
    shifts: DEN.filter((s) => s.id in reqs),
    staff: people(...ids),
    staffGroups: [{ id: "Nurses", members: ids }],
    cardsByKind: cards({
      requirements: [
        ...Object.entries(reqs).map(([shift, k]) => requirement(`req-${shift}`, shift, k)),
        ...requirements,
      ],
      successions,
      counts,
    }),
    ...patch,
  });
};

/** Small 7-day wards, one clash each. The solver drops any that turn out feasible. */
const GENERATED_SMALL: Scenario[] = (
  [
    // Rest-rule clashes: head count is fine every day, the sequence rules are not.
    [
      "rest-DEN-3n-quickreturn",
      "rest_rule",
      () => small(3, { D: 1, E: 1, N: 1 }, { successions: [noND, noNE, noED, max3Nights] }),
    ],
    [
      "rest-DN-3n-no-DN-max5",
      "rest_rule",
      () => small(3, { D: 1, N: 1 }, { successions: [noND, noNN, noDN, max5Days] }),
    ],
    [
      "rest-DN-4n-D2-max5",
      "rest_rule",
      () => small(4, { D: 2, N: 1 }, { successions: [noND, noNN, noDN, max5Days] }),
    ],
    [
      "rest-DN-2n-max5",
      "rest_rule",
      () => small(2, { D: 1, N: 1 }, { successions: [noND, max5Days] }),
    ],
    [
      "rest-DEN-4n-recovery",
      "rest_rule",
      () => small(4, { D: 1, E: 1, N: 1 }, { successions: [noND, noNE, noNN, recovery] }),
    ],
    // Limits against rest rules.
    [
      "cap-nights-2-recovery",
      "count_cap",
      () =>
        small(
          4,
          { D: 2, N: 1 },
          { successions: [noND, noNN, recovery], counts: [nightCap("max-nights", "Nurses", 2)] },
        ),
    ],
    [
      "cap-work-4-each",
      "count_cap",
      () => small(3, { D: 1, N: 1 }, { counts: [cap("max-shifts", ["Nurses"], ["D", "N"], 4)] }),
    ],
    [
      "cap-work-5-rest",
      "count_cap",
      () =>
        small(
          4,
          { D: 2, N: 1 },
          { successions: [noND, noNN], counts: [cap("max-shifts", ["Nurses"], ["D", "N"], 5)] },
        ),
    ],
    [
      "cap-personal-nights-rest",
      "count_cap",
      () =>
        small(
          3,
          { D: 1, N: 1 },
          {
            successions: [noND],
            counts: [
              nightCap("n1-nights", "n1", 2),
              nightCap("n2-nights", "n2", 2),
              nightCap("n3-nights", "n3", 2),
            ],
          },
        ),
    ],
    // Skill mix: enough RNs per shift, not across the rest rules.
    [
      "skill-rn-day-night-rest",
      "skill_mix",
      () =>
        small(
          5,
          { D: 2, N: 1 },
          {
            staffGroups: [
              { id: "Nurses", members: ["n1", "n2", "n3", "n4", "n5"] },
              { id: "RN", members: ["n1", "n2"] },
            ],
            requirements: [
              requirement("rn-day", "D", 1, { qualifiedPeople: ["RN"] }),
              requirement("rn-night", "N", 1, { qualifiedPeople: ["RN"] }),
            ],
            successions: [noND, noNN],
          },
        ),
    ],
    [
      "skill-mix-night-rest-leave",
      "skill_mix",
      () =>
        small(
          5,
          { D: 1 },
          {
            staffGroups: [
              { id: "Nurses", members: ["n1", "n2", "n3", "n4", "n5"] },
              { id: "RN", members: ["n1", "n2"] },
            ],
            shifts: [DEN[0], DEN[2]],
            requirements: [
              requirement("night", "N", 2, { skillMix: [{ people: "RN", minNumPeople: 1 }] }),
            ],
            reqData: [leave("n2", "03"), leave("n2", "04"), leave("n2", "05")],
            successions: [noND, noNN],
          },
        ),
    ],
    [
      "skill-mix-rn-cap",
      "skill_mix",
      () =>
        small(
          5,
          { D: 1 },
          {
            staffGroups: [
              { id: "Nurses", members: ["n1", "n2", "n3", "n4", "n5"] },
              { id: "RN", members: ["n1", "n2"] },
            ],
            shifts: [DEN[0], DEN[2]],
            requirements: [
              requirement("night", "N", 2, { skillMix: [{ people: "RN", minNumPeople: 1 }] }),
            ],
            counts: [nightCap("rn-nights", "RN", 3)],
          },
        ),
    ],
    [
      "skill-rn-leave-rest",
      "skill_mix",
      () =>
        small(
          6,
          { D: 2, N: 2 },
          {
            staffGroups: [
              { id: "Nurses", members: ["n1", "n2", "n3", "n4", "n5", "n6"] },
              { id: "RN", members: ["n1", "n2", "n3"] },
            ],
            requirements: [requirement("rn-night", "N", 1, { qualifiedPeople: ["RN"] })],
            reqData: [leave("n3", "03"), leave("n3", "04")],
            successions: [noND, noNN],
          },
        ),
    ],
    // Hard requests against rest rules or each other.
    [
      "hard-never-night-rest",
      "hard_request",
      () =>
        small(
          3,
          { D: 1, N: 1 },
          {
            reqData: DAYS.map((d) => never("n1", d, "N")),
            successions: [noND, noNN, noDN, max5Days],
          },
        ),
    ],
    [
      "hard-must-days-rest",
      "hard_request",
      () =>
        small(
          3,
          { D: 1, N: 1 },
          {
            reqData: DAYS.map((d) => must("n1", d, "D")),
            successions: [noND, noNN, max5Days],
          },
        ),
    ],
    [
      "hard-never-nights-two",
      "hard_request",
      () =>
        small(
          4,
          { D: 1, N: 1 },
          {
            reqData: [
              ...DAYS.map((d) => never("n1", d, "N")),
              ...DAYS.map((d) => never("n2", d, "N")),
              hardOff("n3", "03"),
              hardOff("n3", "04"),
            ],
            successions: [noND, noNN],
          },
        ),
    ],
    // Leave clusters: nobody is short on the day, the days around it are.
    [
      "leave-cluster-rest",
      "leave_cluster",
      () =>
        small(
          5,
          { D: 2, N: 1 },
          {
            reqData: [leave("n4", "03"), leave("n4", "04"), leave("n5", "03"), leave("n5", "04")],
            successions: [noND, noNN],
          },
        ),
    ],
    [
      "leave-cluster-cap",
      "leave_cluster",
      () =>
        small(
          4,
          { D: 1, N: 1 },
          {
            reqData: [
              leave("n3", "01"),
              leave("n3", "02"),
              leave("n3", "03"),
              leave("n4", "02"),
              leave("n4", "03"),
            ],
            counts: [nightCap("max-nights", "Nurses", 2)],
            successions: [noND, noNN],
          },
        ),
    ],
    [
      "leave-cluster-DEN",
      "leave_cluster",
      () =>
        small(
          5,
          { D: 1, E: 1, N: 1 },
          {
            reqData: ["02", "03", "04"].flatMap((d) => [leave("n4", d), leave("n5", d)]),
            successions: [noND, noNE, noED, noNN],
          },
        ),
    ],
    // Head count shortfalls the static check should catch (control group).
    [
      "head-short-weekend",
      "head_count",
      () => small(4, { D: 2, N: 2 }, { reqData: [leave("n4", "06")] }),
    ],
    ["head-short-DEN", "head_count", () => small(3, { D: 2, E: 1, N: 1 })],
  ] as const
).map(([name, cause, build]) => ({ name, source: "generated_small", cause, build }));

/** Variants of the two real 28-day wards in core/tests/testcases/real. */
const GENERATED_REAL: Scenario[] = [
  // Paid leave pays hours but supplies no cover: the exact-hours identity breaks.
  {
    name: "sg-leave-3-days",
    cause: "leave_cluster",
    build: () => addCells(fromYaml(sgWard), leaveDays("N11", isoDays("2026-09-01", 8, 3))),
  },
  {
    name: "sg-leave-cluster-3-nurses",
    cause: "leave_cluster",
    build: () =>
      addCells(
        fromYaml(sgWard),
        ["N08", "N11", "N12"].flatMap((p) => leaveDays(p, isoDays("2026-09-01", 14, 2))),
      ),
  },
  {
    name: "sg-night-fairness-5",
    cause: "count_cap",
    build: () => editCard(fromYaml(sgWard), "counts", "exactly six nights", { target: 5 }),
  },
  {
    name: "sg-hours-150h",
    cause: "hours_contract",
    build: () => editCard(fromYaml(sgWard), "counts", "contracted hours", { target: 300 }),
  },
  {
    name: "sg-max-2-nights-in-a-row",
    cause: "rest_rule",
    build: () =>
      editCard(fromYaml(sgWard), "successions", "At most three consecutive nights", {
        pattern: ["N", "N", "N"],
      }),
  },
  {
    name: "sg-never-nights-one-nurse",
    cause: "hard_request",
    build: () =>
      addCells(
        fromYaml(sgWard),
        isoDays("2026-09-01", 1, 28).map((d) => never("N12", d, "N")),
      ),
  },
  {
    name: "sg-recovery-3-days",
    cause: "rest_rule",
    build: () =>
      addSuccessions(fromYaml(sgWard), [rest("sg-third-clear-day", ["N", "OFF", "OFF", "ALL"])]),
  },
  {
    name: "w8-senior-hard-offs-weekend",
    cause: "hard_request",
    build: () =>
      addCells(
        fromYaml(ward8),
        [
          "SSN-Siti",
          "SSN-MeiLing",
          "SSN-Priya",
          "SSN-Kavitha",
          "SSN-Aishah",
          "SSN-WeiLing",
          "SSN-Devi",
        ].flatMap((p) => isoDays("2026-10-01", 17, 2).map((d) => hardOff(p, d))),
      ),
  },
  {
    name: "sg-night-4",
    cause: "head_count",
    build: () =>
      editCard(fromYaml(sgWard), "requirements", "Night establishment", { requiredNumPeople: 4 }),
  },
  {
    name: "w8-senior-leave-cluster",
    cause: "skill_mix",
    build: () =>
      addCells(
        fromYaml(ward8),
        [
          "SSN-Siti",
          "SSN-MeiLing",
          "SSN-Priya",
          "SSN-Kavitha",
          "SSN-Aishah",
          "SSN-WeiLing",
          "SSN-Devi",
          "SSN-Farah",
        ].flatMap((p) => leaveDays(p, isoDays("2026-10-01", 10, 4))),
      ),
  },
  {
    name: "w8-four-seniors-per-night",
    cause: "skill_mix",
    build: () =>
      editCard(fromYaml(ward8), "requirements", "One of the four night nurses", {
        requiredNumPeople: 4,
      }),
  },
  {
    name: "w8-max-2-nights-rest",
    cause: "rest_rule",
    build: () =>
      addSuccessions(fromYaml(ward8), [
        rest("w8-max-2-nights", ["AllNights", "AllNights", "AllNights"]),
        rest("w8-max-4-days", ["ALL", "ALL", "ALL", "ALL", "ALL"]),
      ]),
  },
  {
    name: "w8-nights-5",
    cause: "head_count",
    build: () =>
      editCard(fromYaml(ward8), "requirements", "The night needs at least 3", {
        requiredNumPeople: 9,
      }),
  },
].map((s) => ({ ...s, source: "generated_real" as const, cause: s.cause as Cause }));

const CORPUS: Scenario[] = [
  ...Object.entries(SCRIPTED).map(([name, cause]) => ({
    name,
    source: "scripted" as const,
    cause,
    build: SCENARIOS[name as keyof typeof SCRIPTED],
  })),
  {
    name: "flow-c-infeasible-demo",
    source: "eval_yaml",
    cause: "head_count",
    build: () => fromYaml(flowC),
  },
  {
    name: "core-1nurse-1shift-infeasible",
    source: "core_testcase",
    cause: "head_count",
    build: () => fromYaml(basicInfeasible),
  },
  ...GENERATED_SMALL,
  ...GENERATED_REAL,
];

// --- The solver --------------------------------------------------------------------

type SolveStatus = "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | "MODEL_INVALID" | "ERROR";
interface Solve {
  status: SolveStatus;
  seconds: number;
  error?: string;
  explanation?: RunExplanation;
}

function toYaml(state: ScenarioUiState): string {
  const prep = prepareOptimizeSubmission(toCanonicalScenarioDocument(withCoverOverrides(state)), {
    anonymize: false,
  });
  if (!prep.ok) throw new Error(`not submittable: ${JSON.stringify(prep.issues)}`);
  return prep.prep.yaml;
}

/** One real CP-SAT run through the differential oracle, as a job with `timeout_seconds`. */
function solve(yaml: string, explain = false): Promise<Solve> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [ORACLE], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      try {
        const res = JSON.parse(out) as {
          ok: boolean;
          status?: SolveStatus;
          seconds?: number;
          error?: string;
          explanation?: RunExplanation;
        };
        resolve(
          res.ok
            ? { status: res.status!, seconds: res.seconds!, explanation: res.explanation }
            : { status: "ERROR", seconds: 0, error: res.error },
        );
      } catch {
        resolve({ status: "ERROR", seconds: 0, error: err.slice(-300) || out.slice(-300) });
      }
    });
    child.stdin.end(JSON.stringify({ op: "schedule", yaml, timeout: TIMEOUT_S, explain }));
  });
}

const found = (s: Solve) => s.status === "OPTIMAL" || s.status === "FEASIBLE";

// --- One diagnosis -------------------------------------------------------------------

type Verdict =
  | "excluded_feasible"
  | "excluded_baseline_unknown"
  | "excluded_not_submittable"
  | "certain"
  | "fix_found"
  | "unknown_all_infeasible"
  | "unknown_inconclusive"
  | "unknown_no_candidates";

interface Row {
  name: string;
  source: Scenario["source"];
  cause: Cause;
  verdict: Verdict;
  findings: string[];
  baseline: Solve;
  candidates: { repairId: string; target: string; skipped?: string; solve?: Solve }[];
  /** Solver seconds the diagnosis spent on candidate copies (sequential, as in the app). */
  diagnosisSeconds: number;
  /**
   * Unknown rows only, NOT an app path: the hard rules whose softening ALONE makes the
   * copy feasible, trying every one. An upper bound on what a solver-backed explanation
   * naming one culprit rule could offer. Null when not run.
   */
  singleRuleFixes: { fixes: string[]; tried: number; inconclusive: number; seconds: number } | null;
}

/** Every single-rule softening: each hard sequence rule, each hard count, each nurse's hard requests. */
function singleRuleRelaxations(state: ScenarioUiState): { label: string; next: ScenarioUiState }[] {
  const soft = (w: number) => (w > 0 ? 10 : -10);
  const out: { label: string; next: ScenarioUiState }[] = [];
  const k = state.cardsByKind;
  for (const kind of ["successions", "counts"] as const) {
    for (const card of k[kind]) {
      // A contracted-hours count must stay hard (the backend rejects a finite weight).
      if (card.disabled || Number.isFinite(card.weight) || ("tag" in card && card.tag)) continue;
      out.push({
        label: `${kind}:${card.description ?? card.uid}`,
        next: {
          ...state,
          cardsByKind: {
            ...k,
            [kind]: k[kind].map((c) => (c === card ? { ...c, weight: soft(c.weight) } : c)),
          },
        },
      });
    }
  }
  const hardBy = new Set(
    state.reqData
      .filter((c) => c.kind !== "leave" && !Number.isFinite(c.weight))
      .map((c) => String(c.person)),
  );
  for (const person of hardBy) {
    out.push({
      label: `requests:${person}`,
      next: {
        ...state,
        reqData: state.reqData.map((c) =>
          c.kind !== "leave" && String(c.person) === person && !Number.isFinite(c.weight)
            ? { ...c, weight: soft(c.weight) }
            : c,
        ),
      },
    });
  }
  return out;
}

/**
 * a5pb arm (A5PB_WITNESS=1): the baseline run also returns the solver's proven remedies,
 * which the report ranks first (evidence solver_witness), as the app does.
 */
const WITNESS = !!process.env.A5PB_WITNESS;

function witnessFor(state: ScenarioUiState, baseline: Solve) {
  const e = baseline.explanation;
  if (!WITNESS || e?.kind !== "infeasible" || !e.fixes) return null;
  const sources = preferenceSources(toCanonicalScenarioDocument(withCoverOverrides(state)));
  return resolveRemedies(e.fixes, { sources, people: [] });
}

async function diagnose(s: Scenario): Promise<Row> {
  const state = s.build();
  let yaml: string;
  try {
    yaml = toYaml(state);
  } catch {
    // A scenario the producer now rejects (e.g. preferred below required, C1) is not a run.
    const none: Solve = { status: "ERROR", seconds: 0 };
    return {
      name: s.name,
      source: s.source,
      cause: s.cause,
      verdict: "excluded_not_submittable",
      findings: [],
      baseline: none,
      candidates: [],
      diagnosisSeconds: 0,
      singleRuleFixes: null,
    };
  }
  const baseline = await solve(yaml, WITNESS);
  const witness = witnessFor(state, baseline);
  const report = buildFeasibilityReport(state, true, witness);
  const e = baseline.explanation;
  if (e?.kind === "infeasible") {
    // a5pb: what the backend explained, next to what reached the options.
    const solverWitness = report.options.filter((o) => o.evidence === "solver_witness").length;
    console.log(
      `a5pb ${s.name}: proof=${e.proof} core=${e.core ? e.core.members.map((m) => m.kind).join(",") : "none"} ` +
        `fixable=${e.fixes?.fixable} remedies=${JSON.stringify(e.fixes?.remedies.map((r) => [r.cost, r.members.map((m) => m.kind)]))} ` +
        `witnessOptions=${solverWitness}`,
    );
  }
  const row: Row = {
    name: s.name,
    source: s.source,
    cause: s.cause,
    verdict: "certain",
    findings: report.findings,
    baseline,
    candidates: [],
    diagnosisSeconds: 0,
    singleRuleFixes: null,
  };
  if (found(baseline)) return { ...row, verdict: "excluded_feasible" };
  if (baseline.status !== "INFEASIBLE") return { ...row, verdict: "excluded_baseline_unknown" };

  // The options' operations are the candidates, most promising first, at most five.
  let fixed = false;
  let inconclusive = false;
  for (const option of report.options
    .filter((o) => o.operations.length > 0)
    .slice(0, MAX_DIAGNOSTIC_CANDIDATES)) {
    const ops = option.operations as AssistantCommandV1[];
    // What the copy changes: the rule or person each operation touches.
    const target = [
      ...new Set(
        ops.map((op) =>
          "ruleId" in op ? op.ruleId : "personId" in op ? String(op.personId) : op.type,
        ),
      ),
    ].join("+");
    const refused = violatesSafetyFloor(state, ops, { leaveAsked: true });
    const applied = applyAssistantCommands(state, ops);
    if (refused || !applied.ok) {
      row.candidates.push({
        repairId: option.repairId,
        target,
        skipped: refused ?? (applied.ok ? "" : applied.rejection.message),
      });
      continue;
    }
    const result = await solve(toYaml(applied.next));
    row.candidates.push({ repairId: option.repairId, target, solve: result });
    row.diagnosisSeconds += result.seconds;
    if (found(result)) {
      fixed = true;
      break;
    }
    if (result.status !== "INFEASIBLE") inconclusive = true;
  }
  const tested = row.candidates.some((c) => c.solve);
  if (report.findings.length > 0) return row;
  if (!fixed) {
    const probe = { fixes: [] as string[], tried: 0, inconclusive: 0, seconds: 0 };
    for (const { label, next } of singleRuleRelaxations(state)) {
      const result = await solve(toYaml(next));
      probe.tried += 1;
      probe.seconds += result.seconds;
      if (found(result)) probe.fixes.push(label);
      else if (result.status !== "INFEASIBLE") probe.inconclusive += 1;
    }
    row.singleRuleFixes = probe;
  }
  return {
    ...row,
    verdict: fixed
      ? "fix_found"
      : !tested
        ? "unknown_no_candidates"
        : inconclusive
          ? "unknown_inconclusive"
          : "unknown_all_infeasible",
  };
}

async function pool<T, R>(items: T[], size: number, run: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

/**
 * The three rates over confirmed-infeasible rows, by cause and by source. Time is the
 * solver seconds a user waits: the failed run plus the candidate copies, in sequence.
 */
function rates(rows: Row[]): string {
  const kept = rows.filter((r) => !r.verdict.startsWith("excluded"));
  const pct = (n: number, d: number) => `${n} (${d ? Math.round((100 * n) / d) : 0}%)`;
  const line = (label: string, rs: Row[]) => {
    const n = (v: (r: Row) => boolean) => rs.filter(v).length;
    const unknown = n((r) => r.verdict.startsWith("unknown"));
    const split = ["unknown_all_infeasible", "unknown_inconclusive", "unknown_no_candidates"]
      .map((v) => n((r) => r.verdict === v))
      .join("/");
    const oracleFix = n((r) => (r.singleRuleFixes?.fixes.length ?? 0) > 0);
    const secs = rs.map((r) => r.baseline.seconds + r.diagnosisSeconds).sort((a, b) => a - b);
    const median = secs[Math.floor(secs.length / 2)] ?? 0;
    const cells = [
      label,
      rs.length,
      pct(
        n((r) => r.verdict === "certain"),
        rs.length,
      ),
      pct(
        n((r) => r.verdict === "fix_found"),
        rs.length,
      ),
      pct(unknown, rs.length),
      split,
      `${oracleFix}/${unknown}`,
      `${median.toFixed(1)} / ${(secs.at(-1) ?? 0).toFixed(1)}`,
    ];
    return `| ${cells.join(" | ")} |`;
  };
  const by = (key: "cause" | "source") => [
    `| ${key} | n | certain | fix found | unknown | unknown split (all infeasible/inconclusive/no candidates) | unknown with a single-rule fix | solver s median / max |`,
    "|---|---|---|---|---|---|---|---|",
    ...[...new Set(kept.map((r) => r[key]))].sort().map((v) =>
      line(
        v,
        kept.filter((r) => r[key] === v),
      ),
    ),
    line("**all**", kept),
    "",
  ];
  return [
    ...by("cause"),
    ...by("source"),
    `\nExcluded: ${rows.length - kept.length} (${
      rows
        .filter((r) => r.verdict.startsWith("excluded"))
        .map((r) => `${r.name}: ${r.verdict}`)
        .join(", ") || "none"
    })`,
  ].join("\n");
}

const oracle = (r: Row) =>
  r.singleRuleFixes
    ? `${r.singleRuleFixes.fixes.length}/${r.singleRuleFixes.tried}${r.singleRuleFixes.inconclusive ? ` (${r.singleRuleFixes.inconclusive} inconclusive)` : ""}: ${r.singleRuleFixes.fixes.join("; ") || "none"}`
    : "-";

function table(rows: Row[]): string {
  const lines = [
    "| scenario | source | cause | verdict | findings | baseline | candidates | diag s | single-rule fixes (oracle) |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const cands = r.candidates
      .map(
        (c) =>
          `${c.repairId}[${c.target}]:${c.solve ? `${c.solve.status}(${c.solve.seconds}s)` : "skipped"}`,
      )
      .join(", ");
    lines.push(
      `| ${r.name} | ${r.source} | ${r.cause} | ${r.verdict} | ${r.findings.length} | ${r.baseline.status}(${r.baseline.seconds}s) | ${cands || "-"} | ${r.diagnosisSeconds.toFixed(1)} | ${oracle(r)} |`,
    );
  }
  return lines.join("\n");
}

describe.skipIf(!GATED)("infeasibility diagnosis outcomes (l3m measurement)", () => {
  it("every corpus scenario builds and reaches the solver as YAML", () => {
    for (const s of CORPUS) expect(toYaml(s.build()), s.name).toContain("preferences:");
  });

  it(
    "classifies each confirmed-infeasible scenario as certain, fix found or cause unknown",
    async () => {
      const started = Date.now();
      const rows = await pool(CORPUS, POOL, diagnose);
      const wallSeconds = Math.round((Date.now() - started) / 1000);
      console.log(
        JSON.stringify({ timeoutSeconds: TIMEOUT_S, pool: POOL, wallSeconds, rows }, null, 2),
      );
      console.log(table(rows));
      console.log(rates(rows));
      expect(
        rows.every((r) => r.baseline.status !== "ERROR"),
        table(rows),
      ).toBe(true);
    },
    24 * 60 * 60 * 1000,
  );
});
