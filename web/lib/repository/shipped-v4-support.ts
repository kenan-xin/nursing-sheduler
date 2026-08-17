// A FROZEN transcript of the database this app shipped at version 4, plus a full row
// in every one of its tables.
//
// WHY IT IS NOT `NurseSchedulerDb`. That class declares version 5 today, so opening it
// creates a v5 database outright and the 4 -> 5 upgrade never runs. A test built that
// way proves only that the current declaration is self-consistent -- exactly the thing
// that cannot fail. Seeding through the historical declaration is what makes an upgrade
// test an upgrade test.
//
// Kept beside the v2 transcript for the same reason that one exists: exactly one frozen
// copy, because a drifted "shipped" shape proves nothing about real browsers.

import { Dexie } from "dexie";

import { createEmptyScenarioUiState } from "@/lib/scenario/canonical";
import type { ScenarioEnvelopeV3, ScenarioSnapshot, WriterLeaseV2 } from "@/lib/repository/types";
import type {
  AssistantProposalV1,
  AssistantReceiptV1,
  AssistantWriteFenceV1,
  ScenarioCommitV1,
  HistoryLinkV1,
  RepositoryMetaRow,
} from "@/lib/repository/types";
import type { OptimizeBasisRecordV1 } from "@/lib/optimize/basis/basis-row";
import type {
  AssistantSettingsV1,
  AssistantThreadV1,
  AssistantTurnV1,
  AssistantMessageV1,
} from "@/lib/ai/assistant/records";
import type { DiagnosticSearchRecordV1 } from "@/lib/ai/diagnostic/search-record";

/**
 * Explicit table-to-DTO type map. Each row in {@link SHIPPED_V4_ROWS} is checked against
 * its actual durable DTO, so a missing required field or a wrong type fails typecheck —
 * the gate the round-13 review asked for.
 */
export interface ShippedV4RowMap {
  /**
   * The legacy single-scenario slot. Its stored value was a scenario snapshot, so the
   * fixture uses that concrete type rather than `unknown` -- an `unknown` here would
   * accept any shape at all, which is the opposite of what a no-escape fixture proves.
   */
  keyval: KeyvalRow;
  scenarioEnvelopes: ScenarioEnvelopeV3;
  tabSelections: { tabId: string; scenarioId: string; selectedAt: string };
  writerLeases: WriterLeaseV2;
  scenarioCommits: ScenarioCommitV1;
  historyLinks: HistoryLinkV1;
  assistantGenerations: AssistantWriteFenceV1;
  assistantProposals: AssistantProposalV1;
  assistantReceipts: AssistantReceiptV1;
  optimizeBases: OptimizeBasisRecordV1;
  repositoryMeta: RepositoryMetaRow;
  assistantSettings: AssistantSettingsV1;
  assistantThreads: AssistantThreadV1;
  assistantTurns: AssistantTurnV1;
  assistantMessages: AssistantMessageV1;
  diagnosticSearches: DiagnosticSearchRecordV1;
}

/** The v1 key/value row, as the legacy single-scenario build wrote it. */
export interface KeyvalRow {
  key: string;
  value: ScenarioSnapshot;
}

/** Verbatim transcript of the v2 store declaration, as version 5 still carries it. */
export const SHIPPED_V4_V2_STORES: Readonly<Record<string, string>> = {
  scenarioEnvelopes: "scenarioId, updatedAt",
  tabSelections: "tabId, scenarioId",
  writerLeases: "scenarioId, ownerTabId, expiresAt",
  scenarioCommits:
    "commitId, scenarioId, [scenarioId+historySessionId+sessionSeq], [scenarioId+documentRevision], &idempotencyKey",
  historyLinks: "++seq, scenarioId, sourceCommitId, linkCommitId",
  assistantGenerations: "scopeKey",
  assistantProposals: "proposalId, scenarioId, status",
  assistantReceipts: "receiptId, scenarioId, proposalId, commitId",
  optimizeBases: "basisId, scenarioId, [scenarioId+documentRevision], expiresAt",
  repositoryMeta: "key",
};

/** Verbatim transcript of the assistant stores added in version 4 (T04). */
export const SHIPPED_V4_ASSISTANT_STORES: Readonly<Record<string, string>> = {
  assistantSettings: "key",
  assistantThreads: "threadId, scenarioId, state, [scenarioId+state]",
  assistantTurns: "turnId, threadId, scenarioId, state",
  assistantMessages: "messageId, threadId, [threadId+seq], turnId",
};

/** Verbatim transcript of the diagnostic store added in the same version 4 (T10). */
export const SHIPPED_V4_DIAGNOSTIC_STORES: Readonly<Record<string, string>> = {
  diagnosticSearches:
    "searchId, scenarioId, threadId, turnEpoch, parent.basisId, status, expiresAt",
};

/**
 * Open `dbName` at the historical v1 + v2 + v4 declaration.
 *
 * The caller closes it: two live Dexie connections to one database would let a write
 * land after a later reader's snapshot.
 */
export async function openShippedV4Database(dbName: string): Promise<Dexie> {
  const db = new Dexie(dbName);
  db.version(1).stores({ keyval: "key" });
  db.version(2).stores({ ...SHIPPED_V4_V2_STORES });
  db.version(4).stores({ ...SHIPPED_V4_ASSISTANT_STORES });
  db.version(4).stores({ ...SHIPPED_V4_DIAGNOSTIC_STORES });
  await db.open();
  if (db.verno !== 4) {
    throw new Error(`seeded database must really be at version 4, got ${db.verno}`);
  }
  return db;
}

/**
 * One full row for every v4 table, with values on every indexed path.
 *
 * Indexed values are deliberately non-trivial -- compound keys, a unique key, an
 * auto-incremented key, a nested `parent.basisId` -- because an upgrade that quietly
 * rebuilt a store would most likely lose exactly those.
 */
export const SHIPPED_V4_ROWS: ShippedV4RowMap = {
  keyval: {
    key: "legacy-key",
    value: { scenario: createEmptyScenarioUiState(), backupFingerprint: "fingerprint-legacy" },
  },
  scenarioEnvelopes: {
    scenarioId: "scenario-1",
    schemaVersion: 3,
    documentRevision: 7,
    recordRevision: 11,
    acceptedLeaseEpoch: 2,
    topCommitId: "commit-9",
    historySessionId: "session-a",
    historyCursor: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    // A REAL scenario value, built by the product's own constructor. The previous
    // `{} as ...` satisfied the compiler while proving nothing: an upgrade that dropped
    // or rewrote the nested content would have passed against an empty cast.
    scenario: createEmptyScenarioUiState(),
    backupFingerprint: "fingerprint-legacy",
  },
  tabSelections: {
    tabId: "tab-1",
    scenarioId: "scenario-1",
    selectedAt: "2026-08-01T00:00:00.000Z",
  },
  writerLeases: {
    scenarioId: "scenario-1",
    ownerTabId: "tab-1",
    epoch: 4,
    heartbeatAt: "2026-08-02T00:00:00.000Z",
    expiresAt: "2026-08-03T00:00:00.000Z",
  },
  scenarioCommits: {
    commitId: "commit-9",
    scenarioId: "scenario-1",
    parentCommitId: "commit-8",
    documentRevision: 7,
    historySessionId: "session-a",
    sessionSeq: 3,
    kind: "manual",
    isContent: true,
    commandDigest: "sha256:legacy-command-digest",
    reversiblePayload: null,
    payloadState: "live",
    supersededAt: null,
    idempotencyKey: "idem-9",
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  historyLinks: {
    seq: 1,
    scenarioId: "scenario-1",
    historySessionId: "session-a",
    kind: "undo",
    sourceCommitId: "commit-8",
    linkCommitId: "commit-9",
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  assistantGenerations: {
    scopeKey: "scenario:scenario-1",
    generation: 3,
    clearedAt: "2026-08-02T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  assistantProposals: {
    proposalId: "proposal-1",
    schemaVersion: 1,
    commandSchemaVersion: 1,
    revision: 1,
    scenarioId: "scenario-1",
    threadId: "thread-1",
    turnId: "turn-1",
    baseDocumentRevision: 7,
    baseCommitId: "commit-8",
    leaseEpoch: 4,
    registryStamp: { appBuildVersion: "0.1.1", manifestSha256: "sha256:legacy-manifest" },
    commands: [],
    commandsDigest: "sha256:legacy-commands-digest",
    rationale: "Shift nurse A to cover the Tuesday gap.",
    evidence: [{ kind: "user_statement", label: "Unavailable Tuesday", reference: null }],
    outcome: "untested",
    diff: { direct: [], cascade: [], capabilityIds: [], needsReview: [] },
    assumptions: [],
    confirmations: [],
    status: "applied",
    globalGeneration: 0,
    scenarioGeneration: 3,
    appliedCommitId: "commit-9",
    receiptId: "receipt-1",
    idempotencyKey: "idem-9",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  assistantReceipts: {
    receiptId: "receipt-1",
    schemaVersion: 1,
    proposalId: "proposal-1",
    proposalRevision: 1,
    scenarioId: "scenario-1",
    commitId: "commit-9",
    documentRevision: 7,
    historySessionId: "session-a",
    idempotencyKey: "idem-9",
    commandDigest: "sha256:legacy-command-digest",
    confirmationDigest: "sha256:legacy-confirmation",
    registryStamp: { appBuildVersion: "0.1.1", manifestSha256: "sha256:legacy-manifest" },
    summary: [],
    capabilityIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  optimizeBases: {
    basisId: "basis-1",
    scenarioId: "scenario-1",
    documentRevision: 7,
    schemaVersion: 1,
    submissionDigest: "a".repeat(64),
    semanticBasisDigest: "sha256:legacy-semantic-basis",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
  },
  repositoryMeta: {
    key: "legacyScenarioMigration",
    state: "complete",
    scenarioId: "scenario-1",
    sourceKey: "legacy-key",
    attempts: 1,
    reason: null,
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:00:00.000Z",
  },
  assistantSettings: {
    key: "local",
    enabled: true,
    apiKey: "sk-or-LEGACY-0001",
    modelId: "vendor/model",
    modelSource: "catalog",
    probedAt: "2026-08-01T00:00:00.000Z",
    schemaVersion: 1,
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  assistantThreads: {
    threadId: "thread-1",
    scenarioId: "scenario-1",
    state: "active",
    schemaVersion: 1,
    globalGeneration: 0,
    scenarioGeneration: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  assistantTurns: {
    turnId: "turn-1",
    threadId: "thread-1",
    scenarioId: "scenario-1",
    state: "terminal",
    terminalReason: "completed",
    interruptionTrigger: null,
    basisDocumentRevision: 7,
    leaseEpoch: 4,
    modelId: "vendor/model",
    runId: "run-1",
    turnEpoch: 2,
    runtimeInstanceId: "instance-1",
    globalGeneration: 0,
    scenarioGeneration: 3,
    schemaVersion: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  assistantMessages: {
    messageId: "message-1",
    threadId: "thread-1",
    seq: 0,
    turnId: "turn-1",
    role: "user",
    content: "legacy question",
    toolCalls: null,
    toolCallId: null,
    modelId: null,
    schemaVersion: 1,
    scenarioId: "scenario-1",
    globalGeneration: 0,
    scenarioGeneration: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  diagnosticSearches: {
    searchId: "search-1",
    scenarioId: "scenario-1",
    threadId: "thread-1",
    turnId: "turn-1",
    parent: { basisId: "basis-1", jobId: "job-1", scenarioId: "scenario-1", documentRevision: 7 },
    parentOutcome: "infeasible",
    turnEpoch: 2,
    leaseEpoch: 4,
    globalGeneration: 0,
    scenarioGeneration: 3,
    compare: false,
    candidateTimeoutSeconds: 30,
    maxCandidates: 5,
    status: "completed",
    candidates: [],
    stopReason: "first_feasible",
    failureReason: null,
    schemaVersion: 1,
    expiresAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  },
};
