import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { applyDelete, applyRename, deleteEntity, RenameCollisionError, renameEntity } from ".";

// A rich fixture exercising every reference surface: items + nested groups, all
// five card kinds (with coefficient tuples), the matrix (request/leave/off cells),
// people history, and every Export Layout row kind (person/date/cell/history-header
// formatting, an extra count column, an extra count row).
function fixture(): ScenarioUiState {
  const state = createEmptyScenarioUiState("alpha");
  state.rangeStart = "2026-05-14";
  state.rangeEnd = "2026-05-20";
  state.staff = [{ id: "P1", history: ["N", "D"] }, { id: "P2" }, { id: "P3" }];
  state.staffGroups = [
    { id: "TeamA", members: ["P1", "P2"] },
    { id: "TeamB", members: ["TeamA", "P3"] }, // nested: references the group TeamA
  ];
  state.shifts = [{ id: "D" }, { id: "N" }, { id: "E" }];
  state.shiftGroups = [{ id: "SG1", members: ["D", "N"] }];
  state.dateGroups = [
    { id: "WKND", members: ["2026-05-16", "2026-05-17"] },
    { id: "BOTH", members: ["WKND", "2026-05-14"] }, // nested: references the group WKND
  ];
  state.maxOneShiftPerDay = { description: "one per day" };
  state.cardsByKind = {
    requirements: [
      {
        uid: "r1",
        shiftType: "D",
        requiredNumPeople: 1,
        qualifiedPeople: ["P1", "P2"],
        date: ["2026-05-14"],
        shiftTypeCoefficients: [["D", 2]],
        weight: -1,
      },
    ],
    successions: [
      { uid: "s1", person: ["P1"], pattern: [["N", "D"]], date: ["2026-05-14"], weight: 1 },
    ],
    counts: [
      {
        uid: "cnt1",
        person: ["P1"],
        countDates: ["2026-05-14"],
        countShiftTypes: ["N"],
        countShiftTypeCoefficients: [["N", 1]],
        expression: ">=",
        target: 2,
        weight: 1,
      },
    ],
    affinities: [
      {
        uid: "a1",
        date: ["2026-05-14", "WKND"], // references a concrete date AND a date group
        people1: ["P1"],
        people2: ["P2"],
        shiftTypes: ["D"],
        weight: 1,
      },
    ],
    coverings: [
      {
        uid: "cov1",
        date: ["2026-05-14"],
        preceptors: ["P1"],
        preceptees: ["P2"],
        shiftTypes: ["D"],
        weight: Infinity,
      },
    ],
  };
  state.reqData = [
    { uid: "c1", kind: "request", person: "P1", date: "2026-05-14", shiftType: "D", weight: 2 },
    { uid: "c2", kind: "leave", person: "P1", date: "2026-05-15" },
    { uid: "c3", kind: "off", person: "P2", date: "2026-05-16", weight: 1 },
  ];
  state.exportLayout = {
    formatting: [
      { uid: "f1", type: "row", people: ["P1"] },
      { uid: "f2", type: "column", dates: ["2026-05-14"] },
      { uid: "f3", type: "cell", people: ["P1"], dates: ["2026-05-14"], shiftTypes: ["D"] },
      { uid: "f4", type: "history header" },
    ],
    extraColumns: [
      {
        uid: "ec1",
        type: "count",
        header: "N count",
        countShiftTypes: ["N"],
        countShiftTypeCoefficients: [["N", 1]],
        countDates: ["2026-05-14", "WKND"], // concrete date AND a date group
      },
    ],
    extraRows: [
      { uid: "er1", type: "count", header: "P1 row", countShiftTypes: ["D"], countPeople: ["P1"] },
    ],
  };
  return state;
}

/** Deep-scan every string in the state for a stray id. */
function jsonHas(state: ScenarioUiState, id: string): boolean {
  return JSON.stringify(state).includes(`"${id}"`);
}

describe("renameEntity — rewrites everywhere (spec 06 FR-RI-03..07)", () => {
  it("person rename P1→PX rewrites items, group members, cards, matrix, export — no stray P1", () => {
    const before = fixture();
    const snapshot = structuredClone(before);
    const after = renameEntity(before, "person", "P1", "PX");

    expect(after.staff[0].id).toBe("PX");
    expect(after.staffGroups[0].members).toEqual(["PX", "P2"]);
    expect(after.cardsByKind.requirements[0].qualifiedPeople).toEqual(["PX", "P2"]);
    expect(after.cardsByKind.successions[0].person).toEqual(["PX"]);
    expect(after.cardsByKind.counts[0].person).toEqual(["PX"]);
    expect(after.cardsByKind.affinities[0].people1).toEqual(["PX"]);
    expect(after.cardsByKind.coverings[0].preceptors).toEqual(["PX"]);
    expect(after.reqData[0].person).toBe("PX");
    expect(after.reqData[1].person).toBe("PX");
    const rowRule = after.exportLayout.formatting[0];
    expect("people" in rowRule && rowRule.people).toEqual(["PX"]);
    expect(after.exportLayout.extraRows[0].countPeople).toEqual(["PX"]);
    // history is shift-type only — a person rename must not touch it (FR-RI-04)
    expect(after.staff[0].history).toEqual(["N", "D"]);
    // No stray old id anywhere; input untouched (atomic/pure)
    expect(jsonHas(after, "P1")).toBe(false);
    expect(before).toEqual(snapshot);
  });

  it("shift-type rename N→Night rewrites selectors, coefficients, history, export", () => {
    const after = renameEntity(fixture(), "shift", "N", "Night");
    expect(after.shifts[1].id).toBe("Night");
    expect(after.shiftGroups[0].members).toEqual(["D", "Night"]);
    expect(after.cardsByKind.counts[0].countShiftTypes).toEqual(["Night"]);
    expect(after.cardsByKind.counts[0].countShiftTypeCoefficients).toEqual([["Night", 1]]);
    expect(after.cardsByKind.successions[0].pattern).toEqual([["Night", "D"]]);
    expect(after.staff[0].history).toEqual(["Night", "D"]); // FR-RI-04/AC-RI-01
    expect(after.exportLayout.extraColumns[0].countShiftTypes).toEqual(["Night"]);
    expect(after.exportLayout.extraColumns[0].countShiftTypeCoefficients).toEqual([["Night", 1]]);
    expect(jsonHas(after, "N")).toBe(false);
  });

  it("shift rename normalizes absent history to [] on every person (FR-RI-04)", () => {
    const after = renameEntity(fixture(), "shift", "D", "Day");
    expect(after.staff[0].history).toEqual(["N", "Day"]); // existing history rewritten
    expect(after.staff[1].history).toEqual([]); // P2 had no history → normalized to []
    expect(after.staff[2].history).toEqual([]); // P3 likewise
  });

  it("date-group rename rewrites the group def, nested members, card dates + export", () => {
    // Dates come from the range (no renameable date *items*), so a date-domain
    // rename targets a date *group* — its id, nested members, and every reference.
    const after = renameEntity(fixture(), "date", "WKND", "Vacation");
    expect(after.dateGroups[0].id).toBe("Vacation");
    expect(after.dateGroups[1].members).toEqual(["Vacation", "2026-05-14"]); // nested ref
    expect(after.cardsByKind.affinities[0].date).toEqual(["2026-05-14", "Vacation"]);
    expect(after.exportLayout.extraColumns[0].countDates).toEqual(["2026-05-14", "Vacation"]);
    expect(after.reqData[0].date).toBe("2026-05-14"); // a concrete date ref is untouched
  });

  it("group rename cascades like an item id (AC-RI-13) incl. nested group members", () => {
    // A people-group rename uses the "person" domain (its reference namespace).
    const after = renameEntity(fixture(), "person", "TeamA", "TeamZ");
    expect(after.staffGroups[0].id).toBe("TeamZ");
    expect(after.staffGroups[1].members).toEqual(["TeamZ", "P3"]); // nested ref rewritten
  });
});

describe("deleteEntity — cascade + prune emptied preferences (findings #3/#4)", () => {
  it("deleting the sole preceptor of a covering prunes the covering card", () => {
    const after = deleteEntity(fixture(), "person", "P1");
    expect(after.cardsByKind.coverings).toHaveLength(0);
  });

  it("deleting the sole People-1 of an affinity prunes the affinity card", () => {
    const after = deleteEntity(fixture(), "person", "P1");
    expect(after.cardsByKind.affinities).toHaveLength(0);
  });

  it("deleting a person cascades: items, group members, matrix cells, cards, export", () => {
    const after = deleteEntity(fixture(), "person", "P1");
    expect(after.staff.map((p) => p.id)).toEqual(["P2", "P3"]);
    expect(after.staffGroups[0].members).toEqual(["P2"]); // emptied? no — still has P2
    // matrix cells referencing P1 dropped (request c1 + leave c2), off c3 (P2) kept
    expect(after.reqData.map((c) => c.uid)).toEqual(["c3"]);
    // requirement qualifiedPeople ["P1","P2"] → ["P2"], still non-empty → survives
    expect(after.cardsByKind.requirements[0].qualifiedPeople).toEqual(["P2"]);
    // successions.person ["P1"] → [] → dropped
    expect(after.cardsByKind.successions).toHaveLength(0);
    // export: person "row" rule (people [P1]→[]) dropped; cell rule (people emptied) dropped
    const formattingUids = after.exportLayout.formatting.map((r) => r.uid);
    expect(formattingUids).toEqual(["f2", "f4"]); // date rule + history-header survive
    expect(after.exportLayout.extraRows).toHaveLength(0); // countPeople emptied
    expect(jsonHas(after, "P1")).toBe(false);
  });

  it("deleting a shift type blanks history positionally and prunes emptied cards/export", () => {
    const after = deleteEntity(fixture(), "shift", "N");
    expect(after.staff[0].history).toEqual(["", "D"]); // FR-RI-09/AC-RI-06
    expect(after.shiftGroups[0].members).toEqual(["D"]);
    // count card: countShiftTypes ["N"]→[] → dropped; its coefficient tuple gone too
    expect(after.cardsByKind.counts).toHaveLength(0);
    // succession pattern [["N","D"]] → [["D"]] → still non-empty → survives
    expect(after.cardsByKind.successions[0].pattern).toEqual([["D"]]);
    // extra column countShiftTypes emptied → dropped
    expect(after.exportLayout.extraColumns).toHaveLength(0);
  });

  it("deleting a group removes its definition and prunes it from nested groups", () => {
    const after = deleteEntity(fixture(), "person", "TeamA");
    expect(after.staffGroups.map((g) => g.id)).toEqual(["TeamB"]);
    expect(after.staffGroups[0].members).toEqual(["P3"]); // TeamA pruned from TeamB
  });

  it("deleting all covering dates omits the field (all-dates), not date: [] (DL08)", () => {
    // Covering date ["2026-05-14"] is the only date → delete it → omitted.
    const after = deleteEntity(fixture(), "date", "2026-05-14");
    expect(after.cardsByKind.coverings).toHaveLength(1); // date is optional → not dropped
    expect(after.cardsByKind.coverings[0].date).toBeUndefined();
    // requirement date ["2026-05-14"]→[] is required → requirement dropped
    expect(after.cardsByKind.requirements).toHaveLength(0);
  });
});

describe("reference identity is exact — producer-distinct numeric vs string ids", () => {
  // T18 `PersonId`/`ShiftTypeId` = `number | string`; the producer's duplicate
  // checks and `build_shift_type_index_map` key by the RAW id (exact/SameValueZero),
  // so `1` and `"1"` legitimately coexist as distinct ids and must never collapse.
  function numericStringState(): ScenarioUiState {
    const state = createEmptyScenarioUiState("alpha");
    state.rangeStart = "2026-05-14";
    state.rangeEnd = "2026-05-20";
    state.staff = [{ id: 1 }, { id: "1" }];
    state.staffGroups = [{ id: "G", members: [1, "1"] }];
    state.reqData = [
      { uid: "c1", kind: "off", person: 1, date: "2026-05-14", weight: 1 },
      { uid: "c2", kind: "off", person: "1", date: "2026-05-14", weight: 1 },
    ];
    return state;
  }

  it('deleting numeric id 1 leaves the distinct string id "1" intact', () => {
    const after = deleteEntity(numericStringState(), "person", 1);
    expect(after.staff).toEqual([{ id: "1" }]); // only numeric-1 removed
    expect(after.staffGroups[0].members).toEqual(["1"]); // only numeric-1 pruned
    expect(after.reqData.map((c) => c.uid)).toEqual(["c2"]); // only person===1 cell dropped
  });

  it('renaming numeric id 1 → string "1" THROWS item↔item collision (not self-no-op)', () => {
    const state = numericStringState();
    const snapshot = structuredClone(state);
    expect(() => renameEntity(state, "person", 1, "1")).toThrow(RenameCollisionError);
    expect(state).toEqual(snapshot); // atomic
  });
});

describe("rename collision — reject, state unchanged (finding #5)", () => {
  let state: ScenarioUiState;
  beforeEach(() => {
    state = fixture();
  });

  it("item↔item collision throws (duplicate-item)", () => {
    const snapshot = structuredClone(state);
    expect(() => renameEntity(state, "person", "P1", "P2")).toThrow(RenameCollisionError);
    expect(state).toEqual(snapshot); // atomic — untouched
  });

  it("item↔group collision throws (duplicate-group)", () => {
    expect(() => renameEntity(state, "person", "P1", "TeamA")).toThrow(RenameCollisionError);
    try {
      renameEntity(state, "person", "P1", "TeamA");
    } catch (err) {
      expect((err as RenameCollisionError).reason).toBe("duplicate-group");
    }
  });

  it("reserved-keyword target throws, case-insensitively, per domain", () => {
    expect(() => renameEntity(state, "shift", "N", "off")).toThrow(RenameCollisionError); // OFF reserved
    expect(() => renameEntity(state, "person", "P1", "all")).toThrow(RenameCollisionError); // ALL reserved
    expect(() => renameEntity(state, "date", "WKND", "weekend")).toThrow(RenameCollisionError);
    // A shift-domain reserved keyword is NOT reserved for people (domain-scoped).
    expect(() => renameEntity(state, "person", "P1", "OFF")).not.toThrow();
  });

  it("date-group rename to a concrete-date literal is rejected (producer authority)", () => {
    expect(() => renameEntity(state, "date", "WKND", "2026-05-14")).toThrow(RenameCollisionError);
    expect(() => renameEntity(state, "date", "WKND", "15")).toThrow(RenameCollisionError);
  });

  it("rename-to-self is a no-op (not a collision)", () => {
    expect(renameEntity(state, "person", "P1", "P1")).toBe(state);
  });

  it("rejects a non-string (numeric) rename target — no unserializable numeric leak", () => {
    // A new id is always an authored string; a numeric target would leak a number
    // into a string-typed selector and later fail serialization. Typed away AND
    // guarded at runtime.
    // @ts-expect-error — `newId` is typed `string`; this proves the type-level ban.
    expect(() => renameEntity(state, "shift", "D", 1)).toThrow(RenameCollisionError);
    expect(state).toEqual(fixture()); // atomic — untouched
  });

  it("applyRename / applyDelete are aliases", () => {
    expect(applyRename).toBe(renameEntity);
    expect(applyDelete).toBe(deleteEntity);
  });
});
