// Transactional per-scenario repository (T02) — public surface.
//
// The durable authority for scenario content, writer ownership, revisions, and
// bounded history. NOT yet wired into components: the legacy Zustand/`persist`
// path stays live as the projection until T03 performs the cutover.

export { NurseSchedulerDb, NURSE_SCHEDULER_DB_NAME, REPOSITORY_SCHEMA_VERSION } from "./schema";

export { RepositoryError, isRepositoryError, type RepositoryErrorCode } from "./errors";

export { applyScenarioCommand, isContentCommand, type ScenarioCommandV1 } from "./commands";

export { assertLeaseOwnership, isLeaseLive, LEASE_HEARTBEAT_MS, LEASE_TTL_MS } from "./leases";

export { describeHistory, HISTORY_LIMIT, type HistoryAvailability } from "./history";

export { assertGenerationsUnchanged, ensureGeneration, generationScopesFor } from "./generations";

export {
  createScenarioRepository,
  type CommitInput,
  type CommitResult,
  type ScenarioRepository,
  type ScenarioRepositoryConfig,
  type ScenarioSelection,
  type ScenarioSwitch,
  type ScenarioSwitchTarget,
  type TabContext,
} from "./repository";

export {
  migrateLegacyScenarioRecord,
  readLegacyMigrationRecord,
  type LegacyMigrationOutcome,
} from "./migration";

export { commandDigest, stableStringify } from "./digest";

export {
  GLOBAL_GENERATION_SCOPE,
  LEGACY_MIGRATION_KEY,
  scenarioGenerationScope,
  type AssistantProposalV1,
  type AssistantReceiptV1,
  type AssistantWriteFenceV1,
  type CapturedGeneration,
  type GenerationScopeKey,
  type HistoryLinkV1,
  type LeaseOwner,
  type LeaseResult,
  type LegacyMigrationRecord,
  type OptimizeBasisV1,
  type ReversibleScenarioPayload,
  type ScenarioCommitKind,
  type ScenarioCommitV1,
  type ScenarioEnvelopeV3,
  type ScenarioSnapshot,
  type TabWorkspaceSelectionV1,
  type WriterLeaseV2,
} from "./types";
