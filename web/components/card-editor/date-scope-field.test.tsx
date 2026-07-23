// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DateRef } from "@/lib/scenario";
import {
  DateScopeField,
  activeScope,
  refsToText,
  textToRefs,
  type DateScopeItem,
} from "./date-scope-field";

afterEach(() => {
  cleanup();
});

/** Build contiguous, chronological `DateScopeItem`s the way `buildDateScopeDateItems`
 *  does: full-ISO id + day-of-month, one per calendar day (inclusive). */
function rangeItems(startIso: string, endIso: string): DateScopeItem[] {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  const items: DateScopeItem[] = [];
  let day = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  while (day <= end) {
    const dt = new Date(day);
    const iso = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
      dt.getUTCDate(),
    ).padStart(2, "0")}`;
    items.push({ id: iso, dayOfMonth: dt.getUTCDate() });
    day += 86_400_000;
  }
  return items;
}

const MULTI_MONTH = rangeItems("2026-07-15", "2026-08-15");
const SINGLE_MONTH = rangeItems("2026-07-01", "2026-07-31");
const CROSS_YEAR = rangeItems("2025-12-30", "2026-01-02");
const TWO_MONTHS = rangeItems("2026-07-01", "2026-08-31");

describe("refsToText / textToRefs — multi-month identity (the bug)", () => {
  it("renders a month-aware token and round-trips to the EXACT date, not the first day-of-month match", () => {
    // 2026-08-01 and 2026-07-... both would key as day-of-month; the fix keeps them distinct.
    const text = refsToText(["2026-08-01"], MULTI_MONTH);
    expect(text).toBe("08-01");
    expect(textToRefs(text, MULTI_MONTH)).toEqual(["2026-08-01"]);
    // Regression guard: never silently remaps to July.
    expect(textToRefs(text, MULTI_MONTH)).not.toContain("2026-07-01");
  });

  it("renders a cross-month contiguous run without the '31–1' collapse and re-parses to the same two refs", () => {
    const value = ["2026-07-31", "2026-08-01"];
    const text = refsToText(value, MULTI_MONTH);
    expect(text).not.toBe("31–1");
    expect(text).toBe("07-31–08-01");
    // Must NOT expand to all of July (days 1..31).
    expect(textToRefs(text, MULTI_MONTH)).toEqual(value);
  });

  it("drops a genuinely ambiguous bare day-of-month across months rather than first-wins remapping", () => {
    // Day 1 occurs in both July and August of TWO_MONTHS -> ambiguous -> dropped.
    expect(textToRefs("1", TWO_MONTHS)).toEqual([]);
  });
});

describe("refsToText / textToRefs — single-month regression (bare DD preserved)", () => {
  it("renders bare days with a contiguous run and round-trips", () => {
    const value = ["2026-07-03", "2026-07-05", "2026-07-06", "2026-07-07"];
    const text = refsToText(value, SINGLE_MONTH);
    expect(text).toBe("3, 5–7");
    expect(textToRefs(text, SINGLE_MONTH)).toEqual(value);
  });

  it("still accepts a plain-hyphen typed range", () => {
    expect(textToRefs("5-7", SINGLE_MONTH)).toEqual(["2026-07-05", "2026-07-06", "2026-07-07"]);
  });
});

describe("refsToText / textToRefs — cross-year (YYYY-MM-DD grammar)", () => {
  it("renders the full-ISO token and round-trips", () => {
    const text = refsToText(["2026-01-01"], CROSS_YEAR);
    expect(text).toBe("2026-01-01");
    expect(textToRefs(text, CROSS_YEAR)).toEqual(["2026-01-01"]);
  });
});

describe("refsToText — numeric / unknown refs", () => {
  it("drops a durable numeric DateRef from the text without crashing (preserved in value elsewhere)", () => {
    expect(refsToText([5 as DateRef], SINGLE_MONTH)).toBe("");
    expect(refsToText(["9999-99-99"], SINGLE_MONTH)).toBe("");
  });
});

describe("activeScope (unchanged behavior)", () => {
  const groups = [{ id: "HolidayWk", label: "Holiday week" }];
  it("treats [] and ['ALL'] as ALL", () => {
    expect(activeScope([], groups)).toBe("ALL");
    expect(activeScope(["ALL"], groups)).toBe("ALL");
  });
  it("recognizes an authored group id", () => {
    expect(activeScope(["HolidayWk"], groups)).toBe("HolidayWk");
  });
  it("returns null (custom) for a numeric ref without crashing", () => {
    expect(activeScope([5 as DateRef], groups)).toBeNull();
  });
});

describe("DateScopeField (RTL)", () => {
  const noop = () => {};

  it("shows the month-aware text for a multi-month card", () => {
    render(
      <DateScopeField
        autoScopes={[]}
        dateGroups={[]}
        dateItems={MULTI_MONTH}
        value={["2026-08-01"]}
        onChange={noop}
      />,
    );
    expect((screen.getByTestId("date-scope-custom") as HTMLInputElement).value).toBe("08-01");
  });

  it("re-seeds the input on a genuine external value change", () => {
    const { rerender } = render(
      <DateScopeField
        autoScopes={[]}
        dateGroups={[]}
        dateItems={MULTI_MONTH}
        value={["2026-08-01"]}
        onChange={noop}
      />,
    );
    const input = () => screen.getByTestId("date-scope-custom") as HTMLInputElement;
    expect(input().value).toBe("08-01");

    rerender(
      <DateScopeField
        autoScopes={[]}
        dateGroups={[]}
        dateItems={MULTI_MONTH}
        value={["2026-08-10"]}
        onChange={noop}
      />,
    );
    expect(input().value).toBe("08-10");

    // Switching to a scope clears the custom text.
    rerender(
      <DateScopeField
        autoScopes={[]}
        dateGroups={[]}
        dateItems={MULTI_MONTH}
        value={["ALL"]}
        onChange={noop}
      />,
    );
    expect(input().value).toBe("");
  });

  it("does not clobber in-progress multi-month typing that transiently parses to []", () => {
    function Harness() {
      const [value, setValue] = React.useState<readonly DateRef[]>([]);
      return (
        <DateScopeField
          autoScopes={[]}
          dateGroups={[]}
          dateItems={MULTI_MONTH}
          value={value}
          onChange={setValue}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByTestId("date-scope-custom") as HTMLInputElement;
    // Incremental keyboard entry: each partial token parses to [] (month-aware
    // grammar), which flips isCustom false. The field must retain what was typed.
    fireEvent.change(input, { target: { value: "08" } });
    expect(input.value).toBe("08");
    fireEvent.change(input, { target: { value: "08-1" } });
    expect(input.value).toBe("08-1");
    fireEvent.change(input, { target: { value: "08-15" } });
    expect(input.value).toBe("08-15");
    // The completed token resolves to the exact full-ISO ref.
    expect(textToRefs(input.value, MULTI_MONTH)).toEqual(["2026-08-15"]);
  });

  it("does not clobber in-progress typing that parses to the same refs", () => {
    function Harness() {
      const [value, setValue] = React.useState<readonly DateRef[]>(["2026-07-05"]);
      return (
        <DateScopeField
          autoScopes={[]}
          dateGroups={[]}
          dateItems={SINGLE_MONTH}
          value={value}
          onChange={setValue}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByTestId("date-scope-custom") as HTMLInputElement;
    // A trailing comma parses to the same single ref; the re-sync effect must leave it.
    fireEvent.change(input, { target: { value: "5," } });
    expect(input.value).toBe("5,");
  });
});
