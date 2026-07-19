// Durable-job HTTP contract, confirmed against the vendored T19 backend
// (`core/nurse_scheduling/server/api/schemas.py` + `api/optimize.py` + `app.py`).
// The body is adopted UNCHANGED: snake_case, nested `request`/`result`/`error`/
// `controls`/`links`. The BFF does not camel-case it (tech-plan §5). Shared by the
// server-side proxy (`web/lib/bff`) and the client hooks (`web/lib/query`).

// The ONLY cookie the BFF forwards upstream / rewrites on the way back
// (optimize.py: CLIENT_ID_COOKIE_NAME). Seven-day diagnostic correlation only —
// it never controls job liveness. The whole browser cookie header is never
// forwarded (that would leak Next cookies to FastAPI).
export const CLIENT_ID_COOKIE_NAME = "nurse_scheduling_client_id";

// The reconnect cursor header. The client sends its last applied opaque event
// cursor; the BFF whitelists and forwards ONLY this request header upstream, where
// FastAPI binds it to `stream_events(last_event_id=Header(None))`.
export const LAST_EVENT_ID_HEADER = "last-event-id";

// jobs/models.py::JobState. Lifecycle ends at `completed`; the solver outcome
// lives in `result.outcome`, NOT in the lifecycle state (tech-plan §5).
export type JobState = "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";

// jobs/models.py::OptimizationOutcome. The solver verdict, distinct from lifecycle.
export type OptimizationOutcome = "optimal" | "feasible" | "infeasible";

// Terminal lifecycle states. The server also sends `terminal: boolean` on every
// response and event; prefer that flag when it is present.
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "completed",
  "cancelled",
  "failed",
]);

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.has(state);
}

// schemas.py::JobResponse — the complete public representation of one job, adopted
// verbatim. `links` are backend-relative and deliberately ignored as navigation
// authority: the client constructs same-origin `/api/*` URLs itself (tech-plan §3).
export interface JobResponse {
  id: string;
  state: JobState;
  terminal: boolean;
  queue_position: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  request: {
    input_name: string;
    solver: string;
    prettify: boolean | null;
    timeout_seconds: number;
  };
  result: {
    outcome: OptimizationOutcome;
    score: number | null;
    solver_status: string;
    termination_reason: string | null;
  } | null;
  error: { code: string; message: string } | null;
  controls: {
    cancellable: boolean;
    early_completion_available: boolean;
  };
  links: {
    self: string;
    events: string;
    cancellation: string;
    early_completion: string;
    schedule: string | null;
  };
}

// SSE event names emitted by api/optimize.py::stream_events, each persisted with an
// opaque `id:` cursor (tech-plan §5). There is no longer a stream-closing terminal
// event name: closure is not itself success/failure. The client stops when a polled
// or event-carried `terminal` flag is true.
export type OptimizeEventName =
  | "job.state_changed"
  | "job.control_changed"
  | "job.phase_changed"
  | "job.progressed"
  | "job.result_available";

export const OPTIMIZE_EVENT_NAMES: ReadonlySet<string> = new Set<OptimizeEventName>([
  "job.state_changed",
  "job.control_changed",
  "job.phase_changed",
  "job.progressed",
  "job.result_available",
]);
