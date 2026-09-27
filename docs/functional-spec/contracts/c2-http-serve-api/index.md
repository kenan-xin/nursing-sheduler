---
title: "Contract C2 — HTTP Serve API"
kind: spec
---

# Contract C2 — HTTP Serve API

Rewritten 2026-09-27 against the `develop` branch after the v1-sync W2 and W6
work. This replaces the older description of an in-memory, camelCase
`serve.py` / `jobs.py` backend (`jobId`, `xlsxReady`, heartbeat endpoint,
`X-Schedule-*` headers). None of that exists any more. If this page and the
code disagree, the code wins.

Code that owns this contract:

- Backend routes: `core/nurse_scheduling/server/api/optimize.py`
- Backend response shapes: `core/nurse_scheduling/server/api/schemas.py`
- SSE framing: `core/nurse_scheduling/server/api/sse.py`
- App, probes, error mapping, CORS: `core/nurse_scheduling/server/app.py`
- Job states and outcomes: `core/nurse_scheduling/server/jobs/models.py`
- Error codes: `core/nurse_scheduling/server/errors.py`
- Limits and defaults: `core/nurse_scheduling/server/config.py`
- Browser-facing BFF: `web/app/api/**/route.ts` with helpers in `web/lib/bff/`

## Shape of the system

The browser never talks to the backend directly. It calls same-origin Next.js
routes under `/api/*` (the BFF). The BFF forwards each call to the private
FastAPI backend and relays the answer. All JSON field names are snake_case,
except the legacy `/health` body and the roster container (see below).

`GET /info` reports `api_version` `"0.2.0"` (`API_VERSION` in `app.py`).

## Endpoints

| Backend | Browser (BFF) path | Purpose |
| --- | --- | --- |
| `GET /info` | `GET /api/info` | Readiness plus service identity and versions |
| `GET /ready` | (BFF-internal probe) | Minimal readiness: `200 {"status":"ready"}` or `503` |
| `GET /health` | `GET /api/health` | Legacy camelCase health body, kept for older consumers |
| `GET /optimize/options` | `GET /api/optimize/options` | Run options this deployment accepts |
| `POST /optimize` | `POST /api/optimize` | Validate input and queue a durable job |
| `GET /optimize/{id}` | `GET /api/optimize/{id}` | Current job snapshot |
| `GET /optimize/{id}/events` | `GET /api/optimize/{id}/events` | Replayable SSE event stream |
| `POST /optimize/{id}/cancel` | `POST /api/optimize/{id}/cancel` | Cancel a queued or running job |
| `POST /optimize/{id}/finish-now` | `POST /api/optimize/{id}/finish-now` | Ask the solver to return its current feasible result |
| `GET /optimize/{id}/roster` | `GET /api/optimize/{id}/roster` | Structured roster (JSON) for a completed job |
| `GET /optimize/{id}/xlsx` | `GET /api/optimize/{id}/xlsx` | Workbook download for a completed job |
| `DELETE /optimize/{id}` | `DELETE /api/optimize/{id}` | Delete a terminal job and its data |

There is no heartbeat endpoint. Closing the event stream or the browser tab
never cancels a job.

### `GET /info`

Returns `status`, `service_name` (`"nurse-scheduling-api"`), `api_version`,
`app_version`, `deployment_id`, `instance_id`, `started_at`, `job_backend`,
`job_store_id`, `auth` (`{required, scheme: "bearer"}`), `claimed_performance`
and `semantic_profile`. When ready it also returns `jobs` (`running`,
`queued`, `cancelling`) and `workers.online`. When not ready it returns `503`
with `status: "unavailable"` and a `reason`. Always `Cache-Control: no-store`.

The BFF (`web/app/api/info/route.ts`) checks the body against a closed schema
(`web/app/api/info/validate.ts`). If the backend cannot be reached it returns
`502 {status: "unavailable", reason: "backend_unreachable"}`; if the body does
not match it returns `502` with `reason: "invalid_upstream_response"`.

### `GET /optimize/options`

Returns `schema_version: "alpha"`, `solver` (`default` plus `choices`, each
with `value`, `label`, `compute`, `timeout {default, minimum, maximum}` and
`controls {cancel_running, finish_now}`), and `prettify.default`. The web app
reads the timeout range from here. The BFF (`web/app/api/optimize/options/`)
validates the body and turns a backend `404` into
`404 backend_route_unsupported`.

### `POST /optimize`

`multipart/form-data`. Fields:

- `file` or `yaml_content`: exactly one. A file name must end in `.yaml` or
  `.yml`.
- `prettify` (bool), `timeout` (int seconds), `solver` (string).
- `purpose`: `ordinary` (default) or `assistant_diagnostic`.
- Basis claim fields (all optional): `basis_id`, `input_sha256`,
  `submission_contract_version`, `workspace_schema_version`,
  `serializer_version`, `anonymization_mode`,
  `expected_solver_semantic_version`, `expected_backend_capability_version`,
  `parent_basis_id`, `transform_digest`. The server checks the claim against
  the exact bytes it received.

Rules:

- Input over the byte limit (default 2 MiB) gives `413 "Scheduling YAML is too
  large"`.
- Timeout outside the advertised range (default 1 to 3600 s, default 300 s)
  gives `400`.
- The product runs CP-SAT only. Any other solver value is rejected before a
  job is created. The web app does not send `solver`.
- YAML that expands too far gives `400` with code `scheduling_data_too_complex`.
- Content errors found before the job exists give `422` with a structured
  envelope (`SchedulingContentError`).
- Too many pending or retained jobs gives `429` (`job_capacity_exceeded` or
  `diagnostic_capacity_reserved`) with `Retry-After: 1`.

On success: `202` with a `JobResponse`, plus `Location: /optimize/{id}` and
`Retry-After: 1`. The job may already be past `queued` when the response
arrives. The backend also sets an HttpOnly `nurse_scheduling_client_id` cookie
(seven days) used only to correlate jobs for diagnostics.

### `GET /optimize/{id}`

`200` with a `JobResponse`, or `404 job_not_found`.

### `POST /optimize/{id}/cancel` and `POST /optimize/{id}/finish-now`

Both return `202` with a `JobResponse`. Cancel works on queued and running
jobs; the server stops the child process if needed, throws away any result,
and the job ends as `cancelled`. Finish now only works while the job is
`running` and the solver supports it (CP-SAT does). A feasible result then
completes with `result.termination_reason = "user_requested"`. Cancel on a
job that is already terminal or already cancelling returns the job unchanged.
Finish now outside `running` gives `409 job_operation_not_allowed`. Use
`controls` in the `JobResponse` to decide which buttons to show.

### `GET /optimize/{id}/roster`

`200` with the roster container minus the workbook bytes: `schemaVersion`,
`people`, `dates`, `solvedDays`, `score`, `solverStatus`, `coordinateMap` and
`xlsx {name, mime}` (built in `roster_container.py`). This body is camelCase on
purpose; it is a stored artifact, not a job response. `JobResponse.links` has
no roster link; clients build the URL themselves. `409 job_artifact_not_ready`
if the job has no result yet. The BFF turns a backend `404` on this route into
`backend_route_unsupported` so an older backend is reported clearly.

### `GET /optimize/{id}/xlsx`

Streams the workbook stored in the roster container, byte for byte, with
`Content-Disposition: attachment; filename="..."`. The BFF passes on only
`content-type` and `content-disposition` and adds `no-store`. There are no
score or status headers; read those from the `JobResponse` or the roster.

### `DELETE /optimize/{id}`

`204` with no body. Only terminal jobs can be deleted; otherwise `409`.
Unknown ids give `404`.

## `JobResponse`

Returned by create, get, cancel and finish-now.

| Field | Meaning |
| --- | --- |
| `id` | Opaque job id |
| `state` | `queued`, `running`, `cancelling`, `completed`, `cancelled`, `failed` |
| `terminal` | `true` for `completed`, `cancelled`, `failed` |
| `queue_position` | 1-based while queued, else `null` |
| `created_at`, `expires_at`, `started_at`, `finished_at` | ISO timestamps, nullable except `created_at` |
| `request` | `input_name`, `solver`, `prettify`, `timeout_seconds`, `purpose`, `basis` (ids only, or `null`) |
| `result` | `null`, or `outcome`, `score`, `solver_status`, `termination_reason` |
| `error` | `null`, or `{code, message}` |
| `controls` | `cancellable`, `early_completion_available` |
| `links` | `self`, `events`, `cancellation`, `early_completion`, `schedule` (xlsx link, `null` until there is an artifact) |

The lifecycle `state` and the optimization `result.outcome` are separate.
`outcome` is one of `optimal`, `feasible`, `infeasible`, `inconclusive`.
`request.solver` and `result.solver_status` are nested fields; there is no
top-level `solver` key.

When auth is on, `links.events` carries a short-lived `?token=...`, because
`EventSource` cannot send an `Authorization` header.

If the child process runs past the timeout plus a grace period (default 90 s),
the job fails with `error.code = "process_timeout"` and no artifact. A solver
timeout that still has a feasible answer completes with
`termination_reason = "solver_timeout"`.

## Event stream

`GET /optimize/{id}/events` returns `text/event-stream` with
`Cache-Control: no-cache` and `X-Accel-Buffering: no`. Each frame is:

```
id: <opaque cursor>
event: <type>
data: {"occurred_at": "...", ...}

```

Event types: `job.state_changed`, `job.phase_changed`, `job.progressed`,
`job.control_changed`, `job.result_available`. The server adds `terminal` and
`controls` to every `job.state_changed` frame. Idle streams get a
`: keepalive` comment line.

Reconnect by sending the last cursor as `Last-Event-ID`. The server replays
from there. A cursor that is too old gives
`409 event_cursor_expired` (with `oldest_event_id`); a cursor that does not
belong to the job gives `400 invalid_event_cursor`. The client treats these as
different recovery cases and falls back to `GET /optimize/{id}`. The BFF
(`web/lib/bff/stream.ts`) forwards only the `Last-Event-ID` header.

## Errors

Application errors use one envelope:

```json
{ "error": { "code": "job_not_found", "message": "..." } }
```

`404`: `job_not_found`, `job_input_not_found`, `job_artifact_not_found`.
`409`: `job_operation_not_allowed`, `job_operation_contention`,
`job_artifact_not_ready`, `job_queue_invariant_violated`. `429`:
`job_capacity_exceeded`, `diagnostic_capacity_reserved`. Other codes give
`500 server_error`. Simple input checks on `POST /optimize` still use
FastAPI's `{"detail": "..."}` shape, so clients must accept both. Clients act
on `code`, never on the English message.

## BFF rules

- Every `/api/optimize/**` route except `options` first probes backend
  `/ready` (`web/lib/bff/readiness.ts`). Only an exact
  `200 {"status":"ready"}` lets the request through. Anything else gives
  `503 backend_unready` with `no-store`.
- A network or body-read failure gives `502 backend_unreachable` with
  `no-store` (`web/lib/bff/upstream.ts`).
- The BFF forwards cookies and rewrites `Set-Cookie` for the browser origin.
- The backend's CORS allow-list (`ORIGIN_REGEX` in `app.py`) only matters for
  direct calls; the web app always goes through the BFF.

## Defaults (from `config.py`)

| Setting | Default |
| --- | --- |
| Max YAML bytes | 2 MiB |
| Timeout min / default / max | 1 s / 300 s / 3600 s |
| Timeout grace | 90 s |
| Max pending jobs | 32 |
| Max retained jobs | 128 |
| Terminal job retention | 24 h |
| Max stored events per job | 1000 |

Each deployment can change these through environment settings; clients should
read `/optimize/options` rather than hard-code them.
