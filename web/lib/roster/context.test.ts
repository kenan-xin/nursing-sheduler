// Deriving the viewer context from the immutable submission (F3).
//
// The submission here is real: it is serialized through the production strict path
// and parsed back, so these tests also prove the exact-submission YAML actually
// round-trips into a canonical document. The recurring theme is that a value the
// submission does not fix comes back ABSENT / `unavailable` / `null` — never a
// plausible default.

import { describe, expect, it } from "vitest";
import { PREFERENCE_TYPE, type CanonicalScenarioDocument } from "@/lib/scenario";
import { deriveRosterContext, parseSubmissionDocument } from "./context";
import {
  FIXTURE_DATES,
  FIXTURE_HOLIDAY,
  fixtureCanonicalDocument,
  fixtureSubmission,
  withContractedHours,
} from "./test-fixtures";
import type { RosterContext } from "./types";

function derive(
  document?: CanonicalScenarioDocument,
  reverseMap?: [string, string | number][],
): RosterContext {
  const result = deriveRosterContext(fixtureSubmission(document, reverseMap));
  if (!result.ok) throw new Error(`expected a derived context, got: ${result.reason}`);
  return result.context;
}

/** Weekend membership computed independently of the backend keyword resolver. */
function isWeekendIso(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

describe("parseSubmissionDocument", () => {
  it("round-trips the exact submitted YAML back into a canonical document", () => {
    const submission = fixtureSubmission();
    const parsed = parseSubmissionDocument(submission.canonicalYaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.people.items.map((person) => person.id)).toEqual(["P1", "P2"]);
    expect(parsed.document.dates.range).toEqual({
      startDate: FIXTURE_DATES[0],
      endDate: FIXTURE_DATES[3],
    });
  });

  it("rejects an empty, unparseable, or non-canonical submission", () => {
    expect(parseSubmissionDocument("")).toMatchObject({ ok: false });
    expect(parseSubmissionDocument("{[")).toMatchObject({ ok: false });
    // Structurally fine YAML that is not a canonical scenario.
    expect(parseSubmissionDocument("hello: world\n")).toMatchObject({ ok: false });
  });
});

describe("deriveRosterContext — people", () => {
  it("de-anonymizes the people axis in submission order, preserving id types", () => {
    const context = derive();
    expect(context.people).toEqual([{ id: "Alice Ng", history: ["D"] }, { id: 7 }]);
    // The numeric original stays a number: a stringified `"7"` would be a different
    // person as far as every typed-id comparison downstream is concerned.
    expect(typeof context.people[1].id).toBe("number");
  });

  it("carries only real canonical person fields — no invented name/role", () => {
    const context = derive();
    expect(Object.keys(context.people[0]).sort()).toEqual(["history", "id"]);
    expect(Object.keys(context.people[1])).toEqual(["id"]);
  });

  it("treats an empty reverse map as a plain (non-anonymized) submission", () => {
    const plain = fixtureCanonicalDocument();
    plain.people = { items: [{ id: "Alice Ng" }, { id: 7 }] };
    const context = derive(plain, []);
    expect(context.people.map((person) => person.id)).toEqual(["Alice Ng", 7]);
  });

  it("fails closed when the reverse map does not cover every submitted person", () => {
    expect(deriveRosterContext(fixtureSubmission(undefined, [["P1", "Alice Ng"]]))).toMatchObject({
      ok: false,
    });
    expect(
      deriveRosterContext(
        fixtureSubmission(undefined, [
          ["P1", "Alice Ng"],
          ["P9", 7],
        ]),
      ),
    ).toMatchObject({ ok: false });
  });

  it("fails closed on a duplicate de-anonymized identity", () => {
    // Two distinct anonymized ids collapsing onto one real nurse would silently
    // merge two rows of the roster.
    expect(
      deriveRosterContext(
        fixtureSubmission(undefined, [
          ["P1", "Alice Ng"],
          ["P2", "Alice Ng"],
        ]),
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("deriveRosterContext — shift types and calendar", () => {
  it("carries only real canonical shift-type fields", () => {
    const context = derive();
    expect(context.shiftTypes).toEqual([
      { id: "D", startTime: "09:00", endTime: "17:00", durationMinutes: 480 },
      { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
    ]);
  });

  it("expands the submitted range day for day, in order", () => {
    const context = derive();
    expect(context.calendar.map((day) => day.iso)).toEqual([...FIXTURE_DATES]);
  });

  it("marks weekends from the backend keyword, agreeing with a UTC weekday check", () => {
    const context = derive();
    for (const day of context.calendar) {
      expect(day.weekend).toBe(isWeekendIso(day.iso));
    }
    // The fixture range genuinely spans both, so neither branch is vacuous.
    expect(context.calendar.some((day) => day.weekend)).toBe(true);
    expect(context.calendar.some((day) => !day.weekend)).toBe(true);
  });

  it("marks holidays from the submission's OWN PH group, not a bundled dataset", () => {
    const context = derive();
    expect(context.calendar.filter((day) => day.holiday).map((day) => day.iso)).toEqual([
      FIXTURE_HOLIDAY,
    ]);

    // A submission with no PH group asserts no holidays — nothing is filled in.
    const noGroups = fixtureCanonicalDocument();
    noGroups.dates = { range: noGroups.dates.range };
    expect(derive(noGroups).calendar.every((day) => !day.holiday)).toBe(true);
  });

  it("labels each day with its three-letter weekday", () => {
    const context = derive();
    const expected = context.calendar.map(
      (day) =>
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
          new Date(`${day.iso}T00:00:00Z`).getUTCDay()
        ],
    );
    expect(context.calendar.map((day) => day.weekday)).toEqual(expected);
  });
});

describe("deriveRosterContext — baselineMinimums", () => {
  /** Replace the fixture's `D` requirement with a variant, keeping everything else. */
  function withRequirement(overrides: Record<string, unknown>): CanonicalScenarioDocument {
    const document = fixtureCanonicalDocument();
    document.preferences = [
      document.preferences[0],
      { ...(document.preferences[1] as object), ...overrides } as never,
    ];
    return document;
  }

  it("yields a usable baseline for the ordinary scalar-ALL requirement", () => {
    expect(derive().baselineMinimums).toEqual([
      { shiftId: "D", required: 1, source: "preferences[1]" },
      // `N` carries no requirement at all.
      { shiftId: "N", unavailable: true },
    ]);
  });

  it("accepts an OMITTED date/qualifiedPeople as unscoped, exactly like scalar ALL", () => {
    const omitted = withRequirement({ date: undefined, qualifiedPeople: undefined });
    expect(omitted.preferences[1]).not.toHaveProperty("date", "ALL");
    expect(derive(omitted).baselineMinimums[0]).toEqual({
      shiftId: "D",
      required: 1,
      source: "preferences[1]",
    });
  });

  it("marks a shift unavailable when two requirements compete for it", () => {
    const document = fixtureCanonicalDocument();
    document.preferences = [
      ...document.preferences,
      { ...(document.preferences[1] as object), requiredNumPeople: 2 } as never,
    ];
    expect(derive(document).baselineMinimums[0]).toEqual({ shiftId: "D", unavailable: true });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a list selector", { shiftType: ["D"] }],
    ["a group selector", { shiftType: "Both" }],
    ["the ALL keyword", { shiftType: "ALL" }],
    ["a date-scoped requirement", { date: FIXTURE_DATES[0] }],
    ["a list-scoped date", { date: ["ALL"] }],
    ["a qualified requirement", { qualifiedPeople: "P1" }],
    ["a coefficient requirement", { shiftTypeCoefficients: [["D", 2]] }],
  ])("marks a shift unavailable for %s", (_label, overrides) => {
    const document = withRequirement(overrides);
    if (overrides.shiftType === "Both") {
      document.shiftTypes.groups = [{ id: "Both", members: ["D"] }];
    }
    const baseline = derive(document).baselineMinimums[0];
    expect(baseline).toEqual({ shiftId: "D", unavailable: true });
  });

  it("is not swayed by preferredNumPeople or weight", () => {
    const document = withRequirement({ preferredNumPeople: 4, weight: -7 });
    expect(derive(document).baselineMinimums[0]).toEqual({
      shiftId: "D",
      required: 1,
      source: "preferences[1]",
    });
  });
});

describe("deriveRosterContext — leaveCreditMinutes", () => {
  it("is null when the submission fixes no contracted-hours leave credit", () => {
    expect(derive().leaveCreditMinutes).toBeNull();
  });

  it("converts the single contracted-hours LEAVE coefficient to minutes", () => {
    expect(derive(withContractedHours(fixtureCanonicalDocument(), 16)).leaveCreditMinutes).toBe(
      480,
    );
    expect(derive(withContractedHours(fixtureCanonicalDocument(), 20)).leaveCreditMinutes).toBe(
      600,
    );
  });

  it("is null when two contracted-hours counts disagree", () => {
    const document = withContractedHours(fixtureCanonicalDocument(), 16);
    const conflicting = withContractedHours(document, 20);
    expect(derive(conflicting).leaveCreditMinutes).toBeNull();
  });

  it("ignores an UNMARKED shift count's LEAVE coefficient", () => {
    // Without `hoursContract` the coefficient's unit is not half-hours, so reading
    // it as a leave credit would be inventing a number.
    const document = fixtureCanonicalDocument();
    document.preferences = [
      ...document.preferences,
      {
        type: PREFERENCE_TYPE.shiftCount,
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: ["D", "LEAVE"],
        countShiftTypeCoefficients: [
          ["D", 1],
          ["LEAVE", 9],
        ],
        expression: "x <= T",
        target: 5,
        weight: -1,
      },
    ];
    expect(derive(document).leaveCreditMinutes).toBeNull();
  });
});
