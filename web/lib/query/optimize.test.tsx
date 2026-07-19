// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JobResponse } from "@/lib/bff/types";
import {
  applyFrameToCache,
  applyFrameWithReconcile,
  fetchOptimizeXlsx,
  OptimizeApiError,
  useCancelOptimize,
  useFinishNowOptimize,
  useSubmitOptimize,
} from "@/lib/query/optimize";
import { optimizeKeys } from "@/lib/query/keys";

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

const baseJob = (over: Partial<JobResponse>): JobResponse =>
  ({
    id: "opt_1",
    state: "running",
    terminal: false,
    queue_position: null,
    created_at: "t",
    started_at: null,
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
    links: {
      self: "/optimize/opt_1",
      events: "/optimize/opt_1/events",
      cancellation: "/optimize/opt_1/cancel",
      early_completion: "/optimize/opt_1/finish-now",
      schedule: null,
    },
    ...over,
  }) as JobResponse;

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
});

describe("fetchOptimizeXlsx", () => {
  it("returns the blob and filename from Content-Disposition", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(new Blob([new Uint8Array([1, 2])]), {
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

  it("patches state/terminal/queue_position/controls from the enriched job.state_changed frame", () => {
    const outcome = applyFrameToCache(client, "opt_1", {
      id: "v1.j.1",
      event: "job.state_changed",
      data: '{"occurred_at":"t","state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}',
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
      data: '{"state":"failed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false},"error":{"code":"worker_lost","message":"The optimization worker stopped before the job completed."}}',
    });
    expect(cached()?.state).toBe("failed");
    expect(cached()?.error?.code).toBe("worker_lost");
  });

  it("clears early_completion_available from a job.control_changed frame (flag only)", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.3",
      event: "job.control_changed",
      data: '{"occurred_at":"t","early_completion_requested":true}',
    });
    const controls = cached()?.controls;
    expect(controls?.early_completion_available).toBe(false);
    expect(controls?.cancellable).toBe(true); // unchanged — not invented
  });

  it("patches flat result fields and exposes the schedule link from job.result_available", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.4",
      event: "job.result_available",
      data: '{"outcome":"feasible","score":42,"solver_status":"FEASIBLE","termination_reason":null,"artifact_name":"schedule.xlsx"}',
    });
    expect(cached()?.result).toEqual({
      outcome: "feasible",
      score: 42,
      solver_status: "FEASIBLE",
      termination_reason: null,
    });
    expect(cached()?.links.schedule).toBe("/optimize/opt_1/xlsx");
  });

  it("leaves the schedule link null when result_available carries no artifact", () => {
    applyFrameToCache(client, "opt_1", {
      id: "v1.j.5",
      event: "job.result_available",
      data: '{"outcome":"infeasible","score":null,"solver_status":"INFEASIBLE","termination_reason":null,"artifact_name":null}',
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
        data: '{"state":"running","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":false,"controls":{"cancellable":true,"early_completion_available":true}}',
      }),
    ).toBe("needs-reconcile");
    expect(client.getQueryData<JobResponse>(key)).toBeUndefined(); // no partial write
  });

  it("returns needs-reconcile for a valid TERMINAL state_changed frame with no cache", () => {
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.1t",
        event: "job.state_changed",
        data: '{"state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}',
      }),
    ).toBe("needs-reconcile");
    expect(client.getQueryData<JobResponse>(key)).toBeUndefined();
  });

  it("returns needs-reconcile for a valid control_changed frame with no cache", () => {
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.2",
        event: "job.control_changed",
        data: '{"early_completion_requested":true}',
      }),
    ).toBe("needs-reconcile");
    expect(client.getQueryData<JobResponse>(key)).toBeUndefined();
  });

  it("returns needs-reconcile for a valid result_available frame with no cache", () => {
    expect(
      applyFrameToCache(client, "opt_1", {
        id: "v1.j.3",
        event: "job.result_available",
        data: '{"outcome":"feasible","score":42,"solver_status":"FEASIBLE","termination_reason":null,"artifact_name":"schedule.xlsx"}',
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
        data: '{"state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}',
      },
      reconcile,
    );
    expect(reconcile).toHaveBeenCalledOnce();
    expect(client.getQueryData<JobResponse>(key)?.state).toBe("completed");
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
      { id: "v1.j.1", event: "job.control_changed", data: '{"early_completion_requested":true}' },
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
