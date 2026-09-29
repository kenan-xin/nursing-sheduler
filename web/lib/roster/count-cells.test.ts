// Audit C-10: the edited XLSX recounts the count cells an edit moves.
//
// The scenario and solved grid are the shared scenario fixture with v1's default
// layout, solved by the real core exporter (prettify): Alice has history D, then
// Leave, E, D, E, E, E, E; Bob works D every day except OFF on Sat 05-16.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import { withDefaultExportLayout } from "@/lib/scenario/default-export-layout";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";

import { buildCountCellDeltas } from "./count-cells";
import { EditedXlsxError, patchFrozenXlsxWithEdits } from "./edited-xlsx";
import type { RosterCoordinateMap, RosterDayState, RosterEdit, RosterProvenance } from "./types";

const S = (shiftId: string): RosterDayState => ({ kind: "shift", shiftId });
const OFF: RosterDayState = { kind: "off" };
const LV: RosterDayState = { kind: "leave" };

const state = makeValidUiState();
state.exportLayout.formatting = [];
const document = withDefaultExportLayout(toCanonicalScenarioDocument(state));
// 2026-05-14 (Thu) .. 2026-05-20 (Wed).
const solvedDays = [
  [LV, S("E"), S("D"), S("E"), S("E"), S("E"), S("E")],
  [S("D"), S("D"), OFF, S("D"), S("D"), S("D"), S("D")],
];
// Exporter layout: name col, 1 history col, 7 dates (cols 3-9), separator col 10,
// extra columns from 11; people rows 3-4, Score 5, Status 6, separator 7, extra rows from 8.
const coordinateMap: RosterCoordinateMap = {
  peopleRows: [3, 4],
  dateColumns: [3, 4, 5, 6, 7, 8, 9],
  firstPeopleRow: 3,
  leadingCols: 1,
  historyCols: 1,
  prettify: true,
};
const COLUMN_HEADERS = [
  "OFF (Total)",
  "OFF (Weekday)",
  "OFF (Weekend)",
  "D Count",
  "E Count",
  "N Count",
  "DayOrEvening Count",
];
const ROW_HEADERS = ["D Count", "E Count", "N Count", "DayOrEvening Count"];

// Alice: Sat D -> OFF. Bob: Fri D -> E.
const edits: RosterEdit[] = [
  { personIdx: 0, dateIdx: 2, day: OFF },
  { personIdx: 1, dateIdx: 1, day: S("E") },
];

describe("buildCountCellDeltas", () => {
  it("moves each person's count columns and each date's count rows by the edit", () => {
    const deltas = buildCountCellDeltas(document, solvedDays, edits, coordinateMap).map(
      ({ row, col, delta, header }) => ({ row, col, delta, header }),
    );
    expect(deltas).toEqual([
      { row: 3, col: 11, delta: 1, header: "OFF (Total)" },
      { row: 3, col: 13, delta: 1, header: "OFF (Weekend)" },
      { row: 3, col: 14, delta: -1, header: "D Count" },
      { row: 4, col: 14, delta: -1, header: "D Count" },
      { row: 4, col: 15, delta: 1, header: "E Count" },
      { row: 3, col: 17, delta: -1, header: "DayOrEvening Count" },
      // Bob's D -> E stays inside DayOrEvening, so that column does not move.
      { row: 8, col: 5, delta: -1, header: "D Count" },
      { row: 8, col: 4, delta: -1, header: "D Count" },
      { row: 9, col: 4, delta: 1, header: "E Count" },
      { row: 11, col: 5, delta: -1, header: "DayOrEvening Count" },
    ]);
  });

  it("is empty without prettify, without a layout, or without edits", () => {
    expect(
      buildCountCellDeltas(document, solvedDays, edits, { ...coordinateMap, prettify: false }),
    ).toEqual([]);
    expect(
      buildCountCellDeltas({ ...document, export: undefined }, solvedDays, edits, coordinateMap),
    ).toEqual([]);
    expect(buildCountCellDeltas(document, solvedDays, [], coordinateMap)).toEqual([]);
  });
});

describe("patchFrozenXlsxWithEdits count cells", () => {
  const provenance: RosterProvenance = {
    solverStatus: "OPTIMAL",
    score: 3,
    solvedBaselineId: "b",
    appBuild: "t",
  };

  async function frozenWorkbook(): Promise<Blob> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Sheet1");
    COLUMN_HEADERS.forEach((header, j) => (sheet.getCell(2, 11 + j).value = header));
    sheet.getCell(3, 1).value = "Alice";
    sheet.getCell(4, 1).value = "Bob";
    [0, 0, 0, 1, 5, 0, 6].forEach((v, j) => (sheet.getCell(3, 11 + j).value = v));
    [1, 0, 1, 6, 0, 0, 6].forEach((v, j) => (sheet.getCell(4, 11 + j).value = v));
    sheet.getCell(5, 1).value = "Score";
    sheet.getCell(5, 3).value = 3;
    sheet.getCell(6, 1).value = "Status";
    ROW_HEADERS.forEach((header, j) => (sheet.getCell(8 + j, 1).value = header));
    [1, 1, 1, 1, 1, 1, 1].forEach((v, d) => (sheet.getCell(8, 3 + d).value = v));
    [0, 1, 0, 1, 1, 1, 1].forEach((v, d) => (sheet.getCell(9, 3 + d).value = v));
    [1, 2, 1, 2, 2, 2, 2].forEach((v, d) => (sheet.getCell(11, 3 + d).value = v));
    const buffer = await wb.xlsx.writeBuffer();
    return new Blob([buffer as BlobPart]);
  }

  it("writes the recounted values and labels the Score as solved", async () => {
    const blob = await patchFrozenXlsxWithEdits({
      frozenXlsx: await frozenWorkbook(),
      edits,
      coordinateMap,
      provenance,
      counts: buildCountCellDeltas(document, solvedDays, edits, coordinateMap),
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await blob.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    const row = (r: number, from: number, n: number) =>
      Array.from({ length: n }, (_, i) => sheet.getCell(r, from + i).value);
    expect(row(3, 11, 7)).toEqual([1, 0, 1, 0, 5, 0, 5]);
    expect(row(4, 11, 7)).toEqual([1, 0, 1, 5, 1, 0, 6]);
    expect(row(8, 3, 7)).toEqual([1, 0, 0, 1, 1, 1, 1]);
    expect(row(9, 3, 7)).toEqual([0, 2, 0, 1, 1, 1, 1]);
    expect(row(11, 3, 7)).toEqual([1, 2, 0, 2, 2, 2, 2]);
    expect(sheet.getCell(5, 1).value).toBe("Score");
    expect(sheet.getCell(5, 3).value).toBe(3);
    expect(sheet.getCell(5, 4).value).toBe("as solved, before edits");
  });

  it("fails closed when a count header is not where the submission puts it", async () => {
    const counts = buildCountCellDeltas(document, solvedDays, edits, coordinateMap).map((c) => ({
      ...c,
      header: "Something else",
    }));
    await expect(
      patchFrozenXlsxWithEdits({
        frozenXlsx: await frozenWorkbook(),
        edits,
        coordinateMap,
        provenance,
        counts,
      }),
    ).rejects.toBeInstanceOf(EditedXlsxError);
  });
});
