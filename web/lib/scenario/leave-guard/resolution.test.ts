import { describe, expect, it } from "vitest";
import {
  buildDateIndexMap,
  buildPeopleIndexMap,
  buildScenarioResolutionContext,
  DateMapError,
  PeopleMapError,
  resolveDateSelector,
  resolvePeopleSelector,
  resolveShiftTypeSelector,
  toTypedKeyRecords,
  type Resolution,
} from "./resolution";
import { buildShiftTypeIndexMap, LEAVE_SID, OFF_SID } from "../schemas/shift-type-map";

/** Sorted index array for a resolved result; `null` for unresolved. */
function values(result: Resolution<number>): number[] | null {
  return result.resolved ? [...result.values].sort((a, b) => a - b) : null;
}

const RANGE_START = "2026-05-14"; // Thursday
const RANGE_END = "2026-05-20"; // Wednesday (7 inclusive days)

describe("buildPeopleIndexMap — ordered, typed, fail-closed", () => {
  it('keeps numeric 1 and string "1" as distinct raw keys (matches ctx.map_pid_p)', () => {
    const map = buildPeopleIndexMap([{ id: 1 }, { id: "1" }]);
    expect(map.get(1)).toEqual([0]);
    expect(map.get("1")).toEqual([1]);
    // Two distinct entries, plus ALL.
    expect(map.get("ALL")).toEqual([0, 1]);
    expect(values(resolvePeopleSelector(map, 1))).toEqual([0]);
    expect(values(resolvePeopleSelector(map, "1"))).toEqual([1]);
  });

  it("inserts items in item order, then ALL, then groups in declaration order", () => {
    const map = buildPeopleIndexMap(
      [{ id: "A" }, { id: "B" }, { id: "C" }],
      [
        { id: "front", members: ["A", "B"] },
        { id: "wrap", members: ["front", "C"] },
      ],
    );
    expect([...map.keys()]).toEqual(["A", "B", "C", "ALL", "front", "wrap"]);
    expect(map.get("front")).toEqual([0, 1]);
    // A group may reference an already-built group (union/dedupe/sort).
    expect(map.get("wrap")).toEqual([0, 1, 2]);
  });

  it("resolves an empty group to an empty set", () => {
    const map = buildPeopleIndexMap([{ id: "A" }], [{ id: "empty", members: [] }]);
    expect(map.get("empty")).toEqual([]);
    expect(values(resolvePeopleSelector(map, "empty"))).toEqual([]);
  });

  it("fails construction on a forward reference / cycle / unknown member", () => {
    expect(() =>
      buildPeopleIndexMap(
        [{ id: "A" }],
        [
          { id: "g", members: ["later"] },
          { id: "later", members: ["A"] },
        ],
      ),
    ).toThrow(PeopleMapError);
    expect(() => buildPeopleIndexMap([{ id: "A" }], [{ id: "g", members: ["Z"] }])).toThrow(
      PeopleMapError,
    );
  });
});

describe("resolvePeopleSelector — union, fail on first missing key", () => {
  const map = buildPeopleIndexMap(
    [{ id: "A" }, { id: "B" }, { id: "C" }],
    [{ id: "grp", members: ["A", "C"] }],
  );

  it("unions a list selector and sorts/dedupes", () => {
    expect(values(resolvePeopleSelector(map, ["B", "grp", "A"]))).toEqual([0, 1, 2]);
  });

  it("is unresolved (no partial values) when any token is unknown", () => {
    const result = resolvePeopleSelector(map, ["A", "ZZZ"]);
    expect(result.resolved).toBe(false);
    expect(values(result)).toBeNull();
  });

  it("resolves ALL to every person index", () => {
    expect(values(resolvePeopleSelector(map, "ALL"))).toEqual([0, 1, 2]);
  });
});

describe("resolveShiftTypeSelector — via shared ordered map, reserved states", () => {
  const map = buildShiftTypeIndexMap(
    [{ id: "D" }, { id: "E" }],
    [{ id: "mixed", members: ["D", "LEAVE"] }],
  );

  it("resolves worked ids, ALL (worked-only), OFF, and LEAVE sentinels", () => {
    expect(values(resolveShiftTypeSelector(map, "D"))).toEqual([0]);
    expect(values(resolveShiftTypeSelector(map, "ALL"))).toEqual([0, 1]);
    expect(values(resolveShiftTypeSelector(map, "OFF"))).toEqual([OFF_SID]);
    expect(values(resolveShiftTypeSelector(map, "LEAVE"))).toEqual([LEAVE_SID]);
  });

  it("resolves a group whose expansion reaches LEAVE to include the leave sentinel", () => {
    expect(values(resolveShiftTypeSelector(map, "mixed"))).toEqual([LEAVE_SID, 0]);
  });

  it("keeps a numeric shift-type item key distinct from its string form", () => {
    const numericMap = buildShiftTypeIndexMap([{ id: 1 }, { id: "1" }]);
    expect(values(resolveShiftTypeSelector(numericMap, 1))).toEqual([0]);
    expect(values(resolveShiftTypeSelector(numericMap, "1"))).toEqual([1]);
  });

  it("is unresolved on an unknown selector (no partial expansion)", () => {
    expect(resolveShiftTypeSelector(map, ["D", "ZZZ"]).resolved).toBe(false);
  });
});

describe("buildDateIndexMap — ISO dates, keywords, ordered groups", () => {
  it("enumerates each inclusive date to its zero-based index", () => {
    const map = buildDateIndexMap(RANGE_START, RANGE_END);
    expect(map.get("2026-05-14")).toEqual([0]);
    expect(map.get("2026-05-20")).toEqual([6]);
    expect(map.get("ALL")).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("computes WEEKDAY/WEEKEND and weekday-name keywords (Python weekday order)", () => {
    const map = buildDateIndexMap(RANGE_START, RANGE_END);
    // 05-16 Sat (2), 05-17 Sun (3) are the weekend days in the range.
    expect(map.get("WEEKEND")).toEqual([2, 3]);
    expect(map.get("WEEKDAY")).toEqual([0, 1, 4, 5, 6]);
    expect(map.get("THURSDAY")).toEqual([0]);
    expect(map.get("SATURDAY")).toEqual([2]);
  });

  it("resolves a date group via direct-key-then-parse, then makes it addressable", () => {
    const map = buildDateIndexMap(RANGE_START, RANGE_END, [
      { id: "picks", members: ["2026-05-14", 16, "18~19"] },
    ]);
    // ISO direct hit (0), numeric fallback parse of day 16 (2), range 18~19 (4,5).
    expect(map.get("picks")).toEqual([0, 2, 4, 5]);
  });

  it("lets a later group reference an already-built group", () => {
    const map = buildDateIndexMap(RANGE_START, RANGE_END, [
      { id: "a", members: ["2026-05-14"] },
      { id: "b", members: ["a", "2026-05-15"] },
    ]);
    expect(map.get("b")).toEqual([0, 1]);
  });

  it("overwrites an existing date/keyword key when a group id collides with it", () => {
    const map = buildDateIndexMap(RANGE_START, RANGE_END, [
      { id: "2026-05-14", members: ["2026-05-20"] },
    ]);
    // The group id equal to a date spelling overwrites that entry (backend dict).
    expect(map.get("2026-05-14")).toEqual([6]);
  });

  it("fails construction on an invalid range", () => {
    expect(() => buildDateIndexMap("2026-05-20", "2026-05-14")).toThrow(DateMapError);
    expect(() => buildDateIndexMap("", "2026-05-14")).toThrow(DateMapError);
  });

  it("fails construction on ISO year zero (no Python datetime.date equivalent)", () => {
    // JS accepts `0000-01-01` as a real ISO date, but the backend cannot build a
    // year-zero date domain; reject it so both sides fail closed (closure-review P1).
    expect(() => buildDateIndexMap("0000-01-01", "0000-01-02")).toThrow(DateMapError);
    const ctx = buildScenarioResolutionContext({
      staff: [],
      staffGroups: [],
      shifts: [],
      shiftGroups: [],
      rangeStart: "0000-01-01",
      rangeEnd: "0000-01-02",
      dateGroups: [],
    });
    expect(ctx.resolveDates("0000-01-01").resolved).toBe(false);
  });

  it("fails construction on a malformed / out-of-range group member", () => {
    expect(() =>
      buildDateIndexMap(RANGE_START, RANGE_END, [{ id: "g", members: ["nonsense"] }]),
    ).toThrow(DateMapError);
    expect(() =>
      buildDateIndexMap(RANGE_START, RANGE_END, [{ id: "g", members: ["2026-06-01"] }]),
    ).toThrow(DateMapError);
  });
});

describe("resolveDateSelector — parse_dates parity, str(...) boundary", () => {
  const map = buildDateIndexMap(RANGE_START, RANGE_END);

  it("resolves direct ISO, numeric fallback, literal D, MM-DD, and ranges", () => {
    expect(values(resolveDateSelector(map, RANGE_START, RANGE_END, "2026-05-15"))).toEqual([1]);
    expect(values(resolveDateSelector(map, RANGE_START, RANGE_END, 16))).toEqual([2]);
    expect(values(resolveDateSelector(map, RANGE_START, RANGE_END, "16"))).toEqual([2]);
    expect(values(resolveDateSelector(map, RANGE_START, RANGE_END, "05-15"))).toEqual([1]);
    expect(values(resolveDateSelector(map, RANGE_START, RANGE_END, "14~16"))).toEqual([0, 1, 2]);
  });

  it("returns an empty resolved set for a reversed range (backend behavior)", () => {
    const result = resolveDateSelector(map, RANGE_START, RANGE_END, "16~14");
    expect(result.resolved).toBe(true);
    expect(values(result)).toEqual([]);
  });

  it("is unresolved for malformed and out-of-range tokens (no partial values)", () => {
    expect(resolveDateSelector(map, RANGE_START, RANGE_END, "nonsense").resolved).toBe(false);
    expect(resolveDateSelector(map, RANGE_START, RANGE_END, "2026-06-01").resolved).toBe(false);
    // One bad token in a list suppresses the whole selector.
    expect(resolveDateSelector(map, RANGE_START, RANGE_END, ["2026-05-15", "bad"]).resolved).toBe(
      false,
    );
  });

  it("rejects pure-day format across different months", () => {
    const crossMonth = buildDateIndexMap("2026-05-30", "2026-06-02");
    expect(resolveDateSelector(crossMonth, "2026-05-30", "2026-06-02", "1").resolved).toBe(false);
  });
});

describe("buildScenarioResolutionContext — fail-closed per domain", () => {
  const baseInput = {
    staff: [{ id: "A" }, { id: "B" }],
    staffGroups: [{ id: "grp", members: ["A", "B"] }],
    shifts: [{ id: "D" }, { id: "E" }],
    shiftGroups: [{ id: "mixed", members: ["D", "LEAVE"] }],
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    dateGroups: [{ id: "days", members: ["2026-05-14"] }],
  };

  it("resolves each domain through one prebuilt context", () => {
    const ctx = buildScenarioResolutionContext(baseInput);
    expect(values(ctx.resolvePeople("grp"))).toEqual([0, 1]);
    expect(values(ctx.resolveShiftTypes("mixed"))).toEqual([LEAVE_SID, 0]);
    expect(values(ctx.resolveDates("days"))).toEqual([0]);
  });

  it("marks ONLY the failed domain unresolved without throwing", () => {
    const ctx = buildScenarioResolutionContext({
      ...baseInput,
      // A cyclic people group fails just the people domain.
      staffGroups: [
        { id: "g", members: ["later"] },
        { id: "later", members: ["A"] },
      ],
    });
    // Observable behavior only — the maps are closed over, not public.
    expect(ctx.resolvePeople("A").resolved).toBe(false);
    // Dates and shift types are still fully resolvable.
    expect(values(ctx.resolveDates("2026-05-15"))).toEqual([1]);
    expect(values(ctx.resolveShiftTypes("D"))).toEqual([0]);
  });

  it("marks the date domain unresolved on an invalid range, sparing others", () => {
    const ctx = buildScenarioResolutionContext({ ...baseInput, rangeStart: "2026-05-20" });
    // Observable behavior only — the maps are closed over, not public.
    expect(ctx.resolveDates("2026-05-15").resolved).toBe(false);
    expect(values(ctx.resolvePeople("A"))).toEqual([0]);
  });
});

describe("toTypedKeyRecords — lossless typed-identity transport", () => {
  it('emits two distinct records for numeric 1 and string "1" in insertion order', () => {
    const map = buildPeopleIndexMap([{ id: 1 }, { id: "1" }]);
    expect(toTypedKeyRecords(map)).toEqual([
      { keyType: "number", key: 1, indices: [0] },
      { keyType: "string", key: "1", indices: [1] },
      { keyType: "string", key: "ALL", indices: [0, 1] },
    ]);
  });
});
