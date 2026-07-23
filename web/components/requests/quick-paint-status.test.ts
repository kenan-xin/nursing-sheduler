import { describe, expect, it } from "vitest";
import { parseQuickPaintWeight, quickPaintStatus } from "./quick-paint-status";

describe("parseQuickPaintWeight", () => {
  it("parses infinity spellings case-insensitively", () => {
    expect(parseQuickPaintWeight("∞")).toBe(Infinity);
    expect(parseQuickPaintWeight("+∞")).toBe(Infinity);
    expect(parseQuickPaintWeight("Inf")).toBe(Infinity);
    expect(parseQuickPaintWeight("INFINITY")).toBe(Infinity);
    expect(parseQuickPaintWeight("-∞")).toBe(-Infinity);
    expect(parseQuickPaintWeight("-inf")).toBe(-Infinity);
    expect(parseQuickPaintWeight("-Infinity")).toBe(-Infinity);
  });

  it("treats an empty string as 0", () => {
    expect(parseQuickPaintWeight("")).toBe(0);
    expect(parseQuickPaintWeight("  ")).toBe(0);
  });

  it("parses integers", () => {
    expect(parseQuickPaintWeight("5")).toBe(5);
    expect(parseQuickPaintWeight("-10")).toBe(-10);
  });

  it("returns null for unparseable text", () => {
    expect(parseQuickPaintWeight("abc")).toBeNull();
  });
});

describe("quickPaintStatus (FR-SR-29)", () => {
  it("clear: no targets selected", () => {
    expect(quickPaintStatus([], "5")).toEqual({
      tone: "clear",
      text: "Drag over cells to clear existing requests or history. Empty cells will not change.",
    });
  });

  it("clear takes precedence over an invalid weight when no targets are selected", () => {
    expect(quickPaintStatus([], "abc").tone).toBe("clear");
  });

  it("error: invalid weight with targets selected", () => {
    expect(quickPaintStatus(["AM"], "abc")).toEqual({
      tone: "error",
      text: "Enter a valid weight before dragging over cells to apply preferences.",
    });
  });

  it("removal: weight parses to exactly 0", () => {
    expect(quickPaintStatus(["AM", "PM"], "0")).toEqual({
      tone: "removal",
      text: "Drag over cells to remove AM, PM. Empty cells without it will not change.",
    });
  });

  it("removal: empty weight text also parses to 0", () => {
    expect(quickPaintStatus(["AM"], "").tone).toBe("removal");
  });

  it("apply: a nonzero valid weight", () => {
    expect(quickPaintStatus(["AM"], "5")).toEqual({
      tone: "apply",
      text: "Drag over cells to apply AM with weight +5.",
    });
  });

  it("apply: joins multiple targets and abbreviates the weight label", () => {
    expect(quickPaintStatus(["AM", "PM"], "1200")).toEqual({
      tone: "apply",
      text: "Drag over cells to apply AM, PM with weight +1.2k.",
    });
  });

  it("apply: +∞ weight", () => {
    expect(quickPaintStatus(["LEAVE"], "∞").text).toBe(
      "Drag over cells to apply LEAVE with weight +∞.",
    );
  });

  // The status line must announce what the drag ACTUALLY paints (the gesture's
  // `computeQuickPaintCellIntent` precedence), not the raw selection.
  describe("announces the actually-applied intent, not the raw selection", () => {
    it("apply: a co-selected OFF is dropped when a worked shift is selected", () => {
      // Gesture drops OFF and paints only AM — the status must match.
      expect(quickPaintStatus(["OFF", "AM"], "5")).toEqual({
        tone: "apply",
        text: "Drag over cells to apply AM with weight +5.",
      });
    });

    it("removal: a co-selected OFF is dropped for the removal wording too", () => {
      expect(quickPaintStatus(["OFF", "AM"], "0")).toEqual({
        tone: "removal",
        text: "Drag over cells to remove AM. Empty cells without it will not change.",
      });
    });

    it("apply: LEAVE overrides every co-selected target", () => {
      // LEAVE wins over AM and OFF — only LEAVE is announced.
      expect(quickPaintStatus(["OFF", "AM", "LEAVE"], "5")).toEqual({
        tone: "apply",
        text: "Drag over cells to apply LEAVE with weight +5.",
      });
    });

    it("apply: a sole OFF selection is still announced (it is a day-state)", () => {
      expect(quickPaintStatus(["OFF"], "5")).toEqual({
        tone: "apply",
        text: "Drag over cells to apply OFF with weight +5.",
      });
    });
  });
});
