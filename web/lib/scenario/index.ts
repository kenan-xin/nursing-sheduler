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
// T17r — Workspace V1 backup export (plain + anonymised), the Save/Load artifacts.
export { prepareWorkspaceExport, prepareAnonymizedWorkspaceExport } from "./workspace-export";
// T16q — shared Optimize submission preparation: co-derived strict YAML, people
// count, and serializable people-only reverse map from one validated transform.
export {
  prepareOptimizeSubmission,
  validatePeopleReverseMap,
  type OptimizeSubmissionPrep,
  type PrepareOptimizeSubmissionResult,
  type PrepareOptimizeSubmissionOptions,
  type PeopleReverseMap,
  type ReverseMapTuple,
} from "./prepare-optimize-submission";
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
  classifyLoadVersion,
  type PrepareScenarioLoadResult,
  type VersionConfirmStatus,
} from "./prepare-scenario-load";
export {
  buildIdMap,
  anonymizeDocument,
  scatterShiftRequests,
  getMissingPreferredScatterDateGroups,
  type AnonymizationIdMap,
  type Rng,
} from "./anonymize";
// T17r — flat Workspace V1 contract: source selection, structural schema,
// optimize readiness, strict projection, and Workspace YAML serialization.
export {
  WORKSPACE_VERSION,
  MAX_ONE_SHIFT_PER_DAY_WORKSPACE_ID,
  GUIDED_CONSTRAINT_KIND_TO_TYPE,
  workspaceRootSchema,
  classifyWorkspaceSource,
  checkWorkspaceReadiness,
  projectWorkspaceToStrict,
  convertWorkspaceForOptimize,
  buildWorkspaceDocument,
  serializeWorkspace,
  serializeWorkspaceDocument,
  parseWorkspaceYaml,
  normalizeWorkspaceToImportTarget,
  type WorkspaceDocumentV1,
  type WorkspacePreferenceRecord,
  type WorkspaceGuidedRule,
  type ParsedWorkspace,
  type WorkspaceSource,
  type WorkspaceIssue,
  type WorkspaceIssueCode,
  type WorkspaceConversionResult,
} from "./workspace";
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
// qq0.23a — total, ordered, fail-closed C3 selector resolution for the
// uncredited-leave guard, plus the lossless typed-key record transport.
export {
  buildScenarioResolutionContext,
  buildPeopleIndexMap,
  buildDateIndexMap,
  resolvePeopleSelector,
  resolveShiftTypeSelector,
  resolveDateSelector,
  toTypedKeyRecords,
  PeopleMapError,
  DateMapError,
  type Resolution,
  type TypedMapKey,
  type TypedKeyRecord,
  type ResolutionContextInput,
  type ScenarioResolutionContext,
} from "./leave-guard/resolution";
// qq0.23b — the shared, pure uncredited-leave detector plus the saved-state and
// normalized-import adapters that snapshot scenario state into its input.
export {
  findUncreditedLeaveFindings,
  type LeaveGuardCountInput,
  type LeaveGuardInput,
  type UncreditedLeaveFinding,
} from "./leave-guard/detector";
export {
  findSavedUncreditedLeaveFindings,
  findImportUncreditedLeaveFindings,
  type SavedLeaveGuardSnapshot,
  type ImportLeaveGuardSnapshot,
} from "./leave-guard/adapters";
