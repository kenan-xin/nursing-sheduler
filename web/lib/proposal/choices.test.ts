import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  LISTED_CHOICES,
  choiceList,
  everyoneGroups,
  idLabel,
  meansEveryone,
  ruleChoices,
} from "./choices";
import { ruleWardScenario } from "./test-support";

describe("refusal choice lists", () => {
  it("writes ids exactly as they must be sent back: strings quoted, numbers bare", () => {
    expect(idLabel("ana")).toBe('"ana"');
    expect(idLabel(7)).toBe("7");
    expect(choiceList([idLabel("ana"), idLabel(7)])).toBe('Valid choices: "ana", 7.');
  });

  it("caps a long list and says how many more there are", () => {
    const labels = Array.from({ length: LISTED_CHOICES + 5 }, (_, n) => idLabel(`p${n}`));
    const text = choiceList(labels);
    expect(text).toContain('"p19"');
    expect(text).not.toContain('"p20"');
    expect(text).toMatch(/and 5 more\.$/);
  });

  it("says so when there is nothing to choose from", () => {
    expect(choiceList([])).toBe("There are none yet.");
  });

  it("lists rule ids with their titles", () => {
    expect(ruleChoices(ruleWardScenario(), "counts")).toBe(
      'Valid choices: "cnt-nights" (Night cap).',
    );
  });

  it("recognises the ways a model says everyone", () => {
    for (const ref of ["ALL", "all", "Everyone", " everybody "])
      expect(meansEveryone(ref)).toBe(true);
    for (const ref of ["ana", 7, "RN"]) expect(meansEveryone(ref)).toBe(false);
  });

  it("finds staff groups that already hold every person, and none on an empty ward", () => {
    const state = ruleWardScenario();
    expect(everyoneGroups(state)).toEqual([]);
    const withAll = {
      ...state,
      staffGroups: [...state.staffGroups, { id: "All staff", members: ["cai", "ana", "ben"] }],
    };
    expect(everyoneGroups(withAll)).toEqual(["All staff"]);
    expect(everyoneGroups(createEmptyScenarioUiState())).toEqual([]);
  });
});
