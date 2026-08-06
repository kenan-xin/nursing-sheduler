// Roster storage foundation (F1). Typed, transactional repositories over the
// Dexie v2 stores declared in `dexie-storage.ts` — deliberately NOT the zustand
// `StateStorage` string facade, because these payloads are structured and
// blob-capable (`frozenXlsx`) and their invariants are ordering invariants.
//
// The load-bearing contracts this module owns (tech-plan → Storage / Submission
// snapshot; core-flows → candidate durability, atomic promotion, Clear):
//
//   • ORIGIN-WIDE ORDINALS. `nextSubmissionOrdinal` is read-modify-written inside
//     the same `readwrite` transaction that writes the snapshot, so any number of
//     Dexie instances (tabs) against one database allocate unique, monotonic
//     ordinals. IndexedDB serializes overlapping readwrite transactions on the
//     same stores; that store-level lock IS the mutual exclusion, so no custom
//     locking machinery is built here.
//   • IMMUTABLE SNAPSHOTS. A snapshot is keyed by `ownerId` and written exactly
//     once. A second write for the same owner is a typed conflict that consumes
//     no ordinal (the existence check precedes the counter bump in the same
//     transaction). There is no load-time unreferenced-snapshot GC and no
//     automatic expiry — tab-scoped state is never cleanup authority.
//   • NEWER CANDIDATE WINS. Pointer movement and prior-candidate deletion are one
//     transaction. An older submission completing late returns `superseded`
//     without storing anything or moving the pointer, regardless of completion
//     order. Any abort leaves the prior pointer and its candidate intact.
//   • ATOMIC PROMOTION. Validation runs OUTSIDE the transaction (it is caller
//     code and may be async); the transaction re-checks BOTH the source identity
//     and the expected working revision before committing the new `working` row
//     in a single `put`. Promotion is therefore a first-class participant in the
//     working CAS — an autosave that commits while validation is running yields a
//     typed `working-conflict` instead of being silently overwritten — and the
//     old row survives any abort while the source is never consumed.
//   • NON-REUSABLE CANDIDATE IDENTITY. `candidateVersion` comes from an
//     origin-wide counter that is never reset or reused, so every destructive or
//     promoting authority (`dismissCandidate`, promotion's source check) names an
//     exact version that a delete/recreate of the same job can never impersonate.
//   • CAS + CLEAR EPOCH. Every mutating entry point carries the clear epoch it
//     was started under and the revision it expects. Clear bumps the epoch and
//     purges in ONE transaction over every store involved, so a write still in
//     flight across the purge is rejected and cannot repopulate the stores, and
//     a write started under the NEW epoch cannot exist until after the purge has
//     committed — it is therefore never something the purge can delete.

import {
  getRosterDb,
  type MetaRow,
  type RosterRow,
  type ScenarioPersistenceDb,
  type SnapshotRow,
} from "./dexie-storage";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The single working-roster row key. */
export const WORKING_ROSTER_KEY = "working";

/** The `roster` row key for a captured candidate. */
export function candidateRosterKey(jobId: string): string {
  return `candidate:${jobId}`;
}

/** The `snapshot` row key for a submission, authorized by its owner id. */
export function submissionSnapshotKey(ownerId: string): string {
  return `snapshot:${ownerId}`;
}

const META_NEXT_ORDINAL = "nextSubmissionOrdinal";
const META_NEXT_CANDIDATE_VERSION = "nextCandidateVersion";
const META_CURRENT_CANDIDATE = "currentCandidate";
const META_CLEAR_EPOCH = "clearEpoch";

/** The first ordinal handed out by a fresh database. */
const FIRST_SUBMISSION_ORDINAL = 1;

/** The first candidate version handed out by a fresh database. */
const FIRST_CANDIDATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/**
 * The durable pointer to the one latest loadable candidate. Versioned so a
 * capture can prove which commit it observed; `submissionOrdinal` is the
 * origin-wide ordering authority that decides supersession.
 */
export interface CurrentCandidatePointer {
  jobId: string;
  /**
   * Origin-wide and never reused — see `RosterRow.revision`. Together with
   * `jobId` it is the exact authority a later dismissal must present, so a
   * dismissal captured for one capture attempt can never delete a newer one.
   */
  candidateVersion: number;
  submissionOrdinal: number;
}

/**
 * The F3 boundary. F1 stores opaque structured-cloneable documents and never
 * inspects their shape; a caller promoting a document to `working` must supply
 * the validator that proves it, and the validator returns the exact value to
 * store. May be async — it runs outside the transaction.
 */
export type RosterDocumentValidator<TDocument> = (
  document: unknown,
) =>
  | { ok: true; document: TDocument }
  | { ok: false; reason: string }
  | Promise<{ ok: true; document: TDocument } | { ok: false; reason: string }>;

/** Rejected because Clear invalidated the epoch this operation started under. */
export interface StaleEpochOutcome {
  status: "stale-epoch";
  currentEpoch: number;
}

/** Snapshot allocation: the ordinal and the immutable snapshot in one commit. */
export type SnapshotAllocationOutcome<TPayload> =
  | { status: "allocated"; snapshot: SnapshotRow<TPayload> }
  | { status: "conflict"; snapshot: SnapshotRow<TPayload> }
  | StaleEpochOutcome;

/** Candidate commit: either it becomes the pointed candidate, or it is older. */
export type CandidateCommitOutcome =
  | {
      status: "committed";
      pointer: CurrentCandidatePointer;
      /** The pointer this commit replaced (its candidate row was deleted). */
      replaced: CurrentCandidatePointer | null;
    }
  | { status: "superseded"; current: CurrentCandidatePointer }
  | StaleEpochOutcome;

/** A revisioned compare-and-swap write of the working roster. */
export type WorkingWriteOutcome =
  | { status: "written"; revision: number }
  | { status: "conflict"; currentRevision: number | null }
  | StaleEpochOutcome;

/** Promotion of a candidate or an imported document to the working roster. */
export type WorkingPromotionOutcome =
  | { status: "promoted"; revision: number }
  | { status: "rejected"; reason: string }
  | { status: "source-missing" }
  | { status: "source-changed" }
  /**
   * The working roster moved (typically an autosave) while validation was
   * running. Both the newer working document and the source are preserved; the
   * caller re-reads and decides (F5's "discard unsaved edits and replace").
   */
  | { status: "working-conflict"; currentRevision: number | null }
  | StaleEpochOutcome;

/** Dismissal of one exact candidate version. */
export type CandidateDismissalOutcome =
  | { status: "dismissed"; clearedPointer: boolean }
  | { status: "already-absent" }
  /** A different candidate version is stored for this job — nothing was deleted. */
  | { status: "version-conflict"; currentVersion: number }
  | StaleEpochOutcome;

/** Deletion of one submission snapshot. */
export type SnapshotDeletionOutcome =
  | { status: "deleted" }
  | { status: "already-absent" }
  | StaleEpochOutcome;

/** The result of a verified privacy purge. */
export type ClearOutcome =
  | { status: "cleared"; epoch: number }
  | { status: "failed"; epoch: number; remaining: { roster: number; snapshot: number } };

// ---------------------------------------------------------------------------
// Metadata helpers (always called from inside the owning transaction)
// ---------------------------------------------------------------------------

async function readMeta<TValue>(
  db: ScenarioPersistenceDb,
  key: string,
  fallback: TValue,
): Promise<TValue> {
  const row = (await db.meta.get(key)) as MetaRow<TValue> | undefined;
  return row === undefined ? fallback : row.value;
}

async function writeMeta<TValue>(
  db: ScenarioPersistenceDb,
  key: string,
  value: TValue,
): Promise<void> {
  await db.meta.put({ key, value });
}

/**
 * The epoch fence. Returns a `stale-epoch` outcome when Clear has advanced the
 * epoch since the caller started, and `null` when the operation may proceed.
 * Always evaluated inside the mutating transaction, so no purge can interleave
 * between the check and the write.
 */
async function fenceEpoch(
  db: ScenarioPersistenceDb,
  expectedClearEpoch: number,
): Promise<StaleEpochOutcome | null> {
  const currentEpoch = await readMeta(db, META_CLEAR_EPOCH, 0);
  return currentEpoch === expectedClearEpoch ? null : { status: "stale-epoch", currentEpoch };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * The typed roster repositories. Every method resolves the Dexie handle lazily
 * on call, so constructing this object is free and safe during SSR — only an
 * actual operation touches IndexedDB (and throws `IndexedDbUnavailableError`
 * if there is none).
 */
export interface RosterStorage {
  /** The epoch a caller must capture before starting any mutating flow. */
  getClearEpoch(): Promise<number>;

  /**
   * Allocate the next origin-wide `submissionOrdinal` AND write the immutable
   * `snapshot:<ownerId>` row in one transaction. A snapshot already existing for
   * this owner is returned as `conflict` and consumes no ordinal.
   */
  allocateSubmissionSnapshot<TPayload>(input: {
    ownerId: string;
    payload: TPayload;
    expectedClearEpoch: number;
  }): Promise<SnapshotAllocationOutcome<TPayload>>;

  readSubmissionSnapshot<TPayload>(ownerId: string): Promise<SnapshotRow<TPayload> | null>;
  /**
   * Delete a snapshot. Authorized only by a locally proven outcome (POST
   * rejection, candidate commit, explicit dismissal, verified Clear) — never by
   * tab-scoped state and never on a load-time sweep. Epoch-fenced like every
   * other mutation, so destructive work begun before a Clear reports
   * `stale-epoch` rather than acting on the post-purge store.
   */
  deleteSubmissionSnapshot(input: {
    ownerId: string;
    expectedClearEpoch: number;
  }): Promise<SnapshotDeletionOutcome>;
  /** Every snapshot ordinal currently stored (diagnostics/tests). */
  listSubmissionOrdinals(): Promise<number[]>;

  /**
   * Commit a captured candidate: write `candidate:<jobId>`, move
   * `currentCandidate`, and delete the previously pointed candidate — all in one
   * transaction. A submission older than the current pointer returns
   * `superseded` and writes nothing at all.
   */
  commitCandidate<TDocument>(input: {
    jobId: string;
    submissionOrdinal: number;
    document: TDocument;
    expectedClearEpoch: number;
  }): Promise<CandidateCommitOutcome>;

  readCurrentCandidate(): Promise<CurrentCandidatePointer | null>;
  readCandidate<TDocument>(jobId: string): Promise<RosterRow<TDocument> | null>;
  /**
   * Drop one exact candidate's payload (not merely its result card), clearing
   * the pointer when it still names that same version. The caller must present
   * the `{jobId, candidateVersion}` it observed: a dismissal decided against one
   * capture cannot delete a newer re-capture that landed in the meantime, it
   * reports `version-conflict` instead.
   */
  dismissCandidate(input: {
    jobId: string;
    candidateVersion: number;
    expectedClearEpoch: number;
  }): Promise<CandidateDismissalOutcome>;

  readWorking<TDocument>(): Promise<RosterRow<TDocument> | null>;

  /**
   * Revisioned compare-and-swap write of the working roster. `expectedRevision`
   * is `null` when the caller expects no row to exist yet.
   */
  writeWorking<TDocument>(input: {
    document: TDocument;
    expectedRevision: number | null;
    expectedClearEpoch: number;
  }): Promise<WorkingWriteOutcome>;

  /**
   * Promote a stored candidate to the working roster, keeping the candidate.
   * `expectedWorkingRevision` is the revision the caller read BEFORE starting
   * validation (`null` when it observed no working roster); promotion is a
   * participant in the same CAS as autosave, not an override of it.
   */
  promoteCandidateToWorking<TDocument>(input: {
    jobId: string;
    validate: RosterDocumentValidator<TDocument>;
    expectedWorkingRevision: number | null;
    expectedClearEpoch: number;
  }): Promise<WorkingPromotionOutcome>;

  /** Promote an imported document to the working roster. */
  promoteDocumentToWorking<TDocument>(input: {
    document: unknown;
    validate: RosterDocumentValidator<TDocument>;
    expectedWorkingRevision: number | null;
    expectedClearEpoch: number;
  }): Promise<WorkingPromotionOutcome>;

  /**
   * Privacy purge: invalidate the epoch, purge the roster and snapshot stores
   * plus the candidate pointer, and verify the purge — all in ONE transaction,
   * reporting failure if anything sensitive survived. The ordinal counter is
   * deliberately kept so ordinals stay monotonic across a Clear; it carries no
   * personal data.
   */
  clearRosterData(): Promise<ClearOutcome>;
}

/** Create the roster repositories bound to one IndexedDB database name. */
export function createRosterStorage(databaseName?: string): RosterStorage {
  return createRosterStorageForDb(() => getRosterDb(databaseName));
}

/**
 * Create the repositories over an explicitly supplied Dexie handle. Two handles
 * opened on the same database name model two tabs; the shared-name accessor
 * intentionally returns one cached instance instead.
 */
export function createRosterStorageForDb(resolveDb: () => ScenarioPersistenceDb): RosterStorage {
  const db = resolveDb;

  async function commitWorkingDocument<TDocument>(input: {
    document: unknown;
    validate: RosterDocumentValidator<TDocument>;
    expectedWorkingRevision: number | null;
    expectedClearEpoch: number;
    /**
     * Re-checked inside the transaction so a changed source aborts promotion.
     * `revision` here is the candidate's origin-wide, never-reused
     * `candidateVersion`, so a delete/recreate of the same job is detected as a
     * change rather than matching a recycled number.
     */
    source: { key: string; revision: number } | null;
  }): Promise<WorkingPromotionOutcome> {
    // Validation is caller code and may be async, so it runs BEFORE the
    // transaction opens — awaiting a non-Dexie promise inside a transaction
    // would leave its zone and commit the transaction early.
    const verdict = await input.validate(input.document);
    if (!verdict.ok) return { status: "rejected", reason: verdict.reason };

    const handle = db();
    return handle.transaction("rw", handle.roster, handle.meta, async () => {
      const stale = await fenceEpoch(handle, input.expectedClearEpoch);
      if (stale) return stale;

      if (input.source) {
        const current = await handle.roster.get(input.source.key);
        if (!current) return { status: "source-missing" as const };
        if (current.revision !== input.source.revision) {
          return { status: "source-changed" as const };
        }
      }

      // The working CAS applies to promotion too: an autosave that committed
      // while validation was running must not be silently overwritten.
      const existing = await handle.roster.get(WORKING_ROSTER_KEY);
      const currentRevision = existing?.revision ?? null;
      if (currentRevision !== input.expectedWorkingRevision) {
        return { status: "working-conflict" as const, currentRevision };
      }

      // One `put` both durably commits the replacement and replaces the row: an
      // abort anywhere in this transaction leaves the previous working roster
      // and the source candidate/import untouched.
      const revision = (currentRevision ?? 0) + 1;
      await handle.roster.put({
        key: WORKING_ROSTER_KEY,
        document: verdict.document,
        revision,
        clearEpoch: input.expectedClearEpoch,
      });
      return { status: "promoted" as const, revision };
    });
  }

  return {
    async getClearEpoch() {
      return readMeta(db(), META_CLEAR_EPOCH, 0);
    },

    async allocateSubmissionSnapshot<TPayload>(input: {
      ownerId: string;
      payload: TPayload;
      expectedClearEpoch: number;
    }): Promise<SnapshotAllocationOutcome<TPayload>> {
      const handle = db();
      const key = submissionSnapshotKey(input.ownerId);
      return handle.transaction("rw", handle.snapshot, handle.meta, async () => {
        const stale = await fenceEpoch(handle, input.expectedClearEpoch);
        if (stale) return stale;

        // Immutability first: an existing snapshot wins and no ordinal is spent.
        const existing = (await handle.snapshot.get(key)) as SnapshotRow<TPayload> | undefined;
        if (existing) return { status: "conflict" as const, snapshot: existing };

        const submissionOrdinal = await readMeta(
          handle,
          META_NEXT_ORDINAL,
          FIRST_SUBMISSION_ORDINAL,
        );
        await writeMeta(handle, META_NEXT_ORDINAL, submissionOrdinal + 1);

        const snapshot: SnapshotRow<TPayload> = {
          key,
          ownerId: input.ownerId,
          submissionOrdinal,
          payload: input.payload,
        };
        await handle.snapshot.add(snapshot);
        return { status: "allocated" as const, snapshot };
      });
    },

    async readSubmissionSnapshot<TPayload>(ownerId: string) {
      const row = (await db().snapshot.get(submissionSnapshotKey(ownerId))) as
        | SnapshotRow<TPayload>
        | undefined;
      return row ?? null;
    },

    async deleteSubmissionSnapshot(input: {
      ownerId: string;
      expectedClearEpoch: number;
    }): Promise<SnapshotDeletionOutcome> {
      const handle = db();
      const key = submissionSnapshotKey(input.ownerId);
      return handle.transaction("rw", handle.snapshot, handle.meta, async () => {
        const stale = await fenceEpoch(handle, input.expectedClearEpoch);
        if (stale) return stale;
        const existing = await handle.snapshot.get(key);
        if (!existing) return { status: "already-absent" as const };
        await handle.snapshot.delete(key);
        return { status: "deleted" as const };
      });
    },

    async listSubmissionOrdinals() {
      const rows = await db().snapshot.toArray();
      return rows.map((row) => row.submissionOrdinal).sort((a, b) => a - b);
    },

    async commitCandidate<TDocument>(input: {
      jobId: string;
      submissionOrdinal: number;
      document: TDocument;
      expectedClearEpoch: number;
    }): Promise<CandidateCommitOutcome> {
      const handle = db();
      return handle.transaction("rw", handle.roster, handle.meta, async () => {
        const stale = await fenceEpoch(handle, input.expectedClearEpoch);
        if (stale) return stale;

        const pointer = await readMeta<CurrentCandidatePointer | null>(
          handle,
          META_CURRENT_CANDIDATE,
          null,
        );

        // Ordering authority is the origin-wide ordinal, never completion order.
        // A strictly older submission, or a different job that shares the current
        // ordinal, cannot take the pointer; re-committing the SAME job at the same
        // ordinal is an idempotent capture retry and is allowed through.
        if (pointer !== null) {
          const isOlder = input.submissionOrdinal < pointer.submissionOrdinal;
          const isRivalAtSameOrdinal =
            input.submissionOrdinal === pointer.submissionOrdinal && input.jobId !== pointer.jobId;
          if (isOlder || isRivalAtSameOrdinal) {
            return { status: "superseded" as const, current: pointer };
          }
        }

        // Origin-wide and never reused, so no later delete/recreate of this job
        // can produce this number again (the ABA that a per-key counter admits).
        // Allocated only once the commit is known to win, mirroring the ordinal
        // policy: a superseded commit spends nothing.
        const candidateVersion = await readMeta(
          handle,
          META_NEXT_CANDIDATE_VERSION,
          FIRST_CANDIDATE_VERSION,
        );
        await writeMeta(handle, META_NEXT_CANDIDATE_VERSION, candidateVersion + 1);

        const key = candidateRosterKey(input.jobId);
        await handle.roster.put({
          key,
          document: input.document,
          revision: candidateVersion,
          clearEpoch: input.expectedClearEpoch,
        });

        const next: CurrentCandidatePointer = {
          jobId: input.jobId,
          candidateVersion,
          submissionOrdinal: input.submissionOrdinal,
        };
        await writeMeta(handle, META_CURRENT_CANDIDATE, next);

        // Same transaction as the pointer move: the prior candidate's payload can
        // never be deleted without the pointer actually having moved off it.
        if (pointer !== null && pointer.jobId !== input.jobId) {
          await handle.roster.delete(candidateRosterKey(pointer.jobId));
        }
        return { status: "committed" as const, pointer: next, replaced: pointer };
      });
    },

    async readCurrentCandidate() {
      return readMeta<CurrentCandidatePointer | null>(db(), META_CURRENT_CANDIDATE, null);
    },

    async readCandidate<TDocument>(jobId: string) {
      const row = (await db().roster.get(candidateRosterKey(jobId))) as
        | RosterRow<TDocument>
        | undefined;
      return row ?? null;
    },

    async dismissCandidate(input: {
      jobId: string;
      candidateVersion: number;
      expectedClearEpoch: number;
    }): Promise<CandidateDismissalOutcome> {
      const handle = db();
      const key = candidateRosterKey(input.jobId);
      return handle.transaction("rw", handle.roster, handle.meta, async () => {
        const stale = await fenceEpoch(handle, input.expectedClearEpoch);
        if (stale) return stale;

        const existing = await handle.roster.get(key);
        if (!existing) return { status: "already-absent" as const };
        // Exact-version authority: a dismissal decided against an earlier capture
        // must never delete the retry that replaced it.
        if (existing.revision !== input.candidateVersion) {
          return { status: "version-conflict" as const, currentVersion: existing.revision };
        }

        await handle.roster.delete(key);
        const pointer = await readMeta<CurrentCandidatePointer | null>(
          handle,
          META_CURRENT_CANDIDATE,
          null,
        );
        const pointsAtDismissed =
          pointer?.jobId === input.jobId && pointer.candidateVersion === input.candidateVersion;
        if (pointsAtDismissed) await writeMeta(handle, META_CURRENT_CANDIDATE, null);
        return { status: "dismissed" as const, clearedPointer: pointsAtDismissed };
      });
    },

    async readWorking<TDocument>() {
      const row = (await db().roster.get(WORKING_ROSTER_KEY)) as RosterRow<TDocument> | undefined;
      return row ?? null;
    },

    async writeWorking<TDocument>(input: {
      document: TDocument;
      expectedRevision: number | null;
      expectedClearEpoch: number;
    }): Promise<WorkingWriteOutcome> {
      const handle = db();
      return handle.transaction("rw", handle.roster, handle.meta, async () => {
        const stale = await fenceEpoch(handle, input.expectedClearEpoch);
        if (stale) return stale;

        const existing = await handle.roster.get(WORKING_ROSTER_KEY);
        const currentRevision = existing?.revision ?? null;
        if (currentRevision !== input.expectedRevision) {
          return { status: "conflict" as const, currentRevision };
        }

        const revision = (currentRevision ?? 0) + 1;
        await handle.roster.put({
          key: WORKING_ROSTER_KEY,
          document: input.document,
          revision,
          clearEpoch: input.expectedClearEpoch,
        });
        return { status: "written" as const, revision };
      });
    },

    async promoteCandidateToWorking<TDocument>(input: {
      jobId: string;
      validate: RosterDocumentValidator<TDocument>;
      expectedWorkingRevision: number | null;
      expectedClearEpoch: number;
    }): Promise<WorkingPromotionOutcome> {
      const key = candidateRosterKey(input.jobId);
      const staged = await db().roster.get(key);
      if (!staged) return { status: "source-missing" };
      return commitWorkingDocument({
        document: staged.document,
        validate: input.validate,
        expectedWorkingRevision: input.expectedWorkingRevision,
        expectedClearEpoch: input.expectedClearEpoch,
        source: { key, revision: staged.revision },
      });
    },

    async promoteDocumentToWorking<TDocument>(input: {
      document: unknown;
      validate: RosterDocumentValidator<TDocument>;
      expectedWorkingRevision: number | null;
      expectedClearEpoch: number;
    }): Promise<WorkingPromotionOutcome> {
      return commitWorkingDocument({
        document: input.document,
        validate: input.validate,
        expectedWorkingRevision: input.expectedWorkingRevision,
        expectedClearEpoch: input.expectedClearEpoch,
        source: null,
      });
    },

    async clearRosterData(): Promise<ClearOutcome> {
      const handle = db();

      // Invalidate, purge and verify in ONE transaction spanning every store
      // involved. Splitting the epoch bump into its own committed transaction
      // opened a window on the far side of the fence: once the new epoch was
      // durable, another tab could READ it, pass `fenceEpoch` legitimately, and
      // commit a genuine post-Clear snapshot/candidate/working roster that the
      // still-pending purge then deleted — and a write landing before the
      // separate verification read could also make Clear falsely report failure.
      //
      // One transaction closes both. IndexedDB serializes overlapping readwrite
      // transactions on these stores, so a concurrent write either commits
      // BEFORE Clear (and is purged, which is the entire point) or runs after it
      // and is rejected by the fence. Nothing can observe the new epoch until
      // the purge is part of the same commit, so no post-Clear write is ever
      // purgeable and no survivor count can see one.
      return handle.transaction("rw", handle.roster, handle.snapshot, handle.meta, async () => {
        const epoch = (await readMeta(handle, META_CLEAR_EPOCH, 0)) + 1;

        // The ordinal and candidate-version counters survive: they hold no
        // personal data, and resetting them would let a pre-Clear submission look
        // newer than it is, or let a recycled candidate version impersonate an
        // old one.
        await handle.roster.clear();
        await handle.snapshot.clear();
        await writeMeta(handle, META_CURRENT_CANDIDATE, null);
        await writeMeta(handle, META_CLEAR_EPOCH, epoch);

        // Verified inside the transaction, so the counts describe exactly the
        // state this commit makes durable. Clear reports failure if anything
        // sensitive survived the purge (which also aborts nothing — the caller
        // decides), and an abort anywhere above rejects the whole call with the
        // stores and the epoch untouched.
        const remaining = {
          roster: await handle.roster.count(),
          snapshot: await handle.snapshot.count(),
        };
        if (remaining.roster > 0 || remaining.snapshot > 0) {
          return { status: "failed" as const, epoch, remaining };
        }
        return { status: "cleared" as const, epoch };
      });
    },
  };
}

/**
 * The app-wide roster storage singleton. Safe to import anywhere: the Dexie
 * handle is created on the first actual operation, never at module load.
 */
export const rosterStorage: RosterStorage = createRosterStorage();
