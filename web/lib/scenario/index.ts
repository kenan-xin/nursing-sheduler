// Scenario contract (T18) — the single shared boundary that the state store
// (T04) and the validator/serializer (T05) both import unchanged.
//
//   • domain types (UI state + canonical document + import target) — ./types
//   • pure canonical projection + empty-state builder                — ./canonical
//   • order-independent dirty-baseline fingerprint                   — ./hash

export * from "./types";
export { createEmptyScenarioUiState, toCanonicalScenarioDocument } from "./canonical";
export { canonicalHash, canonicalStringify } from "./hash";

// T05 — serialization/validation boundary (F2), import path, anonymize transform.
export {
  serializeScenario,
  validateScenario,
  canonicalizeScenarioDocument,
  ScenarioValidationError,
  type ScenarioValidationIssue,
  type ScenarioValidationResult,
} from "./serialize";
export {
  parseScenarioYaml,
  importScenarioYaml,
  importScenarioValue,
  type ImportResult,
} from "./import-scenario";
export { buildIdMap, anonymizeDocument, type AnonymizationIdMap } from "./anonymize";
export { producerScenarioSchema } from "./schemas/producer";
export { importScenarioSchema } from "./schemas/import";
export {
  buildShiftTypeIndexMap,
  expandShiftTypeSelector,
  OFF_SID,
  LEAVE_SID,
  ShiftTypeMapError,
} from "./schemas/shift-type-map";
