// Hand-change rule check tests (bead nursing-sheduler-73z). Each family pins one way
// `core/nurse_scheduling/preference_types.py` reads it, plus the "only new issues
// blame a change" rule.

import { describe, expect, it } from "vitest";
import {
  PREFERENCE_TYPE,
  type CanonicalPreference,
  type CanonicalScenarioDocument,
} from "@/lib/scenario";
import type { RosterContext, RosterDayState } from "@/lib/roster/types";
import { fixtureSubmission } from "@/lib/roster/test-fixtures";
import {
  buildRuleModel,
  checkRosterChange,
  deriveRuleModel,
  plainDate,
  type LeaveMove,
} from "./rule-check";

const DATES = ["2026-10-07", "2026-10-08", "2026-10-09"];
const s = (id: string): RosterDayState => ({ kind: "shift", shiftId: id });
const OFF: RosterDayState = { kind: "off" };
const LEAVE: RosterDayState = { kind: "leave" };
const SCOPE = { people: [0, 1, 2], dates: [0, 1, 2] };

function doc(preferences: CanonicalPreference[], history?: string[]): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: DATES[0], endDate: DATES[2] } },
    people: {
      items: [{ id: "Ana", ...(history ? { history } : {}) }, { id: "Ben" }, { id: "Cy" }],
      groups: [{ id: "Nights", members: ["Ana", "Ben"] }],
    },
    shiftTypes: {
      items: ["AM", "N"].map((id) => ({
        id,
        startTime: "08:00",
        endTime: "16:00",
        durationMinutes: 480,
      })),
    },
    preferences: [{ type: PREFERENCE_TYPE.maxOneShiftPerDay }, ...preferences],
  };
}

function contextFor(document: CanonicalScenarioDocument): RosterContext {
  return {
    people: document.people.items.map((person) => ({ id: person.id })),
    shiftTypes: document.shiftTypes.items.map((item) => ({ id: item.id })),
    calendar: DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
    baselineMinimums: document.shiftTypes.items.map((item) => ({
      shiftId: item.id,
      unavailable: true as const,
    })),
    leaveCreditMinutes: null,
  };
}

function check(
  preferences: CanonicalPreference[],
  before: RosterDayState[][],
  after: RosterDayState[][],
  options: {
    history?: string[];
    scope?: { people: number[]; dates: number[] };
    leaveMoves?: LeaveMove[];
  } = {},
) {
  const document = doc(preferences, options.history);
  return checkRosterChange(
    buildRuleModel(document),
    contextFor(document),
    before,
    after,
    options.scope ?? SCOPE,
    {
      leaveMoves: options.leaveMoves,
    },
  );
}

const NO_N_THEN_AM = {
  type: PREFERENCE_TYPE.shiftTypeSuccessions,
  description: "No morning after night",
  person: "ALL",
  pattern: ["N", "AM"],
  weight: -Infinity,
} as CanonicalPreference;

const idle = (): RosterDayState[] => [OFF, OFF, OFF];

describe("successions", () => {
  it("blames only the window a change creates", () => {
    const before = [[s("N"), s("AM"), OFF], [OFF, s("N"), OFF], idle()];
    const after = [[s("N"), s("AM"), OFF], [OFF, s("N"), s("AM")], idle()];
    const result = check([NO_N_THEN_AM], before, after);
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "Ben works N on 8 Oct, then AM on 9 Oct, which “No morning after night” does not allow.",
    ]);
  });

  it("reads history across the roster start", () => {
    const result = check(
      [NO_N_THEN_AM],
      [idle(), idle(), idle()],
      [[s("AM"), OFF, OFF], idle(), idle()],
      {
        history: ["N"],
        scope: { people: [0], dates: [0] },
      },
    );
    expect(result.hard).toHaveLength(1);
    expect(result.hard[0].message).toMatch(/N before the roster starts, then AM on 7 Oct/);
  });

  it("ignores a window the rule's dates do not fully cover", () => {
    const scoped = { ...NO_N_THEN_AM, date: "2026-10-09" } as CanonicalPreference;
    const result = check(
      [scoped],
      [idle(), idle(), idle()],
      [[OFF, s("N"), s("AM")], idle(), idle()],
    );
    expect(result.hard).toEqual([]);
  });
});

describe("plain words", () => {
  it("names a day off in words and never quotes a fallback as a rule name", () => {
    const unnamed = {
      type: PREFERENCE_TYPE.shiftTypeSuccessions,
      person: "ALL",
      pattern: ["N", "OFF"],
      weight: -Infinity,
    } as CanonicalPreference;
    const result = check([unnamed], [idle(), idle(), idle()], [idle(), [OFF, s("N"), OFF], idle()]);
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "Ben works N on 8 Oct, then a day off on 9 Oct, which a shift pattern rule does not allow.",
    ]);
  });
});

describe("requests", () => {
  it("treats an infinite request as hard and a finite one as worth knowing", () => {
    const preferences = [
      {
        type: PREFERENCE_TYPE.shiftRequest,
        description: "Ben's study day",
        person: "Ben",
        date: "2026-10-08",
        shiftType: "N",
        weight: -Infinity,
      },
      {
        type: PREFERENCE_TYPE.shiftRequest,
        person: "Ana",
        date: "2026-10-09",
        shiftType: "AM",
        weight: 1,
      },
    ] as CanonicalPreference[];
    const before = [[OFF, OFF, s("AM")], idle(), idle()];
    const after = [[OFF, OFF, OFF], [OFF, s("N"), OFF], idle()];
    const result = check(preferences, before, after);
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "Ben must not have N on 8 Oct (“Ben's study day”).",
    ]);
    expect(result.soft.map((issue) => issue.message)).toEqual(["Ana asked for AM on 9 Oct."]);
  });

  it("treats a LEAVE request as hard at any weight", () => {
    const leave = {
      type: PREFERENCE_TYPE.shiftRequest,
      person: "Ana",
      date: "2026-10-07",
      shiftType: "LEAVE",
      weight: 1,
    } as CanonicalPreference;
    const result = check(
      [leave],
      [[LEAVE, OFF, OFF], idle(), idle()],
      [[s("N"), OFF, OFF], idle(), idle()],
    );
    expect(result.hard.map((issue) => issue.message)).toEqual(["Ana must have leave on 7 Oct."]);
  });
});

describe("counts", () => {
  it("enforces an infinite x <= T per person", () => {
    const cap = {
      type: PREFERENCE_TYPE.shiftCount,
      description: "Max 1 night",
      person: "ALL",
      countDates: "ALL",
      countShiftTypes: "N",
      expression: "x <= T",
      target: 1,
      weight: Infinity,
    } as CanonicalPreference;
    const result = check(
      [cap],
      [idle(), [OFF, s("N"), OFF], idle()],
      [idle(), [s("N"), s("N"), OFF], idle()],
    );
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "Ben has 2 counted under “Max 1 night”, which needs at most 1.",
    ]);
  });

  it("reads -inf on |x - T|^2 as x = T", () => {
    const exact = {
      type: PREFERENCE_TYPE.shiftCount,
      person: "Ben",
      countDates: "ALL",
      countShiftTypes: "N",
      expression: "|x - T|^2",
      target: 1,
      weight: -Infinity,
    } as CanonicalPreference;
    const result = check(
      [exact],
      [idle(), [OFF, s("N"), OFF], idle()],
      [idle(), [s("N"), s("N"), OFF], idle()],
    );
    expect(result.hard).toHaveLength(1);
  });
});

describe("staffing requirements", () => {
  const NIGHTS_ONLY = {
    type: PREFERENCE_TYPE.shiftTypeRequirement,
    description: "One night nurse",
    shiftType: "N",
    requiredNumPeople: 1,
    qualifiedPeople: "Nights",
    weight: -1,
  } as CanonicalPreference;

  it("flags an unqualified cover and the shortfall it leaves", () => {
    const before = [idle(), [OFF, s("N"), OFF], idle()];
    const after = [idle(), idle(), [OFF, s("N"), OFF]];
    const messages = check([NIGHTS_ONLY], before, after).hard.map((issue) => issue.message);
    expect(messages).toContain("8 Oct: Cy works N, which only Nights may work.");
    expect(messages).toContain("8 Oct: “One night nurse” has 0 of the 1 needed.");
  });

  it("does not blame a change for a shortfall that was already there", () => {
    const grid = [idle(), [OFF, s("N"), OFF], idle()];
    // Day 0 and day 2 are short before and after; only day 1 changes hands.
    const after = [[OFF, s("N"), OFF], idle(), idle()];
    expect(check([NIGHTS_ONLY], grid, after).hard).toEqual([]);
  });
});

describe("skill mix", () => {
  // Nights = Ana, Ben. Cy is neither. A floor of two on nights bans nobody.
  const MIXED_NIGHTS = {
    type: PREFERENCE_TYPE.shiftTypeRequirement,
    description: "Two night nurses",
    shiftType: "N",
    requiredNumPeople: 2,
    skillMix: [{ people: "Nights", minNumPeople: 2 }],
    weight: -1,
  } as CanonicalPreference;

  it("flags a change that drops the floor while the head count still holds", () => {
    // Both days have two on N; only the SECOND loses its second Night nurse.
    const before = [[OFF, s("N"), OFF], [OFF, s("N"), OFF], idle()];
    const after = [[OFF, s("N"), OFF], idle(), [OFF, s("N"), OFF]];
    const result = check([MIXED_NIGHTS], before, after);
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "8 Oct: “Two night nurses” has 1 of the 2 needed from Nights.",
    ]);
  });

  it("does not blame a change that keeps the floor", () => {
    const before = [[OFF, s("N"), OFF], idle(), idle()];
    const after = [[OFF, s("N"), OFF], [OFF, s("N"), OFF], idle()];
    expect(check([MIXED_NIGHTS], before, after).hard).toEqual([]);
  });
});

describe("what it cannot check", () => {
  it("lists a hard affinity instead of calling it fine", () => {
    const pairing = {
      type: PREFERENCE_TYPE.shiftAffinity,
      description: "Ana and Ben never together",
      date: "ALL",
      people1: ["Ana"],
      people2: ["Ben"],
      shiftTypes: ["N"],
      weight: -Infinity,
    } as CanonicalPreference;
    expect(check([pairing], [idle(), idle(), idle()], [idle(), idle(), idle()]).unchecked).toEqual([
      "Ana and Ben never together",
    ]);
  });
});

describe("the submission round trip", () => {
  it("keeps hard weights through the canonical YAML", () => {
    const model = deriveRuleModel(fixtureSubmission(doc([NO_N_THEN_AM]), []));
    expect(model?.successions[0].weight).toBe(-Infinity);
  });

  it("formats a roster date the way the ward says it", () => {
    expect(plainDate("2026-10-08")).toBe("8 Oct");
  });
});

describe("leave that moves with a trade", () => {
  const leave = {
    type: PREFERENCE_TYPE.shiftRequest,
    person: "Ana",
    date: "2026-10-07",
    shiftType: "LEAVE",
    weight: 1,
  } as CanonicalPreference;
  const moves = [{ personIdx: 0, from: 0, to: 2 }];

  it("lets a traded leave day move", () => {
    const result = check(
      [leave],
      [[LEAVE, OFF, OFF], idle(), idle()],
      [[s("N"), OFF, LEAVE], idle(), idle()],
      { leaveMoves: moves },
    );
    expect(result.hard).toEqual([]);
  });

  it("still requires the leave on the day it moved to", () => {
    const result = check(
      [leave],
      [[LEAVE, OFF, OFF], idle(), idle()],
      [[s("N"), OFF, OFF], idle(), idle()],
      { leaveMoves: moves },
    );
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "Ana must have leave on 9 Oct (moved from 7 Oct).",
    ]);
  });
});
