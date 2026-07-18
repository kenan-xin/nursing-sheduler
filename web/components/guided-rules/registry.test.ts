import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  type GuidedRulePin,
  type ScenarioUiState,
} from "@/lib/scenario";
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

describe("projectGuidedRules", () => {
  it("always includes the built-in max-one-shift-per-day row, locked and enabled", () => {
    const { rows } = projectGuidedRules(createEmptyScenarioUiState("alpha"));
    const builtin = rows.find((r) => r.source === "builtin");
    expect(builtin).toBeDefined();
    expect(builtin?.locked).toBe(true);
    expect(builtin?.enabled).toBe(true);
  });

  it("derives one row per card, reflecting enabled/disabled from the card's own marker", () => {
    const { rows } = projectGuidedRules(baseState());
    const req = rows.find((r) => r.id === "requirements:r1");
    const count = rows.find((r) => r.id === "counts:c1");
    expect(req?.enabled).toBe(true);
    expect(count?.enabled).toBe(false);
  });

  it("uses mapper defaults (category, quick fields, summary) when no pin exists", () => {
    const { rows } = projectGuidedRules(baseState());
    const req = rows.find((r) => r.id === "requirements:r1")!;
    expect(req.category).toBe("Staffing");
    expect(req.quickFields.map((f) => f.key)).toEqual(["requiredNumPeople"]);
    expect(req.pin).toBeUndefined();
  });

  it("overlays a pin's category/description/quickFields onto its row", () => {
    const state = baseState();
    const pin: GuidedRulePin = {
      id: "pin1",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Custom shortcuts",
      description: "Custom summary",
      quickFields: [],
    };
    state.guidedRulePins = [pin];
    const { rows } = projectGuidedRules(state);
    const req = rows.find((r) => r.id === "requirements:r1")!;
    expect(req.category).toBe("Custom shortcuts");
    expect(req.summary).toBe("Custom summary");
    // Pin selected no quick fields → display-only, even though the mapper
    // declares requiredNumPeople as available.
    expect(req.quickFields).toEqual([]);
    expect(req.pin).toBe(pin);
  });

  it("a pin's quickFields subset is honored (not the mapper's full set)", () => {
    const state = baseState();
    state.guidedRulePins = [
      {
        id: "pin1",
        constraintKind: "requirements",
        constraintId: "r1",
        category: "Staffing",
        quickFields: ["requiredNumPeople"],
      },
    ];
    const { rows } = projectGuidedRules(state);
    const req = rows.find((r) => r.id === "requirements:r1")!;
    expect(req.quickFields.map((f) => f.key)).toEqual(["requiredNumPeople"]);
  });

  it("reconciles duplicate pins for the same source (legacy data): the last one wins the row, the rest are reported stale (T14d)", () => {
    const state = baseState();
    const older: GuidedRulePin = {
      id: "older",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Staffing",
      quickFields: ["requiredNumPeople"],
    };
    const newer: GuidedRulePin = {
      id: "newer",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Custom shortcuts",
      description: "Newest wins",
      quickFields: [],
    };
    state.guidedRulePins = [older, newer];
    const { rows, stalePinIds } = projectGuidedRules(state);
    const req = rows.find((r) => r.id === "requirements:r1")!;
    expect(req.pin).toBe(newer);
    expect(req.category).toBe("Custom shortcuts");
    expect(stalePinIds).toEqual(["older"]);
  });

  it("reports every earlier duplicate as stale when three pins share a source", () => {
    const state = baseState();
    state.guidedRulePins = [
      {
        id: "p1",
        constraintKind: "requirements",
        constraintId: "r1",
        category: "A",
        quickFields: [],
      },
      {
        id: "p2",
        constraintKind: "requirements",
        constraintId: "r1",
        category: "B",
        quickFields: [],
      },
      {
        id: "p3",
        constraintKind: "requirements",
        constraintId: "r1",
        category: "C",
        quickFields: [],
      },
    ];
    const { rows, stalePinIds } = projectGuidedRules(state);
    const req = rows.find((r) => r.id === "requirements:r1")!;
    expect(req.pin?.id).toBe("p3");
    expect(stalePinIds).toEqual(["p1", "p2"]);
  });

  it("reports a pin whose source card no longer exists as stale, without attaching it", () => {
    const state = baseState();
    state.guidedRulePins = [
      {
        id: "orphan",
        constraintKind: "requirements",
        constraintId: "does-not-exist",
        category: "Staffing",
        quickFields: [],
      },
    ];
    const { rows, stalePinIds } = projectGuidedRules(state);
    expect(stalePinIds).toEqual(["orphan"]);
    expect(rows.every((r) => r.pin?.id !== "orphan")).toBe(true);
  });

  it("an unsupported card's row carries the unsupportedReason and no quick fields, even with a pin", () => {
    const state = baseState();
    state.cardsByKind.requirements = [
      { uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 },
    ];
    state.guidedRulePins = [
      {
        id: "pin1",
        constraintKind: "requirements",
        constraintId: "r2",
        category: "Staffing",
        quickFields: ["requiredNumPeople"],
      },
    ];
    const { rows } = projectGuidedRules(state);
    const req = rows.find((r) => r.id === "requirements:r2")!;
    expect(req.unsupportedReason).toBeDefined();
    expect(req.quickFields).toEqual([]);
  });
});
