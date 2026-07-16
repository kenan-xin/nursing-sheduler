import {
  classifyOptimizeError,
  extractErrorDetail,
  OptimizeApiError,
  type OptimizeErrorInfo,
} from "@/lib/bff/errors";
import { isTerminalOptimizeStatus, type OptimizeJobResponse } from "@/lib/bff/types";
import type { SseFrame, StreamOutcome } from "@/lib/query/sse";

// Framework-agnostic SSE reconnect loop (tech-plan §3, T06 line 36). Extracted from
// the React hook so recovery is unit-testable with injected transport/poll/delay —
// no renderer or real network. All side effects (fetch, cache writes, timers) are
// injected via `deps`.
export interface OptimizeEventLoopDeps {
  maxReconnects: number;
  isCancelled: () => boolean;
  // Run ONE SSE connection, invoking `onFrame` per NEW frame; resolve with the
  // outcome or reject on a network/read failure.
  connect: (onFrame: (frame: SseFrame) => void) => Promise<StreamOutcome>;
  // Poll the job's current state; throws OptimizeApiError on an HTTP error.
  pollJob: () => Promise<OptimizeJobResponse>;
  // Backoff before the given (1-based) reconnect attempt.
  delay: (attempt: number) => Promise<void>;
  onFrame: (frame: SseFrame) => void;
  onTerminal?: (frame: SseFrame) => void;
  onExpired?: (info: OptimizeErrorInfo) => void;
  // Reconnect budget exhausted while the job is NOT known-terminal — surfaced
  // instead of silently stopping.
  onError?: (error: unknown) => void;
}

export async function runOptimizeEventLoop(deps: OptimizeEventLoopDeps): Promise<void> {
  let reconnects = 0;
  let lastError: unknown;

  // Poll to learn the real state after a non-terminal stream outcome.
  //   "stop"      → terminal job or exact expiry (onExpired fired): end the loop.
  //   "reconnect" → still running OR a transient poll failure: retry within budget.
  const recover = async (): Promise<"stop" | "reconnect"> => {
    try {
      const job = await deps.pollJob();
      return isTerminalOptimizeStatus(job.status) ? "stop" : "reconnect";
    } catch (error) {
      lastError = error;
      if (error instanceof OptimizeApiError && error.info.kind === "expired") {
        deps.onExpired?.(error.info);
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
      const outcome = await deps.connect((frame) => {
        madeProgress = true;
        deps.onFrame(frame);
      });

      if (deps.isCancelled()) return;

      if (outcome.type === "terminal") {
        deps.onTerminal?.(outcome.frame);
        return;
      }
      if (outcome.type === "error-response") {
        const detail = extractErrorDetail(outcome.body);
        const info = classifyOptimizeError(outcome.status, detail, "events");
        if (info.kind === "expired") {
          deps.onExpired?.(info);
          return;
        }
        // 5xx / unknown 404 / … → poll + retry path (never a silent stop).
        lastError = new OptimizeApiError(outcome.status, detail, "events");
        needRecover = true;
      } else {
        // Closed without a terminal frame → poll to learn the final state.
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
