// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LAST_EVENT_ID_HEADER } from "@/lib/bff/types";
import type { JobResponse } from "@/lib/bff/types";
import {
  applyFrameToCache,
  applyFrameWithReconcile,
  fetchOptimizeXlsx,
  OptimizeApiError,
  useCancelOptimize,
  useFinishNowOptimize,
  useOptimizeJobScoped,
  useOptimizeEventStream,
  useSubmitOptimize,
} from "@/lib/query/optimize";
import { optimizeKeys } from "@/lib/query/keys";
import { MAX_CURSOR_BYTES } from "@/lib/query/sse-limits";

const originalFetch = globalThis.fetch;
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

function mockJsonOnce(status: number, body: unknown, headers?: Record<string, string>) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  ) as typeof fetch;
}

const baseJob = (over: Partial<JobResponse>): JobResponse => {
  const state = over.state ?? "running";
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
                score: 7,
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
  const id = over.id ?? "opt_1";
  const schedule =
    state === "completed" && (over.result?.outcome ?? "optimal") !== "infeasible"
      ? `/optimize/${id}/xlsx`
      : null;
  return {
    id: "opt_1",
    state: "running",
    terminal: false,
    queue_position: null,
    created_at: "2026-07-20T00:00:00+00:00",
    started_at: "2026-07-20T00:00:01+00:00",
    finished_at: null,
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: true },
    ...stateDefaults,
    ...over,
    request: {
      input_name: "s.yaml",
      solver: "ortools/cp-sat",
      prettify: null,
      timeout_seconds: 300,
      ...over.request,
    },
    links: {
      self: `/optimize/${id}`,
      events: `/optimize/${id}/events`,
      cancellation: `/optimize/${id}/cancel`,
      early_completion: `/optimize/${id}/finish-now`,
      schedule,
      ...over.links,
    },
  } as JobResponse;
};

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("useSubmitOptimize", () => {
  it("POSTs multipart and caches the returned JobResponse by id", async () => {
    const job = baseJob({ id: "opt_9", state: "queued", queue_position: 2 });
    mockJsonOnce(202, job);

    const { result } = renderHook(() => useSubmitOptimize(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ yamlContent: "workspaceVersion: 1" });
    });

    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/optimize");
    expect((init as RequestInit).method).toBe("POST");
    expect(client.getQueryData(optimizeKeys.job("opt_9"))).toEqual(job);
  });

  it("throws a classified OptimizeApiError on a code-first validation 422", async () => {
    mockJsonOnce(422, {
      error: {
        code: "workspace_not_ready",
        message: "Workspace is not ready to optimize.",
        issues: [],
      },
    });

    const { result } = renderHook(() => useSubmitOptimize(), { wrapper });
    let caught: unknown;
    await act(async () => {
      caught = await result.current.mutateAsync({ yamlContent: "x" }).catch((error) => error);
    });
    expect(caught).toBeInstanceOf(OptimizeApiError);
    expect((caught as OptimizeApiError).info.kind).toBe("validation");
  });
});

describe("useOptimizeJobScoped identity", () => {
  it("rejects a mismatched response before cache or source-proof callbacks", async () => {
    mockJsonOnce(200, baseJob({ id: "opt_Y", terminal: true, state: "completed" }));
    const onResponse = vi.fn();
    const { result } = renderHook(() => useOptimizeJobScoped("opt_X", "attach-X", { onResponse }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onResponse).not.toHaveBeenCalled();
    expect(client.getQueryData(optimizeKeys.jobScoped("opt_X", "attach-X"))).toBeUndefined();
  });

  it("rejects a malformed matching-id poll before cache or source proof", async () => {
    mockJsonOnce(200, { ...baseJob({}), terminal: true });
    const onResponse = vi.fn();
    const { result } = renderHook(() => useOptimizeJobScoped("opt_1", "attach-1", { onResponse }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onResponse).not.toHaveBeenCalled();
    expect(client.getQueryData(optimizeKeys.jobScoped("opt_1", "attach-1"))).toBeUndefined();
  });

  it.each([
    [500, { error: { code: "job_not_found", message: "gone" } }],
    [404, { error: { code: "job_not_found" } }],
  ])("does not emit gone proof for degraded status/envelope %#", async (status, body) => {
    mockJsonOnce(status, body);
    const onJobGone = vi.fn();
    const { result } = renderHook(() => useOptimizeJobScoped("opt_1", "attach-1", { onJobGone }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onJobGone).not.toHaveBeenCalled();
  });
});

describe("cancel / finish-now driven by server controls", () => {
  it("useCancelOptimize caches the server's post-cancel controls/state", async () => {
    const cancelled = baseJob({
      state: "cancelling",
      controls: { cancellable: false, early_completion_available: false },
    });
    mockJsonOnce(202, cancelled);

    const { result } = renderHook(() => useCancelOptimize(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("opt_1");
    });

    const cached = client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"));
    expect(cached?.state).toBe("cancelling");
    expect(cached?.controls.cancellable).toBe(false);
  });

  it("useFinishNowOptimize POSTs finish-now and reflects the new controls", async () => {
    const finishing = baseJob({
      controls: { cancellable: true, early_completion_available: false },
    });
    mockJsonOnce(202, finishing);

    const { result } = renderHook(() => useFinishNowOptimize(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("opt_1");
    });

    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/optimize/opt_1/finish-now");
    expect(
      client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"))?.controls
        .early_completion_available,
    ).toBe(false);
  });

  it("a late keyed cancel writes only A's scoped cache and never overwrites live B", async () => {
    let resolve!: (response: Response) => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ) as typeof fetch;
    const liveB = baseJob({ state: "running" });
    client.setQueryData(optimizeKeys.job("opt_1"), liveB);
    const { result } = renderHook(() => useCancelOptimize(), { wrapper });

    let pending!: Promise<JobResponse>;
    act(() => {
      pending = result.current.mutateAsync({
        jobId: "opt_1",
        attachmentKey: "A",
        isCurrentAttachment: () => false,
      });
    });
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    const cancellingA = baseJob({
      state: "cancelling",
      controls: { cancellable: false, early_completion_available: false },
    });
    await act(async () => {
      resolve(
        new Response(JSON.stringify(cancellingA), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
      await pending;
    });

    expect(client.getQueryData(optimizeKeys.jobScoped("opt_1", "A"))).toEqual(cancellingA);
    expect(client.getQueryData(optimizeKeys.job("opt_1"))).toEqual(liveB);
  });

  it("a live keyed finish refreshes scoped state before a partial frame patches it", async () => {
    const finishedControl = baseJob({
      controls: { cancellable: true, early_completion_available: false },
    });
    mockJsonOnce(202, finishedControl);
    client.setQueryData(optimizeKeys.jobScoped("opt_1", "B"), baseJob({}));
    const { result } = renderHook(() => useFinishNowOptimize(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: "opt_1",
        attachmentKey: "B",
        isCurrentAttachment: () => true,
      });
    });
    applyFrameToCache(
      client,
      "opt_1",
      {
        id: "v1.j.9",
        event: "job.result_available",
        data: '{"outcome":"feasible","score":7,"solver_status":"FEASIBLE","termination_reason":null,"artifact_name":null}',
      },
      optimizeKeys.jobScoped("opt_1", "B"),
    );

    const scoped = client.getQueryData<JobResponse>(optimizeKeys.jobScoped("opt_1", "B"));
    expect(scoped?.controls.early_completion_available).toBe(false);
    expect(client.getQueryData(optimizeKeys.job("opt_1"))).toEqual(finishedControl);
  });

  it("a mismatched keyed control response writes neither scoped nor base cache", async () => {
    const liveX = baseJob({ id: "opt_X" });
    const wrongY = baseJob({ id: "opt_Y", state: "cancelling" });
    client.setQueryData(optimizeKeys.job("opt_X"), liveX);
    mockJsonOnce(202, wrongY);
    const { result } = renderHook(() => useCancelOptimize(), { wrapper });

    let caught: unknown;
    await act(async () => {
      caught = await result.current
        .mutateAsync({
          jobId: "opt_X",
          attachmentKey: "X",
          isCurrentAttachment: () => true,
        })
        .catch((error) => error);
    });

    expect(caught).toBeInstanceOf(Error);
    expect(client.getQueryData(optimizeKeys.jobScoped("opt_X", "X"))).toBeUndefined();
    expect(client.getQueryData(optimizeKeys.job("opt_X"))).toEqual(liveX);
    expect(client.getQueryData(optimizeKeys.job("opt_Y"))).toBeUndefined();
  });

  it("rejects an incomplete control response without mutating either cache", async () => {
    const live = baseJob({});
    client.setQueryData(optimizeKeys.job("opt_1"), live);
    mockJsonOnce(202, { id: "opt_1", state: "cancelled", terminal: true });
    const { result } = renderHook(() => useCancelOptimize(), { wrapper });

    let caught: unknown;
    await act(async () => {
      caught = await result.current
        .mutateAsync({
          jobId: "opt_1",
          attachmentKey: "A",
          isCurrentAttachment: () => true,
        })
        .catch((error) => error);
    });

    expect(caught).toBeInstanceOf(Error);
    expect(client.getQueryData(optimizeKeys.jobScoped("opt_1", "A"))).toBeUndefined();
    expect(client.getQueryData(optimizeKeys.job("opt_1"))).toEqual(live);
  });
});

describe("fetchOptimizeXlsx", () => {
  it("returns the blob and filename from Content-Disposition", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        // Body is a Uint8Array (valid BodyInit), not a jsdom Blob: this file runs in
        // jsdom, whose Blob lacks `.stream()`, which the global (undici) Response
        // constructor calls — `new Response(jsdomBlob)` throws "object.stream is not a
        // function". The SUT's `response.blob()` still returns the bytes.
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="schedule.xlsx"' },
        }),
    ) as typeof fetch;

    const { filename } = await fetchOptimizeXlsx("opt_1");
    expect(filename).toBe("schedule.xlsx");
  });

  it("throws a classified no-artifact error on a code-first 404", async () => {
    mockJsonOnce(404, { error: { code: "job_artifact_not_found", message: "No schedule." } });
    await expect(fetchOptimizeXlsx("opt_1")).rejects.toMatchObject({
      info: { kind: "no-artifact" },
    });
  });
});

describe("applyFrameToCache (exact backend-wire fixtures)", () => {
  beforeEach(() => {
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
  });
  const cached = () => client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"));
  const runtimeIdentity = {
    service_name: "nurse-scheduling-api",
    api_version: "alpha",
    app_version: "v-test",
    deployment_id: "deployment-test",
    instance_id: "instance-test",
    started_at: "2026-07-20T00:00:00+00:00",
    job_backend: "memory",
    job_store_id: "store-test",
  };

  it("applies the real queued-runtime and running-worker-runtime variants", () => {
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.queued",
        event: "job.state_changed",
        data: JSON.stringify({
          occurred_at: "2026-07-20T00:00:00+00:00",
          state: "queued",
          queue_position: 1,
          cancel_requested: false,
          early_completion_requested: false,
          terminal: false,
          controls: { cancellable: true, early_completion_available: false },
          runtime: runtimeIdentity,
        }),
      }),
    ).toBe("applied");
    expect(cached()?.state).toBe("queued");

    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.running",
        event: "job.state_changed",
        data: JSON.stringify({
          occurred_at: "2026-07-20T00:00:01+00:00",
          state: "running",
          queue_position: null,
          cancel_requested: false,
          early_completion_requested: false,
          terminal: false,
          controls: { cancellable: true, early_completion_available: true },
          worker_id: "worker-1",
          runtime: runtimeIdentity,
        }),
      }),
    ).toBe("applied");
    expect(cached()?.state).toBe("running");
  });

  it("patches state/terminal/queue_position/controls from the enriched job.state_changed frame", () => {
    const outcome = applyFrameToCache(client, "opt_1", {
      id: "v1.j.1",
      event: "job.state_changed",
      data: '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}',
    });
    expect(outcome).toBe("applied");
    expect(cached()?.state).toBe("completed");
    expect(cached()?.terminal).toBe(true);
    expect(cached()?.controls.cancellable).toBe(false);
  });

  it("merges the top-level error from a terminal worker_lost state frame", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.2",
      event: "job.state_changed",
      data: '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"failed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false},"error":{"code":"worker_lost","message":"The optimization worker stopped before the job completed."}}',
    });
    expect(cached()?.state).toBe("failed");
    expect(cached()?.error?.code).toBe("worker_lost");
  });

  it("merges the top-level error from a terminal process_timeout state frame", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.2b",
      event: "job.state_changed",
      data: '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"failed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false},"error":{"code":"process_timeout","message":"The optimization exceeded its timeout and was force-terminated."}}',
    });
    expect(cached()?.state).toBe("failed");
    expect(cached()?.error?.code).toBe("process_timeout");
  });

  it("clears early_completion_available from a job.control_changed frame (flag only)", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.3",
      event: "job.control_changed",
      data: '{"occurred_at":"2026-07-20T00:00:00+00:00","early_completion_requested":true}',
    });
    const controls = cached()?.controls;
    expect(controls?.early_completion_available).toBe(false);
    expect(controls?.cancellable).toBe(true); // unchanged — not invented
  });

  it("patches flat result fields and exposes the schedule link from job.result_available", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.4",
      event: "job.result_available",
      data: '{"occurred_at":"2026-07-20T00:00:00+00:00","outcome":"feasible","score":42,"solver_status":"FEASIBLE","termination_reason":"limit_or_stop","artifact_name":"schedule.xlsx"}',
    });
    expect(cached()?.result).toEqual({
      outcome: "feasible",
      score: 42,
      solver_status: "FEASIBLE",
      termination_reason: "limit_or_stop",
    });
    expect(cached()?.links.schedule).toBe("/optimize/opt_1/xlsx");
  });

  it("accepts solver_timeout as a feasible termination reason from job.result_available", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.4b",
      event: "job.result_available",
      data: '{"occurred_at":"2026-07-20T00:00:00+00:00","outcome":"feasible","score":42,"solver_status":"FEASIBLE","termination_reason":"solver_timeout","artifact_name":"schedule.xlsx"}',
    });
    expect(cached()?.result).toEqual({
      outcome: "feasible",
      score: 42,
      solver_status: "FEASIBLE",
      termination_reason: "solver_timeout",
    });
    expect(cached()?.links.schedule).toBe("/optimize/opt_1/xlsx");
  });

  it("leaves the schedule link null when result_available carries no artifact", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.5",
      event: "job.result_available",
      data: '{"occurred_at":"2026-07-20T00:00:00+00:00","outcome":"infeasible","score":null,"solver_status":"INFEASIBLE","termination_reason":"infeasibility_proven","artifact_name":null}',
    });
    expect(cached()?.result?.outcome).toBe("infeasible");
    expect(cached()?.links.schedule).toBeNull();
  });

  it("returns needs-reconcile (without mutating the cache) for malformed durable payloads", () => {
    const before = cached();
    // Malformed JSON on a durable event.
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.6a",
        event: "job.state_changed",
        data: "{not json",
      }),
    ).toBe("needs-reconcile");
    // The impossible nested-result shape the closure review flagged (parser-rejected).
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.6b",
        event: "job.result_available",
        data: '{"result":{"outcome":"feasible","score":42}}',
      }),
    ).toBe("needs-reconcile");
    // An incomplete control frame (flag missing).
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.6c",
        event: "job.control_changed",
        data: '{"occurred_at":"t"}',
      }),
    ).toBe("needs-reconcile");
    expect(cached()).toEqual(before); // never mutated on the needs-reconcile path
  });

  it.each([
    [
      "queued without queue position",
      "job.state_changed",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"queued","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":false,"controls":{"cancellable":true,"early_completion_available":false}}',
    ],
    [
      "running with terminal controls",
      "job.state_changed",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"running","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":false,"worker_id":"worker-1","controls":{"cancellable":false,"early_completion_available":false}}',
    ],
    [
      "failed without error",
      "job.state_changed",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"failed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}',
    ],
    [
      "control false",
      "job.control_changed",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","early_completion_requested":false}',
    ],
    [
      "feasible result without artifact",
      "job.result_available",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","outcome":"feasible","score":42,"solver_status":"FEASIBLE","termination_reason":"limit_or_stop","artifact_name":null}',
    ],
    [
      "solver_timeout result without artifact",
      "job.result_available",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","outcome":"feasible","score":42,"solver_status":"FEASIBLE","termination_reason":"solver_timeout","artifact_name":null}',
    ],
    [
      "solver_timeout result with no score",
      "job.result_available",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","outcome":"feasible","score":null,"solver_status":"FEASIBLE","termination_reason":"solver_timeout","artifact_name":"schedule.xlsx"}',
    ],
    [
      "infeasible result with artifact",
      "job.result_available",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","outcome":"infeasible","score":null,"solver_status":"INFEASIBLE","termination_reason":"infeasibility_proven","artifact_name":"schedule.xlsx"}',
    ],
    [
      "state with an unknown key",
      "job.state_changed",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"running","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":false,"worker_id":"worker-1","controls":{"cancellable":true,"early_completion_available":true},"mystery":true}',
    ],
    [
      "running state with malformed runtime",
      "job.state_changed",
      '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"running","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":false,"worker_id":"worker-1","controls":{"cancellable":true,"early_completion_available":true},"runtime":{"service_name":"nurse-scheduling-api"}}',
    ],
  ])(
    "rejects a backend-impossible %s frame without mutating a populated cache",
    (_name, event, data) => {
      const before = cached();
      expect(applyFrameToCache(client, "opt_1", { id: "v1.impossible", event, data })).toBe(
        "needs-reconcile",
      );
      expect(cached()).toEqual(before);
    },
  );

  it("returns applied for ephemeral frames (even malformed) and never writes them", () => {
    const before = cached();
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.7",
        event: "job.progressed",
        data: '{"score":7}',
      }),
    ).toBe("applied");
    expect(
      applyFrameToCache(client, "opt_1", { id: "v1.j.7b", event: "job.progressed", data: "{bad" }),
    ).toBe("applied");
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.8",
        event: "job.phase_changed",
        data: '{"phase":"solve"}',
      }),
    ).toBe("applied");
    expect(cached()).toEqual(before);
  });
});

describe("applyFrameToCache with NO cached JobResponse (partial frame cannot construct one)", () => {
  // No beforeEach seed here: the top-level beforeEach makes a fresh, empty client, so
  // optimizeKeys.job("opt_1") is absent. A partial durable frame must NOT be silently
  // acknowledged — it must reconcile so the authoritative poll creates the response.
  const key = optimizeKeys.job("opt_1");

  it("returns needs-reconcile for a valid state_changed frame and never fabricates a cache entry", () => {
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.1",
        event: "job.state_changed",
        data: '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"running","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":false,"worker_id":"worker-1","controls":{"cancellable":true,"early_completion_available":true}}',
      }),
    ).toBe("needs-reconcile");
    expect(client.getQueryData<JobResponse>(key)).toBeUndefined(); // no partial write
  });

  it("returns needs-reconcile for a valid TERMINAL state_changed frame with no cache", () => {
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.1t",
        event: "job.state_changed",
        data: '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}',
      }),
    ).toBe("needs-reconcile");
    expect(client.getQueryData<JobResponse>(key)).toBeUndefined();
  });

  it("returns needs-reconcile for a valid control_changed frame with no cache", () => {
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.2",
        event: "job.control_changed",
        data: '{"occurred_at":"2026-07-20T00:00:00+00:00","early_completion_requested":true}',
      }),
    ).toBe("needs-reconcile");
    expect(client.getQueryData<JobResponse>(key)).toBeUndefined();
  });

  it("returns needs-reconcile for a valid result_available frame with no cache", () => {
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.3",
        event: "job.result_available",
        data: '{"occurred_at":"2026-07-20T00:00:00+00:00","outcome":"feasible","score":42,"solver_status":"FEASIBLE","termination_reason":"limit_or_stop","artifact_name":"schedule.xlsx"}',
      }),
    ).toBe("needs-reconcile");
    expect(client.getQueryData<JobResponse>(key)).toBeUndefined();
  });

  it("reconciles a valid durable frame with no cache by polling, which populates the response", async () => {
    const key = optimizeKeys.job("opt_1");
    const authoritative = baseJob({ state: "completed", terminal: true });
    const reconcile = vi.fn(async () => {
      client.setQueryData(key, authoritative);
      return authoritative;
    });
    await applyFrameWithReconcile(
      client,
      "opt_1",
      {
        id: "v1.j.9",
        event: "job.state_changed",
        data: '{"occurred_at":"2026-07-20T00:00:00+00:00","state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}',
      },
      reconcile,
    );
    expect(reconcile).toHaveBeenCalledOnce();
    expect(client.getQueryData<JobResponse>(key)?.state).toBe("completed");
  });
});

describe("useOptimizeEventStream (T16p resume seam)", () => {
  // A full enriched terminal payload — required for the frame to be RECOGNIZED as
  // terminal (parseStateChangedPayload) and applied against the seeded cache.
  const terminalData =
    '{"occurred_at":"2026-07-20T00:01:00+00:00","state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}';

  function streamResponse(text: string): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  // Route the events subscription to an SSE stream and every poll to a terminal job.
  function mockStream(text: string): { eventsHeader: () => string | null } {
    let sent: string | null = null;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/events")) {
        sent = new Headers(init?.headers).get(LAST_EVENT_ID_HEADER);
        return streamResponse(text);
      }
      return new Response(JSON.stringify(baseJob({ state: "completed", terminal: true })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { eventsHeader: () => sent };
  }

  it("carries the supplied initialCursor as Last-Event-ID on the first request", async () => {
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
    const { eventsHeader } = mockStream(
      `id: v1.j.9\nevent: job.state_changed\ndata: ${terminalData}\n\n`,
    );
    const onTerminal = vi.fn();

    renderHook(
      () =>
        useOptimizeEventStream("opt_1", { enabled: true, initialCursor: "v1.j.42", onTerminal }),
      { wrapper },
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalled());
    expect(eventsHeader()).toBe("v1.j.42");
  });

  it("routes an oversized restored initialCursor through explicit invalid-cursor recovery (never silently cursorless, never sent as a header)", async () => {
    // A corrupted/foreign restored cursor past the byte cap must NOT be seeded as a
    // `Last-Event-ID` header nor silently downgraded to a cursorless resume: it takes
    // the SAME explicit invalid-cursor recovery the backend `invalid_event_cursor`
    // path uses (surface the recovery + clear the persisted cursor), then resumes
    // from the retained floor.
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
    const { eventsHeader } = mockStream(
      `id: v1.j.9\nevent: job.state_changed\ndata: ${terminalData}\n\n`,
    );
    const onTerminal = vi.fn();
    const onCursorInvalid = vi.fn();
    const onCursorReset = vi.fn();
    const oversized = "c".repeat(MAX_CURSOR_BYTES + 1);

    renderHook(
      () =>
        useOptimizeEventStream("opt_1", {
          enabled: true,
          initialCursor: oversized,
          onTerminal,
          onCursorInvalid,
          onCursorReset,
        }),
      { wrapper },
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalled());
    expect(onCursorInvalid).toHaveBeenCalledTimes(1); // explicit recovery, not a silent null
    expect(onCursorReset).toHaveBeenCalledTimes(1); // persisted cursor cleared
    expect(eventsHeader()).toBeNull(); // the poison cursor was never sent as a header
  });

  it("emits onCursorCommit with each committed cursor, after apply, once", async () => {
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
    mockStream(
      'id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n' +
        `id: v1.j.2\nevent: job.state_changed\ndata: ${terminalData}\n\n`,
    );
    const committed: string[] = [];
    const onTerminal = vi.fn();

    renderHook(
      () =>
        useOptimizeEventStream("opt_1", {
          enabled: true,
          onCursorCommit: (cursor) => committed.push(cursor),
          onTerminal,
        }),
      { wrapper },
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalled());
    expect(committed).toEqual(["v1.j.1", "v1.j.2"]);
  });

  it("awaits a rejecting async onEvent: no onCursorCommit, recovery follows the failed-frame path", async () => {
    // Buggy (un-awaited) code would commit and fire onCursorCommit for v1.j.1 before
    // the async rejection settled; awaiting the consumer means the commit never runs.
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
    mockStream('id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n');
    const committed: string[] = [];
    const onTerminal = vi.fn();

    renderHook(
      () =>
        useOptimizeEventStream("opt_1", {
          enabled: true,
          // Promise-returning consumer that rejects: the apply-before-commit fence must
          // await it, so the cursor stays put and no post-commit callback fires.
          onEvent: async () => {
            throw new Error("async consumer failed");
          },
          onCursorCommit: (cursor) => committed.push(cursor),
          onTerminal,
        }),
      { wrapper },
    );

    // The rejection drops the connection; recovery polls, sees terminal, and stops —
    // no cursor was committed for the un-applied frame.
    await waitFor(() => expect(onTerminal).toHaveBeenCalled());
    expect(committed).toEqual([]);
  });

  it("rejects a malformed recovery poll without cache mutation or terminal proof", async () => {
    const live = baseJob({});
    client.setQueryData(optimizeKeys.job("opt_1"), live);
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/events")) return streamResponse("");
      return new Response(JSON.stringify({ ...live, terminal: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const onTerminal = vi.fn();
    const onTerminalProof = vi.fn();
    const onError = vi.fn();

    renderHook(
      () =>
        useOptimizeEventStream("opt_1", {
          enabled: true,
          maxReconnects: 0,
          onTerminal,
          onTerminalProof,
          onError,
        }),
      { wrapper },
    );

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onTerminal).not.toHaveBeenCalled();
    expect(onTerminalProof).not.toHaveBeenCalled();
    expect(client.getQueryData(optimizeKeys.job("opt_1"))).toEqual(live);
  });

  it("commits exactly once per frame for a resolving async onEvent", async () => {
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
    mockStream(
      'id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n' +
        `id: v1.j.2\nevent: job.state_changed\ndata: ${terminalData}\n\n`,
    );
    const committed: string[] = [];
    const onTerminal = vi.fn();

    renderHook(
      () =>
        useOptimizeEventStream("opt_1", {
          enabled: true,
          onEvent: async () => {
            await Promise.resolve();
          },
          onCursorCommit: (cursor) => committed.push(cursor),
          onTerminal,
        }),
      { wrapper },
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalled());
    expect(committed).toEqual(["v1.j.1", "v1.j.2"]);
  });

  it("omits Last-Event-ID on the first request when no initialCursor is given", async () => {
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
    let hadHeader = true;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/events")) {
        hadHeader = new Headers(init?.headers).has(LAST_EVENT_ID_HEADER);
        return streamResponse(`id: v1.j.9\nevent: job.state_changed\ndata: ${terminalData}\n\n`);
      }
      return new Response(JSON.stringify(baseJob({ state: "completed", terminal: true })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const onTerminal = vi.fn();

    renderHook(() => useOptimizeEventStream("opt_1", { enabled: true, onTerminal }), { wrapper });

    await waitFor(() => expect(onTerminal).toHaveBeenCalled());
    expect(hadHeader).toBe(false);
  });

  // A stream the test keeps open and pushes frames into, so a re-render with a
  // refreshed callback can occur BETWEEN frames.
  function controlledEventsStream(): { push: (t: string) => void; close: () => void } {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/events")) {
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify(baseJob({})), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return {
      push: (t) => controller?.enqueue(enc.encode(t)),
      close: () => controller?.close(),
    };
  }

  it("unkeyed subscription keeps LIVE callbacks: a refreshed onCursorCommit takes effect (legacy)", async () => {
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
    const stream = controlledEventsStream();
    const commitV1 = vi.fn();
    const commitV2 = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: (c: string) => void }) =>
        useOptimizeEventStream("opt_1", { enabled: true, onCursorCommit: cb }),
      { wrapper, initialProps: { cb: commitV1 } },
    );
    await act(async () => {
      stream.push('id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(commitV1).toHaveBeenCalledWith("v1.j.1");

    // Re-render with a refreshed callback. Unkeyed → no re-subscribe, but the live
    // `optionsRef` must forward the next commit to the NEW callback (documented
    // legacy behavior). Freezing here would strand the refreshed consumer.
    rerender({ cb: commitV2 });
    await act(async () => {
      stream.push('id: v1.j.2\nevent: job.progressed\ndata: {"p":2}\n\n');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(commitV2).toHaveBeenCalledWith("v1.j.2");
    stream.close();
  });

  it("keyed subscription FREEZES callbacks: a refreshed callback under the SAME key is ignored", async () => {
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
    const stream = controlledEventsStream();
    const commitV1 = vi.fn();
    const commitV2 = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: (c: string) => void }) =>
        useOptimizeEventStream("opt_1", { enabled: true, subscriptionKey: 1, onCursorCommit: cb }),
      { wrapper, initialProps: { cb: commitV1 } },
    );
    await act(async () => {
      stream.push('id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(commitV1).toHaveBeenCalledWith("v1.j.1");

    // Refresh the callback but keep the SAME subscriptionKey → frozen. The new
    // callback must NOT be invoked; the frozen capture (V1) still owns the
    // subscription. This is what prevents an A stream reaching B's callbacks.
    rerender({ cb: commitV2 });
    await act(async () => {
      stream.push('id: v1.j.2\nevent: job.progressed\ndata: {"p":2}\n\n');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(commitV2).not.toHaveBeenCalled();
    expect(commitV1).toHaveBeenCalledWith("v1.j.2");
    stream.close();
  });
});

describe("applyFrameWithReconcile", () => {
  beforeEach(() => {
    client.setQueryData(optimizeKeys.job("opt_1"), baseJob({}));
  });

  it("does NOT reconcile a well-formed durable frame (applies directly)", async () => {
    const reconcile = vi.fn(async () => baseJob({}));
    await applyFrameWithReconcile(
      client,
      "opt_1",
      {
        id: "v1.j.1",
        event: "job.control_changed",
        data: '{"occurred_at":"2026-07-20T00:00:00+00:00","early_completion_requested":true}',
      },
      reconcile,
    );
    expect(reconcile).not.toHaveBeenCalled();
    expect(
      client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"))?.controls
        .early_completion_available,
    ).toBe(false);
  });

  it("reconciles a malformed durable frame by polling authoritative state", async () => {
    const authoritative = baseJob({
      state: "failed",
      terminal: true,
      error: { code: "worker_lost", message: "lost" },
    });
    const reconcile = vi.fn(async () => {
      client.setQueryData(optimizeKeys.job("opt_1"), authoritative);
      return authoritative;
    });
    await applyFrameWithReconcile(
      client,
      "opt_1",
      { id: "v1.j.2", event: "job.state_changed", data: "{malformed" },
      reconcile,
    );
    expect(reconcile).toHaveBeenCalledOnce();
    expect(client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"))?.error?.code).toBe(
      "worker_lost",
    );
  });

  it("does NOT reconcile an ephemeral frame", async () => {
    const reconcile = vi.fn(async () => baseJob({}));
    await applyFrameWithReconcile(
      client,
      "opt_1",
      { id: "v1.j.3", event: "job.progressed", data: "{bad" },
      reconcile,
    );
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("propagates a reconcile (poll) failure so the caller does not commit the cursor", async () => {
    const reconcile = vi.fn(async () => {
      throw new Error("poll failed");
    });
    await expect(
      applyFrameWithReconcile(
        client,
        "opt_1",
        { id: "v1.j.4", event: "job.result_available", data: "{bad" },
        reconcile,
      ),
    ).rejects.toThrow("poll failed");
  });
});
