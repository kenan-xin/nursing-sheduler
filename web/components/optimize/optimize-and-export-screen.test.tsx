// @vitest-environment jsdom
//
// T16e screen integration: the real controller + recovery + terminal orchestration
// wired through the screen, with mocked transport. Proves the readiness/version
// gates, the end-to-end submit → download → cleanup terminal path with bounded
// observability, and the confirmed Forget of an interrupted recovery record.

import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JobResponse } from "@/lib/bff/types";
import { useHotStore, useScenarioStore } from "@/lib/store";
import { createEmptyScenarioUiState } from "@/lib/scenario/canonical";
import type { PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import {
  buildProvisionalSession,
  createOptimizeObservability,
  OPTIMIZE_SESSION_STORAGE_KEY,
  type CleanupCallOutcome,
  type SessionTransactionStorage,
} from "@/lib/optimize";
import { OptimizeAndExportScreen } from "./optimize-and-export-screen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/optimize-and-export",
}));

const originalFetch = globalThis.fetch;
let client: QueryClient;

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

const baseJob = (over: Partial<JobResponse> = {}): JobResponse => ({
  id: "opt_1",
  state: "queued",
  terminal: false,
  queue_position: 2,
  created_at: "2026-07-20T00:00:00+00:00",
  started_at: null,
  finished_at: null,
  request: { input_name: "s.yaml", solver: "ortools/cp-sat", prettify: null, timeout_seconds: 300 },
  result: null,
  error: null,
  controls: { cancellable: true, early_completion_available: false },
  links: {
    self: "/optimize/opt_1",
    events: "/optimize/opt_1/events",
    cancellation: "/optimize/opt_1/cancel",
    early_completion: "/optimize/opt_1/finish-now",
    schedule: null,
  },
  ...over,
});

const completedJob = baseJob({
  state: "completed",
  terminal: true,
  started_at: "2026-07-20T00:00:01+00:00",
  finished_at: "2026-07-20T00:01:00+00:00",
  queue_position: null,
  result: {
    outcome: "optimal",
    score: 42,
    solver_status: "OPTIMAL",
    termination_reason: "optimality_proven",
  },
  controls: { cancellable: false, early_completion_available: false },
  links: { ...baseJob().links, schedule: "/optimize/opt_1/xlsx" },
});

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    handler(String(url), init),
  ) as typeof fetch;
}

function memStorage(seed: string | null = null): SessionTransactionStorage {
  const values = new Map<string, string>();
  if (seed !== null) values.set(OPTIMIZE_SESSION_STORAGE_KEY, seed);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const okPrep: PrepareOptimizeSubmissionResult = {
  ok: true,
  prep: { yaml: "scenario: {}", peopleCount: 0, reverseMap: [], anonymized: false },
};

function readyStore() {
  useScenarioStore.setState({
    ...createEmptyScenarioUiState(),
    staff: [{ id: "p1" }],
    shifts: [{ id: "day" }],
    rangeStart: "2026-07-01",
    rangeEnd: "2026-07-14",
  });
}

function onlineInfo() {
  return {
    fetchInfo: async () => ({
      status: 200,
      body: {
        status: "ready",
        service_name: "nurse",
        api_version: "alpha",
        app_version: "1.0.0",
        deployment_id: "d",
        instance_id: "i",
        started_at: "2026-07-20T00:00:00+00:00",
        job_backend: "redis",
        job_store_id: "s",
      },
    }),
    clientVersion: "1.0.0",
  };
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useHotStore.getState().resetRunView();
  useScenarioStore.setState(createEmptyScenarioUiState());
});

afterEach(() => {
  cleanup();
  client.clear();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OptimizeAndExportScreen — gating", () => {
  it("blocks submission and shows required-data reasons until ready", async () => {
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      {
        wrapper,
      },
    );
    await waitFor(() => expect(screen.getByText("Online")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-readiness")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Complete the missing schedule configuration before optimizing.",
    );
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();
  });

  it("blocks submission when the backend is offline", async () => {
    readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={{
          fetchInfo: async () => ({
            status: 502,
            body: { status: "unavailable", reason: "backend_unreachable" },
          }),
          clientVersion: "1.0.0",
        }}
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByText("Offline")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Backend unavailable.",
    );
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();
  });

  it("warns on a frontend/backend version mismatch", async () => {
    readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={{ ...onlineInfo(), clientVersion: "9.9.9" }}
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(screen.getByTestId("optimize-version-mismatch")).toBeInTheDocument(),
    );
  });
});

describe("OptimizeAndExportScreen — terminal success path", () => {
  it("submits, downloads the restored artifact, cleans up, and emits observability", async () => {
    readyStore();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
      throw new Error(`unexpected request: ${u}`);
    });

    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const fetchXlsx = vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }));
    const observability = createOptimizeObservability({ sink: vi.fn(), now: () => 0 });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          storage: memStorage(),
          createOwnerId: () => "owner-1",
        }}
        terminalDeps={{ saveBlob, deleteJob, fetchXlsx }}
        observability={observability}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("optimize-completed-artifact")).toHaveTextContent(
        "Schedule optimized and downloaded successfully!",
      ),
    );
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), "schedule.xlsx");
    expect(deleteJob).toHaveBeenCalledWith("opt_1");
    expect(screen.getByTestId("optimize-download-again")).toBeInTheDocument();

    const kinds = observability.snapshot().map((event) => event.observation.kind);
    expect(kinds).toContain("job-duration");
    expect(kinds).toContain("cleanup");
  });
});

describe("OptimizeAndExportScreen — queue and cancellation observability", () => {
  it("emits queue depth and cancellation for a queued run", async () => {
    readyStore();
    const cancelledJob = baseJob({
      state: "cancelled",
      terminal: true,
      started_at: "2026-07-20T00:00:01+00:00",
      finished_at: "2026-07-20T00:01:00+00:00",
      queue_position: null,
      error: { code: "cancelled", message: "Optimization cancelled." },
      controls: { cancellable: false, early_completion_available: false },
    });
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (u.endsWith("/cancel")) return json(200, cancelledJob);
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, baseJob());
      throw new Error(`unexpected request: ${u}`);
    });
    const observability = createOptimizeObservability({ sink: vi.fn(), now: () => 0 });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage: memStorage(), createOwnerId: () => "o2" }}
        observability={observability}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("optimize-status")).toHaveTextContent("Queued, position 2"),
    );
    expect(observability.snapshot().map((e) => e.observation.kind)).toContain("queue-position");

    await userEvent.click(screen.getByTestId("optimize-cancel"));
    await waitFor(() =>
      expect(observability.snapshot().map((e) => e.observation.kind)).toContain("cancellation"),
    );
  });
});

describe("OptimizeAndExportScreen — recovery forget", () => {
  it("confirms and forgets an interrupted record", async () => {
    const provisional = buildProvisionalSession({
      ownerId: "owner-x",
      anonymized: false,
      peopleCount: 2,
      reverseMap: [],
      runOptions: {},
    });
    const storage = memStorage(JSON.stringify(provisional));
    const confirm = vi.fn(async () => true);
    routeFetch(() => json(200, baseJob()));

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        recoveryDeps={{ storage }}
        confirm={confirm}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("optimize-interrupted")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("optimize-forget"));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("optimize-interrupted")).not.toBeInTheDocument(),
    );
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("blocks submission while an interrupted record still requires Forget", async () => {
    readyStore();
    const provisional = buildProvisionalSession({
      ownerId: "owner-y",
      anonymized: false,
      peopleCount: 2,
      reverseMap: [],
      runOptions: {},
    });
    const storage = memStorage(JSON.stringify(provisional));
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        recoveryDeps={{ storage }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-interrupted")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();
    expect(screen.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Resolve the recovered run above",
    );
  });

  it("surfaces an unreadable record and blocks submission", async () => {
    readyStore();
    const storage = memStorage("{ not json");
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        recoveryDeps={{ storage }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-unreadable")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();
  });
});

describe("OptimizeAndExportScreen — terminal release", () => {
  const workerLostJob = baseJob({
    state: "failed",
    terminal: true,
    started_at: "2026-07-20T00:00:01+00:00",
    finished_at: "2026-07-20T00:01:00+00:00",
    queue_position: null,
    error: { code: "worker_lost", message: "Worker lost." },
    controls: { cancellable: false, early_completion_available: false },
  });
  const processTimeoutJob = baseJob({
    state: "failed",
    terminal: true,
    started_at: "2026-07-20T00:00:01+00:00",
    finished_at: "2026-07-20T00:01:00+00:00",
    queue_position: null,
    error: { code: "process_timeout", message: "Solver process timed out." },
    controls: { cancellable: false, early_completion_available: false },
  });
  const infeasibleJob = baseJob({
    state: "completed",
    terminal: true,
    started_at: "2026-07-20T00:00:01+00:00",
    finished_at: "2026-07-20T00:01:00+00:00",
    queue_position: null,
    result: {
      outcome: "infeasible",
      score: null,
      solver_status: "INFEASIBLE",
      termination_reason: "infeasibility_proven",
    },
    controls: { cancellable: false, early_completion_available: false },
  });
  const solverTimeoutJob = baseJob({
    state: "completed",
    terminal: true,
    started_at: "2026-07-20T00:00:01+00:00",
    finished_at: "2026-07-20T00:01:00+00:00",
    queue_position: null,
    result: {
      outcome: "feasible",
      score: 7,
      solver_status: "FEASIBLE",
      termination_reason: "solver_timeout",
    },
    controls: { cancellable: false, early_completion_available: false },
    links: { ...baseJob().links, schedule: "/optimize/opt_1/xlsx" },
  });

  function routeTerminal(job: JobResponse) {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job);
      throw new Error(`unexpected request: ${u}`);
    });
  }

  it("row 2: completed-no-artifact shows the reason and auto-cleans", async () => {
    readyStore();
    routeTerminal(infeasibleJob);
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o3" }}
        recoveryDeps={{ storage }}
        terminalDeps={{ deleteJob }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(screen.getByTestId("optimize-no-artifact")).toBeInTheDocument());
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("opt_1"));
  });

  it("U31 solver_timeout (feasible) downloads its artifact then cleans up", async () => {
    readyStore();
    routeTerminal(solverTimeoutJob);
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const fetchXlsx = vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }));
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o7" }}
        recoveryDeps={{ storage }}
        terminalDeps={{ saveBlob, deleteJob, fetchXlsx }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("optimize-completed-artifact")).toHaveTextContent(
        "downloaded successfully",
      ),
    );
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), "schedule.xlsx");
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("opt_1"));
  });

  it("row 3: process_timeout can be dismissed (cleaned) back to idle", async () => {
    readyStore();
    routeTerminal(processTimeoutJob);
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o4" }}
        recoveryDeps={{ storage }}
        terminalDeps={{ deleteJob }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("optimize-terminal-error")).toHaveTextContent("timed out"),
    );
    expect(screen.queryByTestId("optimize-resubmit")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("optimize-dismiss"));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("opt_1"));
    await waitFor(() => expect(screen.getByTestId("optimize-status")).toHaveTextContent("Idle"));
  });

  it("worker_lost: a failed cleanup does NOT resubmit and preserves the terminal result", async () => {
    readyStore();
    routeTerminal(workerLostJob);
    const deleteJob = vi.fn(
      async (): Promise<CleanupCallOutcome> => ({ status: "failed", reason: "409" }),
    );
    const confirm = vi.fn(async () => true);
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o5" }}
        recoveryDeps={{ storage }}
        terminalDeps={{ deleteJob }}
        confirm={confirm}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(screen.getByTestId("optimize-resubmit")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("optimize-resubmit"));
    // Cleanup failed → the worker_lost result is preserved and the cleanup surface appears.
    await waitFor(() => expect(screen.getByTestId("optimize-cleanup-failed")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-terminal-error")).toHaveTextContent("Worker lost.");
    expect(screen.getByTestId("optimize-status")).toHaveTextContent("Worker lost");

    // Abandon requires destructive confirmation, then frees the local slot.
    await userEvent.click(screen.getByTestId("optimize-cleanup-abandon"));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("optimize-cleanup-abandoned")).toBeInTheDocument(),
    );
  });

  it("cleans up via the exact code-first job-not-found DELETE (real classifier)", async () => {
    readyStore();
    const cancelledJob = baseJob({
      state: "cancelled",
      terminal: true,
      started_at: "2026-07-20T00:00:01+00:00",
      finished_at: "2026-07-20T00:01:00+00:00",
      queue_position: null,
      error: { code: "cancelled", message: "Optimization cancelled." },
      controls: { cancellable: false, early_completion_available: false },
    });
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (method === "DELETE")
        return json(404, { error: { code: "job_not_found", message: "gone" } });
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, cancelledJob);
      throw new Error(`unexpected request: ${u}`);
    });
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o6" }}
        recoveryDeps={{ storage }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(screen.getByTestId("optimize-dismiss")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("optimize-dismiss"));
    // Exact job-not-found is a confirmed cleanup → back to idle.
    await waitFor(() => expect(screen.getByTestId("optimize-status")).toHaveTextContent("Idle"));
  });
});

describe("OptimizeAndExportScreen — primary submit gate after cleanup failure", () => {
  // The primary Optimize submit must stay disabled while terminal cleanup is
  // cleaning or has failed to prove local record release — otherwise a click
  // dispatches `submit-started`, then T16q rediscovers the occupied/unproven
  // session slot and dispatches `submit-blocked`, overwriting the authoritative
  // terminal result/blob binding. It re-enables only after cleanup returns
  // `cleaned` or confirmed abandon proves the local slot was removed/absent.

  const completedWithArtifact = baseJob({
    state: "completed",
    terminal: true,
    started_at: "2026-07-20T00:00:01+00:00",
    finished_at: "2026-07-20T00:01:00+00:00",
    queue_position: null,
    result: {
      outcome: "feasible",
      score: 7,
      solver_status: "FEASIBLE",
      termination_reason: "solver_timeout",
    },
    controls: { cancellable: false, early_completion_available: false },
    links: { ...baseJob().links, schedule: "/optimize/opt_1/xlsx" },
  });

  function routeCompletedWithArtifact() {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedWithArtifact);
      throw new Error(`unexpected request: ${u}`);
    });
  }

  // A controllable storage lets the deleteJob seam mutate the local slot between
  // the server DELETE confirmation and the T16b local record inspection, so the
  // three local cleanup outcomes can be produced deterministically.
  type Mode = "normal" | "throw" | "mutate";
  function controllableStorage() {
    const values = new Map<string, string>();
    let mode: Mode = "normal";
    let foreignRaw: string | null = null;
    const storage: SessionTransactionStorage = {
      getItem: (key) => {
        if (mode === "throw") throw new Error("storage read failed");
        if (foreignRaw !== null && key === OPTIMIZE_SESSION_STORAGE_KEY) return foreignRaw;
        const raw = values.get(key) ?? null;
        if (mode === "mutate" && raw !== null) {
          // A different ownerId per read makes the bytes differ between inspect
          // and forget → `changed`.
          const parsed = JSON.parse(raw) as { ownerId: string };
          parsed.ownerId = `${parsed.ownerId}-${Math.random()}`;
          return JSON.stringify(parsed);
        }
        return raw;
      },
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
    return {
      storage,
      throwOnRead: () => {
        mode = "throw";
      },
      startMutating: () => {
        mode = "mutate";
      },
      stopMutating: () => {
        mode = "normal";
      },
      setForeign: (raw: string) => {
        foreignRaw = raw;
        mode = "normal";
      },
      clearForeign: () => {
        foreignRaw = null;
      },
    };
  }

  function foreignActiveRecordRaw(jobId: string): string {
    return JSON.stringify({
      schemaVersion: 1,
      ownerId: "foreign-owner",
      phase: "active",
      anonymized: false,
      runOptions: {},
      peopleCount: 0,
      reverseMap: [],
      jobId,
    });
  }

  for (const scenario of [
    {
      name: "not-current",
      apply: (s: ReturnType<typeof controllableStorage>) =>
        s.setForeign(foreignActiveRecordRaw("opt_FOREIGN")),
    },
    { name: "changed", apply: (s: ReturnType<typeof controllableStorage>) => s.startMutating() },
    { name: "unverified", apply: (s: ReturnType<typeof controllableStorage>) => s.throwOnRead() },
  ] as const) {
    it(`server-confirmed + local ${scenario.name} disables the primary submit and preserves the terminal result`, async () => {
      readyStore();
      routeCompletedWithArtifact();
      const control = controllableStorage();
      const saveBlob = vi.fn();
      const fetchXlsx = vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }));
      const deleteJob = vi.fn(async () => {
        // Server confirmed, then the local slot presents the failing outcome.
        scenario.apply(control);
        return { status: "confirmed" } as const;
      });

      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          controllerDeps={{
            prepare: () => okPrep,
            storage: control.storage,
            createOwnerId: () => `o-${scenario.name}`,
          }}
          recoveryDeps={{ storage: control.storage }}
          terminalDeps={{ saveBlob, deleteJob, fetchXlsx }}
        />,
        { wrapper },
      );

      await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
      await userEvent.click(screen.getByTestId("optimize-submit"));

      // Completed + downloaded, then auto-cleanup fails the local release.
      await waitFor(() =>
        expect(screen.getByTestId("optimize-completed-artifact")).toHaveTextContent(
          "downloaded successfully",
        ),
      );
      await waitFor(() =>
        expect(screen.getByTestId("optimize-cleanup-failed")).toBeInTheDocument(),
      );
      expect(deleteJob).toHaveBeenCalledWith("opt_1");

      // Primary submit must be disabled: clicking it would `submit-blocked`
      // overwrite the authoritative terminal view/blob binding.
      expect(screen.getByTestId("optimize-submit")).toBeDisabled();
      expect(screen.getByTestId("optimize-disabled-reason")).toHaveTextContent(
        "Release the finished run above (Retry cleanup or Abandon)",
      );

      // The terminal success and Download Again affordance must remain visible.
      expect(screen.getByTestId("optimize-download-again")).toBeInTheDocument();
    });
  }

  it("retry cleanup that proves local release re-enables the primary submit", async () => {
    readyStore();
    routeCompletedWithArtifact();
    const control = controllableStorage();
    const saveBlob = vi.fn();
    const fetchXlsx = vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }));
    let attempt = 0;
    const deleteJob = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        // First auto-cleanup: a foreign record lands in the slot (not-current).
        control.setForeign(foreignActiveRecordRaw("opt_FOREIGN"));
      } else {
        // Retry: foreign record cleared, the original active record is restorable.
        control.clearForeign();
      }
      return { status: "confirmed" } as const;
    });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          storage: control.storage,
          createOwnerId: () => "o-retry",
        }}
        recoveryDeps={{ storage: control.storage }}
        terminalDeps={{ saveBlob, deleteJob, fetchXlsx }}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(screen.getByTestId("optimize-cleanup-failed")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();

    // Retry cleanup: the local record now matches, so recovery.cleanup returns removed.
    await userEvent.click(screen.getByTestId("optimize-cleanup-retry"));
    await waitFor(() =>
      expect(screen.queryByTestId("optimize-cleanup-failed")).not.toBeInTheDocument(),
    );

    // Primary submit re-enabled — only a proven release may start a new run.
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
  });

  it("confirmed abandon that proves local release re-enables the primary submit", async () => {
    readyStore();
    routeCompletedWithArtifact();
    const storage = memStorage();
    const saveBlob = vi.fn();
    const fetchXlsx = vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }));
    // Server DELETE fails — abandon is the only release path.
    const deleteJob = vi.fn(
      async (): Promise<CleanupCallOutcome> => ({ status: "failed", reason: "delete-http-500" }),
    );
    const confirm = vi.fn(async () => true);

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o-abandon" }}
        recoveryDeps={{ storage }}
        terminalDeps={{ saveBlob, deleteJob, fetchXlsx }}
        confirm={confirm}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(screen.getByTestId("optimize-cleanup-failed")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();

    // Abandon requires destructive confirmation, then frees the local slot. The
    // active record persisted by the submission is still present and matches, so
    // recovery.cleanup returns removed → abandonCleanup resolves "abandoned".
    await userEvent.click(screen.getByTestId("optimize-cleanup-abandon"));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("optimize-cleanup-abandoned")).toBeInTheDocument(),
    );

    // Primary submit re-enabled — only a proven release may start a new run.
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
  });
});
