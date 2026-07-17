import { describe, expect, it } from "vitest";
import type { UiDateGroup } from "@/lib/scenario";
import { generateDateItems } from "./date-id";
import {
  buildSingaporeHolidayGroups,
  replaceDateGroups,
  SINGAPORE_NONWORKDAY_GROUP_ID,
  SINGAPORE_PH_GROUP_ID,
  SINGAPORE_WORKDAY_GROUP_ID,
} from "./holiday-groups";

// May 2026 spans Labour Day (Fri 1st), Hari Raya Haji (Wed 27th), Vesak Day
// (Sun 31st) plus its observed substitute (Mon 2026-06-01). Range 2026-04-30 …
// 2026-06-02 keeps ids in MM-DD form and covers both a holiday-on-weekday and the
// observed day.
const items = generateDateItems({ start: "2026-04-30", end: "2026-06-02" });

function group(groups: UiDateGroup[], id: string): UiDateGroup {
  const found = groups.find((g) => g.id === id);
  if (!found) throw new Error(`missing group ${id}`);
  return found;
}

describe("buildSingaporeHolidayGroups (FR-DC-34)", () => {
  const groups = buildSingaporeHolidayGroups(items);

  it("returns exactly the three editable groups with fixed descriptions", () => {
    expect(groups.map((g) => g.id)).toEqual([
      SINGAPORE_WORKDAY_GROUP_ID,
      SINGAPORE_NONWORKDAY_GROUP_ID,
      SINGAPORE_PH_GROUP_ID,
    ]);
    expect(group(groups, "PH").description).toBe(
      "Singapore public holidays imported from the data.gov.sg public holidays dataset",
    );
  });

  it("PH holds only gazetted holidays incl. the observed substitute", () => {
    expect(group(groups, "PH").members).toEqual(["05-01", "05-27", "05-31", "06-01"]);
  });

  it("NON-WORKDAY is the union of holidays and weekends; PH ⊆ NON-WORKDAY", () => {
    const nonWork = new Set(group(groups, "NON-WORKDAY").members.map(String));
    // Labour Day (holiday on a Friday) is a non-work day…
    expect(nonWork.has("05-01")).toBe(true);
    // …and so is a plain weekend (Sat 2026-05-02).
    expect(nonWork.has("05-02")).toBe(true);
    for (const m of group(groups, "PH").members) expect(nonWork.has(String(m))).toBe(true);
  });

  it("WORKDAY excludes every holiday and weekend and never overlaps NON-WORKDAY", () => {
    const workday = group(groups, "WORKDAY").members.map(String);
    const nonWork = new Set(group(groups, "NON-WORKDAY").members.map(String));
    expect(workday).not.toContain("05-01"); // holiday
    expect(workday).not.toContain("05-02"); // weekend
    expect(workday).toContain("05-04"); // plain Monday
    for (const m of workday) expect(nonWork.has(m)).toBe(false);
  });
});

describe("replaceDateGroups (FR-DC-40)", () => {
  it("overwrites same-id groups case-insensitively, in place, and appends new ones", () => {
    const existing: UiDateGroup[] = [
      { id: "workday", description: "user's old workday", members: ["99"] },
      { id: "Custom", description: "kept", members: ["01"] },
    ];
    const imported = buildSingaporeHolidayGroups(items);
    const merged = replaceDateGroups(existing, imported);

    // The case-insensitive `workday` match is replaced in its original slot 0.
    expect(merged[0].id).toBe("WORKDAY");
    expect(merged[0].description).toContain("imported from the data.gov.sg");
    // The unrelated user group is preserved in place.
    expect(merged[1]).toEqual(existing[1]);
    // NON-WORKDAY and PH are appended (were not present before).
    expect(merged.slice(2).map((g) => g.id)).toEqual(["NON-WORKDAY", "PH"]);
  });

  it("collapses several case-insensitive aliases of one imported id to a SINGLE canonical group (no exact-id duplicates)", () => {
    // Backend date-group ids are case-SENSITIVE (producer.ts checks duplicates by
    // exact id while reserved keywords are matched case-insensitively), so a valid
    // pre-import scenario may carry BOTH `workday` and `WORKDAY`. Import must fold
    // every alias into exactly one imported `WORKDAY` — never two identical ids,
    // which would violate the producer duplicate-id contract (review Major 1).
    const existing: UiDateGroup[] = [
      { id: "workday", description: "lower", members: ["a"] },
      { id: "WORKDAY", description: "upper", members: ["b"] },
      { id: "non-workday", description: "lower nonwork", members: ["c"] },
      { id: "Custom", description: "keep", members: ["d"] },
    ];
    const imported = buildSingaporeHolidayGroups(items);
    const merged = replaceDateGroups(existing, imported);

    const workdayEntries = merged.filter((g) => g.id === "WORKDAY");
    expect(workdayEntries).toHaveLength(1);
    const nonWorkEntries = merged.filter((g) => g.id === "NON-WORKDAY");
    expect(nonWorkEntries).toHaveLength(1);

    // No exact-id duplicates overall (the producer/backend contract).
    const ids = merged.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The unrelated user group survives.
    expect(merged.some((g) => g.id === "Custom")).toBe(true);
  });
});
