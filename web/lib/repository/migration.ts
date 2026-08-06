// One-time migration of the shipped single persisted scenario into the
// repository's per-scenario envelope (T02).
//
// THREE PROPERTIES, and each one is load-bearing:
//
//   IDEMPOTENT — a marker row records completion, so running it on every boot
//   (which is what actually happens) mints exactly one scenario identity rather
//   than one per reload.
//
//   RECOVERABLE — the marker is written in its OWN transaction before the work
//   begins. A crash between the two leaves `in-progress` with nothing written; a
//   crash during the work is aborted whole by IndexedDB. Either way the next run
//   sees `in-progress`, discards anything partial, and re-runs from the legacy
//   record — which is still there, because:
//
//   NON-DESTRUCTIVE — the legacy `keyval` row is never read-and-deleted. It stays
//   byte-for-byte intact. That is not caution for its own sake: the legacy
//   `persist` path is STILL THE LIVE AUTHORITY during T02, and T03 owns retiring
//   it once parity and rollback evidence exist. Rollback is therefore "stop
//   constructing the repository", with no data movement at all.
//
// FORMAT PARITY. The payload is decoded through the SAME codec, version
// migration, and sanitizer the live store uses — not a re-implementation. A
// migrated envelope therefore produces a byte-identical Workspace document and an
// identical backup fingerprint, so save/export formats are unchanged and a backup
// taken before the migration still compares equal after it.

import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import {
  decodeNonFiniteNumbers,
  migrateScenarioState,
  sanitizePersistedScenario,
  SCENARIO_PERSIST_KEY,
  SCENARIO_PERSIST_VERSION,
} from "@/lib/store/persistence";
import { commandDigest } from "./digest";
import { ensureGeneration, generationScopesFor } from "./generations";
import type { NurseSchedulerDb } from "./schema";
import {
  type LegacyMigrationRecord,
  LEGACY_MIGRATION_KEY,
  type ScenarioCommitV1,
  type ScenarioEnvelopeV3,
  type ScenarioSnapshot,
} from "./types";

export type LegacyMigrationStatus =
  /** A prior run already migrated (or determined there was nothing to migrate). */
  | "already-complete"
  /** There was no legacy record: a fresh install. A scenario is still minted. */
  | "no-legacy-record"
  /** The legacy record was migrated into a fresh scenario identity. */
  | "migrated"
  /** A previous attempt was interrupted; its partial work was discarded and redone. */
  | "recovered"
  /**
   * The legacy record could not be decoded. NOTHING is minted: the bytes are left
   * intact and the caller routes the user to the existing recoverable-error/reset
   * surface.
   */
  | "corrupt";

export interface LegacyMigrationOutcome {
  status: LegacyMigrationStatus;
  /**
   * The migrated scenario identity, or `null` for `corrupt` — corruption mints no
   * scenario, so there is no identity to hand out.
   */
  scenarioId: string | null;
  /**
   * The migrated envelope, or `null` for `corrupt`.
   *
   * Publishing an empty envelope on corruption was actively harmful: the user saw a
   * healthy blank workspace, edited it, and the NEXT boot — still finding a `failed`
   * marker — discarded that scenario as "partial work" before minting another. The
   * honest outcome is no authority at all, so the shell shows its recovery surface
   * and nothing is editable until the user resets.
   */
  envelope: ScenarioEnvelopeV3 | null;
  /** Populated for `corrupt`; the legacy row is left intact for the legacy path. */
  reason: string | null;
}

export interface LegacyMigrationConfig {
  db: NurseSchedulerDb;
  now?: () => Date;
  newId?: () => string;
  /** The legacy `keyval` key to migrate. Overridable only for tests. */
  legacyKey?: string;
}

/** Read the migration marker (for diagnostics and tests). */
export async function readLegacyMigrationRecord(
  db: NurseSchedulerDb,
): Promise<LegacyMigrationRecord | undefined> {
  return db.repositoryMeta.get(LEGACY_MIGRATION_KEY);
}

/**
 * Decode the legacy serialized record into a durable snapshot, using exactly the
 * live store's decode chain. Throws on a corrupt record, which the caller turns
 * into a `corrupt` outcome rather than a broken boot.
 */
function decodeLegacyRecord(raw: string): ScenarioSnapshot {
  const parsed = JSON.parse(raw, decodeNonFiniteNumbers) as {
    state?: unknown;
    version?: number;
  } | null;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("the legacy record is not a persist envelope");
  }
  const version = typeof parsed.version === "number" ? parsed.version : 0;
  // `migrate` only runs on a version mismatch in the live store, so mirror that
  // exactly rather than migrating unconditionally.
  const shaped =
    version === SCENARIO_PERSIST_VERSION
      ? parsed.state
      : migrateScenarioState(parsed.state, version);
  const sanitized = sanitizePersistedScenario(shaped);
  const { backupFingerprint = null, ...scenario } = sanitized;
  return {
    scenario: { ...createEmptyScenarioUiState(), ...scenario } as ScenarioUiState,
    backupFingerprint,
  };
}

/**
 * Migrate the legacy record into a fresh local `scenarioId`, or report that a
 * previous run already did. Safe to call on every boot.
 */
export async function migrateLegacyScenarioRecord(
  config: LegacyMigrationConfig,
): Promise<LegacyMigrationOutcome> {
  const { db } = config;
  const now = config.now ?? (() => new Date());
  const newId = config.newId ?? (() => crypto.randomUUID());
  const legacyKey = config.legacyKey ?? SCENARIO_PERSIST_KEY;

  // ONE transaction covers claim, RE-CHECK, and mint.
  //
  // Reading and claiming the marker outside the data transaction split authority on
  // a concurrent first boot: two tabs (two IndexedDB connections) both observed no
  // marker, then each serialized mint minted a DIFFERENT scenario, the last marker
  // won, and the two tabs came up on different identities — neither of them
  // read-only, because they were not contending for the same lease at all.
  //
  // IndexedDB serializes overlapping readwrite transactions over the same stores
  // ACROSS connections, so re-reading the marker inside the transaction is what
  // makes the loser observe the winner's work and adopt it instead of minting.
  return db.transaction(
    "rw",
    [
      db.keyval,
      db.scenarioEnvelopes,
      db.scenarioCommits,
      db.assistantGenerations,
      db.repositoryMeta,
    ],
    async (): Promise<LegacyMigrationOutcome> => {
      const at = now();
      const iso = at.toISOString();
      const startedAt = iso;

      // Re-read INSIDE the transaction. This is the recheck: a concurrent boot that
      // completed while we queued is observed here, and adopted.
      const existing = await readLegacyMigrationRecord(db);

      if (existing?.state === "complete" && existing.scenarioId) {
        const envelope = await db.scenarioEnvelopes.get(existing.scenarioId);
        if (envelope) {
          return {
            status: "already-complete",
            scenarioId: existing.scenarioId,
            envelope,
            reason: null,
          };
        }
        // The marker claims completion but the envelope is gone (a manual wipe, a
        // partially cleared profile). Treat it as interrupted rather than trusting
        // the marker: the marker describes work, not truth.
      }

      // A `failed` marker whose corruption has not been resolved must NOT be retried
      // into a fresh empty scenario — that is the path that used to discard the
      // user's post-"recovery" edits. Report the corruption again, unchanged.
      if (existing?.state === "failed" && existing.scenarioId === null) {
        return {
          status: "corrupt",
          scenarioId: null,
          envelope: null,
          reason: existing.reason,
        };
      }

      // Any surviving marker at this point means a previous attempt did not finish
      // cleanly — the clean-completion case returned above.
      const recovering = existing !== undefined;

      // Claim the attempt. Inside the transaction it is still a durable claim: a
      // crash mid-transaction aborts it whole, and a crash after it commits leaves
      // `in-progress` for the next run to recover from.
      await db.repositoryMeta.put({
        key: LEGACY_MIGRATION_KEY,
        state: "in-progress",
        scenarioId: null,
        sourceKey: legacyKey,
        attempts: (existing?.attempts ?? 0) + 1,
        reason: null,
        startedAt,
        finishedAt: null,
      });

      if (existing?.scenarioId) {
        await db.scenarioEnvelopes.delete(existing.scenarioId);
        await db.scenarioCommits.where("scenarioId").equals(existing.scenarioId).delete();
        // Generation rows are NOT deleted here. They are permanent by contract, and
        // a discarded partial migration is not a reason to lower a fence.
      }

      const raw = await db.keyval.get(legacyKey);
      let snapshot: ScenarioSnapshot;
      let status: LegacyMigrationStatus;
      let reason: string | null = null;

      if (!raw) {
        snapshot = { scenario: createEmptyScenarioUiState(), backupFingerprint: null };
        status = "no-legacy-record";
      } else {
        try {
          snapshot = decodeLegacyRecord(raw.value);
          status = recovering ? "recovered" : "migrated";
        } catch (error) {
          // CORRUPT: record the failure and mint NOTHING.
          //
          // The legacy bytes are left byte-for-byte intact, so a future build can
          // still recover them and the user's data is never destroyed by a decoder
          // bug. What we must not do is publish an empty envelope: that presented
          // corruption as a healthy blank workspace, invited edits into it, and let
          // the next boot delete those edits as "partial migration work". Returning
          // no authority routes the shell to its existing recoverable-error/reset
          // surface, which is the one place that can honestly offer a choice.
          await db.repositoryMeta.put({
            key: LEGACY_MIGRATION_KEY,
            state: "failed",
            scenarioId: null,
            sourceKey: legacyKey,
            attempts: (existing?.attempts ?? 0) + 1,
            reason: error instanceof Error ? error.message : String(error),
            startedAt,
            finishedAt: iso,
          });
          return {
            status: "corrupt",
            scenarioId: null,
            envelope: null,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const scenarioId = newId();
      const commitId = newId();
      const historySessionId = newId();
      const commit: ScenarioCommitV1 = {
        commitId,
        scenarioId,
        parentCommitId: null,
        documentRevision: 1,
        historySessionId,
        sessionSeq: 0,
        kind: "migrate",
        // Genesis: a durable fact, not a cursor entry. There is nothing to undo
        // "before" the migration.
        isContent: false,
        commandDigest: commandDigest({ kind: "migrate", sourceKey: legacyKey }),
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
      for (const scopeKey of generationScopesFor(scenarioId)) {
        await ensureGeneration(db, scopeKey, at);
      }
      await db.repositoryMeta.put({
        key: LEGACY_MIGRATION_KEY,
        state: "complete",
        scenarioId,
        sourceKey: legacyKey,
        attempts: (existing?.attempts ?? 0) + 1,
        reason,
        startedAt,
        finishedAt: iso,
      });

      return { status, scenarioId, envelope, reason };
    },
  );
}
