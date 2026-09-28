// Capacity vs demand (bead 4h5a): how many shifts the staff can work against how many
// the staffing numbers need and allow. The assistant reads it from get_setup_progress
// instead of doing the sums itself; a 2026-09-28 run saved "at least 2" as exactly 2 and
// then offered a days-off cap the exact counts made impossible.
//
// ponytail: a requirement is counted once per shift selector and date, so two
// requirements on the same shift (a group and a member) are counted twice; the static
// check (lib/rules/shortfalls.ts) owns overlap. Good enough for a sum-level sanity check.

import {
  RESERVED_SHIFT_TYPE,
  isDayStateSelector,
  type ContractedHoursCountCard,
  type ScenarioUiState,
} from "@/lib/scenario/types";
import { isContractedHoursCard } from "@/components/counts/counts-model";
import { expandPersonRefs, expandShiftTypeRefs } from "@/lib/rules/expansion";
import {
  makeDates,
  requiredOn,
  requirementDateIsos,
  toDateId,
} from "@/lib/rules/requirement-dates";
import { generateDateItems } from "@/lib/dates/date-id";

/** Full-time ward practice: 5 working days in every 7 (2 rest days, bead 1v5k). */
const WORKED_PER_WEEK = 5;

export interface StaffingBalance {
  days: number;
  staff: number;
  /** Shifts the staffing numbers need at least, over the period. */
  minimumShifts: number;
  /** Shifts the numbers allow at most (preferred where set); null while a worked shift has no requirement. */
  mostShifts: number | null;
  /** One nurse's full-time share: 5 in every 7 days of the period. */
  shiftsEach: number;
  capacity: number;
  /** Capacity less the minimums: shifts to place as 'ideally' counts, or days off. */
  spareShifts: number;
  /** The fewest days off each nurse can average; a days-off cap below it cannot hold. */
  fewestOffDaysEach: number | null;
  /** The capacity rests on a guess (a nurse with no contract, or mixed shift hours): say "about". */
  estimated: boolean;
  /** The arithmetic in plain words, for the assistant to say. */
  sentence: string;
}

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

export function computeStaffingBalance(state: ScenarioUiState): StaffingBalance | null {
  const days = generateDateItems({ start: state.rangeStart, end: state.rangeEnd }).length;
  const staff = state.staff.length;
  const cards = state.cardsByKind.requirements.filter((card) => !card.disabled);
  if (days === 0 || staff === 0 || cards.length === 0) return null;

  let minimumShifts = 0;
  let ceiling = 0;
  const staffed = new Set<string>();
  for (const card of cards) {
    const selectors = [card.shiftType].flat(2).map(String);
    for (const id of expandShiftTypeRefs(selectors, state)) staffed.add(String(id));
    for (const iso of requirementDateIsos(state, card)) {
      const required = requiredOn(card, iso);
      minimumShifts += required * selectors.length;
      ceiling += Math.max(required, card.preferredNumPeople ?? 0) * selectors.length;
    }
  }
  const unstaffed = state.shifts.some(
    (shift) => !isDayStateSelector(String(shift.id)) && !staffed.has(String(shift.id)),
  );
  const mostShifts = unstaffed ? null : ceiling;
  const shiftsEach = Math.round((days * WORKED_PER_WEEK) / 7);

  // Each nurse's working days: her contract less the leave it credits, else the
  // full-time guess over the days she is not on leave or a hard day off.
  let capacity = 0;
  let assumed = 0;
  let approximate = false;
  for (const person of state.staff) {
    const id = String(person.id);
    const away = awayDays(state, id);
    const contract = contractOf(state, id);
    if (contract) {
      const perDay = contract.workCoefs.reduce((a, b) => a + b, 0) / contract.workCoefs.length;
      const worked =
        ((contract.floor + contract.ceiling) / 2 - away.leave * contract.leaveCoef) / perDay;
      if (!Number.isInteger(worked) || contract.workCoefs.some((c) => c !== perDay))
        approximate = true;
      capacity += Math.max(0, Math.round(worked));
    } else {
      assumed += 1;
      capacity += Math.round(((days - away.leave - away.off) * WORKED_PER_WEEK) / 7);
    }
  }
  const estimated = approximate || assumed > 0;
  const about = estimated ? "about " : "";
  const spareShifts = capacity - minimumShifts;
  const fewestOffDaysEach = mostShifts === null ? null : oneDecimal(days - mostShifts / staff);

  const basis =
    assumed > 0
      ? `${assumed} nurses assumed full time (${shiftsEach} shifts each, 5 in every 7 days, less leave)${assumed < staff ? ", the rest from their contracts" : ""}`
      : "from each nurse's contract, less leave";
  const perDay = oneDecimal(minimumShifts / days);
  const parts = [
    `The staff have ${about}${capacity} shifts of working time in these ${days} days (${basis});`,
    `the staffing numbers need at least ${minimumShifts} shifts (${perDay} a day),`,
    spareShifts > 0
      ? `so there are ${about}${spareShifts} shifts spare.`
      : `so there are ${about}${-spareShifts} shifts too few.`,
  ];
  if (mostShifts !== null && fewestOffDaysEach !== null) {
    parts.push(
      `The numbers allow at most ${mostShifts} shifts, so each nurse averages at least ${days} − ${mostShifts} ÷ ${staff} = ${fewestOffDaysEach} days off; a cap on days off below that cannot hold.`,
    );
  }
  return {
    days,
    staff,
    minimumShifts,
    mostShifts,
    shiftsEach,
    capacity,
    spareShifts,
    fewestOffDaysEach,
    estimated,
    sentence: parts.join(" "),
  };
}

/** Days in the period a nurse is on leave, and on a hard day off. */
export function awayDays(state: ScenarioUiState, person: string): { leave: number; off: number } {
  const { range, allDateIds } = makeDates(state);
  const inRange = new Set(allDateIds);
  const leave = new Set<string>();
  const off = new Set<string>();
  for (const cell of state.reqData) {
    const hardOff = cell.kind === "off" && cell.weight === Infinity;
    if (cell.kind !== "leave" && !hardOff) continue;
    if (!expandPersonRefs([cell.person], state).has(person)) continue;
    const date = toDateId(cell.date, range);
    if (inRange.has(date)) (cell.kind === "leave" ? leave : off).add(date);
  }
  return { leave: leave.size, off: [...off].filter((d) => !leave.has(d)).length };
}

/** A nurse's contracted hours in half-hours, and what each day counts toward it. */
export interface NurseContract {
  card: ContractedHoursCountCard;
  floor: number;
  ceiling: number;
  /** Half-hours each worked shift counts. */
  workCoefs: number[];
  /** Half-hours a leave day counts; 0 when leave does not count. */
  leaveCoef: number;
}

/**
 * The first switched-on contracted hours card that binds this nurse.
 * ponytail: reads the card as covering the whole period whatever its dates.
 */
export function contractOf(state: ScenarioUiState, person: string): NurseContract | null {
  for (const card of state.cardsByKind.counts) {
    if (card.disabled || !isContractedHoursCard(card)) continue;
    if (!expandPersonRefs([card.person].flat(), state).has(person)) continue;
    const coefs = card.countShiftTypeCoefficients ?? [];
    const workCoefs = coefs.filter(([id]) => id !== RESERVED_SHIFT_TYPE.leave).map(([, c]) => c);
    if (workCoefs.length === 0) continue;
    const leaveCoef = coefs.find(([id]) => id === RESERVED_SHIFT_TYPE.leave)?.[1] ?? 0;
    const [floor, ceiling] = Array.isArray(card.target) ? card.target : [card.target, card.target];
    return { card, floor, ceiling, workCoefs, leaveCoef };
  }
  return null;
}
