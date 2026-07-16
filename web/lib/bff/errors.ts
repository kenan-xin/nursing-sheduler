// 404/409 classifier (tech-plan §3, ticket). C2 error responses are NOT a blanket
// "any 404 = expired": the same status means different things per endpoint+detail,
// confirmed against serve.py + jobs.py. A blanket rule would misreport an
// infeasible XLSX download (structured 404) as restart loss.
//
// Pure and framework-free so it drives both the server relay and the client hooks.

// FastAPI wraps errors as `{ "detail": <string | { message, status } > }`.
export type OptimizeErrorDetail = string | { message?: string; status?: string } | null | undefined;

export type OptimizeErrorKind =
  | "expired" // EXACT plain 404 "Optimization job not found" ⇒ evicted / restarted / TTL — recovery
  | "no-result" // XLSX structured 404 "No feasible solution is available." ⇒ terminal, no download
  | "not-ready" // structured 409 "Result is not ready yet." ⇒ non-terminal, retry later
  | "conflict" // other structured 409 (already finished / cannot delete running) — keep status
  | "queue-full" // 429 — too many pending jobs
  | "too-large" // 413 — "Scheduling YAML is too large"
  | "unknown"; // anything else, incl. an unrelated / detail-less 404 (NOT treated as expiry)

// The C2 endpoint a response came from — part of the classifier input, because the
// same status means different things per endpoint (e.g. the structured "no feasible
// solution" 404 is XLSX-only).
export type OptimizeEndpoint = "submit" | "poll" | "events" | "heartbeat" | "cancel" | "xlsx";

export interface OptimizeErrorInfo {
  kind: OptimizeErrorKind;
  status: number;
  message: string;
  // Present when the backend sent a structured `{ message, status }` detail.
  jobStatus?: string;
}

// Pull the `detail` field out of a parsed FastAPI error body.
export function extractErrorDetail(body: unknown): OptimizeErrorDetail {
  if (body && typeof body === "object" && "detail" in body) {
    return (body as { detail: OptimizeErrorDetail }).detail;
  }
  return null;
}

// Tolerate `detail` as a string OR a `{ message, status }` object.
export function errorDetailMessage(detail: OptimizeErrorDetail): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail === "object") return typeof detail.message === "string" ? detail.message : "";
  return String(detail);
}

function errorDetailStatus(detail: OptimizeErrorDetail): string | undefined {
  if (detail && typeof detail === "object" && typeof detail.status === "string") {
    return detail.status;
  }
  return undefined;
}

// Exact binding strings from the vendored backend.
const JOB_NOT_FOUND = "Optimization job not found"; // jobs.py:218/:341/:377, serve.py:533
const NO_FEASIBLE_SOLUTION = "No feasible solution is available."; // serve.py:504 (XLSX 404)
const RESULT_NOT_READY = "Result is not ready yet."; // serve.py:511 (XLSX 409)

// Classify by endpoint + detail — NOT a blanket "any 404 = expired". A 404 is
// `expired` ONLY for the EXACT plain "Optimization job not found"; the XLSX
// structured terminal 404 is `no-result`; every other 404 (unrelated string, null
// detail, wrong endpoint) is `unknown` so it is never mistaken for restart loss.
export function classifyOptimizeError(
  status: number,
  detail: OptimizeErrorDetail,
  endpoint?: OptimizeEndpoint,
): OptimizeErrorInfo {
  const message = errorDetailMessage(detail);
  const jobStatus = errorDetailStatus(detail);

  if (status === 404) {
    // XLSX-only structured terminal detail ⇒ known job, no downloadable result.
    if (endpoint === "xlsx" && message === NO_FEASIBLE_SOLUTION) {
      return { kind: "no-result", status, message, jobStatus };
    }
    // EXACT unknown-job string ⇒ the job is gone (expired / evicted / restarted).
    if (message === JOB_NOT_FOUND) {
      return { kind: "expired", status, message, jobStatus };
    }
    // Any other 404 is unclassified — do NOT report it as expiry/recovery.
    return { kind: "unknown", status, message, jobStatus };
  }

  if (status === 409) {
    if (message === RESULT_NOT_READY) {
      return { kind: "not-ready", status, message, jobStatus };
    }
    return { kind: "conflict", status, message, jobStatus };
  }

  if (status === 429) return { kind: "queue-full", status, message };
  if (status === 413) return { kind: "too-large", status, message };

  return { kind: "unknown", status, message };
}

// Typed error carrying the endpoint-aware classifier verdict, thrown by every
// optimize client call. Lives here (with the classifier) so both the request
// helper and the event-stream loop can construct it without a circular import.
export class OptimizeApiError extends Error {
  readonly status: number;
  readonly detail: OptimizeErrorDetail;
  readonly info: OptimizeErrorInfo;

  constructor(status: number, detail: OptimizeErrorDetail, endpoint?: OptimizeEndpoint) {
    const info = classifyOptimizeError(status, detail, endpoint);
    super(info.message || `Optimize request failed (${status})`);
    this.name = "OptimizeApiError";
    this.status = status;
    this.detail = detail;
    this.info = info;
  }
}
