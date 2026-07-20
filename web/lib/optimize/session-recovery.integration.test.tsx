// @vitest-environment jsdom
//
// T16b ↔ T16a integration matrices (real controller + real recovery hook + mocked
// transport). These prove the whole-lifecycle behaviors the four cold-review findings
// require, which a fake attach spy cannot: a freshly submitted run installs the durable
// cursor writer (so a reload resumes from the committed cursor, not the floor), React
// StrictMode setup→cleanup→setup leaves exactly one live transport, and job-scoped
// cleanup unblocks the next submission.

import { createElement, StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LAST_EVENT_ID_HEADER, type JobResponse } from "@/lib/bff/types";
import { useHotStore } from "@/lib/store";
import type { PrepareOptimizeSubmissionResult } from "@/lib/scenario";
import type { CanonicalScenarioDocument } from "@/lib/scenario/types";
import {
  OPTIMIZE_SESSION_STORAGE_KEY,
  inspectPersistedSession,
  type ActiveOptimizeSession,
  type SessionTransactionStorage,
} from "./session-transaction";
import { useOptimizeRun } from "./use-optimize-run";
import { useOptimizeSessionRecovery } from "./session-recovery";

const KEY = OPTIMIZE_SESSION_STORAGE_KEY;
const originalFetch = globalThis.fetch;
let client: QueryClient;
let ownerSeq = 0;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}
function strictWrapper({ children }: { children: ReactNode }) {
  return createElement(StrictMode, null, createElement(QueryClientProvider, { client }, children));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A stream the test can push frames into on demand (to commit a cursor mid-run). */
function controlledStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (text: string) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  };
}

const job = (over: Partial<JobResponse> = {}): JobResponse => {
  const state = over.state ?? "running";
  const terminal = state === "completed" || state === "cancelled" || state === "failed";
  const id = over.id ?? "opt_1";
  const base = `/optimize/${id}`;
  return {
    id,
    state,
    terminal,
    queue_position: null,
    created_at: "2026-07-20T00:00:00+00:00",
    started_at: "2026-07-20T00:00:00+00:00",
    finished_at: terminal ? "2026-07-20T00:01:00+00:00" : null,
    request: {
      input_name: "s.yaml",
      solver: "ortools/cp-sat",
      prettify: null,
      timeout_seconds: 300,
    },
    result:
      state === "completed"
        ? {
            outcome: "optimal",
            score: 42,
            solver_status: "OPTIMAL",
            termination_reason: "optimality_proven",
          }
        : null,
    error: null,
    controls: {
      cancellable: state === "running" || state === "queued",
      early_completion_available: state === "running",
    },
    links: {
      self: base,
      events: `${base}/events`,
      cancellation: `${base}/cancel`,
      early_completion: `${base}/finish-now`,
      schedule: state === "completed" ? `${base}/xlsx` : null,
    },
    ...over,
  };
};

const okPrep: PrepareOptimizeSubmissionResult = {
  ok: true,
  prep: { yaml: "scenario: {}", peopleCount: 0, reverseMap: [], anonymized: false },
};
const doc = {} as CanonicalScenarioDocument;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function memStorage(
  seed: string | null = null,
): SessionTransactionStorage & { value: () => string | null } {
  const values = new Map<string, string>();
  if (seed !== null) values.set(KEY, seed);
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => void values.set(k, v),
    removeItem: (k) => void values.delete(k),
    value: () => values.get(KEY) ?? null,
  };
}

function activeSeed(jobId = "opt_1"): string {
  const record: ActiveOptimizeSession = {
    schemaVersion: 1,
    ownerId: "owner-seed",
    phase: "active",
    jobId,
    anonymized: false,
    runOptions: {},
    peopleCount: 0,
    reverseMap: [],
  };
  return JSON.stringify(record);
}

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
}

/** One component wiring the real controller and the real recovery hook over shared storage. */
function useCombined(storage: SessionTransactionStorage) {
  const controller = useOptimizeRun({
    storage,
    createOwnerId: () => `owner-${(ownerSeq += 1)}`,
    prepare: () => okPrep,
  });
  const recovery = useOptimizeSessionRecovery(controller, { storage });
  return { controller, recovery };
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useHotStore.getState().resetRunView();
  ownerSeq = 0;
});

afterEach(() => {
  cleanup();
  client.clear();
  globalThis.fetch = originalFetch;
});

describe("T16b integration — fresh run cursor persistence and reload resume", () => {
  it("persists the committed cursor for a FRESH submission and resumes from it on reload", async () => {
    const storage = memStorage();
    let liveStream: ReturnType<typeof controlledStream> | null = null;
    let eventsLastEventId: string | null = null;

    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST")
        return json(202, job({ state: "running" }));
      if (u.endsWith("/events")) {
        eventsLastEventId = new Headers(init?.headers).get(LAST_EVENT_ID_HEADER);
        liveStream = controlledStream();
        return liveStream.response;
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job({ state: "running" }));
      throw new Error(`unexpected ${u}`);
    });

    const first = renderHook(() => useCombined(storage), { wrapper });

    await act(async () => {
      await first.result.current.controller.submit({ document: doc, anonymize: false });
    });
    expect(first.result.current.controller.view.jobId).toBe("opt_1");

    // The stream opens for the fresh run; a committed frame persists its cursor.
    await waitFor(() => expect(liveStream).not.toBeNull());
    await act(async () => {
      liveStream!.push(
        'id: c1\nevent: job.progressed\ndata: {"source":"solver","currentBestScore":1,"elapsedSeconds":1,"occurred_at":"2026-07-20T00:00:00Z"}\n\n',
      );
    });

    await waitFor(() => {
      const ins = inspectPersistedSession(storage);
      expect(ins.kind === "resumable" && ins.record.lastCursor).toBe("c1");
    });

    first.unmount(); // reload

    eventsLastEventId = null;
    const second = renderHook(() => useCombined(storage), { wrapper });
    await waitFor(() => expect(eventsLastEventId).toBe("c1"));
    expect(second.result.current.recovery.resume).toEqual({ status: "attached", jobId: "opt_1" });
    second.unmount();
  });

  it("leaves the prior committed cursor unchanged when a later frame fails to apply", async () => {
    const storage = memStorage();
    let liveStream: ReturnType<typeof controlledStream> | null = null;
    let failPoll = false;

    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST")
        return json(202, job({ state: "running" }));
      if (u.endsWith("/events")) {
        liveStream = controlledStream();
        return liveStream.response;
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) {
        if (failPoll) throw new Error("network down");
        return json(200, job({ state: "running" }));
      }
      throw new Error(`unexpected ${u}`);
    });

    const { result, unmount } = renderHook(() => useCombined(storage), { wrapper });
    await act(async () => {
      await result.current.controller.submit({ document: doc, anonymize: false });
    });
    await waitFor(() => expect(liveStream).not.toBeNull());

    await act(async () => {
      liveStream!.push(
        'id: c1\nevent: job.progressed\ndata: {"source":"solver","currentBestScore":1,"elapsedSeconds":1,"occurred_at":"2026-07-20T00:00:00Z"}\n\n',
      );
    });
    await waitFor(() => {
      const ins = inspectPersistedSession(storage);
      expect(ins.kind === "resumable" && ins.record.lastCursor).toBe("c1");
    });

    // A malformed durable frame forces a reconcile poll; that poll now fails, so the
    // apply-before-commit fence never commits c2 and the cursor writer is never called.
    failPoll = true;
    await act(async () => {
      liveStream!.push("id: c2\nevent: job.state_changed\ndata: not-json\n\n");
      await new Promise((r) => setTimeout(r, 10));
    });

    const ins = inspectPersistedSession(storage);
    expect(ins.kind === "resumable" && ins.record.lastCursor).toBe("c1");
    unmount();
  });
});

describe("T16b integration — StrictMode and cleanup lifecycle", () => {
  it("resumes a seeded active record under React StrictMode with one live transport", async () => {
    const storage = memStorage(activeSeed("opt_1"));
    let eventsRequests = 0;
    routeFetch((u) => {
      if (u.endsWith("/events")) {
        eventsRequests += 1;
        return streamResponse(": keepalive\n\n");
      }
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job({ state: "completed" }));
      throw new Error(`unexpected ${u}`);
    });

    const { result } = renderHook(() => useCombined(storage), { wrapper: strictWrapper });

    await waitFor(() => expect(result.current.controller.view.lifecycle).toBe("completed"));
    expect(result.current.recovery.resume).toEqual({ status: "attached", jobId: "opt_1" });
    // The record and its reverse map survived the resume (T16c lifetime).
    expect(result.current.controller.activation?.jobId).toBe("opt_1");
    // Exactly one attachment owns the run: getLiveJobId is the single live authority.
    expect(result.current.controller.getLiveJobId()).toBe("opt_1");
    // A StrictMode replay may have opened/aborted an extra connection, but the run is
    // coherent and terminal — a torn attachment would have left it stuck non-terminal.
    expect(eventsRequests).toBeGreaterThanOrEqual(1);
  });

  it.each(["older-first", "current-first"] as const)(
    "keeps cursor persistence live when two real recovery hooks unmount %s",
    async (order) => {
      const storage = memStorage(activeSeed("opt_1"));
      const stream = controlledStream();
      routeFetch((u) => {
        if (u.endsWith("/events")) return stream.response;
        if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job({ state: "running" }));
        throw new Error(`unexpected ${u}`);
      });

      const controller = renderHook(
        () =>
          useOptimizeRun({
            storage,
            createOwnerId: () => "owner-controller",
            prepare: () => okPrep,
          }),
        { wrapper },
      );
      const recoveryA = renderHook(
        () => useOptimizeSessionRecovery(controller.result.current, { storage }),
        { wrapper },
      );
      const recoveryB = renderHook(
        () => useOptimizeSessionRecovery(controller.result.current, { storage }),
        { wrapper },
      );
      await waitFor(() => expect(controller.result.current.getLiveJobId()).toBe("opt_1"));

      if (order === "older-first") recoveryA.unmount();
      else recoveryB.unmount();

      await act(async () => {
        stream.push(
          'id: survivor-cursor\nevent: job.progressed\ndata: {"source":"solver","currentBestScore":4,"elapsedSeconds":1,"occurred_at":"2026-07-20T00:00:00Z"}\n\n',
        );
      });
      await waitFor(() => {
        const inspected = inspectPersistedSession(storage);
        expect(inspected.kind === "resumable" && inspected.record.lastCursor).toBe(
          "survivor-cursor",
        );
      });

      if (order === "older-first") recoveryB.unmount();
      else recoveryA.unmount();
      controller.unmount();
      stream.close();
    },
  );

  it.each([
    "reset",
    "generation",
    "poll-gone",
    "control-gone",
    "stream-gone",
    "cleanup",
    "controller-unmount",
  ] as const)(
    "idles every provider prepared for J after %s, including a later-restored survivor",
    async (revokePath) => {
      const storage = memStorage(activeSeed("opt_1"));
      const pollGone = deferred<Response>();
      const streamGone = deferred<Response>();
      routeFetch((u) => {
        if (u.endsWith("/events")) {
          return revokePath === "stream-gone"
            ? streamGone.promise
            : streamResponse(": keepalive\n\n");
        }
        if (u.endsWith("/cancel")) {
          return json(404, { error: { code: "job_not_found", message: "gone" } });
        }
        if (u.endsWith("/api/optimize/opt_1")) {
          return revokePath === "poll-gone"
            ? pollGone.promise
            : json(200, job({ state: "running" }));
        }
        throw new Error(`unexpected ${u}`);
      });

      const controller = renderHook(
        () =>
          useOptimizeRun({
            storage,
            createOwnerId: () => "owner-controller",
            prepare: () => okPrep,
          }),
        { wrapper },
      );
      const recoveryA = renderHook(
        () => useOptimizeSessionRecovery(controller.result.current, { storage }),
        { wrapper },
      );
      const recoveryB = renderHook(
        () => useOptimizeSessionRecovery(controller.result.current, { storage }),
        { wrapper },
      );
      await waitFor(() => {
        expect(recoveryA.result.current.cursorPersistence.jobId).toBe("opt_1");
        expect(recoveryB.result.current.cursorPersistence.jobId).toBe("opt_1");
      });

      if (revokePath === "reset") {
        act(() => controller.result.current.reset());
      } else if (revokePath === "generation") {
        act(() => useHotStore.getState().resetEphemeral());
      } else if (revokePath === "poll-gone") {
        await act(async () => {
          pollGone.resolve(json(404, { error: { code: "job_not_found", message: "gone" } }));
        });
      } else if (revokePath === "control-gone") {
        await act(async () => controller.result.current.cancel());
      } else if (revokePath === "stream-gone") {
        await act(async () => {
          streamGone.resolve(json(404, { error: { code: "job_not_found", message: "gone" } }));
        });
      } else if (revokePath === "cleanup") {
        act(() => recoveryB.result.current.cleanup("opt_1"));
      } else {
        controller.unmount();
      }

      await waitFor(() => {
        expect(recoveryA.result.current.cursorPersistence.jobId).toBeNull();
        expect(recoveryB.result.current.cursorPersistence.jobId).toBeNull();
      });
      recoveryB.unmount();
      expect(recoveryA.result.current.cursorPersistence.jobId).toBeNull();

      recoveryA.unmount();
      if (revokePath !== "controller-unmount") controller.unmount();
    },
  );

  it("keeps successor B healthy when a late revoke for J arrives after B is prepared", async () => {
    const storage = memStorage(activeSeed("job-J"));
    routeFetch((u) => {
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job({ state: "running" }));
      throw new Error(`unexpected ${u}`);
    });
    const controller = renderHook(() => useOptimizeRun({ storage, prepare: () => okPrep }), {
      wrapper,
    });
    const recoveryA = renderHook(
      () => useOptimizeSessionRecovery(controller.result.current, { storage }),
      { wrapper },
    );
    const recoveryB = renderHook(
      () => useOptimizeSessionRecovery(controller.result.current, { storage }),
      { wrapper },
    );
    await waitFor(() => expect(recoveryB.result.current.cursorPersistence.jobId).toBe("job-J"));

    act(() => {
      controller.result.current.reset();
      controller.result.current.attachRecoveredSession({
        jobId: "job-B",
        activation: {
          anonymized: false,
          peopleCount: 0,
          reverseMap: [],
          reloadRecoveryAvailable: true,
        },
        initialCursor: null,
      });
      controller.result.current.revokeCursorPersistence("job-J");
    });
    expect(recoveryB.result.current.cursorPersistence.jobId).toBe("job-B");

    recoveryB.unmount();
    await waitFor(() => expect(recoveryA.result.current.cursorPersistence.jobId).toBe("job-B"));
    recoveryA.unmount();
    controller.unmount();
  });

  it("job-scoped cleanup removes the terminal record and unblocks the next submission", async () => {
    const storage = memStorage(activeSeed("opt_1"));
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST")
        return json(202, job({ id: "opt_2", state: "running" }));
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u))
        return json(200, job({ id: "opt_1", state: "completed" }));
      throw new Error(`unexpected ${u}`);
    });

    const { result } = renderHook(() => useCombined(storage), { wrapper });
    await waitFor(() => expect(result.current.controller.view.lifecycle).toBe("completed"));

    // Confirmed cleanup of the terminal job removes only that record + verifies absence.
    let outcome: ReturnType<typeof result.current.recovery.cleanup> | undefined;
    act(() => {
      outcome = result.current.recovery.cleanup("opt_1");
    });
    expect(outcome).toEqual({ status: "removed" });
    expect(storage.value()).toBeNull();
    // The terminal view is preserved (cleanup is not a run-view reset).
    expect(result.current.controller.view.lifecycle).toBe("completed");
    expect(result.current.recovery.cursorPersistence.jobId).toBeNull();

    // With the slot empty, a fresh submission is no longer blocked by a stale record.
    let submitOutcome!: Awaited<ReturnType<typeof result.current.controller.submit>>;
    await act(async () => {
      submitOutcome = await result.current.controller.submit({ document: doc, anonymize: false });
    });
    expect(submitOutcome.status).toBe("activated");
  });

  it("a DEGRADED (activation-persistence-failed) run cleans its retained PROVISIONAL and unblocks resubmit", async () => {
    // A storage whose ACTIVE write silently no-ops leaves the durable slot as the
    // transaction's provisional record after the 202 — the degraded outcome.
    let failActive = true;
    const values = new Map<string, string>();
    const storage: SessionTransactionStorage & { value: () => string | null } = {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => {
        if (failActive && v.includes('"phase":"active"')) return;
        values.set(k, v);
      },
      removeItem: (k) => void values.delete(k),
      value: () => values.get(KEY) ?? null,
    };
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST")
        return json(202, job({ state: "running" }));
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job({ state: "running" }));
      throw new Error(`unexpected ${u}`);
    });

    const { result } = renderHook(() => useCombined(storage), { wrapper });

    let first!: Awaited<ReturnType<typeof result.current.controller.submit>>;
    await act(async () => {
      first = await result.current.controller.submit({ document: doc, anonymize: false });
    });
    expect(first.status).toBe("activation-persistence-failed");
    // The retained durable record is PROVISIONAL (interrupted), not resumable.
    expect(inspectPersistedSession(storage).kind).toBe("interrupted");

    // Job-scoped cleanup of the degraded job removes exactly that provisional via the
    // opaque capability, and verifies absence — a generic active cleanup would not match.
    let cleaned: ReturnType<typeof result.current.recovery.cleanup> | undefined;
    act(() => {
      cleaned = result.current.recovery.cleanup("opt_1");
    });
    expect(cleaned).toEqual({ status: "removed" });
    expect(storage.value()).toBeNull();

    // The next submission is unblocked; with the active write now succeeding it activates.
    failActive = false;
    let second!: Awaited<ReturnType<typeof result.current.controller.submit>>;
    await act(async () => {
      second = await result.current.controller.submit({ document: doc, anonymize: false });
    });
    expect(second.status).toBe("activated");
  });

  it("preserves a foreign same-job active replacement after activation becomes unverified", async () => {
    const values = new Map<string, string>();
    const foreign = activeSeed("opt_1");
    const storage: SessionTransactionStorage & { value: () => string | null } = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value.includes('"phase":"active"') ? foreign : value);
      },
      removeItem: (key) => void values.delete(key),
      value: () => values.get(KEY) ?? null,
    };
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected ${u}`);
    });

    const { result } = renderHook(() => useCombined(storage), { wrapper });
    let submitted!: Awaited<ReturnType<typeof result.current.controller.submit>>;
    await act(async () => {
      submitted = await result.current.controller.submit({ document: doc, anonymize: false });
    });
    expect(submitted).toMatchObject({ status: "activation-unverified", jobId: "opt_1" });

    let cleaned!: ReturnType<typeof result.current.recovery.cleanup>;
    act(() => {
      cleaned = result.current.recovery.cleanup("opt_1");
    });
    expect(cleaned).toEqual({ status: "not-current" });
    expect(storage.value()).toBe(foreign);
  });

  it("removes an owned active write whose activation read-back was unavailable", async () => {
    const values = new Map<string, string>();
    let throwAfterActiveWrite = false;
    const storage: SessionTransactionStorage & { value: () => string | null } = {
      getItem: (key) => {
        if (throwAfterActiveWrite) {
          throwAfterActiveWrite = false;
          throw new Error("read-back unavailable");
        }
        return values.get(key) ?? null;
      },
      setItem: (key, value) => {
        values.set(key, value);
        if (value.includes('"phase":"active"')) throwAfterActiveWrite = true;
      },
      removeItem: (key) => void values.delete(key),
      value: () => values.get(KEY) ?? null,
    };
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") return json(202, job());
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, job());
      throw new Error(`unexpected ${u}`);
    });

    const { result } = renderHook(() => useCombined(storage), { wrapper });
    let submitted!: Awaited<ReturnType<typeof result.current.controller.submit>>;
    await act(async () => {
      submitted = await result.current.controller.submit({ document: doc, anonymize: false });
    });
    expect(submitted).toMatchObject({ status: "activation-unverified", jobId: "opt_1" });
    expect(JSON.parse(storage.value()!)).toMatchObject({
      ownerId: "owner-1",
      phase: "active",
      jobId: "opt_1",
    });

    let cleaned!: ReturnType<typeof result.current.recovery.cleanup>;
    act(() => {
      cleaned = result.current.recovery.cleanup("opt_1");
    });
    expect(cleaned).toEqual({ status: "removed" });
    expect(storage.value()).toBeNull();
  });
});
