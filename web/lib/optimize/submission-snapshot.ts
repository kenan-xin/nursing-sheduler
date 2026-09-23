// F2 — the write-ahead submission snapshot.
//
// Today `prep.yaml` is built, POSTed, and discarded; only the job id, people
// count, and reverse map survive (`use-optimize-run.ts`, `session-transaction.ts`).
// Roster capture needs the EXACT canonical document that was solved, so this
// module stages it durably BEFORE the POST — in the same Dexie transaction that
// allocates the origin-wide `submissionOrdinal` (F1's
// `allocateSubmissionSnapshot`).
//
// Two load-bearing properties live here:
//
//   • NON-GATING. Every entry point is total: a denied, quota-limited, or absent
//     IndexedDB resolves to a degraded `unavailable` capture state and NEVER
//     throws. The optimize POST and the original XLSX download must proceed
//     byte-identically whether or not the snapshot landed — the only thing a
//     degraded run loses is roster capture (and, with it, Load/Retry).
//   • PROVEN-AUTHORITY DELETION. There is no load-time orphan sweep and no
//     expiry: tab-scoped session state can never prove an origin-wide snapshot is
//     orphaned, and a crash between the snapshot write and the session staging
//     leaves a harmless retained snapshot until Clear. `purgeSubmissionSnapshot`
//     therefore demands a `SnapshotPurgeAuthority` naming the LOCALLY PROVEN
//     outcome that justifies the delete, so no caller can reach the deletion
//     without stating its evidence.

import type { PeopleReverseMap } from "@/lib/scenario";
import type { RosterSubmission } from "@/lib/roster";
import { rosterStorage, type RosterStorage, type SnapshotDeletionOutcome } from "@/lib/store";
import type { SessionCaptureState } from "./session-transaction";

/**
 * The immutable exact submission (Core Flows decision 5) — F3's OWN
 * `RosterSubmission` envelope, staged before the POST and handed to
 * `assembleRosterDocument` verbatim. Capture de-anonymizes only through this,
 * never by reparsing the live editor or the backend's roster coordinates.
 *
 * F2 owns NO schema authority over it: the type and its version constant are
 * F3's, and F3's assembler is what enforces the version. This alias exists purely
 * so F2's storage signatures read in F2's vocabulary.
 */
export type StagedSubmission = RosterSubmission;

/** The narrow F1 surface this module needs — never the whole repository. */
export type SubmissionSnapshotStore = Pick<
  RosterStorage,
  | "getClearEpoch"
  | "allocateSubmissionSnapshot"
  | "readSubmissionSnapshot"
  | "deleteSubmissionSnapshot"
>;

/** A snapshot read back for capture, with the ordinal it was allocated under. */
export interface StagedSubmissionSnapshot {
  ownerId: string;
  submissionOrdinal: number;
  payload: StagedSubmission;
}

/**
 * The locally proven outcome that authorizes deleting a staging snapshot. Listed
 * exhaustively so the set is reviewable in one place; anything not on this list
 * (a load-time sweep, an age heuristic, another tab's session state) is not
 * authority and cannot be expressed.
 */
export type SnapshotPurgeAuthority =
  /** The POST was definitively rejected — no server job was created. */
  | "submit-rejected"
  /** The candidate was durably committed; the snapshot lives on inside it. */
  | "candidate-committed"
  /** The user explicitly declined this exact candidate. */
  | "candidate-dismissed"
  /** F1 proved this submission older than the current pointer (nothing stored). */
  | "candidate-superseded"
  /**
   * A prior-run retirement ran and the exact session record that named this owner
   * is proven gone. The record IS the authority: nothing else in the tab can name
   * this owner, so the deletion is exactly as scoped as the record was.
   */
  | "session-retired"
  /** An explicit, verified privacy purge. */
  | "cleared";

export interface SnapshotPurgeResult {
  authority: SnapshotPurgeAuthority;
  outcome: SnapshotDeletionOutcome | { status: "error"; message: string };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Roster storage is unavailable.";
}

/** Build the immutable envelope from a prepared submission plus F3's version. */
export function buildStagedSubmission(input: {
  canonicalYaml: string;
  reverseMap: PeopleReverseMap;
  schemaVersion: string;
}): StagedSubmission {
  return {
    canonicalYaml: input.canonicalYaml,
    reverseMap: input.reverseMap,
    schemaVersion: input.schemaVersion,
  };
}

/**
 * Atomically allocate the origin-wide `submissionOrdinal` and write the immutable
 * `snapshot:<ownerId>` row, returning the capture authority the session record
 * will carry.
 *
 * TOTAL BY CONSTRUCTION: every failure mode — IndexedDB denied or absent, quota
 * exceeded, a Clear landing mid-stage, or an owner-id collision — degrades to
 * `unavailable` rather than throwing, because the caller is about to POST and
 * that POST must not be gated on storage. A degraded run exposes no roster
 * Load/Retry precisely because no durable exact-submission authority exists.
 */
export async function stageSubmissionSnapshot(input: {
  ownerId: string;
  payload: StagedSubmission;
  store?: SubmissionSnapshotStore;
}): Promise<SessionCaptureState> {
  const store = input.store ?? rosterStorage;
  try {
    const expectedClearEpoch = await store.getClearEpoch();
    const outcome = await store.allocateSubmissionSnapshot({
      ownerId: input.ownerId,
      payload: input.payload,
      expectedClearEpoch,
    });
    if (outcome.status === "allocated") {
      return {
        status: "staged",
        snapshotRef: input.ownerId,
        submissionOrdinal: outcome.snapshot.submissionOrdinal,
      };
    }
    // `conflict` — a snapshot already exists for this owner id. F1's snapshots are
    // write-once, so the stored bytes are NOT provably the document this call is
    // about to submit; adopting them would risk de-anonymizing a result against
    // the wrong submission. `stale-epoch` — a verified Clear committed between the
    // epoch read and the write, so nothing was staged. Both degrade.
    return { status: "unavailable", reason: "snapshot_persist_failed" };
  } catch {
    return { status: "unavailable", reason: "snapshot_persist_failed" };
  }
}

/**
 * Whether an opaque stored payload is STRUCTURALLY a submission envelope.
 *
 * This is a staging-integrity check, not a schema decision: it proves the row is
 * shaped like the envelope F3's assembler expects, so a corrupt or foreign row
 * cannot reach the assembler with `undefined` fields. It deliberately does NOT
 * judge `schemaVersion` by value — that authority is F3's, enforced inside
 * `assembleRosterDocument` before the container is parsed. Carrying an unknown
 * version through to the assembler is what makes a version mismatch fail in ONE
 * place with a real reason, instead of being silently dropped here.
 */
export function isStagedSubmission(value: unknown): value is StagedSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload.canonicalYaml !== "string" || payload.canonicalYaml.length === 0) {
    return false;
  }
  if (typeof payload.schemaVersion !== "string" || payload.schemaVersion.length === 0) {
    return false;
  }
  if (!Array.isArray(payload.reverseMap)) return false;
  return payload.reverseMap.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      (typeof entry[1] === "string" || typeof entry[1] === "number"),
  );
}

/**
 * The outcome of reading a staged snapshot.
 *
 * `absent` and `unusable` are PROVEN facts: the read succeeded and there is
 * nothing consumable, so the run can never capture and cleanup is authorized
 * without a `/roster` attempt. `unavailable` proves nothing at all — the read
 * itself failed, and the snapshot may be perfectly intact. Collapsing the two (as
 * a bare `null` did) lets a transient IndexedDB hiccup manufacture destructive
 * authority over the only server-side copy of a roster, so they are kept apart at
 * the type level rather than by convention.
 */
export type SnapshotReadOutcome =
  | { status: "found"; snapshot: StagedSubmissionSnapshot }
  /** Proven: the read succeeded and no row exists (crash cut, or already purged). */
  | { status: "absent" }
  /** Proven: a row exists but is not a consumable submission envelope. */
  | { status: "unusable" }
  /** NOT proven: the read failed. Retryable; nothing may be concluded from it. */
  | { status: "unavailable"; message: string };

/**
 * Read the staged snapshot for an owner, distinguishing proven absence from a
 * failed read. Never throws — the failure is returned as data so the caller has to
 * decide what it means rather than inheriting a silent `null`.
 */
export async function readStagedSubmissionSnapshot(
  ownerId: string,
  store: SubmissionSnapshotStore = rosterStorage,
): Promise<SnapshotReadOutcome> {
  let row: Awaited<ReturnType<SubmissionSnapshotStore["readSubmissionSnapshot"]>>;
  try {
    row = await store.readSubmissionSnapshot<unknown>(ownerId);
  } catch (error) {
    return { status: "unavailable", message: message(error) };
  }
  if (row === null) return { status: "absent" };
  if (!isStagedSubmission(row.payload)) return { status: "unusable" };
  return {
    status: "found",
    snapshot: { ownerId, submissionOrdinal: row.submissionOrdinal, payload: row.payload },
  };
}

/**
 * The half of a retirement that F1 owns: delete the exact staged snapshot the
 * forgotten session record named, and report whether its absence is PROVEN.
 *
 * `purged` is the only status a retirement may treat as done. Everything else keeps the
 * owner-scoped pending marker alive so the deletion is retried rather than
 * silently abandoned — the row holds the exact canonical YAML and the
 * real-identity reverse map, and the user asked for it to be gone.
 */
export type RetiredSnapshotOutcome =
  /** PROVEN absent: deleted now, or already gone. */
  | { status: "purged" }
  /** NOT proven. Retryable and idempotent; nothing may be concluded from it. */
  | { status: "pending"; message: string };

export async function purgeRetiredSubmissionSnapshot(
  ownerId: string,
  store: SubmissionSnapshotStore = rosterStorage,
): Promise<RetiredSnapshotOutcome> {
  let expectedClearEpoch: number;
  try {
    expectedClearEpoch = await store.getClearEpoch();
  } catch (error) {
    return { status: "pending", message: message(error) };
  }

  const purge = await purgeSubmissionSnapshot({
    ownerId,
    expectedClearEpoch,
    authority: "session-retired",
    store,
  });
  const outcome = purge.outcome;
  if (outcome.status === "deleted" || outcome.status === "already-absent") {
    return { status: "purged" };
  }
  if (outcome.status === "stale-epoch") {
    // A verified Clear committed under us. Clear purges every snapshot, so this
    // row is almost certainly gone — but the refusal says the WRITE was declined,
    // not that the payload went with it. Claiming success on that inference is
    // exactly how sensitive bytes would be left behind under a "forgotten" label,
    // so absence is verified by reading before the retirement may finish.
    const read = await readStagedSubmissionSnapshot(ownerId, store);
    if (read.status === "absent") return { status: "purged" };
    return {
      status: "pending",
      message: "The stored submission could not be verified as removed.",
    };
  }
  return { status: "pending", message: outcome.message };
}

/**
 * Delete one staging snapshot, naming the locally proven outcome that authorizes
 * it. The `authority` is not decoration: it is the type-level gate that keeps
 * this deletion unreachable from a load-time sweep or an expiry timer, both of
 * which would let one tab destroy another tab's in-flight submission.
 *
 * Epoch-fenced by F1, and total like the rest of this module — a purge failure is
 * reported, never thrown, because it can only ever leave a harmless retained row.
 */
export async function purgeSubmissionSnapshot(input: {
  ownerId: string;
  expectedClearEpoch: number;
  authority: SnapshotPurgeAuthority;
  store?: SubmissionSnapshotStore;
}): Promise<SnapshotPurgeResult> {
  const store = input.store ?? rosterStorage;
  try {
    const outcome = await store.deleteSubmissionSnapshot({
      ownerId: input.ownerId,
      expectedClearEpoch: input.expectedClearEpoch,
    });
    return { authority: input.authority, outcome };
  } catch (error) {
    return { authority: input.authority, outcome: { status: "error", message: message(error) } };
  }
}
