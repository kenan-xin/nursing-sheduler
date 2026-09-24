import { describe, expect, it } from "vitest";
import { capOf, findStaffingShortfalls, toDateId } from "./shortfalls";
import { SCENARIOS, cards, leave, people, requirement, ward } from "./ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";

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
