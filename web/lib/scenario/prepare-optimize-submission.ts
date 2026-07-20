// T16q — the single shared preparation path for an Optimize submission. It
// co-derives, from ONE validated transform, everything the run/recovery flow
// needs: the exact strict YAML the backend receives, the people count (T16c's
// XLSX restoration row window `[3, 3 + peopleCount)`), and a serializable
// people-only reverse map (anonymized `P#` → the original id) for restoring
// people ids in the downloaded workbook.
//
// The plain path is byte-identical to the existing strict export
// (`serializeCanonicalDocument`) and carries no reverse map. The anonymized path
// uses T16's FIXED toggle — `people: true`, `groups: false`, `scatter: false` —
// AND, matching the old app (`removeDescriptions: true`, spec FR-OE-41/42),
// recursively removes every free-text `description` before serialization, so no
// identifying prose leaves for a possibly third-party solver. Save/Load
// anonymization (T17) deliberately keeps descriptions and is not touched here.
//
// The YAML and the reverse map are derived from the SAME transformed document,
// so the ids present in the submitted bytes are exactly the keys of the reverse
// map. Pure and copy-not-mutate: the input document is never mutated.

import { anonymizeDocument, buildIdMap, type AnonymizationIdMap } from "./anonymize";
import {
  ScenarioValidationError,
  serializeCanonicalDocument,
  validateScenario,
  type ScenarioValidationIssue,
} from "./serialize";
import type { CanonicalScenarioDocument, PersonId, PersonRef } from "./types";

/**
 * One serializable reverse-map entry: `[anonymizedId, originalTypedId]`. Tuple
 * transport (not an object keyed by the anonymized id) avoids object-key
 * coercion (a numeric-looking key is never stringified) and prototype-pollution
 * hazards (`__proto__`/`constructor` are ordinary array values, never keys). The
 * original id keeps its type — a finite integer or a string.
 */
export type ReverseMapTuple = [anonymizedId: string, originalId: PersonId];

/**
 * The people-only reverse map: ordered `[anonymizedId, originalId]` tuples in
 * people-item order. Empty for a plain (non-anonymized) submission.
 */
export type PeopleReverseMap = ReverseMapTuple[];

/** A well-formed generated id: `P` + a positive integer, no leading zero. */
const ANONYMIZED_ID_PATTERN = /^P[1-9][0-9]*$/;

/** A finite integer id (rejects `NaN`, `±Infinity`, and fractional numbers). */
function isFiniteIntegerId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** An accepted original id: a finite integer or any string (Unicode included). */
function isOriginalId(value: unknown): value is PersonId {
  return typeof value === "string" || isFiniteIntegerId(value);
}

/** A type-aware identity key so numeric `1` and string `"1"` stay DISTINCT. */
function typedIdentityKey(value: PersonId): string {
  return `${typeof value}:${String(value)}`;
}

/**
 * Strictly validate an untrusted value as a `PeopleReverseMap`, returning the
 * typed map or `null`. Enforces the settled tuple-transport invariants:
 *   • exactly `expectedCount` tuples;
 *   • every entry is a 2-tuple whose first element is a unique well-formed `P#`
 *     id and whose second element is a finite integer or string original;
 *   • original typed identities are unique (numeric `1` ≠ string `"1"`).
 * Generated `P#` ids are unique and well-formed rather than asserted contiguous:
 * `buildIdMap` skips a candidate that would collide with a retained group id, so
 * a valid map is not always literally `P1..Pn`. Uniqueness + cardinality is the
 * safe, achievable coverage guarantee.
 */
export function validatePeopleReverseMap(
  value: unknown,
  expectedCount: number,
): PeopleReverseMap | null {
  if (!Array.isArray(value) || value.length !== expectedCount) return null;

  const seenAnonymized = new Set<string>();
  const seenOriginal = new Set<string>();
  const tuples: PeopleReverseMap = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [anonymized, original] = entry as [unknown, unknown];
    if (typeof anonymized !== "string" || !ANONYMIZED_ID_PATTERN.test(anonymized)) return null;
    if (!isOriginalId(original)) return null;
    if (seenAnonymized.has(anonymized)) return null;
    const identity = typedIdentityKey(original);
    if (seenOriginal.has(identity)) return null;
    seenAnonymized.add(anonymized);
    seenOriginal.add(identity);
    tuples.push([anonymized, original]);
  }
  return tuples;
}

/** Everything a submission needs, co-derived from one validated transform. */
export interface OptimizeSubmissionPrep {
  /** The exact strict YAML the backend receives. */
  yaml: string;
  /** People-item count of the submitted document (T16c row window). */
  peopleCount: number;
  /** Ordered `[anonymizedId, originalId]` tuples; empty when not anonymized. */
  reverseMap: PeopleReverseMap;
  /** Whether the fixed people-only anonymization transform was applied. */
  anonymized: boolean;
}

/** The prepared submission, or the blocking producer issues of an invalid draft. */
export type PrepareOptimizeSubmissionResult =
  | { ok: true; prep: OptimizeSubmissionPrep }
  | { ok: false; issues: ScenarioValidationIssue[] };

export interface PrepareOptimizeSubmissionOptions {
  /**
   * Apply T16's fixed people-only anonymization (`people: true`, `groups:
   * false`, `scatter: false`) and recursive description removal. When false, the
   * plain strict byte path is used unchanged and no reverse map is produced.
   */
  anonymize: boolean;
}

/**
 * Recursively return a copy of `value` with every `description` key removed at
 * any depth. Mirrors the old app's `removeDescriptionFields`
 * (`anonymizeSchedulingState.ts`). Copy-not-mutate: arrays/objects are rebuilt,
 * primitives pass through, so the caller's document is never touched.
 */
function stripDescriptions<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripDescriptions(item)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .map(([key, item]) => [key, stripDescriptions(item)]),
  ) as T;
}

/**
 * Restrict a full `buildIdMap` result to the people domain only — T16's fixed
 * toggle rewrites people ids but leaves group ids untouched. Mirrors the
 * people-only slice `prepareAnonymizedExport` takes for `{ people: true, groups:
 * false }`, so the id map handed to `anonymizeDocument` only ever carries the
 * people domain in its `forward`/`reverse` lookup.
 */
function peopleOnlyIdMap(idMap: AnonymizationIdMap): AnonymizationIdMap {
  const forward = new Map<PersonRef, PersonRef>();
  const reverse = new Map<PersonRef, PersonRef>();
  for (const [original, anonymized] of idMap.people) {
    forward.set(original, anonymized);
    reverse.set(anonymized, original);
  }
  return { people: idMap.people, groups: new Map(), forward, reverse };
}

/**
 * Prepare a plain or anonymized Optimize submission from a strict Workspace
 * projection (T17's validated `CanonicalScenarioDocument`).
 *
 * Plain: serialize the document through the existing strict path; the bytes are
 * unchanged, descriptions are preserved, and the reverse map is empty.
 *
 * Anonymized: validate the SOURCE first (an invalid draft blocks before any
 * transform), rewrite only people ids on a clone, recursively strip every
 * description, then serialize the TRANSFORMED document. The reverse map and the
 * people count are read from that same transformed document, so the submitted
 * YAML and the reverse map can never disagree about which anonymized id maps to
 * which original.
 */
export function prepareOptimizeSubmission(
  document: CanonicalScenarioDocument,
  options: PrepareOptimizeSubmissionOptions,
): PrepareOptimizeSubmissionResult {
  if (!options.anonymize) {
    try {
      const yaml = serializeCanonicalDocument(document);
      return {
        ok: true,
        prep: {
          yaml,
          peopleCount: document.people.items.length,
          reverseMap: [],
          anonymized: false,
        },
      };
    } catch (error) {
      if (error instanceof ScenarioValidationError) return { ok: false, issues: error.issues };
      throw error;
    }
  }

  // Validate the source before transforming so an invalid draft blocks up front
  // (mirrors `prepareAnonymizedExport`), and transform the CANONICAL document so
  // the bytes and map derive from exactly what was validated.
  const sourceValidation = validateScenario(document);
  if (!sourceValidation.ok) return { ok: false, issues: sourceValidation.issues };

  const idMap = buildIdMap(sourceValidation.document);
  const anonymized = anonymizeDocument(sourceValidation.document, peopleOnlyIdMap(idMap));
  // Remove every free-text description before the bytes leave for the solver.
  const transformed = stripDescriptions(anonymized);

  // Ordered `[anonymized, original]` tuples from the SAME id map used to rewrite
  // the document, in people-item order. Originals keep their type.
  const reverseMap: PeopleReverseMap = [...idMap.people].map(([original, anon]) => [
    anon,
    original,
  ]);

  try {
    const yaml = serializeCanonicalDocument(transformed);
    return {
      ok: true,
      prep: {
        yaml,
        peopleCount: transformed.people.items.length,
        reverseMap,
        anonymized: true,
      },
    };
  } catch (error) {
    if (error instanceof ScenarioValidationError) return { ok: false, issues: error.issues };
    throw error;
  }
}
