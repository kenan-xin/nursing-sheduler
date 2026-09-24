// The screens render these keys; the diff emits them. A drift here would silently
// highlight nothing, so every scope's key is pinned against the real diff.
import { describe, expect, it } from "vitest";
import { diffScenarioDocuments } from "@/lib/proposal/diff";
import { proposalScenario } from "@/lib/proposal/test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import { changeKeys } from "./keys";

function keysAfter(patch: (state: ScenarioUiState) => Partial<ScenarioUiState>): string[] {
  const before = proposalScenario();
  const after = { ...before, ...patch(before) };
  return diffScenarioDocuments(before, after).map((entry) => entry.key);
}

describe("changeKeys matches the proposal diff", () => {
  it("roster period", () => {
    expect(keysAfter(() => ({ rangeEnd: "2026-04-20" }))).toContain(changeKeys.rosterRange());
  });
  it("date group", () => {
    expect(
      keysAfter((s) => ({ dateGroups: [...s.dateGroups, { id: "Nights", members: ["06"] }] })),
    ).toContain(changeKeys.dateGroup("Nights"));
  });
  it("person, string and numeric ids", () => {
    const keys = keysAfter((s) => ({ staff: [...s.staff, { id: "cy" }, { id: 7 }] }));
    expect(keys).toContain(changeKeys.person("cy"));
    expect(keys).toContain(changeKeys.person(7));
    expect(changeKeys.person(7)).not.toBe(changeKeys.person("7"));
  });
  it("staff group", () => {
    expect(
      keysAfter((s) => ({ staffGroups: [...s.staffGroups, { id: "Seniors", members: ["ana"] }] })),
    ).toContain(changeKeys.peopleGroup("Seniors"));
  });
  it("shift type and shift group", () => {
    const keys = keysAfter((s) => ({
      shifts: [...s.shifts, { id: "EVE" }],
      shiftGroups: [...s.shiftGroups, { id: "Days", members: ["Day"] }],
    }));
    expect(keys).toContain(changeKeys.shift("EVE"));
    expect(keys).toContain(changeKeys.shiftGroup("Days"));
  });
  it("rule card", () => {
    const keys = keysAfter((s) => ({
      cardsByKind: {
        ...s.cardsByKind,
        successions: [
          ...s.cardsByKind.successions,
          { uid: "succ-new", person: ["ALL"], pattern: ["Night", "Day"], weight: -1 },
        ],
      },
    }));
    expect(keys).toContain(changeKeys.rule("successions", "succ-new"));
  });
  it("request cell, and its row prefix", () => {
    const keys = keysAfter((s) => ({
      reqData: [...s.reqData, { uid: "c-new", person: "bo", date: "12", kind: "leave" }],
    }));
    expect(keys).toContain(changeKeys.cell("bo", "12"));
    expect(changeKeys.cell("bo", "12").startsWith(changeKeys.cellRow("bo"))).toBe(true);
  });
});
