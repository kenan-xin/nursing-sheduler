import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { writeTemporary } from "./people-descriptor";

const ward = () => ({
  ...createEmptyScenarioUiState(),
  staff: [{ id: "ana" }, { id: 7, temporary: true }],
});

describe("writeTemporary", () => {
  it("sets true, and removes the key for false", () => {
    const on = writeTemporary(ward(), "ana", true);
    expect(on.staff[0]).toEqual({ id: "ana", temporary: true });
    const off = writeTemporary(on, "ana", false);
    expect(off.staff[0]).toEqual({ id: "ana" });
    expect("temporary" in off.staff[0]).toBe(false);
  });

  it("returns the same state when nothing changes, and matches ids exactly", () => {
    const state = ward();
    expect(writeTemporary(state, "ana", false)).toBe(state);
    expect(writeTemporary(state, 7, true)).toBe(state);
    expect(writeTemporary(state, "7", false)).toBe(state); // "7" is not 7
  });
});
