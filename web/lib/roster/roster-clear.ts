// Roster Clear orchestration (F5). Verified purge of the working roster, every
// candidate + snapshot, the candidate pointer, the F2 capture gate, the optimize
// session + retirement-marker residue, the edit/undo session, and roster view
// metadata — in the order the closure review requires.
//
// The load-bearing ordering: INVALIDATE AUTHORITY FIRST, then PURGE, then remove
// and VERIFY every residue, then NOTIFY. Capture is invalidated (the F2 gate is
// settled) BEFORE the destructive storage work, so an in-flight capture cannot
// land fresh sensitive data on the far side of the purge. The F1 purge advances
// the clear epoch AND clears the roster/snapshot stores in ONE committed
// transaction, so any autosave write still in flight across the purge is fenced
// at the storage layer (its `stale-epoch` outcome is terminal) and cannot
// repopulate the stores. The optimize session record (which carries the
// real-identity reverse map) and the retirement marker are then removed with
// verified read-back through the existing session-transaction helpers, and the
// roster view metadata last.
//
// Every cut is fail-closed. A rejected, partial, or silently-no-op'd cut returns
// `failed` with a residue report and NEVER reports privacy success. `status` is
// `cleared` only when every sensitive surface is provably empty afterwards.
//
// This is separate from Optimize (which preserves the configured scenario) and
// from New schedule (the broader workspace reset). It never introduces
// Forget/Abandon/Optimize-again terminology or a technical recovery copy.

import { rosterStorageFor, useAuthorityStore, type RosterStorage } from "@/lib/store";
// DIRECT LEAF IMPORTS, not the `@/lib/optimize` and `@/lib/roster-viewer` barrels.
// Both barrels' export surfaces reach back into `@/lib/roster`, so importing them from
// inside the roster domain closed two real ESM cycles. Ownership is unchanged: F2 still
// owns capture and session authority, F4 still owns the view key.
import { notifyRosterCaptureCleared } from "@/lib/optimize/roster-capture-app";
import { ROSTER_VIEW_PREFERENCE_KEY } from "@/lib/roster-viewer/view-preference";
import {
  clearAllOptimizeSessions,
  clearRetirementPending,
  OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
  type SessionTransactionStorage,
} from "@/lib/optimize/session-transaction";
import { acquireSessionStorage } from "@/lib/optimize/session-storage";
import {
  purgeRetiredSubmissionSnapshot,
  type SubmissionSnapshotStore,
} from "@/lib/optimize/submission-snapshot";

/** The residue report for the session-storage cut. */
export interface SessionResidueReport {
  /** Every optimize session key — the legacy `nurse.optimize.session` slot and
   *  every `nurse.optimize.session.<ownerId>` record — was provably absent. */
  readonly sessionCleared: boolean;
  /** Optimize keys that survived the sweep (empty when `sessionCleared`). */
  readonly sessionRemaining: readonly string[];
  /** The retirement-marker key (`nurse.optimize.retire-pending`) was provably absent. */
  readonly retireMarkerCleared: boolean;
}

/** The outcome of a Clear, with the residue report the ticket requires. */
export interface RosterClearOutcome {
  /** `cleared` only when every sensitive surface is provably empty afterwards. */
  readonly status: "cleared" | "failed";
  /** The new clear epoch F1 advanced to. */
  readonly epoch: number;
  /** Sensitive rows that survived the F1 purge (non-zero ⇒ `failed`). */
  readonly remaining: { readonly roster: number; readonly snapshot: number };
  /** Whether the F2 capture gate was invalidated. */
  readonly captureNotified: boolean;
  /** Whether the optimize session + retirement-marker residue was provably removed. */
  readonly sessionResidue: SessionResidueReport;
  /** Whether the localStorage view preference was provably removed. */
  readonly viewMetadataCleared: boolean;
}

/** The dependencies (injectable for tests). */
export interface RosterClearDeps {
  /** A function that clears the localStorage view preference. Defaults to live. */
  readonly clearViewMetadata?: () => boolean;
  /** A function that notifies F2 capture. Defaults to the app-lifetime gate. */
  readonly notifyCapture?: () => Promise<void>;
  /** The session transaction storage (sessionStorage). Defaults to the live one. */
  readonly sessionStorage?: SessionTransactionStorage;
  /**
   * The roster storage to purge. Defaults to the app singleton. Injectable so a
   * proof can drive THIS orchestrator — ordering, fail-closed aggregation and all
   * — against a per-tab database, rather than re-implementing it in a test where
   * a production regression could never make the proof fail.
   */
  readonly rosterStorage?: RosterStorage;
}

/**
 * Clear roster & stored data.
 *
 * Order: capture invalidate → F1 verified purge → session/marker residue → view
 * metadata, each fail-closed. The autosave queue is fenced by the epoch bump
 * inside the F1 purge (its pending write returns terminal `stale-epoch`); the
 * editing hook disposes its queue when the working document becomes null after
 * the caller reloads. A rejected or partial cut returns `failed` with residue.
 */
export async function clearRosterDataAndNotify(
  deps: RosterClearDeps = {},
): Promise<RosterClearOutcome> {
  // plq5 P2: the Roster screen clears the OPEN schedule's roster only; other
  // schedules keep theirs. (The epoch bump inside the purge stays origin-wide.)
  const scenarioId = useAuthorityStore.getState().scenarioId;

  // 1. INVALIDATE F2 CAPTURE AUTHORITY FIRST. Settling the gate's in-flight
  //    captures before the purge means none can land fresh sensitive data on the
  //    far side of the destructive work. A capture that reads the NEW epoch after
  //    the purge is a different matter (a new flight); settling here disposes the
  //    in-flight ones this process already authorized. A failure is recorded but
  //    does not abort: the data purge is the privacy-critical half, and a broken
  //    gate is reported honestly in the outcome.
  let captureNotified = true;
  try {
    await (deps.notifyCapture ?? (() => notifyRosterCaptureCleared(scenarioId)))();
  } catch {
    captureNotified = false;
  }

  // 2. F1 VERIFIED PURGE. Advances the epoch and clears roster + snapshot stores
  //    in ONE transaction, so a concurrent write either commits BEFORE (and is
  //    purged) or runs AFTER and is fenced by the new epoch. Nothing can observe
  //    the new epoch until the purge is part of the same commit. A rejection
  //    (rare: a broken IndexedDB) is caught so the caller gets a report, not an
  //    unhandled promise.
  const storage = deps.rosterStorage ?? rosterStorageFor(scenarioId);
  let purgeStatus: "cleared" | "failed" = "failed";
  let epoch = 0;
  let remaining = { roster: 0, snapshot: 0 };
  try {
    const outcome = await storage.clearRosterData();
    purgeStatus = outcome.status;
    epoch = outcome.epoch;
    remaining = outcome.status === "failed" ? outcome.remaining : { roster: 0, snapshot: 0 };
  } catch {
    // The purge threw. Best-effort: read the current epoch so the report carries
    // something honest. Every downstream cut still runs and is reported.
    try {
      epoch = await storage.getClearEpoch();
    } catch {
      epoch = 0;
    }
    purgeStatus = "failed";
  }

  // 3. SESSION + RETIREMENT-MARKER RESIDUE. The optimize session record carries
  //    the real-identity reverse map; the retirement marker carries an opaque
  //    owner id. Both are tab-scoped sessionStorage the ticket names, and both
  //    are removed with verified read-back through the existing helpers.
  const sessionResidue = clearSessionResidue(deps.sessionStorage ?? acquireSessionStorage());

  // 4. VIEW METADATA. The localStorage lens/day preference is roster residue the
  //    ticket names; it carries no personal data but is cleared for honesty.
  const viewMetadataCleared = (deps.clearViewMetadata ?? clearViewPreferenceLive)();

  // 5. AGGREGATE FAIL-CLOSED REPORT. A single failed cut downgrades the whole
  //    outcome: a privacy action never reports success while residue remains.
  const status: "cleared" | "failed" =
    purgeStatus === "cleared" &&
    captureNotified &&
    sessionResidue.sessionCleared &&
    sessionResidue.retireMarkerCleared &&
    viewMetadataCleared
      ? "cleared"
      : "failed";

  return {
    status,
    epoch,
    remaining,
    captureNotified,
    sessionResidue,
    viewMetadataCleared,
  };
}

/** The outcome of {@link clearRunResidue}. */
export interface RunResidueOutcome {
  /** `cleared` only when the session, marker and view residue are provably gone. */
  readonly status: "cleared" | "failed";
  readonly sessionResidue: SessionResidueReport;
  readonly viewMetadataCleared: boolean;
}

/**
 * Leave the last run behind WITHOUT touching any saved roster (plq5 P2, New schedule).
 *
 * Each schedule keeps its own roster, candidate and snapshot, so none of them is
 * purged and no capture is invalidated: a run still in flight lands in the schedule
 * it was submitted from. Only this tab's run residue goes, so the new schedule's
 * Optimize screen does not reattach to the previous run: the optimize session
 * records, the retirement marker and the roster view metadata, each verified.
 *
 * The legacy retirement marker is the only handle to the snapshot it names, so that
 * snapshot is purged FIRST; if its removal is not proven, the marker is kept (and
 * the cut reports failure) rather than stranding the snapshot's real identities.
 */
export async function clearRunResidue(
  deps: Pick<RosterClearDeps, "clearViewMetadata" | "sessionStorage"> & {
    /** Where the marker's snapshot lives. Defaults to the app's roster storage. */
    readonly snapshotStore?: SubmissionSnapshotStore;
  } = {},
): Promise<RunResidueOutcome> {
  const storage = deps.sessionStorage ?? acquireSessionStorage();
  const owner = retirementMarkerOwner(storage);
  const markerPurged =
    owner === null ||
    (await purgeRetiredSubmissionSnapshot(owner, deps.snapshotStore).catch(() => null))?.status ===
      "purged";
  const sessionResidue = clearSessionResidue(storage, { keepMarker: !markerPurged });
  const viewMetadataCleared = (deps.clearViewMetadata ?? clearViewPreferenceLive)();
  const status =
    sessionResidue.sessionCleared && sessionResidue.retireMarkerCleared && viewMetadataCleared
      ? "cleared"
      : "failed";
  return { status, sessionResidue, viewMetadataCleared };
}

/**
 * Remove every optimize session record and the retirement marker, with verified
 * read-back.
 *
 * Records are keyed per owner now, so Clear can no longer name the one key it has
 * to remove. It enumerates the optimize keys and removes exactly those — never
 * `sessionStorage.clear()`, which would destroy unrelated keys this tab's other
 * features own. A store that cannot be enumerated is residue UNKNOWN, and
 * reported as not-cleared: a privacy action must not claim a purge it could not
 * observe.
 */
function clearSessionResidue(
  storage: SessionTransactionStorage,
  options: { keepMarker?: boolean } = {},
): SessionResidueReport {
  let sessionCleared = false;
  let sessionRemaining: readonly string[] = [];
  try {
    const swept = clearAllOptimizeSessions(storage);
    sessionCleared = swept.status === "cleared";
    sessionRemaining = swept.remaining;
  } catch {
    sessionCleared = false;
  }

  // Retirement marker: reuse the verified-removal helper.
  let retireMarkerCleared = false;
  if (options.keepMarker) return { sessionCleared, sessionRemaining, retireMarkerCleared };
  try {
    retireMarkerCleared = clearRetirementPending(storage).status === "cleared";
  } catch {
    retireMarkerCleared = false;
  }

  return { sessionCleared, sessionRemaining, retireMarkerCleared };
}

/**
 * The snapshot owner the legacy retirement marker names: a bare owner id, or the
 * `{ ownerId }` record an older build wrote. `null` when there is no marker.
 */
function retirementMarkerOwner(storage: SessionTransactionStorage): string | null {
  let raw: string | null;
  try {
    raw = storage.getItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const ownerId = (parsed as { ownerId?: unknown } | null)?.ownerId;
    if (typeof ownerId === "string") return ownerId;
  } catch {
    // Not JSON: the bare owner id.
  }
  return raw;
}

/**
 * Remove the roster view preference from localStorage. Returns false if storage
 * is unavailable or the entry could not be removed. Safe in SSR (no `window`).
 */
export function clearViewPreferenceLive(): boolean {
  try {
    if (typeof window === "undefined") return true;
    window.localStorage.removeItem(ROSTER_VIEW_PREFERENCE_KEY);
    return window.localStorage.getItem(ROSTER_VIEW_PREFERENCE_KEY) === null;
  } catch {
    return false;
  }
}
