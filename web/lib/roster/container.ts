// The `roster-container/1` read contract (F3).
//
// This is the TypeScript half of `core/nurse_scheduling/server/roster_container.py`
// as served by `GET /optimize/{id}/roster` — i.e. the full container MINUS
// `xlsx.base64`. It is validated, never trusted: the ordered axes, the complete
// single-state grid, and the explicit 1-based worksheet coordinates are the
// authority a roster document is built from, so a malformed one must fail before
// it can become a document.
//
// Nothing here reparses the canonical scenario or re-derives exporter geometry —
// that is exactly what the container exists to avoid.

import type { IsoDate, PersonId, ShiftTypeId } from "@/lib/scenario";
import { isRosterDayState, isTypedId, typedIdKey } from "./day-state";
import { freezeDayState } from "./immutable";
import type {
  RosterCoordinateMap,
  RosterDayGrid,
  RosterDayState,
  RosterSolverStatus,
} from "./types";

/** The frozen container schema version. Any other value is rejected. */
export const ROSTER_CONTAINER_SCHEMA_VERSION = "roster-container/1";

/** The workbook media type the container and the roster file both carry. */
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const CONTAINER_FIELDS = [
  "schemaVersion",
  "people",
  "dates",
  "solvedDays",
  "score",
  "solverStatus",
  "coordinateMap",
  "xlsx",
] as const;

const COORDINATE_FIELDS = [
  "peopleRows",
  "dateColumns",
  "firstPeopleRow",
  "leadingCols",
  "historyCols",
  "prettify",
] as const;

/** The `/roster` view: the stored container with the workbook bytes removed. */
export interface RosterContainerView {
  schemaVersion: typeof ROSTER_CONTAINER_SCHEMA_VERSION;
  /** Ordered, ANONYMIZED submitted person ids. */
  people: { id: PersonId }[];
  dates: { iso: IsoDate }[];
  solvedDays: RosterDayGrid;
  score: number;
  solverStatus: RosterSolverStatus;
  coordinateMap: RosterCoordinateMap;
  xlsx: { name: string; mime: string };
}

export type ParseContainerResult =
  | { ok: true; container: RosterContainerView }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Require an object carrying EXACTLY the frozen field set (no extras, none missing). */
function exactFields(
  value: unknown,
  expected: readonly string[],
  label: string,
): { ok: true; record: Record<string, unknown> } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: `${label} is not an object` };
  const keys = Object.keys(value);
  const missing = expected.filter((field) => !(field in value));
  if (missing.length > 0) {
    return { ok: false, reason: `${label} is missing ${missing.join(", ")}` };
  }
  const unexpected = keys.filter((key) => !expected.includes(key));
  if (unexpected.length > 0) {
    return { ok: false, reason: `${label} carries unexpected field(s) ${unexpected.join(", ")}` };
  }
  return { ok: true, record: value };
}

function isIndexAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/**
 * A 1-based worksheet axis matching the exporter's formula EXACTLY, entry by entry.
 *
 * Contiguity is the whole point. The exporter lays people out on consecutive rows
 * from `firstPeopleRow` and dates on consecutive columns from
 * `leadingCols + historyCols + 1` (`exporter.py:613-615`); prettify only appends
 * rows AFTER the Score/Status labels, never between people. Checking cardinality,
 * monotonicity, and the first entry — as this did originally — accepts axes like
 * `[3, 5]` or `[3, 5, 6, 7]` that the exporter cannot produce.
 *
 * That gap was exploitable rather than merely untidy: coordinates are neither
 * derived from `submission` nor covered by `solvedBaselineId`, so a tampered file
 * would pass whole-document validation and then make F5's edited-XLSX patch write
 * a valid edit into an unrelated worksheet cell.
 */
function checkAxis(
  axis: unknown,
  expectedLength: number,
  firstValue: number,
  label: string,
  formula: string,
): { ok: true; axis: number[] } | { ok: false; reason: string } {
  if (!Array.isArray(axis)) return { ok: false, reason: `${label} is not an array` };
  if (axis.length !== expectedLength) {
    return {
      ok: false,
      reason: `${label} has ${axis.length} entries for ${expectedLength} records`,
    };
  }
  for (let index = 0; index < axis.length; index++) {
    const value: unknown = axis[index];
    if (!isIndexAtLeast(value, 1)) {
      return { ok: false, reason: `${label}[${index}] is not a 1-based worksheet index` };
    }
    const expected = firstValue + index;
    if (value !== expected) {
      return {
        ok: false,
        reason: `${label}[${index}] is ${value}, but the exporter layout puts it at ${expected} (${formula})`,
      };
    }
  }
  return { ok: true, axis: axis as number[] };
}

/**
 * Validate coordinate metadata for the given axis cardinalities. Shared by the
 * container parse and the roster-document validation, so a document's coordinates
 * are held to the same rule the backend enforced when it produced them.
 */
export function checkCoordinateMap(
  value: unknown,
  peopleCount: number,
  dateCount: number,
  label = "coordinateMap",
): { ok: true; coordinateMap: RosterCoordinateMap } | { ok: false; reason: string } {
  const shape = exactFields(value, COORDINATE_FIELDS, label);
  if (!shape.ok) return shape;
  const record = shape.record;

  for (const [field, minimum] of [
    ["firstPeopleRow", 1],
    ["leadingCols", 0],
    ["historyCols", 0],
  ] as const) {
    if (!isIndexAtLeast(record[field], minimum)) {
      return { ok: false, reason: `${label}.${field} is not an integer of at least ${minimum}` };
    }
  }
  if (typeof record.prettify !== "boolean") {
    return { ok: false, reason: `${label}.prettify is not a boolean` };
  }
  const historyCols = record.historyCols as number;
  if (!record.prettify && historyCols !== 0) {
    return { ok: false, reason: `${label}.historyCols is non-zero without prettify` };
  }

  // Both axes are fully determined by the scalars above, so they are checked
  // against the formula rather than merely for internal consistency.
  const firstPeopleRow = record.firstPeopleRow as number;
  const expectedFirstColumn = (record.leadingCols as number) + historyCols + 1;

  const peopleRows = checkAxis(
    record.peopleRows,
    peopleCount,
    firstPeopleRow,
    `${label}.peopleRows`,
    "firstPeopleRow + personIdx",
  );
  if (!peopleRows.ok) return peopleRows;
  const dateColumns = checkAxis(
    record.dateColumns,
    dateCount,
    expectedFirstColumn,
    `${label}.dateColumns`,
    "leadingCols + historyCols + 1 + dateIdx",
  );
  if (!dateColumns.ok) return dateColumns;

  return {
    ok: true,
    coordinateMap: {
      peopleRows: peopleRows.axis,
      dateColumns: dateColumns.axis,
      firstPeopleRow,
      leadingCols: record.leadingCols as number,
      historyCols,
      prettify: record.prettify,
    },
  };
}

/**
 * Validate the complete `[personIdx][dateIdx]` grid: rectangular, exactly one
 * exact day-state per cell, and every worked shift resolvable. A ragged row, a
 * missing cell, or a multi-shift cell is a contract violation — the solver's
 * exclusivity constraint makes all three impossible in honest output.
 */
export function checkSolvedDays(
  value: unknown,
  peopleCount: number,
  dateCount: number,
  knownShiftIds: ReadonlySet<string> | null,
  label = "solvedDays",
): { ok: true; solvedDays: RosterDayGrid } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: `${label} is not an array` };
  if (value.length !== peopleCount) {
    return { ok: false, reason: `${label} has ${value.length} rows for ${peopleCount} people` };
  }
  const grid: RosterDayState[][] = [];
  for (let personIdx = 0; personIdx < value.length; personIdx++) {
    const row: unknown = value[personIdx];
    if (!Array.isArray(row)) {
      return { ok: false, reason: `${label}[${personIdx}] is not an array` };
    }
    if (row.length !== dateCount) {
      return {
        ok: false,
        reason: `${label}[${personIdx}] has ${row.length} cells for ${dateCount} dates`,
      };
    }
    const cells: RosterDayState[] = [];
    for (let dateIdx = 0; dateIdx < row.length; dateIdx++) {
      const day: unknown = row[dateIdx];
      if (!isRosterDayState(day)) {
        return {
          ok: false,
          reason: `${label}[${personIdx}][${dateIdx}] is not exactly one day-state`,
        };
      }
      if (knownShiftIds !== null && day.kind === "shift") {
        if (!knownShiftIds.has(typedIdKey(day.shiftId))) {
          return {
            ok: false,
            reason: `${label}[${personIdx}][${dateIdx}] names unknown shift type ${String(day.shiftId)}`,
          };
        }
      }
      // A fresh frozen cell, never the caller's object: the returned grid becomes
      // the immutable baseline, and it must not alias untrusted input that could
      // be mutated after validation passed.
      cells.push(freezeDayState(day));
    }
    grid.push(cells);
  }
  return { ok: true, solvedDays: grid };
}

/** Parse and fully validate a `/roster` container view. Fails closed with a reason. */
export function parseRosterContainer(value: unknown): ParseContainerResult {
  const shape = exactFields(value, CONTAINER_FIELDS, "the roster container");
  if (!shape.ok) return shape;
  const record = shape.record;

  if (record.schemaVersion !== ROSTER_CONTAINER_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported roster container schema version ${String(record.schemaVersion)}`,
    };
  }

  if (!Array.isArray(record.people) || record.people.length === 0) {
    return { ok: false, reason: "the roster container has no people" };
  }
  const people: { id: PersonId }[] = [];
  const seenPeople = new Set<string>();
  for (let index = 0; index < record.people.length; index++) {
    const entry = exactFields(record.people[index], ["id"], `people[${index}]`);
    if (!entry.ok) return entry;
    const id = entry.record.id;
    if (!isTypedId(id)) {
      return { ok: false, reason: `people[${index}].id is not a usable typed id` };
    }
    const key = typedIdKey(id);
    if (seenPeople.has(key)) {
      return { ok: false, reason: `people[${index}].id duplicates an earlier person` };
    }
    seenPeople.add(key);
    people.push({ id });
  }

  if (!Array.isArray(record.dates) || record.dates.length === 0) {
    return { ok: false, reason: "the roster container has no dates" };
  }
  const dates: { iso: IsoDate }[] = [];
  const seenDates = new Set<string>();
  for (let index = 0; index < record.dates.length; index++) {
    const entry = exactFields(record.dates[index], ["iso"], `dates[${index}]`);
    if (!entry.ok) return entry;
    const iso = entry.record.iso;
    if (typeof iso !== "string" || !ISO_DATE.test(iso)) {
      return { ok: false, reason: `dates[${index}].iso is not an ISO calendar date` };
    }
    if (seenDates.has(iso)) {
      return { ok: false, reason: `dates[${index}].iso duplicates an earlier date` };
    }
    seenDates.add(iso);
    dates.push({ iso });
  }

  const grid = checkSolvedDays(record.solvedDays, people.length, dates.length, null);
  if (!grid.ok) return grid;

  if (typeof record.score !== "number" || !Number.isFinite(record.score)) {
    return { ok: false, reason: "score is not a finite number" };
  }
  if (record.solverStatus !== "OPTIMAL" && record.solverStatus !== "FEASIBLE") {
    return {
      ok: false,
      reason: `solverStatus is not a solved-run status: ${String(record.solverStatus)}`,
    };
  }

  const coordinates = checkCoordinateMap(record.coordinateMap, people.length, dates.length);
  if (!coordinates.ok) return coordinates;

  // `/roster` strips the bytes; the metadata stays so a client knows what the
  // download endpoint will serve.
  const workbook = exactFields(record.xlsx, ["name", "mime"], "xlsx");
  if (!workbook.ok) return workbook;
  const name = workbook.record.name;
  if (typeof name !== "string" || !name.endsWith(".xlsx")) {
    return { ok: false, reason: "xlsx.name is not an .xlsx filename" };
  }
  if (workbook.record.mime !== XLSX_MEDIA_TYPE) {
    return { ok: false, reason: "xlsx.mime is not the workbook media type" };
  }

  return {
    ok: true,
    container: {
      schemaVersion: ROSTER_CONTAINER_SCHEMA_VERSION,
      people,
      dates,
      solvedDays: grid.solvedDays,
      score: record.score,
      solverStatus: record.solverStatus,
      coordinateMap: coordinates.coordinateMap,
      xlsx: { name, mime: XLSX_MEDIA_TYPE },
    },
  };
}

/** Re-exported for consumers that only need the exact-field helper's semantics. */
export { exactFields as checkExactFields, isIndexAtLeast };

/** Shift-type ids as the type-aware key set the grid check expects. */
export function shiftIdKeySet(ids: readonly ShiftTypeId[]): Set<string> {
  return new Set(ids.map(typedIdKey));
}
