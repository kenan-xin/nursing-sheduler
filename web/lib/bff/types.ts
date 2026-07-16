// C2 contract types, confirmed against the vendored backend
// `core/nurse_scheduling/serve.py` + `jobs.py`. Shared by the server-side proxy
// (`web/lib/bff`) and the client hooks (`web/lib/query`).

// The ONLY cookie the BFF forwards upstream / rewrites on the way back
// (serve.py: CLIENT_UUID_COOKIE_NAME). The whole browser cookie header is never
// forwarded — that would leak Next cookies to FastAPI.
export const CLIENT_UUID_COOKIE_NAME = "nurse_scheduling_client_uuid";

// jobs.py::OptimizeJobStatus.
export type OptimizeJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "optimal"
  | "feasible"
  | "infeasible"
  | "cancelled"
  | "failed";

// Terminal statuses (jobs.py::_is_terminal_job_status).
export const TERMINAL_OPTIMIZE_STATUSES: ReadonlySet<OptimizeJobStatus> =
  new Set<OptimizeJobStatus>(["optimal", "feasible", "infeasible", "cancelled", "failed"]);

export function isTerminalOptimizeStatus(status: OptimizeJobStatus): boolean {
  return TERMINAL_OPTIMIZE_STATUSES.has(status);
}

// jobs.py::_optimize_job_response. `links` are backend-relative and deliberately
// ignored by the client, which constructs `/api/*` URLs itself (tech-plan §3).
export interface OptimizeJobResponse {
  jobId: string;
  status: OptimizeJobStatus;
  queuePosition: number | null;
  inputName: string;
  prettify: boolean | null;
  timeout: number | null;
  score: number | null;
  solverStatus: string | null;
  error: string | null;
  cancelRequested: boolean;
  finishNowRequested: boolean;
  clientHeartbeatExpired: boolean;
  xlsxReady: boolean;
  links: Record<string, string>;
}

// serve.py::heartbeat_optimize_job response shape.
export interface OptimizeHeartbeatResponse {
  jobId: string;
  status: OptimizeJobStatus;
}

// SSE event names emitted by serve.py::_stream_optimize_job_events.
export type OptimizeEventName = "status" | "phase" | "progress" | "complete" | "error";

export const TERMINAL_EVENT_NAMES: ReadonlySet<string> = new Set(["complete", "error"]);
