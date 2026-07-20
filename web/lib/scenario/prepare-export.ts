// T17a-2 — the single validated export path shared by preview, Download, Copy,
// and anonymised download (tech-plan §4, critique major 3). Wraps
// `serializeScenario`/`serializeCanonicalDocument`, turning the
// `ScenarioValidationError` throw into a discriminated result so an invalid
// draft blocks the caller structurally instead of crashing it or recording a
// backup with no artifact produced (FR-SL-02b). Never writes, never calls
// `recordBackup`, never mutates live state — that wiring belongs to later UI
// tickets (T17a-4/T17a-5).

import {
  anonymizeDocument,
  buildIdMap,
  scatterShiftRequests,
  type AnonymizationIdMap,
  type Rng,
} from "./anonymize";
import { toCanonicalScenarioDocument } from "./canonical";
import {
  ScenarioValidationError,
  serializeCanonicalDocument,
  serializeScenario,
  validateScenario,
  type ScenarioValidationIssue,
} from "./serialize";
import type { CanonicalScenarioDocument, PersonRef, ScenarioUiState } from "./types";

/** The result of a validated export attempt: the dumped YAML, or the blocking issues. */
export type PrepareExportResult =
  | { ok: true; yaml: string }
  | { ok: false; issues: ScenarioValidationIssue[] };

/**
 * The single validated plain-export path (preview, Download, Copy). Wraps
 * `serializeScenario`, converting its `ScenarioValidationError` throw into an
 * `{ ok: false }` result so an invalid draft blocks structurally rather than
 * crashing the caller. Never writes, never mutates `state`.
 */
export function prepareExport(state: ScenarioUiState): PrepareExportResult {
  try {
    return { ok: true, yaml: serializeScenario(state) };
  } catch (error) {
    if (error instanceof ScenarioValidationError) return { ok: false, issues: error.issues };
    throw error;
  }
}

/** The anonymisation toggles (DL10 D2) — independent of each other. */
export interface PrepareAnonymizedExportOptions {
  /** Rewrite people-item ids to `P#`. */
  people: boolean;
  /** Rewrite people-group ids to `G#`. Independent of `people` (default: off). */
  groups: boolean;
  /** Run `scatterShiftRequests` before the id rewrite. */
  scatter: boolean;
  /** Injected RNG for scatter (defaults to `Math.random`). */
  rng?: Rng;
}

/**
 * Restrict a full `buildIdMap` result to only the toggled-on domain(s).
 * `buildIdMap`/`anonymizeDocument` rewrite people and groups together, but
 * DL10 D2's toggles are independent — so the id map handed to
 * `anonymizeDocument` here only ever carries the enabled domain(s) in its
 * `forward`/`reverse` lookup, leaving the other domain's ids untouched.
 */
function selectIdMapDomains(
  idMap: AnonymizationIdMap,
  opts: Pick<PrepareAnonymizedExportOptions, "people" | "groups">,
): AnonymizationIdMap {
  const forward = new Map<PersonRef, PersonRef>();
  const reverse = new Map<PersonRef, PersonRef>();
  if (opts.people) {
    for (const [original, anonymized] of idMap.people) {
      forward.set(original, anonymized);
      reverse.set(anonymized, original);
    }
  }
  if (opts.groups) {
    for (const [original, anonymized] of idMap.groups) {
      forward.set(original, anonymized);
      reverse.set(anonymized, original);
    }
  }
  return {
    people: opts.people ? idMap.people : new Map(),
    groups: opts.groups ? idMap.groups : new Map(),
    forward,
    reverse,
  };
}

/**
 * The anonymised export path: project + validate the SOURCE state first (an
 * invalid draft blocks before any transform is attempted), transform a clone
 * — scatter (if toggled) then the independently-toggled people/group id
 * rewrite — and validate + dump the TRANSFORMED document, so the exported
 * bytes are exactly the validated transformed doc. The live `state` is never
 * mutated. `appVersion` is stamped last on the anonymised output too
 * (FR-SL-02), via the shared `serializeCanonicalDocument` core.
 */
export function prepareAnonymizedExport(
  state: ScenarioUiState,
  opts: PrepareAnonymizedExportOptions,
): PrepareExportResult {
  const projected = toCanonicalScenarioDocument(state);
  const sourceValidation = validateScenario(projected);
  if (!sourceValidation.ok) return { ok: false, issues: sourceValidation.issues };

  let doc: CanonicalScenarioDocument = structuredClone(sourceValidation.document);

  if (opts.scatter) {
    try {
      doc = scatterShiftRequests(doc, opts.rng ?? Math.random);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, issues: [{ path: "", message }] };
    }
  }

  const idMap = selectIdMapDomains(buildIdMap(doc), opts);
  doc = anonymizeDocument(doc, idMap);

  try {
    return { ok: true, yaml: serializeCanonicalDocument(doc) };
  } catch (error) {
    if (error instanceof ScenarioValidationError) return { ok: false, issues: error.issues };
    throw error;
  }
}
