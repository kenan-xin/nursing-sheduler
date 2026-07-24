import { describe, expect, it } from "vitest";
import type { UiDateGroup } from "@/lib/scenario";
import { isAllScope, isAllDates, type DateScopeContext } from "./scope";

describe("isAllScope — context-free keyword/shape predicate (DR-H)", () => {
  it("treats an absent selector (undefined / null) as all-scope", () => {
    expect(isAllScope(undefined)).toBe(true);
    expect(isAllScope(null)).toBe(true);
  });

  it("accepts the scalar ALL keyword, String-coerced and case-folded", () => {
    expect(isAllScope("ALL")).toBe(true);
    expect(isAllScope("all")).toBe(true);
    expect(isAllScope("All")).toBe(true);
    expect(isAllScope("aLL")).toBe(true);
  });

  it("accepts a list containing ALL — ALL dominates regardless of position", () => {
    expect(isAllScope(["ALL"])).toBe(true);
    expect(isAllScope(["ALL", "D"])).toBe(true);
    expect(isAllScope(["D", "ALL"])).toBe(true);
    expect(isAllScope(["all", "N"])).toBe(true);
  });

  it("treats an EMPTY list as NOT all-scope (selects nothing, not everything)", () => {
    expect(isAllScope([])).toBe(false);
  });

  it("rejects a non-ALL scalar, including a numeric id", () => {
    expect(isAllScope("D")).toBe(false);
    expect(isAllScope("")).toBe(false);
    expect(isAllScope(5)).toBe(false);
    expect(isAllScope("5")).toBe(false);
    expect(isAllScope("ALLOWED")).toBe(false);
  });

  it("rejects a list with no ALL element", () => {
    expect(isAllScope(["D", "N"])).toBe(false);
    expect(isAllScope([1, 2])).toBe(false);
  });

  it("finds ALL inside a nested aggregate list (defensive)", () => {
    expect(isAllScope(["D", ["ALL"]])).toBe(true);
    expect(isAllScope([["D"], ["N"]])).toBe(false);
  });
});

// A week Wed 2026-07-01 … Tue 2026-07-07: ids are same-month "DD" (01..07);
// Sat 04 + Sun 05 are the weekend, the other five are weekdays.
const WEEK: DateScopeContext["range"] = { start: "2026-07-01", end: "2026-07-07" };
const ALL_WEEK_IDS = ["01", "02", "03", "04", "05", "06", "07"];

function ctx(dateGroups: UiDateGroup[] = []): DateScopeContext {
  return { range: WEEK, dateGroups };
}

describe("isAllDates — context-aware all-dates predicate (DR-H)", () => {
  it("is true for every keyword shape isAllScope accepts", () => {
    expect(isAllDates(undefined, ctx())).toBe(true);
    expect(isAllDates(null, ctx())).toBe(true);
    expect(isAllDates("ALL", ctx())).toBe(true);
    expect(isAllDates("all", ctx())).toBe(true);
    expect(isAllDates(["ALL"], ctx())).toBe(true);
    expect(isAllDates(["ALL", "01"], ctx())).toBe(true);
  });

  it("is true for a full-range enumeration of every concrete date id", () => {
    expect(isAllDates(ALL_WEEK_IDS, ctx())).toBe(true);
  });

  it("is true for a union of all-covering derived groups (WEEKDAY + WEEKEND)", () => {
    expect(isAllDates(["WEEKDAY", "WEEKEND"], ctx())).toBe(true);
    // Case-folded derived-group keywords resolve too.
    expect(isAllDates(["weekday", "weekend"], ctx())).toBe(true);
  });

  it("is true for an authored date group that spans the whole range", () => {
    const groups: UiDateGroup[] = [{ id: "everything", members: ALL_WEEK_IDS }];
    expect(isAllDates(["everything"], ctx(groups))).toBe(true);
  });

  it("is false for a strict subset of the range", () => {
    expect(isAllDates(["01", "02"], ctx())).toBe(false);
    expect(isAllDates("01", ctx())).toBe(false);
    expect(isAllDates(["WEEKDAY"], ctx())).toBe(false); // missing the weekend
    expect(isAllDates(["WEEKEND"], ctx())).toBe(false);
    expect(isAllDates([], ctx())).toBe(false);
  });

  it("is false for an authored group that covers only part of the range", () => {
    const groups: UiDateGroup[] = [{ id: "firstHalf", members: ["01", "02", "03"] }];
    expect(isAllDates(["firstHalf"], ctx(groups))).toBe(false);
  });

  it("without a committed range: keyword shapes still true, concrete refs false", () => {
    const noRange: DateScopeContext = { range: { start: "", end: "" }, dateGroups: [] };
    expect(isAllDates("ALL", noRange)).toBe(true);
    expect(isAllDates(undefined, noRange)).toBe(true);
    expect(isAllDates(["01"], noRange)).toBe(false);
    expect(isAllDates(ALL_WEEK_IDS, noRange)).toBe(false);
  });

  it("resolves all-dates across a different range (cross-year → YYYY-MM-DD ids)", () => {
    // Fri 2026-12-31 … Sat 2027-01-02 spans a year, so ids are full ISO strings.
    const range = { start: "2026-12-31", end: "2027-01-02" };
    const cross: DateScopeContext = { range, dateGroups: [] };
    expect(isAllDates(["2026-12-31", "2027-01-01", "2027-01-02"], cross)).toBe(true);
    expect(isAllDates(["2026-12-31"], cross)).toBe(false);
  });
});
