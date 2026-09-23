// Operational assumptions and their confirmations (T07; decision R12).
//
// The three properties that matter: the host DERIVES the questions from validated
// targets (never from model text), a confirmation binds to one exact proposal
// revision, and a change that destroys someone's leave asks about it even though no
// command mentions leave at all.

import { describe, expect, it } from "vitest";
import {
  activeConfirmations,
  confirmationsDigest,
  deriveAssumptions,
  outstandingAssumptions,
  type OperationalConfirmationV1,
} from "./assumptions";
import { applyAssistantCommands } from "./operations";
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
      question: "Has Ana agreed to give up their leave on 14?",
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
        { type: "edit_person", personId: "ana", name: "Ana Lim", groups: ["RN"] },
      ]),
    ).toEqual([]);
  });

  it("a rename chain inside one batch still asks nothing", () => {
    expect(
      peopleAssumptions([
        { type: "edit_person", personId: "ana", name: "Ana Lim", groups: ["RN"] },
        { type: "edit_person", personId: "Ana Lim", name: "Ana L.", groups: ["RN"] },
      ]),
    ).toEqual([]);
  });

  it("removing a person asks about each leave day", () => {
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
