// Dirty-baseline fingerprint helpers (T04). The durable store's "dirty" flag is
// defined against the last explicit Save/Load baseline, computed as the T18
// canonical-document hash — never a diff of raw UI state. This module also owns
// the single source of truth for *which* fields make up the scenario slice, so
// the persist/temporal partializers and the fingerprint agree exactly.

import { canonicalHash, toCanonicalScenarioDocument, type ScenarioUiState } from "@/lib/scenario";

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
 * The order-independent canonical fingerprint of a scenario slice — the value
 * persisted as the baseline and compared against for dirty detection.
 */
export function computeScenarioFingerprint(scenario: ScenarioUiState): string {
  return canonicalHash(toCanonicalScenarioDocument(scenario));
}
