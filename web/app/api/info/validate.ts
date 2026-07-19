import type { InfoIdentity, InfoResponse } from "@/app/api/info/types";

// Strict, closed parser for the authoritative core `/info` payload
// (core/nurse_scheduling/server/app.py::info_payload / info). Rejects anything
// that isn't EXACTLY one of the two valid shapes, so a backend/proxy fault, a
// future unknown field, or a leaked private field (e.g. `backend_url`) can never
// reach the browser. The route reconstructs its response from the parsed,
// allowlisted fields — it never relays raw upstream bytes.

const IDENTITY_FIELDS = [
  "service_name",
  "api_version",
  "app_version",
  "deployment_id",
  "instance_id",
  "started_at",
  "job_backend",
  "job_store_id",
] as const;

const READY_KEYS = new Set<string>(["status", ...IDENTITY_FIELDS]);
const UNAVAILABLE_KEYS = new Set<string>(["status", "reason", ...IDENTITY_FIELDS]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The key set must match exactly — no missing required key, no extra/unknown key.
function hasExactKeySet(body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(body);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function readIdentity(body: Record<string, unknown>): InfoIdentity | null {
  const identity = {} as Record<(typeof IDENTITY_FIELDS)[number], string>;
  for (const field of IDENTITY_FIELDS) {
    const value = body[field];
    if (typeof value !== "string") return null;
    identity[field] = value;
  }
  return identity;
}

// Parse and validate an upstream `/info` body against its paired HTTP status.
// Returns the closed, reconstructable `InfoResponse`, or `null` when the body
// isn't EXACTLY the ready-200 or unavailable-503 shape (unknown status, wrong
// HTTP pairing, missing/mistyped/extra field).
export function parseInfoPayload(body: unknown, httpStatus: number): InfoResponse | null {
  if (!isPlainObject(body)) return null;

  const status = body.status;
  if (status !== "ready" && status !== "unavailable") return null;

  if (status === "ready") {
    if (httpStatus !== 200) return null;
    if (!hasExactKeySet(body, READY_KEYS)) return null;
    const identity = readIdentity(body);
    if (identity === null) return null;
    return { status: "ready", ...identity };
  }

  if (httpStatus !== 503) return null;
  if (!hasExactKeySet(body, UNAVAILABLE_KEYS)) return null;
  const identity = readIdentity(body);
  if (identity === null) return null;
  const reason = body.reason;
  if (typeof reason !== "string") return null;
  return { status: "unavailable", reason, ...identity };
}

// Reconstruct the wire body from validated fields only, in a stable field order
// matching core's own construction (`{"status": ..., **runtime_identity}`, with
// `reason` appended last for the unavailable case) — never a re-serialization of
// upstream bytes.
export function serializeInfoPayload(info: InfoResponse): string {
  const ordered =
    info.status === "ready"
      ? {
          status: info.status,
          service_name: info.service_name,
          api_version: info.api_version,
          app_version: info.app_version,
          deployment_id: info.deployment_id,
          instance_id: info.instance_id,
          started_at: info.started_at,
          job_backend: info.job_backend,
          job_store_id: info.job_store_id,
        }
      : {
          status: info.status,
          service_name: info.service_name,
          api_version: info.api_version,
          app_version: info.app_version,
          deployment_id: info.deployment_id,
          instance_id: info.instance_id,
          started_at: info.started_at,
          job_backend: info.job_backend,
          job_store_id: info.job_store_id,
          reason: info.reason,
        };
  return JSON.stringify(ordered);
}
