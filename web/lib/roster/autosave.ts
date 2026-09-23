// Edit autosave + loss authority (F5). One serialized, revisioned compare-and-swap
// queue over F1's `writeWorkingEdit`, with the global Saving/saved/failed feedback
// and the browser-unload loss guard Core Flows and the Tech Plan require.
//
// F5 owns the BEHAVIOR; F1 supplies the PRIMITIVE (`writeWorkingEdit`'s revisioned
// CAS + clear-epoch fence). This module never touches Dexie directly and never owns
// document shape — it hands F1 the document the editor just produced and tracks
// the revision F1 returns.
//
// This queue is the edit operation's only production caller, which is exactly what
// its contract assumes: every document that reaches it is a new revision of the
// SAME working roster, so F1 keeps the row's candidate provenance. Load and Import
// replace the whole document and go through F1's promotion authorities instead.
//
// The load-bearing guarantees:
//
//   • SERIALIZED. At most one `writeWorkingEdit` is in flight. A set/swap/undo that
//     arrives while a write is pending COALESCES behind it: when the in-flight
//     write settles, the queue writes the LATEST document, not each intermediate
//     one. Intermediate revisions are skipped by design — they were superseded
//     before they reached storage, and serializing them would just delay the
//     document the user is actually looking at.
//   • CAS-REVISIONED. Each write carries the revision the queue last observed.
//     A `conflict` (another writer — a Load/Import promotion or another tab —
//     committed first) is NEVER resolved by adopting the rival revision and
//     overwriting it with this tab's whole stale document: that is the silent
//     lost update the contract forbids. The ORIGINAL expected revision is
//     RETAINED, so a conflict surfaces as a persistent `failed` state (the edit
//     stays visible for rescue/retry/discard) and Retry can never silently
//     rebase onto the rival. A continuing conflict stays failed until the user
//     makes an explicit current-basis decision (discard/reload/replace/export).
//   • LOSS GUARD. While a write is pending OR failed, `beforeunload` is armed so
//     the browser warns the user before discarding unsaved work. The guard is
//     disarmed the moment the queue is clean (or on dispose).
//   • REPLACEMENT GATES ON SETTLEMENT. `settle()` resolves the moment an
//     in-flight write completes (saved OR failed), so a Load/Import coordinator
//     can await the pending work without hanging on a failure the way `drain()`
//     (which only resolves when clean) would.
//   • FAILED KEEPS THE EDIT. A failed write does NOT revert the in-memory roster;
//     the user's edit stays visible, `Save roster file` stays available as a
//     rescue, and Retry re-attempts the retained document against a fresh revision.
//   • CLEAR INVALIDATES. A `stale-epoch` outcome (Clear bumped the epoch while a
//     write was pending) is terminal for that document: the storage it targeted
//     no longer exists, so the queue drops it without a Retry offer — the Clear
//     flow owns the resulting empty state.

import type { RosterStorage, WorkingEditOutcome } from "@/lib/store";

/** The global save state the UI surfaces. */
export type AutosaveStatus = "idle" | "saving" | "saved" | "failed";

/**
 * The reason a `failed` status holds. Distinct so the UI can tell "the write
 * itself threw" (quota/connection) from "the CAS kept conflicting" and surface
 * the right copy.
 */
export type AutosaveFailureReason = "write-error" | "cas-conflict";

export interface AutosaveFailure {
  readonly reason: AutosaveFailureReason;
  /** A plain-language message for the save-failed banner. */
  readonly message: string;
}

/** A snapshot of the queue a subscriber (the UI hook) reads. */
export interface AutosaveSnapshot {
  readonly status: AutosaveStatus;
  readonly failure: AutosaveFailure | null;
  /**
   * True when there are uncommitted edits — a write is pending OR the last write
   * failed. This is the loss-guard and replacement-gate signal: navigation and
   * Load/Import must respect it.
   */
  readonly dirty: boolean;
}

/** A write outcome extended with the local "threw" case (storage unreachable). */
type EnqueueOutcome = WorkingEditOutcome | { status: "threw" };

/** The dependencies the queue needs (injectable for tests). */
export interface AutosaveDeps {
  readonly storage: RosterStorage;
  /** The clear epoch captured when the working roster was loaded. */
  readonly clearEpoch: number;
  /** The working revision observed when the working roster was loaded. */
  readonly initialRevision: number | null;
  /**
   * Arm the beforeunload loss guard. Receives a predicate that returns a truthy
   * value when unload should be blocked; returns a disposer. Defaults to the
   * browser `beforeunload` listener when `window` exists.
   */
  readonly armLossGuard?: (isDirty: () => boolean) => () => void;
}

const IDLE_SNAPSHOT: AutosaveSnapshot = Object.freeze({
  status: "idle",
  failure: null,
  dirty: false,
});

/**
 * Create the one serialized autosave queue for a working-roster editing session.
 *
 * The queue is created when a working roster becomes editable (the editor mounts)
 * and disposed when it unmounts or the roster is replaced. A fresh queue is
 * created for the new roster — the revision and epoch are per-document.
 */
export function createAutosaveQueue(deps: AutosaveDeps): AutosaveQueue {
  // The revision the queue expects the NEXT write to find at `working`. Bumped on
  // every successful commit; adopted from a conflict.
  let expectedRevision = deps.initialRevision;
  // The document waiting behind the in-flight write (coalesced to the latest).
  let pendingDocument: unknown = null;
  // Resolvers awaiting the write that covers their document.
  const pendingResolvers: Array<(outcome: EnqueueOutcome) => void> = [];
  let writing = false;
  // The document currently being written (held so retry/failure can reference it).
  let writingDocument: unknown = null;
  // The document that last failed, retained for Retry.
  let failedDocument: unknown = null;
  let failure: AutosaveFailure | null = null;
  let hasCommitted = false;
  const subscribers = new Set<() => void>();

  const isDirty = () => writing || pendingDocument !== null || failure !== null;

  const snapshot = (): AutosaveSnapshot => {
    if (failure !== null) return { status: "failed", failure, dirty: true };
    if (writing || pendingDocument !== null)
      return { status: "saving", failure: null, dirty: true };
    if (hasCommitted) return { status: "saved", failure: null, dirty: false };
    return IDLE_SNAPSHOT;
  };

  const emit = () => {
    for (const listener of subscribers) listener();
  };

  const drainResolvers = (
    outcome: EnqueueOutcome,
    resolvers: Array<(outcome: EnqueueOutcome) => void>,
  ) => {
    for (const resolve of resolvers) resolve(outcome);
  };

  // Arm the browser loss guard once. The predicate reads live dirty state.
  const disarm = (deps.armLossGuard ?? browserLossGuard)(isDirty);

  // Microtask-deferred pump scheduling: edits arriving in the same synchronous
  // tick coalesce into a SINGLE write. Without this deferral, the first enqueue
  // would synchronously enter `pump`, promote its document to the in-flight slot,
  // and a second enqueue in the same tick would land behind it as a SEPARATE
  // write — defeating the coalescing the contract promises.
  let pumpScheduled = false;
  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      void pump();
    });
  }

  async function writeOnce(document: unknown): Promise<EnqueueOutcome> {
    try {
      return await deps.storage.writeWorkingEdit({
        document,
        expectedRevision,
        expectedClearEpoch: deps.clearEpoch,
      });
    } catch {
      return { status: "threw" };
    }
  }

  async function pump(): Promise<void> {
    if (writing) return;
    if (pendingDocument === null) return;

    // Promote the pending document to the in-flight slot and clear the queue.
    writingDocument = pendingDocument;
    pendingDocument = null;
    // Snapshot the resolvers waiting for THIS document and clear the list. New
    // enqueues during the write accumulate in the emptied list and fire when the
    // NEXT write (covering their newer document) settles — never with this one.
    const resolversForThisWrite = pendingResolvers.splice(0);
    writing = true;
    emit();

    let outcome = await writeOnce(writingDocument);

    if (outcome.status === "written") {
      expectedRevision = outcome.revision;
      hasCommitted = true;
      failure = null;
      failedDocument = null;
    } else if (outcome.status === "conflict") {
      // A rival writer (another tab, a Load/Import promotion) committed first.
      // NEVER adopt its revision and retry the same whole stale document: that
      // would silently overwrite the rival's document with this tab's old
      // submission/context/overlay — a lost update, not a merge, and the contract
      // forbids it. Retain the ORIGINAL expected revision (do NOT adopt
      // `outcome.currentRevision`) so Retry cannot silently rebase either. The
      // conflict stays failed until the user makes an explicit current-basis
      // decision: discard/reload/replace, or export a roster file as rescue.
      failure = { reason: "cas-conflict", message: SAVE_FAILED_CONFLICT_MESSAGE };
      failedDocument = writingDocument;
    } else if (outcome.status === "stale-epoch") {
      // Clear bumped the epoch. Terminal: the Clear flow owns the resulting state.
    } else {
      // threw: storage unreachable (quota / connection). Keep the edit; offer Retry.
      failure = { reason: "write-error", message: SAVE_FAILED_MESSAGE };
      failedDocument = writingDocument;
    }

    writing = false;
    writingDocument = null;
    drainResolvers(outcome, resolversForThisWrite);
    emit();

    // A newer edit may have queued during the write; pump it. If the write failed
    // and nothing queued, the failed status sticks until Retry or a new edit.
    if (pendingDocument !== null) void pump();
  }

  const queue: AutosaveQueue = {
    enqueue(document) {
      pendingDocument = document;
      // A new edit clears a prior failure: the user is moving forward, and the
      // new document supersedes the one that failed.
      failure = null;
      const promise = new Promise<EnqueueOutcome>((resolve) => {
        pendingResolvers.push(resolve);
      });
      schedulePump();
      return promise;
    },

    retry() {
      if (failure === null) return Promise.resolve({ status: "already-idle" } as const);
      const document = failedDocument;
      if (document === null) return Promise.resolve({ status: "no-document" } as const);
      failure = null;
      return queue.enqueue(document).then((outcome) => ({ status: "retried", outcome }));
    },

    drain() {
      if (!isDirty()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = () => {
          if (!isDirty()) {
            subscribers.delete(check);
            resolve();
          }
        };
        subscribers.add(check);
      });
    },

    /**
     * Resolve the moment an in-flight write SETTLES (no write pending), returning
     * the resulting snapshot. Unlike `drain()`, this does NOT hang on a failure:
     * it resolves as soon as the pending work completes, whether it landed
     * (`saved`) or failed (`failed`). The replacement coordinator gates on this so
     * a Load/Import can branch on the settled outcome rather than wait for a clean
     * state that a persistent failure never reaches.
     */
    settle(): Promise<AutosaveSnapshot> {
      if (!writing && pendingDocument === null) return Promise.resolve(snapshot());
      return new Promise<AutosaveSnapshot>((resolve) => {
        const check = () => {
          if (!writing && pendingDocument === null) {
            subscribers.delete(check);
            resolve(snapshot());
          }
        };
        subscribers.add(check);
      });
    },

    snapshot,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    isDirty,
    dispose() {
      disarm();
      subscribers.clear();
    },
    get expectedRevision() {
      return expectedRevision;
    },
  };

  return queue;
}

export interface AutosaveQueue {
  /**
   * Enqueue a CAS write of the working-roster document. Resolves when the write
   * that covers THIS document settles (it may be coalesced behind an in-flight
   * write). Never rejects — failures land in the snapshot, not as thrown promises.
   */
  enqueue(document: unknown): Promise<EnqueueOutcome>;
  /** Retry the last failed write. No-op (`already-idle`) when not failed. */
  retry(): Promise<
    | { status: "retried"; outcome: EnqueueOutcome }
    | { status: "already-idle" }
    | { status: "no-document" }
  >;
  /** Resolve when no write is pending and no failure is outstanding. */
  drain(): Promise<void>;
  /**
   * Resolve the moment an in-flight write settles (no write pending), returning
   * the resulting snapshot. Does NOT hang on failure — resolves on settlement.
   * The replacement coordinator gates on this.
   */
  settle(): Promise<AutosaveSnapshot>;
  snapshot(): AutosaveSnapshot;
  subscribe(listener: () => void): () => void;
  /** Whether there are uncommitted edits (pending or failed). The loss-guard signal. */
  isDirty(): boolean;
  /** Tear down: disarm the loss guard and drop subscribers. */
  dispose(): void;
  /** Test-only: the expected revision for the next write. */
  readonly expectedRevision: number | null;
}

/** Re-exported so callers can narrow the local `threw` outcome. */
export type { EnqueueOutcome };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const SAVE_FAILED_MESSAGE =
  "The roster could not be saved. Your edits are still here — retry, or export a roster file to keep a copy.";
const SAVE_FAILED_CONFLICT_MESSAGE =
  "The roster changed underneath this edit and could not be saved. Retry, or export a roster file to keep a copy.";

/** Re-exported for the UI's save-failed banner copy. */
export const AUTOSAVE_MESSAGES = {
  failed: SAVE_FAILED_MESSAGE,
  conflict: SAVE_FAILED_CONFLICT_MESSAGE,
} as const;

// ---------------------------------------------------------------------------
// Browser loss guard
// ---------------------------------------------------------------------------

/**
 * The default `beforeunload` loss guard. Registers a listener that calls
 * `preventDefault()` while the predicate is true, so the browser warns before
 * discarding unsaved edits. Returns a disposer. Safe in SSR (no `window`).
 */
function browserLossGuard(isDirty: () => boolean): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: BeforeUnloadEvent) => {
    if (!isDirty()) return;
    // Modern browsers ignore the custom string but require preventDefault to
    // trigger the generic "leave site?" prompt.
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}
