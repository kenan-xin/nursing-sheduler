import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import { PREFERENCE_TYPE, type ScenarioUiState } from "@/lib/scenario/types";

// A representative durable UI state exercising every slice and every F2 marker.
function makeUiState(): ScenarioUiState {
  return {
    meta: { apiVersion: "alpha", description: "Feb 2026 ward", country: "SG" },
    rangeStart: "2026-02-01",
    rangeEnd: "2026-02-28",
    staff: [
      { _k: "p0", id: 0, description: "Nurse 0", history: ["AM1", "OFF"] },
      { _k: "p1", id: 1, description: "Nurse 1" },
    ],
    staffGroups: [{ _k: "g0", id: "Seniors", members: [0, 1] }],
    shifts: [
      {
        _k: "s0",
        id: "AM1",
        description: "AM",
        durationMinutes: 420,
        startTime: "08:00",
        endTime: "15:00",
      },
      { _k: "s1", id: "LD", durationMinutes: 750 },
    ],
    shiftGroups: [{ _k: "sg0", id: "AM", members: ["AM1"] }],
    dateGroups: [{ _k: "d0", id: "week1", members: ["2026-02-01~2026-02-07"] }],
    cardsByKind: {
      requirements: [
        {
          uid: "cu1",
          applied: true,
          description: "One on LD every date",
          shiftType: "LD",
          requiredNumPeople: 1,
          qualifiedPeople: "Seniors",
          weight: -1,
        },
        // A disabled (guided-off) card is excluded entirely.
        { uid: "cu2", disabled: true, shiftType: "AM", requiredNumPeople: 1, weight: -1 },
      ],
      successions: [{ uid: "cu3", person: "ALL", pattern: [["N"], ["AM1"]], weight: -1 }],
      counts: [
        {
          uid: "cu4",
          description: "Monthly contracted hours",
          person: "ALL",
          countDates: "ALL",
          countShiftTypes: ["AM1", "LD", "LEAVE"],
          countShiftTypeCoefficients: [
            ["AM1", 16],
            ["LD", 25],
            ["LEAVE", 16],
          ],
          expression: "x = T",
          target: 320,
          // F2 contracted-hours markers → hoursContract.
          unit: "half",
          tag: "contracted_hours",
          policy: "exact",
          weight: Infinity,
        },
      ],
      affinities: [
        { uid: "cu5", date: "ALL", people1: [0], people2: [1], shiftTypes: [["AM1"]], weight: 1 },
      ],
      coverings: [
        { uid: "cu6", preceptors: [1], preceptees: [0], shiftTypes: [["LD"]], weight: 1 },
      ],
    },
    reqData: [
      { uid: "r1", person: 0, date: 10, kind: "leave", description: "Feb 10" },
      { uid: "r2", person: 0, date: 11, kind: "leave" },
      { uid: "r3", person: 1, date: 12, kind: "off", weight: 1 },
      { uid: "r4", person: 1, date: 13, kind: "request", shiftType: "AM1", weight: -2 },
    ],
    exportLayout: {
      formatting: [{ uid: "f1", type: "history header", backgroundColor: "#fefce8" }],
      extraColumns: [],
      extraRows: [],
    },
    maxOneShiftPerDay: { description: "structural" },
  };
}

describe("toCanonicalScenarioDocument", () => {
  it("reshapes slices into the canonical containers", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());

    expect(doc.apiVersion).toBe("alpha");
    expect(doc.description).toBe("Feb 2026 ward");
    expect(doc.country).toBe("SG");
    expect(doc.dates.range).toEqual({ startDate: "2026-02-01", endDate: "2026-02-28" });
    expect(doc.dates.groups).toEqual([{ id: "week1", members: ["2026-02-01~2026-02-07"] }]);
    expect(doc.people.items).toEqual([
      { id: 0, description: "Nurse 0", history: ["AM1", "OFF"] },
      { id: 1, description: "Nurse 1" },
    ]);
    expect(doc.people.groups).toEqual([{ id: "Seniors", members: [0, 1] }]);
    expect(doc.shiftTypes.groups).toEqual([{ id: "AM", members: ["AM1"] }]);
  });

  it("strips every F2-only field", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());
    const json = JSON.stringify(doc);
    // `_k`/`uid`/`disabled`/`applied`/`tag`/`kind` are UI-only; none survive.
    // (`unit` is intentionally NOT here — `hoursContract.unit` is a real backend
    // field; only the card's UI `unit` marker is dropped.)
    for (const marker of ['"_k"', '"uid"', '"disabled"', '"applied"', '"tag"', '"kind"']) {
      expect(json).not.toContain(marker);
    }
    // The card's UI unit marker ("half") is gone; the canonical unit is "half-hour".
    const count = doc.preferences.find((p) => p.type === "shift count");
    expect(count).toMatchObject({ hoursContract: { unit: "half-hour" } });
    expect(json).not.toContain('"half"');
  });

  it("never emits `dates.items` (backend auto-generates it)", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());
    expect("items" in doc.dates).toBe(false);
  });

  it("always emits the required max-one-shift-per-day preference first", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());
    expect(doc.preferences[0]).toEqual({
      type: PREFERENCE_TYPE.maxOneShiftPerDay,
      description: "structural",
    });
  });

  it("excludes disabled (guided-off) cards", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());
    const requirements = doc.preferences.filter(
      (p) => p.type === PREFERENCE_TYPE.shiftTypeRequirement,
    );
    expect(requirements).toHaveLength(1);
  });

  it("maps the contracted_hours marker to hoursContract", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());
    const count = doc.preferences.find((p) => p.type === PREFERENCE_TYPE.shiftCount);
    expect(count).toBeDefined();
    expect(count).toMatchObject({
      hoursContract: { unit: "half-hour", policy: "exact" },
      weight: Infinity,
    });
  });

  it("folds the matrix into shift requests, deriving selector+weight from kind", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());
    const requests = doc.preferences.filter((p) => p.type === PREFERENCE_TYPE.shiftRequest);
    expect(requests).toEqual([
      // leave → hard LEAVE pin (weight derived, not authored)
      {
        type: PREFERENCE_TYPE.shiftRequest,
        description: "Feb 10",
        person: 0,
        date: 10,
        shiftType: "LEAVE",
        weight: Infinity,
      },
      {
        type: PREFERENCE_TYPE.shiftRequest,
        person: 0,
        date: 11,
        shiftType: "LEAVE",
        weight: Infinity,
      },
      // off → OFF selector, soft authored weight
      { type: PREFERENCE_TYPE.shiftRequest, person: 1, date: 12, shiftType: "OFF", weight: 1 },
      // request → authored worked shift + signed weight
      { type: PREFERENCE_TYPE.shiftRequest, person: 1, date: 13, shiftType: "AM1", weight: -2 },
    ]);
  });

  it("rejects a request cell that carries a direct OFF/LEAVE day-state (kind is the sole authority)", () => {
    const state = createEmptyScenarioUiState();
    state.rangeStart = "2026-02-01";
    state.rangeEnd = "2026-02-28";
    state.staff = [{ id: 0 }];
    // The type permits any string selector on a request cell, but the projection
    // must refuse to serialize a direct day-state as a worked-shift request.
    for (const dayState of ["LEAVE", "OFF"]) {
      state.reqData = [{ person: 0, date: 10, kind: "request", shiftType: dayState, weight: -7 }];
      expect(() => toCanonicalScenarioDocument(state)).toThrow(/reserved day-state/);
    }
  });

  it("allows ALL and worked selectors on a request cell", () => {
    const state = createEmptyScenarioUiState();
    state.rangeStart = "2026-02-01";
    state.rangeEnd = "2026-02-28";
    state.staff = [{ id: 0 }];
    // `shiftType: ALL` is a backend-valid "work any shift" worked-day request.
    for (const selector of ["ALL", "AM1", "AM"]) {
      state.reqData = [{ person: 0, date: 10, kind: "request", shiftType: selector, weight: -7 }];
      expect(() => toCanonicalScenarioDocument(state)).not.toThrow();
    }
    state.reqData = [{ person: 0, date: 10, kind: "request", shiftType: "ALL", weight: -7 }];
    const doc = toCanonicalScenarioDocument(state);
    const request = doc.preferences.find((p) => p.type === PREFERENCE_TYPE.shiftRequest);
    expect(request).toMatchObject({ shiftType: "ALL", weight: -7 });
  });

  it("strips uid from export rows and keeps the canonical rule", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());
    expect(doc.export?.formatting).toEqual([
      { type: "history header", backgroundColor: "#fefce8" },
    ]);
    expect(doc.export?.extraColumns).toBeUndefined();
  });

  it("omits empty group collections and an empty export layout", () => {
    const empty = createEmptyScenarioUiState();
    empty.rangeStart = "2026-02-01";
    empty.rangeEnd = "2026-02-28";
    empty.staff = [{ id: 0 }];
    const doc = toCanonicalScenarioDocument(empty);

    expect(doc.people.groups).toBeUndefined();
    expect(doc.shiftTypes.groups).toBeUndefined();
    expect(doc.dates.groups).toBeUndefined();
    expect(doc.export).toBeUndefined();
    // Only the structural preference survives.
    expect(doc.preferences).toEqual([{ type: PREFERENCE_TYPE.maxOneShiftPerDay }]);
  });

  it("is deterministic and side-effect-free across repeated runs", () => {
    const state = makeUiState();
    const a = toCanonicalScenarioDocument(state);
    const b = toCanonicalScenarioDocument(state);
    expect(a).toEqual(b);
    // Input untouched.
    expect(state.cardsByKind.counts[0].tag).toBe("contracted_hours");
  });

  it("preserves array order of items and preferences", () => {
    const doc = toCanonicalScenarioDocument(makeUiState());
    expect(doc.people.items.map((p) => p.id)).toEqual([0, 1]);
    expect(doc.shiftTypes.items.map((s) => s.id)).toEqual(["AM1", "LD"]);
  });
});

describe("createEmptyScenarioUiState", () => {
  it("builds a well-formed zero value that projects without throwing", () => {
    const empty = createEmptyScenarioUiState();
    expect(empty.meta.apiVersion).toBe("alpha");
    expect(empty.reqData).toEqual([]);
    expect(() => toCanonicalScenarioDocument(empty)).not.toThrow();
  });

  it("honours a custom apiVersion", () => {
    expect(createEmptyScenarioUiState("v2").meta.apiVersion).toBe("v2");
  });
});
