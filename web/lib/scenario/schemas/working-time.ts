// Shared working-time whole-shape validation (T05).
//
// Mirrors `core/nurse_scheduling/models.py` `ShiftType._validate_working_time`
// (lines 94-150): the accepted combinations of startTime/endTime/restMinutes/
// durationMinutes. Both the strict producer schema and the lenient import schema
// apply this via `.superRefine` so the two agree by construction.
//
// The field type accepts `null` (the import path is lenient about omitted fields
// and uses `.nullish()`); `!= null` treats null identically to absence.

import type { z } from "zod";

/** The working-time fields on a shift type, nullable for the import path. */
export interface WorkingTimeFields {
  startTime?: string | null;
  endTime?: string | null;
  restMinutes?: number | null;
  durationMinutes?: number | null;
}

/** Minutes since midnight for a grid-valid "HH:MM" clock string. */
export function clockMinutes(clock: string): number {
  const [hours, minutes] = clock.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Validate the working-time whole shapes (mirrors
 * `ShiftType._validate_working_time`). Accepts exactly two shapes:
 *   (a) bare positive `durationMinutes` divisible by 30; or
 *   (b) paired `startTime`/`endTime` with optional absent rest (== 0) and a
 *       required `durationMinutes` equal to the paid minutes.
 * Everything partial/disagreeing/off-grid/non-positive is rejected.
 *
 * `restMinutes: 0` is accepted then canonicalized to omission elsewhere.
 */
export function validateWorkingTime(st: WorkingTimeFields, ctx: z.RefinementCtx): void {
  const addIssue = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: "custom", message, path });

  const rest = st.restMinutes === 0 ? undefined : st.restMinutes;

  const hasStart = st.startTime != null;
  const hasEnd = st.endTime != null;
  const hasRest = rest != null;
  const hasDuration = st.durationMinutes != null;

  if (hasStart !== hasEnd) {
    addIssue("startTime and endTime must be provided together.");
    return;
  }

  if (hasStart && hasEnd) {
    const start = clockMinutes(st.startTime!);
    let end = clockMinutes(st.endTime!);
    if (end === start) {
      addIssue("startTime and endTime must differ.", ["endTime"]);
      return;
    }
    if (end < start) end += 24 * 60; // Overnight shift.
    const span = end - start;
    const restValue = rest ?? 0;
    if (restValue < 0 || restValue % 30 !== 0) {
      addIssue("restMinutes must be a non-negative multiple of 30.", ["restMinutes"]);
      return;
    }
    if (restValue >= span) {
      addIssue("restMinutes must be less than the shift span.", ["restMinutes"]);
      return;
    }
    const paid = span - restValue;
    if (!hasDuration) {
      addIssue("durationMinutes is required when startTime and endTime are set.", [
        "durationMinutes",
      ]);
      return;
    }
    if (st.durationMinutes !== paid) {
      addIssue(
        `durationMinutes (${st.durationMinutes}) must equal the paid working minutes ` +
          `(${paid} = span ${span} - rest ${restValue}).`,
        ["durationMinutes"],
      );
    }
    return;
  }

  // No clock times.
  if (hasRest) {
    addIssue("restMinutes requires startTime and endTime.", ["restMinutes"]);
    return;
  }
  if (hasDuration) {
    if (st.durationMinutes! <= 0) {
      addIssue("durationMinutes must be positive.", ["durationMinutes"]);
      return;
    }
    if (st.durationMinutes! % 30 !== 0) {
      addIssue("durationMinutes must be a multiple of 30.", ["durationMinutes"]);
    }
  }
}
