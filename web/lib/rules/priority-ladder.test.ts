import { describe, expect, it } from "vitest";
import type { ScenarioUiState } from "@/lib/scenario/types";
import { SCENARIOS } from "./ward-fixtures.test-support";
import { buildRestDaysRuleCard } from "./rest-days";
import { checkWeightOrder, tierOf, weightBandRefusal } from "./priority-ladder";

const sequence = (uid: string, weight: number, disabled = false) => ({
  uid,
  description: uid,
  person: ["ALL"],
  pattern: ["N", "D"],
  weight,
  ...(disabled ? { disabled } : {}),
});

const preferred = (uid: string, weight: number) => ({
  uid,
  description: uid,
  shiftType: ["D"],
  requiredNumPeople: 1,
  preferredNumPeople: 2,
  weight,
});

/** A real ward fixture with every kind of rule set on top. */
function ward(): ScenarioUiState {
  const state = SCENARIOS.ruleTooStrict();
  state.cardsByKind = {
    ...state.cardsByKind,
    requirements: [
      preferred("ideally-50", -50),
      preferred("ideally-10", -10),
      { uid: "exact", shiftType: ["D"], requiredNumPeople: 1, weight: -1 },
    ],
    successions: [
      sequence("old-default", -1),
      sequence("ward", -100),
      sequence("sleep-day", -Infinity),
      sequence("off", -1, true),
    ],
    counts: [buildRestDaysRuleCard("r")],
  };
  state.reqData = [
    { kind: "off", person: "a", date: "01", weight: 20 },
    { kind: "off", person: "a", date: "02", weight: 0 },
    { kind: "request", person: "a", date: "03", shiftType: "D", weight: 0 },
    { kind: "request", person: "a", date: "04", shiftType: "D", weight: -Infinity },
    { kind: "leave", person: "a", date: "05" },
  ];
  return state;
}

describe("tierOf", () => {
  it("places each card by kind and weight", () => {
    expect(tierOf("successions", sequence("s", -Infinity))).toBe("hard");
    expect(tierOf("successions", sequence("s", -1000))).toBe("strong");
    expect(tierOf("successions", sequence("s", -200))).toBe("ward");
    expect(tierOf("counts", buildRestDaysRuleCard("r"))).toBe("strong");
    expect(tierOf("requirements", preferred("p", -10))).toBe("preferred");
    expect(tierOf("requirements", preferred("p", 0))).toBe("spare");
    expect(tierOf("requests", { kind: "off", person: "a", date: "01", weight: 30 })).toBe("wish");
  });

  it("calls a weight with no effect hard: supervision, contracted hours, an exact count", () => {
    const covering = { uid: "c", preceptors: [], preceptees: [], shiftTypes: [], weight: 1 };
    expect(tierOf("coverings", covering)).toBe("hard");
    expect(
      tierOf("requirements", { uid: "e", shiftType: ["D"], requiredNumPeople: 2, weight: -1 }),
    ).toBe("hard");
  });
});

describe("weightBandRefusal", () => {
  it("names the band a nurse wish takes", () => {
    expect(weightBandRefusal("requests", { kind: "off", person: "a", date: "1", weight: 10 })).toBe(
      "a nurse wish takes 20 to 40 (or -20 to -40)",
    );
  });

  it("names both tiers a shift sequence may sit in", () => {
    expect(weightBandRefusal("successions", sequence("s", -50))).toBe(
      "a shift sequence rule takes 100 to 300 (or -100 to -300) for a ward preference, " +
        "or 1000 (or -1000) for a strong ward rule",
    );
  });

  it("accepts every weight inside a band, and every hard weight", () => {
    for (const weight of [100, -300, 1000, -Infinity, Infinity]) {
      expect(weightBandRefusal("successions", sequence("s", weight)), String(weight)).toBe(
        undefined,
      );
    }
    expect(weightBandRefusal("requirements", preferred("p", -50))).toBe(
      "a Preferred staffing count takes -10, or 0 for a spare place",
    );
  });
});

describe("checkWeightOrder", () => {
  it("flags each enabled weight off the ladder, with the fix to offer", () => {
    const findings = checkWeightOrder(ward());
    expect(findings.map((f) => [f.kind, f.ruleId, f.weight, f.suggestedWeight])).toEqual([
      ["requirements", "ideally-50", -50, -10],
      ["successions", "old-default", -1, -100],
      ["requests", undefined, 0, 20],
    ]);
    expect(findings[0].message).toBe(
      '"ideally-50" has weight -50, but a Preferred staffing count takes -10, or 0 for a spare place.',
    );
    expect(findings[2]).toMatchObject({
      count: 2,
      message: "2 requests have weight 0, but a nurse wish takes 20 to 40 (or -20 to -40).",
    });
  });

  it("finds nothing on a ward built with the new defaults", () => {
    expect(checkWeightOrder(SCENARIOS.ruleTooStrict())).toEqual([]);
  });
});
