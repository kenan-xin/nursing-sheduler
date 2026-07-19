// Dirty-baseline fingerprint helpers (T04). The durable store's "dirty" flag is
// defined against the last explicit Save/Load baseline, computed as the T18
// canonical-document hash — never a diff of raw UI state. This module also owns
// the single source of truth for *which* fields make up the scenario slice, so
// the persist/temporal partializers and the fingerprint agree exactly.

import {
  buildWorkspaceDocument,
  canonicalHash,
  type CanonicalScenarioDocument,
  type ScenarioUiState,
} from "@/lib/scenario";

/**
 * The durable scenario slice's keys. The persist partializer, the zundo temporal
 * partializer, and the fingerprint projection all read exactly these — so undo
 * history, persistence, and dirty detection can never drift on field coverage.
 */
export const SCENARIO_KEYS = [
  "meta",
  "staff",
  "staffGroups",
  "shifts",
  "shiftGroups",
  "rangeStart",
  "rangeEnd",
  "dateGroups",
  "reqData",
  "exportLayout",
  "cardsByKind",
  "guidedRulePins",
  "maxOneShiftPerDay",
] as const satisfies readonly (keyof ScenarioUiState)[];

/** Extract just the durable scenario slice from a wider store state. */
export function pickScenario(state: ScenarioUiState): ScenarioUiState {
  return {
    meta: state.meta,
    staff: state.staff,
    staffGroups: state.staffGroups,
    shifts: state.shifts,
    shiftGroups: state.shiftGroups,
    rangeStart: state.rangeStart,
    rangeEnd: state.rangeEnd,
    dateGroups: state.dateGroups,
    reqData: state.reqData,
    exportLayout: state.exportLayout,
    cardsByKind: state.cardsByKind,
    guidedRulePins: state.guidedRulePins,
    maxOneShiftPerDay: state.maxOneShiftPerDay,
  };
}

/**
 * Reference-shallow equality over the scenario slice. Relies on the immutable
 * update discipline (every edit replaces the changed field's reference): a set
 * that touches no scenario field leaves all references identical, so zundo can
 * skip recording it as a no-op history entry.
 */
export function scenarioShallowEqual(a: ScenarioUiState, b: ScenarioUiState): boolean {
  return SCENARIO_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Whether the current scenario slice holds no authoring content — every entity,
 * group, date range, request, card, guided pin, and export-layout collection is
 * empty and no `maxOneShiftPerDay` description is set. This is the pure
 * "genuinely empty workspace" test the Load flow uses (T17r review P0): a Load
 * into an empty workspace with a compatible version may commit directly, while a
 * Load into any non-empty workspace must first confirm the replacement. `meta`
 * (apiVersion/appVersion) is deliberately ignored — it is provenance, not
 * authoring content.
 */
export function isScenarioSliceEmpty(scenario: ScenarioUiState): boolean {
  const cards = scenario.cardsByKind;
  const layout = scenario.exportLayout;
  return (
    scenario.staff.length === 0 &&
    scenario.staffGroups.length === 0 &&
    scenario.shifts.length === 0 &&
    scenario.shiftGroups.length === 0 &&
    scenario.dateGroups.length === 0 &&
    scenario.reqData.length === 0 &&
    scenario.rangeStart === "" &&
    scenario.rangeEnd === "" &&
    scenario.guidedRulePins.length === 0 &&
    cards.requirements.length === 0 &&
    cards.successions.length === 0 &&
    cards.counts.length === 0 &&
    cards.affinities.length === 0 &&
    cards.coverings.length === 0 &&
    layout.formatting.length === 0 &&
    layout.extraColumns.length === 0 &&
    layout.extraRows.length === 0 &&
    (scenario.maxOneShiftPerDay === undefined ||
      scenario.maxOneShiftPerDay.description === undefined)
  );
}

/**
 * The order-independent fingerprint of a scenario slice — the value persisted as
 * the backup baseline and compared against for backup-freshness ("dirty")
 * detection. It hashes the NORMALIZED Workspace V1 projection (minus the volatile
 * `appVersion` build stamp), not the strict canonical document: the strict
 * projection intentionally strips Guided pins and disabled-authoring state, so
 * hashing it would leave a Guided-only or enable/disable edit invisible to backup
 * freshness (T17r review P1; DL12 §1). The Workspace projection preserves exactly
 * the state a Workspace backup would.
 */
export function computeScenarioFingerprint(scenario: ScenarioUiState): string {
  const { appVersion: _appVersion, ...normalized } = buildWorkspaceDocument(scenario);
  return canonicalHash(normalized as unknown as CanonicalScenarioDocument);
}
