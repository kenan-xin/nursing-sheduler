// F2 serialization boundary (T05) — the single Save/Copy/download/Optimize/export
// path. Per tech-plan §4: durable UI state → `toCanonicalScenarioDocument` (T18)
// → canonicalize (omit zero rest, implicit-all → explicit `ALL`) → producer schema
// + refinements → YAML 1.2 dump. Validation runs on the *canonical document*
// (never UI state or a dumped string), and the exact document that is validated is
// the one dumped — there is no unchecked second serialization path.

import { stringify } from "yaml";
import { generateDateItems } from "@/lib/dates/date-id";
import { currentAppVersion } from "./app-version";
import { toCanonicalScenarioDocument } from "./canonical";
import { producerScenarioSchema } from "./schemas/producer";
import {
  PREFERENCE_TYPE,
  RESERVED_SHIFT_TYPE,
  type CanonicalScenarioDocument,
  type DateRef,
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
 * Apply the canonicalizations the producer requires (tech-plan §4), returning
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
 *   4. span-id date refs → canonical full ISO — the exact inverse of the import
 *      boundary's `buildDateRefNormalizer`. See `deSpanDateRefs`.
 */
export function canonicalizeScenarioDocument(
  doc: CanonicalScenarioDocument,
): CanonicalScenarioDocument {
  const clone = structuredClone(doc);
  deSpanDateRefs(clone);
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
 * Expand the two SPAN-ID surfaces back to the backend's canonical date reference.
 *
 * The backend keys `map_did_d` by the full ISO `YYYY-MM-DD` (`scheduler.py`) and
 * accepts `D` / `MM-DD` only as shorthands. The UI instead keys the person×date
 * matrix (`reqData` → shift-request preferences) and date-group members by the
 * span-formatted id `generateDateItems` derives from the range — `DD` within one
 * month, `MM-DD` within one year, ISO across years — and the import boundary
 * re-keys inbound ISO refs onto that form (`buildDateRefNormalizer`). Without the
 * inverse here the producer emits the UI's internal id, so what crosses the
 * boundary is a range-span-dependent shorthand rather than the canonical date,
 * and an import → export round trip is not identity.
 *
 * Mirrors the import normalizer exactly, so the pair composes to identity:
 * only an id that `generateDateItems` actually produced for this range is
 * expanded. Group ids, keywords (`WEEKEND`), range literals (`01~15`), refs that
 * are already full ISO, and non-string refs all pass through verbatim — a bad ref
 * stays reportable by preflight instead of being folded onto a real day.
 *
 * Preference CARDS are deliberately untouched: they store full ISO by design and
 * are not re-keyed on import either.
 */
function deSpanDateRefs(doc: CanonicalScenarioDocument): void {
  const isoBySpanId = new Map(
    generateDateItems({ start: doc.dates.range.startDate, end: doc.dates.range.endDate }).map(
      (item) => [item.id, item.iso],
    ),
  );
  if (isoBySpanId.size === 0) return;
  const expand = (ref: DateRef): DateRef =>
    typeof ref === "string" ? (isoBySpanId.get(ref) ?? ref) : ref;

  for (const group of doc.dates.groups ?? []) {
    group.members = group.members.map(expand);
  }
  for (const pref of doc.preferences) {
    if (pref.type !== PREFERENCE_TYPE.shiftRequest) continue;
    pref.date = Array.isArray(pref.date) ? pref.date.map(expand) : expand(pref.date);
  }
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
 * Stamp the current build version as the **last** top-level key (FR-SL-02),
 * overriding any imported/stale `appVersion` (integrity-only metadata, never
 * re-exported), then run producer preflight on the stamped document and dump
 * exactly what was validated. Throws `ScenarioValidationError` (carrying the
 * flattened issues) if preflight fails — so nothing crosses the boundary
 * structurally unvalidated, and there is no bypass path.
 *
 * The shared core behind `serializeScenario` (plain UI-state export) and the
 * anonymised export path (T17a-2): both stamp/validate/dump identically, so an
 * anonymised download carries `appVersion` last exactly like a plain one.
 */
export function serializeCanonicalDocument(doc: CanonicalScenarioDocument): string {
  const { appVersion: _ignored, ...rest } = doc;
  const stamped: CanonicalScenarioDocument = {
    ...rest,
    appVersion: currentAppVersion(),
  };
  const result = validateScenario(stamped);
  if (!result.ok) throw new ScenarioValidationError(result.issues);
  return stringify(result.document, YAML_OPTIONS);
}

/**
 * Serialize durable UI state to a backend-facing YAML 1.2 string. Projects to the
 * canonical document (T18) and defers to `serializeCanonicalDocument` for the
 * stamp/validate/dump core. Build version is intentionally injected there — not
 * in `toCanonicalScenarioDocument` — so the canonical projection that feeds the
 * dirty-fingerprint hash is invariant under app-version changes (otherwise a
 * restored scenario would go spuriously "dirty" after any build bump).
 */
export function serializeScenario(state: ScenarioUiState): string {
  return serializeCanonicalDocument(toCanonicalScenarioDocument(state));
}
