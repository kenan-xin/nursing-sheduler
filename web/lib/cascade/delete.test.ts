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
    expect(impact).toEqual({ rules: 1, requests: 1, history: 1 });
    expect(describeDeleteImpact(impact)).toEqual(["1 rule", "1 request", "1 history entry"]);
    expect(describeDeleteImpact({ rules: 3, requests: 0, history: 4 })).toEqual([
      "3 rules",
      "4 history entries",
    ]);
  });
});
