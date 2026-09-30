import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import { validateScenario } from "@/lib/scenario/serialize";
import { applyRangeChange, countRangeRemovals } from "./range-cascade";

function seeded(): ScenarioUiState {
  const state = createEmptyScenarioUiState("alpha");
  state.rangeStart = "2026-07-01";
  state.rangeEnd = "2026-07-31";
  // A user group referencing same-month DD ids, plus a shift-request matrix cell
  // on one of those dates and an export column that counts it.
  state.dateGroups = [{ id: "Custom", members: ["01", "15", "31"] }];
  state.staff = [{ id: "P1" }];
  state.shifts = [{ id: "D" }];
  state.reqData = [{ kind: "request", person: "P1", date: "15", shiftType: "D", weight: 1 }];
  state.exportLayout = {
    formatting: [],
    extraColumns: [
      { type: "count", header: "Jul", countShiftTypes: ["D"], countDates: ["01", "15"] },
    ],
    extraRows: [],
  };
  // A preference card whose date field is stored as FULL ISO (never a span id) —
  // it must survive a span change untouched (the migration only remaps span ids).
  state.cardsByKind.counts = [
    {
      uid: "cnt1",
      person: "ALL",
      countDates: ["2026-07-15"],
      countShiftTypes: "D",
      expression: "x >= T",
      target: 1,
      weight: 1,
    },
  ];
  return state;
}

describe("applyRangeChange range cascade (FR-DC-41 / AC-DC-18)", () => {
  it("migrates re-keyed ids on a span change instead of purging in-range references", () => {
    // Widen 2026-07-01…0731 (same-month, DD ids) into August → same-year (MM-DD).
    // Every July date is STILL in range, only re-keyed, so nothing is purged — the
    // three span-id surfaces migrate DD → MM-DD.
    const next = applyRangeChange(seeded(), { start: "2026-07-01", end: "2026-08-15" });

    expect(next.rangeStart).toBe("2026-07-01");
    expect(next.rangeEnd).toBe("2026-08-15");
    expect(next.dateGroups[0].members).toEqual(["07-01", "07-15", "07-31"]);
    expect(next.reqData).toEqual([
      { kind: "request", person: "P1", date: "07-15", shiftType: "D", weight: 1 },
    ]);
    expect(next.exportLayout.extraColumns[0].countDates).toEqual(["07-01", "07-15"]);
    // Full-ISO preference-card date refs are not span ids → left untouched.
    expect(next.cardsByKind.counts[0].countDates).toEqual(["2026-07-15"]);
  });

  it("keeps still-generated ids when the span format is unchanged (removals still purge)", () => {
    // Shrinking within the same month keeps DD ids; only dropped days are purged.
    const next = applyRangeChange(seeded(), { start: "2026-07-01", end: "2026-07-20" });
    expect(next.dateGroups[0].members).toEqual(["01", "15"]); // 31 removed, 01/15 kept
    expect(next.reqData).toHaveLength(1); // cell on "15" survives
    expect(next.exportLayout.extraColumns[0].countDates).toEqual(["01", "15"]);
  });

  it("drops overrides whose date left the range", () => {
    const state = seeded();
    state.cardsByKind.requirements = [
      {
        uid: "r",
        shiftType: "D",
        requiredNumPeople: 2,
        requiredNumPeopleOverrides: [
          [state.rangeStart, 1],
          [state.rangeEnd, 3],
        ],
        weight: -1,
      },
    ];
    const next = applyRangeChange(state, { start: state.rangeStart, end: state.rangeStart });
    expect(next.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([
      [state.rangeStart, 1],
    ]);
    const gone = applyRangeChange(state, { start: state.rangeEnd, end: state.rangeEnd });
    expect(gone.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([
      [state.rangeEnd, 3],
    ]);
  });

  it("removes the field when no override is left", () => {
    const state = seeded();
    state.cardsByKind.requirements = [
      {
        uid: "r",
        shiftType: "D",
        requiredNumPeople: 2,
        requiredNumPeopleOverrides: [[state.rangeEnd, 1]],
        weight: -1,
      },
    ];
    const next = applyRangeChange(state, { start: state.rangeStart, end: state.rangeStart });
    expect(next.cardsByKind.requirements[0]).not.toHaveProperty("requiredNumPeopleOverrides");
  });

  it("both migrates still-in-range dates and purges dates that left in one span change", () => {
    // 2026-07-01…0831 is same-year (MM-DD). Shrinking to August-only flips the span
    // to same-month (DD): July dates LEAVE the range (purge) while August dates STAY
    // but re-key MM-DD → DD (migrate). This proves delete and migrate coexist.
    const state = createEmptyScenarioUiState("alpha");
    state.rangeStart = "2026-07-01";
    state.rangeEnd = "2026-08-31";
    state.dateGroups = [{ id: "Custom", members: ["07-15", "08-20"] }];
    state.staff = [{ id: "P1" }];
    state.shifts = [{ id: "D" }];
    state.reqData = [
      { kind: "request", person: "P1", date: "07-15", shiftType: "D", weight: 1 },
      { kind: "request", person: "P1", date: "08-20", shiftType: "D", weight: 1 },
    ];
    state.exportLayout = {
      formatting: [],
      extraColumns: [
        { type: "count", header: "Aug", countShiftTypes: ["D"], countDates: ["07-15", "08-20"] },
      ],
      extraRows: [],
    };

    const next = applyRangeChange(state, { start: "2026-08-01", end: "2026-08-31" });

    // "07-15" (July, gone) is purged; "08-20" (stays) migrates MM-DD → DD "20".
    expect(next.dateGroups[0].members).toEqual(["20"]);
    expect(next.reqData).toEqual([
      { kind: "request", person: "P1", date: "20", shiftType: "D", weight: 1 },
    ]);
    expect(next.exportLayout.extraColumns[0].countDates).toEqual(["20"]);
  });

  it("preserves keyword date-group members verbatim while generated ids migrate", () => {
    const state = seeded();
    // A span-independent keyword member alongside a same-month DD id.
    state.dateGroups = [{ id: "Custom", members: ["WEEKEND", "01"] }];
    // Widen July → same-year (MM-DD): "01" re-keys to "07-01", WEEKEND is untouched.
    const next = applyRangeChange(state, { start: "2026-07-01", end: "2026-08-15" });
    expect(next.dateGroups[0].members).toEqual(["WEEKEND", "07-01"]);
  });

  it("migrates to full YYYY-MM-DD ids on a cross-year change while purging dates that left", () => {
    // 2026-06-15…0831 is same-year (MM-DD). Moving into 2027 flips the span to
    // cross-year (YYYY-MM-DD): the pre-start June date LEAVES (purge) while the
    // Jul/Aug dates STAY and re-key MM-DD → YYYY-MM-DD (migrate). This is the last
    // untested span transition.
    const state = createEmptyScenarioUiState("alpha");
    state.rangeStart = "2026-06-15";
    state.rangeEnd = "2026-08-31";
    state.dateGroups = [{ id: "Custom", members: ["06-20", "07-15", "08-31"] }];
    state.staff = [{ id: "P1" }];
    state.shifts = [{ id: "D" }];
    state.reqData = [
      { kind: "request", person: "P1", date: "06-20", shiftType: "D", weight: 1 },
      { kind: "request", person: "P1", date: "07-15", shiftType: "D", weight: 1 },
    ];
    state.exportLayout = {
      formatting: [],
      extraColumns: [
        {
          type: "count",
          header: "Jun-Jul",
          countShiftTypes: ["D"],
          countDates: ["06-20", "07-15"],
        },
      ],
      extraRows: [],
    };

    const next = applyRangeChange(state, { start: "2026-07-01", end: "2027-01-15" });

    expect(next.rangeStart).toBe("2026-07-01");
    expect(next.rangeEnd).toBe("2027-01-15");
    // "06-20" (before the new start) is purged; the survivors migrate to full ISO.
    expect(next.dateGroups[0].members).toEqual(["2026-07-15", "2026-08-31"]);
    expect(next.reqData).toEqual([
      { kind: "request", person: "P1", date: "2026-07-15", shiftType: "D", weight: 1 },
    ]);
    expect(next.exportLayout.extraColumns[0].countDates).toEqual(["2026-07-15"]);
  });

  it("leaves full-ISO card date refs untouched across a cross-year span change", () => {
    // Same-month (DD) → cross-year (YYYY-MM-DD). The tempting trap: the new ids are
    // themselves full ISO, identical in shape to the card's span-independent
    // countDates — but cards are never a migration surface, so they stay verbatim.
    const next = applyRangeChange(seeded(), { start: "2026-07-01", end: "2027-01-15" });
    expect(next.cardsByKind.counts[0].countDates).toEqual(["2026-07-15"]);
    // Non-vacuous: generated group members DID migrate DD → YYYY-MM-DD in the same run.
    expect(next.dateGroups[0].members).toEqual(["2026-07-01", "2026-07-15", "2026-07-31"]);
  });

  it("imports WORKDAY/NON-WORKDAY/PH when requested and the range is supported", () => {
    const next = applyRangeChange(
      seeded(),
      { start: "2026-05-01", end: "2026-05-31" },
      {
        importSingaporeHolidays: true,
      },
    );
    const ids = next.dateGroups.map((g) => g.id);
    expect(ids).toContain("WORKDAY");
    expect(ids).toContain("NON-WORKDAY");
    expect(ids).toContain("PH");
    // Labour Day (May 1) is a DD id "01" in a same-month span and lands in PH.
    const ph = next.dateGroups.find((g) => g.id === "PH")!;
    expect(ph.members).toContain("01");
  });

  it("does not import when the range is outside the supported window", () => {
    const next = applyRangeChange(
      seeded(),
      { start: "2019-01-01", end: "2019-01-31" },
      {
        importSingaporeHolidays: true,
      },
    );
    expect(next.dateGroups.map((g) => g.id)).not.toContain("PH");
  });

  it("with the switch off keeps hand-edited holiday groups and remembers off (6975)", () => {
    const may = { start: "2026-05-01", end: "2026-05-31" };
    const imported = applyRangeChange(seeded(), may, { importSingaporeHolidays: true });
    expect(imported.importPublicHolidays).toBe(true);
    // Hand edit: PH keeps only Labour Day.
    const edited = {
      ...imported,
      dateGroups: imported.dateGroups.map((g) => (g.id === "PH" ? { ...g, members: ["01"] } : g)),
    };

    const off = applyRangeChange(edited, may, { importSingaporeHolidays: false });
    expect(off.importPublicHolidays).toBe(false);
    expect(off.dateGroups).toEqual(edited.dateGroups);

    // A later range change with the switch off never rebuilds them.
    const moved = applyRangeChange(
      off,
      { start: "2026-05-01", end: "2026-05-15" },
      {
        importSingaporeHolidays: false,
      },
    );
    expect(moved.dateGroups.find((g) => g.id === "PH")!.members).toEqual(["01"]);
    expect(moved.importPublicHolidays).toBe(false);

    // Omitting the option (removal counting) leaves the remembered switch alone.
    expect(applyRangeChange(off, may).importPublicHolidays).toBe(false);
  });

  it("turning the switch back on rebuilds the groups and remembers on", () => {
    const may = { start: "2026-05-01", end: "2026-05-31" };
    const off = { ...seeded(), importPublicHolidays: false };
    const on = applyRangeChange(off, may, { importSingaporeHolidays: true });
    expect(on.importPublicHolidays).toBe(true);
    expect(on.dateGroups.find((g) => g.id === "PH")!.members).toContain("01");
  });
});

describe("applyRangeChange prunes rule-card dates that left the range (A-04)", () => {
  it("prunes an out-of-range ISO card date and drops a card left with none", () => {
    const state = createEmptyScenarioUiState("alpha");
    state.rangeStart = "2026-01-01";
    state.rangeEnd = "2026-01-31";
    state.staff = [{ id: "P1" }];
    state.shifts = [{ id: "D" }];
    state.cardsByKind.requirements = [
      { uid: "r1", shiftType: "D", requiredNumPeople: 1, date: ["2026-01-05"], weight: -1 },
    ];
    state.cardsByKind.counts = [
      {
        uid: "c1",
        person: "ALL",
        countDates: ["2026-01-31", "2026-02-01"],
        countShiftTypes: "D",
        expression: "x >= T",
        target: 1,
        weight: 1,
      },
    ];

    const next = applyRangeChange(state, { start: "2026-02-01", end: "2026-02-28" });

    expect(next.cardsByKind.requirements).toEqual([]);
    expect(next.cardsByKind.counts[0].countDates).toEqual(["2026-02-01"]);
    expect(validateScenario(toCanonicalScenarioDocument(next)).ok).toBe(true);
  });
});

describe("countRangeRemovals", () => {
  it("counts the request and leave cells the cascade drops, and nothing it migrates", () => {
    const state = seeded();
    state.reqData = [
      ...state.reqData, // request on "15"
      { kind: "leave", person: "P1", date: "25" },
      { kind: "leave", person: "P1", date: "31" },
      { kind: "off", person: "P1", date: "31", weight: 2 },
      { kind: "request", person: "P1", date: "01", shiftType: "D", weight: -1 },
    ];
    // Shrink to 01..20: 25 and 31 leave the range.
    expect(countRangeRemovals(state, { start: "2026-07-01", end: "2026-07-20" })).toEqual({
      requests: 1,
      leaveDays: 2,
    });
    // Widen into August: every July id is re-keyed, nothing removed.
    expect(countRangeRemovals(state, { start: "2026-07-01", end: "2026-08-15" })).toEqual({
      requests: 0,
      leaveDays: 0,
    });
  });
});
