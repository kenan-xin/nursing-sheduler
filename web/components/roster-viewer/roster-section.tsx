"use client";

// Roster section (F4 + F5) — the roster surface on the Optimize screen.
//
// Renders the editable viewer when a working roster exists, the empty/loading
// states when it does not, and the candidate Load/Retry/Dismiss actions that
// surface a durable F2 candidate. F5 adds: in-place editing (cell set / drag-swap
// / single-level undo), durable autosave with Saving/saved/failed feedback, roster
// file + edited-XLSX export, roster-file import (with discard-gate gating), and
// the verified Clear of all roster + stored data.
//
// G3 adds the EMPTY-state document actions. With no working roster there is
// still a file a recipient may have been sent, and there is still private data
// this browser may be holding — so Import and Clear stay reachable while the
// loaded-roster-only Save/Export controls do not. Both go through the same F1/F3
// authorities the loaded panel uses (`importRosterFileToWorking` with an
// expected working revision of `null`, and `clearRosterDataAndNotify()`); this
// component adds no second storage protocol.
//
// The settled non-technical surface (F2 decision) is preserved: no Forget,
// Abandon, Optimize-again, snapshot/storage/backend-job terminology, or extra
// recovery action. The primary submit button remains "Optimize"; candidate
// Load/Retry/Dismiss and the F5 document actions are all roster-result actions.

import { useCallback, useRef, useState } from "react";
import { FaDownload } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { rosterStorage } from "@/lib/store";
import type { RosterDocument } from "@/lib/roster";
import {
  clearRosterDataAndNotify,
  importRosterFileToWorking,
  promoteCandidateRosterToWorking,
} from "@/lib/roster";
import { isWorkingRosterFromCandidate } from "@/lib/store";
import type { CurrentCandidatePointer } from "@/lib/store";
import type { RosterCaptureSurface } from "@/lib/optimize";
import { Callout } from "@/components/optimize/callout";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyRosterActions } from "./roster-actions";
import { describeReplacementFailure, ROSTER_CLEAR_PARTIAL_MESSAGE } from "./replacement-outcome";
import { useWorkingRoster } from "./use-working-roster";
import { WorkingRosterPanel, type WorkingRosterPanelHandle } from "./working-roster-panel";
export interface RosterSectionProps {
  /**
   * The capture surface. Used ONLY to reach the gate's job/version-keyed
   * durable dismissal — never to decide whether a candidate exists. That
   * authority is F1's durable pointer; see `candidate` below.
   */
  capture: RosterCaptureSurface;
}

export function RosterSection({ capture }: RosterSectionProps) {
  const roster = useWorkingRoster();
  // The imperative handle into the working-roster panel, used to route a
  // candidate Load through the SAME save/replacement authority as Import when a
  // working roster is on screen. Null in the empty state (no panel mounted).
  const panelRef = useRef<WorkingRosterPanelHandle | null>(null);
  const [loadPending, setLoadPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dismissPending, setDismissPending] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState<CurrentCandidatePointer | null>(null);
  // The empty-state document actions. Kept in a channel of their own so an
  // Import/Clear failure never overwrites (or is overwritten by) a candidate
  // Load/Dismiss message describing a different action.
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);

  /**
   * LOAD AUTHORITY IS THE DURABLE PAIR, not a capture state.
   *
   * `capture.stateFor(jobId)` reads the app-lifetime gate's in-memory entries.
   * A fresh app process has no entries, so it answers `idle` for every job that
   * ever committed — which made a perfectly good candidate vanish from the UI on
   * reload, the one moment the durable pointer exists to survive. The pointer
   * plus a candidate document actually read back from F1 is the evidence that a
   * loadable result exists; the gate's opinion is about this process, not the
   * data.
   */
  const candidateOnHand =
    roster.candidate !== null && roster.candidateDocument !== null
      ? { pointer: roster.candidate, document: roster.candidateDocument }
      : null;

  /**
   * ...unless the roster on screen was promoted from EXACTLY this candidate.
   *
   * A completed run whose working slot was empty is promoted into it by the same
   * transaction that stores the candidate (F1's fill-empty CAS), so the durable
   * candidate and the working roster are then the same result. Offering to “load”
   * or “replace” it would be offering the roster the user is looking at — and,
   * once they had edited it, an unlabelled discard-my-edits action, which v1
   * deliberately does not have.
   *
   * Identity is the storage row's recorded `{jobId, candidateVersion}` against the
   * current pointer, and nothing else. Comparing DOCUMENT content instead — the
   * solved-baseline id, say — answers a different question: that hash covers only
   * the ordered people, dates and solved day-states, so an independent run with
   * its own submission, score, coordinate map and frozen workbook shares it
   * whenever the assignments coincide. Suppressing on that made a genuinely
   * distinct latest result invisible and unloadable. A newer capture for the same
   * job moves `candidateVersion`, so it stops matching too and becomes visible.
   * A row with no recorded source (an import, or one written before this metadata
   * existed) never matches, so it never hides anything by inference.
   */
  const loadable = isWorkingRosterFromCandidate(
    roster.candidateSource ?? undefined,
    candidateOnHand?.pointer ?? null,
  )
    ? null
    : candidateOnHand;

  /**
   * Promote a candidate in the EMPTY state (no working roster, so no editing
   * authority to gate on). When a working roster IS on screen, Load goes through
   * `panelRef.requestLoadCandidate` instead, which awaits/gates the autosave.
   */
  const promoteEmpty = useCallback(
    async (pointer: CurrentCandidatePointer) => {
      setLoadPending(true);
      setLoadError(null);
      try {
        const epoch = await rosterStorage.getClearEpoch();
        const outcome = await promoteCandidateRosterToWorking(pointer, {
          storage: rosterStorage,
          expectedWorkingRevision: null,
          expectedClearEpoch: epoch,
        });
        if (outcome.status === "promoted") {
          await roster.reload();
          return;
        }
        setLoadError(describeReplacementFailure(outcome, "load"));
        // A newer candidate exists; re-read so the offer names the live one.
        if (outcome.status === "version-conflict") await roster.reload();
      } catch {
        setLoadError("The roster could not be loaded. Try again.");
      } finally {
        setLoadPending(false);
      }
    },
    [roster],
  );

  /**
   * Import a roster file into an EMPTY database.
   *
   * The same F3 decode/validation and F1 atomic promotion the loaded panel uses,
   * with the one difference the state actually implies: `expectedWorkingRevision`
   * is `null` because no working row was observed, so a row that appeared while
   * the file was being read loses the CAS rather than being silently overwritten.
   * The epoch is captured BEFORE the read, so a Clear that interleaves fences
   * this write instead of letting it repopulate the purged store.
   *
   * Fail-closed throughout: an invalid file never reaches storage, and a rejected
   * or conflicted write leaves the empty state and every hidden row exactly as
   * they were. Nothing is reloaded or reset except after a durable promotion.
   */
  const onImportEmpty = useCallback(
    async (file: File) => {
      setActionError(null);
      setClearFailed(false);
      try {
        const epoch = await rosterStorage.getClearEpoch();
        const outcome = await importRosterFileToWorking(file, {
          storage: rosterStorage,
          expectedWorkingRevision: null,
          expectedClearEpoch: epoch,
        });
        if (outcome.status === "promoted") {
          await roster.reload();
          return;
        }
        setActionError(describeReplacementFailure(outcome, "import"));
      } catch {
        setActionError("The roster file could not be imported. Try again.");
      }
    },
    [roster],
  );

  /**
   * Clear roster & stored data from the EMPTY state.
   *
   * An absent working roster is not an empty browser: a durable candidate, its
   * pointer, a submission snapshot, the optimize session record and retirement
   * marker, and the view metadata can all still be here. So this runs the SAME
   * production `clearRosterDataAndNotify()` orchestration, which is origin-wide
   * and verified, rather than a narrower removal that would report a privacy
   * success it did not deliver.
   *
   * There is no editing authority to invalidate here (no panel is mounted, so no
   * autosave queue exists), and the epoch bump inside F1's purge is the storage
   * fence either way. A partial failure is reported plainly and the control stays
   * mounted, so Clear remains retryable.
   */
  const onConfirmClear = useCallback(async () => {
    setConfirmClear(false);
    setActionError(null);
    setClearFailed(false);
    const outcome = await clearRosterDataAndNotify();
    if (outcome.status === "cleared") {
      await roster.reload();
      return;
    }
    setClearFailed(true);
    setActionError(ROSTER_CLEAR_PARTIAL_MESSAGE);
  }, [roster]);

  const hasWorkingRoster = roster.document !== null;

  /**
   * Loading replaces the roster on screen. When there is one, that is a
   * destructive act on work the user may have been reading, so it is confirmed
   * first; with an empty roster there is nothing to lose and the click loads.
   * The confirmed replacement then routes through the panel's save authority.
   */
  const onLoadClick = useCallback(() => {
    if (loadable === null) return;
    if (hasWorkingRoster) {
      setConfirmReplace(loadable.pointer);
      return;
    }
    void promoteEmpty(loadable.pointer);
  }, [hasWorkingRoster, loadable, promoteEmpty]);

  /**
   * The confirmed replacement of an existing roster. Routes through the panel's
   * save/replacement authority (await pending save; gate on failure) so Load and
   * Import share one coordinator.
   */
  const onConfirmReplace = useCallback(async () => {
    const pointer = confirmReplace;
    setConfirmReplace(null);
    if (pointer === null) return;
    const handle = panelRef.current;
    if (handle !== null) {
      setLoadPending(true);
      try {
        await handle.requestLoadCandidate(pointer);
      } finally {
        setLoadPending(false);
      }
    } else {
      // The panel unmounted between the click and the confirm (e.g. the working
      // roster was cleared). Fall back to the empty-state promotion.
      void promoteEmpty(pointer);
    }
  }, [confirmReplace, promoteEmpty]);

  const onClear = useCallback(() => setConfirmClear(true), []);

  /**
   * Dismissal goes to the gate keyed by the EXACT `{jobId, candidateVersion}`
   * this section is displaying.
   *
   * The previous version called the terminal hook's unkeyed `dismissCapture()`,
   * which resolves the CURRENT run at click time. With durable candidate A on
   * screen and a later run B in the panel above, that dismissed B: B's cleanup
   * authority consumed, A's payload and pointer untouched, and the user told
   * their saved roster was discarded when it was not.
   */
  const onDismissClick = useCallback(async () => {
    if (loadable === null) return;
    setDismissPending(true);
    setLoadError(null);
    try {
      const outcome = await capture.gate.dismissDurableCandidate({
        jobId: loadable.pointer.jobId,
        candidateVersion: loadable.pointer.candidateVersion,
      });
      if (outcome.status === "failed") {
        setLoadError(outcome.message);
        return;
      }
      await roster.reload();
    } catch {
      setLoadError("The saved roster could not be discarded. Try again.");
    } finally {
      setDismissPending(false);
    }
  }, [capture, loadable, roster]);

  // Loading skeleton.
  if (roster.loading) {
    return (
      <section className="flex flex-col gap-3" data-testid="roster-section-loading">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          Roster
        </h2>
        <Skeleton className="h-[200px] w-full" />
      </section>
    );
  }

  // Storage could not be read at all. Say so plainly rather than claiming the
  // roster is empty — we never actually read it.
  if (roster.unavailable) {
    return (
      <section className="flex flex-col gap-3" data-testid="roster-section-unavailable">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          Roster
        </h2>
        <Callout tone="warn" placement="page" alert>
          The roster can&rsquo;t be shown in this browser window. Try a normal window, or allow this
          site to keep data on your device.
        </Callout>
      </section>
    );
  }

  // The candidate callout renders in BOTH states. Hiding it behind an existing
  // working roster was the second half of the durability bug: a newer result
  // silently disappeared for exactly the users who had something to compare it
  // against.
  const candidateCallout =
    loadable === null ? null : (
      <Callout
        tone="info"
        placement="page"
        data-testid="roster-candidate-available"
        title={"Your latest saved result is ready to load"}
        actions={
          <>
            <Button
              size="sm"
              onClick={onLoadClick}
              disabled={loadPending || dismissPending}
              data-testid="roster-candidate-load"
            >
              <FaDownload className="size-3.5" aria-hidden />{" "}
              {hasWorkingRoster ? "Replace roster" : "Load into roster"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onDismissClick()}
              disabled={loadPending || dismissPending}
              data-testid="roster-candidate-dismiss"
            >
              Dismiss
            </Button>
          </>
        }
      >
        {/* NOT "your last optimisation". A later run can have finished after this
            result was saved — and failed, or produced nothing loadable. Calling
            this one the last optimisation would then be plainly wrong. What is
            actually true, and all this surface knows, is that it is the latest
            result available to load. */}
        {hasWorkingRoster
          ? "Your latest saved result is ready. Loading it replaces the roster below."
          : "Your latest saved result is ready to review."}
      </Callout>
    );

  const loadErrorCallout =
    loadError === null ? null : (
      <Callout tone="error" placement="page" data-testid="roster-load-error" alert>
        {loadError}
      </Callout>
    );

  const actionErrorCallout =
    actionError === null ? null : (
      <Callout tone="error" placement="page" data-testid="roster-action-error" alert>
        {actionError}
      </Callout>
    );

  // A partial Clear is reported as its own standing fact, not folded into the
  // retry message: some data is still in this browser, and the user is entitled
  // to know that even after they dismiss or replace the action error.
  const clearFailedCallout = !clearFailed ? null : (
    <Callout tone="error" placement="page" data-testid="roster-clear-failed" alert>
      The roster could not be fully cleared &mdash; some data remains in this browser.
    </Callout>
  );

  const clearDialog = (
    <ConfirmDialog
      open={confirmClear}
      onOpenChange={setConfirmClear}
      title="Clear roster & stored data?"
      description="This permanently removes every saved result and all roster data stored in this browser. This cannot be undone."
      confirmLabel="Clear all roster data"
      variant="destructive"
      onConfirm={() => void onConfirmClear()}
    />
  );

  const replaceDialog =
    loadable === null ? null : (
      <ConfirmDialog
        open={confirmReplace !== null}
        onOpenChange={(open) => !open && setConfirmReplace(null)}
        title="Replace the roster on screen?"
        description="The roster you are viewing will be replaced by your latest saved result."
        confirmLabel="Replace roster"
        onConfirm={() => void onConfirmReplace()}
      />
    );

  // A working roster exists — render the editable viewer, with the candidate
  // offered above it. The panel ref routes candidate Load through the panel's
  // save/replacement authority.
  if (hasWorkingRoster && roster.document !== null) {
    return (
      <section className="flex flex-col gap-3" data-testid="roster-section">
        <div className="flex items-end gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-label font-semibold uppercase tracking-[0.03em] text-brandink">
              Roster
            </div>
            <h2 className="font-heading text-display font-bold leading-[1.15] tracking-[-0.015em] text-ink">
              Review the roster
            </h2>
          </div>
        </div>
        {candidateCallout}
        {loadErrorCallout}
        <WorkingRosterPanel
          ref={panelRef}
          document={roster.document}
          revision={roster.revision}
          reload={roster.reload}
        />
        {replaceDialog}
      </section>
    );
  }

  // Empty state: no working roster, but storage IS readable — so the two actions
  // that still have a subject are offered. The loaded-roster save status and the
  // export controls are not: there is nothing on screen for them to act on.
  return (
    <section className="flex flex-col gap-3" data-testid="roster-section-empty">
      <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
        Roster
      </h2>
      <EmptyRosterActions onImportFile={(file) => void onImportEmpty(file)} onClear={onClear} />
      <div className="flex flex-col items-center justify-center px-6 py-11 text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-control border border-dashed border-line text-ink3">
          <FaDownload className="size-5" aria-hidden />
        </div>
        <h3 className="font-heading text-title font-semibold tracking-[-0.015em] text-ink">
          No roster loaded yet
        </h3>
        <p className="mt-1.5 max-w-[40ch] text-meta text-ink2">
          Run an optimisation and load its result here, or import a roster file you were sent.
        </p>
      </div>
      {candidateCallout}
      {loadErrorCallout}
      {actionErrorCallout}
      {clearFailedCallout}
      {replaceDialog}
      {clearDialog}
    </section>
  );
}

/** Re-export for the screen's type-only imports. */
export type { RosterDocument };
