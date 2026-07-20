import { describe, expect, it } from "vitest";
import {
  findImportUncreditedLeaveFindings,
  findSavedUncreditedLeaveFindings,
  type ImportLeaveGuardSnapshot,
  type SavedLeaveGuardSnapshot,
} from "./adapters";
import type { CountCard } from "../types";

const RANGE_START = "2026-05-14";
const RANGE_END = "2026-05-16";

function markedCard(uid: string, overrides: Partial<CountCard> = {}): CountCard {
  return {
    uid,
    tag: "contracted_hours",
    policy: "exact",
    person: "ALL",
    countDates: "ALL",
    countShiftTypes: "D",
    expression: "==",
    target: 1,
    weight: -1,
    ...overrides,
  } as CountCard;
}

function baseSnapshot(
  counts: readonly CountCard[],
  overrides: Partial<SavedLeaveGuardSnapshot> = {},
): SavedLeaveGuardSnapshot {
  return {
    staff: [{ id: "Alice" }, { id: "Bob" }],
    staffGroups: [],
    shifts: [{ id: "D" }],
    shiftGroups: [{ id: "mixed", members: ["D", "LEAVE"] }],
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    dateGroups: [],
    reqData: [{ kind: "leave", person: "Alice", date: "2026-05-15" }],
    counts,
    ...overrides,
  };
}

describe("findSavedUncreditedLeaveFindings — same-snapshot uid join", () => {
  it("joins the finding to the uid at the same index in the same snapshot", () => {
    const byUid = findSavedUncreditedLeaveFindings(baseSnapshot([markedCard("card-1")]));
    expect(byUid.get("card-1")).toEqual({ countIndex: 0, affectedPersonIndices: [0] });
    expect(byUid.size).toBe(1);
  });

  it("treats card.disabled as the enabled flag (!disabled)", () => {
    const byUid = findSavedUncreditedLeaveFindings(
      baseSnapshot([markedCard("card-1", { disabled: true })]),
    );
    expect(byUid.size).toBe(0);
  });

  it("keeps duplicate identical marked cards independent by their own uid", () => {
    const byUid = findSavedUncreditedLeaveFindings(
      baseSnapshot([markedCard("card-1"), markedCard("card-2")]),
    );
    expect(byUid.get("card-1")).toEqual({ countIndex: 0, affectedPersonIndices: [0] });
    expect(byUid.get("card-2")).toEqual({ countIndex: 1, affectedPersonIndices: [0] });
  });

  it("re-evaluated after a reorder, the same uid still resolves to its own finding", () => {
    const before = findSavedUncreditedLeaveFindings(
      baseSnapshot([
        markedCard("card-1"),
        markedCard("card-2", { person: "Bob" }), // Bob is not on leave — no finding.
      ]),
    );
    expect(before.get("card-1")).toEqual({ countIndex: 0, affectedPersonIndices: [0] });
    expect(before.has("card-2")).toBe(false);

    // Reorder: card-2 now comes first. A fresh evaluation must still join by uid,
    // not by a stale index from the previous evaluation.
    const after = findSavedUncreditedLeaveFindings(
      baseSnapshot([markedCard("card-2", { person: "Bob" }), markedCard("card-1")]),
    );
    expect(after.get("card-1")).toEqual({ countIndex: 1, affectedPersonIndices: [0] });
    expect(after.has("card-2")).toBe(false);
  });
});

describe("findImportUncreditedLeaveFindings — keyless import snapshot", () => {
  function importSnapshot(counts: ImportLeaveGuardSnapshot["counts"]): ImportLeaveGuardSnapshot {
    return {
      staff: [{ id: "Alice" }, { id: "Bob" }],
      staffGroups: [],
      shifts: [{ id: "D" }],
      shiftGroups: [{ id: "mixed", members: ["D", "LEAVE"] }],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
      dateGroups: [],
      reqData: [{ kind: "leave", person: "Alice", date: "2026-05-15" }],
      counts,
    };
  }

  it("finds an uncredited-leave finding against a keyless (uid-less) count body", () => {
    const findings = findImportUncreditedLeaveFindings(
      importSnapshot([
        {
          tag: "contracted_hours",
          policy: "exact",
          person: "ALL",
          countDates: "ALL",
          countShiftTypes: "D",
          expression: "==",
          target: 1,
          weight: -1,
        },
      ]),
    );
    expect(findings).toEqual([{ countIndex: 0, affectedPersonIndices: [0] }]);
  });

  it("treats every count as enabled, even one carrying a restored disabled flag", () => {
    const findings = findImportUncreditedLeaveFindings(
      importSnapshot([
        {
          tag: "contracted_hours",
          policy: "exact",
          person: "ALL",
          countDates: "ALL",
          countShiftTypes: "D",
          expression: "==",
          target: 1,
          weight: -1,
          disabled: true,
        },
      ]),
    );
    expect(findings).toEqual([{ countIndex: 0, affectedPersonIndices: [0] }]);
  });
});

describe("adapter equivalence — saved and import adapters agree on the same scenario", () => {
  it("returns equivalent findings for equivalent saved and keyless input", () => {
    const savedByUid = findSavedUncreditedLeaveFindings(baseSnapshot([markedCard("card-1")]));
    const importFindings = findImportUncreditedLeaveFindings({
      staff: [{ id: "Alice" }, { id: "Bob" }],
      staffGroups: [],
      shifts: [{ id: "D" }],
      shiftGroups: [{ id: "mixed", members: ["D", "LEAVE"] }],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
      dateGroups: [],
      reqData: [{ kind: "leave", person: "Alice", date: "2026-05-15" }],
      counts: [
        {
          tag: "contracted_hours",
          policy: "exact",
          person: "ALL",
          countDates: "ALL",
          countShiftTypes: "D",
          expression: "==",
          target: 1,
          weight: -1,
        },
      ],
    });
    expect(savedByUid.get("card-1")?.affectedPersonIndices).toEqual(
      importFindings[0]?.affectedPersonIndices,
    );
    expect(importFindings).toEqual([{ countIndex: 0, affectedPersonIndices: [0] }]);
  });
});
