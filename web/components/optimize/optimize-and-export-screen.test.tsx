// @vitest-environment jsdom
//
// T16e screen integration: the real controller + recovery + terminal orchestration
// wired through the screen, with mocked transport. Proves the readiness/version
// gates, the end-to-end submit → download → cleanup terminal path with bounded
// observability, and the hidden pre-submit retirement behind the Optimize button.

// This file deliberately runs WITHOUT IndexedDB (no `fake-indexeddb`), which is a
// real supported browser condition: the write-ahead snapshot degrades, roster
// capture reports `unavailable`, and the terminal download/cleanup chain behaves
// exactly as it did before capture existed. The production capture pipeline with
// storage present is proved in `optimize-capture-composition.test.tsx`.
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
  createOptimizeObservability,
  OPTIMIZE_SESSION_STORAGE_KEY,
  resetRosterCaptureGate,
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
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
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
  // The capture gate is app-lifetime (module-owned) so it survives route
  // unmount/remount in production. These tests all drive job `opt_1`, so without
  // this reset one test's cleanup token would be visible to the next and capture
  // would be skipped for the wrong reason.
  resetRosterCaptureGate();

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
      "Complete the missing schedule configuration before optimising.",
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
    // The idle-panel CTA mirrors the same gate: it is NOT offered while a run is
    // blocked, so it cannot bypass the submission guard (cold-review P1).
    expect(screen.getByTestId("optimize-idle")).toBeInTheDocument();
    expect(screen.queryByTestId("optimize-start")).not.toBeInTheDocument();
  });

  it("offers the idle-panel CTA only when a run is permitted", async () => {
    readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    // Ready + online + idle → the idle empty state offers the in-panel Optimize CTA.
    expect(screen.getByTestId("optimize-idle")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-start")).toBeInTheDocument();
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
        "Schedule optimised and downloaded successfully!",
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
      error: { code: "cancelled", message: "Optimisation cancelled." },
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

  it("row 2: infeasible shows the dedicated panel and auto-cleans", async () => {
    readyStore();
    routeTerminal(infeasibleJob);
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o3" }}
        terminalDeps={{ deleteJob }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    // B2-1: infeasible renders its dedicated panel (heading + verdict + CTAs), not the
    // generic no-artifact callout.
    await waitFor(() => expect(screen.getByTestId("optimize-infeasible")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-infeasible")).toHaveTextContent("infeasibility_proven");
    expect(screen.getByTestId("optimize-adjust-rules")).toHaveAttribute("href", "/rules");
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

  // G6.2a RETIRED DISMISS AND RESUBMIT. Both existed because a terminal run
  // OCCUPIED the single session record: the user needed a way to release it, and a
  // second run had to wait for that release. Records are owner-keyed now, so a
  // terminal run occupies nothing and a second run is the exact `Optimize` action.
  //
  // These three cases previously drove those buttons. They now prove the property
  // that replaced them: the result is reported honestly, nothing is offered to
  // press, and the primary action is live.
  it.each([
    ["process_timeout", () => processTimeoutJob, "timed out"],
    ["worker_lost", () => workerLostJob, "Worker lost."],
  ])("row 3: a %s run reports honestly and leaves Optimize live", async (_label, job, message) => {
    readyStore();
    routeTerminal(job());
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o4" }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("optimize-terminal-error")).toHaveTextContent(message),
    );

    for (const retired of [
      "optimize-resubmit",
      "optimize-dismiss",
      "optimize-try-again",
      "optimize-cleanup-retry",
      "optimize-cleanup-abandon",
      "confirm-dialog-confirm",
    ]) {
      expect(screen.queryByTestId(retired), retired).not.toBeInTheDocument();
    }
    // The one action, live, with no explanation of a previous run beside it.
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    expect(screen.queryByTestId("optimize-disabled-reason")).not.toBeInTheDocument();
  });

  it("a FAILED cleanup blocks nothing: the result stands and Optimize stays live", async () => {
    readyStore();
    routeTerminal(solverTimeoutJob);
    // The DELETE never confirms, so cleanup can never settle. Under the retired
    // model that state disabled the button and demanded a Retry.
    const deleteJob = vi.fn(
      async (): Promise<CleanupCallOutcome> => ({ status: "failed", reason: "409" }),
    );
    const fetchXlsx = vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }));
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o5" }}
        terminalDeps={{ deleteJob, fetchXlsx, saveBlob: vi.fn() }}
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
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("opt_1"));

    // The successful result is preserved...
    expect(screen.getByTestId("optimize-completed-artifact")).toBeInTheDocument();
    // ...cleanup is invisible...
    expect(screen.queryByTestId("optimize-cleanup-failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-cleanup-retry")).not.toBeInTheDocument();
    // ...and it is not in the next run's way.
    expect(screen.getByTestId("optimize-submit")).toBeEnabled();
    expect(screen.queryByTestId("optimize-disabled-reason")).not.toBeInTheDocument();
  });

  it("cleans up via the exact code-first job-not-found DELETE (real classifier)", async () => {
    // The classifier still matters; what changed is who reaches it. It used to be
    // Dismiss on a cancelled run — a user action. It is now the terminal auto-chain
    // on a COMPLETED one, which is the only path that holds a capture authority and
    // may therefore destroy the server's sole artifact.
    readyStore();
    let deletes = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (method === "DELETE") {
        deletes += 1;
        return json(404, { error: { code: "job_not_found", message: "gone" } });
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (u.endsWith("/xlsx")) return new Response("x", { status: 200 });
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, solverTimeoutJob);
      throw new Error(`unexpected request: ${u}`);
    });
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o6" }}
        terminalDeps={{
          fetchXlsx: async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }),
          saveBlob: vi.fn(),
        }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    // An exact job-not-found is a CONFIRMED cleanup, so the chain settles rather
    // than parking on a retry surface that no longer exists.
    await waitFor(() => expect(deletes).toBeGreaterThan(0));
    expect(screen.queryByTestId("optimize-cleanup-failed")).not.toBeInTheDocument();
  });
});

describe("OptimizeAndExportScreen — G4 dedicated /roster route", () => {
  // G4 closure — the full F4 viewer was removed from this screen. The
  // dedicated /roster page owns it; this screen surfaces the prototype's
  // `Open & adjust roster` CTA only on a completed run whose capture
  // committed a loadable candidate. No embedded viewer, no duplicate
  // empty-state surface, no candidate Load/Dismiss here.

  it("never renders the embedded F4 RosterSection anywhere on the screen", () => {
    // The old testids are the only honest witness: a future re-embed fails
    // here at the seam, not as a confusing duplicate on the rendered page.
    readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      { wrapper },
    );
    expect(screen.queryByTestId("roster-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("roster-section-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("roster-section-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("roster-section-unavailable")).not.toBeInTheDocument();
  });

  it("the CTA points at /roster through the shared guarded boundary", async () => {
    // A captured capture gate is the only way the CTA can render — but in
    // this IndexedDB-free file the gate never settles to "committed", so
    // we drive the CTA directly through the panel seam with `loadableRoster`.
    readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
        // The capture seam stays at its production default; the panel
        // receives the loadable flag through the same `loadableRoster` prop
        // the screen computes for the real capture state. We exercise the
        // rendered href here, the loadable gating is proved in
        // run-status-panel.test.tsx and the production capture composition.
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    // No CTA without a loadable capture state — the in-memory gate is idle
    // for every job on a fresh process, and that is the honest answer.
    expect(screen.queryByTestId("optimize-open-roster")).not.toBeInTheDocument();
  });
});
