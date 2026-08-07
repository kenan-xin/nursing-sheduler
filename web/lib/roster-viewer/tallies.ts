// Per-nurse tallies (F4) — informational, not warnings.
//
// Per-nurse shift-type totals + OFF/leave counts, mirroring the exported summary
// columns. They recompute live on edits and carry no red/error semantics. The
// ticket drops the prototype's "W·off" weekend-rest fairness column and the
// hours-on-160h metric — tallies are shift-type counts plus OFF and Leave only.

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
    for (const cell of row) {
      if (cell.kind === "off") {
        off++;
      } else if (cell.kind === "leave") {
        leave++;
      } else {
        const key = typedIdKey(cell.shiftId);
        const index = shiftKeys.indexOf(key);
        if (index >= 0) shiftCounts[index]++;
      }
    }
    return { personIdx, shiftCounts, off, leave };
  });
}
