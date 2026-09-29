// Fresh count cells for the edited XLSX (audit C-10).
//
// Core writes every `export.extraColumns` / `export.extraRows` count as a fixed
// value, so an edited cell would leave its person's row totals and its date's
// column totals stale. Each edit moves a count by exactly what its old and new
// day-state contribute, so the plan is a DELTA per affected count cell, computed
// with core's own rules (`exporter.py` `_count_extra_column_for_person` /
// `_count_extra_row_for_date`) over the submission's resolved selectors.
//
// Layout (exporter.py, 1-based): extra-column headers sit on the row above the
// people; extra column j is one separator column after the last date; extra row
// j is below Score, Status and a separator row. Each count also names its header
// cell, so the patcher can refuse a workbook whose layout does not match.

import {
  buildScenarioResolutionContext,
  LEAVE_SID,
  OFF_SID,
  type CanonicalScenarioDocument,
} from "@/lib/scenario";

import type { RosterCoordinateMap, RosterDayGrid, RosterDayState, RosterEdit } from "./types";

/** One count cell to move by `delta`, and the header cell that must read `header`. */
export interface CountCellDelta {
  readonly row: number;
  readonly col: number;
  readonly delta: number;
  readonly headerRow: number;
  readonly headerCol: number;
  readonly header: string;
}

function resolved<T>(resolution: { resolved: true; values: ReadonlySet<T> } | { resolved: false }) {
  if (!resolution.resolved) throw new Error("the submission's count selectors could not be read");
  return resolution.values;
}

/** The count deltas the edits cause, or `[]` when the workbook has no count cells. */
export function buildCountCellDeltas(
  document: CanonicalScenarioDocument,
  solvedDays: RosterDayGrid,
  edits: readonly RosterEdit[],
  coordinateMap: RosterCoordinateMap,
): CountCellDelta[] {
  const layout = document.export;
  if (!coordinateMap.prettify || layout === undefined || edits.length === 0) return [];

  const ctx = buildScenarioResolutionContext({
    staff: document.people.items,
    staffGroups: document.people.groups ?? [],
    shifts: document.shiftTypes.items,
    shiftGroups: document.shiftTypes.groups ?? [],
    rangeStart: document.dates.range.startDate,
    rangeEnd: document.dates.range.endDate,
    dateGroups: document.dates.groups ?? [],
  });
  const shiftIndex = (day: RosterDayState): number =>
    day.kind === "off"
      ? OFF_SID
      : day.kind === "leave"
        ? LEAVE_SID
        : document.shiftTypes.items.findIndex((item) => item.id === day.shiftId);
  const changes = edits.map((edit) => ({
    personIdx: edit.personIdx,
    dateIdx: edit.dateIdx,
    before: shiftIndex(solvedDays[edit.personIdx][edit.dateIdx]),
    after: shiftIndex(edit.day),
  }));

  const { peopleRows, dateColumns, firstPeopleRow } = coordinateMap;
  const lastPersonRow = peopleRows[peopleRows.length - 1];
  const lastDateCol = dateColumns[dateColumns.length - 1];
  const deltas: CountCellDelta[] = [];

  (layout.extraColumns ?? []).forEach((rule, j) => {
    const shifts = resolved(ctx.resolveShiftTypes(rule.countShiftTypes));
    const dates = resolved(ctx.resolveDates(rule.countDates));
    const coefficients = new Map<number, number>();
    for (const [ref, coefficient] of rule.countShiftTypeCoefficients ?? []) {
      for (const s of resolved(ctx.resolveShiftTypes(ref))) coefficients.set(s, coefficient);
    }
    const value = (s: number) => (shifts.has(s) ? (coefficients.get(s) ?? 1) : 0);
    const byPerson = new Map<number, number>();
    for (const c of changes) {
      if (!dates.has(c.dateIdx)) continue;
      byPerson.set(
        c.personIdx,
        (byPerson.get(c.personIdx) ?? 0) + value(c.after) - value(c.before),
      );
    }
    const col = lastDateCol + 2 + j;
    for (const [personIdx, delta] of byPerson) {
      if (delta === 0) continue;
      deltas.push({
        row: peopleRows[personIdx],
        col,
        delta,
        headerRow: firstPeopleRow - 1,
        headerCol: col,
        header: rule.header,
      });
    }
  });

  (layout.extraRows ?? []).forEach((rule, j) => {
    const shifts = resolved(ctx.resolveShiftTypes(rule.countShiftTypes));
    const people = resolved(ctx.resolvePeople(rule.countPeople));
    const value = (s: number) => (shifts.has(s) ? 1 : 0);
    const byDate = new Map<number, number>();
    for (const c of changes) {
      if (!people.has(c.personIdx)) continue;
      byDate.set(c.dateIdx, (byDate.get(c.dateIdx) ?? 0) + value(c.after) - value(c.before));
    }
    const row = lastPersonRow + 4 + j;
    for (const [dateIdx, delta] of byDate) {
      if (delta === 0) continue;
      deltas.push({
        row,
        col: dateColumns[dateIdx],
        delta,
        headerRow: row,
        headerCol: 1,
        header: rule.header,
      });
    }
  });

  return deltas;
}
