import { describe, expect, it } from "vitest";
import {
  coefficientEntryOrder,
  coefficientIntegerErrorMessage,
  coefficientOverlapMessage,
  coefficientValueFor,
  eligibleCoefficientIds,
  parseCoefficientInput,
  sortIdsByEntryOrder,
  syncCoefficientPairs,
  updateCoefficientPair,
  validateCoefficientPairs,
  type CoefficientDomain,
} from "./coefficient-fields";

const DOMAIN: CoefficientDomain = {
  items: [{ id: "D" }, { id: "N" }, { id: "OFF" }, { id: "LEAVE" }],
  groups: [
    { id: "Seniors", members: ["D", "N"] },
    { id: "ALL", members: ["D", "N", "OFF", "LEAVE"] },
  ],
};

describe("canonical entry order", () => {
  it("orders items before groups, each in authoring order", () => {
    expect(coefficientEntryOrder(DOMAIN)).toEqual(["D", "N", "OFF", "LEAVE", "Seniors", "ALL"]);
  });

  it("sorts ids to that canonical order, unknown ids sort last", () => {
    expect(sortIdsByEntryOrder(["Seniors", "D", "N"], DOMAIN)).toEqual(["D", "N", "Seniors"]);
    expect(sortIdsByEntryOrder(["Ghost", "D"], DOMAIN)).toEqual(["D", "Ghost"]);
  });
});

describe("eligibleCoefficientIds (FR-PR-70)", () => {
  it("makes an item eligible when its own id is selected", () => {
    expect(eligibleCoefficientIds(["D"], DOMAIN)).toEqual(["D"]);
  });

  it("makes both a group AND its member items eligible when only the group is selected (EDGE-PR-11)", () => {
    // Selecting "Seniors" alone expands the selection to {D, N}; D and N are then
    // individually eligible (their own ids are in the expanded set) AND Seniors
    // itself is eligible (non-empty, all members covered) — ground truth behavior.
    expect(eligibleCoefficientIds(["Seniors"], DOMAIN)).toEqual(["D", "N", "Seniors"]);
  });

  it("does not make a group eligible when only some of its members are selected", () => {
    expect(eligibleCoefficientIds(["D"], DOMAIN)).not.toContain("Seniors");
  });

  it("has no special-case exclusion for OFF/LEAVE — selecting them makes them eligible too", () => {
    expect(eligibleCoefficientIds(["OFF"], DOMAIN)).toEqual(["OFF"]);
    expect(eligibleCoefficientIds(["LEAVE"], DOMAIN)).toEqual(["LEAVE"]);
  });

  it("an empty group never becomes eligible", () => {
    const domain: CoefficientDomain = {
      items: [{ id: "D" }],
      groups: [{ id: "Empty", members: [] }],
    };
    expect(eligibleCoefficientIds(["Empty"], domain)).toEqual([]);
  });
});

describe("syncCoefficientPairs (FR-PR-73)", () => {
  it("adds blank pairs for newly-eligible ids and drops ids no longer eligible", () => {
    const synced = syncCoefficientPairs(
      ["D"],
      [
        ["D", 3],
        ["N", 5],
      ],
      DOMAIN,
    );
    expect(synced).toEqual([["D", 3]]);
  });

  it("preserves an existing value when the id stays eligible", () => {
    const synced = syncCoefficientPairs(["Seniors"], [["D", 2]], DOMAIN);
    expect(coefficientValueFor(synced, "D")).toBe(2);
    expect(coefficientValueFor(synced, "N")).toBe("");
    expect(coefficientValueFor(synced, "Seniors")).toBe("");
  });
});

describe("parseCoefficientInput (FR-PR-72/EDGE-PR-10)", () => {
  it("keeps blank input blank", () => {
    expect(parseCoefficientInput("")).toBe("");
  });

  it("truncates a decimal to its integer prefix via parseInt", () => {
    expect(parseCoefficientInput("1.5")).toBe(1);
    expect(parseCoefficientInput("2.9")).toBe(2);
  });

  it("clamps a value below 1 up to 1", () => {
    expect(parseCoefficientInput("0")).toBe(1);
    expect(parseCoefficientInput("0.5")).toBe(1);
  });

  it("keeps an unparseable string verbatim", () => {
    expect(parseCoefficientInput("abc")).toBe("abc");
  });
});

describe("updateCoefficientPair", () => {
  it("rewrites exactly one id, preserving the others", () => {
    const pairs = updateCoefficientPair(
      ["D", "N"],
      [
        ["D", 1],
        ["N", 2],
      ],
      "N",
      9,
    );
    expect(pairs).toEqual([
      ["D", 1],
      ["N", 9],
    ]);
  });
});

describe("validateCoefficientPairs (spec 05 coefficient table)", () => {
  it("drops blank pairs and returns no errors when everything is valid", () => {
    const result = validateCoefficientPairs(
      ["D", "N"],
      [
        ["D", 2],
        ["N", ""],
      ],
      DOMAIN,
    );
    expect(result.entries).toEqual([["D", 2]]);
    expect(result.errorsById).toEqual({});
    expect(result.overlapError).toBeUndefined();
  });

  it("reports the verbatim per-id integer error for an invalid non-blank value", () => {
    const result = validateCoefficientPairs(["D"], [["D", "abc"]], DOMAIN);
    expect(result.errorsById.D).toBe(coefficientIntegerErrorMessage("D"));
    expect(result.entries).toEqual([]);
  });

  it("reports the verbatim overlap error only once every value is individually valid", () => {
    // Selecting "Seniors" makes D, N, and Seniors all eligible; giving both D and
    // Seniors a value creates a real overlap (both cover D).
    const result = validateCoefficientPairs(
      ["Seniors"],
      [
        ["D", 2],
        ["N", 3],
        ["Seniors", 4],
      ],
      DOMAIN,
    );
    expect(result.errorsById).toEqual({});
    expect(result.overlapError).toBe(coefficientOverlapMessage("D", "Seniors", "D"));
  });

  it("suppresses the overlap check while a per-id integer error still exists", () => {
    const result = validateCoefficientPairs(
      ["Seniors"],
      [
        ["D", "bad"],
        ["N", 3],
        ["Seniors", 4],
      ],
      DOMAIN,
    );
    expect(result.errorsById.D).toBeDefined();
    expect(result.overlapError).toBeUndefined();
  });
});

describe("M1 — typed member identity (number vs string) in expansion/coverage/overlap", () => {
  // A group whose only member is the NUMERIC shift 1, alongside an unrelated string
  // shift "1". They must never collapse (Set.has typed identity).
  const typed: CoefficientDomain = {
    items: [{ id: "1" }, { id: "D" }],
    groups: [{ id: "G", members: [1] }],
  };

  it('selecting group G (member numeric 1) does not make string shift "1" eligible', () => {
    expect(eligibleCoefficientIds(["G"], typed)).toEqual(["G"]);
  });

  it("group G stays eligible only when its numeric member is reached", () => {
    // Nothing that expands to numeric 1 is selected besides G itself.
    expect(eligibleCoefficientIds(["D"], typed)).toEqual(["D"]);
  });

  it('no false overlap between string "1" and G→[1]', () => {
    const result = validateCoefficientPairs(
      ["1", "G"],
      [
        ["1", 2],
        ["G", 3],
      ],
      typed,
    );
    expect(result.errorsById).toEqual({});
    expect(result.overlapError).toBeUndefined();
  });

  it("DOES detect a real overlap when two groups share the same numeric member", () => {
    const shared: CoefficientDomain = {
      items: [{ id: "D" }],
      groups: [
        { id: "G", members: [1] },
        { id: "H", members: [1] },
      ],
    };
    const result = validateCoefficientPairs(
      ["G", "H"],
      [
        ["G", 2],
        ["H", 3],
      ],
      shared,
    );
    expect(result.overlapError).toBe(coefficientOverlapMessage("G", "H", 1));
  });
});
