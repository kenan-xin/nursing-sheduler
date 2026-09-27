// Temporary-cover sheet plan and writer (d582, F6). The pure plan tests read a
// canonical scenario the same way an export does (`parseSubmissionDocument`); the
// writer tests run against a C5-SHAPED synthetic sheet (header rows 1-2, people
// rows 3-5, Score 6, Status 7, separator 8, count row 9, a history column and one
// extra summary column) — the committed C5 goldens carry no count row and no
// conditional formats, so the count-row and CF assertions are made on the shape
// the exporter produces (mirroring `xlsx-rows.test.ts`). The golden round trip
// lives in `edited-xlsx.test.ts`.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseSubmissionDocument } from "./context";
import {
  applyCoverSheet,
  buildCoverSheetPlan,
  toCoverEntries,
  type CoverSheetPlan,
} from "./cover-sheet";
import type { RosterCoverEntry } from "./types";

/** A producer-valid scenario: 3 dates, 3 worked shifts, two overlapping groups. */
const SCENARIO = `apiVersion: alpha
dates:
  range:
    startDate: 2023-08-18
    endDate: 2023-08-20
people:
  items:
    - id: P1
    - id: P2
    - id: P3
  groups:
    - id: Ward 3
      members: [P1]
    - id: All wards
      members: [Ward 3, P2]
shiftTypes:
  items:
    - id: D
    - id: E
    - id: N
preferences:
  - type: at most one shift per day
export:
  extraRows:
    - type: count
      header: Duty count
      countShiftTypes: [ALL]
      countPeople: [ALL]
    - type: count
      header: Ward 3 nights
      countShiftTypes: [N]
      countPeople: [Ward 3]
    - type: count
      header: Day shifts
      countShiftTypes: [D]
      countPeople: [ALL]
    - type: count
      header: Ward 4 nights
      countShiftTypes: [N]
      countPeople: [Ward 4]
    - type: count
      header: All wards
      countShiftTypes: [N]
      countPeople: [All wards]
`;

function scenarioDocument() {
  const parsed = parseSubmissionDocument(SCENARIO);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.document;
}

/** Haseena covers N on the last date, in "Ward 3". */
const HASSEENA: RosterCoverEntry = {
  name: "Haseena (Ward 3)",
  iso: "2023-08-20",
  shiftId: "N",
  groups: ["Ward 3"],
};

describe("toCoverEntries", () => {
  it("renames the UI's date/shiftType onto the submission's iso/shiftId", () => {
    expect(
      toCoverEntries([
        {
          _k: "cover-1",
          name: "Haseena (Ward 3)",
          date: "2023-08-20",
          shiftType: "N",
          groups: ["Ward 3"],
        },
        {
          _k: "cover-2",
          name: "Haseena (Ward 3)",
          date: "2023-08-21",
          shiftType: "E",
          groups: [],
        },
      ]),
    ).toEqual([
      { name: "Haseena (Ward 3)", iso: "2023-08-20", shiftId: "N", groups: ["Ward 3"] },
      { name: "Haseena (Ward 3)", iso: "2023-08-21", shiftId: "E", groups: [] },
    ]);
  });

  it("feeds the plan builder exactly the entries the workbook will carry", () => {
    // The projection's whole job is that the submission and the download agree:
    // the same cards must produce the same plan through either path.
    const covers = [
      { name: "Haseena (Ward 3)", date: "2023-08-20", shiftType: "N", groups: ["Ward 3"] },
    ];
    expect(buildCoverSheetPlan(scenarioDocument(), toCoverEntries(covers))).toEqual(
      buildCoverSheetPlan(scenarioDocument(), [HASSEENA]),
    );
  });
});

describe("buildCoverSheetPlan", () => {
  it("returns null when there are no covers", () => {
    expect(buildCoverSheetPlan(scenarioDocument(), [])).toBeNull();
  });

  it("one row per cover name, her shift on her dates and blank elsewhere", () => {
    const plan = buildCoverSheetPlan(scenarioDocument(), [
      HASSEENA,
      { ...HASSEENA, iso: "2023-08-18", shiftId: "D" },
      { name: "Ravi (Ward 4)", iso: "2023-08-19", shiftId: "E", groups: [] },
    ]);
    expect(plan?.rows).toEqual([
      { name: "Haseena (Ward 3)", cells: ["D", "", "N"] },
      { name: "Ravi (Ward 4)", cells: ["", "E", ""] },
    ]);
  });

  it("count row adds her on her date only when the shift and people match", () => {
    const plan = buildCoverSheetPlan(scenarioDocument(), [HASSEENA]);
    expect(plan?.countCredits).toEqual([
      // countShiftTypes ALL (her N is a worked shift) and countPeople ALL.
      { header: "Duty count", byDate: [0, 0, 1] },
      // Exact shift, and she is in the named group.
      { header: "Ward 3 nights", byDate: [0, 0, 1] },
      // Her shift is not in this count row's shifts.
      { header: "Day shifts", byDate: [0, 0, 0] },
      // She is in no group this count row names.
      { header: "Ward 4 nights", byDate: [0, 0, 0] },
      // The group closure: "Ward 3" is a member of "All wards".
      { header: "All wards", byDate: [0, 0, 1] },
    ]);
  });

  it("credits add up when two covers share a slot", () => {
    const plan = buildCoverSheetPlan(scenarioDocument(), [
      HASSEENA,
      { ...HASSEENA, name: "Ravi (Ward 3)", groups: ["Ward 3"] },
    ]);
    expect(plan?.countCredits[1]).toEqual({ header: "Ward 3 nights", byDate: [0, 0, 2] });
  });

  it("carries the entries for the provenance table", () => {
    expect(buildCoverSheetPlan(scenarioDocument(), [HASSEENA])?.entries).toEqual([HASSEENA]);
  });
});

// ---------------------------------------------------------------------------
// applyCoverSheet — the C5-shaped synthetic sheet
// ---------------------------------------------------------------------------

const DATE_COLUMNS = [3, 4, 5] as const;
const LAST_PERSON_ROW = 5;
const LAYOUT = { lastPersonRow: LAST_PERSON_ROW, dateColumns: DATE_COLUMNS };

/** A C5-shaped sheet: A name, B history, C-E dates, F one extra summary column. */
function scheduleSheet(): ExcelJS.Worksheet {
  const sheet = new ExcelJS.Workbook().addWorksheet("Sheet1");
  sheet.getCell(1, 3).value = 18;
  sheet.getCell(2, 2).value = "History";
  for (const [row, name] of [
    [3, "P1"],
    [4, "P2"],
    [5, "P3"],
    [6, "Score"],
    [7, "Status"],
  ] as const) {
    sheet.getCell(row, 1).value = name;
    for (const col of [2, 3, 4, 5]) sheet.getCell(row, col).value = "D";
    sheet.getCell(row, 6).value = row <= 5 ? row : null;
  }
  sheet.getCell(6, 3).value = 9;
  sheet.getCell(7, 3).value = "OPTIMAL";
  sheet.getCell(9, 1).value = "Duty count";
  for (const col of DATE_COLUMNS) sheet.getCell(9, col).value = 1;
  return sheet;
}

function planFor(
  entries: readonly RosterCoverEntry[],
  countCredits: CoverSheetPlan["countCredits"] = [],
): CoverSheetPlan {
  const built = buildCoverSheetPlan(scenarioDocument(), entries);
  if (built === null) throw new Error("expected a plan");
  return { ...built, countCredits };
}

function addFormat(sheet: ExcelJS.Worksheet, ref: string, priority: number): void {
  sheet.addConditionalFormatting({
    ref,
    rules: [
      {
        type: "cellIs",
        operator: "greaterThan",
        formulae: [0],
        priority,
        style: { font: { bold: true } },
      },
    ],
  });
}

/** Round-trip through the writer: CF refs are asserted as serialized. */
async function conditionalFormatRefs(sheet: ExcelJS.Worksheet): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await sheet.workbook.xlsx.writeBuffer());
  const formats = (
    workbook.worksheets[0] as unknown as {
      conditionalFormattings?: ExcelJS.ConditionalFormattingOptions[];
    }
  ).conditionalFormattings;
  return (formats ?? []).map((format) => format.ref);
}

function sheetRows(sheet: ExcelJS.Worksheet): ExcelJS.CellValue[][] {
  const rows: ExcelJS.CellValue[][] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row: ExcelJS.CellValue[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) row.push(sheet.getCell(r, c).value);
    rows.push(row);
  }
  return rows;
}

describe("applyCoverSheet", () => {
  it("cover rows sit under the staff rows and Score/Status move down", () => {
    const sheet = scheduleSheet();
    applyCoverSheet(sheet.workbook, planFor([HASSEENA]), LAYOUT);

    // Her row is the new last staff row; the summary block moved below it.
    expect(sheet.getCell(6, 1).value).toBe("Haseena (Ward 3)");
    expect(sheet.getCell(7, 1).value).toBe("Score");
    expect(sheet.getCell(7, 3).value).toBe(9);
    expect(sheet.getCell(8, 1).value).toBe("Status");
    expect(sheet.getCell(8, 3).value).toBe("OPTIMAL");

    // Her shift on her date; every other date cell blank.
    expect(sheet.getCell(6, 3).value).toBe("");
    expect(sheet.getCell(6, 4).value).toBe("");
    expect(sheet.getCell(6, 5).value).toBe("N");
  });

  it("her summary cells are blank", () => {
    const sheet = scheduleSheet();
    applyCoverSheet(sheet.workbook, planFor([HASSEENA]), LAYOUT);

    // The history column and the extra summary column read empty, never OFF and
    // never a staff tally.
    expect(sheet.getCell(6, 2).value).toBe("");
    expect(sheet.getCell(6, 6).value).toBe("");
  });

  it("writes the credit into the count row whose header matches", () => {
    const sheet = scheduleSheet();
    applyCoverSheet(
      sheet.workbook,
      planFor(
        [HASSEENA],
        [
          { header: "Duty count", byDate: [0, 0, 1] },
          { header: "Not a row here", byDate: [0, 0, 4] },
        ],
      ),
      LAYOUT,
    );

    // The count row moved down with the summary block.
    expect(sheet.getCell(10, 1).value).toBe("Duty count");
    expect(sheet.getCell(10, 3).value).toBe(1); // untouched date
    expect(sheet.getCell(10, 4).value).toBe(1); // untouched date
    expect(sheet.getCell(10, 5).value).toBe(2); // her date: +1
  });

  it("CF ranges shift with the inserted rows", async () => {
    const sheet = scheduleSheet();
    addFormat(sheet, "A6:E7", 1); // the summary block, below the insert
    addFormat(sheet, "A3:E5", 2); // the staff rows, above it
    applyCoverSheet(sheet.workbook, planFor([HASSEENA]), LAYOUT);
    expect(await conditionalFormatRefs(sheet)).toEqual(["A7:E8", "A3:E5"]);
  });

  it("provenance lists name, ISO date, shift id and groups JSON", () => {
    const sheet = scheduleSheet();
    applyCoverSheet(sheet.workbook, planFor([HASSEENA]), LAYOUT);

    const provenance = sheet.workbook.worksheets.find((ws) => ws.name === "Roster provenance");
    expect(provenance).toBeDefined();
    const rows = sheetRows(provenance!);
    expect(rows).toContainEqual(["Temporary cover", null, null, null]);
    expect(rows).toContainEqual(["Name", "Date", "Shift type", "Groups"]);
    expect(rows).toContainEqual(["Haseena (Ward 3)", "2023-08-20", "N", '["Ward 3"]']);
  });

  it("appends the cover table to a provenance sheet the export already wrote", () => {
    const sheet = scheduleSheet();
    const provenance = sheet.workbook.addWorksheet("Roster provenance");
    provenance.addRow(["Solver status (as solved)", "OPTIMAL"]);
    applyCoverSheet(sheet.workbook, planFor([HASSEENA]), LAYOUT);

    const rows = sheetRows(provenance);
    expect(rows).toContainEqual(["Solver status (as solved)", "OPTIMAL", null, null]);
    expect(rows).toContainEqual(["Name", "Date", "Shift type", "Groups"]);
    expect(rows).toContainEqual(["Haseena (Ward 3)", "2023-08-20", "N", '["Ward 3"]']);
  });

  it("writes nothing but the provenance table when the plan has no rows", () => {
    const sheet = scheduleSheet();
    const plan = planFor([HASSEENA]);
    applyCoverSheet(sheet.workbook, { ...plan, rows: [] }, LAYOUT);

    expect(sheet.getCell(6, 1).value).toBe("Score");
    expect(sheet.getCell(7, 1).value).toBe("Status");
    expect(sheet.workbook.worksheets.some((ws) => ws.name === "Roster provenance")).toBe(true);
  });
});
