"use client";

// Working roster panel (F5) — the editable roster surface shown when a working
// roster exists. Owns the editing hook (session edits + autosave) and the F5
// document actions (export roster file, export edited XLSX, import, clear).
//
// Split out of `roster-section` so the editing hook is always called
// unconditionally (Rules of Hooks): this component is only mounted when a working
// roster is present, so the hook's lifetime matches the document's.
//
// ONE REPLACEMENT COORDINATOR (the P0-2 closure). Both candidate Load and roster
// Import go through the same editing/autosave authority: a pending save is
// awaited via `settleReplacement()`; a FAILED save does not hang — it surfaces an
// explicit plain-language "Discard unsaved edits and replace" confirmation. The
// normal replacement warning is applied (Import confirms replacement of an
// existing roster even without unsaved edits). Selection and single-level undo
// reset ONLY after a durable promotion succeeds; a rejected/conflicted/
// quota-failed replacement preserves both.

import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import { rosterStorage } from "@/lib/store";
import {
  clearRosterDataAndNotify,
  importRosterFileToWorking,
  promoteCandidateRosterToWorking,
  type RosterClearOutcome,
  type RosterDocument,
} from "@/lib/roster";
import type { CurrentCandidatePointer } from "@/lib/store";
import type { RosterImportOutcome, WorkingPromotionOutcome } from "@/lib/roster";
import { useRosterChangeRequest } from "./use-roster-change-request";
import { Callout } from "@/components/optimize/callout";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { RosterActions } from "./roster-actions";
import { RosterContentWidthProvider } from "./roster-content-width";
import { describeReplacementFailure, ROSTER_CLEAR_PARTIAL_MESSAGE } from "./replacement-outcome";
import { RosterViewer } from "./roster-viewer";
import { useRosterEditing } from "./use-roster-editing";

/** A pending replacement held while a confirmation is open. */
type PendingReplacement =
  | { kind: "load"; pointer: CurrentCandidatePointer }
  | { kind: "import"; file: File };

/**
 * The imperative handle the roster section uses to route a candidate Load through
 * this panel's save/replacement authority when a working roster is on screen.
 */
export interface WorkingRosterPanelHandle {
  /** Coordinate a candidate Load through the save authority and promote it. */
  requestLoadCandidate(pointer: CurrentCandidatePointer): Promise<void>;
}

export interface WorkingRosterPanelProps {
  /** The immutable working-roster document read from F1 storage. */
  document: RosterDocument;
  /** The F1 working-row revision (the CAS baseline for autosave). */
  revision: number | null;
  /** Re-read the working roster after Import/Load/Clear. */
  reload: () => Promise<void>;
}

export const WorkingRosterPanel = forwardRef<WorkingRosterPanelHandle, WorkingRosterPanelProps>(
  function WorkingRosterPanel({ document, revision, reload }, ref) {
    const editing = useRosterEditing({ document, revision, reload });
    // A change the user approved elsewhere (the assistant's swap card) lands here,
    // through this panel's own edit session, or not at all.
    useRosterChangeRequest(editing);
    const [confirmClear, setConfirmClear] = useState(false);
    // A replacement awaiting the normal "replace the roster" confirmation.
    const [confirmReplace, setConfirmReplace] = useState<PendingReplacement | null>(null);
    // A replacement whose pending save FAILED and now needs explicit discard.
    const [confirmDiscard, setConfirmDiscard] = useState<PendingReplacement | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [clearReport, setClearReport] = useState<RosterClearOutcome | null>(null);

    // The shared promotion primitive: perform the exact validated replacement,
    // then reset selection/undo ONLY after a durable promotion succeeds.
    const performPromotion = useCallback(
      async (pending: PendingReplacement): Promise<void> => {
        setActionError(null);
        const epoch = await rosterStorage.getClearEpoch();
        const workingRow = await rosterStorage.readWorking<RosterDocument>();
        const outcome: WorkingPromotionOutcome | RosterImportOutcome =
          pending.kind === "load"
            ? await promoteCandidateRosterToWorking(pending.pointer, {
                storage: rosterStorage,
                expectedWorkingRevision: workingRow?.revision ?? null,
                expectedClearEpoch: epoch,
              })
            : await importRosterFileToWorking(pending.file, {
                storage: rosterStorage,
                expectedWorkingRevision: workingRow?.revision ?? null,
                expectedClearEpoch: epoch,
              });

        if (outcome.status === "promoted") {
          await reload();
          // Selection and undo reset ONLY after durable success.
          editing.resetAfterReplacement();
          return;
        }
        // Rejected/conflicted/quota-failed: preserve selection + undo, surface why.
        // The wording is shared with the empty-state actions so the same storage
        // answer never reads as two different refusals.
        setActionError(describeReplacementFailure(outcome, pending.kind));
        if (outcome.status === "version-conflict") await reload();
      },
      [editing, reload],
    );

    // The shared coordination gate: await a pending save; branch on the SETTLED
    // outcome. A failed save does NOT hang — it routes to the discard dialog.
    const coordinate = useCallback(
      async (pending: PendingReplacement): Promise<void> => {
        if (editing.save.status === "failed") {
          setConfirmDiscard(pending);
          return;
        }
        if (editing.save.dirty) {
          const settled = await editing.settleReplacement();
          if (settled === "failed") {
            setConfirmDiscard(pending);
            return;
          }
        }
        await performPromotion(pending);
      },
      [editing, performPromotion],
    );

    // Candidate Load entry — exposed to the roster section via the imperative
    // handle so Load goes through the SAME authority as Import.
    useImperativeHandle(
      ref,
      () => ({
        async requestLoadCandidate(pointer: CurrentCandidatePointer) {
          await coordinate({ kind: "load", pointer });
        },
      }),
      [coordinate],
    );

    // Import entry — always confirms replacement of an existing roster (the
    // normal replacement warning applies even without unsaved edits).
    const onImportFile = useCallback(
      (file: File) => {
        setActionError(null);
        // If the save is already failed, the discard dialog carries the file.
        if (editing.save.status === "failed") {
          setConfirmDiscard({ kind: "import", file });
          return;
        }
        setConfirmReplace({ kind: "import", file });
      },
      [editing.save.status],
    );

    const onConfirmReplace = useCallback(async () => {
      const pending = confirmReplace;
      setConfirmReplace(null);
      if (pending === null) return;
      await coordinate(pending);
    }, [confirmReplace, coordinate]);

    const onConfirmDiscard = useCallback(async () => {
      const pending = confirmDiscard;
      setConfirmDiscard(null);
      if (pending === null) return;
      // The user explicitly discarded unsaved edits; proceed WITHOUT draining.
      await performPromotion(pending);
    }, [confirmDiscard, performPromotion]);

    const onClear = useCallback(() => setConfirmClear(true), []);

    const onConfirmClear = useCallback(async () => {
      setConfirmClear(false);
      setActionError(null);
      // Invalidate the save authority BEFORE the destructive storage work: disarms
      // the loss guard and drops pending/retry state so no parked write can land
      // across the purge. The epoch fence inside F1's purge is the storage-layer
      // guarantee; this is the in-memory authority.
      editing.invalidateForClear();
      const outcome = await clearRosterDataAndNotify();
      setClearReport(outcome);
      if (outcome.status === "cleared") {
        await reload();
      } else {
        setActionError(ROSTER_CLEAR_PARTIAL_MESSAGE);
      }
    }, [editing, reload]);

    const replaceDescription =
      confirmReplace?.kind === "import"
        ? "The roster you are viewing will be replaced by the imported file."
        : "The roster you are viewing will be replaced by your latest saved result.";

    return (
      <>
        {/* ONE measured roster-content box wraps the action row AND the lens/data
            surface, so the two can never disagree about how narrow the roster is
            (G7). `min-w-0` keeps the internal scrollers inside it from pushing
            the document into horizontal overflow. */}
        <RosterContentWidthProvider className="flex min-w-0 flex-col gap-3">
          <RosterActions
            document={editing.editedDocument}
            save={editing.save}
            onRetrySave={() => void editing.retrySave()}
            onImportFile={(file) => void onImportFile(file)}
            onClear={onClear}
            onExportError={(message) => setActionError(message)}
          />
          {actionError !== null ? (
            <Callout tone="error" placement="page" data-testid="roster-action-error" alert>
              {actionError}
            </Callout>
          ) : null}
          {clearReport !== null && clearReport.status === "failed" ? (
            <Callout tone="error" placement="page" data-testid="roster-clear-failed" alert>
              The roster could not be fully cleared — some data remains in this browser.
            </Callout>
          ) : null}
          <RosterViewer
            document={editing.editedDocument}
            editing={editing.ready ? editing : undefined}
          />
        </RosterContentWidthProvider>

        <ConfirmDialog
          open={confirmClear}
          onOpenChange={setConfirmClear}
          title="Clear roster & stored data?"
          description="This permanently removes the roster on screen, every saved result, and all roster data stored in this browser. This cannot be undone."
          confirmLabel="Clear all roster data"
          variant="destructive"
          onConfirm={() => void onConfirmClear()}
        />
        <ConfirmDialog
          open={confirmReplace !== null}
          onOpenChange={(open) => !open && setConfirmReplace(null)}
          title="Replace the roster on screen?"
          description={replaceDescription}
          confirmLabel="Replace roster"
          onConfirm={() => void onConfirmReplace()}
        />
        <ConfirmDialog
          open={confirmDiscard !== null}
          onOpenChange={(open) => !open && setConfirmDiscard(null)}
          title="Discard unsaved edits and replace?"
          description="The current roster has edits that could not be saved. Replacing it discards those edits."
          confirmLabel="Discard edits & replace"
          variant="destructive"
          onConfirm={() => void onConfirmDiscard()}
        />
      </>
    );
  },
);
