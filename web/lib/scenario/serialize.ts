// F2 serialization boundary (T05) — the single Save/Copy/download/Optimize/export
// path. Per tech-plan §4: durable UI state → `toCanonicalScenarioDocument` (T18)
// → canonicalize (omit zero rest, implicit-all → explicit `ALL`) → producer schema
// + refinements → YAML 1.2 dump. Validation runs on the *canonical document*
// (never UI state or a dumped string), and the exact document that is validated is
// the one dumped — there is no unchecked second serialization path.

import { stringify } from "yaml";
import { toCanonicalScenarioDocument } from "./canonical";
import { producerScenarioSchema } from "./schemas/producer";
import {
  PREFERENCE_TYPE,
  RESERVED_SHIFT_TYPE,
  type CanonicalScenarioDocument,
  type ScenarioUiState,
} from "./types";
import type { z } from "zod";

/** A single producer-validation failure, flattened for UI display. */
export interface ScenarioValidationIssue {
  /** Dotted path into the canonical document (e.g. `shiftTypes.items.0.endTime`). */
  path: string;
  message: string;
}

export type ScenarioValidationResult =
  | { ok: true; document: CanonicalScenarioDocument }
  | { ok: false; issues: ScenarioValidationIssue[] };

/** Thrown by `serializeScenario` when the canonical document fails preflight. */
export class ScenarioValidationError extends Error {
  readonly issues: ScenarioValidationIssue[];
  constructor(issues: ScenarioValidationIssue[]) {
    super(
      `Scenario failed producer validation with ${issues.length} issue(s): ` +
        issues.map((i) => `${i.path || "<root>"}: ${i.message}`).join("; "),
    );
    this.name = "ScenarioValidationError";
    this.issues = issues;
  }
}

function toIssues(error: z.ZodError): ScenarioValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * Apply the two canonicalizations the producer requires (tech-plan §4), returning
 * a NEW document (never mutating the input):
 *   1. omit zero rest — `restMinutes: 0` is dropped (absence is the only persisted
 *      zero-rest form, mirroring `models.ShiftType` which canonicalizes 0 → None);
 *   2. implicit-all → explicit `ALL` — an omitted shift-type-requirement
 *      `qualifiedPeople` / `date` becomes explicit `ALL` (the backend treats
 *      `None` and `ALL` identically; the frontend normalizes to explicit `ALL`).
 *   3. drop empty `date: []` — the three optional-date preferences (`shift type
 *      requirement`, `shift type successions`, `shift type covering`) treat an
 *      OMITTED `date` as "all dates" while an explicit empty array is a backend
 *      no-op (no dates). See core/nurse_scheduling/preference_types.py: the
 *      `if preference.date is not None` guard before `parse_dates` means `None`
 *      expands to every day but `[]` parses to none. Dropping an empty array
 *      makes a load→save round-trip preserve "all dates" instead of silently
 *      flipping it to "no dates".
 */
export function canonicalizeScenarioDocument(
  doc: CanonicalScenarioDocument,
): CanonicalScenarioDocument {
  const clone = structuredClone(doc);
  for (const shiftType of clone.shiftTypes.items) {
    if (shiftType.restMinutes === 0) delete shiftType.restMinutes;
  }
  for (const pref of clone.preferences) {
    if (
      (pref.type === PREFERENCE_TYPE.shiftTypeRequirement ||
        pref.type === PREFERENCE_TYPE.shiftTypeSuccessions ||
        pref.type === PREFERENCE_TYPE.shiftTypeCovering) &&
      Array.isArray(pref.date) &&
      pref.date.length === 0
    ) {
      delete pref.date;
    }
    if (pref.type === PREFERENCE_TYPE.shiftTypeRequirement) {
      if (pref.qualifiedPeople === undefined) pref.qualifiedPeople = RESERVED_SHIFT_TYPE.all;
      if (pref.date === undefined) pref.date = RESERVED_SHIFT_TYPE.all;
    }
  }
  return clone;
}

/**
 * Validate a scenario document against the strict producer schema (client
 * preflight only — the three differential harnesses are the authority). The
 * document is canonicalized first, and the *canonicalized* document is what the
 * `ok` result carries, so callers serialize exactly what was validated. Pure.
 */
export function validateScenario(document: CanonicalScenarioDocument): ScenarioValidationResult {
  const canonical = canonicalizeScenarioDocument(document);
  const result = producerScenarioSchema.safeParse(canonical);
  if (result.success) return { ok: true, document: canonical };
  return { ok: false, issues: toIssues(result.error) };
}

/** YAML 1.2 dump options. `yaml` defaults to 1.2; `.inf`/`-.inf` and reserved
 *  keywords (`ALL`/`OFF`/`LEAVE`) round-trip through the vendored ruamel loader. */
const YAML_OPTIONS = { version: "1.2" as const };

/**
 * Serialize durable UI state to a backend-facing YAML 1.2 string. Projects to the
 * canonical document (T18), canonicalizes + runs producer preflight, and dumps the
 * validated canonical document. Throws `ScenarioValidationError` (carrying the
 * flattened issues) if preflight fails — so nothing crosses the boundary
 * structurally unvalidated, and there is no bypass path.
 */
export function serializeScenario(state: ScenarioUiState): string {
  const projected = toCanonicalScenarioDocument(state);
  const result = validateScenario(projected);
  if (!result.ok) throw new ScenarioValidationError(result.issues);
  return stringify(result.document, YAML_OPTIONS);
}
