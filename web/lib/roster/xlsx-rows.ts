// Styled row insert for the frozen C5 workbook (bead 6iw). ExcelJS's `insertRow`
// re-anchors merged cells itself (`spliceRows` remerges every shifted master) but
// never touches `conditionalFormattings`, so those ranges are shifted here by hand.

import type ExcelJS from "exceljs";

/**
 * Insert `count` empty rows at `beforeRow`, give each the style and height of row
 * `beforeRow - 1`, and move every conditional-format range at or below the insert
 * down by `count`.
 */
export function insertStyledRows(sheet: ExcelJS.Worksheet, beforeRow: number, count: number): void {
  for (let i = 0; i < count; i++) {
    sheet.insertRow(beforeRow + i, []);
    copyRowStyle(sheet, beforeRow - 1, beforeRow + i);
  }
  shiftConditionalFormatsForInsert(sheet, beforeRow, count);
}

/**
 * Copy a worksheet row's styling — every cell's style, plus the row height — onto
 * another row, so an inserted row reads as its neighbour rather than a bare row. Mirrors the copy ExcelJS itself performs when `spliceRows` shifts a row.
 */
function copyRowStyle(sheet: ExcelJS.Worksheet, sourceRow: number, targetRow: number): void {
  const source = sheet.getRow(sourceRow);
  const target = sheet.getRow(targetRow);
  target.height = source.height;
  for (let col = 1; col <= sheet.columnCount; col++) {
    target.getCell(col).style = source.getCell(col).style;
  }
}

/**
 * The worksheet's conditional-format definitions. ExcelJS carries these at runtime
 * (`worksheet.conditionalFormattings`, serialized through `worksheet.model`) but
 * its typings omit the field, so the read is narrowed here.
 */
function conditionalFormats(sheet: ExcelJS.Worksheet): ExcelJS.ConditionalFormattingOptions[] {
  return (
    (sheet as unknown as { conditionalFormattings?: ExcelJS.ConditionalFormattingOptions[] })
      .conditionalFormattings ?? []
  );
}

/**
 * Move every conditional-format range that sits at or below an inserted row down
 * with the rows it covers. `insertRow` re-anchors merged cells but leaves the CF
 * ranges alone, so without this a rule keeps pointing at rows its subject has just
 * left. A range wholly above the insert is untouched; a range at or below it
 * shifts by the inserted count. A ref ExcelJS cannot read as cell addresses — a
 * whole-column `B:D`, say — is left exactly as it was rather than guessed at.
 */
function shiftConditionalFormatsForInsert(
  sheet: ExcelJS.Worksheet,
  insertRow: number,
  insertedCount: number,
): void {
  if (insertedCount === 0) return;
  for (const format of conditionalFormats(sheet)) {
    const shifted = shiftRangeRef(sheet, format.ref, insertRow, insertedCount);
    if (shifted !== null) {
      format.ref = shifted;
    }
  }
}

/**
 * Shift one conditional-format ref (`A6:E7`, or the space-separated
 * `A6:E7 B1:B9` form), returning the new ref — or null if it is not a set of
 * single-cell ranges, in which case the caller keeps the original.
 */
function shiftRangeRef(
  sheet: ExcelJS.Worksheet,
  ref: string,
  insertRow: number,
  insertedCount: number,
): string | null {
  const ranges = ref
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (ranges.length === 0) return null;

  const shiftedRanges: string[] = [];
  for (const range of ranges) {
    const endpoints = range.split(":");
    if (endpoints.length > 2) return null;
    const shiftedEndpoints: string[] = [];
    for (const endpoint of endpoints) {
      let cell: ExcelJS.Cell;
      try {
        cell = sheet.getCell(endpoint);
      } catch {
        return null; // Not one cell (a whole-column ref, say): leave the ref alone.
      }
      // `Cell.row`/`Cell.col` are typed `string` by ExcelJS's typings though they
      // are numbers at runtime; `fullAddress` carries the numeric pair.
      const { row, col } = cell.fullAddress;
      shiftedEndpoints.push(
        sheet.getCell(row >= insertRow ? row + insertedCount : row, col).address,
      );
    }
    shiftedRanges.push(shiftedEndpoints.join(":"));
  }
  return shiftedRanges.join(" ");
}
