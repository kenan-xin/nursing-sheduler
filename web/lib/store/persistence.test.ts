import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createGuardedStorage,
  createMemoryStorage,
  migrateScenarioState,
  sanitizePersistedScenario,
  SCENARIO_PERSIST_VERSION,
} from "./persistence";

describe("guarded storage", () => {
  it("passes reads through and serializes removes with writes", async () => {
    const inner = createMemoryStorage({ k: "seed" });
    const guard = createGuardedStorage(() => inner);
    expect(await guard.getItem("k")).toBe("seed");
    await guard.setItem("k", "next");
    await guard.removeItem("k");
    await guard.drain();
    expect(await guard.getItem("k")).toBeNull();
  });

  it("a slow older write cannot clobber a newer one (FIFO, no overlap)", async () => {
    const backing = new Map<string, string>();
    let call = 0;
    const inner: StateStorage = {
      getItem: async (name) => backing.get(name) ?? null,
      setItem: (name, value) => {
        // First inner write is slow, second fast: a naive passthrough would land
        // the slow v1 last and clobber v2. The queue serializes, so v2 wins.
        const delay = call++ === 0 ? 30 : 1;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            backing.set(name, value);
            resolve();
          }, delay);
        });
      },
      removeItem: async (name) => {
        backing.delete(name);
      },
    };
    const guard = createGuardedStorage(() => inner);

    guard.setItem("k", "v1");
    guard.setItem("k", "v2");
    await guard.drain();

    expect(backing.get("k")).toBe("v2");
  });

  it("does not strand the newest value when an inner write rejects", async () => {
    const backing = new Map<string, string>();
    let call = 0;
    const inner: StateStorage = {
      getItem: async (name) => backing.get(name) ?? null,
      setItem: async () => {
        // Every write fails; the newest revision still leaves an error.
        call++;
        throw new Error("disk full");
      },
      removeItem: async (name) => {
        backing.delete(name);
      },
    };
    const guard = createGuardedStorage(() => inner);

    guard.setItem("k", "v1"); // rejects internally
    guard.setItem("k", "v2"); // newest — also rejects, so the error stands
    await guard.drain();

    expect(call).toBe(2);
    expect(guard.consumeWriteError()).toBeInstanceOf(Error);
    // The error is consumed once.
    expect(guard.consumeWriteError()).toBeNull();
  });

  it("a newer successful write supersedes an older failure (newest-wins applies to errors)", async () => {
    const backing = new Map<string, string>();
    let call = 0;
    const inner: StateStorage = {
      getItem: async (name) => backing.get(name) ?? null,
      setItem: async (name, value) => {
        // v1 fails; v2 (newest) succeeds and must clear the stale v1 error —
        // otherwise a transient failure would keep reporting `error` forever
        // after a later write actually landed.
        if (call++ === 0) throw new Error("disk full");
        backing.set(name, value);
      },
      removeItem: async (name) => {
        backing.delete(name);
      },
    };
    const guard = createGuardedStorage(() => inner);

    guard.setItem("k", "v1"); // rejects internally
    guard.setItem("k", "v2"); // newest — succeeds, superseding v1's error
    await guard.drain();

    expect(backing.get("k")).toBe("v2");
    expect(guard.consumeWriteError()).toBeNull();
  });

  it("never surfaces a rejection to the caller (no unhandled rejection)", async () => {
    const inner: StateStorage = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("boom");
      },
      removeItem: async () => {},
    };
    const guard = createGuardedStorage(() => inner);
    await expect(guard.setItem("k", "v")).resolves.toBeUndefined();
    await expect(guard.drain()).resolves.toBeUndefined();
  });
});

describe("migrateScenarioState", () => {
  it("upgrades a v0 payload: requests → reqData, adds export layout", () => {
    const cell = { kind: "leave", person: "p1", date: "2026-01-01" };
    const migrated = migrateScenarioState(
      { requests: [cell], rangeStart: "2026-01-01" },
      0,
    ) as Record<string, unknown>;
    expect(migrated.reqData).toEqual([cell]);
    expect("requests" in migrated).toBe(false);
    expect(migrated.exportLayout).toEqual({ formatting: [], extraColumns: [], extraRows: [] });
    expect(migrated.rangeStart).toBe("2026-01-01");
  });

  it("refuses a FUTURE version instead of silently downgrading", () => {
    expect(() => migrateScenarioState({ reqData: [] }, SCENARIO_PERSIST_VERSION + 1)).toThrow(
      /newer than the supported version/,
    );
  });

  it("does not throw on a recognized older/empty payload", () => {
    expect(() => migrateScenarioState(undefined, 0)).not.toThrow();
    expect(() => migrateScenarioState({}, 0)).not.toThrow();
  });

  it("upgrades a v1 payload: defaults an absent guidedRulePins to []", () => {
    const migrated = migrateScenarioState({ rangeStart: "2026-01-01" }, 1) as Record<
      string,
      unknown
    >;
    expect(migrated.guidedRulePins).toEqual([]);
    expect(migrated.rangeStart).toBe("2026-01-01");
  });

  it("does not clobber an already-present guidedRulePins on re-migration", () => {
    const pin = {
      id: "p1",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const migrated = migrateScenarioState({ guidedRulePins: [pin] }, 0) as Record<string, unknown>;
    expect(migrated.guidedRulePins).toEqual([pin]);
  });

  it("upgrades a v2 payload: collapses duplicate legacy pins for the same source to the most recent one (T14d)", () => {
    const older = {
      id: "older",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const newer = {
      id: "newer",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Custom shortcuts",
      quickFields: ["target"],
    };
    const unrelated = {
      id: "unrelated",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Staffing",
      quickFields: [],
    };
    const migrated = migrateScenarioState(
      { guidedRulePins: [older, newer, unrelated] },
      2,
    ) as Record<string, unknown>;
    expect(migrated.guidedRulePins).toEqual([newer, unrelated]);
  });

  it("upgrades a v3 payload: clears the legacy strict-projection baseline to null", () => {
    // A pre-v4 baseline was computed under the old strict-projection scheme and set
    // on hydration/New/Load, so it no longer denotes a real backup. The v3→v4 step
    // clears it (under the old key, before v5 renames the key).
    const migrated = migrateScenarioState(
      { rangeStart: "2026-01-01", baselineFingerprint: "legacy-strict-hash" },
      3,
    ) as Record<string, unknown>;
    expect(migrated.backupFingerprint).toBeNull();
    expect("baselineFingerprint" in migrated).toBe(false);
  });

  it("upgrades a v4 payload: renames baselineFingerprint → backupFingerprint, preserving its value", () => {
    // A v4 record already stored the value under the download-baseline semantics
    // (set only by a real plain Download), so v4→v5 carries it across verbatim.
    const migrated = migrateScenarioState(
      { rangeStart: "2026-01-01", baselineFingerprint: "real-download-hash" },
      4,
    ) as Record<string, unknown>;
    expect(migrated.backupFingerprint).toBe("real-download-hash");
    expect("baselineFingerprint" in migrated).toBe(false);
  });

  it("renames a null v4 backup fingerprint to the new key", () => {
    const migrated = migrateScenarioState({ baselineFingerprint: null }, 4) as Record<
      string,
      unknown
    >;
    expect(migrated.backupFingerprint).toBeNull();
    expect("baselineFingerprint" in migrated).toBe(false);
  });
});

describe("sanitizePersistedScenario", () => {
  it("returns an empty overlay for an undefined payload (no record)", () => {
    expect(sanitizePersistedScenario(undefined)).toEqual({});
  });

  it("rejects an explicit null payload as corrupt", () => {
    expect(() => sanitizePersistedScenario(null)).toThrow(/corrupt record/);
  });

  it("allowlists known scenario keys and drops unknown/foreign ones", () => {
    const sanitized = sanitizePersistedScenario({
      meta: { apiVersion: "alpha" },
      rangeStart: "2026-01-01",
      reqData: [],
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
      exportLayout: { formatting: [], extraColumns: [], extraRows: [] },
      backupFingerprint: "abc",
      mutateScenario: () => "hijack", // foreign — must be dropped
      bogus: 123,
    });
    expect(sanitized).toEqual({
      meta: { apiVersion: "alpha" },
      rangeStart: "2026-01-01",
      reqData: [],
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
      exportLayout: { formatting: [], extraColumns: [], extraRows: [] },
      backupFingerprint: "abc",
    });
    expect("mutateScenario" in sanitized).toBe(false);
    expect("bogus" in sanitized).toBe(false);
  });

  it("throws on a parseable-but-malformed payload (top-level wrong types)", () => {
    expect(() => sanitizePersistedScenario("not an object")).toThrow();
    expect(() => sanitizePersistedScenario({ reqData: "should be an array" })).toThrow();
    expect(() => sanitizePersistedScenario({ meta: "should be an object" })).toThrow();
    expect(() => sanitizePersistedScenario({ backupFingerprint: 42 })).toThrow();
  });

  it("throws on nested malformation that container-type checks miss", () => {
    // meta missing the required apiVersion
    expect(() => sanitizePersistedScenario({ meta: {} })).toThrow(/apiVersion/);
    // cardsByKind missing required sub-keys
    expect(() => sanitizePersistedScenario({ cardsByKind: {} })).toThrow(/cardsByKind\./);
    // exportLayout missing required sub-keys
    expect(() => sanitizePersistedScenario({ exportLayout: {} })).toThrow(/exportLayout\./);
    // collection element is null
    expect(() => sanitizePersistedScenario({ staff: [null] })).toThrow(/staff\[0\]/);
    // group missing required members array
    expect(() => sanitizePersistedScenario({ staffGroups: [{ id: "g1" }] })).toThrow(/members/);
    // request cell missing required kind discriminant
    expect(() => sanitizePersistedScenario({ reqData: [{ person: "p1", date: "d1" }] })).toThrow(
      /kind/,
    );
    // "request" cell missing required shiftType
    expect(() =>
      sanitizePersistedScenario({
        reqData: [{ kind: "request", person: "p1", date: "d1", weight: 1 }],
      }),
    ).toThrow(/shiftType/);
    // "off" cell missing required weight
    expect(() =>
      sanitizePersistedScenario({ reqData: [{ kind: "off", person: "p1", date: "d1" }] }),
    ).toThrow(/weight/);
    // card element missing required uid
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          requirements: [{ shiftType: "D", requiredNumPeople: 1, weight: 1 }],
          successions: [],
          counts: [],
          affinities: [],
          coverings: [],
        },
      }),
    ).toThrow(/uid/);
  });

  it("accepts a complete, well-formed scenario payload", () => {
    const payload = {
      meta: { apiVersion: "alpha", description: "Test" },
      staff: [{ id: "p1" }],
      staffGroups: [{ id: "g1", members: ["p1"] }],
      shifts: [{ id: "D" }],
      shiftGroups: [{ id: "sg1", members: ["D"] }],
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
      dateGroups: [{ id: "dg1", members: ["2026-01-01"] }],
      reqData: [
        { kind: "leave", person: "p1", date: "2026-01-01" },
        { kind: "off", person: "p1", date: "2026-01-02", weight: 5 },
        { kind: "request", person: "p1", date: "2026-01-03", shiftType: "D", weight: 3 },
      ],
      exportLayout: {
        formatting: [{ type: "cell", people: [], dates: [], shiftTypes: [] }],
        extraColumns: [{ type: "count", header: "C", countShiftTypes: [], countDates: [] }],
        extraRows: [{ type: "count", header: "R", countShiftTypes: [], countPeople: [] }],
      },
      cardsByKind: {
        requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 1, weight: 1 }],
        successions: [{ uid: "s1", person: "p1", pattern: ["D"], weight: 1 }],
        counts: [
          {
            uid: "c1",
            person: "p1",
            countDates: [],
            countShiftTypes: [],
            expression: "",
            target: 1,
            weight: 1,
          },
        ],
        affinities: [
          { uid: "a1", date: "d1", people1: [], people2: [], shiftTypes: [], weight: 1 },
        ],
        coverings: [{ uid: "v1", preceptors: [], preceptees: [], shiftTypes: [], weight: 1 }],
      },
      guidedRulePins: [
        {
          id: "pin1",
          constraintKind: "counts",
          constraintId: "c1",
          category: "Hours",
          description: "Cap nights",
          quickFields: ["target"],
        },
      ],
      maxOneShiftPerDay: { description: "enforced" },
      backupFingerprint: "deadbeef",
    };
    expect(sanitizePersistedScenario(payload)).toEqual(payload);
  });

  it("throws on guidedRulePins malformation (T14a)", () => {
    // missing constraintKind/constraintId/category/quickFields
    expect(() => sanitizePersistedScenario({ guidedRulePins: [{ id: "p1" }] })).toThrow(
      /guidedRulePins\[0\]/,
    );
    // an unrecognized constraintKind
    expect(() =>
      sanitizePersistedScenario({
        guidedRulePins: [
          { id: "p1", constraintKind: "bogus", constraintId: "c1", category: "X", quickFields: [] },
        ],
      }),
    ).toThrow(/constraintKind/);
    // quickFields must be an array of strings
    expect(() =>
      sanitizePersistedScenario({
        guidedRulePins: [
          {
            id: "p1",
            constraintKind: "counts",
            constraintId: "c1",
            category: "X",
            quickFields: [1],
          },
        ],
      }),
    ).toThrow(/quickFields/);
  });

  it("accepts a well-formed guidedRulePins list, including an optional description", () => {
    const payload = {
      guidedRulePins: [
        {
          id: "p1",
          constraintKind: "requirements",
          constraintId: "r1",
          category: "Staffing",
          quickFields: [],
        },
        {
          id: "p2",
          constraintKind: "counts",
          constraintId: "c1",
          category: "Hours",
          description: "Cap nights",
          quickFields: ["target"],
        },
      ],
    };
    expect(sanitizePersistedScenario(payload)).toEqual(payload);
  });

  it("accepts a contracted-hours count card (tag + policy discriminant)", () => {
    const payload = {
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [
          {
            uid: "ch1",
            person: "p1",
            countDates: [],
            countShiftTypes: [],
            expression: "",
            target: 1,
            weight: 1,
            tag: "contracted_hours",
            policy: "exact",
          },
        ],
        affinities: [],
        coverings: [],
      },
      exportLayout: { formatting: [], extraColumns: [], extraRows: [] },
    };
    expect(() => sanitizePersistedScenario(payload)).not.toThrow();
  });

  it("throws on card body malformation (uid-only cards and missing required fields)", () => {
    const emptyCards = {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    };

    // uid-only requirement card (missing shiftType, requiredNumPeople, weight)
    expect(() =>
      sanitizePersistedScenario({ cardsByKind: { ...emptyCards, requirements: [{ uid: "r1" }] } }),
    ).toThrow(/shiftType|requiredNumPeople|weight/);

    // succession card missing pattern
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: { ...emptyCards, successions: [{ uid: "s1", person: "p1", weight: 1 }] },
      }),
    ).toThrow(/pattern/);

    // count card missing expression
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          counts: [
            { uid: "c1", person: "p1", countDates: [], countShiftTypes: [], target: 1, weight: 1 },
          ],
        },
      }),
    ).toThrow(/expression/);

    // affinity card missing people1
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          affinities: [{ uid: "a1", date: "d1", people2: [], shiftTypes: [], weight: 1 }],
        },
      }),
    ).toThrow(/people1/);

    // covering card missing preceptors
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          coverings: [{ uid: "v1", preceptees: [], shiftTypes: [], weight: 1 }],
        },
      }),
    ).toThrow(/preceptors/);

    // contracted-hours count card missing policy
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          counts: [
            {
              uid: "ch1",
              person: "p1",
              countDates: [],
              countShiftTypes: [],
              expression: "",
              target: 1,
              weight: 1,
              tag: "contracted_hours",
            },
          ],
        },
      }),
    ).toThrow(/policy/);

    // invalid count card tag value
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          counts: [
            {
              uid: "b1",
              person: "p1",
              countDates: [],
              countShiftTypes: [],
              expression: "",
              target: 1,
              weight: 1,
              tag: "bogus",
            },
          ],
        },
      }),
    ).toThrow(/tag/);
  });

  it("throws on export-layout rule malformation (empty rule objects and missing required fields)", () => {
    const emptyLayout = { formatting: [], extraColumns: [], extraRows: [] };

    // empty formatting rule object — no type discriminant
    expect(() =>
      sanitizePersistedScenario({ exportLayout: { ...emptyLayout, formatting: [{}] } }),
    ).toThrow(/type/);

    // "row" rule missing people array
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: { ...emptyLayout, formatting: [{ type: "row" }] },
      }),
    ).toThrow(/people/);

    // "column" rule missing dates array
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: { ...emptyLayout, formatting: [{ type: "column" }] },
      }),
    ).toThrow(/dates/);

    // "cell" rule missing shiftTypes
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: { ...emptyLayout, formatting: [{ type: "cell", people: [], dates: [] }] },
      }),
    ).toThrow(/shiftTypes/);

    // unknown formatting type
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: { ...emptyLayout, formatting: [{ type: "bogus" }] },
      }),
    ).toThrow(/type/);

    // extra column missing header
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          extraColumns: [{ type: "count", countShiftTypes: [], countDates: [] }],
        },
      }),
    ).toThrow(/header/);

    // extra row wrong type
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          extraRows: [{ type: "sum", header: "R", countShiftTypes: [], countPeople: [] }],
        },
      }),
    ).toThrow(/type/);
  });

  it("throws on entity optional field and group member type malformation", () => {
    // person with non-array history
    expect(() =>
      sanitizePersistedScenario({ staff: [{ id: "p1", history: "not array" }] }),
    ).toThrow(/history/);
    // person with non-string history entry
    expect(() => sanitizePersistedScenario({ staff: [{ id: "p1", history: [42] }] })).toThrow(
      /history/,
    );
    // shift with non-number durationMinutes
    expect(() =>
      sanitizePersistedScenario({ shifts: [{ id: "D", durationMinutes: "fast" }] }),
    ).toThrow(/durationMinutes/);
    // group with non-ref member
    expect(() =>
      sanitizePersistedScenario({ staffGroups: [{ id: "g1", members: [null] }] }),
    ).toThrow(/members/);
  });

  it("throws on coefficient tuple malformation", () => {
    const emptyLayout = { formatting: [], extraColumns: [], extraRows: [] };
    // entry[0] is an object, not a string
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          extraColumns: [
            {
              type: "count",
              header: "C",
              countShiftTypes: [],
              countDates: [],
              countShiftTypeCoefficients: [[{}, 1]],
            },
          ],
        },
      }),
    ).toThrow(/\[string, number\]/);
  });

  it("throws on number in a nested shift-type list (string-only)", () => {
    const emptyCards = {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    };
    // succession pattern has a number — NestedShiftTypeRefList is string-only
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          successions: [{ uid: "s1", person: "p1", pattern: [1], weight: 1 }],
        },
      }),
    ).toThrow(/string/);
    // affinity shiftTypes has a number
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          affinities: [
            { uid: "a1", date: "d1", people1: [], people2: [], shiftTypes: [1], weight: 1 },
          ],
        },
      }),
    ).toThrow(/string/);
    // affinity people1 with a number is OK (NestedPersonRefList allows number|string)
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          affinities: [
            { uid: "a2", date: "d1", people1: [1], people2: [], shiftTypes: [], weight: 1 },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("throws on numeric or nested count-card countShiftTypes (flat string-only)", () => {
    const emptyCards = {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    };
    // numeric countShiftTypes
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          counts: [
            {
              uid: "c1",
              person: "p1",
              countDates: [],
              countShiftTypes: [1],
              expression: "",
              target: 1,
              weight: 1,
            },
          ],
        },
      }),
    ).toThrow(/countShiftTypes entry must be a string/);
    // nested array in countShiftTypes
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          counts: [
            {
              uid: "c2",
              person: "p1",
              countDates: [],
              countShiftTypes: [["D"]],
              expression: "",
              target: 1,
              weight: 1,
            },
          ],
        },
      }),
    ).toThrow(/countShiftTypes entry must be a string/);
  });

  it("throws on export array element type and note/when malformation", () => {
    const emptyLayout = { formatting: [], extraColumns: [], extraRows: [] };
    // cell rule people array with {} element
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [{ type: "cell", people: [{}], dates: [], shiftTypes: [] }],
        },
      }),
    ).toThrow(/people.*string or number/);
    // cell rule note without text
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [{ type: "cell", people: [], dates: [], shiftTypes: [], note: {} }],
        },
      }),
    ).toThrow(/note/);
    // cell rule when with bad preference
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [
            {
              type: "cell",
              people: [],
              dates: [],
              shiftTypes: [],
              when: { preference: { types: ["bad"] } },
            },
          ],
        },
      }),
    ).toThrow(/types.*shift request/);
  });

  it("throws on count marker union violation (ordinary count with policy)", () => {
    const emptyCards = {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    };
    // ordinary count (no tag) with policy — forbidden
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          counts: [
            {
              uid: "o1",
              person: "p1",
              countDates: [],
              countShiftTypes: [],
              expression: "",
              target: 1,
              weight: 1,
              policy: "exact",
            },
          ],
        },
      }),
    ).toThrow(/policy.*contracted_hours/);
    // ordinary count with unit — also forbidden
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          ...emptyCards,
          counts: [
            {
              uid: "o2",
              person: "p1",
              countDates: [],
              countShiftTypes: [],
              expression: "",
              target: 1,
              weight: 1,
              unit: "hours",
            },
          ],
        },
      }),
    ).toThrow(/unit.*contracted_hours/);
  });

  it("throws on optional F2/export string-field type malformation (round-5 audit)", () => {
    const emptyLayout = { formatting: [], extraColumns: [], extraRows: [] };

    // entity / group _k must be a string
    expect(() => sanitizePersistedScenario({ staff: [{ id: "p1", _k: 42 }] })).toThrow(/_k/);
    expect(() => sanitizePersistedScenario({ shifts: [{ id: "D", _k: 42 }] })).toThrow(/_k/);
    expect(() =>
      sanitizePersistedScenario({ staffGroups: [{ id: "g1", members: [], _k: 42 }] }),
    ).toThrow(/_k/);

    // reqData uid / description must be strings
    expect(() =>
      sanitizePersistedScenario({
        reqData: [{ kind: "off", person: "p1", date: "d1", weight: 1, uid: 5 }],
      }),
    ).toThrow(/uid/);
    expect(() =>
      sanitizePersistedScenario({
        reqData: [{ kind: "off", person: "p1", date: "d1", weight: 1, description: 9 }],
      }),
    ).toThrow(/description/);

    // contracted-hours count unit must be a string
    expect(() =>
      sanitizePersistedScenario({
        cardsByKind: {
          requirements: [],
          successions: [],
          counts: [
            {
              uid: "ch1",
              person: "p1",
              countDates: [],
              countShiftTypes: [],
              expression: "",
              target: 1,
              weight: 1,
              tag: "contracted_hours",
              policy: "exact",
              unit: 42,
            },
          ],
          affinities: [],
          coverings: [],
        },
      }),
    ).toThrow(/unit/);

    // formatting rule base/cell/uid string fields
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [{ type: "row", people: [], description: 7 }],
        },
      }),
    ).toThrow(/description/);
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [{ type: "row", people: [], backgroundColor: 7 }],
        },
      }),
    ).toThrow(/backgroundColor/);
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [{ type: "cell", people: [], dates: [], shiftTypes: [], appendText: 7 }],
        },
      }),
    ).toThrow(/appendText/);
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [{ type: "row", people: [], uid: 7 }],
        },
      }),
    ).toThrow(/uid/);

    // extra column / row string fields
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          extraColumns: [
            { type: "count", header: "C", countShiftTypes: [], countDates: [], description: 7 },
          ],
        },
      }),
    ).toThrow(/description/);
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          extraColumns: [
            {
              type: "count",
              header: "C",
              countShiftTypes: [],
              countDates: [],
              rightBorderColor: 7,
            },
          ],
        },
      }),
    ).toThrow(/rightBorderColor/);
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          extraRows: [
            {
              type: "count",
              header: "R",
              countShiftTypes: [],
              countPeople: [],
              bottomBorderColor: 7,
            },
          ],
        },
      }),
    ).toThrow(/bottomBorderColor/);
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          extraRows: [{ type: "count", header: "R", countShiftTypes: [], countPeople: [], uid: 7 }],
        },
      }),
    ).toThrow(/uid/);

    // when.preference.requestShape must be a committed literal
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [
            {
              type: "cell",
              people: [],
              dates: [],
              shiftTypes: [],
              when: { preference: { types: ["shift request"], requestShape: ["bogus-shape"] } },
            },
          ],
        },
      }),
    ).toThrow(/request-shape/);
    // a valid committed requestShape literal is accepted
    expect(() =>
      sanitizePersistedScenario({
        exportLayout: {
          ...emptyLayout,
          formatting: [
            {
              type: "cell",
              people: [],
              dates: [],
              shiftTypes: [],
              when: { preference: { types: ["shift request"], requestShape: ["ALL"] } },
            },
          ],
        },
      }),
    ).not.toThrow();
  });
});

describe("in-memory storage double", () => {
  it("round-trips and snapshots", async () => {
    const mem = createMemoryStorage();
    expect(await mem.getItem("x")).toBeNull();
    await mem.setItem("x", "1");
    expect(await mem.getItem("x")).toBe("1");
    expect(mem.snapshot()).toEqual({ x: "1" });
    await mem.removeItem("x");
    expect(mem.snapshot()).toEqual({});
  });
});
