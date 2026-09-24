// Scripted wards for the static staffing check and the assistant evaluation harness.
//
// Each ward is 1-7 Nov 2026, so the request-matrix date ids are "01".."07". Every
// ward except `empty` and `restRuleTooTight` is statically infeasible, and each one
// is a situation a real ward manager meets. `restRuleTooTight` is infeasible only
// through rest rules, which the static check does not model: it exercises the
// "unexplained" path.

import {
  createEmptyScenarioUiState,
  type CardsByKind,
  type CountCard,
  type RequirementCard,
  type ScenarioUiState,
  type UiPerson,
  type UiRequestCell,
} from "@/lib/scenario";

export function ward(patch: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-11-01",
    rangeEnd: "2026-11-07",
    shifts: [
      { id: "D", description: "Day" },
      { id: "N", description: "Night" },
    ],
    ...patch,
  };
}

export function cards(partial: Partial<CardsByKind>): CardsByKind {
  return {
    requirements: [],
    successions: [],
    counts: [],
    affinities: [],
    coverings: [],
    ...partial,
  };
}

export const people = (...ids: string[]): UiPerson[] => ids.map((id) => ({ id }));

export function requirement(
  uid: string,
  shift: string,
  requiredNumPeople: number,
  extra: Partial<RequirementCard> = {},
): RequirementCard {
  return {
    uid,
    description: uid,
    shiftType: [shift],
    requiredNumPeople,
    qualifiedPeople: ["ALL"],
    date: ["ALL"],
    weight: -1,
    ...extra,
  };
}

/** A hard "at most `target` nights per nurse this period" rule for one group. */
export function nightCap(uid: string, group: string, target: number): CountCard {
  return {
    uid,
    description: `At most ${target} nights`,
    person: [group],
    countDates: ["ALL"],
    countShiftTypes: ["N"],
    expression: "x <= T",
    target,
    weight: Infinity,
  };
}

export const leave = (person: string, date: string): UiRequestCell => ({
  uid: `leave-${person}-${date}`,
  person,
  date,
  kind: "leave",
});

const OTHER_NIGHTS = [
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-06",
  "2026-11-07",
];

export const SCENARIOS = {
  /** A brand-new scenario: nothing set up. */
  empty: (): ScenarioUiState => createEmptyScenarioUiState(),
  /** Night on the 5th needs 3 (high acuity); with 1 on days the 3 nurses cannot cover it. */
  understaffedNight: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben", "cara"),
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 1, { date: OTHER_NIGHTS }),
          requirement("night-05", "N", 3, {
            date: ["2026-11-05"],
            description: "Night on the 5th (high acuity)",
          }),
        ],
      }),
    }),
  /** Every night needs 1 RN; the only RN is on leave on the 3rd. */
  onlyRnOnLeave: (): ScenarioUiState =>
    ward({
      staff: people("rn1", "en1", "en2"),
      staffGroups: [{ id: "RN", members: ["rn1"] }],
      reqData: [leave("rn1", "03")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night-rn", "N", 1, {
            qualifiedPeople: ["RN"],
            description: "1 RN every night",
          }),
        ],
      }),
    }),
  /** Nights need 2, at least 2 of them RNs; one of the two RNs is on leave on the 3rd. */
  rnMixOnLeave: (): ScenarioUiState =>
    ward({
      staff: people("rn1", "rn2", "en1", "en2", "en3"),
      staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
      reqData: [leave("rn2", "03")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 2, {
            description: "Night: 2, both RNs",
            skillMix: [{ people: "RN", minNumPeople: 2 }],
          }),
        ],
      }),
    }),
  /** 7 nights to fill, but "at most 1 night each" lets 4 nurses cover only 4. */
  ruleTooStrict: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben", "cara", "dev"),
      staffGroups: [{ id: "Nurses", members: ["ana", "ben", "cara", "dev"] }],
      cardsByKind: cards({
        requirements: [requirement("day", "D", 1), requirement("night", "N", 1)],
        counts: [nightCap("max-nights", "Nurses", 1)],
      }),
    }),
  /** Day, evening and night each need 1, every day, with only 2 nurses. */
  tooFewNurses: (): ScenarioUiState =>
    ward({
      shifts: [
        { id: "D", description: "Day" },
        { id: "E", description: "Evening" },
        { id: "N", description: "Night" },
      ],
      staff: people("ana", "ben"),
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("eve", "E", 1),
          requirement("night", "N", 1),
        ],
      }),
    }),
  /** 7 nights, 2 nurses, each with her own hard limit of 3 nights: one night is left over. */
  personalCapsTooLow: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben"),
      cardsByKind: cards({
        requirements: [requirement("night", "N", 1)],
        counts: [nightCap("ana-nights", "ana", 3), nightCap("ben-nights", "ben", 3)],
      }),
    }),
  /** Every night needs exactly 1 on the ward and exactly 2 RNs: the two rules cannot both hold. */
  conflictingRequirements: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben", "cara"),
      staffGroups: [{ id: "RN", members: ["ana", "ben"] }],
      cardsByKind: cards({
        requirements: [
          requirement("night-total", "N", 1, { description: "1 on every night" }),
          requirement("night-rn", "N", 2, {
            qualifiedPeople: ["RN"],
            description: "2 RNs every night",
          }),
        ],
      }),
    }),
  /**
   * Busy nights on the 2nd and 6th need 3, with a day nurse too, from 3 nurses; and
   * nobody may work a day straight after a night. A borrowed nurse inherits that rule.
   */
  busyNightsWithRestRule: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben", "cara"),
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 1, {
            date: ["2026-11-01", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-07"],
          }),
          requirement("night-busy", "N", 3, {
            date: ["2026-11-02", "2026-11-06"],
            description: "Busy nights (theatre lists)",
          }),
        ],
        successions: [
          {
            uid: "no-day-after-night",
            description: "No day shift straight after a night",
            person: ["ALL"],
            pattern: ["N", "D"],
            weight: -Infinity,
          },
        ],
      }),
    }),
  /** Every night needs 2 and every day 1, from 3 nurses. Cara is on leave on the 5th: one short. */
  shortOnLeaveDay: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben", "cara"),
      reqData: [leave("cara", "05")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 2, { description: "2 on every night" }),
        ],
      }),
    }),
  /** 2 nurses, day + night each day, no day after a night and no two nights in a row. */
  restRuleTooTight: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben"),
      staffGroups: [{ id: "Nurses", members: ["ana", "ben"] }],
      cardsByKind: cards({
        requirements: [requirement("day", "D", 1), requirement("night", "N", 1)],
        successions: [
          {
            uid: "no-day-after-night",
            description: "No day shift straight after a night",
            person: ["Nurses"],
            pattern: ["N", "D"],
            weight: -Infinity,
          },
          {
            uid: "no-double-night",
            description: "No two nights in a row",
            person: ["Nurses"],
            pattern: ["N", "N"],
            weight: -Infinity,
          },
        ],
      }),
    }),
} as const satisfies Record<string, () => ScenarioUiState>;

export type ScenarioName = keyof typeof SCENARIOS;
