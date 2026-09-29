import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { deleteImpact, describeDeleteImpact } from "./delete";

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
