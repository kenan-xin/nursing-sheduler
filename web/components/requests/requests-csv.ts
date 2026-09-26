// Pure CSV parse/validate helpers for the Shift Requests matrix (T11, FR-SR-34..37).
// Parity source: web-frontend/src/app/shift-requests/page.tsx
// (validateShiftRequestCsvData ~409, validatePeopleHistoryCsvData ~536, shared parse ~665).
// No React, no store writes — callers apply the returned deltas/entries themselves.
//
// `serializeShiftRequestCsv` is the inverse: it writes the matrix in exactly the
// shape `validateShiftRequestCsv` reads, so an export re-imports unchanged.

import {
  RESERVED_SHIFT_TYPE,
  isDayStateSelector,
  type DateRef,
  type PersonRef,
  type UiRequestCell,
} from "@/lib/scenario";
import { resolveDayStatePrecedence } from "./requests-model";

/** A weight value as produced by the shared weight parser: a valid weight is a
 *  finite `number` or exactly `Infinity`/`-Infinity`; any other string is raw
 *  (unparsed/invalid) text kept verbatim. */
export type WeightValue = number | string;

export type CsvValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ShiftRequestCsvOptions {
  /** Canonical person IDs, in the order rows must cover (peopleData.items). */
  peopleIds: string[];
  /** Date-item IDs, in column order (peopleData.items.length columns follow). */
  dateItemIds: string[];
  /** Valid cell shift-type IDs — items AND groups (FR-SR-36, QK-SR-02). */
  validShiftTypeIds: string[];
  /** The add-form weight; must be valid before any row is processed. */
  weight: WeightValue;
}

export interface ShiftRequestDelta {
  personId: string;
  dateId: string;
  /** A worked shift-type/group id, or a reserved day-state label (`OFF`/`LEAVE`)
   *  as the matrix export writes them; the caller routes the day-states to a
   *  leave/off cell rather than a worked request. */
  shiftType: string;
}

export interface PeopleHistoryCsvOptions {
  /** Canonical person IDs, in the order rows must cover (peopleData.items). */
  peopleIds: string[];
  /** Valid cell shift-type IDs — items ONLY, no groups (FR-SR-37, QK-SR-02). */
  validShiftTypeItemIds: string[];
}

export interface PeopleHistoryEntry {
  personId: string;
  /** Empty string means "clear this person's history" (repetitionCount is 0). */
  shiftType: string;
  repetitionCount: number;
}

function isValidWeight(value: WeightValue): value is number {
  return typeof value === "number" && (Number.isFinite(value) || Math.abs(value) === Infinity);
}

/** FR-SR-35: split on newlines (trim, drop blanks), then split each line on commas (trim cells). */
function splitCsvRows(text: string): string[][] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => line.split(",").map((cell) => cell.trim()));
}

function validateShiftRequestRows(
  rows: string[][],
  { peopleIds, dateItemIds, validShiftTypeIds }: Omit<ShiftRequestCsvOptions, "weight">,
): CsvValidationResult<ShiftRequestDelta[]> {
  const expectedPeopleCount = peopleIds.length;
  const expectedDateCount = dateItemIds.length;

  const validPersonIds = new Set(peopleIds);

  // Accept an optional leading header row (as emitted by the planned matrix CSV
  // export). Only strip row 0 when the row count is exactly one more than the
  // number of people AND that first row's first cell is not a valid person ID.
  // A genuine person row always has a valid person ID in cell 0, so it can never
  // be misclassified as a header; a headerless file (row count already == N) is
  // never touched.
  const dataRows =
    rows.length === expectedPeopleCount + 1 && !validPersonIds.has(rows[0][0])
      ? rows.slice(1)
      : rows;

  if (dataRows.length !== expectedPeopleCount) {
    return {
      ok: false,
      error: `CSV should have ${expectedPeopleCount} rows (one per person), but has ${dataRows.length} rows.`,
    };
  }

  const personRowMap = new Map<string, number>();

  for (let i = 0; i < dataRows.length; i++) {
    if (dataRows[i].length !== expectedDateCount + 1) {
      return {
        ok: false,
        error: `Row ${i + 1} should have ${expectedDateCount + 1} columns (dates), but has ${dataRows[i].length} columns.`,
      };
    }

    const personId = dataRows[i][0];
    if (!validPersonIds.has(personId)) {
      return {
        ok: false,
        error: `Row ${i + 1} has invalid person ID "${personId}". Valid person IDs: ${peopleIds.join(", ")}`,
      };
    }

    if (personRowMap.has(personId)) {
      return {
        ok: false,
        error: `Duplicate person ID "${personId}" found at row ${i + 1}. Person was already seen at row ${personRowMap.get(personId)! + 1}.`,
      };
    }

    personRowMap.set(personId, i);
  }

  for (const personId of peopleIds) {
    if (!personRowMap.has(personId)) {
      return {
        ok: false,
        error: `Missing person "${personId}" in CSV data. All people must be included.`,
      };
    }
  }

  const validShiftTypeSet = new Set(validShiftTypeIds);
  const deltas: ShiftRequestDelta[] = [];

  for (let r = 0; r < dataRows.length; r++) {
    const personId = dataRows[r][0];
    for (let c = 1; c < dataRows[r].length; c++) {
      const cellValue = dataRows[r][c];
      if (!cellValue) continue;

      // A cell is one day-state label (`OFF`/`LEAVE`, as the matrix export writes
      // them) or one-or-more worked selectors joined with ` | ` (the export's
      // several-entries-per-cell form). Splitting on `|` and trimming also accepts
      // the unspaced `AM|PM` a hand-editor might type.
      const tokens = cellValue
        .split("|")
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      const dayState = tokens.find(isDayStateSelector);

      if (dayState !== undefined) {
        if (tokens.length > 1) {
          return {
            ok: false,
            error: `Cell at row ${r + 1}, column ${c + 1} mixes the day-state "${dayState}" with other entries; a cell is either one day-state (OFF/LEAVE) or shift types joined with " | ".`,
          };
        }
        deltas.push({ personId, dateId: dateItemIds[c - 1], shiftType: dayState });
        continue;
      }

      if (tokens.length === 0) continue;

      for (const token of tokens) {
        if (!validShiftTypeSet.has(token)) {
          return {
            ok: false,
            error: `Invalid shift type "${token}" at row ${r + 1}, column ${c + 1}. Valid shift types: ${validShiftTypeIds.join(", ")}`,
          };
        }
        deltas.push({ personId, dateId: dateItemIds[c - 1], shiftType: token });
      }
    }
  }

  return { ok: true, data: deltas };
}

/**
 * Parse + validate a Shift Requests CSV (FR-SR-36): a people × dates matrix,
 * column 0 = person ID, remaining columns = one cell per date item in order.
 * On success returns the additive deltas (all at `weight`) for the caller to
 * group per (person, date) and merge into the existing preferences.
 */
export function validateShiftRequestCsv(
  text: string,
  options: ShiftRequestCsvOptions,
): CsvValidationResult<ShiftRequestDelta[]> {
  if (!isValidWeight(options.weight)) {
    return { ok: false, error: "Weight must be a valid number, Infinity, or -Infinity." };
  }

  if (!text) {
    return { ok: false, error: "No content found in the uploaded file." };
  }

  try {
    const rows = splitCsvRows(text);
    return validateShiftRequestRows(rows, options);
  } catch {
    return {
      ok: false,
      error: "Error processing shift-requests CSV file. Please check the file format.",
    };
  }
}

// --- Matrix export (the FR-SR-36 inverse; export → edit → re-import) ---------

export interface ShiftRequestCsvExportOptions {
  /** Person refs, in row order; column 0 carries each one's string form. */
  people: readonly PersonRef[];
  /** Date-item refs, in column order (one column per item). */
  dateItemIds: readonly DateRef[];
}

/**
 * The CSV text for one coordinate's cells: a leave pin and an off-day are written
 * as their reserved selector labels (`LEAVE`/`OFF`), a worked request as its
 * shift-type/group id. Several coexisting worked entries join with ` | ` so a
 * whole matrix cell survives one round-trip; an empty coordinate is blank.
 * Duplicate encodings are collapsed so the emitted cell is always one the parser
 * accepts.
 */
function encodeShiftRequestCell(cells: readonly UiRequestCell[]): string {
  const entries = cells.map((cell) =>
    cell.kind === "leave"
      ? RESERVED_SHIFT_TYPE.leave
      : cell.kind === "off"
        ? RESERVED_SHIFT_TYPE.off
        : cell.shiftType,
  );
  return [...new Set(entries)].join(" | ");
}

/**
 * Serialize the requests matrix to CSV in the shape {@link validateShiftRequestCsv}
 * reads: a `person,<date-item ids…>` header row, then one row per person, one
 * column per date item. Cells are read through the SAME day-state precedence the
 * matrix renders (LEAVE > OFF > worked), so what is exported is what the user
 * sees, and several coexisting worked requests at one coordinate join with ` | `.
 * An export therefore re-imports through the Requests CSV modal with the same
 * (person, date, selector) cells. Weights are not part of the matrix format — the
 * import applies the caller's weight — so they are not written.
 *
 * Group-person and date-group/`H-n` columns are out of scope: the import parser
 * only reads the individual-people × date-item matrix (see the artifact).
 */
export function serializeShiftRequestCsv(
  cells: readonly UiRequestCell[],
  { people, dateItemIds }: ShiftRequestCsvExportOptions,
): string {
  // Precedence-resolve, then index by exact (person, date) identity — the same
  // strict-equality keys `cellPreferenceSet` uses (no string coercion).
  const byPerson = new Map<PersonRef, Map<DateRef, UiRequestCell[]>>();
  for (const cell of resolveDayStatePrecedence(cells)) {
    let byDate = byPerson.get(cell.person);
    if (!byDate) byPerson.set(cell.person, (byDate = new Map()));
    const at = byDate.get(cell.date);
    if (at) at.push(cell);
    else byDate.set(cell.date, [cell]);
  }

  const rows = [["person", ...dateItemIds.map(String)].join(",")];
  for (const person of people) {
    const byDate = byPerson.get(person);
    const row = [String(person)];
    for (const dateId of dateItemIds) {
      row.push(encodeShiftRequestCell(byDate?.get(dateId) ?? []));
    }
    rows.push(row.join(","));
  }
  return rows.join("\n");
}

function validatePeopleHistoryRows(
  rows: string[][],
  { peopleIds, validShiftTypeItemIds }: PeopleHistoryCsvOptions,
): CsvValidationResult<PeopleHistoryEntry[]> {
  const expectedPeopleCount = peopleIds.length;

  if (rows.length !== expectedPeopleCount) {
    return {
      ok: false,
      error: `CSV should have ${expectedPeopleCount} rows (one per person), but has ${rows.length} rows.`,
    };
  }

  const validPersonIds = new Set(peopleIds);
  const personRowMap = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== 3) {
      return {
        ok: false,
        error: `Row ${i + 1} should have 3 columns (name, shift type, repetition count), but has ${rows[i].length} columns.`,
      };
    }

    const personId = rows[i][0];
    if (!validPersonIds.has(personId)) {
      return {
        ok: false,
        error: `Row ${i + 1} has invalid person ID "${personId}". Valid person IDs: ${peopleIds.join(", ")}`,
      };
    }

    if (personRowMap.has(personId)) {
      return {
        ok: false,
        error: `Duplicate person ID "${personId}" found at row ${i + 1}. Person was already seen at row ${personRowMap.get(personId)! + 1}.`,
      };
    }

    personRowMap.set(personId, i);
  }

  for (const personId of peopleIds) {
    if (!personRowMap.has(personId)) {
      return {
        ok: false,
        error: `Missing person "${personId}" in CSV data. All people must be included.`,
      };
    }
  }

  const validShiftTypeSet = new Set(validShiftTypeItemIds);
  const entries: PeopleHistoryEntry[] = [];

  for (let i = 0; i < rows.length; i++) {
    const [personId, shiftType, repetitionStr] = rows[i];

    if (!shiftType) {
      entries.push({ personId, shiftType: "", repetitionCount: 0 });
      continue;
    }

    if (!validShiftTypeSet.has(shiftType)) {
      return {
        ok: false,
        error: `Invalid shift type "${shiftType}" at row ${i + 1}. Valid shift types: ${validShiftTypeItemIds.join(", ")}`,
      };
    }

    const repetitionCount = Number.parseInt(repetitionStr, 10);
    if (Number.isNaN(repetitionCount) || repetitionCount < 0) {
      return {
        ok: false,
        error: `Invalid repetition count '${repetitionStr}' for person '${personId}' at row ${i + 1}. Must be a non-negative integer.`,
      };
    }

    entries.push({ personId, shiftType, repetitionCount });
  }

  return { ok: true, data: entries };
}

/**
 * Parse + validate a People History shorthand CSV (FR-SR-37): one row per
 * person (no header), columns `name, shiftType, repetitionCount`. On success
 * returns entries for the caller to set each person's history to
 * `repetitionCount` copies of `shiftType` (empty `shiftType` clears history).
 */
export function validatePeopleHistoryCsv(
  text: string,
  options: PeopleHistoryCsvOptions,
): CsvValidationResult<PeopleHistoryEntry[]> {
  if (!text) {
    return { ok: false, error: "No content found in the uploaded file." };
  }

  try {
    const rows = splitCsvRows(text);
    return validatePeopleHistoryRows(rows, options);
  } catch {
    return {
      ok: false,
      error: "Error processing people-history CSV file. Please check the file format.",
    };
  }
}
