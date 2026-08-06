// Assembling a roster document from a captured run (F3).
//
// This is the pure half of capture: the container the backend produced plus the
// immutable submission snapshot plus the de-anonymized frozen workbook, combined
// into one validated document. F2 owns WHEN this runs (the capture state machine,
// retries, cleanup authority); this owns WHAT the resulting document is.
//
// Two alignments are proved rather than assumed, because everything downstream
// indexes through them:
//
//   • the container's ANONYMIZED people axis is the submission's people axis, in
//     the same order — so de-anonymizing by position is sound;
//   • the container's date axis is the submission range's expansion, day for day.
//
// The document's own coordinates come from the container verbatim. Nothing here
// reconstructs worksheet geometry.
//
// Assembly ends by running the whole-document validator, so an `ok` result is a
// document F1 can commit AND later promote — never one that passes here and fails
// at the promotion gate once the server job is gone.

import { computeSolvedBaselineId } from "./baseline";
import { parseRosterContainer, shiftIdKeySet, type RosterContainerView } from "./container";
import { checkSolvedDays } from "./container";
import { deriveRosterContext } from "./context";
import { typedIdKey } from "./day-state";
import { validateRosterDocument } from "./validate";
import {
  ROSTER_DOCUMENT_SCHEMA_VERSION,
  ROSTER_SUBMISSION_SCHEMA_VERSION,
  type RosterDocument,
  type RosterSubmission,
} from "./types";

/** Everything capture has in hand once a run has completed successfully. */
export interface AssembleRosterInput {
  /** The raw `GET /optimize/{id}/roster` body. Validated here, never trusted. */
  container: unknown;
  /** The immutable submission snapshot payload staged before the POST. */
  submission: RosterSubmission;
  /** The de-anonymized styled workbook — the frozen render output. */
  frozenXlsx: Blob;
  /** Build stamp for provenance only; it never gates compatibility. */
  appBuild: string;
}

export type AssembleRosterResult =
  | { ok: true; document: RosterDocument }
  | { ok: false; reason: string };

/** Assemble and self-validate a roster document. Fails closed with a reason. */
export async function assembleRosterDocument(
  input: AssembleRosterInput,
): Promise<AssembleRosterResult> {
  if (input.submission.schemaVersion !== ROSTER_SUBMISSION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported submission snapshot schema version ${String(input.submission.schemaVersion)}`,
    };
  }
  if (!(input.frozenXlsx instanceof Blob) || input.frozenXlsx.size === 0) {
    return { ok: false, reason: "the frozen workbook is missing or empty" };
  }
  if (typeof input.appBuild !== "string" || input.appBuild.length === 0) {
    return { ok: false, reason: "appBuild is not a non-empty string" };
  }

  const parsed = parseRosterContainer(input.container);
  if (!parsed.ok) return parsed;
  const container: RosterContainerView = parsed.container;

  const derived = deriveRosterContext(input.submission);
  if (!derived.ok) return derived;
  const context = derived.context;

  if (container.people.length !== context.people.length) {
    return {
      ok: false,
      reason: `the container has ${container.people.length} people for ${context.people.length} submitted people`,
    };
  }
  // The container's ids are the SUBMITTED (anonymized) ids, so they are compared
  // against the submitted document's own axis, not against the de-anonymized one.
  const submittedIds = derived.document.people.items.map((person) => typedIdKey(person.id));
  for (let index = 0; index < container.people.length; index++) {
    if (typedIdKey(container.people[index].id) !== submittedIds[index]) {
      return {
        ok: false,
        reason: `the container's people axis diverges from the submission at index ${index}`,
      };
    }
  }

  if (container.dates.length !== context.calendar.length) {
    return {
      ok: false,
      reason: `the container has ${container.dates.length} dates for ${context.calendar.length} submitted dates`,
    };
  }
  for (let index = 0; index < container.dates.length; index++) {
    if (container.dates[index].iso !== context.calendar[index].iso) {
      return {
        ok: false,
        reason: `the container's date axis diverges from the submission at index ${index}`,
      };
    }
  }

  // Re-check the grid against the DOCUMENT's shift types: the container check ran
  // before any shift-type set was known, so this is where an assignment code that
  // no shift type resolves is caught.
  const grid = checkSolvedDays(
    container.solvedDays,
    context.people.length,
    context.calendar.length,
    shiftIdKeySet(context.shiftTypes.map((shiftType) => shiftType.id)),
  );
  if (!grid.ok) return grid;

  const solvedBaselineId = await computeSolvedBaselineId({
    people: context.people,
    dates: context.calendar,
    solvedDays: grid.solvedDays,
  });

  const assembled: RosterDocument = {
    schemaVersion: ROSTER_DOCUMENT_SCHEMA_VERSION,
    provenance: {
      solverStatus: container.solverStatus,
      score: container.score,
      solvedBaselineId,
      appBuild: input.appBuild,
    },
    submission: {
      canonicalYaml: input.submission.canonicalYaml,
      reverseMap: [...input.submission.reverseMap],
      schemaVersion: ROSTER_SUBMISSION_SCHEMA_VERSION,
    },
    context,
    solvedDays: grid.solvedDays,
    // A freshly captured roster has not been edited yet, by definition.
    edits: [],
    coordinateMap: container.coordinateMap,
    frozenXlsx: input.frozenXlsx,
  };

  // Assembly finishes through the SAME whole-document validator promotion and import
  // use, so `ok` means "immediately valid" rather than "structurally plausible".
  //
  // This is not belt-and-braces. F1's `commitCandidate` stores documents opaquely,
  // without validation, so any invalidity assembly waved through would persist as a
  // candidate that only fails much later at promotion — after the server job may
  // already have been deleted. The concrete case: local de-anonymization only needs
  // the container's keys to be LOOKUP-able, so a reverse map whose identifiers are
  // not well-formed `P#` passed here while `validatePeopleReverseMap` rejects it.
  return validateRosterDocument(assembled);
}
