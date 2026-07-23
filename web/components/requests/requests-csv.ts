// Pure CSV parse/validate helpers for the Shift Requests matrix (T11, FR-SR-34..37).
// Parity source: web-frontend/src/app/shift-requests/page.tsx
// (validateShiftRequestCsvData ~409, validatePeopleHistoryCsvData ~536, shared parse ~665).
// No React, no store writes — callers apply the returned deltas/entries themselves.

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

      if (!validShiftTypeSet.has(cellValue)) {
        return {
          ok: false,
          error: `Invalid shift type "${cellValue}" at row ${r + 1}, column ${c + 1}. Valid shift types: ${validShiftTypeIds.join(", ")}`,
        };
      }

      deltas.push({ personId, dateId: dateItemIds[c - 1], shiftType: cellValue });
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
