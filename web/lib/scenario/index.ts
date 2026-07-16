// Scenario contract (T18) — the single shared boundary that the state store
// (T04) and the validator/serializer (T05) both import unchanged.
//
//   • domain types (UI state + canonical document + import target) — ./types
//   • pure canonical projection + empty-state builder                — ./canonical
//   • order-independent dirty-baseline fingerprint                   — ./hash

export * from "./types";
export { createEmptyScenarioUiState, toCanonicalScenarioDocument } from "./canonical";
export { canonicalHash, canonicalStringify } from "./hash";
