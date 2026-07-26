import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { projectGuidedRules } from "./registry";

function baseState(): ScenarioUiState {
  const state = createEmptyScenarioUiState("alpha");
  state.cardsByKind = {
    requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 }],
    successions: [],
    counts: [
      {
        uid: "c1",
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: "N",
        expression: "x >= T",
        target: 3,
        weight: 1,
        disabled: true,
      },
    ],
    affinities: [],
    coverings: [],
  };
  return state;
}

/** One card of every kind, including a disabled one and an unsupported shape. */
function fullState(): ScenarioUiState {
  const state = createEmptyScenarioUiState("alpha");
  state.cardsByKind = {
    requirements: [
      { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 },
      // Multi-shift-type — "Set in Advanced only".
      { uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 },
    ],
    successions: [{ uid: "s1", person: ["P1"], pattern: ["N", "D"], weight: -1 }],
    counts: [
      {
        uid: "c1",
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: "N",
        expression: "x >= T",
        target: 3,
        weight: 1,
        disabled: true,
      },
    ],
    affinities: [
      {
        uid: "a1",
        people1: ["P1"],
        people2: ["P2"],
        shiftTypes: ["D"],
        date: "ALL",
        weight: 1,
      },
    ],
    coverings: [
      {
        uid: "v1",
        preceptors: ["P1"],
        preceptees: ["P2"],
        shiftTypes: ["D"],
        weight: -1,
      },
    ],
  };
  return state;
}

describe("projectGuidedRules", () => {
  it("always includes the built-in max-one-shift-per-day row, locked and enabled", () => {
    const rows = projectGuidedRules(createEmptyScenarioUiState("alpha"));
    const builtin = rows.find((r) => r.source === "builtin");
    expect(builtin).toBeDefined();
    expect(builtin?.locked).toBe(true);
    expect(builtin?.enabled).toBe(true);
    expect(builtin?.category).toBe("Always on");
  });

  it("titles the built-in row from its own description when one is authored", () => {
    const state = createEmptyScenarioUiState("alpha");
    state.maxOneShiftPerDay = { description: "One shift a day, everyone" };
    const builtin = projectGuidedRules(state).find((r) => r.source === "builtin")!;
    expect(builtin.title).toBe("One shift a day, everyone");
  });

  it("derives one row per card, reflecting enabled/disabled from the card's own marker", () => {
    const rows = projectGuidedRules(baseState());
    const req = rows.find((r) => r.id === "requirements:r1");
    const count = rows.find((r) => r.id === "counts:c1");
    expect(req?.enabled).toBe(true);
    expect(count?.enabled).toBe(false);
  });

  it("gives every constraint a row — disabled cards and unsupported shapes included", () => {
    const rows = projectGuidedRules(fullState());
    expect(rows.map((r) => r.id)).toEqual([
      "builtin:max-one-shift-per-day",
      "requirements:r1",
      "requirements:r2",
      "successions:s1",
      "counts:c1",
      "affinities:a1",
      "coverings:v1",
    ]);
  });

  it("orders rows so the plain-English headings read built-in first, then kind by kind", () => {
    const categories = projectGuidedRules(fullState()).map((r) => r.category);
    expect([...new Set(categories)]).toEqual([
      "Always on",
      "Staffing levels",
      "Shift sequences",
      "Hours & contracts",
      "Who works together",
      "Supervision",
    ]);
  });

  it("gives a supported row the mapper's full declared quick-field set", () => {
    const rows = projectGuidedRules(baseState());
    const req = rows.find((r) => r.id === "requirements:r1")!;
    expect(req.category).toBe("Staffing levels");
    expect(req.quickFields.map((f) => f.key)).toEqual(["requiredNumPeople"]);
  });

  it("an unsupported card's row carries the unsupportedReason and no quick fields", () => {
    const state = baseState();
    state.cardsByKind.requirements = [
      { uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 },
    ];
    const req = projectGuidedRules(state).find((r) => r.id === "requirements:r2")!;
    expect(req.unsupportedReason).toBeDefined();
    expect(req.quickFields).toEqual([]);
  });
});
