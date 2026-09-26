// Edited-XLSX export (F5, the B4 fix): patch the frozen solved workbook with the
// current edit overlay, never recomputing solver-derived styling.
//
// The frozen workbook is the de-anonymized styled output captured at solve time
// (F2 reuses the restored parity-download blob). Edits are a bounded overlay, so
// the export loads those bytes with ExcelJS and patches ONLY the edited cells —
// every unedited cell, the Score/Status rows, summaries, and the worksheet
// geometry are reproduced exactly as solved.
//
// The patch matrix (Core Flows Flow 5 + Tech Plan "Edited-XLSX export"), applied
// per edited coordinate (`row = peopleRows[personIdx]`, `col = dateColumns[dateIdx]`):
//
//   • Value            → the new day-state display (OFF→"", Leave→"Leave", worked→shift id)
//   • Fill / font      → CLEARED together (edited cells render plain); their static and
//                        conditional origins are merged in the frozen bytes and cannot be
//                        safely separated, so both styling vehicles are stripped.
//   • Border           → PRESERVED wholesale (`cell.border` untouched); its origins are
//                        likewise merged and not separable from the frozen bytes.
//   • Cell hyperlink   → REMOVED (it pointed into the Notes sheet; see below).
//   • Notes rows       → every Notes row for the edited cell is REMOVED, and the Notes
//                        sheet plus every SURVIVING hyperlink is rebuilt, because splicing
//                        rows in place shifts the row numbers other cells' hyperlinks
//                        target and corrupts untouched links (exporter.py:781-806).
//   • appendText       → OMITTED (the new value carries no appended annotation text).
//
// Borrowed rows (F5 borrowed-nurse support) are INSERTED after the last solved
// person row, styled from the neighbouring person row so they read as roster rows.
// ExcelJS re-anchors merged cells across that insert but leaves conditional-format
// ranges at their old rows, so the patcher shifts those ranges itself.
//
// Provenance (solver status/score "as solved" + edited-since marker) is written to a
// DEDICATED sheet, never into the schedule sheet — the frontend's restoration boundary
// parses sheet[0] column A and the literal `Score`/`Status` labels, so provenance must
// never relabel those rows or insert between the people window and them.
//
// ExcelJS re-serializes the whole workbook, so byte-identical output is not claimed
// (ZIP framing, calc-chain, and parts ExcelJS does not model shift). The proof is a
// semantic one: unedited surfaces reproduce exactly, and edited surfaces match the
// matrix. That is what the openpyxl semantic diff in the test suite asserts.

import type ExcelJS from "exceljs";

import { dayStateDisplay } from "./day-state";
import { deriveCurrentDays } from "./overlay";
import type {
  RosterBorrowedRow,
  RosterCoordinateMap,
  RosterDayState,
  RosterEdit,
  RosterProvenance,
} from "./types";

/** The day-state patch for one edited coordinate. */
export interface EditedCellPatch {
  /** 1-based worksheet row, from `coordinateMap.peopleRows[personIdx]`. */
  readonly row: number;
  /** 1-based worksheet column, from `coordinateMap.dateColumns[dateIdx]`. */
  readonly col: number;
  /** The new day-state to write. */
  readonly day: RosterDayState;
}

/** The A1 address of an edited cell, for Notes-sheet matching. */
export interface EditedCoordinateAddress {
  readonly row: number;
  readonly col: number;
  readonly address: string;
}

/** A patch request: the frozen workbook plus the normalized overlay + axes. */
export interface EditedXlsxPatchInput {
  /** The de-anonymized frozen workbook, as captured at solve time. */
  readonly frozenXlsx: Blob;
  /** The normalized edit overlay (one entry per edited coordinate). */
  readonly edits: readonly RosterEdit[];
  /**
   * Borrowed rows (roster-file/2). Each becomes a plain row inserted right after the
   * last person row, so Score/Status and the rows below move down by one.
   */
  readonly borrowed?: readonly RosterBorrowedRow[];
  /** Explicit 1-based worksheet axes — never re-derived from the workbook. */
  readonly coordinateMap: RosterCoordinateMap;
  /** Solve provenance, written "as solved" into the dedicated sheet. */
  readonly provenance: RosterProvenance;
}

/** The provenance view written into the dedicated sheet. */
export interface EditedXlsxProvenanceView {
  readonly solverStatus: string;
  readonly score: number;
  readonly solvedBaselineId: string;
  readonly appBuild: string;
}

export type PatchEditedXlsxResult = { ok: true; blob: Blob } | { ok: false; reason: string };

/** Thrown for every fail-closed condition; never caught internally. */
export class EditedXlsxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EditedXlsxError";
  }
}

/** The schedule sheet is the first worksheet, by workbook position (Contract C5). */
const SCHEDULE_SHEET_INDEX = 0;

/** The Notes sheet's name, as the exporter creates it (`exporter.py:783`). */
const NOTES_SHEET_NAME = "Notes";

/** The dedicated provenance sheet's name. */
const PROVENANCE_SHEET_NAME = "Roster provenance";

/** The workbook media type the patched blob carries. */
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Lazily import ExcelJS so its substantial browser bundle is only fetched when an
 * edited-XLSX export actually runs (mirroring `restore-people-ids-in-xlsx.ts`).
 */
async function loadExcelJs(): Promise<typeof ExcelJS> {
  const mod = await import("exceljs");
  return (mod as { default: typeof ExcelJS }).default;
}

/** Build the per-cell patches from the overlay + the explicit coordinate axes. */
export function buildEditedCellPatches(
  edits: readonly RosterEdit[],
  coordinateMap: RosterCoordinateMap,
): EditedCellPatch[] {
  return edits.map((edit) => ({
    row: coordinateMap.peopleRows[edit.personIdx],
    col: coordinateMap.dateColumns[edit.dateIdx],
    day: edit.day,
  }));
}

/**
 * Patch the frozen workbook with the edit overlay and return a fresh blob.
 *
 * Fails closed (throws `EditedXlsxError`) if the workbook cannot be parsed or
 * does not match the expected C5 schedule-sheet layout. Never partially patches:
 * every edited cell is patched in one pass before re-serialization.
 */
export async function patchFrozenXlsxWithEdits(input: EditedXlsxPatchInput): Promise<Blob> {
  const borrowed = input.borrowed ?? [];
  if (input.edits.length === 0 && borrowed.length === 0) {
    // No edits: the frozen bytes are the export. Avoid an ExcelJS round-trip that
    // would re-serialize the whole workbook for no semantic change — the captured
    // bytes are exactly what the export should be.
    return input.frozenXlsx;
  }

  // Edits on a borrowed row are written with her whole row below, not patched.
  const solvedCount = input.coordinateMap.peopleRows.length;
  const patches = buildEditedCellPatches(
    input.edits.filter((edit) => edit.personIdx < solvedCount),
    input.coordinateMap,
  );
  const borrowedDays = deriveCurrentDays(
    borrowed.map((row) => row.days),
    input.edits
      .filter((edit) => edit.personIdx >= solvedCount)
      .map((edit) => ({ ...edit, personIdx: edit.personIdx - solvedCount })),
  );
  const ExcelJs = await loadExcelJs();

  const workbook = new ExcelJs.Workbook();
  const arrayBuffer = await input.frozenXlsx.arrayBuffer();
  try {
    await workbook.xlsx.load(arrayBuffer as unknown as ArrayBuffer);
  } catch (cause) {
    throw new EditedXlsxError("the frozen workbook could not be parsed by ExcelJS", { cause });
  }

  if (workbook.worksheets.length === 0) {
    throw new EditedXlsxError("the frozen workbook has no worksheets");
  }
  const sheet = workbook.worksheets[SCHEDULE_SHEET_INDEX];

  // Resolve each edited coordinate's A1 address once, for both the cell patch and
  // the Notes-sheet match. The address is derived from the SAME (row, col) the
  // patch writes, so a coordinate-map mismatch would surface here rather than
  // writing a valid edit into an unrelated cell.
  const addresses: EditedCoordinateAddress[] = patches.map((patch) => {
    const cell = sheet.getCell(patch.row, patch.col);
    return { row: patch.row, col: patch.col, address: cell.address };
  });
  const editedAddressSet = new Set(addresses.map((a) => a.address));

  // 1. Patch each edited cell: value (which also severs a value-folded Notes
  //    hyperlink — ExcelJS models a schedule cell's link as `{ text, hyperlink }`
  //    on the value, so a plain-string value drops it), fill/font cleared, and
  //    the border preserved wholesale.
  for (const patch of patches) {
    const cell = sheet.getCell(patch.row, patch.col);
    cell.value = dayStateDisplay(patch.day);
    clearCellFillAndFont(cell);
    // `cell.border` is intentionally untouched — preserved wholesale.
  }

  // 2. Rebuild the Notes sheet: drop every row for an edited coordinate, then
  //    rewrite the surviving rows contiguously and fix every affected hyperlink.
  rebuildNotesSheet(workbook, sheet, editedAddressSet);

  // 2b. Borrowed rows: each is inserted after the last solved person row and
  //     adopts the neighbouring person row's styling (cells and height), so she
  //     reads as a roster row rather than a bare one. Notes only point at person
  //     rows above, so no hyperlink moves.
  //
  //     ExcelJS's `insertRow` re-anchors MERGED cells itself (`spliceRows` remerges
  //     every shifted master), but it never touches `conditionalFormattings`, so
  //     those ranges are shifted here by hand.
  //
  //     ponytail: her extra columns and extra rows (the per-person and per-date
  //     count summaries) are not recomputed — the frozen workbook carries no count
  //     rules to recompute from, and counts are not recomputed for any edit either.
  const insertRow = input.coordinateMap.peopleRows[solvedCount - 1] + 1;
  borrowed.forEach((row, i) => {
    const rowNumber = insertRow + i;
    sheet.insertRow(rowNumber, []);
    copyRowStyle(sheet, rowNumber - 1, rowNumber);
    sheet.getCell(rowNumber, 1).value = String(row.id);
    input.coordinateMap.dateColumns.forEach((col, dateIdx) => {
      sheet.getCell(rowNumber, col).value = dayStateDisplay(borrowedDays[i][dateIdx]);
    });
  });
  shiftConditionalFormatsForInsert(sheet, insertRow, borrowed.length);

  // 3. Provenance: a dedicated sheet, never the schedule sheet. Remove any prior
  //    provenance sheet first so a re-export replaces rather than duplicates.
  writeProvenanceSheet(workbook, input.provenance);

  let outputBuffer: ExcelJS.Buffer;
  try {
    outputBuffer = await workbook.xlsx.writeBuffer();
  } catch (cause) {
    throw new EditedXlsxError("the patched workbook could not be re-serialized", { cause });
  }
  return new Blob([outputBuffer as BlobPart], { type: XLSX_MEDIA_TYPE });
}

/**
 * The robust entry point the UI calls. Wraps `patchFrozenXlsxWithEdits` and
 * converts a thrown `EditedXlsxError` into a typed failure so the caller can
 * surface a plain message and keep the roster visible.
 */
export async function tryPatchFrozenXlsxWithEdits(
  input: EditedXlsxPatchInput,
): Promise<PatchEditedXlsxResult> {
  try {
    const blob = await patchFrozenXlsxWithEdits(input);
    return { ok: true, blob };
  } catch (error) {
    if (error instanceof EditedXlsxError) {
      return { ok: false, reason: error.message };
    }
    return { ok: false, reason: "the edited workbook could not be exported" };
  }
}

/**
 * The visible text a schedule cell carries, whether it is a plain value or a
 * value-folded hyperlink (`{ text, hyperlink }`). Used when re-pointing a
 * surviving cell's hyperlink: the displayed assignment must not change.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "text" in value) {
    const text = (value as { text: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

/**
 * Re-point a surviving schedule cell's hyperlink into the rebuilt Notes sheet
 * WITHOUT changing its displayed assignment. ExcelJS models the link as
 * `{ text, hyperlink }` on the value (the separate `cell.hyperlink` property is
 * getter-only at runtime), so the value is re-wrapped around its current text.
 */
function pointCellHyperlink(cell: ExcelJS.Cell, target: string): void {
  cell.value = { text: cellText(cell.value), hyperlink: target };
}

// ---------------------------------------------------------------------------
// Cell-level patching
// ---------------------------------------------------------------------------

/**
 * Remove a cell's fill and font styling. The fill is set to "none" and the font's
 * color override is stripped (the structural name/size/family stay so the cell
 * reads as the same typeface — "plain" means no styling, not a different font).
 *
 * Fill and font are cleared TOGETHER because the frozen bytes merge their static
 * and conditional origins; stripping one but not the other would leave a
 * half-styled cell that no longer matches either its solved or its edited intent.
 */
function clearCellFillAndFont(cell: ExcelJS.Cell): void {
  cell.fill = { type: "pattern", pattern: "none" } as ExcelJS.FillPattern;
  const font = cell.font;
  if (font !== undefined) {
    // Drop the color override only. Keeping name/size/family preserves the
    // workbook's typeface so the edited cell blends structurally; the patch
    // matrix clears the *styling* vehicles (fill + font colour), not the type.
    const { color: _color, ...rest } = font;
    void _color;
    cell.font = rest as ExcelJS.Font;
  }
}

// ---------------------------------------------------------------------------
// Borrowed-row geometry: styling and conditional-format ranges
// ---------------------------------------------------------------------------

/**
 * Copy a worksheet row's styling — every cell's style, plus the row height — onto
 * another row, so a borrowed nurse's row reads as a person row rather than a bare
 * one. Mirrors the copy ExcelJS itself performs when `spliceRows` shifts a row.
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

// ---------------------------------------------------------------------------
// Notes sheet rebuild
// ---------------------------------------------------------------------------

interface NoteRow {
  /** The schedule-cell A1 coordinate this note row describes, e.g. "E3". */
  readonly coordinate: string;
  /** The frozen "Schedule Value" snapshot (column B). */
  readonly scheduleValue: ExcelJS.CellValue;
  /** The note text (column C). */
  readonly note: string;
}

/**
 * Remove every Notes row whose schedule cell was edited, then rewrite the Notes
 * sheet contiguously and repair every hyperlink that a row shift would have
 * broken. The exporter lays Notes out as one row per note, grouped by cell, with
 * the schedule cell linking to its FIRST note row and each note row linking back
 * (`exporter.py:781-806`); splicing in place corrupts the untouched groups.
 */
function rebuildNotesSheet(
  workbook: ExcelJS.Workbook,
  scheduleSheet: ExcelJS.Worksheet,
  editedAddresses: ReadonlySet<string>,
): void {
  const notes = workbook.worksheets.find((ws) => ws.name === NOTES_SHEET_NAME);
  if (notes === undefined) return; // No Notes sheet: nothing to rebuild.

  const rows = readNoteRows(notes);
  // Keep only the rows whose cell was NOT edited. A group whose cell was edited
  // vanishes entirely — every one of its rows goes, not just some.
  const surviving = rows.filter((row) => !editedAddresses.has(row.coordinate));

  // If nothing was edited inside the Notes sheet, no rebuild is needed: the row
  // numbers and hyperlinks are all still valid. (Edited cells without notes do
  // not appear here at all.)
  if (surviving.length === rows.length) return;

  rewriteNotesSheet(workbook, scheduleSheet, surviving);
}

/** Read every Notes data row (row 2+) as a typed record, preserving order. */
function readNoteRows(notes: ExcelJS.Worksheet): NoteRow[] {
  const rows: NoteRow[] = [];
  // Start at row 2: row 1 is the header (`Cell`, `Schedule Value`, `Note`).
  for (let rowNumber = 2; rowNumber <= notes.rowCount; rowNumber++) {
    const coordCell = notes.getCell(rowNumber, 1);
    const scheduleValue = notes.getCell(rowNumber, 2).value;
    const noteCell = notes.getCell(rowNumber, 3);
    const note = noteCell.value;
    if (typeof note !== "string") continue; // A malformed row is skipped, not fatal.

    const coordinate = noteRowCoordinate(coordCell.value);
    if (coordinate === null) continue;
    rows.push({ coordinate, scheduleValue, note });
  }
  return rows;
}

/** Extract the schedule-cell coordinate a Notes A-cell carries (string or hyperlink object). */
function noteRowCoordinate(value: ExcelJS.CellValue): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ("text" in value && typeof (value as { text: unknown }).text === "string") {
      return (value as { text: string }).text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Notes worksheet metadata preservation
// ---------------------------------------------------------------------------

/**
 * The genuine C5 Notes worksheet metadata the exporter sets (`exporter.py:786`:
 * `freeze_panes`, `auto_filter`, and per-column widths). Captured before the
 * rebuild removes the sheet and restored on the replacement so an edit does not
 * degrade an otherwise unedited Notes surface.
 */
interface NotesWorksheetMetadata {
  /** The frozen-pane view (the exporter freezes row 1 so the header stays put). */
  readonly views: ReadonlyArray<Record<string, unknown>>;
  /** The auto-filter range (the exporter filters `A1:C1`). */
  readonly autoFilter:
    | { from: { row: number; column: number }; to: { row: number; column: number } }
    | string
    | null;
  /** The per-column widths (A=14, B=24, C=80 in the genuine C5 fixture). */
  readonly columnWidths: ReadonlyArray<{ index: number; width: number | undefined }>;
}

/** Capture the Notes worksheet metadata before the sheet is removed. */
function captureNotesMetadata(notes: ExcelJS.Worksheet): NotesWorksheetMetadata {
  // Views: deep-ish copy each view's plain fields (state/xSplit/ySplit/topLeftCell).
  const views = (notes.views ?? []).map((view) => {
    const copy: Record<string, unknown> = {};
    const v = view as unknown as Record<string, unknown>;
    for (const key of [
      "state",
      "xSplit",
      "ySplit",
      "topLeftCell",
      "activeCell",
      "showGridLines",
      "zoomScale",
    ]) {
      if (v[key] !== undefined) copy[key] = v[key];
    }
    return copy;
  });

  // Auto-filter: ExcelJS exposes it as `{ from, to }` or a string; copy what is set.
  let autoFilter: NotesWorksheetMetadata["autoFilter"] = null;
  const af = (notes as unknown as { autoFilter?: NotesWorksheetMetadata["autoFilter"] }).autoFilter;
  if (af !== undefined && af !== null) {
    if (typeof af === "string") {
      autoFilter = af;
    } else if (typeof af === "object") {
      autoFilter = {
        from: { ...(af.from as { row: number; column: number }) },
        to: { ...(af.to as { row: number; column: number }) },
      };
    }
  }

  // Column widths: read each defined column's width up to the used width.
  const columnWidths: Array<{ index: number; width: number | undefined }> = [];
  const widthCount = notes.columnCount;
  for (let i = 1; i <= widthCount; i += 1) {
    const width = notes.getColumn(i).width;
    columnWidths.push({ index: i, width });
  }

  return { views, autoFilter, columnWidths };
}

/** Restore captured Notes worksheet metadata onto the rebuilt sheet. */
function applyNotesMetadata(notes: ExcelJS.Worksheet, metadata: NotesWorksheetMetadata): void {
  // Views (freeze panes).
  if (metadata.views.length > 0) {
    notes.views = metadata.views.map((v) => ({ ...v })) as unknown as typeof notes.views;
  }
  // Auto-filter.
  if (metadata.autoFilter !== null) {
    (notes as unknown as { autoFilter: NotesWorksheetMetadata["autoFilter"] }).autoFilter =
      metadata.autoFilter;
  }
  // Column widths.
  for (const { index, width } of metadata.columnWidths) {
    if (width !== undefined) notes.getColumn(index).width = width;
  }
}

/**
 * Rewrite the Notes sheet from the surviving rows and repair every hyperlink.
 *
 * ExcelJS's `spliceRows` does not reliably clear rows when asked to remove from
 * row 1 (its `rowCount` stays stale), so the sheet is REMOVED and a fresh one
 * created. The genuine C5 Notes sheet carries worksheet metadata the exporter
 * sets (`freeze_panes`, `auto_filter`, and per-column widths — see
 * `exporter.py:786-788`); that metadata is captured before the removal and
 * restored on the replacement so an edit does not degrade an otherwise unedited
 * Notes surface. The schedule sheet (sheet[0]) is untouched; the Notes sheet's
 * workbook position may move, but it is resolved by name everywhere that matters.
 */
function rewriteNotesSheet(
  workbook: ExcelJS.Workbook,
  scheduleSheet: ExcelJS.Worksheet,
  surviving: readonly NoteRow[],
): void {
  const scheduleName = scheduleSheet.name.replace(/'/g, "''");
  const oldNotes = workbook.worksheets.find((ws) => ws.name === NOTES_SHEET_NAME);
  if (oldNotes === undefined) return;
  // Capture the genuine C5 Notes worksheet metadata before removing the sheet.
  const metadata = captureNotesMetadata(oldNotes);
  workbook.removeWorksheet(oldNotes.id);
  const notes = workbook.addWorksheet(NOTES_SHEET_NAME);
  const notesName = notes.name.replace(/'/g, "''");
  // Restore the captured metadata so an edit does not drop freeze panes, the
  // auto-filter, or column widths from an otherwise unedited Notes surface.
  applyNotesMetadata(notes, metadata);

  notes.addRow(["Cell", "Schedule Value", "Note"]);

  // Group surviving rows by coordinate, preserving first-seen order so the
  // rebuild is deterministic and matches the exporter's emission order.
  const groups = new Map<string, NoteRow[]>();
  const order: string[] = [];
  for (const row of surviving) {
    let group = groups.get(row.coordinate);
    if (group === undefined) {
      group = [];
      groups.set(row.coordinate, group);
      order.push(row.coordinate);
    }
    group.push(row);
  }

  for (const coordinate of order) {
    const group = groups.get(coordinate);
    if (group === undefined) continue;
    const firstAddedRow = notes.rowCount + 1;

    for (const row of group) {
      notes.addRow([
        { text: row.coordinate, hyperlink: `#'${scheduleName}'!${row.coordinate}` },
        row.scheduleValue,
        row.note,
      ]);
      // ExcelJS cannot apply openpyxl's named "Hyperlink" cell style (assigning a
      // style string corrupts its weak-map style model), so the standard link
      // appearance is set on the font directly. The hyperlink TARGET — the thing
      // the contract actually requires rebuilt — lives on the value above.
      const noteCell = notes.getCell(notes.rowCount, 1);
      noteCell.font = {
        ...noteCell.font,
        color: { argb: "FF0563C1" },
        underline: true,
      } as ExcelJS.Font;
    }

    // Point the schedule cell at the FIRST note row for this group, at its new
    // rebuilt address. A row shift cannot leave it dangling.
    const scheduleCell = findScheduleCellByAddress(scheduleSheet, coordinate);
    if (scheduleCell !== null) {
      pointCellHyperlink(scheduleCell, `#'${notesName}'!A${firstAddedRow}`);
    }
  }
}

/** Find a schedule-sheet cell by its A1 address (e.g. "E3"). */
function findScheduleCellByAddress(sheet: ExcelJS.Worksheet, address: string): ExcelJS.Cell | null {
  try {
    return sheet.getCell(address);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provenance sheet
// ---------------------------------------------------------------------------

/**
 * Write a dedicated provenance sheet carrying the "as solved" status/score and
 * the edited-since marker. The schedule sheet's own `Score`/`Status` labels are
 * never touched: a separate sheet cannot be misread by the col-A restoration
 * boundary, and replacing (not appending) keeps a re-export honest.
 */
function writeProvenanceSheet(workbook: ExcelJS.Workbook, provenance: RosterProvenance): void {
  const existing = workbook.worksheets.find((ws) => ws.name === PROVENANCE_SHEET_NAME);
  if (existing !== undefined) {
    workbook.removeWorksheet(existing.id);
  }
  const sheet = workbook.addWorksheet(PROVENANCE_SHEET_NAME);
  sheet.columns = [
    { header: "Field", key: "field", width: 32 },
    { header: "Value", key: "value", width: 48 },
  ];
  sheet.addRow(["Roster provenance", ""]);
  sheet.addRow(["Solver status (as solved)", provenance.solverStatus]);
  sheet.addRow(["Solver score (as solved)", provenance.score]);
  sheet.addRow(["Edited since solve", "yes"]);
  sheet.addRow(["Solved baseline", provenance.solvedBaselineId]);
  sheet.addRow(["Exported by app build", provenance.appBuild]);
}
