import { describe, expect, it, vi } from "vitest";
import { OptimizeApiError } from "@/lib/query/optimize";
import { classifyOptimizeError } from "@/lib/bff/errors";
import type { JobResponse } from "@/lib/bff/types";
import type { SseFrame } from "@/lib/query/sse";
import type {
  ActiveOptimizeSession,
  SubmissionTransactionOutcome,
  VolatileActivation,
} from "./session-transaction";
import {
  buildStreamCallbacks,
  classifySubmitError,
  durableFrameSignal,
  frameToSignal,
  normalizePhaseFrame,
  normalizeProgressFrame,
  outcomeToSignals,
} from "./submission";
import type { RunSignal } from "./run-view";

// Build an OptimizeApiError with a chosen classified kind via a matching body.
function apiError(status: number, body: unknown): OptimizeApiError {
  return new OptimizeApiError(status, body);
}

const activeRecord = (jobId: string): ActiveOptimizeSession => ({
  schemaVersion: 1,
  ownerId: "own_1",
  phase: "active",
  anonymized: false,
  runOptions: {},
  peopleCount: 0,
  reverseMap: [],
  jobId,
});

const volatile = (jobId: string): VolatileActivation => ({
  jobId,
  anonymized: true,
  peopleCount: 2,
  reverseMap: [
    ["P1", 1],
    ["P2", 2],
  ],
  reloadRecoveryUnavailable: true,
});

const frame = (event: string, data: string): SseFrame => ({ id: "cur_1", event, data });

describe("classifySubmitError", () => {
  it("treats validation/too-large/queue-full/conflict as definite rejections", () => {
    expect(
      classifySubmitError(
        apiError(422, { error: { code: "invalid_scheduling_data", message: "x" } }),
      ).status,
    ).toBe("definitely-rejected");
    expect(classifySubmitError(apiError(413, { detail: "too big" })).status).toBe(
      "definitely-rejected",
    );
    expect(
      classifySubmitError(apiError(429, { error: { code: "job_capacity_exceeded", message: "x" } }))
        .status,
    ).toBe("definitely-rejected");
    expect(
      classifySubmitError(
        apiError(409, { error: { code: "job_operation_not_allowed", message: "x" } }),
      ).status,
    ).toBe("definitely-rejected");
  });

  it("treats 5xx / unreachable / unknown / thrown errors as acceptance-unknown", () => {
    expect(classifySubmitError(apiError(500, { detail: "boom" })).status).toBe(
      "acceptance-unknown",
    );
    expect(
      classifySubmitError(apiError(502, { error: { code: "backend_unreachable", message: "x" } }))
        .status,
    ).toBe("acceptance-unknown");
    expect(classifySubmitError(new Error("network down")).status).toBe("acceptance-unknown");
    expect(classifySubmitError("weird").status).toBe("acceptance-unknown");
  });
});

describe("outcomeToSignals", () => {
  it("blocked-before-post yields a submit-blocked signal with a code and message", () => {
    const signals = outcomeToSignals({ status: "blocked-before-post", reason: "session-conflict" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: "submit-blocked", code: "session-conflict" });
    expect((signals[0] as { message: string }).message.length).toBeGreaterThan(0);
  });

  it("submit-rejected carries a code-first error", () => {
    const outcome: SubmissionTransactionOutcome = {
      status: "submit-rejected",
      error: apiError(422, { error: { code: "workspace_not_ready", message: "not ready" } }),
      rollback: "removed",
    };
    expect(outcomeToSignals(outcome)).toEqual([
      { type: "submit-rejected", code: "workspace_not_ready", message: "not ready" },
    ]);
  });

  it("acceptance-unknown maps to submit-unknown", () => {
    const outcome: SubmissionTransactionOutcome = {
      status: "acceptance-unknown",
      error: new Error("interrupted"),
    };
    expect(outcomeToSignals(outcome)).toEqual([
      { type: "submit-unknown", code: null, message: "interrupted" },
    ]);
  });

  it("activated yields a durable job-activated", () => {
    const outcome: SubmissionTransactionOutcome = {
      status: "activated",
      record: activeRecord("opt_7"),
    };
    expect(outcomeToSignals(outcome)).toEqual([
      { type: "job-activated", jobId: "opt_7", reloadRecoveryAvailable: true },
    ]);
  });

  it("activation-persistence-failed yields a volatile job-activated with reload recovery off", () => {
    const outcome: SubmissionTransactionOutcome = {
      status: "activation-persistence-failed",
      volatile: volatile("opt_8"),
    };
    expect(outcomeToSignals(outcome)).toEqual([
      {
        type: "job-activated",
        jobId: "opt_8",
        reloadRecoveryAvailable: false,
        reason: "activation-persistence-failed",
      },
    ]);
  });

  it("activation-unverified carries its structured reason", () => {
    const outcome: SubmissionTransactionOutcome = {
      status: "activation-unverified",
      volatile: volatile("opt_9"),
      reason: "owner-conflict",
    };
    expect(outcomeToSignals(outcome)).toEqual([
      {
        type: "job-activated",
        jobId: "opt_9",
        reloadRecoveryAvailable: false,
        reason: "owner-conflict",
      },
    ]);
  });
});

describe("frame normalization", () => {
  it("normalizes a well-formed progress frame", () => {
    const point = normalizeProgressFrame(
      frame(
        "job.progressed",
        JSON.stringify({
          source: "solver",
          currentBestScore: 12,
          elapsedSeconds: 3.5,
          solutionIndex: 2,
          commentCount: 4,
        }),
      ),
    );
    expect(point).toEqual({
      source: "solver",
      currentBestScore: 12,
      elapsedSeconds: 3.5,
      solutionIndex: 2,
      commentCount: 4,
    });
  });

  it("requires a non-empty source; rejects (not coerces) an optional field of the wrong type", () => {
    // Source is required; a missing source produces no chart point.
    expect(
      normalizeProgressFrame(
        frame(
          "job.progressed",
          JSON.stringify({ currentBestScore: 7, elapsedSeconds: 2, solutionIndex: "x" }),
        ),
      ),
    ).toBeNull();
    // Strict (P1): an optional field supplied with the WRONG type REJECTS the whole
    // frame — it is never silently coerced to null.
    expect(
      normalizeProgressFrame(
        frame(
          "job.progressed",
          JSON.stringify({
            source: "solver",
            currentBestScore: 7,
            elapsedSeconds: 2,
            solutionIndex: "x",
          }),
        ),
      ),
    ).toBeNull();
    // A fractional/negative optional value is out-of-domain → reject.
    expect(
      normalizeProgressFrame(
        frame(
          "job.progressed",
          JSON.stringify({
            source: "solver",
            currentBestScore: 7,
            elapsedSeconds: 2,
            commentCount: -1,
          }),
        ),
      ),
    ).toBeNull();
    // A genuinely ABSENT optional field becomes null (not a rejection).
    expect(
      normalizeProgressFrame(
        frame(
          "job.progressed",
          JSON.stringify({ source: "solver", currentBestScore: 7, elapsedSeconds: 2 }),
        ),
      ),
    ).toEqual({
      source: "solver",
      currentBestScore: 7,
      elapsedSeconds: 2,
      solutionIndex: null,
      commentCount: null,
    });
  });

  it("returns null for malformed JSON or non-object payloads", () => {
    expect(normalizeProgressFrame(frame("job.progressed", "{bad json"))).toBeNull();
    expect(normalizeProgressFrame(frame("job.progressed", "42"))).toBeNull();
    expect(normalizePhaseFrame(frame("job.phase_changed", "null"))).toBeNull();
  });

  it("rejects a chart point unless source non-empty AND both currentBestScore and elapsedSeconds are finite", () => {
    // Missing source → no chart point.
    expect(
      normalizeProgressFrame(frame("job.progressed", JSON.stringify({ currentBestScore: 5 }))),
    ).toBeNull();
    // Empty source → no chart point.
    expect(
      normalizeProgressFrame(
        frame(
          "job.progressed",
          JSON.stringify({ source: "", currentBestScore: 5, elapsedSeconds: 1 }),
        ),
      ),
    ).toBeNull();
    // Missing elapsedSeconds → no chart point.
    expect(
      normalizeProgressFrame(
        frame("job.progressed", JSON.stringify({ source: "solver", currentBestScore: 5 })),
      ),
    ).toBeNull();
    // Missing currentBestScore → no chart point.
    expect(
      normalizeProgressFrame(
        frame("job.progressed", JSON.stringify({ source: "solver", elapsedSeconds: 5 })),
      ),
    ).toBeNull();
    // Non-finite score → no chart point.
    expect(
      normalizeProgressFrame(
        frame(
          "job.progressed",
          JSON.stringify({ source: "solver", currentBestScore: Infinity, elapsedSeconds: 1 }),
        ),
      ),
    ).toBeNull();
    // Non-finite elapsed → no chart point.
    expect(
      normalizeProgressFrame(
        frame(
          "job.progressed",
          JSON.stringify({ source: "solver", currentBestScore: 1, elapsedSeconds: NaN }),
        ),
      ),
    ).toBeNull();
    // All valid → chart point.
    expect(
      normalizeProgressFrame(
        frame(
          "job.progressed",
          JSON.stringify({ source: "solver", currentBestScore: 1, elapsedSeconds: 0 }),
        ),
      ),
    ).not.toBeNull();
  });

  it("rejects a phase entry unless source, code, message are non-empty AND elapsedSeconds is finite", () => {
    const full = { source: "scheduler", code: "solve", message: "Solving", elapsedSeconds: 1 };
    // Missing source → null.
    expect(
      normalizePhaseFrame(
        frame("job.phase_changed", JSON.stringify({ ...full, source: undefined })),
      ),
    ).toBeNull();
    // Missing code → null.
    expect(
      normalizePhaseFrame(frame("job.phase_changed", JSON.stringify({ ...full, code: undefined }))),
    ).toBeNull();
    // Empty source → null.
    expect(
      normalizePhaseFrame(frame("job.phase_changed", JSON.stringify({ ...full, source: "" }))),
    ).toBeNull();
    // Strict (P1): missing message → null.
    expect(
      normalizePhaseFrame(
        frame("job.phase_changed", JSON.stringify({ ...full, message: undefined })),
      ),
    ).toBeNull();
    // Strict (P1): missing/non-finite elapsedSeconds → null.
    expect(
      normalizePhaseFrame(
        frame("job.phase_changed", JSON.stringify({ ...full, elapsedSeconds: undefined })),
      ),
    ).toBeNull();
    expect(
      normalizePhaseFrame(
        frame("job.phase_changed", JSON.stringify({ ...full, elapsedSeconds: "1" })),
      ),
    ).toBeNull();
    // All required fields present and well-typed → entry.
    expect(normalizePhaseFrame(frame("job.phase_changed", JSON.stringify(full)))).not.toBeNull();
  });

  it("normalizes a phase frame", () => {
    const entry = normalizePhaseFrame(
      frame(
        "job.phase_changed",
        JSON.stringify({
          source: "scheduler",
          code: "solve",
          message: "Solving",
          elapsedSeconds: 1,
        }),
      ),
    );
    expect(entry).toEqual({
      source: "scheduler",
      code: "solve",
      message: "Solving",
      elapsedSeconds: 1,
    });
  });

  it("routes only ephemeral frames through frameToSignal", () => {
    expect(
      frameToSignal(
        frame(
          "job.progressed",
          JSON.stringify({
            source: "solver",
            currentBestScore: 1,
            elapsedSeconds: 0,
            occurred_at: "2026-07-19T10:00:00Z",
          }),
        ),
      )?.type,
    ).toBe("progress");
    expect(
      frameToSignal(
        frame(
          "job.phase_changed",
          JSON.stringify({
            source: "s",
            code: "a",
            message: "Analyzing",
            elapsedSeconds: 1,
            occurred_at: "2026-07-19T10:00:00Z",
          }),
        ),
      )?.type,
    ).toBe("phase");
    // Durable frames are reconciled by the query cache, not turned into run signals.
    expect(frameToSignal(frame("job.state_changed", "{}"))).toBeNull();
    expect(frameToSignal(frame("job.result_available", "{}"))).toBeNull();
    // A malformed ephemeral frame is dropped, not signalled.
    expect(frameToSignal(frame("job.progressed", "{bad"))).toBeNull();
    // A progress frame without finite score+elapsed is dropped (no chart point).
    expect(
      frameToSignal(frame("job.progressed", JSON.stringify({ source: "s", currentBestScore: 1 }))),
    )?.toBe(null);
  });
});

describe("buildStreamCallbacks", () => {
  function collect() {
    const signals: RunSignal[] = [];
    return { signals, dispatch: (s: RunSignal) => signals.push(s) };
  }

  const terminalJob: JobResponse = {
    id: "opt_1",
    state: "completed",
    terminal: true,
    queue_position: null,
    created_at: "t",
    started_at: null,
    finished_at: null,
    request: { input_name: "s", solver: "x", prettify: null, timeout_seconds: 1 },
    result: { outcome: "optimal", score: 1, solver_status: "OPTIMAL", termination_reason: null },
    error: null,
    controls: { cancellable: false, early_completion_available: false },
    links: {
      self: "",
      events: "",
      cancellation: "",
      early_completion: "",
      schedule: "/optimize/opt_1/xlsx",
    },
  };

  it("dispatches a progress signal for an ephemeral frame (awaited)", async () => {
    const { signals, dispatch } = collect();
    const cbs = buildStreamCallbacks(dispatch);
    await cbs.onEvent(
      frame(
        "job.progressed",
        JSON.stringify({
          source: "solver",
          currentBestScore: 3,
          elapsedSeconds: 1,
          occurred_at: "2026-07-19T10:00:00Z",
        }),
      ),
    );
    expect(signals).toEqual([
      {
        type: "progress",
        point: {
          source: "solver",
          currentBestScore: 3,
          elapsedSeconds: 1,
          solutionIndex: null,
          commentCount: null,
        },
        cursor: "cur_1",
        occurredAt: "2026-07-19T10:00:00Z",
      },
    ]);
  });

  it("dispatches a durable-frame-applied signal for strictly valid durable frames", async () => {
    const { signals, dispatch } = collect();
    const cbs = buildStreamCallbacks(dispatch);
    // Strict T06 payload (state_changed enriched with terminal/controls/etc.)
    await cbs.onEvent(
      frame(
        "job.state_changed",
        JSON.stringify({
          state: "running",
          terminal: false,
          queue_position: null,
          cancel_requested: false,
          early_completion_requested: false,
          worker_id: "worker-1",
          controls: { cancellable: true, early_completion_available: true },
          occurred_at: "2026-07-19T10:00:00Z",
        }),
      ),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: "durable-frame-applied",
      event: "job.state_changed",
      cursor: "cur_1",
      detail: "state=running",
      occurredAt: "2026-07-19T10:00:00Z",
    });
  });

  it("durable-frame-applied extracts occurredAt from payload and requires T06-valid fields", async () => {
    const { signals, dispatch } = collect();
    const cbs = buildStreamCallbacks(dispatch);
    await cbs.onEvent(
      frame(
        "job.result_available",
        JSON.stringify({
          outcome: "optimal",
          score: 42,
          solver_status: "OPTIMAL",
          termination_reason: "optimality_proven",
          artifact_name: "schedule.xlsx",
          occurred_at: "2026-07-19T12:00:00Z",
        }),
      ),
    );
    expect(signals[0]).toMatchObject({
      type: "durable-frame-applied",
      event: "job.result_available",
      occurredAt: "2026-07-19T12:00:00Z",
      detail: "outcome=optimal, score=42",
    });
  });

  it("onCursorCommit forwards the committed cursor", () => {
    const commits: string[] = [];
    const { dispatch } = collect();
    const cbs = buildStreamCallbacks(dispatch, (c) => commits.push(c));
    cbs.onCursorCommit?.("cur_42");
    expect(commits).toEqual(["cur_42"]);
  });

  it("onCursorCommit is optional (no throw when omitted)", () => {
    const { dispatch } = collect();
    const cbs = buildStreamCallbacks(dispatch);
    expect(() => cbs.onCursorCommit?.("cur_1")).not.toThrow();
  });

  it("drops malformed ephemeral frames AND strictly-invalid durable frames (no placeholder entries)", async () => {
    const { signals, dispatch } = collect();
    const cbs = buildStreamCallbacks(dispatch);
    // A malformed ephemeral frame (bad JSON) dispatches nothing.
    await cbs.onEvent(frame("job.progressed", "{bad"));
    // A durable frame missing occurred_at dispatches nothing.
    await cbs.onEvent(
      frame(
        "job.state_changed",
        JSON.stringify({
          state: "running",
          terminal: false,
          queue_position: null,
          cancel_requested: false,
          early_completion_requested: false,
          controls: { cancellable: true, early_completion_available: true },
        }),
      ),
    );
    // A durable frame with a malformed T06 payload (unknown state) dispatches nothing.
    await cbs.onEvent(
      frame(
        "job.state_changed",
        JSON.stringify({
          state: "totally-unknown",
          terminal: false,
          queue_position: null,
          cancel_requested: false,
          early_completion_requested: false,
          controls: { cancellable: true, early_completion_available: true },
          occurred_at: "2026-07-19T12:00:00Z",
        }),
      ),
    );
    // A strictly valid durable frame dispatches a durable-frame-applied signal.
    await cbs.onEvent(
      frame(
        "job.control_changed",
        JSON.stringify({
          early_completion_requested: true,
          occurred_at: "2026-07-19T12:00:01Z",
        }),
      ),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: "durable-frame-applied",
      event: "job.control_changed",
      occurredAt: "2026-07-19T12:00:01Z",
      detail: "early_completion=true",
    });
  });

  it("maps terminal, job-gone, cursor recovery, reset, and transport error", () => {
    const { signals, dispatch } = collect();
    const cbs = buildStreamCallbacks(dispatch);

    cbs.onTerminal({ job: terminalJob });
    cbs.onJobGone(
      classifyOptimizeError(404, { error: { code: "job_not_found", message: "gone" } }),
    );
    cbs.onCursorExpired(
      classifyOptimizeError(409, {
        error: { code: "event_cursor_expired", message: "e", oldest_event_id: "cur_1" },
      }),
    );
    cbs.onCursorInvalid(
      classifyOptimizeError(400, { error: { code: "invalid_event_cursor", message: "i" } }),
    );
    cbs.onCursorReset();
    cbs.onError(new Error("budget exhausted"));

    expect(signals).toEqual([
      { type: "job-snapshot", job: terminalJob },
      { type: "job-gone", code: "job_not_found", message: "gone" },
      { type: "cursor-recovery", reason: "expired", oldestEventId: "cur_1" },
      { type: "cursor-recovery", reason: "invalid" },
      { type: "cursor-reset" },
      { type: "stream-error", message: "budget exhausted" },
    ]);
  });

  it("onTerminal without a job dispatches nothing (stream close is not a result)", () => {
    const dispatch = vi.fn();
    buildStreamCallbacks(dispatch).onTerminal({});
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("occurred_at timestamp-domain validation (P1 #5)", () => {
  // A progress frame carrying a chosen occurred_at value (ephemeral path).
  const progressFrame = (occurredAt: unknown): SseFrame =>
    frame(
      "job.progressed",
      JSON.stringify({
        source: "solver",
        currentBestScore: 1,
        elapsedSeconds: 0,
        occurred_at: occurredAt,
      }),
    );
  // A strict T06 state frame carrying a chosen occurred_at value (durable path).
  const stateFrame = (occurredAt: unknown): SseFrame =>
    frame(
      "job.state_changed",
      JSON.stringify({
        state: "running",
        terminal: false,
        queue_position: null,
        cancel_requested: false,
        early_completion_requested: false,
        worker_id: "worker-1",
        controls: { cancellable: true, early_completion_available: true },
        occurred_at: occurredAt,
      }),
    );

  const ACCEPTED = [
    "2026-07-19T10:00:00+00:00", // backend datetime.isoformat() UTC
    "2026-07-19T10:00:00.123456+00:00", // with microseconds
    "2026-07-19T10:00:00+08:00", // positive offset
    "2026-07-19T10:00:00-05:00", // negative offset
    "2026-07-19T10:00:00Z", // Z designator
    "2028-02-29T23:59:59+00:00", // real leap day
    "2026-07-19T10:00:00+14:00", // max positive offset (exactly ±14:00)
    "2026-07-19T10:00:00-14:00", // max negative offset
    "0001-01-01T00:00:00+00:00", // earliest Python-emittable year
  ];
  const REJECTED = [
    "2026-07-19T10:00:00", // naive — no timezone offset
    " 2026-07-19T10:00:00+00:00 ", // surrounding whitespace (trim is not acceptance)
    "2026-07-19T10:00:00+00:00 ", // trailing whitespace
    "not-a-date",
    "", // empty
    "2026-13-19T10:00:00+00:00", // impossible month
    "2026-07-40T10:00:00+00:00", // impossible day
    "2026-02-29T00:00:00+00:00", // 2026 is not a leap year
    "2026-07-19T25:00:00+00:00", // impossible hour
    "2026-07-19T10:61:00+00:00", // impossible minute
    "2026-07-19 10:00:00+00:00", // space instead of T
    "0000-01-01T00:00:00+00:00", // year 0000 — impossible for Python datetime
    "2026-07-19T10:00:00+14:01", // offset one minute past the ±14:00 max
    "2026-07-19T10:00:00+14:59", // offset within-hour but past the max
    "2026-07-19T10:00:00-14:30", // negative offset past the max
    "2026-07-19T10:00:00+15:00", // offset hour past the max
  ];

  it.each(ACCEPTED)("accepts a real timezone-bearing ISO datetime: %s", (ts) => {
    expect(frameToSignal(progressFrame(ts))).not.toBeNull();
    expect(durableFrameSignal(stateFrame(ts))).not.toBeNull();
  });

  it.each(REJECTED)("rejects a non-domain occurred_at (no log entry): %s", (ts) => {
    expect(frameToSignal(progressFrame(ts))).toBeNull();
    expect(durableFrameSignal(stateFrame(ts))).toBeNull();
  });

  it("rejects the camelCase occurredAt alias (canonical envelope is snake_case)", () => {
    const aliased = frame(
      "job.progressed",
      JSON.stringify({
        source: "solver",
        currentBestScore: 1,
        elapsedSeconds: 0,
        occurredAt: "2026-07-19T10:00:00+00:00",
      }),
    );
    expect(frameToSignal(aliased)).toBeNull();
  });

  it("carries the exact valid timestamp through to the signal (no normalization)", () => {
    const ts = "2026-07-19T10:00:00.500000+00:00";
    const sig = frameToSignal(progressFrame(ts));
    expect(sig).toMatchObject({ type: "progress", occurredAt: ts });
    const durable = durableFrameSignal(stateFrame(ts));
    expect(durable).toMatchObject({ type: "durable-frame-applied", occurredAt: ts });
  });
});
