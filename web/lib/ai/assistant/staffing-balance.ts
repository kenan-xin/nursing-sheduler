// Capacity vs demand (bead 4h5a): how many shifts the staff can work against how many
// the staffing numbers need and allow. The assistant reads it from get_setup_progress
// instead of doing the sums itself; a 2026-09-28 run saved "at least 2" as exactly 2 and
// then offered a days-off cap the exact counts made impossible.
//
// ponytail: a requirement is counted once per shift selector and date, so two
// requirements on the same shift (a group and a member) are counted twice; the static
// check (lib/rules/shortfalls.ts) owns overlap. Good enough for a sum-level sanity check.

import { isDayStateSelector, type ScenarioUiState } from "@/lib/scenario/types";
import { expandShiftTypeRefs } from "@/lib/rules/expansion";
import { requiredOn, requirementDateIsos } from "@/lib/rules/requirement-dates";
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
  const capacity = staff * shiftsEach;
  const spareShifts = capacity - minimumShifts;
  const fewestOffDaysEach = mostShifts === null ? null : oneDecimal(days - mostShifts / staff);

  const perDay = oneDecimal(minimumShifts / days);
  const parts = [
    `${staff} nurses × ${shiftsEach} shifts = ${capacity} shifts of working time in these ${days} days (5 in every 7 days each);`,
    `the staffing numbers need at least ${minimumShifts} shifts (${perDay} a day),`,
    spareShifts > 0
      ? `so there are ${spareShifts} shifts spare.`
      : `so there are ${-spareShifts} shifts too few.`,
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
    sentence: parts.join(" "),
  };
}
