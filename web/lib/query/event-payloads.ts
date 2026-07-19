import type { JobResponse, JobState, OptimizationOutcome } from "@/lib/bff/types";

// Exact SSE event wire payloads, derived from the authoritative T19 emitters — NOT
// from `JobResponse`. These are the FLAT shapes the backend actually persists and
// streams:
//   - job.state_changed   core/nurse_scheduling/server/jobs/controller.py::_state_event
//                         enriched with `terminal`/`controls` in api/optimize.py::_enrich_state_event
//   - job.control_changed controller.py::request_early_completion (only the flag)
//   - job.result_available controller.py::_result_event (flat result fields)
//   - job.phase_changed / job.progressed  jobs/runner.py (ephemeral progress; not cached)
// Payloads that cannot construct durable state without invention are left for an
// authoritative poll rather than guessed.

type JobControls = JobResponse["controls"];
type JobErrorPayload = NonNullable<JobResponse["error"]>;

// api/optimize.py enriches every state_changed frame with `terminal` and `controls`;
// `error` is present only on failed/cancelled states.
export interface StateChangedPayload {
  state: JobState;
  terminal: boolean;
  queue_position: number | null;
  cancel_requested: boolean;
  early_completion_requested: boolean;
  controls: JobControls;
  error?: JobErrorPayload;
}

// The control event carries ONLY the accepted early-completion request flag, never a
// full `controls` object.
export interface ControlChangedPayload {
  early_completion_requested: boolean;
}

// The result event carries flat result fields plus the artifact name (non-null once
// a downloadable schedule exists).
export interface ResultAvailablePayload {
  outcome: OptimizationOutcome;
  score: number | null;
  solver_status: string;
  termination_reason: string | null;
  artifact_name: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isControls(value: unknown): value is JobControls {
  return (
    isRecord(value) &&
    typeof value.cancellable === "boolean" &&
    typeof value.early_completion_available === "boolean"
  );
}

function isErrorPayload(value: unknown): value is JobErrorPayload {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

// The exact T19 domains (core/nurse_scheduling/server/jobs/models.py). A `state` or
// `outcome` outside these enums is a contract violation, NOT a castable string.
const JOB_STATES: ReadonlySet<string> = new Set<JobState>([
  "queued",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
]);
const OPTIMIZATION_OUTCOMES: ReadonlySet<string> = new Set<OptimizationOutcome>([
  "optimal",
  "feasible",
  "infeasible",
]);

function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && JOB_STATES.has(value);
}

// The exact T19 terminal lifecycle states (core/nurse_scheduling/server/jobs/models.py):
// once a job reaches one of these it never transitions again. `queued`, `running`, and
// `cancelling` are non-terminal. The enriched `terminal` flag on a state_changed frame
// MUST agree with this set — it is derived from the same lifecycle, never independent.
const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set<JobState>([
  "completed",
  "cancelled",
  "failed",
]);

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.has(state);
}

function isOptimizationOutcome(value: unknown): value is OptimizationOutcome {
  return typeof value === "string" && OPTIMIZATION_OUTCOMES.has(value);
}

// `queue_position` is `null` while unqueued, otherwise a one-based non-negative
// integer. Negative or fractional numbers are invalid durable values.
function isQueuePosition(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

// The objective `score` is `null` or an integer (int | None on the backend).
function isScore(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

// Parse an enriched job.state_changed payload against the exact T19 domains. Returns
// null (⇒ reconcile) on any semantically invalid field — unknown state, out-of-domain
// queue position, a supplied-but-malformed `error`, or a `terminal` flag that disagrees
// with the state's lifecycle terminality — never silently dropping it. This single
// parser is shared by cache application and terminal recognition, so a state/terminal
// contradiction in EITHER direction (terminal state marked non-terminal, or a live
// state marked terminal) forces authoritative reconciliation and can never close the
// stream directly.
export function parseStateChangedPayload(data: unknown): StateChangedPayload | null {
  if (
    !isRecord(data) ||
    !isJobState(data.state) ||
    typeof data.terminal !== "boolean" ||
    data.terminal !== isTerminalJobState(data.state) ||
    typeof data.cancel_requested !== "boolean" ||
    typeof data.early_completion_requested !== "boolean" ||
    !isQueuePosition(data.queue_position) ||
    !isControls(data.controls)
  ) {
    return null;
  }
  // `error` is optional; state events omit it unless failed/cancelled. When present
  // (and not null), it MUST be the exact `{code, message}` envelope — a malformed
  // error forces reconciliation rather than being discarded.
  let error: JobErrorPayload | undefined;
  if (data.error !== undefined && data.error !== null) {
    if (!isErrorPayload(data.error)) return null;
    error = data.error;
  }
  const payload: StateChangedPayload = {
    state: data.state,
    terminal: data.terminal,
    queue_position: data.queue_position,
    cancel_requested: data.cancel_requested,
    early_completion_requested: data.early_completion_requested,
    controls: data.controls,
  };
  if (error !== undefined) payload.error = error;
  return payload;
}

export function parseControlChangedPayload(data: unknown): ControlChangedPayload | null {
  if (!isRecord(data) || typeof data.early_completion_requested !== "boolean") return null;
  return { early_completion_requested: data.early_completion_requested };
}

export function parseResultAvailablePayload(data: unknown): ResultAvailablePayload | null {
  if (
    !isRecord(data) ||
    !isOptimizationOutcome(data.outcome) ||
    typeof data.solver_status !== "string" ||
    !isScore(data.score) ||
    !isStringOrNull(data.termination_reason) ||
    !isStringOrNull(data.artifact_name)
  ) {
    return null;
  }
  return {
    outcome: data.outcome,
    score: data.score,
    solver_status: data.solver_status,
    termination_reason: data.termination_reason,
    artifact_name: data.artifact_name,
  };
}
