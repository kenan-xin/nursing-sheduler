// Roster document domain types (F3). The working roster AND the shareable roster
// file are the same document; only the frozen workbook's carrier differs (an
// in-memory `Blob` vs a base64 string on the wire — see `./file`).
//
// The load-bearing shape rules, from the tech plan ("Roster document schema")
// and Core Flows ("the working roster is a portable document"):
//
//   • `submission` is the IMMUTABLE exact solved document + reverse-identity map.
//     It is the source of truth; everything in `context` is derivable from it.
//   • `context` is a DERIVED viewer cache built from `submission` with real
//     canonical fields only (people `id/description/history`; shift types
//     `id/description/durationMinutes/startTime/endTime/restMinutes`). No
//     invented `role`/`name`.
//   • `context.people` and `context.calendar` are ALSO the document's ordered
//     axes: `solvedDays[personIdx][dateIdx]`, every `edits` coordinate, and both
//     `coordinateMap` axes are index-aligned to them.
//   • `solvedDays` is immutable and complete — exactly one day-state per
//     (person, date). `currentDays` and `editedSinceSolve` are DERIVED from it
//     plus `edits` (see `./overlay`); neither is ever stored.
//   • `edits` is a normalized overlay: sorted, one entry per coordinate, and no
//     entry whose value equals its solved day-state.

import type { IsoDate, PersonId, ShiftTypeId } from "@/lib/scenario";
import type { ReverseMapTuple } from "@/lib/scenario";

/** The current roster-document schema version. Independent of `appBuild`. */
export const ROSTER_DOCUMENT_SCHEMA_VERSION = "roster-file/1";

/**
 * The submission-snapshot envelope version. This is the `submission.schemaVersion`
 * field: it versions the `{canonicalYaml, reverseMap}` capture contract, NOT the
 * scenario's own `apiVersion` (which lives inside `canonicalYaml`) and NOT the
 * roster document version.
 */
export const ROSTER_SUBMISSION_SCHEMA_VERSION = "roster-submission/1";

/** The schema version the baseline hash canonicalization is stamped with. */
export const ROSTER_BASELINE_SCHEMA_VERSION = "roster-baseline/1";

/**
 * One person×date day-state. A worked day carries exactly ONE shift id: the
 * solver's exclusivity constraint `offs + Σshifts + leaves == 1`
 * (`scheduler.py:191`) guarantees one state per cell, so a list would be a
 * contract violation, not a richer encoding.
 *
 * Deeply `readonly`, like every roster type below. The immutable solved baseline
 * is a load-bearing contract and a mutable day-state object defeats it from the
 * inside: cloning a grid ROW still leaves every CELL shared, so a single
 * `cell.shiftId = …` would rewrite the baseline that `solvedBaselineId` was
 * computed over. `readonly` makes that a compile error; `./immutable` freezes the
 * same values at runtime for callers without types.
 */
export type RosterDayState =
  | { readonly kind: "off" }
  | { readonly kind: "leave" }
  | { readonly kind: "shift"; readonly shiftId: ShiftTypeId };

/** An immutable, index-aligned `[personIdx][dateIdx]` day-state grid. */
export type RosterDayGrid = readonly (readonly RosterDayState[])[];

/** Solver outcomes that produce a structurally complete, loadable roster. */
export type RosterSolverStatus = "OPTIMAL" | "FEASIBLE";

/** Solve provenance. Always rendered "as solved" — never recomputed after edits. */
export interface RosterProvenance {
  readonly solverStatus: RosterSolverStatus;
  readonly score: number;
  /** SHA-256 hex over the canonical baseline (see `./baseline`). */
  readonly solvedBaselineId: string;
  /** App/build stamp. Provenance ONLY — it never gates compatibility. */
  readonly appBuild: string;
}

/** The immutable exact submission that was solved. The document's source of truth. */
export interface RosterSubmission {
  /** The exact anonymized canonical YAML the backend received, byte-for-byte. */
  readonly canonicalYaml: string;
  /** Ordered `[anonymizedId, originalId]` tuples; empty for a plain submission. */
  readonly reverseMap: readonly ReverseMapTuple[];
  /** Must equal `ROSTER_SUBMISSION_SCHEMA_VERSION`. */
  readonly schemaVersion: string;
}

/** A person on the roster axis, carrying only real canonical person fields. */
export interface RosterContextPerson {
  /** The DE-ANONYMIZED id, with its authored `number | string` type preserved. */
  readonly id: PersonId;
  readonly description?: string;
  readonly history?: readonly string[];
}

/** A shift type, carrying only real canonical shift-type fields. */
export interface RosterContextShiftType {
  readonly id: ShiftTypeId;
  readonly description?: string;
  readonly durationMinutes?: number;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly restMinutes?: number;
}

/** One day on the roster axis. */
export interface RosterCalendarDay {
  readonly iso: IsoDate;
  /** Three-letter English weekday, e.g. `"Tue"`. */
  readonly weekday: string;
  /** Whether the backend's `WEEKEND` keyword covers this day. */
  readonly weekend: boolean;
  /** Whether the submission's own `PH` date group covers this day. */
  readonly holiday: boolean;
}

/**
 * The per-shift baseline minimum, or an explicit statement that no unique simple
 * baseline exists. A shift is `unavailable` when zero or more than one
 * requirement satisfies the baseline rule (see `./context`); the viewer then
 * shows "coverage unavailable" and never a fabricated number.
 */
export type RosterBaselineMinimum =
  | {
      readonly shiftId: ShiftTypeId;
      readonly required: number;
      /** Provenance back to the source requirement, e.g. `"preferences[3]"`. */
      readonly source: string;
    }
  | { readonly shiftId: ShiftTypeId; readonly unavailable: true };

/** The derived viewer cache. Rebuildable from `submission` at any time. */
export interface RosterContext {
  readonly people: readonly RosterContextPerson[];
  readonly shiftTypes: readonly RosterContextShiftType[];
  readonly calendar: readonly RosterCalendarDay[];
  /** One entry per `shiftTypes` item, in the same order. */
  readonly baselineMinimums: readonly RosterBaselineMinimum[];
  /** Paid-leave credit in minutes, or `null` when the submission does not fix one. */
  readonly leaveCreditMinutes: number | null;
}

/** One normalized overlay entry. */
export interface RosterEdit {
  readonly personIdx: number;
  readonly dateIdx: number;
  readonly day: RosterDayState;
}

/**
 * Explicit 1-based worksheet coordinates, produced by the scheduler alongside the
 * ordered axes. The client never re-derives the exporter's layout from them.
 */
export interface RosterCoordinateMap {
  readonly peopleRows: readonly number[];
  readonly dateColumns: readonly number[];
  readonly firstPeopleRow: number;
  readonly leadingCols: number;
  readonly historyCols: number;
  readonly prettify: boolean;
}

/** The in-memory roster document — the working roster and the import/export unit. */
export interface RosterDocument {
  /**
   * The document schema version. Production only ever produces
   * `ROSTER_DOCUMENT_SCHEMA_VERSION`; it is typed as a string because a document
   * validated under an injected policy version (see `./schema-version`) carries
   * that version instead, and the validator — not this type — is what pins it.
   */
  readonly schemaVersion: string;
  readonly provenance: RosterProvenance;
  readonly submission: RosterSubmission;
  readonly context: RosterContext;
  /** `[personIdx][dateIdx]`; immutable and complete. */
  readonly solvedDays: RosterDayGrid;
  /** Normalized overlay — see `./overlay`. */
  readonly edits: readonly RosterEdit[];
  readonly coordinateMap: RosterCoordinateMap;
  /** The de-anonymized styled workbook, frozen as solved. */
  readonly frozenXlsx: Blob;
}

/** The embedded workbook on the wire: strict base64 plus its exact media type. */
export interface RosterFileWorkbook {
  readonly base64: string;
  readonly mime: string;
}

/**
 * The wire form of a roster document: identical to `RosterDocument` except the
 * frozen workbook is base64-embedded, so the file is a single self-contained JSON
 * document with no side-car bytes.
 */
export type RosterFileDocument = Omit<RosterDocument, "frozenXlsx"> & {
  frozenXlsx: RosterFileWorkbook;
};

/** The exact top-level field set of a roster document (both forms). */
export const ROSTER_DOCUMENT_FIELDS = [
  "schemaVersion",
  "provenance",
  "submission",
  "context",
  "solvedDays",
  "edits",
  "coordinateMap",
  "frozenXlsx",
] as const;
