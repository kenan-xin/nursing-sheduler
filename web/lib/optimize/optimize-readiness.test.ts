import { describe, expect, it } from "vitest";
import {
  deriveOptimizeReadiness,
  UNSUPPORTED_EXPRESSION_REASON,
  type OptimizeReadinessSource,
} from "./optimize-readiness";

const ready: OptimizeReadinessSource = {
  rangeStart: "2026-07-01",
  rangeEnd: "2026-07-14",
  staff: [{ id: "p1" }],
  shifts: [{ id: "day" }],
  shiftGroups: [],
  counts: [{ expression: "x >= T" }, { expression: ["x >= T", "x <= T"] }],
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
      counts: [],
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

  it("blocks an enabled shift count whose expression core does not support (wa46)", () => {
    for (const expression of ["x >= 0", ["x >= T", "x != T"]]) {
      const result = deriveOptimizeReadiness({ ...ready, counts: [{ expression }] });
      expect(result.ready).toBe(false);
      expect(result.issues).toHaveLength(1);
      const [issue] = result.issues;
      expect(issue).toMatchObject({ kind: "shift-counts", href: "/shift-counts" });
      expect(`${issue.before}${issue.linkLabel}${issue.after}`).toBe(UNSUPPORTED_EXPRESSION_REASON);
    }
  });

  it("ignores an unsupported expression on a disabled count (it is never sent)", () => {
    const counts = [{ expression: "x >= 0", disabled: true }];
    expect(deriveOptimizeReadiness({ ...ready, counts }).ready).toBe(true);
  });

  it("returns issues in priority order dates → people → shift types", () => {
    const result = deriveOptimizeReadiness({
      rangeStart: "",
      rangeEnd: "",
      staff: [],
      shifts: [],
      shiftGroups: [],
      counts: [],
    });
    expect(result.issues.map((i) => i.kind)).toEqual(["dates", "people", "shift-types"]);
  });
});
