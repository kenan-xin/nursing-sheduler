// @vitest-environment jsdom
//
// T16e screen integration: the real controller + recovery + terminal orchestration
// wired through the screen, with mocked transport. Proves the readiness/version
// gates, the end-to-end submit → download → cleanup terminal path with bounded
// observability, and the confirmed Forget of an interrupted recovery record.

import "fake-indexeddb/auto";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JobResponse } from "@/lib/bff/types";
import { getScenarioAuthority, scenarioCommands, useHotStore } from "@/lib/store";
import {
  drainScenarioCommands,
  installTestAuthority,
  resetScenarioForTest,
} from "@/lib/store/test-authority";
import { toast } from "sonner";

import type { CanonicalScenarioDocument, PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import {
  buildProvisionalSession,
  createOptimizeObservability,
  OPTIMIZE_SESSION_STORAGE_KEY,
  type CleanupCallOutcome,
  type OptimizeBasisStore,
  type SessionTransactionStorage,
} from "@/lib/optimize";
import { OptimizeAndExportScreen } from "./optimize-and-export-screen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/optimize-and-export",
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

const originalFetch = globalThis.fetch;
let client: QueryClient;
/** The installed test authority — exposed so a peer tab can share its database. */
let authorityDbName: string;

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
  expires_at: "2026-07-21T00:00:00+00:00",
  request: {
    input_name: "s.yaml",
    solver: "ortools/cp-sat",
    prettify: null,
    timeout_seconds: 300,
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
  };
}

const okPrep: PrepareOptimizeSubmissionResult = {
  ok: true,
  prep: { yaml: "scenario: {}", peopleCount: 0, reverseMap: [], anonymized: false },
};

/**
 * Satisfy the route's required-data gate through the product's own write path.
 *
 * T03: this used to `setState` the projection directly. It commits now, because
 * the screen's submit preflight reads PERSISTED identity/revision — a
 * projection-only seed would leave the two disagreeing and the preflight would
 * reconcile the seed straight back out.
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
 * `onlineInfo()` below deliberately does NOT carry one, because most of this suite is
 * about the run lifecycle rather than the basis, and a backend may legitimately omit
 * it. That omission is also exactly why this whole file missed the defect the last
 * test in it now guards: with no profile in the fixture, a screen that drops the
 * profile and a screen that forwards it behave identically.
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
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A fresh repository-backed authority per test: the screen's preflight reads
  // durable state, so an empty projection over someone else's database would not
  // be an empty scenario.
  const harness = await resetScenarioForTest();
  authorityDbName = harness.databaseName;
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
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      {
        wrapper,
      },
    );
    await waitFor(async () => expect(screen.getByText("Online")).toBeInTheDocument());
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
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      { wrapper },
    );
    await waitFor(async () => expect(screen.getByText("Offline")).toBeInTheDocument());
    expect(screen.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Backend unavailable.",
    );
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();
    // The idle-panel CTA mirrors the same gate: it is NOT offered while a run is
    // blocked, so it cannot bypass the submission guard (cold-review P1).
    expect(screen.getByTestId("optimize-idle")).toBeInTheDocument();
    expect(screen.queryByTestId("optimize-start")).not.toBeInTheDocument();
  });

  it("submits the COMMITTED document, not whichever frame the click landed on", async () => {
    // T03's authoritative preflight. A durable edit issued a moment before Optimize
    // is clicked is still in the command queue: pre-cutover the payload was read
    // straight off the projection, so that edit would have been silently left out
    // of the run. The preflight drains first, so the submitted document is the one
    // that actually committed.
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    let submitted: CanonicalScenarioDocument | null = null;
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: (document: CanonicalScenarioDocument) => {
            submitted = document;
            return okPrep;
          },
          storage: memStorage(),
        }}
      />,
      { wrapper },
    );
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());

    // Issued WITHOUT awaiting — exactly the shape of an Adjust blur or a paint
    // mouse-up landing in the same tick as the click.
    void scenarioCommands.mutate({ staff: [{ id: "p1" }, { id: "p2" }] });
    await userEvent.click(screen.getByTestId("optimize-submit"));

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted!.people.items.map((person: { id: unknown }) => person.id)).toEqual([
      "p1",
      "p2",
    ]);
    // ...and the run itself is unchanged: same payload shape, same outcome path.
    await drainScenarioCommands();
  });

  it("offers the idle-panel CTA only when a run is permitted", async () => {
    await readyStore();
    routeFetch(() => json(200, baseJob()));
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      { wrapper },
    );
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
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
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(screen.getByTestId("optimize-version-mismatch")).toBeInTheDocument(),
    );
  });

  it("refuses submission after a peer takeover that wrote NO content, even with a missed hint", async () => {
    // T03F1 round-2, finding 1: the final pre-submit gate must read the PERSISTED
    // lease, not the projected `ownership`. A peer that takes over without writing
    // content leaves the envelope revision unchanged; if its BroadcastChannel hint
    // is delayed or missed, the projection still believes it is the owner. The
    // persisted lease disagrees, and the preflight must catch it — zero server
    // submission and a truthful UI refusal.
    await readyStore();
    const fetchHandler = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(200, baseJob()),
    );
    routeFetch(fetchHandler);
    let submitted: CanonicalScenarioDocument | null = null;
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: (document: CanonicalScenarioDocument) => {
            submitted = document;
            return okPrep;
          },
          storage: memStorage(),
        }}
      />,
      { wrapper },
    );
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());

    // A peer tab seizes the lease. It writes NOTHING — the envelope revision is
    // unchanged — so only the lease row moved. Its hint is NOT delivered (missed /
    // suppressed BroadcastChannel), so the projection still says "owner".
    const peer = await installTestAuthority({ databaseName: authorityDbName, install: false });
    await peer.authority.initialize();
    await peer.authority.takeover();

    // The projection is stale: the button is still enabled because the reactive
    // gate still reads the projected ownership.
    await userEvent.click(screen.getByTestId("optimize-submit"));

    // Zero server submissions: the POST handler was never reached.
    expect(submitted).toBeNull();
    const posts = fetchHandler.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/api/optimize") && (init?.method ?? "GET") === "POST",
    );
    expect(posts).toHaveLength(0);
    // Truthful UI refusal: the preflight surfaced the read-only message.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/being edited in another tab/i),
      );
    });
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
          storage: memStorage(),
          createOwnerId: () => "owner-1",
        }}
        terminalDeps={{ saveBlob, deleteJob, fetchXlsx }}
        observability={observability}
      />,
      { wrapper },
    );

    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
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
        controllerDeps={{ prepare: () => okPrep, storage: memStorage(), createOwnerId: () => "o2" }}
        observability={observability}
      />,
      { wrapper },
    );

    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
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

    await waitFor(async () =>
      expect(screen.getByTestId("optimize-interrupted")).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByTestId("optimize-forget"));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("optimize-interrupted")).not.toBeInTheDocument(),
    );
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("blocks submission while an interrupted record still requires Forget", async () => {
    await readyStore();
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
    await waitFor(async () =>
      expect(screen.getByTestId("optimize-interrupted")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();
    expect(screen.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Resolve the recovered run above",
    );
  });

  it("surfaces an unreadable record and blocks submission", async () => {
    await readyStore();
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
    await waitFor(async () =>
      expect(screen.getByTestId("optimize-unreadable")).toBeInTheDocument(),
    );
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

  it("row 2: infeasible shows the dedicated panel and RETAINS its server record", async () => {
    await readyStore();
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
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    // B2-1: infeasible renders its dedicated panel (heading + verdict + CTAs), not the
    // generic no-artifact callout.
    await waitFor(async () =>
      expect(screen.getByTestId("optimize-infeasible")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("optimize-infeasible")).toHaveTextContent("infeasibility_proven");
    expect(screen.getByTestId("optimize-adjust-rules")).toHaveAttribute("href", "/rules");

    // WHAT CHANGED, AND WHY THIS ROW HAD TO. This asserted `deleteJob` WAS called: an
    // infeasible run has no artifact, so the terminal chain treated it as nothing to
    // keep and deleted it the instant it settled.
    //
    // That deletion is what made T10's bounded diagnostic unreachable for every run on
    // every deployment. `classifyRecovery` asks the server for the parent job, got a
    // 404, answered `local-only`, and `mayOpenSearch` refused -- while the browser's
    // basis row sat there intact. The row now asserts the opposite, because an
    // infeasible run's server record IS the evidence the diagnostic exists to read.
    //
    // Retention is not extended: the backend already stamps `expires_at` at admission
    // and reaps on `finished_at`, and `classifyRecovery` independently refuses evidence
    // past that expiry. Only the client's premature delete is gone. The local slot is
    // still released, so the next run is never blocked -- which is what the submit
    // button being enabled below proves.
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
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
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o7" }}
        recoveryDeps={{ storage }}
        terminalDeps={{ saveBlob, deleteJob, fetchXlsx }}
      />,
      { wrapper },
    );
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("optimize-completed-artifact")).toHaveTextContent(
        "downloaded successfully",
      ),
    );
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), "schedule.xlsx");
    await waitFor(async () => expect(deleteJob).toHaveBeenCalledWith("opt_1"));
  });

  it("row 3: process_timeout can be dismissed (cleaned) back to idle", async () => {
    await readyStore();
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
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("optimize-terminal-error")).toHaveTextContent("timed out"),
    );
    expect(screen.queryByTestId("optimize-resubmit")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("optimize-dismiss"));
    await waitFor(async () => expect(deleteJob).toHaveBeenCalledWith("opt_1"));
    // Dismissed → the B2-1 idle empty state (not a bare status badge).
    await waitFor(async () => expect(screen.getByTestId("optimize-idle")).toBeInTheDocument());
  });

  it("worker_lost: a failed cleanup does NOT resubmit and preserves the terminal result", async () => {
    await readyStore();
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
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(async () => expect(screen.getByTestId("optimize-resubmit")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("optimize-resubmit"));
    // Cleanup failed → the worker_lost result is preserved and the cleanup surface appears.
    await waitFor(async () =>
      expect(screen.getByTestId("optimize-cleanup-failed")).toBeInTheDocument(),
    );
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
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(async () => expect(screen.getByTestId("optimize-dismiss")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("optimize-dismiss"));
    // Exact job-not-found is a confirmed cleanup → back to idle.
    await waitFor(async () => expect(screen.getByTestId("optimize-idle")).toBeInTheDocument());
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
      await readyStore();
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

      await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
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
    await readyStore();
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

    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(async () =>
      expect(screen.getByTestId("optimize-cleanup-failed")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();

    // Retry cleanup: the local record now matches, so recovery.cleanup returns removed.
    await userEvent.click(screen.getByTestId("optimize-cleanup-retry"));
    await waitFor(() =>
      expect(screen.queryByTestId("optimize-cleanup-failed")).not.toBeInTheDocument(),
    );

    // Primary submit re-enabled — only a proven release may start a new run.
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
  });

  it("confirmed abandon that proves local release re-enables the primary submit", async () => {
    await readyStore();
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

    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(async () =>
      expect(screen.getByTestId("optimize-cleanup-failed")).toBeInTheDocument(),
    );
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
    await waitFor(async () => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
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
        controllerDeps={{ prepare: () => okPrep, storage: memStorage(), basisStore: store }}
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
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
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
        controllerDeps={{ prepare: () => okPrep, storage: memStorage() }}
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
