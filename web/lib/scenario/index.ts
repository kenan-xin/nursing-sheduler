// Scenario contract (T18) — the single shared boundary that the state store
// (T04) and the validator/serializer (T05) both import unchanged.
//
//   • domain types (UI state + canonical document + import target) — ./types
//   • pure canonical projection + empty-state builder                — ./canonical
//   • order-independent dirty-baseline fingerprint                   — ./hash

export * from "./types";
export { createEmptyScenarioUiState, toCanonicalScenarioDocument } from "./canonical";
export { canonicalHash, canonicalStringify } from "./hash";
export { currentAppVersion } from "./app-version";
// T14a — durable Guided rule pin metadata + source-card-deletion reconciliation.
export {
  createGuidedRulePin,
  upsertGuidedRulePin,
  upsertGuidedRulePinBySource,
  updateGuidedRulePin,
  removeGuidedRulePin,
  removeGuidedRulePins,
  pruneOrphanedGuidedRulePins,
  dedupeGuidedRulePinsBySource,
  type GuidedRulePinDraft,
} from "./guided-rule-pins";

// T05 — serialization/validation boundary (F2), import path, anonymize transform.
export {
  serializeScenario,
  serializeCanonicalDocument,
  validateScenario,
  canonicalizeScenarioDocument,
  ScenarioValidationError,
  type ScenarioValidationIssue,
  type ScenarioValidationResult,
} from "./serialize";
// T17a-2 — validated export gate (plain + anonymised), shared by preview/Download/Copy.
export {
  prepareExport,
  prepareAnonymizedExport,
  type PrepareExportResult,
  type PrepareAnonymizedExportOptions,
} from "./prepare-export";
export {
  parseScenarioYaml,
  importScenarioYaml,
  importScenarioValue,
  type ImportResult,
} from "./import-scenario";
// T17b — pure pre-commit load seam (project + validate, no store mutation).
export {
  projectImportTarget,
  prepareScenarioLoad,
  classifyImportVersion,
  type PrepareScenarioLoadResult,
  type ImportVersionStatus,
} from "./prepare-scenario-load";
export {
  buildIdMap,
  anonymizeDocument,
  scatterShiftRequests,
  getMissingPreferredScatterDateGroups,
  type AnonymizationIdMap,
  type Rng,
} from "./anonymize";
export { producerScenarioSchema } from "./schemas/producer";
export { importScenarioSchema } from "./schemas/import";
export {
  buildShiftTypeIndexMap,
  expandShiftTypeSelector,
  OFF_SID,
  LEAVE_SID,
  ShiftTypeMapError,
} from "./schemas/shift-type-map";
export {
  validateContractedHoursContract,
  type ContractedHoursInput,
  type ContractedHoursField,
  type ContractedHoursError,
  type ContractedHoursValidation,
} from "./schemas/contracted-hours";
