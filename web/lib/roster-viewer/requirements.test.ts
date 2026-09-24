// Ephemeral staffing-equation projection tests (G7).
//
// The point is that this model is DISCRIMINATING against the backend contract in
// `core/nurse_scheduling/preference_types.py`. Each case below pins a shape the
// solver reads a specific way, and several are negative controls for the exact
// mistakes a plausible-looking implementation makes: merging a flat list into one
// equation, letting a satisfied qualified numerator hide a forbidden unqualified
// assignment, relabelling weighted units as people, or copying a group target
// down onto a member shift.

import { describe, expect, it } from "vitest";
import {
  buildAssignmentIndex,
  buildEquations,
  computeRequirementGrid,
  deriveRequirementModel,
  evaluateRequirementCell,
  exactShiftRequirement,
  requirementDayHealth,
  summariseRequirements,
  type RequirementCell,
  type RequirementEquation,
} from "./requirements";
import { PREFERENCE_TYPE, serializeCanonicalDocument } from "@/lib/scenario";
import type {
  CanonicalPreference,
  CanonicalScenarioDocument,
  CanonicalShiftTypeGroup,
} from "@/lib/scenario";
import type { RosterContext, RosterDayGrid, RosterDayState } from "@/lib/roster";

const SHIFT_IDS = ["D", "D+", "E", "N"] as const;

function shift(id: string): RosterDayState {
  return { kind: "shift", shiftId: id };
}
const OFF: RosterDayState = { kind: "off" };

/** A four-shift, four-person, two-day scenario the cases below vary. */
function documentWith(
  preferences: CanonicalPreference[],
  groups: CanonicalShiftTypeGroup[] = [],
): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: "2026-07-01", endDate: "2026-07-02" } },
    people: {
      items: [{ id: "Ada" }, { id: "Bo" }, { id: "Cy" }, { id: "Di" }],
      groups: [{ id: "Seniors", members: ["Ada", "Bo"] }],
    },
    shiftTypes: {
      items: SHIFT_IDS.map((id) => ({
        id,
        startTime: "08:00",
        endTime: "16:00",
        durationMinutes: 480,
      })),
      groups,
    },
    // The producer schema requires the exclusivity preference, and it is the
    // constraint that makes one day-state per cell true in the first place.
    preferences: [{ type: PREFERENCE_TYPE.maxOneShiftPerDay }, ...preferences],
  };
}

function requirement(
  body: Partial<Extract<CanonicalPreference, { type: "shift type requirement" }>> & {
    shiftType: unknown;
    requiredNumPeople: number;
  },
): CanonicalPreference {
  return {
    type: PREFERENCE_TYPE.shiftTypeRequirement,
    weight: -1,
    ...body,
  } as CanonicalPreference;
}

/** The roster axes the assignment index aligns to. */
function contextFor(document: CanonicalScenarioDocument): RosterContext {
  return {
    people: document.people.items.map((person) => ({ id: person.id })),
    shiftTypes: document.shiftTypes.items.map((item) => ({ id: item.id })),
    calendar: [
      { iso: "2026-07-01", weekday: "Wed", weekend: false, holiday: false },
      { iso: "2026-07-02", weekday: "Thu", weekend: false, holiday: false },
    ],
    baselineMinimums: document.shiftTypes.items.map((item) => ({
      shiftId: item.id,
      unavailable: true as const,
    })),
    leaveCreditMinutes: null,
  };
}

function indexFor(document: CanonicalScenarioDocument, days: RosterDayGrid) {
  return buildAssignmentIndex(contextFor(document), days);
}

/** Narrow to the evaluated verdict, failing loudly on any other status. */
function checked(cell: RequirementCell): Extract<RequirementCell, { status: "checked" }> {
  if (cell.status !== "checked") throw new Error(`expected a checked cell, got ${cell.status}`);
  return cell;
}

function scopes(equations: readonly RequirementEquation[]): string[] {
  return equations.map((equation) => equation.scopeLabel);
}

describe("normalization mirrors the backend grouping rules", () => {
  it("reads a scalar selector as ONE equation over its resolved shifts", () => {
    const document = documentWith([requirement({ shiftType: "D", requiredNumPeople: 1 })]);
    const equations = buildEquations(document);
    expect(scopes(equations)).toEqual(["D"]);
    expect(equations[0].shiftIndices).toEqual([0]);
  });

  it("reads a FLAT top-level list as INDEPENDENT equations, never one union", () => {
    // `[D, E]` is `sum_p shifts[D] == 1` AND `sum_p shifts[E] == 1`. Merging it
    // into one `D+E >= 1` equation would report a roster satisfied while the
    // solver's second constraint is violated.
    const document = documentWith([requirement({ shiftType: ["D", "E"], requiredNumPeople: 1 })]);
    const equations = buildEquations(document);
    expect(scopes(equations)).toEqual(["D", "E"]);
    expect(equations.map((equation) => equation.shiftIndices)).toEqual([[0], [2]]);

    // One person on D only: D is satisfied, E is Short 1 — two separate verdicts.
    const days: RosterDayGrid = [
      [shift("D"), OFF],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const index = indexFor(document, days);
    expect(checked(evaluateRequirementCell(equations[0], index, 0)).mismatch).toBe(false);
    expect(checked(evaluateRequirementCell(equations[1], index, 0)).short).toBe(1);
  });

  it("reads a NESTED list as one aggregate equation", () => {
    const document = documentWith([requirement({ shiftType: [["D", "E"]], requiredNumPeople: 1 })]);
    const equations = buildEquations(document);
    expect(equations).toHaveLength(1);
    expect(equations[0].shiftIndices).toEqual([0, 2]);

    const days: RosterDayGrid = [
      [shift("D"), OFF],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const index = indexFor(document, days);
    expect(checked(evaluateRequirementCell(equations[0], index, 0)).mismatch).toBe(false);
  });

  it("reads a GROUP selector as one aggregate equation and never splits it per member", () => {
    const document = documentWith(
      [requirement({ shiftType: "AllDays", requiredNumPeople: 2 })],
      [{ id: "AllDays", members: ["D", "D+"] }],
    );
    const equations = buildEquations(document);
    expect(equations).toHaveLength(1);
    expect(equations[0].shiftIndices).toEqual([0, 1]);

    // Two people across the two member shifts satisfies the group — and neither
    // member shift inherits a target of its own.
    const days: RosterDayGrid = [
      [shift("D"), OFF],
      [shift("D+"), OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const index = indexFor(document, days);
    expect(checked(evaluateRequirementCell(equations[0], index, 0)).units).toBe(2);
    const model = { equations, reason: null };
    expect(exactShiftRequirement(model, 0, 2)).toBeNull();
    expect(exactShiftRequirement(model, 1, 2)).toBeNull();
  });

  it("keeps layered/duplicate equations as separate rows in source order", () => {
    const document = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1, description: "first" }),
      requirement({ shiftType: "D", requiredNumPeople: 2, description: "second" }),
    ]);
    const equations = buildEquations(document);
    expect(equations.map((equation) => equation.description)).toEqual(["first", "second"]);
    expect(equations.map((equation) => equation.required)).toEqual([1, 2]);
    // Two layered targets on one shift means no single exact-shift number exists.
    expect(exactShiftRequirement({ equations, reason: null }, 0, 2)).toBeNull();
  });
});

describe("date applicability", () => {
  it("renders a date-scoped equation NOT APPLICABLE outside its dates, never zero", () => {
    const document = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1, date: "2026-07-01" }),
    ]);
    const equations = buildEquations(document);
    const index = indexFor(document, [
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ]);
    // Day 0 applies and is short; day 1 is out of scope and makes no claim.
    expect(checked(evaluateRequirementCell(equations[0], index, 0)).short).toBe(1);
    expect(evaluateRequirementCell(equations[0], index, 1)).toEqual({ status: "not-applicable" });
    // THE DEFECT THIS REPLACES. This used to assert `toBeNull()` for the whole
    // shift, freezing a bug: a genuinely authored one-day target was visible in
    // Declared requirements while Grid and Day omitted `staffed/required` on the
    // very date it governs. The target is a property of a (shift, DAY).
    const model = { equations, reason: null };
    expect(exactShiftRequirement(model, 0, 0)).toBe(1);
    expect(exactShiftRequirement(model, 0, 1)).toBeNull();
  });
});

describe("qualification", () => {
  const document = documentWith([
    requirement({
      shiftType: "D+",
      requiredNumPeople: 1,
      qualifiedPeople: ["Seniors"],
      description: "one senior on the senior-only slot",
    }),
  ]);

  it("counts only qualified people toward the numerator", () => {
    // Cy is not a Senior, so the numerator stays 0 and the row is Short 1.
    const days: RosterDayGrid = [
      [OFF, OFF],
      [OFF, OFF],
      [shift("D+"), OFF],
      [OFF, OFF],
    ];
    const equations = buildEquations(document);
    const cell = checked(evaluateRequirementCell(equations[0], indexFor(document, days), 0));
    expect(cell.units).toBe(0);
    expect(cell.short).toBe(1);
  });

  it("NEGATIVE CONTROL: a satisfied qualified numerator is still red when an ordinary nurse occupies the slot", () => {
    // The backend adds `unqualified_n_people == 0` per selected shift, SEPARATELY
    // from the staffing sum. Ada (a Senior) satisfies 1/1 while Cy (not a Senior)
    // also stands on `D+` — a hard violation the numerator cannot see.
    const days: RosterDayGrid = [
      [shift("D+"), OFF],
      [OFF, OFF],
      [shift("D+"), OFF],
      [OFF, OFF],
    ];
    const equations = buildEquations(document);
    const cell = checked(evaluateRequirementCell(equations[0], indexFor(document, days), 0));
    expect(cell.units).toBe(1);
    expect(cell.required).toBe(1);
    expect(cell.short).toBe(0);
    expect(cell.over).toBe(0);
    expect(cell.unqualified).toBe(1);
    expect(cell.mismatch).toBe(true);
    expect(cell.offenders).toEqual([2]);
  });

  it("never becomes an exact-shift target", () => {
    expect(
      exactShiftRequirement({ equations: buildEquations(document), reason: null }, 1, 2),
    ).toBeNull();
  });
});

describe("coefficients", () => {
  it("weights coverage UNITS exactly as the backend does and labels the row weighted", () => {
    const document = documentWith([
      requirement({
        shiftType: [["D", "N"]],
        shiftTypeCoefficients: [["N", 2]],
        requiredNumPeople: 3,
      }),
    ]);
    const equations = buildEquations(document);
    expect(equations[0].weighted).toBe(true);
    // One person on D (1 unit) + one on N (2 units) = 3 units, not 2 people.
    const days: RosterDayGrid = [
      [shift("D"), OFF],
      [shift("N"), OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const cell = checked(evaluateRequirementCell(equations[0], indexFor(document, days), 0));
    expect(cell.units).toBe(3);
    expect(cell.mismatch).toBe(false);
  });

  it("is unavailable when coefficients meet a multi-group selector, as the backend raises", () => {
    const document = documentWith([
      requirement({
        shiftType: ["D", "N"],
        shiftTypeCoefficients: [["N", 2]],
        requiredNumPeople: 1,
      }),
    ]);
    const equations = buildEquations(document);
    expect(equations).toHaveLength(2);
    for (const equation of equations) expect(equation.unavailable).not.toBeNull();
  });

  it("never becomes an exact-shift target", () => {
    const document = documentWith([
      requirement({
        shiftType: "D",
        shiftTypeCoefficients: [["D", 2]],
        requiredNumPeople: 2,
      }),
    ]);
    expect(
      exactShiftRequirement({ equations: buildEquations(document), reason: null }, 0, 2),
    ).toBeNull();
  });
});

describe("hard status", () => {
  it("treats requiredNumPeople alone as EXACT: below is Short, above is Over", () => {
    const document = documentWith([requirement({ shiftType: "D", requiredNumPeople: 1 })]);
    const equations = buildEquations(document);
    const none: RosterDayGrid = [
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const two: RosterDayGrid = [
      [shift("D"), OFF],
      [shift("D"), OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    expect(checked(evaluateRequirementCell(equations[0], indexFor(document, none), 0)).short).toBe(
      1,
    );
    const over = checked(evaluateRequirementCell(equations[0], indexFor(document, two), 0));
    expect(over.over).toBe(1);
    expect(over.short).toBe(0);
    expect(over.mismatch).toBe(true);
  });

  it("treats preferredNumPeople as the UPPER target and required as the lower bound", () => {
    const document = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1, preferredNumPeople: 2 }),
    ]);
    const equations = buildEquations(document);
    const one: RosterDayGrid = [
      [shift("D"), OFF],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const three: RosterDayGrid = [
      [shift("D"), OFF],
      [shift("D"), OFF],
      [shift("D"), OFF],
      [OFF, OFF],
    ];
    const atFloor = checked(evaluateRequirementCell(equations[0], indexFor(document, one), 0));
    expect(atFloor.mismatch).toBe(false);
    expect(atFloor.preferred).toBe(2);
    expect(checked(evaluateRequirementCell(equations[0], indexFor(document, three), 0)).over).toBe(
      1,
    );
  });

  it("reports an unresolvable selector as unavailable with a reason, never as satisfied", () => {
    const document = documentWith([
      requirement({ shiftType: "NoSuchShift", requiredNumPeople: 1 }),
    ]);
    const equations = buildEquations(document);
    expect(equations[0].unavailable).toContain("NoSuchShift");
    const cell = evaluateRequirementCell(equations[0], indexFor(document, [[OFF, OFF]]), 0);
    expect(cell.status).toBe("unavailable");
  });

  it("refuses OFF/LEAVE in a staffing requirement, as the backend does", () => {
    const document = documentWith([requirement({ shiftType: "OFF", requiredNumPeople: 1 })]);
    expect(buildEquations(document)[0].unavailable).toContain("OFF/LEAVE");
  });
});

describe("requiredNumPeopleOverrides", () => {
  it("checks a date with an override against the override", () => {
    const document = documentWith([
      requirement({
        shiftType: "N",
        requiredNumPeople: 2,
        requiredNumPeopleOverrides: [["2026-07-02", 1]],
      }),
    ]);
    // One person on N every day.
    const days: RosterDayGrid = [
      [shift("N"), shift("N")],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const equations = buildEquations(document);
    const index = indexFor(document, days);
    expect(checked(evaluateRequirementCell(equations[0], index, 1))).toMatchObject({
      status: "checked",
      required: 1,
      short: 0,
      mismatch: false,
    });
    expect(checked(evaluateRequirementCell(equations[0], index, 0))).toMatchObject({
      status: "checked",
      required: 2,
      short: 1,
      mismatch: true,
    });
  });
});

describe("grid, summary and day health", () => {
  const document = documentWith(
    [
      requirement({ shiftType: "AllDays", requiredNumPeople: 1, preferredNumPeople: 2 }),
      requirement({ shiftType: "D+", requiredNumPeople: 1, qualifiedPeople: ["Seniors"] }),
    ],
    [{ id: "AllDays", members: ["D", "D+"] }],
  );

  it("recomputes live from the CURRENT assignments", () => {
    const equations = buildEquations(document);
    const model = { equations, reason: null };
    const before: RosterDayGrid = [
      [shift("D+"), shift("D+")],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const gridBefore = computeRequirementGrid(model, indexFor(document, before), 2);
    expect(summariseRequirements(gridBefore).mismatched).toBe(0);
    expect(requirementDayHealth(gridBefore, 0)).toBe("at");

    // Ada goes OFF on day 0: the qualified senior slot loses its only assignee
    // and the aggregate group drops below its floor.
    const after: RosterDayGrid = [
      [OFF, shift("D+")],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const gridAfter = computeRequirementGrid(model, indexFor(document, after), 2);
    expect(checked(gridAfter[0][0]).short).toBe(1);
    expect(checked(gridAfter[1][0]).short).toBe(1);
    expect(requirementDayHealth(gridAfter, 0)).toBe("under");
    expect(requirementDayHealth(gridAfter, 1)).toBe("at");
    expect(summariseRequirements(gridAfter).mismatched).toBe(2);
  });

  it("reports unknown, not healthy, when nothing on a day is checkable", () => {
    const broken = documentWith([requirement({ shiftType: "Nope", requiredNumPeople: 1 })]);
    const model = { equations: buildEquations(broken), reason: null };
    const grid = computeRequirementGrid(model, indexFor(broken, [[OFF, OFF]]), 2);
    expect(requirementDayHealth(grid, 0)).toBe("unknown");
    const summary = summariseRequirements(grid);
    expect(summary.anyCheckable).toBe(false);
    expect(summary.unavailable).toBe(2);
  });

  it("FAILS CLOSED: one unavailable equation makes a day unknown even when the rest are satisfied", () => {
    // THE DEFECT THIS REPLACES. Unavailable cells were skipped, so a day with a
    // satisfied `D` requirement and an unresolvable sibling painted the healthy
    // dot — a green all-clear over a requirement nothing had checked.
    const mixed = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1 }),
      requirement({ shiftType: "Nope", requiredNumPeople: 1 }),
    ]);
    const model = { equations: buildEquations(mixed), reason: null };
    const days: RosterDayGrid = [
      [shift("D"), shift("D")],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const grid = computeRequirementGrid(model, indexFor(mixed, days), 2);
    // The satisfied half really is satisfied — so this is not passing by accident.
    expect(checked(grid[0][0]).mismatch).toBe(false);
    expect(grid[1][0].status).toBe("unavailable");
    expect(requirementDayHealth(grid, 0)).toBe("unknown");
    // ...and the summary still names both halves rather than absorbing either.
    const summary = summariseRequirements(grid);
    expect(summary.anyCheckable).toBe(true);
    expect(summary.mismatched).toBe(0);
    expect(summary.unavailable).toBe(2);
  });

  it("keeps a DATE-SCOPED unavailable equation off every day it does not govern", () => {
    // THE DEFECT THIS REPLACES. `unavailable` was returned before the dates were
    // consulted, so one malformed rule scoped to a single date leaked onto every
    // other date: those days were counted unavailable, their health went
    // `unknown`, and Coverage drew a warning cell for a rule that does not apply
    // there. A resolved date scope is a fact that survives another selector
    // failing.
    const mixed = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1 }),
      requirement({ shiftType: "NoSuchShift", requiredNumPeople: 1, date: "2026-07-01" }),
    ]);
    const equations = buildEquations(mixed);
    // The premise: the second equation really is unavailable, and its date scope
    // really did resolve — otherwise this proves nothing.
    expect(equations[1].unavailable).not.toBeNull();
    expect(equations[1].dateScopeResolved).toBe(true);
    expect([...equations[1].dateIndices]).toEqual([0]);

    const model = { equations, reason: null };
    const days: RosterDayGrid = [
      [shift("D"), shift("D")],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const grid = computeRequirementGrid(model, indexFor(mixed, days), 2);

    // MUTATION CONTROL. Reversing the applicability ordering makes day 1's cell
    // `unavailable`, its health `unknown`, and the unavailable total 2 — each of
    // the three assertions below flips.
    expect(grid[1][0].status).toBe("unavailable");
    expect(grid[1][1]).toEqual({ status: "not-applicable" });
    expect(requirementDayHealth(grid, 0)).toBe("unknown");
    expect(requirementDayHealth(grid, 1)).toBe("ok");
    expect(summariseRequirements(grid).unavailable).toBe(1);
  });

  it("FAILS CLOSED when the DATE selector itself is unresolved, on every date", () => {
    // Here applicability is exactly what is unknown, so no day may excuse itself:
    // an empty `dateIndices` from a failed resolution must not read as "applies
    // nowhere".
    const broken = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1 }),
      requirement({ shiftType: "D", requiredNumPeople: 1, date: "not-a-date" }),
    ]);
    const equations = buildEquations(broken);
    expect(equations[1].dateScopeResolved).toBe(false);
    expect(equations[1].dateIndices.size).toBe(0);

    const model = { equations, reason: null };
    const days: RosterDayGrid = [
      [shift("D"), shift("D")],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const grid = computeRequirementGrid(model, indexFor(broken, days), 2);
    expect(grid[1][0].status).toBe("unavailable");
    expect(grid[1][1].status).toBe("unavailable");
    expect(requirementDayHealth(grid, 0)).toBe("unknown");
    expect(requirementDayHealth(grid, 1)).toBe("unknown");
    expect(summariseRequirements(grid).unavailable).toBe(2);
  });

  it("does NOT turn a generic unresolved equation into globally not-applicable", () => {
    // NEGATIVE CONTROL for over-correcting: an unavailable equation with NO date
    // scope applies to every day, so it must stay unavailable on every day.
    const generic = documentWith([requirement({ shiftType: "NoSuchShift", requiredNumPeople: 1 })]);
    const equations = buildEquations(generic);
    expect(equations[0].dateScopeResolved).toBe(true);
    expect(equations[0].dateIndices.size).toBe(2);

    const model = { equations, reason: null };
    const grid = computeRequirementGrid(model, indexFor(generic, [[OFF, OFF]]), 2);
    expect(grid[0][0].status).toBe("unavailable");
    expect(grid[0][1].status).toBe("unavailable");
    expect(requirementDayHealth(grid, 0)).toBe("unknown");
    expect(requirementDayHealth(grid, 1)).toBe("unknown");
  });

  it("still ranks a hard mismatch ABOVE an unavailable sibling", () => {
    // Fail-closed must not swallow the worse answer: a genuine shortage is more
    // actionable than "could not check", so it stays the reported state.
    const mixed = documentWith([
      requirement({ shiftType: "Nope", requiredNumPeople: 1 }),
      requirement({ shiftType: "D", requiredNumPeople: 1 }),
    ]);
    const model = { equations: buildEquations(mixed), reason: null };
    const empty: RosterDayGrid = [
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
      [OFF, OFF],
    ];
    const grid = computeRequirementGrid(model, indexFor(mixed, empty), 2);
    expect(requirementDayHealth(grid, 0)).toBe("under");
  });
});

describe("exactShiftRequirement", () => {
  it("returns the target for a unique, unweighted, unqualified single-shift equation", () => {
    const document = documentWith([requirement({ shiftType: "D", requiredNumPeople: 2 })]);
    const model = { equations: buildEquations(document), reason: null };
    expect(exactShiftRequirement(model, 0, 0)).toBe(2);
    expect(exactShiftRequirement(model, 0, 1)).toBe(2);
    // Every other lane in the same scenario still has no declared target.
    expect(exactShiftRequirement(model, 1, 0)).toBeNull();
    expect(exactShiftRequirement(model, 2, 0)).toBeNull();
  });

  it("reads DISJOINT date-scoped equations for one shift as one target per day, not as ambiguity", () => {
    // Exactly one equation applies on each day, so each day has a single
    // unambiguous number. Judging ambiguity across the whole calendar erased
    // both.
    const document = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1, date: "2026-07-01" }),
      requirement({ shiftType: "D", requiredNumPeople: 3, date: "2026-07-02" }),
    ]);
    const model = { equations: buildEquations(document), reason: null };
    expect(exactShiftRequirement(model, 0, 0)).toBe(1);
    expect(exactShiftRequirement(model, 0, 1)).toBe(3);
  });

  it("suppresses the target only on a day where two equations genuinely OVERLAP", () => {
    // Both apply on day 0 and the backend enforces both, so there is no single
    // number to show there — but day 1 has exactly one and keeps its target.
    const document = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1 }),
      requirement({ shiftType: "D", requiredNumPeople: 2, date: "2026-07-01" }),
    ]);
    const model = { equations: buildEquations(document), reason: null };
    expect(exactShiftRequirement(model, 0, 0)).toBeNull();
    expect(exactShiftRequirement(model, 0, 1)).toBe(1);
  });

  it("keeps every exclusion on a day the equation applies to", () => {
    // NEGATIVE CONTROLS: day-awareness must not have relaxed the other rules.
    const aggregate = documentWith(
      [requirement({ shiftType: "AllDays", requiredNumPeople: 2, date: "2026-07-01" })],
      [{ id: "AllDays", members: ["D", "D+"] }],
    );
    expect(
      exactShiftRequirement({ equations: buildEquations(aggregate), reason: null }, 0, 0),
    ).toBeNull();

    const qualified = documentWith([
      requirement({
        shiftType: "D",
        requiredNumPeople: 1,
        qualifiedPeople: ["Seniors"],
        date: "2026-07-01",
      }),
    ]);
    expect(
      exactShiftRequirement({ equations: buildEquations(qualified), reason: null }, 0, 0),
    ).toBeNull();

    const weighted = documentWith([
      requirement({
        shiftType: "D",
        requiredNumPeople: 2,
        shiftTypeCoefficients: [["D", 2]],
        date: "2026-07-01",
      }),
    ]);
    expect(
      exactShiftRequirement({ equations: buildEquations(weighted), reason: null }, 0, 0),
    ).toBeNull();

    const unresolved = documentWith([
      requirement({ shiftType: "D", requiredNumPeople: 1, date: "nonsense" }),
    ]);
    expect(
      exactShiftRequirement({ equations: buildEquations(unresolved), reason: null }, 0, 0),
    ).toBeNull();
  });
});

describe("deriveRequirementModel", () => {
  it("projects from the immutable submission YAML", () => {
    const document = documentWith(
      [requirement({ shiftType: "AllDays", requiredNumPeople: 1, date: "ALL" })],
      [{ id: "AllDays", members: ["D", "D+"] }],
    );
    const model = deriveRequirementModel({
      canonicalYaml: serializeCanonicalDocument(document),
    });
    expect(model.reason).toBeNull();
    expect(scopes(model.equations)).toEqual(["AllDays"]);
    expect(model.equations[0].dateLabel).toBe("Every day");
    expect(model.equations[0].dateIndices.size).toBe(2);
  });

  it("reports a corrupt submission as a model-level reason, not as empty requirements", () => {
    const model = deriveRequirementModel({ canonicalYaml: "" });
    expect(model.equations).toEqual([]);
    expect(model.reason).not.toBeNull();
  });
});

describe("buildAssignmentIndex", () => {
  it("lists the people on each (day, shift) in person-axis order", () => {
    const document = documentWith([]);
    const days: RosterDayGrid = [
      [shift("D"), OFF],
      [shift("N"), shift("D")],
      [shift("D"), OFF],
      [OFF, OFF],
    ];
    const index = buildAssignmentIndex(contextFor(document), days);
    expect(index.byDateShift[0][0]).toEqual([0, 2]);
    expect(index.byDateShift[0][3]).toEqual([1]);
    expect(index.byDateShift[1][0]).toEqual([1]);
  });
});
