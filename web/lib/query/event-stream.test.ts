import { describe, expect, it, vi } from "vitest";
import { OptimizeApiError } from "@/lib/bff/errors";
import type { JobResponse } from "@/lib/bff/types";
import { type OptimizeEventLoopDeps, runOptimizeEventLoop } from "@/lib/query/event-stream";
import { parseStrictTerminalFrame } from "@/lib/query/event-payloads";
import type { StreamOutcome } from "@/lib/query/sse";

const job = (over: Partial<JobResponse> = {}): JobResponse => ({
  id: "job-A",
  state: "running",
  terminal: false,
  queue_position: null,
  created_at: "2026-07-20T00:00:00Z",
  started_at: "2026-07-20T00:00:01Z",
  finished_at: null,
  request: {
    input_name: "scenario.yaml",
    solver: "ortools/cp-sat",
    prettify: null,
    timeout_seconds: 60,
  },
  result: null,
  error: null,
  controls: { cancellable: true, early_completion_available: true },
  links: {
    self: "/optimize/job-A",
    events: "/optimize/job-A/events",
    cancellation: "/optimize/job-A/cancel",
    early_completion: "/optimize/job-A/finish-now",
    schedule: null,
  },
  ...over,
});
const runningJob = job();
const completedJob = job({
  state: "completed",
  terminal: true,
  finished_at: "2026-07-20T00:01:00Z",
  controls: { cancellable: false, early_completion_available: false },
  result: {
    outcome: "optimal",
    score: 7,
    solver_status: "OPTIMAL",
    termination_reason: "optimality_proven",
  },
  links: {
    ...job().links,
    schedule: "/optimize/job-A/xlsx",
  },
});

const errorEnvelope = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: code, ...extra },
});

function deps(overrides: Partial<OptimizeEventLoopDeps>): OptimizeEventLoopDeps {
  return {
    maxReconnects: 2,
    isCancelled: () => false,
    connect: async () => ({ type: "closed" }) as StreamOutcome,
    pollJob: async () => runningJob,
    delay: async () => {},
    resetCursor: () => {},
    onFrame: () => {},
    ...overrides,
  };
}

const terminalFrame = parseStrictTerminalFrame({
  id: "v1.j.9",
  event: "job.state_changed",
  data: JSON.stringify({
    occurred_at: "2026-07-20T00:01:00+00:00",
    state: "completed",
    terminal: true,
    queue_position: null,
    cancel_requested: false,
    early_completion_requested: false,
    controls: { cancellable: false, early_completion_available: false },
  }),
})!;

describe("runOptimizeEventLoop", () => {
  it("delivers terminal source proof after the response resolves even when abort won", async () => {
    let cancelled = false;
    let resolve!: (outcome: StreamOutcome) => void;
    const connect = vi.fn(
      () =>
        new Promise<StreamOutcome>((done) => {
          resolve = done;
        }),
    );
    const onTerminalProof = vi.fn();
    const onTerminal = vi.fn();
    const pollJob = vi.fn(async () => completedJob);
    const running = runOptimizeEventLoop(
      deps({
        connect,
        pollJob,
        isCancelled: () => cancelled,
        onTerminalProof,
        onTerminal,
      }),
    );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    cancelled = true;
    resolve({ type: "terminal", frame: terminalFrame });
    await running;

    expect(onTerminalProof).toHaveBeenCalledWith({ frame: terminalFrame });
    expect(onTerminal).not.toHaveBeenCalled();
    expect(pollJob).not.toHaveBeenCalled();
  });

  it("does not accept an injected terminal flag as source proof after abort", async () => {
    let cancelled = false;
    let resolve!: (outcome: StreamOutcome) => void;
    const connect = vi.fn(
      () =>
        new Promise<StreamOutcome>((done) => {
          resolve = done;
        }),
    );
    const onTerminalProof = vi.fn();
    const pollJob = vi.fn(async () => completedJob);
    const running = runOptimizeEventLoop(
      deps({ connect, pollJob, isCancelled: () => cancelled, onTerminalProof }),
    );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    cancelled = true;
    resolve({
      type: "terminal",
      frame: {
        id: "v1.j.bad",
        event: "job.state_changed",
        data: '{"state":"running","terminal":true}',
      },
    } as unknown as StreamOutcome);
    await running;

    expect(onTerminalProof).not.toHaveBeenCalled();
    expect(pollJob).not.toHaveBeenCalled();
  });

  it("delivers job-gone source proof after the response resolves even when abort won", async () => {
    let cancelled = false;
    let resolve!: (outcome: StreamOutcome) => void;
    const connect = vi.fn(
      () =>
        new Promise<StreamOutcome>((done) => {
          resolve = done;
        }),
    );
    const onJobGoneProof = vi.fn();
    const onJobGone = vi.fn();
    const pollJob = vi.fn(async () => runningJob);
    const running = runOptimizeEventLoop(
      deps({
        connect,
        pollJob,
        isCancelled: () => cancelled,
        onJobGoneProof,
        onJobGone,
      }),
    );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    cancelled = true;
    resolve({ type: "error-response", status: 404, body: errorEnvelope("job_not_found") });
    await running;

    expect(onJobGoneProof).toHaveBeenCalledOnce();
    expect(onJobGone).not.toHaveBeenCalled();
    expect(pollJob).not.toHaveBeenCalled();
  });

  it.each([
    [500, errorEnvelope("job_not_found")],
    [404, { error: { code: "job_not_found" } }],
    [404, { error: { code: "job_not_found", message: "gone", extra: true } }],
  ])("does not grant gone proof to a degraded %s response", async (status, body) => {
    let cancelled = false;
    let resolve!: (outcome: StreamOutcome) => void;
    const connect = vi.fn(
      () =>
        new Promise<StreamOutcome>((done) => {
          resolve = done;
        }),
    );
    const onJobGoneProof = vi.fn();
    const running = runOptimizeEventLoop(
      deps({ connect, isCancelled: () => cancelled, onJobGoneProof }),
    );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    cancelled = true;
    resolve({ type: "error-response", status, body });
    await running;
    expect(onJobGoneProof).not.toHaveBeenCalled();
  });

  it("suppresses a cancelled nonterminal response without proof or recovery", async () => {
    let cancelled = false;
    let resolve!: (outcome: StreamOutcome) => void;
    const connect = vi.fn(
      () =>
        new Promise<StreamOutcome>((done) => {
          resolve = done;
        }),
    );
    const onTerminalProof = vi.fn();
    const onJobGoneProof = vi.fn();
    const pollJob = vi.fn(async () => runningJob);
    const running = runOptimizeEventLoop(
      deps({
        connect,
        pollJob,
        isCancelled: () => cancelled,
        onTerminalProof,
        onJobGoneProof,
      }),
    );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    cancelled = true;
    resolve({ type: "closed" });
    await running;

    expect(onTerminalProof).not.toHaveBeenCalled();
    expect(onJobGoneProof).not.toHaveBeenCalled();
    expect(pollJob).not.toHaveBeenCalled();
  });

  it("on a terminal frame, polls once for the full job and stops", async () => {
    const onTerminal = vi.fn();
    const pollJob = vi.fn(async () => completedJob);

    await runOptimizeEventLoop(
      deps({
        connect: async () => ({ type: "terminal", frame: terminalFrame }),
        pollJob,
        onTerminal,
      }),
    );

    expect(pollJob).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith({ frame: terminalFrame, job: completedJob });
  });

  it("surfaces a worker_lost terminal failure through the refreshed job", async () => {
    const workerLost = job({
      state: "failed",
      terminal: true,
      finished_at: "2026-07-20T00:01:00Z",
      error: { code: "worker_lost", message: "The worker was lost." },
      controls: { cancellable: false, early_completion_available: false },
    });
    const onTerminal = vi.fn();

    await runOptimizeEventLoop(
      deps({
        connect: async () => ({
          type: "terminal",
          frame: parseStrictTerminalFrame({
            id: "v1.j.9",
            event: "job.state_changed",
            data: JSON.stringify({
              occurred_at: "2026-07-20T00:01:00+00:00",
              state: "failed",
              terminal: true,
              queue_position: null,
              cancel_requested: false,
              early_completion_requested: false,
              controls: { cancellable: false, early_completion_available: false },
              error: { code: "worker_lost", message: "The worker was lost." },
            }),
          })!,
        }),
        pollJob: async () => workerLost,
        onTerminal,
      }),
    );

    expect(onTerminal.mock.calls[0][0].job.error.code).toBe("worker_lost");
  });

  it("stops and fires onJobGone on a code-first job_not_found, without polling", async () => {
    const onJobGone = vi.fn();
    const pollJob = vi.fn(async () => runningJob);

    await runOptimizeEventLoop(
      deps({
        connect: async () => ({
          type: "error-response",
          status: 404,
          body: errorEnvelope("job_not_found"),
        }),
        pollJob,
        onJobGone,
      }),
    );

    expect(onJobGone).toHaveBeenCalledOnce();
    expect(pollJob).not.toHaveBeenCalled();
  });

  it("recovers from event_cursor_expired: clears history, resets the cursor, reconnects while running", async () => {
    const onCursorExpired = vi.fn();
    const resetCursor = vi.fn();
    let connectCalls = 0;

    await runOptimizeEventLoop(
      deps({
        connect: async () => {
          connectCalls += 1;
          if (connectCalls === 1) {
            return {
              type: "error-response",
              status: 409,
              body: errorEnvelope("event_cursor_expired", { oldest_event_id: "v1.j.5" }),
            };
          }
          return { type: "terminal", frame: terminalFrame };
        },
        pollJob: async () => (connectCalls >= 2 ? completedJob : runningJob),
        onCursorExpired,
        resetCursor,
      }),
    );

    expect(onCursorExpired).toHaveBeenCalledOnce();
    expect(onCursorExpired.mock.calls[0][0].oldestEventId).toBe("v1.j.5");
    expect(resetCursor).toHaveBeenCalledOnce();
    expect(connectCalls).toBe(2); // reconnected after clearing the cursor
  });

  it("fires onCursorReset AFTER resetCursor and BEFORE the cursorless reconnect (expired)", async () => {
    const order: string[] = [];
    let connectCalls = 0;

    await runOptimizeEventLoop(
      deps({
        connect: async () => {
          connectCalls += 1;
          order.push(`connect#${connectCalls}`);
          if (connectCalls === 1) {
            return {
              type: "error-response",
              status: 409,
              body: errorEnvelope("event_cursor_expired", { oldest_event_id: "v1.j.5" }),
            };
          }
          return { type: "terminal", frame: terminalFrame };
        },
        pollJob: async () => (connectCalls >= 2 ? completedJob : runningJob),
        resetCursor: () => order.push("reset"),
        onCursorReset: () => order.push("notify-reset"),
      }),
    );

    // The tracker is cleared, then the persisted-cursor clear fires, then reconnect.
    expect(order).toEqual(["connect#1", "reset", "notify-reset", "connect#2"]);
  });

  it("fires onCursorReset on invalid_event_cursor recovery too", async () => {
    const onCursorReset = vi.fn();
    const resetCursor = vi.fn();
    let connectCalls = 0;

    await runOptimizeEventLoop(
      deps({
        maxReconnects: 1,
        connect: async () => {
          connectCalls += 1;
          return connectCalls === 1
            ? { type: "error-response", status: 400, body: errorEnvelope("invalid_event_cursor") }
            : { type: "terminal", frame: terminalFrame };
        },
        pollJob: async () => (connectCalls >= 2 ? completedJob : runningJob),
        resetCursor,
        onCursorReset,
      }),
    );

    expect(resetCursor).toHaveBeenCalledOnce();
    expect(onCursorReset).toHaveBeenCalledOnce();
  });

  it("does NOT fire onCursorReset on a plain 5xx (no cursor recovery)", async () => {
    const onCursorReset = vi.fn();

    await runOptimizeEventLoop(
      deps({
        maxReconnects: 1,
        connect: async () => ({ type: "error-response", status: 500, body: null }),
        pollJob: async () => runningJob,
        onCursorReset,
      }),
    );

    expect(onCursorReset).not.toHaveBeenCalled();
  });

  it("recovers from invalid_event_cursor distinctly and resets the cursor", async () => {
    const onCursorInvalid = vi.fn();
    const onCursorExpired = vi.fn();
    const resetCursor = vi.fn();
    let connectCalls = 0;

    await runOptimizeEventLoop(
      deps({
        maxReconnects: 1,
        connect: async () => {
          connectCalls += 1;
          return connectCalls === 1
            ? { type: "error-response", status: 400, body: errorEnvelope("invalid_event_cursor") }
            : { type: "terminal", frame: terminalFrame };
        },
        pollJob: async () => (connectCalls >= 2 ? completedJob : runningJob),
        onCursorInvalid,
        onCursorExpired,
        resetCursor,
      }),
    );

    expect(onCursorInvalid).toHaveBeenCalledOnce();
    expect(onCursorExpired).not.toHaveBeenCalled();
    expect(resetCursor).toHaveBeenCalledOnce();
  });

  it("treats a close without a terminal frame as a disconnect: polls and reconnects while running (never cancels)", async () => {
    let connectCalls = 0;
    const cancelSpy = vi.fn(); // there is no cancel in the loop; assert it is never wired

    await runOptimizeEventLoop(
      deps({
        connect: async () => {
          connectCalls += 1;
          return { type: "closed" };
        },
        pollJob: async () => (connectCalls >= 3 ? completedJob : runningJob),
      }),
    );

    expect(connectCalls).toBe(3); // reconnected twice while running, then poll-terminal stopped
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("stops when a poll reveals a terminal job after an ambiguous close", async () => {
    const onTerminal = vi.fn();

    await runOptimizeEventLoop(
      deps({
        connect: async () => ({ type: "closed" }),
        pollJob: async () => completedJob,
        onTerminal,
      }),
    );

    expect(onTerminal).toHaveBeenCalledWith({ job: completedJob });
  });

  it("retries an initial 5xx via poll and surfaces onError after the budget", async () => {
    const connect = vi.fn(
      async (): Promise<StreamOutcome> => ({ type: "error-response", status: 500, body: null }),
    );
    const delay = vi.fn(async () => {});
    const onError = vi.fn();

    await runOptimizeEventLoop(
      deps({ maxReconnects: 2, connect, pollJob: async () => runningJob, delay, onError }),
    );

    // budget 2 ⇒ attempts at reconnects 1, 2, then 3 > 2 triggers onError.
    expect(connect).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("stops (job gone) when polling after a network failure returns job_not_found", async () => {
    const onJobGone = vi.fn();
    const onError = vi.fn();

    await runOptimizeEventLoop(
      deps({
        connect: async () => {
          throw new Error("network dropped");
        },
        pollJob: async () => {
          throw new OptimizeApiError(
            404,
            { error: { code: "job_not_found", message: "gone" } },
            "poll",
          );
        },
        onJobGone,
        onError,
      }),
    );

    expect(onJobGone).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("recovers after a frame application throws: reconnects, keeps the budget, no onError", async () => {
    let connectCalls = 0;
    let threwOnce = false;
    const onError = vi.fn();

    await runOptimizeEventLoop(
      deps({
        maxReconnects: 1,
        // First frame application throws (cache/consumer failure) → the injected
        // connect rejects; the loop must poll + reconnect, not surface onError.
        onFrame: () => {
          if (!threwOnce) {
            threwOnce = true;
            throw new Error("apply failed");
          }
        },
        connect: async (onFrame) => {
          connectCalls += 1;
          if (connectCalls === 1) {
            await onFrame({ id: "v1.j.1", event: "job.progressed", data: "{}" }); // rejects out of connect
            return { type: "closed" };
          }
          return { type: "terminal", frame: terminalFrame };
        },
        pollJob: async () => (connectCalls >= 2 ? completedJob : runningJob),
        onError,
      }),
    );

    expect(connectCalls).toBe(2); // reconnected once after the throw
    expect(onError).not.toHaveBeenCalled(); // a throwing frame did not falsely reset or exhaust the budget
  });

  it("resets the reconnect budget after a connection that delivered new frames", async () => {
    let connectCalls = 0;
    const onError = vi.fn();

    await runOptimizeEventLoop(
      deps({
        maxReconnects: 2,
        connect: async (onFrame) => {
          connectCalls += 1;
          await onFrame({ id: `v1.j.${connectCalls}`, event: "job.progressed", data: "{}" });
          return { type: "closed" };
        },
        pollJob: async () => runningJob,
        isCancelled: () => connectCalls >= 4,
        onError,
      }),
    );

    expect(connectCalls).toBe(4);
    expect(onError).not.toHaveBeenCalled();
  });
});
