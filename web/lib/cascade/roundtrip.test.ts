import { describe, expect, it } from "vitest";
import { serializeScenario, type ScenarioUiState } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, scenarioCommands, useScenarioStore } from "@/lib/store";
import { deleteEntity, renameEntity } from ".";
import { resetScenarioForTest, undoDepth } from "@/lib/store/test-authority";

// Export Layout reference cascade proven through T05's serialization oracle: the
// dumped YAML must reflect the rename rewrite and the delete prune (finding #4).
describe("Export Layout cascade round-trip via T05 serialize", () => {
  it("a person rename rewrites the export row in the serialized YAML", async () => {
    // makeValidUiState seeds an export formatting row keyed on person "Alice".
    const yaml = serializeScenario(renameEntity(makeValidUiState(), "person", "Alice", "Alicia"));
    expect(yaml).toContain("Alicia");
    expect(yaml).not.toContain("Alice"); // no stray old id survived the round-trip
  });

  it("a person delete prunes the emptied export row (row → [] → dropped)", async () => {
    const after = deleteEntity(makeValidUiState(), "person", "Alice");
    // The sole formatting row (people: [Alice]) emptied → dropped → export omitted.
    expect(after.exportLayout.formatting).toHaveLength(0);
    const yaml = serializeScenario(after);
    expect(yaml).not.toContain("Alice");
    expect(yaml).not.toMatch(/^export:/m); // nothing left in the export layout
  });

  it("a shift rename to a string id serializes cleanly (no numeric-selector leak)", async () => {
    // Regression: a numeric rename target would leak a number into a string-typed
    // selector and throw here. A string target round-trips.
    const after = renameEntity(makeValidUiState(), "shift", "D", "Day");
    expect(() => serializeScenario(after)).not.toThrow();
    expect(serializeScenario(after)).toMatch(/shiftType: Day\b/);
  });
});

// One cascade op = one durable write ⇒ one repository commit; a single undo
// restores the exact prior state (acceptance matrix "undo restores exactly").
//
// T03: the store under assertion is the APP projection singleton, because that is
// what the installed authority publishes into. A locally built spine would stay
// empty and every assertion below would read an untouched empty scenario.
describe("cascade op wired as one tracked mutation (undo restores exactly)", () => {
  it("rename records one commit and a single undo reverts it", async () => {
    await resetScenarioForTest();
    const store = useScenarioStore;

    // Seed a scenario (one entry), then rename P1→PX (a second entry).
    const seed: Partial<ScenarioUiState> = {
      staff: [{ id: "P1" }, { id: "P2" }],
      staffGroups: [{ id: "TeamA", members: ["P1", "P2"] }],
    };
    await scenarioCommands.mutate(seed);
    const entriesAfterSeed = await undoDepth();

    await scenarioCommands.mutate((s) => renameEntity(s, "person", "P1", "PX"));
    expect(store.getState().staff[0].id).toBe("PX");
    expect(await undoDepth()).toBe(entriesAfterSeed + 1);

    // One undo restores the pre-rename state exactly.
    await scenarioCommands.undo();
    expect(store.getState().staff[0].id).toBe("P1");
    expect(store.getState().staffGroups[0].members).toEqual(["P1", "P2"]);
  });

  it("delete records one commit; undo restores, redo re-applies exactly", async () => {
    await resetScenarioForTest();
    const store = useScenarioStore;

    // Seed a scenario where P1 is referenced across surfaces (group member, a
    // covering card, a matrix cell, an export row).
    const seed: Partial<ScenarioUiState> = {
      staff: [{ id: "P1" }, { id: "P2" }],
      staffGroups: [{ id: "TeamA", members: ["P1", "P2"] }],
      cardsByKind: {
        requirements: [],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [
          {
            uid: "cov1",
            preceptors: ["P1"],
            preceptees: ["P2"],
            shiftTypes: ["D"],
            weight: Infinity,
          },
        ],
      },
      reqData: [{ uid: "c1", kind: "off", person: "P1", date: "2026-05-14", weight: 1 }],
      exportLayout: {
        formatting: [{ uid: "f1", type: "row", people: ["P1"] }],
        extraColumns: [],
        extraRows: [],
      },
    };
    await scenarioCommands.mutate(seed);
    const entriesAfterSeed = await undoDepth();
    // Full durable-slice snapshot BEFORE the delete (exact-restoration oracle).
    const preDelete = structuredClone(pickScenario(store.getState()));

    // Delete P1 (one entry): sole preceptor → covering pruned; cell + export row gone.
    await scenarioCommands.mutate((s) => deleteEntity(s, "person", "P1"));
    const postDelete = structuredClone(pickScenario(store.getState()));
    expect(store.getState().staff.map((p) => p.id)).toEqual(["P2"]);
    expect(store.getState().cardsByKind.coverings).toHaveLength(0);
    expect(store.getState().reqData).toHaveLength(0);
    expect(store.getState().exportLayout.formatting).toHaveLength(0);
    expect(await undoDepth()).toBe(entriesAfterSeed + 1);

    // One undo restores the ENTIRE durable slice EXACTLY (== pre-delete).
    await scenarioCommands.undo();
    expect(pickScenario(store.getState())).toEqual(preDelete);

    // Redo re-applies the exact cascade result (== post-delete).
    await scenarioCommands.redo();
    expect(pickScenario(store.getState())).toEqual(postDelete);
  });
});
