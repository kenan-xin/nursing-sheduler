import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  RESERVED_SHIFT_TYPE,
  type ScenarioUiState,
  type UiPerson,
  type UiShiftType,
} from "@/lib/scenario";
import { RenameCollisionError } from "@/lib/cascade";
import type { EntityDescriptor } from "./descriptor";
import {
  addGroup,
  addItem,
  deleteGroup,
  deleteItem,
  duplicateGroup,
  duplicateItem,
  reorderGroups,
  reorderItems,
  reorderByUpload,
  renameGroup,
  renameItem,
  setGroupMembers,
  toggleGroupMembership,
  updateGroupFields,
  updateItemFields,
} from "./mutations";

// --- Test descriptors (mirror the real wrappers, kept inline for isolation) ---

function peopleDescriptor(): EntityDescriptor<UiPerson> {
  return {
    domain: "person",
    labels: {
      item: "Person",
      itemPlural: "People",
      itemLower: "person",
      itemPluralLower: "people",
    },
    reservedKeywords: [RESERVED_SHIFT_TYPE.all],
    supportsWorkingTime: false,
    readItems: (s) => s.staff,
    readGroups: (s) => s.staffGroups,
    writeState: (s, patch) => ({
      ...s,
      staff: patch.items ?? s.staff,
      staffGroups: patch.groups ?? s.staffGroups,
    }),
    createItem: ({ id, description }) => ({ id, description, history: [] }),
    syntheticItems: [],
    syntheticGroups: [{ id: RESERVED_SHIFT_TYPE.all }],
  };
}

function shiftDescriptor(): EntityDescriptor<UiShiftType> {
  return {
    domain: "shift",
    labels: {
      item: "Shift Type",
      itemPlural: "Shift Types",
      itemLower: "shift type",
      itemPluralLower: "shift types",
    },
    reservedKeywords: [RESERVED_SHIFT_TYPE.all, RESERVED_SHIFT_TYPE.off, RESERVED_SHIFT_TYPE.leave],
    supportsWorkingTime: true,
    readItems: (s) => s.shifts,
    readGroups: (s) => s.shiftGroups,
    writeState: (s, patch) => ({
      ...s,
      shifts: patch.items ?? s.shifts,
      shiftGroups: patch.groups ?? s.shiftGroups,
    }),
    createItem: ({ id, description }) => ({ id, description }),
    syntheticItems: [{ id: RESERVED_SHIFT_TYPE.off }, { id: RESERVED_SHIFT_TYPE.leave }],
    syntheticGroups: [{ id: RESERVED_SHIFT_TYPE.all }],
  };
}

function fixture(): ScenarioUiState {
  const state = createEmptyScenarioUiState("alpha");
  state.rangeStart = "2026-05-14";
  state.rangeEnd = "2026-05-20";
  state.staff = [{ id: "P1" }, { id: "P2" }, { id: "P3" }];
  state.staffGroups = [{ id: "TeamA", members: ["P3", "P1"] }]; // out of item order
  state.shifts = [
    { id: "D", startTime: "08:00", endTime: "16:00", durationMinutes: 480 },
    { id: "N" },
  ];
  state.shiftGroups = [{ id: "AllWork", members: ["N", "D"] }];
  return state;
}

describe("addItem / updateItemFields", () => {
  it("appends a person with a fresh history [] (DL10: no role/seniority field)", () => {
    const after = addItem(fixture(), peopleDescriptor(), { id: "P4", description: "Nurse D" });
    expect(after.staff.map((p) => p.id)).toEqual(["P1", "P2", "P3", "P4"]);
    expect(after.staff[3]).toEqual({ id: "P4", description: "Nurse D", history: [] });
    // No role/seniority field is authored (seniority lives in groups + coverings).
    expect(after.staff[3]).not.toHaveProperty("role");
    expect(after.staff[3]).not.toHaveProperty("seniority");
  });

  it("merges shift-type working-time extra over the created base", () => {
    const after = addItem(fixture(), shiftDescriptor(), {
      id: "E",
      extra: { startTime: "07:00", endTime: "15:00", durationMinutes: 480 },
    });
    expect(after.shifts.map((s) => s.id)).toEqual(["D", "N", "E"]);
    expect(after.shifts[2]).toMatchObject({ id: "E", startTime: "07:00", durationMinutes: 480 });
  });

  it("addItem extra is merged UNDER the base so descriptor-owned id/description win (NEW MAJOR 4)", () => {
    // A caller forces id/description into extra — the descriptor base must win.
    const after = addItem(fixture(), shiftDescriptor(), {
      id: "E",
      description: "Real",
      extra: {
        id: "HACK",
        description: "HACK",
        startTime: "07:00",
      } as unknown as Omit<Partial<UiShiftType>, "id" | "description">,
    });
    const item = after.shifts.at(-1)!;
    expect(item.id).toBe("E"); // not "HACK"
    expect(item.description).toBe("Real"); // not "HACK"
    expect(item.startTime).toBe("07:00"); // domain field from extra preserved
  });

  it("updateItemFields rejects a runtime id patch (must use renameItem for the cascade)", () => {
    expect(() =>
      updateItemFields(fixture(), peopleDescriptor(), "P1", {
        id: "PX",
      } as unknown as Omit<Partial<UiPerson>, "id">),
    ).toThrow(/renameItem/i);
  });

  it("updateItemFields updates description and is a no-op when unchanged", () => {
    const before = fixture();
    const same = updateItemFields(before, peopleDescriptor(), "P1", { description: undefined });
    expect(same).toBe(before); // same reference → no zundo entry
    const after = updateItemFields(before, peopleDescriptor(), "P1", { description: "Alice" });
    expect(after.staff[0].description).toBe("Alice");
    expect(after).not.toBe(before);
  });

  it("updateItemFields on a shift preserves working-time fields it does not touch", () => {
    const after = updateItemFields(fixture(), shiftDescriptor(), "D", { description: "Day" });
    expect(after.shifts[0]).toEqual({
      id: "D",
      description: "Day",
      startTime: "08:00",
      endTime: "16:00",
      durationMinutes: 480,
    });
  });
});

describe("reorderItems", () => {
  it("moves an item and re-sorts group members to match the new item order", () => {
    const after = reorderItems(fixture(), peopleDescriptor(), 0, 2); // P1 → end
    expect(after.staff.map((p) => p.id)).toEqual(["P2", "P3", "P1"]);
    // TeamA was [P3, P1]; item order now [P2,P3,P1] → members sorted [P3, P1]
    expect(after.staffGroups[0].members).toEqual(["P3", "P1"]);
  });

  it("re-sorts a group whose members change relative order after a reorder", () => {
    const after = reorderItems(fixture(), peopleDescriptor(), 2, 0); // P3 → front
    expect(after.staff.map((p) => p.id)).toEqual(["P3", "P1", "P2"]);
    // TeamA [P3,P1] sorted by [P3,P1,P2] → [P3,P1] (P3 now first)
    expect(after.staffGroups[0].members).toEqual(["P3", "P1"]);
  });

  it("is a no-op for an out-of-range or same-index move", () => {
    const before = fixture();
    expect(reorderItems(before, peopleDescriptor(), 1, 1)).toBe(before);
    expect(reorderItems(before, peopleDescriptor(), -1, 0)).toBe(before);
    expect(reorderItems(before, peopleDescriptor(), 0, 99)).toBe(before);
  });
});

describe("reorderGroups (FR-ED-19..21)", () => {
  it("moves a group within the groups list", () => {
    const state = fixture();
    state.staffGroups = [
      { id: "A", members: [] },
      { id: "B", members: [] },
      { id: "C", members: [] },
    ];
    const after = reorderGroups(state, peopleDescriptor(), 0, 2); // A → end
    expect(after.staffGroups.map((g) => g.id)).toEqual(["B", "C", "A"]);
  });

  it("is a no-op for an out-of-range or same-index move (same reference)", () => {
    const state = fixture();
    state.staffGroups = [
      { id: "A", members: [] },
      { id: "B", members: [] },
    ];
    expect(reorderGroups(state, peopleDescriptor(), 1, 1)).toBe(state);
    expect(reorderGroups(state, peopleDescriptor(), -1, 0)).toBe(state);
    expect(reorderGroups(state, peopleDescriptor(), 0, 99)).toBe(state);
  });
});

describe("duplicateItem (findings #8, spec 03 duplicate labeling)", () => {
  it("creates '{id} copy' inserted after the source", () => {
    const after = duplicateItem(fixture(), peopleDescriptor(), "P1");
    expect(after.staff.map((p) => p.id)).toEqual(["P1", "P1 copy", "P2", "P3"]);
  });

  it("a second duplicate gets '{id} copy 2' (each copy inserts right after the source)", () => {
    let after = duplicateItem(fixture(), peopleDescriptor(), "P1");
    after = duplicateItem(after, peopleDescriptor(), "P1");
    // Both copies insert immediately after P1, so the newer one lands above the first.
    expect(after.staff.map((p) => p.id)).toEqual(["P1", "P1 copy 2", "P1 copy", "P2", "P3"]);
  });

  it("duplicated person starts with a fresh empty history", () => {
    const state = fixture();
    state.staff[0].history = ["N", "D"];
    const after = duplicateItem(state, peopleDescriptor(), "P1");
    expect(after.staff[1]).toEqual({ id: "P1 copy", description: undefined, history: [] });
  });

  it("duplicated shift preserves working-time fields", () => {
    const after = duplicateItem(fixture(), shiftDescriptor(), "D");
    expect(after.shifts[1]).toMatchObject({
      id: "D copy",
      startTime: "08:00",
      endTime: "16:00",
      durationMinutes: 480,
    });
  });

  it("strips a prior 'copy' suffix so a duplicate of a copy is not 'copy copy'", () => {
    const state = fixture();
    state.staff = [{ id: "Alice copy" }];
    const after = duplicateItem(state, peopleDescriptor(), "Alice copy");
    expect(after.staff.map((p) => p.id)).toEqual(["Alice copy", "Alice copy 2"]);
  });

  it("inserts the new id into every group containing the source, after the source (FR-ED-16)", () => {
    // TeamA members [P3, P1] — duplicating P1 inserts "P1 copy" right after P1.
    const after = duplicateItem(fixture(), peopleDescriptor(), "P1");
    expect(after.staffGroups[0].members).toEqual(["P3", "P1", "P1 copy"]);
  });

  it("group inheritance uses EXACT identity — numeric 1 vs string '1' never cross-insert", () => {
    const state = fixture();
    state.staff = [{ id: 1 }, { id: "1" }];
    state.staffGroups = [{ id: "G", members: [1, "1"] }];
    // Duplicating numeric 1 inserts its copy only after the numeric member.
    const after = duplicateItem(state, peopleDescriptor(), 1);
    expect(after.staffGroups[0].members).toEqual([1, "1 copy", "1"]);
    // The string "1" row is untouched and still distinct in the item list.
    expect(after.staff.map((p) => p.id)).toEqual([1, "1 copy", "1"]);
  });
});

describe("renameItem / deleteItem route through the T07 cascade", () => {
  it("rename rewrites the id and cascades into group members", () => {
    const after = renameItem(fixture(), peopleDescriptor(), "P1", "PX");
    expect(after.staff[0].id).toBe("PX");
    expect(after.staffGroups[0].members).toEqual(["P3", "PX"]);
  });

  it("rename to a reserved keyword throws RenameCollisionError, state untouched", () => {
    const before = fixture();
    const snapshot = structuredClone(before);
    expect(() => renameItem(before, peopleDescriptor(), "P1", "ALL")).toThrow(RenameCollisionError);
    expect(before).toEqual(snapshot);
  });

  it("delete cascades: removes the item and prunes it from group members", () => {
    const after = deleteItem(fixture(), peopleDescriptor(), "P1");
    expect(after.staff.map((p) => p.id)).toEqual(["P2", "P3"]);
    expect(after.staffGroups[0].members).toEqual(["P3"]);
  });
});

describe("group CRUD", () => {
  it("addGroup appends an empty group", () => {
    const after = addGroup(fixture(), peopleDescriptor(), { id: "TeamB" });
    expect(after.staffGroups.map((g) => g.id)).toEqual(["TeamA", "TeamB"]);
    expect(after.staffGroups[1].members).toEqual([]);
  });

  it("updateGroupFields updates description and is a no-op when unchanged", () => {
    const before = fixture();
    expect(updateGroupFields(before, peopleDescriptor(), "TeamA", { description: undefined })).toBe(
      before,
    );
    const after = updateGroupFields(before, peopleDescriptor(), "TeamA", {
      description: "Alpha team",
    });
    expect(after.staffGroups[0].description).toBe("Alpha team");
  });

  it("duplicateGroup copies members and labels '{id} copy' (finding #8)", () => {
    const after = duplicateGroup(fixture(), peopleDescriptor(), "TeamA");
    expect(after.staffGroups.map((g) => g.id)).toEqual(["TeamA", "TeamA copy"]);
    expect(after.staffGroups[1].members).toEqual(["P3", "P1"]);
  });

  it("deleteGroup removes the group definition", () => {
    const after = deleteGroup(fixture(), peopleDescriptor(), "TeamA");
    expect(after.staffGroups).toHaveLength(0);
  });

  it("renameGroup cascades the id through nested group members", () => {
    const state = fixture();
    state.staffGroups.push({ id: "Outer", members: ["TeamA", "P2"] });
    const after = renameGroup(state, peopleDescriptor(), "TeamA", "TeamZ");
    expect(after.staffGroups[0].id).toBe("TeamZ");
    expect(after.staffGroups[1].members).toEqual(["TeamZ", "P2"]);
  });

  it("renameGroup to a reserved keyword throws", () => {
    expect(() => renameGroup(fixture(), peopleDescriptor(), "TeamA", "all")).toThrow(
      RenameCollisionError,
    );
  });
});

describe("setGroupMembers (transfer list)", () => {
  it("replaces membership and sorts members by item order (selection order not kept)", () => {
    const after = setGroupMembers(fixture(), peopleDescriptor(), "TeamA", ["P1", "P3"]);
    expect(after.staffGroups[0].members).toEqual(["P1", "P3"]); // item order
    // selection order reversed → still item order
    const after2 = setGroupMembers(fixture(), peopleDescriptor(), "TeamA", ["P3", "P1"]);
    expect(after2.staffGroups[0].members).toEqual(["P1", "P3"]);
  });

  it("keeps unknown member ids (e.g. a nested group id) trailing in original order", () => {
    const after = setGroupMembers(fixture(), peopleDescriptor(), "TeamA", ["Outer", "P1"]);
    expect(after.staffGroups[0].members).toEqual(["P1", "Outer"]);
  });

  it("is a no-op when the membership set is unchanged (same reference returned)", () => {
    const before = fixture();
    before.staffGroups[0].members = ["P1", "P3"]; // already in item order
    expect(setGroupMembers(before, peopleDescriptor(), "TeamA", ["P3", "P1"])).toBe(before);
  });
});

describe("toggleGroupMembership (live membership toggle)", () => {
  it("adds a member in item order (exact identity)", () => {
    const after = toggleGroupMembership(fixture(), peopleDescriptor(), "TeamA", "P2");
    // TeamA was [P3, P1]; adding P2 → re-sorted to [P1, P2, P3].
    expect(after.staffGroups[0].members).toEqual(["P1", "P2", "P3"]);
  });

  it("removes a member (exact identity)", () => {
    const after = toggleGroupMembership(fixture(), peopleDescriptor(), "TeamA", "P1");
    expect(after.staffGroups[0].members).toEqual(["P3"]);
  });

  it("toggles numeric vs string ids distinctly", () => {
    const state = fixture();
    state.staff = [{ id: 1 }, { id: "1" }];
    state.staffGroups = [{ id: "G", members: [1] }];
    // Toggling string "1" into a group that has numeric 1 → both present.
    const after = toggleGroupMembership(state, peopleDescriptor(), "G", "1");
    expect(after.staffGroups[0].members).toEqual([1, "1"]);
  });
});

describe("reorderByUpload (People bulk upload, FR-ED-31)", () => {
  it("reorders existing to file order, inserts new in order, appends unmentioned trailing", () => {
    const state = fixture(); // staff [P1, P2, P3]
    const result = reorderByUpload(state, peopleDescriptor(), ["P3", "P4", "P1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.staff.map((p) => p.id)).toEqual(["P3", "P4", "P1", "P2"]);
    expect(result.reordered).toBe(2); // P3, P1
    expect(result.added).toBe(1); // P4
    expect(result.movedToEnd).toBe(1); // P2
  });

  it("aborts on an intra-file duplicate BEFORE any mutation (V10)", () => {
    const state = fixture();
    const result = reorderByUpload(state, peopleDescriptor(), ["P3", "P3"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("duplicate");
    expect(result.name).toBe("P3");
    // State untouched (no mutation ran).
  });

  it("aborts on an empty parsed list (V8)", () => {
    const result = reorderByUpload(fixture(), peopleDescriptor(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("empty");
  });

  it("uses EXACT identity — 'p3' is NEW, distinct from existing 'P3' (case-sensitive)", () => {
    const state = fixture(); // [P1, P2, P3]
    const result = reorderByUpload(state, peopleDescriptor(), ["p3", "P4"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // p3 (new) + P4 (new) in file order; existing P1,P2,P3 unmentioned → trailing.
    expect(result.state.staff.map((p) => p.id)).toEqual(["p3", "P4", "P1", "P2", "P3"]);
  });

  it("rejects a reserved name atomically before any mutation (NEW MAJOR 6)", () => {
    const state = fixture();
    const result = reorderByUpload(state, peopleDescriptor(), ["P1", "ALL"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("reserved");
    expect(result.name).toBe("ALL");
    // State untouched — the whole upload aborted.
    expect(state.staff.map((p) => p.id)).toEqual(["P1", "P2", "P3"]);
  });

  it("rejects a NEW name colliding with an existing group id (NEW MAJOR 6)", () => {
    // "TeamA" is an existing people-group id — a new person cannot reuse it.
    const result = reorderByUpload(fixture(), peopleDescriptor(), ["TeamA"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("collision");
    expect(result.name).toBe("TeamA");
  });

  it("returns the ORIGINAL state (no zundo entry) for a semantically no-op upload (NEW MAJOR 8)", () => {
    const state = createEmptyScenarioUiState("noop");
    state.staff = [
      { id: "P1", history: [] },
      { id: "P2", history: [] },
      { id: "P3", history: [] },
    ];
    state.staffGroups = [{ id: "G", members: ["P1", "P3"] }]; // already in item order
    // The file exactly matches the current order and memberships → nothing changes.
    const result = reorderByUpload(state, peopleDescriptor(), ["P1", "P2", "P3"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe(state); // same reference — no writeState
    expect(result.state.staff).toBe(state.staff);
    expect(result.state.staffGroups[0]).toBe(state.staffGroups[0]);
  });

  it("reuses existing item objects (preserves their fields) and re-sorts group members", () => {
    const state = fixture(); // TeamA members [P3, P1]
    state.staff[0].description = "Alice";
    const result = reorderByUpload(state, peopleDescriptor(), ["P1", "P3"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // P1 reused (keeps description), reordered first; members re-sorted to [P1, P3].
    expect(result.state.staff[0]).toMatchObject({ id: "P1", description: "Alice" });
    expect(result.state.staffGroups[0].members).toEqual(["P1", "P3"]);
  });

  it("new people are created with history: []", () => {
    const result = reorderByUpload(fixture(), peopleDescriptor(), ["P4"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.staff.find((p) => p.id === "P4")).toMatchObject({ history: [] });
  });

  it("preserves duplicate member occurrences through the upload re-sort (WT0/MAJOR 3)", () => {
    const state = createEmptyScenarioUiState("dup");
    state.staff = [
      { id: 1, history: [] },
      { id: "1", history: [] },
      { id: "B", history: [] },
    ];
    // The group carries a duplicate numeric-1 occurrence plus the distinct string "1".
    state.staffGroups = [{ id: "G", members: [1, 1, "1", "B"] }];
    // Upload names are unique (intra-file dup would abort); they reorder the ITEMS.
    const result = reorderByUpload(state, peopleDescriptor(), ["B", "1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Items → [B, "1", 1(trailing)]; group members re-sorted to that order WITHOUT
    // collapsing the duplicate numeric 1.
    expect(result.state.staff.map((p) => p.id)).toEqual(["B", "1", 1]);
    expect(result.state.staffGroups[0].members).toEqual(["B", "1", 1, 1]);
  });
});

describe("reorder integer guards (Minor 1)", () => {
  it("reorderItems rejects NaN / fractional indexes (returns the same state)", () => {
    const state = fixture();
    expect(reorderItems(state, peopleDescriptor(), Number.NaN, 1)).toBe(state);
    expect(reorderItems(state, peopleDescriptor(), 0.5, 2)).toBe(state);
    expect(reorderItems(state, peopleDescriptor(), 0, 1.9)).toBe(state);
  });

  it("reorderGroups rejects NaN / fractional indexes (returns the same state)", () => {
    const state = fixture();
    state.staffGroups = [
      { id: "G1", members: [] },
      { id: "G2", members: [] },
    ];
    expect(reorderGroups(state, peopleDescriptor(), Number.NaN, 1)).toBe(state);
    expect(reorderGroups(state, peopleDescriptor(), 0.5, 1)).toBe(state);
  });
});
