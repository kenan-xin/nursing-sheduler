// Planning a shift swap on a produced roster (bead nursing-sheduler-73z).
//
// A swap exchanges two people's day-states on the same dates. It is only offered when
// it introduces no hard issue (`./rule-check`). Leave never moves. When every partner
// cell was OFF, it is a "cover": the person gives the shifts away and has those days
// off, which a hard minimum-shifts count still catches.
//
// Pure, React-free and assistant-free: the assistant's tools call it, and the Roster
// screen can later use it to suggest swaps by hand.

import { dayStatesEqual, typedIdKey } from "@/lib/roster/day-state";
import type { RosterCellChange } from "@/lib/roster/change-request";
import type { RosterContext, RosterDayGrid, RosterDayState } from "@/lib/roster/types";
import {
  checkRosterChange,
  dayCode,
  type LeaveMove,
  plainDate,
  type RuleIssue,
  type RuleModel,
} from "./rule-check";

export interface SwapContext {
  readonly context: RosterContext;
  /** The CURRENT assignments (solved + edits). */
  readonly days: RosterDayGrid;
  readonly model: RuleModel;
}

export type SwapPlan =
  | {
      readonly ok: true;
      readonly kind: "exchange" | "cover" | "move" | "record";
      readonly cells: readonly RosterCellChange[];
      readonly soft: readonly RuleIssue[];
      readonly unchecked: readonly string[];
      /** New hard issues the change leaves open (mostly shortfalls). Empty except for `record`. */
      readonly uncovered: readonly string[];
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

export interface SwapCandidate {
  readonly partnerIdx: number;
  readonly plan: Extract<SwapPlan, { ok: true }>;
  /** How many of the handed-over shift codes the partner holds afterwards. */
  readonly sameShiftsAfter: number;
  readonly workedDaysAfter: number;
}

export const personName = (context: RosterContext, idx: number): string =>
  String(context.people[idx]?.id ?? idx);

/** Exact name, else a unique case-insensitive part of one. −1 when unknown or ambiguous. */
export function findPersonIdx(context: RosterContext, name: string): number {
  const wanted = name.trim();
  const exact = context.people.findIndex((person) => String(person.id) === wanted);
  if (exact >= 0) return exact;
  const lower = wanted.toLowerCase();
  const loose = context.people.flatMap((person, idx) =>
    String(person.id).toLowerCase().includes(lower) ? [idx] : [],
  );
  return lower.length > 0 && loose.length === 1 ? loose[0] : -1;
}

export const findDateIdx = (context: RosterContext, iso: string): number =>
  context.calendar.findIndex((day) => day.iso === iso.trim());

/** Why `personIdx` cannot give up these dates at all, whoever takes them. */
export function givingProblem(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
): string | null {
  for (const d of dateIdxs) {
    const cell = ctx.days[personIdx][d];
    if (cell.kind !== "shift") {
      const why = cell.kind === "leave" ? "on leave" : "day off";
      return `${personName(ctx.context, personIdx)} is not working on ${plainDate(ctx.context.calendar[d].iso)} (${why}).`;
    }
  }
  return null;
}

export function planSwap(
  ctx: SwapContext,
  personIdx: number,
  partnerIdx: number,
  dateIdxs: readonly number[],
): SwapPlan {
  const partner = personName(ctx.context, partnerIdx);
  if (partnerIdx === personIdx) {
    return { ok: false, reasons: [`${partner} cannot swap with themselves.`] };
  }
  const giving = givingProblem(ctx, personIdx, dateIdxs);
  if (giving !== null) return { ok: false, reasons: [giving] };

  const cells: RosterCellChange[] = [];
  for (const d of dateIdxs) {
    const date = plainDate(ctx.context.calendar[d].iso);
    const mine = ctx.days[personIdx][d];
    const theirs = ctx.days[partnerIdx][d];
    if (theirs.kind === "leave")
      return { ok: false, reasons: [`${partner} is on leave on ${date}.`] };
    if (dayStatesEqual(mine, theirs)) {
      return { ok: false, reasons: [`${partner} already works ${dayCode(theirs)} on ${date}.`] };
    }
    cells.push(
      { personIdx, dateIdx: d, before: mine, after: theirs },
      { personIdx: partnerIdx, dateIdx: d, before: theirs, after: mine },
    );
  }

  const after: RosterDayState[][] = ctx.days.map((row) => [...row]);
  for (const cell of cells) after[cell.personIdx][cell.dateIdx] = cell.after;
  const check = checkRosterChange(ctx.model, ctx.context, ctx.days, after, {
    people: [personIdx, partnerIdx],
    dates: dateIdxs,
  });
  if (check.hard.length > 0)
    return { ok: false, reasons: check.hard.map((issue) => issue.message) };
  const kind = dateIdxs.every((d) => ctx.days[partnerIdx][d].kind === "off") ? "cover" : "exchange";
  return { ok: true, kind, cells, soft: check.soft, unchecked: check.unchecked, uncovered: [] };
}

function rankPartners(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  plan: (partnerIdx: number) => SwapPlan,
  limit: number,
): { candidates: SwapCandidate[]; ruledOut: { partnerIdx: number; reason: string }[] } {
  const handedOver = new Set(
    dateIdxs.flatMap((d) => {
      const cell = ctx.days[personIdx][d];
      return cell.kind === "shift" ? [typedIdKey(cell.shiftId)] : [];
    }),
  );
  const candidates: SwapCandidate[] = [];
  const ruledOut: { partnerIdx: number; reason: string }[] = [];
  ctx.context.people.forEach((_person, partnerIdx) => {
    if (partnerIdx === personIdx) return;
    const result = plan(partnerIdx);
    if (!result.ok) {
      ruledOut.push({ partnerIdx, reason: result.reasons[0] });
      return;
    }
    const row = ctx.days[partnerIdx].map(
      (cell, d) =>
        result.cells.find((c) => c.personIdx === partnerIdx && c.dateIdx === d)?.after ?? cell,
    );
    candidates.push({
      partnerIdx,
      plan: result,
      sameShiftsAfter: row.filter(
        (c) => c.kind === "shift" && handedOver.has(typedIdKey(c.shiftId)),
      ).length,
      workedDaysAfter: row.filter((c) => c.kind === "shift").length,
    });
  });
  // ponytail: fairness = fewest soft issues (the ward's own fairness counts and requests),
  // then fewest of the handed-over shifts, then fewest worked days, then roster order.
  // Ask ward managers before weighting it further (spec, open question 8).
  candidates.sort(
    (a, b) =>
      a.plan.soft.length - b.plan.soft.length ||
      a.sameShiftsAfter - b.sameShiftsAfter ||
      a.workedDaysAfter - b.workedDaysAfter ||
      a.partnerIdx - b.partnerIdx,
  );
  return { candidates: candidates.slice(0, limit), ruledOut };
}

export const findSwapPartners = (
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  limit = 5,
) => rankPartners(ctx, personIdx, dateIdxs, (q) => planSwap(ctx, personIdx, q, dateIdxs), limit);

export const findSickCovers = (
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  limit = 5,
) =>
  rankPartners(ctx, personIdx, dateIdxs, (q) => planSickCover(ctx, personIdx, q, dateIdxs), limit);

/** Step 3: what a borrowed nurse must cover, and the skill group a requirement demands there. */
export function borrowNeeds(ctx: SwapContext, personIdx: number, dateIdxs: readonly number[]) {
  return dateIdxs.flatMap((dateIdx) => {
    const cell = ctx.days[personIdx][dateIdx];
    if (cell.kind !== "shift") return [];
    const shiftIdx = ctx.model.shiftIndex.get(typedIdKey(cell.shiftId));
    const scoped = ctx.model.equations.find(
      (equation) =>
        equation.unavailable === null &&
        equation.qualifiedLabel !== null &&
        shiftIdx !== undefined &&
        equation.shiftIndices.includes(shiftIdx) &&
        equation.dateIndices.has(dateIdx),
    );
    return [{ dateIdx, shift: String(cell.shiftId), skillGroup: scoped?.qualifiedLabel ?? null }];
  });
}

export type CoverReason = "swap" | "sick_or_emergency";

const LEAVE: RosterDayState = { kind: "leave" };
const OFF: RosterDayState = { kind: "off" };

/**
 * Sick or emergency leave: the person goes on LEAVE on the dates and takes nothing back.
 * A partner who was OFF covers; a partner on another shift that day moves (the old shift
 * loses a nurse, so staffing must still hold). `partnerIdx` null records the absence alone:
 * the new shortfall is stated as `uncovered`, never a refusal, because the absence is a fact.
 */
export function planSickCover(
  ctx: SwapContext,
  personIdx: number,
  partnerIdx: number | null,
  dateIdxs: readonly number[],
): SwapPlan {
  const giving = givingProblem(ctx, personIdx, dateIdxs);
  if (giving !== null) return { ok: false, reasons: [giving] };
  if (partnerIdx === personIdx) return { ok: false, reasons: ["Pick someone else to cover."] };
  const cells: RosterCellChange[] = [];
  for (const d of dateIdxs) {
    const mine = ctx.days[personIdx][d];
    cells.push({ personIdx, dateIdx: d, before: mine, after: LEAVE });
    if (partnerIdx === null) continue;
    const theirs = ctx.days[partnerIdx][d];
    const date = plainDate(ctx.context.calendar[d].iso);
    if (theirs.kind === "leave") {
      return {
        ok: false,
        reasons: [`${personName(ctx.context, partnerIdx)} is on leave on ${date}.`],
      };
    }
    if (dayStatesEqual(mine, theirs)) {
      return {
        ok: false,
        reasons: [
          `${personName(ctx.context, partnerIdx)} already works ${dayCode(theirs)} on ${date}.`,
        ],
      };
    }
    cells.push({ personIdx: partnerIdx, dateIdx: d, before: theirs, after: mine });
  }
  const after: RosterDayState[][] = ctx.days.map((row) => [...row]);
  for (const cell of cells) after[cell.personIdx][cell.dateIdx] = cell.after;
  const people = partnerIdx === null ? [personIdx] : [personIdx, partnerIdx];
  const check = checkRosterChange(ctx.model, ctx.context, ctx.days, after, {
    people,
    dates: dateIdxs,
  });
  if (partnerIdx === null) {
    return {
      ok: true,
      kind: "record",
      cells,
      soft: check.soft,
      unchecked: check.unchecked,
      uncovered: check.hard.map((i) => i.message),
    };
  }
  if (check.hard.length > 0)
    return { ok: false, reasons: check.hard.map((issue) => issue.message) };
  const kind = dateIdxs.every((d) => ctx.days[partnerIdx][d].kind === "off") ? "cover" : "move";
  return { ok: true, kind, cells, soft: check.soft, unchecked: check.unchecked, uncovered: [] };
}

export interface CoverLadder {
  readonly step: 1 | 2 | 3;
  readonly candidates: readonly SwapCandidate[];
  readonly trades: readonly TradeCandidate[];
  readonly borrow: readonly { dateIdx: number; shift: string; skillGroup: string | null }[];
  readonly ruledOut: readonly { partnerIdx: number; reason: string }[];
}

/**
 * The ward's escalation ladder: 1 swap/cover/move, 2 a trade with someone off or on
 * leave, 3 borrow. Only the lowest step with an option is returned, so the assistant
 * cannot skip a step. Step 3 has no candidates: the user names the borrowed nurse.
 */
export function findCoverLadder(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  reason: CoverReason,
): CoverLadder {
  const step1 =
    reason === "swap"
      ? findSwapPartners(ctx, personIdx, dateIdxs)
      : findSickCovers(ctx, personIdx, dateIdxs);
  const empty = { candidates: [], trades: [], borrow: [], ruledOut: step1.ruledOut };
  if (step1.candidates.length > 0) return { ...empty, step: 1, candidates: step1.candidates };
  const trades = findTrades(ctx, personIdx, dateIdxs, reason);
  if (trades.length > 0) return { ...empty, step: 2, trades };
  return { ...empty, step: 3, borrow: borrowNeeds(ctx, personIdx, dateIdxs) };
}

export type TradeVariant = "person-covers" | "partner-off";

export interface TradePlan {
  readonly ok: true;
  readonly kind: "trade";
  readonly variant: TradeVariant;
  readonly dateIdxs: readonly number[];
  readonly laterDateIdxs: readonly number[];
  readonly cells: readonly RosterCellChange[];
  readonly leaveMoves: readonly LeaveMove[];
  readonly soft: readonly RuleIssue[];
  readonly unchecked: readonly string[];
}

export interface TradeCandidate {
  readonly partnerIdx: number;
  readonly plan: TradePlan;
}

/**
 * Step 2: a nurse who is OFF or on LEAVE on the given dates works them, and that off or
 * leave moves to later dates the nurse now works (paired in order). `person-covers`: the
 * person works those later shifts. `partner-off`: nobody does, and staffing must still
 * hold. Every affected date, now and later, goes through the same check. Succession
 * windows that touch a changed date are in scope, which covers the day after each
 * moved shift.
 */
export function planTrade(
  ctx: SwapContext,
  personIdx: number,
  partnerIdx: number,
  dateIdxs: readonly number[],
  laterDateIdxs: readonly number[],
  variant: TradeVariant,
  reason: CoverReason = "swap",
): TradePlan | { readonly ok: false; readonly reasons: readonly string[] } {
  const person = personName(ctx.context, personIdx);
  const partner = personName(ctx.context, partnerIdx);
  const fail = (why: string) => ({ ok: false as const, reasons: [why] });
  const date = (d: number) => plainDate(ctx.context.calendar[d].iso);
  if (partnerIdx === personIdx) return fail(`${partner} cannot trade with themselves.`);
  if (reason === "sick_or_emergency" && variant === "person-covers") {
    return fail(
      `${person} is on sick or emergency leave, so ${person} cannot work later shifts in return.`,
    );
  }
  if (laterDateIdxs.length !== dateIdxs.length)
    return fail("A trade needs one later date for each date given up.");
  if (new Set([...dateIdxs, ...laterDateIdxs]).size !== dateIdxs.length * 2)
    return fail("Each date can only be traded once.");
  const giving = givingProblem(ctx, personIdx, dateIdxs);
  if (giving !== null) return fail(giving);
  const last = Math.max(...dateIdxs);

  const cells: RosterCellChange[] = [];
  const leaveMoves: LeaveMove[] = [];
  for (let i = 0; i < dateIdxs.length; i++) {
    const g = dateIdxs[i];
    const l = laterDateIdxs[i];
    if (l <= last) return fail(`The later dates must come after ${date(last)}.`);
    const partnerOnG = ctx.days[partnerIdx][g];
    const partnerOnL = ctx.days[partnerIdx][l];
    const personOnG = ctx.days[personIdx][g];
    if (partnerOnG.kind === "shift") return fail(`${partner} is working on ${date(g)}.`);
    if (partnerOnL.kind !== "shift")
      return fail(`${partner} is not working on ${date(l)}, so there is nothing to trade back.`);
    cells.push(
      { personIdx, dateIdx: g, before: personOnG, after: reason === "swap" ? OFF : LEAVE },
      { personIdx: partnerIdx, dateIdx: g, before: partnerOnG, after: personOnG },
      { personIdx: partnerIdx, dateIdx: l, before: partnerOnL, after: partnerOnG },
    );
    if (variant === "person-covers") {
      const personOnL = ctx.days[personIdx][l];
      if (personOnL.kind !== "off") {
        const state = personOnL.kind === "leave" ? "on leave" : "working";
        return fail(`${person} is ${state} on ${date(l)}, so ${person} cannot cover it.`);
      }
      cells.push({ personIdx, dateIdx: l, before: personOnL, after: partnerOnL });
    }
    if (partnerOnG.kind === "leave") leaveMoves.push({ personIdx: partnerIdx, from: g, to: l });
  }

  const after: RosterDayState[][] = ctx.days.map((row) => [...row]);
  for (const cell of cells) after[cell.personIdx][cell.dateIdx] = cell.after;
  const check = checkRosterChange(
    ctx.model,
    ctx.context,
    ctx.days,
    after,
    { people: [personIdx, partnerIdx], dates: [...dateIdxs, ...laterDateIdxs] },
    { leaveMoves },
  );
  if (check.hard.length > 0)
    return { ok: false, reasons: check.hard.map((issue) => issue.message) };
  return {
    ok: true,
    kind: "trade",
    variant,
    dateIdxs,
    laterDateIdxs,
    cells,
    leaveMoves,
    soft: check.soft,
    unchecked: check.unchecked,
  };
}

export function findTrades(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  reason: CoverReason,
  limit = 3,
): TradeCandidate[] {
  const k = dateIdxs.length;
  const last = Math.max(...dateIdxs);
  const dayCount = ctx.context.calendar.length;
  const variants: TradeVariant[] =
    reason === "swap" ? ["person-covers", "partner-off"] : ["partner-off"];
  const found: TradeCandidate[] = [];
  ctx.context.people.forEach((_person, partnerIdx) => {
    if (partnerIdx === personIdx) return;
    if (!dateIdxs.every((d) => ctx.days[partnerIdx][d].kind !== "shift")) return;
    let kept = 0;
    // ponytail: runs of consecutive later days only, two per partner. Widen when wards ask.
    for (let start = last + 1; start + k <= dayCount && kept < 2; start++) {
      const later = Array.from({ length: k }, (_unused, i) => start + i);
      if (!later.every((d) => ctx.days[partnerIdx][d].kind === "shift")) continue;
      for (const variant of variants) {
        const plan = planTrade(ctx, personIdx, partnerIdx, dateIdxs, later, variant, reason);
        if (plan.ok) {
          found.push({ partnerIdx, plan });
          kept++;
          break;
        }
      }
    }
  });
  // ponytail: OFF trades first (no leave record changes), then fewer soft issues, then
  // the earliest later dates, then roster order.
  found.sort(
    (a, b) =>
      a.plan.leaveMoves.length - b.plan.leaveMoves.length ||
      a.plan.soft.length - b.plan.soft.length ||
      a.plan.laterDateIdxs[0] - b.plan.laterDateIdxs[0] ||
      a.partnerIdx - b.partnerIdx,
  );
  return found.slice(0, limit);
}
