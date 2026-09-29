// "Also record as leave / day off" (kyh3, audit C-08). A roster hand edit to LV or
// OFF lives only in the roster; this maps such edits onto Requests cells so the
// next run keeps them. It only computes — the offer component writes, on a click.
//
// LV becomes a paid-leave pin; OFF becomes a day-off wish at the nurse-wish
// default. Precedence is LEAVE > OFF > request: leave already covers a day off,
// so an OFF edit on a leave cell counts as recorded and is never downgraded.

import { generateDateItems, hasCompleteRange } from "@/lib/dates";
import type { DateRef, PersonRef, ScenarioUiState, UiRequestCell } from "@/lib/scenario";
import type { EditCoordinate, RosterContext } from "@/lib/roster";
import { dateLabel } from "@/lib/roster-viewer";
import { DEFAULT_OFF_WEIGHT } from "@/components/requests/cell-preference-editor";
import { replaceCoordinateCells } from "@/components/requests/use-requests";

export type RecordKind = "leave" | "off";

/** A roster cell the user set to LV or OFF in this session. */
export interface RecordableEdit extends EditCoordinate {
  readonly kind: RecordKind;
}

export interface RecordCandidate {
  readonly kind: RecordKind;
  readonly person: PersonRef;
  readonly date: DateRef;
  /** "P1 · 2026-07-03 Fri" — the same naming the edit bar uses. */
  readonly label: string;
  /** Requests already holds this (or leave, for an OFF). */
  readonly recorded: boolean;
}

export type RecordScenario = Pick<ScenarioUiState, "staff" | "rangeStart" | "rangeEnd" | "reqData">;

/** Whether Requests already holds `kind` at this coordinate (leave covers OFF). */
export function isRecorded(
  reqData: readonly UiRequestCell[],
  person: PersonRef,
  date: DateRef,
  kind: RecordKind,
): boolean {
  return reqData.some(
    (c) =>
      c.person === person &&
      c.date === date &&
      (c.kind === "leave" || (kind === "off" && c.kind === "off")),
  );
}

/**
 * Map roster edits to Requests coordinates. An edit whose nurse or date is not in
 * the current scenario (a roster from an older setup) cannot be recorded and is
 * left out.
 */
export function resolveRecordCandidates(
  edits: readonly RecordableEdit[],
  context: RosterContext,
  scenario: RecordScenario,
): RecordCandidate[] {
  const range = { start: scenario.rangeStart, end: scenario.rangeEnd };
  const dateIdByIso = new Map<string, DateRef>(
    hasCompleteRange(range) ? generateDateItems(range).map((d) => [d.iso, d.id]) : [],
  );
  const candidates: RecordCandidate[] = [];
  for (const edit of edits) {
    const person = context.people[edit.personIdx];
    const day = context.calendar[edit.dateIdx];
    if (person === undefined || day === undefined) continue;
    const date = dateIdByIso.get(day.iso);
    if (date === undefined || !scenario.staff.some((p) => p.id === person.id)) continue;
    candidates.push({
      kind: edit.kind,
      person: person.id,
      date,
      label: `${String(person.id)} · ${dateLabel(context.calendar, edit.dateIdx)} ${day.weekday}`,
      recorded: isRecorded(scenario.reqData, person.id, date, edit.kind),
    });
  }
  return candidates;
}

/**
 * The matrix with every candidate recorded, through the Requests cell editor's own
 * coordinate write. Re-checks precedence against `reqData` (the queue head), so a
 * cell that gained leave in the meantime is not downgraded.
 */
export function recordCandidates(
  reqData: readonly UiRequestCell[],
  candidates: readonly RecordCandidate[],
): UiRequestCell[] {
  return candidates.reduce<UiRequestCell[]>(
    (acc, c) =>
      isRecorded(acc, c.person, c.date, c.kind)
        ? acc
        : replaceCoordinateCells(
            acc,
            c.person,
            c.date,
            c.kind === "leave" ? { kind: "leave" } : { kind: "off", weight: DEFAULT_OFF_WEIGHT },
          ),
    [...reqData],
  );
}
