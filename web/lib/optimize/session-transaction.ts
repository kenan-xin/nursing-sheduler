// T16q — the client submission session transaction. It durably stages a
// recovery record BEFORE the optimize `POST` so an anonymized job's only people
// reverse map exists on disk before a crash can lose it, then reconciles that
// record against the outcome of the request.
//
// The mechanism is pure and injectable (a minimal `Storage` subset + an injected
// `submit`), so every crash/adversarial window is unit-testable without a
// browser. T16a wires the real `sessionStorage` and the real `useSubmitOptimize`
// mutation.
//
// The record is versioned and closed. Two variants:
//   • provisional — owner id, run options, people count, reverse map, but NO job
//     id. Written before `POST`; on reload it means an INTERRUPTED submission.
//   • active — the provisional payload plus the accepted job id. The only variant
//     a reload treats as a resumable job.
//
// Safety properties enforced here (from the cold reviews):
//   • Owner-scoped mutations. Every rollback / activation replacement re-reads the
//     key and compares owner + variant IMMEDIATELY before mutating (no `await` in
//     the critical section), so a run that was superseded while its `POST` was in
//     flight can never remove or overwrite a DIFFERENT run's record.
//   • Writer validation. A locally built provisional/active record is validated
//     against the same closed runtime schema — and proven to round-trip through
//     the codec — BEFORE any `setItem`, so an invalid record never becomes
//     durable (or submitted) only to fail on reload.
//   • Verified writes. Every write is confirmed by an exact read-back; a failed
//     active write is reconciled by reading the key back so a write-then-throw
//     double is classified by what is actually durable, and a partial/foreign/
//     unreadable state is never reported as resumable or interrupted.
//   • Closed submit outcome — accepted / definitely-rejected / acceptance-unknown.
//     Only a definite rejection rolls back (owner-scoped); an ambiguous failure
//     retains the map. The pre-`202` rollback never runs after the server may have
//     accepted the job.

import { validatePeopleReverseMap, type PeopleReverseMap } from "@/lib/scenario";
import { MAX_CURSOR_BYTES, isNonEmptyStringWithin, withinUtf8Bytes } from "@/lib/query/sse-limits";

/** Bump when the record shape changes; a mismatched version is not resumable. */
export const OPTIMIZE_SESSION_SCHEMA_VERSION = 1;

/** The sessionStorage key the single in-flight submission record lives under. */
export const OPTIMIZE_SESSION_STORAGE_KEY = "nurse.optimize.session";

// Settled Optimize timeout bounds (backend: `optimize.py` rejects `<= 0` or
// `> max_timeout_seconds`, whose default is `60 * 60`).
export const OPTIMIZE_TIMEOUT_MIN_SECONDS = 1;
export const OPTIMIZE_TIMEOUT_MAX_SECONDS = 60 * 60;

/** Backend run options carried across a reload so a resume submits identically. */
export interface OptimizeRunOptions {
  prettify?: boolean;
  timeout?: number;
}

interface OptimizeSessionCommon {
  schemaVersion: typeof OPTIMIZE_SESSION_SCHEMA_VERSION;
  /** Unique per transaction; proves a read-back record is ours before we mutate. */
  ownerId: string;
  anonymized: boolean;
  runOptions: OptimizeRunOptions;
  peopleCount: number;
  /** Ordered `[anonymizedId, originalId]` tuples; empty for a plain run. */
  reverseMap: PeopleReverseMap;
}

/** Written before `POST`; a reload finding this means an interrupted submission. */
export interface ProvisionalOptimizeSession extends OptimizeSessionCommon {
  phase: "provisional";
}

/** The provisional payload plus the accepted job id; the only resumable variant. */
export interface ActiveOptimizeSession extends OptimizeSessionCommon {
  phase: "active";
  jobId: string;
  /**
   * The last opaque event cursor T16p reported committed (post-apply). Absent
   * until the resumed stream commits its first frame; a reload seeds it as the
   * stream's initial `Last-Event-ID`. Opaque — stored verbatim, never parsed.
   * T16b persists it through `updateActiveCursor` and clears it on cursor reset.
   */
  lastCursor?: string;
}

export type OptimizeSessionRecord = ProvisionalOptimizeSession | ActiveOptimizeSession;

/** The minimal `Storage` subset used, so tests inject a plain object. */
export interface SessionTransactionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Injectable (de)serialization; defaults to JSON. A throwing/lossy `serialize`
 *  models corrupt serialization and is caught by the writer round-trip check. */
export interface SessionCodec {
  serialize(record: OptimizeSessionRecord): string;
  deserialize(raw: string): unknown;
}

const defaultCodec: SessionCodec = {
  serialize: (record) => JSON.stringify(record),
  deserialize: (raw) => JSON.parse(raw) as unknown,
};

/** Why a durable stage could not happen before `POST`. */
export type StageFailureReason =
  | "storage-unavailable"
  | "quota-exceeded"
  // A locally built record failed the closed runtime schema / codec round-trip.
  | "invalid-record"
  | "read-back-failed"
  // The slot is occupied or cannot be proven empty.
  | "session-conflict";

/** The in-tab state retained when the durable map cannot become resumable. Reload
 *  recovery is unavailable, but the accepted job and its map remain usable for the
 *  lifetime of the current tab. */
export interface VolatileActivation {
  jobId: string;
  anonymized: boolean;
  peopleCount: number;
  reverseMap: PeopleReverseMap;
  reloadRecoveryUnavailable: true;
}

// --- guarded storage primitives -------------------------------------------

type GuardedRead = { ok: true; raw: string | null } | { ok: false };

function guardedGet(storage: SessionTransactionStorage): GuardedRead {
  try {
    return { ok: true, raw: storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY) };
  } catch {
    return { ok: false };
  }
}

type WriteFailureReason = "storage-unavailable" | "quota-exceeded";
type GuardedWrite = { ok: true } | { ok: false; reason: WriteFailureReason };

function classifyWriteFailure(error: unknown): WriteFailureReason {
  const name = (error as { name?: unknown })?.name;
  const code = (error as { code?: unknown })?.code;
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22) {
    return "quota-exceeded";
  }
  return "storage-unavailable";
}

function guardedSet(storage: SessionTransactionStorage, value: string): GuardedWrite {
  try {
    storage.setItem(OPTIMIZE_SESSION_STORAGE_KEY, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: classifyWriteFailure(error) };
  }
}

function guardedRemove(storage: SessionTransactionStorage): boolean {
  try {
    storage.removeItem(OPTIMIZE_SESSION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** A single synchronous snapshot of the key: readability, raw bytes, and the
 *  decoded record (null when empty OR unreadable — disambiguate via `raw`). */
type CurrentSnapshot =
  | { ok: false }
  | { ok: true; raw: string | null; record: OptimizeSessionRecord | null };

function readCurrent(storage: SessionTransactionStorage, codec: SessionCodec): CurrentSnapshot {
  const read = guardedGet(storage);
  if (!read.ok) return { ok: false };
  if (read.raw === null) return { ok: true, raw: null, record: null };
  return { ok: true, raw: read.raw, record: decodeRecord(read.raw, codec) };
}

// --- construction + validation --------------------------------------------

/** Build the provisional record from a prepared submission's recovery fields.
 *  Not yet validated for storage — `stageProvisionalSession` validates before
 *  any write. */
export function buildProvisionalSession(input: {
  ownerId: string;
  anonymized: boolean;
  peopleCount: number;
  reverseMap: PeopleReverseMap;
  runOptions: OptimizeRunOptions;
}): ProvisionalOptimizeSession {
  return {
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId: input.ownerId,
    phase: "provisional",
    anonymized: input.anonymized,
    runOptions: input.runOptions,
    peopleCount: input.peopleCount,
    reverseMap: input.reverseMap,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidJobId(jobId: unknown): jobId is string {
  return isNonEmptyString(jobId);
}

/** Decode + strictly validate raw bytes into a typed record, or null. */
function decodeRecord(raw: string, codec: SessionCodec): OptimizeSessionRecord | null {
  let value: unknown;
  try {
    value = codec.deserialize(raw);
  } catch {
    return null;
  }
  return parseSession(value);
}

/** Ordered, type-strict tuple equality (`===` keeps numeric `1` ≠ string `"1"`). */
function reverseMapsEqual(a: PeopleReverseMap, b: PeopleReverseMap): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

/** Closed run-options equality (both keys optional; `undefined === undefined`). */
function runOptionsEqual(a: OptimizeRunOptions, b: OptimizeRunOptions): boolean {
  return a.prettify === b.prettify && a.timeout === b.timeout;
}

/** Full semantic equality across EVERY load-bearing field of the closed record. */
function recordsEqual(a: OptimizeSessionRecord, b: OptimizeSessionRecord): boolean {
  if (a.schemaVersion !== b.schemaVersion) return false;
  if (a.ownerId !== b.ownerId) return false;
  if (a.phase !== b.phase) return false;
  if (a.anonymized !== b.anonymized) return false;
  if (a.peopleCount !== b.peopleCount) return false;
  if (!runOptionsEqual(a.runOptions, b.runOptions)) return false;
  if (!reverseMapsEqual(a.reverseMap, b.reverseMap)) return false;
  if (a.phase === "active" && b.phase === "active") {
    if (a.jobId !== b.jobId) return false;
    // `undefined === undefined` treats an absent cursor as equal on both sides.
    if (a.lastCursor !== b.lastCursor) return false;
  }
  return true;
}

/**
 * Serialize a locally built record ONLY if it passes the closed runtime schema
 * AND round-trips through the codec back to a SEMANTICALLY IDENTICAL owned record
 * — every option, count, tuple, flag, owner, phase, and job id. Returns the
 * bytes, or null if the record is invalid or the codec is lossy/lying (even a
 * codec that emits a DIFFERENT but schema-valid record) — so a wrong recovery
 * payload can never reach `setItem`.
 */
function serializeOwnedRecord(record: OptimizeSessionRecord, codec: SessionCodec): string | null {
  if (parseSession(record) === null) return null;
  let serialized: string;
  try {
    serialized = codec.serialize(record);
  } catch {
    return null;
  }
  const decoded = decodeRecord(serialized, codec);
  if (decoded === null || !recordsEqual(decoded, record)) return null;
  return serialized;
}

// --- staging (before POST) -------------------------------------------------

export type StageProvisionalOutcome =
  | { status: "staged"; record: ProvisionalOptimizeSession }
  // Plain run: the key is proven absent but the record is not durable — proceed
  // with no recovery (there is no map to lose).
  | { status: "proceed-without-recovery"; reason: StageFailureReason }
  | { status: "blocked"; reason: StageFailureReason };

/**
 * Synchronously stage the provisional record before `POST`, with writer
 * validation and read-back verification. Staging is NON-DESTRUCTIVE: it never
 * clears the key. Any existing value — a valid provisional/active record owned
 * by another (possibly still in-flight) transaction, OR unreadable bytes — is a
 * `session-conflict` that blocks with zero `setItem`/`removeItem`, so a second
 * submission can never erase a first submission's only durable recovery map.
 * Clearing an inspected reload record uses `forgetInspectedSession`; transaction
 * rollback remains owner-and-variant scoped internally.
 *
 * Anonymized runs must end durable: any validation/storage/read-back failure
 * BLOCKS. Plain runs may proceed without recovery ONLY when the key is genuinely
 * empty and the (unnecessary) write fails. An invalid locally built record blocks
 * either way.
 */
export function stageProvisionalSession(
  storage: SessionTransactionStorage,
  record: ProvisionalOptimizeSession,
  codec: SessionCodec = defaultCodec,
): StageProvisionalOutcome {
  // Writer validation FIRST: never submit behind an invalid recovery record.
  const serialized = serializeOwnedRecord(record, codec);
  if (serialized === null) return { status: "blocked", reason: "invalid-record" };

  const blockOrProceed = (reason: StageFailureReason): StageProvisionalOutcome =>
    record.anonymized
      ? { status: "blocked", reason }
      : { status: "proceed-without-recovery", reason };

  // Non-destructive occupancy check: the slot must be genuinely empty. A present
  // record (valid or unreadable) is a conflict — never removed, never overwritten.
  const pre = readCurrent(storage, codec);
  if (!pre.ok || pre.raw !== null) {
    return { status: "blocked", reason: "session-conflict" };
  }

  const write = guardedSet(storage, serialized);
  if (!write.ok) {
    // The key is proven absent (reconciled above); a plain run may proceed.
    return blockOrProceed(write.reason);
  }

  // Classify one post-write snapshot. Exact bytes succeed; proven empty is a
  // durability failure; every non-empty or unreadable mismatch is a conflict.
  const afterWrite = readCurrent(storage, codec);
  if (afterWrite.ok && afterWrite.raw === serialized) {
    return { status: "staged", record };
  }
  if (afterWrite.ok && afterWrite.raw === null) {
    return blockOrProceed("read-back-failed");
  }
  return { status: "blocked", reason: "session-conflict" };
}

// --- activation (after 202) ------------------------------------------------

/** Why an activation could not be verified as durable (reload recovery is
 *  unavailable in both cases; the job + map remain usable in-tab). */
export type ActivationUnverifiedReason = "owner-conflict" | "storage-unknown";

export type ActivateOutcome =
  | { status: "activated"; record: ActiveOptimizeSession }
  // Our provisional record is proven durable: degraded in-tab, reload=interrupted.
  | { status: "activation-persistence-failed"; volatile: VolatileActivation }
  // The durable state could not be proven ours: never claimed resumable/interrupted.
  | {
      status: "activation-unverified";
      volatile: VolatileActivation;
      reason: ActivationUnverifiedReason;
    };

function volatileFrom(provisional: ProvisionalOptimizeSession, jobId: string): VolatileActivation {
  return {
    jobId,
    anonymized: provisional.anonymized,
    peopleCount: provisional.peopleCount,
    reverseMap: provisional.reverseMap,
    reloadRecoveryUnavailable: true,
  };
}

function ownsProvisional(record: OptimizeSessionRecord | null, ownerId: string): boolean {
  return record !== null && record.phase === "provisional" && record.ownerId === ownerId;
}

/**
 * After a successful `202`, synchronously replace OUR provisional record with the
 * active job-id record — compare-and-act on the exact owned provisional so a
 * concurrent transaction that superseded the key is never overwritten.
 *
 * The write is verified by read-back. A throwing/partial active write is
 * reconciled by reading the key back: our exact active bytes ⇒ activated (the
 * write landed before the throw); our provisional still present ⇒ degraded
 * (reload=interrupted); the key missing ⇒ restore the provisional only with a
 * verified write, else report the state unknown; a foreign/unreadable value is
 * left untouched and reported as a conflict — never as a resumable job.
 */
export function activateSession(
  storage: SessionTransactionStorage,
  provisional: ProvisionalOptimizeSession,
  jobId: string,
  codec: SessionCodec = defaultCodec,
): ActivateOutcome {
  const volatile = volatileFrom(provisional, jobId);

  // Build + writer-validate the active record BEFORE touching storage.
  if (!isValidJobId(jobId)) {
    return { status: "activation-persistence-failed", volatile };
  }
  const active: ActiveOptimizeSession = { ...provisional, phase: "active", jobId };
  const serializedActive = serializeOwnedRecord(active, codec);
  if (serializedActive === null) {
    return { status: "activation-persistence-failed", volatile };
  }

  // Replace only our provisional record, or a slot still proven empty.
  const cur = readCurrent(storage, codec);
  if (!cur.ok) {
    return {
      status: "activation-unverified",
      volatile,
      reason: "storage-unknown",
    };
  }
  if (cur.record !== null) {
    // Idempotent: our active is already durable.
    if (
      cur.record.phase === "active" &&
      cur.record.ownerId === provisional.ownerId &&
      cur.record.jobId === jobId
    ) {
      return { status: "activated", record: active };
    }
    if (!ownsProvisional(cur.record, provisional.ownerId)) {
      return {
        status: "activation-unverified",
        volatile,
        reason: "owner-conflict",
      };
    }
  } else if (cur.raw !== null) {
    // Unreadable garbage occupies the key — do not overwrite blindly.
    return {
      status: "activation-unverified",
      volatile,
      reason: "owner-conflict",
    };
  }

  // We own the provisional, or the key is genuinely empty: write the active record.
  guardedSet(storage, serializedActive);
  // Reconcile one post-write snapshot against what is actually durable.
  const after = readCurrent(storage, codec);
  if (!after.ok) {
    return {
      status: "activation-unverified",
      volatile,
      reason: "storage-unknown",
    };
  }
  if (after.raw === serializedActive) {
    // Write-then-throw: our exact active bytes landed → genuinely resumable.
    return { status: "activated", record: active };
  }
  if (ownsProvisional(after.record, provisional.ownerId)) {
    // Our provisional survived → degraded, reload=interrupted.
    return { status: "activation-persistence-failed", volatile };
  }
  if (after.raw === null) {
    // Missing: restore the provisional ONLY with a verified write/read-back.
    const serializedProvisional = serializeOwnedRecord(provisional, codec);
    if (serializedProvisional !== null) {
      const restoreWrite = guardedSet(storage, serializedProvisional);
      const restoreRead = readCurrent(storage, codec);
      if (restoreWrite.ok && restoreRead.ok && restoreRead.raw === serializedProvisional) {
        return { status: "activation-persistence-failed", volatile };
      }
    }
    return {
      status: "activation-unverified",
      volatile,
      reason: "storage-unknown",
    };
  }
  // A foreign/unreadable value now holds the key — never overwrite or claim it.
  return {
    status: "activation-unverified",
    volatile,
    reason: "owner-conflict",
  };
}

// --- active cursor persistence (during a resumed run) ----------------------

/** The closed result of persisting (or clearing) an active record's resume cursor. */
export type UpdateActiveCursorOutcome =
  | { status: "updated"; record: ActiveOptimizeSession }
  // The slot no longer holds an active record for this job (gone / superseded /
  // a different job / unreadable). Non-fatal: the next commit retries.
  | { status: "stale" }
  // Storage could not be read, or the write could not be proven durable.
  | { status: "unverified" }
  // The cursor violated the structural byte cap and was refused (never written).
  // Distinct from `stale` (record gone) and `unverified` (I/O): the record is
  // healthy, only the cursor was rejected. Non-fatal — durability is not claimed.
  | { status: "rejected" };

/** Return the active record with its cursor removed (no `lastCursor: undefined` key). */
function withoutCursor(record: ActiveOptimizeSession): ActiveOptimizeSession {
  if (record.lastCursor === undefined) return record;
  const { lastCursor: _omit, ...rest } = record;
  return rest;
}

/**
 * Persist the last committed opaque cursor onto the durable ACTIVE record for
 * `jobId`, or clear it when `cursor` is null (an expired/invalid cursor reset).
 * Job-scoped, not owner-scoped: the cursor belongs to the resumed job, and the
 * stored owner id is deliberately not treated as caller authorization after a
 * reload. The record is re-read immediately before the write (no `await` in the
 * critical section), rebuilt from the CURRENT durable record so a concurrent
 * field change is never clobbered, writer-validated, and verified by read-back —
 * so a stale/foreign/unreadable slot is never overwritten and a partial write is
 * never reported as durable.
 */
export function updateActiveCursor(
  storage: SessionTransactionStorage,
  jobId: string,
  cursor: string | null,
  codec: SessionCodec = defaultCodec,
): UpdateActiveCursorOutcome {
  const cur = readCurrent(storage, codec);
  if (!cur.ok) return { status: "unverified" };
  const record = cur.record;
  if (record === null || record.phase !== "active" || record.jobId !== jobId) {
    return { status: "stale" };
  }

  // Never persist an oversized opaque cursor. Unreachable on the real path (only a
  // cursor validated by the stream's `checkCursor` boundary before application ever
  // reaches `onCursorCommit`), this is a defense-in-depth seam:
  // a poison cursor is never written, so a later reload cannot re-send it as a
  // `Last-Event-ID` header. Surfaced as `rejected` (the record is healthy, only
  // the cursor was refused) — NOT `stale`, which would wrongly imply the slot is
  // gone and trigger a refresh. Non-fatal: durability is simply not claimed.
  if (cursor !== null && !withinUtf8Bytes(cursor, MAX_CURSOR_BYTES)) return { status: "rejected" };

  const nextCursor = isNonEmptyString(cursor) ? cursor : undefined;
  // No-op fast path: the durable cursor already matches; skip a redundant write.
  if (record.lastCursor === nextCursor) return { status: "updated", record };

  const updated: ActiveOptimizeSession =
    nextCursor === undefined ? withoutCursor(record) : { ...record, lastCursor: nextCursor };
  const serialized = serializeOwnedRecord(updated, codec);
  if (serialized === null) return { status: "unverified" };

  const write = guardedSet(storage, serialized);
  if (!write.ok) return { status: "unverified" };
  const after = readCurrent(storage, codec);
  if (after.ok && after.raw === serialized) return { status: "updated", record: updated };
  return { status: "unverified" };
}

export type ClearInvalidCursorOutcome =
  | { status: "cleared"; record: ActiveOptimizeSession }
  // Nothing to clear: no record, a different job, or not this recoverable case
  // (already clean, or other corruption that stays unreadable).
  | { status: "none" }
  // Storage could not be read, or the rewrite could not be proven durable.
  | { status: "unverified" };

/**
 * Durably drop an oversized saved cursor from the persisted ACTIVE record for
 * `jobId`, verified by read-back. This is the verified persistence seam for the
 * invalid-cursor recovery: only when the on-disk record's SOLE defect is an oversized
 * cursor (via `decodeActiveWithInvalidCursor`) and it belongs to `jobId` does it
 * rewrite the record cursor-less, so a later reload sees a clean resumable session
 * instead of re-entering recovery. Job-scoped, not owner-authorized. `none` when
 * there is nothing to clear; `unverified` when the write could not be proven.
 */
export function clearInvalidActiveCursor(
  storage: SessionTransactionStorage,
  jobId: string,
  codec: SessionCodec = defaultCodec,
): ClearInvalidCursorOutcome {
  const read = guardedGet(storage);
  if (!read.ok) return { status: "unverified" };
  if (read.raw === null) return { status: "none" };
  const recovered = decodeActiveWithInvalidCursor(read.raw, codec);
  if (recovered === null || recovered.jobId !== jobId) return { status: "none" };

  const serialized = serializeOwnedRecord(recovered, codec);
  if (serialized === null) return { status: "unverified" };
  const write = guardedSet(storage, serialized);
  if (!write.ok) return { status: "unverified" };
  const after = readCurrent(storage, codec);
  return after.ok && after.raw === serialized
    ? { status: "cleared", record: recovered }
    : { status: "unverified" };
}

/** A record we expect to own before removing it: exact owner AND variant. */
interface ExpectedRecord {
  ownerId: string;
  phase: "provisional" | "active";
}

/** The closed result of an owner-scoped removal. */
type RemovalOutcome =
  | { status: "removed" }
  // The key was already empty.
  | { status: "absent" }
  // The key holds a foreign owner, the wrong variant, or unreadable bytes — left
  // untouched.
  | { status: "owner-or-variant-conflict" }
  // Storage could not be read, or the record survived the removal (no-op/partial/
  // throwing remove) — absence is NOT proven.
  | { status: "unverified" };

/** Closed evidence returned by the in-tab degraded cleanup authority. */
export type DegradedCleanupOutcome =
  | { status: "removed"; variant: "provisional" | "active" }
  | { status: "absent" }
  | {
      status: "conflict";
      evidence: "foreign-provisional" | "foreign-active" | "owned-active-other-job" | "unreadable";
    }
  | { status: "unverified"; operation: "read" | "remove-or-verify" };

/**
 * An OPAQUE, in-tab authority to remove the exact record a degraded post-202
 * activation may have left behind. It captures only the transaction owner and the
 * accepted job id. That is enough to authorize either the owned provisional or the
 * owned active record when the active write landed but its read-back was unavailable.
 * A foreign record is never authorized by job id alone. This is not reload authority:
 * it is never persisted or reconstructed.
 */
export type PreparedDegradedCleanup = () => DegradedCleanupOutcome;

function removeDegradedRecord(
  storage: SessionTransactionStorage,
  expected: { ownerId: string; jobId: string },
  codec: SessionCodec,
): DegradedCleanupOutcome {
  const current = readCurrent(storage, codec);
  if (!current.ok) return { status: "unverified", operation: "read" };
  if (current.raw === null) return { status: "absent" };
  const record = current.record;
  if (record === null) return { status: "conflict", evidence: "unreadable" };

  if (record.ownerId !== expected.ownerId) {
    return {
      status: "conflict",
      evidence: record.phase === "active" ? "foreign-active" : "foreign-provisional",
    };
  }

  let variant: "provisional" | "active";
  if (record.phase === "provisional") {
    variant = "provisional";
  } else if (record.jobId === expected.jobId) {
    variant = "active";
  } else {
    return { status: "conflict", evidence: "owned-active-other-job" };
  }

  guardedRemove(storage);
  const after = readCurrent(storage, codec);
  if (after.ok && after.raw === null) return { status: "removed", variant };
  return { status: "unverified", operation: "remove-or-verify" };
}

/**
 * Remove the key ONLY when it currently holds the exact expected owner + variant,
 * then verify the postcondition synchronously: success is reported only once the
 * key is proven absent by read-back. A foreign / wrong-phase / unreadable record
 * is never deleted, and a no-op/partial/throwing removal is reported `unverified`
 * rather than a false clean removal.
 */
function removeOwnedRecord(
  storage: SessionTransactionStorage,
  expected: ExpectedRecord,
  codec: SessionCodec,
): RemovalOutcome {
  const cur = readCurrent(storage, codec);
  if (!cur.ok) return { status: "unverified" };
  if (cur.raw === null) return { status: "absent" };
  const record = cur.record;
  if (record === null || record.ownerId !== expected.ownerId || record.phase !== expected.phase) {
    return { status: "owner-or-variant-conflict" };
  }
  // Attempt removal, then PROVE absence (a throwing/no-op/partial remove leaves
  // the record behind and must not be reported as clean).
  guardedRemove(storage);
  const after = readCurrent(storage, codec);
  if (after.ok && after.raw === null) return { status: "removed" };
  return { status: "unverified" };
}

// --- submit seam + full transaction ---------------------------------------

/** The closed result the injected submit MUST return (or throw, treated as
 *  acceptance-unknown). Separates a known non-acceptance from an ambiguous
 *  transport/body/consumer failure. */
export type SubmitResult =
  | { status: "accepted"; jobId: string }
  | { status: "definitely-rejected"; error: unknown }
  | { status: "acceptance-unknown"; error: unknown };

export interface RunSubmissionTransactionDeps {
  storage: SessionTransactionStorage;
  /** Perform the `POST /api/optimize`; resolve with a CLOSED submit result. A
   *  thrown error is treated as `acceptance-unknown`. */
  submit: () => Promise<SubmitResult>;
  codec?: SessionCodec;
}

export type SubmissionTransactionOutcome =
  // Could not durably stage before POST (anonymized) or a session conflict.
  | { status: "blocked-before-post"; reason: StageFailureReason }
  // The POST is known not to have created a job. `rollback` reports whether our
  // provisional record was actually removed — a superseding run (owner conflict)
  // or a failed removal (unverified) is surfaced, never a false clean rollback.
  | {
      status: "submit-rejected";
      error: unknown;
      rollback: RemovalOutcome["status"];
    }
  // The POST outcome is ambiguous: the map is retained, recovery is interrupted/
  // retention — a server job may exist and the pre-202 rollback must not run.
  | { status: "acceptance-unknown"; error: unknown }
  // 202 accepted and the active record persisted; the session is resumable.
  | { status: "activated"; record: ActiveOptimizeSession }
  // 202 accepted but the active write failed; degraded in-tab-only recovery. The
  // The durable slot may hold this transaction's provisional or an active write whose
  // verification failed; `cleanupDegraded` classifies both through exact authority.
  | {
      status: "activation-persistence-failed";
      volatile: VolatileActivation;
      cleanupDegraded: PreparedDegradedCleanup;
    }
  // 202 accepted but durable state could not be proven ours (superseded/unknown).
  | {
      status: "activation-unverified";
      volatile: VolatileActivation;
      reason: ActivationUnverifiedReason;
      cleanupDegraded: PreparedDegradedCleanup;
    };

/**
 * Run the full stage → submit → activate transaction. The `submit` closure owns
 * the request (and the prepared YAML); this function owns only the durable
 * recovery record and its owner-scoped reconciliation against a CLOSED submit
 * outcome. The only `await` is the `submit()` call — every storage mutation runs
 * in a synchronous, owner-checked critical section afterwards.
 */
export async function runSubmissionTransaction(
  record: ProvisionalOptimizeSession,
  deps: RunSubmissionTransactionDeps,
): Promise<SubmissionTransactionOutcome> {
  const codec = deps.codec ?? defaultCodec;

  const staged = stageProvisionalSession(deps.storage, record, codec);
  if (staged.status === "blocked") {
    return { status: "blocked-before-post", reason: staged.reason };
  }

  let result: SubmitResult;
  try {
    result = await deps.submit();
  } catch (error) {
    // A thrown error is acceptance-unknown: the server may have accepted the job.
    result = { status: "acceptance-unknown", error };
  }

  if (result.status === "definitely-rejected") {
    // Known not accepted: owner+variant-scoped removal, verified by read-back, and
    // always classified against the CURRENT slot (never hard-coded). It removes
    // ONLY our own provisional; an empty slot reports `absent`, a superseding run
    // reports `owner-or-variant-conflict`, and a failed clear reports `unverified`
    // — so a plain run that proceeded without durable staging still describes the
    // real durable state.
    const rollbackOutcome = removeOwnedRecord(
      deps.storage,
      { ownerId: record.ownerId, phase: "provisional" },
      codec,
    );
    const rollback = rollbackOutcome.status;
    return { status: "submit-rejected", error: result.error, rollback };
  }

  if (result.status === "acceptance-unknown") {
    // Ambiguous: retain the map (never roll back). Our provisional stays the
    // reload target (classified interrupted) unless a superseding run replaced it.
    return { status: "acceptance-unknown", error: result.error };
  }

  // Accepted — validate the job id before activation.
  if (!isValidJobId(result.jobId)) {
    return {
      status: "acceptance-unknown",
      error: new Error("Optimize submission accepted without a usable job id."),
    };
  }

  const activated = activateSession(deps.storage, record, result.jobId, codec);
  if (activated.status === "activated") {
    return { status: "activated", record: activated.record };
  }
  // Degraded: verification could have failed before or after the active write landed.
  // Bind cleanup to the exact owner + accepted job so it can safely remove either
  // legitimate owned variant while preserving every foreign/wrong/unreadable record.
  const cleanupDegraded: PreparedDegradedCleanup = () =>
    removeDegradedRecord(deps.storage, { ownerId: record.ownerId, jobId: result.jobId }, codec);
  if (activated.status === "activation-persistence-failed") {
    return {
      status: "activation-persistence-failed",
      volatile: activated.volatile,
      cleanupDegraded,
    };
  }
  return {
    status: "activation-unverified",
    volatile: activated.volatile,
    reason: activated.reason,
    cleanupDegraded,
  };
}

// --- reload classification -------------------------------------------------

const SESSION_RECORD_IDENTITY = Symbol("optimize-session-record-identity");

/** Opaque identity for the exact bytes observed during inspection. Callers may
 * retain and return it, but only T16q can read or construct it. */
export interface SessionRecordIdentity {
  readonly [SESSION_RECORD_IDENTITY]: string;
}

export const FORGET_OPTIMIZE_SESSION_WARNING =
  "Forgetting this recovery record does not cancel the backend job. An unknown backend optimization may continue until terminal state or server retention.";

export type InspectedSession =
  | { kind: "none" }
  // An orphan provisional record: an interrupted submission. Not resumable; the
  // only safe action is to discard it (server retention handles any accepted job
  // from the unknowable after-202/before-id-write crash window).
  | {
      kind: "interrupted";
      record: ProvisionalOptimizeSession;
      identity: SessionRecordIdentity;
    }
  // An active record with an accepted job id — a resumable session. `cursorReset` is
  // true when the otherwise-valid record carried an oversized saved cursor: the
  // record here has that cursor stripped, so recovery resumes from the retained floor
  // and enters explicit invalid-cursor recovery rather than the Forget flow.
  | {
      kind: "resumable";
      record: ActiveOptimizeSession;
      identity: SessionRecordIdentity;
      cursorReset?: boolean;
    }
  // A corrupt, incomplete, or version-mismatched record; discardable, never resumable.
  | { kind: "unreadable"; identity: SessionRecordIdentity | null };

export type ForgetInspectedSessionOutcome =
  | { status: "removed" }
  | { status: "changed" }
  | { status: "unverified" };

function recordIdentity(raw: string): SessionRecordIdentity {
  return Object.freeze({ [SESSION_RECORD_IDENTITY]: raw });
}

const COMMON_KEYS = [
  "schemaVersion",
  "ownerId",
  "phase",
  "anonymized",
  "runOptions",
  "peopleCount",
  "reverseMap",
] as const;
const PROVISIONAL_KEYS = new Set<string>(COMMON_KEYS);
// The active variant requires the provisional keys plus `jobId`, and optionally
// carries `lastCursor` (absent until the resumed stream commits its first frame).
const ACTIVE_REQUIRED_KEYS = new Set<string>([...COMMON_KEYS, "jobId"]);
const ACTIVE_ALLOWED_KEYS = new Set<string>([...COMMON_KEYS, "jobId", "lastCursor"]);
const RUN_OPTION_KEYS = new Set<string>(["prettify", "timeout"]);

function hasExactKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

/** Every present key is allowed AND every required key is present (allows optionals). */
function hasAllowedKeys(
  record: Record<string, unknown>,
  required: Set<string>,
  allowed: Set<string>,
): boolean {
  const keys = Object.keys(record);
  if (!keys.every((key) => allowed.has(key))) return false;
  for (const key of required) {
    if (!(key in record)) return false;
  }
  return true;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidRunOptions(value: unknown): value is OptimizeRunOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  if (!Object.keys(options).every((key) => RUN_OPTION_KEYS.has(key))) return false;
  if ("prettify" in options && typeof options.prettify !== "boolean") return false;
  if ("timeout" in options) {
    const timeout = options.timeout;
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < OPTIMIZE_TIMEOUT_MIN_SECONDS ||
      timeout > OPTIMIZE_TIMEOUT_MAX_SECONDS
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Strictly validate an untrusted value as a session record, returning the typed
 * record or `null`. Closed schema: exact keys per variant, current schema version
 * only (future/unknown versions are unreadable), non-empty owner id, non-negative
 * integer people count, closed run options within the settled timeout bounds, and
 * a consistent anonymized/reverse-map invariant validated as a strict people-only
 * tuple map (unique well-formed `P#` ids, unique typed finite-integer/string
 * originals, cardinality equal to the people count). Shared by the reload reader
 * AND the writer-side pre-write validation.
 */
function parseSession(value: unknown): OptimizeSessionRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;

  if (candidate.schemaVersion !== OPTIMIZE_SESSION_SCHEMA_VERSION) return null;
  if (typeof candidate.ownerId !== "string" || candidate.ownerId.length === 0) return null;
  if (typeof candidate.anonymized !== "boolean") return null;
  if (!isNonNegativeInteger(candidate.peopleCount)) return null;
  if (!isValidRunOptions(candidate.runOptions)) return null;

  // The reverse map must be a valid tuple map whose cardinality matches: exactly
  // the people count for an anonymized run, and empty for a plain run.
  const expectedMapSize = candidate.anonymized ? (candidate.peopleCount as number) : 0;
  const reverseMap = validatePeopleReverseMap(candidate.reverseMap, expectedMapSize);
  if (reverseMap === null) return null;

  if (candidate.phase === "provisional") {
    if (!hasExactKeys(candidate, PROVISIONAL_KEYS)) return null;
    return { ...(candidate as unknown as ProvisionalOptimizeSession), reverseMap };
  }
  if (candidate.phase === "active") {
    if (!hasAllowedKeys(candidate, ACTIVE_REQUIRED_KEYS, ACTIVE_ALLOWED_KEYS)) return null;
    if (!isValidJobId(candidate.jobId)) return null;
    // A present cursor must be a non-empty string WITHIN the opaque-cursor byte
    // cap; a persisted record never stores `undefined` (JSON drops it), so the key
    // is either absent or a real cursor. An oversized persisted cursor (corrupted
    // or foreign) makes the whole record unreadable — fail closed rather than
    // reload it and re-send it as a `Last-Event-ID` header.
    if (
      "lastCursor" in candidate &&
      !isNonEmptyStringWithin(candidate.lastCursor, MAX_CURSOR_BYTES)
    )
      return null;
    return { ...(candidate as unknown as ActiveOptimizeSession), reverseMap };
  }
  return null;
}

/**
 * Decode a raw record whose ONLY invalidity is an oversized saved cursor: an
 * otherwise fully valid ACTIVE session (identity, anonymization map, run options)
 * carrying a `lastCursor` that is a non-empty string past the byte cap. Returns that
 * active record with the cursor STRIPPED, or `null` for anything else (a within-cap
 * cursor, a structurally garbage cursor, or any other corruption — all of which stay
 * generically unreadable). The rest is validated by the strict `parseSession` on a
 * cursor-less copy, so a second defect never masquerades as this recoverable case.
 */
function decodeActiveWithInvalidCursor(
  raw: string,
  codec: SessionCodec,
): ActiveOptimizeSession | null {
  let value: unknown;
  try {
    value = codec.deserialize(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  // The distinguishing defect: a present, non-empty-string cursor OVER the cap.
  if (typeof candidate.lastCursor !== "string" || candidate.lastCursor.length === 0) return null;
  if (isNonEmptyStringWithin(candidate.lastCursor, MAX_CURSOR_BYTES)) return null;
  // Everything else must be a valid active record. Strip the cursor and re-validate.
  const { lastCursor: _oversized, ...rest } = candidate;
  const parsed = parseSession(rest);
  return parsed !== null && parsed.phase === "active" ? parsed : null;
}

/**
 * Classify whatever the current tab's storage holds on load. A missing key is
 * `none`; a well-formed provisional record is an `interrupted` submission (never
 * resumed — it may hide an accepted job the server owns); a well-formed active
 * record is `resumable`; anything unparseable, incomplete, or version-mismatched
 * is `unreadable` and can be safely discarded. A read that throws is unreadable.
 */
export function inspectPersistedSession(
  storage: SessionTransactionStorage,
  codec: SessionCodec = defaultCodec,
): InspectedSession {
  const read = guardedGet(storage);
  if (!read.ok) return { kind: "unreadable", identity: null };
  if (read.raw === null) return { kind: "none" };

  const record = decodeRecord(read.raw, codec);
  const identity = recordIdentity(read.raw);
  if (record === null) {
    // Distinguish an otherwise-valid active session whose ONLY defect is an oversized
    // saved cursor from generic corruption: it stays resumable (cursor stripped, so it
    // resumes from the retained floor) and enters explicit invalid-cursor recovery.
    // Every other unreadable record keeps the confirmed Forget flow.
    const recovered = decodeActiveWithInvalidCursor(read.raw, codec);
    if (recovered !== null)
      return { kind: "resumable", record: recovered, identity, cursorReset: true };
    return { kind: "unreadable", identity };
  }
  return record.phase === "provisional"
    ? { kind: "interrupted", record, identity }
    : { kind: "resumable", record, identity };
}

/**
 * Remove the exact record returned by `inspectPersistedSession`, without treating
 * its stored owner id as caller authorization. A changed record is preserved.
 * Success is returned only after the slot is synchronously verified absent.
 */
export function forgetInspectedSession(
  storage: SessionTransactionStorage,
  identity: SessionRecordIdentity,
): ForgetInspectedSessionOutcome {
  const expectedRaw = identity[SESSION_RECORD_IDENTITY];
  const current = guardedGet(storage);
  if (!current.ok) return { status: "unverified" };
  if (current.raw === null) return { status: "removed" };
  if (current.raw !== expectedRaw) return { status: "changed" };

  guardedRemove(storage);
  const after = guardedGet(storage);
  if (!after.ok) return { status: "unverified" };
  if (after.raw === null) return { status: "removed" };
  return { status: after.raw === expectedRaw ? "unverified" : "changed" };
}
