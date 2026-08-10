// @vitest-environment jsdom
//
// G6.2 — the visit-scoped Optimize lifecycle, at the screen boundary.
//
// One property under test, stated three ways because each has its own way of
// going wrong: entering the route is FRESH, leaving ABANDONS, and the exact
// `Optimize` action is never held down by a run the user has walked away from.
//
// Every assertion here is deliberately about an OBSERVABLE the user or the server
// would notice — a request that was or was not sent, a file that was or was not
// saved, a record that was or was not removed — rather than about the copy on
// screen. A patch that hid the notice or forced the button enabled would leave
// every one of these failing.

import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JobResponse } from "@/lib/bff/types";
import { useHotStore, useScenarioStore } from "@/lib/store";
import { createEmptyScenarioUiState } from "@/lib/scenario/canonical";
import type { PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import {
  isActiveLifecycle,
  OPTIMIZE_SESSION_KEY_PREFIX,
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  resetRosterCaptureGate,
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

function xlsxResponse(): Response {
  // A string body, not a Blob: jsdom's `Blob` has no `stream()`, so `new
  // Response(blob)` throws before the test can observe anything.
  return new Response("xlsx-bytes", {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="schedule.xlsx"',
    },
  });
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

const runningJob = (): JobResponse =>
  baseJob({
    state: "running",
    terminal: false,
    queue_position: null,
    started_at: "2026-07-20T00:00:01+00:00",
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

/** A tab's `sessionStorage`, enumerable (owner-keyed records need a prefix sweep). */
function memStorage(): SessionTransactionStorage & {
  seed(key: string, value: string): void;
  optimizeKeys(): string[];
} {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    seed: (key, value) => void values.set(key, value),
    optimizeKeys: () =>
      [...values.keys()].filter((key) => key.startsWith(OPTIMIZE_SESSION_KEY_PREFIX)),
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

/**
 * The state the user photographed: a durable ACTIVE record for a run from an
 * earlier visit, in the LEGACY single slot, plus the retirement marker an older
 * build could leave beside it.
 */
function priorRunRecord(ownerId = "owner-prior", jobId = "opt_prior"): string {
  return JSON.stringify({
    schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
    ownerId,
    phase: "active",
    jobId,
    anonymized: false,
    runOptions: {},
    peopleCount: 0,
    reverseMap: [],
    capture: { status: "staged", snapshotRef: ownerId, submissionOrdinal: 1 },
  });
}

beforeEach(() => {
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

// ---------------------------------------------------------------------------
// Entering the route
// ---------------------------------------------------------------------------

describe("entering the Optimize route is fresh", () => {
  it("the screenshot state is inert: no resume, no request, no download, and Optimize is live", async () => {
    readyStore();
    const storage = memStorage();
    storage.seed(OPTIMIZE_SESSION_STORAGE_KEY, priorRunRecord());

    const touched: string[] = [];
    routeFetch((u, init) => {
      touched.push(`${init?.method ?? "GET"} ${u}`);
      throw new Error(`the old run must not be touched: ${u}`);
    });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());

    // The three elements from the screenshot, named individually.
    expect(screen.queryByText(/still running/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-resumed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-capture-notice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-disabled-reason")).not.toBeInTheDocument();

    // Nothing about the old job was requested — not a poll, not a stream, not the
    // XLSX, not a DELETE. The route-entry auto-download is gone, not suppressed.
    expect(touched).toEqual([]);
  });

  it("a prior run's record does not disable Optimize, and a click sends exactly one POST", async () => {
    readyStore();
    const storage = memStorage();
    storage.seed(OPTIMIZE_SESSION_STORAGE_KEY, priorRunRecord());

    let posts = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return json(202, baseJob());
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, baseJob());
      throw new Error(`unexpected request: ${u}`);
    });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);

    await waitFor(() => expect(posts).toBe(1));
    // TWO owner-keyed records: the prior run's, moved to its own key by the
    // fresh-entry migration, and the new run's. Neither reads or blocks the other
    // — which is the whole point of owner-keying.
    await waitFor(() => expect(storage.optimizeKeys()).toHaveLength(2));
  });
});

// ---------------------------------------------------------------------------
// The fresh-entry cleanup lane
// ---------------------------------------------------------------------------
//
// The ONLY thing route entry does about a previous run. It is invisible by
// contract, and the tests below assert that twice over: what it moves, and what it
// conspicuously does not do while moving it.
//
// Why it has to happen at all: an owner-keyed retirement can only remove a record
// it can NAME. A record left in the legacy single slot by an earlier build is not
// nameable that way, so its real-identity reverse map would sit there until a full
// Clear. Migrating it is what brings it back within reach.

describe("fresh entry migrates a legacy record without touching the old run", () => {
  function renderFresh(storage: ReturnType<typeof memStorage>) {
    return render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );
  }

  it("moves a READABLE legacy record to its owner key, and requests nothing", async () => {
    readyStore();
    const storage = memStorage();
    const legacy = priorRunRecord("owner-legacy", "opt_legacy");
    storage.seed(OPTIMIZE_SESSION_STORAGE_KEY, legacy);

    const touched: string[] = [];
    routeFetch((u, init) => {
      touched.push(`${init?.method ?? "GET"} ${u}`);
      throw new Error(`the old run must not be touched: ${u}`);
    });

    renderFresh(storage);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());

    // Moved, byte-for-byte, to the key an owner-scoped cleanup can name.
    await waitFor(() =>
      expect(storage.getItem(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-legacy`)).toBe(legacy),
    );
    // ...and the legacy slot is proven empty, so Clear and retirement agree on
    // where the record lives.
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();
    expect(storage.optimizeKeys()).toEqual([`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-legacy`]);

    // INVISIBLE. Nothing rendered, nothing requested, nothing gated.
    expect(touched).toEqual([]);
    expect(screen.queryByText(/still running/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-disabled-reason")).not.toBeInTheDocument();
    expect(screen.getByTestId("optimize-idle")).toBeInTheDocument();
  });

  it("leaves UNREADABLE legacy bytes exactly where they are, for verified Clear", async () => {
    readyStore();
    const storage = memStorage();
    storage.seed(OPTIMIZE_SESSION_STORAGE_KEY, "{corrupt-from-an-older-build");
    routeFetch(() => json(200, baseJob()));

    renderFresh(storage);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());

    // Bytes that decode to nothing name no owner, so there is nowhere to move them
    // and nothing that may be inferred from them. Deleting what we could not read
    // is exactly how a real-identity reverse map would be lost silently.
    expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBe("{corrupt-from-an-older-build");
    expect(storage.optimizeKeys()).toEqual([]);
  });

  it("preserves an EXISTING owner key rather than overwriting it with legacy bytes", async () => {
    readyStore();
    const storage = memStorage();
    const current = priorRunRecord("owner-x", "opt_current");
    const stale = priorRunRecord("owner-x", "opt_stale");
    storage.seed(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-x`, current);
    storage.seed(OPTIMIZE_SESSION_STORAGE_KEY, stale);
    routeFetch(() => json(200, baseJob()));

    renderFresh(storage);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());

    // The owner key was written by the owner-keyed path and is therefore at least
    // as current as the legacy bytes; overwriting it could replace a live run's
    // record with a stale copy of itself.
    await waitFor(() => expect(storage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull());
    expect(storage.getItem(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-x`)).toBe(current);
  });

  it("is idempotent, so a StrictMode double-mount is a no-op", async () => {
    readyStore();
    const storage = memStorage();
    const legacy = priorRunRecord("owner-legacy", "opt_legacy");
    storage.seed(OPTIMIZE_SESSION_STORAGE_KEY, legacy);
    routeFetch(() => json(200, baseJob()));

    const first = renderFresh(storage);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    first.unmount();
    cleanup();

    renderFresh(storage);
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    expect(storage.optimizeKeys()).toEqual([`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-legacy`]);
    expect(storage.getItem(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-legacy`)).toBe(legacy);
  });
});

// ---------------------------------------------------------------------------
// The click boundary
// ---------------------------------------------------------------------------

describe("one click owns one attempt", () => {
  it("repeated clicks while the POST is unresolved send exactly ONE request", async () => {
    readyStore();
    const storage = memStorage();
    const postGate = Promise.withResolvers<Response>();
    let posts = 0;
    let cancels = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return postGate.promise;
      }
      if (u.endsWith("/cancel")) {
        cancels += 1;
        return json(200, baseJob());
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, baseJob());
      throw new Error(`unexpected request: ${u}`);
    });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());

    // Three handler events belonging to ONE user gesture (a double click, plus the
    // replay a StrictMode remount would produce). They join; they do not race.
    //
    // DETERMINISTIC BY CONSTRUCTION, and this is the part that matters. The earlier
    // form fired unawaited clicks and slept 20 ms — a bet that the events dispatch
    // before the sleep ends, which the cold review lost, observing 3 POSTs. Two
    // things fix it for good:
    //
    //   • the POST is parked and can NEVER settle inside this test, so “a later
    //     deliberate click” is not a state this test can accidentally reach; and
    //   • the duplicate events are dispatched SYNCHRONOUSLY, so the assertion
    //     cannot run before they have been delivered.
    //
    // The events are delivered as FORM SUBMITS, which is what the button raises
    // and what the screen's handler is actually wired to. Clicking the button a
    // second time would prove less than it appears to: the button disables itself
    // while the request is in flight, so a disabled element would swallow the
    // event and the join would never be reached. Submitting the form reaches the
    // handler directly, which is the path a StrictMode replay or a programmatic
    // caller takes — and it is dispatched synchronously, so by the assertion below
    // the duplicates have provably run.
    const form = submit.closest("form")!;
    void userEvent.click(submit);
    await waitFor(() => expect(posts).toBe(1));

    // Belt: while the request is in flight the control is not offered at all.
    expect(submit).toBeDisabled();

    // Braces: and a handler event that arrives anyway joins rather than racing.
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(posts, "duplicate events on one gesture must not spend a request").toBe(1);

    // And nothing queued behind them fires late either.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(posts).toBe(1);

    postGate.resolve(json(202, baseJob()));
    await waitFor(() => expect(useHotStore.getState().runView.jobId).toBe("opt_1"));
    expect(posts).toBe(1);

    // THEY JOINED — they were not merely refused, and this is what tells the two
    // apart. A duplicate event that fell through to a fresh attempt would REVOKE
    // the gesture's own attempt on the way past, so its `202` would arrive stale
    // and the retirement lane would cancel the very job the user asked for. One
    // gesture, one run, and nothing cancelled behind it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cancels, "a duplicate event must not cancel the run its own gesture started").toBe(0);
    expect(useHotStore.getState().runView.jobId).toBe("opt_1");
  });

  it("a later deliberate click supersedes a genuinely RUNNING run, cleanup parked", async () => {
    readyStore();
    const storage = memStorage();
    let posts = 0;
    const cancelled: string[] = [];
    // The old run's cleanup is PARKED and never resolves. A new click must not
    // wait on it, be blocked by it, or have its own record touched by it.
    const cancelGate = Promise.withResolvers<Response>();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return json(202, baseJob({ id: `opt_${posts}` }));
      }
      if (u.endsWith("/cancel")) {
        cancelled.push(u);
        return cancelGate.promise;
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      // The job stays RUNNING for the whole test: the second click has to work
      // against a live lifecycle, which is exactly the state `!active` used to
      // make unreachable.
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, runningJob());
      throw new Error(`unexpected request: ${u}`);
    });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        // The retirement lane's snapshot purge is parked too — an unproven purge
        // must not stop the record removal or the next click.
        retirementDeps={{ storage, purgeSnapshot: async () => ({ status: "pending" }) }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(posts).toBe(1));
    const firstKeys = storage.optimizeKeys();
    expect(firstKeys).toHaveLength(1);

    // THE RUN IS GENUINELY LIVE. Nothing here mutates the hot store to fake a
    // terminal state — that is what the previous version of this test did, and it
    // is precisely why the product could keep disabling the button for every
    // queued/running/cancelling lifecycle without any test noticing.
    await waitFor(() => expect(useHotStore.getState().runView.jobId).toBe("opt_1"));
    await waitFor(() =>
      expect(isActiveLifecycle(useHotStore.getState().runView.lifecycle)).toBe(true),
    );

    // The exact primary action, still live, on a running job.
    const stillLive = screen.getByTestId("optimize-submit");
    expect(stillLive).toBeEnabled();
    expect(screen.queryByTestId("optimize-disabled-reason")).not.toBeInTheDocument();
    await userEvent.click(stillLive);

    await waitFor(() => expect(posts).toBe(2));
    // The superseded run was cancelled best-effort...
    await waitFor(() => expect(cancelled).toHaveLength(1));
    // ...and the new run has its OWN key, while the old owner's key was retired by
    // the abandonment the click performed — without the parked cancel ever settling.
    const secondKeys = storage.optimizeKeys();
    expect(secondKeys).toHaveLength(1);
    expect(secondKeys[0]).not.toBe(firstKeys[0]);
  });
});

// ---------------------------------------------------------------------------
// Leaving the route
// ---------------------------------------------------------------------------

describe("leaving the route abandons the run", () => {
  it("a terminal result that lands after the exit downloads nothing", async () => {
    readyStore();
    const storage = memStorage();
    let xlsxFetches = 0;
    const pollGate = Promise.withResolvers<Response>();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (u.endsWith("/xlsx")) {
        xlsxFetches += 1;
        return xlsxResponse();
      }
      if (u.endsWith("/cancel")) return json(200, baseJob());
      if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return pollGate.promise;
      throw new Error(`unexpected request: ${u}`);
    });

    const view = render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(useHotStore.getState().runView.jobId).toBe("opt_1"));

    // The user leaves while the job is still running.
    view.unmount();

    // The job completes afterwards. Nothing downloads: the download primitive may
    // not be called once revocation has linearized, and no browser API could take
    // the file back if it were.
    pollGate.resolve(json(200, completedJob));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(xlsxFetches).toBe(0);

    // The abandoned run's record was retired by its own owner-scoped cleanup.
    await waitFor(() => expect(storage.optimizeKeys()).toHaveLength(0));
  });

  it("leaving MID-CHAIN stops the download that was already fetching", async () => {
    // The case the attempt fence exists for, and the one `mountedRef` never
    // covered: the terminal chain is ALREADY running when the user leaves. React
    // state is suppressed after unmount, but the asynchronous chain — the XLSX
    // fetch, the restore, `saveBlob` — carried on regardless, and the user got a
    // file for a run they had walked away from.
    readyStore();
    const storage = memStorage();
    const saveBlob = vi.fn();
    const xlsxGate = Promise.withResolvers<Response>();
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (u.endsWith("/xlsx")) return xlsxGate.promise;
      if (u.endsWith("/cancel")) return json(200, baseJob());
      if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
      throw new Error(`unexpected request: ${u}`);
    });

    const view = render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        terminalDeps={{ saveBlob }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );
    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);

    // The run completes and the auto-chain starts its XLSX fetch, which parks.
    await waitFor(() => expect(useHotStore.getState().runView.lifecycle).toBe("completed"), {
      timeout: 5_000,
    });
    await waitFor(
      () => expect(useHotStore.getState().runView.download.status).toBe("downloading"),
      {
        timeout: 5_000,
      },
    );

    // The user leaves with the fetch still in flight.
    view.unmount();

    // The bytes arrive afterwards. The chain resumes at its next awaited boundary,
    // sees the attempt revoked, and stops BEFORE the download primitive.
    xlsxGate.resolve(xlsxResponse());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("returning after leaving shows a fresh screen and no automatic second POST", async () => {
    readyStore();
    const storage = memStorage();
    let posts = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return json(202, baseJob());
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (u.endsWith("/cancel")) return json(200, baseJob());
      if (u.endsWith("/xlsx")) return xlsxResponse();
      if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
      throw new Error(`unexpected request: ${u}`);
    });

    const first = render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );
    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(posts).toBe(1));
    first.unmount();

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );

    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    // Fresh: the previous run's completed panel, its CTA and its capture notice
    // are all absent, and no second POST was sent by merely arriving.
    expect(screen.getByTestId("optimize-idle")).toBeInTheDocument();
    expect(screen.queryByTestId("optimize-completed-artifact")).not.toBeInTheDocument();
    expect(screen.queryByText(/still running/i)).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(posts).toBe(1);
  });

  it("a LATE 202 activates its own record, is cancelled, and never attaches", async () => {
    readyStore();
    const storage = memStorage();
    const postGate = Promise.withResolvers<Response>();
    const cancelled: string[] = [];
    let posts = 0;
    let polls = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return postGate.promise;
      }
      if (u.endsWith("/cancel")) {
        cancelled.push(u);
        return json(200, baseJob());
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) {
        polls += 1;
        return json(200, baseJob());
      }
      throw new Error(`unexpected request: ${u}`);
    });

    const view = render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );
    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    void userEvent.click(submit);
    await waitFor(() => expect(posts).toBe(1));

    // The user leaves while the POST is still in flight.
    view.unmount();

    // The `202` lands afterwards. Its record still activates — that is the ONLY
    // way the exact job becomes nameable — but the job is handed straight to the
    // retirement lane: cancelled, its record removed, never polled, never rendered.
    postGate.resolve(json(202, baseJob()));
    await waitFor(() => expect(cancelled).toHaveLength(1));
    expect(cancelled[0]).toContain("/api/optimize/opt_1/cancel");
    await waitFor(() => expect(storage.optimizeKeys()).toHaveLength(0));
    expect(polls).toBe(0);
    expect(useHotStore.getState().runView.jobId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two linearization points
// ---------------------------------------------------------------------------
//
// A visit fence checked NEAR a linearization point is not checked AT it. Both
// cases below park the operation that linearizes, revoke the visit while it is
// parked, and then let it finish — which is the only arrangement that can tell
// the two apart.

describe("revocation is decisive AT the submission linearization points", () => {
  it("exit while the snapshot is still staging sends ZERO requests", async () => {
    readyStore();
    const backing = memStorage();
    // THE DISCRIMINATOR between the two fences.
    //
    // Both fences read the same predicate, so once the visit is revoked either one
    // will stop the POST and purge the snapshot — which is why "no request, and the
    // snapshot is gone" cannot tell them apart, and why an earlier version of this
    // test still passed with the FIRST fence deleted. What separates them is what
    // the attempt costs on the way past: fence 1 returns BEFORE the provisional
    // session record is ever built, so a correct run writes NOTHING here; fence 2
    // only fires after that record has been written (and then rolled back), which
    // this counter sees and the end-state assertions cannot.
    let recordWrites = 0;
    const storage: typeof backing = {
      ...backing,
      setItem: (key, value) => {
        recordWrites += 1;
        backing.setItem(key, value);
      },
    };
    const stageGate = Promise.withResolvers<{
      status: "staged";
      snapshotRef: string;
      submissionOrdinal: number;
    }>();
    const purged: string[] = [];
    // Resolved the moment staging is actually entered. The old version of this test
    // slept 20ms instead and then unmounted, which made "the user leaves while it is
    // parked" a claim about how fast `userEvent.click` happened to be: on a loaded
    // machine the click's own event sequence takes longer than that, the unmount
    // lands FIRST, and the click then dispatches into a detached tree — so the
    // submission never started and every assertion below passed or failed for a
    // reason that had nothing to do with the fence.
    const stagingEntered = Promise.withResolvers<void>();
    let requests = 0;
    routeFetch((u) => {
      requests += 1;
      throw new Error(`no request may be sent after the visit ended: ${u}`);
    });

    const view = render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          storage,
          createOwnerId: () => "owner-parked",
          // Parked: staging is the FIRST await in `submit`, and it is where the
          // old code resumed unconditionally and went on to POST.
          stageSnapshot: () => {
            stagingEntered.resolve();
            return stageGate.promise;
          },
          purgeSnapshot: async (owner) => {
            purged.push(owner);
          },
        }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    void userEvent.click(submit);
    // Synchronized on the ACTUAL park, not on a stopwatch: the submission is
    // provably inside staging before the visit ends.
    await stagingEntered.promise;

    // The user leaves while it is parked.
    view.unmount();

    // Staging completes afterwards.
    stageGate.resolve({ status: "staged", snapshotRef: "owner-parked", submissionOrdinal: 1 });

    // The snapshot it had just staged is purged — exactly that one, by owner. This
    // is also the non-vacuity proof: it can only hold if the submission genuinely
    // resumed after the revocation and took the fence's branch.
    await waitFor(() => expect(purged).toEqual(["owner-parked"]));
    // NO server job was created for a visit that had already ended.
    expect(requests, "a revoked pre-POST attempt must send nothing at all").toBe(0);
    // ...and the attempt never got as far as writing a record to roll back.
    expect(recordWrites, "fence 1 returns before any session record is built").toBe(0);
    expect(backing.optimizeKeys()).toEqual([]);
  });

  it("exit AFTER the record is staged, before the request leaves, still sends ZERO", async () => {
    // THE SECOND FENCE, ISOLATED. Staging the snapshot succeeds cleanly here, so
    // the first fence passes; the visit is then revoked by the SESSION-RECORD
    // write, which happens after that fence and before the submit closure runs.
    //
    // Synthetic, and deliberately so: the two fences sit close enough together
    // that no ordinary scheduling gap separates them, which is exactly why a test
    // that cannot separate them proves only one of them exists. Mutating either
    // fence away must fail its own case, and this is the case for the second.
    readyStore();
    const backing = memStorage();
    let requests = 0;
    let recordWrites = 0;
    let unmount: (() => void) | null = null;
    routeFetch((u) => {
      requests += 1;
      throw new Error(`no request may be sent after the visit ended: ${u}`);
    });

    // A storage that ends the visit at the moment the provisional record lands.
    const storage: typeof backing = {
      ...backing,
      setItem: (key, value) => {
        backing.setItem(key, value);
        recordWrites += 1;
        unmount?.();
        unmount = null;
      },
    };

    const view = render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{
          prepare: () => okPrep,
          storage,
          createOwnerId: () => "owner-late",
          stageSnapshot: async () => ({
            status: "staged",
            snapshotRef: "owner-late",
            submissionOrdinal: 1,
          }),
          purgeSnapshot: async () => {},
        }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    unmount = () => view.unmount();
    void userEvent.click(submit);

    // NON-VACUITY FIRST. Every assertion below is an absence, and absences are
    // exactly what a click that never landed also satisfies — so wait for the
    // record write that proves the transaction reached the point this test is
    // about, and which is what revokes the visit.
    await waitFor(() => expect(recordWrites).toBe(1));
    // The record the transaction staged is then rolled back owner-scoped, because a
    // request that never left proves no job exists.
    await waitFor(() => expect(backing.optimizeKeys()).toEqual([]));
    expect(requests, "the request must not leave after the visit ended").toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Document exit
// ---------------------------------------------------------------------------

describe("pagehide cuts the owner record synchronously", () => {
  it("removes the exact owner key even when the snapshot purge never resolves", async () => {
    readyStore();
    const storage = memStorage();
    // Another tab's run, sitting in this store. It must not be touched.
    storage.seed(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-other`, priorRunRecord("owner-other"));

    let posts = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return json(202, baseJob());
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (u.endsWith("/cancel")) return json(200, baseJob());
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, runningJob());
      throw new Error(`unexpected request: ${u}`);
    });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "owner-mine" }}
        // NEVER RESOLVES. On a document teardown the page may simply stop running,
        // so anything sequenced after an awaited purge is anything that does not
        // happen — which is how the owner record, and the real-identity reverse map
        // it carries, used to survive a reload.
        retirementDeps={{ storage, purgeSnapshot: () => new Promise(() => {}) }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() =>
      expect(storage.getItem(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-mine`)).not.toBeNull(),
    );

    // The document goes away. No await, no microtask — the assertion runs on the
    // very next line, which is the whole claim.
    fireEvent(window, new Event("pagehide"));

    expect(
      storage.getItem(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-mine`),
      "the owner record must be gone synchronously, not after an awaited purge",
    ).toBeNull();
    // And only ours: another owner's record is not this exit's to remove.
    expect(storage.getItem(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-other`)).not.toBeNull();
  });

  // THE INTERLEAVING. The two halves above and in `a LATE 202 activates its own
  // record...` were each true on their own, and between them sat the case neither
  // covered: the POST still in flight WHEN the document goes away.
  //
  // What used to happen: `pagehide` cut the owner key synchronously (correct), the
  // `202` landed afterwards, and activation found an empty key, read it as free,
  // and wrote the identity-bearing active record straight back into it. The SPA
  // retirement lane that follows cannot repair that — it awaits the snapshot purge
  // before removing the record, and the hard-exit case this very test models is a
  // purge that never resumes. The reverse map would then outlive the visit.
  it("a 202 landing AFTER the document-exit cut never recreates the owner key", async () => {
    readyStore();
    const storage = memStorage();
    // Another tab's run, which nothing here may touch.
    storage.seed(`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-other`, priorRunRecord("owner-other"));

    const postGate = Promise.withResolvers<Response>();
    const calls: string[] = [];
    let posts = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${u}`);
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return postGate.promise;
      }
      // The ONE thing a retired run may still do.
      if (u.endsWith("/cancel")) return json(200, baseJob());
      throw new Error(`a retired run may send nothing but a cancel: ${method} ${u}`);
    });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "owner-mine" }}
        // Parked forever, as a real document teardown may leave it.
        retirementDeps={{ storage, purgeSnapshot: () => new Promise(() => {}) }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    void userEvent.click(submit);

    // POSITIVE HANDSHAKE, twice over: the request is genuinely in flight AND the
    // provisional record is genuinely durable. Every assertion below is an absence,
    // and absences are what a submission that never started also satisfies.
    const key = `${OPTIMIZE_SESSION_STORAGE_KEY}.owner-mine`;
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() => expect(storage.getItem(key)).not.toBeNull());

    // The document goes away while the POST is parked.
    fireEvent(window, new Event("pagehide"));
    expect(storage.getItem(key), "the cut itself").toBeNull();

    // ...and only NOW does the server accept the job.
    postGate.resolve(json(202, baseJob()));

    // The activation attempt runs. Settle on the best-effort cancel, which is the
    // one thing a retired run is still allowed to do — so this waits for the
    // continuation to have actually happened rather than for a duration.
    await waitFor(() => expect(calls.some((line) => line.includes("/cancel"))).toBe(true));

    expect(storage.getItem(key), "a late 202 must not recreate the key the exit cut").toBeNull();
    // Exactly one record in the store, and it is the other tab's.
    expect(storage.optimizeKeys()).toEqual([`${OPTIMIZE_SESSION_STORAGE_KEY}.owner-other`]);

    // No poll, no stream, no XLSX, no roster capture — the whole terminal chain
    // stayed unreachable because no job was ever activated into the view.
    expect(
      calls.filter((line) => /\/events|\/xlsx|\/roster|GET \S*\/api\/optimize\//.test(line)),
    ).toEqual([]);
    expect(useHotStore.getState().runView.jobId).toBeNull();
    expect(screen.getByTestId("optimize-idle")).toBeInTheDocument();
    expect(screen.queryByText(/still running/i)).not.toBeInTheDocument();
  });

  it("CONTROL: with no exit, the same parked 202 activates and runs normally", async () => {
    // Without this the test above would pass equally against a build that simply
    // dropped every late 202 on the floor.
    readyStore();
    const storage = memStorage();
    const postGate = Promise.withResolvers<Response>();
    let posts = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return postGate.promise;
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, runningJob());
      throw new Error(`unexpected request: ${u}`);
    });

    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage, createOwnerId: () => "owner-mine" }}
        retirementDeps={{ storage }}
      />,
      { wrapper },
    );

    const submit = await waitFor(() => screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(submit).toBeEnabled());
    void userEvent.click(submit);
    const key = `${OPTIMIZE_SESSION_STORAGE_KEY}.owner-mine`;
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() => expect(storage.getItem(key)).not.toBeNull());

    postGate.resolve(json(202, baseJob()));

    // The record becomes ACTIVE under the same owner key, and the run is live.
    await waitFor(() => expect(useHotStore.getState().runView.jobId).toBe("opt_1"));
    await waitFor(() =>
      expect(JSON.parse(storage.getItem(key)!)).toMatchObject({ phase: "active", jobId: "opt_1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("one run's cleanup cannot reach another run's data", () => {
  it("two tabs submit independently and neither retires the other's record", async () => {
    readyStore();
    // `sessionStorage` is per TAB, so two tabs are two stores. The isolation being
    // proved is that the abandonment in tab A names only owners A staged — it
    // cannot enumerate its way into anything else, in this tab or any other.
    const tabA = memStorage();
    const tabB = memStorage();
    let posts = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return json(202, baseJob({ id: `opt_${posts}` }));
      }
      if (u.endsWith("/cancel")) return json(200, baseJob());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, baseJob());
      throw new Error(`unexpected request: ${u}`);
    });

    const a = render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage: tabA }}
        retirementDeps={{ storage: tabA }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(posts).toBe(1));
    expect(tabA.optimizeKeys()).toHaveLength(1);
    a.unmount();
    cleanup();

    useHotStore.getState().resetRunView();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        controllerDeps={{ prepare: () => okPrep, storage: tabB }}
        retirementDeps={{ storage: tabB }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
    await waitFor(() => expect(posts).toBe(2));

    // B submitted without waiting on A, and A's exit removed only A's own key.
    await waitFor(() => expect(tabA.optimizeKeys()).toHaveLength(0));
    expect(tabB.optimizeKeys()).toHaveLength(1);
  });
});
