import { describe, expect, it } from "vitest";

import {
  NO_DIAGNOSTICS,
  readDiagnosticCanceller,
  setDiagnosticCanceller,
  summarizeCancellations,
} from "./diagnostic-cancellation";
import { interrupt, type InterruptionDeps } from "./interruption";
import { createDiagnosticFixture } from "./test-support";
import type { AssistantTurnV1 } from "./records";

const TURN: AssistantTurnV1 = {
  turnId: "turn-1",
  schemaVersion: 1,
  threadId: "thread-1",
  scenarioId: "scenario-a",
  basisDocumentRevision: 1,
  leaseEpoch: 1,
  modelId: "vendor/model",
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

/** Minimal real controller wiring, so the fixture is exercised the way T10 will be. */
function deps(overrides: Partial<InterruptionDeps> = {}): InterruptionDeps {
  return {
    now: () => new Date("2026-08-07T12:00:00.000Z"),
    closeGate: () => 1,
    publishPhase: () => {},
    readUnsettledTurns: () => Promise.resolve([TURN]),
    setTurnState: () => Promise.resolve("accepted"),
    abortLocalRun: () => ({ threadId: "thread-1", runId: "run-1", abort: () => {} }),
    requestRuntimeStop: () => Promise.resolve("stopped"),
    cancelDiagnostics: (request) => readDiagnosticCanceller().cancelOwnedJobs(request),
    beginClear: () => {
      throw new Error("not a clear trigger");
    },
    finishClear: () => {
      throw new Error("not a clear trigger");
    },
    settlementWindow: () => new Promise<void>(() => {}),
    ...overrides,
  };
}

describe("the default canceller", () => {
  it("is a no-op, so the controller has one code path before T10 exists", async () => {
    setDiagnosticCanceller(null);

    expect(readDiagnosticCanceller()).toBe(NO_DIAGNOSTICS);
    // An empty array rather than a throw or a null owner: "no diagnostics" must settle
    // immediately, not wait out the window for a capability the app lacks.
    const result = await interrupt(
      { trigger: "stop", threadId: "thread-1", scenarioId: "scenario-a" },
      deps(),
    );
    expect(result.settlement).toBe("stopped");
    expect(result.diagnostics).toEqual({ requested: 0, confirmed: 0, unresolved: 0 });
  });

  it("is restored by passing null, so a test cannot leak an owner into the next one", () => {
    setDiagnosticCanceller({ cancelOwnedJobs: () => Promise.resolve([]) });
    setDiagnosticCanceller(null);

    expect(readDiagnosticCanceller()).toBe(NO_DIAGNOSTICS);
  });
});

describe("the ownership interface T10 must honour", () => {
  it("receives the closed epoch and the scope, and nothing else", async () => {
    const fixture = createDiagnosticFixture({ acks: [{ jobId: "job-1", state: "cancelled" }] });
    setDiagnosticCanceller(fixture);

    await interrupt(
      { trigger: "takeover", threadId: "thread-1", scenarioId: "scenario-a" },
      deps({ closeGate: () => 42 }),
    );

    const [request] = fixture.requests;
    expect(request).toMatchObject({
      trigger: "takeover",
      threadId: "thread-1",
      scenarioId: "scenario-a",
      // Handed the epoch that is ALREADY closed: nothing authorised under it may
      // publish, so a job finishing later cannot re-enter the turn.
      closedTurnEpoch: 42,
    });
    expect(Object.keys(request).sort()).toEqual([
      "closedTurnEpoch",
      "scenarioId",
      "signal",
      "threadId",
      "trigger",
    ]);
  });

  it("is told to stop waiting when the settlement window closes", async () => {
    const fixture = createDiagnosticFixture({ hang: true });
    setDiagnosticCanceller(fixture);

    const result = await interrupt(
      { trigger: "stop", threadId: "thread-1", scenarioId: "scenario-a" },
      deps({ settlementWindow: () => Promise.resolve() }),
    );

    expect(result.settlement).toBe("detached_timeout");
    expect(fixture.aborted()).toBe(true);
  });

  it("settles normally when a slow owner answers inside the window", async () => {
    const fixture = createDiagnosticFixture({
      delayMs: 5,
      acks: [{ jobId: "job-1", state: "cancelled" }],
    });
    setDiagnosticCanceller(fixture);

    const result = await interrupt(
      { trigger: "stop", threadId: "thread-1", scenarioId: "scenario-a" },
      deps(),
    );

    expect(result.settlement).toBe("cancelled");
    expect(fixture.aborted()).toBe(true);
  });
});

describe("summarising a cancellation round", () => {
  it("counts a job that ended some other terminal way as confirmed", () => {
    expect(
      summarizeCancellations([
        { jobId: "a", state: "cancelled" },
        { jobId: "b", state: "terminal_other" },
        { jobId: "c", state: "unconfirmed" },
      ]),
    ).toEqual({ requested: 3, confirmed: 2, unresolved: 1 });
  });

  it("is empty for an empty round", () => {
    expect(summarizeCancellations([])).toEqual({ requested: 0, confirmed: 0, unresolved: 0 });
  });
});
