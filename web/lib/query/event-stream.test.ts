import { describe, expect, it, vi } from "vitest";
import { OptimizeApiError } from "@/lib/bff/errors";
import type { OptimizeJobResponse } from "@/lib/bff/types";
import { type OptimizeEventLoopDeps, runOptimizeEventLoop } from "@/lib/query/event-stream";
import type { StreamOutcome } from "@/lib/query/sse";

const runningJob = { status: "running" } as unknown as OptimizeJobResponse;
const doneJob = { status: "optimal" } as unknown as OptimizeJobResponse;

function deps(overrides: Partial<OptimizeEventLoopDeps>): OptimizeEventLoopDeps {
  return {
    maxReconnects: 2,
    isCancelled: () => false,
    connect: async () => ({ type: "closed" }) as StreamOutcome,
    pollJob: async () => runningJob,
    delay: async () => {},
    onFrame: () => {},
    ...overrides,
  };
}

describe("runOptimizeEventLoop", () => {
  it("stops on a terminal frame without polling", async () => {
    const onTerminal = vi.fn();
    const pollJob = vi.fn(async () => runningJob);

    await runOptimizeEventLoop(
      deps({
        connect: async () => ({ type: "terminal", frame: { event: "complete", data: "{}" } }),
        pollJob,
        onTerminal,
      }),
    );

    expect(onTerminal).toHaveBeenCalledOnce();
    expect(pollJob).not.toHaveBeenCalled();
  });

  it("classifies an exact expired 404 error-response and stops without polling", async () => {
    const onExpired = vi.fn();
    const pollJob = vi.fn(async () => runningJob);

    await runOptimizeEventLoop(
      deps({
        connect: async () => ({
          type: "error-response",
          status: 404,
          body: { detail: "Optimization job not found" },
        }),
        pollJob,
        onExpired,
      }),
    );

    expect(onExpired).toHaveBeenCalledOnce();
    expect(pollJob).not.toHaveBeenCalled();
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

  it("stops on an expired job discovered by polling after a network failure", async () => {
    const onExpired = vi.fn();
    const onError = vi.fn();

    await runOptimizeEventLoop(
      deps({
        connect: async () => {
          throw new Error("network dropped");
        },
        pollJob: async () => {
          throw new OptimizeApiError(404, "Optimization job not found", "poll");
        },
        onExpired,
        onError,
      }),
    );

    expect(onExpired).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats a transient poll failure as retryable and surfaces onError after the budget", async () => {
    const connect = vi.fn(async () => {
      throw new Error("stream failed");
    });
    const onError = vi.fn();

    await runOptimizeEventLoop(
      deps({
        maxReconnects: 1,
        connect,
        pollJob: async () => {
          throw new OptimizeApiError(500, "upstream unreachable", "poll");
        },
        onError,
      }),
    );

    expect(connect).toHaveBeenCalledTimes(2); // reconnect 1, then 2 > 1 → onError
    expect(onError).toHaveBeenCalledOnce();
  });

  it("stops immediately when a poll reveals a terminal status", async () => {
    const onError = vi.fn();
    const onTerminal = vi.fn();

    await runOptimizeEventLoop(
      deps({
        connect: async () => ({ type: "closed" }),
        pollJob: async () => doneJob,
        onError,
        onTerminal,
      }),
    );

    expect(onError).not.toHaveBeenCalled();
    // The loop stops on the terminal poll; onTerminal is only for terminal frames.
  });

  it("resets the reconnect budget after a connection that delivered new frames", async () => {
    let connectCalls = 0;
    const onError = vi.fn();

    await runOptimizeEventLoop(
      deps({
        maxReconnects: 2,
        connect: async (onFrame) => {
          connectCalls += 1;
          onFrame({ event: "progress", data: "{}" }); // progress each round
          return { type: "closed" };
        },
        pollJob: async () => runningJob, // still running → reconnect
        // Stop the otherwise-endless healthy loop after 4 rounds.
        isCancelled: () => connectCalls >= 4,
        onError,
      }),
    );

    // With per-progress budget reset, 4 reconnects with maxReconnects=2 never
    // exhaust the budget → no onError (without the reset, it would fire at #3).
    expect(connectCalls).toBe(4);
    expect(onError).not.toHaveBeenCalled();
  });
});
