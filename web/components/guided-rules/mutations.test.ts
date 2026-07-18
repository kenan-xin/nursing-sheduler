import { describe, expect, it } from "vitest";
import type { CountCard, RequirementCard } from "@/lib/scenario";
import {
  applyCountQuickEdit,
  applyRequirementQuickEdit,
  renameRequirementRule,
  toggleRequirementRule,
} from "./mutations";

const requirement: RequirementCard = {
  uid: "r1",
  shiftType: "D",
  requiredNumPeople: 2,
  weight: -1,
};

describe("applyRequirementQuickEdit", () => {
  it("applies a valid quick edit", () => {
    const outcome = applyRequirementQuickEdit([requirement], "r1", "requiredNumPeople", 5);
    expect(outcome).toEqual({
      kind: "applied",
      card: { ...requirement, requiredNumPeople: 5 },
    });
  });

  it("reports missing-source for an unknown constraintId", () => {
    expect(applyRequirementQuickEdit([requirement], "gone", "requiredNumPeople", 5)).toEqual({
      kind: "missing-source",
    });
  });

  it("reports unsupported-field for a field the mapper never declared", () => {
    expect(applyRequirementQuickEdit([requirement], "r1", "weight", 5)).toEqual({
      kind: "unsupported-field",
    });
  });

  it("reports invalid-value with the model's own message", () => {
    const outcome = applyRequirementQuickEdit([requirement], "r1", "requiredNumPeople", -1);
    expect(outcome.kind).toBe("invalid-value");
  });

  it("reports unsupported-field for an unsupported (multi-shift-type) card, never coercing it", () => {
    const unsupported: RequirementCard = {
      uid: "r2",
      shiftType: ["D", "N"],
      requiredNumPeople: 1,
      weight: -1,
    };
    expect(applyRequirementQuickEdit([unsupported], "r2", "requiredNumPeople", 5)).toEqual({
      kind: "unsupported-field",
    });
  });
});

describe("toggleRequirementRule", () => {
  it("sets disabled on toggle-off and clears it on toggle-on", () => {
    const off = toggleRequirementRule([requirement], "r1", false);
    expect(off).toEqual({ kind: "applied", card: { ...requirement, disabled: true } });
    if (off.kind !== "applied") throw new Error("expected applied");
    const on = toggleRequirementRule([off.card], "r1", true);
    expect(on).toEqual({ kind: "applied", card: requirement });
  });

  it("reports missing-source for an unknown constraintId", () => {
    expect(toggleRequirementRule([requirement], "gone", true)).toEqual({ kind: "missing-source" });
  });
});

describe("renameRequirementRule", () => {
  it("writes the source card's description", () => {
    const outcome = renameRequirementRule([requirement], "r1", "Cap D shift");
    expect(outcome).toEqual({
      kind: "applied",
      card: { ...requirement, description: "Cap D shift" },
    });
  });

  it("reports missing-source for an unknown constraintId", () => {
    expect(renameRequirementRule([requirement], "gone", "x")).toEqual({ kind: "missing-source" });
  });
});

describe("applyCountQuickEdit", () => {
  const count: CountCard = {
    uid: "c1",
    person: "ALL",
    countDates: "ALL",
    countShiftTypes: "N",
    expression: "x >= T",
    target: 3,
    weight: 1,
  };

  it("applies a valid target edit", () => {
    expect(applyCountQuickEdit([count], "c1", "target", 8)).toEqual({
      kind: "applied",
      card: { ...count, target: 8 },
    });
  });

  it("rejects a non-integer target", () => {
    expect(applyCountQuickEdit([count], "c1", "target", 1.5).kind).toBe("invalid-value");
  });

  it("reports unsupported-field for a contracted-hours count", () => {
    const contracted: CountCard = { ...count, uid: "c2", tag: "contracted_hours", policy: "exact" };
    expect(applyCountQuickEdit([contracted], "c2", "target", 8)).toEqual({
      kind: "unsupported-field",
    });
  });
});
