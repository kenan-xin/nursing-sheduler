"use client";

// R6 Round 9B — every notice here is mounted DIRECTLY on the route's L0 page
// plane (`optimize-and-export-screen.tsx` renders this as a sibling of the route
// cards), so each one declares `placement="page"`. That is load-bearing for the
// two neutral states — an attached resume and a storage-unavailable notice —
// which were rendering the inset `--panel` well straight onto L0, where DESIGN.md
// §4 puts nothing free-floating and seats note strips inside an L1 card. At page
// placement the neutral tone takes the L1 role instead. The status-tinted states
// are unchanged by the flag; they declare it so the mount point is stated once
// for the whole component rather than inferred per notice.
//
// T16e — run-status notices for the current run. Renders an auto-resumed run, a
// failed resume, a storage-unavailable notice, and the degraded
// (reload-recovery-unavailable) warning for a post-202 activation that could not be
// durably staged.
//
// It renders NO prior-run recovery workflow. An interrupted record from a previous
// attempt is retired invisibly by `prepareForOptimize` when the user next clicks
// Optimize, and an unreadable record simply blocks that submit — neither is a
// concept the user is asked to hold, so neither gets a notice or an action here.

import type { OptimizeRecovery, OptimizeResumeOutcome } from "@/lib/optimize";
import { Callout } from "./callout";

export interface RecoveryNoticeProps {
  state: OptimizeRecovery;
  resume: OptimizeResumeOutcome | null;
  /** A live run whose post-202 activation could not be durably recorded. */
  reloadRecoveryUnavailable: boolean;
}

export function RecoveryNotice({ state, resume, reloadRecoveryUnavailable }: RecoveryNoticeProps) {
  return (
    <>
      {reloadRecoveryUnavailable ? (
        <Callout tone="warn" placement="page" data-testid="optimize-degraded" alert>
          Reload recovery is unavailable for this run. It is still running in this tab, but if you
          reload the page you will not be able to resume it here.
        </Callout>
      ) : null}

      {state.kind === "resumable" && resume?.status === "attached" ? (
        <Callout tone="info" placement="page" data-testid="optimize-resumed">
          Resumed your previous optimisation run.
        </Callout>
      ) : null}

      {state.kind === "resumable" && resume !== null && resume.status !== "attached" ? (
        <Callout tone="error" placement="page" data-testid="optimize-resume-failed" alert>
          A previous optimisation run could not be resumed. {resume.reason}
        </Callout>
      ) : null}

      {state.kind === "storage-error" ? (
        <Callout tone="info" placement="page" data-testid="optimize-storage-error">
          Browser session storage is unavailable, so run recovery is disabled for this tab.
        </Callout>
      ) : null}
    </>
  );
}
