import { describe, expect, it } from "vitest";
import { applyAssistantCommand } from "./operations";
import { deriveNewPeriod, historyDaysFor, type PastRoster } from "./new-period";
import { proposalScenario } from "./test-support";
import type { RosterDayState } from "@/lib/roster/types";
import type { ScenarioUiState } from "@/lib/scenario";

const MAY = { start: "2026-05-01", end: "2026-05-31" };
const off: RosterDayState = { kind: "off" };
const leave: RosterDayState = { kind: "leave" };
const shift = (shiftId: string): RosterDayState => ({ kind: "shift", shiftId });

/** April's roster: ana works Day then two Nights at the end; bo is off, then on leave. */
function aprilRoster(lastDay = "2026-04-30"): PastRoster {
  const calendar = Array.from({ length: 30 }, (_, i) => ({
    iso: `2026-04-${String(i + 1).padStart(2, "0")}`,
    weekday: "Mon",
    weekend: false,
    holiday: false,
  }));
  calendar[29] = { ...calendar[29]!, iso: lastDay };
  const ana = Array.from({ length: 30 }, (_, i) => (i >= 28 ? shift("Night") : shift("Day")));
  const bo = Array.from({ length: 30 }, (_, i) => (i === 29 ? leave : off));
  return {
    context: {
      people: [{ id: "ana" }, { id: "bo" }, { id: "gone" }],
      shiftTypes: [{ id: "Day" }, { id: "Night" }],
      calendar,
      baselineMinimums: [],
      leaveCreditMinutes: null,
    },
    solvedDays: [ana, bo, ana],
    // A hand edit after the solve: ana's 27 April became a day off.
    edits: [{ personIdx: 0, dateIdx: 26, day: off }],
  };
}

function april(): ScenarioUiState {
  return {
    ...proposalScenario(),
    staff: [
      { _k: "p1", id: "ana", history: ["Day"] },
      { _k: "p2", id: "bo" },
      { _k: "p3", id: "new" },
    ],
    temporaryCover: [{ name: "Haseena", date: "2026-04-08", shiftType: "Day", groups: [] }],
  } as ScenarioUiState;
}

function planOf(result: ReturnType<typeof deriveNewPeriod>) {
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

describe("a new period from a past schedule", () => {
  it("copies the ward and its rules, moves the dates with holidays, and leaves the month's requests behind", () => {
    const past = april();
    const plan = planOf(deriveNewPeriod(past, null, MAY));
    const next = plan.scenario;

    expect(next).toMatchObject({ rangeStart: MAY.start, rangeEnd: MAY.end });
    expect(next.shifts).toEqual(past.shifts);
    expect(next.staffGroups).toEqual(past.staffGroups);
    expect(next.cardsByKind).toEqual(past.cardsByKind);
    expect(next.meta).toEqual(past.meta);
    expect(next.exportLayout).toEqual(past.exportLayout);
    expect(next.staff.map((person) => person.id)).toEqual(["ana", "bo", "new"]);
    expect(next.reqData).toEqual([]);
    expect(next.temporaryCover).toEqual([]);
    expect(plan.notCarried).toEqual({ requests: 2, leave: 1, covers: 1 });
    // April's own history describes March: never reused.
    expect(next.staff[0]!.history).toBeUndefined();
    // Singapore holidays for May: Labour Day (1 May) is in the PH group.
    expect(next.importPublicHolidays).toBe(true);
    expect(next.dateGroups.find((group) => group.id === "PH")?.members).toContain("01");
  });

  it("moves the dates through the same set_roster_range arm as an ordinary range change", () => {
    const past = april();
    const base = {
      ...past,
      staff: past.staff.map(({ history: _h, ...person }) => person),
      reqData: [],
      temporaryCover: [],
    };
    const direct = applyAssistantCommand(base, {
      type: "set_roster_range",
      start: MAY.start,
      end: MAY.end,
      importPublicHolidays: true,
    });
    if (!direct.ok) throw new Error("range refused");
    expect(planOf(deriveNewPeriod(past, null, MAY)).scenario).toEqual(direct.next);
  });

  it("lists what the move dropped", () => {
    const plan = planOf(deriveNewPeriod(april(), null, MAY));
    // Only the drop: not the period itself, nor the holiday groups rebuilt for May.
    expect(plan.dropped.map((entry) => entry.label)).toEqual(["Date group “Handover days”"]);
  });

  it("carries the roster's last 7 days, with hand edits, when the new period follows straight on", () => {
    const plan = planOf(deriveNewPeriod(april(), aprilRoster(), MAY));
    expect(plan.history).toEqual({
      status: "carried",
      days: 7,
      people: 2,
      rosterEnd: "2026-04-30",
    });
    const [ana, bo, newcomer] = plan.scenario.staff;
    expect(ana!.history).toEqual(["Day", "Day", "Day", "OFF", "Day", "Night", "Night"]);
    expect(bo!.history).toEqual(["OFF", "OFF", "OFF", "OFF", "OFF", "OFF", "LEAVE"]);
    // Not on April's roster: no history.
    expect(newcomer!.history).toBeUndefined();
  });

  it("takes the longest rule look-back when it is above 7 days", () => {
    const past = april();
    past.cardsByKind.successions = [
      { uid: "s", person: "ALL", pattern: Array(9).fill("Day"), weight: -1 },
    ];
    expect(historyDaysFor(past)).toBe(9);
    const plan = planOf(deriveNewPeriod(past, aprilRoster(), MAY));
    expect(plan.history.days).toBe(9);
    expect(plan.scenario.staff[0]!.history).toHaveLength(9);
  });

  it("cuts history at a shift type the schedule no longer has", () => {
    const past = april();
    past.shifts = past.shifts.filter((s) => s.id !== "Night");
    const plan = planOf(deriveNewPeriod(past, aprilRoster(), MAY));
    expect(plan.scenario.staff[0]!.history).toBeUndefined();
    expect(plan.scenario.staff[1]!.history).toHaveLength(7);
  });

  it("carries no history across a gap, or with no roster, and says why", () => {
    const gap = planOf(
      deriveNewPeriod(april(), aprilRoster(), { start: "2026-06-01", end: "2026-06-30" }),
    );
    expect(gap.history).toMatchObject({ status: "gap", people: 0, rosterEnd: "2026-04-30" });
    expect(gap.scenario.staff.every((person) => person.history === undefined)).toBe(true);

    const none = planOf(deriveNewPeriod(april(), null, MAY));
    expect(none.history).toMatchObject({ status: "no-roster", people: 0, rosterEnd: null });
  });

  it("refuses dates the range arm refuses, in its own words", () => {
    expect(deriveNewPeriod(april(), null, { start: "2026-05-31", end: "2026-05-01" })).toEqual({
      ok: false,
      message: "The end date must be on or after the start date.",
    });
  });

  it("has a digest that follows the result, so Apply can tell a changed source", () => {
    const a = planOf(deriveNewPeriod(april(), aprilRoster(), MAY));
    expect(planOf(deriveNewPeriod(april(), aprilRoster(), MAY)).digest).toBe(a.digest);
    const edited = { ...aprilRoster(), edits: [] };
    expect(planOf(deriveNewPeriod(april(), edited, MAY)).digest).not.toBe(a.digest);
  });
});
