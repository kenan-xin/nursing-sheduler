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

/** Bump when the record shape changes; a mismatched version is not resumable.
 *  v2 adds the F2 `capture` authority (the roster submission-snapshot ref and its
 *  origin-wide ordinal, or the reason capture is unavailable for this run). A v1
 *  record predates roster capture and is deliberately NOT migrated: it is read as
 *  unreadable, exactly like any other unknown shape. */
export const OPTIMIZE_SESSION_SCHEMA_VERSION = 2;

/**
 * The LEGACY single-slot key.
 *
 * One key meant one run at a time, and that was load-bearing in the worst way:
 * `stageProvisionalSession` refuses an occupied slot, so an older run that had
 * not finished proving its cleanup literally occupied the next submission. That
 * is why `Optimize` could be disabled by a run the user had already walked away
 * from. Records are now keyed per owner (below); this constant remains because a
 * record written by an earlier build can still be sitting here, and because
 * Clear must keep removing it.
 */
export const OPTIMIZE_SESSION_STORAGE_KEY = "nurse.optimize.session";

/**
 * The prefix each owner-keyed record lives under: `nurse.optimize.session.<ownerId>`.
 *
 * Deliberately a child of the legacy key's namespace so one prefix sweep covers
 * both shapes, and deliberately keyed by the SAME opaque `ownerId` the immutable
 * submission snapshot uses — so a record and the snapshot it points at are
 * addressable by one identity, and cleanup for one owner can never name another's.
 */
export const OPTIMIZE_SESSION_KEY_PREFIX = `${OPTIMIZE_SESSION_STORAGE_KEY}.`;

/** The storage key holding the record for exactly this owner. */
export function optimizeSessionKeyFor(ownerId: string): string {
  return `${OPTIMIZE_SESSION_KEY_PREFIX}${ownerId}`;
}

// Settled Optimize timeout bounds (backend: `optimize.py` rejects `<= 0` or
// `> max_timeout_seconds`, whose default is `60 * 60`).
export const OPTIMIZE_TIMEOUT_MIN_SECONDS = 1;
export const OPTIMIZE_TIMEOUT_MAX_SECONDS = 60 * 60;

/** Backend run options carried across a reload so a resume submits identically. */
export interface OptimizeRunOptions {
  prettify?: boolean;
  timeout?: number;
}

/** Why a run has no durable exact-submission authority, and so no roster capture. */
export type CaptureUnavailableReason = "snapshot_persist_failed";

/**
 * The F2 roster-capture authority carried by the session record. Modelled as a
 * discriminated union rather than a bag of nullable fields so a "staged" record
 * without an ordinal, or an "unavailable" record that still claims a snapshot,
 * is not representable at all.
 *
 * `snapshotRef` is the transaction's `ownerId` — stable, known before the POST,
 * and the key F1 stores the immutable snapshot under. It is stored explicitly
 * rather than re-derived from `ownerId` so the record states plainly whether a
 * snapshot was ever durably staged for this run.
 */
export type SessionCaptureState =
  | { status: "staged"; snapshotRef: string; submissionOrdinal: number }
  | { status: "unavailable"; reason: CaptureUnavailableReason };

interface OptimizeSessionCommon {
  schemaVersion: typeof OPTIMIZE_SESSION_SCHEMA_VERSION;
  /** Unique per transaction; proves a read-back record is ours before we mutate. */
  ownerId: string;
  anonymized: boolean;
  runOptions: OptimizeRunOptions;
  peopleCount: number;
  /** Ordered `[anonymizedId, originalId]` tuples; empty for a plain run. */
  reverseMap: PeopleReverseMap;
  /**
   * Whether this run staged a durable exact-submission snapshot before its POST.
   * Written once, before staging, and never mutated afterwards — activation and
   * cursor updates rebuild the record from the CURRENT durable one, so this field
   * survives them verbatim.
   */
  capture: SessionCaptureState;
}

/** Written before `POST`; a reload finding this means an interrupted submission. */
export interface ProvisionalOptimizeSession extends OptimizeSessionCommon {
  phase: "provisional";
}

/**
 * The provisional payload plus the accepted job id.
 *
 * G6.2 removed the persisted resume cursor. It existed for exactly one purpose —
 * seeding a reloaded page's `Last-Event-ID` so a run could be resumed across a
 * reload — and reload-resume is gone: a fresh route entry never reattaches to an
 * older run. The in-visit stream still tracks its cursor, in memory, where it
 * belongs; nothing durable needs to survive the visit that owns it.
 */
export interface ActiveOptimizeSession extends OptimizeSessionCommon {
  phase: "active";
  jobId: string;
}

export type OptimizeSessionRecord = ProvisionalOptimizeSession | ActiveOptimizeSession;

/** The minimal `Storage` subset used, so tests inject a plain object. */
export interface SessionTransactionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /**
   * Enumeration, as the real `Storage` provides it.
   *
   * Owner-keyed records mean Clear can no longer name every key it must remove.
   * The tempting alternative — `sessionStorage.clear()` — is not open to us: this
   * is a shared tab-scoped store, and a roster privacy action has no business
   * destroying keys other features own. So Clear enumerates and removes exactly
   * the optimize keys.
   *
   * Optional only so the many single-key test doubles that predate owner-keying
   * need not all grow an enumeration they never exercise. A store that cannot be
   * enumerated is treated as residue UNKNOWN — never as an empty one — so the
   * looser type cannot turn into a false purge claim.
   */
  readonly length?: number;
  key?(index: number): string | null;
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

/**
 * The in-tab state retained when the accepted job has no durable record behind it.
 * The job and its reverse map stay usable for the lifetime of the current visit.
 *
 * G6.2d dropped `reloadRecoveryUnavailable: true`. It was a hard-coded flag naming
 * a capability that no longer exists in either direction — no activation makes a
 * run resumable across a reload, so none of them needs to say it does not.
 */
export interface VolatileActivation {
  jobId: string;
  anonymized: boolean;
  peopleCount: number;
  reverseMap: PeopleReverseMap;
}

// --- guarded storage primitives -------------------------------------------

type GuardedRead = { ok: true; raw: string | null } | { ok: false };

// `key` is REQUIRED. It used to default to the legacy single slot, which is
// precisely how a caller could silently keep writing the one blocking record
// after records became owner-keyed. Every call now names the key it means.
function guardedGet(storage: SessionTransactionStorage, key: string): GuardedRead {
  try {
    return { ok: true, raw: storage.getItem(key) };
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

function guardedSet(storage: SessionTransactionStorage, value: string, key: string): GuardedWrite {
  try {
    storage.setItem(key, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: classifyWriteFailure(error) };
  }
}

function guardedRemove(storage: SessionTransactionStorage, key: string): boolean {
  try {
    storage.removeItem(key);
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

function readCurrent(
  storage: SessionTransactionStorage,
  codec: SessionCodec,
  key: string,
): CurrentSnapshot {
  const read = guardedGet(storage, key);
  if (!read.ok) return { ok: false };
  if (read.raw === null) return { ok: true, raw: null, record: null };
  return { ok: true, raw: read.raw, record: decodeRecord(read.raw, codec) };
}

// ---------------------------------------------------------------------------
// Owner-keyed records
// ---------------------------------------------------------------------------
//
// Everything below addresses a record by its opaque owner instead of by "the"
// slot. The point is not tidiness: it is that a run the user abandoned must be
// able to finish its cleanup WITHOUT standing between them and the next click.
// With one slot those two things were the same storage cell, so "cleanup not yet
// proven" and "you may not submit" were indistinguishable.
//
// Enumeration is only ever used for invisible exact-owner cleanup and for Clear.
// `sessionStorage` is tab-scoped, so this is not an origin-wide queue and never
// speaks for another tab.

/** Every optimize session key currently present: the legacy slot first (when
 *  present), then each owner-keyed record. `ok: false` when the store could not
 *  be enumerated — which proves nothing, least of all emptiness. */
export type SessionKeyListing = { ok: true; keys: string[] } | { ok: false };

export function listOptimizeSessionKeys(storage: SessionTransactionStorage): SessionKeyListing {
  const keys: string[] = [];
  try {
    const count = storage.length;
    const readKey = storage.key;
    // No enumeration surface at all is exactly the same situation as a throwing
    // one: nothing was observed, so nothing may be concluded.
    if (typeof count !== "number" || typeof readKey !== "function") return { ok: false };
    for (let index = 0; index < count; index += 1) {
      const key = readKey.call(storage, index);
      if (key === null) continue;
      if (key === OPTIMIZE_SESSION_STORAGE_KEY || key.startsWith(OPTIMIZE_SESSION_KEY_PREFIX)) {
        keys.push(key);
      }
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, keys };
}

/** The decoded record stored for one owner, with unreadable kept distinct from
 *  absent — an unreadable record names no trustworthy owner and is Clear-only. */
export type OwnerSessionRead =
  | { status: "found"; record: OptimizeSessionRecord; raw: string }
  | { status: "absent" }
  | { status: "unreadable"; raw: string }
  | { status: "unavailable" };

export function readOwnerSession(
  storage: SessionTransactionStorage,
  ownerId: string,
  codec: SessionCodec = defaultCodec,
): OwnerSessionRead {
  const snapshot = readCurrent(storage, codec, optimizeSessionKeyFor(ownerId));
  if (!snapshot.ok) return { status: "unavailable" };
  if (snapshot.raw === null) return { status: "absent" };
  if (snapshot.record === null) return { status: "unreadable", raw: snapshot.raw };
  return { status: "found", record: snapshot.record, raw: snapshot.raw };
}

/**
 * Remove exactly one owner's record, verified absent by read-back.
 *
 * Owner-scoped by construction: the key names the owner, so this cannot reach
 * another run's record even if the caller is confused about which run it is
 * retiring. That is the property that lets abandonment cleanup run concurrently
 * with a brand-new submission.
 */
export type RemoveOwnerSessionOutcome =
  | { status: "removed" }
  | { status: "absent" }
  | { status: "unverified" };

export function removeOwnerSession(
  storage: SessionTransactionStorage,
  ownerId: string,
): RemoveOwnerSessionOutcome {
  const key = optimizeSessionKeyFor(ownerId);
  const before = guardedGet(storage, key);
  if (!before.ok) return { status: "unverified" };
  if (before.raw === null) return { status: "absent" };
  if (!guardedRemove(storage, key)) return { status: "unverified" };
  const after = guardedGet(storage, key);
  if (!after.ok || after.raw !== null) return { status: "unverified" };
  return { status: "removed" };
}

/**
 * Move a readable legacy single-slot record to its own owner key.
 *
 * Idempotent and read-back verified, because it runs on route entry and may be
 * interrupted at any point:
 *
 *   • An EXISTING owner key always wins. It was written by the owner-keyed path
 *     and is therefore at least as current as the legacy bytes; overwriting it
 *     could replace a live run's record with a stale copy of itself.
 *   • The legacy key is removed ONLY after the target is read back and decodes to
 *     a semantically identical record. A half-done migration therefore leaves the
 *     legacy bytes in place and is simply re-run.
 *   • UNREADABLE legacy bytes name no trustworthy owner, so there is nowhere to
 *     move them and nothing that may be inferred from them. They are left for
 *     verified Clear rather than deleted here — deleting bytes we could not read
 *     is exactly how a real-identity reverse map would be lost silently.
 */
export type LegacyMigrationOutcome =
  /** Legacy bytes were copied to the owner key and the legacy key is proven gone. */
  | { status: "migrated"; ownerId: string }
  /** The owner key already held this owner's record; the legacy duplicate is gone. */
  | { status: "already-migrated"; ownerId: string }
  /** No legacy record present. */
  | { status: "none" }
  /** Present but undecodable: left untouched for verified Clear. */
  | { status: "unreadable" }
  /** Nothing was proven; both keys are left exactly as they were. */
  | { status: "unverified" };

export function migrateLegacySession(
  storage: SessionTransactionStorage,
  codec: SessionCodec = defaultCodec,
): LegacyMigrationOutcome {
  const legacy = readCurrent(storage, codec, OPTIMIZE_SESSION_STORAGE_KEY);
  if (!legacy.ok) return { status: "unverified" };
  if (legacy.raw === null) return { status: "none" };
  if (legacy.record === null) return { status: "unreadable" };

  const ownerId = legacy.record.ownerId;
  const target = optimizeSessionKeyFor(ownerId);
  const existing = readCurrent(storage, codec, target);
  if (!existing.ok) return { status: "unverified" };

  if (existing.raw !== null) {
    // PRESERVE, never overwrite. Only drop the legacy duplicate once the target is
    // proven to be a readable record for the same owner.
    if (existing.record === null || existing.record.ownerId !== ownerId) {
      return { status: "unverified" };
    }
    if (!guardedRemove(storage, OPTIMIZE_SESSION_STORAGE_KEY)) return { status: "unverified" };
    const after = guardedGet(storage, OPTIMIZE_SESSION_STORAGE_KEY);
    if (!after.ok || after.raw !== null) return { status: "unverified" };
    return { status: "already-migrated", ownerId };
  }

  // Re-serialize through the writer path rather than copying raw bytes, so the
  // migrated record is held to the same closed-schema and codec round-trip rules
  // every other write is.
  const serialized = serializeOwnedRecord(legacy.record, codec);
  if (serialized === null) return { status: "unverified" };
  if (!guardedSet(storage, serialized, target).ok) return { status: "unverified" };

  const written = readCurrent(storage, codec, target);
  if (!written.ok || written.record === null || !recordsEqual(written.record, legacy.record)) {
    // The copy is not proven. Leave the legacy key alone; re-running repairs it.
    return { status: "unverified" };
  }

  if (!guardedRemove(storage, OPTIMIZE_SESSION_STORAGE_KEY)) return { status: "unverified" };
  const legacyAfter = guardedGet(storage, OPTIMIZE_SESSION_STORAGE_KEY);
  if (!legacyAfter.ok || legacyAfter.raw !== null) return { status: "unverified" };
  return { status: "migrated", ownerId };
}

/**
 * Remove EVERY optimize session key — the legacy slot and every owner-keyed
 * record — verifying each absence. This is Clear's cut.
 *
 * Explicitly not `storage.clear()`: the tab's `sessionStorage` is shared, and a
 * roster privacy action has no authority over anything else in it. `cleared` is
 * returned only when the store could be enumerated AND every optimize key is
 * proven gone; anything else is honest failure with what remains.
 */
export interface ClearAllSessionsOutcome {
  status: "cleared" | "failed";
  /** Keys still present (or empty when the store could not be enumerated). */
  remaining: string[];
  /** False when enumeration itself failed — residue is UNKNOWN, not zero. */
  enumerated: boolean;
}

export function clearAllOptimizeSessions(
  storage: SessionTransactionStorage,
): ClearAllSessionsOutcome {
  const listing = listOptimizeSessionKeys(storage);
  if (!listing.ok) return { status: "failed", remaining: [], enumerated: false };

  for (const key of listing.keys) guardedRemove(storage, key);

  // Re-enumerate rather than trusting the removals: a store that silently no-ops
  // a `removeItem` must not be able to report a verified purge.
  const after = listOptimizeSessionKeys(storage);
  if (!after.ok) return { status: "failed", remaining: [], enumerated: false };
  return {
    status: after.keys.length === 0 ? "cleared" : "failed",
    remaining: after.keys,
    enumerated: true,
  };
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
  /** The outcome of the write-ahead snapshot transaction (F2). */
  capture: SessionCaptureState;
}): ProvisionalOptimizeSession {
  return {
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId: input.ownerId,
    phase: "provisional",
    anonymized: input.anonymized,
    runOptions: input.runOptions,
    peopleCount: input.peopleCount,
    reverseMap: input.reverseMap,
    capture: input.capture,
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

/** Closed capture equality across every field of both variants. */
function captureEqual(a: SessionCaptureState, b: SessionCaptureState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "staged" && b.status === "staged") {
    return a.snapshotRef === b.snapshotRef && a.submissionOrdinal === b.submissionOrdinal;
  }
  if (a.status === "unavailable" && b.status === "unavailable") return a.reason === b.reason;
  return false;
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
  if (!captureEqual(a.capture, b.capture)) return false;
  if (a.phase === "active" && b.phase === "active") {
    if (a.jobId !== b.jobId) return false;
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
 * Clearing an inspected reload record uses `removeInspectedSession`; transaction
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

  const key = optimizeSessionKeyFor(record.ownerId);

  const blockOrProceed = (reason: StageFailureReason): StageProvisionalOutcome =>
    record.anonymized
      ? { status: "blocked", reason }
      : { status: "proceed-without-recovery", reason };

  // Non-destructive occupancy check. It reads THIS OWNER'S key, which is what
  // makes an older run's unfinished cleanup stop being the next click's problem:
  // the two runs no longer contend for one cell, so `session-conflict` is now
  // reachable only by an owner-id collision — kept as a fail-closed guard, not as
  // a queue. A present record (valid or unreadable) is never removed or overwritten.
  const pre = readCurrent(storage, codec, key);
  if (!pre.ok || pre.raw !== null) {
    return { status: "blocked", reason: "session-conflict" };
  }

  const write = guardedSet(storage, serialized, key);
  if (!write.ok) {
    // The key is proven absent (reconciled above); a plain run may proceed.
    return blockOrProceed(write.reason);
  }

  // Classify one post-write snapshot. Exact bytes succeed; proven empty is a
  // durability failure; every non-empty or unreadable mismatch is a conflict.
  const afterWrite = readCurrent(storage, codec, key);
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
  // Our provisional record is proven durable: degraded in-tab.
  | { status: "activation-persistence-failed"; volatile: VolatileActivation }
  // The durable state could not be proven ours: never claimed as this run's.
  | {
      status: "activation-unverified";
      volatile: VolatileActivation;
      reason: ActivationUnverifiedReason;
    }
  /**
   * The exact record this transaction staged is GONE, so nothing was written.
   *
   * An empty owner key is not free space, it is EVIDENCE. Nothing empties one
   * except a retirement (route exit, `pagehide`, a superseding click) or a
   * verified Clear — all of which mean the visit that staged this submission has
   * ended. Writing the active record here would recreate the identity-bearing
   * record the exit had just cut, and on the hard-exit path there is no second
   * chance to remove it again.
   *
   * The job id travels so the caller can still cancel the exact job best-effort.
   */
  | { status: "activation-retired"; jobId: string };

function volatileFrom(provisional: ProvisionalOptimizeSession, jobId: string): VolatileActivation {
  return {
    jobId,
    anonymized: provisional.anonymized,
    peopleCount: provisional.peopleCount,
    reverseMap: provisional.reverseMap,
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
 * STAGED ACTIVATION ONLY. This function requires the record its transaction
 * staged to still be there. Call it only after `stageProvisionalSession` returned
 * `staged`; a plain run that proceeded without durable staging has no provisional
 * to replace and must stay volatile (see `runSubmissionTransaction`).
 *
 * The write is verified by read-back. A throwing/partial active write is
 * reconciled by reading the key back: our exact active bytes ⇒ activated (the
 * write landed before the throw); our provisional still present ⇒ degraded; the
 * key missing ⇒ retired; a foreign/unreadable value is left untouched and
 * reported as a conflict — never as a resumable job.
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

  // Owner-keyed: a late 202 writes its job id onto ITS OWN record and nowhere
  // else, so an activation that lands after the user has already started a newer
  // run cannot touch the newer run's record. Whether anyone is still watching is
  // the caller's question (the visit attempt), not this transaction's.
  const key = optimizeSessionKeyFor(provisional.ownerId);

  // Replace only our provisional record, or a slot still proven empty.
  const cur = readCurrent(storage, codec, key);
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
  } else {
    // GENUINELY EMPTY — and that is the answer, not permission.
    //
    // This branch used to fall through and write the active record, on the
    // reading that an empty key is free. It is not: this transaction staged its
    // provisional here before the POST, so the only things that could have
    // emptied it are a retirement or a verified Clear. Writing now would put the
    // identity-bearing record back into the key a route exit had just removed —
    // and on the `pagehide` path, where the retirement lane's snapshot purge may
    // never resume, nothing would ever remove it again.
    return { status: "activation-retired", jobId };
  }

  // We own the provisional: replace it with the active record.
  guardedSet(storage, serializedActive, key);
  // Reconcile one post-write snapshot against what is actually durable.
  const after = readCurrent(storage, codec, key);
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
    // Missing AFTER our write — the same evidence, one step later. This used to
    // restore the provisional, which is the identical repopulation the empty-key
    // branch above was doing: a key that goes from ours to absent across a single
    // synchronous write was emptied by a retirement, and putting anything back is
    // exactly what must not happen.
    return { status: "activation-retired", jobId };
  }
  // A foreign/unreadable value now holds the key — never overwrite or claim it.
  return {
    status: "activation-unverified",
    volatile,
    reason: "owner-conflict",
  };
}

// --- REMOVED: active cursor persistence ------------------------------------
//
// `updateActiveCursor` / `clearInvalidActiveCursor` wrote and repaired the durable
// resume cursor. Both existed only to make a RELOAD resume a run. G6.2 retired
// that: a fresh route entry never reattaches, so nothing reads a persisted cursor,
// and a writer with no reader is not a feature — it is a store of the user's run
// state that outlives the visit they were willing to have it for.

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

// REMOVED (G6.2d): `DegradedCleanupOutcome`, `PreparedDegradedCleanup` and
// `removeDegradedRecord`.
//
// They were an in-tab authority to remove whichever owned variant a degraded
// post-202 activation had left behind, handed to the controller's
// `prepareDegradedCleanup`. That controller method went with boot recovery in
// G6.2, and nothing took its place: the live authority is the owner-scoped
// `removeOwnedRecord` / `retireSessionRecord` pair plus verified Clear, both of
// which name the exact key rather than reasoning about variants. A second,
// unused cleanup capability is a second lifecycle vocabulary for a reader to
// mistake for the current one.

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
  const key = optimizeSessionKeyFor(expected.ownerId);
  const cur = readCurrent(storage, codec, key);
  if (!cur.ok) return { status: "unverified" };
  if (cur.raw === null) return { status: "absent" };
  const record = cur.record;
  if (record === null || record.ownerId !== expected.ownerId || record.phase !== expected.phase) {
    return { status: "owner-or-variant-conflict" };
  }
  // Attempt removal, then PROVE absence (a throwing/no-op/partial remove leaves
  // the record behind and must not be reported as clean).
  guardedRemove(storage, key);
  const after = readCurrent(storage, codec, key);
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
  // 202 accepted and the active record persisted.
  | { status: "activated"; record: ActiveOptimizeSession }
  // 202 accepted but no durable active record stands behind it — either the write
  // failed, or the run never staged one (a plain run whose staging write failed).
  // The job and its map remain usable for this visit.
  | { status: "activation-persistence-failed"; volatile: VolatileActivation }
  // 202 accepted but durable state could not be proven ours (superseded/unknown).
  | {
      status: "activation-unverified";
      volatile: VolatileActivation;
      reason: ActivationUnverifiedReason;
    }
  // 202 accepted, and the record this transaction staged is gone: the visit was
  // retired while the request was in flight. Nothing was written. The job id
  // travels so the caller can cancel the exact job best-effort.
  | { status: "activation-retired"; jobId: string };

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
      error: new Error("Optimise submission accepted without a usable job id."),
    };
  }

  // NO DURABLE STAGING, NO ACTIVATION.
  //
  // `proceed-without-recovery` is a plain run whose provisional write failed: the
  // key is proven empty and stays that way. There is no provisional for activation
  // to replace, and an empty key is not this transaction's to fill — filling it is
  // exactly the repopulation `activateSession` now refuses. So the accepted job
  // stays volatile instead, which is what "no durable record behind it" means.
  //
  // Expressed as "don't call it" rather than as a second activation mode: an
  // activation that writes into an empty key should not exist at all, and a mode
  // flag is something a later caller can pass.
  if (staged.status !== "staged") {
    return {
      status: "activation-persistence-failed",
      volatile: volatileFrom(record, result.jobId),
    };
  }

  const activated = activateSession(deps.storage, record, result.jobId, codec);
  if (activated.status === "activated") {
    return { status: "activated", record: activated.record };
  }
  if (activated.status === "activation-retired") {
    return { status: "activation-retired", jobId: activated.jobId };
  }
  if (activated.status === "activation-persistence-failed") {
    return { status: "activation-persistence-failed", volatile: activated.volatile };
  }
  return {
    status: "activation-unverified",
    volatile: activated.volatile,
    reason: activated.reason,
  };
}

// --- record validation -----------------------------------------------------
//
// G6.2 REMOVED the reload classifier. `inspectPersistedSession` answered "what
// should this page do about the record it found on boot?", and the answer is now
// always "nothing": a route entry is fresh. The opaque `SessionRecordIdentity`
// went with it — it existed so a boot-time removal could prove it was deleting
// the exact bytes it had classified, and owner-keyed records make the key itself
// that proof. What remains below is the closed schema, which is still needed to
// write, read back, and verify a record for the run that owns it.

const COMMON_KEYS = [
  "schemaVersion",
  "ownerId",
  "phase",
  "anonymized",
  "runOptions",
  "peopleCount",
  "reverseMap",
  "capture",
] as const;
const PROVISIONAL_KEYS = new Set<string>(COMMON_KEYS);
// The active variant is exactly the provisional keys plus `jobId`. It used to
// also allow an optional `lastCursor`; with reload-resume gone, a record carrying
// one was written by an older build and is not a shape this build understands.
const ACTIVE_KEYS = new Set<string>([...COMMON_KEYS, "jobId"]);
const RUN_OPTION_KEYS = new Set<string>(["prettify", "timeout"]);
const CAPTURE_STAGED_KEYS = new Set<string>(["status", "snapshotRef", "submissionOrdinal"]);
const CAPTURE_UNAVAILABLE_KEYS = new Set<string>(["status", "reason"]);

function hasExactKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Closed capture validation: exact keys per variant, a non-empty snapshot ref,
 * and a POSITIVE integer ordinal (F1 hands out 1, 2, 3 … and never 0), so a
 * corrupted or hand-written record cannot present a bogus ordering authority that
 * would let an old submission outrank a newer captured candidate.
 */
function isValidCapture(value: unknown): value is SessionCaptureState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const capture = value as Record<string, unknown>;
  if (capture.status === "staged") {
    if (!hasExactKeys(capture, CAPTURE_STAGED_KEYS)) return false;
    if (!isNonEmptyString(capture.snapshotRef)) return false;
    return (
      typeof capture.submissionOrdinal === "number" &&
      Number.isInteger(capture.submissionOrdinal) &&
      capture.submissionOrdinal > 0
    );
  }
  if (capture.status === "unavailable") {
    if (!hasExactKeys(capture, CAPTURE_UNAVAILABLE_KEYS)) return false;
    return capture.reason === "snapshot_persist_failed";
  }
  return false;
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
 * integer people count, closed run options within the settled timeout bounds, a
 * closed F2 capture authority (a staged snapshot ref plus a positive origin-wide
 * ordinal, or an explicit unavailable reason), and
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
  if (!isValidCapture(candidate.capture)) return null;

  // AUTHORITY BINDING. `snapshotRef` IS the transaction owner id — that identity is
  // the whole reason the exact-owner snapshot deletion is as narrowly scoped
  // as the record authorizing it. Without this check a schema-valid record could
  // name ANY origin-wide owner, so removing record B would authorize deleting
  // owner A's snapshot, including a live accepted run belonging to another tab.
  // Enforced here rather than in `isValidCapture` because only this level sees
  // both halves, and enforced on the SHARED parser so the writer round-trip, the
  // reload decode, and the oversized-cursor recovery all fail closed identically.
  const capture = candidate.capture as SessionCaptureState;
  if (capture.status === "staged" && capture.snapshotRef !== candidate.ownerId) return null;

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
    if (!hasExactKeys(candidate, ACTIVE_KEYS)) return null;
    if (!isValidJobId(candidate.jobId)) return null;
    return { ...(candidate as unknown as ActiveOptimizeSession), reverseMap };
  }
  return null;
}

/**
 * Decode raw record bytes with the PRODUCT's closed schema.
 *
 * Exported for out-of-process readers (the browser-test harness that has to name
 * the job a page accepted without re-implementing — and therefore weakening — the
 * schema). It answers only "what, if anything, do these bytes say"; it grants no
 * authority and reads no storage.
 */
export function decodeSessionRecord(
  raw: string,
  codec: SessionCodec = defaultCodec,
): OptimizeSessionRecord | null {
  return decodeRecord(raw, codec);
}

// --- REMOVED: pending prior-run retirement marker ---------------------------
//
// The marker existed to bridge two stores across a HIDDEN PRE-SUBMIT RETIREMENT:
// the Optimize click first had to retire the previous run's record and the
// snapshot it named, and the marker survived the gap between those two deletions.
// G6.2 deleted the retirement itself — a new run stages under its own owner key
// and never touches an older run's record — so the gap it bridged no longer
// exists. What is still owed to an abandoned run is done by its own owner-scoped
// cleanup, and whatever that cannot prove is left for verified Clear.

/**
 * The legacy retirement-marker key.
 *
 * The mechanism is gone; the KEY is not, because a tab that ran an earlier build
 * may still be holding one. Clear removes it — an opaque owner id is small, but a
 * privacy action that leaves a key behind because the feature that wrote it was
 * deleted is still leaving a key behind.
 */
export const OPTIMIZE_RETIRE_PENDING_STORAGE_KEY = "nurse.optimize.retire-pending";

/** The closed result of removing the legacy retirement marker, verified by read-back. */
export type ClearRetirementPendingOutcome = { status: "cleared" } | { status: "unverified" };

/**
 * Remove the legacy retirement marker, VERIFIED by read-back.
 *
 * All that survives of the marker mechanism, and only for Clear: a privacy action
 * has to be able to say the key is gone, and "gone" means read back absent, not
 * `removeItem` returned.
 */
export function clearRetirementPending(
  storage: SessionTransactionStorage,
): ClearRetirementPendingOutcome {
  try {
    storage.removeItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY);
  } catch {
    return { status: "unverified" };
  }
  try {
    return storage.getItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY) === null
      ? { status: "cleared" }
      : { status: "unverified" };
  } catch {
    return { status: "unverified" };
  }
}
