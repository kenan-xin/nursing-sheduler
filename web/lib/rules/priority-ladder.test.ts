import { describe, expect, it } from "vitest";
import type { ScenarioUiState } from "@/lib/scenario/types";
import { SCENARIOS } from "./ward-fixtures.test-support";
import { buildRestDaysRuleCard } from "./rest-days";
import { checkWeightOrder, pointsSentence, tierOf, weightBandRefusal } from "./priority-ladder";

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
    expect(tierOf("successions", sequence("s", -600))).toBe("strong");
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
        "or 600 to 1000 (or -600 to -1000) for a strong ward rule",
    );
  });

  it("accepts every weight inside a band, and every hard weight", () => {
    for (const weight of [100, -300, 1000, -Infinity, Infinity]) {
      expect(weightBandRefusal("successions", sequence("s", weight)), String(weight)).toBe(
        undefined,
      );
    }
    expect(weightBandRefusal("requirements", preferred("p", -50))).toBe(
      "a Preferred staffing count takes -8 to -15, or 0 for a spare place",
    );
  });

  it("holds each band's edges and refuses one step outside (user ruling 2026-10-05)", () => {
    const edges: [string, (w: number) => string | undefined, number[], number[]][] = [
      [
        "strong",
        (w) => weightBandRefusal("counts", { ...buildRestDaysRuleCard("r"), weight: w }),
        [-600, -1000],
        [-599, -1001],
      ],
      [
        "ward",
        (w) =>
          weightBandRefusal("affinities", {
            uid: "a",
            people1: [],
            people2: [],
            shiftTypes: [],
            date: [],
            weight: w,
          }),
        [-100, 300],
        [-99, 301],
      ],
      [
        "wish",
        (w) => weightBandRefusal("requests", { kind: "off", person: "a", date: "1", weight: w }),
        [20, -40],
        [19, 41],
      ],
      [
        "preferred",
        (w) => weightBandRefusal("requirements", preferred("p", w)),
        [-8, -15, 0],
        [-7, -16],
      ],
      [
        "fairness",
        (w) =>
          weightBandRefusal("counts", {
            uid: "c",
            person: ["ALL"],
            countDates: ["ALL"],
            countShiftTypes: ["ALL"],
            expression: "|x - T|^2",
            target: 1,
            weight: w,
          }),
        [-4, -6],
        [-3, -7],
      ],
    ];
    for (const [tier, refuse, inside, outside] of edges) {
      for (const w of inside) expect(refuse(w), `${tier} ${w}`).toBe(undefined);
      for (const w of outside) expect(refuse(w), `${tier} ${w}`).toBeTypeOf("string");
    }
  });
});

describe("pointsSentence (section 6 item 4)", () => {
  it("states the points and the tier that always wins over the rule", () => {
    expect(pointsSentence("successions", sequence("s", -100))).toBe(
      "-100 points each time the pattern happens. A ward preference: a strong ward rule (600 to 1000 points) always wins.",
    );
    expect(pointsSentence("requirements", preferred("p", -10))).toBe(
      "-10 points for each empty Preferred place on each date. A Preferred staffing count: a nurse wish (20 to 40 points) always wins.",
    );
    expect(pointsSentence("successions", sequence("s", -1000))).toBe(
      "-1000 points each time the pattern happens. A strong ward rule: only a must wins over it.",
    );
    expect(pointsSentence("requirements", preferred("p", 0))).toMatch(/^A spare place: no points/);
  });

  it("says nothing for a must, whose sentence already says it", () => {
    expect(pointsSentence("successions", sequence("s", -Infinity))).toBe(undefined);
  });
});

describe("checkWeightOrder", () => {
  it("flags each enabled weight off the ladder, with the fix to offer", () => {
    const findings = checkWeightOrder(ward());
    expect(findings.map((f) => [f.kind, f.ruleId, f.weight, f.suggestedWeight])).toEqual([
      ["requirements", "ideally-50", -50, -15],
      ["successions", "old-default", -1, -100],
      ["requests", undefined, 0, 20],
    ]);
    expect(findings[0].message).toBe(
      '"ideally-50" has weight -50, but a Preferred staffing count takes -8 to -15, or 0 for a spare place.',
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

describe("spare-slot bonuses (uv8n)", () => {
  const bonus = (weight: number) => ({ uid: "b", person: ["ALL"], pattern: ["A_sup"], weight });

  it("a one-shift card with 1 to 3 points sits in the bonus tier", () => {
    for (const weight of [1, 2, 3]) {
      expect(tierOf("successions", bonus(weight))).toBe("bonus");
      expect(weightBandRefusal("successions", bonus(weight))).toBeUndefined();
    }
  });

  it("refuses a bonus that would outweigh fairness or a wish, naming the positive band", () => {
    expect(weightBandRefusal("successions", bonus(4))).toBe("a shift sequence rule takes 1 to 3");
    expect(weightBandRefusal("successions", bonus(20))).toBe("a shift sequence rule takes 1 to 3");
  });

  it("the Preview points line says the bonus is the lowest priority", () => {
    expect(pointsSentence("successions", bonus(3))).toBe(
      "+3 points for each A_sup shift. Lowest priority: a nurse's day off (20 points) always wins.",
    );
  });

  it("a negative one-shift card is still a ward preference, not a bonus", () => {
    expect(tierOf("successions", bonus(-100))).toBe("ward");
    expect(weightBandRefusal("successions", bonus(-3))).toMatch(/100 to 300/);
  });
});
