// The saved-roster seed goes through the app's own capture path: the staged snapshot,
// the app capture gate, F3's assembler and F1's commit. So what the assistant reads is
// what a successful Optimize run leaves behind.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { readRosterForAssistant } from "@/lib/ai/assistant/roster-context";
import { isRosterGenerated } from "@/lib/optimize/roster-generated";
import { cards, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import { useHotStore } from "@/lib/store";
import { seedSavedRoster } from "./saved-roster";

const scenario = () =>
  ward({
    staff: people("ana", "ben"),
    cardsByKind: cards({ requirements: [requirement("day", "D", 1)] }),
  });

const ROWS = {
  ana: "D D OFF N N OFF LV",
  ben: "OFF N D D OFF D D",
};

describe("seedSavedRoster", () => {
  beforeEach(() => {
    useHotStore.getState().resetRunView();
  });

  it("leaves a saved, current roster the assistant reads, from a finished run", async () => {
    await seedSavedRoster(scenario(), ROWS);

    const read = await readRosterForAssistant();
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.newerRunWaiting).toBe(false);
    expect(read.document.context.people.map((p) => String(p.id))).toEqual(["ana", "ben"]);
    expect(read.document.solvedDays[1][3]).toEqual({ kind: "shift", shiftId: "D" });
    expect(read.document.solvedDays[0][6]).toEqual({ kind: "leave" });
    expect(read.document.solvedDays[0][2]).toEqual({ kind: "off" });
    expect(isRosterGenerated(useHotStore.getState().runView)).toBe(true);
  });

  it("replaces the roster a previous trial saved", async () => {
    await seedSavedRoster(scenario(), ROWS);
    await seedSavedRoster(scenario(), { ana: "N N N N N N N", ben: "D D D D D D D" });

    const read = await readRosterForAssistant();
    expect(read.status === "ready" && read.document.solvedDays[0][0]).toEqual({
      kind: "shift",
      shiftId: "N",
    });
  });

  it("refuses a row that does not match the roster period", async () => {
    await expect(seedSavedRoster(scenario(), { ana: "D", ben: "D" })).rejects.toThrow(/ana/);
  });

  it("refuses a roster the app would not save", async () => {
    await expect(
      seedSavedRoster(scenario(), { ana: "X X X X X X X", ben: "D D D D D D D" }),
    ).rejects.toThrow(/did not save/);
  });
});
