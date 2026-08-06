// Durable DTOs for the transactional per-scenario repository (T02, tech-plan
// "Browser durable model"). These are versioned APPLICATION shapes, not library
// objects: nothing here is a Zustand, zundo, Dexie, or CopilotKit instance, so a
// library upgrade has exactly one adapter boundary.
//
// The repository — not the Zustand store — is the durable authority for scenario
// content once T03 cuts the live paths over. During T02 the legacy
// `persist`-backed key/value record stays live and untouched; the repository is
// populated beside it by an idempotent migration (see `migration.ts`).

import type { CapabilityRegistryStamp } from "@/lib/capability/types";
import type { ScenarioUiState } from "@/lib/scenario";
import type { PreparedProposalV1, ProposalDiffEntry, ProposalStatus } from "@/lib/proposal";

// ---------------------------------------------------------------------------
// Scenario envelope
// ---------------------------------------------------------------------------

/** A durable scenario snapshot: content plus its backup-freshness fingerprint. */
export interface ScenarioSnapshot {
  scenario: ScenarioUiState;
  /** Fingerprint of the last emitted Workspace backup, or `null` (unknown). */
  backupFingerprint: string | null;
}

/**
 * The per-scenario durable envelope — one row per logical scenario identity.
 *
 * Two independent revision counters, because they answer different questions:
 *   • `documentRevision` moves ONLY for scenario-content commits. A Preview or
 *     proposal binds to it, so a metadata-only write must not stale it.
 *   • `recordRevision` moves for EVERY envelope write, including metadata-only
 *     ones (recording a backup, a history-session change). It is the row's
 *     write identity.
 *
 * Neither ever moves backwards. Undo and Redo are new commits with new
 * `documentRevision` values, never a rewind of the counter.
 */
export interface ScenarioEnvelopeV3 extends ScenarioSnapshot {
  /** Primary key. Logical scenario identity; local-only, never exported. */
  scenarioId: string;
  schemaVersion: 3;
  documentRevision: number;
  recordRevision: number;
  /** Fencing token of the writer whose commits this envelope has accepted. */
  acceptedLeaseEpoch: number;
  topCommitId: string | null;
  /** Reload mints a new session; prior-session reversal payloads are invalidated. */
  historySessionId: string;
  /**
   * How many live content commits of the current session are currently applied.
   * Undo moves it down, Redo moves it up, a new content commit supersedes
   * everything above it and lands the cursor at the new top.
   */
  historyCursor: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Tab selection and writer lease
// ---------------------------------------------------------------------------

/**
 * Which scenario a tab currently has selected. Selection is deliberately SEPARATE
 * from ownership: a tab editing scenario A must not lock scenario B, and reaping a
 * stale selection must never delete scenario content.
 */
export interface TabWorkspaceSelectionV1 {
  /** Primary key. The per-tab UUID, stable across a reload of the same tab. */
  tabId: string;
  scenarioId: string;
  selectedAt: string;
}

/**
 * The single-writer lease for ONE scenario. IndexedDB plus this persisted epoch is
 * the authority; a BroadcastChannel message is only a hint, so a frozen or
 * disconnected former owner still fails its next persisted write on the epoch
 * check.
 */
export interface WriterLeaseV2 {
  /** Primary key — one lease per scenario, not one per workspace. */
  scenarioId: string;
  ownerTabId: string;
  /** Monotonic fencing token; a takeover increments it immediately. */
  epoch: number;
  heartbeatAt: string;
  expiresAt: string;
}

/** The identity a caller must present for every fenced repository write. */
export interface LeaseOwner {
  scenarioId: string;
  tabId: string;
  epoch: number;
}

/** The result of an acquire/takeover/heartbeat, with the persisted envelope reread. */
export interface LeaseResult {
  owner: LeaseOwner;
  lease: WriterLeaseV2;
  envelope: ScenarioEnvelopeV3;
  /** Whether this call incremented the epoch (i.e. seized an existing lease). */
  tookOver: boolean;
}

// ---------------------------------------------------------------------------
// Commits and history
// ---------------------------------------------------------------------------

export type ScenarioCommitKind =
  | "migrate"
  | "new"
  | "load"
  | "switch"
  | "manual"
  | "undo"
  | "redo"
  | "assistant_apply";

/** The bounded, session-scoped reversal material for one content commit. */
export interface ReversibleScenarioPayload {
  before: ScenarioSnapshot;
  after: ScenarioSnapshot;
}

/**
 * Why a commit no longer carries reversal material. The commit FACT is durable and
 * append-only either way — only the payload is bounded.
 */
export type ReversiblePayloadState =
  | "live"
  | "pruned" // evicted by the 50-entry session bound
  | "expired-session"; // a reload started a new history session

/** One append-only commit fact. Never updated except to bound/supersede it. */
export interface ScenarioCommitV1 {
  commitId: string;
  scenarioId: string;
  parentCommitId: string | null;
  documentRevision: number;
  historySessionId: string;
  /** Monotonic ordering within `(scenarioId, historySessionId)`. */
  sessionSeq: number;
  kind: ScenarioCommitKind;
  /**
   * Whether this commit participates in the session Undo/Redo cursor.
   *
   * Deliberately an explicit flag rather than a derivation from `kind`: a genesis
   * commit and a content commit can share a kind (a Load may mint a new identity
   * OR replace the current one), and "is this undoable?" must not depend on
   * re-deriving that distinction at every read. Genesis, `switch`, `undo`, and
   * `redo` commits are durable FACTS but are never cursor entries.
   */
  isContent: boolean;
  commandDigest: string;
  reversiblePayload: ReversibleScenarioPayload | null;
  payloadState: ReversiblePayloadState;
  /** Set when a later commit branched over this one; the fact is still retained. */
  supersededAt: string | null;
  idempotencyKey?: string;
  createdAt: string;
}

/**
 * An append-only link recording that `linkCommitId` reverted (`undo`) or reapplied
 * (`redo`) `sourceCommitId`. Links are never deleted or rewritten.
 */
export interface HistoryLinkV1 {
  seq?: number;
  scenarioId: string;
  historySessionId: string;
  kind: "undo" | "redo";
  sourceCommitId: string;
  linkCommitId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Assistant write fences (generations)
// ---------------------------------------------------------------------------

/** The global fence scope, plus the per-scenario scope key builder. */
export const GLOBAL_GENERATION_SCOPE = "global" as const;

export type GenerationScopeKey = "global" | `scenario:${string}`;

export function scenarioGenerationScope(scenarioId: string): GenerationScopeKey {
  return `scenario:${scenarioId}`;
}

/**
 * A PERMANENT, monotonic, non-content fence. Clear history / Clear all bump it;
 * nothing ever deletes it or moves it backwards, so a detached late callback that
 * captured an older generation can never recreate deleted data.
 */
export interface AssistantWriteFenceV1 {
  scopeKey: GenerationScopeKey;
  generation: number;
  clearedAt: string | null;
  createdAt: string;
}

/** A generation captured before an interruptible operation, checked on write. */
export interface CapturedGeneration {
  scopeKey: GenerationScopeKey;
  generation: number;
}

// ---------------------------------------------------------------------------
// Proposal / receipt / basis (durable schema only — T07/T08 own the behaviour)
// ---------------------------------------------------------------------------

/**
 * The proposal lifecycle, named by the layer that decides it.
 *
 * T02 minted its own copy of these literals because `lib/proposal` did not exist
 * yet. It does now, and a second definition of "what states may a proposal be in"
 * could only ever drift from the one the Preview actually renders.
 */
export type AssistantProposalStatus = ProposalStatus;

/**
 * A typed change proposal bound to the exact scenario basis it was prepared
 * against, as it is persisted.
 *
 * The row IS the prepared proposal -- its commands, digest, host-derived diff,
 * operational assumptions and recorded confirmations -- plus the three fields only
 * a completed Apply can fill. Storing a projection of it instead would mean the
 * durable record and the reviewed change were two different things, and Apply would
 * have to trust whichever one it happened to read.
 */
export interface AssistantProposalV1 extends PreparedProposalV1 {
  /** The commit this proposal produced, once one exists. */
  appliedCommitId: string | null;
  receiptId: string | null;
  /** The key the Apply transaction consumed. A different key may never reuse it. */
  idempotencyKey: string | null;
}

/**
 * The durable proof of an applied proposal, written in the Apply transaction.
 *
 * Everything on it is derived from COMMITTED state: the summary is the diff between
 * the document the transaction read and the document it wrote, not the preview the
 * user was shown. If those two ever disagreed, the receipt would be describing a
 * change that did not happen.
 */
export interface AssistantReceiptV1 {
  receiptId: string;
  schemaVersion: 1;
  proposalId: string;
  /** The exact proposal revision that was applied. */
  proposalRevision: number;
  scenarioId: string;
  commitId: string;
  /** The revision the commit PRODUCED. Equality with the live one is the Superseded test. */
  documentRevision: number;
  historySessionId: string;
  idempotencyKey: string;
  commandDigest: string;
  confirmationDigest: string;
  registryStamp: CapabilityRegistryStamp;
  /** Host-derived, from committed before/after. What the receipt shows the user. */
  summary: ProposalDiffEntry[];
  /** The screens the change reached, as capability ids. */
  capabilityIds: string[];
  createdAt: string;
}

// The Optimize basis row is DEFINED in `@/lib/optimize/basis/basis-row` and
// re-exported here. T02 owns the durable table so a basis row can be written in
// the same transaction as a commit; T08 owns the shape and its semantics, and the
// authority boundary forbids T08's modules from importing this graph — so the
// dependency points outward, not inward.
export type {
  OptimizeBasisOwnerKind,
  OptimizeBasisRecordFields,
  OptimizeBasisRecordV1,
  OptimizeBasisRecordV2,
  StoredOptimizeBasisRow,
} from "@/lib/optimize/basis/basis-row";

// ---------------------------------------------------------------------------
// Repository metadata
// ---------------------------------------------------------------------------

export type LegacyMigrationState = "in-progress" | "complete" | "failed";

/** The idempotency/recovery marker for the one-time legacy-record migration. */
export interface LegacyMigrationRecord {
  key: typeof LEGACY_MIGRATION_KEY;
  state: LegacyMigrationState;
  /** The scenario identity the legacy record was migrated into. */
  scenarioId: string | null;
  /** Source legacy key, kept so a re-run can prove it targets the same record. */
  sourceKey: string;
  attempts: number;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const LEGACY_MIGRATION_KEY = "legacyScenarioMigration" as const;

/** Any row in the small repository metadata table. */
export type RepositoryMetaRow = LegacyMigrationRecord;

/** One key/value row — the LEGACY persisted scenario payload lives under one key. */
export interface KeyValueRow {
  key: string;
  value: string;
}
