// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LAST_EVENT_ID_HEADER, type JobResponse } from "@/lib/bff/types";
import { useHotStore } from "@/lib/store";
import type { PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import type { CanonicalScenarioDocument } from "@/lib/scenario/types";
import {
  inspectPersistedSession,
  type ActiveOptimizeSession,
  type SessionTransactionStorage,
} from "./session-transaction";
import {
  useOptimizeRun,
  type AttachmentToken,
  type PreparedRecoveryAttachment,
  type UseOptimizeRunDeps,
} from "./use-optimize-run";
import * as optimizeQuery from "@/lib/query/optimize";
import type { UseOptimizeEventStreamOptions } from "@/lib/query/optimize";
import { optimizeKeys } from "@/lib/query/keys";

const originalFetch = globalThis.fetch;
let client: QueryClient;

/**
 * Latest options passed to `useOptimizeEventStream`. The spy wraps the real
 * hook so the stream still works; tests that need to invoke the controller's
 * wrapped cursor callbacks directly (to simulate the in-flight race window)
 * read from this capture.
 */
let currentStreamOptions: UseOptimizeEventStreamOptions | null = null;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const job = (over: Partial<JobResponse> = {}): JobResponse => {
  const id = over.id ?? "opt_1";
  const state = over.state ?? "running";
  const terminal = state === "completed" || state === "cancelled" || state === "failed";
  const stateDefaults: Partial<JobResponse> =
    state === "queued"
      ? {
          queue_position: 1,
          started_at: null,
          controls: { cancellable: true, early_completion_available: false },
        }
      : state === "cancelling"
        ? { controls: { cancellable: false, early_completion_available: false } }
        : state === "completed"
          ? {
              finished_at: "2026-07-20T00:01:00+00:00",
              result: {
                outcome: "optimal",
                score: 42,
                solver_status: "OPTIMAL",
                termination_reason: "optimality_proven",
              },
              controls: { cancellable: false, early_completion_available: false },
            }
          : state === "cancelled"
            ? {
                finished_at: "2026-07-20T00:01:00+00:00",
                error: { code: "cancelled", message: "Optimization cancelled." },
                controls: { cancellable: false, early_completion_available: false },
              }
            : state === "failed"
              ? {
                  finished_at: "2026-07-20T00:01:00+00:00",
                  error: { code: "worker_lost", message: "Worker lost." },
                  controls: { cancellable: false, early_completion_available: false },
                }
              : {};
  return {
    id,
    state,
    terminal,
    queue_position: null,
    created_at: "2026-07-20T00:00:00+00:00",
    started_at: "2026-07-20T00:00:01+00:00",
    finished_at: null,
    request: {
      input_name: "s.yaml",
      solver: "ortools/cp-sat",
      prettify: null,
      timeout_seconds: 300,
    },
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: true },
    ...stateDefaults,
    ...over,
    links: {
      self: `/optimize/${id}`,
      events: `/optimize/${id}/events`,
      cancellation: `/optimize/${id}/cancel`,
      early_completion: `/optimize/${id}/finish-now`,
      schedule: state === "completed" ? `/optimize/${id}/xlsx` : null,
      ...over.links,
    },
  };
};

const completedJob = job({
  state: "completed",
  terminal: true,
  controls: { cancellable: false, early_completion_available: false },
  finished_at: "2026-07-20T00:01:00+00:00",
  result: {
    outcome: "optimal",
    score: 42,
    solver_status: "OPTIMAL",
    termination_reason: "optimality_proven",
  },
  links: { ...job().links, schedule: "/optimize/opt_1/xlsx" },
});

// A canned prepared submission so tests never build a full canonical document.
const okPrep: PrepareOptimizeSubmissionResult = {
  ok: true,
  prep: { yaml: "scenario: {}", peopleCount: 0, reverseMap: [], anonymized: false },
};

// A single-slot session storage double (session-transaction always uses one key).
function memStorage(
  seed: string | null = null,
): SessionTransactionStorage & { value: () => string | null } {
  const values = new Map<string, string>();
  if (seed !== null) values.set("nurse.optimize.session", seed);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    value: () => values.get("nurse.optimize.session") ?? null,
  };
}

const doc = {} as CanonicalScenarioDocument;
let defaultStorage: ReturnType<typeof memStorage>;

function deps(over: Partial<UseOptimizeRunDeps> = {}): UseOptimizeRunDeps {
  return {
    storage: defaultStorage,
    createOwnerId: () => "owner-test",
    prepare: () => okPrep,
    ...over,
  };
}

function activeRecord(jobId: string, ownerId: string): ActiveOptimizeSession {
  return {
    schemaVersion: 1,
    ownerId,
    phase: "active",
    anonymized: false,
    runOptions: {},
    peopleCount: 0,
    reverseMap: [],
    jobId,
  };
}

function preparedAttachment(
  jobId: string,
  over: Partial<PreparedRecoveryAttachment> = {},
): PreparedRecoveryAttachment {
  const { activation, ...rest } = over;
  return {
    jobId,
    activation: {
      anonymized: false,
      peopleCount: 0,
      reverseMap: [],
      reloadRecoveryAvailable: true,
      ...activation,
    },
    initialCursor: null,
    ...rest,
  };
}

// Record every requested URL so we can assert no heartbeat is ever sent.
let requested: string[];

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  requested = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    requested.push(u);
    return handler(u, init);
  }) as typeof fetch;
}

// A stream the test can push frames into on demand, so we can attach cursor
// callbacks BEFORE the frame arrives (the controller wraps `onCursorCommit`
// and forwards it to the T16b consumer's ref AFTER the apply-before-commit
// fence advances the tracker).
function controlledStream(): {
  response: Response;
  push: (text: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (text) => {
      controller?.enqueue(encoder.encode(text));
    },
    close: () => {
      controller?.close();
    },
  };
}

// Capture the original implementation at module load so the spy can wrap it
// while still letting the real stream run.
const originalUseOptimizeEventStream = optimizeQuery.useOptimizeEventStream;

beforeEach(() => {
  defaultStorage = memStorage();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useHotStore.getState().resetRunView();
  currentStreamOptions = null;
  // Wrap the real `useOptimizeEventStream` so the stream still works while
  // capturing the latest options for tests that exercise the controller's
  // wrapped cursor callbacks directly.
  vi.spyOn(optimizeQuery, "useOptimizeEventStream").mockImplementation((jobId, options) => {
    currentStreamOptions = options;
    return originalUseOptimizeEventStream(jobId, options);
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("useOptimizeRun — happy path", () => {
  it("submits, streams a progress frame, and reaches completed with a downloadable result", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) {
        return streamResponse(
          'id: c1\nevent: job.progressed\ndata: {"source":"solver","currentBestScore":42,"elapsedSeconds":2,"solutionIndex":1,"commentCount":0,"occurred_at":"2026-07-19T10:00:00Z"}\n\n',
        );
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob); // poll
      throw new Error(`unexpected request: ${u}`);
    });

    const d = deps();
    const { result } = renderHook(() => useOptimizeRun(d), { wrapper });

    let outcome!: Awaited<ReturnType<typeof result.current.submit>>;
    await act(async () => {
      outcome = await result.current.submit({
        document: doc,
        anonymize: false,
        prettify: true,
        timeout: 300,
      });
    });
    expect(outcome).toEqual({ status: "activated", jobId: "opt_1" });
    expect(result.current.activation?.reloadRecoveryAvailable).toBe(true);

    await waitFor(() => expect(result.current.view.lifecycle).toBe("completed"));

    const view = result.current.view;
    expect(view.outcome).toBe("optimal");
    expect(view.latestScore).toBe(42);
    expect(view.download.artifactAvailable).toBe(true);
    expect(view.progress.length).toBeGreaterThanOrEqual(1);
    expect(view.progress[0].currentBestScore).toBe(42);

    // No client heartbeat is ever sent (the durable protocol removed it).
    expect(requested.some((u) => u.includes("heartbeat"))).toBe(false);
    // The active record was durably staged under the single session key.
    expect(d.storage?.getItem("nurse.optimize.session")).not.toBeNull();
  });
});

describe("useOptimizeRun — submission outcomes", () => {
  it("blocks before POST on a pre-occupied session slot (no request is sent)", async () => {
    routeFetch(() => {
      throw new Error("no request should be made");
    });
    const d = deps({ storage: memStorage("occupied") });
    const { result } = renderHook(() => useOptimizeRun(d), { wrapper });

    let outcome!: Awaited<ReturnType<typeof result.current.submit>>;
    await act(async () => {
      outcome = await result.current.submit({ document: doc, anonymize: false });
    });

    expect(outcome).toEqual({ status: "blocked-before-post", reason: "session-conflict" });
    expect(result.current.view.lifecycle).toBe("submit-blocked");
    expect(result.current.view.error?.source).toBe("session");
    expect(requested).toEqual([]);
  });

  it("classifies a 5xx submit as acceptance-unknown and retains the interrupted map", async () => {
    routeFetch((u, init) => {
      if (u.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") {
        return json(500, { detail: "boom" });
      }
      throw new Error(`unexpected: ${u}`);
    });
    const storage = memStorage();
    const { result } = renderHook(() => useOptimizeRun(deps({ storage })), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });

    expect(result.current.view.lifecycle).toBe("submit-unknown");
    expect(result.current.view.error?.source).toBe("submit");
    // The provisional record is retained (a job may exist) — not rolled back.
    expect(storage.value()).not.toBeNull();
  });

  it("blocks overlapping submits in memory and retains a stale accepted record after reset", async () => {
    const pendingResponse = deferred<Response>();
    let postCount = 0;
    routeFetch((u, init) => {
      if (u.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") {
        postCount += 1;
        return pendingResponse.promise;
      }
      throw new Error(`unexpected: ${u}`);
    });
    const storage = memStorage();
    const { result } = renderHook(() => useOptimizeRun(deps({ storage })), { wrapper });

    let first!: Promise<unknown>;
    act(() => {
      first = result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.isSubmitting).toBe(true));
    await expect(result.current.submit({ document: doc, anonymize: false })).resolves.toEqual({
      status: "blocked-before-post",
      reason: "submission-in-progress",
    });

    act(() => result.current.reset());
    await expect(result.current.submit({ document: doc, anonymize: false })).resolves.toEqual({
      status: "blocked-before-post",
      reason: "submission-in-progress",
    });
    expect(postCount).toBe(1);

    await act(async () => {
      pendingResponse.resolve(json(202, job({ id: "stale-job" })));
      await first;
    });
    expect(result.current.view.lifecycle).toBe("idle");
    expect(inspectPersistedSession(storage)).toMatchObject({
      kind: "resumable",
      record: { jobId: "stale-job" },
    });
  });

  it("keeps an activation persistence failure usable in the current tab", async () => {
    const storage = memStorage();
    const originalSet = storage.setItem;
    storage.setItem = (key, value) => {
      const record = JSON.parse(value) as { phase: string };
      if (record.phase === "provisional") originalSet(key, value);
    };
    routeFetch((u, init) => {
      if (u.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") {
        return json(202, job({ id: "volatile-job" }));
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job({ id: "volatile-job" }));
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps({ storage })), { wrapper });

    await act(async () => {
      await expect(result.current.submit({ document: doc, anonymize: false })).resolves.toEqual({
        status: "activation-persistence-failed",
        jobId: "volatile-job",
      });
    });
    expect(result.current.activation).toMatchObject({
      jobId: "volatile-job",
      reloadRecoveryAvailable: false,
    });
    expect(result.current.view.sessionRecovery).toEqual({
      reloadRecoveryAvailable: false,
      reason: "activation-persistence-failed",
    });
    expect(inspectPersistedSession(storage).kind).toBe("interrupted");
  });

  it("classifies a 422 submit as a definite rejection and rolls back", async () => {
    routeFetch((u, init) => {
      if (u.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") {
        return json(422, { error: { code: "invalid_scheduling_data", message: "bad" } });
      }
      throw new Error(`unexpected: ${u}`);
    });
    const storage = memStorage();
    const { result } = renderHook(() => useOptimizeRun(deps({ storage })), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });

    expect(result.current.view.lifecycle).toBe("submit-rejected");
    expect(result.current.view.resubmittable).toBe(true);
    // A definite rejection created no job, so the provisional record is cleared.
    expect(storage.value()).toBeNull();
  });

  it("rejects an invalid draft without contacting the server", async () => {
    routeFetch(() => {
      throw new Error("no request should be made");
    });
    const invalid: PrepareOptimizeSubmissionResult = {
      ok: false,
      issues: [{ path: "people.items", message: "At least one person is required." }],
    };
    const { result } = renderHook(() => useOptimizeRun(deps({ prepare: () => invalid })), {
      wrapper,
    });

    let outcome!: Awaited<ReturnType<typeof result.current.submit>>;
    await act(async () => {
      outcome = await result.current.submit({ document: doc, anonymize: true });
    });

    expect(outcome.status).toBe("invalid");
    expect(result.current.view.lifecycle).toBe("submit-rejected");
    expect(requested).toEqual([]);
  });
});

describe("useOptimizeRun — server-authoritative controls", () => {
  it("cancel replaces state from the cancel response", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/cancel")) {
        return json(
          200,
          job({
            state: "cancelling",
            controls: { cancellable: false, early_completion_available: false },
          }),
        );
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job()); // poll: still running
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.view.lifecycle).toBe("cancelling");
    expect(result.current.view.controls.cancellable).toBe(false);
  });

  it("a failed control request records a control error without changing lifecycle", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/finish-now")) {
        return json(409, { error: { code: "job_operation_not_allowed", message: "cannot" } });
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    await act(async () => {
      await result.current.finishNow();
    });
    expect(result.current.view.lifecycle).toBe("running");
    expect(result.current.view.error).toEqual({
      source: "control",
      code: "job_operation_not_allowed",
      message: "cannot",
    });
  });
});

describe("useOptimizeRun — reset + download/cleanup", () => {
  it("reset clears the run view back to idle", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    act(() => result.current.reset());
    expect(result.current.view.lifecycle).toBe("idle");
    expect(result.current.view.jobId).toBeNull();
    expect(result.current.activation).toBeNull();
  });

  it("download/cleanup notifiers advance the terminal artifact state", async () => {
    // Notifiers are attachment-scoped (P1 #1), so establish a live attachment first
    // (T16e only drives download/cleanup on the currently-attached terminal run).
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));
    act(() => result.current.notifyDownloadStarted());
    expect(result.current.view.download.status).toBe("downloading");
    act(() => result.current.notifyDownloadSucceeded("schedule.xlsx"));
    expect(result.current.view.download).toMatchObject({
      status: "downloaded",
      filename: "schedule.xlsx",
    });
    act(() => result.current.notifyCleanup("cleaned"));
    expect(result.current.view.cleanup.status).toBe("cleaned");
    expect(result.current.view.jobId).toBe("opt_1");
    expect(result.current.view.download).toMatchObject({
      status: "downloaded",
      filename: "schedule.xlsx",
    });
  });
});

// ---------------------------------------------------------------------------
// P1 fixup tests — generation fencing, recovery attach, resubmit, storage
// getter, control 404, event ordering/bounds/progress rejection.
// ---------------------------------------------------------------------------

/** A deferred response so tests can trigger reset mid-flight. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useOptimizeRun — generation fencing (P1 #1)", () => {
  it("reset during a pending submit drops the late outcome (no repopulation)", async () => {
    const postDeferred = deferred<Response>();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return postDeferred.promise;
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const storage = memStorage();
    const { result } = renderHook(() => useOptimizeRun(deps({ storage })), { wrapper });

    // Start submit — the POST is pending.
    let submitPromise!: Promise<unknown>;
    act(() => {
      submitPromise = result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.isSubmitting).toBe(true));

    // Reset while the POST is in flight.
    act(() => result.current.reset());
    expect(result.current.view.lifecycle).toBe("idle");

    // The POST resolves with a 202 — the late outcome must be inert.
    await act(async () => {
      postDeferred.resolve(json(202, job()));
      await submitPromise;
    });

    expect(result.current.view.lifecycle).toBe("idle");
    expect(result.current.view.jobId).toBeNull();
    expect(result.current.activation).toBeNull();
  });

  it("resetEphemeral (New/Load) during an active stream drops late snapshots", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));
    expect(result.current.view.lifecycle).toBe("running");

    // Simulate New/Load: resetEphemeral bumps runGeneration.
    act(() => useHotStore.getState().resetEphemeral());

    // The poll effect may fire a late snapshot — it must be dropped.
    await act(async () => {
      // Force a re-render cycle to let any pending effect fire.
      await new Promise((r) => setTimeout(r, 10));
    });

    // The view was cleared by resetEphemeral; no late snapshot repopulated it.
    expect(result.current.view.lifecycle).toBe("idle");
    expect(result.current.view.jobId).toBeNull();
  });

  it("reset during a pending cancel drops the late cancel response", async () => {
    const cancelDeferred = deferred<Response>();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/cancel")) return cancelDeferred.promise;
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    // Start cancel — the POST is pending.
    let cancelPromise!: Promise<unknown>;
    act(() => {
      cancelPromise = result.current.cancel();
    });

    // Reset while cancel is in flight.
    act(() => result.current.reset());
    expect(result.current.view.lifecycle).toBe("idle");

    // The cancel resolves with a cancelling state — it must be inert.
    await act(async () => {
      cancelDeferred.resolve(
        json(
          200,
          job({
            state: "cancelling",
            controls: { cancellable: false, early_completion_available: false },
          }),
        ),
      );
      await cancelPromise;
    });

    expect(result.current.view.lifecycle).toBe("idle");
  });
});

describe("useOptimizeRun — attachRecoveredSession (P1 #2)", () => {
  it("attaches a recovered active session and sends the initial cursor", async () => {
    let eventsLastEventId: string | null = null;
    routeFetch((u, init) => {
      if (u.endsWith("/events")) {
        eventsLastEventId = new Headers(init?.headers).get(LAST_EVENT_ID_HEADER);
        return streamResponse(": keepalive\n\n");
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job({ id: "recovered_job" }));
      throw new Error(`unexpected: ${u}`);
    });

    const reverseMap: ActiveOptimizeSession["reverseMap"] = [
      ["P1", 1],
      ["P2", 2],
    ];

    const onCursorCommit = vi.fn();
    const onCursorReset = vi.fn();

    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    act(() => {
      result.current.attachRecoveredSession({
        ...preparedAttachment("recovered_job", {
          activation: {
            anonymized: true,
            peopleCount: 2,
            reverseMap,
            reloadRecoveryAvailable: true,
          },
        }),
        initialCursor: "cursor-from-reload",
        onCursorCommit,
        onCursorReset,
      });
    });

    expect(result.current.view.jobId).toBe("recovered_job");
    expect(result.current.view.sessionRecovery.reloadRecoveryAvailable).toBe(true);
    expect(result.current.activation?.reverseMap).toEqual(reverseMap);

    // The stream started with the initial cursor as Last-Event-ID.
    await waitFor(() => expect(eventsLastEventId).toBe("cursor-from-reload"));
  });
});

describe("useOptimizeRun — storage getter SecurityError (P1 #4)", () => {
  it("a throwing sessionStorage property access routes to blocked-before-post", async () => {
    routeFetch(() => {
      throw new Error("no request should be made");
    });

    // A storage whose property access throws SecurityError.
    const throwingStorageProxy: SessionTransactionStorage = new Proxy(
      {},
      {
        get() {
          throw new DOMException("SecurityError", "SecurityError");
        },
      },
    ) as unknown as SessionTransactionStorage;

    const { result } = renderHook(() => useOptimizeRun(deps({ storage: throwingStorageProxy })), {
      wrapper,
    });

    let outcome!: Awaited<ReturnType<typeof result.current.submit>>;
    await act(async () => {
      outcome = await result.current.submit({ document: doc, anonymize: true });
    });

    expect(outcome.status).toBe("blocked-before-post");
    expect(result.current.view.lifecycle).toBe("submit-blocked");
    expect(result.current.view.error?.source).toBe("session");
    expect(requested).toEqual([]);
  });
});

describe("useOptimizeRun — exact poll job-gone proof", () => {
  it.each([
    [500, { error: { code: "job_not_found", message: "gone" } }],
    [404, { error: { code: "job_not_found" } }],
    [404, { error: { code: "job_not_found", message: "gone", extra: true } }],
  ])("does not detach or clear authority for a non-exact %s envelope", async (status, body) => {
    const storage = memStorage(JSON.stringify(activeRecord("poll_A", "owner-A")));
    let postCount = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (u.endsWith("/api/optimize/poll_A")) return json(status, body);
      if (u.endsWith("/api/optimize") && method === "POST") {
        postCount += 1;
        return json(202, job());
      }
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps({ storage })), { wrapper });

    act(() =>
      result.current.attachRecoveredSession({
        ...preparedAttachment("poll_A"),
      }),
    );
    await waitFor(() => expect(result.current.view.jobId).toBe("poll_A"));
    await waitFor(() =>
      expect(requested.some((url) => url.endsWith("/api/optimize/poll_A"))).toBe(true),
    );
    expect(result.current.activation?.jobId).toBe("poll_A");
    expect(result.current.view.jobId).toBe("poll_A");

    await act(async () => {
      await expect(
        result.current.submit({ document: doc, anonymize: false }),
      ).resolves.toMatchObject({
        status: "blocked-before-post",
      });
    });
    expect(postCount).toBe(0);
  });
});

describe("useOptimizeRun — control job_not_found (P1 #5)", () => {
  it("cancel job_not_found becomes job-gone, detaches, and is resubmittable", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/cancel")) {
        return json(404, { error: { code: "job_not_found", message: "gone" } });
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.view.lifecycle).toBe("failed");
    expect(result.current.view.error?.code).toBe("job_not_found");
    expect(result.current.view.resubmittable).toBe(true);
    expect(result.current.activation).toBeNull();
  });

  it("finish-now job_not_found becomes job-gone, detaches, and is resubmittable", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/finish-now")) {
        return json(404, { error: { code: "job_not_found", message: "gone" } });
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    await act(async () => {
      await result.current.finishNow();
    });

    expect(result.current.view.lifecycle).toBe("failed");
    expect(result.current.view.error?.code).toBe("job_not_found");
    expect(result.current.view.resubmittable).toBe(true);
    expect(result.current.activation).toBeNull();
  });

  it("a non-404 cancel error preserves lifecycle and controls", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/cancel")) {
        return json(409, { error: { code: "job_operation_not_allowed", message: "cannot" } });
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.view.lifecycle).toBe("running");
    expect(result.current.view.controls.cancellable).toBe(true);
    expect(result.current.view.error).toEqual({
      source: "control",
      code: "job_operation_not_allowed",
      message: "cannot",
    });
  });
});

describe("useOptimizeRun — event log ordering + progress rejection (P1 #6)", () => {
  it("event log entries carry eventTime after dispatch", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));
    // An attachment-scoped notifier dispatches under the live attachment.
    act(() => result.current.notifyDownloadStarted());
    const entry = result.current.view.log[result.current.view.log.length - 1];
    expect(entry.eventTime).not.toBeNull();
    expect(typeof entry.eventTime).toBe("number");
  });

  it("unchanged poll snapshots do not consume the event log budget", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    const logLenAfterSubmit = result.current.view.log.length;

    // Multiple polls return the same running state — no new log entries.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.view.log.length).toBe(logLenAfterSubmit);
  });

  it("a progress frame without finite score+elapsed creates no chart point", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) {
        // A progress frame missing elapsedSeconds.
        return streamResponse(
          'id: c1\nevent: job.progressed\ndata: {"source":"solver","currentBestScore":42}\n\n',
        );
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    // The malformed progress frame produced no chart point.
    expect(result.current.view.progress).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Closure-review (2026-07-19) regression tests — second nested repair.
// These pin the four P1 groups the closure review flagged as still open:
//   • same-generation overlap (the prior test inserted reset() between submits)
//   • stale accepted outcome → explicit owner cleanup
//   • cancel/finish 404 detaches the exact current attachment
//   • single-source recovery: invalid/conflict closed returns
//   • cursor callback post-commit/reset ordering + revoked-old-stream isolation
//   • rapid wire sequence: durable + ephemeral frames preserve exact order
// ---------------------------------------------------------------------------

describe("useOptimizeRun — prepared recovery transport", () => {
  it("rejects invalid transport primitives without interpreting persistence data", () => {
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    let outcome!: ReturnType<typeof result.current.attachRecoveredSession>;
    act(() => {
      outcome = result.current.attachRecoveredSession(preparedAttachment(""));
    });
    expect(outcome).toEqual({ status: "invalid", reason: expect.any(String) });
    expect(result.current.activation).toBeNull();
  });

  it("returns conflict when a different job is already attached", () => {
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    act(() => {
      result.current.attachRecoveredSession(preparedAttachment("first_job"));
    });
    expect(result.current.view.jobId).toBe("first_job");

    let outcome!: ReturnType<typeof result.current.attachRecoveredSession>;
    act(() => {
      outcome = result.current.attachRecoveredSession(preparedAttachment("second_job"));
    });
    expect(outcome.status).toBe("conflict");
    expect(result.current.view.jobId).toBe("first_job");
  });

  it("idempotent re-attach of the same job id with the same cursor leaves the token untouched", () => {
    const originalCommit = vi.fn();
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    let first!: ReturnType<typeof result.current.attachRecoveredSession>;
    act(() => {
      first = result.current.attachRecoveredSession(
        preparedAttachment("same_job", {
          initialCursor: "cursor-A",
          onCursorCommit: originalCommit,
        }),
      );
    });
    expect(first.status).toBe("attached");

    const seqAfterFirst = result.current.view.seq;
    const logLenAfterFirst = result.current.view.log.length;

    const refreshedCommit = vi.fn();
    let second!: ReturnType<typeof result.current.attachRecoveredSession>;
    act(() => {
      second = result.current.attachRecoveredSession(
        preparedAttachment("same_job", {
          initialCursor: "cursor-A",
          onCursorCommit: refreshedCommit,
        }),
      );
    });
    expect(second.status).toBe("attached");

    expect(result.current.view.seq).toBe(seqAfterFirst);
    expect(result.current.view.log.length).toBe(logLenAfterFirst);

    expect(currentStreamOptions).not.toBeNull();
    currentStreamOptions!.onCursorCommit?.("cursor-fresh");
    expect(originalCommit).toHaveBeenCalledWith("cursor-fresh");
    expect(refreshedCommit).not.toHaveBeenCalled();
  });

  it("does not compare prepared activation data on an idempotent live re-attach", () => {
    const originalCommit = vi.fn();
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    act(() => {
      result.current.attachRecoveredSession(
        preparedAttachment("same_job", {
          initialCursor: "cursor-A",
          onCursorCommit: originalCommit,
        }),
      );
    });
    const seqAfterFirst = result.current.view.seq;

    const refreshedCommit = vi.fn();
    let outcome!: ReturnType<typeof result.current.attachRecoveredSession>;
    act(() => {
      outcome = result.current.attachRecoveredSession(
        preparedAttachment("same_job", {
          activation: {
            anonymized: true,
            peopleCount: 3,
            reverseMap: [["P1", 1]],
            reloadRecoveryAvailable: true,
          },
          initialCursor: "cursor-A",
          onCursorCommit: refreshedCommit,
        }),
      );
    });
    expect(outcome.status).toBe("attached");
    expect(result.current.view.seq).toBe(seqAfterFirst);
    expect(result.current.activation?.peopleCount).toBe(0);
    currentStreamOptions!.onCursorCommit?.("cursor-x");
    expect(originalCommit).toHaveBeenCalledWith("cursor-x");
    expect(refreshedCommit).not.toHaveBeenCalled();
  });

  it("same-job re-attach with a CHANGED cursor returns conflict (never silent swap)", () => {
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    act(() => {
      result.current.attachRecoveredSession(
        preparedAttachment("same_job", { initialCursor: "cursor-A" }),
      );
    });
    const seqAfterFirst = result.current.view.seq;
    const logLenAfterFirst = result.current.view.log.length;

    // Re-attach with a different cursor → conflict, no state mutation.
    let outcome!: ReturnType<typeof result.current.attachRecoveredSession>;
    act(() => {
      outcome = result.current.attachRecoveredSession(
        preparedAttachment("same_job", { initialCursor: "cursor-B" }),
      );
    });
    expect(outcome.status).toBe("conflict");
    expect(result.current.view.seq).toBe(seqAfterFirst);
    expect(result.current.view.log.length).toBe(logLenAfterFirst);
  });
});

describe("useOptimizeRun — cursor callbacks fire post-commit (closure-review P1 #3)", () => {
  it("onCursorCommit fires after a stream frame applies, with the committed cursor", async () => {
    const stream = controlledStream();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return stream.response;
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });

    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    const onCursorCommit = vi.fn();
    const onCursorReset = vi.fn();

    // Install the cursor callbacks via the LEGITIMATE fresh-attach path (no prior
    // submit): a recovered session is the primary attachment, so the callbacks are
    // wired as its own subscription inputs — never swapped in behind a live one.
    act(() => {
      result.current.attachRecoveredSession(
        preparedAttachment("opt_1", {
          initialCursor: null,
          onCursorCommit,
          onCursorReset,
        }),
      );
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    // Push a frame — the SSE parser applies it and commits the cursor.
    await act(async () => {
      stream.push(
        'id: committed-cursor\nevent: job.progressed\ndata: {"source":"solver","currentBestScore":3,"elapsedSeconds":1,"occurred_at":"2026-07-19T10:00:00Z"}\n\n',
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(onCursorCommit).toHaveBeenCalled();
    const committed = onCursorCommit.mock.calls.at(-1)?.[0];
    expect(committed).toBe("committed-cursor");
    expect(result.current.view.progress.length).toBeGreaterThanOrEqual(1);
    stream.close();
  });

  it("a controller-driven reset does NOT forward onCursorReset to the consumer", async () => {
    // The controller's `onCursorReset` wrapping is wired to the stream's
    // recovery path. A user-initiated `reset()` is a controller action that
    // clears state but MUST NOT forward onCursorReset — the consumer's
    // persisted cursor is the consumer's responsibility, not the reset path's.
    const stream = controlledStream();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return stream.response;
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });

    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    const onCursorReset = vi.fn();
    act(() => {
      result.current.attachRecoveredSession(
        preparedAttachment("opt_1", {
          initialCursor: null,
          onCursorReset,
        }),
      );
    });

    // Controller reset must NOT forward onCursorReset.
    act(() => result.current.reset());
    expect(onCursorReset).not.toHaveBeenCalled();
    stream.close();
  });
});

describe("useOptimizeRun — revoked stream cannot forward cursor callbacks (closure-review P1 #3)", () => {
  // The controller wraps `onCursorCommit` and `onCursorReset` with a
  // `tokenIsCurrent(tokenRef.current)` check. We capture the options passed
  // to `useOptimizeEventStream` via a `vi.spyOn` that wraps the real hook
  // but records the latest options, then invoke those callbacks directly
  // after the token is revoked. The wrapping must drop them — a revoked
  // stream's commit/reset cannot reach the T16b consumer.
  it("a revoked stream's onCursorCommit/onCursorReset are dropped (token-fenced)", async () => {
    const stream = controlledStream();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return stream.response;
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });

    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    const onCursorCommit = vi.fn();
    const onCursorReset = vi.fn();
    // Fresh-attach the recovered session as the primary attachment (the legitimate
    // path that installs cursor callbacks); no prior submit swaps them in.
    act(() => {
      result.current.attachRecoveredSession(
        preparedAttachment("opt_1", {
          initialCursor: null,
          onCursorCommit,
          onCursorReset,
        }),
      );
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    // Re-render to let the stream effect pick up the new options.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Sanity: while the token is current, the wrapping forwards.
    expect(currentStreamOptions).not.toBeNull();
    currentStreamOptions!.onCursorCommit?.("cursor-active");
    expect(onCursorCommit).toHaveBeenCalledWith("cursor-active");

    // Reset revokes the attachment token (tokenRef.current → null).
    act(() => result.current.reset());
    expect(result.current.view.lifecycle).toBe("idle");

    // After reset, the revoked stream's commit/reset callbacks are dropped.
    // These calls simulate the in-flight race window where the old stream's
    // tracker advances after the user-triggered reset.
    currentStreamOptions!.onCursorCommit?.("cursor-revoked");
    currentStreamOptions!.onCursorReset?.();
    expect(onCursorCommit).not.toHaveBeenCalledWith("cursor-revoked");
    expect(onCursorReset).not.toHaveBeenCalled();
    stream.close();
  });
});

describe("useOptimizeRun — rapid wire sequence preserves exact order (closure-review P1 #4)", () => {
  it("durable + ephemeral frames preserve exact event/cursor order in the log", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) {
        // Five frames in a deliberate interleaving: state, progress, control,
        // phase, result. The reducer must preserve this order in the event log.
        // Durable frames carry strict T06 payloads (terminal/controls/etc.).
        return streamResponse(
          [
            'id: c1\nevent: job.state_changed\ndata: {"state":"running","terminal":false,"queue_position":null,"cancel_requested":false,"early_completion_requested":false,"worker_id":"worker-1","controls":{"cancellable":true,"early_completion_available":true},"occurred_at":"2026-07-19T10:00:00Z"}\n\n',
            'id: c2\nevent: job.progressed\ndata: {"source":"solver","currentBestScore":5,"elapsedSeconds":1.5,"occurred_at":"2026-07-19T10:00:01Z"}\n\n',
            'id: c3\nevent: job.control_changed\ndata: {"early_completion_requested":true,"occurred_at":"2026-07-19T10:00:02Z"}\n\n',
            'id: c4\nevent: job.phase_changed\ndata: {"source":"scheduler","code":"solve","message":"Solving","elapsedSeconds":2,"occurred_at":"2026-07-19T10:00:03Z"}\n\n',
            'id: c5\nevent: job.result_available\ndata: {"outcome":"optimal","score":42,"solver_status":"OPTIMAL","termination_reason":"optimality_proven","artifact_name":"schedule.xlsx","occurred_at":"2026-07-19T10:00:04Z"}\n\n',
          ].join(""),
        );
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) {
        // The poll/cache reconciliation snapshot — a separate authoritative state.
        return json(200, completedJob);
      }
      throw new Error(`unexpected: ${u}`);
    });

    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));
    // Let the stream drain.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // The event log preserves the exact wire order of applied frames.
    const wireEvents = result.current.view.log
      .filter((e) => e.event !== null)
      .map((e) => ({ event: e.event, cursor: e.cursor, occurredAt: e.occurredAt }));
    expect(wireEvents).toEqual([
      {
        event: "job.state_changed",
        cursor: "c1",
        occurredAt: "2026-07-19T10:00:00Z",
      },
      {
        event: "job.progressed",
        cursor: "c2",
        occurredAt: "2026-07-19T10:00:01Z",
      },
      {
        event: "job.control_changed",
        cursor: "c3",
        occurredAt: "2026-07-19T10:00:02Z",
      },
      {
        event: "job.phase_changed",
        cursor: "c4",
        occurredAt: "2026-07-19T10:00:03Z",
      },
      {
        event: "job.result_available",
        cursor: "c5",
        occurredAt: "2026-07-19T10:00:04Z",
      },
    ]);

    // The progress frame also produced a chart point with the finite axes.
    expect(result.current.view.progress).toEqual([
      expect.objectContaining({
        source: "solver",
        currentBestScore: 5,
        elapsedSeconds: 1.5,
      }),
    ]);
    // Phase history captured the solve entry.
    expect(result.current.view.phases).toEqual([
      expect.objectContaining({ code: "solve", message: "Solving", elapsedSeconds: 2 }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Final-nested-repair regression tests — exact-token fence, strict wire log,
// A→B subscription-identity isolation, New/Load private+public state clear.
// ---------------------------------------------------------------------------

describe("useOptimizeRun — exact-token fence (final nested repair)", () => {
  it("A stream's frozen onEvent cannot mutate state after reset (creating-token capture)", async () => {
    const stream = controlledStream();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return stream.response;
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });

    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    // Capture the OLD stream's options — what T16p's subscription-identity seam
    // froze at A's subscription start. The OLD onEvent closed over A's creating
    // token.
    const aStreamOptions = currentStreamOptions;
    expect(aStreamOptions).not.toBeNull();
    const aOnEvent = aStreamOptions!.onEvent!;

    // Reset — token cleared (tokenRef.current → null), subscriptionKey bumped.
    act(() => result.current.reset());
    expect(result.current.view.lifecycle).toBe("idle");

    const beforeLogLen = result.current.view.log.length;

    // Invoke A's frozen onEvent directly, simulating an in-flight frame from
    // the OLD stream during the React commit window before T16p's effect
    // cleanup aborts the underlying connection.
    await act(async () => {
      await aOnEvent({
        id: "stale-cursor",
        event: "job.progressed",
        data: JSON.stringify({
          source: "solver",
          currentBestScore: 999,
          elapsedSeconds: 999,
          occurredAt: "2026-07-19T00:00:00Z",
        }),
      });
    });

    // A's onEvent captured A's creating token; tokenRef.current is null after
    // reset; the exact-equality fence drops the dispatch — no view mutation.
    expect(result.current.view.log.length).toBe(beforeLogLen);
    expect(result.current.view.progress).toHaveLength(0);
    stream.close();
  });

  it("A stream's frozen onCursorCommit/onCursorReset cannot forward after reset", async () => {
    const stream = controlledStream();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return stream.response;
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });

    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });
    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));

    const consumerCommit = vi.fn();
    const consumerReset = vi.fn();
    act(() => {
      result.current.attachRecoveredSession(
        preparedAttachment("opt_1", {
          initialCursor: null,
          onCursorCommit: consumerCommit,
          onCursorReset: consumerReset,
        }),
      );
    });

    // Capture A's frozen cursor callbacks.
    const aStreamOptions = currentStreamOptions;
    const aCommit = aStreamOptions!.onCursorCommit;
    const aReset = aStreamOptions!.onCursorReset;
    expect(aCommit).toBeDefined();
    expect(aReset).toBeDefined();

    // Reset revokes the attachment token AND bumps subscriptionKey. T16p's
    // effect cleanup will abort A's underlying connection.
    act(() => result.current.reset());
    expect(result.current.view.lifecycle).toBe("idle");

    // A's frozen callbacks, invoked during the in-flight race window, must NOT
    // forward to the consumer.
    aCommit?.("stale-cursor");
    aReset?.();
    expect(consumerCommit).not.toHaveBeenCalled();
    expect(consumerReset).not.toHaveBeenCalled();
    stream.close();
  });
});

describe("useOptimizeRun — New/Load clears private and public attachment state", () => {
  it("resetEphemeral (New/Load) revokes the attachment token and stream callbacks", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));
    expect(result.current.activation?.jobId).toBe("opt_1");

    // Capture A's frozen onEvent.
    const aStreamOptions = currentStreamOptions;
    const aOnEvent = aStreamOptions!.onEvent!;

    // Simulate the canonical New/Load path: resetEphemeral bumps runGeneration.
    // The controller's generation subscription observes the change and clears
    // private attachment/callbacks/submitting; the token is the authority.
    act(() => useHotStore.getState().resetEphemeral());

    // Allow effects to flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Public view was cleared by resetEphemeral; no late snapshot repopulated.
    expect(result.current.view.lifecycle).toBe("idle");
    expect(result.current.view.jobId).toBeNull();

    // A's frozen onEvent cannot mutate the cleared view.
    const beforeLogLen = result.current.view.log.length;
    await act(async () => {
      await aOnEvent({
        id: "stale",
        event: "job.progressed",
        data: JSON.stringify({
          source: "solver",
          currentBestScore: 999,
          elapsedSeconds: 1,
          occurredAt: "2026-07-19T00:00:00Z",
        }),
      });
    });
    expect(result.current.view.log.length).toBe(beforeLogLen);
    expect(result.current.view.progress).toHaveLength(0);
  });
});

describe("useOptimizeRun — strict wire log (final nested repair P1 #4)", () => {
  it("a durable frame missing occurred_at produces no event-log entry", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) {
        // A strictly valid T06 payload EXCEPT it's missing occurred_at.
        return streamResponse(
          'id: c1\nevent: job.state_changed\ndata: {"state":"running","terminal":false,"queue_position":null,"cancel_requested":false,"early_completion_requested":false,"worker_id":"worker-1","controls":{"cancellable":true,"early_completion_available":true}}\n\n',
        );
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // No durable-frame-applied entry was logged for the malformed frame.
    const wireEvents = result.current.view.log.filter((e) => e.event === "job.state_changed");
    expect(wireEvents).toHaveLength(0);
  });

  it("a durable frame with a malformed T06 payload (unknown state) produces no event-log entry", async () => {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) {
        return streamResponse(
          'id: c1\nevent: job.state_changed\ndata: {"state":"totally-unknown","terminal":false,"queue_position":null,"cancel_requested":false,"early_completion_requested":false,"worker_id":"worker-1","controls":{"cancellable":true,"early_completion_available":true},"occurred_at":"2026-07-19T00:00:00Z"}\n\n',
        );
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const wireEvents = result.current.view.log.filter((e) => e.event === "job.state_changed");
    expect(wireEvents).toHaveLength(0);
  });

  it("a poll snapshot produces zero event-log entries even on state change", async () => {
    // The poll response is a separate authoritative snapshot — it must NOT
    // log a wire event. Wire events come only from the SSE durable-frame path.
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) {
        // The poll returns a different state than the POST's 202 body.
        return json(
          200,
          job({
            state: "queued",
            queue_position: 3,
            controls: { cancellable: true, early_completion_available: false },
          }),
        );
      }
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    await act(async () => {
      await result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(result.current.view.jobId).toBe("opt_1"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // The poll snapshot updated authoritative state (lifecycle=queued, queue=3)
    // and the reducer logged the state TRANSITION (idle/submitting → queued)
    // via the `state` kind — but no durable-frame-applied entry exists.
    expect(result.current.view.lifecycle).toBe("queued");
    const wireEvents = result.current.view.log.filter(
      (e) => e.event !== null && e.event.startsWith("job."),
    );
    expect(wireEvents).toHaveLength(0);
  });
});

describe("useOptimizeRun — globally unique attachment cache identity", () => {
  it.each([
    ["cancel", "/cancel"],
    ["finishNow", "/finish-now"],
  ] as const)("late %s from unmounted A cannot overwrite remounted B", async (method, path) => {
    const lateControl = deferred<Response>();
    routeFetch((u, init) => {
      const httpMethod = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && httpMethod === "POST") {
        return json(202, job({ id: "same-job" }));
      }
      if (u.endsWith(path)) return lateControl.promise;
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job({ id: "same-job" }));
      throw new Error(`unexpected: ${u}`);
    });

    const storageA = memStorage();
    const a = renderHook(() => useOptimizeRun(deps({ storage: storageA })), { wrapper });
    await act(async () => {
      await a.result.current.submit({ document: doc, anonymize: false });
    });
    let pending!: Promise<void>;
    act(() => {
      pending = a.result.current[method]();
    });
    const keyA = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
      .find((key) => key[1] === "same-job" && key[2] === "attach")!;
    a.unmount();

    const storageB = memStorage();
    const b = renderHook(() => useOptimizeRun(deps({ storage: storageB })), { wrapper });
    await act(async () => {
      await b.result.current.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(b.result.current.activation?.jobId).toBe("same-job"));
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
      .filter((key) => key[1] === "same-job" && key[2] === "attach");
    const keyB = keys.find((key) => key[3] !== keyA[3])!;
    expect(keyB).toBeDefined();
    expect((keyA[3] as AttachmentToken).attachmentId).not.toBe(
      (keyB[3] as AttachmentToken).attachmentId,
    );

    await act(async () => {
      lateControl.resolve(
        json(
          200,
          job({
            id: "same-job",
            state: "cancelling",
            controls: { cancellable: false, early_completion_available: false },
          }),
        ),
      );
      await pending;
    });

    expect(b.result.current.view.lifecycle).not.toBe("cancelling");
    expect(client.getQueryData<JobResponse>(keyB)?.state).toBe("running");
    expect(client.getQueryData<JobResponse>(optimizeKeys.job("same-job"))?.state).toBe("running");
    b.unmount();
  });

  it("same-stack recovery attach and control use the new token identity", async () => {
    routeFetch((u) => {
      if (u.endsWith("/cancel")) {
        return json(200, job({ id: "same-stack", state: "cancelling" }));
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) {
        return json(200, job({ id: "same-stack", state: "cancelling" }));
      }
      throw new Error(`unexpected: ${u}`);
    });
    const { result } = renderHook(() => useOptimizeRun(deps()), { wrapper });

    let pending!: Promise<void>;
    act(() => {
      useHotStore.getState().resetEphemeral();
      result.current.attachRecoveredSession(preparedAttachment("same-stack"));
      pending = result.current.cancel();
    });
    await act(async () => pending);

    const scoped = client
      .getQueryCache()
      .getAll()
      .find(
        (query) =>
          query.queryKey[1] === "same-stack" &&
          query.queryKey[2] === "attach" &&
          (query.queryKey[3] as AttachmentToken).jobId === "same-stack",
      );
    expect(scoped?.state.data).toMatchObject({ id: "same-stack", state: "cancelling" });
    expect(result.current.view.lifecycle).toBe("cancelling");
  });
});
