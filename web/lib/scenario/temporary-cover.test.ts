import { describe, expect, it } from "vitest";
import { buildEquations } from "@/lib/roster-viewer/requirements";
import { requiredOn, requirementDateIsos } from "@/lib/rules/shortfalls";
import { cards, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import {
  toCanonicalScenarioDocument,
  type RequirementCard,
  type ScenarioUiState,
  type UiTemporaryCover,
} from "@/lib/scenario";
import {
  applyCovers,
  cardNeedOn,
  cardTargets,
  coverStatuses,
  groupClosureOf,
  wardNeed,
  withCoverOverrides,
} from "./temporary-cover";

// 1-7 Nov 2026. RN ⊂ Nurses (a nested group), HCA apart; Day = D + E.
const ISO = "2026-11-03";
const DATES = [1, 2, 3, 4, 5, 6, 7].map((d) => `2026-11-0${d}`);

function scenario(
  requirements: RequirementCard[],
  temporaryCover: UiTemporaryCover[],
  patch: Partial<ScenarioUiState> = {},
): ScenarioUiState {
  return ward({
    staff: people("a1", "a2", "r1", "r2", "h1"),
    staffGroups: [
      { id: "RN", members: ["r1", "r2"] },
      { id: "Nurses", members: ["RN", "a1"] },
      { id: "HCA", members: ["h1"] },
    ],
    shifts: [{ id: "D" }, { id: "E" }, { id: "N" }],
    shiftGroups: [{ id: "Day", members: ["D", "E"] }],
    cardsByKind: cards({ requirements }),
    temporaryCover,
    ...patch,
  });
}

const cover = (
  name: string,
  shiftType: string,
  groups: string[] = [],
  date = ISO,
): UiTemporaryCover => ({ name, date, shiftType, groups });

/** uid -> head count on `iso`, for every card that covers `iso`. */
function requiredOnIso(state: ScenarioUiState, iso = ISO): Record<string, number> {
  return Object.fromEntries(
    state.cardsByKind.requirements
      .filter((card) => requirementDateIsos(state, card).includes(iso))
      .map((card) => [card.uid, requiredOn(card, iso)]),
  );
}

/** uid -> the whole slot on `iso` (count, preferred, skill mix). */
function slotsOn(state: ScenarioUiState, iso = ISO) {
  return Object.fromEntries(
    state.cardsByKind.requirements
      .filter((card) => requirementDateIsos(state, card).includes(iso))
      .map((card) => [
        card.uid,
        {
          required: requiredOn(card, iso),
          preferred: card.preferredNumPeople,
          skillMix: card.skillMix,
        },
      ]),
  );
}

/** The solver's equations on one date, read back through `buildEquations`. */
function equationsOn(state: ScenarioUiState, iso: string): string[] {
  const dateIndex = DATES.indexOf(iso);
  return buildEquations(toCanonicalScenarioDocument(state))
    .filter((eq) => eq.dateIndices.has(dateIndex))
    .map((eq) =>
      [
        eq.shiftIds.join("+"),
        eq.requiredByDate.get(dateIndex) ?? eq.required,
        eq.preferred,
        eq.qualifiedLabel,
        eq.skillMix.map((m) => `${m.label}>=${m.minNumPeople}`).join(","),
      ].join("|"),
    )
    .sort();
}

const mixN = (n = 2, min = 1, extra: Partial<RequirementCard> = {}) =>
  requirement("mix", "N", n, { skillMix: [{ people: "RN", minNumPeople: min }], ...extra });

type NeedRow = {
  title: string;
  state: ScenarioUiState;
  need: Record<string, number>;
};

const F1: NeedRow[] = [
  {
    title: "lowers the all-staff card for a cover with no groups",
    state: scenario([requirement("all", "N", 3)], [cover("Haseena (Ward 3)", "N")]),
    need: { all: 2 },
  },
  {
    title: "lowers a qualifiedPeople card only for a member",
    state: scenario(
      [requirement("rn", "N", 2, { qualifiedPeople: ["RN"] }), requirement("all", "N", 3)],
      [cover("Haseena", "N", ["RN"])],
    ),
    need: { rn: 1, all: 2 },
  },
  {
    title: "lowers a qualifiedPeople card only for a member (non-member: open card only)",
    state: scenario(
      [requirement("rn", "N", 2, { qualifiedPeople: ["RN"] }), requirement("all", "N", 3)],
      [cover("Haseena", "N", ["HCA"])],
    ),
    need: { rn: 2, all: 2 },
  },
  {
    title: "lowers an aggregate shift-group card for either member shift (D)",
    state: scenario([requirement("day", "Day", 3)], [cover("Haseena", "D")]),
    need: { day: 2 },
  },
  {
    title: "lowers an aggregate shift-group card for either member shift (E)",
    state: scenario([requirement("day", "Day", 3)], [cover("Haseena", "E")]),
    need: { day: 2 },
  },
  {
    title: "lowers an aggregate shift-group card for either member shift (nested list)",
    state: scenario(
      [requirement("de", "D", 3, { shiftType: [["D", "E"]] })],
      [cover("Haseena", "E")],
    ),
    need: { de: 2 },
  },
  {
    title: "lowers an aggregate shift-group card for either member shift (not N)",
    state: scenario([requirement("day", "Day", 3)], [cover("Haseena", "N")]),
    need: { day: 3 },
  },
  {
    title: "splits a multi-selector card and lowers only the covered shift",
    state: scenario(
      [requirement("dn", "D", 2, { shiftType: ["D", "N"] })],
      [cover("Haseena", "N")],
    ),
    need: { "dn#s0": 2, "dn#s1": 1 },
  },
  {
    title: "nested group membership counts",
    state: scenario(
      [requirement("nurses", "N", 2, { qualifiedPeople: ["Nurses"] })],
      [cover("Haseena", "N", ["RN"])],
    ),
    need: { nurses: 1 },
  },
  {
    title: "person-id qualifiedPeople never counts her",
    state: scenario(
      [requirement("named", "N", 2, { qualifiedPeople: ["r1", "r2"] })],
      [cover("Haseena", "N", ["RN"])],
    ),
    need: { named: 2 },
  },
  {
    title: "coefficient 2 credits 2",
    state: scenario(
      [
        requirement("units", "D", 4, {
          shiftType: [["D", "N"]],
          shiftTypeCoefficients: [["N", 2]],
        }),
      ],
      [cover("Haseena", "N")],
    ),
    need: { units: 2 },
  },
  {
    title: "coefficient 2 credits 2 (the other shift still credits 1)",
    state: scenario(
      [
        requirement("units", "D", 4, {
          shiftType: [["D", "N"]],
          shiftTypeCoefficients: [["N", 2]],
        }),
      ],
      [cover("Haseena", "D")],
    ),
    need: { units: 3 },
  },
  {
    title: "a scalar ALL selector counts every worked shift",
    state: scenario([requirement("any", "D", 5, { shiftType: "ALL" })], [cover("Haseena", "E")]),
    need: { any: 4 },
  },
  {
    title: "a disabled card is never lowered",
    state: scenario(
      [requirement("off", "N", 3, { disabled: true }), requirement("all", "N", 2)],
      [cover("Haseena", "N")],
    ),
    need: { off: 3, all: 1 },
  },
];

type SlotRow = {
  title: string;
  state: ScenarioUiState;
  slots: ReturnType<typeof slotsOn>;
};

const MIX: SlotRow[] = [
  {
    title: "RN cover satisfies 'at least 1 RN'",
    state: scenario([mixN()], [cover("Haseena", "N", ["RN"])]),
    slots: { [`mix#d${ISO}`]: { required: 1, preferred: undefined, skillMix: undefined } },
  },
  {
    title: "non-RN cover does not lower the RN skill mix",
    state: scenario([mixN()], [cover("Haseena", "N", ["HCA"])]),
    slots: {
      mix: { required: 1, preferred: undefined, skillMix: [{ people: "RN", minNumPeople: 1 }] },
    },
  },
  {
    title: "two RN covers lower 'at least 2 RN' to 0 and drop the entry",
    state: scenario([mixN(3, 2)], [cover("Haseena", "N", ["RN"]), cover("Ola", "N", ["RN"])]),
    slots: { [`mix#d${ISO}`]: { required: 1, preferred: undefined, skillMix: undefined } },
  },
  {
    title: "one RN cover lowers 'at least 2 RN' to 1 and keeps the entry",
    state: scenario([mixN(3, 2)], [cover("Haseena", "N", ["RN"])]),
    slots: {
      [`mix#d${ISO}`]: {
        required: 2,
        preferred: undefined,
        skillMix: [{ people: "RN", minNumPeople: 1 }],
      },
    },
  },
  {
    title: "nested group membership counts toward a skill mix of the outer group",
    state: scenario(
      [requirement("mix", "N", 2, { skillMix: [{ people: "Nurses", minNumPeople: 1 }] })],
      [cover("Haseena", "N", ["RN"])],
    ),
    slots: { [`mix#d${ISO}`]: { required: 1, preferred: undefined, skillMix: undefined } },
  },
  {
    title: "skill mix counts heads, not coefficients",
    state: scenario(
      [
        mixN(4, 2, {
          shiftType: [["D", "N"]],
          shiftTypeCoefficients: [["N", 2]],
        }),
      ],
      [cover("Haseena", "N", ["RN"])],
    ),
    slots: {
      [`mix#d${ISO}`]: {
        required: 2,
        preferred: undefined,
        skillMix: [{ people: "RN", minNumPeople: 1 }],
      },
    },
  },
  {
    title: "a hand override on the cover date moves into the date copy as its base count",
    state: scenario(
      [
        mixN(2, 1, {
          requiredNumPeopleOverrides: [
            [ISO, 4],
            ["2026-11-05", 3],
          ],
        }),
      ],
      [cover("Haseena", "N", ["RN"])],
    ),
    slots: { [`mix#d${ISO}`]: { required: 3, preferred: undefined, skillMix: undefined } },
  },
];

const F2: SlotRow[] = [
  {
    title: "lowers floor and preferred on the cover date only",
    state: scenario(
      [requirement("soft", "N", 2, { preferredNumPeople: 4 })],
      [cover("Haseena", "N")],
    ),
    slots: { [`soft#d${ISO}`]: { required: 1, preferred: 3, skillMix: undefined } },
  },
  {
    title: "preferred never drops below the floor",
    state: scenario(
      [requirement("soft", "N", 1, { preferredNumPeople: 2 })],
      [cover("Haseena", "N"), cover("Ola", "N"), cover("Tom", "N")],
    ),
    slots: { [`soft#d${ISO}`]: { required: 0, preferred: 0, skillMix: undefined } },
  },
];

const F3: NeedRow[] = [
  {
    title: "hand override and cover compose",
    state: scenario(
      [requirement("n", "N", 3, { requiredNumPeopleOverrides: [[ISO, 2]] })],
      [cover("Haseena", "N")],
    ),
    need: { n: 1 },
  },
  {
    title: "hand override and cover compose (a result equal to the base count is dropped)",
    state: scenario(
      [requirement("n", "N", 2, { requiredNumPeopleOverrides: [[ISO, 3]] })],
      [cover("Haseena", "N")],
    ),
    need: { n: 2 },
  },
];

const F4: NeedRow[] = [
  {
    title: "two covers lower by two",
    state: scenario([requirement("n", "N", 3)], [cover("Haseena", "N"), cover("Ola", "N")]),
    need: { n: 1 },
  },
  {
    title: "clamps at zero with an extra-cover warning",
    state: scenario(
      [requirement("n", "N", 2)],
      [cover("Haseena", "N"), cover("Ola", "N"), cover("Tom", "N")],
    ),
    need: { n: 0 },
  },
  {
    title: "a requirement already at 0 stays 0 and warns",
    state: scenario([requirement("n", "N", 0)], [cover("Haseena", "N")]),
    need: { n: 0 },
  },
];

const DATE_SPLITS: { title: string; state: ScenarioUiState }[] = [
  { title: "skill mix", state: MIX[0].state },
  { title: "preferred count", state: F2[0].state },
  { title: "hand overrides on and off the cover date", state: MIX[6].state },
  {
    title: "a multi-selector card with a skill mix",
    state: scenario(
      [
        requirement("dn", "D", 2, {
          shiftType: ["D", "N"],
          skillMix: [{ people: "RN", minNumPeople: 1 }],
        }),
      ],
      [cover("Haseena", "N", ["RN"]), cover("Ola", "D", ["RN"], "2026-11-05")],
    ),
  },
];

const FIXTURES = [...F1, ...MIX, ...F2, ...F3, ...F4, ...DATE_SPLITS].map((row) => row.state);

describe("F1 overlapping cards, groups, skill mix and shift-type groups", () => {
  it.each(F1)("$title", ({ state, need }) => {
    expect(requiredOnIso(applyCovers(state).state)).toEqual(need);
  });

  it.each(MIX)("$title", ({ state, slots }) => {
    expect(slotsOn(applyCovers(state).state)).toEqual(slots);
  });

  it.each(DATE_SPLITS)(
    "date split leaves every other date's equations unchanged: $title",
    ({ state }) => {
      const derived = applyCovers(state).state;
      for (const iso of DATES) {
        if (state.temporaryCover.some((c) => c.date === iso)) {
          expect(equationsOn(derived, iso)).not.toEqual(equationsOn(state, iso));
        } else {
          expect(equationsOn(derived, iso)).toEqual(equationsOn(state, iso));
        }
      }
    },
  );

  it("the date copy sits right after its card, and the card lists its other dates", () => {
    const derived = applyCovers(MIX[6].state).state.cardsByKind.requirements;
    expect(derived.map((c) => c.uid)).toEqual(["mix", `mix#d${ISO}`]);
    expect(derived[0].date).toEqual(DATES.filter((iso) => iso !== ISO));
    expect(derived[0].requiredNumPeopleOverrides).toEqual([["2026-11-05", 3]]);
    expect(derived[1].date).toEqual([ISO]);
    expect(derived[1].requiredNumPeopleOverrides).toBeUndefined();
  });

  it("a single-date card is replaced by its date copy", () => {
    const state = scenario([mixN(2, 1, { date: [ISO] })], [cover("Haseena", "N", ["RN"])]);
    expect(applyCovers(state).state.cardsByKind.requirements.map((c) => c.uid)).toEqual([
      `mix#d${ISO}`,
    ]);
  });

  it("a split card keeps every other field", () => {
    const state = scenario(
      [
        requirement("dn", "D", 2, {
          shiftType: ["D", ["E", "N"]],
          preferredNumPeople: 3,
          weight: -5,
        }),
      ],
      [cover("Haseena", "D", [], "2026-11-01")],
    );
    const [d, copy, en] = applyCovers(state).state.cardsByKind.requirements;
    expect(en).toEqual({
      ...state.cardsByKind.requirements[0],
      uid: "dn#s1",
      shiftType: [["E", "N"]],
    });
    expect(d).toMatchObject({
      uid: "dn#s0",
      shiftType: ["D"],
      weight: -5,
      qualifiedPeople: ["ALL"],
    });
    expect(copy).toEqual({
      ...state.cardsByKind.requirements[0],
      uid: "dn#s0#d2026-11-01",
      shiftType: ["D"],
      date: ["2026-11-01"],
      requiredNumPeople: 1,
      preferredNumPeople: 2,
    });
  });

  it("cardTargets: one per top-level selector, with coefficients and qualified groups", () => {
    const state = scenario([], []);
    expect(
      cardTargets(
        state,
        requirement("x", "D", 1, { shiftType: ["D", ["E", "N"]], qualifiedPeople: ["RN", "a1"] }),
      ),
    ).toEqual([
      { shiftIds: ["D"], coefficients: [1], qualifiedGroups: new Set(["RN"]) },
      { shiftIds: ["E", "N"], coefficients: [1, 1], qualifiedGroups: new Set(["RN"]) },
    ]);
    expect(
      cardTargets(
        state,
        requirement("y", "Day", 1, {
          shiftTypeCoefficients: [["E", 2]],
          qualifiedPeople: undefined,
        }),
      ),
    ).toEqual([{ shiftIds: ["D", "E"], coefficients: [1, 2], qualifiedGroups: null }]);
  });

  it("groupClosureOf: a group plus every group that contains it, cycles guarded", () => {
    const closure = groupClosureOf([
      { id: "RN", members: ["r1"] },
      { id: "Nurses", members: ["RN"] },
      { id: "Ward", members: ["Nurses", "Ward"] },
    ]);
    expect(closure("RN")).toEqual(new Set(["RN", "Nurses", "Ward"]));
    expect(closure("Ward")).toEqual(new Set(["Ward"]));
    expect(closure("ghost")).toEqual(new Set(["ghost"]));
  });
});

describe("F2 soft and preferred counts", () => {
  it.each(F2)("$title", ({ state, slots }) => {
    const derived = applyCovers(state).state;
    expect(slotsOn(derived)).toEqual(slots);
    const original = derived.cardsByKind.requirements.find((c) => c.uid === "soft");
    expect(original?.date).toEqual(DATES.filter((iso) => iso !== ISO));
    expect(original?.preferredNumPeople).toBe(state.cardsByKind.requirements[0].preferredNumPeople);
  });
});

describe("F3 drift", () => {
  it.each(F3)("$title", ({ state, need }) => {
    expect(requiredOnIso(applyCovers(state).state)).toEqual(need);
  });

  it("hand override and cover compose (other overrides are untouched)", () => {
    const state = scenario(
      [
        requirement("n", "N", 3, {
          requiredNumPeopleOverrides: [
            ["2026-11-01", 5],
            [ISO, 2],
          ],
        }),
      ],
      [cover("Haseena", "N")],
    );
    expect(applyCovers(state).state.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual(
      [
        ["2026-11-01", 5],
        [ISO, 1],
      ],
    );
    expect(
      applyCovers(
        scenario(
          [requirement("n", "N", 2, { requiredNumPeopleOverrides: [[ISO, 3]] })],
          [cover("H", "N")],
        ),
      ).state.cardsByKind.requirements[0].requiredNumPeopleOverrides,
    ).toBeUndefined();
  });

  it("removing a cover restores the exact hand-written count", () => {
    const withCover = scenario(
      [requirement("n", "N", 3, { requiredNumPeopleOverrides: [[ISO, 5]] })],
      [cover("Haseena", "N")],
    );
    expect(requiredOnIso(applyCovers(withCover).state)).toEqual({ n: 4 });
    expect(withCover.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([[ISO, 5]]);
    const removed = { ...withCover, temporaryCover: [] };
    expect(applyCovers(removed).state).toBe(removed);
    expect(requiredOnIso(applyCovers(removed).state)).toEqual({ n: 5 });
  });

  it.each([
    {
      title: "deleted shift type flags the cover",
      cover: cover("Haseena", "X"),
      flag: "unknown-shift",
    },
    {
      title: "a day-state shift flags the cover",
      cover: cover("Haseena", "OFF"),
      flag: "unknown-shift",
    },
    {
      title: "out-of-period cover is flagged and lowers nothing",
      cover: cover("Haseena", "N", [], "2026-12-01"),
      flag: "out-of-period",
    },
    {
      title: "no-card cover is flagged",
      cover: cover("Haseena", "D"),
      flag: "no-card",
    },
    {
      title: "unknown group flags the cover",
      cover: cover("Haseena", "N", ["ghost"]),
      flag: "unknown-group",
    },
  ])("$title", ({ cover: flagged, flag }) => {
    const state = scenario(
      [requirement("n", "N", 3), requirement("off", "D", 2, { disabled: true })],
      [flagged],
      { shifts: [{ id: "D" }, { id: "E" }, { id: "N" }, { id: "OFF" }] },
    );
    expect(coverStatuses(state)).toEqual([
      { index: 0, flag, effects: [], extra: 0, restrictedBy: [] },
    ]);
    expect(applyCovers(state)).toEqual({ state, decrements: [] });
    expect(applyCovers(state).state).toBe(state);
  });

  it("a flagged cover sits beside a working one and lowers nothing", () => {
    const state = scenario(
      [requirement("n", "N", 3)],
      [cover("Haseena", "N", ["ghost"]), cover("Ola", "N")],
    );
    expect(requiredOnIso(applyCovers(state).state)).toEqual({ n: 2 });
    expect(coverStatuses(state).map((s) => s.flag)).toEqual(["unknown-group", null]);
  });

  it("no-card lists the cards restricted to a group she is not in", () => {
    const state = scenario(
      [requirement("rn", "N", 2, { qualifiedPeople: ["RN"], description: "Night RN" })],
      [cover("Haseena", "N", ["HCA"])],
    );
    expect(coverStatuses(state)).toEqual([
      {
        index: 0,
        flag: "no-card",
        effects: [],
        extra: 0,
        restrictedBy: [{ cardUid: "rn", label: "Night RN", group: "RN" }],
      },
    ]);
  });
});

describe("F4 several covers on one slot, and covers past the requirement", () => {
  it.each(F4)("$title", ({ state, need }) => {
    expect(requiredOnIso(applyCovers(state).state)).toEqual(need);
  });

  it.each([
    { title: "two covers lower by two", state: F4[0].state, before: 3, after: 1, extra: 0 },
    {
      title: "clamps at zero with an extra-cover warning",
      state: F4[1].state,
      before: 2,
      after: 0,
      extra: 1,
    },
    {
      title: "a requirement already at 0 stays 0 and warns",
      state: F4[2].state,
      before: 0,
      after: 0,
      extra: 1,
    },
  ])("status: $title", ({ state, before, after, extra }) => {
    for (const status of coverStatuses(state)) {
      expect(status).toEqual({
        index: status.index,
        flag: null,
        effects: [{ cardUid: "n", label: "n", iso: ISO, shiftId: "N", before, after }],
        extra,
        restrictedBy: [],
      });
    }
  });

  it("a card restricted to another group warns but she still counts on the open card", () => {
    const state = scenario(
      [requirement("rn", "N", 1, { qualifiedPeople: ["RN"] }), requirement("all", "N", 3)],
      [cover("Haseena", "N")],
    );
    expect(coverStatuses(state)[0]).toMatchObject({
      flag: null,
      effects: [{ cardUid: "all", before: 3, after: 2 }],
      restrictedBy: [{ cardUid: "rn", label: "rn", group: "RN" }],
    });
  });

  it("wardNeed clamps at zero", () => {
    expect([wardNeed(3, 1), wardNeed(2, 3), wardNeed(0, 1)]).toEqual([2, 0, 0]);
  });
});

describe("identity and the ledger", () => {
  it("no cover returns the same state object", () => {
    const state = scenario([requirement("n", "N", 3), mixN()], []);
    expect(applyCovers(state).state).toBe(state);
    expect(applyCovers(state).decrements).toEqual([]);
    expect(withCoverOverrides(state)).toBe(state);
  });

  it("a cover that changes no number returns the same state object", () => {
    const state = F4[2].state;
    expect(applyCovers(state)).toEqual({ state, decrements: [] });
    expect(applyCovers(state).state).toBe(state);
  });

  it("withCoverOverrides is applyCovers(state).state", () => {
    for (const state of FIXTURES)
      expect(withCoverOverrides(state)).toEqual(applyCovers(state).state);
  });

  it("never writes the authored state", () => {
    for (const state of FIXTURES) {
      const before = structuredClone(state);
      applyCovers(state);
      coverStatuses(state);
      expect(state).toEqual(before);
    }
  });

  it("ledger pref matches buildEquations preferenceIndex", () => {
    const state = scenario(
      [
        requirement("off", "N", 9, { disabled: true }),
        requirement("dn", "D", 2, { shiftType: ["D", "N"] }),
        mixN(3, 2, { preferredNumPeople: 4 }),
        requirement("tail", "E", 1),
      ],
      [cover("Haseena", "N", ["RN"]), cover("Ola", "E", [], "2026-11-06")],
    );
    const { state: derived, decrements } = applyCovers(state);
    expect(derived.cardsByKind.requirements.map((c) => c.uid)).toEqual([
      "off",
      "dn#s0",
      "dn#s1",
      "mix",
      `mix#d${ISO}`,
      "tail",
    ]);
    expect(decrements).toEqual([
      { pref: 2, iso: ISO, required: 1 },
      { pref: 4, iso: ISO, required: 1, preferred: 1, mix: [[0, 1]] },
      { pref: 5, iso: "2026-11-06", required: 1 },
    ]);
    const document = toCanonicalScenarioDocument(derived);
    const equations = buildEquations(document);
    const authored = new Map(state.cardsByKind.requirements.map((c) => [c.uid, c]));
    for (const d of decrements) {
      const equation = equations.find((eq) => eq.preferenceIndex === d.pref);
      expect(equation).toBeDefined();
      const card = derived.cardsByKind.requirements.filter((c) => !c.disabled)[d.pref - 1];
      expect(document.preferences[d.pref]).toMatchObject({
        requiredNumPeople: card.requiredNumPeople,
      });
      // submitted + decrement = authored, on the decrement's date.
      const source = authored.get(card.uid.split("#")[0]);
      expect(requiredOn(card, d.iso) + d.required).toBe(requiredOn(source!, d.iso));
    }
  });
});

describe("cardNeedOn (authored-card readers)", () => {
  it("cardNeedOn and the solver form agree on every slot", () => {
    let slots = 0;
    for (const state of FIXTURES) {
      const derived = new Map(
        applyCovers(state).state.cardsByKind.requirements.map((c) => [c.uid, c]),
      );
      for (const card of state.cardsByKind.requirements) {
        if (card.disabled) continue;
        const targets = cardTargets(state, card);
        targets.forEach((target, t) => {
          const base = derived.has(`${card.uid}#s${t}`) ? `${card.uid}#s${t}` : card.uid;
          for (const iso of requirementDateIsos(state, card)) {
            const solved = derived.get(`${base}#d${iso}`) ?? derived.get(base);
            expect(solved, `${card.uid} ${t} ${iso}`).toBeDefined();
            expect(requirementDateIsos(state, solved!)).toContain(iso);
            const need = cardNeedOn(state, card, iso, target.shiftIds[0]);
            expect(need.required).toBe(requiredOn(solved!, iso));
            expect(need.preferred).toBe(solved!.preferredNumPeople);
            expect(need.mix.filter((n) => n > 0)).toEqual(
              (solved!.skillMix ?? []).map((m) => m.minNumPeople).filter((n) => n > 0),
            );
            slots += 1;
          }
        });
      }
    }
    expect(slots).toBeGreaterThan(100);
  });

  it("reports credit and extra, and ignores a disabled card or an uncovered date", () => {
    const state = F4[1].state;
    const card = state.cardsByKind.requirements[0];
    expect(cardNeedOn(state, card, ISO)).toEqual({ required: 0, mix: [], credit: 3, extra: 1 });
    expect(cardNeedOn(state, card, "2026-11-01")).toEqual({
      required: 2,
      mix: [],
      credit: 0,
      extra: 0,
    });
    expect(cardNeedOn(state, { ...card, disabled: true }, ISO)).toMatchObject({
      required: 2,
      credit: 0,
    });
    expect(cardNeedOn(state, card, ISO, "D")).toMatchObject({ required: 2, credit: 0 });
  });
});
