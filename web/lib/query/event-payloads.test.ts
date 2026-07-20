import { describe, expect, it } from "vitest";
import type { JobResponse } from "@/lib/bff/types";
import {
  isTerminalJobState,
  parseControlChangedPayload,
  parseJobResponse,
  parseResultAvailablePayload,
  parseStrictTerminalFrame,
  parseStateChangedPayload,
} from "@/lib/query/event-payloads";

// Fixtures mirror the EXACT frames the T19 backend serializes (controller.py +
// api/optimize.py::_enrich_state_event + sse.py, which merges `occurred_at`).

describe("parseStateChangedPayload", () => {
  const runtimeIdentity = {
    service_name: "nurse-scheduling-api",
    api_version: "alpha",
    app_version: "v-test",
    deployment_id: "deployment-test",
    instance_id: "instance-test",
    started_at: "2026-07-19T00:00:00+00:00",
    job_backend: "memory",
    job_store_id: "store-test",
  } as const;

  const running = (over: Record<string, unknown> = {}) => ({
    occurred_at: "2026-07-19T00:00:00+00:00",
    state: "running",
    queue_position: null,
    cancel_requested: false,
    early_completion_requested: false,
    terminal: false,
    controls: { cancellable: true, early_completion_available: true },
    ...over,
  });

  const stateFrames = {
    queued: running({
      state: "queued",
      queue_position: 3,
      controls: { cancellable: true, early_completion_available: false },
    }),
    running: running({ worker_id: "worker-1" }),
    cancelling: running({
      state: "cancelling",
      cancel_requested: true,
      controls: { cancellable: false, early_completion_available: false },
    }),
    completed: running({
      state: "completed",
      terminal: true,
      controls: { cancellable: false, early_completion_available: false },
    }),
    cancelled: running({
      state: "cancelled",
      terminal: true,
      cancel_requested: true,
      controls: { cancellable: false, early_completion_available: false },
      error: { code: "cancelled", message: "Optimization cancelled." },
    }),
    failed: running({
      state: "failed",
      terminal: true,
      controls: { cancellable: false, early_completion_available: false },
      error: { code: "worker_lost", message: "The worker stopped." },
    }),
  } as const;

  it("accepts every backend-emitted lifecycle envelope", () => {
    for (const [state, frame] of Object.entries(stateFrames)) {
      expect(parseStateChangedPayload(frame)?.state).toBe(state);
    }
  });

  it("accepts the real queued and running runtime-identity variants", () => {
    expect(
      parseStateChangedPayload({ ...stateFrames.queued, runtime: runtimeIdentity })?.state,
    ).toBe("queued");
    expect(
      parseStateChangedPayload({ ...stateFrames.running, runtime: runtimeIdentity })?.state,
    ).toBe("running");
  });

  it.each([
    ["missing occurred_at", { ...stateFrames.running, occurred_at: undefined }],
    ["invalid occurred_at", { ...stateFrames.running, occurred_at: "yesterday" }],
    ["unknown state", { ...stateFrames.running, state: "bogus" }],
    ["state/terminal mismatch", { ...stateFrames.running, terminal: true }],
    ["queued without position", { ...stateFrames.queued, queue_position: null }],
    ["queued with early completion", { ...stateFrames.queued, early_completion_requested: true }],
    ["running without worker_id", running()],
    ["running with an empty worker_id", { ...stateFrames.running, worker_id: "" }],
    ["running with a position", { ...stateFrames.running, queue_position: 2 }],
    ["running with an error", { ...stateFrames.running, error: { code: "x", message: "boom" } }],
    ["running with a null error field", { ...stateFrames.running, error: null }],
    [
      "running with terminal controls",
      { ...stateFrames.running, controls: stateFrames.completed.controls },
    ],
    ["cancelling without cancel request", { ...stateFrames.cancelling, cancel_requested: false }],
    [
      "completed with live controls",
      { ...stateFrames.completed, controls: stateFrames.running.controls },
    ],
    ["cancelled without error", { ...stateFrames.cancelled, error: undefined }],
    [
      "cancelled with non-cancel error",
      { ...stateFrames.cancelled, error: { code: "x", message: "boom" } },
    ],
    ["failed without error", { ...stateFrames.failed, error: undefined }],
    [
      "failed with cancel error",
      { ...stateFrames.failed, error: { code: "cancelled", message: "Optimization cancelled." } },
    ],
    ["zero queue position", { ...stateFrames.queued, queue_position: 0 }],
    ["fractional queue position", { ...stateFrames.queued, queue_position: 1.5 }],
    ["malformed error", { ...stateFrames.failed, error: { code: "x" } }],
    ["unknown top-level key", { ...stateFrames.running, mystery: true }],
    ["worker_id on queued", { ...stateFrames.queued, worker_id: "worker-1" }],
    ["worker_id on cancelling", { ...stateFrames.cancelling, worker_id: "worker-1" }],
    ["runtime on completed", { ...stateFrames.completed, runtime: runtimeIdentity }],
    [
      "unknown runtime key",
      { ...stateFrames.queued, runtime: { ...runtimeIdentity, mystery: true } },
    ],
    [
      "incomplete runtime identity",
      {
        ...stateFrames.queued,
        runtime: { service_name: "nurse-scheduling-api", started_at: runtimeIdentity.started_at },
      },
    ],
    [
      "invalid runtime started_at",
      { ...stateFrames.running, runtime: { ...runtimeIdentity, started_at: "today" } },
    ],
    [
      "invalid runtime service",
      { ...stateFrames.running, runtime: { ...runtimeIdentity, service_name: "other" } },
    ],
    [
      "invalid runtime backend",
      { ...stateFrames.running, runtime: { ...runtimeIdentity, job_backend: "disk" } },
    ],
    [
      "empty runtime identity field",
      { ...stateFrames.running, runtime: { ...runtimeIdentity, job_store_id: "" } },
    ],
  ])("rejects %s", (_name, frame) => {
    expect(parseStateChangedPayload(frame)).toBeNull();
  });
});

describe("isTerminalJobState", () => {
  it("marks exactly completed/cancelled/failed terminal and the live states non-terminal", () => {
    expect(isTerminalJobState("completed")).toBe(true);
    expect(isTerminalJobState("cancelled")).toBe(true);
    expect(isTerminalJobState("failed")).toBe(true);
    expect(isTerminalJobState("queued")).toBe(false);
    expect(isTerminalJobState("running")).toBe(false);
    expect(isTerminalJobState("cancelling")).toBe(false);
  });
});

describe("parseControlChangedPayload", () => {
  it("accepts only the emitted true envelope", () => {
    expect(
      parseControlChangedPayload({
        occurred_at: "2026-07-19T00:00:00+00:00",
        early_completion_requested: true,
      }),
    ).toEqual({ early_completion_requested: true });
  });

  it.each([
    ["false", { occurred_at: "2026-07-19T00:00:00+00:00", early_completion_requested: false }],
    ["missing timestamp", { early_completion_requested: true }],
    ["invalid timestamp", { occurred_at: "t", early_completion_requested: true }],
    ["nested controls", { controls: { early_completion_available: false } }],
    [
      "extra field",
      {
        occurred_at: "2026-07-19T00:00:00+00:00",
        early_completion_requested: true,
        controls: {},
      },
    ],
  ])("rejects %s", (_name, frame) => {
    expect(parseControlChangedPayload(frame)).toBeNull();
  });
});

describe("parseResultAvailablePayload", () => {
  const feasible = (over: Record<string, unknown> = {}) => ({
    occurred_at: "2026-07-19T00:00:00+00:00",
    outcome: "feasible",
    score: 1,
    solver_status: "FEASIBLE",
    termination_reason: "limit_or_stop",
    artifact_name: "schedule.xlsx",
    ...over,
  });

  it("accepts the backend result boundaries", () => {
    expect(parseResultAvailablePayload(feasible())?.outcome).toBe("feasible");
    expect(
      parseResultAvailablePayload(feasible({ termination_reason: "user_requested" }))?.outcome,
    ).toBe("feasible");
    expect(
      parseResultAvailablePayload(
        feasible({
          outcome: "optimal",
          solver_status: "OPTIMAL",
          termination_reason: "optimality_proven",
        }),
      )?.outcome,
    ).toBe("optimal");
    expect(
      parseResultAvailablePayload(
        feasible({
          outcome: "infeasible",
          score: null,
          solver_status: "INFEASIBLE",
          termination_reason: "infeasibility_proven",
          artifact_name: null,
        }),
      )?.outcome,
    ).toBe("infeasible");
  });

  it.each([
    ["missing timestamp", feasible({ occurred_at: undefined })],
    ["invalid timestamp", feasible({ occurred_at: "t" })],
    ["unknown outcome", feasible({ outcome: "unknown" })],
    ["fractional score", feasible({ score: 1.5 })],
    ["feasible without score", feasible({ score: null })],
    ["feasible without artifact", feasible({ artifact_name: null })],
    ["feasible with wrong status", feasible({ solver_status: "OPTIMAL" })],
    ["feasible with wrong reason", feasible({ termination_reason: "optimality_proven" })],
    ["optimal with feasible status", feasible({ outcome: "optimal" })],
    [
      "infeasible with score",
      feasible({
        outcome: "infeasible",
        solver_status: "INFEASIBLE",
        termination_reason: "infeasibility_proven",
      }),
    ],
    [
      "infeasible with artifact",
      feasible({
        outcome: "infeasible",
        score: null,
        solver_status: "INFEASIBLE",
        termination_reason: "infeasibility_proven",
      }),
    ],
    ["empty artifact", feasible({ artifact_name: "" })],
    ["extra field", feasible({ result: {} })],
  ])("rejects %s", (_name, frame) => {
    expect(parseResultAvailablePayload(frame)).toBeNull();
  });
});

const validJobResponse = (over: Partial<JobResponse> = {}): JobResponse => ({
  id: "job-A",
  state: "running",
  terminal: false,
  queue_position: null,
  created_at: "2026-07-20T00:00:00+00:00",
  started_at: "2026-07-20T00:00:01+00:00",
  finished_at: null,
  request: {
    input_name: "scenario.yaml",
    solver: "ortools/cp-sat",
    prettify: null,
    timeout_seconds: 300,
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

function validStateResponse(state: JobResponse["state"]): JobResponse {
  const base = validJobResponse();
  if (state === "queued") {
    return {
      ...base,
      state,
      queue_position: 1,
      started_at: null,
      controls: { cancellable: true, early_completion_available: false },
    };
  }
  if (state === "running") return base;
  if (state === "cancelling") {
    return {
      ...base,
      state,
      controls: { cancellable: false, early_completion_available: false },
    };
  }
  if (state === "completed") {
    return {
      ...base,
      state,
      terminal: true,
      finished_at: "2026-07-20T00:01:00+00:00",
      result: {
        outcome: "optimal",
        score: 9,
        solver_status: "OPTIMAL",
        termination_reason: "optimality_proven",
      },
      controls: { cancellable: false, early_completion_available: false },
      links: { ...base.links, schedule: "/optimize/job-A/xlsx" },
    };
  }
  if (state === "cancelled") {
    return {
      ...base,
      state,
      terminal: true,
      started_at: null,
      finished_at: "2026-07-20T00:01:00+00:00",
      error: { code: "cancelled", message: "Optimization cancelled." },
      controls: { cancellable: false, early_completion_available: false },
    };
  }
  return {
    ...base,
    state,
    terminal: true,
    finished_at: "2026-07-20T00:01:00+00:00",
    error: { code: "worker_lost", message: "Worker lost." },
    controls: { cancellable: false, early_completion_available: false },
  };
}

describe("parseJobResponse", () => {
  it("accepts every backend lifecycle boundary, including queued cancellation", () => {
    for (const state of [
      "queued",
      "running",
      "cancelling",
      "completed",
      "cancelled",
      "failed",
    ] as const) {
      expect(parseJobResponse(validStateResponse(state))?.state).toBe(state);
    }
  });

  it("accepts all three backend result envelopes", () => {
    const completed = validStateResponse("completed");
    expect(
      parseJobResponse({
        ...completed,
        result: {
          outcome: "feasible",
          score: 4,
          solver_status: "FEASIBLE",
          termination_reason: "limit_or_stop",
        },
      }),
    ).not.toBeNull();
    expect(
      parseJobResponse({
        ...completed,
        result: {
          outcome: "feasible",
          score: 4,
          solver_status: "FEASIBLE",
          termination_reason: "user_requested",
        },
      }),
    ).not.toBeNull();
    expect(
      parseJobResponse({
        ...completed,
        result: {
          outcome: "infeasible",
          score: null,
          solver_status: "INFEASIBLE",
          termination_reason: "infeasibility_proven",
        },
        links: { ...completed.links, schedule: null },
      }),
    ).not.toBeNull();
  });

  it("accepts a complete response and enforces the URL-bound identity", () => {
    const response = validJobResponse();
    expect(parseJobResponse(response, "job-A")).toEqual(response);
    expect(parseJobResponse(response, "job-B")).toBeNull();
  });

  it("rejects incomplete responses and inconsistent lifecycle terminality", () => {
    const { controls: _controls, ...incomplete } = validJobResponse();
    expect(parseJobResponse(incomplete)).toBeNull();
    expect(parseJobResponse(validJobResponse({ terminal: true }))).toBeNull();
    expect(parseJobResponse(validJobResponse({ state: "completed", terminal: false }))).toBeNull();
  });

  it("rejects invalid enum, numeric, error, controls, result, and links domains", () => {
    const invalid: unknown[] = [
      { ...validJobResponse(), state: "optimal" },
      { ...validJobResponse(), queue_position: -1 },
      {
        ...validJobResponse(),
        request: { ...validJobResponse().request, timeout_seconds: 1.5 },
      },
      { ...validJobResponse(), error: { code: "worker_lost" } },
      { ...validJobResponse(), controls: { cancellable: "yes", early_completion_available: true } },
      {
        ...validJobResponse(),
        result: {
          outcome: "completed",
          score: 4,
          solver_status: "DONE",
          termination_reason: null,
        },
      },
      {
        ...validJobResponse(),
        result: {
          outcome: "feasible",
          score: 1.25,
          solver_status: "DONE",
          termination_reason: null,
        },
      },
      { ...validJobResponse(), links: { ...validJobResponse().links, schedule: 3 } },
    ];
    for (const response of invalid) expect(parseJobResponse(response)).toBeNull();
  });

  it("rejects backend-impossible timestamp, queue, terminal, and live envelopes", () => {
    const completed = validStateResponse("completed");
    const running = validStateResponse("running");
    const failed = validStateResponse("failed");
    const cancelled = validStateResponse("cancelled");
    for (const response of [
      { ...running, created_at: "today" },
      { ...running, created_at: "2026-02-30T00:00:00+00:00" },
      { ...running, started_at: "2026-07-19T23:59:59+00:00" },
      {
        ...running,
        created_at: "2026-07-20T00:00:00.000000002Z",
        started_at: "2026-07-20T00:00:00.000000001Z",
      },
      { ...validStateResponse("queued"), queue_position: 0 },
      { ...running, queue_position: 2 },
      { ...completed, finished_at: null },
      { ...completed, result: null },
      { ...failed, error: null },
      { ...cancelled, error: { code: "worker_lost", message: "wrong" } },
      { ...running, finished_at: "2026-07-20T00:01:00+00:00" },
      { ...running, error: { code: "worker_lost", message: "wrong" } },
      { ...completed, controls: { cancellable: true, early_completion_available: false } },
      { ...completed, links: { ...completed.links, self: "/optimize/job-B" } },
      {
        ...completed,
        result: { ...completed.result!, outcome: "infeasible", score: 2 },
      },
      { ...running, request: { ...running.request, solver: "cp-sat" } },
      { ...running, request: { ...running.request, timeout_seconds: 0 } },
    ]) {
      expect(parseJobResponse(response)).toBeNull();
    }
  });

  it("uses the settled proleptic ISO timezone boundaries", () => {
    const running = validStateResponse("running");
    for (const created_at of [
      "0001-01-01T00:00:00Z",
      "9999-12-31T23:59:59.999999+14:00",
      "2026-07-20T00:00:00-14:00",
    ]) {
      expect(parseJobResponse({ ...running, created_at, started_at: created_at })).not.toBeNull();
    }
    for (const created_at of [
      "0000-01-01T00:00:00Z",
      "10000-01-01T00:00:00Z",
      "2026-07-20T00:00:00+14:01",
      "2026-07-20T00:00:00+23:59",
    ]) {
      expect(parseJobResponse({ ...running, created_at })).toBeNull();
    }
  });
});

describe("parseStrictTerminalFrame", () => {
  it("brands only a complete, strictly parsed terminal state_changed frame", () => {
    const valid = {
      id: "v1.job-A.9",
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
    };
    expect(parseStrictTerminalFrame(valid)).toBe(valid);
    expect(
      parseStrictTerminalFrame({
        ...valid,
        data: '{"state":"running","terminal":true}',
      }),
    ).toBeNull();
    expect(
      parseStrictTerminalFrame({
        ...valid,
        data: JSON.stringify({
          state: "completed",
          terminal: true,
          queue_position: null,
          cancel_requested: false,
          early_completion_requested: false,
          controls: { cancellable: false, early_completion_available: false },
        }),
      }),
    ).toBeNull();
    expect(parseStrictTerminalFrame({ ...valid, id: null })).toBeNull();
    for (const occurred_at of [
      "0000-01-01T00:00:00Z",
      "2026-07-20T00:00:00+14:01",
      "2026-07-20T00:00:00+23:59",
    ]) {
      expect(
        parseStrictTerminalFrame({
          ...valid,
          data: JSON.stringify({ ...JSON.parse(valid.data), occurred_at }),
        }),
      ).toBeNull();
    }
  });

  it.each([
    ["cancelled", "cancelled", true],
    ["failed", "worker_lost", false],
  ] as const)("accepts the complete persisted %s terminal envelope", (state, code, cancelled) => {
    expect(
      parseStrictTerminalFrame({
        id: `v1.job-A.${state}`,
        event: "job.state_changed",
        data: JSON.stringify({
          occurred_at: "2026-07-20T00:01:00+00:00",
          state,
          terminal: true,
          queue_position: null,
          cancel_requested: cancelled,
          early_completion_requested: false,
          controls: { cancellable: false, early_completion_available: false },
          error: { code, message: "terminal" },
        }),
      }),
    ).not.toBeNull();
  });
});
