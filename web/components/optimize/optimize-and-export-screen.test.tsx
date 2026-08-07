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
  buildProvisionalSession,
  createOptimizeObservability,
  OPTIMIZE_SESSION_STORAGE_KEY,
  OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
  resetRosterCaptureGate,
  type CleanupCallOutcome,
  type SessionTransactionStorage,
} from "@/lib/optimize";
import type { SubmissionSnapshotStore } from "@/lib/optimize/submission-snapshot";
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

/** The narrow F1 snapshot surface the hidden retirement needs. This file deliberately
 *  runs without IndexedDB, so the second half is driven through a double. */
function snapshotStoreDouble(seeded: string[] = []) {
  const rows = new Set(seeded);
  const control = {
    rows,
    failDelete: false,
    deleteCalls: [] as string[],
    /** Park the delete so a test can hold one retirement genuinely in flight. */
    deleteGate: null as Promise<void> | null,
  };
  const store = {
    getClearEpoch: async () => 0,
    allocateSubmissionSnapshot: async () => ({ status: "stale-epoch", currentEpoch: 0 }),
    readSubmissionSnapshot: async (ownerId: string) =>
      rows.has(ownerId)
        ? { key: `snapshot:${ownerId}`, ownerId, submissionOrdinal: 1, payload: {} }
        : null,
    deleteSubmissionSnapshot: async ({ ownerId }: { ownerId: string }) => {
      control.deleteCalls.push(ownerId);
      if (control.deleteGate) await control.deleteGate;
      if (control.failDelete) throw new Error("snapshot delete failed");
      return rows.delete(ownerId) ? { status: "deleted" } : { status: "already-absent" };
    },
  } as unknown as SubmissionSnapshotStore;
  return Object.assign(control, { store });
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

describe("OptimizeAndExportScreen — hidden prior-run retirement behind Optimize", () => {
  /** The single primary action's existing label. It must not change with state and
   *  must never gain an "again"/Forget/Abandon sibling. */
  const SUBMIT_LABEL = "Optimize";

  function provisionalFor(ownerId: string): string {
    return JSON.stringify(
      buildProvisionalSession({
        ownerId,
        anonymized: false,
        peopleCount: 2,
        reverseMap: [],
        runOptions: {},
        capture: { status: "staged", snapshotRef: ownerId, submissionOrdinal: 1 },
      }),
    );
  }

  function renderScreen(
    storage: ReturnType<typeof memStorage>,
    snapshots?: ReturnType<typeof snapshotStoreDouble>,
  ) {
    return render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        recoveryDeps={{ storage, snapshotStore: snapshots?.store }}
      />,
      { wrapper },
    );
  }

  it("shows no recovery surface at all, and the primary button is always Optimize", async () => {
    // The settled product boundary. A prior interrupted attempt is present, and the
    // user is shown nothing about it: no notice, no Forget, no Abandon, no
    // "Optimize again", no confirmation, and no recovery vocabulary anywhere.
    readyStore();
    const storage = memStorage(provisionalFor("owner-hidden"));
    const snapshots = snapshotStoreDouble(["owner-hidden"]);
    routeFetch(() => json(200, baseJob()));
    renderScreen(storage, snapshots);

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    // The ONE primary action, with its existing label unchanged by the presence of a
    // prior attempt. No second action and no variant of it.
    expect(screen.getByTestId("optimize-submit")).toHaveTextContent(SUBMIT_LABEL);
    expect(document.body.textContent ?? "").not.toMatch(/optimi[sz]e again|abandon this|forget/i);
    for (const id of ["optimize-interrupted", "optimize-unreadable", "optimize-forget"]) {
      expect(screen.queryByTestId(id), id).not.toBeInTheDocument();
    }
    expect(document.body.textContent ?? "").not.toMatch(
      /forget|recovery record|snapshot|owner id|cleanup token|storage epoch|retention/i,
    );
  });

  it("a fresh run with no prior record submits exactly once", async () => {
    readyStore();
    const storage = memStorage();
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });
    renderScreen(storage);

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(posts).toBe(1));
  });

  it("retires an exact-owner interrupted record, then submits once", async () => {
    readyStore();
    const storage = memStorage(provisionalFor("owner-x"));
    const snapshots = snapshotStoreDouble(["owner-x"]);
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });
    renderScreen(storage, snapshots);

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));

    await waitFor(() => expect(posts).toBe(1));
    // Both halves of the prior run are gone, and it happened without a word to the user.
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).not.toContain("owner-x");
    expect(snapshots.rows.has("owner-x")).toBe(false);
    expect(screen.queryByTestId("optimize-start-failed")).not.toBeInTheDocument();
  });

  it("an owed marker is resumed by the click, then the run submits once", async () => {
    readyStore();
    const storage = memStorage();
    storage.setItem(
      OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, ownerId: "owner-owed" }),
    );
    const snapshots = snapshotStoreDouble(["owner-owed"]);
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });
    renderScreen(storage, snapshots);

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(posts).toBe(1));
    expect(snapshots.rows.has("owner-owed")).toBe(false);
  });

  it("when retirement cannot be verified: ZERO POST, data preserved, plain guidance only", async () => {
    // The whole failure contract in one place. No request, nothing deleted, the
    // configured schedule untouched, and copy that names only Optimize and New
    // schedule — never a record, snapshot, owner, epoch, token, or backend job.
    readyStore();
    const storage = memStorage(provisionalFor("owner-stuck"));
    const snapshots = snapshotStoreDouble(["owner-stuck"]);
    snapshots.failDelete = true;
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });
    renderScreen(storage, snapshots);

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));

    const notice = await screen.findByTestId("optimize-start-failed");
    expect(posts).toBe(0);
    expect(snapshots.rows.has("owner-stuck")).toBe(true);
    expect(notice).toHaveTextContent("Optimisation could not start");
    expect(notice).toHaveTextContent(/click optimize to try again/i);
    expect(notice).toHaveTextContent(/new schedule/i);
    expect(notice.textContent ?? "").not.toMatch(
      /forget|recovery record|snapshot|owner|cleanup token|storage epoch|retention|backend job/i,
    );
    // The scenario the user configured is still there to retry with.
    expect(useScenarioStore.getState().staff).toHaveLength(1);
    // The button is unchanged and still live — no "try again" variant appears.
    expect(screen.getByTestId("optimize-submit")).toHaveTextContent(SUBMIT_LABEL);
    expect(screen.getByTestId("optimize-submit")).toBeEnabled();

    // Retrying the SAME action finishes the owed work and submits.
    snapshots.failDelete = false;
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(posts).toBe(1));
    expect(snapshots.rows.has("owner-stuck")).toBe(false);
  });

  it("an UNREADABLE record blocks the POST without removing or deleting anything", async () => {
    readyStore();
    const storage = memStorage("{ not json");
    const snapshots = snapshotStoreDouble(["owner-unknown"]);
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });
    renderScreen(storage, snapshots);

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));

    await screen.findByTestId("optimize-start-failed");
    expect(posts).toBe(0);
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBe("{ not json");
    expect(snapshots.deleteCalls).toEqual([]);
    expect(snapshots.rows.has("owner-unknown")).toBe(true);
  });

  it("a route REMOUNT while the POST is parked joins the attempt — ONE POST", async () => {
    // The window the mount-local guard could not cover. Between the request leaving
    // and the job activating, this run's OWN durable record is still provisional — so
    // a remount in that window used to read it as a prior interrupted attempt, retire
    // its snapshot, and send a second POST behind the first.
    readyStore();
    const storage = memStorage();
    const snapshots = snapshotStoreDouble();
    let posts = 0;
    const post = Promise.withResolvers<void>();
    routeFetch(async (url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") {
        posts += 1;
        await post.promise;
      }
      return json(200, baseJob());
    });

    const first = renderScreen(storage, snapshots);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(posts).toBe(1));

    // Navigate away and back while that POST is still in flight, then click again.
    first.unmount();
    renderScreen(storage, snapshots);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("optimize-submit")).catch(() => undefined);

    expect(posts).toBe(1);
    // The first attempt's own record was not retired out from under it.
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).not.toBeNull();
    expect(snapshots.deleteCalls).toEqual([]);

    post.resolve();
    await waitFor(() => expect(posts).toBe(1));
  });

  it("a replay AFTER the attempt settles still cannot issue a second POST", async () => {
    // Once the run activates, its record is `active` — which the hidden step refuses
    // to retire, so the boundary itself blocks a rival request without needing any
    // cached attempt.
    readyStore();
    const storage = memStorage();
    const snapshots = snapshotStoreDouble();
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });

    const first = renderScreen(storage, snapshots);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(posts).toBe(1));

    first.unmount();
    renderScreen(storage, snapshots);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("optimize-submit")).catch(() => undefined);

    expect(posts).toBe(1);
    expect(snapshots.deleteCalls).toEqual([]);
  });

  it("a click DURING boot marker recovery still POSTs exactly once after release", async () => {
    // The realistic crash-cut, on the real screen: boot finds a valid marker and no
    // session record, the IndexedDB delete is parked, the boot inspection has already
    // made Optimize submit-ready, and the user clicks. The retirement-only flight must
    // ADOPT that click rather than coalescing it into its own empty callback —
    // otherwise the request is silently never sent and no failure is shown.
    readyStore();
    const storage = memStorage();
    storage.setItem(
      OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, ownerId: "owner-boot" }),
    );
    const snapshots = snapshotStoreDouble(["owner-boot"]);
    const purge = Promise.withResolvers<void>();
    snapshots.deleteGate = purge.promise;
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });

    const first = renderScreen(storage, snapshots);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    // Boot's retirement is genuinely parked inside the purge.
    await waitFor(() => expect(snapshots.deleteCalls).toEqual(["owner-boot"]));

    await userEvent.click(screen.getByTestId("optimize-submit"));
    // Nothing can have been sent yet: retirement has not proved safe.
    expect(posts).toBe(0);

    // A remount and another click while still parked must not add a second request.
    first.unmount();
    renderScreen(storage, snapshots);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("optimize-submit")).catch(() => undefined);

    purge.resolve();

    await waitFor(() => expect(posts).toBe(1));
    expect(snapshots.deleteCalls).toEqual(["owner-boot"]);
    expect(storage.getItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY)).toBeNull();
    expect(screen.queryByTestId("optimize-start-failed")).not.toBeInTheDocument();
  });

  it("a click during boot recovery that BLOCKS sends nothing and shows the plain guidance", async () => {
    readyStore();
    const storage = memStorage();
    storage.setItem(
      OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, ownerId: "owner-boot" }),
    );
    const snapshots = snapshotStoreDouble(["owner-boot"]);
    snapshots.failDelete = true;
    const purge = Promise.withResolvers<void>();
    snapshots.deleteGate = purge.promise;
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });

    renderScreen(storage, snapshots);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await waitFor(() => expect(snapshots.deleteCalls).toEqual(["owner-boot"]));

    await userEvent.click(screen.getByTestId("optimize-submit"));
    purge.resolve();

    await screen.findByTestId("optimize-start-failed");
    expect(posts).toBe(0);
    expect(snapshots.rows.has("owner-boot")).toBe(true);
    // The configured schedule is untouched, so the retry has something to send.
    expect(useScenarioStore.getState().staff).toHaveLength(1);
  });

  it("repeated clicks coalesce to ONE retirement and ONE POST", async () => {
    readyStore();
    const storage = memStorage(provisionalFor("owner-double"));
    const snapshots = snapshotStoreDouble(["owner-double"]);
    let posts = 0;
    routeFetch((url, init) => {
      if (url.endsWith("/api/optimize") && (init?.method ?? "GET") === "POST") posts += 1;
      return json(200, baseJob());
    });
    renderScreen(storage, snapshots);

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    const button = screen.getByTestId("optimize-submit");
    await Promise.all([userEvent.click(button), userEvent.click(button), userEvent.click(button)]);

    await waitFor(() => expect(posts).toBe(1));
    expect(snapshots.deleteCalls).toEqual(["owner-double"]);
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
        recoveryDeps={{ storage }}
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
    // Dismissed → the B2-1 idle empty state (not a bare status badge).
    await waitFor(() => expect(screen.getByTestId("optimize-idle")).toBeInTheDocument());
  });

  it("worker_lost: a failed cleanup does NOT resubmit and preserves the terminal result", async () => {
    readyStore();
    routeTerminal(workerLostJob);
    const deleteJob = vi.fn(
      async (): Promise<CleanupCallOutcome> => ({ status: "failed", reason: "409" }),
    );
    const storage = memStorage();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "o5" }}
        recoveryDeps={{ storage }}
        terminalDeps={{ deleteJob }}
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

    // The retired escape hatch is gone: the run stays current until Retry succeeds,
    // with no second action and no destructive confirmation to reach it.
    expect(screen.queryByTestId("optimize-cleanup-abandon")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-cleanup-abandoned")).not.toBeInTheDocument();
    // No confirmation surface is reachable at all — the prop that drove it is gone.
    expect(screen.queryByTestId("confirm-dialog-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("optimize-cleanup-retry")).toBeInTheDocument();
  });

  it("cleans up via the exact code-first job-not-found DELETE (real classifier)", async () => {
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
    await waitFor(() => expect(screen.getByTestId("optimize-idle")).toBeInTheDocument());
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
        "Finish tidying up the last run above",
      );
      // Plain language only: no retired action and no backend vocabulary.
      expect(screen.getByTestId("optimize-disabled-reason").textContent ?? "").not.toMatch(
        /abandon|retention|server job/i,
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
    const deleteJob = vi.fn(async () => {
      // A foreign record lands in the slot while the DELETE is in flight, so the
      // first local release reports `not-current` and the cleanup fails.
      control.setForeign(foreignActiveRecordRaw("opt_FOREIGN"));
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
    expect(deleteJob).toHaveBeenCalledTimes(1);

    // The foreign record is resolved, then the user retries. Cleanup is two halves
    // and only the LOCAL one is outstanding — the retry must not re-issue a DELETE
    // the server already confirmed against a job that is provably gone.
    control.clearForeign();
    await userEvent.click(screen.getByTestId("optimize-cleanup-retry"));
    await waitFor(() =>
      expect(screen.queryByTestId("optimize-cleanup-failed")).not.toBeInTheDocument(),
    );

    // Primary submit re-enabled — only a proven release may start a new run.
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    expect(deleteJob).toHaveBeenCalledTimes(1);
  });
});
