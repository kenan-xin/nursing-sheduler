// The edits overlay (F3): normalization, the derived truths, and the strict
// already-normalized check the import path uses. Each rejection case is paired
// with the accepting control, so a test cannot pass because the whole input was
// rejected for an unrelated reason.

import { describe, expect, it } from "vitest";
import {
  checkNormalizedEdits,
  deriveCurrentDays,
  deriveEditedSinceSolve,
  normalizeRosterEdits,
  withRosterCellEdit,
  type OverlayBounds,
} from "./overlay";
import type { RosterDayState, RosterEdit } from "./types";

const D: RosterDayState = { kind: "shift", shiftId: "D" };
const N: RosterDayState = { kind: "shift", shiftId: "N" };
const OFF: RosterDayState = { kind: "off" };
const LEAVE: RosterDayState = { kind: "leave" };

function bounds(): OverlayBounds {
  return {
    solvedDays: [
      [D, OFF, N],
      [N, D, OFF],
    ],
    shiftTypeIds: ["D", "N"],
  };
}

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

describe("normalizeRosterEdits", () => {
  it("sorts by (personIdx, dateIdx) and keeps one entry per coordinate", () => {
    const result = expectOk(
      normalizeRosterEdits(
        [
          { personIdx: 1, dateIdx: 0, day: LEAVE },
          { personIdx: 0, dateIdx: 2, day: D },
          // A second write to the same coordinate: the later value wins.
          { personIdx: 1, dateIdx: 0, day: OFF },
        ],
        bounds(),
      ),
    );
    expect(result.edits).toEqual([
      { personIdx: 0, dateIdx: 2, day: D },
      { personIdx: 1, dateIdx: 0, day: OFF },
    ]);
  });

  it("drops an entry equal to its solved day-state, id type included", () => {
    // solvedDays[0][0] is shift D: writing D again is not an edit.
    const dropped = expectOk(
      normalizeRosterEdits(
        [{ personIdx: 0, dateIdx: 0, day: { kind: "shift", shiftId: "D" } }],
        bounds(),
      ),
    );
    expect(dropped.edits).toEqual([]);

    // Control: a genuinely different value IS kept.
    const kept = expectOk(normalizeRosterEdits([{ personIdx: 0, dateIdx: 0, day: N }], bounds()));
    expect(kept.edits).toHaveLength(1);
  });

  it("treats a numeric shift id as distinct from the same-looking string id", () => {
    const numericBounds: OverlayBounds = {
      solvedDays: [[{ kind: "shift", shiftId: 1 }]],
      shiftTypeIds: [1, "1"],
    };
    // Writing the STRING "1" over a solved NUMERIC 1 is a real edit, not a no-op.
    const result = expectOk(
      normalizeRosterEdits(
        [{ personIdx: 0, dateIdx: 0, day: { kind: "shift", shiftId: "1" } }],
        numericBounds,
      ),
    );
    expect(result.edits).toEqual([
      { personIdx: 0, dateIdx: 0, day: { kind: "shift", shiftId: "1" } },
    ]);
  });

  it("rejects an out-of-range coordinate rather than dropping it", () => {
    expect(normalizeRosterEdits([{ personIdx: 2, dateIdx: 0, day: OFF }], bounds())).toMatchObject({
      ok: false,
    });
    expect(normalizeRosterEdits([{ personIdx: 0, dateIdx: 3, day: OFF }], bounds())).toMatchObject({
      ok: false,
    });
    expect(normalizeRosterEdits([{ personIdx: -1, dateIdx: 0, day: OFF }], bounds())).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it("rejects a day-state naming an unknown shift type", () => {
    expect(
      normalizeRosterEdits(
        [{ personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "X" } }],
        bounds(),
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("withRosterCellEdit", () => {
  it("adds, replaces, and then removes an entry as the cell returns to solved", () => {
    const b = bounds();
    const added = expectOk(withRosterCellEdit([], { personIdx: 0, dateIdx: 0 }, N, b));
    expect(added.edits).toEqual([{ personIdx: 0, dateIdx: 0, day: N }]);
    expect(deriveEditedSinceSolve(added.edits)).toBe(true);

    const replaced = expectOk(
      withRosterCellEdit(added.edits, { personIdx: 0, dateIdx: 0 }, LEAVE, b),
    );
    expect(replaced.edits).toEqual([{ personIdx: 0, dateIdx: 0, day: LEAVE }]);

    // Choosing the solver's own value clears the overlay AND the derived flag,
    // with no reset-to-solved action involved.
    const cleared = expectOk(
      withRosterCellEdit(replaced.edits, { personIdx: 0, dateIdx: 0 }, D, b),
    );
    expect(cleared.edits).toEqual([]);
    expect(deriveEditedSinceSolve(cleared.edits)).toBe(false);
  });

  it("leaves other coordinates untouched when one returns to solved", () => {
    const b = bounds();
    const two = expectOk(
      normalizeRosterEdits(
        [
          { personIdx: 0, dateIdx: 0, day: N },
          { personIdx: 1, dateIdx: 2, day: LEAVE },
        ],
        b,
      ),
    );
    const one = expectOk(withRosterCellEdit(two.edits, { personIdx: 0, dateIdx: 0 }, D, b));
    expect(one.edits).toEqual([{ personIdx: 1, dateIdx: 2, day: LEAVE }]);
  });
});

describe("deriveCurrentDays", () => {
  it("applies the overlay without mutating the immutable baseline", () => {
    const b = bounds();
    const current = deriveCurrentDays(b.solvedDays, [{ personIdx: 1, dateIdx: 1, day: LEAVE }]);
    expect(current[1][1]).toEqual(LEAVE);
    expect(b.solvedDays[1][1]).toEqual(D);
  });

  it("equals the baseline exactly when there are no edits", () => {
    const b = bounds();
    expect(deriveCurrentDays(b.solvedDays, [])).toEqual(b.solvedDays);
  });

  it("shares no day-state OBJECT with the baseline or the overlay", () => {
    // Row-only copying (the original implementation) left every CELL shared, so
    // `current[0][0].shiftId = …` rewrote the baseline in place and silently
    // invalidated `solvedBaselineId`. Identity, not just equality, is the contract.
    const b = bounds();
    const edits: RosterEdit[] = [{ personIdx: 0, dateIdx: 0, day: N }];
    const current = deriveCurrentDays(b.solvedDays, edits);

    expect(current[1][1]).not.toBe(b.solvedDays[1][1]);
    expect(current[0][0]).not.toBe(edits[0].day);
    expect(current[0]).not.toBe(b.solvedDays[0]);
  });

  it("cannot be mutated to change the solved baseline or the edits", () => {
    const b = bounds();
    const solvedBefore = structuredClone(b.solvedDays);
    const edits: RosterEdit[] = [{ personIdx: 0, dateIdx: 0, day: N }];
    const editsBefore = structuredClone(edits);
    const current = deriveCurrentDays(b.solvedDays, edits);

    // Frozen through every level, so an untyped caller cannot write at all.
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current[0])).toBe(true);
    expect(Object.isFrozen(current[0][0])).toBe(true);

    // ES modules are strict mode, so each of these THROWS rather than failing quietly.
    expect(() => {
      (current[1][1] as { shiftId: string }).shiftId = "HACKED";
    }).toThrow(TypeError);
    expect(() => {
      (current[0] as RosterDayState[])[1] = LEAVE;
    }).toThrow(TypeError);
    expect(() => {
      (current as RosterDayState[][])[0] = [];
    }).toThrow(TypeError);

    expect(b.solvedDays).toEqual(solvedBefore);
    expect(edits).toEqual(editsBefore);
  });
});

describe("overlay immutability", () => {
  it("returns frozen entries that alias neither the input nor the baseline", () => {
    const b = bounds();
    const input: RosterEdit = { personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "N" } };
    const result = expectOk(normalizeRosterEdits([input], b));

    expect(result.edits[0]).not.toBe(input);
    expect(result.edits[0].day).not.toBe(input.day);
    expect(Object.isFrozen(result.edits)).toBe(true);
    expect(Object.isFrozen(result.edits[0])).toBe(true);
    expect(Object.isFrozen(result.edits[0].day)).toBe(true);

    // Mutating the ORIGINAL input afterwards cannot reach the normalized overlay.
    (input as { personIdx: number }).personIdx = 1;
    expect(result.edits[0].personIdx).toBe(0);
  });

  it("does not let a superseded overlay entry alias the replacement", () => {
    const b = bounds();
    const first = expectOk(withRosterCellEdit([], { personIdx: 0, dateIdx: 0 }, N, b));
    const second = expectOk(
      withRosterCellEdit(first.edits, { personIdx: 0, dateIdx: 0 }, LEAVE, b),
    );
    expect(second.edits[0]).not.toBe(first.edits[0]);
    expect(first.edits[0].day).toEqual(N);
  });
});

describe("checkNormalizedEdits", () => {
  const normal: RosterEdit[] = [
    { personIdx: 0, dateIdx: 1, day: N },
    { personIdx: 1, dateIdx: 0, day: OFF },
  ];

  it("accepts an overlay already in normal form", () => {
    expect(checkNormalizedEdits(normal, bounds())).toEqual({ ok: true });
    expect(checkNormalizedEdits([], bounds())).toEqual({ ok: true });
  });

  it("rejects an unsorted overlay instead of silently repairing it", () => {
    expect(checkNormalizedEdits([normal[1], normal[0]], bounds())).toMatchObject({ ok: false });
  });

  it("rejects a duplicate coordinate", () => {
    expect(
      checkNormalizedEdits([normal[0], { personIdx: 0, dateIdx: 1, day: LEAVE }], bounds()),
    ).toMatchObject({ ok: false });
  });

  it("rejects an entry equal to its solved day-state", () => {
    expect(checkNormalizedEdits([{ personIdx: 0, dateIdx: 0, day: D }], bounds())).toMatchObject({
      ok: false,
    });
  });

  it("rejects a record carrying an unexpected field", () => {
    expect(checkNormalizedEdits([{ ...normal[0], note: "why" }], bounds())).toMatchObject({
      ok: false,
    });
  });

  it("rejects a multi-shift or malformed day-state", () => {
    expect(
      checkNormalizedEdits(
        [{ personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: ["D", "N"] } }],
        bounds(),
      ),
    ).toMatchObject({ ok: false });
    expect(
      checkNormalizedEdits([{ personIdx: 0, dateIdx: 1, day: { kind: "holiday" } }], bounds()),
    ).toMatchObject({ ok: false });
  });

  it("rejects a non-array overlay and a fractional index", () => {
    expect(checkNormalizedEdits({ 0: normal[0] }, bounds())).toMatchObject({ ok: false });
    expect(checkNormalizedEdits([{ personIdx: 0.5, dateIdx: 1, day: N }], bounds())).toMatchObject({
      ok: false,
    });
  });
});
