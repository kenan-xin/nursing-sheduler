// The single Dexie schema declaration for the browser database (T02).
//
// There is exactly ONE `nurse-scheduler` database and exactly one place that
// declares its versions. That matters because two live consumers open it in the
// same tab: the LEGACY `persist` key/value adapter (`lib/store/dexie-storage.ts`,
// still the authority until T03 cuts over) and the transactional repository. If
// they declared different versions, whichever opened with the lower one would hit
// IndexedDB's `VersionError` — so both construct this same class.
//
// Version 1 is the shipped single `keyval` store. Version 2 ADDS the repository
// tables and leaves `keyval` untouched; Dexie carries forward every store a later
// version 2 does not mention, so the legacy record survives the upgrade byte for
// byte. No data is moved inside the version upgrade: the legacy record is
// migrated by an explicit, idempotent, recoverable transaction (`migration.ts`)
// so an interruption is detectable rather than silently half-applied.
//
// Version 3 (T04) ADDS the four assistant tables. Same reasoning as version 2:
// purely additive, no existing store mentioned, nothing moved. The assistant DTOs
// are imported TYPE-ONLY from `lib/ai/assistant/records` -- they are T04-owned
// shapes, and keeping them there lets this file remain the single place that
// declares the database's versions without the assistant's contract having to
// live inside the scenario repository's own DTO module.

import { Dexie, type Table } from "dexie";
import type {
  AssistantMessageV1,
  AssistantSettingsV1,
  AssistantThreadV1,
  AssistantTurnV1,
} from "@/lib/ai/assistant/records";
import type {
  AssistantProposalV1,
  AssistantReceiptV1,
  AssistantWriteFenceV1,
  DiagnosticSearchRecordV1,
  HistoryLinkV1,
  KeyValueRow,
  RepositoryMetaRow,
  ScenarioCommitV1,
  ScenarioEnvelopeV3,
  StoredOptimizeBasisRow,
  TabWorkspaceSelectionV1,
  WriterLeaseV2,
} from "./types";

/** Default IndexedDB database name (unchanged from the shipped build). */
export const NURSE_SCHEDULER_DB_NAME = "nurse-scheduler";

/** Current declared Dexie schema version. */
export const REPOSITORY_SCHEMA_VERSION = 4;

/** The version that introduced the scenario-repository tables. */
export const REPOSITORY_TABLES_VERSION = 2;

/** The version that introduced the T10 diagnostic-search ownership table. */
export const DIAGNOSTIC_TABLES_VERSION = 4;

/** The browser database: the legacy key/value store plus the repository tables. */
export class NurseSchedulerDb extends Dexie {
  /** LEGACY — the `persist` middleware's single serialized scenario record. */
  keyval!: Table<KeyValueRow, string>;
  scenarioEnvelopes!: Table<ScenarioEnvelopeV3, string>;
  tabSelections!: Table<TabWorkspaceSelectionV1, string>;
  writerLeases!: Table<WriterLeaseV2, string>;
  scenarioCommits!: Table<ScenarioCommitV1, string>;
  historyLinks!: Table<HistoryLinkV1, number>;
  assistantGenerations!: Table<AssistantWriteFenceV1, string>;
  assistantProposals!: Table<AssistantProposalV1, string>;
  assistantReceipts!: Table<AssistantReceiptV1, string>;
  // The DURABLE UNION, not the current record alone: this store has existed since
  // version 2 and its rows are never rewritten, so a browser that ran a pre-T08
  // build still holds `schemaVersion: 1` rows here. Declaring the table as V2 made
  // every read an unchecked cast (see `basis-row.ts`).
  optimizeBases!: Table<StoredOptimizeBasisRow, string>;
  repositoryMeta!: Table<RepositoryMetaRow, string>;
  /** T04 -- the single browser-local assistant configuration row. */
  assistantSettings!: Table<AssistantSettingsV1, string>;
  assistantThreads!: Table<AssistantThreadV1, string>;
  assistantTurns!: Table<AssistantTurnV1, string>;
  assistantMessages!: Table<AssistantMessageV1, string>;
  /** T10 -- durable ownership of one bounded infeasibility diagnostic search. */
  diagnosticSearches!: Table<DiagnosticSearchRecordV1, string>;

  constructor(databaseName: string = NURSE_SCHEDULER_DB_NAME) {
    super(databaseName);

    this.version(1).stores({ keyval: "key" });

    this.version(REPOSITORY_TABLES_VERSION).stores({
      scenarioEnvelopes: "scenarioId, updatedAt",
      tabSelections: "tabId, scenarioId",
      writerLeases: "scenarioId, ownerTabId, expiresAt",
      // The compound index is the history reader: every session walk is a range
      // scan already ordered by `sessionSeq`, so ordering is never re-derived in JS.
      // `idempotencyKey` is UNIQUE, which is what makes an Apply replay collide
      // durably rather than by convention (undefined values are simply not indexed).
      scenarioCommits:
        "commitId, scenarioId, [scenarioId+historySessionId+sessionSeq], [scenarioId+documentRevision], &idempotencyKey",
      historyLinks: "++seq, scenarioId, sourceCommitId, linkCommitId",
      assistantGenerations: "scopeKey",
      assistantProposals: "proposalId, scenarioId, status",
      assistantReceipts: "receiptId, scenarioId, proposalId, commitId",
      optimizeBases: "basisId, scenarioId, [scenarioId+documentRevision], expiresAt",
      repositoryMeta: "key",
    });

    this.version(REPOSITORY_SCHEMA_VERSION).stores({
      // One row, so no secondary index. Its key is a constant.
      assistantSettings: "key",
      // `[scenarioId+state]` is the hot read: "the ACTIVE thread for this exact
      // scenario identity", which is the scenario-bound history boundary itself.
      // `state` is indexed on its own as well as compounded: the "at most one
      // active thread" repair scans by state ALONE (it has to find an active thread
      // belonging to any other scenario), which a compound-only index cannot serve.
      assistantThreads: "threadId, scenarioId, state, [scenarioId+state]",
      assistantTurns: "turnId, threadId, scenarioId, state",
      // `[threadId+seq]` makes hydration a range scan already in `seq` order, so
      // message ordering is never re-derived in JS from timestamps.
      assistantMessages: "messageId, threadId, [threadId+seq], turnId",
    });

    // Version 4 (T10) ADDS the diagnostic-search ownership table. Purely additive:
    // no existing store is mentioned, so every prior table carries forward
    // unchanged. The indices serve the hot reads: by scenario for the current
    // search, by parent basis for recovery, by status for the open-search sweep,
    // and by expiry for the reaper.
    this.version(DIAGNOSTIC_TABLES_VERSION).stores({
      diagnosticSearches:
        "searchId, scenarioId, threadId, turnEpoch, parent.basisId, status, expiresAt",
    });

    this.keyval = this.table("keyval");
    this.scenarioEnvelopes = this.table("scenarioEnvelopes");
    this.tabSelections = this.table("tabSelections");
    this.writerLeases = this.table("writerLeases");
    this.scenarioCommits = this.table("scenarioCommits");
    this.historyLinks = this.table("historyLinks");
    this.assistantGenerations = this.table("assistantGenerations");
    this.assistantProposals = this.table("assistantProposals");
    this.assistantReceipts = this.table("assistantReceipts");
    this.optimizeBases = this.table("optimizeBases");
    this.repositoryMeta = this.table("repositoryMeta");
    this.assistantSettings = this.table("assistantSettings");
    this.assistantThreads = this.table("assistantThreads");
    this.assistantTurns = this.table("assistantTurns");
    this.assistantMessages = this.table("assistantMessages");
    this.diagnosticSearches = this.table("diagnosticSearches");
  }
}

/**
 * The tables an assistant history write may touch. Passed to `db.transaction` so
 * appending a message, advancing its turn, and reading the thread it belongs to
 * genuinely share one IndexedDB transaction -- which is what lets a `seq` be
 * allocated without two concurrent appends colliding on it.
 */
export const ASSISTANT_WRITE_TABLES = [
  "assistantThreads",
  "assistantTurns",
  "assistantMessages",
  "assistantGenerations",
] as const;

/**
 * The tables a fenced scenario write may touch. Passed to `db.transaction` so a
 * commit, its history bookkeeping, and its receipt genuinely share one IndexedDB
 * transaction — a partial write is impossible, not merely unlikely.
 */
export const SCENARIO_WRITE_TABLES = [
  "scenarioEnvelopes",
  "tabSelections",
  "writerLeases",
  "scenarioCommits",
  "historyLinks",
  "assistantGenerations",
  "assistantProposals",
  "assistantReceipts",
  "optimizeBases",
  "diagnosticSearches",
  "repositoryMeta",
] as const;
