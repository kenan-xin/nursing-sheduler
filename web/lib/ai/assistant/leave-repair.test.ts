// Leave repairs (bead nursing-sheduler-msnp): move a nurse's leave day to a nearby date
// the roster can spare, else give up one leave day at a time, each with her agreement.

import { describe, expect, it } from "vitest";
import { generateDateItems } from "@/lib/dates/date-id";
import type { ResolvedCoreMember } from "@/lib/optimize/explanation";
import { deriveAssumptions } from "@/lib/proposal/assumptions";
import { applyAssistantCommands } from "@/lib/proposal/operations";
import { findStaffingShortfalls } from "@/lib/rules/shortfalls";
import { cards, leave, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState, SuccessionCard, UiRequestCell } from "@/lib/scenario";
import { REPAIR_ORDER } from "./playbook";
import {
  buildFeasibilityReport,
  isSafeOption,
  rankRepairOptions,
  type RepairOption,
} from "./repair-options";

const BUSY = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
const QUIET = ["2026-11-06", "2026-11-07"];

/** 3 nurses; 1 day + 2 nights on the 1st-5th need all three, the weekend needs only 2. */
const busyWeek = (reqData: UiRequestCell[]): ScenarioUiState =>
  ward({
    staff: people("ana", "ben", "cara"),
    reqData,
    cardsByKind: cards({
      requirements: [
        requirement("day", "D", 1),
        requirement("nights-busy", "N", 2, { date: BUSY }),
        requirement("nights-quiet", "N", 1, { date: QUIET }),
      ],
    }),
  });

/**
 * Nights need 2 of the named RNs on the 1st-4th and 1 from the 5th: no group, so no
 * borrow, and no head count, so no run-one-short. Only the leave repairs are left.
 */
const rnWeek = (reqData: UiRequestCell[]): ScenarioUiState =>
  ward({
    staff: people("rn1", "rn2", "en1"),
    reqData,
    cardsByKind: cards({
      requirements: [
        requirement("day", "D", 1),
        requirement("nights-rn", "N", 2, {
          qualifiedPeople: ["rn1", "rn2"],
          date: ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"],
        }),
        requirement("nights-rn-late", "N", 1, {
          qualifiedPeople: ["rn1", "rn2"],
          date: ["2026-11-05", "2026-11-06", "2026-11-07"],
        }),
      ],
    }),
  });

const rank = (state: ScenarioUiState, core: ResolvedCoreMember[] | null = null) =>
  rankRepairOptions(state, findStaffingShortfalls(state), {
    runInfeasible: true,
    core,
  });
const pick = (options: RepairOption[], id: RepairOption["repairId"]) =>
  options.find((o) => o.repairId === id);
const label = (id: string) =>
  generateDateItems({ start: "2026-11-01", end: "2026-11-07" }).find((i) => i.id === id)!
    .description;

function applied(state: ScenarioUiState, option: RepairOption): ScenarioUiState {
  const result = applyAssistantCommands(state, option.operations);
  if (!result.ok) throw new Error(result.rejection.message);
  return result.next;
}

describe("move a nurse's leave to a date the roster can spare", () => {
  it("moves cara's leave off the short 5th to the quiet 6th, after the borrow and run-one-short", () => {
    const state = busyWeek([leave("cara", "05")]);
    const options = rank(state);
    expect(options.map((o) => o.repairId)).toEqual([
      "borrow_temporary_nurse",
      "run_one_short",
      "move_leave",
    ]);
    const move = pick(options, "move_leave")!;
    expect(move.operations).toEqual([
      { type: "move_leave", personId: "cara", fromDate: "05", toDate: "06" },
    ]);
    expect(move).toMatchObject({
      confirmation: "named_nurse",
      enforcedBy: "host_question",
      evidence: "static_check",
      capabilityId: "leave-and-requests",
    });
    expect(isSafeOption(state, move)).toBe(true);
    // The host's own operation closes the gap, and the 6th stays fully staffed.
    const after = applied(state, move);
    expect(findStaffingShortfalls(after)).toEqual([]);
  });

  it("names the nurse and both dates in the option and on the Preview's host question", () => {
    const state = busyWeek([leave("cara", "05")]);
    const move = pick(rank(state), "move_leave")!;
    for (const text of [move.title, move.confirmationQuestion]) {
      expect(text).toContain("cara");
      expect(text).toContain(label("05"));
      expect(text).toContain(label("06"));
    }
    expect(move.confirmationQuestion).toBe(
      `Has cara agreed to move their leave from ${label("05")} to ${label("06")}?`,
    );
    expect(move.needsFromUser.join(" ")).toMatch(/sick or compassionate/);
    const [question] = deriveAssumptions(state, applied(state, move), move.operations);
    expect(question).toMatchObject({
      type: "leave_moved",
      person: "cara",
      date: "05",
      toDate: "06",
    });
    expect(question.question).toBe("Has cara agreed to move their leave from 5 Nov to 6 Nov?");
  });

  it("never moves leave onto a date that would then be short", () => {
    // Every day needs all three nurses: no date can spare her.
    const state = ward({
      ...busyWeek([leave("cara", "05")]),
      cardsByKind: cards({
        requirements: [requirement("day", "D", 1), requirement("night", "N", 2)],
      }),
    });
    expect(rank(state).map((o) => o.repairId)).not.toContain("move_leave");
  });

  it("moves each short day of a leave block to the nearest date that can spare her", () => {
    const state = busyWeek([leave("cara", "04"), leave("cara", "05")]);
    const move = pick(rank(state), "move_leave")!;
    expect(move.operations).toEqual([
      { type: "move_leave", personId: "cara", fromDate: "04", toDate: "06" },
      { type: "move_leave", personId: "cara", fromDate: "05", toDate: "07" },
    ]);
    expect(findStaffingShortfalls(applied(state, move))).toEqual([]);
    const questions = deriveAssumptions(state, applied(state, move), move.operations);
    expect(questions.map((q) => q.type)).toEqual(["leave_moved", "leave_moved"]);
  });

  it("will not free her for a day her hard rest rules forbid", () => {
    // cara must work the night of the 4th; no day and no second night after a night.
    const mustNight: UiRequestCell = {
      uid: "cara-n-04",
      person: "cara",
      date: "04",
      kind: "request",
      shiftType: "N",
      weight: Infinity,
    };
    const rest = (uid: string, pattern: string[]): SuccessionCard => ({
      uid,
      description: uid,
      person: ["ALL"],
      pattern,
      weight: -Infinity,
    });
    const base = busyWeek([leave("cara", "05"), mustNight]);
    const blocked: ScenarioUiState = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        successions: [rest("no-day-after-night", ["N", "D"]), rest("no-two-nights", ["N", "N"])],
      },
    };
    const ids = rank(blocked).map((o) => o.repairId);
    expect(ids).not.toContain("move_leave");
    expect(ids).not.toContain("ask_nurse_on_leave");
    // With only "no day after a night" she can still take the night: the move stands.
    const nightOk: ScenarioUiState = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        successions: [rest("no-day-after-night", ["N", "D"])],
      },
    };
    expect(rank(nightOk).map((o) => o.repairId)).toContain("move_leave");
  });
});

describe("ranking: rule changes, extra staff and run-one-short, then move leave, then cancel", () => {
  it("orders the playbook so moving leave comes before giving it up, both after running short", () => {
    for (const situation of ["acute", "chronic"] as const) {
      const order = REPAIR_ORDER[situation];
      const at = (id: RepairOption["repairId"]) => order.indexOf(id);
      expect(at("borrow_temporary_nurse")).toBeLessThan(at("move_leave"));
      expect(at("run_one_short")).toBeLessThan(at("move_leave"));
      expect(at("move_leave")).toBeLessThan(at("ask_nurse_on_leave"));
    }
    expect(REPAIR_ORDER.capped).not.toContain("move_leave");
  });

  it("offers the move first and the cancel last when nothing else fits", () => {
    const state = rnWeek([leave("rn1", "03")]);
    const options = rank(state);
    expect(options.map((o) => o.repairId)).toEqual(["move_leave", "ask_nurse_on_leave"]);
    expect(options[0].operations).toEqual([
      { type: "move_leave", personId: "rn1", fromDate: "03", toDate: "05" },
    ]);
    expect(options[0].why).toMatch(/is qualified and is on leave/);
    for (const option of options) {
      expect(isSafeOption(state, option)).toBe(true);
      expect(findStaffingShortfalls(applied(state, option))).toEqual([]);
    }
  });
});

describe("give up leave, one day at a time", () => {
  it("cancels one day per short day, each its own operation and question", () => {
    // Two RNs off on two different days: two days short, two separate agreements.
    const state = rnWeek([leave("rn1", "02"), leave("rn2", "04")]);
    const cancel = pick(rank(state), "ask_nurse_on_leave")!;
    expect(cancel.operations).toEqual([
      {
        type: "clear_requests",
        personId: "rn1",
        startDate: "2026-11-02",
        endDate: "2026-11-02",
      },
      {
        type: "clear_requests",
        personId: "rn2",
        startDate: "2026-11-04",
        endDate: "2026-11-04",
      },
    ]);
    expect(cancel.title).toBe(
      `Ask nurses on leave to give up one leave day each: rn1 on ${label("02")} and rn2 on ${label("04")}`,
    );
    expect(isSafeOption(state, cancel)).toBe(true);
    const after = applied(state, cancel);
    expect(findStaffingShortfalls(after)).toEqual([]);
    const questions = deriveAssumptions(state, after, cancel.operations);
    expect(questions.map((q) => [q.type, q.person, q.date])).toEqual(
      expect.arrayContaining([
        ["leave_cancelled", "rn1", "02"],
        ["leave_cancelled", "rn2", "04"],
      ]),
    );
    expect(questions).toHaveLength(2);
  });

  it("asks two nurses on one day when that day is two short", () => {
    const state = rnWeek([leave("rn1", "02"), leave("rn2", "02")]);
    const cancel = pick(rank(state), "ask_nurse_on_leave")!;
    expect(cancel.operations.map((op) => op.type === "clear_requests" && op.personId)).toEqual([
      "rn1",
      "rn2",
    ]);
  });

  it("names a day no leave can close as staying short", () => {
    // The 2nd is short by 1 with rn1 on sick leave; the 4th by 1 with rn2 on annual leave.
    const sick = { ...leave("rn1", "02"), description: "Sick leave" };
    const state = rnWeek([sick, leave("rn2", "04")]);
    const cancel = pick(rank(state), "ask_nurse_on_leave")!;
    expect(cancel.operations).toEqual([
      {
        type: "clear_requests",
        personId: "rn2",
        startDate: "2026-11-04",
        endDate: "2026-11-04",
      },
    ]);
    expect(cancel.why).toContain(`${label("02")} stays short`);
  });

  it("refuses a multi-day clear even when the nurse is asked", () => {
    const state = rnWeek([leave("rn1", "02"), leave("rn1", "03")]);
    const block: RepairOption = {
      ...pick(rank(state), "ask_nurse_on_leave")!,
      operations: [
        {
          type: "clear_requests",
          personId: "rn1",
          startDate: "2026-11-02",
          endDate: "2026-11-03",
        },
      ],
    };
    expect(isSafeOption(state, block)).toBe(false);
  });
});

describe("never sick or compassionate leave", () => {
  for (const description of ["Sick leave", "MC", "Compassionate leave", "Bereavement"]) {
    it(`offers no leave repair for "${description}"`, () => {
      const state = busyWeek([{ ...leave("cara", "05"), description }]);
      const ids = rank(state).map((o) => o.repairId);
      expect(ids).not.toContain("move_leave");
      expect(ids).not.toContain("ask_nurse_on_leave");
      const rnState = rnWeek([{ ...leave("rn1", "03"), description }]);
      expect(rank(rnState)).toEqual([]);
    });
  }

  it("refuses a hand-built option that moves or clears sick leave", () => {
    const state = rnWeek([{ ...leave("rn1", "03"), description: "Sick leave" }]);
    const asked = {
      confirmation: "named_nurse" as const,
      enforcedBy: "host_question" as const,
      title: "t",
      why: "w",
      confirmationQuestion: "q",
      needsFromUser: [],
      capabilityId: null,
      evidence: "static_check" as const,
    };
    expect(
      isSafeOption(state, {
        ...asked,
        repairId: "move_leave",
        operations: [{ type: "move_leave", personId: "rn1", fromDate: "03", toDate: "05" }],
      }),
    ).toBe(false);
    expect(
      isSafeOption(state, {
        ...asked,
        repairId: "ask_nurse_on_leave",
        operations: [
          {
            type: "clear_requests",
            personId: "rn1",
            startDate: "2026-11-03",
            endDate: "2026-11-03",
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("after a failed run with no static cause, the solver's core names the leave", () => {
  // No date is short to the static check; the core is what the backend proved.
  const state = () => busyWeek([leave("cara", "06")]);
  const core: ResolvedCoreMember[] = [
    {
      kind: "leave",
      ruleId: "leave-cara-06",
      label: "cara LEAVE on 06",
      nurse: "cara",
      date: "2026-11-06",
      shift: ["LEAVE"],
    },
    {
      kind: "staffing",
      ruleId: "nights-quiet",
      label: "nights-quiet",
      date: "2026-11-06",
      shift: ["N"],
      need: 1,
      max: 1,
    },
    { kind: "succession", ruleId: "rest", label: "No day after a night" },
  ];

  it("offers no leave repair without a core: the app never guesses at leave", () => {
    expect(findStaffingShortfalls(state())).toEqual([]);
    expect(rank(state()).map((o) => o.repairId)).not.toContain("move_leave");
    expect(rank(state()).map((o) => o.repairId)).not.toContain("ask_nurse_on_leave");
  });

  it("moves or cancels exactly the core's leave day, as a hypothesis to test", () => {
    const options = rank(state(), core);
    expect(options.map((o) => o.repairId)).toEqual(["move_leave", "ask_nurse_on_leave"]);
    const [move, cancel] = options;
    // The 5th and the 7th: the 7th keeps every date fully staffed; the 5th would be short.
    expect(move.operations).toEqual([
      { type: "move_leave", personId: "cara", fromDate: "06", toDate: "07" },
    ]);
    expect(cancel.operations).toEqual([
      {
        type: "clear_requests",
        personId: "cara",
        startDate: "2026-11-06",
        endDate: "2026-11-06",
      },
    ]);
    for (const option of options) {
      expect(option.evidence).toBe("hypothesis");
      expect(option.why).toMatch(/optimiser proved that cara's leave/);
      expect(isSafeOption(state(), option)).toBe(true);
    }
  });

  it("drops rule changes for rules the core does not name, keeping the approved order", () => {
    // A hard rest rule and a hard request the clash does not involve: relaxing either
    // cannot resolve it, so only the core's own members and the leave repairs remain.
    const base = state();
    const ward2: ScenarioUiState = {
      ...base,
      reqData: [
        ...base.reqData,
        {
          uid: "ben-never-n",
          person: "ben",
          date: "03",
          kind: "request",
          shiftType: "N",
          weight: -Infinity,
        },
      ],
      cardsByKind: {
        ...base.cardsByKind,
        successions: [
          {
            uid: "rest-nd",
            description: "No day after a night",
            person: ["ALL"],
            pattern: ["N", "D"],
            weight: -Infinity,
          },
        ],
      },
    };
    const ids = (c: ResolvedCoreMember[] | null) => rank(ward2, c).map((o) => o.repairId);
    expect(ids(null)).toEqual(["soften_hard_request", "soften_rest_rule"]);
    const leaveOnly = core.filter((m) => m.kind === "leave");
    expect(ids(leaveOnly)).toEqual(["move_leave", "ask_nurse_on_leave"]);
    // Once the core names them, each rule change is back, in the playbook's order.
    const named: ResolvedCoreMember[] = [
      ...leaveOnly,
      { kind: "succession", ruleId: "rest-nd", label: "No day after a night", nurse: "ana" },
      {
        kind: "request",
        ruleId: "ben-never-n",
        label: "ben N",
        nurse: "ben",
        date: "2026-11-03",
        shift: ["N"],
        must: false,
      },
    ];
    expect(ids(named)).toEqual(["soften_hard_request", "soften_rest_rule", "move_leave"]);
  });

  it("reaches the report only after an infeasible run", () => {
    const ids = (after: boolean) =>
      buildFeasibilityReport(state(), after, core).options.map((o) => o.repairId);
    expect(ids(true)).toContain("move_leave");
    expect(ids(false)).toEqual([]);
  });
});
