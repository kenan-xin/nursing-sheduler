"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  isExactJobGoneError,
  OptimizeApiError,
  type OptimizeEndpoint,
  type OptimizeErrorInfo,
} from "@/lib/bff/errors";
import type { JobResponse } from "@/lib/bff/types";
import {
  parseControlChangedPayload,
  parseJobResponse,
  parseResultAvailablePayload,
  parseStateChangedPayload,
  type StrictTerminalFrame,
} from "@/lib/query/event-payloads";
import { runOptimizeEventLoop } from "@/lib/query/event-stream";
import { optimizeKeys } from "@/lib/query/keys";
import { CursorTracker, type SseFrame, streamOptimizeEvents } from "@/lib/query/sse";

// Re-export so consumers can keep importing the error type from the hooks module.
export { OptimizeApiError } from "@/lib/bff/errors";

// UX-only preflight — the backend enforces the real limit with an exact 413
// ("Scheduling YAML is too large"). Never treat this as the enforcement boundary.
export const OPTIMIZE_MAX_YAML_BYTES = 2 * 1024 * 1024;

async function requestOptimizeJob(
  input: string,
  init?: RequestInit,
  endpoint?: OptimizeEndpoint,
  expectedId?: string,
): Promise<JobResponse> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // The code-first envelope (or FastAPI `detail`) is classified from the raw body.
    throw new OptimizeApiError(response.status, body, endpoint);
  }
  const job = parseJobResponse(body, expectedId);
  if (job === null) {
    throw new Error("Optimize API returned an invalid JobResponse.");
  }
  return job;
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

      return requestOptimizeJob("/api/optimize", { method: "POST", body: form }, "submit");
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
      requestOptimizeJob(
        `/api/optimize/${encodeURIComponent(jobId as string)}`,
        undefined,
        "poll",
        jobId as string,
      ),
    enabled: Boolean(jobId) && (options?.enabled ?? true),
    refetchInterval: options?.refetchInterval ?? false,
  });
}

// A provenance-isolated poll for the T16a controller (P1 #2). The query is keyed by
// the caller's opaque `attachmentKey` (its attachment/subscription identity) IN
// ADDITION to the job id, so a superseded attachment's in-flight request can NEVER
// populate a later attachment's observer: reset/re-attach B to the SAME job starts a
// DIFFERENT query, and A's delayed 200/404 resolves into A's now-unobserved query,
// not B's. The abort `signal` is forwarded to `fetch`, so the superseded request is
// cancelled rather than left to resolve. The controller mirrors an exact response to
// the shared base only after its live-ownership fence.
export function useOptimizeJobScoped(
  jobId: string | null,
  attachmentKey: unknown,
  options?: {
    enabled?: boolean;
    refetchInterval?: number | false;
    /** Source-provenance callback. It runs for an exact URL-bound response even if
     * the observer is superseded before React can apply the snapshot. */
    onResponse?: (job: JobResponse) => void;
    onJobGone?: (info: OptimizeErrorInfo) => void;
  },
) {
  return useQuery<JobResponse, Error>({
    queryKey: jobId ? optimizeKeys.jobScoped(jobId, attachmentKey) : optimizeKeys.all,
    queryFn: async ({ signal }) => {
      // Fetch with the abort signal (a superseded attachment's in-flight request is
      // cancelled) and return the response for THIS scoped observer only. The response
      // is NOT written to the shared base here — the controller mirrors to base ONLY
      // after its live exact-token ownership fence (P1 #6/#7), so a stale A response
      // cannot leak into the base or a later attachment.
      let job: JobResponse;
      try {
        job = await requestOptimizeJob(
          `/api/optimize/${encodeURIComponent(jobId as string)}`,
          { signal },
          "poll",
          jobId as string,
        );
      } catch (error) {
        if (isExactJobGoneError(error)) {
          options?.onJobGone?.(error.info);
        }
        throw error;
      }
      options?.onResponse?.(job);
      return job;
    },
    enabled: Boolean(jobId) && (options?.enabled ?? true),
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export interface ScopedOptimizeControlInput {
  jobId: string;
  attachmentKey: unknown;
  isCurrentAttachment: () => boolean;
}

export type OptimizeControlInput = string | ScopedOptimizeControlInput;

function controlJobId(input: OptimizeControlInput): string {
  return typeof input === "string" ? input : input.jobId;
}

function cacheControlResponse(
  queryClient: QueryClient,
  job: JobResponse,
  input: OptimizeControlInput,
): void {
  if (typeof input === "string") {
    queryClient.setQueryData(optimizeKeys.job(job.id), job);
    return;
  }
  if (job.id !== input.jobId) return;
  queryClient.setQueryData(optimizeKeys.jobScoped(input.jobId, input.attachmentKey), job);
  if (input.isCurrentAttachment()) {
    queryClient.setQueryData(optimizeKeys.job(input.jobId), job);
  }
}

// POST /api/optimize/{id}/cancel. Server-authoritative: the returned JobResponse's
// `controls`/`state` reflect the new lifecycle. Show Cancel only when
// `controls.cancellable`.
export function useCancelOptimize() {
  const queryClient = useQueryClient();

  return useMutation<JobResponse, OptimizeApiError, OptimizeControlInput>({
    mutationFn: (input) => {
      const jobId = controlJobId(input);
      return requestOptimizeJob(
        `/api/optimize/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST" },
        "cancel",
        jobId,
      );
    },
    onSuccess: (job, input) => {
      cacheControlResponse(queryClient, job, input);
    },
  });
}

// POST /api/optimize/{id}/finish-now. Replaces the removed client heartbeat: browser
// liveness no longer drives lifecycle. Show Finish now only when
// `controls.early_completion_available`.
export function useFinishNowOptimize() {
  const queryClient = useQueryClient();

  return useMutation<JobResponse, OptimizeApiError, OptimizeControlInput>({
    mutationFn: (input) => {
      const jobId = controlJobId(input);
      return requestOptimizeJob(
        `/api/optimize/${encodeURIComponent(jobId)}/finish-now`,
        { method: "POST" },
        "finish-now",
        jobId,
      );
    },
    onSuccess: (job, input) => {
      cacheControlResponse(queryClient, job, input);
    },
  });
}

export interface UseOptimizeEventStreamOptions {
  enabled: boolean;
  // Opaque resume cursor to seed the tracker with, so the FIRST request carries it as
  // `Last-Event-ID` (a session resuming after reload). Null/undefined starts from the
  // retained floor. Read once when the subscription starts; never parsed or compared.
  initialCursor?: string | null;
  /**
   * Optional subscription-identity key (T16a attachment epoch). When the consumer
   * bumps this value, the active stream subscription is torn down and a new one is
   * started, and the options frozen at that start are used for the new subscription's
   * lifetime. This prevents an A stream from invoking B's latest callback refs
   * through the mutable `optionsRef`. The T16a run controller bumps this on every
   * new attachment so an old stream cannot dispatch signals, advance the cursor,
   * or forward cursor callbacks into a later attachment's view. Leave undefined to
   * keep the legacy behavior.
   */
  subscriptionKey?: unknown;
  // May be async: it is AWAITED inside the apply-before-commit fence, so the cursor
  // commits (and `onCursorCommit` fires) only after consumer application resolves. A
  // rejection leaves the cursor at the prior id, so the frame replays on reconnect.
  onEvent?: (frame: SseFrame) => void | Promise<void>;
  onTerminal?: (result: { frame?: StrictTerminalFrame; job?: JobResponse }) => void;
  onTerminalProof?: (result: { frame?: StrictTerminalFrame; job?: JobResponse }) => void;
  // The job is gone (job_not_found) — expired/deleted/never existed.
  onJobGone?: (info: OptimizeErrorInfo) => void;
  onJobGoneProof?: (info: OptimizeErrorInfo) => void;
  // Cursor recoveries: the consumer clears ephemeral chart/log history and labels
  // earlier progress unavailable. Two distinct reasons are surfaced separately.
  onCursorExpired?: (info: OptimizeErrorInfo) => void;
  onCursorInvalid?: (info: OptimizeErrorInfo) => void;
  // The opaque cursor just committed — fired only after the frame's cache
  // reconciliation and consumer application succeeded and the tracker advanced. A
  // consumer persists this to resume from on reload; it is the ONLY safe resume point
  // (never a pre-apply frame id). Opaque: store verbatim, never parse.
  onCursorCommit?: (cursor: string) => void;
  // The saved cursor was cleared during expired/invalid recovery. A consumer clears
  // any persisted resume cursor so a later reload does not resend the stale value.
  onCursorReset?: () => void;
  // Called once the reconnect budget is exhausted (stream down, job not terminal).
  onError?: (error: unknown) => void;
  maxReconnects?: number;
  // T16a P1 cache provenance: when KEYED, the stream applies/reconciles durable frames
  // into an ATTACHMENT-SCOPED cache key (`jobScoped(jobId, subscriptionKey)`) instead
  // of the shared base, so a superseded stream never mutates the base or a later
  // attachment. The current exact-token attachment mirrors scoped state to the base
  // only when `isCurrentAttachment()` returns true. Unkeyed callers ignore both and
  // keep writing the base directly (legacy).
  isCurrentAttachment?: () => boolean;
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

    // T16p subscription-identity seam: capture the options AT subscription start.
    // The T16a consumer bumps `subscriptionKey` on each new attachment; combined
    // with capturing, this guarantees an A stream cannot invoke B's latest
    // callbacks through the mutable `optionsRef`. Even if A's underlying transport
    // is still alive during the React commit window, its in-flight dispatches use
    // A's frozen callbacks (which close over A's attachment token), so the
    // controller's exact-equality fence drops them.
    const captured = optionsRef.current;

    // Callback resolution honors the documented contract:
    //   • KEYED subscriptions (a `subscriptionKey` was supplied) freeze the
    //     callbacks captured at start — an A stream can never reach B's callbacks.
    //   • UNKEYED subscriptions preserve the legacy live-`optionsRef` behavior, so a
    //     consumer re-rendering the SAME job with a refreshed callback still updates
    //     the live handler. `initialCursor`/`maxReconnects` remain start-only reads
    //     in BOTH modes (they are subscription-lifetime, not per-render).
    const keyed = captured.subscriptionKey !== undefined;
    const cb = () => (keyed ? captured : optionsRef.current);

    // Cache provenance (P1 #6/#7): a keyed stream writes durable state to its OWN
    // attachment-scoped key; an unkeyed stream keeps writing the shared base. The base
    // is mirrored only when this attachment is still the live owner.
    const cacheKey: readonly unknown[] = keyed
      ? optimizeKeys.jobScoped(jobId, captured.subscriptionKey)
      : optimizeKeys.job(jobId);
    const mirrorToBase = (job: JobResponse) => {
      if (keyed && captured.isCurrentAttachment?.()) {
        queryClient.setQueryData(optimizeKeys.job(job.id), job);
      }
    };

    const controller = new AbortController();
    // Seed the tracker with the supplied resume cursor so the first request carries it
    // as `Last-Event-ID`. Read once at subscription start (like maxReconnects).
    const tracker = new CursorTracker(captured.initialCursor ?? null);
    const eventsUrl = `/api/optimize/${encodeURIComponent(jobId)}/events`;
    const pollUrl = `/api/optimize/${encodeURIComponent(jobId)}`;

    // Authoritative poll + cache replacement, reused by the loop's recovery and by
    // per-frame reconciliation of malformed durable events. The abort signal is
    // forwarded so a superseded recovery poll is cancelled (P1 #7); it writes the
    // attachment-scoped key and mirrors to the base only under the ownership fence.
    const pollAndCache = async (): Promise<JobResponse> => {
      const job = await requestOptimizeJob(pollUrl, { signal: controller.signal }, "poll", jobId);
      const mayMutate = keyed
        ? (captured.isCurrentAttachment?.() ?? !controller.signal.aborted)
        : !controller.signal.aborted;
      if (mayMutate) {
        queryClient.setQueryData(cacheKey, job);
        mirrorToBase(job);
      }
      return job;
    };

    void runOptimizeEventLoop({
      maxReconnects: captured.maxReconnects ?? 5,
      isCancelled: () => controller.signal.aborted,
      canApplyFrame: () => captured.isCurrentAttachment?.() ?? !controller.signal.aborted,
      connect: (onFrame) =>
        streamOptimizeEvents(eventsUrl, {
          signal: controller.signal,
          tracker,
          onEvent: onFrame,
          onTerminalObserved: (frame) => cb().onTerminalProof?.({ frame }),
          // Fires after the frame applied AND the tracker committed; forward the
          // committed opaque cursor so a consumer can persist the resume point.
          onCommit: (cursor) => cb().onCursorCommit?.(cursor),
        }),
      pollJob: pollAndCache,
      delay: (attempt) => abortableDelay(reconnectDelayMs(attempt), controller.signal),
      resetCursor: () => tracker.reset(),
      onCursorReset: () => cb().onCursorReset?.(),
      // Async: a malformed durable frame reconciles (poll + replace) BEFORE the
      // cursor commits; a poll/cache/consumer failure rejects so the cursor stays
      // at the prior id and the frame is replayed on reconnect.
      onFrame: async (frame) => {
        await applyFrameWithReconcile(queryClient, jobId, frame, pollAndCache, cacheKey);
        if (keyed && captured.isCurrentAttachment && !captured.isCurrentAttachment()) return;
        // Mirror the just-applied scoped durable state to the shared base under the
        // ownership fence, so unkeyed consumers/recovery see current SSE state without
        // a stale stream ever writing the base (P1 #6/#7).
        if (keyed) {
          const scopedJob = queryClient.getQueryData<JobResponse>(cacheKey);
          if (scopedJob) mirrorToBase(scopedJob);
        }
        // Await the consumer so a rejecting async `onEvent` keeps the cursor at the
        // prior id (no commit, no onCursorCommit) and the frame replays on reconnect.
        await cb().onEvent?.(frame);
      },
      onTerminal: (result) => cb().onTerminal?.(result),
      onTerminalProof: (result) => cb().onTerminalProof?.(result),
      onJobGone: (info) => cb().onJobGone?.(info),
      onJobGoneProof: (info) => cb().onJobGoneProof?.(info),
      onCursorExpired: (info) => cb().onCursorExpired?.(info),
      onCursorInvalid: (info) => cb().onCursorInvalid?.(info),
      onError: (error) => cb().onError?.(error),
    });

    return () => {
      controller.abort();
    };
  }, [jobId, enabled, queryClient, options.subscriptionKey]);
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
  // The cache key to patch. Defaults to the shared base; the keyed T16a stream passes
  // its ATTACHMENT-SCOPED key so a superseded stream never writes the base (P1 #6/#7).
  cacheKey: readonly unknown[] = optimizeKeys.job(jobId),
): FrameApplyOutcome {
  const durable = DURABLE_EVENTS.has(frame.event);
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    // Malformed JSON on a durable event must reconcile; ephemeral/raw frames don't.
    return durable ? "needs-reconcile" : "applied";
  }
  const key = cacheKey;

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
  cacheKey: readonly unknown[] = optimizeKeys.job(jobId),
): Promise<void> {
  if (applyFrameToCache(queryClient, jobId, frame, cacheKey) === "needs-reconcile") {
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
