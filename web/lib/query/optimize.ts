"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { OptimizeApiError, type OptimizeEndpoint, type OptimizeErrorInfo } from "@/lib/bff/errors";
import type { JobResponse } from "@/lib/bff/types";
import {
  parseControlChangedPayload,
  parseResultAvailablePayload,
  parseStateChangedPayload,
} from "@/lib/query/event-payloads";
import { runOptimizeEventLoop } from "@/lib/query/event-stream";
import { optimizeKeys } from "@/lib/query/keys";
import { CursorTracker, type SseFrame, streamOptimizeEvents } from "@/lib/query/sse";

// Re-export so consumers can keep importing the error type from the hooks module.
export { OptimizeApiError } from "@/lib/bff/errors";

// UX-only preflight — the backend enforces the real limit with an exact 413
// ("Scheduling YAML is too large"). Never treat this as the enforcement boundary.
export const OPTIMIZE_MAX_YAML_BYTES = 2 * 1024 * 1024;

async function requestOptimizeJson<T>(
  input: string,
  init?: RequestInit,
  endpoint?: OptimizeEndpoint,
): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // The code-first envelope (or FastAPI `detail`) is classified from the raw body.
    throw new OptimizeApiError(response.status, body, endpoint);
  }
  return body as T;
}

export interface SubmitOptimizeInput {
  // Provide exactly one of `file` / `yamlContent` (mirrors the backend's Form).
  file?: File;
  yamlContent?: string;
  prettify?: boolean;
  timeout?: number;
}

// POST /api/optimize (multipart). FormData lets the browser set the boundary; the
// BFF forwards it verbatim. Returns the 202 snake_case JobResponse.
export function useSubmitOptimize() {
  const queryClient = useQueryClient();

  return useMutation<JobResponse, OptimizeApiError, SubmitOptimizeInput>({
    mutationFn: (input) => {
      const form = new FormData();
      if (input.file) {
        form.set("file", input.file);
      } else if (input.yamlContent !== undefined) {
        form.set("yaml_content", input.yamlContent);
      }
      if (input.prettify !== undefined) form.set("prettify", String(input.prettify));
      if (input.timeout !== undefined) form.set("timeout", String(input.timeout));

      return requestOptimizeJson<JobResponse>(
        "/api/optimize",
        { method: "POST", body: form },
        "submit",
      );
    },
    onSuccess: (job) => {
      queryClient.setQueryData(optimizeKeys.job(job.id), job);
    },
  });
}

// GET /api/optimize/{id} poll. A code-first `job_not_found` surfaces as
// OptimizeApiError with `info.kind === "job-not-found"` (recovery), distinct from a
// `no-artifact` download error.
export function useOptimizeJob(
  jobId: string | null,
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery<JobResponse, OptimizeApiError>({
    queryKey: jobId ? optimizeKeys.job(jobId) : optimizeKeys.all,
    queryFn: () =>
      requestOptimizeJson<JobResponse>(
        `/api/optimize/${encodeURIComponent(jobId as string)}`,
        undefined,
        "poll",
      ),
    enabled: Boolean(jobId) && (options?.enabled ?? true),
    refetchInterval: options?.refetchInterval ?? false,
  });
}

// POST /api/optimize/{id}/cancel. Server-authoritative: the returned JobResponse's
// `controls`/`state` reflect the new lifecycle. Show Cancel only when
// `controls.cancellable`.
export function useCancelOptimize() {
  const queryClient = useQueryClient();

  return useMutation<JobResponse, OptimizeApiError, string>({
    mutationFn: (jobId) =>
      requestOptimizeJson<JobResponse>(
        `/api/optimize/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST" },
        "cancel",
      ),
    onSuccess: (job) => {
      queryClient.setQueryData(optimizeKeys.job(job.id), job);
    },
  });
}

// POST /api/optimize/{id}/finish-now. Replaces the removed client heartbeat: browser
// liveness no longer drives lifecycle. Show Finish now only when
// `controls.early_completion_available`.
export function useFinishNowOptimize() {
  const queryClient = useQueryClient();

  return useMutation<JobResponse, OptimizeApiError, string>({
    mutationFn: (jobId) =>
      requestOptimizeJson<JobResponse>(
        `/api/optimize/${encodeURIComponent(jobId)}/finish-now`,
        { method: "POST" },
        "finish-now",
      ),
    onSuccess: (job) => {
      queryClient.setQueryData(optimizeKeys.job(job.id), job);
    },
  });
}

export interface UseOptimizeEventStreamOptions {
  enabled: boolean;
  onEvent?: (frame: SseFrame) => void;
  onTerminal?: (result: { frame?: SseFrame; job?: JobResponse }) => void;
  // The job is gone (job_not_found) — expired/deleted/never existed.
  onJobGone?: (info: OptimizeErrorInfo) => void;
  // Cursor recoveries: the consumer clears ephemeral chart/log history and labels
  // earlier progress unavailable. Two distinct reasons are surfaced separately.
  onCursorExpired?: (info: OptimizeErrorInfo) => void;
  onCursorInvalid?: (info: OptimizeErrorInfo) => void;
  // Called once the reconnect budget is exhausted (stream down, job not terminal).
  onError?: (error: unknown) => void;
  maxReconnects?: number;
}

// fetch-stream SSE subscription with opaque-cursor reconnect and server-authoritative
// recovery. On ANY non-terminal outcome — a 5xx/unknown error response, a
// network/read failure, or a close without a terminal frame — it polls
// GET /api/optimize/{id} and classifies: job gone ⇒ stop + onJobGone; terminal ⇒
// stop; cursor expired/invalid ⇒ clear history + reconnect without a cursor;
// otherwise reconnect within the budget. A connection that delivered new frames
// resets the budget so a healthy long job isn't killed by transient blips.
export function useOptimizeEventStream(
  jobId: string | null,
  options: UseOptimizeEventStreamOptions,
) {
  const { enabled } = options;
  const queryClient = useQueryClient();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!jobId || !enabled) return;

    const controller = new AbortController();
    const tracker = new CursorTracker();
    const eventsUrl = `/api/optimize/${encodeURIComponent(jobId)}/events`;
    const pollUrl = `/api/optimize/${encodeURIComponent(jobId)}`;

    // Authoritative poll + cache replacement, reused by the loop's recovery and by
    // per-frame reconciliation of malformed durable events.
    const pollAndCache = async (): Promise<JobResponse> => {
      const job = await requestOptimizeJson<JobResponse>(pollUrl, undefined, "poll");
      queryClient.setQueryData(optimizeKeys.job(jobId), job);
      return job;
    };

    void runOptimizeEventLoop({
      maxReconnects: optionsRef.current.maxReconnects ?? 5,
      isCancelled: () => controller.signal.aborted,
      connect: (onFrame) =>
        streamOptimizeEvents(eventsUrl, { signal: controller.signal, tracker, onEvent: onFrame }),
      pollJob: pollAndCache,
      delay: (attempt) => abortableDelay(reconnectDelayMs(attempt), controller.signal),
      resetCursor: () => tracker.reset(),
      // Async: a malformed durable frame reconciles (poll + replace) BEFORE the
      // cursor commits; a poll/cache/consumer failure rejects so the cursor stays
      // at the prior id and the frame is replayed on reconnect.
      onFrame: async (frame) => {
        await applyFrameWithReconcile(queryClient, jobId, frame, pollAndCache);
        optionsRef.current.onEvent?.(frame);
      },
      onTerminal: (result) => optionsRef.current.onTerminal?.(result),
      onJobGone: (info) => optionsRef.current.onJobGone?.(info),
      onCursorExpired: (info) => optionsRef.current.onCursorExpired?.(info),
      onCursorInvalid: (info) => optionsRef.current.onCursorInvalid?.(info),
      onError: (error) => optionsRef.current.onError?.(error),
    });

    return () => {
      controller.abort();
    };
  }, [jobId, enabled, queryClient]);
}

// Download the workbook (T16 owns the browser save gesture). Throws OptimizeApiError
// on a code-first `no-artifact` (no schedule) error; score/status come from the
// retained JobResponse.result, not from response headers.
export async function fetchOptimizeXlsx(jobId: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/optimize/${encodeURIComponent(jobId)}/xlsx`, {
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new OptimizeApiError(response.status, body, "xlsx");
  }
  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get("content-disposition")) ?? `${jobId}.xlsx`;
  return { blob, filename };
}

// The durable events whose payload MUST update the retained JobResponse. A malformed
// or parser-rejected payload on one of these cannot be treated as a successful no-op:
// the cursor must not advance past a transition the cache never received.
const DURABLE_EVENTS: ReadonlySet<string> = new Set([
  "job.state_changed",
  "job.control_changed",
  "job.result_available",
]);

// Whether a durable frame was applied to the cache, or its payload was malformed/
// incomplete and the caller must authoritatively reconcile (poll + replace) before
// advancing the cursor. Ephemeral/unknown frames are always `"applied"` (there is no
// durable state to lose).
export type FrameApplyOutcome = "applied" | "needs-reconcile";

// Apply one persisted event to the durable job cache from its EXACT T19 wire payload
// (see `event-payloads.ts`). State/control/result events patch the retained
// JobResponse; phase/progress frames are ephemeral chart/log data surfaced via
// onEvent (T16), never written. A durable payload returns `"needs-reconcile"` — so the
// caller polls authoritative state before committing the cursor — whenever it cannot
// be applied as a complete durable update: malformed JSON, parser/domain rejection, OR
// no full JobResponse is cached to patch (a partial frame cannot construct one). It is
// NEVER a silent no-op that would strand the cache while the cursor moves on.
export function applyFrameToCache(
  queryClient: QueryClient,
  jobId: string,
  frame: SseFrame,
): FrameApplyOutcome {
  const durable = DURABLE_EVENTS.has(frame.event);
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    // Malformed JSON on a durable event must reconcile; ephemeral/raw frames don't.
    return durable ? "needs-reconcile" : "applied";
  }
  const key = optimizeKeys.job(jobId);

  // A durable frame carries only a PARTIAL patch onto an existing JobResponse — its
  // flat T19 payload cannot construct the full response on its own. If no response is
  // cached yet (eviction, or a session restore before the poll query populated), the
  // patch would silently no-op while the cursor advances, permanently skipping the
  // transition. Reconcile authoritatively (poll + replace) instead of acknowledging.
  if (frame.event === "job.state_changed") {
    const payload = parseStateChangedPayload(data);
    if (payload === null) return "needs-reconcile";
    const prev = queryClient.getQueryData<JobResponse>(key);
    if (prev === undefined) return "needs-reconcile";
    queryClient.setQueryData<JobResponse>(key, {
      ...prev,
      state: payload.state,
      terminal: payload.terminal,
      queue_position: payload.queue_position,
      controls: payload.controls,
      // Failed/cancelled states carry a top-level `error`; other states omit it.
      error: payload.error ?? prev.error,
    });
    return "applied";
  }

  if (frame.event === "job.control_changed") {
    const payload = parseControlChangedPayload(data);
    if (payload === null) return "needs-reconcile";
    const prev = queryClient.getQueryData<JobResponse>(key);
    if (prev === undefined) return "needs-reconcile";
    // The event only reports the accepted early-completion request; the sole
    // derivable control change is that early completion is no longer available.
    if (payload.early_completion_requested) {
      queryClient.setQueryData<JobResponse>(key, {
        ...prev,
        controls: { ...prev.controls, early_completion_available: false },
      });
    }
    return "applied";
  }

  if (frame.event === "job.result_available") {
    const payload = parseResultAvailablePayload(data);
    if (payload === null) return "needs-reconcile";
    const prev = queryClient.getQueryData<JobResponse>(key);
    if (prev === undefined) return "needs-reconcile";
    queryClient.setQueryData<JobResponse>(key, {
      ...prev,
      result: {
        outcome: payload.outcome,
        score: payload.score,
        solver_status: payload.solver_status,
        termination_reason: payload.termination_reason,
      },
      // A non-null artifact means the backend exposes the schedule download;
      // reproduce the exact link it would emit (client still calls /api/*).
      links:
        payload.artifact_name !== null
          ? { ...prev.links, schedule: `/optimize/${jobId}/xlsx` }
          : prev.links,
    });
    return "applied";
  }

  // `job.phase_changed` / `job.progressed` / unknown are ephemeral — never cached,
  // and never block the cursor.
  return "applied";
}

// Apply a frame and, when its durable payload could not be applied, reconcile
// authoritatively before returning. `reconcile` polls the current JobResponse and
// replaces the cache; if it throws (poll/cache failure) this rejects WITHOUT the
// caller committing the cursor, so the frame is replayed on reconnect. When it
// succeeds, the caller commits exactly once, so a permanently malformed retained
// event cannot loop forever.
export async function applyFrameWithReconcile(
  queryClient: QueryClient,
  jobId: string,
  frame: SseFrame,
  reconcile: () => Promise<unknown>,
): Promise<void> {
  if (applyFrameToCache(queryClient, jobId, frame) === "needs-reconcile") {
    await reconcile();
  }
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

function reconnectDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 8_000);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
