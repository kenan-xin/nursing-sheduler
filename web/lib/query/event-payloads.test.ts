import { describe, expect, it } from "vitest";
import {
  isTerminalJobState,
  parseControlChangedPayload,
  parseResultAvailablePayload,
  parseStateChangedPayload,
} from "@/lib/query/event-payloads";

// Fixtures mirror the EXACT frames the T19 backend serializes (controller.py +
// api/optimize.py::_enrich_state_event + sse.py, which merges `occurred_at`).

describe("parseStateChangedPayload", () => {
  it("parses an enriched running state frame (occurred_at ignored)", () => {
    const payload = parseStateChangedPayload({
      occurred_at: "2026-07-19T00:00:00+00:00",
      state: "running",
      queue_position: null,
      cancel_requested: false,
      early_completion_requested: false,
      terminal: false,
      controls: { cancellable: true, early_completion_available: true },
    });
    expect(payload).toEqual({
      state: "running",
      terminal: false,
      queue_position: null,
      cancel_requested: false,
      early_completion_requested: false,
      controls: { cancellable: true, early_completion_available: true },
    });
  });

  it("parses a queued frame carrying a queue position", () => {
    expect(
      parseStateChangedPayload({
        state: "queued",
        queue_position: 3,
        cancel_requested: false,
        early_completion_requested: false,
        terminal: false,
        controls: { cancellable: true, early_completion_available: false },
      })?.queue_position,
    ).toBe(3);
  });

  it("parses a terminal worker_lost failure with its top-level error", () => {
    const payload = parseStateChangedPayload({
      state: "failed",
      queue_position: null,
      cancel_requested: false,
      early_completion_requested: false,
      terminal: true,
      controls: { cancellable: false, early_completion_available: false },
      error: {
        code: "worker_lost",
        message: "The optimization worker stopped before the job completed.",
      },
    });
    expect(payload?.terminal).toBe(true);
    expect(payload?.error?.code).toBe("worker_lost");
  });

  it("returns null on impossible/nested shapes and missing required fields", () => {
    // The old (wrong) fixture shape: nested controls without the flat fields.
    expect(parseStateChangedPayload({ controls: { cancellable: true } })).toBeNull();
    expect(parseStateChangedPayload({ state: "running", terminal: false })).toBeNull(); // no controls
    expect(
      parseStateChangedPayload({
        state: "running",
        queue_position: "3", // wrong type
        cancel_requested: false,
        early_completion_requested: false,
        terminal: false,
        controls: { cancellable: true, early_completion_available: true },
      }),
    ).toBeNull();
    expect(parseStateChangedPayload(null)).toBeNull();
  });

  const validState = (over: Record<string, unknown>) => ({
    state: "running",
    queue_position: null,
    cancel_requested: false,
    early_completion_requested: false,
    terminal: false,
    controls: { cancellable: true, early_completion_available: true },
    ...over,
  });

  // Every state paired with its lifecycle-correct `terminal` flag: the three live
  // states are non-terminal, the three sink states are terminal.
  const stateTerminalPairs: Array<[string, boolean]> = [
    ["queued", false],
    ["running", false],
    ["cancelling", false],
    ["completed", true],
    ["cancelled", true],
    ["failed", true],
  ];

  it("accepts every exact JobState with its correct terminal flag and rejects an unknown state", () => {
    for (const [state, terminal] of stateTerminalPairs) {
      const payload = parseStateChangedPayload(validState({ state, terminal }));
      expect(payload?.state).toBe(state);
      expect(payload?.terminal).toBe(terminal);
    }
    // Wrong state, correct terminal shape → still rejected on the state domain.
    expect(parseStateChangedPayload(validState({ state: "optimal" }))).toBeNull(); // outcome, not a state
    expect(parseStateChangedPayload(validState({ state: "RUNNING" }))).toBeNull(); // wrong case
    expect(parseStateChangedPayload(validState({ state: "bogus" }))).toBeNull();
  });

  it("requires terminal to match lifecycle terminality (rejects both inconsistency directions)", () => {
    // Correct pairings parse; the matching wrong-direction pairing is null.
    for (const [state, terminal] of stateTerminalPairs) {
      expect(parseStateChangedPayload(validState({ state, terminal }))?.state).toBe(state);
      expect(parseStateChangedPayload(validState({ state, terminal: !terminal }))).toBeNull();
    }
    // A live state falsely marked terminal must not be trusted.
    expect(parseStateChangedPayload(validState({ state: "running", terminal: true }))).toBeNull();
    expect(parseStateChangedPayload(validState({ state: "queued", terminal: true }))).toBeNull();
    expect(
      parseStateChangedPayload(validState({ state: "cancelling", terminal: true })),
    ).toBeNull();
    // A terminal state falsely marked non-terminal must reconcile, not apply as live.
    expect(
      parseStateChangedPayload(validState({ state: "completed", terminal: false })),
    ).toBeNull();
    expect(
      parseStateChangedPayload(validState({ state: "cancelled", terminal: false })),
    ).toBeNull();
    expect(
      parseStateChangedPayload(validState({ state: "failed", terminal: false, error: undefined })),
    ).toBeNull();
  });

  it("validates queue_position as null or a non-negative integer (rejects negative/fractional)", () => {
    expect(parseStateChangedPayload(validState({ queue_position: 0 }))?.queue_position).toBe(0);
    expect(parseStateChangedPayload(validState({ queue_position: 7 }))?.queue_position).toBe(7);
    expect(
      parseStateChangedPayload(validState({ queue_position: null }))?.queue_position,
    ).toBeNull();
    expect(parseStateChangedPayload(validState({ queue_position: -1 }))).toBeNull();
    expect(parseStateChangedPayload(validState({ queue_position: 1.5 }))).toBeNull();
    expect(parseStateChangedPayload(validState({ queue_position: Number.NaN }))).toBeNull();
  });

  it("forces reconciliation for a supplied-but-malformed error (never silently dropped)", () => {
    expect(parseStateChangedPayload(validState({ error: { code: "x" } }))).toBeNull(); // missing message
    expect(parseStateChangedPayload(validState({ error: { message: "m" } }))).toBeNull(); // missing code
    expect(parseStateChangedPayload(validState({ error: "boom" }))).toBeNull(); // not an object
    expect(parseStateChangedPayload(validState({ error: { code: 1, message: "m" } }))).toBeNull(); // wrong type
    // A well-formed error is kept; an explicit null means "no error".
    expect(
      parseStateChangedPayload(validState({ error: { code: "worker_lost", message: "m" } }))?.error
        ?.code,
    ).toBe("worker_lost");
    expect(parseStateChangedPayload(validState({ error: null }))?.error).toBeUndefined();
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
  it("parses the early-completion-requested flag", () => {
    expect(
      parseControlChangedPayload({ occurred_at: "t", early_completion_requested: true }),
    ).toEqual({ early_completion_requested: true });
  });

  it("returns null when the flag is missing or a nested controls object is used", () => {
    expect(
      parseControlChangedPayload({ controls: { early_completion_available: false } }),
    ).toBeNull();
    expect(parseControlChangedPayload({})).toBeNull();
    expect(parseControlChangedPayload(null)).toBeNull();
  });
});

describe("parseResultAvailablePayload", () => {
  it("parses flat result fields with a downloadable artifact", () => {
    expect(
      parseResultAvailablePayload({
        occurred_at: "t",
        outcome: "feasible",
        score: 42,
        solver_status: "FEASIBLE",
        termination_reason: "OPTIMAL_WITHIN_GAP",
        artifact_name: "schedule.xlsx",
      }),
    ).toEqual({
      outcome: "feasible",
      score: 42,
      solver_status: "FEASIBLE",
      termination_reason: "OPTIMAL_WITHIN_GAP",
      artifact_name: "schedule.xlsx",
    });
  });

  it("parses an infeasible result with null score/termination and no artifact", () => {
    const payload = parseResultAvailablePayload({
      outcome: "infeasible",
      score: null,
      solver_status: "INFEASIBLE",
      termination_reason: null,
      artifact_name: null,
    });
    expect(payload?.score).toBeNull();
    expect(payload?.artifact_name).toBeNull();
  });

  it("returns null for the impossible nested-result shape and wrong types", () => {
    // The old (wrong) fixture: a nested `result` object rather than flat fields.
    expect(
      parseResultAvailablePayload({
        result: {
          outcome: "feasible",
          score: 42,
          solver_status: "FEASIBLE",
          termination_reason: null,
        },
      }),
    ).toBeNull();
    expect(
      parseResultAvailablePayload({
        outcome: "feasible",
        score: "42", // wrong type
        solver_status: "FEASIBLE",
        termination_reason: null,
        artifact_name: null,
      }),
    ).toBeNull();
    expect(parseResultAvailablePayload(null)).toBeNull();
  });

  const validResult = (over: Record<string, unknown>) => ({
    outcome: "feasible",
    score: 1,
    solver_status: "FEASIBLE",
    termination_reason: null,
    artifact_name: null,
    ...over,
  });

  it("accepts every exact OptimizationOutcome and rejects an unknown outcome", () => {
    for (const outcome of ["optimal", "feasible", "infeasible"]) {
      expect(parseResultAvailablePayload(validResult({ outcome }))?.outcome).toBe(outcome);
    }
    expect(parseResultAvailablePayload(validResult({ outcome: "failed" }))).toBeNull(); // a state, not an outcome
    expect(parseResultAvailablePayload(validResult({ outcome: "OPTIMAL" }))).toBeNull(); // wrong case
    expect(parseResultAvailablePayload(validResult({ outcome: "unknown" }))).toBeNull();
  });

  it("validates score as null or an integer (rejects fractional/NaN)", () => {
    expect(parseResultAvailablePayload(validResult({ score: 0 }))?.score).toBe(0);
    expect(parseResultAvailablePayload(validResult({ score: -5 }))?.score).toBe(-5); // score may be negative
    expect(parseResultAvailablePayload(validResult({ score: null }))?.score).toBeNull();
    expect(parseResultAvailablePayload(validResult({ score: 1.5 }))).toBeNull();
    expect(parseResultAvailablePayload(validResult({ score: Number.NaN }))).toBeNull();
  });
});
