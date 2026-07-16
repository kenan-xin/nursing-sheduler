"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  extractErrorDetail,
  OptimizeApiError,
  type OptimizeEndpoint,
  type OptimizeErrorInfo,
} from "@/lib/bff/errors";
import type { OptimizeHeartbeatResponse, OptimizeJobResponse } from "@/lib/bff/types";
import { runOptimizeEventLoop } from "@/lib/query/event-stream";
import { startHeartbeat } from "@/lib/query/heartbeat";
import { optimizeKeys } from "@/lib/query/keys";
import { OrdinalSkipTracker, type SseFrame, streamOptimizeEvents } from "@/lib/query/sse";

// Re-export so consumers can keep importing the error type from the hooks module.
export { OptimizeApiError } from "@/lib/bff/errors";

// UX-only preflight — the backend enforces the real limit with an exact 413
// ("Scheduling YAML is too large"). Never treat this as the enforcement boundary.
export const OPTIMIZE_MAX_YAML_BYTES = 2 * 1024 * 1024;
export const OPTIMIZE_HEARTBEAT_INTERVAL_MS = 5_000;

async function requestOptimizeJson<T>(
  input: string,
  init?: RequestInit,
  endpoint?: OptimizeEndpoint,
): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new OptimizeApiError(response.status, extractErrorDetail(body), endpoint);
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
// BFF forwards it verbatim. Returns the 202 job response.
export function useSubmitOptimize() {
  const queryClient = useQueryClient();

  return useMutation<OptimizeJobResponse, OptimizeApiError, SubmitOptimizeInput>({
    mutationFn: (input) => {
      const form = new FormData();
      if (input.file) {
        form.set("file", input.file);
      } else if (input.yamlContent !== undefined) {
        form.set("yaml_content", input.yamlContent);
      }
      if (input.prettify !== undefined) form.set("prettify", String(input.prettify));
      if (input.timeout !== undefined) form.set("timeout", String(input.timeout));

      return requestOptimizeJson<OptimizeJobResponse>(
        "/api/optimize",
        { method: "POST", body: form },
        "submit",
      );
    },
    onSuccess: (job) => {
      queryClient.setQueryData(optimizeKeys.job(job.jobId), job);
    },
  });
}

// GET /api/optimize/{id} poll. A plain 404 surfaces as OptimizeApiError with
// `info.kind === "expired"` (recovery), distinct from an infeasible XLSX 404.
export function useOptimizeJob(
  jobId: string | null,
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery<OptimizeJobResponse, OptimizeApiError>({
    queryKey: jobId ? optimizeKeys.job(jobId) : optimizeKeys.all,
    queryFn: () =>
      requestOptimizeJson<OptimizeJobResponse>(
        `/api/optimize/${encodeURIComponent(jobId as string)}`,
        undefined,
        "poll",
      ),
    enabled: Boolean(jobId) && (options?.enabled ?? true),
    refetchInterval: options?.refetchInterval ?? false,
  });
}

// POST /api/optimize/{id}/cancel.
export function useCancelOptimize() {
  const queryClient = useQueryClient();

  return useMutation<OptimizeJobResponse, OptimizeApiError, string>({
    mutationFn: (jobId) =>
      requestOptimizeJson<OptimizeJobResponse>(
        `/api/optimize/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST" },
        "cancel",
      ),
    onSuccess: (job) => {
      queryClient.setQueryData(optimizeKeys.job(job.jobId), job);
    },
  });
}

// One heartbeat POST. Returns whether the scheduler should keep beating: false on a
// 409 (already finished) / 404 (gone) — every terminal signal; true on transient
// errors so a blip doesn't cancel a live job.
async function sendHeartbeat(jobId: string): Promise<boolean> {
  try {
    await requestOptimizeJson<OptimizeHeartbeatResponse>(
      `/api/optimize/${encodeURIComponent(jobId)}/heartbeat`,
      { method: "POST" },
      "heartbeat",
    );
    return true;
  } catch (error) {
    if (error instanceof OptimizeApiError && (error.status === 409 || error.status === 404)) {
      return false;
    }
    return true;
  }
}

// Client heartbeat @ 5 s: immediate, on interval, on tab re-focus, and on network
// resume. Pass `enabled: false` once the job is terminal; it also self-stops on a
// heartbeat 409/404. (Scheduling logic lives in `startHeartbeat`, unit-tested.)
export function useOptimizeHeartbeat(jobId: string | null, options: { enabled: boolean }) {
  const { enabled } = options;

  useEffect(() => {
    if (!jobId || !enabled) return;

    const controller = startHeartbeat({
      intervalMs: OPTIMIZE_HEARTBEAT_INTERVAL_MS,
      beat: () => sendHeartbeat(jobId),
      visibilityTarget: document,
      onlineTarget: window,
      isVisible: () => document.visibilityState === "visible",
    });

    return controller.stop;
  }, [jobId, enabled]);
}

export interface UseOptimizeEventStreamOptions {
  enabled: boolean;
  onEvent?: (frame: SseFrame) => void;
  onTerminal?: (frame: SseFrame) => void;
  onExpired?: (info: OptimizeErrorInfo) => void;
  // Called once the reconnect budget is exhausted (stream down, job not terminal).
  onError?: (error: unknown) => void;
  maxReconnects?: number;
}

// fetch-stream SSE subscription with ordinal-skip dedupe and reconnect ownership.
// On ANY non-terminal outcome — a 5xx/unknown error response, a network/read
// failure, or a close without a terminal frame — it polls GET /api/optimize/{id}
// and classifies: exact-expiry ⇒ stop + onExpired; terminal ⇒ stop; otherwise
// reconnect within the budget (replay is deduped by position). Budget exhaustion
// surfaces `onError` instead of silently stopping. A connection that delivered new
// frames resets the budget so a healthy long job isn't killed by transient blips.
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
    const tracker = new OrdinalSkipTracker();
    const eventsUrl = `/api/optimize/${encodeURIComponent(jobId)}/events`;
    const pollUrl = `/api/optimize/${encodeURIComponent(jobId)}`;

    void runOptimizeEventLoop({
      maxReconnects: optionsRef.current.maxReconnects ?? 5,
      isCancelled: () => controller.signal.aborted,
      connect: (onFrame) =>
        streamOptimizeEvents(eventsUrl, { signal: controller.signal, tracker, onEvent: onFrame }),
      pollJob: async () => {
        const job = await requestOptimizeJson<OptimizeJobResponse>(pollUrl, undefined, "poll");
        queryClient.setQueryData(optimizeKeys.job(jobId), job);
        return job;
      },
      delay: (attempt) => abortableDelay(reconnectDelayMs(attempt), controller.signal),
      onFrame: (frame) => {
        applyFrameToCache(queryClient, jobId, frame);
        optionsRef.current.onEvent?.(frame);
      },
      onTerminal: (frame) => optionsRef.current.onTerminal?.(frame),
      onExpired: (info) => optionsRef.current.onExpired?.(info),
      onError: (error) => optionsRef.current.onError?.(error),
    });

    return () => {
      controller.abort();
    };
  }, [jobId, enabled, queryClient]);
}

// Download the workbook (T16 owns the browser save gesture). Throws
// OptimizeApiError on a structured 404 ("no feasible solution") / 409 ("not ready").
export async function fetchOptimizeXlsx(jobId: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/optimize/${encodeURIComponent(jobId)}/xlsx`, {
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new OptimizeApiError(response.status, extractErrorDetail(body), "xlsx");
  }
  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get("content-disposition")) ?? `${jobId}.xlsx`;
  return { blob, filename };
}

function applyFrameToCache(queryClient: QueryClient, jobId: string, frame: SseFrame): void {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return;
  }

  if (frame.event === "complete" || frame.event === "error") {
    queryClient.setQueryData(optimizeKeys.job(jobId), data as OptimizeJobResponse);
    return;
  }
  if (frame.event === "status" && data && typeof data === "object") {
    const patch = data as { status?: OptimizeJobResponse["status"]; queuePosition?: number | null };
    queryClient.setQueryData<OptimizeJobResponse>(optimizeKeys.job(jobId), (prev) =>
      prev
        ? {
            ...prev,
            status: patch.status ?? prev.status,
            queuePosition: patch.queuePosition ?? null,
          }
        : prev,
    );
  }
  // `progress` / `phase` frames are ephemeral chart/log data — surfaced via
  // onEvent (T16), never written to the durable job cache.
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
