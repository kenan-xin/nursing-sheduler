"use client";

// Roster editing hook (F5) — the one React coordinator that wires the editing
// domain (`./editing`), the autosave/loss authority (`./autosave`), and the
// working-roster reads/writes (F1 storage).
//
// The hook owns the session-scoped editing state for ONE working roster:
//   • the current edit session (overlay + single undo target);
//   • the serialized autosave queue (Saving/saved/failed);
//   • the loss-guard and replacement-gating signals.
//
// It owns NO document shape: the document it edits is whatever F1 last promoted,
// and the edits overlay is the only mutable part. The hook rebuilds the edited
// document as `{ ...workingDocument, edits: session.edits }` on every change, so
// the viewer always renders the current (solved + edits) assignments.
//
// A fresh queue + session are created whenever the working document's IDENTITY
// changes (Load / Import / reload after Clear), so undo history and the CAS
// revision never cross roster boundaries.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rosterStorage } from "@/lib/store";
import {
  applyCellBatchToSession,
  applyCellEditToSession,
  applyCellSwapToSession,
  canUndoSession,
  deriveCurrentDays,
  emptyEditSession,
  resetSession,
  rosterBaseDays,
  undoSessionEdit,
  type EditCoordinate,
  type EditSession,
  type OverlayBounds,
  type RosterEdit,
} from "@/lib/roster";
import type { RosterBorrowedRow, RosterDayState, RosterDocument } from "@/lib/roster";
import { createAutosaveQueue, type AutosaveQueue, type AutosaveSnapshot } from "@/lib/roster";

export interface RosterEditingOptions {
  /** The working roster document read from F1 storage (the immutable base). */
  readonly document: RosterDocument;
  /** The storage revision of `document` (from the F1 working row). */
  readonly revision: number | null;
  /** Re-read the working roster after a Load/Import/Clear (from `useWorkingRoster`). */
  readonly reload: () => Promise<void>;
}

export interface RosterEditingState {
  /** The document with the current session edits applied (what the viewer renders). */
  readonly editedDocument: RosterDocument;
  /** Set one cell to a day-state. Normalizes + autosaves as one revision. */
  setCell(coordinate: EditCoordinate, day: RosterDayState): void;
  /** Swap two cells atomically. One revision, one undo step. */
  swapCells(a: EditCoordinate, b: EditCoordinate): void;
  /**
   * Set several cells as ONE edit (one undo step, one autosave revision). False when
   * the batch is rejected; nothing changes then. The assistant's swap card uses it via
   * `useRosterChangeRequest`. `addPeople` appends borrowed rows in the same revision,
   * so `cells` may address them (index `people + borrowed + i`).
   */
  applyCells(cells: readonly RosterEdit[], addPeople?: readonly RosterBorrowedRow[]): boolean;
  /** Revert the last set/swap. Disabled when there is nothing to undo. */
  undo(): void;
  /** Whether an undo is available. */
  readonly canUndo: boolean;
  /** The autosave status, for the Saving/saved/failed feedback. */
  readonly save: AutosaveSnapshot;
  /** Retry the last failed save. */
  retrySave(): Promise<void>;
  /**
   * True when the editing authority (autosave queue + epoch + revision) is ready.
   * Until then, edits are BUFFERED (not lost): the first commit before readiness
   * is held and flushed the moment the queue is created. The UI may also gate
   * interactive editing on this so the user never sees a visible-but-unsaved cut.
   */
  readonly ready: boolean;
  /**
   * Await settlement of any pending save and return the resulting state. Used by
   * the replacement coordinator (Load/Import) so a pending save is not raced and a
   * failed save does not hang the replacement. Resolves `"clean"` when the queue
   * is idle/saved, `"failed"` when the pending write settled as a failure.
   */
  settleReplacement(): Promise<"clean" | "failed">;
  /**
   * Clear the cell selection and reset the undo target. Called by the replacement
   * coordinator ONLY after a durable promotion succeeds, so a rejected/conflicted/
   * quota-failed replacement preserves both. (The edit SESSION itself resets
   * automatically when `reload` brings a new document identity.)
   */
  resetAfterReplacement(): void;
  /** Invalidate the save authority (dispose the queue) before a destructive Clear. */
  invalidateForClear(): void;
  /**
   * True when a replacement (Load/Import) must wait or be gated: a save is
   * pending OR the last save failed. Pending → the caller awaits
   * `settleReplacement()`; failed → the caller must obtain explicit discard.
   */
  readonly replacementBlocked: boolean;
  /** The currently-selected cell (for the edit bar), or null. */
  readonly selectedCell: EditCoordinate | null;
  selectCell(coordinate: EditCoordinate | null): void;
}

const IDLE_SAVE: AutosaveSnapshot = { status: "idle", failure: null, dirty: false };

export function useRosterEditing(options: RosterEditingOptions): RosterEditingState {
  const { document, revision, reload } = options;
  const solvedDays = document.solvedDays;
  const shiftTypeIds = useMemo(
    () => document.context.shiftTypes.map((s) => s.id),
    [document.context.shiftTypes],
  );
  // Borrowed rows (roster-file/2) join the axis in the session, not the stored base:
  // the assistant's temporary-nurse card adds them. A new roster adopts its own.
  // Undo restores the rows as they were before the last edit, so undoing the Apply
  // that added a temporary nurse removes her row with her shifts (bead 2rp).
  const [borrowed, setBorrowed] = useState(document.borrowed);
  const borrowedRef = useRef(borrowed);
  borrowedRef.current = borrowed;
  const borrowedUndoTarget = useRef(borrowed);
  const baseDays = useMemo(() => rosterBaseDays({ solvedDays, borrowed }), [solvedDays, borrowed]);
  const bounds: OverlayBounds = useMemo(
    () => ({ solvedDays: baseDays, shiftTypeIds }),
    [baseDays, shiftTypeIds],
  );

  // The edit session resets whenever the working document changes. Comparing the
  // `solvedDays` reference (frozen and unique per document) is enough: a new
  // roster always carries a new grid, and the same grid survives reload.
  const [session, setSession] = useState<EditSession>(() => emptyEditSession(document.edits));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const prevSolved = useRef(solvedDays);
  if (solvedDays !== prevSolved.current) {
    prevSolved.current = solvedDays;
    // A new working roster: reset undo history and adopt the new document's edits.
    setSession((current) => resetSession(current, document.edits));
    setBorrowed(document.borrowed);
    borrowedUndoTarget.current = document.borrowed;
  }

  const [selectedCell, setSelectedCell] = useState<EditCoordinate | null>(null);
  const [save, setSave] = useState<AutosaveSnapshot>(IDLE_SAVE);
  // Ready flips true once the autosave queue (epoch + revision authority) exists.
  // Until then, commits are BUFFERED in `pendingInitializationDocument` and flushed
  // the moment the queue is created, so an edit before initialization is never
  // visible-only and unsaved (the P1 closure finding).
  const [ready, setReady] = useState(false);

  // The autosave queue is created per working document. Recreate it when the
  // solved grid changes (the identity signal for a new roster).
  const queueRef = useRef<AutosaveQueue | null>(null);
  const queueEpoch = useRef(solvedDays);
  // The buffered document waiting for the queue to be ready (P1 guard).
  const pendingInitializationDocument = useRef<RosterDocument | null>(null);

  if (queueEpoch.current !== solvedDays) {
    // New document: dispose the old queue (disarms the old loss guard) and let
    // the effect below create a fresh one with the new revision + epoch.
    queueRef.current?.dispose();
    queueRef.current = null;
    pendingInitializationDocument.current = null;
    queueEpoch.current = solvedDays;
    setReady(false);
  }

  useEffect(() => {
    let cancelled = false;
    // The queue this effect run created, and its subscription — both torn down by
    // this run's cleanup so a re-run (new document identity / revision) never
    // leaves a stale listener or an armed loss guard behind.
    let created: AutosaveQueue | null = null;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      // Read the clear epoch for this document's lifetime. The queue is created
      // once per working roster; a Clear bumps the epoch and the hook is reset by
      // the caller (reload → new document → this effect re-runs).
      const epoch = await rosterStorage.getClearEpoch();
      if (cancelled) return;
      const queue = createAutosaveQueue({
        storage: rosterStorage,
        clearEpoch: epoch,
        initialRevision: revision,
      });
      queueRef.current = queue;
      created = queue;
      setSave(queue.snapshot());
      unsubscribe = queue.subscribe(() => setSave(queue.snapshot()));
      setReady(true);
      // Flush any edit committed before the queue was ready (P1 guard): it was
      // buffered, never lost. The buffer is cleared after the flush is queued.
      const buffered = pendingInitializationDocument.current;
      if (buffered !== null) {
        pendingInitializationDocument.current = null;
        void queue.enqueue(buffered);
      }
    })();
    return () => {
      cancelled = true;
      // Tear down exactly the queue THIS effect run created: unsubscribe (so the
      // dead queue cannot keep pushing snapshots) and dispose (so its loss guard
      // is disarmed). Without this, a re-run left the previous queue's listener
      // and `beforeunload` handler alive for the lifetime of the page.
      unsubscribe?.();
      unsubscribe = null;
      if (created !== null) {
        created.dispose();
        if (queueRef.current === created) queueRef.current = null;
        created = null;
      }
    };
  }, [solvedDays, revision]);

  // Dispose the queue on unmount.
  useEffect(() => {
    return () => {
      queueRef.current?.dispose();
      queueRef.current = null;
    };
  }, []);

  const editedDocument: RosterDocument = useMemo(
    () => ({ ...document, borrowed, edits: session.edits }),
    [document, borrowed, session.edits],
  );

  // Build the next document from a new session and enqueue it for autosave. The
  // document is the immutable base with the new overlay swapped in; everything
  // else (submission, context, coordinateMap, frozenXlsx, provenance) is carried
  // by reference, so only the edits array is fresh.
  //
  // If the queue is not ready yet (the async epoch read has not completed), the
  // document is BUFFERED and flushed when the queue is created — never dropped.
  // The visible session updates immediately so the user sees their edit.
  const commit = useCallback(
    (next: EditSession, nextBorrowed: readonly RosterBorrowedRow[] = borrowedRef.current) => {
      // An edit keeps the rows it started from as the undo target; undo itself
      // (no undo target left) passes the target back in, so this is a no-op then.
      if (next.undoTarget !== null) borrowedUndoTarget.current = borrowedRef.current;
      setSession(next);
      setBorrowed(nextBorrowed);
      borrowedRef.current = nextBorrowed;
      const nextDocument: RosterDocument = {
        ...document,
        borrowed: nextBorrowed,
        edits: next.edits,
      };
      const queue = queueRef.current;
      if (queue !== null) {
        void queue.enqueue(nextDocument);
      } else {
        pendingInitializationDocument.current = nextDocument;
      }
    },
    [document],
  );

  const setCell = useCallback(
    (coordinate: EditCoordinate, day: RosterDayState) => {
      const result = applyCellEditToSession(sessionRef.current, coordinate, day, bounds);
      if (!result.ok) return;
      commit(result.session);
    },
    [bounds, commit],
  );

  const swapCells = useCallback(
    (a: EditCoordinate, b: EditCoordinate) => {
      const result = applyCellSwapToSession(
        sessionRef.current,
        a,
        b,
        deriveCurrentDays(baseDays, sessionRef.current.edits),
        bounds,
      );
      if (!result.ok || !result.touched) return;
      commit(result.session);
    },
    [bounds, baseDays, commit],
  );

  const applyCells = useCallback(
    (cells: readonly RosterEdit[], addPeople: readonly RosterBorrowedRow[] = []): boolean => {
      const nextBorrowed =
        addPeople.length === 0 ? borrowedRef.current : [...borrowedRef.current, ...addPeople];
      const nextBounds =
        addPeople.length === 0
          ? bounds
          : { shiftTypeIds, solvedDays: rosterBaseDays({ solvedDays, borrowed: nextBorrowed }) };
      const result = applyCellBatchToSession(sessionRef.current, cells, nextBounds);
      if (!result.ok) return false;
      commit(result.session, nextBorrowed);
      return true;
    },
    [bounds, shiftTypeIds, solvedDays, commit],
  );

  const undo = useCallback(() => {
    if (!canUndoSession(sessionRef.current)) return;
    commit(undoSessionEdit(sessionRef.current), borrowedUndoTarget.current);
  }, [commit]);

  const retrySave = useCallback(async () => {
    await queueRef.current?.retry();
  }, []);

  const settleReplacement = useCallback(async (): Promise<"clean" | "failed"> => {
    const queue = queueRef.current;
    if (queue === null) return "clean";
    const snapshot = await queue.settle();
    return snapshot.status === "failed" ? "failed" : "clean";
  }, []);

  const resetAfterReplacement = useCallback(() => {
    // Selection clears (it survives a document swap otherwise). The edit SESSION
    // resets automatically via the `prevSolved` mechanism when reload brings a
    // new document identity; clearing it here as well is harmless and explicit.
    setSelectedCell(null);
  }, []);

  const invalidateForClear = useCallback(() => {
    // Dispose the queue before destructive storage work: disarms the loss guard
    // (no beforeunload blocks Clear) and drops pending/retry state so no parked
    // write can land or be retried across the purge. The epoch fence inside F1's
    // purge is the storage-layer guarantee; this is the in-memory authority.
    queueRef.current?.dispose();
    queueRef.current = null;
    pendingInitializationDocument.current = null;
    // Editing goes UNAVAILABLE with the authority. The viewer gates interaction
    // on `ready`, so after invalidation there is no cut where a cell can be
    // changed on screen with no queue to save it and no loss guard armed. If the
    // Clear then fails and the panel stays mounted, the roster is read-only until
    // a reload rebuilds the authority — fail-closed, not visible-but-unsaved.
    setReady(false);
    setSave(IDLE_SAVE);
  }, []);

  const selectCell = useCallback((coordinate: EditCoordinate | null) => {
    setSelectedCell((current) =>
      current !== null &&
      coordinate !== null &&
      current.personIdx === coordinate.personIdx &&
      current.dateIdx === coordinate.dateIdx
        ? null // tap the selected cell again → cancel
        : coordinate,
    );
  }, []);

  // Keep `reload` referenced so it is part of the hook's contract even when the
  // current implementation does not call it directly (Load/Import/Clear live in
  // the section, which holds this hook's return).
  void reload;

  return {
    editedDocument,
    setCell,
    swapCells,
    applyCells,
    undo,
    canUndo: canUndoSession(session),
    save,
    retrySave,
    ready,
    settleReplacement,
    resetAfterReplacement,
    invalidateForClear,
    replacementBlocked: save.dirty,
    selectedCell,
    selectCell,
  };
}
