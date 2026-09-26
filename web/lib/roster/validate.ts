// Whole-document fail-closed validation (F3).
//
// This is the gate every inbound roster document passes before it can replace the
// working roster — an imported file, and a captured candidate on promotion. It is
// the `RosterDocumentValidator` F1 asks for, so a document that fails here is
// never written and the current roster survives untouched.
//
// The strong move is that `context` is not merely shape-checked: it is RE-DERIVED
// from `submission` and required to match exactly. `submission` is the document's
// source of truth and `context` is explicitly a cache of it, so anything that
// disagrees with the submission — a fabricated `baselineMinimums.required`, an
// invented leave credit, a renamed shift type, a swapped person — is caught
// structurally rather than by enumerating tamper cases one at a time.
//
// CONSEQUENCE, and the reason the schema version is independent of `appBuild`:
// changing how `./context` derives anything is a ROSTER SCHEMA CHANGE. It needs a
// version bump plus a migration that re-derives the context, because old files
// carry the old derivation and this check would otherwise reject them.

import { canonicalStringify, validatePeopleReverseMap } from "@/lib/scenario";
import { computeSolvedBaselineId, isSolvedBaselineId } from "./baseline";
import { checkCoordinateMap, checkExactFields, checkSolvedDays, shiftIdKeySet } from "./container";
import { deriveRosterContext } from "./context";
import { checkNormalizedEdits } from "./overlay";
import { freezeRosterDocument } from "./immutable";
import {
  ROSTER_DOCUMENT_FIELDS,
  ROSTER_DOCUMENT_SCHEMA_VERSION,
  ROSTER_SUBMISSION_SCHEMA_VERSION,
  type RosterDocument,
} from "./types";

/** Frozen cap on the embedded workbook, matching the backend's raw-XLSX cap. */
export const MAX_FROZEN_XLSX_BYTES = 32 * 1024 * 1024;

const PROVENANCE_FIELDS = ["solverStatus", "score", "solvedBaselineId", "appBuild"] as const;
const SUBMISSION_FIELDS = ["canonicalYaml", "reverseMap", "schemaVersion"] as const;

/** The validator's verdict, in the exact shape F1's promotion contract expects. */
export type RosterValidation =
  | { ok: true; document: RosterDocument }
  | { ok: false; reason: string };

/** How a validation run is parameterized. */
export interface RosterValidationOptions {
  /**
   * The document schema version to require. Defaults to the version this build
   * writes.
   *
   * This exists so the version policy and its validator can advance TOGETHER (see
   * `./schema-version`). With the version hard-coded, a supported older file would
   * migrate successfully and then be rejected by a validator still demanding the
   * pre-migration version — which made the whole migrate-older branch of the
   * contract dead on arrival at the first real schema bump.
   */
  schemaVersion?: string;
}

/**
 * Validate an untrusted value as a complete roster document. Every rejection names
 * the specific invariant that failed, so the import surface can tell the user what
 * is wrong with the file rather than "invalid roster".
 */
export async function validateRosterDocument(
  value: unknown,
  options: RosterValidationOptions = {},
): Promise<RosterValidation> {
  const expectedSchemaVersion = options.schemaVersion ?? ROSTER_DOCUMENT_SCHEMA_VERSION;
  const shape = checkExactFields(value, ROSTER_DOCUMENT_FIELDS, "the roster document");
  if (!shape.ok) return shape;
  const record = shape.record;

  if (record.schemaVersion !== expectedSchemaVersion) {
    return {
      ok: false,
      reason: `unsupported roster document schema version ${String(record.schemaVersion)}`,
    };
  }

  // --- submission (the source of truth) ------------------------------------
  const submissionShape = checkExactFields(record.submission, SUBMISSION_FIELDS, "submission");
  if (!submissionShape.ok) return submissionShape;
  const submissionRecord = submissionShape.record;
  if (submissionRecord.schemaVersion !== ROSTER_SUBMISSION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported submission schema version ${String(submissionRecord.schemaVersion)}`,
    };
  }
  if (
    typeof submissionRecord.canonicalYaml !== "string" ||
    submissionRecord.canonicalYaml.length === 0
  ) {
    return { ok: false, reason: "submission.canonicalYaml is not a non-empty string" };
  }
  if (!Array.isArray(submissionRecord.reverseMap)) {
    return { ok: false, reason: "submission.reverseMap is not an array" };
  }
  const submission: RosterDocument["submission"] = {
    canonicalYaml: submissionRecord.canonicalYaml,
    reverseMap: submissionRecord.reverseMap as RosterDocument["submission"]["reverseMap"],
    schemaVersion: ROSTER_SUBMISSION_SCHEMA_VERSION,
  };

  // --- context: re-derived, then required to match --------------------------
  const derived = deriveRosterContext(submission);
  if (!derived.ok) return derived;
  const context = derived.context;

  const submittedPeopleCount = derived.document.people.items.length;
  if (submission.reverseMap.length > 0) {
    // Non-empty means the submission was anonymized: the map must cover every
    // submitted person exactly, with unique well-formed `P#` keys and unique
    // typed originals (numeric `1` and string `"1"` stay distinct).
    if (validatePeopleReverseMap(submission.reverseMap, submittedPeopleCount) === null) {
      return { ok: false, reason: "submission.reverseMap is not a valid people reverse map" };
    }
  }

  if (canonicalStringify(record.context) !== canonicalStringify(context)) {
    return {
      ok: false,
      reason: "context does not match the context derived from submission.canonicalYaml",
    };
  }

  // --- solvedDays over the derived axes ------------------------------------
  const grid = checkSolvedDays(
    record.solvedDays,
    context.people.length,
    context.calendar.length,
    shiftIdKeySet(context.shiftTypes.map((shiftType) => shiftType.id)),
  );
  if (!grid.ok) return grid;

  // --- provenance ----------------------------------------------------------
  const provenanceShape = checkExactFields(record.provenance, PROVENANCE_FIELDS, "provenance");
  if (!provenanceShape.ok) return provenanceShape;
  const provenanceRecord = provenanceShape.record;
  if (provenanceRecord.solverStatus !== "OPTIMAL" && provenanceRecord.solverStatus !== "FEASIBLE") {
    return {
      ok: false,
      reason: `provenance.solverStatus is not a solved-run status: ${String(provenanceRecord.solverStatus)}`,
    };
  }
  if (typeof provenanceRecord.score !== "number" || !Number.isFinite(provenanceRecord.score)) {
    return { ok: false, reason: "provenance.score is not a finite number" };
  }
  if (!isSolvedBaselineId(provenanceRecord.solvedBaselineId)) {
    return { ok: false, reason: "provenance.solvedBaselineId is not a SHA-256 hex digest" };
  }
  if (typeof provenanceRecord.appBuild !== "string" || provenanceRecord.appBuild.length === 0) {
    return { ok: false, reason: "provenance.appBuild is not a non-empty string" };
  }

  const recomputed = await computeSolvedBaselineId({
    people: context.people,
    dates: context.calendar,
    solvedDays: grid.solvedDays,
  });
  if (recomputed !== provenanceRecord.solvedBaselineId) {
    return {
      ok: false,
      reason: "provenance.solvedBaselineId does not match the recomputed solved baseline",
    };
  }

  // --- edits overlay -------------------------------------------------------
  const overlay = checkNormalizedEdits(record.edits, {
    solvedDays: grid.solvedDays,
    shiftTypeIds: context.shiftTypes.map((shiftType) => shiftType.id),
  });
  if (!overlay.ok) return overlay;

  // --- coordinates ---------------------------------------------------------
  const coordinates = checkCoordinateMap(
    record.coordinateMap,
    context.people.length,
    context.calendar.length,
  );
  if (!coordinates.ok) return coordinates;

  // --- frozen workbook -----------------------------------------------------
  if (!(record.frozenXlsx instanceof Blob)) {
    return { ok: false, reason: "frozenXlsx is not a Blob" };
  }
  if (record.frozenXlsx.size === 0) {
    return { ok: false, reason: "frozenXlsx is empty" };
  }
  if (record.frozenXlsx.size > MAX_FROZEN_XLSX_BYTES) {
    return {
      ok: false,
      reason: `frozenXlsx is ${record.frozenXlsx.size} bytes, above the ${MAX_FROZEN_XLSX_BYTES}-byte limit`,
    };
  }

  // Frozen deep copy at the document boundary: what the caller gets back shares no
  // mutable object with the value it passed in, so a validated document cannot be
  // edited into an invalid one behind the validator's back.
  return {
    ok: true,
    document: freezeRosterDocument({
      schemaVersion: expectedSchemaVersion,
      provenance: {
        solverStatus: provenanceRecord.solverStatus,
        score: provenanceRecord.score,
        solvedBaselineId: provenanceRecord.solvedBaselineId,
        appBuild: provenanceRecord.appBuild,
      },
      submission,
      context,
      solvedDays: grid.solvedDays,
      edits: record.edits as RosterDocument["edits"],
      coordinateMap: coordinates.coordinateMap,
      frozenXlsx: record.frozenXlsx,
    }),
  };
}
