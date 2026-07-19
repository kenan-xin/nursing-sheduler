import { classifyOptimizeError, OptimizeApiError, type OptimizeErrorInfo } from "@/lib/bff/errors";
import type { JobResponse } from "@/lib/bff/types";
import type { SseFrame, StreamOutcome } from "@/lib/query/sse";

// Framework-agnostic SSE reconnect loop (tech-plan §5). Extracted from the React
// hook so recovery is unit-testable with injected transport/poll/delay — no
// renderer or real network. All side effects (fetch, cache writes, timers, cursor
// reset) are injected via `deps`.
//
// Server-authoritative recovery: stream closure/error is ambiguous, so we poll the
// current `JobResponse` and stop only when it is terminal, otherwise reconnect from
// the latest usable cursor. Three failure codes are handled distinctly:
//   - job_not_found        → the job is gone (expired/deleted); stop + onJobGone.
//   - event_cursor_expired → retained history rolled past our cursor; discard the
//                            cursor, clear ephemeral history, reconnect from floor.
//   - invalid_event_cursor → the saved cursor is malformed/foreign; same reset with
//                            a distinct recovery reason.
export interface OptimizeEventLoopDeps {
  maxReconnects: number;
  isCancelled: () => boolean;
  // Run ONE SSE connection, invoking `onFrame` per NEW frame; resolve with the
  // outcome or reject on a network/read failure.
  connect: (onFrame: (frame: SseFrame) => void) => Promise<StreamOutcome>;
  // Poll the job's current state; throws OptimizeApiError on an HTTP error.
  pollJob: () => Promise<JobResponse>;
  // Backoff before the given (1-based) reconnect attempt.
  delay: (attempt: number) => Promise<void>;
  // Discard the saved event cursor so the next connection resumes from the floor.
  resetCursor: () => void;
  // May be async: applies the frame to the cache, reconciles a malformed durable
  // payload, and runs consumer callbacks. Awaited before the cursor commits.
  onFrame: (frame: SseFrame) => void | Promise<void>;
  // Terminal reached, via a terminal frame and/or an authoritative poll.
  onTerminal?: (result: { frame?: SseFrame; job?: JobResponse }) => void;
  // The job no longer exists (job_not_found) — recovery, not a retryable error.
  onJobGone?: (info: OptimizeErrorInfo) => void;
  // Retained history rolled past the cursor; the consumer clears ephemeral history.
  onCursorExpired?: (info: OptimizeErrorInfo) => void;
  // The saved cursor was malformed/foreign; the consumer clears ephemeral history.
  onCursorInvalid?: (info: OptimizeErrorInfo) => void;
  // Reconnect budget exhausted while the job is NOT known-terminal.
  onError?: (error: unknown) => void;
}

export async function runOptimizeEventLoop(deps: OptimizeEventLoopDeps): Promise<void> {
  let reconnects = 0;
  let lastError: unknown;

  // Poll to learn the real state after an ambiguous outcome.
  //   "stop"      → terminal job (onTerminal fired) or the job is gone (onJobGone).
  //   "reconnect" → still running OR a transient poll failure: retry within budget.
  const recover = async (): Promise<"stop" | "reconnect"> => {
    try {
      const job = await deps.pollJob();
      if (job.terminal) {
        deps.onTerminal?.({ job });
        return "stop";
      }
      return "reconnect";
    } catch (error) {
      lastError = error;
      if (error instanceof OptimizeApiError && error.info.kind === "job-not-found") {
        deps.onJobGone?.(error.info);
        return "stop";
      }
      // 5xx / network / unrelated → retryable within the reconnect budget.
      return "reconnect";
    }
  };

  while (!deps.isCancelled()) {
    let madeProgress = false;
    let needRecover = false;

    try {
      const outcome = await deps.connect(async (frame) => {
        // `onFrame` writes the cache, reconciles, and runs consumer callbacks; it
        // may throw/reject. Count progress only AFTER it succeeds so a persistently
        // failing frame cannot keep resetting the reconnect budget.
        await deps.onFrame(frame);
        madeProgress = true;
      });

      if (deps.isCancelled()) return;

      if (outcome.type === "terminal") {
        // Refresh the full JobResponse (result/error/links) the terminal frame
        // does not carry; still stop even if that poll fails.
        try {
          const job = await deps.pollJob();
          deps.onTerminal?.({ frame: outcome.frame, job });
        } catch {
          deps.onTerminal?.({ frame: outcome.frame });
        }
        return;
      }

      if (outcome.type === "error-response") {
        const info = classifyOptimizeError(outcome.status, outcome.body, "events");
        if (info.kind === "job-not-found") {
          deps.onJobGone?.(info);
          return;
        }
        if (info.kind === "event-cursor-expired") {
          deps.onCursorExpired?.(info);
          deps.resetCursor();
        } else if (info.kind === "invalid-event-cursor") {
          deps.onCursorInvalid?.(info);
          deps.resetCursor();
        } else {
          // 5xx / unknown / backend-unready → poll + retry (never a silent stop).
          lastError = new OptimizeApiError(outcome.status, outcome.body, "events");
        }
        needRecover = true;
      } else {
        // Closed without a terminal frame → poll to learn the final state. A browser
        // disconnect NEVER cancels the job; the loop simply reconnects if running.
        needRecover = true;
      }
    } catch (error) {
      if (deps.isCancelled()) return;
      lastError = error;
      needRecover = true;
    }

    if (!needRecover || deps.isCancelled()) return;

    // A connection that delivered new frames is healthy — reset the budget so a
    // long-running job isn't killed by accumulated transient blips.
    if (madeProgress) reconnects = 0;

    if ((await recover()) === "stop" || deps.isCancelled()) return;

    if (++reconnects > deps.maxReconnects) {
      deps.onError?.(lastError ?? new Error("SSE reconnect budget exhausted"));
      return;
    }
    await deps.delay(reconnects);
  }
}
