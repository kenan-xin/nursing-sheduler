// An .xlsx attachment as text (bead 6eli). The composer converts the workbook in the
// browser and sends the result as an ordinary CSV text attachment, so the server
// never parses a workbook and its text rules (type by content, 200 KB) still apply.
// Every sheet is written as CSV under a "## Sheet: <name>" heading, bounded in rows
// and columns, with formulas as their cached results.
//
// ponytail: the 10 MB file cap is the only bound on the zip's expanded size (ExcelJS
// inflates it all); a crafted zip bomb can hang only the tab of the user who attached it.

import type ExcelJS from "exceljs";

import { MAX_TEXT_BYTES } from "./attachment-rules";

export const XLSX_MAX_SHEETS = 20;
export const XLSX_MAX_ROWS = 500;
export const XLSX_MAX_COLUMNS = 60;

/** An encrypted workbook (and an old .xls) is an OLE compound file, not a zip. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const startsWith = (data: Uint8Array, prefix: readonly number[]) =>
  prefix.every((byte, i) => data[i] === byte);

function dateText(date: Date): string {
  const iso = date.toISOString();
  return iso.endsWith("T00:00:00.000Z")
    ? iso.slice(0, 10)
    : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** A cell's shown value: a formula's cached result, rich text joined, a link's text. */
function valueText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return dateText(value);
  if (typeof value !== "object") return String(value);
  if ("result" in value) return valueText(value.result as ExcelJS.CellValue);
  if ("richText" in value) return value.richText.map((run) => run.text).join("");
  if ("text" in value) return valueText(value.text as ExcelJS.CellValue);
  if ("error" in value) return value.error;
  return "";
}

const csvField = (text: string) =>
  /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

function sheetText(sheet: ExcelJS.Worksheet, mergeType: number): string[] {
  const rows = Math.min(sheet.rowCount, XLSX_MAX_ROWS);
  const columns = Math.min(sheet.columnCount, XLSX_MAX_COLUMNS);
  const lines = [`## Sheet: ${sheet.name}`];
  for (let r = 1; r <= rows; r += 1) {
    const row = sheet.findRow(r);
    const fields: string[] = [];
    for (let c = 1; c <= columns; c += 1) {
      const cell = row?.getCell(c);
      // A merged range keeps its value in the top-left cell only.
      fields.push(!cell || cell.type === mergeType ? "" : csvField(valueText(cell.value)));
    }
    lines.push(fields.join(","));
  }
  if (sheet.rowCount > XLSX_MAX_ROWS || sheet.columnCount > XLSX_MAX_COLUMNS) {
    lines.push(`[Only the first ${XLSX_MAX_ROWS} rows and ${XLSX_MAX_COLUMNS} columns are shown.]`);
  }
  return lines;
}

/**
 * The workbook as CSV text, or an Error whose message is the reason to show. The
 * messages name the file and never quote its content.
 */
export async function xlsxToText(bytes: Uint8Array, name: string): Promise<string> {
  if (startsWith(bytes, OLE)) {
    throw new Error(
      `"${name}" is password-protected or an old .xls file. Save it as an .xlsx without a password and attach it again.`,
    );
  }
  const unreadable = new Error(`"${name}" could not be read as an Excel workbook.`);
  if (!startsWith(bytes, ZIP)) throw unreadable;
  const ExcelJs = ((await import("exceljs")) as { default: typeof ExcelJS }).default;
  const workbook = new ExcelJs.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw unreadable;
  }
  const sheets = workbook.worksheets.slice(0, XLSX_MAX_SHEETS);
  const blocks = sheets.map((sheet) => sheetText(sheet, ExcelJs.ValueType.Merge).join("\n"));
  if (workbook.worksheets.length > XLSX_MAX_SHEETS) {
    blocks.push(`[Only the first ${XLSX_MAX_SHEETS} sheets are shown.]`);
  }
  const text = blocks.join("\n\n");
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    throw new Error(
      `"${name}" is larger than 200 KB once converted to text. Remove the sheets or rows you do not need and attach it again.`,
    );
  }
  return text;
}
