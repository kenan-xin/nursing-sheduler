import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClearDeletion, ClearFence } from "./clear-repo";
import type { DiagnosticCancellationAck } from "./diagnostic-cancellation";
import {
  interrupt,
  SETTLEMENT_WINDOW_MS,
  type InterruptionDeps,
  type InterruptionRequest,
} from "./interruption";
import {
  INTERRUPTION_TRIGGERS,
  readLifecycleLog,
  resetLifecycleLog,
  type InterruptionTrigger,
  type RuntimeStopOutcome,
} from "./lifecycle";
import type { AssistantTurnV1 } from "./records";
import type { WriteOutcome } from "./history-repo";
import { SENTINEL_KEY, TEST_MODEL } from "./test-support";

const TURN: AssistantTurnV1 = {
  turnId: "turn-1",
  schemaVersion: 1,
  threadId: "thread-1",
  scenarioId: "scenario-a",
  basisDocumentRevision: 3,
  leaseEpoch: 1,
  modelId: TEST_MODEL,
  runId: "run-1",
  turnEpoch: 1,
  runtimeInstanceId: "instance-1",
  state: "streaming",
  terminalReason: null,
  interruptionTrigger: null,
  globalGeneration: 0,
  scenarioGeneration: 0,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

type Recorder = {
  deps: InterruptionDeps;
  /** Every turn-state write, in order, as `state:settlement`. */
  turnWrites: string[];
  phases: string[];
  epoch: number;
  /** How many times the runtime stop route was asked. */
  stops: number;
  aborts: number;
  /** Sends and tool calls the fixtures attempted AFTER the gate closed. */
  blocked: string[];
};

const FENCE: ClearFence = {
  scope: "history",
  captured: [{ scopeKey: "scenario:scenario-a", generation: 1 }],
  threadIds: ["thread-1"],
  configurationDeleted: false,
};

const DELETION: ClearDeletion = {
  outcome: "deleted",
  threads: 1,
  messages: 2,
  turns: 1,
  proposals: 0,
  receipts: 0,
};

interface FixtureOptions {
  turns?: AssistantTurnV1[];
  runtime?: RuntimeStopOutcome | (() => Promise<RuntimeStopOutcome>);
  diagnostics?:
    | DiagnosticCancellationAck[]
    | ((signal: AbortSignal) => Promise<DiagnosticCancellationAck[]>);
  /** `true` closes the 15-second window before the cancellation work resolves. */
  timeout?: boolean;
  hasLocalRun?: boolean;
  turnWriteOutcome?: WriteOutcome;
  clearFence?: ClearFence;
}

/**
 * A recording set of dependencies.
 *
 * `settlementWindow` is injected rather than faked with timers so a test can decide
 * the race deterministically -- "the window closed first" and "the work finished
 * first" are the two behaviours under test, and a real 15-second wait would prove
 * neither.
 */
function fixture(options: FixtureOptions = {}): Recorder {
  const turns = options.turns ?? [TURN];
  const recorder: Recorder = {
    deps: {} as InterruptionDeps,
    turnWrites: [],
    phases: [],
    epoch: 7,
    stops: 0,
    aborts: 0,
    blocked: [],
  };

  recorder.deps = {
    now: () => new Date("2026-08-07T12:00:00.000Z"),
    closeGate: () => {
      recorder.epoch += 1;
      return recorder.epoch;
    },
    publishPhase: (phase) => {
      recorder.phases.push(phase);
    },
    readUnsettledTurns: () => Promise.resolve(turns),
    setTurnState: (turnId, input) => {
      recorder.turnWrites.push(`${turnId}:${input.state}:${input.settlement ?? "-"}`);
      return Promise.resolve(options.turnWriteOutcome ?? "accepted");
    },
    abortLocalRun: () => {
      if (options.hasLocalRun === false) return null;
      recorder.aborts += 1;
      return { threadId: "thread-1", runId: "run-1", abort: () => {} };
    },
    requestRuntimeStop: async () => {
      recorder.stops += 1;
      const runtime = options.runtime ?? "stopped";
      return typeof runtime === "function" ? runtime() : runtime;
    },
    cancelDiagnostics: ({ signal }) => {
      const diagnostics = options.diagnostics ?? [];
      return typeof diagnostics === "function" ? diagnostics(signal) : Promise.resolve(diagnostics);
    },
    beginClear: () => Promise.resolve(options.clearFence ?? FENCE),
    finishClear: () => Promise.resolve(DELETION),
    settlementWindow: (ms) => {
      expect(ms).toBe(SETTLEMENT_WINDOW_MS);
      // Resolving immediately closes the window before any awaited work completes;
      // never resolving lets the work win.
      return options.timeout ? Promise.resolve() : new Promise<void>(() => {});
    },
  };

  return recorder;
}

function request(trigger: InterruptionTrigger): InterruptionRequest {
  return { trigger, threadId: "thread-1", scenarioId: "scenario-a" };
}

beforeEach(() => {
  resetLifecycleLog();
});

describe("one controller, every trigger", () => {
  it.each(INTERRUPTION_TRIGGERS)("closes the local gate and settles for %s", async (trigger) => {
    const recorder = fixture();

    const result = await interrupt(request(trigger), recorder.deps);

    expect(result.trigger).toBe(trigger);
    // The epoch ALWAYS advances: that single fact is what closes sends and tool
    // handlers, and it must not depend on which action asked.
    expect(result.closedTurnEpoch).toBe(8);
    expect(recorder.aborts).toBe(1);
    expect(recorder.stops).toBe(1);
    // Truthful ordering, every time: Stopping before Settling before terminal.
    expect(recorder.phases.slice(0, 3)).toEqual(["closing", "cancelling", "settling"]);
  });

  it("closes the gate BEFORE it awaits anything", async () => {
    const order: string[] = [];
    const recorder = fixture();
    const deps: InterruptionDeps = {
      ...recorder.deps,
      closeGate: () => {
        order.push("gate");
        return 1;
      },
      readUnsettledTurns: () => {
        order.push("read");
        return Promise.resolve([TURN]);
      },
      abortLocalRun: () => {
        order.push("abort");
        return null;
      },
    };

    await interrupt(request("stop"), deps);

    // A single `await` before the gate closes is a window in which a streaming
    // callback or a tool handler is still authorised.
    expect(order[0]).toBe("gate");
  });

  it("advances the epoch even when nothing is running, so a stray callback still loses", async () => {
    const recorder = fixture({ turns: [], hasLocalRun: false });

    const result = await interrupt(request("stop"), recorder.deps);

    expect(result.closedTurnEpoch).toBe(8);
    // Nothing to stop is `not_attempted`, which is NOT a failed stop and NOT a
    // synthesised completion.
    expect(result.runtime).toBe("not_attempted");
    expect(recorder.stops).toBe(0);
    expect(result.settlement).toBe("stopped");
  });
});

describe("bounded settlement", () => {
  it("confirms Stopped when the runtime acknowledges and no diagnostics exist", async () => {
    const recorder = fixture({ runtime: "stopped" });

    const result = await interrupt(request("stop"), recorder.deps);

    expect(result.settlement).toBe("stopped");
    expect(result.phase).toBe("settled");
    expect(recorder.turnWrites).toEqual([
      "turn-1:stopping:-",
      "turn-1:settling:-",
      "turn-1:terminal:stopped",
    ]);
  });

  it("reports Cancelled only when an owned job confirmed a terminal cancellation", async () => {
    const recorder = fixture({
      diagnostics: [{ jobId: "job-1", state: "cancelled" }],
    });

    const result = await interrupt(request("stop"), recorder.deps);

    expect(result.settlement).toBe("cancelled");
    expect(result.diagnostics).toEqual({ requested: 1, confirmed: 1, unresolved: 0 });
  });

  it("treats a job that reached another terminal outcome first as confirmed, not detached", async () => {
    const recorder = fixture({
      diagnostics: [{ jobId: "job-1", state: "terminal_other" }],
    });

    const result = await interrupt(request("stop"), recorder.deps);

    // The job is terminal, so cancellation is settled -- and the gate is already
    // closed, so its result cannot reach the model or revive a proposal.
    expect(result.settlement).toBe("cancelled");
  });

  it("DETACHES a slow job that never confirms, rather than waiting indefinitely", async () => {
    const recorder = fixture({
      timeout: true,
      diagnostics: () => new Promise<DiagnosticCancellationAck[]>(() => {}),
    });

    const result = await interrupt(request("stop"), recorder.deps);

    expect(result.settlement).toBe("detached_timeout");
    expect(result.phase).toBe("detached");
    expect(recorder.turnWrites.at(-1)).toBe("turn-1:detached:detached_timeout");
  });

  it("DETACHES a slow runtime whose stop never answers", async () => {
    const recorder = fixture({
      timeout: true,
      runtime: () => new Promise<RuntimeStopOutcome>(() => {}),
    });

    const result = await interrupt(request("stop"), recorder.deps);

    expect(result.settlement).toBe("detached_timeout");
  });

  it("aborts the settlement signal so a pending canceller stops waiting", async () => {
    let observed: AbortSignal | undefined;
    const recorder = fixture({
      timeout: true,
      diagnostics: (signal) => {
        observed = signal;
        return new Promise<DiagnosticCancellationAck[]>(() => {});
      },
    });

    await interrupt(request("stop"), recorder.deps);

    expect(observed?.aborted).toBe(true);
  });

  it("detaches a partially-confirmed round rather than calling it Cancelled", async () => {
    const recorder = fixture({
      diagnostics: [
        { jobId: "job-1", state: "cancelled" },
        { jobId: "job-2", state: "unconfirmed" },
      ],
    });

    const result = await interrupt(request("stop"), recorder.deps);

    // "We could not confirm part of this" is the truthful summary of a mixed outcome.
    expect(result.settlement).toBe("detached_timeout");
    expect(result.diagnostics).toEqual({ requested: 2, confirmed: 1, unresolved: 1 });
  });

  it("detaches a canceller that throws instead of failing the interruption", async () => {
    const recorder = fixture({
      diagnostics: () => Promise.reject(new Error("queue unavailable")),
    });

    const result = await interrupt(request("stop"), recorder.deps);

    expect(result.settlement).toBe("detached_timeout");
    expect(
      readLifecycleLog().some((event) => event.errorClass === "diagnostic_cancel_failed"),
    ).toBe(true);
  });
});

describe("a runtime that cannot confirm", () => {
  it.each([
    ["instance_mismatch", "a restarted process answering under a new launch id"],
    ["unreachable", "a runtime that could not be reached at all"],
    ["no_active_run", "an unknown thread or a missing stop target"],
  ] as const)("detaches on %s (%s)", async (runtime, _why) => {
    const recorder = fixture({ runtime });

    const result = await interrupt(request("stop"), recorder.deps);

    expect(result.settlement).toBe("detached_runtime");
    expect(recorder.turnWrites.at(-1)).toBe("turn-1:detached:detached_runtime");
    // Never a synthesised provider completion.
    expect(recorder.turnWrites.join(" ")).not.toContain("completed");
  });

  it("is idempotent: a second interruption over the same turn changes nothing new", async () => {
    const recorder = fixture({ runtime: "no_active_run", hasLocalRun: false });

    const first = await interrupt(request("stop"), recorder.deps);
    const second = await interrupt(request("stop"), recorder.deps);

    expect(first.settlement).toBe(second.settlement);
    expect(second.settlement).toBe("detached_runtime");
  });
});

describe("the clear triggers", () => {
  it("fences BEFORE closing the gate, and deletes only after settlement", async () => {
    const order: string[] = [];
    const recorder = fixture();
    const deps: InterruptionDeps = {
      ...recorder.deps,
      beginClear: (scope) => {
        order.push(`beginClear:${scope}`);
        return Promise.resolve(FENCE);
      },
      closeGate: () => {
        order.push("gate");
        return 1;
      },
      requestRuntimeStop: () => {
        order.push("stop");
        return Promise.resolve("stopped" as const);
      },
      finishClear: () => {
        order.push("finishClear");
        return Promise.resolve(DELETION);
      },
    };

    const result = await interrupt(request("clear_history"), deps);

    // The fence lands before the gate closes and before anything asynchronous starts,
    // and the deletion happens last -- that ordering IS the retention contract.
    expect(order).toEqual(["beginClear:history", "gate", "stop", "finishClear"]);
    expect(result.clear?.deletion).toEqual(DELETION);
    expect(result.phase).toBe("cleared");
  });

  it("asks for the ALL scope on clear_all and the history scope on clear_history", async () => {
    const scopes: string[] = [];
    const recorder = fixture();
    const deps: InterruptionDeps = {
      ...recorder.deps,
      beginClear: (scope) => {
        scopes.push(scope);
        return Promise.resolve(FENCE);
      },
    };

    await interrupt(request("clear_history"), deps);
    await interrupt(request("clear_all"), deps);

    expect(scopes).toEqual(["history", "all"]);
  });

  it("reports a fenced turn write as fenced rather than settled", async () => {
    // The realistic clear case: the generation moved in `beginClear`, so the turn's own
    // stored capture is stale and its state writes are refused. The rows are deleted
    // moments later anyway.
    const recorder = fixture({ turnWriteOutcome: "fenced" });

    const result = await interrupt(request("clear_history"), recorder.deps);

    expect(result.fencedTurnIds).toEqual(["turn-1"]);
    expect(result.settledTurnIds).toEqual([]);
  });

  it("never begins a clear for a non-clear trigger", async () => {
    const beginClear = vi.fn(() => Promise.resolve(FENCE));
    const recorder = fixture();

    for (const trigger of INTERRUPTION_TRIGGERS) {
      if (trigger === "clear_history" || trigger === "clear_all") continue;
      await interrupt(request(trigger), { ...recorder.deps, beginClear });
    }

    // Disable, Remove key, Replace, takeover, lease loss and scenario switch are all
    // NON-DESTRUCTIVE by contract.
    expect(beginClear).not.toHaveBeenCalled();
  });
});

describe("turn scoping", () => {
  it.each([
    ["clear_all", { kind: "all" }],
    ["disable", { kind: "all" }],
    ["stop", { kind: "thread", threadId: "thread-1" }],
  ] as const)("scopes %s correctly", async (trigger, expected) => {
    const scopes: unknown[] = [];
    const recorder = fixture();

    await interrupt(request(trigger), {
      ...recorder.deps,
      readUnsettledTurns: (scope) => {
        scopes.push(scope);
        return Promise.resolve([TURN]);
      },
    });

    expect(scopes).toEqual([expected]);
  });

  it("falls back to the scenario when the caller has no thread id in hand", async () => {
    const scopes: unknown[] = [];
    const recorder = fixture();

    await interrupt(
      { trigger: "clear_history", threadId: null, scenarioId: "scenario-a" },
      {
        ...recorder.deps,
        readUnsettledTurns: (scope) => {
          scopes.push(scope);
          return Promise.resolve([TURN]);
        },
      },
    );

    // Not "all": clearing one scenario's conversation must not settle another
    // scenario's live turn.
    expect(scopes).toEqual([{ kind: "scenario", scenarioId: "scenario-a" }]);
  });
});

describe("bounded observability", () => {
  it("logs lifecycle and error CLASSES only -- never content", async () => {
    const recorder = fixture({ diagnostics: [{ jobId: "job-1", state: "cancelled" }] });

    await interrupt(request("clear_all"), recorder.deps);

    const serialized = JSON.stringify(readLifecycleLog());
    for (const forbidden of [
      SENTINEL_KEY,
      "scenario-a",
      "a question about",
      "get_schedule_overview",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The record type admits these fields and no free-text field at all, which is what
    // makes the guarantee structural rather than a review habit.
    expect(Object.keys(readLifecycleLog()[0])).toEqual([
      "seq",
      "at",
      "trigger",
      "phase",
      "settlement",
      "runtime",
      "turns",
      "diagnosticsRequested",
      "diagnosticsConfirmed",
      "errorClass",
    ]);
  });

  it("carries neither the model id nor anything the model produced", async () => {
    const recorder = fixture();

    await interrupt(request("stop"), recorder.deps);

    const serialized = JSON.stringify(readLifecycleLog());
    expect(serialized).not.toContain(TEST_MODEL);
    expect(serialized).toContain('"trigger":"stop"');
  });
});
