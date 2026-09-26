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
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JobResponse } from "@/lib/bff/types";
import { scenarioCommands, useHotStore } from "@/lib/store";
import { resetScenarioForTest } from "@/lib/store/test-authority";
import type { PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import {
  buildStagedSubmission,
  getCleanupCoordinator,
  getRosterCaptureGate,
  notifyRosterCaptureCleared,
  OPTIMIZE_POLL_INTERVAL_MS,
  OPTIMIZE_SESSION_STORAGE_KEY,
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
import { clearRosterDataAndNotify, resetToNewSchedule } from "@/lib/roster";
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
    // Enumerable: records are keyed per owner now, so Clear sweeps the optimize
    // keys by prefix instead of removing one named key — and a store it cannot
    // enumerate is residue UNKNOWN, which fails Clear closed.
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
  };
}

/**
 * The optimize session records a store is holding.
 *
 * Records are owner-keyed (`nurse.optimize.session.<ownerId>`) and the owner is a
 * UUID minted inside the submission, so no test can name the key up front. Reading
 * by prefix is how these compositions ask "is the run's record still there" — and
 * counting them is how they ask "did an old run's cleanup touch a newer one".
 */
function optimizeRecords(storage: SessionTransactionStorage): string[] {
  const keys: string[] = [];
  const length = storage.length ?? 0;
  for (let i = 0; i < length; i += 1) {
    const key = storage.key?.(i) ?? null;
    if (key !== null && key.startsWith("nurse.optimize.session.")) keys.push(key);
  }
  return keys;
}

const baseJob = (over: Partial<JobResponse> = {}): JobResponse => ({
  id: "opt_1",
  state: "queued",
  terminal: false,
  queue_position: 2,
  created_at: "2026-07-20T00:00:00+00:00",
  // Nullable server-side and read only by T10's diagnostic evidence window, which
  // this suite does not exercise.
  expires_at: null,
  started_at: null,
  finished_at: null,
  request: {
    input_name: "s.yaml",
    solver: "ortools/cp-sat",
    prettify: null,
    timeout_seconds: 300,
    // T09 — an unqualified submission is admitted as `ordinary`, and an ordinary run
    // echoes no claimed basis.
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

/**
 * Make the scenario submit-ready THROUGH THE T03 AUTHORITY.
 *
 * This used to push a whole state object into the scenario store. That store is a
 * read-only projection now — a component that wants to change a scenario issues a
 * repository command — so a test that reached for `setState` would be asserting
 * against a view the durable authority never agreed to. `mutate` is the same command
 * the editor uses, and it resolves only once the commit that produced the projected
 * snapshot has landed.
 */
async function readyStore() {
  await scenarioCommands.mutate({
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
 * `onlineInfo()` with the `/api/info` answer deliberately parked for a beat.
 *
 * Readiness is genuinely asynchronous: a mount is `checking` until the request
 * settles, and only then is `Optimize` enabled. A test that asserts the SETTLED
 * projection is therefore asserting something it has to wait for — but with an
 * instantly-resolved `fetchInfo` the wait is usually free, and an assertion that
 * synchronizes on nothing still looks green roughly twenty-four runs in
 * twenty-five. Parking the answer makes the pending state unavoidable, which turns
 * the one remount proof below from "passed under this scheduling" into "waits for
 * the condition it names".
 */
function parkedOnlineInfo(delayMs = 25) {
  const base = onlineInfo();
  return {
    ...base,
    fetchInfo: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return base.fetchInfo();
    },
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

beforeEach(async () => {
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
  // A brand-new empty scenario on a brand-new database, owned by this tab. The
  // durable authority is per-scenario now (envelope + lease + commit log), so
  // resetting the projection alone would leak ownership and history across tests.
  await resetScenarioForTest();
  useHotStore.getState().resetRunView();
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
   *
   * `sessionStorage` is optional: by default a fresh `memStorage()` is created for
   * the controller, matching the existing suite (which tests capture/download/
   * cleanup, not the recovery-blocking UI). Pass an EXPLICIT storage and hand the
   * SAME object to `recoveryDeps.storage` to exercise the durable-record blocking
   * path — otherwise recovery reads a different (empty) slot and `recovery.state`
   * stays `none`, making every "blocked" assertion vacuous.
   */
  function captureWiring(
    store: RosterStorage,
    stagedOwners: string[] = [],
    sessionStorage?: SessionTransactionStorage,
  ) {
    return {
      stagedOwners,
      controllerDeps: {
        prepare: () => okPrep,
        storage: sessionStorage ?? memStorage(),
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
      await readyStore();
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
      expect(document.schemaVersion).toBe("roster-file/2");
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
      await readyStore();
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

      render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...captureWiring(store)} />, {
        wrapper,
      });

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
      await readyStore();
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

      render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...captureWiring(store)} />, {
        wrapper,
      });

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
    "a confirmed New schedule leaves no stale capture notice behind on this screen",
    async () => {
      // The reported defect, end to end on the real screen: after New schedule,
      // Optimize kept showing `The roster for this run could not be saved — Not
      // Found … Your downloaded XLSX is unaffected.` The notice is a projection of
      // the capture gate plus the stored run state, so the fix has to remove that
      // state — which is what this asserts, rather than that some copy is hidden.
      await readyStore();
      const store = freshStore();
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse("");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        // A 404 on the roster fetch is exactly the reported `Not Found`.
        if (u.endsWith("/roster")) {
          return json(404, { error: { code: "not_found", message: "Not Found" } });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...captureWiring(store)} />, {
        wrapper,
      });

      await submitAndSettle();

      // ACCEPTING PRE-STATE — the exact notice the user reported is on screen.
      const notice = await waitFor(() => screen.getByTestId("optimize-capture-fetch-failed"), {
        timeout: CAPTURE_TIMEOUT,
      });
      expect(notice).toHaveTextContent(/could not be saved/i);
      expect(notice).toHaveTextContent(/Your downloaded XLSX is unaffected/i);

      // The PRODUCTION reset. Only the storage the run was wired to is substituted;
      // capture invalidation is Clear's own default, so the app-lifetime gate this
      // screen is rendering is the one that gets settled.
      let outcome;
      await act(async () => {
        outcome = await resetToNewSchedule({
          clearStoredData: () =>
            clearRosterDataAndNotify({
              rosterStorage: store,
              sessionStorage: memStorage(),
              clearViewMetadata: () => true,
            }),
        });
      });
      expect(outcome).toMatchObject({ status: "reset" });

      // No stale notice, and no result state behind it either.
      await waitFor(() =>
        expect(screen.queryByTestId("optimize-capture-fetch-failed")).not.toBeInTheDocument(),
      );
      expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
      expect(screen.queryByTestId("optimize-open-roster")).not.toBeInTheDocument();
    },
    TEST_TIMEOUT,
  );

  it(
    "discarding the saved roster removes the candidate through the real screen action",
    async () => {
      await readyStore();
      const store = freshStore();
      routeTerminalRun({ onRoster: () => {}, onDelete: () => {} });

      render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...captureWiring(store)} />, {
        wrapper,
      });

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
    "leaving the route ABANDONS an in-flight capture: no commit, no token, no DELETE",
    async () => {
      // THE INVERSION. This test used to prove that a remount REJOINED the flight a
      // route exit had left open — the capture would land and commit for a run the
      // user had walked away from. Under the visit fence the same setup must produce
      // the opposite: the parked `/roster` response arrives after the exit and
      // reaches nothing.
      //
      // What is unchanged, and still asserted, is the gate’s LIFETIME: it is still
      // the same app-lifetime object across the unmount. That is what makes the
      // abandonment observable at all — and it is why a remount cannot re-authorize
      // a DELETE for a job it already settled.
      await readyStore();
      const store = freshStore();
      const rosterGate = Promise.withResolvers<Response>();
      let rosterFetches = 0;
      let deletes = 0;
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) {
          rosterFetches += 1;
          return rosterGate.promise;
        }
        if (u.endsWith("/cancel")) return json(200, baseJob());
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          deletes += 1;
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      const wiring = captureWiring(store);
      const first = render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...wiring} />, {
        wrapper,
      });

      await submitAndSettle();
      await waitFor(() => expect(rosterFetches).toBe(1), { timeout: CAPTURE_TIMEOUT });

      // Navigate away mid-flight.
      const gateBeforeUnmount = getRosterCaptureGate();
      first.unmount();
      expect(gateBeforeUnmount.isAbandoned("opt_1")).toBe(true);

      // Navigate back. Same gate object — and nothing resumed.
      render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...wiring} />, { wrapper });
      expect(getRosterCaptureGate()).toBe(gateBeforeUnmount);

      // The parked fetch lands AFTER the exit. It must not commit a candidate the
      // user never asked for, must not mint a DELETE token, and must not surface.
      rosterGate.resolve(json(200, fixtureContainer()));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(rosterFetches).toBe(1);
      expect(getRosterCaptureGate().getToken("opt_1")).toBeNull();
      expect(getRosterCaptureGate().getState("opt_1").status).not.toBe("committed");
      expect(await store.readCurrentCandidate()).toBeNull();
      expect(deletes).toBe(0);

      // The fresh visit shows none of it, and Optimize is live.
      await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled(), {
        timeout: CAPTURE_TIMEOUT,
      });
      expect(screen.queryByTestId("optimize-capture-notice")).not.toBeInTheDocument();
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
      await readyStore();
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
      const first = render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...wiring} />, {
        wrapper,
      });

      await submitAndSettle();
      // The auto chain captured and has now entered the DELETE, which is parked.
      await waitFor(() => expect(deletes).toBe(1), { timeout: CAPTURE_TIMEOUT });
      expect(getRosterCaptureGate().getToken("opt_1")).toMatchObject({ kind: "committed" });

      // Navigate away and back with that DELETE still in flight.
      first.unmount();
      render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...wiring} />, { wrapper });

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
      await readyStore();
      const store = freshStore();
      routeTerminalRun({ onRoster: () => {}, onDelete: () => {} });

      render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...captureWiring(store)} />, {
        wrapper,
      });

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
      await readyStore();
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

      render(<OptimizeAndExportScreen serverInfoDeps={onlineInfo()} {...captureWiring(store)} />, {
        wrapper,
      });

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
    "G6: a provable roster job-gone releases the run — honest notice stays, record gone, Optimize re-enabled on remount",
    async () => {
      // The reported defect. A completed run whose XLSX downloads but whose
      // `/roster` fetch returns a real `job_not_found` 404 (the job is gone)
      // used to strand forever: the capture gate issued NO cleanup token, so the
      // terminal chain never settled and the durable session record stayed
      // active. On the NEXT mount of the recovery hook (a client-side navigation
      // away and back, or a reload) boot re-inspected that record, classified it
      // `resumable`, and the screen showed "An optimisation from this browser is
      // still running" with Optimize disabled — until New schedule.
      //
      // The fix issues a dismissal token on a provable job-gone so cleanup
      // removes the record; the honest `fetch-failed` (`jobGone`) notice stays.
      //
      // Controller and recovery share ONE session storage so the record is real,
      // and a remount after the chain re-runs boot to prove the release — the
      // same-session render alone cannot, because recovery.state is set by the
      // boot inspection that ran before the record existed.
      await readyStore();
      const store = freshStore();
      const sessionStorage = memStorage();
      const owners: string[] = [];
      let posts = 0;
      let deletes = 0;
      let rosterFetches = 0;
      // A job that is CONSISTENTLY gone: the same structured envelope on the roster
      // GET and on the cleanup DELETE. A 204 there would be an impossible server —
      // it would claim to have deleted the job the GET just said does not exist —
      // and would hide whether cleanup really settles through the job-gone path.
      const goneEnvelope = { error: { code: "job_not_found", message: "Job was not found" } };
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") {
          posts += 1;
          return json(202, baseJob());
        }
        if (u.endsWith("/events")) return streamResponse("");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) {
          rosterFetches += 1;
          // The REAL backend shape for a gone job (server/app.py exception
          // handler → JobNotFoundError.code = "job_not_found").
          return json(404, goneEnvelope);
        }
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          deletes += 1;
          return json(404, goneEnvelope);
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      const first = render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          {...captureWiring(store, owners, sessionStorage)}
        />,
        { wrapper },
      );

      await submitAndSettle();

      // The honest capture notice is on screen — the roster genuinely could not
      // be saved. A copy-only patch would have to hide this; the fix does not.
      const notice = await waitFor(() => screen.getByTestId("optimize-capture-fetch-failed"), {
        timeout: CAPTURE_TIMEOUT,
      });
      expect(notice).toHaveTextContent(/could not be saved/i);
      // jobGone copy, and no Retry (a gone job can never be retried).
      expect(notice).toHaveTextContent(/no longer available on the server/i);
      expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
      expect(rosterFetches).toBe(1);

      // THE RELEASE, observed at the owning authority: cleanup ran exactly once
      // (the gone job confirms the DELETE) and the durable record the run
      // occupied is proven gone. This is the assertion a force-enable or
      // hide-the-notice patch would have to defeat.
      await waitFor(() => expect(deletes).toBe(1), { timeout: CAPTURE_TIMEOUT });
      expect(sessionStorage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();
      // No roster candidate and no pointer: the fetch never returned a container.
      expect(await store.readCandidate("opt_1")).toBeNull();
      expect(await store.readCurrentCandidate()).toBeNull();
      // The staging row — canonical YAML plus the real-identity reverse map — is
      // PROVEN gone. The session record was its only durable handle, and cleanup
      // just consumed that record, so a surviving row here would be unreachable by
      // anything short of a full Clear.
      expect(owners).toHaveLength(1);
      expect(await store.readSubmissionSnapshot(owners[0])).toBeNull();
      // The owning authority: a settled dismissal token, durable across re-render.
      expect(getRosterCaptureGate().getToken("opt_1")).toMatchObject({
        kind: "dismissed",
        reason: "job-gone",
      });

      // The PROJECTION of the release on the next mount: a client-side navigate
      // away and back arrives fresh, finds no record for the released job, and
      // offers the same exact Optimize action. (The capture gate is app-lifetime
      // and retains the honest notice for opt_1, but the new mount's view is idle
      // so it is not projected — what matters is that no stale RUNNING authority
      // remains.)
      //
      // ORDER MATTERS HERE, and it used to be wrong. This block waited on the
      // absence of "still running" and then asserted enablement synchronously —
      // but a fresh mount has no run, so that absence is already true on the first
      // frame. It synchronized on nothing, and the assertions raced the remounted
      // `/api/info`: until that settles the screen is legitimately disabled with
      // `Backend unavailable`, which is the readiness projection doing its job
      // rather than a stale run blocking anything. So wait for the ONLINE
      // projection FIRST, then for the action, and only then ask about "still
      // running" — where its absence finally discriminates.
      first.unmount();
      render(
        <OptimizeAndExportScreen
          // PARKED on purpose — see `parkedOnlineInfo`. It guarantees the remount
          // starts in `checking`, so the ordering below is load-bearing every run
          // rather than only under an unlucky one.
          serverInfoDeps={parkedOnlineInfo()}
          {...captureWiring(store, [], sessionStorage)}
        />,
        { wrapper },
      );
      // Exact-string match, so the `Offline` badge cannot satisfy it.
      await waitFor(() => expect(screen.getByText("Online")).toBeInTheDocument());
      await waitFor(() => {
        expect(screen.queryByTestId("optimize-disabled-reason")).not.toBeInTheDocument();
        expect(screen.getByTestId("optimize-submit")).toBeEnabled();
      });
      expect(screen.queryByText(/still running/i)).not.toBeInTheDocument();
      // ONE joined cleanup across the whole lifecycle: the remount re-ran boot and
      // the terminal effects without re-issuing the DELETE, and the release cost
      // exactly one submission.
      expect(deletes).toBe(1);
      expect(posts).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "G6 negative control: a TRANSIENT roster failure retains the record (retryable, no DELETE) and strands on remount",
    async () => {
      // The contract discrimination. A NON-job-gone fetch failure (transient 5xx
      // / network) must NOT auto-release: the job still exists, a Retry could
      // still fetch its roster, and the record must stay retained for that retry.
      // Only a PROVEN job-gone (above) settles. A patch that force-released every
      // fetch failure would fail here.
      await readyStore();
      const store = freshStore();
      const sessionStorage = memStorage();
      let deletes = 0;
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse("");
        if (u.endsWith("/xlsx")) return xlsxResponse();
        if (u.endsWith("/roster")) {
          return json(500, { error: { code: "boom", message: "down" } });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
          deletes += 1;
          return new Response(null, { status: 204 });
        }
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });

      const first = render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          {...captureWiring(store, [], sessionStorage)}
        />,
        { wrapper },
      );

      await submitAndSettle();

      // Transient failure: the notice shows and a Retry is offered (the job still
      // exists). No cleanup authority was granted and no DELETE was issued, so the
      // server artifact is preserved for the retry.
      const notice = await waitFor(() => screen.getByTestId("optimize-capture-fetch-failed"), {
        timeout: CAPTURE_TIMEOUT,
      });
      expect(notice).toHaveTextContent(/Your downloaded XLSX is unaffected/i);
      expect(screen.getByTestId("optimize-capture-retry")).toBeInTheDocument();
      expect(deletes).toBe(0);
      expect(getRosterCaptureGate().getToken("opt_1")).toBeNull();
      // The run is NOT released: its record is retained for the retry.
      expect(optimizeRecords(sessionStorage)).toHaveLength(1);

      // AND THE PART THAT CHANGED. The retention above is real and correct — the
      // job still exists and a Retry could still work. What it is NOT is a claim on
      // the next visit. Leaving abandons the run, and returning finds a clean
      // screen with the exact Optimize action live. This assertion is the inverse
      // of the one it replaces, which pinned the user's reported defect as
      // intended behaviour: "still running" plus a disabled button.
      first.unmount();
      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          {...captureWiring(store, [], sessionStorage)}
        />,
        { wrapper },
      );
      await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled(), {
        timeout: CAPTURE_TIMEOUT,
      });
      expect(screen.queryByText(/still running/i)).not.toBeInTheDocument();
      expect(screen.queryByTestId("optimize-capture-fetch-failed")).not.toBeInTheDocument();
      expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
    },
    TEST_TIMEOUT,
  );

  /**
   * G6.1 — the user's REPRODUCED production failure, at the screen boundary.
   *
   * Captured 2026-08-09 from the running dev stack: the browser was proxying to a
   * uvicorn process started from a different checkout whose route table predates
   * the roster endpoint. `/xlsx` existed, `/roster` did not, and FastAPI answered
   * the unrouted path with its own `404 {"detail":"Not Found"}` — the SAME status a
   * genuinely gone job uses.
   *
   * That response is not evidence about the job, so it must behave like every other
   * unresolved failure: no cleanup authority, no DELETE, no second submission, the
   * session record and the staging snapshot both intact, and the run still blocked.
   * It is asserted for BOTH shapes the browser can see — the raw upstream body (in
   * case the transport guard is ever bypassed) and the code-first 502 the BFF now
   * relabels it to.
   */
  async function expectStrandedButSafe(
    rosterResponse: () => Response,
    // Whether repeating the request could plausibly help. The two shapes differ
    // here and only here: a bare 404 proves nothing about the route, so Retry is
    // still honest; a `backend_route_unsupported` 502 proves the service has no
    // roster route, so offering Retry would be the screenshot's futile loop.
    expectRetry: boolean,
  ) {
    await readyStore();
    const store = freshStore();
    const sessionStorage = memStorage();
    const owners: string[] = [];
    let posts = 0;
    let deletes = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return json(202, baseJob());
      }
      if (u.endsWith("/events")) return streamResponse("");
      if (u.endsWith("/xlsx")) return xlsxResponse();
      if (u.endsWith("/roster")) return rosterResponse();
      if (/\/api\/optimize\/[^/]+$/.test(u) && method === "DELETE") {
        deletes += 1;
        return new Response(null, { status: 204 });
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
      throw new Error(`unexpected request: ${u}`);
    });

    const first = render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        {...captureWiring(store, owners, sessionStorage)}
      />,
      { wrapper },
    );

    await submitAndSettle();

    const notice = await waitFor(() => screen.getByTestId("optimize-capture-fetch-failed"), {
      timeout: CAPTURE_TIMEOUT,
    });
    // Honest and NOT the job-gone copy: nothing here proves the job is gone, so the
    // permanent "no longer available on the server" wording must not appear.
    expect(notice).toHaveTextContent(/could not be saved/i);
    expect(notice).not.toHaveTextContent(/no longer available on the server/i);
    if (expectRetry) {
      expect(screen.getByTestId("optimize-capture-retry")).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
    }

    // ZERO destructive authority. The server job, the durable session record and
    // the staging snapshot all survive, so a Retry against a repaired backend can
    // still complete the capture.
    expect(deletes).toBe(0);
    expect(getRosterCaptureGate().getToken("opt_1")).toBeNull();
    expect(optimizeRecords(sessionStorage)).toHaveLength(1);
    expect(owners).toHaveLength(1);
    expect(await store.readSubmissionSnapshot(owners[0])).not.toBeNull();
    expect(await store.readCurrentCandidate()).toBeNull();

    // NOT blocking on the next visit. The deployment mismatch is real and the run
    // is genuinely unresolved — both still true — but neither is the next visit's
    // problem: returning is fresh, and the exact Optimize action is live.
    first.unmount();
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={onlineInfo()}
        {...captureWiring(store, owners, sessionStorage)}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled(), {
      timeout: CAPTURE_TIMEOUT,
    });
    expect(screen.queryByText(/still running/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-capture-fetch-failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
    // ...and the old run's unfinished state cost the visit nothing: no second POST
    // has been sent because the user has not clicked yet.
    expect(posts).toBe(1);
    expect(deletes).toBe(0);
    return notice;
  }

  it(
    "G6.1: a GENERIC 404 {detail:'Not Found'} never becomes job-gone — zero DELETE, zero second POST, record and snapshot retained",
    () =>
      // A bare 404 says nothing about whether the route exists, so Retry remains
      // the honest offer at this layer. The BFF guard is what turns this shape
      // into a proven verdict — see the 502 case below.
      expectStrandedButSafe(() => json(404, { detail: "Not Found" }), true).then((notice) => {
        // The bare framework wording is exactly what the user reported seeing.
        expect(notice).toHaveTextContent(/Not Found/);
      }),
    TEST_TIMEOUT,
  );

  it(
    "G6.1: the BFF's backend_route_unsupported 502 keeps the same safe verdict, states the real recovery, and offers NO Retry",
    () =>
      expectStrandedButSafe(
        () =>
          json(502, {
            error: {
              code: "backend_route_unsupported",
              message:
                "The scheduling service this app is connected to does not support saving rosters, so it needs to be updated before rosters can be saved here.",
            },
          }),
        // The screenshot's futile loop, closed: the service has no roster route,
        // so no button may re-send a request that can only fail identically.
        false,
      ).then((notice) => {
        // Same authority verdict, actionable copy instead of "Not Found".
        expect(notice).toHaveTextContent(/does not support saving rosters/i);
        expect(notice).toHaveTextContent(/needs to be updated/i);
        expect(notice).not.toHaveTextContent(/Not Found/);
      }),
    TEST_TIMEOUT,
  );
});

describe("OptimizeAndExportScreen — G4 dedicated /roster route", () => {
  // G4 closure — the full F4 RosterSection was removed from this screen.
  // The dedicated /roster page owns it; this screen surfaces the prototype's
  // `Open & adjust roster` CTA only when the capture gate committed a
  // loadable candidate for the run in view. With real IndexedDB the capture
  // gate can actually advance, so the CTA's negative + positive controls
  // are discriminable here (the IndexedDB-free file can only assert absence).

  it(
    "renders no embedded F4 RosterSection anywhere on the screen",
    async () => {
      await readyStore();
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
        if (u.endsWith("/roster")) return json(200, fixtureContainer());
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });
      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          controllerDeps={{
            prepare: () => okPrep,
            storage: memStorage(),
            createOwnerId: () => "o-g4",
          }}
          terminalDeps={{
            fetchXlsx: vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" })),
          }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
      await userEvent.click(screen.getByTestId("optimize-submit"));
      await waitFor(
        () => expect(screen.getByTestId("optimize-completed-artifact")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      // The dedicated /roster route owns the viewer; this screen mounts NONE
      // of the four roster-section testids, neither loaded nor empty.
      expect(screen.queryByTestId("roster-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("roster-section-empty")).not.toBeInTheDocument();
      expect(screen.queryByTestId("roster-section-loading")).not.toBeInTheDocument();
      expect(screen.queryByTestId("roster-section-unavailable")).not.toBeInTheDocument();
    },
    TEST_TIMEOUT,
  );

  it(
    "renders the `Open & adjust roster` CTA ONLY when the capture gate committed for the run in view",
    async () => {
      await readyStore();
      routeFetch((u, init) => {
        const method = init?.method ?? "GET";
        if (u.endsWith("/api/optimize") && method === "POST") return json(202, baseJob());
        if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
        if (u.endsWith("/roster")) return json(200, fixtureContainer());
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, completedJob);
        throw new Error(`unexpected request: ${u}`);
      });
      render(
        <OptimizeAndExportScreen
          serverInfoDeps={onlineInfo()}
          controllerDeps={{
            prepare: () => okPrep,
            storage: memStorage(),
            createOwnerId: () => "o-g4-cta",
          }}
          terminalDeps={{
            fetchXlsx: vi.fn(async () => ({ blob: new Blob(["x"]), filename: "schedule.xlsx" })),
          }}
        />,
        { wrapper },
      );
      await waitFor(() => expect(screen.getByTestId("optimize-submit")).toBeEnabled());
      // Before any run lands, no CTA: the screen refuses to claim a roster exists.
      expect(screen.queryByTestId("optimize-open-roster")).not.toBeInTheDocument();

      await userEvent.click(screen.getByTestId("optimize-submit"));
      await waitFor(
        () => expect(screen.getByTestId("optimize-completed-artifact")).toBeInTheDocument(),
        { timeout: CAPTURE_TIMEOUT },
      );
      // Once the capture gate commits a loadable candidate for opt_1, the CTA
      // appears, anchored to /roster and routing through the shared guarded
      // boundary the rest of the panel uses.
      const cta = await screen.findByTestId("optimize-open-roster");
      expect(cta).toHaveAttribute("href", "/roster");
      expect(cta).toHaveTextContent("Open & adjust roster");
    },
    TEST_TIMEOUT,
  );
});
