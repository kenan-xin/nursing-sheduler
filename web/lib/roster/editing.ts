// Editing primitives (F5): atomic swap + single-level session undo.
//
// The overlay math (normalize / set / derive) already lives in `./overlay`. This
// module adds the two editing operations Core Flows Flow 3 names that are NOT a
// single `withRosterCellEdit`:
//
//   • SWAP — exchanging any two cells as ONE atomic edit. A swap is one
//     normalization, one coverage/tally recompute, one undo step, and one
//     autosave revision. It may produce zero, one, or two overlay entries
//     depending on how its results compare with the immutable baseline, because
//     setting a cell back to its solved value removes the entry (see `./overlay`).
//   • SESSION UNDO — single-level, session-scoped. After each set/swap the
//     previous overlay is retained as the one undo target; undo restores it and
//     clears the target, so undo is disabled once it has run. Redo and
//     reset-to-solved are deliberately out (Core Flows). Undo history is NOT
//     restored after reload — only the roster content is (`autosave` owns that).
//
// Everything here is PURE: it transforms overlays and returns new session state.
// Durability, retry, and the loss guard live in `./autosave`; the UI hook owns
// the one mutable coordinator. No storage, no React, no side effects.

import { dayStatesEqual } from "./day-state";
import { freezeEdits } from "./immutable";
import {
  normalizeRosterEdits,
  withRosterCellEdit,
  type NormalizeResult,
  type OverlayBounds,
} from "./overlay";
import type { RosterDayGrid, RosterDayState, RosterEdit } from "./types";

/** A cell coordinate on the roster grid. */
export interface EditCoordinate {
  readonly personIdx: number;
  readonly dateIdx: number;
}

/**
 * Exchange any two cells as ONE atomic edit. The two assignments are normalized
 * together, so the result is a single overlay revision: a cell landing on its
 * solved value removes its entry, and two cells swapped back to their original
 * positions leave the overlay empty.
 *
 * Dropping a cell on itself (or two equal coordinates) is a no-op: the swap is
 * the identity, so the overlay is returned unchanged and `touched` is `false` —
 * the caller should not create a revision or an undo step for it.
 *
 * `currentDays` is the assignments the swap reads from (solved + overlay). It is
 * taken explicitly rather than re-derived here so the caller and the swap agree
 * on exactly the grid the user is looking at, with no second derivation.
 */
export function swapRosterCells(
  edits: readonly RosterEdit[],
  a: EditCoordinate,
  b: EditCoordinate,
  currentDays: RosterDayGrid,
  bounds: OverlayBounds,
): NormalizeResult & { readonly touched: boolean } {
  // A self-swap is the identity. Detecting it BEFORE reading cells means a
  // pointer-up on the same cell (the common "I changed my mind" gesture) does
  // not invent an undo step or a save revision for a no-op.
  if (a.personIdx === b.personIdx && a.dateIdx === b.dateIdx) {
    return { ok: true, edits, touched: false };
  }

  const dayAtA = currentDays[a.personIdx]?.[a.dateIdx];
  const dayAtB = currentDays[b.personIdx]?.[b.dateIdx];
  if (dayAtA === undefined || dayAtB === undefined) {
    return { ok: false, reason: "swap targets a cell outside the roster grid", touched: false };
  }

  // Two assignments, one normalization: A takes B's current value and B takes
  // A's. Because normalization collapses duplicates and drops solved-equal
  // entries, this single call yields the zero/one/two-entry outcomes Core Flows
  // describes, with no special-casing.
  return normalizeWith(
    edits,
    [
      { personIdx: a.personIdx, dateIdx: a.dateIdx, day: dayAtB },
      { personIdx: b.personIdx, dateIdx: b.dateIdx, day: dayAtA },
    ],
    bounds,
    /* touched */ true,
  );
}

/**
 * The session-scoped editing state: the current overlay plus the single overlay
 * an undo would restore. `undoTarget` is `null` exactly when undo is disabled —
 * after a reload, after an undo has run, or before any edit has occurred.
 */
export interface EditSession {
  readonly edits: readonly RosterEdit[];
  readonly undoTarget: readonly RosterEdit[] | null;
}

/** A session with no edits and nothing to undo — the state after a fresh load. */
export function emptyEditSession(edits: readonly RosterEdit[]): EditSession {
  return { edits: freezeEdits(edits), undoTarget: null };
}

/** Whether there is a change an undo would revert. Derived, never stored. */
export function canUndoSession(session: EditSession): boolean {
  return session.undoTarget !== null;
}

/**
 * Set one cell, retaining the current overlay as the single undo target. The
 * previous undo target is discarded: undo is single-level, so a second edit
 * replaces the undo path rather than chaining beneath it.
 */
export function applyCellEditToSession(
  session: EditSession,
  coordinate: EditCoordinate,
  day: RosterDayState,
  bounds: OverlayBounds,
): NormalizeResult & { readonly session: EditSession } {
  const result = withRosterCellEdit(session.edits, coordinate, day, bounds);
  if (!result.ok) return { ...result, session };
  return { ...result, session: advanceSession(session, result.edits) };
}

/**
 * Swap two cells atomically, retaining the current overlay as the undo target.
 * A no-op swap (same cell, or two cells whose exchange leaves the overlay
 * unchanged) does NOT advance the undo target and returns the session unchanged.
 */
export function applyCellSwapToSession(
  session: EditSession,
  a: EditCoordinate,
  b: EditCoordinate,
  currentDays: RosterDayGrid,
  bounds: OverlayBounds,
): NormalizeResult & { readonly session: EditSession; readonly touched: boolean } {
  const result = swapRosterCells(session.edits, a, b, currentDays, bounds);
  if (!result.ok) return { ...result, session, touched: false };
  if (!result.touched) {
    // Identity swap: no revision, no undo step. The session is unchanged.
    return { ...result, session, touched: false };
  }
  return { ...result, session: advanceSession(session, result.edits), touched: true };
}

/**
 * Revert the last set/swap. Restores the retained undo target and clears it, so
 * undo becomes disabled afterwards (single-level). Undo itself is an edit: it
 * produces a fresh revision and the autosave queue treats it as one save unit.
 *
 * The returned `session.edits` is the restored overlay; `session.undoTarget` is
 * `null` because there is now nothing further to undo.
 */
export function undoSessionEdit(session: EditSession): EditSession {
  if (session.undoTarget === null) return session;
  return { edits: freezeEdits(session.undoTarget), undoTarget: null };
}

/**
 * Replace a session's overlay with a fresh external value (a Load, Import, or
 * reload after autosave commit). Undo history does not survive these: a loaded
 * roster has no proven undo path, and the overlay the autosave just wrote is the
 * new truth. Returns a session with no undo target.
 */
export function resetSession(session: EditSession, edits: readonly RosterEdit[]): EditSession {
  // Same overlay reference and already no undo target: nothing to do. This is
  // the common reload-after-commit path, where the autosaved overlay is the same
  // one already in the session.
  if (edits === session.edits && session.undoTarget === null) return session;
  return emptyEditSession(edits);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Advance to a new overlay, snapshotting the PRE-EDIT overlay as the single undo
 * target. The previous undo target is dropped: undo is one level deep.
 *
 * If the operation normalized to the SAME overlay (e.g. setting a cell to the
 * value it already holds), there is no new change to undo — the existing undo
 * target is preserved rather than cleared, so a real edit followed by a no-op
 * stays undoable.
 */
function advanceSession(session: EditSession, nextEdits: readonly RosterEdit[]): EditSession {
  if (overlaysEqual(session.edits, nextEdits)) {
    // No change: keep the current overlay's identity and its undo path intact.
    if (nextEdits === session.edits) return session;
    return { edits: nextEdits, undoTarget: session.undoTarget };
  }
  return { edits: nextEdits, undoTarget: freezeEdits(session.edits) };
}

function normalizeWith(
  edits: readonly RosterEdit[],
  additions: readonly RosterEdit[],
  bounds: OverlayBounds,
  touched: boolean,
): NormalizeResult & { readonly touched: boolean } {
  const result = normalizeRosterEdits([...edits, ...additions], bounds);
  if (!result.ok) return { ...result, touched: false };
  return { ok: true, edits: result.edits, touched };
}

/** Reference-and-value equality for two overlays, entry by entry. */
function overlaysEqual(left: readonly RosterEdit[], right: readonly RosterEdit[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (a.personIdx !== b.personIdx || a.dateIdx !== b.dateIdx) return false;
    if (!dayStatesEqual(a.day, b.day)) return false;
  }
  return true;
}
