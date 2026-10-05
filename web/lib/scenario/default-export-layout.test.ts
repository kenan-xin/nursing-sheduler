import { describe, expect, it } from "vitest";

import { toCanonicalScenarioDocument } from "./canonical";
import { generateDefaultExportLayout, withDefaultExportLayout } from "./default-export-layout";
import { serializeCanonicalDocument } from "./serialize";
import { makeValidUiState } from "./test-fixtures";

function stateWithoutLayout() {
  const state = makeValidUiState();
  state.exportLayout.formatting = [];
  return state;
}

describe("default export layout (audit C-01, v1 parity)", () => {
  it("fills the v1 layout when none is saved, and it passes strict serialization", () => {
    const doc = withDefaultExportLayout(toCanonicalScenarioDocument(stateWithoutLayout()));
    const layout = doc.export!;
    expect(layout.formatting?.map((rule) => rule.description ?? rule.type)).toContain(
      "Mark unsatisfied shift requests",
    );
    expect(layout.extraColumns?.map((c) => c.header)).toEqual([
      "OFF (Total)",
      "OFF (Weekday)",
      "OFF (Weekend)",
      "D Count",
      "E Count",
      "N Count",
      "DayOrEvening Count",
    ]);
    expect(layout.extraRows?.map((r) => r.header)).toEqual([
      "D Count",
      "E Count",
      "N Count",
      "DayOrEvening Count",
    ]);
    const yaml = serializeCanonicalDocument(doc);
    expect(yaml).toContain("[X]");
    expect(yaml).toContain("-.inf");
  });

  it("adds the WORKDAY / NON-WORKDAY OFF columns only when those groups exist", () => {
    const state = stateWithoutLayout();
    state.dateGroups = [
      { id: "WORKDAY", members: ["2026-05-14"] },
      { id: "NON-WORKDAY", members: ["2026-05-16"] },
    ];
    const layout = generateDefaultExportLayout(toCanonicalScenarioDocument(state));
    expect(layout.extraColumns?.slice(0, 3).map((c) => c.header)).toEqual([
      "OFF (Total)",
      "OFF (WORKDAY)",
      "OFF (NON-WORKDAY)",
    ]);
    expect(() =>
      serializeCanonicalDocument({
        ...toCanonicalScenarioDocument(state),
        export: layout,
      }),
    ).not.toThrow();
  });

  it("leaves a saved layout untouched", () => {
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    expect(withDefaultExportLayout(doc)).toBe(doc);
  });
});
