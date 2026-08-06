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
//
// `inconclusive` is a NORMAL completion (T08): the solver reached a terminal state
// and proved neither side. It is deliberately not folded into `failed` (which
// would lose "we have no proof" vs "the run broke") nor into `infeasible` (which
// would manufacture evidence the solver never produced).
export type OptimizationOutcome = "optimal" | "feasible" | "infeasible" | "inconclusive";

// jobs/runner.py — the closed set of reasons an `inconclusive` result may carry.
export type InconclusiveReason = "solver_timeout_no_solution" | "no_proof" | "solver_unknown";

export const INCONCLUSIVE_REASONS: ReadonlySet<string> = new Set<InconclusiveReason>([
  "solver_timeout_no_solution",
  "no_proof",
  "solver_unknown",
]);

// optimize_basis.py::OptimizeBasisV2, projected by schemas.py::JobBasisResponse.
// IDENTIFIERS ONLY — the submitted document is never carried on a job response or
// event, so no client can read another submission out of the job API.
export interface JobBasis {
  basis_id: string;
  schema_version: number;
  submission_contract_version: string;
  workspace_schema_version: string;
  serializer_version: string;
  anonymization_mode: string;
  input_sha256: string;
  normalized_options: {
    solver: string;
    prettify: boolean;
    timeout_seconds: number;
  };
  solver_semantic_version: string;
  backend_capability_version: string;
  parent_basis_id: string | null;
  transform_digest: string | null;
}

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
  // The advertised time from which this job's evidence may no longer exist.
  // Derived server-side from `created_at`, so it is never LATER than the earliest
  // possible deletion: evidence validity must not outlive what was advertised.
  expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  request: {
    input_name: string;
    solver: string;
    prettify: boolean | null;
    timeout_seconds: number;
    // The immutable submission identity, or `null` when the client claimed none
    // (an ordinary run submitted without the assistant).
    basis: JobBasis | null;
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
