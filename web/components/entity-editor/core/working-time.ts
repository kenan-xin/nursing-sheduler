// Working-time UI validation for the shift-type editor (T09). The producer schema
// (T05) is the authority for the *whole-shape* rules — equal start/end (review
// finding #6), partial clock / start-only or end-only (#7), off-grid clocks,
// rest-vs-span, and the authoring-only `durationMinutes` invariant. This module
// surfaces those same rules as per-field UI messages by *reusing* T05's
// `validateWorkingTime` through a collecting shim context — so the editor and the
// serializer can never drift — and adds the 30-min-grid format check the producer
// enforces via `zClock` (which the whole-shape validator assumes already passed).
//
// No React here: pure, unit-testable under the node vitest env.

import type { z } from "zod";
import {
  clockMinutes,
  validateWorkingTime,
  type WorkingTimeFields,
} from "@/lib/scenario/schemas/working-time";
import { CLOCK_GRID_PATTERN } from "@/lib/scenario/schemas/primitives";

export type WorkingTimeField = "startTime" | "endTime" | "restMinutes" | "durationMinutes";

export interface WorkingTimeIssue {
  /** The field the message applies to, if any (whole-shape errors may be generic). */
  field?: WorkingTimeField;
  message: string;
}

/** The editable working-time fields on a shift-type draft. */
export interface WorkingTimeDraft {
  startTime?: string;
  endTime?: string;
  restMinutes?: number;
  durationMinutes?: number;
}

/** Alias used by the React sub-form (the controlled value shape). */
export type WorkingTimeValue = WorkingTimeDraft;

export interface WorkingTimeResult {
  ok: boolean;
  issues: WorkingTimeIssue[];
}

const GRID_MESSAGE = "Clock time must be on the 30-minute grid, e.g. '09:00' or '13:30'.";

/** Treat empty / whitespace-only strings as absent (form inputs may be ""). */
function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

/**
 * Validate a shift-type working-time draft against the producer's rules. Returns
 * per-field issues: grid format on each clock field, plus the whole-shape rules
 * (reused verbatim from T05). Whole-shape arithmetic only runs once both clocks are
 * grid-valid-or-absent, so an off-grid clock reports its own message rather than a
 * misleading derived one.
 */
export function validateWorkingTimeDraft(input: WorkingTimeDraft): WorkingTimeResult {
  const issues: WorkingTimeIssue[] = [];

  const startTime = nonEmpty(input.startTime);
  const endTime = nonEmpty(input.endTime);

  const startGridOk = startTime == null || CLOCK_GRID_PATTERN.test(startTime);
  const endGridOk = endTime == null || CLOCK_GRID_PATTERN.test(endTime);
  if (!startGridOk) issues.push({ field: "startTime", message: GRID_MESSAGE });
  if (!endGridOk) issues.push({ field: "endTime", message: GRID_MESSAGE });

  if (startGridOk && endGridOk) {
    const fields: WorkingTimeFields = {
      startTime,
      endTime,
      restMinutes: input.restMinutes,
      durationMinutes: input.durationMinutes,
    };
    const ctx = {
      addIssue(issue: { code?: string; message?: string; path?: (string | number)[] }) {
        const head = issue.path?.[0];
        issues.push({
          field: typeof head === "string" ? (head as WorkingTimeField) : undefined,
          message: issue.message ?? "Invalid working time.",
        });
      },
    };
    validateWorkingTime(fields, ctx as unknown as z.RefinementCtx);
  }

  return { ok: issues.length === 0, issues };
}

/**
 * The paid working minutes for a clock pair (span − rest), or `null` when the
 * clocks are absent/off-grid/equal or rest is invalid. Used to auto-fill the
 * authoring-only `durationMinutes` so a clock-authored shift always satisfies the
 * producer's "durationMinutes must equal paid minutes" whole-shape rule.
 */
export function paidMinutesFor(
  startTime: string | undefined,
  endTime: string | undefined,
  restMinutes?: number,
): number | null {
  if (startTime == null || endTime == null) return null;
  if (!CLOCK_GRID_PATTERN.test(startTime) || !CLOCK_GRID_PATTERN.test(endTime)) return null;
  const start = clockMinutes(startTime);
  let end = clockMinutes(endTime);
  if (end === start) return null;
  if (end < start) end += 24 * 60;
  const span = end - start;
  const rest = restMinutes ?? 0;
  if (rest < 0 || rest % 30 !== 0 || rest >= span) return null;
  return span - rest;
}
