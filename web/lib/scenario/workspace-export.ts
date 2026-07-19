// Workspace V1 backup export gate (T17r; DL13 D6, DL12 §2). The Save & Load
// screen's Download / Copy / Edit-preview / anonymised-download all route through
// here so the emitted artifact is flat Workspace V1 YAML — the authoring-complete
// backup format — rather than the strict solver projection.
//
// Unlike the strict export gate (`prepare-export.ts`, which blocks a draft that
// fails producer validation because it feeds Optimize), a backup PRESERVES
// incomplete work (DL12 §2): null dates and disabled records serialize cleanly.
// The only structural gate is emitted-identity uniqueness — a corrupt duplicate
// `workspaceId` blocks the write rather than shipping an un-reloadable file.

import {
  anonymizeDocument,
  buildIdMap,
  scatterShiftRequests,
  type AnonymizationIdMap,
} from "./anonymize";
import { type PrepareAnonymizedExportOptions, type PrepareExportResult } from "./prepare-export";
import {
  buildWorkspaceDocument,
  serializeWorkspace,
  serializeWorkspaceDocument,
  type WorkspaceDocumentV1,
} from "./workspace";
import type { CanonicalScenarioDocument, PersonRef, ScenarioUiState } from "./types";

/**
 * The plain Workspace backup path (Download / Copy / Edit-preview): serialize the
 * durable state to Workspace V1 YAML. Incomplete work is preserved; only a
 * duplicate emitted `workspaceId` (an identity bug) blocks with a structured issue.
 */
export function prepareWorkspaceExport(state: ScenarioUiState): PrepareExportResult {
  try {
    return { ok: true, yaml: serializeWorkspace(state) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: "", message }] };
  }
}

/**
 * A structured blocking issue when the Workspace date range cannot support Scatter
 * — a missing start/end (incomplete authoring) or a reversed range (end before
 * start) — else `null`. ISO `YYYY-MM-DD` strings order lexicographically, so a
 * plain string compare detects the reversed case. Prevents a silent scatter no-op
 * from reporting a successful scattered download (T17r review P2).
 */
function scatterRangeIssue(range: WorkspaceDocumentV1["dates"]["range"]): {
  path: string;
  message: string;
} | null {
  const { startDate, endDate } = range;
  if (startDate == null || endDate == null || endDate < startDate) {
    return {
      path: "dates.range",
      message:
        "Scatter needs a complete, valid schedule date range: set both a start and end date " +
        "(end on or after start) before downloading a scattered anonymised backup.",
    };
  }
  return null;
}

/** Restrict a full id map to only the toggled-on people/group domain(s). */
function selectIdMapDomains(
  idMap: AnonymizationIdMap,
  opts: Pick<PrepareAnonymizedExportOptions, "people" | "groups">,
): AnonymizationIdMap {
  const forward = new Map<PersonRef, PersonRef>();
  const reverse = new Map<PersonRef, PersonRef>();
  if (opts.people)
    for (const [original, anonymized] of idMap.people) {
      forward.set(original, anonymized);
      reverse.set(anonymized, original);
    }
  if (opts.groups)
    for (const [original, anonymized] of idMap.groups) {
      forward.set(original, anonymized);
      reverse.set(anonymized, original);
    }
  return {
    people: opts.people ? idMap.people : new Map(),
    groups: opts.groups ? idMap.groups : new Map(),
    forward,
    reverse,
  };
}

/**
 * The anonymised Workspace backup path. Builds the full Workspace document
 * (disabled records and Guided pins included) and applies the SAME shared
 * copy-not-mutate transforms the strict path uses — optional scatter, then the
 * independently-toggled people/group id rewrite — over its people domain. The
 * transforms only touch people identifiers, so `workspaceId`/`enabled`/`guidedRules`
 * pass through untouched and the anonymised backup remains a lossless, reloadable
 * Workspace file. The live `state` is never mutated.
 */
export function prepareAnonymizedWorkspaceExport(
  state: ScenarioUiState,
  opts: PrepareAnonymizedExportOptions,
): PrepareExportResult {
  try {
    const workspaceDoc = buildWorkspaceDocument(state);
    // Scatter needs a concrete calendar to move requests within. A null/incomplete
    // or reversed range would silently move nothing yet still report a successful
    // scattered download, so it is a structured blocking issue with no mutation
    // (T17r review P2) — surfaced through the same result channel as any other
    // export failure.
    if (opts.scatter) {
      const rangeIssue = scatterRangeIssue(workspaceDoc.dates.range);
      if (rangeIssue) return { ok: false, issues: [rangeIssue] };
    }
    // The Workspace document is a people-domain superset of the canonical document,
    // so the shared canonical transforms operate on it directly by structural shape.
    let doc = workspaceDoc as unknown as CanonicalScenarioDocument;
    if (opts.scatter) doc = scatterShiftRequests(doc, opts.rng ?? Math.random);
    const idMap = selectIdMapDomains(buildIdMap(doc), opts);
    doc = anonymizeDocument(doc, idMap);
    return { ok: true, yaml: serializeWorkspaceDocument(doc as unknown as WorkspaceDocumentV1) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: "", message }] };
  }
}
