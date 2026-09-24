// Operational assumptions and their confirmations (T07; decision R12).
//
// The three properties that matter: the host DERIVES the questions from validated
// targets (never from model text), a confirmation binds to one exact proposal
// revision, and a change that destroys someone's leave asks about it even though no
// command mentions leave at all.

import { describe, expect, it } from "vitest";
import {
  activeConfirmations,
  calendarSpan,
  confirmationsDigest,
  deriveAssumptions,
  outstandingAssumptions,
  type OperationalConfirmationV1,
} from "./assumptions";
import { proposalDigest } from "./digest";
import { applyAssistantCommands } from "./operations";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import { octoberWard, peopleScenario, proposalScenario } from "./test-support";

function assumptionsFor(commands: Parameters<typeof applyAssistantCommands>[1]) {
  const before = proposalScenario();
  const applied = applyAssistantCommands(before, commands);
  if (!applied.ok) throw new Error(`fixture refused: ${applied.rejection.message}`);
  return {
    before,
    after: applied.next,
    assumptions: deriveAssumptions(before, applied.next, commands),
  };
}

describe("deriveAssumptions", () => {
  it("asks about a moved leave, naming the person and both dates", () => {
    const { assumptions } = assumptionsFor([
      { type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" },
    ]);
    expect(assumptions).toHaveLength(1);
    expect(assumptions[0]).toMatchObject({
      type: "leave_moved",
      person: "ana",
      date: "02",
      toDate: "10",
    });
    expect(assumptions[0].question).toContain("ana");
    expect(assumptions[0].question).toContain("10");
  });

  it("asks about leave a CASCADE destroys, which no command mentions", () => {
    // Shrinking the roster period past ana's leave date is a dates operation. The
    // fact that it cancels a person's leave is only visible in the documents.
    const { assumptions } = assumptionsFor([
      {
        type: "set_roster_range",
        start: "2026-04-03",
        end: "2026-04-30",
        importPublicHolidays: false,
      },
    ]);
    expect(assumptions).toHaveLength(1);
    expect(assumptions[0]).toMatchObject({ type: "leave_cancelled", person: "ana", date: "02" });
  });

  it("does not ask twice about one agreement", () => {
    // A move makes the pin disappear from its old coordinate, which the destroyed-
    // leave scan would otherwise report as a second, separate cancellation.
    const { assumptions } = assumptionsFor([
      { type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" },
    ]);
    expect(assumptions.map((entry) => entry.type)).toEqual(["leave_moved"]);
  });

  it("asks nothing for a change with no real-world commitment", () => {
    const { assumptions } = assumptionsFor([
      { type: "set_staffing_requirement_people", ruleId: "req-day", requiredNumPeople: 4 },
    ]);
    expect(assumptions).toEqual([]);
  });

  it("gives the same change the same question identities every time", () => {
    const first = assumptionsFor([
      { type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" },
    ]);
    const second = assumptionsFor([
      { type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" },
    ]);
    expect(first.assumptions).toEqual(second.assumptions);
  });
});

describe("confirmations bind to one revision and one target", () => {
  const { assumptions } = assumptionsFor([
    { type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" },
  ]);
  const answer = (over: Partial<OperationalConfirmationV1> = {}): OperationalConfirmationV1 => ({
    assumptionId: assumptions[0].assumptionId,
    type: assumptions[0].type,
    person: assumptions[0].person,
    date: assumptions[0].date,
    toDate: assumptions[0].toDate,
    proposalRevision: 1,
    confirmedAt: "2026-08-06T00:00:00.000Z",
    ...over,
  });

  it("counts an answer given against this revision", () => {
    expect(outstandingAssumptions(assumptions, [answer()], 1)).toEqual([]);
    expect(activeConfirmations(assumptions, [answer()], 1)).toHaveLength(1);
  });

  it("ignores an answer given against a previous revision", () => {
    // This is the whole invalidation mechanism: Revise bumps the revision, so a
    // previously-given agreement simply stops being one of this proposal's answers.
    expect(outstandingAssumptions(assumptions, [answer()], 2)).toHaveLength(1);
  });

  it("ignores an answer whose targets were edited under it", () => {
    const tampered = answer({ toDate: "11" });
    expect(outstandingAssumptions(assumptions, [tampered], 1)).toHaveLength(1);
  });

  it("ignores an answer to a question this proposal no longer asks", () => {
    const orphan = answer({ assumptionId: "leave_moved:something-else" });
    expect(outstandingAssumptions(assumptions, [orphan], 1)).toHaveLength(1);
  });

  it("digests order-independently, and changes when an answer is withdrawn", () => {
    const a = answer();
    const b = answer({ assumptionId: "z-second", date: "03" });
    expect(confirmationsDigest([a, b])).toBe(confirmationsDigest([b, a]));
    expect(confirmationsDigest([a])).not.toBe(confirmationsDigest([a, b]));
    expect(confirmationsDigest([])).not.toBe(confirmationsDigest([a]));
  });
});

describe("leave and request arms", () => {
  function assumptionsIn(commands: Parameters<typeof applyAssistantCommands>[1]) {
    const before = octoberWard();
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture refused: ${applied.rejection.message}`);
    return deriveAssumptions(before, applied.next, commands);
  }

  it("asks whether the person agreed when a change clears their leave", () => {
    const assumptions = assumptionsIn([
      { type: "clear_requests", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
      {
        type: "set_shift_request",
        personId: "Ana",
        shiftType: "N",
        startDate: "2026-10-14",
        endDate: "2026-10-14",
        weight: "must",
      },
    ]);
    expect(assumptions).toHaveLength(1);
    expect(assumptions[0]).toMatchObject({
      type: "leave_cancelled",
      person: "Ana",
      date: "14",
      toDate: null,
      question: "Has Ana agreed to give up their leave on 14 Oct?",
    });
  });

  it("asks when a day-off request replaces leave", () => {
    const assumptions = assumptionsIn([
      {
        type: "set_off_request",
        personId: "Ana",
        startDate: "2026-10-14",
        endDate: "2026-10-14",
        weight: 0,
      },
    ]);
    expect(assumptions.map((a) => [a.type, a.person, a.date])).toEqual([
      ["leave_cancelled", "Ana", "14"],
    ]);
  });

  it("asks nothing when leave is only recorded or requests change", () => {
    expect(
      assumptionsIn([
        { type: "add_leave", personId: "Ana", startDate: "2026-10-10", endDate: "2026-10-16" },
        {
          type: "set_shift_request",
          personId: "Ben",
          shiftType: "N",
          startDate: "2026-10-19",
          endDate: "2026-10-25",
          weight: -5,
        },
        { type: "clear_requests", personId: "Ben", startDate: "2026-10-21", endDate: "2026-10-22" },
      ]),
    ).toEqual([]);
  });
});

describe("deriveAssumptions and the Staff-screen arms", () => {
  function peopleAssumptions(commands: Parameters<typeof applyAssistantCommands>[1]) {
    const before = peopleScenario();
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture refused: ${applied.rejection.message}`);
    return deriveAssumptions(before, applied.next, commands);
  }

  it("a rename relabels leave; it does not ask about giving it up", () => {
    expect(
      peopleAssumptions([
        { type: "edit_person", personId: "ana", name: "Ana Lim", groups: ["RN"], temporary: false },
      ]),
    ).toEqual([]);
  });

  it("a rename chain inside one batch still asks nothing", () => {
    expect(
      peopleAssumptions([
        { type: "edit_person", personId: "ana", name: "Ana Lim", groups: ["RN"], temporary: false },
        {
          type: "edit_person",
          personId: "Ana Lim",
          name: "Ana L.",
          groups: ["RN"],
          temporary: false,
        },
      ]),
    ).toEqual([]);
  });

  it("removing a person asks about each run of their leave", () => {
    const assumptions = peopleAssumptions([{ type: "remove_person", personId: "ana" }]);
    expect(assumptions.map((a) => [a.type, a.person, a.date])).toEqual([
      ["leave_cancelled", "ana", "02"],
    ]);
  });

  it("marking a person off over their leave asks about it", () => {
    const assumptions = peopleAssumptions([
      {
        type: "set_off_request",
        personId: "ana",
        startDate: "2026-10-02",
        endDate: "2026-10-02",
        weight: "must",
      },
    ]);
    expect(assumptions.map((a) => [a.type, a.person, a.date])).toEqual([
      ["leave_cancelled", "ana", "02"],
    ]);
  });
});

describe("real-world agreements beyond leave", () => {
  it("asks whether a bounded loan of a borrowed nurse is arranged", () => {
    const before = SCENARIOS.onlyRnOnLeave();
    const commands: Parameters<typeof applyAssistantCommands>[1] = [
      { type: "add_person", name: "Float RN (Ward 5)", groups: ["RN"], temporary: false },
      {
        type: "set_off_request",
        personId: "Float RN (Ward 5)",
        startDate: "2026-11-01",
        endDate: "2026-11-02",
        weight: "must",
      },
      {
        type: "set_off_request",
        personId: "Float RN (Ward 5)",
        startDate: "2026-11-04",
        endDate: "2026-11-07",
        weight: "must",
      },
    ];
    const result = applyAssistantCommands(before, commands);
    if (!result.ok) throw new Error(result.rejection.message);
    const [assumption] = deriveAssumptions(before, result.next, commands);
    expect(assumption).toMatchObject({
      type: "borrowed_staff_arranged",
      person: "Float RN (Ward 5)",
      date: "2026-11-03",
      toDate: "2026-11-03",
    });
    expect(assumption.question).toMatch(/lending ward or agency/);
    expect(assumption.question).toMatch(/RN/);
  });

  it("does not ask about an ordinary new staff member", () => {
    const before = SCENARIOS.onlyRnOnLeave();
    const commands: Parameters<typeof applyAssistantCommands>[1] = [
      { type: "add_person", name: "Dana", groups: [], temporary: false },
    ];
    const result = applyAssistantCommands(before, commands);
    if (!result.ok) throw new Error(result.rejection.message);
    expect(deriveAssumptions(before, result.next, commands)).toEqual([]);
  });

  it("asks one nurse to agree before her own limit goes up, but not a team limit", () => {
    const base = SCENARIOS.ruleTooStrict();
    const solo = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        counts: [{ ...base.cardsByKind.counts[0], uid: "ana-nights", person: ["ana"] }],
      },
    };
    const edit = (ruleId: string, people: string[]) => ({
      type: "edit_count_rule" as const,
      ruleId,
      description: "At most 1 nights",
      people,
      shiftTypes: ["N"],
      dates: ["ALL"],
      expression: "x <= T" as const,
      target: 2,
      weight: "infinity",
    });
    const soloCmd = [edit("ana-nights", ["ana"])];
    const soloAfter = applyAssistantCommands(solo, soloCmd);
    if (!soloAfter.ok) throw new Error(soloAfter.rejection.message);
    expect(deriveAssumptions(solo, soloAfter.next, soloCmd)).toEqual([
      expect.objectContaining({ type: "extra_shifts_agreed", person: "ana", toDate: "2" }),
    ]);

    const teamCmd = [edit("max-nights", ["Nurses"])];
    const teamAfter = applyAssistantCommands(base, teamCmd);
    if (!teamAfter.ok) throw new Error(teamAfter.rejection.message);
    expect(deriveAssumptions(base, teamAfter.next, teamCmd)).toEqual([]);
  });
});

describe("calendarSpan", () => {
  it.each([
    ["2026-10-14", "2026-10-14", "14 Oct"],
    ["2026-10-10", "2026-10-16", "10–16 Oct"],
    ["2026-10-30", "2026-11-01", "30 Oct – 1 Nov"],
    ["2026-12-30", "2027-01-02", "30 Dec 2026 – 2 Jan 2027"],
    ["2026-09-01", "2026-09-02", "1–2 Sep"],
  ])("%s to %s reads %s", (from, to, label) => {
    expect(calendarSpan(from, to)).toBe(label);
  });
});

describe("cancelled leave is asked about once per unbroken run", () => {
  /** octoberWard with Ana's leave replaced by exactly these October days. */
  function anaOnLeave(days: string[]) {
    const base = octoberWard();
    return {
      ...base,
      reqData: [
        ...base.reqData.filter((cell) => cell.kind !== "leave"),
        ...days.map((d) => ({
          uid: `ana-leave-${d}`,
          person: "Ana",
          date: d,
          kind: "leave" as const,
        })),
      ],
    };
  }
  function derive(
    before: ReturnType<typeof octoberWard>,
    commands: Parameters<typeof applyAssistantCommands>[1],
  ) {
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(applied.rejection.message);
    return deriveAssumptions(before, applied.next, commands);
  }
  const clearWeek = [
    {
      type: "clear_requests" as const,
      personId: "Ana",
      startDate: "2026-10-10",
      endDate: "2026-10-16",
    },
  ];

  it("asks once about a cleared week, in calendar dates", () => {
    const assumptions = derive(anaOnLeave(["10", "11", "12", "13", "14", "15", "16"]), clearWeek);
    expect(assumptions).toEqual([
      expect.objectContaining({
        type: "leave_cancelled",
        person: "Ana",
        date: "10",
        toDate: "16",
        question: "Has Ana agreed to give up their leave on 10–16 Oct?",
      }),
    ]);
  });

  it("asks separately about two runs a free day splits", () => {
    const assumptions = derive(anaOnLeave(["10", "11", "13", "14"]), clearWeek);
    expect(assumptions.map((a) => a.question).sort()).toEqual(
      [
        "Has Ana agreed to give up their leave on 10–11 Oct?",
        "Has Ana agreed to give up their leave on 13–14 Oct?",
      ].sort(),
    );
  });

  it("spans a month boundary", () => {
    const before = {
      ...octoberWard(),
      rangeEnd: "2026-11-30",
      reqData: ["10-30", "10-31", "11-01"].map((d) => ({
        uid: `ana-leave-${d}`,
        person: "Ana",
        date: d,
        kind: "leave" as const,
      })),
    };
    const assumptions = derive(before, [{ type: "remove_person", personId: "Ana" }]);
    expect(assumptions.map((a) => [a.date, a.toDate, a.question])).toEqual([
      ["10-30", "11-01", "Has Ana agreed to give up their leave on 30 Oct – 1 Nov?"],
    ]);
  });

  it("keeps a one-day question's identity, so stored answers still match", () => {
    const [only] = derive(octoberWard(), [
      { type: "clear_requests", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
    ]);
    expect(only.assumptionId).toBe(
      `leave_cancelled:${proposalDigest({ person: "Ana", date: "14", toDate: null })}`,
    );
  });

  it("keeps Apply blocked until every run is answered", () => {
    const assumptions = derive(anaOnLeave(["10", "11", "13", "14"]), clearWeek);
    const [first] = assumptions;
    const answer: OperationalConfirmationV1 = {
      assumptionId: first.assumptionId,
      type: first.type,
      person: first.person,
      date: first.date,
      toDate: first.toDate,
      proposalRevision: 1,
      confirmedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(outstandingAssumptions(assumptions, [answer], 1)).toHaveLength(1);
  });
});
