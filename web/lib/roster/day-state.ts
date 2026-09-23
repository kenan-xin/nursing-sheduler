// Day-state predicates, equality, and the display codec (F3).
//
// The display codec is the single mapping between a day-state and the string an
// XLSX cell carries (`exporter.py`): OFF → `""`, Leave → `"Leave"`, worked → the
// shift id. F5's edited-XLSX patch and the viewer both read it from here so the
// two can never disagree.

import type { PersonId, ShiftTypeId } from "@/lib/scenario";
import type { RosterDayState } from "./types";

/** The literal an OFF cell carries in the workbook. */
export const OFF_DISPLAY = "";
/** The literal a Leave cell carries in the workbook. */
export const LEAVE_DISPLAY = "Leave";

/**
 * Whether a value is a usable typed id: a non-empty string, or a safe integer.
 *
 * Numeric `1` and string `"1"` are DISTINCT ids throughout (`types.ts` models
 * both as `number | string`), so nothing here stringifies an id to compare it.
 * Non-integer, non-finite, and unsafe-magnitude numbers are rejected outright —
 * they cannot survive a JSON round-trip without silently changing value.
 */
export function isTypedId(value: unknown): value is PersonId & ShiftTypeId {
  if (typeof value === "string") return value.length > 0;
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** A type-aware identity key, so numeric `1` and string `"1"` never collide. */
export function typedIdKey(id: PersonId | ShiftTypeId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

/** Whether a value is a well-formed day-state with no unexpected fields. */
export function isRosterDayState(value: unknown): value is RosterDayState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.kind === "off" || record.kind === "leave") {
    return keys.length === 1;
  }
  if (record.kind === "shift") {
    return keys.length === 2 && "shiftId" in record && isTypedId(record.shiftId);
  }
  return false;
}

/** Structural equality of two day-states, id type included. */
export function dayStatesEqual(left: RosterDayState, right: RosterDayState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "shift" && right.kind === "shift") {
    return typedIdKey(left.shiftId) === typedIdKey(right.shiftId);
  }
  return true;
}

/** The workbook/grid display string for a day-state. */
export function dayStateDisplay(day: RosterDayState): string {
  if (day.kind === "off") return OFF_DISPLAY;
  if (day.kind === "leave") return LEAVE_DISPLAY;
  return String(day.shiftId);
}
