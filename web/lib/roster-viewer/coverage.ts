// The Exact shifts plane (F4, rewritten for G7).
//
// One lane per concrete shift type: who is on it each day, how many that is,
// and — only where the scenario actually declares one — the target for that exact
// shift. Ward 8 declares staffing for shift GROUPS, so most of its lanes
// truthfully carry a headcount and no target at all. That is not a gap to be
// filled: dividing `AllMornings: 6` across `am1/am2/am3` would report a shift as
// short against a number the scenario never stated.
//
// ONE TARGET AUTHORITY. The required value comes from the ephemeral requirement
// model's `exactShiftRequirement` rule and nowhere else. The persisted
// `context.baselineMinimums` cache is left exactly as F3 writes it (the roster
// schema is unchanged) but is no longer read by presentation, so there is one
// derivation of "does this exact shift have a declared target", not two that can
// drift apart.

// DIRECT LEAF IMPORT, not the `@/lib/roster` barrel (see `tallies.ts`).
import type { RosterCalendarDay, RosterContext, RosterDayState } from "@/lib/roster/types";
import {
  exactShiftRequirement,
  type RequirementModel,
  type RosterAssignmentIndex,
} from "./requirements";

/** One concrete shift's staffing on one day. */
export interface ShiftCoverage {
  /** The people on this shift, as person-axis indices in ascending order. */
  readonly people: readonly number[];
  /** How many people are on it. Always a real, stated number. */
  readonly staffed: number;
  /**
   * The declared target for THIS exact shift, or null when the scenario states
   * none. Null is not "zero" and not "fine" — it means no per-shift claim exists.
   */
  readonly required: number | null;
  /** Under a declared exact-shift target. Always false when `required` is null. */
  readonly short: boolean;
}

/** One day's exact-shift lanes, aligned to `context.shiftTypes`. */
export interface DayCoverage {
  readonly iso: string;
  readonly shifts: readonly ShiftCoverage[];
  /** Whether any exact-shift lane with a declared target is under it. */
  readonly anyShort: boolean;
}

/** The full exact-shift plane: one `DayCoverage` per calendar day. */
export type CoverageGrid = readonly DayCoverage[];

/**
 * Compute the exact-shift plane from the current assignments.
 *
 * Pure: the caller passes an index built from `deriveCurrentDays(...)`, so an
 * edit recomputes both planes in the same render.
 */
export function computeCoverage(
  context: RosterContext,
  index: RosterAssignmentIndex,
  model: RequirementModel,
): CoverageGrid {
  return context.calendar.map((day, dateIdx) => {
    const lane = index.byDateShift[dateIdx] ?? [];
    const shifts = context.shiftTypes.map((_shift, shiftIdx): ShiftCoverage => {
      const people = lane[shiftIdx] ?? [];
      // PER DAY, not once per shift. A requirement may be scoped to particular
      // dates, so the same lane can legitimately carry a target on one date and
      // none on the next; resolving it once and copying it across the calendar
      // both invented a target off-scope and deleted one on-scope.
      const target = exactShiftRequirement(model, shiftIdx, dateIdx);
      return {
        people,
        staffed: people.length,
        required: target,
        short: target !== null && people.length < target,
      };
    });
    return {
      iso: day.iso,
      shifts,
      anyShort: shifts.some((shift) => shift.short),
    };
  });
}

/**
 * The target for a shift's LANE LABEL, where one number has to stand for the
 * whole row.
 *
 * Only a target every day agrees on can be stated there. A date-scoped
 * requirement makes the row's target vary, and printing any one day's number as
 * the lane's `min N` would state a quota the other days do not have — so the
 * label falls back to the shift's own context and the per-day cells carry the
 * truth.
 */
export function uniformShiftRequirement(coverage: CoverageGrid, shiftIdx: number): number | null {
  if (coverage.length === 0) return null;
  const first = coverage[0].shifts[shiftIdx]?.required ?? null;
  if (first === null) return null;
  return coverage.every((day) => day.shifts[shiftIdx]?.required === first) ? first : null;
}

/** Re-exported so coverage consumers can read a calendar day without reaching into F3. */
export type { RosterCalendarDay, RosterDayState };
