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
//
// ---------------------------------------------------------------------------
// THE MERGED LADDER: why `roster` / `snapshot` / `meta` are declared in VERSION 2
// ---------------------------------------------------------------------------
//
// Two features shipped a Dexie ladder against the SAME database name. This file's
// ladder (1 keyval, 2 repository, 4 assistant + diagnostic, 5 clear) and the roster
// storage foundation's (1 keyval, 2 `roster` / `snapshot` / `meta`). Both claimed
// version 2 with DIFFERENT store sets, so whichever opened second raised
// `VersionError` and its feature failed outright. There is now exactly one ladder,
// and it is the UNION of the two, merged VERSION BY VERSION.
//
// The roster stores are therefore declared in the version 2 block -- the version
// that actually shipped them -- and NOT in the new top version. That is not a
// stylistic choice, it is the only safe one, and Dexie's own upgrade loop is why.
// `updateTablesAndIndexes` runs every declared version from the installed one
// upward, and after each it calls `deleteRemovedTables(thatVersionsCumulativeSchema)`,
// which DROPS every object store the real database has and that version's cumulative
// schema does not name. A browser sitting at the roster ladder's version 2 therefore
// walks 2 -> 4 -> 5 -> 6; had the roster stores been declared only at 6, the version
// 2 step would have deleted `roster`, `snapshot` and `meta` -- with every row in them
// -- and version 6 would then have recreated them EMPTY. The upgrade would look
// clean and would silently destroy the user's roster.
//
// Declaring them at 2 makes them present in the cumulative schema of every version
// from 2 up, so no step can drop them, whichever side's population is opening.
// `merged-schema-upgrade.test.ts` measures both arms rather than believing this.
//
// Version 6 exists so the upgrade transaction RUNS AT ALL. IndexedDB only fires
// `upgradeneeded` on a version increase, and a browser already at this ladder's
// version 5 would otherwise open unchanged and never gain the roster stores. It adds
// no store of its own: it is the merge marker, and every existing population is
// below it.
//
// The roster tables are deliberately absent from both write-table sets below. They
// are the roster feature's own transactional domain; the assistant and the fenced
// scenario write must not be able to reach them, which `lib/ai/phase-2-absence.test.ts`
// asserts against those two constants.

import { Dexie, type Table } from "dexie";
import type {
  AssistantMessageV1,
  AssistantSettingsV1,
  AssistantThreadV1,
  AssistantTurnV1,
} from "@/lib/ai/assistant/records";
import type {
  AssistantClearOperationV1,
  AssistantProposalV1,
  AssistantReceiptV1,
  AssistantWriteFenceV1,
  DiagnosticSearchRecordV1,
  HistoryLinkV1,
  KeyValueRow,
  MetaRow,
  RepositoryMetaRow,
  RosterRow,
  ScenarioCommitV1,
  ScenarioEnvelopeV3,
  SnapshotRow,
  StoredOptimizeBasisRow,
  TabWorkspaceSelectionV1,
  WriterLeaseV2,
} from "./types";

/** Default IndexedDB database name (unchanged from the shipped build). */
export const NURSE_SCHEDULER_DB_NAME = "nurse-scheduler";

/** Current declared Dexie schema version. */
export const REPOSITORY_SCHEMA_VERSION = 6;

/** Version 4 added the assistant conversation tables (T04). */
export const ASSISTANT_TABLES_VERSION = 4;

/**
 * Version 5 adds the canonical Clear operation record (T11-F1j).
 *
 * PURELY ADDITIVE, like version 4's diagnostic table: no existing store is mentioned,
 * so every prior table carries forward untouched and an existing browser gains an
 * empty table. Nothing reads the legacy per-scope markers it replaces, so a database
 * mid-clear at upgrade time fails closed -- the fence still protects the data, and the
 * user's next Clear starts a clean operation.
 */
export const CLEAR_OPERATIONS_VERSION = 5;

/** The version that introduced the scenario-repository tables. */
export const REPOSITORY_TABLES_VERSION = 2;

/** The version that introduced the T10 diagnostic-search ownership table. */
export const DIAGNOSTIC_TABLES_VERSION = 4;

/**
 * The version that introduced the roster storage tables (F1).
 *
 * TWO, not six, and the header explains why at length: Dexie deletes any store a
 * version's cumulative schema does not name, so a roster store declared above the
 * version a real browser is sitting at would be dropped on the way past it.
 */
export const ROSTER_STORAGE_TABLES_VERSION = 2;

/**
 * Version 6 merges the two ladders that both claimed version 2 for this database.
 *
 * It adds NO store. Its whole job is to be greater than every version either side
 * ever shipped, so that opening a browser from either population raises
 * `upgradeneeded` and the union schema is actually installed.
 */
export const MERGED_LADDER_VERSION = 6;

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
  /** T11 -- one canonical record per in-flight Clear operation. */
  assistantClearOperations!: Table<AssistantClearOperationV1, string>;
  /** F1 -- the working roster and each candidate roster document. */
  roster!: Table<RosterRow, string>;
  /** F1 -- immutable submission snapshots, keyed and authorized by `ownerId`. */
  snapshot!: Table<SnapshotRow, string>;
  /** F1 -- origin-wide roster counters and pointers. */
  meta!: Table<MetaRow, string>;

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
      // The ROSTER storage foundation's own version 2 (F1), merged in at the version
      // that shipped it rather than at the top of the ladder -- see the header. Out-of-line
      // primary key only: the documents are opaque to Dexie and nothing indexes into them.
      roster: "key",
      snapshot: "key",
      meta: "key",
    });

    this.version(ASSISTANT_TABLES_VERSION).stores({
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

    // Version 5 (T11-F1j) ADDS the canonical Clear operation record. Keyed by the
    // operation's own identity, because that is the thing recovery must prove it still
    // owns; `scope` is indexed only to keep the recovery sweep a scan of the few
    // operations that exist rather than of everything.
    this.version(CLEAR_OPERATIONS_VERSION).stores({
      assistantClearOperations: "operationId, scope",
    });

    // Version 6 declares NOTHING. It is the merge marker: the two ladders that both
    // claimed version 2 are now one, and a browser sitting at either side's highest
    // version needs a version INCREASE before IndexedDB will run an upgrade at all.
    // Dexie carries every prior store forward, so the cumulative schema here is the
    // full union and no store is dropped on the way up.
    this.version(MERGED_LADDER_VERSION).stores({});

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
    this.assistantClearOperations = this.table("assistantClearOperations");
    this.roster = this.table("roster");
    this.snapshot = this.table("snapshot");
    this.meta = this.table("meta");
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
 *
 * `roster` / `snapshot` / `meta` are deliberately ABSENT. They live in the same
 * database but they are the roster feature's own transactional domain, and a fenced
 * scenario write — including an assistant Apply — has no business holding a lock on
 * them, let alone writing one.
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
