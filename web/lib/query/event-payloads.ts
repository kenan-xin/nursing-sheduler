import type { JobResponse, JobState, OptimizationOutcome } from "@/lib/bff/types";
import type { SseFrame } from "@/lib/query/sse";
import { compareIsoDateTimes, isIsoDateTime } from "@/lib/time/iso-date-time";

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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const CONTROL_KEYS = new Set(["cancellable", "early_completion_available"]);
const ERROR_KEYS = new Set(["code", "message"]);
const CONTROL_CHANGED_KEYS = new Set(["occurred_at", "early_completion_requested"]);
const RESULT_AVAILABLE_KEYS = new Set([
  "occurred_at",
  "outcome",
  "score",
  "solver_status",
  "termination_reason",
  "artifact_name",
]);
const STATE_BASE_KEYS = [
  "occurred_at",
  "state",
  "terminal",
  "queue_position",
  "cancel_requested",
  "early_completion_requested",
  "controls",
] as const;
const STATE_KEYS = new Set(STATE_BASE_KEYS);
const STATE_ERROR_KEYS = new Set([...STATE_BASE_KEYS, "error"]);
const STATE_RUNTIME_KEYS = new Set([...STATE_BASE_KEYS, "runtime"]);
const STATE_RUNNING_KEYS = new Set([...STATE_BASE_KEYS, "worker_id"]);
const STATE_RUNNING_RUNTIME_KEYS = new Set([...STATE_BASE_KEYS, "worker_id", "runtime"]);
const RUNTIME_IDENTITY_KEYS = new Set([
  "service_name",
  "api_version",
  "app_version",
  "deployment_id",
  "instance_id",
  "started_at",
  "job_backend",
  "job_store_id",
]);

function isControls(value: unknown): value is JobControls {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONTROL_KEYS) &&
    typeof value.cancellable === "boolean" &&
    typeof value.early_completion_available === "boolean"
  );
}

function isErrorPayload(value: unknown): value is JobErrorPayload {
  return (
    isRecord(value) &&
    hasExactKeys(value, ERROR_KEYS) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function isRuntimeIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, RUNTIME_IDENTITY_KEYS) &&
    value.service_name === "nurse-scheduling-api" &&
    value.api_version === "alpha" &&
    isNonEmptyString(value.app_version) &&
    isNonEmptyString(value.deployment_id) &&
    isNonEmptyString(value.instance_id) &&
    isIsoDateTimeValue(value.started_at) &&
    (value.job_backend === "memory" || value.job_backend === "redis") &&
    isNonEmptyString(value.job_store_id)
  );
}

function hasExactStateVariant(value: Record<string, unknown>, state: JobState): boolean {
  switch (state) {
    case "queued":
      return value.runtime === undefined
        ? hasExactKeys(value, STATE_KEYS)
        : hasExactKeys(value, STATE_RUNTIME_KEYS) && isRuntimeIdentity(value.runtime);
    case "running":
      if (!isNonEmptyString(value.worker_id)) return false;
      return value.runtime === undefined
        ? hasExactKeys(value, STATE_RUNNING_KEYS)
        : hasExactKeys(value, STATE_RUNNING_RUNTIME_KEYS) && isRuntimeIdentity(value.runtime);
    case "cancelled":
    case "failed":
      return hasExactKeys(value, STATE_ERROR_KEYS);
    case "cancelling":
    case "completed":
      return hasExactKeys(value, STATE_KEYS);
  }
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

// `queue_position` is `null` while unqueued, otherwise a one-based positive
// integer. Negative or fractional numbers are invalid durable values.
function isQueuePosition(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1);
}

// The objective `score` is `null` or an integer (int | None on the backend).
function isScore(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

interface OptimizationResultFields {
  outcome: OptimizationOutcome;
  score: number | null;
  solver_status: string;
  termination_reason: string | null;
}

function hasValidOptimizationResult(
  result: OptimizationResultFields,
  artifact: string | null,
): boolean {
  switch (result.outcome) {
    case "optimal":
      return (
        result.score !== null &&
        result.solver_status === "OPTIMAL" &&
        result.termination_reason === "optimality_proven" &&
        artifact !== null &&
        artifact.length > 0
      );
    case "feasible":
      return (
        result.score !== null &&
        result.solver_status === "FEASIBLE" &&
        (result.termination_reason === "limit_or_stop" ||
          result.termination_reason === "user_requested") &&
        artifact !== null &&
        artifact.length > 0
      );
    case "infeasible":
      return (
        result.score === null &&
        result.solver_status === "INFEASIBLE" &&
        result.termination_reason === "infeasibility_proven" &&
        artifact === null
      );
  }
}

function hasValidStateChangedLifecycle(payload: StateChangedPayload): boolean {
  const controls = payload.controls;
  switch (payload.state) {
    case "queued":
      return (
        payload.queue_position !== null &&
        !payload.cancel_requested &&
        !payload.early_completion_requested &&
        controls.cancellable &&
        !controls.early_completion_available &&
        payload.error === undefined
      );
    case "running":
      return (
        payload.queue_position === null &&
        !payload.cancel_requested &&
        !payload.early_completion_requested &&
        controls.cancellable &&
        controls.early_completion_available &&
        payload.error === undefined
      );
    case "cancelling":
      return (
        payload.queue_position === null &&
        payload.cancel_requested &&
        !controls.cancellable &&
        !controls.early_completion_available &&
        payload.error === undefined
      );
    case "completed":
      return (
        payload.queue_position === null &&
        !payload.cancel_requested &&
        !controls.cancellable &&
        !controls.early_completion_available &&
        payload.error === undefined
      );
    case "cancelled":
      return (
        payload.queue_position === null &&
        payload.cancel_requested &&
        !controls.cancellable &&
        !controls.early_completion_available &&
        payload.error?.code === "cancelled"
      );
    case "failed":
      return (
        payload.queue_position === null &&
        !payload.cancel_requested &&
        !controls.cancellable &&
        !controls.early_completion_available &&
        payload.error !== undefined &&
        payload.error.code !== "cancelled"
      );
  }
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
    !isIsoDateTimeValue(data.occurred_at) ||
    !isJobState(data.state) ||
    !hasExactStateVariant(data, data.state) ||
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
  // it MUST be the exact `{code, message}` envelope — a malformed
  // error forces reconciliation rather than being discarded.
  let error: JobErrorPayload | undefined;
  if (data.error !== undefined) {
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
  return hasValidStateChangedLifecycle(payload) ? payload : null;
}

export function parseControlChangedPayload(data: unknown): ControlChangedPayload | null {
  if (
    !isRecord(data) ||
    !hasExactKeys(data, CONTROL_CHANGED_KEYS) ||
    !isIsoDateTimeValue(data.occurred_at) ||
    data.early_completion_requested !== true
  ) {
    return null;
  }
  return { early_completion_requested: true };
}

export function parseResultAvailablePayload(data: unknown): ResultAvailablePayload | null {
  if (
    !isRecord(data) ||
    !hasExactKeys(data, RESULT_AVAILABLE_KEYS) ||
    !isIsoDateTimeValue(data.occurred_at) ||
    !isOptimizationOutcome(data.outcome) ||
    !isNonEmptyString(data.solver_status) ||
    !isScore(data.score) ||
    !isStringOrNull(data.termination_reason) ||
    !isStringOrNull(data.artifact_name)
  ) {
    return null;
  }
  const payload: ResultAvailablePayload = {
    outcome: data.outcome,
    score: data.score,
    solver_status: data.solver_status,
    termination_reason: data.termination_reason,
    artifact_name: data.artifact_name,
  };
  return hasValidOptimizationResult(payload, payload.artifact_name) ? payload : null;
}

const JOB_RESPONSE_KEYS = new Set([
  "id",
  "state",
  "terminal",
  "queue_position",
  "created_at",
  "started_at",
  "finished_at",
  "request",
  "result",
  "error",
  "controls",
  "links",
]);
const REQUEST_KEYS = new Set(["input_name", "solver", "prettify", "timeout_seconds"]);
const RESULT_KEYS = new Set(["outcome", "score", "solver_status", "termination_reason"]);
const LINK_KEYS = new Set(["self", "events", "cancellation", "early_completion", "schedule"]);

function isIsoDateTimeValue(value: unknown): value is string {
  return typeof value === "string" && isIsoDateTime(value);
}

function isIsoDateTimeValueOrNull(value: unknown): value is string | null {
  return value === null || isIsoDateTimeValue(value);
}

function canonicalLinks(value: JobResponse, id: string): boolean {
  const base = `/optimize/${id}`;
  return (
    value.links.self === base &&
    value.links.events === `${base}/events` &&
    value.links.cancellation === `${base}/cancel` &&
    value.links.early_completion === `${base}/finish-now` &&
    (value.links.schedule === null || value.links.schedule === `${base}/xlsx`)
  );
}

function hasValidLifecycleEnvelope(job: JobResponse): boolean {
  if (job.started_at !== null && compareIsoDateTimes(job.started_at, job.created_at) === -1) {
    return false;
  }
  if (
    job.finished_at !== null &&
    compareIsoDateTimes(job.finished_at, job.started_at ?? job.created_at) === -1
  ) {
    return false;
  }

  switch (job.state) {
    case "queued":
      return (
        job.queue_position !== null &&
        job.started_at === null &&
        job.finished_at === null &&
        job.result === null &&
        job.error === null &&
        job.controls.cancellable &&
        !job.controls.early_completion_available &&
        job.links.schedule === null
      );
    case "running":
      return (
        job.queue_position === null &&
        job.started_at !== null &&
        job.finished_at === null &&
        job.result === null &&
        job.error === null &&
        job.controls.cancellable &&
        job.links.schedule === null
      );
    case "cancelling":
      return (
        job.queue_position === null &&
        job.started_at !== null &&
        job.finished_at === null &&
        job.result === null &&
        job.error === null &&
        !job.controls.cancellable &&
        !job.controls.early_completion_available &&
        job.links.schedule === null
      );
    case "completed":
      return (
        job.queue_position === null &&
        job.started_at !== null &&
        job.finished_at !== null &&
        job.result !== null &&
        job.error === null &&
        !job.controls.cancellable &&
        !job.controls.early_completion_available &&
        hasValidOptimizationResult(job.result, job.links.schedule)
      );
    case "cancelled":
      return (
        job.queue_position === null &&
        job.finished_at !== null &&
        job.result === null &&
        job.error?.code === "cancelled" &&
        !job.controls.cancellable &&
        !job.controls.early_completion_available &&
        job.links.schedule === null
      );
    case "failed":
      return (
        job.queue_position === null &&
        job.started_at !== null &&
        job.finished_at !== null &&
        job.result === null &&
        job.error !== null &&
        job.error.code !== "cancelled" &&
        !job.controls.cancellable &&
        !job.controls.early_completion_available &&
        job.links.schedule === null
      );
  }
}

export function parseJobResponse(value: unknown, expectedId?: string): JobResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, JOB_RESPONSE_KEYS)) return null;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 512 ||
    (expectedId !== undefined && value.id !== expectedId) ||
    !isJobState(value.state) ||
    typeof value.terminal !== "boolean" ||
    value.terminal !== isTerminalJobState(value.state) ||
    !isQueuePosition(value.queue_position) ||
    !isIsoDateTimeValue(value.created_at) ||
    !isIsoDateTimeValueOrNull(value.started_at) ||
    !isIsoDateTimeValueOrNull(value.finished_at) ||
    !isControls(value.controls)
  ) {
    return null;
  }

  if (!isRecord(value.request) || !hasExactKeys(value.request, REQUEST_KEYS)) return null;
  if (
    typeof value.request.input_name !== "string" ||
    value.request.input_name.length === 0 ||
    value.request.solver !== "ortools/cp-sat" ||
    !(value.request.prettify === null || typeof value.request.prettify === "boolean") ||
    typeof value.request.timeout_seconds !== "number" ||
    !Number.isInteger(value.request.timeout_seconds) ||
    value.request.timeout_seconds <= 0
  ) {
    return null;
  }

  if (value.result !== null) {
    if (!isRecord(value.result) || !hasExactKeys(value.result, RESULT_KEYS)) return null;
    if (
      !isOptimizationOutcome(value.result.outcome) ||
      !isScore(value.result.score) ||
      typeof value.result.solver_status !== "string" ||
      value.result.solver_status.length === 0 ||
      !isStringOrNull(value.result.termination_reason)
    ) {
      return null;
    }
  }
  if (value.error !== null && !isErrorPayload(value.error)) return null;

  if (!isRecord(value.links) || !hasExactKeys(value.links, LINK_KEYS)) return null;
  if (
    typeof value.links.self !== "string" ||
    typeof value.links.events !== "string" ||
    typeof value.links.cancellation !== "string" ||
    typeof value.links.early_completion !== "string" ||
    !isStringOrNull(value.links.schedule)
  ) {
    return null;
  }
  const job = value as unknown as JobResponse;
  return canonicalLinks(job, job.id) && hasValidLifecycleEnvelope(job) ? job : null;
}

declare const STRICT_TERMINAL_FRAME: unique symbol;
export type StrictTerminalFrame = SseFrame & { readonly [STRICT_TERMINAL_FRAME]: true };

export function parseStrictTerminalFrame(frame: SseFrame): StrictTerminalFrame | null {
  if (frame.id === null || frame.id.length === 0 || frame.event !== "job.state_changed")
    return null;
  let value: unknown;
  try {
    value = JSON.parse(frame.data) as unknown;
  } catch {
    return null;
  }
  const payload = parseStateChangedPayload(value);
  if (payload?.terminal !== true || !isRecord(value) || !isIsoDateTimeValue(value.occurred_at)) {
    return null;
  }
  const expectedKeys = new Set([
    "occurred_at",
    "state",
    "terminal",
    "queue_position",
    "cancel_requested",
    "early_completion_requested",
    "controls",
    ...(payload.state === "completed" ? [] : ["error"]),
  ]);
  if (!hasExactKeys(value, expectedKeys)) return null;
  if (
    payload.queue_position !== null ||
    payload.controls.cancellable ||
    payload.controls.early_completion_available
  ) {
    return null;
  }
  if (payload.state === "completed") {
    if (payload.error !== undefined || value.cancel_requested) return null;
  } else {
    if (payload.error === undefined) return null;
    if (payload.state === "cancelled") {
      if (payload.error.code !== "cancelled" || value.cancel_requested !== true) return null;
    } else if (payload.error.code === "cancelled" || value.cancel_requested !== false) {
      return null;
    }
  }
  return frame as StrictTerminalFrame;
}
