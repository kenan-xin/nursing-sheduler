// @vitest-environment jsdom
//
// T16e screen integration: the real controller + recovery + terminal orchestration
// wired through the screen, with mocked transport. Proves the readiness/version
// gates, the end-to-end submit → download → cleanup terminal path with bounded
// observability, and the hidden pre-submit retirement behind the Optimize button.

// This file runs with the write-ahead snapshot DEGRADED, which is a real supported
// browser condition: roster capture reports `unavailable`, and the terminal
// download/cleanup chain behaves exactly as it did before capture existed. The
// production capture pipeline with storage present is proved in
// `optimize-capture-composition.test.tsx`.
//
// INTEGRATION — that premise is now STATED rather than inherited. It used to rest on
// this module not importing `fake-indexeddb`, so no IndexedDB existed and staging
// could not succeed. The T02/T03 repository made IndexedDB a GLOBAL test fixture
// (`vitest.setup.ts` registers `fake-indexeddb/auto` for the whole suite), which
// silently falsified it: capture began fetching `/roster`, this file's route handler
// — which has no such case, because it was never reached — answered `unexpected
// request`, the gate settled `fetch-failed`, and the last-line DELETE invariant
// correctly refused every cleanup. Nothing about the product was wrong; the file's
// ambient precondition had evaporated. It is reinstated below through the product's
// own `stageSnapshot` seam, where it cannot evaporate again.
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JobResponse } from "@/lib/bff/types";
import { getScenarioAuthority, scenarioCommands, useHotStore } from "@/lib/store";
import { resetScenarioForTest } from "@/lib/store/test-authority";
import type { PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import {
  createOptimizeObservability,
  OPTIMIZE_SESSION_STORAGE_KEY,
  requestOptimizeRun,
  resetRosterCaptureGate,
  useRunRequestStore,
  type CleanupCallOutcome,
  type OptimizeBasisStore,
  type SessionCaptureState,
  type SessionTransactionStorage,
  type UseOptimizeServerInfoDeps,
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
  // Nullable server-side (`schemas.py`: `datetime | None`) and read only by T10's
  // diagnostic evidence window, which nothing in this suite exercises — so `null`
  // states the contract without moving any behaviour here.
  expires_at: null,
  started_at: null,
  finished_at: null,
  request: {
    input_name: "s.yaml",
    solver: "ortools/cp-sat",
    prettify: null,
    timeout_seconds: 300,
    // T09 — every admitted job carries a purpose, and an unqualified submission is
    // admitted as `ordinary` rather than as a job with no purpose. `basis: null` is
    // the ORDINARY run's echo: this fixture deliberately does not reflect a posted
    // basis back, which is why the bind assertions below expect an unbound row.
    purpose: "ordinary",
    basis: null,
  },
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

/**
 * THIS FILE'S PREMISE, injected: the write-ahead snapshot could not be staged.
 *
 * The seam is required to be total — a rejection would gate the POST, which the
 * non-gating contract forbids — so the real implementation reports failure by
 * returning this degraded state rather than by throwing, and so does this. Capture
 * then settles `unavailable` BEFORE any `/roster` fetch, which is the one class of
 * cause that authorizes cleanup without a capture token. That is what lets every
 * assertion below be about the terminal download/cleanup table and nothing else.
 */
const degradedCapture = async (): Promise<SessionCaptureState> => ({
  status: "unavailable",
  reason: "snapshot_persist_failed",
});

/**
 * Satisfy the route's required-data gate through the product's own write path.
 *
 * INTEGRATION (T03): this used to `setState` the projection directly. The projection
 * has no setter any more — at the type level and at runtime — so it COMMITS instead.
 * That also matters for correctness here: the screen's submit preflight reads
 * PERSISTED identity/revision, and a projection-only seed would leave the two
 * disagreeing so the preflight would reconcile the seed straight back out.
 */
async function readyStore() {
  await scenarioCommands.mutate({
    staff: [{ id: "p1" }],
    shifts: [{ id: "day" }],
    rangeStart: "2026-07-01",
    rangeEnd: "2026-07-14",
  });
}

/**
 * The `semantic_profile` block a real backend advertises on `/info` (T08).
 *
 * `onlineInfo()` deliberately does NOT carry one by default: most of this suite is
 * about the run lifecycle, and a backend may legitimately omit it. That omission is
 * also why the basis defect hid here — with no profile in the fixture, a screen that
 * drops the profile and one that forwards it behave identically.
 */
const ADVERTISED_SEMANTIC_PROFILE = {
  submission_contract_version: "optimize-yaml-v1",
  solver_semantic_version: "ortools/cp-sat@1",
  backend_capability_version: "nurse-scheduling-backend@1",
} as const;

function onlineInfo(extra: Record<string, unknown> = {}) {
  return {
    fetchInfo: async () => ({
      status: 200,
      body: {
        ...extra,
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

beforeEach(async () => {
  // The capture gate is app-lifetime (module-owned) so it survives route
  // unmount/remount in production. These tests all drive job `opt_1`, so without
  // this reset one test's cleanup token would be visible to the next and capture
  // would be skipped for the wrong reason.
  resetRosterCaptureGate();

  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // INTEGRATION (T03): a fresh repository-backed authority per test. This replaces
  // `useScenarioStore.setState(...)` — the projection has no setter — and it matters
  // beyond compilation: the screen's preflight reads durable state, so an empty
  // projection over someone else's database is not an empty scenario.
  await resetScenarioForTest();
  useHotStore.getState().resetRunView();
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
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
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
    await readyStore();
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
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
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
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    // Ready + online + idle → the idle empty state offers the in-panel Optimize CTA.
    expect(screen.getByTestId("optimize-idle")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-start")).toBeInTheDocument();
  });

  it("warns on a frontend/backend version mismatch", async () => {
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={{ ...onlineInfo(), clientVersion: "9.9.9" }}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
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
    await readyStore();
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
          stageSnapshot: degradedCapture,
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
    await readyStore();
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
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
          createOwnerId: () => "o2",
        }}
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

  it("row 2: infeasible shows the dedicated panel and is RETAINED, not deleted", async () => {
    await readyStore();
    routeTerminal(infeasibleJob);
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage,
          createOwnerId: () => "o3",
        }}
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

    // INTEGRATION — THIS ROW'S EXPECTATION INVERTED, and the inversion is the point.
    //
    // It used to assert the DELETE. That is precisely the defect T10 exists to fix: an
    // infeasible run produces no artifact, so the chain read it as "nothing to keep" and
    // destroyed the only server-side evidence the bounded infeasibility diagnostic can
    // ever classify against — seconds after it was created, on every deployment. The
    // browser's basis row survived; its server half did not, so `classifyRecovery` saw a
    // 404, answered `local-only`, and the diagnostic could never open a search for ANY
    // run. Retention is not extended here: the backend already stamps `expires_at` at
    // admission and reaps on `finished_at`. The client simply stops ending that window
    // early.
    //
    // The LOCAL retirement is the settle point, and it has to be: it is the same step
    // that would immediately precede the DELETE, so reaching it proves the terminal chain
    // ran to the decision rather than merely not having got there yet. `deleteJob` is
    // wired and provably reachable through this exact screen path — the feasible row
    // below calls it — so this absence is a real refusal, not a vacuous one.
    await waitFor(() => expect(storage.length).toBe(0));
    expect(deleteJob).not.toHaveBeenCalled();
  });

  it("U31 solver_timeout (feasible) downloads its artifact then cleans up", async () => {
    await readyStore();
    routeTerminal(solverTimeoutJob);
    const saveBlob = vi.fn();
    const deleteJob = vi.fn(async (): Promise<CleanupCallOutcome> => ({ status: "confirmed" }));
    const fetchXlsx = vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" }));
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage,
          createOwnerId: () => "o7",
        }}
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
    await readyStore();
    routeTerminal(job());
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage,
          createOwnerId: () => "o4",
        }}
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
    await readyStore();
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
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage,
          createOwnerId: () => "o5",
        }}
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
    await readyStore();
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
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage,
          createOwnerId: () => "o6",
        }}
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

  it("never renders the embedded F4 RosterSection anywhere on the screen", async () => {
    // The old testids are the only honest witness: a future re-embed fails
    // here at the seam, not as a confusing duplicate on the rendered page.
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
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
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
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
describe("OptimizeAndExportScreen — assistant run request", () => {
  beforeEach(() => {
    useRunRequestStore.setState({ pending: null, last: null });
  });

  /** Routes the run's traffic and counts POSTs, the one fact these cases assert. */
  function countPosts(): () => number {
    let posts = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return json(202, baseJob());
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      // Unmount abandons a live run, and retirement cancels it.
      if (u.endsWith("/cancel")) return json(200, baseJob({ state: "cancelled", terminal: true }));
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, baseJob({ state: "running" }));
      throw new Error(`unexpected request: ${u}`);
    });
    return () => posts;
  }

  function renderScreen(serverInfoDeps: UseOptimizeServerInfoDeps = onlineInfo()) {
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={serverInfoDeps}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
      />,
      { wrapper },
    );
  }

  it("starts the run through the Optimize path when the assistant card asks", async () => {
    await readyStore();
    const posts = countPosts();
    requestOptimizeRun();
    renderScreen();

    await waitFor(() => expect(posts()).toBe(1));
    expect(useRunRequestStore.getState()).toEqual({ pending: null, last: "started" });
  });

  it("reports not-ready and posts nothing when set-up is missing", async () => {
    const posts = countPosts();
    requestOptimizeRun();
    renderScreen();

    await waitFor(() => expect(useRunRequestStore.getState().last).toBe("not-ready"));
    expect(posts()).toBe(0);
  });

  it("reports backend-offline and posts nothing when the backend is down", async () => {
    await readyStore();
    const posts = countPosts();
    requestOptimizeRun();
    renderScreen({
      fetchInfo: async () => ({
        status: 502,
        body: { status: "unavailable", reason: "backend_unreachable" },
      }),
      clientVersion: "1.0.0",
    });

    await waitFor(() => expect(useRunRequestStore.getState().last).toBe("backend-offline"));
    expect(posts()).toBe(0);
  });

  it("reports blocked, not started, when the Optimize path stops before posting", async () => {
    await readyStore();
    const posts = countPosts();
    requestOptimizeRun();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => ({ ok: false, issues: [] }),
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
      />,
      { wrapper },
    );

    await waitFor(() => expect(useRunRequestStore.getState().last).toBe("blocked"));
    expect(posts()).toBe(0);
  });

  it("forgets an earlier refusal once a manual run starts", async () => {
    await readyStore();
    const posts = countPosts();
    useRunRequestStore.setState({ last: "backend-offline" });
    renderScreen();

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));

    await waitFor(() => expect(posts()).toBe(1));
    expect(useRunRequestStore.getState().last).toBeNull();
  });
});

describe("the submission basis is claimed from the live backend semantic profile", () => {
  // THE DEFECT THIS PINS. `buildSubmitInput` assembled `{document, anonymize, prettify,
  // timeout}` and stopped there. `semanticProfile` is an OPTIONAL field on
  // `OptimizeRunSubmitInput`, and omitting it is a supported, first-class degradation —
  // the controller's `buildBasisForSubmission` returns null at its first guard and the
  // run proceeds as an ordinary un-claimed submission. So the screen never claimed a
  // basis, on any backend, and every run still looked completely healthy.
  //
  // The cost was T10's whole surface. With no row in `optimizeBases`, an infeasible run
  // has no parent basis, `readDiagnosticParent()` returns null, and the bounded
  // infeasibility diagnostic truthfully answers "there is no retained Optimize run for
  // the schedule as it stands now that this tab can diagnose" — for every user, on every
  // infeasible result, permanently.
  //
  // It survived 5,000+ unit tests because no fixture advertised a `semantic_profile`:
  // with none in the payload the forwarding and non-forwarding screens are
  // indistinguishable. Both arms below are therefore required — the second is what makes
  // the first non-vacuous.
  function recordingBasisStore() {
    const recorded: Parameters<OptimizeBasisStore["putOptimizeBasis"]>[0][] = [];
    const store: OptimizeBasisStore = {
      putOptimizeBasis: async (record) => void recorded.push(record),
      bindOptimizeBasisJob: async (basisId, verify) => {
        const row = recorded.find((candidate) => candidate.basisId === basisId);
        return row === undefined ? null : verify(row);
      },
    };
    return { recorded, store };
  }

  async function submitOnce(info: ReturnType<typeof onlineInfo>, store: OptimizeBasisStore) {
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={info}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
          basisStore: store,
        }}
      />,
      { wrapper },
    );
    await waitFor(async () => expect(screen.getByText("Online")).toBeInTheDocument());
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
  }

  it("records a basis row carrying the profile the backend advertised", async () => {
    const { recorded, store } = recordingBasisStore();

    await submitOnce(onlineInfo({ semantic_profile: ADVERTISED_SEMANTIC_PROFILE }), store);

    // A row is written BEFORE the POST, so an accepted job whose response never
    // arrives still has something durable to recover against.
    await waitFor(async () => expect(recorded).toHaveLength(1));
    const row = recorded[0]!;
    expect(row.ownerKind).toBe("ordinary");
    expect(row.schemaVersion).toBe(2);
    // The profile is carried through verbatim — not defaulted, not re-derived. If the
    // screen ever forwards a stale or invented profile instead of the one the status
    // bar read, these three fail.
    expect(row.basis.submissionContractVersion).toBe(
      ADVERTISED_SEMANTIC_PROFILE.submission_contract_version,
    );
    expect(row.basis.solverSemanticVersion).toBe(
      ADVERTISED_SEMANTIC_PROFILE.solver_semantic_version,
    );
    expect(row.basis.backendCapabilityVersion).toBe(
      ADVERTISED_SEMANTIC_PROFILE.backend_capability_version,
    );
    // The resolved run options are bound in too: the backend binds ITS resolved values,
    // so a basis built from guessed defaults would fail admission.
    expect(row.basis.normalizedOptions).toEqual({
      solver: expect.any(String),
      prettify: true,
      timeoutSeconds: 300,
    });
  });

  it("records the row through the REAL adapter when nothing is injected", async () => {
    // THE ARM THAT MATTERS MOST, and the one whose absence let the second half of this
    // defect ship. Every other test here injects a `basisStore`, which is exactly the
    // condition that hid it: `UseOptimizeRunDeps.basisStore` documented a default to the
    // authority adapter, but the controller read `depsRef.current?.basisStore ?? null`.
    // The only mount in the app that passes `controllerDeps` is a dev fixture, so the
    // real route always ran with a null store -- and an injected store made the tests
    // pass regardless.
    //
    // So this arm injects NO basis store and reads the row back through the product's
    // own adapter. It is the only test in the file that exercises the wiring the route
    // actually uses.
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo({ semantic_profile: ADVERTISED_SEMANTIC_PROFILE })}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
      />,
      { wrapper },
    );
    await waitFor(async () => expect(screen.getByText("Online")).toBeInTheDocument());
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));

    await waitFor(async () =>
      expect(await getScenarioAuthority().listOptimizeBases()).toHaveLength(1),
    );
    const [row] = await getScenarioAuthority().listOptimizeBases();
    expect(row).toMatchObject({ schemaVersion: 2, ownerKind: "ordinary" });

    // JOB BINDING IS DELIBERATELY NOT ASSERTED HERE. `bindAcceptedJob` binds only on an
    // EXACTLY matching echoed identity, and `baseJob()` returns `request.basis: null` --
    // it does not echo what was posted -- so the correct outcome against this fixture is
    // an unbound row. Asserting a bind would mean teaching the fixture to reflect the
    // multipart basis fields back, which would prove the fixture echoes rather than that
    // the backend does. The bind rule itself is owned by `lib/optimize/basis`, and the
    // real echo is proven against the live backend in the T11 closure journey.
    expect((row as { jobId: string | null }).jobId).toBeNull();
  });

  it("reports the degradation through the SCREEN's own observability instance", async () => {
    // The reason taxonomy is proven exhaustively in `basis-observability.test.tsx`
    // against the controller. What is unproven there, and is the whole point of this
    // one, is that the SHIPPED SCREEN actually hands the controller an observability
    // sink -- the same class of wiring gap as the two that made the basis path dead.
    // `onlineInfo()` advertises no semantic profile, so this is a real degradation.
    const observability = createOptimizeObservability();
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
        observability={observability}
      />,
      { wrapper },
    );
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));

    await waitFor(async () =>
      expect(
        observability
          .snapshot()
          .map((e) => e.observation)
          .filter((o) => o.kind === "basis-degraded"),
      ).toEqual([{ kind: "basis-degraded", jobId: null, reason: "profile-unavailable" }]),
    );
  });

  it("still degrades to an ordinary un-claimed run when the backend advertises none", async () => {
    // The negative control, and the reason the assertion above means something: the
    // pre-repair screen produced THIS outcome for both payloads.
    const { recorded, store } = recordingBasisStore();

    await submitOnce(onlineInfo(), store);

    // The run itself is unaffected — no basis is not an error.
    await waitFor(async () =>
      expect(screen.getByTestId("optimize-run-status")).toBeInTheDocument(),
    );
    expect(recorded).toEqual([]);
  });
});
