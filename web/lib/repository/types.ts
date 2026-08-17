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
  /**
   * A clear that has fenced but not yet deleted, and the scenario it targets.
   *
   * THE ONLY DURABLE RECORD OF THE USER'S ACTUAL REQUEST. Clear history is asked for
   * by scenario, and the deletion pass used to rediscover that scenario from whichever
   * threads happened to be marked `cleared` -- so a scenario with content but no thread
   * row had no scope at all, and its proposals, receipts and diagnostic searches
   * survived a clear that promised to remove them. Recovery after a reload was worse:
   * with no thread to find, there was nothing to recover from.
   *
   * Written by `beginClear` and removed by the deletion pass, so its presence means
   * "this clear is unfinished". Non-content: a scope key, a scenario id and a
   * timestamp.
   */
  /**
   * LEGACY. Superseded by {@link AssistantClearOperationV1}.
   *
   * A clear used to record itself as one marker per fence row it bumped, which made
   * its identity a set of fragments rather than one fact. A later clear could replace
   * some of those fragments and leave others, and recovery reading a surviving
   * fragment would authorise a deletion the operation no longer owned. Rows written by
   * such a build may still carry this; it is READ BY NOTHING, so those operations fail
   * closed rather than acting on partial authority.
   */
  pendingClear?: {
    /**
     * The immutable identity of ONE clear operation.
     *
     * Without it, "is this marker still mine?" could only be answered by scope and
     * scenario -- and those repeat. A recovery continuation holding a marker for
     * scenario S would then happily consume the marker of a NEWER clear of S, and
     * delete content written after its own clear had already finished. The id is what
     * makes a stale continuation recognise itself as stale.
     */
    operationId: string;
    scope: "history" | "all";
    /** The captured target. `null` only for `all`, which is global by definition. */
    scenarioId: string | null;
    /** The generation this clear bumped this scope to. A second fact to compare. */
    generation: number;
    at: string;
  } | null;
}

/**
 * ONE Clear operation, recorded once, keyed by its own identity.
 *
 * WHY THIS IS A SINGLE RECORD. Clear all bumps several generation scopes, and the
 * previous design wrote a marker onto each of them. That made an operation's authority
 * divisible: a newer scoped clear would replace the marker on one scope and leave the
 * rest, so recovery could find a surviving fragment, validate only that fragment, and
 * authorise a GLOBAL deletion for an operation whose world had already moved on --
 * after a newer clear had completed and fresh content had landed.
 *
 * The captured set is therefore held here, whole. An operation may delete only if
 * EVERY scope it captured still stands at the generation it captured. A subset proves
 * nothing.
 */
export interface AssistantClearOperationV1 {
  operationId: string;
  /**
   * Shape version. An unrecognised value fails closed rather than being guessed at.
   *
   * 2 replaced a version-1 commitment that hashed lossily: it dropped low surrogates
   * and used ambiguous delimiters, so two different captured sets could commit to the
   * same value. Version-1 records are rejected rather than migrated -- they cannot be
   * trusted to name the set they claim.
   *
   * 3 existed because `outcome` was added to the version-2 shape in place. Two record
   * layouts then shared one discriminator, which is precisely what a version is
   * supposed to prevent: a reader had to guess from key presence rather than be told.
   *
   * 4 IS THE VERSION THIS BUILD WRITES. It carries the canonical Clear fact tail --
   * `requestId`, `reason`, `settlement`, `deletionOutcome` -- so the durable record,
   * the value returned to the caller, the browser bridge and the hydrated projection
   * are the same facts rather than four reconstructions of them. Versions 3 and 2 are
   * read only for compatibility, and only in their exact shipped shapes; their fact
   * tail is reported as `null`, never guessed (see `clear-repo.ts`).
   */
  version: 2 | 3 | 4 | 5;
  /**
   * The UI invocation that minted this operation, so a caller can correlate a returned
   * result with the row on disk even across repeats. Version 4 and later only.
   */
  requestId?: string;
  scope: "history" | "all";
  /** The captured target. `null` only for `all`, which is global by definition. */
  scenarioId: string | null;
  /** EVERY scope this operation bumped, with the generation it bumped it to. */
  captured: readonly { scopeKey: GenerationScopeKey; generation: number }[];
  /**
   * An independently checkable commitment to the COMPLETE captured set.
   *
   * Count plus digest, computed over the normalized set at begin. Without it, a claim
   * could only compare the entries the record happened to supply -- so a record whose
   * set had been truncated or substituted proved whatever remained, and a malformed
   * `history` record naming one scenario while capturing only `global` could delete
   * that scenario on the strength of the global row. The count catches a dropped or
   * added entry; the digest catches a swapped one.
   */
  commitment: { count: number; canonical: string };
  startedAt: string;
  /**
   * The PRODUCT outcome of this operation, independent of its deletion authority.
   *
   * - `"pending"` — the operation is still live deletion authority. `claimOperation` may
   *   prove ownership and delete from it.
   * - `"incomplete"` — the operation was superseded or exhausted. It is NO LONGER
   *   deletion authority (recovery ignores it), but it persists as a secret-safe
   *   tombstone so hydration can show the user that their clear did not complete and
   *   offer a retry. Cleared only after a verified successful Clear all or the matching
   *   scoped retry.
   * - `"failed"` — a storage or runtime failure prevented the deletion transaction from
   *   committing. Same tombstone semantics as `"incomplete"`.
   *
   * OPTIONAL for backward compatibility: records written before the outcome field was
   * added (pre-round-14 version-2 pending rows) do not carry it. The reader treats an
   * absent `outcome` as `"pending"` so legacy authority can recover safely.
   */
  outcome?: "pending" | "incomplete" | "failed";
  /**
   * The bounded fact tail, version 4 and later. Present as explicit `null` on a
   * pending row -- "not known yet" and "known to be nothing" are different facts and
   * an absent key could not tell them apart.
   */
  reason?: "superseded" | "recapture_exhausted" | "storage" | null;
  /** The real bounded settlement class, or `null` if settlement never ran. */
  settlement?: string | null;
  /** The real deletion outcome, or `null` if the deletion pass never ran. */
  deletionOutcome?: "deleted" | "superseded" | null;
  /**
   * What this operation PROVED about the stored configuration, version 5 and later.
   *
   * Separate from the scope because the scope is what was asked for. `beginClear`
   * deletes the settings row inside the transaction that writes a pending record, so a
   * committed global begin proves `deleted`; a global failure before it proves
   * `retained`; a failure that could not read anything proves `unknown`. Settings copy
   * reads this instead of inferring deletion from the requested scope.
   */
  configurationOutcome?: "deleted" | "retained" | "unknown";
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

// The DiagnosticSearch row is DEFINED in `@/lib/ai/diagnostic/search-record` and
// re-exported here. T02 owns the durable table so a search row can be written in a
// generation-fenced transaction alongside its evidence basis; T10 owns the shape
// and its semantics. The authority boundary forbids T10's modules from importing
// this graph, so the dependency points outward.
export type { DiagnosticSearchRecordV1 } from "@/lib/ai/diagnostic/search-record";

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

// ---------------------------------------------------------------------------
// Roster storage rows (F1)
// ---------------------------------------------------------------------------
//
// These DTOs belong to the ROSTER feature, not to the scenario repository, and
// nothing in this graph reads them: the repository declares their tables and never
// touches a row. They are DEFINED here rather than in `lib/store/dexie-storage.ts`
// only to keep the dependency acyclic — that module needs the runtime
// `NurseSchedulerDb` class, so it cannot also be the place the class imports its row
// types from. It re-exports every one of them, so roster code still names them at
// their original specifier.

/**
 * A stored roster document. F1 owns durability, not shape: the payload is an
 * opaque structured-cloneable value (it may embed a `Blob` such as `frozenXlsx`)
 * whose schema and validation belong to F3. `TDocument` defaults to `unknown` so
 * a caller that has a validated type can read it back typed without F1 inventing
 * one.
 */
export interface RosterRow<TDocument = unknown> {
  /** `working` or `candidate:<jobId>`. */
  key: string;
  document: TDocument;
  /**
   * The row's version token. Its allocation differs by row kind:
   *
   *   • `working` — a per-key compare-and-swap revision (1, 2, 3 …).
   *   • `candidate:<jobId>` — the `candidateVersion`, drawn from an ORIGIN-WIDE
   *     counter that is never reset and never reused. Deleting and recreating a
   *     candidate for the same job therefore cannot resurrect a previous version
   *     number, which is what makes it safe as a delete/promote authority (a
   *     per-key counter would restart at 1 and admit ABA).
   */
  revision: number;
  /** The clear epoch this row was written under (see `roster-storage.ts`). */
  clearEpoch: number;
  /**
   * On the `working` row only: the EXACT candidate this roster was promoted from,
   * or absent when it came from an import or any other non-candidate source.
   *
   * Storage metadata, deliberately NOT part of the roster document: it is about
   * where this browser's row came from, so it has no place in the shareable roster
   * file or in the solved-baseline hash. It needs no Dexie index (nothing queries
   * by it) and no schema version bump — an optional field on an out-of-line-keyed
   * store, so rows written before it existed read back with it simply absent.
   */
  candidateSource?: { jobId: string; candidateVersion: number };
}

/** An immutable submission snapshot row, keyed and authorized by `ownerId`. */
export interface SnapshotRow<TPayload = unknown> {
  /** `snapshot:<ownerId>`. */
  key: string;
  ownerId: string;
  submissionOrdinal: number;
  payload: TPayload;
}

/** One typed metadata row (origin-wide counters and pointers). */
export interface MetaRow<TValue = unknown> {
  key: string;
  value: TValue;
}
