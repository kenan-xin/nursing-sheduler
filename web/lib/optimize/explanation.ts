// Run explanations from the backend (bead a5pb, experimental): the penalty ledger of a
// solved roster, resolved to rule ids and real people, summarised for the assistant,
// and diffed against the previous run. The backend names rules by preference index
// and people by submitted (maybe anonymised) id; this module maps both back.

import type { PeopleReverseMap } from "@/lib/scenario/prepare-optimize-submission";
import {
  PREFERENCE_TYPE,
  type CanonicalPreference,
  type CanonicalScenarioDocument,
} from "@/lib/scenario/types";

/** One non-zero objective term: points = weight x value (the objective is maximised). */
export interface LedgerMatch {
  rule: number;
  nurse?: string | number;
  date?: string;
  shift?: string;
  points: number;
}

export interface Ledger {
  objective: number;
  balanced: boolean;
  terms: number;
  rules: { rule: number; points: number; matches: number }[];
  matches: LedgerMatch[];
  truncated: boolean;
  seconds: number;
}

/** One hard rule unit in an infeasibility core: a request cell, a staffing slot, a nurse's cap... */
export interface CoreMember {
  rule: number;
  kind:
    | "request"
    | "leave"
    | "staffing"
    | "skill_mix"
    | "qualification"
    | "cap"
    | "count_floor"
    | "contracted_hours"
    | "succession"
    | "covering"
    | "affinity"
    | "other";
  nurse?: string | number;
  date?: string;
  shift?: string[];
  need?: number;
  expression?: string;
  target?: number;
}

export interface InfeasibleCore {
  members: CoreMember[];
  /** Every member proven necessary within the time budget. */
  minimal: boolean;
  solves: number;
  seconds: number;
}

export type RunExplanation =
  | { kind: "ledger"; ledger: Ledger }
  | {
      kind: "infeasible";
      /** `main_run`, or `feasibility_check:<s>` when a no-objective check proved it. */
      proof: string;
      /** Null when the core solve ran out of time: the run is still proven infeasible. */
      core: InfeasibleCore | null;
    };

/** What a preference index stands for in the submitted document. */
export interface RuleSource {
  ruleId: string;
  type: CanonicalPreference["type"];
  label: string;
  hard: boolean;
}

/** Captured at submit: the rule map and the anonymised-to-real people map. */
export interface ExplainContext {
  sources: RuleSource[];
  people: PeopleReverseMap;
}

const SHORT_TYPE: Record<CanonicalPreference["type"], string> = {
  [PREFERENCE_TYPE.maxOneShiftPerDay]: "fixed",
  [PREFERENCE_TYPE.shiftTypeRequirement]: "requirement",
  [PREFERENCE_TYPE.shiftRequest]: "request",
  [PREFERENCE_TYPE.shiftTypeSuccessions]: "succession",
  [PREFERENCE_TYPE.shiftCount]: "count",
  [PREFERENCE_TYPE.shiftAffinity]: "affinity",
  [PREFERENCE_TYPE.shiftTypeCovering]: "covering",
};

const text = (value: unknown): string =>
  Array.isArray(value) ? value.map(text).join("+") : String(value);

function labelOf(pref: CanonicalPreference): string {
  if (pref.description) return pref.description;
  switch (pref.type) {
    case PREFERENCE_TYPE.shiftRequest:
      return `${text(pref.person)} ${text(pref.shiftType)} on ${text(pref.date)}`;
    case PREFERENCE_TYPE.shiftTypeRequirement:
      return `${pref.requiredNumPeople} on ${text(pref.shiftType)}`;
    case PREFERENCE_TYPE.shiftCount:
      return `${text(pref.person)} ${text(pref.expression)} ${text(pref.target)}`;
    case PREFERENCE_TYPE.shiftTypeSuccessions:
      return `${text(pref.person)} pattern ${text(pref.pattern)}`;
    default:
      return SHORT_TYPE[pref.type];
  }
}

/**
 * Stable rule ids for the submitted document, index-aligned with `preferences`.
 * A request is named by its cell (person, date, shift); a card by its type and
 * label, with `#n` on repeats. Ids survive edits to other rules, so two runs'
 * ledgers can be diffed (a raw index shifts when a rule is added before it).
 */
export function preferenceSources(doc: CanonicalScenarioDocument): RuleSource[] {
  const seen = new Map<string, number>();
  // `?? []`: injected test documents may carry no preferences.
  return (doc.preferences ?? []).map((pref) => {
    const label = labelOf(pref);
    const base =
      pref.type === PREFERENCE_TYPE.shiftRequest
        ? `request:${text(pref.person)}:${text(pref.date)}:${text(pref.shiftType)}`
        : `${SHORT_TYPE[pref.type]}:${label}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const weight = "weight" in pref ? pref.weight : Infinity;
    return {
      ruleId: n === 1 ? base : `${base}#${n}`,
      type: pref.type,
      label,
      hard: !Number.isFinite(weight),
    };
  });
}

/** A ledger match named by rule id and real person. */
export interface ResolvedMatch {
  ruleId: string;
  nurse: string | null;
  date: string | null;
  shift: string | null;
  points: number;
}

export interface ResolvedLedger {
  objective: number;
  truncated: boolean;
  rules: { ruleId: string; label: string; points: number; matches: number }[];
  matches: ResolvedMatch[];
}

function realPerson(people: PeopleReverseMap): (id: string | number | undefined) => string | null {
  const map = new Map(people.map(([anon, original]) => [anon, String(original)]));
  return (id) => (id === undefined ? null : (map.get(String(id)) ?? String(id)));
}

export function resolveLedger(ledger: Ledger, ctx: ExplainContext): ResolvedLedger {
  const source = (rule: number) =>
    ctx.sources[rule] ?? { ruleId: `rule#${rule}`, label: `rule ${rule}` };
  const person = realPerson(ctx.people);
  return {
    objective: ledger.objective,
    truncated: ledger.truncated,
    rules: ledger.rules.map((r) => ({
      ruleId: source(r.rule).ruleId,
      label: source(r.rule).label,
      points: r.points,
      matches: r.matches,
    })),
    matches: ledger.matches.map((m) => ({
      ruleId: source(m.rule).ruleId,
      nurse: person(m.nurse),
      date: m.date ?? null,
      shift: m.shift ?? null,
      points: m.points,
    })),
  };
}

const TOP = 5;

function topBy<T>(entries: Map<string, T>, score: (t: T) => number): [string, T][] {
  return [...entries].sort((a, b) => score(a[1]) - score(b[1])).slice(0, TOP);
}

/** Compact score breakdown for the assistant: where points were lost, by rule, nurse and date. */
export interface LedgerSummary {
  score: number;
  lost: number;
  earned: number;
  rules: { ruleId: string; label: string; points: number; matches: number }[];
  byNurse: { nurse: string; points: number }[];
  byDate: { date: string; points: number }[];
  /** Only the top matches reached the browser; per-rule totals are still exact. */
  partial: boolean;
}

export function summarizeLedger(ledger: ResolvedLedger): LedgerSummary {
  const lost = ledger.rules.filter((r) => r.points < 0);
  const nurses = new Map<string, number>();
  const dates = new Map<string, number>();
  for (const m of ledger.matches) {
    if (m.points >= 0) continue;
    if (m.nurse !== null) nurses.set(m.nurse, (nurses.get(m.nurse) ?? 0) + m.points);
    if (m.date !== null) dates.set(m.date, (dates.get(m.date) ?? 0) + m.points);
  }
  return {
    score: ledger.objective,
    lost: lost.reduce((sum, r) => sum + r.points, 0),
    earned: ledger.rules.reduce((sum, r) => sum + Math.max(0, r.points), 0),
    rules: [...lost].sort((a, b) => a.points - b.points).slice(0, 8),
    byNurse: topBy(nurses, (p) => p).map(([nurse, points]) => ({ nurse, points })),
    byDate: topBy(dates, (p) => p).map(([date, points]) => ({ date, points })),
    partial: ledger.truncated,
  };
}

export interface ResolvedCoreMember extends Omit<CoreMember, "rule" | "nurse"> {
  ruleId: string;
  label: string;
  nurse?: string;
}

/** A proven clash in ward words: the members and one sentence per date (or rule). */
export interface CoreSummary {
  proof: string;
  minimal: boolean;
  members: ResolvedCoreMember[];
  text: string;
}

export function resolveCore(core: InfeasibleCore, ctx: ExplainContext): ResolvedCoreMember[] {
  const person = realPerson(ctx.people);
  return core.members.map(({ rule, nurse, ...rest }) => {
    const source = ctx.sources[rule];
    return {
      ...rest,
      ruleId: source?.ruleId ?? `rule#${rule}`,
      label: source?.label ?? `rule ${rule}`,
      ...(nurse === undefined ? {} : { nurse: person(nurse)! }),
    };
  });
}

function clause(m: ResolvedCoreMember): string {
  const shift = m.shift?.join("/") ?? "";
  switch (m.kind) {
    case "staffing":
      return `${m.need} needed on ${shift}`;
    case "leave":
      return `${m.nurse} is on leave`;
    case "request":
      return `${m.nurse} must work ${shift}`;
    case "skill_mix":
      return `"${m.label}" needs its skill mix on ${shift}`;
    case "qualification":
      return `only qualified staff may work ${shift} ("${m.label}")`;
    default:
      return m.nurse === undefined ? `"${m.label}"` : `"${m.label}" for ${m.nurse}`;
  }
}

/** "On 2026-11-03: 1 needed on N; rn1 is on leave." Members without a date close the sentence. */
export function coreText(members: ResolvedCoreMember[]): string {
  const byDate = new Map<string, string[]>();
  const undated: string[] = [];
  for (const m of members) {
    if (m.date === undefined) undated.push(clause(m));
    else byDate.set(m.date, [...(byDate.get(m.date) ?? []), clause(m)]);
  }
  const parts = [...byDate].map(([date, clauses]) => `On ${date}: ${clauses.join("; ")}.`);
  if (undated.length > 0) parts.push(`Together with ${undated.join("; ")}.`);
  return `These cannot all hold. ${parts.join(" ")}`;
}

export function summarizeCore(
  explanation: Extract<RunExplanation, { kind: "infeasible" }>,
  ctx: ExplainContext,
): CoreSummary | null {
  if (explanation.core === null) return null;
  const members = resolveCore(explanation.core, ctx);
  return {
    proof: explanation.proof,
    minimal: explanation.core.minimal,
    members,
    text: coreText(members),
  };
}

/** What changed between the previous run and this one, per rule id (Timefold's diff). */
export interface LedgerDiff {
  scoreDelta: number;
  rules: { ruleId: string; label: string; delta: number; added: number; removed: number }[];
  partial: boolean;
}

const matchKey = (m: ResolvedMatch) => `${m.ruleId}|${m.nurse}|${m.date}|${m.shift}`;

export function diffLedgers(previous: ResolvedLedger, next: ResolvedLedger): LedgerDiff {
  const rules = new Map<string, { label: string; delta: number; added: number; removed: number }>();
  const entry = (ruleId: string, label: string) => {
    const hit = rules.get(ruleId) ?? { label, delta: 0, added: 0, removed: 0 };
    rules.set(ruleId, hit);
    return hit;
  };
  for (const r of next.rules) entry(r.ruleId, r.label).delta += r.points;
  for (const r of previous.rules) entry(r.ruleId, r.label).delta -= r.points;
  const before = new Set(previous.matches.map(matchKey));
  const after = new Set(next.matches.map(matchKey));
  for (const m of next.matches) if (!before.has(matchKey(m))) entry(m.ruleId, m.ruleId).added += 1;
  for (const m of previous.matches)
    if (!after.has(matchKey(m))) entry(m.ruleId, m.ruleId).removed += 1;
  return {
    scoreDelta: next.objective - previous.objective,
    rules: [...rules]
      .filter(([, r]) => r.delta !== 0 || r.added !== 0 || r.removed !== 0)
      .sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta))
      .slice(0, 8)
      .map(([ruleId, r]) => ({ ruleId, ...r })),
    partial: previous.truncated || next.truncated,
  };
}
