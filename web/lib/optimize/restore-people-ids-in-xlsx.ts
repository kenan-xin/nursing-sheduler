// T16c — restore original people ids in a downloaded anonymized XLSX.
//
// A pure Blob → Blob transform. It reads T16q's co-derived `PeopleReverseMap`
// (`[anonymizedId, originalId]` tuples) and rewrites ONLY the schedule sheet's
// people-id column, per Contract C5 [CON-OUT-41]: the FIRST worksheet (resolved
// by workbook order, not by name), 1-based rows `[3, 3 + peopleCount)`, column A.
//
// Mechanism mirrors the old application (`restorePeopleIdsInXlsx` in
// `web-frontend/src/utils`): the real backend C5 producer (openpyxl via
// `exporter.export_to_excel`, always with `prettify=True` for the downloaded
// file) emits a workbook ExcelJS 4.4.0 can both read and re-serialize, so we
// load it once, mutate only the targeted column-A cells (ExcelJS keeps each
// cell's existing style, number format, and address), and write a fresh buffer.
// Where the old app SILENTLY SKIPPED a non-string or unmapped cell, this module
// FAILS CLOSED on every deviation from the expected C5 layout — a shifted
// `Score`/`Status` boundary, a missing header row, a people-id cell that is not
// a mapped `P#`, an unused map entry — so the user is never handed a file that
// LOOKS restored while still leaking an anonymized `P#`.
//
// ExcelJS is loaded LAZILY via `await import("exceljs")` so the substantial
// browser bundle is only fetched when an anonymized restoration actually runs;
// the plain (non-anonymized) download never imports it.
//
// Scope is bounded to real C5 producer workbooks. This is not a general XLSX
// rewriter and makes no compatibility promise beyond that producer's output:
// ExcelJS re-serializes the whole workbook (so ZIP framing, calc-chain
// ordering, and parts ExcelJS does not model — images, drawings, external
// relationships — are not preserved by design). The independent openpyxl
// semantic diff in the test suite proves the cells and styles this module
// touches are preserved on real C5 output.

import type ExcelJS from "exceljs";

import {
  validatePeopleReverseMap,
  type PeopleReverseMap,
} from "../scenario/prepare-optimize-submission";
import type { PersonId } from "../scenario/types";

export const RESTORED_XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A well-formed generated id: `P` + a positive integer, no leading zero. */
const ANONYMIZED_ID_PATTERN = /^P[1-9][0-9]*$/;

/** The first data row of the schedule sheet's people-id column (Contract C5 [CON-OUT-41]). */
const FIRST_PEOPLE_ROW = 3;

/** C5 schedule-sheet layout facts shared by both plain and prettified backend
 *  workbooks. Used by `assertHeaderRows` to fail closed on an arbitrary
 *  first-sheet collision before any cell is touched. */
const HEADER_ROW_COUNT = 2;
/** The leading column-A header cell must be blank in the real C5 output. */
const LEADING_HEADER_COL = 1;
/** Schedule columns live to the right of column A. */
const FIRST_SCHEDULE_COL = 2;
/** C5 freezes column A and the two header rows, producing a B3 split. */
const FREEZE_LEFT_COL = 1;
const FREEZE_TOP_ROW = 2;
const FREEZE_TOP_LEFT_CELL = "B3";
/** Boundary row labels that must sit immediately after the people window. */
const SCORE_LABEL = "Score";
const STATUS_LABEL = "Status";

/** Thrown for every fail-closed condition: never caught internally, always propagated. */
export class XlsxRestorationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "XlsxRestorationError";
  }
}

/**
 * Validate and index a `PeopleReverseMap`, reusing T16q's
 * `validatePeopleReverseMap` so this module enforces exactly the same
 * well-formedness the wire path does (correct cardinality, unique well-formed
 * `P#` ids, unique typed originals — numeric `1` and string `"1"` stay
 * distinct). Fails closed on any malformed map.
 */
function indexReverseMap(
  reverseMap: PeopleReverseMap,
  peopleCount: number,
): ReadonlyMap<string, PersonId> {
  const validated = validatePeopleReverseMap(reverseMap, peopleCount);
  if (!validated) {
    throw new XlsxRestorationError("missing, malformed, or ambiguous people reverse map");
  }
  const lookup = new Map<string, PersonId>();
  for (const [anonymizedId, originalId] of validated) lookup.set(anonymizedId, originalId);
  return lookup;
}

/**
 * Lazily import ExcelJS so its browser bundle is only fetched when an
 * anonymized restoration actually runs. The plain (non-anonymized) download
 * path never reaches here, so it stays free of the ExcelJS cost.
 */
async function loadExcelJs(): Promise<typeof ExcelJS> {
  const mod = await import("exceljs");
  return (mod as { default: typeof ExcelJS }).default;
}

/** Read the schedule sheet's first worksheet by workbook position (Contract C5). */
function getFirstWorksheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  if (workbook.worksheets.length === 0) {
    throw new XlsxRestorationError("incompatible workbook: no worksheets");
  }
  return workbook.worksheets[0];
}

/**
 * Read a column-A people-id cell as a string, or fail closed. ExcelJS exposes
 * non-string cell values (numbers, dates, formulas, rich-text, hyperlinks,
 * booleans, errors) as either a primitive of the wrong type or a structured
 * object; any of those at a people-id row means the layout is not C5.
 */
function readPeopleIdCell(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (typeof value !== "string") {
    const ref = `A${cell.row}`;
    throw new XlsxRestorationError(
      `incompatible workbook: expected an anonymized person id string at ${ref}`,
    );
  }
  return value;
}

/** True when the cell carries no meaningful content (null/undefined/empty
 *  string). Used for the leading column-A header, which C5 emits blank. */
function isBlankCellValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length === 0;
  if (typeof value === "object") {
    // ExcelJS exposes rich-text as `{ richText: [...] }`; treat as non-blank.
    return false;
  }
  return false;
}

/** ExcelJS exposes C5's row-1 date headers as either a serial number or a JS
 *  `Date`, depending on the cell's `numFmt`. Both count as a real schedule
 *  column for the header-identity guard. */
function isDateHeaderValue(value: unknown): boolean {
  return typeof value === "number" || value instanceof Date;
}

/** C5's row-2 weekday names are non-empty strings like "Fri", "Sat", "Sun". */
function isWeekdayHeaderValue(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/** Inspect the leading column-A header cells. C5 leaves A1 and A2 blank; any
 *  populated value there means a non-C5 first worksheet. */
function assertLeadingHeaderBlank(sheet: ExcelJS.Worksheet): void {
  for (const row of [1, 2] as const) {
    const value = sheet.getCell(row, LEADING_HEADER_COL).value;
    if (!isBlankCellValue(value)) {
      throw new XlsxRestorationError(
        `incompatible workbook: expected blank leading header at A${row}, got ${JSON.stringify(value)}`,
      );
    }
  }
}

/** Find the first column at or after B whose row-1 + row-2 headers look like a
 *  real C5 schedule column (date serial / `Date` in row 1, non-empty weekday
 *  string in row 2). Returns the column index or throws. */
function assertScheduleColumnPresent(sheet: ExcelJS.Worksheet): number {
  const columnCount = Math.max(sheet.columnCount, FIRST_SCHEDULE_COL);
  for (let col = FIRST_SCHEDULE_COL; col <= columnCount; col += 1) {
    const dateValue = sheet.getCell(1, col).value;
    const weekdayValue = sheet.getCell(2, col).value;
    if (isDateHeaderValue(dateValue) && isWeekdayHeaderValue(weekdayValue)) {
      return col;
    }
  }
  throw new XlsxRestorationError(
    `incompatible workbook: no schedule column with a date in row 1 and a weekday string in row 2`,
  );
}

/**
 * Assert the C5 worksheet freeze boundary is exactly `B3` (column A and the
 * two header rows frozen). ExcelJS exposes this as `views[0]` with
 * `state === "frozen"`, `xSplit === 1`, `ySplit === 2`, and `topLeftCell ===
 * "B3"`. Any deviation — missing views, a different split, a different
 * top-left cell, or `state === "frozen"` with no split at all — fails closed.
 */
function assertFreezeBoundary(sheet: ExcelJS.Worksheet): void {
  const views = sheet.views;
  if (!Array.isArray(views) || views.length === 0) {
    throw new XlsxRestorationError(
      `incompatible workbook: expected a frozen view at B3, got no worksheet views`,
    );
  }
  const view = views[0];
  if (
    view?.state !== "frozen" ||
    view?.xSplit !== FREEZE_LEFT_COL ||
    view?.ySplit !== FREEZE_TOP_ROW ||
    view?.topLeftCell !== FREEZE_TOP_LEFT_CELL
  ) {
    throw new XlsxRestorationError(
      `incompatible workbook: expected frozen view at B3, got ${JSON.stringify(view)}`,
    );
  }
}

/**
 * Assert the real C5 schedule-sheet layout: the two header rows are present,
 * `A1`/`A2` are blank, at least one schedule column carries a row-1 date and
 * a row-2 weekday, and the freeze boundary is exactly `B3`. Every deviation
 * fails closed before any cell is touched.
 */
function assertHeaderRows(sheet: ExcelJS.Worksheet): void {
  if (sheet.rowCount < HEADER_ROW_COUNT) {
    throw new XlsxRestorationError(
      `incompatible workbook: expected at least ${HEADER_ROW_COUNT} header rows, got rowCount ${sheet.rowCount}`,
    );
  }
  assertLeadingHeaderBlank(sheet);
  assertScheduleColumnPresent(sheet);
  assertFreezeBoundary(sheet);
}

/**
 * Assert the `Score` and `Status` boundary labels sit exactly where
 * `peopleCount` places them. A mismatch means the layout (or the count) is
 * wrong — fail closed rather than rewrite arbitrary rows. ExcelJS exposes the
 * resolved string for shared/inline string cells, so the label is compared
 * directly.
 */
function assertBoundary(sheet: ExcelJS.Worksheet, peopleCount: number): void {
  const lastPeopleRow = FIRST_PEOPLE_ROW + peopleCount - 1;
  const expected: ReadonlyArray<readonly [number, string]> = [
    [lastPeopleRow + 1, SCORE_LABEL],
    [lastPeopleRow + 2, STATUS_LABEL],
  ];
  for (const [row, label] of expected) {
    const value = sheet.getCell(row, 1).value;
    if (value !== label) {
      throw new XlsxRestorationError(
        `incompatible workbook: expected "${label}" at A${row}, boundary does not match peopleCount ${peopleCount}`,
      );
    }
  }
}

/**
 * Validate the exact C5 schedule-sheet layout and mutate ONLY the column-A
 * people-id cells. Every check runs before any value is written wherever
 * practical: header and boundary structure is verified first, then each people
 * cell is read, validated, and overwritten. ExcelJS keeps each cell's style,
 * number format, and address when `cell.value` is reassigned, so only the
 * value (and the inferred type) changes.
 */
function restoreScheduleCells(
  sheet: ExcelJS.Worksheet,
  lookup: ReadonlyMap<string, PersonId>,
  peopleCount: number,
): void {
  assertHeaderRows(sheet);
  assertBoundary(sheet, peopleCount);

  const lastPeopleRow = FIRST_PEOPLE_ROW + peopleCount - 1;
  const usedIds = new Set<string>();

  for (let row = FIRST_PEOPLE_ROW; row <= lastPeopleRow; row += 1) {
    const cell = sheet.getCell(row, 1);
    const anonymizedId = readPeopleIdCell(cell);

    if (!ANONYMIZED_ID_PATTERN.test(anonymizedId)) {
      throw new XlsxRestorationError(
        `incompatible workbook: expected an anonymized "P#" id at A${row}, got "${anonymizedId}"`,
      );
    }
    if (usedIds.has(anonymizedId)) {
      throw new XlsxRestorationError(
        `incompatible workbook: duplicate anonymized id "${anonymizedId}" at A${row}`,
      );
    }
    const originalId = lookup.get(anonymizedId);
    if (originalId === undefined) {
      throw new XlsxRestorationError(
        `incomplete restoration: no reverse-map entry for "${anonymizedId}" at A${row}`,
      );
    }
    usedIds.add(anonymizedId);
    // Reassign in place so ExcelJS preserves the cell's style, number format,
    // and address. JS type drives the written OOXML type: a number becomes a
    // numeric cell, a string becomes a shared/inline string cell.
    cell.value = originalId;
  }

  if (usedIds.size !== peopleCount) {
    throw new XlsxRestorationError(
      `incomplete restoration: restored ${usedIds.size} of ${peopleCount} expected ids`,
    );
  }
}

/**
 * Restore original people ids into an anonymized XLSX download.
 *
 * Loads the workbook with ExcelJS, mutates only the first worksheet's column-A
 * cells for rows `[3, 3 + peopleCount)`, and re-serializes. Any deviation from
 * the expected C5 layout, or any unused reverse-map entry, fails closed rather
 * than shipping a partially or falsely "restored" file.
 */
export async function restorePeopleIdsInXlsx(
  xlsxBlob: Blob,
  reverseMap: PeopleReverseMap,
  peopleCount: number,
): Promise<Blob> {
  if (!Number.isInteger(peopleCount) || peopleCount <= 0) {
    throw new XlsxRestorationError(`invalid people count: ${peopleCount}`);
  }

  const lookup = indexReverseMap(reverseMap, peopleCount);
  const ExcelJs = await loadExcelJs();

  const workbook = new ExcelJs.Workbook();
  const arrayBuffer = await xlsxBlob.arrayBuffer();
  try {
    await workbook.xlsx.load(arrayBuffer as unknown as ArrayBuffer);
  } catch (cause) {
    throw new XlsxRestorationError("incompatible workbook: ExcelJS could not parse it", { cause });
  }

  const sheet = getFirstWorksheet(workbook);
  restoreScheduleCells(sheet, lookup, peopleCount);

  let outputBuffer: ExcelJS.Buffer;
  try {
    outputBuffer = await workbook.xlsx.writeBuffer();
  } catch (cause) {
    throw new XlsxRestorationError("failed to re-serialize restored workbook", { cause });
  }

  return new Blob([outputBuffer as BlobPart], { type: RESTORED_XLSX_MIME_TYPE });
}

/**
 * What a download caller (T16e) knows about a completed run's workbook: whether
 * it was anonymized, and — if so — the reverse map and people count needed to
 * restore it. Mirrors the co-derived fields of T16q's `OptimizeSubmissionPrep`.
 */
export interface PeopleIdRestorationInput {
  /** Whether the submission applied people-id anonymization. */
  readonly anonymized: boolean;
  /** The `[anonymizedId, originalId]` tuples; empty for a plain submission. */
  readonly reverseMap: PeopleReverseMap;
  /** People-item count of the submitted document (the restoration row window). */
  readonly peopleCount: number;
}

/**
 * The download seam T16e wires the "Download" action to. It keeps the
 * non-anonymized BYPASS out of the pure transform: a plain download returns the
 * SAME blob, never parsed or re-serialized, so its bytes stay exactly as the
 * backend produced them. Only an anonymized download runs the ExcelJS
 * restoration. Exposed (and tested) directly so T16e can rely on the bypass
 * decision without owning it.
 */
export async function applyPeopleIdRestoration(
  xlsxBlob: Blob,
  input: PeopleIdRestorationInput,
): Promise<Blob> {
  if (!input.anonymized) return xlsxBlob;
  return restorePeopleIdsInXlsx(xlsxBlob, input.reverseMap, input.peopleCount);
}
