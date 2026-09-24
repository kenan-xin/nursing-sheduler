// What the assistant may read about the saved roster (bead nursing-sheduler-73z).
//
// A READ OF THE SAME ROWS THE ROSTER SCREEN READS (`useWorkingRoster`): the working
// roster, plus whether a newer run's roster is waiting to be Loaded. Nothing here
// writes; a swap reaches the roster only through the Roster screen's own edit session
// (`lib/roster/change-request.ts`).

import { calendarSpan } from "@/lib/proposal/assumptions";
import { deriveCurrentDays, type RosterContext, type RosterDocument } from "@/lib/roster";
import type { RosterChangeOutcome } from "@/lib/roster/change-request";
import { dayCode, deriveRuleModel, listIssues, plainDate } from "@/lib/roster-viewer/rule-check";
import { shiftTimeRange } from "@/lib/roster-viewer/shift-label";
import {
  type CoverReason,
  findPersonIdx,
  personName,
  type ShortShiftPlan,
  type SwapPlan,
  type TradePlan,
} from "@/lib/roster-viewer/swap";
import { isWorkingRosterFromCandidate, rosterStorage, type RosterStorage } from "@/lib/store";

export type AssistantRosterRead =
  | { status: "ready"; document: RosterDocument; newerRunWaiting: boolean }
  | { status: "none"; newerRunWaiting: boolean }
  | { status: "unavailable" };

export async function readRosterForAssistant(
  storage: Pick<RosterStorage, "readWorking" | "readCurrentCandidate"> = rosterStorage,
): Promise<AssistantRosterRead> {
  try {
    const [working, pointer] = await Promise.all([
      storage.readWorking<RosterDocument>(),
      storage.readCurrentCandidate(),
    ]);
    if (working === null) return { status: "none", newerRunWaiting: pointer !== null };
    // The same rule as the Roster screen's Load offer (`roster-section.tsx:88-115`).
    const newerRunWaiting =
      pointer !== null &&
      !isWorkingRosterFromCandidate(working.candidateSource ?? undefined, pointer);
    return { status: "ready", document: working.document, newerRunWaiting };
  } catch {
    return { status: "unavailable" };
  }
}

export interface RosterSummary {
  status: "ready";
  newerRunWaiting: boolean;
  changedByHand: boolean;
  solvedAs: "optimal" | "feasible";
  period: { start: string; end: string };
  shiftTypes: { code: string; name: string; time: string }[];
  dates: string[];
  rows: { person: string; days: string[] }[];
  rulesBrokenNow: string[];
  lastChange?: string;
  guidance: string;
}

const ROSTER_GUIDANCE =
  "Each row lists one person's day for each date: a shift code from shiftTypes, OFF for a " +
  "day off, or LEAVE. Answer questions about who works when from this; never ask the user. " +
  "To change who works a shift, use find_swap_partners, then prepare_roster_swap.";

export function summarizeRoster(
  document: RosterDocument,
  filter: { fromDate?: string; toDate?: string; people?: readonly string[] },
  newerRunWaiting: boolean,
): RosterSummary | string {
  const { context } = document;
  const isos = context.calendar.map((day) => day.iso);
  const first = isos[0];
  const last = isos[isos.length - 1];
  const from = filter.fromDate ?? first;
  const to = filter.toDate ?? last;
  const dateIdxs = isos.flatMap((iso, idx) => (iso >= from && iso <= to ? [idx] : []));
  if (dateIdxs.length === 0) {
    return `No roster dates fall in that range. This roster runs from ${first} to ${last}.`;
  }
  let people = context.people.map((_person, idx) => idx);
  if (filter.people && filter.people.length > 0) {
    const found = filter.people.map((name) => findPersonIdx(context, name));
    const missing = filter.people.filter((_name, i) => found[i] < 0);
    if (missing.length > 0) {
      const everyone = context.people.map((person) => String(person.id)).join(", ");
      return `Not on this roster: ${missing.join(", ")}. People on it: ${everyone}.`;
    }
    people = [...new Set(found)];
  }
  const days = deriveCurrentDays(document.solvedDays, document.edits);
  const model = deriveRuleModel(document.submission);
  // ponytail: the whole range goes back in one answer; a ward period is about 4-6 weeks.
  const rulesBrokenNow =
    model === null
      ? []
      : listIssues(model, context, days, {
          people: context.people.map((_p, i) => i),
          dates: dateIdxs,
        })
          .filter((issue) => issue.hard)
          .slice(0, 20)
          .map((issue) => issue.message);
  return {
    status: "ready",
    newerRunWaiting,
    changedByHand: document.edits.length > 0,
    solvedAs: document.provenance.solverStatus === "OPTIMAL" ? "optimal" : "feasible",
    period: { start: first, end: last },
    shiftTypes: context.shiftTypes.map((shift) => ({
      code: String(shift.id),
      name: shift.description ?? String(shift.id),
      time: shiftTimeRange(shift) ?? "",
    })),
    dates: dateIdxs.map((d) => isos[d]),
    rows: people.map((p) => ({
      person: personName(context, p),
      days: dateIdxs.map((d) => dayCode(days[p][d])),
    })),
    rulesBrokenNow,
    guidance: newerRunWaiting
      ? `${ROSTER_GUIDANCE} A newer roster from the last run is waiting: tell the user to press Load on the Roster screen if they mean that one.`
      : ROSTER_GUIDANCE,
  };
}

export interface RosterChangeView {
  /** "Swap shifts?", "Trade shifts?", "Cover SN-Priya's sick leave?", "Borrow a nurse?" */
  heading: string;
  /** "Step 1 · Swap or cover within the ward" and so on: the ladder step, said plainly. */
  stepLabel: string;
  title: string;
  /** The model's reason. Shown as its reasoning, never as an instruction. */
  summary: string;
  rows: { person: string; date: string; now: string; after: string }[];
  /** One line per moved leave: "SN-Asha's leave: 8–9 Oct → 11–12 Oct". */
  leaveRows: string[];
  worthKnowing: string[];
  notChecked: string[];
  /** Plain lines under the table ("Night on 8 Oct is still uncovered."). */
  notes: string[];
  /** The real-world agreement to tick before Apply, or null when none is needed. */
  agreement: string | null;
}

export const STEP_LABEL = {
  1: "Step 1 · Swap or cover within the ward",
  2: "Step 2 · Ask someone off or on leave to come in",
  3: "Step 3 · Ask for a temporary nurse",
  4: "Step 4 · Last resort: run one short",
} as const;

function joinDates(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function buildRosterChangeView(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number,
  plan: Extract<SwapPlan, { ok: true }>,
  summary: string,
): RosterChangeView {
  const dates = [...new Set(plan.cells.map((cell) => cell.dateIdx))].map((d) =>
    plainDate(context.calendar[d].iso),
  );
  return {
    heading: "Swap shifts?",
    stepLabel: STEP_LABEL[1],
    leaveRows: [],
    notes: [],
    agreement: null,
    title: `${personName(context, personIdx)} and ${personName(context, partnerIdx)}, ${joinDates(dates)}`,
    summary,
    rows: plan.cells.map((cell) => ({
      person: personName(context, cell.personIdx),
      date: plainDate(context.calendar[cell.dateIdx].iso),
      now: dayCode(cell.before),
      after: dayCode(cell.after),
    })),
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
  };
}

/** The last swap's fate, in words the model can pass on. Absent when there is none. */
export function describeRosterChangeOutcome(
  outcome: RosterChangeOutcome | null,
): string | undefined {
  switch (outcome) {
    case "applied":
      return "The last swap the user applied is on the roster.";
    case "roster-changed":
      return "The last swap was NOT applied: the roster changed after it was prepared. Offer to prepare it again.";
    case "rejected":
      return "The last swap was NOT applied: the Roster screen refused it. Suggest making it by hand there.";
    case "expired":
      return "The last swap was NOT applied: the Roster screen did not open in time. The user can press Apply again after asking you to prepare it again.";
    default:
      return undefined;
  }
}

/** "8–9 Oct" for a run of days, "8 Oct and 10 Oct" otherwise. */
function span(context: RosterContext, dateIdxs: readonly number[]): string {
  const sorted = [...dateIdxs].sort((a, b) => a - b);
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  const iso = (d: number) => context.calendar[d].iso;
  return consecutive
    ? calendarSpan(iso(sorted[0]), iso(sorted[sorted.length - 1]))
    : joinDates(sorted.map((d) => plainDate(iso(d))));
}

const rowsOf = (context: RosterContext, cells: Extract<SwapPlan, { ok: true }>["cells"]) =>
  cells.map((cell) => ({
    person: personName(context, cell.personIdx),
    date: plainDate(context.calendar[cell.dateIdx].iso),
    now: dayCode(cell.before),
    after: dayCode(cell.after),
  }));

/** The one sentence the user ticks before a trade can apply. */
export function tradeAgreement(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number,
  plan: TradePlan,
): string {
  const person = personName(context, personIdx);
  const partner = personName(context, partnerIdx);
  const given = span(context, plan.dateIdxs);
  const later = span(context, plan.laterDateIdxs);
  const moved = plan.leaveMoves.length;
  const away =
    moved === plan.dateIdxs.length
      ? `take leave on ${later} instead`
      : moved === 0
        ? `have ${later} off instead (off-in-lieu)`
        : `move the leave and days off to ${later}`;
  const cover = plan.variant === "person-covers" ? `, and ${person} agreed to work ${later}` : "";
  return `${partner} agreed to come in on ${given} and ${away}${cover}.`;
}

export function buildTradeView(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number,
  plan: TradePlan,
  summary: string,
): RosterChangeView {
  const partner = personName(context, partnerIdx);
  const moves = plan.leaveMoves;
  return {
    heading: `Ask ${partner} to come in?`,
    stepLabel: STEP_LABEL[2],
    title: `${personName(context, personIdx)} and ${partner}: ${span(context, plan.dateIdxs)} for ${span(context, plan.laterDateIdxs)}`,
    summary,
    rows: rowsOf(context, plan.cells),
    leaveRows:
      moves.length === 0
        ? []
        : [
            `${partner}'s leave: ${span(
              context,
              moves.map((m) => m.from),
            )} → ${span(
              context,
              moves.map((m) => m.to),
            )}`,
          ],
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
    notes: moves.length > 0 ? ["This changes the roster and the leave record together."] : [],
    agreement: tradeAgreement(context, personIdx, partnerIdx, plan),
  };
}

export function buildSickView(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number | null,
  plan: Extract<SwapPlan, { ok: true }>,
  summary: string,
): RosterChangeView {
  const person = personName(context, personIdx);
  const dates = [
    ...new Set(plan.cells.filter((c) => c.personIdx === personIdx).map((c) => c.dateIdx)),
  ];
  return {
    heading: `Cover ${person}'s MC?`,
    stepLabel: STEP_LABEL[1],
    title:
      partnerIdx === null
        ? `${person} on leave ${span(context, dates)}`
        : `${person} on leave ${span(context, dates)}; ${personName(context, partnerIdx)} covers`,
    summary,
    rows: rowsOf(context, plan.cells),
    leaveRows: [],
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
    notes: [
      "The leave also goes into the leave record, so a new run knows.",
      ...plan.uncovered.map((message) => `Still uncovered: ${message}`),
    ],
    agreement: null,
  };
}

/** Step 2: a cover by a nurse with no known spare capacity is a request, paid back. */
export function buildOvertimeView(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number,
  plan: Extract<SwapPlan, { ok: true }>,
  reason: CoverReason,
  summary: string,
): RosterChangeView {
  const partner = personName(context, partnerIdx);
  const dates = [
    ...new Set(plan.cells.filter((c) => c.personIdx === partnerIdx).map((c) => c.dateIdx)),
  ];
  return {
    heading: `Ask ${partner} to come in?`,
    stepLabel: STEP_LABEL[2],
    title: `${partner} covers ${personName(context, personIdx)}, ${span(context, dates)}`,
    summary,
    rows: rowsOf(context, plan.cells),
    leaveRows: [],
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
    notes: [
      "This is a request: overtime pay or the rest-day rate applies.",
      ...(reason === "sick_or_emergency"
        ? ["The leave also goes into the leave record, so a new run knows."]
        : []),
    ],
    agreement: `${partner} agreed to come in on ${span(context, dates)} for overtime pay.`,
  };
}

/** Step 4, the last resort: only with the nurse manager's sign-off. */
export function buildShortView(
  context: RosterContext,
  personIdx: number,
  plan: Extract<ShortShiftPlan, { ok: true }>,
  summary: string,
): RosterChangeView {
  const lines = plan.shortfalls.map(
    (s) =>
      `“${s.label}” on ${plainDate(context.calendar[s.dateIdx].iso)} with ${s.to} instead of ${s.from}`,
  );
  return {
    heading: `Run ${lines.length === 1 ? "the shift" : "these shifts"} one short?`,
    stepLabel: STEP_LABEL[4],
    title: `${personName(context, personIdx)} off; ${lines.join("; ")}`,
    summary,
    rows: rowsOf(context, plan.cells),
    leaveRows: [],
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
    notes: [
      "Only with your nurse manager's sign-off. Every nurse the skill mix needs stays on this shift.",
    ],
    agreement: `My nurse manager has agreed it is safe to run ${lines.join("; ")}.`,
  };
}

export const BORROW_SOURCE = {
  relief_pool: "relief pool",
  other_ward: "another ward",
  agency: "agency",
} as const;

/** Step 3, C1: the schedule change only. `question` is the proposal's lending-ward question. */
export function buildBorrowView(
  name: string,
  source: keyof typeof BORROW_SOURCE,
  groups: readonly string[],
  needs: readonly { date: string; shift: string }[],
  question: string | null,
  summary: string,
): RosterChangeView {
  const from = BORROW_SOURCE[source];
  const qualified = groups.length > 0 ? `, and qualified as ${groups.join(", ")}` : "";
  return {
    heading: "Ask for a temporary nurse?",
    stepLabel: STEP_LABEL[3],
    title: `${name} (${from}): ${needs.map((n) => `${n.shift} on ${n.date}`).join(", ")}`,
    summary,
    rows: [],
    leaveRows: [],
    worthKnowing: [],
    notChecked: [],
    notes: [
      `Adds ${name} (${from}) as temporary staff, off on every other date${qualified}.`,
      `${name}'s roster row appears after the next run.`,
      "Please let your nurse manager know.",
    ],
    agreement: question,
  };
}
