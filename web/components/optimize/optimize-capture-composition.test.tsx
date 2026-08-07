// @vitest-environment jsdom
//
// F2 production capture composition.
//
// `fake-indexeddb/auto` MUST be the first import: Dexie captures the IndexedDB
// API at open time, so loading it after the store modules leaves the roster
// database unopenable and every assertion below would pass through the degraded
// branch instead of exercising the real pipeline. This file therefore lives apart
// from `optimize-and-export-screen.test.tsx`, which deliberately runs WITHOUT
// IndexedDB to cover the degraded browser condition.
//
// What is real here: the screen, the run controller, session recovery, the
// terminal download/cleanup chain, the capture gate the screen builds itself, and
// F1 storage. Only the gate's collaborators that cannot be real on this branch are
// substituted — F3's document assembler.
import "fake-indexeddb/auto";
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
  buildStagedSubmission,
  getCleanupCoordinator,
  getRosterCaptureGate,
  INITIAL_OPTIMIZE_RUN_VIEW,
  notifyRosterCaptureCleared,
  OPTIMIZE_POLL_INTERVAL_MS,
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  OPTIMIZE_SESSION_STORAGE_KEY,
  productionCandidateBuilder,
  reduceRunView,
  resetRosterCaptureGate,
  ROSTER_SUBMISSION_VERSION,
  stageSubmissionSnapshot,
  type SessionTransactionStorage,
} from "@/lib/optimize";
import { ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { createRosterStorageForDb, type RosterStorage } from "@/lib/store/roster-storage";
import {
  FIXTURE_REVERSE_MAP,
  fixtureContainer,
  fixtureSubmission,
} from "@/lib/roster/test-fixtures";
import type { RosterDocument } from "@/lib/roster";
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

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    handler(String(url), init),
  ) as typeof fetch;
}

function memStorage(): SessionTransactionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
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

// The REAL canonical submission F3's fixtures describe, so the production
// assembler runs against bytes the backend would actually have received and the
// container below genuinely aligns with it. A hand-shaped stand-in would only ever
// prove the assembler's rejection path.
//
// The RUN itself is plain (`anonymized: false`). That keeps T16q's XLSX people-id
// restoration on its byte-identical bypass, so the stand-in workbook these tests
// serve is not fed to ExcelJS — a failure that would have nothing to do with
// capture. The CAPTURED submission still carries a real reverse map (staged
// below): the parity download's restoration and the roster document's
// de-anonymization are independent concerns reading independent inputs.
const okPrep: PrepareOptimizeSubmissionResult = {
  ok: true,
  prep: {
    yaml: fixtureSubmission().canonicalYaml,
    peopleCount: 0,
    reverseMap: [],
    anonymized: false,
  },
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
 * The capture chain is several async hops deep, and the run only reaches terminal
 * via the authoritative fallback poll — `OPTIMIZE_POLL_INTERVAL_MS` is 4s, so a
 * completion observed on the second poll already costs ~8s before capture even
 * starts. The budget is set well clear of two poll intervals plus the
 * xlsx → restore → roster → assemble → Dexie commit → render chain; a passing run
 * still resolves as soon as the assertion holds, so this costs nothing when green.
 */
const CAPTURE_TIMEOUT = OPTIMIZE_POLL_INTERVAL_MS * 3;

/**
 * Vitest's own per-test timeout, which must sit ABOVE `CAPTURE_TIMEOUT` — the
 * default 5s would fire first and report a bare "test timed out" instead of the
 * assertion that actually failed.
 */
const TEST_TIMEOUT = CAPTURE_TIMEOUT + OPTIMIZE_POLL_INTERVAL_MS * 2;

/** The exact bytes the stand-in workbook carries, asserted after the round trip. */
const XLSX_BYTES = "xlsx-bytes";

/**
 * The parity XLSX every branch must deliver regardless of capture.
 *
 * Hand-rolled rather than a real `Response`, to keep TWO jsdom/undici artefacts
 * out of the way of what these tests are actually about:
 *
 *   • jsdom's `Blob` has no `.stream()`, so `new Response(blob)` makes
 *     `response.blob()` throw "object.stream is not a function";
 *   • undici's `response.blob()` returns a NODE `Blob`, which fails
 *     `instanceof globalThis.Blob` inside F3's assembler — so the roster would be
 *     rejected as "the frozen workbook is missing or empty" for a reason that
 *     cannot occur in a browser.
 *
 * Returning a jsdom `Blob` from `blob()` is what a real browser does, so this is
 * the environment being corrected, not the product being worked around.
 */
function xlsxResponse(): Response {
  const headers = new Headers({
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": 'attachment; filename="schedule.xlsx"',
  });
  return {
    ok: true,
    status: 200,
    headers,
    blob: async () => new Blob([XLSX_BYTES], { type: headers.get("content-type")! }),
    json: async () => null,
  } as unknown as Response;
}

beforeEach(() => {
  // jsdom implements neither object-URL method, and the REAL `saveBlob` seam needs
  // both. Polyfilling the ENVIRONMENT (rather than injecting `terminalDeps.saveBlob`)
  // is what lets these tests keep the terminal chain completely un-injected while
  // still driving the parity download to completion.
  URL.createObjectURL = vi.fn(() => "blob:composition-test");
  URL.revokeObjectURL = vi.fn();

  // The production gate is app-lifetime by design (it must survive route
  // unmount/remount), so it is module-owned and would otherwise carry one test's
  // captured jobs, store, and tokens into the next. Dropping it here is the test
  // isolation that ownership choice requires.
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
// F2 — production capture composition.
//
// The point of these is that NOTHING about the terminal chain is injected: the
// screen builds its own capture gate, hands it to the real `useOptimizeTerminal`,
// and the DELETE is gated on the token that gate issues. Only the gate's three
// COLLABORATORS are substituted (F1 storage so the assertions can read it back,
// the `/roster` client so the fetch is countable, and F3's assembler, which is
// not on this branch yet) — never the gate, the terminal hook, or the wiring
// between them.
// ---------------------------------------------------------------------------

describe("OptimizeAndExportScreen — production roster capture", () => {
  let dbCounter = 0;

  function freshStore(): RosterStorage {
    const db = new ScenarioPersistenceDb(`screen-capture-test-${dbCounter++}`);
    return createRosterStorageForDb(() => db);
  }

  /**
   * Bind BOTH halves of the pipeline to one store: the pre-POST write-ahead
   * staging and the terminal capture that consumes it. Without this the run would
   * stage into the app-wide singleton while capture read a fresh database, and
   * every assertion below would pass vacuously through the degraded branch.
   */
  function captureWiring(store: RosterStorage, stagedOwners: string[] = []) {
    return {
      stagedOwners,
      controllerDeps: {
        prepare: () => okPrep,
        storage: memStorage(),
        stageSnapshot: (input: { ownerId: string; canonicalYaml: string }) => {
          // Recorded so a test can address the exact staged snapshot afterwards
          // (the owner id is a fresh UUID chosen inside the controller).
          stagedOwners.push(input.ownerId);
          return stageSubmissionSnapshot({
            ownerId: input.ownerId,
            payload: buildStagedSubmission({
              // The EXACT bytes the submit closure sent.
              canonicalYaml: input.canonicalYaml,
              // The reverse map the roster document de-anonymizes through (see the
              // note on `okPrep` for why it is not the run's own).
              reverseMap: FIXTURE_REVERSE_MAP.map(([anonymized, original]) => [
                anonymized,
                original,
              ]),
              schemaVersion: ROSTER_SUBMISSION_VERSION,
            }),
            store,
          });
        },
      },
      // ONLY the storage is substituted, so the assertions can read the database
      // back. `buildCandidate` is deliberately absent: the gate falls through to
      // `productionCandidateBuilder`, i.e. F3's real `assembleRosterDocument`.
      captureDeps: { store },
    };
  }

  /** Route the whole terminal chain: POST → poll(completed) → xlsx → DELETE. */
  function routeTerminalRun(options: {
    onRoster: () => void;
    onDelete: () => void;
    deleteStatus?: number;
  }) {
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
      if (u.endsWith("/events")) return streamResponse("");
      if (u.endsWith("/xlsx")) return xlsxResponse();
      if (u.endsWith("/roster")) {
        options.onRoster();
        return json(200, fixtureContainer());
      }
      if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
        options.onDelete();
        return new Response(null, { status: options.deleteStatus ?? 204 });
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
      throw new Error(`unexpected request: ${u}`);
    });
  }

  async function submitAndSettle() {
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("optimize-submit"));
  }

  it(
    "the DEFAULT screen fetches /roster once, commits one candidate, and gates the DELETE on it",
    async () => {
      readyStore();
      const store = freshStore();
      let rosterFetches = 0;
      let deletes = 0;
      const order: string[] = [];
      routeTerminalRun({
        onRoster: () => {
          rosterFetches += 1;
          order.push("roster");
        },
        onDelete: () => {
          deletes += 1;
          order.push("delete");
        },
      });

      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          // Only the gate's collaborators. No `terminalDeps` at all: the screen's own
          // gate is what the real terminal hook consults.
          {...captureWiring(store)}
        />,
        { wrapper },
      );

      await submitAndSettle();

      await waitFor(
        () => expect(screen.getByTestId("optimize-capture-committed")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      expect(rosterFetches).toBe(1);
      // The roster was fetched BEFORE the only server copy was destroyed.
      expect(order).toEqual(["roster", "delete"]);
      expect(deletes).toBe(1);

      const pointer = await store.readCurrentCandidate();
      expect(pointer).toMatchObject({ jobId: "opt_1", candidateVersion: 1 });
      // The staged snapshot was consumed by the commit, not orphaned.
      expect(await store.listSubmissionOrdinals()).toEqual([]);

      // F2 × F3 → F1: what landed in IndexedDB is a REAL assembled roster document,
      // not an opaque blob F2 invented. Every field below is one only F3's assembler
      // can produce — de-anonymized people, the derived calendar, the solved grid, the
      // container's own coordinates, and the recomputed baseline identity.
      const row = await store.readCandidate<RosterDocument>("opt_1");
      const document = row!.document;
      expect(document.schemaVersion).toBe("roster-file/1");
      expect(document.submission.canonicalYaml).toBe(fixtureSubmission().canonicalYaml);
      // De-anonymized through the SNAPSHOT's reverse map: `P1` → "Alice Ng", `P2` → 7
      // with its numeric identity preserved.
      expect(document.context.people.map((person) => person.id)).toEqual(["Alice Ng", 7]);
      expect(document.context.calendar.map((day) => day.iso)).toEqual(
        fixtureContainer().dates.map((date) => date.iso),
      );
      expect(document.solvedDays).toEqual(fixtureContainer().solvedDays);
      expect(document.coordinateMap).toEqual(fixtureContainer().coordinateMap);
      expect(document.provenance.solverStatus).toBe("OPTIMAL");
      expect(document.provenance.solvedBaselineId).toMatch(/^[0-9a-f]{64}$/);
      // A freshly captured roster carries no overlay.
      expect(document.edits).toEqual([]);
      // Workbook BYTE fidelity through storage is asserted in
      // `lib/optimize/roster-capture.test.ts`, which runs in the node environment:
      // `fake-indexeddb` cannot structured-clone a jsdom `Blob`, so a byte assertion
      // here would be testing the polyfill rather than the pipeline.
    },
    TEST_TIMEOUT,
  );

  it(
    "an assembler REJECTION resolves the run without a Retry, and still gates the DELETE on a token",
    async () => {
      // A container F3 refuses cannot be repaired by retrying, so the run resolves
      // instead of parking behind a dead Retry — and cleanup still happens only
      // AFTER the roster fetch, through an explicit dismissal token.
      readyStore();
      const store = freshStore();
      const order: string[] = [];
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) {
          order.push("roster");
          // A well-formed container for a DIFFERENT people axis than the submission.
          return json(200, { ...fixtureContainer(), people: [{ id: "P1" }] });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          order.push("delete");
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...captureWiring(store)}
        />,
        { wrapper },
      );

      await submitAndSettle();

      await waitFor(() => expect(order).toEqual(["roster", "delete"]), {
        timeout: CAPTURE_TIMEOUT,
      });
      // No Retry is offered, because no retry could succeed.
      expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
      expect(await store.readCurrentCandidate()).toBeNull();
      // The now-useless staging snapshot was retired by that proven outcome.
      expect(await store.listSubmissionOrdinals()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    "a capture failure blocks the DELETE and offers Retry on the real screen",
    async () => {
      readyStore();
      const store = freshStore();
      let deletes = 0;
      let attempt = 0;
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse("");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) {
          attempt += 1;
          if (attempt === 1) return json(500, { error: { code: "boom", message: "down" } });
          return json(200, fixtureContainer());
        }
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          deletes += 1;
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...captureWiring(store)}
        />,
        { wrapper },
      );

      await submitAndSettle();

      await waitFor(
        () => expect(screen.getByTestId("optimize-capture-fetch-failed")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      // The sole server artifact survives an unresolved capture.
      expect(deletes).toBe(0);
      expect(await store.readCurrentCandidate()).toBeNull();

      await userEvent.click(screen.getByTestId("optimize-capture-retry"));

      await waitFor(
        () => expect(screen.getByTestId("optimize-capture-committed")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      expect(deletes).toBe(1);
      expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "opt_1" });
    },
    TEST_TIMEOUT,
  );

  it(
    "discarding the saved roster removes the candidate through the real screen action",
    async () => {
      readyStore();
      const store = freshStore();
      routeTerminalRun({ onRoster: () => {}, onDelete: () => {} });

      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...captureWiring(store)}
        />,
        { wrapper },
      );

      await submitAndSettle();
      await waitFor(
        () => expect(screen.getByTestId("optimize-capture-committed")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );

      await userEvent.click(screen.getByTestId("optimize-capture-dismiss"));

      await waitFor(async () => expect(await store.readCurrentCandidate()).toBeNull(), {
        timeout: CAPTURE_TIMEOUT,
      });
      expect(await store.readCandidate("opt_1")).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "the gate SURVIVES a route unmount and a remount rejoins the same in-flight capture",
    async () => {
      // The lifetime property, exercised the way navigation actually breaks it:
      // mount the route, park the `/roster` fetch so a capture is genuinely open,
      // unmount the whole screen, remount it, then let the fetch land. A
      // component-owned gate would be unreachable after the unmount and the remount
      // would build a second one — duplicating the fetch and losing the commit.
      readyStore();
      const store = freshStore();
      const rosterGate = Promise.withResolvers<Response>();
      let rosterFetches = 0;
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) {
          rosterFetches += 1;
          return rosterGate.promise;
        }
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      const wiring = captureWiring(store);
      const first = render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...wiring}
        />,
        { wrapper },
      );

      await submitAndSettle();
      await waitFor(() => expect(rosterFetches).toBe(1), { timeout: CAPTURE_TIMEOUT });

      // Navigate away mid-flight.
      const gateBeforeUnmount = getRosterCaptureGate();
      first.unmount();
      expect(gateBeforeUnmount.getState("opt_1").status).toBe("fetching-roster");

      // Navigate back. The remounted route resolves the SAME gate.
      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...wiring}
        />,
        { wrapper },
      );
      expect(getRosterCaptureGate()).toBe(gateBeforeUnmount);

      // The parked fetch lands after the remount: it belongs to the flight that was
      // already open, so it commits once and no second fetch was ever spent.
      rosterGate.resolve(json(200, fixtureContainer()));
      // Wait on the machine's OWN terminal signal, not the committed row. The commit
      // path awaits `commitCandidate` and THEN the snapshot purge before it settles
      // `committed`, so the row becomes readable strictly earlier; triggering on the
      // row and then asserting the state races that gap (and did, under parallel
      // load). Settling first makes the row assertion below unconditional.
      await waitFor(
        () => expect(getRosterCaptureGate().getState("opt_1").status).toBe("committed"),
        { timeout: CAPTURE_TIMEOUT },
      );
      expect(rosterFetches).toBe(1);
      expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "opt_1" });
      expect(getRosterCaptureGate().getToken("opt_1")).toMatchObject({ kind: "committed" });
    },
    TEST_TIMEOUT,
  );

  it(
    "a retained commit-failed retry survives a remount and does NOT refetch /roster",
    async () => {
      // The bytes-in-hand guarantee across navigation: the container fetched before
      // the failure is retained on the app-lifetime gate, so the retry after a
      // remount is purely local.
      readyStore();
      const store = freshStore();
      let rosterFetches = 0;
      let builds = 0;
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) {
          rosterFetches += 1;
          return json(200, fixtureContainer());
        }
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      const wiring = captureWiring(store);
      const first = render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...wiring}
          captureDeps={{
            ...wiring.captureDeps,
            // Fail the FIRST assembly retryably, succeed afterwards.
            buildCandidate: async (input) => {
              builds += 1;
              return builds === 1
                ? { ok: false as const, retryable: true, reason: "transient storage error" }
                : productionCandidateBuilder(input);
            },
          }}
        />,
        { wrapper },
      );

      await submitAndSettle();
      await waitFor(
        () => expect(screen.getByTestId("optimize-capture-commit-failed")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      expect(rosterFetches).toBe(1);
      // The snapshot is still staged: a retryable failure retires nothing.
      expect(await store.listSubmissionOrdinals()).toEqual([1]);

      first.unmount();
      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...wiring}
        />,
        { wrapper },
      );

      // Retry through the surviving gate: the container and frozen bytes are still
      // in hand, so the retry commits without spending a second server fetch.
      const gate = getRosterCaptureGate();
      expect(gate.getState("opt_1")).toMatchObject({ status: "commit-failed" });
      const retried = await gate.retry({
        jobId: "opt_1",
        capture: { status: "staged", snapshotRef: wiring.stagedOwners[0], submissionOrdinal: 1 },
        frozenXlsx: new Blob([XLSX_BYTES]),
      });

      expect(rosterFetches).toBe(1);
      expect(retried.token).toMatchObject({ kind: "committed" });
      expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "opt_1" });
    },
    TEST_TIMEOUT,
  );

  it(
    "an old parked DELETE and a remounted manual action share exactly ONE cleanup",
    async () => {
      // Cleanup authority is app-lifetime, so its COALESCING has to be too. Park the
      // DELETE the first mount started, navigate away and back, then fire the
      // remounted route's own cleanup action: two coalescers that could not see each
      // other would each read the same still-valid token and each delete the job.
      readyStore();
      const store = freshStore();
      const deleteGate = Promise.withResolvers<Response>();
      let deletes = 0;
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) return json(200, fixtureContainer());
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          deletes += 1;
          return deleteGate.promise;
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      const wiring = captureWiring(store);
      const first = render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...wiring}
        />,
        { wrapper },
      );

      await submitAndSettle();
      // The auto chain captured and has now entered the DELETE, which is parked.
      await waitFor(() => expect(deletes).toBe(1), { timeout: CAPTURE_TIMEOUT });
      expect(getRosterCaptureGate().getToken("opt_1")).toMatchObject({ kind: "committed" });

      // Navigate away and back with that DELETE still in flight.
      first.unmount();
      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...wiring}
        />,
        { wrapper },
      );

      // The remounted route acts on the same job while the old attempt is unfinished.
      // It must JOIN that attempt, not start a rival one.
      const coordinator = getCleanupCoordinator();
      const joined = coordinator.run(
        "opt_1",
        async () => {
          throw new Error("the remounted action started a SECOND cleanup");
        },
        (result) => result === "cleaned",
      );

      deleteGate.resolve(new Response(null, { status: 204 }));
      await expect(joined).resolves.toBe("cleaned");
      expect(deletes).toBe(1);

      // And a later action replays the settled result rather than deleting again.
      await expect(
        coordinator.run(
          "opt_1",
          async () => {
            throw new Error("a settled cleanup was re-run");
          },
          (result) => result === "cleaned",
        ),
      ).resolves.toBe("cleaned");
      expect(deletes).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "a verified Clear after a COMMIT removes the candidate and stops claiming it is saved",
    async () => {
      readyStore();
      const store = freshStore();
      routeTerminalRun({ onRoster: () => {}, onDelete: () => {} });

      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...captureWiring(store)}
        />,
        { wrapper },
      );

      await submitAndSettle();
      await waitFor(
        () => expect(screen.getByTestId("optimize-capture-committed")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      expect(await store.readCurrentCandidate()).toMatchObject({ jobId: "opt_1" });

      // What F5's Clear does: purge first, then notify.
      expect((await store.clearRosterData()).status).toBe("cleared");
      await notifyRosterCaptureCleared();

      // The candidate really is gone — so the UI must stop saying it is saved here.
      expect(await store.readCurrentCandidate()).toBeNull();
      expect(await store.readCandidate("opt_1")).toBeNull();
      await waitFor(
        () => expect(screen.queryByTestId("optimize-capture-committed")).not.toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      // The server job's cleanup authority is retained, just no longer as a claim
      // that a roster is available.
      expect(getRosterCaptureGate().getToken("opt_1")).toMatchObject({
        kind: "dismissed",
        reason: "cleared",
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "a verified Clear reaches the mounted gate through the F5 seam",
    async () => {
      readyStore();
      const store = freshStore();
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse("");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        // A permanently failing roster leaves the capture UNRESOLVED, which is
        // exactly the state Clear has to be able to settle.
        if (u.endsWith("/roster")) return json(500, { error: { code: "boom", message: "down" } });
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: memStorage() }}
          {...captureWiring(store)}
        />,
        { wrapper },
      );

      await submitAndSettle();
      await waitFor(
        () => expect(screen.getByTestId("optimize-capture-fetch-failed")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );

      // What F5 will do after a verified purge: invalidate first, then notify.
      expect((await store.clearRosterData()).status).toBe("cleared");
      await notifyRosterCaptureCleared();

      // The Retry affordance is gone: it would have retried against purged data.
      await waitFor(
        () => expect(screen.queryByTestId("optimize-capture-fetch-failed")).not.toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "a remount before recovery attaches defers capture, then the intact snapshot drives one fetch and commit",
    async () => {
      // The authority handoff race this fixup closes. A remount inherits a
      // completed runView from the hot store while the controller's activation is
      // still null — recovery attaches the durable record from a passive effect
      // that runs AFTER the terminal hook's completed-job effect. The old path
      // reached capture with a null authority and the gate returned
      // snapshot_missing + DELETE; the fix defers the whole chain until recovery
      // resolves, so the intact snapshot is read and used exactly once.
      //
      // This is seeded rather than submitted because the point is the REMOUNT
      // state: a fresh gate entry (no prior capture) with an intact staged
      // snapshot, exercised through the real screen wiring.
      readyStore();
      const store = freshStore();
      const sessionStore = memStorage();

      // An intact staged snapshot capture will read after recovery attaches.
      const ownerId = "owner-seed";
      await stageSubmissionSnapshot({
        ownerId,
        payload: buildStagedSubmission({
          canonicalYaml: fixtureSubmission().canonicalYaml,
          reverseMap: FIXTURE_REVERSE_MAP.map(([anonymized, original]) => [anonymized, original]),
          schemaVersion: ROSTER_SUBMISSION_VERSION,
        }),
        store,
      });

      // A resumable active record so recovery attaches opt_1 with the staged
      // capture authority on its boot inspection.
      sessionStore.setItem(
        OPTIMIZE_SESSION_STORAGE_KEY,
        JSON.stringify({
          schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
          ownerId,
          phase: "active",
          jobId: "opt_1",
          anonymized: false,
          runOptions: {},
          peopleCount: 0,
          reverseMap: [],
          capture: { status: "staged", snapshotRef: ownerId, submissionOrdinal: 1 },
        }),
      );

      // The completed runView a remount inherits (the hot store survives route
      // unmount within a tab). Seeded directly so the terminal effect fires on
      // the first render, before recovery has attached the activation.
      const completedRemountView = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
        type: "job-snapshot",
        job: completedJob,
      });
      useHotStore.getState().setRunView(completedRemountView);

      let rosterFetches = 0;
      let deletes = 0;
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) {
          rosterFetches += 1;
          return json(200, fixtureContainer());
        }
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          deletes += 1;
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          recoveryDeps={{ storage: sessionStore }}
          controllerDeps={{ prepare: () => okPrep, storage: sessionStore }}
          captureDeps={{ store }}
        />,
        { wrapper },
      );

      // The terminal chain defers through the handoff, then the intact snapshot
      // drives exactly one roster fetch and one commit.
      await waitFor(
        () => expect(screen.getByTestId("optimize-capture-committed")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      expect(rosterFetches).toBe(1);
      expect(deletes).toBe(1);

      // The gate settled on a COMMITTED token — the snapshot was read and used.
      // The old null→snapshot_missing path would have ZERO roster fetches and a
      // vacuous-fence unavailable token, so this assertion is the discriminating
      // negative control: a handoff that mis-classified the intact snapshot as
      // absent cannot reach committed.
      expect(getRosterCaptureGate().getToken("opt_1")).toMatchObject({ kind: "committed" });
      const pointer = await store.readCurrentCandidate();
      expect(pointer).toMatchObject({ jobId: "opt_1", candidateVersion: 1 });
      // The staged snapshot was consumed by the commit, not orphaned by a false
      // snapshot_missing.
      expect(await store.listSubmissionOrdinals()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
