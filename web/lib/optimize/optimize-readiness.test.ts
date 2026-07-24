import { describe, expect, it } from "vitest";
import { deriveOptimizeReadiness, type OptimizeReadinessSource } from "./optimize-readiness";

const ready: OptimizeReadinessSource = {
  rangeStart: "2026-07-01",
  rangeEnd: "2026-07-14",
  staff: [{ id: "p1" }],
  shifts: [{ id: "day" }],
  shiftGroups: [],
};

describe("deriveOptimizeReadiness", () => {
  it("is ready when dates, people, and shift types are present", () => {
    expect(deriveOptimizeReadiness(ready)).toEqual({ ready: true, issues: [] });
  });

  it("accepts a shift-type group in place of individual shift types", () => {
    const result = deriveOptimizeReadiness({
      ...ready,
      shifts: [],
      shiftGroups: [{ id: "g1", members: [] }],
    });
    expect(result.ready).toBe(true);
  });

  it("flags a missing date range endpoint", () => {
    expect(deriveOptimizeReadiness({ ...ready, rangeEnd: "" }).issues.map((i) => i.kind)).toEqual([
      "dates",
    ]);
    expect(deriveOptimizeReadiness({ ...ready, rangeStart: "" }).issues.map((i) => i.kind)).toEqual(
      ["dates"],
    );
  });

  it("flags missing people and shift types with old-app copy and tab links", () => {
    const result = deriveOptimizeReadiness({
      rangeStart: "2026-07-01",
      rangeEnd: "2026-07-14",
      staff: [],
      shifts: [],
      shiftGroups: [],
    });
    expect(result.ready).toBe(false);
    expect(result.issues.map((i) => i.kind)).toEqual(["people", "shift-types"]);
    expect(result.issues[0]).toMatchObject({
      before: "Please set up your people first by visiting the ",
      linkLabel: "Staff",
      href: "/people",
      after: " tab.",
    });
    expect(result.issues[1]).toMatchObject({ linkLabel: "Shifts", href: "/shift-types" });
  });

  it("returns issues in priority order dates → people → shift types", () => {
    const result = deriveOptimizeReadiness({
      rangeStart: "",
      rangeEnd: "",
      staff: [],
      shifts: [],
      shiftGroups: [],
    });
    expect(result.issues.map((i) => i.kind)).toEqual(["dates", "people", "shift-types"]);
  });
});
