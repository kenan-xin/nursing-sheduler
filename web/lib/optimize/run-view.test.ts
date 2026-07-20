import { describe, expect, it } from "vitest";
import type { JobResponse, JobState } from "@/lib/bff/types";
import {
  INITIAL_OPTIMIZE_RUN_VIEW,
  MAX_LOG_ENTRIES,
  MAX_PHASE_ENTRIES,
  MAX_PROGRESS_POINTS,
  isActiveLifecycle,
  isSettledLifecycle,
  reduceRunView,
  reduceRunViewAll,
  type OptimizeRunView,
  type RunLogPayload,
  type RunProgressPoint,
  type RunSignal,
} from "./run-view";

// Typed validated payloads a durable-frame-applied signal now carries (P1 #4). The
// controller builds these from the T06 parsers; the reducer only routes/logs them.
const statePayload = (over: Partial<Extract<RunLogPayload, { kind: "state" }>> = {}) =>
  ({
    kind: "state",
    state: "running",
    terminal: false,
    queuePosition: null,
    cancelRequested: false,
    earlyCompletionRequested: false,
    cancellable: true,
    earlyCompletionAvailable: false,
    error: null,
    ...over,
  }) satisfies RunLogPayload;

const controlPayload = (earlyCompletionRequested = true): RunLogPayload => ({
  kind: "control",
  earlyCompletionRequested,
});

const resultPayload = (over: Partial<Extract<RunLogPayload, { kind: "result" }>> = {}) =>
  ({
    kind: "result",
    outcome: "optimal",
    score: 42,
    solverStatus: "OPTIMAL",
    terminationReason: null,
    artifactName: null,
    ...over,
  }) satisfies RunLogPayload;

// A JobResponse fixture. `over` patches the running-job baseline.
function job(over: Partial<JobResponse> = {}): JobResponse {
  return {
    id: "opt_1",
    state: "running",
    terminal: false,
    queue_position: null,
    created_at: "t0",
    started_at: null,
    finished_at: null,
    request: { input_name: "s.yaml", solver: "cp-sat", prettify: null, timeout_seconds: 300 },
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: true },
    links: {
      self: "/optimize/opt_1",
      events: "/optimize/opt_1/events",
      cancellation: "/optimize/opt_1/cancel",
      early_completion: "/optimize/opt_1/finish-now",
      schedule: null,
    },
    ...over,
  };
}

function terminalJob(state: JobState, over: Partial<JobResponse> = {}): JobResponse {
  return job({
    state,
    terminal: true,
    controls: { cancellable: false, early_completion_available: false },
    ...over,
  });
}

const point = (over: Partial<RunProgressPoint> = {}): RunProgressPoint => ({
  source: "solver",
  currentBestScore: 10,
  elapsedSeconds: 1,
  solutionIndex: 0,
  commentCount: null,
  ...over,
});

const reduce = (signals: RunSignal[], from?: OptimizeRunView) => reduceRunViewAll(signals, from);

describe("reduceRunView — submission lifecycle", () => {
  it("submit-started resets prior run state and enters submitting", () => {
    const dirty = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 3 },
      { type: "progress", point: point() },
      { type: "job-snapshot", job: job() },
    ]);
    const next = reduceRunView(dirty, { type: "submit-started", anonymized: true, peopleCount: 5 });

    expect(next.lifecycle).toBe("submitting");
    expect(next.anonymized).toBe(true);
    expect(next.peopleCount).toBe(5);
    // Prior incumbent, progress, job id, and controls are cleared (FR-OE-40).
    expect(next.jobId).toBeNull();
    expect(next.progress).toEqual([]);
    expect(next.latestScore).toBeNull();
    expect(next.controls).toEqual({ cancellable: false, earlyCompletionAvailable: false });
    // seq keeps advancing across runs for a monotonic log order.
    expect(next.seq).toBeGreaterThan(dirty.seq);
  });

  it("submit-blocked records a session error and never marks resubmittable", () => {
    const next = reduce([
      { type: "submit-started", anonymized: true, peopleCount: 2 },
      { type: "submit-blocked", code: "session-conflict", message: "A run is already staged." },
    ]);
    expect(next.lifecycle).toBe("submit-blocked");
    expect(next.error).toEqual({
      source: "session",
      code: "session-conflict",
      message: "A run is already staged.",
    });
    expect(next.jobId).toBeNull();
    expect(next.resubmittable).toBe(false);
    expect(next.sessionRecovery.reloadRecoveryAvailable).toBe(false);
  });

  it("submit-rejected is resubmittable (no job was created)", () => {
    const next = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 2 },
      { type: "submit-rejected", code: "invalid_scheduling_data", message: "bad" },
    ]);
    expect(next.lifecycle).toBe("submit-rejected");
    expect(next.error).toEqual({
      source: "submit",
      code: "invalid_scheduling_data",
      message: "bad",
    });
    expect(next.resubmittable).toBe(true);
  });

  it("submit-unknown is NOT resubmittable (a job may exist)", () => {
    const next = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 2 },
      { type: "submit-unknown", code: null, message: "network" },
    ]);
    expect(next.lifecycle).toBe("submit-unknown");
    expect(next.error).toEqual({ source: "submit", code: null, message: "network" });
    expect(next.resubmittable).toBe(false);
  });
});

describe("reduceRunView — activation + reload recovery", () => {
  it("job-activated with a durable record marks reload recovery available", () => {
    const next = reduce([
      { type: "submit-started", anonymized: true, peopleCount: 2 },
      { type: "job-activated", jobId: "opt_9", reloadRecoveryAvailable: true },
    ]);
    expect(next.jobId).toBe("opt_9");
    expect(next.sessionRecovery).toEqual({ reloadRecoveryAvailable: true, reason: null });
  });

  it("a degraded post-202 activation keeps the job but denies reload recovery", () => {
    const next = reduce([
      { type: "submit-started", anonymized: true, peopleCount: 2 },
      {
        type: "job-activated",
        jobId: "opt_9",
        reloadRecoveryAvailable: false,
        reason: "owner-conflict",
      },
    ]);
    expect(next.jobId).toBe("opt_9");
    expect(next.sessionRecovery).toEqual({
      reloadRecoveryAvailable: false,
      reason: "owner-conflict",
    });
  });
});

describe("reduceRunView — authoritative job snapshots", () => {
  it("adopts server lifecycle, queue position, and controls verbatim", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: job({
        state: "queued",
        queue_position: 4,
        controls: { cancellable: true, early_completion_available: false },
      }),
    });
    expect(next.lifecycle).toBe("queued");
    expect(next.queuePosition).toBe(4);
    expect(next.controls).toEqual({ cancellable: true, earlyCompletionAvailable: false });
    expect(isActiveLifecycle(next.lifecycle)).toBe(true);
  });

  it("cancelling is a distinct active lifecycle", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: job({
        state: "cancelling",
        controls: { cancellable: false, early_completion_available: false },
      }),
    });
    expect(next.lifecycle).toBe("cancelling");
    expect(isActiveLifecycle("cancelling")).toBe(true);
  });

  it("completed with an artifact exposes the result and a downloadable schedule", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: terminalJob("completed", {
        result: {
          outcome: "optimal",
          score: 42,
          solver_status: "OPTIMAL",
          termination_reason: null,
        },
        links: { ...job().links, schedule: "/optimize/opt_1/xlsx" },
      }),
    });
    expect(next.lifecycle).toBe("completed");
    expect(next.outcome).toBe("optimal");
    expect(next.result).toEqual({
      outcome: "optimal",
      score: 42,
      solverStatus: "OPTIMAL",
      terminationReason: null,
    });
    expect(next.latestScore).toBe(42);
    expect(next.download.artifactAvailable).toBe(true);
    expect(next.download.status).toBe("available");
    expect(isSettledLifecycle(next.lifecycle)).toBe(true);
  });

  it("completed infeasible with no artifact marks the download unavailable", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: terminalJob("completed", {
        result: {
          outcome: "infeasible",
          score: null,
          solver_status: "INFEASIBLE",
          termination_reason: "x",
        },
      }),
    });
    expect(next.outcome).toBe("infeasible");
    expect(next.download.status).toBe("unavailable");
    expect(next.download.artifactAvailable).toBe(false);
    expect(next.resubmittable).toBe(false);
  });

  it("cancelled is terminal with controls cleared", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: terminalJob("cancelled"),
    });
    expect(next.lifecycle).toBe("cancelled");
    expect(next.controls).toEqual({ cancellable: false, earlyCompletionAvailable: false });
  });

  it("failed carries the structured error; a generic failure is not resubmittable", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: terminalJob("failed", { error: { code: "solver_error", message: "boom" } }),
    });
    expect(next.lifecycle).toBe("failed");
    expect(next.error).toEqual({ source: "job", code: "solver_error", message: "boom" });
    expect(next.resubmittable).toBe(false);
  });

  it("worker_lost is a failed job that offers Resubmit, keyed on error.code only", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: terminalJob("failed", {
        error: {
          code: "worker_lost",
          message: "The optimization worker stopped before the job completed.",
        },
      }),
    });
    expect(next.lifecycle).toBe("failed");
    expect(next.error?.code).toBe("worker_lost");
    expect(next.resubmittable).toBe(true);
  });

  it("process_timeout is a structured terminal failure but does NOT offer Resubmit", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: terminalJob("failed", {
        error: {
          code: "process_timeout",
          message: "The optimization exceeded its timeout and was force-terminated.",
        },
      }),
    });
    expect(next.lifecycle).toBe("failed");
    expect(next.error).toEqual({
      source: "job",
      code: "process_timeout",
      message: "The optimization exceeded its timeout and was force-terminated.",
    });
    expect(next.resubmittable).toBe(false);
  });

  it("a later snapshot without an error clears a prior job error authoritatively", () => {
    const withError = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: job({ error: { code: "transient", message: "x" } }),
    });
    const cleared = reduceRunView(withError, { type: "job-snapshot", job: job({ error: null }) });
    expect(cleared.error).toBeNull();
  });
});

describe("reduceRunView — ephemeral progress + phase histories", () => {
  it("appends normalized progress points and tracks the live score", () => {
    const next = reduce([
      { type: "job-snapshot", job: job() },
      { type: "progress", point: point({ currentBestScore: 5 }) },
      { type: "progress", point: point({ currentBestScore: 9 }) },
    ]);
    expect(next.progress).toHaveLength(2);
    expect(next.latestScore).toBe(9);
  });

  it("progress chart points always carry finite non-null score and elapsed", () => {
    // The normalizer guarantees both axes are finite numbers; the reducer
    // trusts that and always sets latestScore from the point.
    const next = reduce([
      { type: "progress", point: point({ currentBestScore: 7, elapsedSeconds: 2 }) },
      { type: "progress", point: point({ currentBestScore: 9, elapsedSeconds: 3 }) },
    ]);
    expect(next.latestScore).toBe(9);
    expect(next.progress[0].currentBestScore).toBe(7);
    expect(next.progress[0].elapsedSeconds).toBe(2);
  });

  it("appends phase entries", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "phase",
      entry: { source: "scheduler", code: "phase_a", message: "Phase A", elapsedSeconds: 0.5 },
    });
    expect(next.phases).toEqual([
      { source: "scheduler", code: "phase_a", message: "Phase A", elapsedSeconds: 0.5 },
    ]);
  });

  it("bounds progress history and evicts the oldest deterministically", () => {
    let view = INITIAL_OPTIMIZE_RUN_VIEW;
    for (let i = 0; i < MAX_PROGRESS_POINTS + 5; i += 1) {
      view = reduceRunView(view, { type: "progress", point: point({ solutionIndex: i }) });
    }
    expect(view.progress).toHaveLength(MAX_PROGRESS_POINTS);
    // The first five points were evicted; the window starts at index 5.
    expect(view.progress[0].solutionIndex).toBe(5);
    expect(view.progress[view.progress.length - 1].solutionIndex).toBe(MAX_PROGRESS_POINTS + 4);
  });

  it("bounds phase history", () => {
    let view = INITIAL_OPTIMIZE_RUN_VIEW;
    for (let i = 0; i < MAX_PHASE_ENTRIES + 3; i += 1) {
      view = reduceRunView(view, {
        type: "phase",
        entry: { source: "s", code: `c${i}`, message: "m", elapsedSeconds: i },
      });
    }
    expect(view.phases).toHaveLength(MAX_PHASE_ENTRIES);
  });

  it("bounds the unified event log", () => {
    let view = INITIAL_OPTIMIZE_RUN_VIEW;
    for (let i = 0; i < MAX_LOG_ENTRIES + 10; i += 1) {
      view = reduceRunView(view, { type: "progress", point: point() });
    }
    expect(view.log).toHaveLength(MAX_LOG_ENTRIES);
    // seq keeps counting past the bound; ordering never collides.
    expect(view.log[view.log.length - 1].seq).toBe(MAX_LOG_ENTRIES + 10);
  });
});

describe("reduceRunView — cursor recovery + transport", () => {
  it("cursor recovery clears ephemeral history and records the reason", () => {
    const next = reduce([
      { type: "job-snapshot", job: job() },
      { type: "progress", point: point() },
      { type: "phase", entry: { source: "s", code: "c", message: "m", elapsedSeconds: 0 } },
      { type: "cursor-recovery", reason: "expired", oldestEventId: "cur_42" },
    ]);
    expect(next.progress).toEqual([]);
    expect(next.phases).toEqual([]);
    expect(next.cursorRecovery).toEqual({ reason: "expired", oldestEventId: "cur_42" });
    // The authoritative job lifecycle survives the recovery.
    expect(next.lifecycle).toBe("running");
  });

  it("invalid-cursor recovery carries no oldest id", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "cursor-recovery",
      reason: "invalid",
    });
    expect(next.cursorRecovery).toEqual({ reason: "invalid", oldestEventId: null });
  });

  it("stream-error records a transport error without changing lifecycle", () => {
    const next = reduce([
      { type: "job-snapshot", job: job({ state: "running" }) },
      { type: "stream-error", message: "reconnect budget exhausted" },
    ]);
    expect(next.lifecycle).toBe("running");
    expect(next.error).toEqual({
      source: "stream",
      code: null,
      message: "reconnect budget exhausted",
    });
  });

  it("control-error records a control error without changing lifecycle or controls", () => {
    const next = reduce([
      { type: "job-snapshot", job: job({ state: "running" }) },
      { type: "control-error", code: "job_operation_not_allowed", message: "cannot cancel" },
    ]);
    expect(next.lifecycle).toBe("running");
    expect(next.controls).toEqual({ cancellable: true, earlyCompletionAvailable: true });
    expect(next.error).toEqual({
      source: "control",
      code: "job_operation_not_allowed",
      message: "cannot cancel",
    });
  });

  it("job-gone becomes a failed recovery, clears download, and is resubmittable", () => {
    const next = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 1 },
      {
        type: "job-activated",
        jobId: "opt_1",
        reloadRecoveryAvailable: true,
      },
      { type: "job-snapshot", job: job({ state: "running" }) },
      { type: "job-gone", code: "job_not_found", message: "gone" },
    ]);
    expect(next.lifecycle).toBe("failed");
    expect(next.jobId).toBeNull();
    expect(next.error).toEqual({ source: "job", code: "job_not_found", message: "gone" });
    expect(next.download.artifactAvailable).toBe(false);
    // cleanup status is NOT "cleaned" — T16q removal hasn't run yet.
    expect(next.cleanup.status).toBe("idle");
    expect(next.resubmittable).toBe(true);
    expect(next.sessionRecovery.reloadRecoveryAvailable).toBe(false);
  });
});

describe("reduceRunView — download + cleanup progression", () => {
  it("walks download from available through downloaded", () => {
    const next = reduce([
      {
        type: "job-snapshot",
        job: terminalJob("completed", {
          result: {
            outcome: "optimal",
            score: 1,
            solver_status: "OPTIMAL",
            termination_reason: null,
          },
          links: { ...job().links, schedule: "/optimize/opt_1/xlsx" },
        }),
      },
      { type: "download-started" },
      { type: "download-succeeded", filename: "schedule.xlsx" },
    ]);
    expect(next.download.status).toBe("downloaded");
    expect(next.download.filename).toBe("schedule.xlsx");
  });

  it("a failed download returns to available for retry", () => {
    const next = reduce([
      { type: "download-started" },
      { type: "download-failed", message: "network" },
    ]);
    expect(next.download.status).toBe("available");
    expect(next.error?.message).toBe("network");
  });

  it("cleanup can succeed, fail, or be retained", () => {
    expect(
      reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, { type: "cleanup-succeeded" }).cleanup.status,
    ).toBe("cleaned");
    expect(
      reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, { type: "cleanup-failed" }).cleanup.status,
    ).toBe("failed");
    expect(
      reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, { type: "cleanup-retained" }).cleanup.status,
    ).toBe("retained");
  });
});

describe("reduceRunView — reset", () => {
  it("reset returns to idle but preserves the monotonic seq", () => {
    const dirty = reduce([
      { type: "submit-started", anonymized: true, peopleCount: 3 },
      { type: "job-snapshot", job: job() },
      { type: "progress", point: point() },
    ]);
    const next = reduceRunView(dirty, { type: "reset" });
    expect(next.lifecycle).toBe("idle");
    expect(next.jobId).toBeNull();
    expect(next.progress).toEqual([]);
    expect(next.log).toEqual([]);
    expect(next.seq).toBe(dirty.seq);
  });

  it("does not mutate the input view", () => {
    const before = { ...INITIAL_OPTIMIZE_RUN_VIEW };
    reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, { type: "progress", point: point() });
    expect(INITIAL_OPTIMIZE_RUN_VIEW).toEqual(before);
    expect(INITIAL_OPTIMIZE_RUN_VIEW.progress).toEqual([]);
  });
});

describe("reduceRunView — snapshots never append log entries (P1 #4)", () => {
  it("a job-snapshot updates authoritative fields but appends ZERO log entries", () => {
    let view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "job-snapshot",
      job: job({ state: "queued", queue_position: 3 }),
    });
    // No log entry — the bounded wire-event budget is reserved for SSE-applied
    // frames (not poll/cache/control reconciliation). `seq` does not advance.
    expect(view.log).toHaveLength(0);
    expect(view.seq).toBe(0);
    expect(view.lifecycle).toBe("queued");
    expect(view.queuePosition).toBe(3);

    // A second snapshot updates the authoritative field, still no log.
    view = reduceRunView(view, {
      type: "job-snapshot",
      job: job({ state: "queued", queue_position: 2 }),
    });
    expect(view.log).toHaveLength(0);
    expect(view.seq).toBe(0);
    expect(view.queuePosition).toBe(2);

    // A lifecycle CHANGE via snapshot still appends no log entry.
    view = reduceRunView(view, { type: "job-snapshot", job: job({ state: "running" }) });
    expect(view.log).toHaveLength(0);
    expect(view.seq).toBe(0);
    expect(view.lifecycle).toBe("running");
  });

  it("a terminal snapshot updates lifecycle/result but appends no log entry", () => {
    const view = reduce([
      { type: "job-snapshot", job: job({ state: "running" }) },
      { type: "job-snapshot", job: terminalJob("completed") },
    ]);
    expect(view.log).toHaveLength(0);
    expect(view.lifecycle).toBe("completed");
  });

  it("only submit-started/job-activated (never snapshots) append lifecycle log entries", () => {
    let view = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 1 },
      { type: "job-snapshot", job: job({ state: "running" }) },
    ]);
    // submit-started logged; the snapshot did NOT.
    expect(view.log).toHaveLength(1);
    expect(view.log[0]).toMatchObject({ kind: "lifecycle", label: "submitting" });

    view = reduceRunView(view, {
      type: "job-activated",
      jobId: "opt_2",
      reloadRecoveryAvailable: true,
    });
    // job-activated logged; a subsequent snapshot still does not append.
    expect(view.log).toHaveLength(2);
    view = reduceRunView(view, {
      type: "job-snapshot",
      job: job({ id: "opt_2", state: "running" }),
    });
    expect(view.log).toHaveLength(2);
  });

  it("progress entries carry score/elapsed detail and timing", () => {
    const view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "progress",
      point: point({
        currentBestScore: 42,
        elapsedSeconds: 3.5,
        solutionIndex: 7,
        commentCount: 2,
      }),
    });
    expect(view.log[0]).toMatchObject({
      kind: "progress",
      detail: "score=42, elapsed=3.5s, solution=#7, comments=2",
      elapsedSeconds: 3.5,
    });
  });

  it("phase entries carry code/message detail and timing", () => {
    const view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "phase",
      entry: { source: "scheduler", code: "solve", message: "Solving", elapsedSeconds: 1.2 },
    });
    expect(view.log[0]).toMatchObject({
      kind: "phase",
      detail: "solve: Solving",
      elapsedSeconds: 1.2,
    });
  });

  it("submit-started carries anonymized + peopleCount detail", () => {
    const view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "submit-started",
      anonymized: true,
      peopleCount: 5,
    });
    expect(view.log[0].detail).toBe("anonymized=true, people=5");
  });

  it("cursor-recovery carries oldestEventId detail", () => {
    const view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "cursor-recovery",
      reason: "expired",
      oldestEventId: "cur_99",
    });
    expect(view.log[0]).toMatchObject({ kind: "recovery", detail: "cur_99" });
  });

  it("log entries default eventTime to null (the controller stamps it)", () => {
    const view = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "progress",
      point: point({ currentBestScore: 1, elapsedSeconds: 0 }),
    });
    expect(view.log[0].eventTime).toBeNull();
  });
});

describe("reduceRunView — control-job-gone", () => {
  it("control-job-gone detaches the job and is resubmittable", () => {
    const withJob = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 1 },
      {
        type: "job-activated",
        jobId: "opt_1",
        reloadRecoveryAvailable: true,
      },
      { type: "job-snapshot", job: job({ state: "running" }) },
    ]);
    expect(withJob.jobId).toBe("opt_1");

    const next = reduceRunView(withJob, {
      type: "control-job-gone",
      code: "job_not_found",
      message: "gone",
    });
    expect(next.lifecycle).toBe("failed");
    expect(next.jobId).toBeNull();
    expect(next.error).toEqual({ source: "job", code: "job_not_found", message: "gone" });
    expect(next.resubmittable).toBe(true);
    expect(next.download.artifactAvailable).toBe(false);
    expect(next.cleanup.status).toBe("idle");
  });

  it("control-error preserves lifecycle, controls, and jobId", () => {
    const withJob = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 1 },
      { type: "job-snapshot", job: job({ state: "running" }) },
    ]);
    const next = reduceRunView(withJob, {
      type: "control-error",
      code: "job_operation_not_allowed",
      message: "cannot",
    });
    expect(next.lifecycle).toBe("running");
    expect(next.jobId).toBe("opt_1");
    expect(next.controls).toEqual({ cancellable: true, earlyCompletionAvailable: true });
    expect(next.error).toEqual({
      source: "control",
      code: "job_operation_not_allowed",
      message: "cannot",
    });
  });
});

describe("reduceRunView — durable-frame-applied (P1 #4)", () => {
  it("logs a durable state_changed frame with event name and cursor", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "durable-frame-applied",
      event: "job.state_changed",
      cursor: "cur_42",
      payload: statePayload({ queuePosition: 2 }),
      detail: "state=running, queue=2",
    });
    expect(next.log).toHaveLength(1);
    expect(next.log[0]).toMatchObject({
      kind: "state",
      event: "job.state_changed",
      cursor: "cur_42",
      detail: "state=running, queue=2",
      payload: { kind: "state", queuePosition: 2 },
    });
  });

  it("logs a result_available frame with occurredAt", () => {
    const next = reduceRunView(INITIAL_OPTIMIZE_RUN_VIEW, {
      type: "durable-frame-applied",
      event: "job.result_available",
      cursor: "cur_99",
      payload: resultPayload(),
      detail: "outcome=optimal, score=42",
      occurredAt: "2026-07-19T12:00:00Z",
    });
    expect(next.log[0]).toMatchObject({
      kind: "result",
      event: "job.result_available",
      occurredAt: "2026-07-19T12:00:00Z",
      payload: { kind: "result", outcome: "optimal", score: 42 },
    });
  });

  it("does NOT change lifecycle/controls (state arrives via job-snapshot)", () => {
    const base = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 1 },
      { type: "job-snapshot", job: job({ state: "running" }) },
    ]);
    const next = reduceRunView(base, {
      type: "durable-frame-applied",
      event: "job.state_changed",
      cursor: "c1",
      payload: statePayload({ state: "completed", terminal: true }),
      detail: "state=completed",
    });
    // Lifecycle unchanged — the durable frame only logs; the cache
    // reconciliation + poll will deliver the authoritative snapshot.
    expect(next.lifecycle).toBe("running");
    expect(next.log.at(-1)).toMatchObject({ event: "job.state_changed" });
  });

  it("preserves exact wire order across durable and ephemeral frames", () => {
    const next = reduce([
      { type: "submit-started", anonymized: false, peopleCount: 1 },
      { type: "job-snapshot", job: job({ state: "running" }) },
      {
        type: "durable-frame-applied",
        event: "job.state_changed",
        cursor: "c1",
        payload: statePayload(),
        detail: "state=running",
      },
      {
        type: "progress",
        point: point({ currentBestScore: 5, elapsedSeconds: 1 }),
        cursor: "c2",
      },
      {
        type: "durable-frame-applied",
        event: "job.control_changed",
        cursor: "c3",
        payload: controlPayload(true),
        detail: "early_completion=true",
      },
      {
        type: "phase",
        entry: { source: "s", code: "solve", message: "Solving", elapsedSeconds: 2 },
        cursor: "c4",
      },
      {
        type: "durable-frame-applied",
        event: "job.result_available",
        cursor: "c5",
        payload: resultPayload(),
        detail: "outcome=optimal, score=42",
      },
    ]);
    // The log preserves the exact wire order: state, progress, control, phase, result.
    const events = next.log
      .filter((e) => e.event !== null)
      .map((e) => ({ event: e.event, cursor: e.cursor }));
    expect(events).toEqual([
      { event: "job.state_changed", cursor: "c1" },
      { event: "job.progressed", cursor: "c2" },
      { event: "job.control_changed", cursor: "c3" },
      { event: "job.phase_changed", cursor: "c4" },
      { event: "job.result_available", cursor: "c5" },
    ]);
  });
});
