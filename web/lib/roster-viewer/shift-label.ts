// Shift context labels (G7).
//
// `am1` / `am1+` / `long+` are unreadable on their own: the Ward 8 audit found
// that a scheduler cannot tell a 08:00–15:00 early morning from a 08:00–17:00
// extended one without decoding the id. The scenario already carries the answer
// (`startTime`/`endTime`/`description`), so every surface that names a shift can
// name its hours too.
//
// Missing fields fall back to the id rather than blocking the view — a scenario
// that omits times is still a valid scenario.

import type { RosterContextShiftType } from "@/lib/roster";

/** `08:00–15:00`, or null when the submission does not fix both ends. */
export function shiftTimeRange(shift: RosterContextShiftType): string | null {
  const { startTime, endTime } = shift;
  if (typeof startTime !== "string" || startTime.length === 0) return null;
  if (typeof endTime !== "string" || endTime.length === 0) return null;
  return `${startTime}–${endTime}`;
}

/**
 * The complete spoken/`title` label for a shift: id, hours when known, and the
 * authored description when there is one. This is the accessible name behind any
 * compact visual label, so the full context is never only visual.
 */
export function shiftContextLabel(shift: RosterContextShiftType): string {
  const parts: string[] = [String(shift.id)];
  const time = shiftTimeRange(shift);
  if (time !== null) parts.push(time);
  if (typeof shift.description === "string" && shift.description.length > 0) {
    parts.push(shift.description);
  }
  return parts.join(" · ");
}
