// Code-first error classifier (tech-plan §5). The revised backend returns a
// structured `{ error: { code, message, ... } }` envelope for every application,
// event-cursor, and scheduling-content failure, so classification keys off the
// stable `error.code` — NOT a fragile message-string match. FastAPI request-schema
// and parse/size failures keep their native `{ detail }` form, so that remains the
// documented fallback. Pure and framework-free: it drives the client hooks, and the
// BFF reuses its synthetic codes for fail-closed responses.

// The BFF relays backend error bodies verbatim; these are the two shapes a body may
// take. Application/cursor/content errors are code-first; request validation is
// `detail`.
export type OptimizeErrorDetail =
  | string
  | { message?: string; status?: string }
  | Array<unknown>
  | null
  | undefined;

export interface OptimizeStructuredError {
  code: string;
  message: string;
  // event_cursor_expired carries the oldest still-retained cursor.
  oldest_event_id?: string | null;
  // scheduling-content 422 carries deterministic per-issue locations.
  issues?: Array<{ path: Array<string | number>; code: string; message: string }>;
}

export type OptimizeErrorKind =
  | "job-not-found" // job_not_found ⇒ expired / deleted / never existed — recovery, not an error to retry
  | "event-cursor-expired" // 409 event_cursor_expired ⇒ reconnect without a cursor; carries oldestEventId
  | "invalid-event-cursor" // 400 invalid_event_cursor ⇒ discard the corrupt/foreign cursor and reconnect
  | "no-artifact" // job_artifact_not_found / job_artifact_not_ready ⇒ no downloadable schedule
  | "queue-full" // 429 job_capacity_exceeded
  | "conflict" // other 409 lifecycle/contention (already finished, cannot act now)
  | "validation" // scheduling-content 422 (workspace_not_ready / invalid_scheduling_data / unsupported_*)
  | "too-large" // 413 request body over the byte limit (detail form)
  | "request-invalid" // FastAPI 400/422 request-schema or parse/source failure (detail form)
  | "backend-unreachable" // BFF-synthesized 502 — upstream connection failed
  | "backend-unready" // BFF-synthesized 503 — readiness gate failed closed
  | "server-error" // 5xx
  | "unknown"; // anything not otherwise recognized

// The C2 endpoint a response came from — retained for callers that key recovery on
// the originating call (e.g. an events cursor error vs a poll not-found).
export type OptimizeEndpoint = "submit" | "poll" | "events" | "cancel" | "finish-now" | "xlsx";

export interface OptimizeErrorInfo {
  kind: OptimizeErrorKind;
  status: number;
  // The backend (or BFF-synthetic) machine code when the body was structured.
  code: string | null;
  message: string;
  oldestEventId?: string | null;
  issues?: OptimizeStructuredError["issues"];
  // The native FastAPI `detail`, preserved when the body was NOT code-first.
  detail?: OptimizeErrorDetail;
}

// Codes that map one-to-one onto a classifier kind.
const CODE_TO_KIND: Record<string, OptimizeErrorKind> = {
  job_not_found: "job-not-found",
  event_cursor_expired: "event-cursor-expired",
  invalid_event_cursor: "invalid-event-cursor",
  job_artifact_not_found: "no-artifact",
  job_artifact_not_ready: "no-artifact",
  job_capacity_exceeded: "queue-full",
  job_operation_not_allowed: "conflict",
  job_operation_contention: "conflict",
  job_input_not_found: "conflict",
  workspace_not_ready: "validation",
  invalid_scheduling_data: "validation",
  unsupported_workspace_version: "validation",
  unsupported_solver: "validation",
  backend_unreachable: "backend-unreachable",
  backend_unready: "backend-unready",
};

// Pull a code-first `{ error: { code, message, ... } }` envelope out of a parsed
// body. Returns null unless `error.code` is a non-empty string.
export function extractStructuredError(body: unknown): OptimizeStructuredError | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const error = (body as { error: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) return null;
  const message = (error as { message?: unknown }).message;
  return {
    code,
    message: typeof message === "string" ? message : "",
    oldest_event_id: (error as { oldest_event_id?: string | null }).oldest_event_id,
    issues: (error as OptimizeStructuredError).issues,
  };
}

// Pull the FastAPI `detail` field out of a parsed request-validation body.
export function extractErrorDetail(body: unknown): OptimizeErrorDetail {
  if (body && typeof body === "object" && "detail" in body) {
    return (body as { detail: OptimizeErrorDetail }).detail;
  }
  return null;
}

function detailMessage(detail: OptimizeErrorDetail): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return "";
  if (typeof detail === "object") return typeof detail.message === "string" ? detail.message : "";
  return String(detail);
}

// Classify code-first, falling back to `detail` only when the body was not a
// structured error envelope. Recognized codes win regardless of status; the
// status-based fallback handles native FastAPI 413/400/422 and any 5xx.
export function classifyOptimizeError(
  status: number,
  body: unknown,
  _endpoint?: OptimizeEndpoint,
): OptimizeErrorInfo {
  const structured = extractStructuredError(body);
  if (structured !== null) {
    const kind = CODE_TO_KIND[structured.code] ?? (status >= 500 ? "server-error" : "unknown");
    return {
      kind,
      status,
      code: structured.code,
      message: structured.message,
      oldestEventId: structured.oldest_event_id,
      issues: structured.issues,
    };
  }

  const detail = extractErrorDetail(body);
  let kind: OptimizeErrorKind;
  if (status === 413) kind = "too-large";
  else if (status === 400 || status === 422) kind = "request-invalid";
  else if (status >= 500) kind = "server-error";
  else kind = "unknown";
  return { kind, status, code: null, message: detailMessage(detail), detail };
}

// Typed error carrying the classifier verdict, thrown by every optimize client
// call. Lives here (with the classifier) so both the request helper and the
// event-stream loop can construct it without a circular import.
export class OptimizeApiError extends Error {
  readonly status: number;
  readonly info: OptimizeErrorInfo;

  constructor(status: number, body: unknown, endpoint?: OptimizeEndpoint) {
    const info = classifyOptimizeError(status, body, endpoint);
    super(info.message || `Optimize request failed (${status})`);
    this.name = "OptimizeApiError";
    this.status = status;
    this.info = info;
  }
}
