// T10 — the DiagnosticCanceller the T05 interruption controller calls.
//
// Covers: cancelling owned non-terminal jobs, leaving already-terminal jobs as
// terminal_other, reporting unconfirmed when the poll fails/aborts, scoping by
// thread/scenario/epoch, and never touching jobs this tab does not own.

import { afterEach, describe, expect, it } from "vitest";
import type { JobResponse, JobState } from "@/lib/bff/types";
import {
  cancelOwnedDiagnosticsNow,
  createDiagnosticCanceller,
  readOwnedDiagnosticJobs,
  registerOwnedDiagnosticJob,
  resetOwnedDiagnosticJobsForTest,
  unregisterOwnedDiagnosticJob,
  type DiagnosticCancellerDeps,
} from "./diagnostic-canceller";
import {
  NO_DIAGNOSTICS,
  readDiagnosticCanceller,
  setDiagnosticCanceller,
  type DiagnosticCancellationRequest,
} from "@/lib/ai/assistant/diagnostic-cancellation";
import { installDiagnosticCanceller } from "./install";

const NOW = new Date("2026-08-07T12:00:00Z");

afterEach(() => {
  resetOwnedDiagnosticJobsForTest();
});

function makeJob(state: JobState): JobResponse {
  return {
    id: "j",
    state,
    terminal: ["completed", "cancelled", "failed"].includes(state),
    queue_position: null,
    created_at: NOW.toISOString(),
    expires_at: null,
    started_at: null,
    finished_at: null,
    request: {
      input_name: "in",
      solver: "ortools/cp-sat",
      prettify: false,
      timeout_seconds: 90,
      purpose: "assistant_diagnostic",
      basis: null,
    },
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: false },
    links: { self: "", events: "", cancellation: "", early_completion: "", schedule: null },
  };
}

function makeDeps(
  jobs: Record<string, JobResponse>,
  failRead = false,
): DiagnosticCancellerDeps & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
    async cancelJob(jobId) {
      cancelled.push(jobId);
    },
    async readJob(jobId) {
      if (failRead) throw new Error("read failed");
      return jobs[jobId] ?? null;
    },
  };
}

function request(over: Partial<DiagnosticCancellationRequest> = {}): DiagnosticCancellationRequest {
  return {
    trigger: "stop",
    threadId: null,
    scenarioId: null,
    closedTurnEpoch: 5,
    signal: new AbortController().signal,
    ...over,
  };
}

describe("createDiagnosticCanceller", () => {
  it("is what an installed canceller does, not the no-op default", () => {
    // T05 shipped the contract with a no-op default so it could land before T10.
    // Bring-up must replace it — otherwise every interruption would report zero
    // diagnostics to cancel while a solve carried on running.
    setDiagnosticCanceller(null);
    expect(readDiagnosticCanceller()).toBe(NO_DIAGNOSTICS);

    installDiagnosticCanceller();
    expect(readDiagnosticCanceller()).not.toBe(NO_DIAGNOSTICS);

    // And again after a reset, because bring-up runs more than once per page
    // lifetime and must not depend on whether it happens to be the first.
    setDiagnosticCanceller(null);
    installDiagnosticCanceller();
    expect(readDiagnosticCanceller()).not.toBe(NO_DIAGNOSTICS);

    setDiagnosticCanceller(null);
  });

  it("returns an empty array when no jobs are owned", async () => {
    const deps = makeDeps({});
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request());
    expect(acks).toEqual([]);
  });

  it("cancels an owned running job and confirms when the backend reports cancelled", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: null, scenarioId: null, turnEpoch: 3 });
    const deps = makeDeps({ j1: makeJob("cancelled") });
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request());
    expect(deps.cancelled).toContain("j1");
    expect(acks).toEqual([{ jobId: "j1", state: "cancelled" }]);
    // A settled job is dropped from the registry.
    expect(readOwnedDiagnosticJobs()).toHaveLength(0);
  });

  it("reports terminal_other when the job reached a different terminal outcome first", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: null, scenarioId: null, turnEpoch: 3 });
    const deps = makeDeps({ j1: makeJob("completed") });
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request());
    expect(acks).toEqual([{ jobId: "j1", state: "terminal_other" }]);
  });

  it("reports unconfirmed when the job is still non-terminal after cancellation", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: null, scenarioId: null, turnEpoch: 3 });
    const deps = makeDeps({ j1: makeJob("running") });
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request());
    expect(acks).toEqual([{ jobId: "j1", state: "unconfirmed" }]);
    // Still owned: an unconfirmed job is not dropped.
    expect(readOwnedDiagnosticJobs()).toHaveLength(1);
  });

  it("reports terminal_other when the job is gone (expired/deleted)", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: null, scenarioId: null, turnEpoch: 3 });
    const deps = makeDeps({});
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request());
    expect(acks).toEqual([{ jobId: "j1", state: "terminal_other" }]);
  });

  it("reports unconfirmed when the poll itself fails", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: null, scenarioId: null, turnEpoch: 3 });
    const deps = makeDeps({}, true);
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request());
    expect(acks).toEqual([{ jobId: "j1", state: "unconfirmed" }]);
  });

  it("scopes cancellation by threadId", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: "t1", scenarioId: null, turnEpoch: 3 });
    registerOwnedDiagnosticJob({ jobId: "j2", threadId: "t2", scenarioId: null, turnEpoch: 3 });
    const deps = makeDeps({ j1: makeJob("cancelled") });
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request({ threadId: "t1" }));
    expect(acks.map((a) => a.jobId)).toEqual(["j1"]);
    expect(deps.cancelled).toEqual(["j1"]);
  });

  it("scopes cancellation by scenarioId", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: null, scenarioId: "s1", turnEpoch: 3 });
    registerOwnedDiagnosticJob({ jobId: "j2", threadId: null, scenarioId: "s2", turnEpoch: 3 });
    const deps = makeDeps({ j1: makeJob("cancelled") });
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request({ scenarioId: "s1" }));
    expect(acks.map((a) => a.jobId)).toEqual(["j1"]);
  });

  it("leaves a LATER turn's job alone — an interruption closes one epoch, not the future", async () => {
    // The controller passes the epoch it just closed. A job registered under a
    // higher epoch belongs to a turn that started afterwards, and cancelling it
    // would make an interruption reach forward into work the user did not stop.
    registerOwnedDiagnosticJob({ jobId: "j_old", threadId: null, scenarioId: null, turnEpoch: 5 });
    registerOwnedDiagnosticJob({ jobId: "j_new", threadId: null, scenarioId: null, turnEpoch: 6 });
    const deps = makeDeps({ j_old: makeJob("cancelled") });
    const canceller = createDiagnosticCanceller(deps);

    const acks = await canceller.cancelOwnedJobs(request({ closedTurnEpoch: 5 }));
    expect(acks.map((ack) => ack.jobId)).toEqual(["j_old"]);
    expect(deps.cancelled).toEqual(["j_old"]);
    expect(readOwnedDiagnosticJobs().map((job) => job.jobId)).toEqual(["j_new"]);
  });

  it("unregisterOwnedDiagnosticJob removes a settled job proactively", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: null, scenarioId: null, turnEpoch: 3 });
    unregisterOwnedDiagnosticJob("j1");
    const deps = makeDeps({});
    const canceller = createDiagnosticCanceller(deps);
    const acks = await canceller.cancelOwnedJobs(request());
    expect(acks).toEqual([]);
  });
});

describe("cancelOwnedDiagnosticsNow", () => {
  it("cancels every owned job on the user's explicit request, whatever its epoch", async () => {
    // The "Cancel testing" control. Unlike an interruption it is not scoped to a
    // closed epoch: the user asked to free the worker, not to stop a conversation.
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: "t1", scenarioId: "s1", turnEpoch: 2 });
    registerOwnedDiagnosticJob({ jobId: "j2", threadId: "t2", scenarioId: "s2", turnEpoch: 9 });
    const deps = makeDeps({});

    const targets = await cancelOwnedDiagnosticsNow(deps, new AbortController().signal);
    expect(targets.sort()).toEqual(["j1", "j2"]);
    expect(deps.cancelled.sort()).toEqual(["j1", "j2"]);
  });

  it("never throws when the backend refuses a cancellation", async () => {
    registerOwnedDiagnosticJob({ jobId: "j1", threadId: null, scenarioId: null, turnEpoch: 1 });
    const deps: DiagnosticCancellerDeps = {
      async cancelJob() {
        throw new Error("backend said no");
      },
      async readJob() {
        return null;
      },
    };
    // A control that could throw would leave the button stuck; the orchestrator's
    // own poll observes whatever the job really settles to.
    await expect(cancelOwnedDiagnosticsNow(deps, new AbortController().signal)).resolves.toEqual([
      "j1",
    ]);
  });
});
