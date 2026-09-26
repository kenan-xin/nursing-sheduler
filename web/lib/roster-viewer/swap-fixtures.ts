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
    schemaVersion: "roster-file/2",
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
    borrowed: [],
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

// The borrow fixture: nobody on the ward can take Priya's night on 8 Oct.
//            7 Oct  8 Oct  9 Oct
// SN-Priya   OFF    N      OFF
// SSN-Dev    AM     AM     AM     → not in Nights: cannot move to N
export const BORROW_DATES = ["2026-10-07", "2026-10-08", "2026-10-09"];

export function borrowDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: BORROW_DATES[0], endDate: BORROW_DATES[2] } },
    people: {
      items: [{ id: "SN-Priya" }, { id: "SSN-Dev" }],
      groups: [{ id: "Nights", members: ["SN-Priya"] }],
    },
    shiftTypes: {
      items: [
        { id: "AM", startTime: "07:00", endTime: "15:00", durationMinutes: 480 },
        { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
      ],
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      {
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        description: "One night nurse",
        shiftType: "N",
        date: "2026-10-08",
        requiredNumPeople: 1,
        qualifiedPeople: "Nights",
        weight: -1,
      },
    ],
  };
}

export function borrowGrid(): RosterDayState[][] {
  return [
    [OFF, N, OFF],
    [AM, AM, AM],
  ];
}

export function borrowContext(): RosterContext {
  return {
    people: [{ id: "SN-Priya" }, { id: "SSN-Dev" }],
    shiftTypes: [
      { id: "AM", description: "Morning" },
      { id: "N", description: "Night" },
    ],
    calendar: BORROW_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
    baselineMinimums: ["AM", "N"].map((shiftId) => ({ shiftId, unavailable: true as const })),
    leaveCreditMinutes: null,
  };
}

export function borrowRosterDocument(): RosterDocument {
  return {
    ...priyaRosterDocument(),
    submission: fixtureSubmission(borrowDocument(), []),
    context: borrowContext(),
    solvedDays: borrowGrid(),
  };
}

// A borrowed nurse (roster-file/2, bead g1p) already on the roster, covering the night
// of 9 Oct. She is the only Nights nurse off on 7-8 Oct, so the ladder must count her
// row or it reports the night short and asks for a SECOND temporary nurse (bead d88).
//            7 Oct  8 Oct  9 Oct
// SN-Priya   N      N      OFF
// SSN-Dev    AM     AM     AM     → not in Nights: cannot take a night
// Mei (borrowed, Nights)  OFF  OFF  N
function borrowedCoverDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: BORROW_DATES[0], endDate: BORROW_DATES[2] } },
    people: {
      items: [{ id: "SN-Priya" }, { id: "SSN-Dev" }],
      groups: [{ id: "Nights", members: ["SN-Priya"] }],
    },
    shiftTypes: {
      items: [
        { id: "AM", startTime: "07:00", endTime: "15:00", durationMinutes: 480 },
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
    ],
  };
}

export function borrowedCoverRosterDocument(): RosterDocument {
  return {
    ...priyaRosterDocument(),
    submission: fixtureSubmission(borrowedCoverDocument(), []),
    context: borrowContext(),
    solvedDays: [
      [N, N, OFF],
      [AM, AM, AM],
    ],
    borrowed: [{ id: "Mei", groups: ["Nights"], days: [OFF, OFF, N] }],
  };
}

/**
 * The d88 borrowed-cover roster plus ONE ward-wide count rule whose person is `ALL`
 * (bead d88 review). The g1p loan narrows the ward's hard count rules away from the
 * borrowed nurse (`narrowedCounts`, `web/lib/ai/assistant/repair-options.ts`), so her
 * row must not take them up: a minimum must not report her short, and a cap must not
 * block her cover.
 */
export function borrowedWardCountRosterDocument(count: {
  description: string;
  countShiftTypes: string;
  expression: string;
  target: number;
}): RosterDocument {
  const document = borrowedCoverDocument();
  return {
    ...borrowedCoverRosterDocument(),
    // Priya works three shifts (two of them nights), so a hard minimum of two still holds
    // for her after she gives one night away: only the borrowed row is the rule's business.
    solvedDays: [
      [N, N, AM],
      [AM, AM, AM],
    ],
    submission: fixtureSubmission(
      {
        ...document,
        preferences: [
          ...document.preferences,
          {
            type: PREFERENCE_TYPE.shiftCount,
            description: count.description,
            person: "ALL",
            countDates: "ALL",
            countShiftTypes: count.countShiftTypes,
            expression: count.expression,
            target: count.target,
            weight: Infinity,
          },
        ],
      },
      [],
    ),
  };
}

// The Priya/Asha fixture (step 2): nobody can swap or cover Priya's nights on 8-9 Oct.
//            7   8   9   10  11  12  13  14 Oct
// SN-Priya   AM  N   N   OFF OFF OFF OFF OFF
// SN-Asha    OFF LV  LV  OFF AM  AM  OFF OFF  → on leave 8-9: trade, leave moves to 11-12, Priya works her AMs
// SN-Ben     N   OFF OFF AM  OFF N   N   N    → cover: N 7-9 then AM on 10 (and 6 nights)
// SN-Cy      OFF OFF OFF N   N   OFF OFF OFF  → cover: 4 nights in a row. Trade: off 10-11, Priya works his Ns
// SSN-Dev    OFF AM  AM  OFF OFF OFF AM  AM   → not in Nights
export const ASHA_DATES = [
  "2026-10-07",
  "2026-10-08",
  "2026-10-09",
  "2026-10-10",
  "2026-10-11",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
];
export const ASHA_PEOPLE = ["SN-Priya", "SN-Asha", "SN-Ben", "SN-Cy", "SSN-Dev"];
const LV: RosterDayState = { kind: "leave" };

export function ashaDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: ASHA_DATES[0], endDate: ASHA_DATES[7] } },
    people: {
      items: ASHA_PEOPLE.map((id) => ({ id })),
      groups: [{ id: "Nights", members: ASHA_PEOPLE.filter((id) => id.startsWith("SN-")) }],
    },
    shiftTypes: {
      items: [
        { id: "AM", startTime: "07:00", endTime: "15:00", durationMinutes: 480 },
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
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        description: "One morning nurse",
        shiftType: "AM",
        requiredNumPeople: 1,
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
        type: PREFERENCE_TYPE.shiftTypeSuccessions,
        description: "No four nights in a row",
        person: "ALL",
        pattern: ["N", "N", "N", "N"],
        weight: -Infinity,
      },
      {
        type: PREFERENCE_TYPE.shiftCount,
        description: "Max 4 nights",
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: "N",
        expression: "x <= T",
        target: 4,
        weight: Infinity,
      },
      {
        type: PREFERENCE_TYPE.shiftRequest,
        description: "Asha's annual leave",
        person: "SN-Asha",
        date: ["2026-10-08", "2026-10-09"],
        shiftType: "LEAVE",
        weight: 1,
      },
    ],
  };
}

export function ashaGrid(): RosterDayState[][] {
  return [
    [AM, N, N, OFF, OFF, OFF, OFF, OFF],
    [OFF, LV, LV, OFF, AM, AM, OFF, OFF],
    [N, OFF, OFF, AM, OFF, N, N, N],
    [OFF, OFF, OFF, N, N, OFF, OFF, OFF],
    [OFF, AM, AM, OFF, OFF, OFF, AM, AM],
  ];
}

export function ashaContext(): RosterContext {
  return {
    people: ASHA_PEOPLE.map((id) => ({ id })),
    shiftTypes: [
      { id: "AM", description: "Morning" },
      { id: "N", description: "Night" },
    ],
    calendar: ASHA_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
    baselineMinimums: ["AM", "N"].map((shiftId) => ({ shiftId, unavailable: true as const })),
    leaveCreditMinutes: null,
  };
}

export function ashaRosterDocument(): RosterDocument {
  return {
    ...priyaRosterDocument(),
    submission: fixtureSubmission(ashaDocument(), []),
    context: ashaContext(),
    solvedDays: ashaGrid(),
  };
}

// Overtime (step 2): like the borrow fixture, plus SN-Kai, off all period and under no count
// rule, so he has no known spare capacity. His cover is an overtime request.
export function overtimeDocument(): CanonicalScenarioDocument {
  const base = borrowDocument();
  return {
    ...base,
    people: {
      items: [...base.people.items, { id: "SN-Kai" }],
      groups: [{ id: "Nights", members: ["SN-Priya", "SN-Kai"] }],
    },
  };
}
export const overtimeGrid = (): RosterDayState[][] => [...borrowGrid(), [OFF, OFF, OFF]];
export const overtimeContext = (): RosterContext => ({
  ...borrowContext(),
  people: [{ id: "SN-Priya" }, { id: "SSN-Dev" }, { id: "SN-Kai" }],
});

// Run one short (step 4): night on 8 Oct needs 2 across N and N+, and N+ is the senior
// (NIC) slot. Dropping Priya (N) leaves 1 with the senior: allowed with sign-off.
// Dropping Lee (N+) drops the senior: never offered.
//            7 Oct  8 Oct  9 Oct
// SN-Priya   OFF    N      OFF
// SSN-Lee    OFF    N+     OFF
export function shortDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: BORROW_DATES[0], endDate: BORROW_DATES[2] } },
    people: {
      items: [{ id: "SN-Priya" }, { id: "SSN-Lee" }],
      groups: [{ id: "Seniors", members: ["SSN-Lee"] }],
    },
    shiftTypes: {
      items: [
        { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
        { id: "N+", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
      ],
      groups: [{ id: "AllNights", members: ["N", "N+"] }],
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      {
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        description: "Two night nurses",
        shiftType: "AllNights",
        date: "2026-10-08",
        requiredNumPeople: 2,
        weight: -1,
      },
      {
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        description: "Senior (NIC) on nights",
        shiftType: "N+",
        date: "2026-10-08",
        requiredNumPeople: 1,
        qualifiedPeople: "Seniors",
        weight: -1,
      },
    ],
  };
}
export const shortGrid = (): RosterDayState[][] => [
  [OFF, N, OFF],
  [OFF, { kind: "shift", shiftId: "N+" }, OFF],
];
export const shortContext = (): RosterContext => ({
  people: [{ id: "SN-Priya" }, { id: "SSN-Lee" }],
  shiftTypes: [
    { id: "N", description: "Night" },
    { id: "N+", description: "Night (senior)" },
  ],
  calendar: BORROW_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
  baselineMinimums: ["N", "N+"].map((shiftId) => ({ shiftId, unavailable: true as const })),
  leaveCreditMinutes: null,
});
// The MC fixture (bead nursing-sheduler-736): the live ward. N needs exactly 2; day shifts
// need nobody. Ben must work N every date, Chloe on 8 Oct. Ben goes on MC on 8 Oct.
//            7 Oct  8 Oct  9 Oct
// Ana        am1    am1    am1    → N on 8, then am1 on 9: her own rule forbids it
// Ben Tan    N      N      N      → MC on 8 Oct: his request cannot be honoured
// Chloe Lim  N      N      N
// Mei        am2    pm1    am2    → moves pm1 → N on 8
// Raj        pm2    L      ADM    → moves L → N on 8
export const MC_PEOPLE = ["Ana", "Ben Tan", "Chloe Lim", "Mei", "Raj"];
const MC_SHIFTS = ["am1", "am2", "am3", "pm1", "pm2", "pm3", "N", "L", "ADM"];

export function mcDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: BORROW_DATES[0], endDate: BORROW_DATES[2] } },
    people: { items: MC_PEOPLE.map((id) => ({ id })) },
    shiftTypes: {
      items: MC_SHIFTS.map((id) => ({
        id,
        startTime: "07:00",
        endTime: "15:00",
        durationMinutes: 480,
      })),
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      {
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        description: "Two night nurses",
        shiftType: "N",
        requiredNumPeople: 2,
        weight: -1,
      },
      {
        type: PREFERENCE_TYPE.shiftTypeSuccessions,
        description: "No am1 after N",
        person: "Ana",
        pattern: ["N", "am1"],
        weight: -Infinity,
      },
      {
        type: PREFERENCE_TYPE.shiftRequest,
        description: "Ben on nights",
        person: "Ben Tan",
        date: "ALL",
        shiftType: "N",
        weight: Infinity,
      },
      {
        type: PREFERENCE_TYPE.shiftRequest,
        person: "Chloe Lim",
        date: "2026-10-08",
        shiftType: "N",
        weight: Infinity,
      },
    ],
  };
}
const S = (shiftId: string): RosterDayState => ({ kind: "shift", shiftId });
export const mcGrid = (): RosterDayState[][] => [
  [S("am1"), S("am1"), S("am1")],
  [N, N, N],
  [N, N, N],
  [S("am2"), S("pm1"), S("am2")],
  [S("pm2"), S("L"), S("ADM")],
];
export const mcContext = (): RosterContext => ({
  people: MC_PEOPLE.map((id) => ({ id })),
  shiftTypes: MC_SHIFTS.map((id) => ({ id, description: id })),
  calendar: BORROW_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
  baselineMinimums: MC_SHIFTS.map((shiftId) => ({ shiftId, unavailable: true as const })),
  leaveCreditMinutes: null,
});

export function shortRosterDocument(): RosterDocument {
  return {
    ...priyaRosterDocument(),
    submission: fixtureSubmission(shortDocument(), []),
    context: shortContext(),
    solvedDays: shortGrid(),
  };
}
