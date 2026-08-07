"use client";

// T16b — active-session and anonymization-map recovery.
//
// This is the ONLY boot interpreter of T16q's single durable recovery record. On
// load it inspects the one provisional/active record through T16q's storage
// primitives, classifies it into a UI-facing recovery state, and — for a resumable
// active record — builds the transport-ready `PreparedRecoveryAttachment` T16a needs
// to resume the run through the authoritative poll + durable stream.
//
// Ownership boundaries (kept deliberately narrow):
//   • T16q owns the closed codec and every storage primitive (inspect, cursor
//     update, verified removal, degraded provisional cleanup). T16b NEVER writes
//     sessionStorage directly and never implements a second codec.
//   • T16a receives ONLY a `PreparedRecoveryAttachment` (job id + resume cursor) and a
//     T16b cursor-persistence provider; it forwards opaque cursors/capabilities and
//     never parses records, owner metadata, or storage.
//   • T16b owns boot interpretation, the cursor-persistence provider, the hidden
//     pre-submit prior-run retirement, and the job-scoped cleanup/abandon action.
//
// Cursor lifecycle: T16b registers ONE identity-scoped provider with the controller.
// The controller drives it by identity (`prepare`/`onCommit`/`onReset`) and resolves
// the CURRENT provider at call time, so every durable activation — fresh or reloaded —
// persists its committed opaque cursor from its first frame, and a recovery-hook
// remount over a still-live stream takes over persistence without stale frozen
// callbacks or restarting transport. Persistence health is scoped to the exact job and
// reset when a new job becomes current, so job A's outcome never leaks into job B. A
// write that cannot be proven durable is surfaced (never fatal to the live stream).
//
// A resumable active record resumes automatically. There is NO user-facing recovery
// workflow: an interrupted (orphan provisional) record is retired invisibly by
// `prepareForOptimize` when the user next clicks Optimize, and an unreadable record is
// never resumed, never removed, and never deleted from — it simply blocks the submit
// without explaining itself in recovery terms. Job-scoped cleanup/abandon remains for
// the active OR degraded (post-202 activation-failed, provisional-retained) job: it
// removes only the exact still-current record through T16q, verifies absence, and
// preserves replacements. Recovery never mutates scenario or durable backup state — it
// only reads/removes the one sessionStorage record.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acquireSessionStorage } from "./session-storage";
import {
  purgeRetiredSubmissionSnapshot,
  type SubmissionSnapshotStore,
} from "./submission-snapshot";
import {
  clearRetirementPending,
  clearInvalidActiveCursor,
  removeInspectedSession,
  inspectPersistedSession,
  markRetirementPending,
  readRetirementPending,
  updateActiveCursor,
  type ActiveOptimizeSession,
  type InspectedSession,
  type DegradedCleanupOutcome,
  type SessionCodec,
  type SessionRecordIdentity,
  type SessionTransactionStorage,
  type UpdateActiveCursorOutcome,
} from "./session-transaction";
import type { OptimizeRunController, PreparedRecoveryAttachment } from "./use-optimize-run";

// ---------------------------------------------------------------------------
// UI-facing recovery state
// ---------------------------------------------------------------------------

/**
 * What the current tab's storage holds on load, interpreted for the UI (T16e).
 *   • `none`         — no record; a fresh submission may proceed.
 *   • `resumable`    — a durable active job; T16b auto-resumes it via T16a.
 *   • `interrupted`  — an orphan provisional record: a submission that was
 *                      interrupted before its job id was durably recorded. A server
 *                      job MAY exist. Never resumed; retired invisibly by the
 *                      next Optimize click.
 *   • `unreadable`   — corrupt / incomplete / future-version bytes are present.
 *                      Never resumed, never auto-deleted, and never retired: the
 *                      bytes name no trustworthy owner.
 *   • `storage-error`— sessionStorage could not be read at all (private mode /
 *                      security). There is no removable record.
 */
export type OptimizeRecovery =
  | { kind: "none" }
  | { kind: "resumable"; jobId: string; anonymized: boolean; peopleCount: number }
  | { kind: "interrupted"; anonymized: boolean; peopleCount: number }
  | { kind: "unreadable" }
  | { kind: "storage-error" };

/**
 * The result of the boot auto-resume attach for a resumable record. A failed handoff
 * (`invalid`/`conflict`) is surfaced so T16e never silently shows a resumable record
 * with no live transport behind it. `null` when the boot record was not resumable.
 */
export type OptimizeResumeOutcome =
  | { status: "attached"; jobId: string }
  | { status: "invalid"; reason: string }
  | { status: "conflict"; reason: string };

/**
 * Durable cursor-persistence health, SCOPED to the exact job it describes so T16e can
 * never apply job A's result to job B. Reset synchronously when a new job becomes
 * current (via the provider's `prepare`), so a stale unverified result never lingers.
 */
export interface CursorPersistenceState {
  /** The job this health describes, or null before any durable/degraded job attaches. */
  jobId: string | null;
  /** Whether the job supports reload recovery at all (false for a degraded in-tab run). */
  reloadRecoveryAvailable: boolean;
  /** Whether the last observed write was durable. Meaningful once `lastOutcome !== null`;
   *  false for a degraded job (no durable cursor is kept). */
  durable: boolean;
  /** The last `updateActiveCursor` result for this job, or null before any commit/reset. */
  lastOutcome: UpdateActiveCursorOutcome["status"] | null;
}

const IDLE_PERSISTENCE: CursorPersistenceState = {
  jobId: null,
  reloadRecoveryAvailable: false,
  durable: true,
  lastOutcome: null,
};

/**
 * The closed result of the hidden pre-submit prior-run retirement.
 *
 * Deliberately two-valued and carries no message: the product exposes no recovery
 * vocabulary, so the caller has exactly one decision to make — submit, or don't and
 * show the one settled plain-language failure line. Nothing here may be rendered.
 */
export type OptimizePrepareOutcome =
  /**
   * Safe to POST. Either there was nothing owed, or an exact-owner
   * provisional/interrupted record (and any snapshot it named) is now PROVEN gone.
   */
  | { status: "ready" }
  /**
   * Not safe to POST. Covers both "this is still the current run" (active/resumable)
   * and every unverified authority (unreadable, foreign owner, malformed marker,
   * failed marker write, unproven deletion). In all of them every store is left
   * exactly as it was and no request is sent.
   */
  | { status: "blocked" };

/**
 * The closed result of a job-scoped confirmed cleanup/abandon. Covers BOTH the active
 * (durable, `resumable`) record and the degraded (post-202 activation-failed,
 * provisional-retained) record for the exact same job.
 */
export type OptimizeCleanupOutcome =
  // The still-current record for the expected job was removed and absence verified.
  | { status: "removed" }
  // The slot was already empty (nothing to clean).
  | { status: "absent" }
  // Another job, an interrupted, or an unreadable record holds the slot — preserved.
  | { status: "not-current" }
  // The record changed during confirmation — preserved; state refreshed.
  | { status: "changed" }
  // Removal could not be proven, or storage was unreadable — the map is retained.
  | { status: "unverified" };

/** The recovery surface consumed by the screen (T16e). */
export interface OptimizeSessionRecovery {
  /** The interpreted recovery state (re-renders when it changes). */
  state: OptimizeRecovery;
  /** False until the one boot inspection (and any auto-resume attach) has run. */
  ready: boolean;
  /** The auto-resume attach result for a resumable boot record (null otherwise). */
  resume: OptimizeResumeOutcome | null;
  /** Durable cursor-persistence health for the current job (job-scoped). */
  cursorPersistence: CursorPersistenceState;
  /**
   * The hidden pre-submit step the Optimize button runs before it POSTs. There is
   * no user-facing recovery action; this is the whole of it.
   *
   * It retires ONLY a proven exact-owner provisional/interrupted record — or
   * finishes the local step a valid pending marker still owes — and reports
   * `ready` only once both the record and the snapshot it named are proven absent.
   * An active/resumable run is the current run and is never silently retired.
   * Anything unverified leaves every store untouched and reports `blocked`.
   *
   * VERIFIED ACROSS BOTH STORES: the record's staged `snapshotRef` names an
   * immutable Dexie row holding the exact canonical YAML and the real-identity
   * reverse map, and there is no orphan sweep or expiry to catch it later.
   *
   * Coalesced per TAB and attempt (keyed by the storage this tab resolved), so
   * repeated clicks, StrictMode replay, and route unmount/remount share one
   * retirement. Two tabs are independent submitters; neither can touch the other's
   * owner-scoped record or snapshot. It issues no server DELETE — a provisional
   * has no proven job id, and job deletion stays inside the terminal capture
   * coordinator.
   */
  prepareForOptimize(): Promise<OptimizePrepareOutcome>;
  /**
   * Run ONE whole Optimize attempt for this tab: the hidden retirement, and then —
   * only if it proved safe — the caller's `submit`.
   *
   * The attempt, not just the retirement, is what is coalesced. Between the POST
   * leaving and the job activating, the durable record is still a PROVISIONAL one,
   * so a route remount in that window would classify the in-flight run's own record
   * as an interrupted prior attempt, retire its snapshot, and issue a second POST.
   * Holding the whole attempt at tab lifetime is what closes that window; a remount
   * joins it instead of starting a rival.
   *
   * Still per TAB, never origin-wide: two tabs each run their own attempt.
   *
   * A boot retirement started with no submit intent ADOPTS the first real one that
   * arrives while it is parked, so a click during marker recovery is never coalesced
   * into a silent no-op. Later clicks dedupe onto that same intent.
   */
  runOptimizeAttempt(submit: () => Promise<void>): Promise<OptimizePrepareOutcome>;
  /** Confirmed cleanup/abandon of job `jobId`: re-inspects the current slot and removes
   *  ONLY the still-current record for that exact job through T16q — the active record
   *  by opaque identity, or a degraded run's retained provisional via the controller's
   *  opaque authority — then verifies absence. A replacement/other record is preserved.
   *  Does not reset the controller's terminal view or the tab-local Download Again blob. */
  cleanup(jobId: string): OptimizeCleanupOutcome;
  /** Re-inspect storage and refresh `state` (after external change or cleanup). */
  refresh(): void;
}

// ---------------------------------------------------------------------------
// Pure interpretation + attachment construction
// ---------------------------------------------------------------------------

/** Map a raw T16q inspection into the UI-facing recovery state (no side effects). */
export function interpretInspectedSession(inspected: InspectedSession): OptimizeRecovery {
  switch (inspected.kind) {
    case "none":
      return { kind: "none" };
    case "resumable":
      return {
        kind: "resumable",
        jobId: inspected.record.jobId,
        anonymized: inspected.record.anonymized,
        peopleCount: inspected.record.peopleCount,
      };
    case "interrupted":
      return {
        kind: "interrupted",
        anonymized: inspected.record.anonymized,
        peopleCount: inspected.record.peopleCount,
      };
    case "unreadable":
      // A read that threw carries no identity and no removable bytes.
      return inspected.identity === null ? { kind: "storage-error" } : { kind: "unreadable" };
  }
}

/**
 * The staged snapshot owner an inspected record still points at, or null.
 *
 * This is the piece the hidden retirement cannot do without and the UI-facing
 * `OptimizeRecovery` projection deliberately drops: without it, removing the
 * record destroys the only handle to a Dexie row holding the exact canonical YAML
 * and the real-identity reverse map. `unreadable` decodes to no record at all, so
 * it exposes no trustworthy owner and stays Clear-only.
 */
function snapshotOwnerOf(inspected: InspectedSession): string | null {
  switch (inspected.kind) {
    case "interrupted":
    case "resumable":
      return inspected.record.capture.status === "staged"
        ? inspected.record.capture.snapshotRef
        : null;
    case "unreadable":
    case "none":
      return null;
  }
}

/**
 * The TRANSACTION owner a decoded record carries, or null when nothing decoded.
 *
 * Distinct from `snapshotOwnerOf`, which answers "what snapshot does this record
 * point at". This answers "whose record is in the slot", which is the only question
 * that can prove a marker's own record is gone.
 */
function recordOwnerOf(inspected: InspectedSession): string | null {
  switch (inspected.kind) {
    case "interrupted":
    case "resumable":
      return inspected.record.ownerId;
    case "unreadable":
    case "none":
      return null;
  }
}

/** The exact-record identity for an inspection, or null when there is nothing to remove. */
function identityOf(inspected: InspectedSession): SessionRecordIdentity | null {
  switch (inspected.kind) {
    case "interrupted":
    case "resumable":
      return inspected.identity;
    case "unreadable":
      return inspected.identity;
    case "none":
      return null;
  }
}

/**
 * Build the transport-ready attachment for a resumable active record. It carries the
 * retained reverse map + count (T16c) and the record's persisted cursor to seed the
 * stream's first `Last-Event-ID`. Cursor persistence is driven separately through the
 * registered provider (resolved at call time), so the attachment carries no callbacks.
 */
export function buildRecoveryAttachment(
  record: ActiveOptimizeSession,
  invalidCursorReset = false,
): PreparedRecoveryAttachment {
  return {
    jobId: record.jobId,
    activation: {
      anonymized: record.anonymized,
      peopleCount: record.peopleCount,
      reverseMap: record.reverseMap,
      // A durable active record is, by definition, reload-recoverable.
      reloadRecoveryAvailable: true,
      // Carried verbatim: the reload's roster-capture authority is whatever the
      // pre-POST write-ahead actually achieved. A record whose snapshot was never
      // staged stays capture-unavailable across reloads, and one that WAS staged
      // resolves its snapshot by ref — F2 never infers authority from tab state.
      capture: record.capture,
    },
    initialCursor: record.lastCursor ?? null,
    // The saved cursor was oversized and has been cleared: resume from the retained
    // floor and surface explicit invalid-cursor recovery on attach.
    invalidCursorReset,
  };
}

/** Map T16q's opaque provisional-cleanup result into the UI cleanup outcome. */
function mapDegradedCleanup(outcome: DegradedCleanupOutcome): OptimizeCleanupOutcome {
  switch (outcome.status) {
    case "removed":
      return { status: "removed" };
    case "absent":
      return { status: "absent" };
    case "conflict":
      return { status: "not-current" };
    case "unverified":
      return { status: "unverified" };
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * In-flight Optimize attempts, keyed by the storage object a tab resolved.
 *
 * Tab lifetime rather than mount lifetime: a route unmount/remount must join the
 * same attempt, and a component ref cannot survive that. Keying by the storage
 * OBJECT (one `sessionStorage` per tab) makes that scope exact, and keeps two
 * simulated tabs in one test realm genuinely independent instead of sharing a
 * module singleton. A `WeakMap` so nothing is retained after the attempt settles.
 */
/** What an attempt will POST once retirement proves safe, or null for a
 *  retirement-only flight (boot marker recovery). */
type OptimizeSubmitIntent = (() => Promise<void>) | null;

/**
 * One tab's in-flight Optimize attempt.
 *
 * A bare promise was not enough: boot-time marker recovery starts a flight with no
 * submit intent, and a click arriving while that flight is parked has to be able to
 * hand it one. The record holds a SINGLE pending real intent, claimed exactly once.
 */
interface OptimizeAttempt {
  promise: Promise<OptimizePrepareOutcome>;
  /** The one real submit this attempt will run. Adopted at most once. */
  submit: OptimizeSubmitIntent;
  /** True once the attempt has read `submit`; after this it can accept no more. */
  claimed: boolean;
}

const attemptInFlight = new WeakMap<SessionTransactionStorage, OptimizeAttempt>();

/** Injectable seams for testability. */
export interface UseOptimizeSessionRecoveryDeps {
  /** Defaults to the real `sessionStorage` (the same accessor T16a submission uses). */
  storage?: SessionTransactionStorage;
  /** Defaults to T16q's JSON codec; overridable in tests. */
  codec?: SessionCodec;
  /** F1 repositories for the snapshot half of a retirement. Defaults to the
   *  app-wide roster storage. */
  snapshotStore?: SubmissionSnapshotStore;
}

/** The controller seams T16b needs (kept narrow so tests can pass a lightweight double). */
type RecoveryController = Pick<
  OptimizeRunController,
  | "attachRecoveredSession"
  | "getLiveJobId"
  | "notifyInvalidCursorReset"
  | "registerCursorPersistence"
  | "prepareDegradedCleanup"
  | "revokeCursorPersistence"
>;

/**
 * Boot the single-record recovery for one tab. On mount it inspects the durable
 * record and, for a resumable active record, resumes through the controller —
 * idempotently against the controller's ACTUAL live attachment (`getLiveJobId`), so a
 * React StrictMode setup→cleanup→setup replay re-attaches rather than going silent. A
 * failed handoff is surfaced through `resume`.
 *
 * It registers ONE identity-scoped cursor-persistence provider so fresh, reloaded, and
 * remounted runs all persist their cursor through the current provider, and it exposes
 * the hidden pre-submit retirement and job-scoped cleanup/abandon (active OR
 * degraded provisional) actions.
 */
export function useOptimizeSessionRecovery(
  controller: RecoveryController,
  deps?: UseOptimizeSessionRecoveryDeps,
): OptimizeSessionRecovery {
  const storageRef = useRef<SessionTransactionStorage | null>(null);
  if (storageRef.current === null) {
    storageRef.current = deps?.storage ?? acquireSessionStorage();
  }
  const codec = deps?.codec;
  const snapshotStore = deps?.snapshotStore;
  const {
    attachRecoveredSession,
    getLiveJobId,
    notifyInvalidCursorReset,
    registerCursorPersistence,
    prepareDegradedCleanup,
    revokeCursorPersistence,
  } = controller;

  const [state, setState] = useState<OptimizeRecovery>({ kind: "none" });
  const [ready, setReady] = useState(false);
  const [resume, setResume] = useState<OptimizeResumeOutcome | null>(null);
  const [cursorPersistence, setCursorPersistence] =
    useState<CursorPersistenceState>(IDLE_PERSISTENCE);
  // The identity of the record observed by the LAST inspection. Removal re-checks it so
  // a record that changed (e.g. a resumed cursor commit) is preserved, not blindly
  // removed. Held in a ref because job-scoped cleanup reads it imperatively.
  const identityRef = useRef<SessionRecordIdentity | null>(null);
  // The staged snapshot owner the inspected record points at. Held beside the
  // identity because a retirement must still know what it authorizes AFTER the
  // record that named it is gone.
  const snapshotOwnerRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyInspection = useCallback((inspected: InspectedSession) => {
    identityRef.current = identityOf(inspected);
    snapshotOwnerRef.current = snapshotOwnerOf(inspected);
    setState(interpretInspectedSession(inspected));
  }, []);

  const refresh = useCallback(() => {
    applyInspection(inspectPersistedSession(storageRef.current!, codec));
  }, [applyInspection, codec]);

  // Record a cursor-persistence result WITHOUT making stream progress fatal: a `stale`
  // record (gone/replaced) refreshes the visible state; an `unverified` write flips
  // `durable` false so the UI stops claiming full durability. Job-scoped.
  const note = useCallback(
    (jobId: string, outcome: UpdateActiveCursorOutcome) => {
      if (!mountedRef.current) return;
      if (outcome.status === "stale") refresh();
      setCursorPersistence({
        jobId,
        reloadRecoveryAvailable: true,
        durable: outcome.status === "updated",
        lastOutcome: outcome.status,
      });
    },
    [refresh],
  );

  // The single identity-scoped provider. The controller resolves it at call time, so
  // this mounted hook is always the observation sink for the live run.
  const provider = useMemo(
    () => ({
      // A durable/degraded job became current — reset health to it (never inherit A's).
      prepare(jobId: string, reloadRecoveryAvailable: boolean) {
        if (!mountedRef.current) return;
        setCursorPersistence({
          jobId,
          reloadRecoveryAvailable,
          durable: reloadRecoveryAvailable,
          lastOutcome: null,
        });
      },
      onCommit(jobId: string, cursor: string) {
        note(jobId, updateActiveCursor(storageRef.current!, jobId, cursor, codec));
      },
      onReset(jobId: string) {
        note(jobId, updateActiveCursor(storageRef.current!, jobId, null, codec));
      },
      revoke(jobId: string) {
        if (!mountedRef.current) return;
        setCursorPersistence((current) => (current.jobId === jobId ? IDLE_PERSISTENCE : current));
      },
    }),
    [note, codec],
  );

  // Register the provider (identity-scoped): a surviving provider is never revoked by an
  // overlapping hook's cleanup, and a recovery-only remount immediately reflects the
  // live job's state (the controller `prepare`s the new provider for the current job).
  useEffect(() => {
    const unregister = registerCursorPersistence(provider);
    return unregister;
  }, [registerCursorPersistence, provider]);

  // Boot: inspect and auto-resume a resumable record, idempotent against the live
  // attachment. Runs on each mount (StrictMode replays it); attaching only when the
  // controller is not already live for this exact job keeps exactly one live transport.
  useEffect(() => {
    // One bounded classifier for BOTH the initial inspection and a `none` re-inspection.
    // `depth` caps re-inspection at a single hop, so a record that keeps changing surfaces
    // a visible conflict rather than looping or leaving a stuck `resumable + resume=null`.
    const resolve = (inspected: InspectedSession, depth: number): OptimizeResumeOutcome | null => {
      applyInspection(inspected); // set the UI state + identity for EVERY classification
      // none/interrupted/unreadable/storage-error are visible through `state` alone.
      if (inspected.kind !== "resumable") return null;
      const jobId = inspected.record.jobId;

      if (!inspected.cursorReset) {
        // Clean resumable: attach, idempotent against an already-live attachment.
        return getLiveJobId() === jobId
          ? { status: "attached", jobId }
          : attachRecoveredSession(buildRecoveryAttachment(inspected.record, false));
      }

      // Invalid-cursor resumable: verify the durable clear BEFORE any same-live shortcut,
      // so an already-live poisoned record is still cleared and read-back-verified.
      const cleared = clearInvalidActiveCursor(storageRef.current!, jobId, codec);
      if (cleared.status === "cleared") {
        if (getLiveJobId() === jobId) {
          // Keep the live transport; emit exactly one exact-job invalid-cursor reset signal
          // (no second stream). Durable recovery is now truthful — the poison is removed.
          notifyInvalidCursorReset(jobId);
          return { status: "attached", jobId };
        }
        return attachRecoveredSession(buildRecoveryAttachment(cleared.record, true));
      }
      if (cleared.status === "none") {
        // Changed/vanished between inspect and clear — never attach the stale decoded
        // record. Re-inspect ONCE and treat the CURRENT record as the new authority.
        if (depth > 0) {
          return {
            status: "conflict",
            reason: "The recovery record kept changing during cleanup; reload to retry.",
          };
        }
        return resolve(inspectPersistedSession(storageRef.current!, codec), depth + 1);
      }
      // `unverified`: storage read/write/read-back failed — fail closed, no durability claim.
      setState({ kind: "storage-error" });
      return null;
    };

    const resume = resolve(inspectPersistedSession(storageRef.current!, codec), 0);

    if (mountedRef.current) {
      setResume(resume);
      setReady(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The SECOND half of a retirement. The record is already gone, so this owner id
  // (from the pending marker) is the only remaining handle to a Dexie row holding
  // the exact canonical YAML and the real-identity reverse map. Idempotent by
  // construction: `already-absent` is proof, so a retry after any partial cut
  // simply completes.
  const finishRetirement = useCallback(
    async (ownerId: string): Promise<OptimizePrepareOutcome> => {
      // A marker ALONE never authorizes deleting a snapshot. The record it belongs
      // to must be PROVEN gone first, because while that record exists the snapshot
      // is still ITS capture authority, not ours to destroy.
      const inspected = inspectPersistedSession(storageRef.current!, codec);
      if (inspected.kind === "unreadable") {
        // Proves nothing at all — a thrown read and undecodable bytes both land here,
        // and the record may be perfectly live. A crash after the marker write but
        // before the record removal, plus one transient read failure, is exactly this
        // path: deleting here would destroy a live run's only submission copy.
        // Keep the marker, keep everything, and let the next attempt re-prove it.
        return { status: "blocked" };
      }
      if (inspected.kind !== "none") {
        const owner = recordOwnerOf(inspected);
        if (owner === ownerId) {
          // Our own record survived the removal, so it is the authority again and the
          // marker is not owed. Drop it and block; the next attempt re-runs the whole
          // retirement from the record.
          clearRetirementPending(storageRef.current!);
          return { status: "blocked" };
        }
        // A DIFFERENT transaction holds the single slot, which proves ours is not in
        // it. That is the ordinary "a newer submission started" state, and refusing it
        // would strand the owed deletion forever.
      }

      const purged = await purgeRetiredSubmissionSnapshot(ownerId, snapshotStore);
      // NOT proven gone: keep the marker so the next attempt resumes exactly this
      // deletion, and refuse the POST. Submitting while the prior run's exact
      // submission is still stored is the defect this contract exists to prevent.
      if (purged.status !== "purged") return { status: "blocked" };
      // The marker is a destructive capability, so retiring it is part of the proof,
      // not a courtesy: a removal that silently no-ops would replay this deletion on
      // every boot and make `ready` a claim nothing checked.
      if (clearRetirementPending(storageRef.current!).status !== "cleared") {
        return { status: "blocked" };
      }
      if (mountedRef.current) setState({ kind: "none" });
      return { status: "ready" };
    },
    [codec, snapshotStore],
  );

  // The whole hidden pre-submit step, minus the coalescing wrapper below.
  const runPrepare = useCallback(async (): Promise<OptimizePrepareOutcome> => {
    // RESUME FIRST. A marker means a previous attempt already proved the record gone
    // and owes only the snapshot; re-inspecting instead would find an empty slot and
    // wrongly conclude there is nothing to do, abandoning the bytes.
    const pending = readRetirementPending(storageRef.current!);
    if (pending.status === "pending") return finishRetirement(pending.ownerId);
    if (pending.status === "unreadable") {
      // A marker is present but names nothing trustworthy. Deleting on a guess would
      // destroy some other run's snapshot, so nothing is touched and nothing is sent.
      return { status: "blocked" };
    }

    // Re-inspect at click time rather than trusting the boot snapshot: the record may
    // have become `active` since, and only the current bytes can say so.
    const inspected = inspectPersistedSession(storageRef.current!, codec);
    if (inspected.kind === "none") return { status: "ready" };
    if (inspected.kind !== "interrupted") {
      // `resumable` — this IS the current run and is never silently retired; its
      // ordinary lifecycle has to settle first. `unreadable` — the bytes expose no
      // trustworthy owner, and a record that fails on one extra key can still NAME a
      // real staged snapshot, so removing it would destroy the last handle to it
      // while proving nothing. Both preserve everything and send nothing.
      return { status: "blocked" };
    }

    const identity = inspected.identity;
    const ownerId = snapshotOwnerOf(inspected);

    // The marker goes down BEFORE the record, because removing the record is what
    // destroys the only other handle to the snapshot. Ordering the two the other
    // way round would be simpler but unsafe: a provisional can become `active`
    // between inspection and removal, and only the exact-bytes check below can
    // tell, so nothing may be deleted from F1 until that check has passed.
    //
    // FAIL CLOSED on an unverified marker. A best-effort write would let the record
    // be removed with nothing to resume from: the next attempt would find no marker
    // and no record, and the snapshot would keep the exact canonical YAML and the
    // real-identity reverse map with no way left to name them. Refusing here costs
    // nothing — both halves keep their authority and the next click retries.
    if (
      ownerId !== null &&
      markRetirementPending(storageRef.current!, ownerId).status !== "marked"
    ) {
      clearRetirementPending(storageRef.current!);
      return { status: "blocked" };
    }

    const removal = removeInspectedSession(storageRef.current!, identity);
    if (removal.status !== "removed") {
      // The record survives and still names its own snapshot, so the authority is
      // durable again and the marker is not needed. `changed` also lands here: the
      // replacement is preserved untouched.
      clearRetirementPending(storageRef.current!);
      refresh();
      return { status: "blocked" };
    }

    identityRef.current = null;
    snapshotOwnerRef.current = null;
    if (ownerId === null) {
      // A decoded record whose staging was degraded: it provably never wrote a
      // snapshot, so there is no second half to verify.
      clearRetirementPending(storageRef.current!);
      if (mountedRef.current) setState({ kind: "none" });
      return { status: "ready" };
    }
    return finishRetirement(ownerId);
  }, [codec, finishRetirement, refresh]);

  const runOptimizeAttempt = useCallback(
    (submit: OptimizeSubmitIntent): Promise<OptimizePrepareOutcome> => {
      // Coalesced at TAB lifetime, not mount lifetime: the key is the storage object
      // this tab resolved, so repeated clicks, a StrictMode replay, and a route
      // unmount/remount all join the SAME attempt — through the POST, not merely
      // through the retirement. A second tab has its own storage and is an
      // independent submitter. Deliberately NOT an origin-wide lease.
      const storage = storageRef.current!;
      const running = attemptInFlight.get(storage);

      if (running !== undefined) {
        if (!running.claimed) {
          // A boot retirement started with NO submit intent, and the user has now
          // clicked. The flight is still the right one to join — but it must ADOPT
          // that intent, or the click would silently receive `ready` with no request
          // ever sent. Only the first real intent is taken; later clicks dedupe onto
          // it, which is what keeps this one POST.
          running.submit ??= submit;
          return running.promise;
        }
        if (running.submit !== null) {
          // Already owns a real submit and has passed its claim point — joining is
          // exactly the dedupe that keeps repeated clicks at one POST.
          return running.promise;
        }
        if (submit === null) return running.promise;
        // A retirement-only flight that has just passed its claim point can no longer
        // run this intent, and starting a rival attempt now would let it retire the
        // in-flight run's own record. Chain a fresh attempt behind it instead.
        return running.promise.then(() => runOptimizeAttempt(submit));
      }

      const attempt: OptimizeAttempt = {
        submit,
        claimed: false,
        promise: undefined as unknown as Promise<OptimizePrepareOutcome>,
      };
      attempt.promise = (async () => {
        const prepared = await runPrepare();
        // THE CLAIM POINT, and the only place `submit` is read. Whatever intent the
        // attempt holds at this instant is the one it runs, exactly once; anything
        // arriving later sees `claimed` and is handled above rather than lost.
        attempt.claimed = true;
        const intent = attempt.submit;
        if (prepared.status === "ready" && intent !== null) await intent();
        return prepared;
      })().finally(() => {
        // Only retire our OWN entry: a later caller may already have installed a
        // successor here while this one was settling.
        if (attemptInFlight.get(storage) === attempt) attemptInFlight.delete(storage);
      });
      attemptInFlight.set(storage, attempt);
      return attempt.promise;
    },
    [runPrepare],
  );

  // The retirement on its own is the same attempt carrying NO submit intent — null
  // rather than an empty callback, so a real click arriving while it is parked can
  // still be adopted instead of coalescing into a no-op.
  const prepareForOptimize = useCallback(
    (): Promise<OptimizePrepareOutcome> => runOptimizeAttempt(null),
    [runOptimizeAttempt],
  );

  // Finish an owed retirement on mount, without waiting for a click. The marker
  // means the record was already proven gone and only its snapshot is still owed,
  // so this re-attempts exactly ONE already-authorized, owner-scoped deletion. It
  // is not a sweep: it can only ever name an owner this tab itself wrote down, and
  // it goes through the same coalescer so it cannot race a click.
  useEffect(() => {
    if (readRetirementPending(storageRef.current!).status !== "pending") return;
    void prepareForOptimize();
  }, [prepareForOptimize]);

  // Apply a cleanup outcome's side effects (state reset on removal, refresh on a
  // preserved-but-changed/unverified record) and return it unchanged.
  const finalizeCleanup = useCallback(
    (jobId: string, outcome: OptimizeCleanupOutcome): OptimizeCleanupOutcome => {
      if (outcome.status === "removed" || outcome.status === "absent") {
        revokeCursorPersistence(jobId);
        identityRef.current = null;
        setState({ kind: "none" });
      } else if (outcome.status === "changed" || outcome.status === "unverified") {
        refresh();
      }
      return outcome;
    },
    [refresh, revokeCursorPersistence],
  );

  const cleanup = useCallback(
    (jobId: string): OptimizeCleanupOutcome => {
      // A same-tab degraded authority governs dispatch before any job-id-only active
      // match. It alone can prove the transaction owner and safely classify the
      // provisional/possible-active ambiguity left by an unverified activation.
      const degraded = prepareDegradedCleanup(jobId);
      if (degraded) return finalizeCleanup(jobId, mapDegradedCleanup(degraded()));

      const inspected = inspectPersistedSession(storageRef.current!, codec);
      // A read that threw cannot confirm the expected job — retain, report unverified.
      if (inspected.kind === "unreadable" && inspected.identity === null) {
        return { status: "unverified" };
      }
      // Active durable record for the exact job — remove by opaque identity.
      if (inspected.kind === "resumable" && inspected.record.jobId === jobId) {
        return finalizeCleanup(
          jobId,
          removeInspectedSession(storageRef.current!, inspected.identity),
        );
      }
      if (inspected.kind === "none") return finalizeCleanup(jobId, { status: "absent" });
      return { status: "not-current" };
    },
    [codec, finalizeCleanup, prepareDegradedCleanup],
  );

  return {
    state,
    ready,
    resume,
    cursorPersistence,
    prepareForOptimize,
    runOptimizeAttempt,
    cleanup,
    refresh,
  };
}
