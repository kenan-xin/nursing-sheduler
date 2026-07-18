import { describe, expect, it } from "vitest";
import { getMissingPreferredScatterDateGroups, scatterShiftRequests } from "./anonymize";
import type { CanonicalScenarioDocument } from "./types";

// A deterministic RNG (Math.random is unavailable in some execution contexts, so
// scatter always takes an injected source). `() => 0` makes Fisher–Yates fully
// deterministic, so placement is reproducible run to run.
const rng0 = () => 0;

const ISO = (day: number) => `2026-05-${String(day).padStart(2, "0")}`;

/** The eight-day May-2026 calendar the happy-path/V18 fixtures share. */
function baseDoc(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: {
      range: { startDate: ISO(1), endDate: ISO(8) },
      groups: [
        { id: "WORKDAY", members: [ISO(1), ISO(2), ISO(5), ISO(6)] },
        { id: "NON-WORKDAY", members: [ISO(3), ISO(4), ISO(7), ISO(8)] },
      ],
    },
    people: {
      items: [{ id: "Alice" }, { id: "Bob" }],
      groups: [{ id: "Team", members: ["Alice", "Bob"] }],
    },
    shiftTypes: { items: [{ id: "D" }, { id: "E" }] },
    preferences: [],
  };
}

const WORKDAY_ISOS = new Set([ISO(1), ISO(2), ISO(5), ISO(6)]);
const NON_WORKDAY_ISOS = new Set([ISO(3), ISO(4), ISO(7), ISO(8)]);
const ISO_ORDER = [ISO(1), ISO(2), ISO(3), ISO(4), ISO(5), ISO(6), ISO(7), ISO(8)];
const indexOfIso = (iso: string) => ISO_ORDER.indexOf(iso);

describe("scatterShiftRequests — happy path (FR-SL-37)", () => {
  it("preserves per-person category counts and consecutive-run lengths; leaves other refs untouched", () => {
    const doc = baseDoc();
    doc.preferences = [
      // Alice: a WORKDAY run of 2 …
      { type: "shift request", person: "Alice", date: [ISO(1), ISO(2)], shiftType: "D", weight: 1 },
      // … and a NON-WORKDAY single (scalar date, to exercise scalar handling).
      { type: "shift request", person: "Alice", date: ISO(4), shiftType: "D", weight: -1 },
      // Keyword-group date → not concrete → unchanged.
      { type: "shift request", person: "Alice", date: "WORKDAY", shiftType: "D", weight: 2 },
      // People-group person (not a concrete item) → unchanged.
      { type: "shift request", person: "Team", date: ISO(3), shiftType: "D", weight: 3 },
      // Non-request preference → untouched.
      {
        type: "shift type requirement",
        shiftType: "D",
        requiredNumPeople: 1,
        date: "ALL",
        weight: -1,
      },
    ];
    const snapshot = structuredClone(doc);

    const result = scatterShiftRequests(doc, rng0);

    // Copy-not-mutate: the input document is byte-for-byte untouched.
    expect(doc).toEqual(snapshot);

    // Run 0: still 2 WORKDAY dates, still consecutive.
    const run = result.preferences[0];
    expect(run.type === "shift request" && Array.isArray(run.date) && run.date).toHaveLength(2);
    const runDates = (run as { date: string[] }).date;
    expect(runDates.every((d) => WORKDAY_ISOS.has(d))).toBe(true);
    expect(Math.abs(indexOfIso(runDates[1]) - indexOfIso(runDates[0]))).toBe(1);

    // Single: still one NON-WORKDAY date, still a scalar.
    const single = result.preferences[1] as { date: string };
    expect(typeof single.date).toBe("string");
    expect(NON_WORKDAY_ISOS.has(single.date)).toBe(true);

    // Keyword / group / non-request preferences pass through verbatim.
    expect((result.preferences[2] as { date: unknown }).date).toBe("WORKDAY");
    expect((result.preferences[3] as { date: unknown }).date).toBe(ISO(3));
    expect(result.preferences[4]).toEqual(snapshot.preferences[4]);
  });
});

describe("scatterShiftRequests — validation contract (V16–V18)", () => {
  it("V16 — throws on a multi-person shift request", () => {
    const doc = baseDoc();
    doc.preferences = [
      { type: "shift request", person: ["Alice", "Bob"], date: ISO(1), shiftType: "D", weight: 1 },
    ];
    expect(() => scatterShiftRequests(doc, rng0)).toThrow(
      "Cannot scatter shift requests with multiple people or multiple shift types.",
    );
  });

  it("V16 — throws on a multi-shift-type shift request", () => {
    const doc = baseDoc();
    doc.preferences = [
      { type: "shift request", person: "Alice", date: ISO(1), shiftType: ["D", "E"], weight: 1 },
    ];
    expect(() => scatterShiftRequests(doc, rng0)).toThrow(
      "Cannot scatter shift requests with multiple people or multiple shift types.",
    );
  });

  it("V17 — throws when a date is in neither category", () => {
    const doc = baseDoc();
    doc.dates = {
      range: { startDate: ISO(1), endDate: ISO(3) },
      // Both preferred groups present (so no WEEKDAY/WEEKEND fallback), but 05-03
      // is in neither.
      groups: [
        { id: "WORKDAY", members: [ISO(1)] },
        { id: "NON-WORKDAY", members: [ISO(2)] },
      ],
    };
    expect(() => scatterShiftRequests(doc, rng0)).toThrow(
      `Date "${ISO(3)}" must belong to exactly one of WORKDAY or NON-WORKDAY.`,
    );
  });

  it("V18 — throws when a run has no non-overlapping placement", () => {
    const doc = baseDoc();
    doc.dates = {
      range: { startDate: ISO(1), endDate: ISO(4) },
      groups: [
        { id: "WORKDAY", members: [ISO(1), ISO(2), ISO(4)] },
        { id: "NON-WORKDAY", members: [ISO(3)] },
      ],
    };
    // Alice: a WORKDAY run of 2 (05-01,05-02) plus a WORKDAY single (05-04). The
    // single greedily takes the only spare WORKDAY slot, leaving the run of 2 with
    // no free WORKDAY-count-2 window.
    doc.preferences = [
      { type: "shift request", person: "Alice", date: [ISO(1), ISO(2)], shiftType: "D", weight: 1 },
      { type: "shift request", person: "Alice", date: ISO(4), shiftType: "D", weight: 1 },
    ];
    expect(() => scatterShiftRequests(doc, rng0)).toThrow(
      "Unable to scatter shift requests without overlapping consecutive runs.",
    );
  });

  it("no mutation on error — the input document is untouched after a throw", () => {
    const doc = baseDoc();
    doc.preferences = [
      { type: "shift request", person: ["Alice", "Bob"], date: ISO(1), shiftType: "D", weight: 1 },
    ];
    const snapshot = structuredClone(doc);
    expect(() => scatterShiftRequests(doc, rng0)).toThrow();
    expect(doc).toEqual(snapshot);
  });
});

describe("getMissingPreferredScatterDateGroups (FR-SL-38 / V20)", () => {
  it("returns [] when both preferred groups are present", () => {
    expect(
      getMissingPreferredScatterDateGroups([
        { id: "WORKDAY", members: [] },
        { id: "NON-WORKDAY", members: [] },
      ]),
    ).toEqual([]);
  });

  it("returns the single missing group id", () => {
    expect(getMissingPreferredScatterDateGroups([{ id: "WORKDAY", members: [] }])).toEqual([
      "NON-WORKDAY",
    ]);
  });

  it("returns both when neither is present", () => {
    expect(getMissingPreferredScatterDateGroups([{ id: "Custom", members: [] }])).toEqual([
      "WORKDAY",
      "NON-WORKDAY",
    ]);
  });
});

describe("scatterShiftRequests — WEEKDAY/WEEKEND fallback (FR-SL-38)", () => {
  it("classifies via weekday/weekend when a preferred group is missing", () => {
    const isWeekend = (iso: string) => {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      return dow === 0 || dow === 6;
    };
    const doc = baseDoc();
    // Only WORKDAY present → NON-WORKDAY missing → fall back to WEEKDAY/WEEKEND.
    doc.dates.groups = [{ id: "WORKDAY", members: [ISO(1)] }];
    // Pick a weekday source date so it must stay a weekday after scatter.
    const weekdaySource = ISO_ORDER.find((iso) => !isWeekend(iso))!;
    doc.preferences = [
      { type: "shift request", person: "Alice", date: weekdaySource, shiftType: "D", weight: 1 },
    ];

    expect(getMissingPreferredScatterDateGroups(doc.dates.groups)).toEqual(["NON-WORKDAY"]);

    const result = scatterShiftRequests(doc, rng0);
    const moved = (result.preferences[0] as { date: string }).date;
    expect(isWeekend(moved)).toBe(false);
  });
});
