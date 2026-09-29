import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { deleteEntity, deleteImpact, describeDeleteImpact } from "./delete";

describe("deleting a shift type a sequence rule uses (A-03)", () => {
  function withPattern(pattern: ScenarioUiState["cardsByKind"]["successions"][number]["pattern"]) {
    const empty = createEmptyScenarioUiState();
    return {
      ...empty,
      shifts: [{ id: "D" }, { id: "N" }],
      cardsByKind: {
        ...empty.cardsByKind,
        successions: [{ uid: "s1", person: ["ALL"], pattern, date: ["ALL"], weight: -Infinity }],
      },
    } as ScenarioUiState;
  }

  it("drops the rule rather than shortening its pattern, and the confirm counts it", () => {
    const state = withPattern(["N", "D"]);
    expect(deleteEntity(state, "shift", "D").cardsByKind.successions).toEqual([]);
    expect(deleteImpact(state, "shift", "D").rules).toBe(1);
  });

  it("keeps the rule when a step only loses one of its alternatives", () => {
    const after = deleteEntity(withPattern([["N", "D"], "D"]), "shift", "N");
    expect(after.cardsByKind.successions[0]?.pattern).toEqual([["D"], "D"]);
  });
});

describe("deleteImpact (T1 confirm counts)", () => {
  it("counts the rules, requests and history entries the cascade drops", () => {
    const empty = createEmptyScenarioUiState();
    const state: ScenarioUiState = {
      ...empty,
      shifts: [{ id: "D" }, { id: "N" }],
      staff: [{ id: "Anna", history: ["N", "D", "D"] }],
      reqData: [
        { kind: "request", person: "Anna", date: "2026-01-01", shiftType: "N", weight: 1 },
        { kind: "request", person: "Anna", date: "2026-01-02", shiftType: "D", weight: 1 },
      ] as ScenarioUiState["reqData"],
      cardsByKind: {
        ...empty.cardsByKind,
        requirements: [
          {
            uid: "r1",
            shiftType: ["N"],
            requiredNumPeople: 1,
            qualifiedPeople: ["ALL"],
            date: ["ALL"],
            weight: -1,
          },
        ],
      },
    };
    const impact = deleteImpact(state, "shift", "N");
    expect(impact).toEqual({ rules: 1, requests: 1, leave: 0, history: 1, overrides: 0 });
    expect(describeDeleteImpact(impact)).toEqual(["1 rule", "1 request", "1 history entry"]);
    expect(
      describeDeleteImpact({ rules: 3, requests: 0, leave: 2, history: 4, overrides: 1 }),
    ).toEqual(["3 rules", "2 leave pins", "4 history entries", "1 date exception"]);
  });

  it("counts a nurse's leave pins apart from requests (F10)", () => {
    const empty = createEmptyScenarioUiState();
    const state: ScenarioUiState = {
      ...empty,
      staff: [{ id: "Kevin" }, { id: "Ann" }],
      reqData: [
        { kind: "leave", person: "Kevin", date: "2026-01-01" },
        { kind: "off", person: "Kevin", date: "2026-01-02", weight: 1 },
        { kind: "leave", person: "Ann", date: "2026-01-01" },
      ] as ScenarioUiState["reqData"],
    };
    expect(describeDeleteImpact(deleteImpact(state, "person", "Kevin"))).toEqual([
      "1 request",
      "1 leave pin",
    ]);
  });

  it("counts the date exceptions a date-group delete drops from a surviving rule (R9)", () => {
    const empty = createEmptyScenarioUiState();
    const state: ScenarioUiState = {
      ...empty,
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-03",
      shifts: [{ id: "D" }],
      dateGroups: [{ id: "PH", members: ["2026-01-02"] }],
      cardsByKind: {
        ...empty.cardsByKind,
        requirements: [
          {
            uid: "r1",
            shiftType: ["D"],
            requiredNumPeople: 3,
            qualifiedPeople: ["ALL"],
            date: ["2026-01-01", "PH"],
            requiredNumPeopleOverrides: [["2026-01-02", 1]],
            weight: -1,
          },
        ],
      },
    } as ScenarioUiState;
    const impact = deleteImpact(state, "date", "PH");
    expect(impact).toMatchObject({ rules: 0, overrides: 1 });
    expect(describeDeleteImpact(impact)).toEqual(["1 date exception"]);
  });
});
