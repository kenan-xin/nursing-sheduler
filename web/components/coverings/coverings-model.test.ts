import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import {
  buildCoveringCard,
  buildShiftTypeOptions,
  COVERING_MESSAGES,
  COVERING_WEIGHT,
  coveringToForm,
  emptyCoveringForm,
  expandDateRange,
  flattenRefs,
  isAdvancedCoveringCard,
  isEditableCoveringCard,
  reorderByDrop,
  isSelected,
  selectionReachesDayState,
  shiftGroupContainsDayState,
  summarizeRefs,
  toggleRef,
  validateCoveringForm,
  type CoveringFormState,
} from "./coverings-model";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), ...overrides };
}

function form(overrides: Partial<CoveringFormState> = {}): CoveringFormState {
  return { ...emptyCoveringForm(), ...overrides };
}

const PEOPLE = scenario({
  staff: [{ id: "Anna" }, { id: "Lil" }],
  staffGroups: [{ id: "Seniors", members: ["Anna"] }],
  shifts: [{ id: "D" }, { id: "N" }],
});

describe("selection helpers", () => {
  it("toggleRef adds then removes by exact identity, order-preserving", () => {
    expect(toggleRef([], "D")).toEqual(["D"]);
    expect(toggleRef(["D", "N"], "D")).toEqual(["N"]);
    expect(isSelected(["D"], "D")).toBe(true);
    expect(isSelected(["D"], "N")).toBe(false);
  });

  it('exact identity keeps numeric 1 and string "1" distinct (T09 sameEntityId parity)', () => {
    // A numeric person id and a same-spelling string group id are both authorable
    // and must not collapse in one selection (cold-review Major 3).
    expect(isSelected([1], "1")).toBe(false);
    expect(isSelected(["1"], 1)).toBe(false);
    expect(isSelected([1], 1)).toBe(true);
    // Selecting string "1" does NOT remove the numeric 1, and vice versa.
    expect(toggleRef([1], "1")).toEqual([1, "1"]);
    expect(toggleRef([1, "1"], 1)).toEqual(["1"]);
    expect(toggleRef([1, "1"], "1")).toEqual([1]);
  });
});

describe("OFF/LEAVE exclusion in the shift-type selector (FR-CV-15)", () => {
  it("marks a group whose members include OFF or LEAVE as disabled", () => {
    const state = scenario({
      shifts: [{ id: "D" }, { id: "N" }],
      shiftGroups: [
        { id: "Days", members: ["D"] },
        { id: "WithOff", members: ["N", "OFF"] },
      ],
    });
    const options = buildShiftTypeOptions(state);
    const days = options.groups.find((o) => o.ref === "Days");
    const withOff = options.groups.find((o) => o.ref === "WithOff");
    expect(days?.disabled).toBeUndefined();
    expect(withOff?.disabled).toBe(true);
    expect(withOff?.disabledReason).toBe(COVERING_MESSAGES.offLeave);
  });

  it("detects OFF/LEAVE reached transitively through nested groups (cycle-safe)", () => {
    const state = scenario({
      shifts: [{ id: "D" }],
      shiftGroups: [
        { id: "Outer", members: ["Inner"] },
        { id: "Inner", members: ["LEAVE"] },
        // A self-referential cycle must not hang.
        { id: "Cyclic", members: ["Cyclic", "D"] },
      ],
    });
    expect(shiftGroupContainsDayState("Outer", state)).toBe(true);
    expect(shiftGroupContainsDayState("Cyclic", state)).toBe(false);
  });

  it("rejects a shift-type selection that reaches OFF/LEAVE (item or tainted group)", () => {
    const state = scenario({
      shifts: [{ id: "D" }],
      shiftGroups: [{ id: "WithOff", members: ["OFF"] }],
    });
    expect(selectionReachesDayState(["OFF"], state)).toBe(true);
    expect(selectionReachesDayState(["WithOff"], state)).toBe(true);
    expect(selectionReachesDayState(["D"], state)).toBe(false);
  });
});

// A numeric shift-type entity id is a valid `ShiftTypeId` but a covering selector is
// string-only (`ShiftTypeRef`). A numeric id cannot be referenced by a string
// selector, so it is disabled with an actionable explanation rather than silently
// `String()`-ed (the Python shift map keys the raw numeric id).
describe("numeric shift-type id exclusion from the selector", () => {
  it("disables a numeric shift id so it cannot become a covering selector", () => {
    const state = scenario({ shifts: [{ id: 7 }, { id: "D" }] });
    const options = buildShiftTypeOptions(state);
    const numeric = options.items.find((o) => o.ref === 7);
    const stringShift = options.items.find((o) => o.ref === "D");
    expect(numeric?.disabled).toBe(true);
    expect(numeric?.disabledReason).toBe(COVERING_MESSAGES.numericShiftId);
    expect(stringShift?.disabled).toBeUndefined();
  });
});

describe("validation (FR-CV-13..15)", () => {
  it("sets the verbatim empty-selection messages, none for dates", () => {
    const errors = validateCoveringForm(form(), PEOPLE);
    expect(errors.preceptors).toBe(COVERING_MESSAGES.preceptors);
    expect(errors.preceptees).toBe(COVERING_MESSAGES.preceptees);
    expect(errors.shiftTypes).toBe(COVERING_MESSAGES.shiftTypes);
    expect(errors.dates).toBeUndefined();
  });

  it("rejects an OFF/LEAVE shift-type selection with the E26b message", () => {
    const state = scenario({ shifts: [{ id: "D" }] });
    const errors = validateCoveringForm(
      form({ preceptors: ["Anna"], preceptees: ["Lil"], shiftTypes: ["OFF"] }),
      state,
    );
    expect(errors.shiftTypes).toBe(COVERING_MESSAGES.offLeave);
  });

  it("passes a fully-populated worked-shift draft", () => {
    const errors = validateCoveringForm(
      form({ preceptors: ["Seniors"], preceptees: ["Lil"], shiftTypes: ["D"] }),
      PEOPLE,
    );
    expect(errors).toEqual({});
  });
});

describe("buildCoveringCard save shape (FR-CV-07, EDGE-CV-01, EDGE-CV-04)", () => {
  it("wraps each flat selection in the single-equation outer array", () => {
    const card = buildCoveringCard(
      form({ preceptors: ["Anna", "Seniors"], preceptees: ["Lil"], shiftTypes: ["D", "N"] }),
      "uid-1",
    );
    expect(card.preceptors).toEqual([["Anna", "Seniors"]]);
    expect(card.preceptees).toEqual([["Lil"]]);
    expect(card.shiftTypes).toEqual([["D", "N"]]);
    expect(card.uid).toBe("uid-1");
  });

  it("stamps the inert enforced weight — there is no editable weight field", () => {
    const card = buildCoveringCard(form({ shiftTypes: ["D"] }), "uid-2");
    expect(card.weight).toBe(COVERING_WEIGHT);
    // The form draft type carries no weight key at all (compile-time guarantee);
    // at runtime the stamped weight is independent of any input.
    expect("weight" in emptyCoveringForm()).toBe(false);
  });

  it("OMITS date when no dates are selected (never date: [])", () => {
    const card = buildCoveringCard(form({ shiftTypes: ["D"] }), "uid-3");
    expect("date" in card).toBe(false);
    expect(card.date).toBeUndefined();
  });

  it("emits a flat date array when dates are selected", () => {
    const card = buildCoveringCard(
      form({ shiftTypes: ["D"], dates: ["2026-01-01", "2026-01-02"] }),
      "uid-4",
    );
    expect(card.date).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("trims and drops an empty description", () => {
    expect(
      buildCoveringCard(form({ shiftTypes: ["D"], description: "  " }), "u").description,
    ).toBeUndefined();
    expect(
      buildCoveringCard(form({ shiftTypes: ["D"], description: " x " }), "u").description,
    ).toBe("x");
  });
});

describe("coveringToForm load round-trip (FR-CV-08)", () => {
  it("flattens the nested trees back to the flat draft", () => {
    const original = form({
      description: "pairing",
      preceptors: ["Anna", "Seniors"],
      preceptees: ["Lil"],
      shiftTypes: ["D"],
      dates: ["2026-01-01"],
    });
    const loaded = coveringToForm(buildCoveringCard(original, "uid"));
    expect(loaded).toEqual(original);
  });

  it("an omitted date loads as an empty date selection", () => {
    const loaded = coveringToForm(buildCoveringCard(form({ shiftTypes: ["D"] }), "uid"));
    expect(loaded.dates).toEqual([]);
  });

  it("keeps multi-term imported selectors read-only instead of flattening them on edit", () => {
    const advanced = {
      ...buildCoveringCard(form({ shiftTypes: ["D"] }), "advanced"),
      preceptors: [["Anna"], ["Lil"]],
    };
    expect(isAdvancedCoveringCard(advanced)).toBe(true);
    expect(isEditableCoveringCard(advanced)).toBe(false);
    expect(advanced.preceptors).toEqual([["Anna"], ["Lil"]]);
  });

  it("flattenRefs and summarizeRefs handle nested trees and empties", () => {
    expect(flattenRefs([["A", "B"], "C"])).toEqual(["A", "B", "C"]);
    expect(summarizeRefs([["A", "B"]])).toBe("A, B");
    expect(summarizeRefs([[]])).toBe("(all)");
  });
});

describe("pointer-half reorder", () => {
  const cards = [{ uid: "A" }, { uid: "B" }, { uid: "C" }];

  it("inserts before or after the hovered card without spending a no-op mutation", () => {
    expect(reorderByDrop(cards, "A", "C", "before").map((card) => card.uid)).toEqual([
      "B",
      "A",
      "C",
    ]);
    expect(reorderByDrop(cards, "A", "C", "after").map((card) => card.uid)).toEqual([
      "B",
      "C",
      "A",
    ]);
    expect(reorderByDrop(cards, "A", "A", "after")).toEqual(cards);
  });
});

describe("date option expansion", () => {
  it("expands an inclusive ISO range into concrete date items", () => {
    expect(expandDateRange("2026-01-01", "2026-01-03")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  it("returns [] for a missing or reversed range", () => {
    expect(expandDateRange("", "")).toEqual([]);
    expect(expandDateRange("2026-01-05", "2026-01-01")).toEqual([]);
  });

  it("expands a range longer than two years without silent truncation", () => {
    const dates = expandDateRange("2026-01-01", "2029-01-01");
    expect(dates[dates.length - 1]).toBe("2029-01-01");
    expect(dates.length).toBeGreaterThan(733);
  });
});
