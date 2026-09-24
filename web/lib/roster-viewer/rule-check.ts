// Hand-change rule check for a produced roster (bead nursing-sheduler-73z).
//
// WHY. The assistant may now propose swapping shifts on the saved roster. A swap is
// only worth offering if it keeps every HARD rule the roster was solved under, and the
// solver cannot answer that for one swap without re-solving everything. So this module
// re-reads the rules from the roster's own immutable submission and evaluates them on
// a grid, the way `./requirements` already does for staffing.
//
// IT MIRRORS THE BACKEND (`core/nurse_scheduling/preference_types.py`):
//   • weight ±Infinity is hard (`utils.add_objective`); a LEAVE request is hard at any
//     weight (`shift_request`); staffing is hard both ways (`./requirements`);
//   • successions slide over every start day, the `date` filter must cover the whole
//     window, and at day 0 the history-prefix variants apply (`shift_type_successions`);
//   • counts sum coefficient × day-state over `countDates` per person (`shift_count`).
// Hard affinities and coverings are NOT evaluated. They are listed in `unchecked`, and
// the card says so: unknown is never reported as fine.
//
// ONLY NEW ISSUES BLAME A CHANGE. A roster can already break a rule (an earlier hand
// edit). `checkRosterChange` evaluates before and after over the same scope and keeps
// only issues whose key is new or whose severity grew.

import {
  buildScenarioResolutionContext,
  LEAVE_SID,
  OFF_SID,
  PREFERENCE_TYPE,
  type CanonicalScenarioDocument,
  type DateRef,
  type PersonRef,
  type ShiftTypeGroupMember,
} from "@/lib/scenario";
// DIRECT LEAF IMPORTS, not the `@/lib/roster` barrel (see `tallies.ts`).
import { parseSubmissionDocument } from "@/lib/roster/context";
import { typedIdKey } from "@/lib/roster/day-state";
import type {
  RosterContext,
  RosterDayGrid,
  RosterDayState,
  RosterSubmission,
} from "@/lib/roster/types";
import {
  buildAssignmentIndex,
  buildEquations,
  evaluateRequirementCell,
  type RequirementEquation,
} from "./requirements";

/** One rule broken on one grid. */
export interface RuleIssue {
  /** Identity across before/after: rule, person, day, and pair or offender. */
  readonly key: string;
  readonly hard: boolean;
  /** How badly: people short or over, count distance; 1 for yes/no rules. */
  readonly severity: number;
  /** One plain sentence a nurse can read. */
  readonly message: string;
}

type IndexSet = ReadonlySet<number>;

interface SuccessionRule {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly people: IndexSet;
  readonly pattern: readonly IndexSet[];
  /** `null` = every date (the backend's `range(ctx.n_days)`). */
  readonly dates: IndexSet | null;
}

interface RequestRule {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly people: IndexSet;
  readonly dates: IndexSet;
  readonly shifts: readonly number[];
  /** The selector equals every worked shift: "works any shift" (`is_ss_equivalent_to_all`). */
  readonly anyWorked: boolean;
}

interface CountRule {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly people: IndexSet;
  readonly dates: readonly number[];
  readonly coefficients: ReadonlyMap<number, number>;
  readonly pairs: readonly { readonly expression: string; readonly target: number }[];
}

export interface RuleModel {
  readonly shiftIndex: ReadonlyMap<string, number>;
  readonly shiftCodes: readonly string[];
  /** Per person: resolved history indices, or null when absent or unreadable. */
  readonly history: readonly (readonly number[] | null)[];
  readonly equations: readonly RequirementEquation[];
  readonly successions: readonly SuccessionRule[];
  readonly requests: readonly RequestRule[];
  readonly counts: readonly CountRule[];
  /** Hard rules this module cannot evaluate, as plain labels. Never "fine". */
  readonly unchecked: readonly string[];
}

export interface CheckScope {
  readonly people: readonly number[];
  readonly dates: readonly number[];
}

/** A leave day a trade moves: the pin on `from` now means `to` (after the change only). */
export interface LeaveMove {
  readonly personIdx: number;
  readonly from: number;
  readonly to: number;
}

export interface CheckOptions {
  readonly leaveMoves?: readonly LeaveMove[];
}

const isHard = (weight: number): boolean => weight === Infinity || weight === -Infinity;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-08" → "8 Oct", the way the ward says it. */
export function plainDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

/** The code the grid shows: the shift id, OFF or LEAVE. */
export function dayCode(day: RosterDayState): string {
  if (day.kind === "shift") return String(day.shiftId);
  return day.kind === "off" ? "OFF" : "LEAVE";
}

/** Build the rule model from the canonical document the roster was solved from. */
export function buildRuleModel(document: CanonicalScenarioDocument): RuleModel {
  const items = document.shiftTypes.items;
  const resolver = buildScenarioResolutionContext({
    staff: document.people.items,
    staffGroups: document.people.groups ?? [],
    shifts: items,
    shiftGroups: document.shiftTypes.groups ?? [],
    rangeStart: document.dates.range.startDate,
    rangeEnd: document.dates.range.endDate,
    dateGroups: document.dates.groups ?? [],
  });
  const people = (selector: unknown) =>
    resolver.resolvePeople(selector as PersonRef | readonly PersonRef[]);
  const dates = (selector: unknown) =>
    resolver.resolveDates(selector as DateRef | readonly DateRef[]);
  const shifts = (selector: unknown) =>
    resolver.resolveShiftTypes(selector as ShiftTypeGroupMember | readonly ShiftTypeGroupMember[]);

  const equations = buildEquations(document);
  const unchecked: string[] = equations
    .filter((equation) => equation.unavailable !== null)
    .map((equation) => equation.description ?? `${equation.scopeLabel} staffing`);
  const successions: SuccessionRule[] = [];
  const requests: RequestRule[] = [];
  const counts: CountRule[] = [];

  document.preferences.forEach((preference, index) => {
    const key = `preferences[${index}]`;
    switch (preference.type) {
      case PREFERENCE_TYPE.shiftTypeSuccessions: {
        const label = preference.description ?? "a shift pattern rule";
        const who = people(preference.person);
        const when = preference.date === undefined ? null : dates(preference.date);
        const pattern = preference.pattern.map((element) => shifts(element));
        if (
          !who.resolved ||
          (when !== null && !when.resolved) ||
          !pattern.every((p) => p.resolved)
        ) {
          if (isHard(preference.weight)) unchecked.push(label);
          return;
        }
        successions.push({
          key,
          label,
          weight: preference.weight,
          people: who.values,
          pattern: pattern.map((p) => (p.resolved ? p.values : new Set<number>())),
          dates: when !== null && when.resolved ? when.values : null,
        });
        return;
      }
      case PREFERENCE_TYPE.shiftRequest: {
        const label = preference.description ?? "a request";
        const who = people(preference.person);
        const when = dates(preference.date);
        const what = shifts(preference.shiftType);
        if (!who.resolved || !when.resolved || !what.resolved) {
          // An unreadable request may be a leave pin, which is hard at any weight.
          unchecked.push(label);
          return;
        }
        const list = [...what.values];
        requests.push({
          key,
          label,
          weight: preference.weight,
          people: who.values,
          dates: when.values,
          shifts: list,
          anyWorked: list.length === items.length && list.every((s) => s >= 0),
        });
        return;
      }
      case PREFERENCE_TYPE.shiftCount: {
        const label = preference.description ?? "a shift count rule";
        const who = people(preference.person);
        const when = dates(preference.countDates);
        const what = shifts(preference.countShiftTypes);
        if (!who.resolved || !when.resolved || !what.resolved) {
          if (isHard(preference.weight)) unchecked.push(label);
          return;
        }
        const coefficients = new Map<number, number>([...what.values].map((s) => [s, 1]));
        for (const [shiftId, coefficient] of preference.countShiftTypeCoefficients ?? []) {
          const expanded = shifts(shiftId);
          if (!expanded.resolved) continue;
          for (const s of expanded.values)
            if (coefficients.has(s)) coefficients.set(s, coefficient);
        }
        const expressions = [preference.expression].flat();
        const targets = [preference.target].flat();
        counts.push({
          key,
          label,
          weight: preference.weight,
          people: who.values,
          dates: [...when.values],
          coefficients,
          pairs: expressions.map((expression, i) => ({ expression, target: targets[i] ?? 0 })),
        });
        return;
      }
      case PREFERENCE_TYPE.shiftAffinity:
        if (isHard(preference.weight)) {
          unchecked.push(preference.description ?? "a rule about who works together");
        }
        return;
      case PREFERENCE_TYPE.shiftTypeCovering:
        if (isHard(preference.weight))
          unchecked.push(preference.description ?? "a supervision rule");
        return;
      default:
        // "at most one shift per day" is the grid's own shape; staffing is `equations`.
        return;
    }
  });

  const history = document.people.items.map((person) => {
    if (!person.history) return null;
    const resolved = person.history.map((token) => shifts(token));
    if (!resolved.every((r) => r.resolved && r.values.size === 1)) return null;
    return resolved.map((r) => (r.resolved ? [...r.values][0] : 0));
  });

  return {
    shiftIndex: new Map(items.map((item, i) => [typedIdKey(item.id), i])),
    shiftCodes: items.map((item) => String(item.id)),
    history,
    equations,
    successions,
    requests,
    counts,
    unchecked,
  };
}

/** The rule model of a roster's own submission, or null when it cannot be read. */
export function deriveRuleModel(
  submission: Pick<RosterSubmission, "canonicalYaml">,
): RuleModel | null {
  const parsed = parseSubmissionDocument(submission.canonicalYaml);
  return parsed.ok ? buildRuleModel(parsed.document) : null;
}

function cellIndex(model: RuleModel, day: RosterDayState): number {
  if (day.kind === "off") return OFF_SID;
  if (day.kind === "leave") return LEAVE_SID;
  return model.shiftIndex.get(typedIdKey(day.shiftId)) ?? Number.NaN;
}

function describeShift(model: RuleModel, s: number): string {
  if (s === OFF_SID) return "a day off";
  if (s === LEAVE_SID) return "leave";
  return model.shiftCodes[s] ?? "a shift";
}

const RELATION: Readonly<Record<string, (target: number) => string>> = {
  "x <= T": (t) => `at most ${t}`,
  "x < T": (t) => `fewer than ${t}`,
  "x >= T": (t) => `at least ${t}`,
  "x > T": (t) => `more than ${t}`,
  "x = T": (t) => `exactly ${t}`,
  "|x - T|^2": (t) => `exactly ${t}`,
};

function countHolds(expression: string, x: number, t: number): boolean {
  switch (expression) {
    case "x <= T":
      return x <= t;
    case "x < T":
      return x < t;
    case "x >= T":
      return x >= t;
    case "x > T":
      return x > t;
    default:
      return x === t; // "x = T" and "|x - T|^2"
  }
}

/** Every rule the grid breaks inside `scope`, hard and soft. */
export function listIssues(
  model: RuleModel,
  context: RosterContext,
  grid: RosterDayGrid,
  scope: CheckScope,
  options: CheckOptions = {},
): RuleIssue[] {
  const movedFrom = new Set((options.leaveMoves ?? []).map((m) => `${m.personIdx}:${m.from}`));
  const issues: RuleIssue[] = [];
  const inScope = new Set(scope.dates);
  const dayCount = context.calendar.length;
  const name = (p: number) => String(context.people[p]?.id ?? p);
  const day = (d: number) => plainDate(context.calendar[d].iso);
  const at = (p: number, d: number) => cellIndex(model, grid[p][d]);

  // --- successions -------------------------------------------------------------
  for (const rule of model.successions) {
    const length = rule.pattern.length;
    if (length === 0 || length > dayCount) continue;
    const covered = (start: number, span: number) => {
      for (let i = 0; i < span; i++)
        if (rule.dates !== null && !rule.dates.has(start + i)) return false;
      return true;
    };
    const touches = (start: number, span: number) => {
      for (let i = 0; i < span; i++) if (inScope.has(start + i)) return true;
      return false;
    };
    for (const p of scope.people) {
      if (!rule.people.has(p)) continue;
      const judge = (pattern: readonly IndexSet[], start: number, lead: string, suffix: string) => {
        let matched = 0;
        for (let i = 0; i < pattern.length; i++) if (pattern[i].has(at(p, start + i))) matched++;
        const full = matched === pattern.length;
        const cells = pattern
          .map((_set, i) => `${dayCode(grid[p][start + i])} on ${day(start + i)}`)
          .join(", then ");
        const base = { key: `${rule.key}:p${p}:d${start}${suffix}`, severity: 1 };
        if (rule.weight === -Infinity && full) {
          issues.push({
            ...base,
            hard: true,
            message: `${name(p)} works ${lead}${cells}, which “${rule.label}” does not allow.`,
          });
        } else if (rule.weight === Infinity && !full) {
          issues.push({
            ...base,
            hard: true,
            message: `${name(p)} works ${lead}${cells}, which does not follow “${rule.label}”.`,
          });
        } else if (Number.isFinite(rule.weight) && rule.weight < 0 && full) {
          issues.push({
            ...base,
            hard: false,
            message: `${name(p)} works ${lead}${cells}, which “${rule.label}” tries to avoid.`,
          });
        }
      };
      for (let start = 0; start + length <= dayCount; start++) {
        if (covered(start, length) && touches(start, length)) judge(rule.pattern, start, "", "");
      }
      // Day 0 with history: a history suffix that matches the pattern's prefix leaves
      // the rest of the pattern to be judged from day 0 (`preference_types.py:329-352`).
      // The backend checks the date filter over the FULL pattern length from day 0.
      const history = model.history[p];
      if (history === null || !covered(0, length)) continue;
      for (let k = 1; k <= Math.min(length, history.length); k++) {
        const tail = history.slice(-k);
        if (!tail.every((s, i) => rule.pattern[i].has(s))) continue;
        const rest = rule.pattern.slice(k);
        if (rest.length === 0 || !touches(0, rest.length)) continue;
        const lead = `${tail.map((s) => (s === OFF_SID ? "OFF" : describeShift(model, s))).join(", then ")} before the roster starts, then `;
        judge(rest, 0, lead, `:h${k}`);
      }
    }
  }

  // --- requests ----------------------------------------------------------------
  for (const rule of model.requests) {
    for (const p of scope.people) {
      if (!rule.people.has(p)) continue;
      for (const d of scope.dates) {
        if (!rule.dates.has(d)) continue;
        const cell = at(p, d);
        const checks = rule.anyWorked
          ? [{ id: "any", holds: cell >= 0, label: "a shift", leave: false }]
          : rule.shifts.map((s) => ({
              id: String(s),
              holds: cell === s,
              label: describeShift(model, s),
              leave: s === LEAVE_SID,
            }));
        for (const c of checks) {
          if (c.leave && movedFrom.has(`${p}:${d}`)) continue;
          const must = c.leave || rule.weight === Infinity;
          const mustNot = !c.leave && rule.weight === -Infinity;
          const base = { key: `${rule.key}:p${p}:d${d}:s${c.id}`, severity: 1 };
          if (must && !c.holds) {
            issues.push({
              ...base,
              hard: true,
              message: `${name(p)} must have ${c.label} on ${day(d)} (“${rule.label}”).`,
            });
          } else if (mustNot && c.holds) {
            issues.push({
              ...base,
              hard: true,
              message: `${name(p)} must not have ${c.label} on ${day(d)} (“${rule.label}”).`,
            });
          } else if (!must && !mustNot && rule.weight > 0 && !c.holds) {
            issues.push({
              ...base,
              hard: false,
              message: `${name(p)} asked for ${c.label} on ${day(d)}.`,
            });
          } else if (!must && !mustNot && rule.weight < 0 && c.holds) {
            issues.push({
              ...base,
              hard: false,
              message: `${name(p)} asked not to have ${c.label} on ${day(d)}.`,
            });
          }
        }
      }
    }
  }

  for (const move of options.leaveMoves ?? []) {
    if (!scope.people.includes(move.personIdx)) continue;
    if (grid[move.personIdx][move.to].kind === "leave") continue;
    issues.push({
      key: `leave-move:p${move.personIdx}:d${move.to}`,
      hard: true,
      severity: 1,
      message: `${name(move.personIdx)} must have leave on ${day(move.to)} (moved from ${day(move.from)}).`,
    });
  }

  // --- counts ------------------------------------------------------------------
  for (const rule of model.counts) {
    if (rule.weight === 0 || !rule.dates.some((d) => inScope.has(d))) continue;
    for (const p of scope.people) {
      if (!rule.people.has(p)) continue;
      let x = 0;
      for (const d of rule.dates) x += rule.coefficients.get(at(p, d)) ?? 0;
      rule.pairs.forEach(({ expression, target }, i) => {
        const relation = RELATION[expression];
        if (relation === undefined) return; // the backend rejects it; no roster exists
        const holds = countHolds(expression, x, target);
        const squared = expression === "|x - T|^2";
        let hard = false;
        let broken: boolean;
        let text: string;
        if (rule.weight === Infinity || (squared && rule.weight === -Infinity)) {
          hard = true;
          broken = !holds;
          text = `needs ${relation(target)}`;
        } else if (rule.weight === -Infinity) {
          hard = true;
          broken = holds;
          text = `must not be ${relation(target)}`;
        } else if (squared || rule.weight > 0) {
          broken = !holds;
          text = `aims for ${relation(target)}`;
        } else {
          broken = holds;
          text = `tries to avoid ${relation(target)}`;
        }
        if (!broken) return;
        issues.push({
          key: `${rule.key}:p${p}:pair${i}`,
          hard,
          severity: Math.abs(x - target) + 1,
          message: `${name(p)} has ${x} counted under “${rule.label}”, which ${text}.`,
        });
      });
    }
  }

  // --- staffing requirements ---------------------------------------------------
  const index = buildAssignmentIndex(context, grid);
  for (const equation of model.equations) {
    const label = equation.description ?? `${equation.scopeLabel} staffing`;
    for (const d of scope.dates) {
      const cell = evaluateRequirementCell(equation, index, d);
      if (cell.status !== "checked") continue;
      for (const offender of cell.offenders) {
        issues.push({
          key: `${equation.key}:d${d}:unqualified:p${offender}`,
          hard: true,
          severity: 1,
          message: `${day(d)}: ${name(offender)} works ${equation.scopeLabel}, which only ${equation.qualifiedLabel ?? "qualified staff"} may work.`,
        });
      }
      if (cell.short > 0) {
        issues.push({
          key: `${equation.key}:d${d}:short`,
          hard: true,
          severity: cell.short,
          message: `${day(d)}: “${label}” has ${cell.units} of the ${cell.required} needed.`,
        });
      }
      if (cell.over > 0) {
        issues.push({
          key: `${equation.key}:d${d}:over`,
          hard: true,
          severity: cell.over,
          message: `${day(d)}: “${label}” has ${cell.units}, more than the ${cell.preferred ?? cell.required} allowed.`,
        });
      }
    }
  }
  return issues;
}

export interface ChangeCheck {
  readonly hard: readonly RuleIssue[];
  readonly soft: readonly RuleIssue[];
  readonly unchecked: readonly string[];
}

/** The issues a change INTRODUCES: a new key, or a key whose severity grew. */
export function checkRosterChange(
  model: RuleModel,
  context: RosterContext,
  before: RosterDayGrid,
  after: RosterDayGrid,
  scope: CheckScope,
  options: CheckOptions = {},
): ChangeCheck {
  const had = new Map(listIssues(model, context, before, scope).map((i) => [i.key, i.severity]));
  const introduced = listIssues(model, context, after, scope, options).filter(
    (issue) => issue.severity > (had.get(issue.key) ?? 0),
  );
  return {
    hard: introduced.filter((issue) => issue.hard),
    soft: introduced.filter((issue) => !issue.hard),
    unchecked: model.unchecked,
  };
}
