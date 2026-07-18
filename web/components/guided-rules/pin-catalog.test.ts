import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type CardsByKind, type GuidedRulePin } from "@/lib/scenario";
import {
  listPinnableRecords,
  pinConstraint,
  repinConstraint,
  unpinConstraint,
} from "./pin-catalog";

function baseCards(): CardsByKind {
  const state = createEmptyScenarioUiState("alpha");
  return {
    ...state.cardsByKind,
    requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 }],
    coverings: [
      { uid: "v1", preceptors: ["P1"], preceptees: ["P2"], shiftTypes: ["D"], weight: 1 },
    ],
  };
}

describe("listPinnableRecords", () => {
  it("lists one candidate per card across all five kinds", () => {
    const records = listPinnableRecords({
      ...createEmptyScenarioUiState("alpha"),
      cardsByKind: baseCards(),
    });
    expect(records.map((r) => r.constraintId).sort()).toEqual(["r1", "v1"]);
  });

  it("a covering candidate has no quick fields (structural weight)", () => {
    const records = listPinnableRecords({
      ...createEmptyScenarioUiState("alpha"),
      cardsByKind: baseCards(),
    });
    const covering = records.find((r) => r.constraintId === "v1")!;
    expect(covering.quickFieldOptions).toEqual([]);
  });
});

describe("pinConstraint", () => {
  const cards = baseCards();

  it("pins a supported constraint with a valid quick-field subset", () => {
    const outcome = pinConstraint(cards, [], {
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Custom",
      quickFields: ["requiredNumPeople"],
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied");
    expect(outcome.pins).toHaveLength(1);
    expect(outcome.pins[0]).toMatchObject({
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Custom",
      quickFields: ["requiredNumPeople"],
    });
  });

  it("replaces the existing pin rather than appending a duplicate for an already-pinned source (T14d)", () => {
    const first = pinConstraint(cards, [], {
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Staffing",
      quickFields: ["requiredNumPeople"],
    });
    if (first.kind !== "applied") throw new Error("expected applied");
    expect(first.pins).toHaveLength(1);

    const second = pinConstraint(cards, first.pins, {
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Custom shortcuts",
      description: "Renamed shortcut",
      quickFields: [],
    });
    if (second.kind !== "applied") throw new Error("expected applied");
    expect(second.pins).toHaveLength(1);
    expect(second.pins[0]).toMatchObject({
      id: first.pins[0].id,
      category: "Custom shortcuts",
      description: "Renamed shortcut",
      quickFields: [],
    });
  });

  it("repeated pin calls for the same source never grow the pin list past one", () => {
    let pins: GuidedRulePin[] = [];
    for (let i = 0; i < 5; i++) {
      const outcome = pinConstraint(cards, pins, {
        constraintKind: "coverings",
        constraintId: "v1",
        category: "Custom shortcuts",
        quickFields: [],
      });
      if (outcome.kind !== "applied") throw new Error("expected applied");
      pins = outcome.pins;
    }
    expect(pins).toHaveLength(1);
  });

  it("allows an empty quickFields selection (a deliberate display-only pin)", () => {
    const outcome = pinConstraint(cards, [], {
      constraintKind: "coverings",
      constraintId: "v1",
      category: "Custom",
      quickFields: [],
    });
    expect(outcome.kind).toBe("applied");
  });

  it("reports missing-source for a constraintId that does not exist", () => {
    const outcome = pinConstraint(cards, [], {
      constraintKind: "requirements",
      constraintId: "gone",
      category: "Custom",
      quickFields: [],
    });
    expect(outcome).toEqual({ kind: "missing-source" });
  });

  it("reports unsupported-field for a quick field the mapper never declared for this card", () => {
    const outcome = pinConstraint(cards, [], {
      constraintKind: "coverings",
      constraintId: "v1",
      category: "Custom",
      quickFields: ["weight"],
    });
    expect(outcome).toEqual({ kind: "unsupported-field", field: "weight" });
  });
});

describe("repinConstraint", () => {
  const cards = baseCards();
  const pin: GuidedRulePin = {
    id: "pin1",
    constraintKind: "requirements",
    constraintId: "r1",
    category: "Staffing",
    quickFields: ["requiredNumPeople"],
  };

  it("patches category/description without touching quickFields", () => {
    const outcome = repinConstraint(cards, [pin], "pin1", { category: "Renamed" });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied");
    expect(outcome.pins[0].category).toBe("Renamed");
    expect(outcome.pins[0].quickFields).toEqual(["requiredNumPeople"]);
  });

  it("re-validates a new quickFields selection against the current card", () => {
    const outcome = repinConstraint(cards, [pin], "pin1", { quickFields: ["bogus"] });
    expect(outcome).toEqual({ kind: "unsupported-field", field: "bogus" });
  });

  it("repeated repin calls stay a single pin and accumulate the latest patch", () => {
    let pins: GuidedRulePin[] = [pin];
    for (const category of ["Renamed once", "Renamed twice", "Renamed thrice"]) {
      const outcome = repinConstraint(cards, pins, "pin1", { category });
      if (outcome.kind !== "applied") throw new Error("expected applied");
      pins = outcome.pins;
    }
    expect(pins).toHaveLength(1);
    expect(pins[0].category).toBe("Renamed thrice");
  });

  it("reports missing-source for an unknown pin id", () => {
    expect(repinConstraint(cards, [pin], "missing", { category: "X" })).toEqual({
      kind: "missing-source",
    });
  });
});

describe("unpinConstraint", () => {
  it("removes only the shortcut", () => {
    const pin: GuidedRulePin = {
      id: "pin1",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Staffing",
      quickFields: [],
    };
    expect(unpinConstraint([pin], "pin1")).toEqual([]);
  });
});
