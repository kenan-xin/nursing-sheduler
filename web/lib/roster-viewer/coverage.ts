// Coverage warnings (F4) — the executable baseline predicate.
//
// The ONLY warnings in v1 are per-day, per-shift staffed-count-vs-minimum. The
// baseline is decided by F3's `context.baselineMinimums`, which already encodes
// the unique-simple-requirement rule from the tech plan: a shift with exactly
// one unscoped, uncoefficiented, scalar-ALL requirement is `available`; zero or
// many qualifying requirements are `unavailable`.
//
// This module CONSUMES that derivation and computes live coverage from the
// current (possibly edited) day grid. It never re-derives the baseline and never
// fabricates a number for an `unavailable` shift — that is the load-bearing
// contract from Core Flows Flow 4 and the F4 ticket.
//
// "Short" = staffed < required. Overstaffing is not flagged. No night→morning
// rest, no fairness, no hours-on-160h, no role/seniority — all deliberately out.

import { typedIdKey } from "@/lib/roster";
import type {
  RosterBaselineMinimum,
  RosterCalendarDay,
  RosterContext,
  RosterDayGrid,
  RosterDayState,
} from "@/lib/roster";

/**
 * One shift's coverage for one day.
 *
 * `available` carries a live count and the Short flag; `unavailable` carries no
 * number at all, because inventing one would contradict the baseline rule.
 */
export type ShiftCoverage =
  | { status: "available"; staffed: number; required: number; short: boolean }
  | { status: "unavailable" };

/** One day's coverage across every worked shift lane. */
export interface DayCoverage {
  /** ISO date string, for labelling and the Day strip. */
  iso: string;
  /** One entry per `context.shiftTypes` item, in the same order. */
  shifts: readonly ShiftCoverage[];
  /** Whether ANY available shift on this day is Short. */
  anyShort: boolean;
}

/** The full coverage grid: one `DayCoverage` per calendar day. */
export type CoverageGrid = readonly DayCoverage[];

/**
 * Count how many people are working a given shift on a given day.
 *
 * `day` is the per-person column for one date index: `currentDays[personIdx]` is
 * that person's row, and `day[personIdx]` is their assignment for this date. A
 * worked shift counts if the day-state is `shift` with exactly this `shiftId`.
 */
function countStaffed(grid: RosterDayGrid, dateIdx: number, shiftKey: string): number {
  let count = 0;
  for (let personIdx = 0; personIdx < grid.length; personIdx++) {
    const cell = grid[personIdx][dateIdx];
    if (cell.kind === "shift" && typedIdKey(cell.shiftId) === shiftKey) count++;
  }
  return count;
}

/**
 * Compute the live coverage grid from the current assignments and the derived
 * baseline minimums.
 *
 * Recomputed on every edit by the caller (this is a pure function); the viewer
 * passes `deriveCurrentDays(solvedDays, edits)` so edits are reflected
 * immediately.
 */
export function computeCoverage(context: RosterContext, currentDays: RosterDayGrid): CoverageGrid {
  const calendar = context.calendar;
  const minimums = context.baselineMinimums;

  return calendar.map((day, dateIdx) => {
    const shifts: ShiftCoverage[] = minimums.map((minimum) => {
      if ("unavailable" in minimum) return { status: "unavailable" as const };
      const shiftKey = typedIdKey(minimum.shiftId);
      const staffed = countStaffed(currentDays, dateIdx, shiftKey);
      return {
        status: "available" as const,
        staffed,
        required: minimum.required,
        short: staffed < minimum.required,
      };
    });
    return {
      iso: day.iso,
      shifts,
      anyShort: shifts.some((shift) => shift.status === "available" && shift.short),
    };
  });
}

/**
 * A roster-level summary of coverage.
 *
 * UNKNOWN IS NOT GOOD NEWS. An `unavailable` lane means the baseline predicate
 * found nothing it could check — it is the absence of evidence, not evidence of
 * sufficiency. So the summary counts unavailable slots explicitly and the
 * "everything is fine" claim is scoped to what was actually checkable, with a
 * separate flag for whether anything was checkable at all.
 */
export interface CoverageSummary {
  /** How many (shift, day) slots are staffed below their minimum. */
  underMinimum: number;
  /** How many (shift, day) slots have a usable baseline (available). */
  totalAvailable: number;
  /** How many (shift, day) slots have NO usable baseline. */
  totalUnavailable: number;
  /**
   * Whether every CHECKABLE slot is staffed at or above minimum.
   *
   * False when nothing is checkable: with no baseline at all there is no claim
   * to make, and `true` here would be read as an all-clear. Callers that need to
   * distinguish "nothing short" from "nothing checked" read `anyCheckable`.
   */
  allCheckableStaffed: boolean;
  /** Whether ANY slot had a usable baseline. False = nothing was verifiable. */
  anyCheckable: boolean;
}

/** Summarise a coverage grid into a single roster-level statement. */
export function summariseCoverage(grid: CoverageGrid): CoverageSummary {
  let underMinimum = 0;
  let totalAvailable = 0;
  let totalUnavailable = 0;
  for (const day of grid) {
    for (const shift of day.shifts) {
      if (shift.status !== "available") {
        totalUnavailable++;
        continue;
      }
      totalAvailable++;
      if (shift.short) underMinimum++;
    }
  }
  return {
    underMinimum,
    totalAvailable,
    totalUnavailable,
    anyCheckable: totalAvailable > 0,
    allCheckableStaffed: totalAvailable > 0 && underMinimum === 0,
  };
}

/**
 * The worst coverage state for one day, for the Day-strip health dot.
 *
 * `under` = at least one available shift is Short; `at` = none Short but at
 * least one exactly at minimum; `ok` = every checkable shift is above minimum;
 * `unknown` = NOTHING on this day was checkable.
 *
 * `unknown` exists because the previous collapse of "no baseline" into `ok`
 * painted a green dot over a day the predicate never evaluated — a positive
 * staffing claim with nothing behind it. A day with a mix of checkable and
 * unavailable lanes still reports on what it could check; only a day with no
 * checkable lane at all is `unknown`.
 */
export function dayHealth(day: DayCoverage): "under" | "at" | "ok" | "unknown" {
  let hasAt = false;
  let checkable = 0;
  for (const shift of day.shifts) {
    if (shift.status !== "available") continue;
    checkable++;
    if (shift.short) return "under";
    if (shift.staffed === shift.required) hasAt = true;
  }
  if (checkable === 0) return "unknown";
  return hasAt ? "at" : "ok";
}

/** Re-exported so coverage consumers can read a baseline without reaching into F3. */
export type { RosterBaselineMinimum, RosterCalendarDay, RosterDayState };
