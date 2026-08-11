// Per-nurse tallies (F4) — informational, not warnings.
//
// Per-nurse shift-type totals + OFF/leave counts, mirroring the exported summary
// columns. They recompute live on edits and carry no red/error semantics; the
// hours-on-160h metric stays out.
//
// G7 restores the prototype's weekend-rest column, which F4 had dropped. It is
// counted from ACTUAL weekend OFF assignments — a rest day that lands on a day
// the submission's own `WEEKEND` keyword covers — never from a fairness model of
// our own. It stays informational: the Grid renders zero weekend rest as a
// distinct scan flag, but nothing here calls it a violation, because no scenario
// constraint says it is one.

import { typedIdKey } from "@/lib/roster";
import type { RosterContext, RosterDayGrid } from "@/lib/roster";

/** One nurse's informational tallies across the roster range. */
export interface NurseTally {
  /** The person axis index, so the tally aligns with the grid row. */
  personIdx: number;
  /** One count per `context.shiftTypes` item, in the same order. */
  shiftCounts: readonly number[];
  /** How many OFF (rest) days this nurse has. */
  off: number;
  /** How many Leave days this nurse has. */
  leave: number;
  /** How many of those OFF days fall on a weekend day. Informational. */
  weekendRest: number;
}

/** The tallies for every nurse, in axis order. */
export type Tallies = readonly NurseTally[];

/**
 * Compute per-nurse tallies from the current assignments.
 *
 * Pure and recomputed on every edit by the caller; pass
 * `deriveCurrentDays(solvedDays, edits)` so edits are reflected immediately.
 */
export function computeTallies(context: RosterContext, currentDays: RosterDayGrid): Tallies {
  const shiftKeys = context.shiftTypes.map((shift) => typedIdKey(shift.id));

  return currentDays.map((row, personIdx) => {
    const shiftCounts: number[] = Array.from({ length: shiftKeys.length }, () => 0);
    let off = 0;
    let leave = 0;
    let weekendRest = 0;
    row.forEach((cell, dateIdx) => {
      if (cell.kind === "off") {
        off++;
        if (context.calendar[dateIdx]?.weekend === true) weekendRest++;
      } else if (cell.kind === "leave") {
        leave++;
      } else {
        const key = typedIdKey(cell.shiftId);
        const index = shiftKeys.indexOf(key);
        if (index >= 0) shiftCounts[index]++;
      }
    });
    return { personIdx, shiftCounts, off, leave, weekendRest };
  });
}
