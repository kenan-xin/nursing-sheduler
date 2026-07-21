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
//   • T16b owns boot interpretation, the cursor-persistence provider, the confirmed
//     Forget action, and the job-scoped cleanup/abandon action exposed to the UI.
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
// A resumable active record resumes automatically. An interrupted (orphan provisional)
// or unreadable record is surfaced but NEVER resumed or auto-deleted: T16q's occupied-
// slot check blocks a new submission, and the escape is a confirmed action — Forget for
// an interrupted/unreadable record, or job-scoped cleanup/abandon for the active OR the
// degraded (post-202 activation-failed, provisional-retained) job. Cleanup removes only
// the exact still-current record through T16q, verifies absence, preserves replacements,
// and carries the unknown-backend-job warning. Recovery never mutates scenario or
// durable backup state — it only reads/removes the one sessionStorage record.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acquireSessionStorage } from "./session-storage";
import {
  clearInvalidActiveCursor,
  FORGET_OPTIMIZE_SESSION_WARNING,
  forgetInspectedSession,
  inspectPersistedSession,
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
 *                      job MAY exist. Never resumed; discardable via Forget.
 *   • `unreadable`   — corrupt / incomplete / future-version bytes are present.
 *                      Never resumed and never auto-deleted; discardable via Forget.
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

/** The closed result of a confirmed Forget (interrupted/unreadable record). */
export type OptimizeForgetOutcome =
  | { status: "removed" }
  // The record changed since it was inspected — it is preserved and the state has
  // been refreshed so the UI can re-inspect and re-confirm.
  | { status: "changed" }
  // The removal could not be proven (storage unreadable, or the record survived).
  | { status: "unverified" }
  // There was no durable record to forget (state was `none`/`storage-error`).
  | { status: "nothing-to-forget" };

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
  /** The warning shown before Forget/cleanup discards a record. */
  forgetWarning: string;
  /** Confirmed Forget of the currently inspected interrupted/unreadable record. */
  forget(): OptimizeForgetOutcome;
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

/** Injectable seams for testability. */
export interface UseOptimizeSessionRecoveryDeps {
  /** Defaults to the real `sessionStorage` (the same accessor T16a submission uses). */
  storage?: SessionTransactionStorage;
  /** Defaults to T16q's JSON codec; overridable in tests. */
  codec?: SessionCodec;
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
 * confirmed Forget (interrupted/unreadable) and job-scoped cleanup/abandon (active OR
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
  // The identity of the record observed by the LAST inspection. Forget re-checks it so
  // a record that changed (e.g. a resumed cursor commit) is preserved, not blindly
  // removed. Held in a ref because Forget reads it imperatively.
  const identityRef = useRef<SessionRecordIdentity | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyInspection = useCallback((inspected: InspectedSession) => {
    identityRef.current = identityOf(inspected);
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

  const forget = useCallback((): OptimizeForgetOutcome => {
    const identity = identityRef.current;
    if (identity === null) return { status: "nothing-to-forget" };
    const outcome = forgetInspectedSession(storageRef.current!, identity);
    if (outcome.status === "removed") {
      identityRef.current = null;
      setState({ kind: "none" });
    } else if (outcome.status === "changed") {
      // The record changed before confirmation — preserve it and re-inspect so the UI
      // shows the fresh state and can require a new confirmation.
      refresh();
    }
    return outcome;
  }, [refresh]);

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
          forgetInspectedSession(storageRef.current!, inspected.identity),
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
    forgetWarning: FORGET_OPTIMIZE_SESSION_WARNING,
    forget,
    cleanup,
    refresh,
  };
}
