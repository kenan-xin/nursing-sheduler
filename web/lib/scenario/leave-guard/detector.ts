// Shared, pure uncredited-leave detector (qq0.23b, tech-plan §2). Saved state and
// normalized imports must adapt into the structural `LeaveGuardInput` below rather
// than growing their own approximation of the trigger — this module owns policy.
//
// The detector never guesses: it resolves every selector through the fail-closed
// `ScenarioResolutionContext` (qq0.23a) and suppresses exactly as much as an
// unresolved selector demands — the whole count when its own selectors fail, only
// the affected pairing when a single leave-pin candidate's selectors fail.

import { buildScenarioResolutionContext, type ScenarioResolutionContext } from "./resolution";
import { LEAVE_SID } from "../schemas/shift-type-map";
import type {
  CountCardBody,
  IsoDate,
  UiDateGroup,
  UiPeopleGroup,
  UiPerson,
  UiRequestCell,
  UiShiftType,
  UiShiftTypeGroup,
} from "../types";

/** One count body plus its live enabled state — the detector never re-derives enablement. */
export interface LeaveGuardCountInput {
  body: CountCardBody;
  isEnabled: boolean;
}

/**
 * The one keyless, structural input every qq0.23 consumer resolves through. It
 * carries no card identity (`uid`) — a same-snapshot `countIndex` is the only
 * cross-reference, and it is meaningful only for the duration of one evaluation.
 */
export interface LeaveGuardInput {
  staff: readonly UiPerson[];
  staffGroups: readonly UiPeopleGroup[];
  shifts: readonly UiShiftType[];
  shiftGroups: readonly UiShiftTypeGroup[];
  rangeStart: IsoDate;
  rangeEnd: IsoDate;
  dateGroups: readonly UiDateGroup[];
  reqData: readonly UiRequestCell[];
  counts: readonly LeaveGuardCountInput[];
}

/**
 * One count's finding. `countIndex` is the position of the triggering count in
 * `LeaveGuardInput.counts` for THIS evaluation only — callers must join it to
 * durable identity (a saved `uid`) immediately, never persist it, and never
 * rejoin it after the counts array reorders (tech-plan §2).
 */
export interface UncreditedLeaveFinding {
  countIndex: number;
  /** Backend-equivalent staff indices, ascending — i.e. staff declaration order. */
  affectedPersonIndices: readonly number[];
}

/** A leave-pin candidate resolved once, up front, and reused across every count. */
interface LeavePinCandidate {
  people: ReadonlySet<number>;
  dates: ReadonlySet<number>;
}

/**
 * Find every uncredited-leave finding, ordered by `countIndex`. Only enabled
 * counts marked `tag: "contracted_hours"` are ever evaluated (tech-plan §2, "The
 * marker is the only proof of hours-contract intent"); every other count and
 * every unresolved count/pairing silently contributes no finding.
 */
export function findUncreditedLeaveFindings(input: LeaveGuardInput): UncreditedLeaveFinding[] {
  const ctx = buildScenarioResolutionContext({
    staff: input.staff,
    staffGroups: input.staffGroups,
    shifts: input.shifts,
    shiftGroups: input.shiftGroups,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    dateGroups: input.dateGroups,
  });

  const leavePins = resolveLeavePinCandidates(input.reqData, ctx);

  const findings: UncreditedLeaveFinding[] = [];
  input.counts.forEach((count, countIndex) => {
    if (!count.isEnabled || count.body.tag !== "contracted_hours") return;

    // 1. Resolve the count's expanded shift types. Unresolved suppresses the
    // count; an expansion that already reaches LEAVE means it is already safe.
    const countShiftTypes = ctx.resolveShiftTypes(count.body.countShiftTypes);
    if (!countShiftTypes.resolved) return;
    if (countShiftTypes.values.has(LEAVE_SID)) return;

    // 2. Resolve the count's own people and dates. Unresolved suppresses the count.
    const countPeople = ctx.resolvePeople(count.body.person);
    if (!countPeople.resolved) return;
    const countDates = ctx.resolveDates(count.body.countDates);
    if (!countDates.resolved) return;

    // 3-4. Intersect both dimensions with each resolved leave-pin candidate and
    // union the overlapping concrete people; emit a finding only when non-empty.
    const affected = new Set<number>();
    for (const pin of leavePins) {
      if (!hasOverlap(countPeople.values, pin.people)) continue;
      if (!hasOverlap(countDates.values, pin.dates)) continue;
      for (const person of countPeople.values) {
        if (pin.people.has(person)) affected.add(person);
      }
    }

    if (affected.size > 0) {
      findings.push({ countIndex, affectedPersonIndices: [...affected].sort((a, b) => a - b) });
    }
  });

  return findings;
}

/**
 * Resolve every leave-pin candidate once, up front. A candidate pins leave when
 * its cell has `kind: "leave"`, or its `kind: "request"` shift selector expands to
 * a set containing `LEAVE` (including a group whose expansion reaches it). Its
 * people/dates are then resolved; if either side is unresolved, only THAT
 * candidate is discarded — other resolved leave pins can still trigger a finding.
 */
function resolveLeavePinCandidates(
  reqData: readonly UiRequestCell[],
  ctx: ScenarioResolutionContext,
): LeavePinCandidate[] {
  const candidates: LeavePinCandidate[] = [];
  for (const cell of reqData) {
    if (!pinsLeave(cell, ctx)) continue;
    const people = ctx.resolvePeople(cell.person);
    if (!people.resolved) continue;
    const dates = ctx.resolveDates(cell.date);
    if (!dates.resolved) continue;
    candidates.push({ people: people.values, dates: dates.values });
  }
  return candidates;
}

function pinsLeave(cell: UiRequestCell, ctx: ScenarioResolutionContext): boolean {
  if (cell.kind === "leave") return true;
  if (cell.kind === "off") return false;
  const shiftTypes = ctx.resolveShiftTypes(cell.shiftType);
  return shiftTypes.resolved && shiftTypes.values.has(LEAVE_SID);
}

function hasOverlap(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) return true;
  }
  return false;
}
