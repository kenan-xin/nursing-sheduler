// Exact-shift plane tests (F4, rewritten for G7).
//
// The plane always states a real fact — who is on, and how many — and carries a
// target ONLY where the scenario declares one for that single shift. The
// discriminating cases are the negative ones: a group target must not appear on
// its member lanes, and a lane with no declared target must never read as short.

import { describe, expect, it } from "vitest";
import { computeCoverage, exactShiftCoverageLabel, uniformShiftRequirement } from "./coverage";
import { buildAssignmentIndex, buildEquations } from "./requirements";
import { PREFERENCE_TYPE } from "@/lib/scenario";
import type {
  CanonicalPreference,
  CanonicalScenarioDocument,
  UiTemporaryCover,
} from "@/lib/scenario";
import type { RosterContext, RosterDayGrid, RosterDayState } from "@/lib/roster";

const D: RosterDayState = { kind: "shift", shiftId: "D" };
const DPLUS: RosterDayState = { kind: "shift", shiftId: "D+" };
const N: RosterDayState = { kind: "shift", shiftId: "N" };
const OFF: RosterDayState = { kind: "off" };

const CONTEXT: RosterContext = {
  people: [{ id: "Ada" }, { id: "Bo" }, { id: "Cy" }],
  shiftTypes: [{ id: "D" }, { id: "D+" }, { id: "N" }],
  calendar: [
    { iso: "2026-07-01", weekday: "Wed", weekend: false, holiday: false },
    { iso: "2026-07-02", weekday: "Thu", weekend: false, holiday: false },
  ],
  // Left exactly as F3 writes it, and deliberately NOT consulted by
  // presentation any more: the ephemeral model is the single target authority.
  baselineMinimums: [
    { shiftId: "D", unavailable: true },
    { shiftId: "D+", unavailable: true },
    { shiftId: "N", unavailable: true },
  ],
  leaveCreditMinutes: null,
};

function documentWith(preferences: CanonicalPreference[]): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: "2026-07-01", endDate: "2026-07-02" } },
    people: { items: [{ id: "Ada" }, { id: "Bo" }, { id: "Cy" }] },
    shiftTypes: {
      items: [{ id: "D" }, { id: "D+" }, { id: "N" }],
      groups: [{ id: "AllDays", members: ["D", "D+"] }],
    },
    preferences,
  };
}

function requirement(
  shiftType: unknown,
  requiredNumPeople: number,
  date?: string,
): CanonicalPreference {
  return {
    type: PREFERENCE_TYPE.shiftTypeRequirement,
    shiftType,
    requiredNumPeople,
    ...(date === undefined ? {} : { date }),
    weight: -1,
  } as CanonicalPreference;
}

function modelFor(preferences: CanonicalPreference[]) {
  return { equations: buildEquations(documentWith(preferences)), reason: null };
}

/** The model with a temporary-cover ledger and live set (d582). */
function coveredModel(preferences: CanonicalPreference[], live: UiTemporaryCover[]) {
  return {
    equations: buildEquations(documentWith(preferences), { decrements: [], live }),
    reason: null,
  };
}

const HASEENA: UiTemporaryCover = {
  name: "Haseena (Ward 3)",
  date: "2026-07-01",
  shiftType: "D",
  groups: [],
};

/** Day 0: Ada+Cy on D, Bo on N. Day 1: Ada on D+, nobody else working. */
const GRID: RosterDayGrid = [
  [D, DPLUS],
  [N, OFF],
  [D, OFF],
];

describe("computeCoverage", () => {
  it("always states who is on and how many, in person-axis order", () => {
    const coverage = computeCoverage(CONTEXT, buildAssignmentIndex(CONTEXT, GRID), modelFor([]));
    expect(coverage[0].shifts[0]).toEqual({
      people: [0, 2],
      staffed: 2,
      required: null,
      cover: 0,
      short: false,
    });
    expect(coverage[0].shifts[2].people).toEqual([1]);
    expect(coverage[1].shifts[1].people).toEqual([0]);
    expect(coverage[1].shifts[0].staffed).toBe(0);
  });

  it("carries a target and flags Short only where the scenario declares one for that exact shift", () => {
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("D", 2)]),
    );
    expect(coverage[0].shifts[0]).toEqual({
      people: [0, 2],
      staffed: 2,
      required: 2,
      cover: 0,
      short: false,
    });
    // Day 1 has nobody on D against a declared 2.
    expect(coverage[1].shifts[0].short).toBe(true);
    expect(coverage[0].anyShort).toBe(false);
    expect(coverage[1].anyShort).toBe(true);
  });

  it("NEGATIVE CONTROL: a GROUP target never lands on its member lanes", () => {
    // `AllDays: 2` is one aggregate equation over D and D+. Dividing it would
    // report `D+` short on day 0 against a number the scenario never stated.
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("AllDays", 2)]),
    );
    for (const day of coverage) {
      for (const shift of day.shifts) {
        expect(shift.required).toBeNull();
        expect(shift.short).toBe(false);
      }
      expect(day.anyShort).toBe(false);
    }
  });

  it("leaves a lane with no declared target unflagged even when nobody is on it", () => {
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("D", 2)]),
    );
    // Nobody works N on day 1, but no requirement names N, so there is nothing
    // to be short against.
    expect(coverage[1].shifts[2]).toEqual({
      people: [],
      staffed: 0,
      required: null,
      cover: 0,
      short: false,
    });
  });

  it("carries a DATE-SCOPED target on its own date and none off-scope", () => {
    // THE DEFECT THIS REPLACES. The target was resolved once per shift and
    // copied across the calendar, so a one-day requirement produced no target
    // anywhere — Declared requirements showed it while the exact lane did not.
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("D", 2, "2026-07-01")]),
    );
    expect(coverage[0].shifts[0].required).toBe(2);
    expect(coverage[0].shifts[0].short).toBe(false);
    // Day 1 is out of scope: no target, and therefore nothing to be short of,
    // even though nobody works D that day.
    expect(coverage[1].shifts[0]).toEqual({
      people: [],
      staffed: 0,
      required: null,
      cover: 0,
      short: false,
    });
  });

  it("flags a scoped shortage on the scoped date only", () => {
    // Nobody works D on day 1; a requirement scoped THERE must go short, and the
    // unscoped day 0 must stay silent.
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("D", 1, "2026-07-02")]),
    );
    expect(coverage[0].shifts[0].required).toBeNull();
    expect(coverage[0].anyShort).toBe(false);
    expect(coverage[1].shifts[0].required).toBe(1);
    expect(coverage[1].shifts[0].short).toBe(true);
    expect(coverage[1].anyShort).toBe(true);
  });

  it("reads disjoint scoped equations for one shift as a different target per day", () => {
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("D", 2, "2026-07-01"), requirement("D", 5, "2026-07-02")]),
    );
    expect(coverage[0].shifts[0].required).toBe(2);
    expect(coverage[1].shifts[0].required).toBe(5);
  });

  it("suppresses only the OVERLAPPING day when two equations collide", () => {
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("D", 1), requirement("D", 2, "2026-07-01")]),
    );
    expect(coverage[0].shifts[0].required).toBeNull();
    expect(coverage[1].shifts[0].required).toBe(1);
  });

  it("states a lane label target only when every day agrees on it", () => {
    const scoped = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("D", 2, "2026-07-01")]),
    );
    // Varying by day: the row cannot state one number for the whole lane.
    expect(uniformShiftRequirement(scoped, 0)).toBeNull();

    const everyDay = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      modelFor([requirement("D", 2)]),
    );
    expect(uniformShiftRequirement(everyDay, 0)).toBe(2);
    expect(uniformShiftRequirement(everyDay, 2)).toBeNull();
  });

  it("recomputes from the CURRENT assignments", () => {
    const edited: RosterDayGrid = [
      [OFF, DPLUS],
      [N, OFF],
      [D, OFF],
    ];
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, edited),
      modelFor([requirement("D", 2)]),
    );
    expect(coverage[0].shifts[0].people).toEqual([2]);
    expect(coverage[0].shifts[0].short).toBe(true);
  });

  it("coverage counts a temporary cover", () => {
    // `D` needs 3 of the ward's own every day; Haseena (Ward 3) covers D on day 0.
    const coverage = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      coveredModel([requirement("D", 3)], [HASEENA]),
    );
    // Her day: the ward need is 2, so 2 of the ward's own SATISFIES it — and the
    // cell states both numbers instead of silently reading as if the ward alone
    // staffed it. She is never a person in `people`.
    expect(coverage[0].shifts[0]).toEqual({
      people: [0, 2],
      staffed: 2,
      required: 2,
      cover: 1,
      short: false,
    });
    expect(coverage[0].anyShort).toBe(false);

    // Off her date the declared 3 stands untouched, and nobody on it is Short
    // against it.
    expect(coverage[1].shifts[0]).toEqual({
      people: [],
      staffed: 0,
      required: 3,
      cover: 0,
      short: true,
    });
    // One number cannot stand for a lane whose target is 2 on one day and 3 on
    // the next.
    expect(uniformShiftRequirement(coverage, 0)).toBeNull();
  });

  it("leaves the lane target alone for a cover on a shift and date it does not name", () => {
    const elsewhere = computeCoverage(
      CONTEXT,
      buildAssignmentIndex(CONTEXT, GRID),
      coveredModel(
        [requirement("N", 2)],
        [{ name: "Haseena (Ward 3)", date: "2026-07-02", shiftType: "D+", groups: [] }],
      ),
    );
    expect(elsewhere[0].shifts[2]).toEqual({
      people: [1],
      staffed: 1,
      required: 2,
      cover: 0,
      short: true,
    });
  });
});

describe("exactShiftCoverageLabel", () => {
  it("reads the ward need and her credit side by side", () => {
    expect(
      exactShiftCoverageLabel({ people: [0, 2], staffed: 2, required: 2, cover: 1, short: false }),
    ).toBe("2/2 from the ward · +1 cover");
    expect(
      exactShiftCoverageLabel({ people: [0], staffed: 1, required: 2, cover: 2, short: false }),
    ).toBe("1/2 from the ward · +2 covers");
  });

  it("states the ward staff alone when she lowers nothing, and never invents a denominator", () => {
    expect(
      exactShiftCoverageLabel({ people: [0, 2], staffed: 2, required: 2, cover: 0, short: false }),
    ).toBe("2/2 from the ward");
    // No declared target: the cell still states who is on, with no `/n`.
    expect(
      exactShiftCoverageLabel({
        people: [0, 2],
        staffed: 2,
        required: null,
        cover: 0,
        short: false,
      }),
    ).toBe("2 from the ward");
  });
});
