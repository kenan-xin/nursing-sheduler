import { describe, expect, it, vi } from "vitest";

import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable, type Subscriber } from "rxjs";

import { RUNTIME_INSTANCE_HEADER } from "./containment";
import { TransientAgentRunner } from "./transient-agent-runner";

// Runner-level contract, isolated from HTTP so retention and settlement can be
// asserted directly on the runner's own state.

const INSTANCE = "launch-a";

type FakeAgent = {
  run: (input: RunAgentInput) => Observable<BaseEvent>;
  abortRun: () => void;
  emit: (event: BaseEvent) => void;
  finish: () => void;
  fail: (error: Error) => void;
  aborted: boolean;
};

function fakeAgent(): FakeAgent {
  let subscriber: Subscriber<BaseEvent> | undefined;
  const agent: FakeAgent = {
    aborted: false,
    run: (input) =>
      new Observable<BaseEvent>((s) => {
        subscriber = s;
        s.next({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId } as BaseEvent);
      }),
    abortRun: () => {
      agent.aborted = true;
    },
    emit: (event) => subscriber?.next(event),
    finish: () => subscriber?.complete(),
    fail: (error) => subscriber?.error(error),
  };
  return agent;
}

function input(threadId: string, runId = `run-${threadId}`): RunAgentInput {
  return {
    threadId,
    runId,
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  } as RunAgentInput;
}

function collect(observable: Observable<BaseEvent>): {
  events: BaseEvent[];
  completed: boolean;
  error?: unknown;
} {
  const result: { events: BaseEvent[]; completed: boolean; error?: unknown } = {
    events: [],
    completed: false,
  };
  observable.subscribe({
    next: (event) => result.events.push(event),
    complete: () => {
      result.completed = true;
    },
    error: (error: unknown) => {
      result.error = error;
    },
  });
  return result;
}

function start(runner: TransientAgentRunner, threadId: string, agent = fakeAgent()) {
  const stream = collect(
    runner.run({
      threadId,
      agent: agent as unknown as Parameters<TransientAgentRunner["run"]>[0]["agent"],
      input: input(threadId),
    }),
  );
  return { agent, stream };
}

describe("TransientAgentRunner", () => {
  it("buffers the synchronous RUN_STARTED so the HTTP consumer never misses it", () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const { stream } = start(runner, "t");

    expect(stream.events.map((e) => e.type)).toEqual(["RUN_STARTED"]);
  });

  it("erases the entry and its buffer on completion", async () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const { agent, stream } = start(runner, "t");

    expect(await runner.isRunning({ threadId: "t" })).toBe(true);

    agent.finish();

    expect(stream.completed).toBe(true);
    expect(runner.activeRunCount()).toBe(0);
    expect(await runner.isRunning({ threadId: "t" })).toBe(false);
    expect(collect(runner.connect({ threadId: "t" })).events).toEqual([]);
  });

  it("erases the entry on error and forwards the failure to attached consumers", async () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const { agent, stream } = start(runner, "t");

    agent.fail(new Error("upstream_failed"));

    expect(stream.error).toBeInstanceOf(Error);
    expect(runner.activeRunCount()).toBe(0);
    expect(collect(runner.connect({ threadId: "t" })).events).toEqual([]);
  });

  it("replays only the current run's events to a mid-flight connect", () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const { agent } = start(runner, "t");
    agent.emit({ type: "TEXT_MESSAGE_CHUNK", delta: "a" } as BaseEvent);

    const attached = collect(runner.connect({ threadId: "t" }));
    expect(attached.events.map((e) => e.type)).toEqual(["RUN_STARTED", "TEXT_MESSAGE_CHUNK"]);

    agent.emit({ type: "TEXT_MESSAGE_CHUNK", delta: "b" } as BaseEvent);
    expect(attached.events).toHaveLength(3);
  });

  it("returns an empty completing stream for an unknown thread", () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const attached = collect(runner.connect({ threadId: "nope" }));

    expect(attached.events).toEqual([]);
    expect(attached.completed).toBe(true);
    expect(attached.error).toBeUndefined();
  });

  it("refuses to attach a connect claiming another launch instance", () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    start(runner, "t");

    const stale = collect(
      runner.connect({ threadId: "t", headers: { [RUNTIME_INSTANCE_HEADER]: "launch-b" } }),
    );
    expect(stale.events).toEqual([]);
    expect(stale.completed).toBe(true);

    // Header casing is not something the caller controls; matching is insensitive.
    const upper = collect(
      runner.connect({ threadId: "t", headers: { "X-Nurse-AI-Runtime-Instance": "launch-b" } }),
    );
    expect(upper.events).toEqual([]);

    const current = collect(
      runner.connect({ threadId: "t", headers: { [RUNTIME_INSTANCE_HEADER]: INSTANCE } }),
    );
    expect(current.events.map((e) => e.type)).toEqual(["RUN_STARTED"]);
  });

  it("stops an active run once and reports every later stop as not-found", async () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const { agent, stream } = start(runner, "t");

    expect(await runner.stop({ threadId: "t" })).toBe(true);
    expect(agent.aborted).toBe(true);
    expect(stream.completed).toBe(true);
    expect(runner.activeRunCount()).toBe(0);

    expect(await runner.stop({ threadId: "t" })).toBe(false);
    expect(await runner.stop({ threadId: "never" })).toBe(false);
  });

  it("never stops a newer run when an older runId is named", async () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const { agent } = start(runner, "t");

    expect(await runner.stop({ threadId: "t", runId: "an-older-run" })).toBe(false);
    expect(agent.aborted).toBe(false);
    expect(await runner.isRunning({ threadId: "t" })).toBe(true);

    expect(await runner.stop({ threadId: "t", runId: "run-t" })).toBe(true);
  });

  it("supersedes a still-active run on the same thread instead of stacking", async () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const first = start(runner, "t");
    const second = start(runner, "t");

    expect(first.agent.aborted).toBe(true);
    expect(first.stream.completed).toBe(true);
    expect(runner.activeRunCount()).toBe(1);

    second.agent.emit({ type: "TEXT_MESSAGE_CHUNK", delta: "only-me" } as BaseEvent);
    expect(first.stream.events).toHaveLength(1);
    expect(second.stream.events).toHaveLength(2);
  });

  it("erases state on app-initiated detachment", async () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const { agent, stream } = start(runner, "t");

    expect(runner.detach("t")).toBe(true);
    expect(agent.aborted).toBe(true);
    expect(stream.completed).toBe(true);
    expect(runner.activeRunCount()).toBe(0);
    expect(runner.detach("t")).toBe(false);
  });

  it("unsubscribes upstream so a stopped run cannot keep pushing events", async () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    const { agent, stream } = start(runner, "t");
    const before = stream.events.length;

    await runner.stop({ threadId: "t" });
    agent.emit({ type: "TEXT_MESSAGE_CHUNK", delta: "late" } as BaseEvent);

    expect(stream.events).toHaveLength(before);
  });

  it("never retains a terminal thread list", async () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    for (const threadId of ["a", "b", "c"]) {
      const { agent } = start(runner, threadId);
      agent.finish();
    }

    expect(runner.activeRunCount()).toBe(0);
    for (const threadId of ["a", "b", "c"]) {
      expect(collect(runner.connect({ threadId })).events).toEqual([]);
      expect(await runner.stop({ threadId })).toBe(false);
    }
  });

  it("does not implement CopilotKit's local thread endpoints", () => {
    const runner = new TransientAgentRunner({ instanceId: INSTANCE });
    // The flag is what makes /info advertise a server-side thread list; leaving it
    // unset is what keeps the runtime out of the transcript-store business.
    expect(runner.ɵsupportsLocalThreadEndpoints).toBeUndefined();
    expect("listThreads" in runner).toBe(false);
    expect("getThreadMessages" in runner).toBe(false);
  });
});

describe("instance identity", () => {
  it("is stable for the life of a launch and distinct across launches", async () => {
    const { getRuntimeInstanceId, resetRuntimeInstanceIdForTest } =
      await import("./instance-identity");

    const first = getRuntimeInstanceId();
    expect(getRuntimeInstanceId()).toBe(first);

    resetRuntimeInstanceIdForTest();
    const second = getRuntimeInstanceId();
    expect(second).not.toBe(first);

    // Bounded non-secret metadata: a random UUID, nothing derived from a credential.
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    vi.restoreAllMocks();
  });
});
