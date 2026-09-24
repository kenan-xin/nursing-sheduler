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
      readonly kind: "exchange" | "cover";
      readonly cells: readonly RosterCellChange[];
      readonly soft: readonly RuleIssue[];
      readonly unchecked: readonly string[];
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
  return { ok: true, kind, cells, soft: check.soft, unchecked: check.unchecked };
}

export function findSwapPartners(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  limit = 5,
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
    const plan = planSwap(ctx, personIdx, partnerIdx, dateIdxs);
    if (!plan.ok) {
      ruledOut.push({ partnerIdx, reason: plan.reasons[0] });
      return;
    }
    const row = ctx.days[partnerIdx].map(
      (cell, d) =>
        plan.cells.find((c) => c.personIdx === partnerIdx && c.dateIdx === d)?.after ?? cell,
    );
    candidates.push({
      partnerIdx,
      plan,
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
