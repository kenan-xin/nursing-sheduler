// insertStyledRows (bead 6iw, kept through the d582 g1p revert): an inserted row
// reads as its neighbour and conditional-format ranges follow the rows they cover.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { insertStyledRows } from "./xlsx-rows";

/** A C5-shaped sheet: header rows 1-2, people rows 3-5, Score 6, Status 7. */
function scheduleSheet(): ExcelJS.Worksheet {
  const sheet = new ExcelJS.Workbook().addWorksheet("Sheet1");
  sheet.getCell(1, 1).value = "Name";
  for (const [row, name] of [
    [3, "P1"],
    [4, "P2"],
    [5, "P3"],
    [6, "Score"],
    [7, "Status"],
  ] as const) {
    sheet.getCell(row, 1).value = name;
    for (let col = 2; col <= 5; col++) sheet.getCell(row, col).value = "D";
  }
  for (let col = 1; col <= 5; col++) {
    sheet.getCell(5, col).alignment = { horizontal: "center" };
    sheet.getCell(5, col).border = { bottom: { style: "medium" } };
  }
  sheet.getRow(5).height = 24;
  return sheet;
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

/** Round-trip through the writer: merges and CF refs are asserted as serialized. */
async function reread(sheet: ExcelJS.Worksheet): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await sheet.workbook.xlsx.writeBuffer());
  return workbook.worksheets[0];
}

async function conditionalFormatRefs(sheet: ExcelJS.Worksheet): Promise<string[]> {
  const formats = (
    (await reread(sheet)) as unknown as {
      conditionalFormattings?: ExcelJS.ConditionalFormattingOptions[];
    }
  ).conditionalFormattings;
  return (formats ?? []).map((format) => format.ref);
}

describe("insertStyledRows", () => {
  it("copies the neighbouring row style and height", () => {
    const sheet = scheduleSheet();
    insertStyledRows(sheet, 6, 1);
    for (let col = 1; col <= 5; col++) {
      expect(sheet.getCell(6, col).style).toEqual(sheet.getCell(5, col).style);
    }
    expect(sheet.getCell(6, 1).border).toMatchObject({ bottom: { style: "medium" } });
    expect(sheet.getRow(6).height).toBe(24);
    expect(sheet.getCell(6, 1).value).toBeNull();
    expect(sheet.getCell(7, 1).value).toBe("Score");
  });

  it("shifts CF ranges at or below the insert", async () => {
    const sheet = scheduleSheet();
    addFormat(sheet, "A6:E7", 1);
    addFormat(sheet, "C3:E3 D6:D6", 2);
    insertStyledRows(sheet, 6, 1);
    expect(await conditionalFormatRefs(sheet)).toEqual(["A7:E8", "C3:E3 D7:D7"]);
  });

  it("leaves CF ranges above the insert and whole-column refs alone", async () => {
    const sheet = scheduleSheet();
    addFormat(sheet, "A3:E5", 1);
    addFormat(sheet, "B:B", 2);
    insertStyledRows(sheet, 6, 1);
    expect(await conditionalFormatRefs(sheet)).toEqual(["A3:E5", "B:B"]);
  });

  it("inserts two rows", async () => {
    const sheet = scheduleSheet();
    sheet.mergeCells("A6:B6");
    addFormat(sheet, "A6:E7", 1);
    insertStyledRows(sheet, 6, 2);
    expect(sheet.getCell(8, 1).value).toBe("Score");
    expect(sheet.getCell(9, 1).value).toBe("Status");
    expect((await reread(sheet)).model.merges).toEqual(["A8:B8"]);
    for (let col = 1; col <= 5; col++) {
      expect(sheet.getCell(7, col).style).toEqual(sheet.getCell(5, col).style);
    }
    expect(await conditionalFormatRefs(sheet)).toEqual(["A8:E9"]);
  });
});
