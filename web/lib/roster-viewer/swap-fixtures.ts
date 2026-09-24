// The Priya fixture (bead nursing-sheduler-73z): the live case, small enough to reason
// about by hand. Test-only; not exported from the barrel.
//
//            7 Oct  8 Oct  9 Oct  10 Oct  11 Oct
// SN-Priya   AM     N      N      OFF     OFF
// SN-Ana     N      OFF    OFF    AM      OFF   → takes N on 9, AM on 10: N then AM
// SN-Ben     OFF    OFF    OFF    N       N     → takes both: 4 nights, cap is 3
// SN-Cara    OFF    OFF    OFF    OFF     OFF   → cover: valid, 2 worked days after
// SSN-Dev    PM     PM     PM     PM      PM    → not in Nights: cannot work N
// SN-Eve     OFF    PM     PM     OFF     PM    → exchange: valid, 3 worked days after

import { PREFERENCE_TYPE, type CanonicalScenarioDocument } from "@/lib/scenario";
import type { RosterContext, RosterDayState, RosterDocument } from "@/lib/roster/types";
import { fixtureSubmission } from "@/lib/roster/test-fixtures";

export const PRIYA_DATES = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
export const PRIYA_PEOPLE = ["SN-Priya", "SN-Ana", "SN-Ben", "SN-Cara", "SSN-Dev", "SN-Eve"];

const AM: RosterDayState = { kind: "shift", shiftId: "AM" };
const PM: RosterDayState = { kind: "shift", shiftId: "PM" };
const N: RosterDayState = { kind: "shift", shiftId: "N" };
const OFF: RosterDayState = { kind: "off" };

export function priyaDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: PRIYA_DATES[0], endDate: PRIYA_DATES[4] } },
    people: {
      items: PRIYA_PEOPLE.map((id) => ({ id })),
      groups: [{ id: "Nights", members: PRIYA_PEOPLE.filter((id) => id.startsWith("SN-")) }],
    },
    shiftTypes: {
      items: [
        { id: "AM", startTime: "07:00", endTime: "15:00", durationMinutes: 480 },
        { id: "PM", startTime: "13:00", endTime: "21:00", durationMinutes: 480 },
        { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
      ],
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      {
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        description: "One night nurse",
        shiftType: "N",
        requiredNumPeople: 1,
        qualifiedPeople: "Nights",
        weight: -1,
      },
      {
        type: PREFERENCE_TYPE.shiftTypeSuccessions,
        description: "No morning after night",
        person: "ALL",
        pattern: ["N", "AM"],
        weight: -Infinity,
      },
      {
        type: PREFERENCE_TYPE.shiftCount,
        description: "Max 3 nights",
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: "N",
        expression: "x <= T",
        target: 3,
        weight: Infinity,
      },
    ],
  };
}

/** Rows follow PRIYA_PEOPLE; columns follow PRIYA_DATES. */
export function priyaGrid(): RosterDayState[][] {
  return [
    [AM, N, N, OFF, OFF],
    [N, OFF, OFF, AM, OFF],
    [OFF, OFF, OFF, N, N],
    [OFF, OFF, OFF, OFF, OFF],
    [PM, PM, PM, PM, PM],
    [OFF, PM, PM, OFF, PM],
  ];
}

export function priyaContext(): RosterContext {
  return {
    people: PRIYA_PEOPLE.map((id) => ({ id })),
    shiftTypes: [
      { id: "AM", description: "Morning", startTime: "07:00", endTime: "15:00" },
      { id: "PM", description: "Afternoon", startTime: "13:00", endTime: "21:00" },
      { id: "N", description: "Night", startTime: "21:00", endTime: "07:00" },
    ],
    calendar: PRIYA_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
    baselineMinimums: ["AM", "PM", "N"].map((shiftId) => ({ shiftId, unavailable: true as const })),
    leaveCreditMinutes: null,
  };
}

/**
 * A working-roster document for tool tests. Assembled by hand: the tools read only
 * `context`, `solvedDays`, `edits`, `submission` and `provenance`, and the real
 * assembly path is covered by `lib/roster`'s own suite.
 */
export function priyaRosterDocument(): RosterDocument {
  return {
    schemaVersion: "roster-file/1",
    provenance: {
      solverStatus: "OPTIMAL",
      score: 0,
      solvedBaselineId: "a".repeat(64),
      appBuild: "test",
    },
    submission: fixtureSubmission(priyaDocument(), []),
    context: priyaContext(),
    solvedDays: priyaGrid(),
    edits: [],
    coordinateMap: {
      peopleRows: [],
      dateColumns: [],
      firstPeopleRow: 1,
      leadingCols: 1,
      historyCols: 0,
      prettify: false,
    },
    frozenXlsx: new Blob([]),
  };
}
