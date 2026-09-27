import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { MAX_TEXT_BYTES } from "./attachment-rules";
import { XLSX_MAX_COLUMNS, XLSX_MAX_ROWS, xlsxToText } from "./xlsx-text";

async function workbookBytes(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("xlsx attachments as text (6eli)", () => {
  it("writes every sheet as CSV under its name, with cached values", async () => {
    const bytes = await workbookBytes((wb) => {
      const roster = wb.addWorksheet("Roster");
      roster.addRow(["Name", "Date", "Shifts", "Note"]);
      roster.addRow(["Ana", new Date(Date.UTC(2026, 10, 3)), 5, 'Nights, "late"']);
      roster.addRow([
        { richText: [{ text: "Ben" }, { text: " Ode" }] },
        null,
        { formula: "C2+1", result: 6 },
        { formula: 'IF(C3>5,"full","")', result: "full" },
      ]);
      const leave = wb.addWorksheet("Leave");
      leave.addRow(["Who", "Days"]);
      leave.addRow(["Ana", 3]);
    });

    expect(await xlsxToText(bytes, "ward.xlsx")).toBe(
      [
        "## Sheet: Roster",
        "Name,Date,Shifts,Note",
        'Ana,2026-11-03,5,"Nights, ""late"""',
        "Ben Ode,,6,full",
        "",
        "## Sheet: Leave",
        "Who,Days",
        "Ana,3",
      ].join("\n"),
    );
  });

  it("cuts a sheet at the row and column bounds and says so", async () => {
    const bytes = await workbookBytes((wb) => {
      const big = wb.addWorksheet("Big");
      for (let r = 0; r < XLSX_MAX_ROWS + 5; r += 1) {
        big.addRow(Array.from({ length: XLSX_MAX_COLUMNS + 3 }, (_, c) => c));
      }
    });

    const lines = (await xlsxToText(bytes, "big.xlsx")).split("\n");
    expect(lines[0]).toBe("## Sheet: Big");
    expect(lines).toHaveLength(1 + XLSX_MAX_ROWS + 1);
    expect(lines[1].split(",")).toHaveLength(XLSX_MAX_COLUMNS);
    expect(lines.at(-1)).toBe(
      `[Only the first ${XLSX_MAX_ROWS} rows and ${XLSX_MAX_COLUMNS} columns are shown.]`,
    );
  });

  it("refuses converted text over 200 KB, a password-protected file and a non-workbook", async () => {
    const huge = await workbookBytes((wb) => {
      const sheet = wb.addWorksheet("Notes");
      for (let r = 0; r < 60; r += 1) sheet.addRow(["x".repeat(4000)]);
    });
    expect(MAX_TEXT_BYTES).toBe(200 * 1024);
    await expect(xlsxToText(huge, "notes.xlsx")).rejects.toThrow(
      '"notes.xlsx" is larger than 200 KB once converted to text. Remove the sheets or rows you do not need and attach it again.',
    );

    // An encrypted workbook is an OLE compound file, not a zip.
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(xlsxToText(ole, "locked.xlsx")).rejects.toThrow(
      '"locked.xlsx" is password-protected or an old .xls file. Save it as an .xlsx without a password and attach it again.',
    );
    await expect(xlsxToText(new TextEncoder().encode("a,b"), "fake.xlsx")).rejects.toThrow(
      '"fake.xlsx" could not be read as an Excel workbook.',
    );
  });
});
