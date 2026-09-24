import { describe, expect, it } from "vitest";
import {
  capOf,
  findStaffingShortfalls,
  newRuleClash,
  requiredOn,
  requirementDateIsos,
  toDateId,
} from "./shortfalls";
import { SCENARIOS, cards, leave, people, requirement, ward } from "./ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";

describe("newRuleClash (att: two named groups on one shift)", () => {
  const icuWard = (extra: ReturnType<typeof requirement>[] = [], patch = {}) =>
    ward({
      staff: people("icu1", "icu2", "gen1", "gen2"),
      staffGroups: [
        { id: "ICU", members: ["icu1", "icu2"] },
        { id: "GEN", members: ["gen1", "gen2"] },
        { id: "SEN", members: ["icu1", "gen1"] },
      ],
      cardsByKind: cards({
        requirements: [requirement("icu-d", "D", 1, { qualifiedPeople: ["ICU"] }), ...extra],
      }),
      ...patch,
    });

  it("flags a second named group on the same shift: each bans the other's people", () => {
    const after = icuWard([requirement("gen-d", "D", 1, { qualifiedPeople: ["GEN"] })]);
    expect(newRuleClash(icuWard(), after)?.ruleIds.sort()).toEqual(["gen-d", "icu-d"]);
  });

  it("flags a skill mix whose group the named rule bans", () => {
    const mix = requirement("mix-d", "D", 1, { skillMix: [{ people: "GEN", minNumPeople: 1 }] });
    expect(newRuleClash(icuWard(), icuWard([mix]))).not.toBeNull();
  });

  it("passes groups that share someone, other shifts, and a clash that was already there", () => {
    const sen = requirement("sen-d", "D", 1, { qualifiedPeople: ["SEN"] });
    expect(newRuleClash(icuWard(), icuWard([sen]))).toBeNull();
    const night = requirement("gen-n", "N", 1, { qualifiedPeople: ["GEN"] });
    expect(newRuleClash(icuWard(), icuWard([night]))).toBeNull();
    const clashing = icuWard([requirement("gen-d", "D", 1, { qualifiedPeople: ["GEN"] })]);
    expect(newRuleClash(clashing, clashing)).toBeNull();
  });

  describe("a clash that was already there stays old after an unrelated edit (review S1)", () => {
    const gen = requirement("gen-d", "D", 1, { qualifiedPeople: ["GEN"] });
    const sen = requirement("sen-d", "D", 1, { qualifiedPeople: ["SEN"] });

    it("turning off one of two banning rules is a step toward a fix, not a new clash", () => {
      // gen-d is banned by icu-d and icu2-d; turning off icu2-d leaves the old icu-d clash.
      const icu2 = requirement("icu2-d", "D", 1, { qualifiedPeople: ["ICU"] });
      const before = icuWard([gen, icu2]);
      const after = icuWard([gen, { ...icu2, disabled: true }]);
      expect(newRuleClash(before, after)).toBeNull();
    });

    it("a longer roster period or a new span class does not make it new", () => {
      const before = icuWard([gen]);
      expect(newRuleClash(before, { ...before, rangeEnd: "2026-11-30" })).toBeNull();
      expect(newRuleClash(before, { ...before, rangeEnd: "2027-01-31" })).toBeNull();
    });

    it("reordering the rules or a group's members does not make it new", () => {
      const before = icuWard([gen, sen]);
      const reordered = {
        ...before,
        staffGroups: before.staffGroups.map((g) => ({ ...g, members: [...g.members].reverse() })),
        cardsByKind: {
          ...before.cardsByKind,
          requirements: [...before.cardsByKind.requirements].reverse(),
        },
      };
      expect(newRuleClash(before, reordered)).toBeNull();
    });
  });

  it("leaves a gap made by leave to the static check, not to this refusal", () => {
    const onLeave = icuWard([], {
      reqData: [leave("icu1", "2026-11-02"), leave("icu2", "2026-11-02")],
    });
    expect(newRuleClash(icuWard(), onLeave)).toBeNull();
  });
});

describe("findStaffingShortfalls", () => {
  it("finds nothing in an empty scenario", () => {
    expect(findStaffingShortfalls(SCENARIOS.empty())).toEqual([]);
  });

  it("reports the only RN on leave as a skill-mix requirement shortfall", () => {
    const findings = findStaffingShortfalls(SCENARIOS.onlyRnOnLeave());
    expect(findings).toEqual([
      {
        kind: "requirement_short",
        dateId: "03",
        iso: "2026-11-03",
        shiftTypes: ["N"],
        ruleIds: ["night-rn"],
        required: 1,
        available: 0,
        away: [{ person: "rn1", reason: "leave" }],
        capRuleIds: [],
        skillMix: true,
        mixPeople: null,
      },
    ]);
  });

  it("reports a day that needs more nurses than it has across separate shifts", () => {
    const findings = findStaffingShortfalls(SCENARIOS.understaffedNight());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "day_short",
      dateId: "05",
      required: 4,
      available: 3,
      ruleIds: ["night-05", "day"],
      skillMix: false,
    });
  });

  it("reports hard count caps that cannot supply a requirement over the period", () => {
    expect(findStaffingShortfalls(SCENARIOS.ruleTooStrict())).toEqual([
      expect.objectContaining({
        kind: "cap_short",
        dateId: null,
        shiftTypes: ["N"],
        ruleIds: ["night"],
        required: 7,
        available: 4,
        capRuleIds: ["max-nights"],
      }),
    ]);
  });

  it("reports every day of a chronically short ward", () => {
    const findings = findStaffingShortfalls(SCENARIOS.tooFewNurses());
    expect(findings.map((f) => [f.kind, f.dateId, f.required, f.available])).toEqual(
      ["01", "02", "03", "04", "05", "06", "07"].map((d) => ["day_short", d, 3, 2]),
    );
  });

  it("stays silent on infeasibility it does not model (rest rules)", () => {
    expect(findStaffingShortfalls(SCENARIOS.restRuleTooTight())).toEqual([]);
  });

  it("treats an ISO-dated leave cell as the same day as its span id", () => {
    const iso = { ...SCENARIOS.onlyRnOnLeave(), reqData: [leave("rn1", "2026-11-03")] };
    expect(findStaffingShortfalls(iso).map((f) => f.dateId)).toEqual(["03"]);
  });

  it("expands a group leave row to its members", () => {
    const grouped = { ...SCENARIOS.onlyRnOnLeave(), reqData: [leave("RN", "03")] };
    expect(findStaffingShortfalls(grouped)[0].away).toEqual([{ person: "rn1", reason: "leave" }]);
  });

  it("counts a hard day off and a hard 'never' request as away, but not soft ones", () => {
    const base = SCENARIOS.onlyRnOnLeave();
    const hardOff = {
      ...base,
      reqData: [{ uid: "o", person: "rn1", date: "03", kind: "off" as const, weight: Infinity }],
    };
    const softOff = {
      ...base,
      reqData: [{ uid: "o", person: "rn1", date: "03", kind: "off" as const, weight: 5 }],
    };
    const never = {
      ...base,
      reqData: [
        {
          uid: "r",
          person: "rn1",
          date: "03",
          kind: "request" as const,
          shiftType: "N",
          weight: -Infinity,
        },
      ],
    };
    expect(findStaffingShortfalls(hardOff)[0].away[0].reason).toBe("day_off");
    expect(findStaffingShortfalls(softOff)).toEqual([]);
    expect(findStaffingShortfalls(never)[0].away[0].reason).toBe("never_request");
  });

  it("finds nothing in a ward that can be staffed", () => {
    const state = ward({
      staff: people("rn1", "rn2", "en1", "en2"),
      staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
      reqData: [leave("rn1", "03")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 2),
          requirement("night-rn", "N", 1, { qualifiedPeople: ["RN"] }),
          requirement("night", "N", 1, { preferredNumPeople: 2, weight: -5 }),
        ],
      }),
    });
    expect(findStaffingShortfalls(state)).toEqual([]);
  });

  it("reports a night that needs more nurses than the ward has", () => {
    const state = ward({
      staff: people("ana", "ben"),
      cardsByKind: cards({ requirements: [requirement("night", "N", 3, { date: ["05"] })] }),
    });
    expect(findStaffingShortfalls(state)).toEqual([
      expect.objectContaining({
        kind: "requirement_short",
        dateId: "05",
        required: 3,
        available: 2,
        away: [],
      }),
    ]);
  });

  it("counts an ALL shift selector as one requirement over every worked shift", () => {
    const state = ward({
      staff: people("ana"),
      cardsByKind: cards({ requirements: [requirement("any", "ALL", 2, { date: ["02"] })] }),
    });
    expect(findStaffingShortfalls(state)).toEqual([
      expect.objectContaining({
        kind: "requirement_short",
        dateId: "02",
        shiftTypes: ["D", "N"],
        available: 1,
      }),
    ]);
  });

  it("applies a skill-mix rule's ban to every other requirement on that shift", () => {
    // "1-2 RNs on nights" bans the ENs from nights, so "2 on nights" has only rn1.
    // (The range keeps the two rules from contradicting each other outright.)
    const state = ward({
      staff: people("rn1", "en1", "en2"),
      staffGroups: [{ id: "RN", members: ["rn1"] }],
      cardsByKind: cards({
        requirements: [
          requirement("night-rn", "N", 1, {
            qualifiedPeople: ["RN"],
            preferredNumPeople: 2,
            weight: -5,
            date: ["04"],
          }),
          requirement("night", "N", 2, { date: ["04"] }),
        ],
      }),
    });
    expect(findStaffingShortfalls(state)).toEqual([
      expect.objectContaining({
        kind: "requirement_short",
        dateId: "04",
        ruleIds: ["night", "night-rn"],
        required: 2,
        available: 1,
        skillMix: true,
      }),
    ]);
  });

  it("reports overlapping exact requirements that contradict each other", () => {
    // Every night exactly 1, but the 5th exactly 2: no roster satisfies both.
    const state = ward({
      staff: people("ana", "ben", "cara"),
      cardsByKind: cards({
        requirements: [
          requirement("night", "N", 1),
          requirement("night-05", "N", 2, { date: ["05"] }),
        ],
      }),
    });
    expect(findStaffingShortfalls(state)).toEqual([
      {
        kind: "requirement_conflict",
        dateId: "05",
        iso: "2026-11-05",
        shiftTypes: ["N"],
        ruleIds: ["night-05", "night"],
        required: 2,
        available: 1,
        away: [],
        capRuleIds: [],
        skillMix: false,
        mixPeople: null,
      },
    ]);
  });

  it("reports separate shifts that together exceed an exact requirement over both", () => {
    const state = ward({
      staff: people("ana", "ben", "cara"),
      shiftGroups: [{ id: "Any", members: ["D", "N"] }],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1, { date: ["02"] }),
          requirement("night", "N", 1, { date: ["02"] }),
          requirement("total", "Any", 1, { date: ["02"] }),
        ],
      }),
    });
    expect(findStaffingShortfalls(state)).toEqual([
      expect.objectContaining({
        kind: "requirement_conflict",
        dateId: "02",
        ruleIds: ["day", "night", "total"],
        required: 2,
        available: 1,
      }),
    ]);
  });

  it("accepts overlapping requirements whose preferred ranges meet", () => {
    const state = ward({
      staff: people("ana", "ben", "cara"),
      cardsByKind: cards({
        requirements: [
          requirement("night", "N", 1, { preferredNumPeople: 3, weight: -5 }),
          requirement("night-05", "N", 2, { date: ["05"] }),
        ],
      }),
    });
    expect(findStaffingShortfalls(state)).toEqual([]);
  });

  describe("skill-mix gaps", () => {
    const rnWard = (patch: Partial<ScenarioUiState> = {}) =>
      ward({
        staff: people("rn1", "rn2", "en1", "en2", "en3"),
        staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
        cardsByKind: cards({
          requirements: [
            requirement("day", "D", 1),
            requirement("night", "N", 2, { skillMix: [{ people: "RN", minNumPeople: 2 }] }),
          ],
        }),
        ...patch,
      });

    it("an RN on leave leaves the night one RN short, flagged as skill mix", () => {
      const findings = findStaffingShortfalls(rnWard({ reqData: [leave("rn2", "03")] }));
      expect(findings).toEqual([
        expect.objectContaining({
          kind: "requirement_short",
          dateId: "03",
          ruleIds: ["night"],
          required: 2,
          available: 1,
          skillMix: true,
          mixPeople: "RN",
          away: [{ person: "rn2", reason: "leave" }],
        }),
      ]);
    });

    it("a skill mix does not ban anyone: non-RNs still count toward the head count", () => {
      expect(findStaffingShortfalls(rnWard())).toEqual([]);
    });

    it("empty group is a skill-mix gap on every night", () => {
      const findings = findStaffingShortfalls(rnWard({ staffGroups: [{ id: "RN", members: [] }] }));
      expect(findings.filter((f) => f.mixPeople === "RN")).toHaveLength(7);
    });

    it("scopes a dated card's skill-mix entries to its own dates", () => {
      const dated = rnWard({
        cardsByKind: cards({
          requirements: [
            requirement("day", "D", 1),
            requirement("night", "N", 2, {
              skillMix: [{ people: "RN", minNumPeople: 2 }],
              date: ["04"],
            }),
          ],
        }),
        // rn2 away on the 2nd is outside the card's date scope, so it raises nothing there.
        reqData: [leave("rn2", "04"), leave("rn2", "02")],
      });
      const findings = findStaffingShortfalls(dated);
      expect(findings.map((f) => f.dateId)).toEqual(["04"]);
      expect(findings[0].mixPeople).toBe("RN");
    });

    it("tracks two skill-mix entries on one card independently", () => {
      // RN >= 2 and Senior >= 1 on a 3-person night. Only the Senior on leave, so only
      // the Senior entry is short; the RN entry and the card's own head count are fine.
      const state = ward({
        staff: people("rn1", "rn2", "sen1", "other1", "other2"),
        staffGroups: [
          { id: "RN", members: ["rn1", "rn2"] },
          { id: "Senior", members: ["sen1"] },
        ],
        reqData: [leave("sen1", "04")],
        cardsByKind: cards({
          requirements: [
            requirement("day", "D", 1),
            requirement("night", "N", 3, {
              skillMix: [
                { people: "RN", minNumPeople: 2 },
                { people: "Senior", minNumPeople: 1 },
              ],
            }),
          ],
        }),
      });
      const findings = findStaffingShortfalls(state);
      expect(findings).toEqual([
        expect.objectContaining({
          kind: "requirement_short",
          dateId: "04",
          ruleIds: ["night"],
          required: 1,
          available: 0,
          skillMix: true,
          mixPeople: "Senior",
          away: [{ person: "sen1", reason: "leave" }],
        }),
      ]);
    });

    const mixWard = (n: number, mix: { people: string; minNumPeople: number }[], extra = {}) =>
      ward({
        staff: people("rn1", "rn2", "en1", "en2"),
        staffGroups: [
          { id: "RN", members: ["rn1", "rn2"] },
          { id: "EN", members: ["en1", "en2"] },
          { id: "Senior", members: ["rn1"] },
        ],
        cardsByKind: cards({
          requirements: [requirement("night", "N", n, { skillMix: mix, ...extra })],
        }),
      });

    it("reports disjoint skill-mix groups that need more people than the head count", () => {
      const findings = findStaffingShortfalls(
        mixWard(3, [
          { people: "RN", minNumPeople: 2 },
          { people: "EN", minNumPeople: 2 },
        ]),
      );
      expect(findings).toHaveLength(7);
      expect(findings[0]).toMatchObject({
        kind: "requirement_conflict",
        dateId: "01",
        shiftTypes: ["N"],
        ruleIds: ["night"],
        required: 4,
        available: 3,
        skillMix: true,
        mixPeople: "RN and EN",
      });
    });

    it("accepts overlapping skill-mix groups: an RN who is a senior counts toward both", () => {
      const mix = [
        { people: "RN", minNumPeople: 2 },
        { people: "Senior", minNumPeople: 1 },
      ];
      expect(findStaffingShortfalls(mixWard(2, mix))).toEqual([]);
    });

    it("accepts disjoint skill-mix groups that fit under the preferred count", () => {
      const mix = [
        { people: "RN", minNumPeople: 2 },
        { people: "EN", minNumPeople: 2 },
      ];
      expect(findStaffingShortfalls(mixWard(3, mix, { preferredNumPeople: 4 }))).toEqual([]);
    });

    const disjointMix = [
      { people: "RN", minNumPeople: 2 },
      { people: "EN", minNumPeople: 2 },
    ];

    it("reports disjoint skill-mix groups on an override date that lowers the head count below them", () => {
      const findings = findStaffingShortfalls(
        mixWard(4, disjointMix, { requiredNumPeopleOverrides: [["2026-11-05", 3]] }),
      );
      expect(findings).toEqual([
        expect.objectContaining({
          kind: "requirement_conflict",
          dateId: "05",
          ruleIds: ["night"],
          required: 4,
          available: 3,
          mixPeople: "RN and EN",
        }),
      ]);
    });

    it("a lowered override date still fits disjoint groups under the preferred count", () => {
      const state = mixWard(4, disjointMix, {
        preferredNumPeople: 4,
        requiredNumPeopleOverrides: [["2026-11-05", 3]],
      });
      expect(findStaffingShortfalls(state)).toEqual([]);
    });
  });

  it("ignores disabled requirements and ones with coefficients", () => {
    const state = ward({
      staff: people("ana"),
      cardsByKind: cards({
        requirements: [
          requirement("off", "D", 5, { disabled: true }),
          requirement("coef", "N", 5, { shiftTypeCoefficients: [["N", 2]] }),
        ],
      }),
    });
    expect(findStaffingShortfalls(state)).toEqual([]);
  });
});

describe("requirement overrides", () => {
  // Every night needs 2, cara is on leave on the 5th: the 5th is one short.
  const shortFifth = (overrides?: [string, number][]) =>
    ward({
      staff: people("ana", "ben", "cara"),
      reqData: [leave("cara", "05")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 2, overrides ? { requiredNumPeopleOverrides: overrides } : {}),
        ],
      }),
    });

  it("reads the override on its date and the rule's number elsewhere", () => {
    const card = {
      requiredNumPeople: 2,
      requiredNumPeopleOverrides: [["2026-11-05", 1]] as [string, number][],
    };
    expect(requiredOn(card, "2026-11-05")).toBe(1);
    expect(requiredOn(card, "2026-11-04")).toBe(2);
  });

  it("finds the one-short date without an override", () => {
    expect(findStaffingShortfalls(shortFifth()).map((f) => f.dateId)).toEqual(["05"]);
  });

  it("finds no gap once the short date has an override of one fewer", () => {
    expect(findStaffingShortfalls(shortFifth([["2026-11-05", 1]]))).toEqual([]);
  });

  it("an override that raises a date makes that date short", () => {
    const findings = findStaffingShortfalls(
      shortFifth([
        ["2026-11-05", 1],
        ["2026-11-03", 3],
      ]),
    );
    expect(findings.map((f) => [f.dateId, f.required])).toContainEqual(["03", 4]);
  });

  it("lists the ISO dates a rule covers", () => {
    const state = shortFifth();
    expect(requirementDateIsos(state, { date: ["2026-11-02", "2026-11-04"] })).toEqual([
      "2026-11-02",
      "2026-11-04",
    ]);
    expect(requirementDateIsos(state, { date: ["ALL"] })).toHaveLength(7);
  });
});

describe("capOf", () => {
  it("reads every hard upper bound and nothing else", () => {
    expect(capOf("x <= T", 5, Infinity)).toBe(5);
    expect(capOf("x < T", 5, Infinity)).toBe(4);
    expect(capOf("x = T", 5, Infinity)).toBe(5);
    expect(capOf("x > T", 5, -Infinity)).toBe(5);
    expect(capOf("x >= T", 5, -Infinity)).toBe(4);
    expect(capOf("|x - T|^2", 5, -Infinity)).toBe(5);
    expect(capOf("x >= T", 5, Infinity)).toBe(Infinity);
    expect(capOf("x <= T", 5, -3)).toBe(Infinity);
  });
});

describe("toDateId", () => {
  it("maps an in-range ISO date onto the span id and leaves other refs alone", () => {
    const range = { start: "2026-11-01", end: "2026-11-07" };
    expect(toDateId("2026-11-05", range)).toBe("05");
    expect(toDateId("05", range)).toBe("05");
    expect(toDateId("WEEKDAY", range)).toBe("WEEKDAY");
  });
});
