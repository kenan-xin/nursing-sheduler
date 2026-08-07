"use client";

// F2 — the minimal roster-capture surface on the Optimize route.
//
// Scope is deliberately narrow: this renders the capture state machine's outcome
// and its two actions (Retry, Dismiss). The roster VIEWER and its editing belong
// to F4/F5; nothing here reads or renders a roster document.
//
// Silence is reserved for states that cost the user nothing they could act on:
// `idle`/`fetching-roster`/`committing` are transient and already covered by the
// run's own status, and `no-artifact` is a run that produced no schedule at all,
// which the run panel already says plainly.
//
// Every OTHER terminal outcome is announced, including the ones with no action
// attached. A run whose roster could not be saved still downloaded its XLSX and
// released its job, so nothing looks wrong — which is exactly why the user has to
// be told that no loadable roster was kept, and whether anything can be done about
// it. Retry is offered only where a retry could actually succeed: never for a
// structurally terminal cause.

import { Button } from "@/components/ui/button";
import type { RosterCaptureState } from "@/lib/optimize";
import { Callout } from "./callout";

export interface CaptureNoticeProps {
  state: RosterCaptureState;
  onRetry(): void;
  onDismiss(): void;
  /** True while a dismissal is in flight, so the action cannot be double-fired. */
  dismissPending: boolean;
}

export function CaptureNotice({ state, onRetry, onDismiss, dismissPending }: CaptureNoticeProps) {
  if (state.status === "committed") {
    return (
      <Callout
        tone="info"
        placement="page"
        data-testid="optimize-capture-committed"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={onDismiss}
            disabled={dismissPending}
            data-testid="optimize-capture-dismiss"
          >
            Discard the saved roster
          </Button>
        }
      >
        The roster for this run was saved in this browser.
      </Callout>
    );
  }

  if (state.status === "fetch-failed") {
    return (
      <Callout
        tone="warn"
        placement="page"
        data-testid="optimize-capture-fetch-failed"
        title="The roster for this run could not be saved"
        actions={
          state.jobGone ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              data-testid="optimize-capture-retry"
            >
              Retry saving the roster
            </Button>
          )
        }
        alert
      >
        {state.jobGone
          ? "The finished run is no longer available on the server, so its roster can no longer be saved here. Your downloaded XLSX is unaffected."
          : `${state.message} Your downloaded XLSX is unaffected.`}
      </Callout>
    );
  }

  if (state.status === "commit-failed") {
    return (
      <Callout
        tone="warn"
        placement="page"
        data-testid="optimize-capture-commit-failed"
        title="The roster for this run could not be saved in this browser"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            data-testid="optimize-capture-retry"
          >
            Retry saving the roster
          </Button>
        }
        alert
      >
        {state.message} Your downloaded XLSX is unaffected.
      </Callout>
    );
  }

  if (state.status === "unavailable") {
    // Cause-specific, non-actionable guidance. Each of these is terminal for the
    // run in view: no Retry is offered because none could change the outcome.
    if (state.cause === "no-artifact") return null;

    // A closed lookup rather than a ternary chain: TypeScript then requires an
    // entry for every remaining cause, so adding one to the union cannot silently
    // fall through to another cause's message.
    const guidance = {
      snapshot_persist_failed: {
        testId: "optimize-capture-storage-unavailable",
        title: "The roster for this run was not saved",
        body: "This browser could not store the submitted schedule before the run started, so there is nothing to rebuild the roster from. Free up browser storage (or allow it for this site) and run the optimisation again. Your downloaded XLSX is unaffected.",
      },
      snapshot_missing: {
        testId: "optimize-capture-submission-missing",
        title: "The roster for this run was not saved",
        body: "The stored copy of the submitted schedule for this run is no longer available, so its roster cannot be rebuilt. Run the optimisation again to save a roster. Your downloaded XLSX is unaffected.",
      },
      session_record_absent: {
        testId: "optimize-capture-record-absent",
        title: "The roster for this run was not saved",
        body: "This browser has no record of the run that produced this result, so there is nothing to rebuild its roster from. Run the optimisation again to save a roster. Your downloaded XLSX is unaffected.",
      },
      "assembly-rejected": {
        testId: "optimize-capture-assembly-rejected",
        title: "No loadable roster was saved for this run",
        body: "The result came back in a form this version cannot turn into a roster, so nothing was saved and this run cannot be recovered here. Retrying would produce the same result. Your downloaded XLSX is unaffected.",
      },
    }[state.cause];

    return (
      <Callout
        tone="warn"
        placement="page"
        data-testid={guidance.testId}
        title={guidance.title}
        alert
      >
        {guidance.body}
      </Callout>
    );
  }

  if (state.status === "dismiss-failed") {
    return (
      <Callout
        tone="warn"
        placement="page"
        data-testid="optimize-capture-dismiss-failed"
        title="The saved roster could not be discarded"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={onDismiss}
            disabled={dismissPending}
            data-testid="optimize-capture-dismiss"
          >
            Try discarding again
          </Button>
        }
        alert
      >
        {state.message} It is still saved in this browser, and the finished run has been left on the
        server so nothing is lost.
      </Callout>
    );
  }

  return null;
}
