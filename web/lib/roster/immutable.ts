// Runtime immutability for roster state (F3).
//
// The `readonly` types in `./types` are erased at runtime, so they protect typed
// callers and nobody else. This module is the runtime half: it clones and freezes
// at the boundaries where roster state becomes public, so an untyped consumer, a
// `any`-cast, or a JS caller cannot reach through a derived value and rewrite the
// immutable solved baseline or a normalized overlay.
//
// Cloning is the load-bearing part, not freezing. Freezing an object that is still
// SHARED with `solvedDays` would only move the failure from "silent corruption" to
// "throws in someone else's code"; the guarantee we want is that a derived grid and
// the baseline have no object in common at all. Every helper here therefore returns
// a deep copy, and freezes it so the copy cannot be mutated either.
//
// The frozen workbook `Blob` is deliberately never frozen or copied: it is already
// an immutable binary object, and copying multi-megabyte bytes on every validation
// would be pure waste.

import type {
  RosterContext,
  RosterCoordinateMap,
  RosterDayGrid,
  RosterDayState,
  RosterDocument,
  RosterEdit,
  RosterProvenance,
  RosterSubmission,
} from "./types";

/** A fresh, frozen copy of one day-state — the unit of grid aliasing. */
export function freezeDayState(day: RosterDayState): RosterDayState {
  return Object.freeze(
    day.kind === "shift" ? { kind: "shift" as const, shiftId: day.shiftId } : { kind: day.kind },
  );
}

/** A fresh, frozen copy of a whole day-state grid — rows and cells alike. */
export function freezeDayGrid(grid: RosterDayGrid): RosterDayGrid {
  return Object.freeze(grid.map((row) => Object.freeze(row.map(freezeDayState))));
}

/** A fresh, frozen copy of one overlay entry, including its day-state. */
export function freezeEdit(edit: RosterEdit): RosterEdit {
  return Object.freeze({
    personIdx: edit.personIdx,
    dateIdx: edit.dateIdx,
    day: freezeDayState(edit.day),
  });
}

/** A fresh, frozen copy of a normalized overlay. */
export function freezeEdits(edits: readonly RosterEdit[]): readonly RosterEdit[] {
  return Object.freeze(edits.map(freezeEdit));
}

/** A fresh, frozen copy of the derived viewer context. */
export function freezeContext(context: RosterContext): RosterContext {
  return Object.freeze({
    people: Object.freeze(
      context.people.map((person) =>
        Object.freeze({
          ...person,
          ...(person.history === undefined ? {} : { history: Object.freeze([...person.history]) }),
        }),
      ),
    ),
    shiftTypes: Object.freeze(
      context.shiftTypes.map((shiftType) => Object.freeze({ ...shiftType })),
    ),
    calendar: Object.freeze(context.calendar.map((day) => Object.freeze({ ...day }))),
    baselineMinimums: Object.freeze(
      context.baselineMinimums.map((minimum) => Object.freeze({ ...minimum })),
    ),
    leaveCreditMinutes: context.leaveCreditMinutes,
  });
}

/** A fresh, frozen copy of the coordinate map, axes included. */
export function freezeCoordinateMap(coordinateMap: RosterCoordinateMap): RosterCoordinateMap {
  return Object.freeze({
    peopleRows: Object.freeze([...coordinateMap.peopleRows]),
    dateColumns: Object.freeze([...coordinateMap.dateColumns]),
    firstPeopleRow: coordinateMap.firstPeopleRow,
    leadingCols: coordinateMap.leadingCols,
    historyCols: coordinateMap.historyCols,
    prettify: coordinateMap.prettify,
  });
}

/** A fresh, frozen copy of the immutable submission, reverse-map tuples included. */
export function freezeSubmission(submission: RosterSubmission): RosterSubmission {
  return Object.freeze({
    canonicalYaml: submission.canonicalYaml,
    reverseMap: Object.freeze(
      submission.reverseMap.map((tuple) => Object.freeze([tuple[0], tuple[1]]) as typeof tuple),
    ),
    schemaVersion: submission.schemaVersion,
  });
}

/** A fresh, frozen copy of provenance. */
export function freezeProvenance(provenance: RosterProvenance): RosterProvenance {
  return Object.freeze({ ...provenance });
}

/**
 * The single document boundary: a deep, frozen copy that shares no mutable object
 * with the input (the `Blob` excepted — see the module header). Applied wherever a
 * document becomes public, so a validated document can never be edited into an
 * invalid one behind the validator's back.
 */
export function freezeRosterDocument(document: RosterDocument): RosterDocument {
  return Object.freeze({
    schemaVersion: document.schemaVersion,
    provenance: freezeProvenance(document.provenance),
    submission: freezeSubmission(document.submission),
    context: freezeContext(document.context),
    solvedDays: freezeDayGrid(document.solvedDays),
    edits: freezeEdits(document.edits),
    coordinateMap: freezeCoordinateMap(document.coordinateMap),
    frozenXlsx: document.frozenXlsx,
  });
}
