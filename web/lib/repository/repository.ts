// The transactional per-scenario repository (T02, tech-plan "Transactional
// scenario repository and single writer").
//
// WHAT THIS REPLACES, AND WHY. The shipped durable path is Zustand `persist`
// write-behind: it cannot report a failed durable write back to the action that
// caused it, and its revision guard is process-local to one tab, so a second tab
// can silently overwrite the first. Here, every durable change is one IndexedDB
// transaction that verifies ownership and revision BEFORE it writes and returns
// the committed identity to its caller.
//
// T02 SCOPE. Nothing here is wired into a component. The legacy store remains the
// live projection AND the live persistence path; T03 performs the cutover. What
// T02 delivers is the durable authority, its fences, and its contract tests.
//
// THE INVARIANTS, stated once:
//   1. `documentRevision` moves only for content commits, and never backwards.
//      Undo and Redo are new commits with new revisions, not a rewind.
//   2. `recordRevision` moves for every envelope write, so a metadata-only write
//      is observable without staling a content-bound Preview.
//   3. A write is accepted only from the tab holding the scenario's lease at the
//      exact epoch it presents, and only against the revision it actually read.
//   4. Leases are per SCENARIO. A tab editing scenario A never blocks scenario B.
//   5. Commits are append-only facts. Bounding history removes reversal PAYLOADS;
//      the commits, links, and receipts survive.
//   6. Assistant generations are permanent monotonic fences.
//
// TRANSACTION DISCIPLINE. Every method performs all reads and writes inside one
// `db.transaction` and awaits only Dexie promises inside it — awaiting a foreign
// promise would leave Dexie's transaction zone and commit the transaction early.
// The clock and id minter are injected for exactly this reason: they must be
// synchronous, and tests must be able to make expiry deterministic.

import {
  applyScenarioCommand,
  isContentCommand,
  isSemanticNoOpCommand,
  type ScenarioCommandV1,
} from "./commands";
import { commandDigest } from "./digest";
import { RepositoryError } from "./errors";
import { assertGenerationsUnchanged, ensureGeneration, generationScopesFor } from "./generations";
import {
  contentCommits,
  describeHistory as deriveHistory,
  type HistoryAvailability,
  HISTORY_LIMIT,
  nextSessionSeq,
  pruneSessionPayloads,
  readSessionCommits,
} from "./history";
import { assertLeaseOwnership, isLeaseLive, LEASE_TTL_MS, renewedLease } from "./leases";
import { assertValidScenarioSnapshot } from "./validate";
import { NurseSchedulerDb, SCENARIO_WRITE_TABLES } from "./schema";
import {
  type AssistantProposalV1,
  type AssistantReceiptV1,
  type CapturedGeneration,
  GLOBAL_GENERATION_SCOPE,
  type GenerationScopeKey,
  type LeaseOwner,
  type LeaseResult,
  type OptimizeBasisRecordV2,
  type StoredOptimizeBasisRow,
  type ScenarioCommitKind,
  type ScenarioCommitV1,
  type ScenarioEnvelopeV3,
  type ScenarioSnapshot,
  scenarioGenerationScope,
  type TabWorkspaceSelectionV1,
  type WriterLeaseV2,
} from "./types";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ScenarioRepositoryConfig {
  db: NurseSchedulerDb;
  /** Synchronous clock. Injected so lease expiry is deterministic under test. */
  now?: () => Date;
  /** Synchronous id minter. Injected so commit identities are reproducible. */
  newId?: () => string;
  leaseTtlMs?: number;
  historyLimit?: number;
}

/** What a tab must reread after reload, BFCache restore, or a long suspension. */
export interface TabContext {
  selection: TabWorkspaceSelectionV1 | null;
  envelope: ScenarioEnvelopeV3 | null;
  lease: WriterLeaseV2 | null;
  /** True only when a LIVE lease on the selected scenario names this tab. */
  isOwner: boolean;
  owner: LeaseOwner | null;
  history: HistoryAvailability | null;
}

export type ScenarioSwitchTarget =
  /** Select an existing local identity. */
  | { kind: "existing"; scenarioId: string }
  /** Mint a fresh identity holding an empty scenario. */
  | { kind: "new"; apiVersion?: string }
  /**
   * Mint a fresh identity holding imported content. Load ALWAYS mints a new
   * identity even when the bytes match a prior document, so a restored file can
   * never inherit another document's history, receipts, or threads.
   */
  | { kind: "load"; scenario: ScenarioUiState };

export interface ScenarioSwitch {
  tabId: string;
  target: ScenarioSwitchTarget;
  /**
   * The lease this tab currently holds, if any. Validated FIRST: a switch by a
   * tab that has already been taken over must change nothing.
   */
  currentOwner?: LeaseOwner;
  /** Acquire the target's lease as part of the switch. Defaults to `true`. */
  acquire?: boolean;
  /**
   * Start a fresh Undo session as part of the (fenced) acquisition. Only honoured
   * when the switch actually acquires — a read-only selection has no authority to
   * expire anybody's reversal material.
   */
  rollHistorySession?: boolean;
}

export interface ScenarioSelection {
  selection: TabWorkspaceSelectionV1;
  envelope: ScenarioEnvelopeV3;
  lease: WriterLeaseV2 | null;
  owner: LeaseOwner | null;
  /**
   * The durable fact recording the switch (or the target's genesis commit), or
   * `null` when the selection acquired nothing — a read-only tab selecting a
   * scenario writes no scenario-scoped fact at all.
   */
  commit: ScenarioCommitV1 | null;
}

export interface CommitInput {
  owner: LeaseOwner;
  expectedScenarioId: string;
  expectedDocumentRevision: number;
  command: ScenarioCommandV1;
  kind?: Extract<ScenarioCommitKind, "manual" | "load" | "assistant_apply">;
  /**
   * Makes a retry safe: the same key returns the original committed result, and
   * the same key with DIFFERENT input fails closed rather than committing twice.
   */
  idempotencyKey?: string;
  /** Assistant generations captured before the operation started (T05 adopts this). */
  guardGenerations?: readonly CapturedGeneration[];
  /** Written in the SAME transaction as the commit — never as a follow-up write. */
  receipt?: Omit<AssistantReceiptV1, "commitId" | "documentRevision" | "historySessionId">;
  /** Proposal status transition to apply atomically with the commit. */
  proposalUpdate?: { proposalId: string; status: AssistantProposalV1["status"] };
}

export interface CommitResult {
  envelope: ScenarioEnvelopeV3;
  /** `null` for a metadata-only command, which writes no commit fact. */
  commit: ScenarioCommitV1 | null;
  history: HistoryAvailability;
  /** True when an idempotency key replayed an already-committed result. */
  replayed: boolean;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ScenarioRepository {
  read(scenarioId: string): Promise<ScenarioEnvelopeV3>;
  /** Reread everything a tab must not trust process memory for. */
  readTabContext(tabId: string): Promise<TabContext>;
  /**
   * Start a fresh Undo session for a scenario this owner already holds. Prior
   * reversal payloads are invalidated; commits, links, and receipts are kept.
   *
   * FENCED on the exact owner. Prefer `rollHistorySession` on
   * acquisition/switch, which rolls inside the transaction that earned the lease.
   */
  beginHistorySession(owner: LeaseOwner): Promise<ScenarioEnvelopeV3>;
  selectOrSwitchScenario(input: ScenarioSwitch): Promise<ScenarioSelection>;
  acquireOrTakeover(input: {
    scenarioId: string;
    tabId: string;
    mode?: "acquire" | "takeover";
    /** Roll the Undo session inside this same fenced transaction. */
    rollHistorySession?: boolean;
  }): Promise<LeaseResult>;
  heartbeat(owner: LeaseOwner): Promise<LeaseResult>;
  release(owner: LeaseOwner): Promise<void>;
  commit(input: CommitInput): Promise<CommitResult>;
  undo(input: { owner: LeaseOwner; expectedDocumentRevision: number }): Promise<CommitResult>;
  redo(input: { owner: LeaseOwner; expectedDocumentRevision: number }): Promise<CommitResult>;
  describeHistory(scenarioId: string): Promise<HistoryAvailability>;
  /** Capture the global + per-scenario fences before an interruptible operation. */
  captureGenerations(scenarioId: string): Promise<CapturedGeneration[]>;
  /** Bump a fence. Monotonic and permanent: nothing ever deletes or lowers it. */
  bumpGeneration(scopeKey: GenerationScopeKey): Promise<number>;
  /**
   * Delete assistant CONTENT for a scope and bump its fence in one transaction.
   * The fence rows themselves are never deleted — that is what stops a detached
   * late callback from recreating what was just cleared.
   */
  clearAssistantContent(input: { scenarioId?: string }): Promise<{ generation: number }>;
  /** Run `body` in a fenced write transaction (the guard T05 callbacks adopt). */
  runGuarded<T>(
    captured: readonly CapturedGeneration[],
    body: (db: NurseSchedulerDb) => Promise<T>,
  ): Promise<T>;
  putProposal(proposal: AssistantProposalV1): Promise<void>;
  getProposal(proposalId: string): Promise<AssistantProposalV1 | undefined>;
  getReceipt(receiptId: string): Promise<AssistantReceiptV1 | undefined>;
  /** Only a CURRENT record may be written; legacy rows are read-only history. */
  putOptimizeBasis(basis: OptimizeBasisRecordV2): Promise<void>;
  /** Returns the durable union — a pre-T08 browser still holds schema-V1 rows. */
  getOptimizeBasis(basisId: string): Promise<StoredOptimizeBasisRow | undefined>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT = (apiVersion?: string): ScenarioSnapshot => ({
  scenario: createEmptyScenarioUiState(apiVersion),
  backupFingerprint: null,
});

export function createScenarioRepository(config: ScenarioRepositoryConfig): ScenarioRepository {
  const { db } = config;
  const now = config.now ?? (() => new Date());
  const newId = config.newId ?? (() => crypto.randomUUID());
  const leaseTtlMs = config.leaseTtlMs ?? LEASE_TTL_MS;
  const historyLimit = config.historyLimit ?? HISTORY_LIMIT;

  /** Read an envelope or fail closed — never silently create one. */
  async function requireEnvelope(scenarioId: string): Promise<ScenarioEnvelopeV3> {
    const envelope = await db.scenarioEnvelopes.get(scenarioId);
    if (!envelope) {
      throw new RepositoryError("scenario_not_found", "no envelope exists for this scenario", {
        scenarioId,
      });
    }
    return envelope;
  }

  /** Mint an envelope plus its non-content genesis commit inside a transaction. */
  async function createEnvelope(
    snapshot: ScenarioSnapshot,
    kind: Extract<ScenarioCommitKind, "new" | "load" | "migrate">,
    at: Date,
  ): Promise<{ envelope: ScenarioEnvelopeV3; commit: ScenarioCommitV1 }> {
    const scenarioId = newId();
    const commitId = newId();
    const historySessionId = newId();
    const iso = at.toISOString();

    // The genesis commit is a durable FACT but not a cursor entry: a brand-new or
    // freshly-migrated scenario must offer nothing to undo, and the prior workspace
    // of a Load lives under its own prior identity, not in this one's history.
    const commit: ScenarioCommitV1 = {
      commitId,
      scenarioId,
      parentCommitId: null,
      documentRevision: 1,
      historySessionId,
      sessionSeq: 0,
      kind,
      isContent: false,
      commandDigest: commandDigest({ kind, scenarioId }),
      reversiblePayload: null,
      payloadState: "live",
      supersededAt: null,
      createdAt: iso,
    };
    const envelope: ScenarioEnvelopeV3 = {
      scenarioId,
      schemaVersion: 3,
      documentRevision: 1,
      recordRevision: 1,
      acceptedLeaseEpoch: 0,
      topCommitId: commitId,
      historySessionId,
      historyCursor: 0,
      scenario: snapshot.scenario,
      backupFingerprint: snapshot.backupFingerprint,
      createdAt: iso,
      updatedAt: iso,
    };
    await db.scenarioCommits.put(commit);
    await db.scenarioEnvelopes.put(envelope);
    // Mint both fences up front so a later capture cannot race their creation.
    for (const scopeKey of generationScopesFor(scenarioId)) {
      await ensureGeneration(db, scopeKey, at);
    }
    return { envelope, commit };
  }

  /**
   * Take (or renew, or seize) the lease on a scenario. `acquire` refuses a live
   * lease held by another tab; `takeover` always wins and increments the epoch
   * immediately, without waiting for the old tab to cooperate — a frozen tab would
   * never cooperate, and that is the case takeover exists for.
   */
  async function acquireLeaseInTx(
    envelope: ScenarioEnvelopeV3,
    tabId: string,
    mode: "acquire" | "takeover",
    at: Date,
  ): Promise<{ lease: WriterLeaseV2; tookOver: boolean }> {
    const scenarioId = envelope.scenarioId;
    const existing = await db.writerLeases.get(scenarioId);
    const live = isLeaseLive(existing, at);
    const heldByOther = live && existing.ownerTabId !== tabId;

    if (heldByOther && mode === "acquire") {
      throw new RepositoryError("target_owned", "another tab holds a live lease on this scenario", {
        scenarioId,
        heldBy: existing.ownerTabId,
        expiresAt: existing.expiresAt,
      });
    }

    // Renewing your own live lease keeps the epoch, so an in-flight operation that
    // captured it stays valid. Every other path bumps, which is what fences the
    // previous holder — including a lease that merely expired.
    const renewInPlace = live && existing.ownerTabId === tabId;
    // THE EPOCH IS A FENCING TOKEN, so it must never repeat within a scenario's
    // lifetime. Deriving it from the lease row alone did repeat: a clean release
    // DELETES that row, so epoch 1 → takeover 2 → release → reacquire handed out
    // epoch 1 again, and an epoch-1 callback the takeover had already fenced became
    // valid a second time whenever the document revision had not moved.
    //
    // `acceptedLeaseEpoch` is the durable high-water mark: it lives on the envelope,
    // survives every lease deletion, and (below) only ever rises. Taking the max of
    // the two is what makes the next epoch strictly greater than every epoch this
    // scenario has ever issued.
    const highWater = Math.max(existing?.epoch ?? 0, envelope.acceptedLeaseEpoch);
    const epoch = renewInPlace ? existing.epoch : highWater + 1;
    const lease = renewedLease({ scenarioId, ownerTabId: tabId, epoch }, at, leaseTtlMs);
    await db.writerLeases.put(lease);
    return { lease, tookOver: !renewInPlace && existing !== undefined };
  }

  /**
   * Persist the envelope's acceptance of a lease epoch (a metadata-only write).
   *
   * MONOTONIC BY CONSTRUCTION: it raises the accepted epoch and never lowers it.
   * Lowering was the other half of the epoch-rewind defect — it reopened the door
   * for a superseded owner even after the lease itself had moved on, because
   * `assertLeaseOwnership` compares the presented epoch against this field.
   */
  async function acceptLeaseEpoch(
    envelope: ScenarioEnvelopeV3,
    epoch: number,
    at: Date,
  ): Promise<ScenarioEnvelopeV3> {
    if (envelope.acceptedLeaseEpoch >= epoch) return envelope;
    const next: ScenarioEnvelopeV3 = {
      ...envelope,
      acceptedLeaseEpoch: epoch,
      recordRevision: envelope.recordRevision + 1,
      updatedAt: at.toISOString(),
    };
    await db.scenarioEnvelopes.put(next);
    return next;
  }

  /** The shared write body for `commit`, `undo`, and `redo`. */
  async function writeContentCommit(input: {
    envelope: ScenarioEnvelopeV3;
    next: ScenarioSnapshot;
    kind: ScenarioCommitKind;
    isContent: boolean;
    commandDigestValue: string;
    idempotencyKey?: string;
    at: Date;
    sessionCommits: readonly ScenarioCommitV1[];
  }): Promise<{ envelope: ScenarioEnvelopeV3; commit: ScenarioCommitV1 }> {
    const { envelope, next, kind, isContent, at, sessionCommits } = input;
    const iso = at.toISOString();
    const before: ScenarioSnapshot = {
      scenario: envelope.scenario,
      backupFingerprint: envelope.backupFingerprint,
    };

    let content = contentCommits(sessionCommits);
    if (isContent && envelope.historyCursor < content.length) {
      // Committing while undone branches history. The superseded commits stay as
      // durable facts (a receipt may still reference one); they simply leave the
      // cursor list, which is what makes Redo unavailable after a new edit.
      //
      // Their PAYLOADS go, though. A superseded commit can never be undone or
      // redone again — it is off the cursor list for good — so retaining its
      // before/after snapshots keeps two full scenario documents alive per branch,
      // outside the session bound (which only counts live entries). Undo→edit cycles
      // therefore grew storage without limit. Dropping the payload while keeping the
      // fact is exactly the `pruned` contract: "this happened, and it can no longer
      // be reversed".
      for (const superseded of content.slice(envelope.historyCursor)) {
        await db.scenarioCommits.update(superseded.commitId, {
          supersededAt: iso,
          reversiblePayload: null,
          payloadState: "pruned",
        });
      }
      content = content.slice(0, envelope.historyCursor);
    }

    const commit: ScenarioCommitV1 = {
      commitId: newId(),
      scenarioId: envelope.scenarioId,
      parentCommitId: envelope.topCommitId,
      documentRevision: envelope.documentRevision + 1,
      historySessionId: envelope.historySessionId,
      sessionSeq: nextSessionSeq(sessionCommits),
      kind,
      isContent,
      commandDigest: input.commandDigestValue,
      // Only a CURSOR ENTRY carries reversal material. An Undo/Redo commit is
      // navigation: nothing reverses it (the cursor moves instead), so a payload on
      // it is a full scenario document retained for no reader — and, since pruning
      // only walks content commits, one that nothing would ever bound. Repeated
      // Undo/Redo was the unbounded case this closes.
      reversiblePayload: isContent ? { before, after: next } : null,
      payloadState: "live",
      supersededAt: null,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      createdAt: iso,
    };
    await db.scenarioCommits.put(commit);

    const nextEnvelope: ScenarioEnvelopeV3 = {
      ...envelope,
      documentRevision: commit.documentRevision,
      recordRevision: envelope.recordRevision + 1,
      topCommitId: commit.commitId,
      historyCursor: isContent ? content.length + 1 : envelope.historyCursor,
      scenario: next.scenario,
      backupFingerprint: next.backupFingerprint,
      updatedAt: iso,
    };
    await db.scenarioEnvelopes.put(nextEnvelope);

    if (isContent) {
      await pruneSessionPayloads(db, [...content, commit], historyLimit);
    }
    return { envelope: nextEnvelope, commit };
  }

  /**
   * Start a fresh history session for an envelope the CALLER HAS ALREADY FENCED.
   *
   * Private on purpose: rolling the session invalidates every surviving reversal
   * payload, which is destructive enough that it must never run as an unfenced
   * write. Every caller reaches it from inside a transaction that has already
   * asserted the acting owner.
   */
  async function rollHistorySessionInTx(
    envelope: ScenarioEnvelopeV3,
    at: Date,
  ): Promise<ScenarioEnvelopeV3> {
    // Invalidate every surviving reversal payload for this scenario. The commit
    // rows, their history links, and every receipt remain: "you can no longer undo
    // this" must never be recorded as "this never happened".
    const stale = await db.scenarioCommits
      .where("scenarioId")
      .equals(envelope.scenarioId)
      .filter((commit) => commit.payloadState === "live" && commit.reversiblePayload !== null)
      .toArray();
    for (const commit of stale) {
      await db.scenarioCommits.update(commit.commitId, {
        reversiblePayload: null,
        payloadState: "expired-session",
      });
    }
    const next: ScenarioEnvelopeV3 = {
      ...envelope,
      historySessionId: newId(),
      historyCursor: 0,
      recordRevision: envelope.recordRevision + 1,
      updatedAt: at.toISOString(),
    };
    await db.scenarioEnvelopes.put(next);
    return next;
  }

  /** Recompute availability after a write, from the freshly persisted facts. */
  async function historyOf(envelope: ScenarioEnvelopeV3): Promise<HistoryAvailability> {
    const commits = await readSessionCommits(db, envelope.scenarioId, envelope.historySessionId);
    return deriveHistory(commits, envelope.historyCursor);
  }

  return {
    async read(scenarioId) {
      return db.transaction("r", db.scenarioEnvelopes, () => requireEnvelope(scenarioId));
    },

    async readTabContext(tabId) {
      return db.transaction(
        "r",
        [db.tabSelections, db.scenarioEnvelopes, db.writerLeases, db.scenarioCommits],
        async (): Promise<TabContext> => {
          const at = now();
          const selection = (await db.tabSelections.get(tabId)) ?? null;
          if (!selection) {
            return {
              selection: null,
              envelope: null,
              lease: null,
              isOwner: false,
              owner: null,
              history: null,
            };
          }
          const envelope = (await db.scenarioEnvelopes.get(selection.scenarioId)) ?? null;
          const lease = (await db.writerLeases.get(selection.scenarioId)) ?? null;
          // Ownership is asserted from PERSISTED state at this instant, never from
          // "this tab was the owner before the reload". A missing envelope or a
          // lease that expired or moved leaves the tab read-only until it
          // explicitly reselects or takes over.
          const isOwner =
            envelope !== null &&
            lease !== null &&
            isLeaseLive(lease, at) &&
            lease.ownerTabId === tabId &&
            envelope.acceptedLeaseEpoch <= lease.epoch;
          const history = envelope
            ? deriveHistory(
                await readSessionCommits(db, envelope.scenarioId, envelope.historySessionId),
                envelope.historyCursor,
              )
            : null;
          return {
            selection,
            envelope,
            lease,
            isOwner,
            owner:
              isOwner && lease
                ? { scenarioId: selection.scenarioId, tabId, epoch: lease.epoch }
                : null,
            history,
          };
        },
      );
    },

    async beginHistorySession(owner) {
      return db.transaction(
        "rw",
        [db.scenarioEnvelopes, db.scenarioCommits, db.writerLeases],
        async () => {
          const at = now();
          const envelope = await requireEnvelope(owner.scenarioId);
          const lease = await db.writerLeases.get(owner.scenarioId);
          // FENCED, and by the EXACT owner. Rolling the session expires every
          // reversal payload, so a stale continuation reaching this unfenced could
          // destroy the reversal material of a newer owner that had already taken
          // over. Prefer the `rollHistorySession` option on acquisition/switch, which
          // does this in the same transaction that earned the lease; this entry point
          // exists for the callers that legitimately roll a session they already own.
          assertLeaseOwnership(lease, envelope, owner, at);
          return rollHistorySessionInTx(envelope, at);
        },
      );
    },

    async selectOrSwitchScenario(input) {
      // ONE transaction covers: validate the old owner, create/select the target,
      // acquire it, record the switch, update the selection, release the old lease.
      // Any failure aborts every one of those — so a refused target leaves the
      // selection, BOTH envelopes, and the old lease exactly as they were.
      return db.transaction("rw", SCENARIO_WRITE_TABLES, async (): Promise<ScenarioSelection> => {
        const at = now();
        const acquire = input.acquire ?? true;

        // Step 1 — the old owner is validated BEFORE anything is created, so a tab
        // that has already been taken over cannot switch anything, anywhere.
        if (input.currentOwner) {
          const oldEnvelope = await requireEnvelope(input.currentOwner.scenarioId);
          const oldLease = await db.writerLeases.get(input.currentOwner.scenarioId);
          assertLeaseOwnership(oldLease, oldEnvelope, input.currentOwner, at);
        }

        // Step 2 — resolve or mint the target.
        let envelope: ScenarioEnvelopeV3;
        let commit: ScenarioCommitV1 | null = null;
        /** Built after acquisition, so a read-only selection writes no scenario fact. */
        let pendingSwitchFact: ScenarioCommitV1 | null = null;
        if (input.target.kind === "existing") {
          envelope = await requireEnvelope(input.target.scenarioId);
          // NOT written yet. A non-acquiring selection is a read-only tab pointing at
          // a scenario it may not write — appending a scenario-scoped `switch` commit
          // there had the non-owner mutating commit history, and because the
          // envelope's `topCommitId`/`recordRevision` were left alone the fact was
          // orphaned from the chain as well. The write moves below the acquisition,
          // so the owner's switch fact and its envelope linkage land together.
          pendingSwitchFact = {
            commitId: newId(),
            scenarioId: envelope.scenarioId,
            parentCommitId: envelope.topCommitId,
            documentRevision: envelope.documentRevision,
            historySessionId: envelope.historySessionId,
            sessionSeq: nextSessionSeq(
              await readSessionCommits(db, envelope.scenarioId, envelope.historySessionId),
            ),
            kind: "switch",
            // A switch changes no content, so it advances `recordRevision` only and
            // is not a cursor entry: selecting a scenario must never become an
            // undoable edit of it.
            isContent: false,
            commandDigest: commandDigest({ kind: "switch", tabId: input.tabId }),
            reversiblePayload: null,
            payloadState: "live",
            supersededAt: null,
            createdAt: at.toISOString(),
          };
        } else {
          const snapshot =
            input.target.kind === "new"
              ? EMPTY_SNAPSHOT(input.target.apiVersion)
              : // A loaded file is not a fresh local backup, so the fingerprint is
                // `null` (unknown) — matching the shipped Load contract exactly.
                { scenario: input.target.scenario, backupFingerprint: null };
          const created = await createEnvelope(snapshot, input.target.kind, at);
          envelope = created.envelope;
          commit = created.commit;
        }

        // Step 3 — acquire the target. A live foreign owner throws here, which
        // aborts the transaction and unwinds everything above, including a
        // just-minted envelope.
        let lease: WriterLeaseV2 | null = null;
        let owner: LeaseOwner | null = null;
        if (acquire) {
          const acquired = await acquireLeaseInTx(envelope, input.tabId, "acquire", at);
          lease = acquired.lease;
          owner = { scenarioId: envelope.scenarioId, tabId: input.tabId, epoch: lease.epoch };
          envelope = await acceptLeaseEpoch(envelope, lease.epoch, at);
          // The switch fact is an OWNER's fact, and it is linked into the chain in the
          // same transaction that earned the lease — no orphaned commit rows.
          if (pendingSwitchFact) {
            commit = pendingSwitchFact;
            await db.scenarioCommits.put(commit);
            envelope = {
              ...envelope,
              topCommitId: commit.commitId,
              recordRevision: envelope.recordRevision + 1,
              updatedAt: at.toISOString(),
            };
            await db.scenarioEnvelopes.put(envelope);
          }
          if (input.rollHistorySession) {
            envelope = await rollHistorySessionInTx(envelope, at);
          }
        }

        // Step 4 — record the tab's selection.
        const selection: TabWorkspaceSelectionV1 = {
          tabId: input.tabId,
          scenarioId: envelope.scenarioId,
          selectedAt: at.toISOString(),
        };
        await db.tabSelections.put(selection);

        // Step 5 — release the old lease LAST, and only when the switch actually
        // moved to a different scenario (a re-select of the same one just renewed).
        if (input.currentOwner && input.currentOwner.scenarioId !== envelope.scenarioId) {
          await db.writerLeases.delete(input.currentOwner.scenarioId);
        }

        return { selection, envelope, lease, owner, commit };
      });
    },

    async acquireOrTakeover({ scenarioId, tabId, mode = "acquire", rollHistorySession = false }) {
      return db.transaction(
        "rw",
        [db.scenarioEnvelopes, db.writerLeases, db.scenarioCommits, db.assistantGenerations],
        async (): Promise<LeaseResult> => {
          const at = now();
          const envelope = await requireEnvelope(scenarioId);
          const { lease, tookOver } = await acquireLeaseInTx(envelope, tabId, mode, at);
          let accepted = await acceptLeaseEpoch(envelope, lease.epoch, at);
          // History-session rollover happens HERE, inside the fenced acquisition, not
          // in a second transaction afterwards. Split across two transactions it was
          // an unfenced scenario write, so the interleaving B-acquire → C-takeover →
          // B-rollover let a stale B expire C's reversal material and replace C's
          // session. Folded in, the rollover either lands with the acquisition that
          // earned it or does not happen at all.
          if (rollHistorySession) {
            accepted = await rollHistorySessionInTx(accepted, at);
          }
          return {
            owner: { scenarioId, tabId, epoch: lease.epoch },
            lease,
            // The envelope is returned from PERSISTED state so a new owner reads the
            // committed truth rather than whatever the previous owner published.
            envelope: accepted,
            tookOver,
          };
        },
      );
    },

    async heartbeat(owner) {
      return db.transaction(
        "rw",
        [db.scenarioEnvelopes, db.writerLeases],
        async (): Promise<LeaseResult> => {
          const at = now();
          const envelope = await requireEnvelope(owner.scenarioId);
          const lease = await db.writerLeases.get(owner.scenarioId);
          // A heartbeat is fenced exactly like a write: renewing a lease that was
          // taken over or already expired would resurrect a stale writer.
          assertLeaseOwnership(lease, envelope, owner, at);
          const renewed = renewedLease(
            { scenarioId: owner.scenarioId, ownerTabId: owner.tabId, epoch: owner.epoch },
            at,
            leaseTtlMs,
          );
          await db.writerLeases.put(renewed);
          return { owner, lease: renewed, envelope, tookOver: false };
        },
      );
    },

    async release(owner) {
      await db.transaction("rw", [db.scenarioEnvelopes, db.writerLeases], async () => {
        const at = now();
        const envelope = await requireEnvelope(owner.scenarioId);
        const lease = await db.writerLeases.get(owner.scenarioId);
        // Releasing without validating would let a superseded tab delete the CURRENT
        // owner's lease on its way out.
        assertLeaseOwnership(lease, envelope, owner, at);
        await db.writerLeases.delete(owner.scenarioId);
      });
    },

    async commit(input) {
      return db.transaction("rw", SCENARIO_WRITE_TABLES, async (): Promise<CommitResult> => {
        const at = now();
        if (input.owner.scenarioId !== input.expectedScenarioId) {
          throw new RepositoryError(
            "scenario_mismatch",
            "the lease and the expected scenario disagree",
            { owner: input.owner.scenarioId, expected: input.expectedScenarioId },
          );
        }
        const envelope = await requireEnvelope(input.expectedScenarioId);
        const lease = await db.writerLeases.get(input.expectedScenarioId);
        assertLeaseOwnership(lease, envelope, input.owner, at);

        if (input.guardGenerations?.length) {
          await assertGenerationsUnchanged(db, input.guardGenerations);
        }

        const digest = commandDigest(input.command);

        // Idempotent replay, checked BEFORE the revision so a retry after a
        // successful-but-unacknowledged commit succeeds instead of reporting a
        // stale revision it caused itself.
        if (input.idempotencyKey !== undefined) {
          const prior = await db.scenarioCommits
            .where("idempotencyKey")
            .equals(input.idempotencyKey)
            .first();
          if (prior) {
            if (prior.commandDigest !== digest || prior.scenarioId !== envelope.scenarioId) {
              // The same key must never map to different input. Failing closed is
              // the only safe answer: applying it would double-commit.
              throw new RepositoryError(
                "idempotency_conflict",
                "this idempotency key was already consumed by a different command",
                { idempotencyKey: input.idempotencyKey, priorCommitId: prior.commitId },
              );
            }
            return {
              envelope,
              commit: prior,
              history: await historyOf(envelope),
              replayed: true,
            };
          }
        }

        if (envelope.documentRevision !== input.expectedDocumentRevision) {
          throw new RepositoryError(
            "stale_revision",
            "the scenario advanced since this command read it",
            {
              scenarioId: envelope.scenarioId,
              expected: input.expectedDocumentRevision,
              persisted: envelope.documentRevision,
            },
          );
        }

        // The command is applied to the snapshot just read INSIDE the transaction,
        // never to whatever the caller was looking at.
        const before: ScenarioSnapshot = {
          scenario: envelope.scenario,
          backupFingerprint: envelope.backupFingerprint,
        };
        const next = applyScenarioCommand(before, input.command);
        // Validate the RESULT, inside the transaction, before anything is written.
        // A refusal here aborts the whole commit and leaves the committed content
        // exactly as it was (see `validate.ts`).
        assertValidScenarioSnapshot(next, {
          scenarioId: envelope.scenarioId,
          command: input.command.type,
        });

        if (!isContentCommand(input.command)) {
          // Metadata only: `recordRevision` moves, `documentRevision` does not, and
          // no commit fact is written — so a content-bound Preview stays valid.
          const updated: ScenarioEnvelopeV3 = {
            ...envelope,
            recordRevision: envelope.recordRevision + 1,
            backupFingerprint: next.backupFingerprint,
            updatedAt: at.toISOString(),
          };
          await db.scenarioEnvelopes.put(updated);
          return {
            envelope: updated,
            commit: null,
            history: await historyOf(updated),
            replayed: false,
          };
        }

        // A content command whose RESULT equals the committed content is not a
        // change. Committing it anyway spent a revision and an Undo entry on
        // nothing — a Clear over an already-empty matrix, or a paint gesture that
        // folded back to the same cells. The comparison is SEMANTIC because the
        // matrix arms are rebuilt objects: reference equality would call every one of
        // them a change. `patch_scenario` keeps its cheap per-key reference test at
        // the command bus; this catches the arms that cannot use one.
        if (isSemanticNoOpCommand(before, next, input.command)) {
          return {
            envelope,
            commit: null,
            history: await historyOf(envelope),
            replayed: false,
          };
        }

        const sessionCommits = await readSessionCommits(
          db,
          envelope.scenarioId,
          envelope.historySessionId,
        );
        const written = await writeContentCommit({
          envelope,
          next,
          kind: input.kind ?? "manual",
          isContent: true,
          commandDigestValue: digest,
          idempotencyKey: input.idempotencyKey,
          at,
          sessionCommits,
        });

        // Receipt and proposal transition share this transaction, so "applied" and
        // "there is a receipt proving it" can never disagree after a partial write.
        if (input.receipt) {
          await db.assistantReceipts.put({
            ...input.receipt,
            commitId: written.commit.commitId,
            documentRevision: written.commit.documentRevision,
            historySessionId: written.commit.historySessionId,
          });
        }
        if (input.proposalUpdate) {
          await db.assistantProposals.update(input.proposalUpdate.proposalId, {
            status: input.proposalUpdate.status,
            updatedAt: at.toISOString(),
          });
        }

        return {
          envelope: written.envelope,
          commit: written.commit,
          history: await historyOf(written.envelope),
          replayed: false,
        };
      });
    },

    async undo(input) {
      return db.transaction("rw", SCENARIO_WRITE_TABLES, async (): Promise<CommitResult> => {
        const at = now();
        const envelope = await requireEnvelope(input.owner.scenarioId);
        const lease = await db.writerLeases.get(input.owner.scenarioId);
        assertLeaseOwnership(lease, envelope, input.owner, at);
        if (envelope.documentRevision !== input.expectedDocumentRevision) {
          throw new RepositoryError("stale_revision", "the scenario advanced since this read", {
            expected: input.expectedDocumentRevision,
            persisted: envelope.documentRevision,
          });
        }

        const sessionCommits = await readSessionCommits(
          db,
          envelope.scenarioId,
          envelope.historySessionId,
        );
        const content = contentCommits(sessionCommits);
        const target = envelope.historyCursor > 0 ? content[envelope.historyCursor - 1] : undefined;
        if (!target || target.payloadState !== "live" || !target.reversiblePayload) {
          // Includes the pruned and session-expired cases: the commit is a real
          // durable fact, but its reversal material is gone, so Undo must not
          // promise a restore it cannot perform.
          throw new RepositoryError(
            "nothing_to_undo",
            "no reversible commit at the history cursor",
            {
              scenarioId: envelope.scenarioId,
              historyCursor: envelope.historyCursor,
              payloadState: target?.payloadState ?? null,
            },
          );
        }

        const written = await writeContentCommit({
          envelope,
          next: target.reversiblePayload.before,
          kind: "undo",
          // An Undo is navigation, not a new cursor entry — the cursor moves down
          // instead, which is what leaves the undone commit available to Redo.
          isContent: false,
          commandDigestValue: commandDigest({ kind: "undo", source: target.commitId }),
          at,
          sessionCommits,
        });
        const moved: ScenarioEnvelopeV3 = {
          ...written.envelope,
          historyCursor: envelope.historyCursor - 1,
        };
        await db.scenarioEnvelopes.put(moved);
        await db.historyLinks.add({
          scenarioId: envelope.scenarioId,
          historySessionId: envelope.historySessionId,
          kind: "undo",
          sourceCommitId: target.commitId,
          linkCommitId: written.commit.commitId,
          createdAt: at.toISOString(),
        });

        return {
          envelope: moved,
          commit: written.commit,
          history: await historyOf(moved),
          replayed: false,
        };
      });
    },

    async redo(input) {
      return db.transaction("rw", SCENARIO_WRITE_TABLES, async (): Promise<CommitResult> => {
        const at = now();
        const envelope = await requireEnvelope(input.owner.scenarioId);
        const lease = await db.writerLeases.get(input.owner.scenarioId);
        assertLeaseOwnership(lease, envelope, input.owner, at);
        if (envelope.documentRevision !== input.expectedDocumentRevision) {
          throw new RepositoryError("stale_revision", "the scenario advanced since this read", {
            expected: input.expectedDocumentRevision,
            persisted: envelope.documentRevision,
          });
        }

        const sessionCommits = await readSessionCommits(
          db,
          envelope.scenarioId,
          envelope.historySessionId,
        );
        const content = contentCommits(sessionCommits);
        const target =
          envelope.historyCursor < content.length ? content[envelope.historyCursor] : undefined;
        if (!target || target.payloadState !== "live" || !target.reversiblePayload) {
          throw new RepositoryError("nothing_to_redo", "no reapplyable commit above the cursor", {
            scenarioId: envelope.scenarioId,
            historyCursor: envelope.historyCursor,
            contentCount: content.length,
          });
        }

        const written = await writeContentCommit({
          envelope,
          next: target.reversiblePayload.after,
          kind: "redo",
          isContent: false,
          commandDigestValue: commandDigest({ kind: "redo", source: target.commitId }),
          at,
          sessionCommits,
        });
        const moved: ScenarioEnvelopeV3 = {
          ...written.envelope,
          historyCursor: envelope.historyCursor + 1,
        };
        await db.scenarioEnvelopes.put(moved);
        await db.historyLinks.add({
          scenarioId: envelope.scenarioId,
          historySessionId: envelope.historySessionId,
          kind: "redo",
          sourceCommitId: target.commitId,
          linkCommitId: written.commit.commitId,
          createdAt: at.toISOString(),
        });

        return {
          envelope: moved,
          commit: written.commit,
          history: await historyOf(moved),
          replayed: false,
        };
      });
    },

    async describeHistory(scenarioId) {
      return db.transaction("r", [db.scenarioEnvelopes, db.scenarioCommits], async () => {
        const envelope = await requireEnvelope(scenarioId);
        return historyOf(envelope);
      });
    },

    async captureGenerations(scenarioId) {
      return db.transaction("rw", db.assistantGenerations, async () => {
        const at = now();
        const captured: CapturedGeneration[] = [];
        for (const scopeKey of generationScopesFor(scenarioId)) {
          const fence = await ensureGeneration(db, scopeKey, at);
          captured.push({ scopeKey, generation: fence.generation });
        }
        return captured;
      });
    },

    async bumpGeneration(scopeKey) {
      return db.transaction("rw", db.assistantGenerations, async () => {
        const at = now();
        const fence = await ensureGeneration(db, scopeKey, at);
        const generation = fence.generation + 1;
        await db.assistantGenerations.put({
          ...fence,
          generation,
          clearedAt: at.toISOString(),
        });
        return generation;
      });
    },

    async clearAssistantContent({ scenarioId }) {
      return db.transaction(
        "rw",
        [db.assistantGenerations, db.assistantProposals, db.assistantReceipts],
        async () => {
          const at = now();
          const iso = at.toISOString();

          if (scenarioId === undefined) {
            // Clear ALL assistant content. The tech plan requires Clear all to
            // increment BOTH the global generation AND every affected scenario
            // generation: a callback may have captured only a per-scenario fence,
            // so bumping global alone would leave it unfenced. The fence rows
            // themselves are never deleted — that asymmetry is what stops a
            // detached late callback from recreating the data just deleted here.
            await db.assistantProposals.clear();
            await db.assistantReceipts.clear();
            await ensureGeneration(db, GLOBAL_GENERATION_SCOPE, at);
            const all = await db.assistantGenerations.toArray();
            let globalGeneration = 0;
            for (const fence of all) {
              const generation = fence.generation + 1;
              if (fence.scopeKey === GLOBAL_GENERATION_SCOPE) globalGeneration = generation;
              await db.assistantGenerations.put({ ...fence, generation, clearedAt: iso });
            }
            return { generation: globalGeneration };
          }

          // Clear one scenario's content: delete its rows, bump only its fence.
          const scopeKey: GenerationScopeKey = scenarioGenerationScope(scenarioId);
          await db.assistantProposals.where("scenarioId").equals(scenarioId).delete();
          await db.assistantReceipts.where("scenarioId").equals(scenarioId).delete();
          const fence = await ensureGeneration(db, scopeKey, at);
          const generation = fence.generation + 1;
          await db.assistantGenerations.put({
            ...fence,
            generation,
            clearedAt: at.toISOString(),
          });
          return { generation };
        },
      );
    },

    async runGuarded(captured, body) {
      return db.transaction("rw", SCENARIO_WRITE_TABLES, async () => {
        // The check and the write share one transaction, so a clear cannot land
        // between "still current" and "written" — which is exactly the race an
        // out-of-transaction precheck leaves open.
        await assertGenerationsUnchanged(db, captured);
        return body(db);
      });
    },

    async putProposal(proposal) {
      await db.assistantProposals.put(proposal);
    },

    async getProposal(proposalId) {
      return db.assistantProposals.get(proposalId);
    },

    async getReceipt(receiptId) {
      return db.assistantReceipts.get(receiptId);
    },

    async putOptimizeBasis(basis) {
      await db.optimizeBases.put(basis);
    },

    async getOptimizeBasis(basisId) {
      return db.optimizeBases.get(basisId);
    },
  };
}
