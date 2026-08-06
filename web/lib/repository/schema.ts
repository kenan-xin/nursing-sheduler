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
// version does not mention, so the legacy record survives the upgrade byte for
// byte. No data is moved inside the version upgrade: the legacy record is
// migrated by an explicit, idempotent, recoverable transaction (`migration.ts`)
// so an interruption is detectable rather than silently half-applied.

import { Dexie, type Table } from "dexie";
import type {
  AssistantProposalV1,
  AssistantReceiptV1,
  AssistantWriteFenceV1,
  HistoryLinkV1,
  KeyValueRow,
  OptimizeBasisRecordV2,
  RepositoryMetaRow,
  ScenarioCommitV1,
  ScenarioEnvelopeV3,
  TabWorkspaceSelectionV1,
  WriterLeaseV2,
} from "./types";

/** Default IndexedDB database name (unchanged from the shipped build). */
export const NURSE_SCHEDULER_DB_NAME = "nurse-scheduler";

/** Current declared Dexie schema version. */
export const REPOSITORY_SCHEMA_VERSION = 2;

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
  optimizeBases!: Table<OptimizeBasisRecordV2, string>;
  repositoryMeta!: Table<RepositoryMetaRow, string>;

  constructor(databaseName: string = NURSE_SCHEDULER_DB_NAME) {
    super(databaseName);

    this.version(1).stores({ keyval: "key" });

    this.version(REPOSITORY_SCHEMA_VERSION).stores({
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
  }
}

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
  "repositoryMeta",
] as const;
