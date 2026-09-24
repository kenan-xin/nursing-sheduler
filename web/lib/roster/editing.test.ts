// Editing primitive tests (F5): atomic swap + single-level session undo.
//
// These cover the load-bearing overlay outcomes Core Flows Flow 3 promises:
//   • swap is one atomic normalization that yields zero/one/two entries;
//   • a self-swap and an exchange-back-to-solved leave no overlay and no undo;
//   • undo is single-level, disabled after it runs, and session-scoped (reset
//     on Load/Import/reload);
//   • every operation reuses the overlay normalization, so "set to solved
//     removes the entry" and "editedSinceSolve clears when empty" hold by
//     construction.

import { describe, expect, it } from "vitest";
import { deriveCurrentDays } from "./overlay";
import {
  applyCellBatchToSession,
  applyCellEditToSession,
  applyCellSwapToSession,
  canUndoSession,
  emptyEditSession,
  resetSession,
  swapRosterCells,
  undoSessionEdit,
} from "./editing";
import { fixtureSolvedDays } from "./test-fixtures";
import type { OverlayBounds } from "./overlay";
import type { RosterEdit } from "./types";

const SHIFT_D = { kind: "shift", shiftId: "D" } as const;
const SHIFT_N = { kind: "shift", shiftId: "N" } as const;
const OFF = { kind: "off" } as const;
const LEAVE = { kind: "leave" } as const;

const BOUNDS: OverlayBounds = {
  solvedDays: fixtureSolvedDays(),
  shiftTypeIds: ["D", "N"],
};

// `edits` is empty, so currentDays is just the solved grid.
function currentDays(edits: readonly RosterEdit[] = []) {
  return deriveCurrentDays(BOUNDS.solvedDays, edits);
}

describe("swapRosterCells", () => {
  it("exchanges two cells with different values, producing two overlay entries", () => {
    // Solved: P0D0=D, P1D0=N. Swapping them: P0D0=N, P1D0=D -> both differ.
    const result = swapRosterCells(
      [],
      { personIdx: 0, dateIdx: 0 },
      { personIdx: 1, dateIdx: 0 },
      currentDays(),
      BOUNDS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.touched).toBe(true);
    expect(result.edits).toEqual<RosterEdit[]>([
      { personIdx: 0, dateIdx: 0, day: SHIFT_N },
      { personIdx: 1, dateIdx: 0, day: SHIFT_D },
    ]);
  });

  it("produces zero entries when two solved cells are swapped back to their solved values", () => {
    // Solved: P0D0=D, P1D0=N. Swap -> P0=N, P1=D. Swap AGAIN -> P0=D, P1=N.
    // The second swap reads the CURRENT grid, so it returns both to solved and
    // the normalized overlay is empty.
    const first = swapRosterCells(
      [],
      { personIdx: 0, dateIdx: 0 },
      { personIdx: 1, dateIdx: 0 },
      currentDays(),
      BOUNDS,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = swapRosterCells(
      first.edits,
      { personIdx: 0, dateIdx: 0 },
      { personIdx: 1, dateIdx: 0 },
      currentDays(first.edits),
      BOUNDS,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.edits).toEqual([]);
  });

  it("produces one entry when a swap returns one cell to its solved value", () => {
    // Solved: P0D0=D, P1D0=N. Edit P0D0->N first. Current after edit: P0D0=N,
    // P1D0=N(solved). Swap P0D0 and P1D0: P0D0 takes P1D0's value (N, differs
    // from solved D -> kept), P1D0 takes P0D0's value (N == solved N -> removed).
    // Result: exactly one entry.
    const oneEdit: RosterEdit[] = [{ personIdx: 0, dateIdx: 0, day: SHIFT_N }];
    const result = swapRosterCells(
      oneEdit,
      { personIdx: 0, dateIdx: 0 },
      { personIdx: 1, dateIdx: 0 },
      currentDays(oneEdit),
      BOUNDS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits).toEqual<RosterEdit[]>([{ personIdx: 0, dateIdx: 0, day: SHIFT_N }]);
  });

  it("treats a self-swap as a no-op (no touched, unchanged overlay)", () => {
    const result = swapRosterCells(
      [],
      { personIdx: 0, dateIdx: 0 },
      { personIdx: 0, dateIdx: 0 },
      currentDays(),
      BOUNDS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.touched).toBe(false);
    expect(result.edits).toEqual([]);
  });

  it("allows swapping across nurse and date, including OFF/Leave", () => {
    // P0D3=Leave, P1D2=OFF. Swap -> P0D3=OFF (differs from Leave), P1D2=Leave (differs from OFF).
    const result = swapRosterCells(
      [],
      { personIdx: 0, dateIdx: 3 },
      { personIdx: 1, dateIdx: 2 },
      currentDays(),
      BOUNDS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits).toEqual<RosterEdit[]>([
      { personIdx: 0, dateIdx: 3, day: OFF },
      { personIdx: 1, dateIdx: 2, day: LEAVE },
    ]);
  });

  it("fails closed when a coordinate is outside the grid", () => {
    const result = swapRosterCells(
      [],
      { personIdx: 0, dateIdx: 0 },
      { personIdx: 9, dateIdx: 0 },
      currentDays(),
      BOUNDS,
    );
    expect(result.ok).toBe(false);
  });
});

describe("EditSession — single-level undo", () => {
  it("starts with undo disabled", () => {
    expect(canUndoSession(emptyEditSession([]))).toBe(false);
  });

  it("records one undo target after a set, and undo restores the prior overlay", () => {
    let session = emptyEditSession([]);
    const set = applyCellEditToSession(session, { personIdx: 0, dateIdx: 0 }, SHIFT_N, BOUNDS);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    session = set.session;
    expect(canUndoSession(session)).toBe(true);
    expect(session.edits).toHaveLength(1);

    session = undoSessionEdit(session);
    expect(canUndoSession(session)).toBe(false);
    expect(session.edits).toEqual([]);
  });

  it("undo is single-level: a second edit replaces the undo path, not chains", () => {
    let session = emptyEditSession([]);
    session = applyCellEditToSession(
      session,
      { personIdx: 0, dateIdx: 0 },
      SHIFT_N,
      BOUNDS,
    ).session;
    session = applyCellEditToSession(
      session,
      { personIdx: 0, dateIdx: 1 },
      SHIFT_D,
      BOUNDS,
    ).session;
    expect(session.edits).toHaveLength(2);

    // Undo reverts BOTH edits back to the overlay before the second one only.
    session = undoSessionEdit(session);
    expect(session.edits).toEqual([{ personIdx: 0, dateIdx: 0, day: SHIFT_N }]);
    expect(canUndoSession(session)).toBe(false);
  });

  it("undo is disabled after it has run (no redo)", () => {
    let session = emptyEditSession([]);
    session = applyCellEditToSession(
      session,
      { personIdx: 0, dateIdx: 0 },
      SHIFT_N,
      BOUNDS,
    ).session;
    session = undoSessionEdit(session);
    // Undo again is a no-op: nothing to undo.
    const before = session;
    session = undoSessionEdit(session);
    expect(session).toBe(before);
  });

  it("a no-op set (value already held) does not create an undo target", () => {
    let session = emptyEditSession([]);
    session = applyCellEditToSession(
      session,
      { personIdx: 0, dateIdx: 0 },
      SHIFT_N,
      BOUNDS,
    ).session;
    // Set the SAME cell to the SAME value again.
    const result = applyCellEditToSession(session, { personIdx: 0, dateIdx: 0 }, SHIFT_N, BOUNDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The overlay is unchanged, so there is still exactly the one real edit and
    // the no-op did not advance the undo target.
    expect(result.session.edits).toEqual(session.edits);
    expect(canUndoSession(result.session)).toBe(true);
  });

  it("a swap that is a no-op (self-swap) does not advance the undo target", () => {
    let session = emptyEditSession([]);
    session = applyCellEditToSession(
      session,
      { personIdx: 0, dateIdx: 0 },
      SHIFT_N,
      BOUNDS,
    ).session;
    const before = session;
    const result = applyCellSwapToSession(
      session,
      { personIdx: 0, dateIdx: 1 },
      { personIdx: 0, dateIdx: 1 },
      currentDays(session.edits),
      BOUNDS,
    );
    expect(result.touched).toBe(false);
    expect(result.session).toBe(before);
  });

  it("resetSession drops undo history (Load/Import/reload have no undo path)", () => {
    let session = emptyEditSession([]);
    session = applyCellEditToSession(
      session,
      { personIdx: 0, dateIdx: 0 },
      SHIFT_N,
      BOUNDS,
    ).session;
    expect(canUndoSession(session)).toBe(true);

    session = resetSession(session, []);
    expect(canUndoSession(session)).toBe(false);
    expect(session.edits).toEqual([]);
  });

  it("resetSession keeps the same session when the overlay ref and undo are unchanged", () => {
    const session = emptyEditSession([]);
    // Passing the SAME edits reference with no undo target returns the same session.
    expect(resetSession(session, session.edits)).toBe(session);
  });
});

describe("applyCellBatchToSession", () => {
  it("sets several cells as ONE edit with ONE undo step", () => {
    const start = emptyEditSession([]);
    const result = applyCellBatchToSession(
      start,
      [
        { personIdx: 0, dateIdx: 0, day: SHIFT_N },
        { personIdx: 1, dateIdx: 0, day: SHIFT_D },
      ],
      BOUNDS,
    );
    expect(result.ok).toBe(true);
    expect(result.session.edits).toEqual<RosterEdit[]>([
      { personIdx: 0, dateIdx: 0, day: SHIFT_N },
      { personIdx: 1, dateIdx: 0, day: SHIFT_D },
    ]);
    expect(canUndoSession(result.session)).toBe(true);
    expect(undoSessionEdit(result.session).edits).toEqual([]);
  });

  it("rejects the whole batch when one cell is outside the grid", () => {
    const start = emptyEditSession([]);
    const result = applyCellBatchToSession(
      start,
      [
        { personIdx: 0, dateIdx: 0, day: SHIFT_N },
        { personIdx: 9, dateIdx: 0, day: SHIFT_D },
      ],
      BOUNDS,
    );
    expect(result.ok).toBe(false);
    expect(result.session).toBe(start);
  });
});

describe("EditSession — swap integration", () => {
  it("swap is one undo step covering both cells", () => {
    let session = emptyEditSession([]);
    const result = applyCellSwapToSession(
      session,
      { personIdx: 0, dateIdx: 0 },
      { personIdx: 1, dateIdx: 0 },
      currentDays(session.edits),
      BOUNDS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    session = result.session;
    expect(session.edits).toHaveLength(2);
    expect(canUndoSession(session)).toBe(true);

    session = undoSessionEdit(session);
    expect(session.edits).toEqual([]);
  });
});
