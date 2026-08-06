// The edits overlay: normalization plus the two derived truths (F3).
//
// `solvedDays` is immutable; `edits` is the only mutable part of a roster. Two
// things follow, and both are enforced here rather than trusted:
//
//   • `currentDays` is DERIVED — `solvedDays` with the overlay applied. It is
//     never stored, so it cannot drift from the baseline it is built on.
//   • `editedSinceSolve` is DERIVED — `edits.length > 0`. Because a normalized
//     overlay never contains an entry equal to its solved day-state, setting a
//     cell back to the solver's value REMOVES the entry and the flag clears by
//     itself. v1 needs no reset-to-solved action for that to hold.
//
// Normal form: entries sorted by `(personIdx, dateIdx)` ascending, at most one
// entry per coordinate, every coordinate in range, every day-state resolvable
// against the document's shift types, and no entry equal to `solvedDays`.
//
// `normalizeRosterEdits` CONSTRUCTS that form (collapsing duplicates, dropping
// solved-equal entries) for the editing path. `checkNormalizedEdits` REQUIRES it,
// for the import path — a file whose overlay is merely normalizable is rejected,
// not silently repaired, so two peers can never disagree about what a shared
// document says.

import type { ShiftTypeId } from "@/lib/scenario";
import { dayStatesEqual, isRosterDayState, isTypedId, typedIdKey } from "./day-state";
import { freezeDayState, freezeEdit, freezeEdits } from "./immutable";
import type { RosterDayGrid, RosterDayState, RosterEdit } from "./types";

/** A rejected overlay, with the specific reason (never a generic failure). */
export type OverlayCheck = { ok: true } | { ok: false; reason: string };

/** The immutable inputs an overlay is validated against. */
export interface OverlayBounds {
  solvedDays: RosterDayGrid;
  /** Every shift-type id a worked day-state may name. */
  shiftTypeIds: readonly ShiftTypeId[];
}

function shiftIdSet(shiftTypeIds: readonly ShiftTypeId[]): Set<string> {
  return new Set(shiftTypeIds.map(typedIdKey));
}

/** Whether a day-state's worked shift resolves to a known shift type. */
function isResolvable(day: RosterDayState, known: ReadonlySet<string>): boolean {
  return day.kind !== "shift" || known.has(typedIdKey(day.shiftId));
}

function isIndexWithin(value: unknown, length: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < length;
}

/** Whether a value is a structurally exact edit record (no unexpected fields). */
function isEditShape(value: unknown): value is RosterEdit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3) return false;
  return (
    "personIdx" in record && "dateIdx" in record && "day" in record && isRosterDayState(record.day)
  );
}

/**
 * Require an overlay to ALREADY be in normal form. Used by import validation, so
 * every failure names the offending coordinate.
 */
export function checkNormalizedEdits(edits: unknown, bounds: OverlayBounds): OverlayCheck {
  if (!Array.isArray(edits)) return { ok: false, reason: "edits is not an array" };
  const known = shiftIdSet(bounds.shiftTypeIds);
  const dateCount = bounds.solvedDays[0]?.length ?? 0;

  let previousKey = -1;
  for (let index = 0; index < edits.length; index++) {
    const entry: unknown = edits[index];
    if (!isEditShape(entry)) {
      return { ok: false, reason: `edits[${index}] is not an exact edit record` };
    }
    if (!isIndexWithin(entry.personIdx, bounds.solvedDays.length)) {
      return { ok: false, reason: `edits[${index}].personIdx is out of range` };
    }
    if (!isIndexWithin(entry.dateIdx, dateCount)) {
      return { ok: false, reason: `edits[${index}].dateIdx is out of range` };
    }
    if (!isResolvable(entry.day, known)) {
      return {
        ok: false,
        reason: `edits[${index}].day names an unknown shift type`,
      };
    }
    // A single strictly-increasing composite key proves BOTH the sort order and
    // the one-entry-per-coordinate rule in one pass: an out-of-order entry and a
    // duplicate coordinate are indistinguishable to a sorted-unique check, and
    // both are contract violations.
    const compositeKey = entry.personIdx * dateCount + entry.dateIdx;
    if (compositeKey <= previousKey) {
      return {
        ok: false,
        reason:
          `edits[${index}] is not strictly ordered after the previous entry ` +
          `(duplicate coordinate or unsorted overlay)`,
      };
    }
    previousKey = compositeKey;

    const solved = bounds.solvedDays[entry.personIdx][entry.dateIdx];
    if (dayStatesEqual(entry.day, solved)) {
      return {
        ok: false,
        reason: `edits[${index}] equals its solved day-state and must not be stored`,
      };
    }
  }
  return { ok: true };
}
/** A constructed overlay, or the reason the input could not produce one. */
export type NormalizeResult =
  | { ok: true; edits: readonly RosterEdit[] }
  | { ok: false; reason: string };

/**
 * Build the normal form from arbitrary in-range entries: later entries for the
 * same coordinate win, solved-equal entries are dropped, and the result is sorted.
 * Out-of-range coordinates and unresolvable day-states are rejected rather than
 * dropped — they are caller bugs, not redundancy.
 */
export function normalizeRosterEdits(
  entries: readonly RosterEdit[],
  bounds: OverlayBounds,
): NormalizeResult {
  const known = shiftIdSet(bounds.shiftTypeIds);
  const dateCount = bounds.solvedDays[0]?.length ?? 0;
  const byCoordinate = new Map<number, RosterEdit>();

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!isEditShape(entry)) {
      return { ok: false, reason: `entry ${index} is not an exact edit record` };
    }
    if (!isIndexWithin(entry.personIdx, bounds.solvedDays.length)) {
      return { ok: false, reason: `entry ${index} has an out-of-range personIdx` };
    }
    if (!isIndexWithin(entry.dateIdx, dateCount)) {
      return { ok: false, reason: `entry ${index} has an out-of-range dateIdx` };
    }
    if (!isResolvable(entry.day, known)) {
      return { ok: false, reason: `entry ${index} names an unknown shift type` };
    }
    const compositeKey = entry.personIdx * dateCount + entry.dateIdx;
    const solved = bounds.solvedDays[entry.personIdx][entry.dateIdx];
    if (dayStatesEqual(entry.day, solved)) {
      // Returning a cell to its solved value removes the overlay entry.
      byCoordinate.delete(compositeKey);
      continue;
    }
    // A fresh frozen entry, so the overlay shares no day-state object with the
    // caller's input, with `solvedDays`, or with a previous overlay it replaced.
    // One tiny object per EDIT (overlays are sparse by construction), so this costs
    // nothing next to the per-cell work normalization already does.
    byCoordinate.set(compositeKey, freezeEdit(entry));
  }

  const edits = Array.from(byCoordinate.entries())
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => entry);
  return { ok: true, edits: Object.freeze(edits) };
}

/**
 * Set one cell and return the re-normalized overlay. This is the single primitive
 * F5's set/swap/undo build on, so "choosing the solved value clears the edit" is
 * true by construction rather than by remembering to check.
 */
export function withRosterCellEdit(
  edits: readonly RosterEdit[],
  coordinate: { personIdx: number; dateIdx: number },
  day: RosterDayState,
  bounds: OverlayBounds,
): NormalizeResult {
  return normalizeRosterEdits(
    [...edits, { personIdx: coordinate.personIdx, dateIdx: coordinate.dateIdx, day }],
    bounds,
  );
}

/**
 * The current assignments: `solvedDays` with the overlay applied.
 *
 * Every CELL is a fresh frozen copy, not just every row. Copying rows alone — the
 * original implementation — leaves each day-state object shared, so
 * `current[0][0].shiftId = …` would rewrite `solvedDays` in place and silently
 * invalidate `solvedBaselineId` without passing through normalization. Edited cells
 * would likewise share their object with the overlay entry.
 */
export function deriveCurrentDays(
  solvedDays: RosterDayGrid,
  edits: readonly RosterEdit[],
): RosterDayGrid {
  const current = solvedDays.map((row) => row.map(freezeDayState));
  for (const entry of edits) {
    current[entry.personIdx][entry.dateIdx] = freezeDayState(entry.day);
  }
  return Object.freeze(current.map((row) => Object.freeze(row)));
}

/** Whether the roster diverges from its solved baseline. Derived, never stored. */
export function deriveEditedSinceSolve(edits: readonly RosterEdit[]): boolean {
  return edits.length > 0;
}

/** Re-exported so overlay consumers need not reach into `./day-state`. */
export { isTypedId, freezeEdits };
