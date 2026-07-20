"use client";

// T16e — session recovery surface. Renders the interpreted T16b recovery state:
// an auto-resumed run, an interrupted/unreadable record with a destructive Forget,
// a storage-unavailable notice, and the degraded (reload-recovery-unavailable)
// warning for a post-202 activation that could not be durably staged. T16e owns
// only confirmation and rendering; it calls T16b's inspected recovery actions.

import { Button } from "@/components/ui/button";
import type { OptimizeRecovery, OptimizeResumeOutcome } from "@/lib/optimize";
import { Callout } from "./callout";

export interface RecoveryNoticeProps {
  state: OptimizeRecovery;
  resume: OptimizeResumeOutcome | null;
  /** A live run whose post-202 activation could not be durably recorded. */
  reloadRecoveryUnavailable: boolean;
  onForget(): void;
  forgetPending: boolean;
}

export function RecoveryNotice({
  state,
  resume,
  reloadRecoveryUnavailable,
  onForget,
  forgetPending,
}: RecoveryNoticeProps) {
  const forgetButton = (
    <Button
      variant="destructive"
      size="sm"
      onClick={onForget}
      disabled={forgetPending}
      data-testid="optimize-forget"
    >
      Forget this run and start over
    </Button>
  );

  return (
    <>
      {reloadRecoveryUnavailable ? (
        <Callout tone="warn" data-testid="optimize-degraded" alert>
          Reload recovery is unavailable for this run. It is still running in this tab, but if you
          reload the page you will not be able to resume it here.
        </Callout>
      ) : null}

      {state.kind === "resumable" && resume?.status === "attached" ? (
        <Callout tone="info" data-testid="optimize-resumed">
          Resumed your previous optimization run.
        </Callout>
      ) : null}

      {state.kind === "resumable" && resume !== null && resume.status !== "attached" ? (
        <Callout tone="error" data-testid="optimize-resume-failed" alert>
          A previous optimization run could not be resumed. {resume.reason}
        </Callout>
      ) : null}

      {state.kind === "interrupted" ? (
        <Callout
          tone="warn"
          data-testid="optimize-interrupted"
          title="A previous optimize run was interrupted"
          actions={forgetButton}
          alert
        >
          A submission was interrupted before its job could be recorded, so it cannot be resumed. An
          unknown backend optimization may still be running until it reaches a terminal state or the
          server releases it.
        </Callout>
      ) : null}

      {state.kind === "unreadable" ? (
        <Callout
          tone="warn"
          data-testid="optimize-unreadable"
          title="Recovery data for a previous run is unreadable"
          actions={forgetButton}
          alert
        >
          The saved recovery record could not be read. It will not be resumed or deleted
          automatically. An unknown backend optimization may still be running until it reaches a
          terminal state or the server releases it.
        </Callout>
      ) : null}

      {state.kind === "storage-error" ? (
        <Callout tone="info" data-testid="optimize-storage-error">
          Browser session storage is unavailable, so run recovery is disabled for this tab.
        </Callout>
      ) : null}
    </>
  );
}
