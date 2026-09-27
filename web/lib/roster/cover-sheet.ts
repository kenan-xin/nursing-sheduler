// Temporary-cover rows for the exported workbook (d582, F6).
//
// A cover nurse is never a solver person, so she is never in the frozen workbook:
// her display rows are INSERTED under the ward staff window at export time, and
// her credit is added to the count rows by hand. The plan is built from the
// SUBMITTED document (`submission.canonicalYaml`), because the count rows are the
// submission's own `export.extraRows` and only the submission knows which dates
// the range covers; the entries come from the staged `document.cover.entries`
// (roster-file/2).
//
// One row per cover NAME (she may cover several dates), column A the name, her
// shift id on her dates and `""` everywhere else — never OFF, because nobody
// knows when she is off. Her per-person summary cells stay blank (§F6).
//
// The count-row credit is the SAME arithmetic every other reader uses
// (`coverCredit` + `groupClosureOf`, d582 Task 5): a count row counts her when
// its `countShiftTypes` expands to her shift and its `countPeople` is ALL or
// names a group she is in, or one that contains it.

import type ExcelJS from "exceljs";

import { generateDateItems } from "@/lib/dates";
import { expandShiftTypeRefs } from "@/lib/rules/expansion";
import {
  isDayStateSelector,
  RESERVED_SHIFT_TYPE,
  type CanonicalExportExtraRow,
  type CanonicalScenarioDocument,
  type UiTemporaryCover,
} from "@/lib/scenario";
import {
  coverCredit,
  groupClosureOf,
  type CoverTarget,
  type GroupClosure,
} from "@/lib/scenario/temporary-cover";

import type { RosterCoverEntry } from "./types";
import { insertStyledRows } from "./xlsx-rows";

/**
 * The provenance sheet's name, shared with the edited export so the cover table
 * and the "as solved" block can never land on two different sheets.
 */
export const PROVENANCE_SHEET_NAME = "Roster provenance";

/** The schedule sheet is the first worksheet, by workbook position (Contract C5). */
const SCHEDULE_SHEET_INDEX = 0;

/** The summary row label the count rows sit below. */
const STATUS_LABEL = "Status";

/** One cover display row: the name, and one cell per date index. */
export interface CoverSheetRow {
  readonly name: string;
  readonly cells: readonly string[];
}

/** One count row's credit: the header to find it by, and the credit per date index. */
export interface CoverSheetCountCredit {
  readonly header: string;
  readonly byDate: readonly number[];
}

/** Everything an export needs to write the cover rows and their provenance. */
export interface CoverSheetPlan {
  readonly rows: readonly CoverSheetRow[];
  /** One per `export.extraRows` entry, in the document's order. */
  readonly countCredits: readonly CoverSheetCountCredit[];
  /** Written to the "Temporary cover" table. */
  readonly entries: readonly RosterCoverEntry[];
}

/** Where the staff window ends and which columns carry the dates. */
export interface CoverSheetLayout {
  /** 1-based worksheet row of the LAST staff row; her rows go directly below it. */
  readonly lastPersonRow: number;
  /** 1-based worksheet column per date index. */
  readonly dateColumns: readonly number[];
}

const isAll = (ref: string): boolean => ref.toUpperCase() === RESERVED_SHIFT_TYPE.all;

/** The worked shift type ids the scenario defines (OFF/LEAVE are not shifts). */
function workedShiftIds(document: CanonicalScenarioDocument): Set<string> {
  return new Set(
    document.shiftTypes.items
      .map((item) => String(item.id))
      .filter((id) => !isDayStateSelector(id)),
  );
}

/**
 * The count row as a `CoverTarget` (d582 Task 5's shape): its shift refs expanded
 * to concrete worked shifts, and its people refs reduced to the group ids it
 * names — `null` only for an explicit `ALL`. An empty or person-only `countPeople`
 * yields the empty set, which no cover matches: a count row over named people
 * never counts her.
 */
function countRowTarget(
  document: CanonicalScenarioDocument,
  row: CanonicalExportExtraRow,
): CoverTarget {
  const worked = workedShiftIds(document);
  const shiftRefs = row.countShiftTypes.map(String);
  const shiftIds = shiftRefs.some(isAll)
    ? [...worked]
    : [
        ...expandShiftTypeRefs(shiftRefs, {
          shifts: document.shiftTypes.items,
          shiftGroups: document.shiftTypes.groups ?? [],
        }),
      ].filter((id) => worked.has(id));

  const peopleRefs = row.countPeople.map(String);
  const groupIds = new Set((document.people.groups ?? []).map((group) => String(group.id)));
  return {
    shiftIds,
    coefficients: shiftIds.map(() => 1),
    qualifiedGroups: peopleRefs.some(isAll)
      ? null
      : new Set(peopleRefs.filter((ref) => groupIds.has(ref))),
  };
}

/**
 * Project the authored cover cards onto the submission's cover entries (d582).
 *
 * The only real work is the rename: the UI stores the ISO date and the shift ref
 * under the names its date/shift inputs use (`date`, `shiftType`), while the
 * submission type names them `iso` and `shiftId`. `_k` is the React list key and
 * is deliberately dropped — it is never serialized anywhere.
 *
 * One entry per card, in the authored order. Collapsing a name's several dates
 * into one roster row is the PLAN's job (`buildCoverSheetPlan`), not this
 * projection's: the submission stages the cards as authored.
 */
export function toCoverEntries(covers: readonly UiTemporaryCover[]): RosterCoverEntry[] {
  return covers.map(({ name, date, shiftType, groups }) => ({
    name,
    iso: date,
    shiftId: shiftType,
    groups,
  }));
}

/** The staged entries in the shape the cover arithmetic reads. */
function coversOf(entries: readonly RosterCoverEntry[]): UiTemporaryCover[] {
  return entries.map((entry) => ({
    name: entry.name,
    date: entry.iso,
    shiftType: String(entry.shiftId),
    groups: [...entry.groups],
  }));
}

/**
 * Build the plan for an export, or `null` when there is nothing to write. The
 * plan is pure: the writer only has to place rows and numbers.
 */
export function buildCoverSheetPlan(
  document: CanonicalScenarioDocument,
  entries: readonly RosterCoverEntry[],
): CoverSheetPlan | null {
  if (entries.length === 0) return null;
  const { startDate, endDate } = document.dates.range;
  const dates = generateDateItems({ start: startDate, end: endDate }).map((item) => item.iso);

  // One row per NAME, in first-seen order; a name covering several dates fills
  // each of her date cells.
  const rows: { name: string; cells: string[] }[] = [];
  const cellsByName = new Map<string, string[]>();
  for (const entry of entries) {
    let cells = cellsByName.get(entry.name);
    if (cells === undefined) {
      cells = dates.map(() => "");
      cellsByName.set(entry.name, cells);
      rows.push({ name: entry.name, cells });
    }
    const dateIdx = dates.indexOf(entry.iso);
    if (dateIdx !== -1) cells[dateIdx] = String(entry.shiftId);
  }

  const covers = coversOf(entries);
  const closure: GroupClosure = groupClosureOf(document.people.groups ?? []);
  const countCredits = (document.export?.extraRows ?? []).map((row) => {
    const target = countRowTarget(document, row);
    return {
      header: row.header,
      byDate: dates.map((iso) => coverCredit(target, iso, covers, closure)),
    };
  });

  return { rows, countCredits, entries };
}

/**
 * Write the plan into a loaded workbook: insert her rows under the staff window,
 * credit the count rows, and append the "Temporary cover" table to the provenance
 * sheet. Never runs on the frozen bytes themselves — the caller owns the copy.
 */
export function applyCoverSheet(
  workbook: ExcelJS.Workbook,
  plan: CoverSheetPlan,
  layout: CoverSheetLayout,
): void {
  const sheet = workbook.worksheets[SCHEDULE_SHEET_INDEX];
  if (sheet === undefined) {
    throw new Error("the workbook has no schedule sheet");
  }

  if (plan.rows.length > 0) {
    insertStyledRows(sheet, layout.lastPersonRow + 1, plan.rows.length);
    plan.rows.forEach((row, index) =>
      writeCoverRow(sheet, layout, layout.lastPersonRow + 1 + index, row),
    );
    creditCountRows(sheet, layout, plan.countCredits);
  }

  writeCoverProvenance(workbook, plan.entries);
}

/**
 * Write one cover row: the name in column A, her shift id in each of her date
 * cells, and `""` in every other cell — history and the extra (summary) columns
 * included, so her row never reads as a tally.
 */
function writeCoverRow(
  sheet: ExcelJS.Worksheet,
  layout: CoverSheetLayout,
  rowNumber: number,
  row: CoverSheetRow,
): void {
  const dateIdxByColumn = new Map<number, number>();
  layout.dateColumns.forEach((column, dateIdx) => dateIdxByColumn.set(column, dateIdx));
  for (let column = 1; column <= sheet.columnCount; column++) {
    const dateIdx = dateIdxByColumn.get(column);
    sheet.getCell(rowNumber, column).value =
      column === 1 ? row.name : dateIdx === undefined ? "" : (row.cells[dateIdx] ?? "");
  }
}

/**
 * Add each count row's credit to its date cells. A count row is found by its
 * header text in column A BELOW the `Status` row — the exporter's own layout
 * (separator row, then one row per `export.extraRows` entry) — so a header that
 * happens to equal a staff name above the summary block is never mistaken for one.
 */
function creditCountRows(
  sheet: ExcelJS.Worksheet,
  layout: CoverSheetLayout,
  countCredits: readonly CoverSheetCountCredit[],
): void {
  if (countCredits.length === 0) return;
  const statusRow = findLabelRow(sheet, STATUS_LABEL);
  if (statusRow === null) return;
  for (let rowNumber = statusRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const credit = countCredits.find((entry) => entry.header === sheet.getCell(rowNumber, 1).value);
    if (credit === undefined) continue;
    credit.byDate.forEach((by, dateIdx) => {
      if (by <= 0 || dateIdx >= layout.dateColumns.length) return;
      const cell = sheet.getCell(rowNumber, layout.dateColumns[dateIdx]);
      cell.value = (typeof cell.value === "number" ? cell.value : 0) + by;
    });
  }
}

/** The 1-based row whose column A carries `label`, or null. */
function findLabelRow(sheet: ExcelJS.Worksheet, label: string): number | null {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    if (sheet.getCell(rowNumber, 1).value === label) return rowNumber;
  }
  return null;
}

/**
 * Append the "Temporary cover" table (Name / Date / Shift type / Groups) to the
 * provenance sheet, creating it when the export did not write one — the raw
 * download has no "as solved" block to write (Task 14). Groups are a JSON array
 * because a group id is arbitrary user text.
 */
function writeCoverProvenance(
  workbook: ExcelJS.Workbook,
  entries: readonly RosterCoverEntry[],
): void {
  const existing = workbook.worksheets.find((ws) => ws.name === PROVENANCE_SHEET_NAME);
  const sheet = existing ?? workbook.addWorksheet(PROVENANCE_SHEET_NAME);
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 40;
  sheet.addRow(["Temporary cover"]);
  sheet.addRow(["Name", "Date", "Shift type", "Groups"]);
  for (const entry of entries) {
    sheet.addRow([entry.name, entry.iso, String(entry.shiftId), JSON.stringify(entry.groups)]);
  }
}
