import { describe, expect, it } from "vitest";
import { sortMembersByItemOrder } from "./membership";

describe("sortMembersByItemOrder", () => {
  it("sorts known members to match the item order", () => {
    expect(sortMembersByItemOrder(["C", "A", "B"], ["A", "B", "C", "D"])).toEqual(["A", "B", "C"]);
  });

  it("keeps unknown members trailing, in their original relative order", () => {
    expect(sortMembersByItemOrder(["Outer", "B", "Inner", "A"], ["A", "B"])).toEqual([
      "A",
      "B",
      "Outer",
      "Inner",
    ]);
  });

  it("preserves the membership set when every member is unknown", () => {
    expect(sortMembersByItemOrder(["X", "Y"], ["A", "B"])).toEqual(["X", "Y"]);
  });

  it("handles exact-identity numeric ids (1 and '1' are distinct)", () => {
    // The string "1" matches the item order; the distinct number 1 is unknown to
    // the item list and trails at the end.
    expect(sortMembersByItemOrder(["1", 1], ["1"])).toEqual(["1", 1]);
  });

  it("preserves DUPLICATE member occurrences (backend allows non-unique arrays) — MAJOR 3", () => {
    // [1, 1, "1", "B"] re-sorted to order ["B", 1, "1"] keeps BOTH numeric-1 copies,
    // grouped in item order, with the distinct string "1" following — no Set collapse.
    expect(sortMembersByItemOrder([1, 1, "1", "B"], ["B", 1, "1"])).toEqual(["B", 1, 1, "1"]);
  });

  it("keeps duplicate + unknown occurrences together (dup grouped, unknown trailing)", () => {
    expect(sortMembersByItemOrder(["X", "A", "A", "B"], ["A", "B"])).toEqual(["A", "A", "B", "X"]);
  });
});
