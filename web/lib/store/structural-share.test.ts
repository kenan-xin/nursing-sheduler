import { describe, expect, it } from "vitest";
import { shareStructure } from "./structural-share";

// The property that matters to the app: the published value always EQUALS the
// committed document, and identity changes only where the value did.
describe("shareStructure", () => {
  it("returns the previous value when the two are deep-equal", () => {
    const prev = { staff: [{ id: "A" }], range: { start: "2026-01-01" } };
    const next = structuredClone(prev);
    expect(shareStructure(prev, next)).toBe(prev);
  });

  it("keeps untouched sibling slices at their original reference", () => {
    const prev = { staff: [{ id: "A" }], shifts: [{ id: "D" }] };
    const next = { staff: [{ id: "A" }], shifts: [{ id: "E" }] };

    const shared = shareStructure(prev, next);
    expect(shared).not.toBe(prev);
    // The slice that changed is the committed one; the one that did not is reused,
    // which is exactly what an open editor's staleness token relies on.
    expect(shared.shifts).toEqual([{ id: "E" }]);
    expect(shared.staff).toBe(prev.staff);
  });

  it("reuses unchanged elements inside a changed array", () => {
    const prev = {
      cards: [
        { uid: "a", n: 1 },
        { uid: "b", n: 2 },
      ],
    };
    const next = structuredClone(prev);
    next.cards[1].n = 3;

    const shared = shareStructure(prev, next);
    expect(shared.cards[0]).toBe(prev.cards[0]);
    expect(shared.cards[1]).not.toBe(prev.cards[1]);
    expect(shared).toEqual(next);
  });

  it("treats a length change as a change even when the prefix matches", () => {
    const prev = { staff: [{ id: "A" }] };
    const next = { staff: [{ id: "A" }, { id: "B" }] };

    const shared = shareStructure(prev, next);
    expect(shared.staff).not.toBe(prev.staff);
    expect(shared.staff[0]).toBe(prev.staff[0]);
  });

  it("treats a dropped key as a change (key count, not just presence)", () => {
    const prev = { card: { uid: "a", weight: -1 } };
    const next = { card: { uid: "a" } };

    const shared = shareStructure(prev, next);
    expect(shared.card).not.toBe(prev.card);
    expect(shared).toEqual(next);
  });

  it("does not confuse a shape change for an equal value", () => {
    expect(shareStructure({ a: 1 }, [1])).toEqual([1]);
    expect(shareStructure([1], { a: 1 })).toEqual({ a: 1 });
    expect(shareStructure({ a: 1 }, null)).toBeNull();
  });

  it("carries ±Infinity weights through unchanged", () => {
    const prev = { card: { weight: Infinity } };
    const next = { card: { weight: Infinity } };
    expect(shareStructure(prev, next)).toBe(prev);
    expect(shareStructure(prev, { card: { weight: -Infinity } }).card.weight).toBe(-Infinity);
  });
});
