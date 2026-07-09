---
title: "Contract C2 — HTTP Serve API"
kind: spec
---

# Contract C2 — HTTP Serve API

## Purpose & Scope

This contract fixes the HTTP surface of the existing FastAPI backend
(`core/nurse_scheduling/serve.py, core/nurse_scheduling/jobs.py). The Python`
backend is **NOT being rebuilt. The new frontend MUST call this API exactly**
as documented here. Every endpoint, request field, response field, status code,
header, cookie, and wire-level string below is a conformance target. Where an
exact string is quoted, the frontend MUST tolerate that exact text (it is what
the server emits) and MUST NOT depend on any variant.

- App metadata: `title = "Nurse Scheduling API" (serve.py:108),`
`version = "alpha" (serve.py:109), FastAPI(title=title, version=version, lifespan=lifespan) (serve.py:118).`
- All optimization state is **in-memory (**`_optimize_jobs: dict[str, OptimizeJob], jobs.py:95); jobs do not survive a backend restart.`
- Optimization runs on a single-worker thread pool: `OPTIMIZE_MAX_WORKERS = 1 (serve.py:158), _optimize_executor = ThreadPoolExecutor(max_workers=OPTIMIZE_MAX_WORKERS) (serve.py:165). Jobs are strictly serialized; concurrent submissions queue.`

Scope boundaries: solver internals, YAML schema, and XLSX layout are out of
scope for this contract (covered elsewhere). Only the HTTP/SSE boundary is fixed here.

## Endpoint Reference

All response bodies are JSON unless noted. Path parameter `{job_id} is the`
opaque job id string returned as `jobId (format opt_<uuid4-hex>, jobs.py:238).`

### CON-API-01 — `GET /`

Root/metadata probe. (serve.py:435-441)

- **Request: none.**
- **Response 200:**
    ```json
    {
      "message": "Nurse Scheduling API",
      "version": "alpha",
      "appVersion": "<git describe --tags --always --dirty>"
    }
    ```
  - `message = title (serve.py:438), version = version (serve.py:439),`
`appVersion = app_version (serve.py:440), computed via`
`git describe --tags --always --dirty (serve.py:74-88), falling back to`
`"v0.0.0-unknown" on error (serve.py:90).`
- **Status codes: **`200 only.`

### CON-API-02 — `GET /health`

Health probe. (serve.py:444-451)

- **Request: none.**
- **Response 200:**
    ```json
    {
      "status": "ok",
      "version": "alpha",
      "apiVersion": "alpha",
      "appVersion": "<app_version>"
    }
    ```
  - `status is the literal "ok" (serve.py:447); version and apiVersion`
both equal `version ("alpha"); appVersion = app_version.`
- **Status codes: **`200 only.`

### CON-API-03 — `POST /optimize`

Create an optimization job. (serve.py:454-486)

- **Content type: **`multipart/form-data.`
- **Fields (all via multipart form, file via file part):**
  - `file — optional UploadFile, "YAML file with scheduling data" (serve.py:458).`
  - `yaml_content — optional string form field, "YAML content as a string" (serve.py:459).`
  - `prettify — optional bool form field, "Enable prettier output formatting" (serve.py:460).`
  - `timeout — optional int form field (seconds), "Max execution time in seconds" (serve.py:461).`
  - **No ****`solver`**** field. The current FastAPI signature declares only the four form fields above; there is no **`solver selection on the HTTP surface. The backend always uses OR-Tools CP-SAT (see Contract C4 CON-EXE-01). A rebuilt frontend must not send a solver field.`
- **Input rules (****`_read_optimization_input`****, serve.py:177-198):**
  - `file XOR yaml_content: exactly one required.`
    - Neither provided → `400 "Either 'file' or 'yaml_content' must be provided" (serve.py:182).`
    - Both provided → `400 "Provide either 'file' or 'yaml_content', not both" (serve.py:185).`
  - If `file given, filename MUST end with .yaml or .yml, else`
`400 "Invalid file type. Please upload a YAML file (.yaml or .yml)" (serve.py:188-189).`
  - If `yaml_content given, content is UTF-8 encoded and input_name`
is synthesized as `nurse-scheduling-<YYYYMMDDHHMMSS>.yaml (serve.py:193-194).`
  - Content size limit: `len(content) > MAX_OPTIMIZATION_YAML_BYTES (2 MiB) →`
`413 "Scheduling YAML is too large" (serve.py:196-197).`
- **Timeout normalization (****`_normalize_optimization_timeout`****, serve.py:201-209):**
  - `None → DEFAULT_OPTIMIZATION_TIMEOUT_SECONDS = 300 (serve.py:150,202-203).`
  - `<= 0 or > MAX_OPTIMIZATION_TIMEOUT_SECONDS (3600) →`
`400 "Optimization timeout must be between 1 and 3600 seconds" (serve.py:204-207).`
- **Multipart parser size guard: if the multipart form parser itself raises a**
size error on `POST /optimize, the global handler rewrites it to`
`413 with detail "Scheduling YAML is too large" (serve.py:139-142, _is_form_parser_size_error serve.py:170-174 — a 400 whose detail lowercased contains "size" plus "exceeded" or "too large").`
- **Queue/retention limits (****`_enforce_optimize_job_limits`****, jobs.py:182-215):**
  - Pending (non-terminal) jobs `>= OPTIMIZE_MAX_PENDING_JOBS (8) →`
`429 "Too many optimization jobs are already queued or running" (jobs.py:184-190).`
  - If retained jobs still `>= OPTIMIZE_MAX_RETAINED_JOBS (32) after evicting`
oldest terminal jobs → `429 "Too many optimization jobs are retained" (jobs.py:209-215).`
- **Client-UUID cookie (serve.py:466-477): on request, read cookie**
`nurse_scheduling_client_uuid (serve.py:159); if absent/invalid a new`
`uuid4().hex is generated and set via Set-Cookie with`
`max_age = 30*24*60*60 (2592000s, serve.py:160), httponly=True,`
`samesite="lax", secure = (request.url.scheme == "https"), path="/".`
A valid existing cookie is parsed as `UUID(...).hex (serve.py:226-233).`
- **Response 202 (**`status_code=202, serve.py:454): a `**job-response object**
(see [Job-Response Object) for the freshly created](#job-response-object)
`QUEUED job.`
- **Status codes: **`202 success; 400 (input/timeout errors); 413`
(too large); `429 (pending/retained limits); 422 (FastAPI request`
validation — captured by `sentry_request_validation_exception_handler, serve.py:123-129).`

### CON-API-04 — `GET /optimize/{job_id}`

Poll job status. (serve.py:489-492)

- **Request: path **`job_id.`
- **Response 200: job-response object for **`job_id (_get_optimize_job, jobs.py:218-224).`
- **Status codes: **`200; 404 "Optimization job not found" if unknown/expired (jobs.py:223).`

### CON-API-05 — `GET /optimize/{job_id}/events (SSE)`

Server-Sent Events stream of job progress/lifecycle. (serve.py:495-505)

- **Request: path **`job_id.`
- **Response 200: **`StreamingResponse, media_type="text/event-stream",`
headers `Cache-Control: no-cache and X-Accel-Buffering: no (serve.py:498-505).`
- **Body: see **[SSE Event Stream.](#sse-event-stream)
- **Status codes: **`200; 404 "Optimization job not found" on unknown job`
(`_get_optimize_job runs before streaming, serve.py:497).`

### CON-API-06 — `POST /optimize/{job_id}/heartbeat`

Client liveness heartbeat. (serve.py:508-511)

- **Request: path **`job_id; no body.`
- **Behavior: updates **`last_client_heartbeat_at (_record_client_heartbeat, jobs.py:390-404).`
- **Status codes: **`200; 404 "Optimization job not found" (jobs.py:394);`
`409 if terminal, detail object`
`{ "message": "Optimization job has already finished.", "status": "<status>" } (jobs.py:396-402).`

### CON-API-07 — `POST /optimize/{job_id}/cancel`

Cancel a job. (serve.py:514-517)

- **Request: path **`job_id; no body.`
- **Behavior (****`_request_optimize_job_stop(job_id, finish_now=False)`****, jobs.py:338-387):**
  - If `QUEUED: finished immediately as CANCELLED with`
`error = "Optimization cancelled." (jobs.py:343,369-371); emits terminal complete event.`
  - If `RUNNING: sets cancel_requested=True, status → CANCELLING (jobs.py:373-374); emits status event. The current OR-Tools backend supports cooperative stop (see Contract C4 CON-EXE-03).`
- **Response 200: job-response object.**
- **Status codes: **`200; 404 "Optimization job not found" (jobs.py:349);`
`409 if already terminal — detail`
`{ "message": "Optimization job has already finished.", "status": "<status>" } (jobs.py:350-357`).`
- **No "unsupported-solver" 409. The current backend only uses OR-Tools CP-SAT, which supports cooperative stop; a request to cancel a running job always succeeds (or 409s as already-finished, never as solver-unsupported).**

### CON-API-08 — `POST /optimize/{job_id}/finish-now`

Stop early and keep the best solution found so far. (serve.py:520-526)

- **Request: path **`job_id; no body.`
- **Behavior (****`_request_optimize_job_stop(job_id, finish_now=True)`****, jobs.py:367-368):**
sets `finish_now_requested=True (does not change status to CANCELLING). Then the`
endpoint builds `event_data = _job_status_event_data(job), sets`
`event_data["finishNowRequested"] = True, and publishes a status event (serve.py:523-525).`
- **Response 200: job-response object.**
- **Status codes: **`200; 404 "Optimization job not found";`
`409 already-finished (same detail as CON-API-07).`
- **No "unsupported-solver" 409 — same rationale as CON-API-07.**

### CON-API-09 — `GET /optimize/{job_id}/xlsx`

Download the produced XLSX workbook. (serve.py:529-557)

- **Request: path **`job_id.`
- **Response 200: **`StreamingResponse of the XLSX bytes,`
`media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" (serve.py:551).`
Headers (serve.py:552-556):
  - `Content-Disposition: attachment; filename=<job.xlsx_filename> — filename is`
`<input basename>.xlsx (serve.py:333).`
  - `X-Schedule-Score: <str(job.score)>.`
  - `X-Schedule-Status: <str(job.solver_status)>.`
  - These three headers are CORS-exposed (see [Conformance Notes).](#conformance-notes-for-the-new-frontend)
- **Status codes / errors (serve.py:531-547):**
  - `404 when xlsx_bytes is None `**and status is terminal — detail object**
`{ "message": "No feasible solution is available.", "status": "<status>" } (serve.py:533-540).`
  - `409 when xlsx_bytes is None and status is `**not terminal — detail object**
`{ "message": "Result is not ready yet.", "status": "<status>" } (serve.py:541-547).`
  - `404 "Optimization job not found" if job unknown (via _get_optimize_job, serve.py:531).`

### CON-API-10 — `DELETE /optimize/{job_id}`

Delete a terminal job. (serve.py:560-579)

- **Request: path **`job_id; no body.`
- **Behavior: runs **`_cleanup_expired_optimize_jobs() first (serve.py:562);`
requires terminal status.
- **Status codes / errors:**
  - `404 "Optimization job not found" if unknown (serve.py:566).`
  - `409 if not terminal — detail object`
`{ "message": "Cannot delete a running optimization job.", "status": "<status>" } (serve.py:567-574).`

## Job-Response Object

Returned by `_optimize_job_response (jobs.py:459-481) from CON-API-03, -04, -07,`
-08, and embedded in SSE `complete/error events. Exact shape:`

```json
{
  "jobId": "opt_<hex>",
  "status": "queued|running|cancelling|optimal|feasible|infeasible|cancelled|failed",
  "queuePosition": 1,
  "inputName": "<original or synthesized filename>",
  "prettify": true,
  "timeout": 300,
  "score": 0,
  "solverStatus": "OPTIMAL",
  "error": null,
  "cancelRequested": false,
  "finishNowRequested": false,
  "clientHeartbeatExpired": false,
  "xlsxReady": false,
  "links": {
    "status": "/optimize/<id>",
    "events": "/optimize/<id>/events",
    "heartbeat": "/optimize/<id>/heartbeat",
    "xlsx": "/optimize/<id>/xlsx"
  }
}
```

<user_quoted_section>No solver field. The current OptimizeJob dataclass (jobs.py:53-68) and _optimize_job_response() (:442-460) do not include a solver key. The job always uses OR-Tools CP-SAT (Contract C4 CON-EXE-01). A rebuilt frontend must not read response.solver.</user_quoted_section>

Field notes (jobs.py:459-481):

- `jobId — job.id.`
- `status — enum string value (see `[Job status enum).](#job-status-enum--terminal-set)
- `queuePosition — integer position among QUEUED jobs (1-based), or null`
when not queued/terminal (`_refresh_queue_positions, jobs.py:144-159; cleared`
to `None when finished, jobs.py:316).`
- `inputName — job.input_name.`
- `prettify — nullable bool (as submitted; null if omitted).`
- `timeout — normalized integer seconds.`
- `score — nullable integer; null until solver reports a best score.`
- `solverStatus — nullable string (e.g. OPTIMAL, FEASIBLE, INFEASIBLE); null until finished.`
- `error — nullable string; populated on cancel/failure.`
- `cancelRequested — bool.`
- `finishNowRequested — bool.`
- `clientHeartbeatExpired — bool (set when heartbeat watchdog cancels the job).`
- `xlsxReady — job.xlsx_bytes is not None (jobs.py:474); true once an XLSX exists to download.`
- `links — dict of convenience relative paths (status, events, heartbeat, xlsx).`

The heartbeat endpoint (CON-API-06) returns only `{ "jobId", "status" }, NOT this full object.`

## SSE Event Stream

Wire format (`_format_sse_event, serve.py:375-376):`

```
event: <event>\ndata: <json>\n\n
```

Keepalive comment line when idle (serve.py:403): `: keepalive\n\n. A keepalive is`
emitted after each `OPTIMIZE_SSE_KEEPALIVE_SECONDS wait window with no new event`
(serve.py:385-388, 402-404). Env var `OPTIMIZE_SSE_KEEPALIVE_SECONDS default 10`
(jobs.py:90).

Streaming loop (`_stream_optimize_job_events, serve.py:379-408): replays all`
accumulated `job.events in order starting at index 0, then blocks on the job`
`condition for new events until a terminal status is reached. After the last`
event of a terminal job, a synthetic terminal event is emitted if not already
present: `error when status is FAILED, otherwise complete (serve.py:395-398).`
The generator returns (closes the stream) after yielding an event whose type is
`complete or error (serve.py:407-408).`

### Event types and payloads

- **`status — payload is `**`_job_status_event_data(job) = { "status": "<status>", "queuePosition": <int|null> } (jobs.py:124-128). Emitted on queue-position changes (jobs.py:159), on cancel (jobs.py:386), and on heartbeat-expiry transitions (jobs.py:449). For finish-now, the published status payload additionally includes "finishNowRequested": true (serve.py:523-525).`
- **`phase — payload is `**`serialize_schedule_phase_progress(payload) for SchedulePhaseProgress progress objects (serve.py:285-286). (Phase progress structure is defined by solver_interface; out of scope for this contract.)`
- **`progress — payload is `**`serialize_solver_progress(payload, include_export_summary=True) for solver progress (serve.py:288-289); as a side effect the job score is updated to payload.currentBestScore.`
- **`complete — payload is the full `**[job-response object at terminal time. Emitted for any terminal status other than ](#job-response-object)`FAILED (_finish_optimize_job_locked appends {"event": "complete", ...}, jobs.py:317; synthetic fallback serve.py:396-397).`
- **`error — payload is the full job-response object; emitted for `**`FAILED terminal status (serve.py:352,396). The error field carries <exception>\n\n<UNEXPECTED_ERROR_VERSION_ADVICE> (serve.py:222-223), where the advice text is: "If this error was unexpected, check that your frontend and backend versions match. Older YAML may not work after breaking changes, though we try to preserve compatibility." (serve.py:161-164).`

The frontend MUST treat receipt of a `complete or error event as the end of the`
stream and stop reading. Events may be replayed from index 0 on reconnect, so the
frontend MUST be idempotent to re-delivery of earlier `status/phase/progress events.`

## Job Lifecycle & Limits

### Job status enum & terminal set

`OptimizeJobStatus (jobs.py:36-46), string values:`

| Enum | Value | Terminal? |
| --- | --- | --- |
| `QUEUED` | `"queued"` | no |
| `RUNNING` | `"running"` | no |
| `CANCELLING` | `"cancelling"` | no |
| `OPTIMAL` | `"optimal"` | yes |
| `FEASIBLE` | `"feasible"` | yes |
| `INFEASIBLE` | `"infeasible"` | yes |
| `CANCELLED` | `"cancelled"` | yes |
| `FAILED` | `"failed"` | yes |

Terminal set (`_is_terminal_job_status, jobs.py:104-111): OPTIMAL, FEASIBLE,`
`INFEASIBLE, CANCELLED, FAILED.`

### Lifecycle

1. `POST /optimize → QUEUED with queuePosition assigned (jobs.py:242-254).`
2. Executor picks up (single worker) → `RUNNING, started_at set (serve.py:270).`
3. Solver runs; `progress/phase events stream; score updated live (serve.py:283-304).`
4. Terminal transition (serve.py:319-346, jobs.py:294-330):
  - `df is None → INFEASIBLE (serve.py:319-329).`
  - else final status derived from solver status (`_final_status_from_solver_status, serve.py:212-219): OPTIMAL→OPTIMAL, FEASIBLE→FEASIBLE, INFEASIBLE→INFEASIBLE, otherwise FAILED; XLSX bytes + filename stored (serve.py:331-344).`
  - Cancellation observed → `CANCELLED with cancellation error (serve.py:256-268, 306-317).`
  - Exception → `FAILED with formatted error (serve.py:347-372).`
 On finish, `queue_position is cleared to None and a terminal event is appended (jobs.py:316-317).`

### Cancel vs. finish-now

- **Cancel / finish-now are always supported for the current backend.**
The only backend is OR-Tools CP-SAT (Contract C4 CON-EXE-01), so the
historical `_solver_supports_job_stop branch in jobs.py:114-115 and`
the unsupported-solver `409 in jobs.py:358-366 are dead code. Cancel`
and finish-now succeed for non-terminal non-`QUEUED jobs (subject to`
`should_stop propagation, see C4 CON-EXE-03). The only 409s`
remaining for cancel/finish-now are "already terminal" (`jobs.py:350-357)`
and the live-job 409 retained at `serve.py:516-518. Queued jobs can`
always be cancelled.
- **cancel on running solver → **`CANCELLING; the running solver polls`
`should_stop() → _is_job_stop_requested (cancel_requested or finish_now_requested, jobs.py:333-335, serve.py:292-295) and finalizes as CANCELLED.`
- **finish-now sets **`finish_now_requested and lets the solver return its best`
solution; final status is the normal solver-derived terminal status (not `CANCELLED).`

### Limits & timing constants

| Constant | Value | Source |
| --- | --- | --- |
| `MAX_OPTIMIZATION_YAML_BYTES` | `2 * 1024 * 1024 (2 MiB)` | serve.py:149 |
| `DEFAULT_OPTIMIZATION_TIMEOUT_SECONDS` | `5 * 60 (300s)` | serve.py:150 |
| `MAX_OPTIMIZATION_TIMEOUT_SECONDS` | `60 * 60 (3600s)` | serve.py:151 |
| `OPTIMIZE_JOB_TTL_SECONDS` | `30 * 60 (1800s)` | jobs.py:87 |
| `OPTIMIZE_MAX_PENDING_JOBS` | `8` | jobs.py:88 |
| `OPTIMIZE_MAX_RETAINED_JOBS` | `32` | jobs.py:89 |
| `OPTIMIZE_SSE_KEEPALIVE_SECONDS` | env, default `10` | jobs.py:90 |
| `OPTIMIZE_CLIENT_HEARTBEAT_TIMEOUT_SECONDS` | env, default `60` | jobs.py:91-93 |
| `OPTIMIZE_CLIENT_LIVENESS_CHECK_SECONDS` | env, default `5` | jobs.py:94 |
| `OPTIMIZE_MAX_WORKERS` | `1` | serve.py:158 |
| `CLIENT_UUID_COOKIE_NAME` | `"nurse_scheduling_client_uuid"` | serve.py:159 |
| `CLIENT_UUID_COOKIE_MAX_AGE_SECONDS` | `30*24*60*60 (2592000s)` | serve.py:160 |

Startup guard: `OPTIMIZE_CLIENT_LIVENESS_CHECK_SECONDS must not exceed`
`OPTIMIZE_CLIENT_HEARTBEAT_TIMEOUT_SECONDS or the module raises at import (jobs.py:484-485).`

### Retention & TTL

- **TTL cleanup (**`_cleanup_expired_optimize_jobs, jobs.py:162-179): jobs whose`
`finished_at is older than OPTIMIZE_JOB_TTL_SECONDS (1800s) are deleted. Runs`
lazily on `_get_optimize_job, _create_optimize_job, and DELETE.`
- **Retention eviction (jobs.py:192-207): on create, if total jobs **`>= 32, oldest`
**terminal jobs (by **`finished_at/created_at) are evicted to make room; if still`
full → `429. Deleting or losing a job means later lookups get 404.`

### Heartbeat watchdog

- A daemon thread `optimize-client-heartbeat runs _run_client_heartbeat_watchdog`
(jobs.py:453-456, 486), sleeping `OPTIMIZE_CLIENT_LIVENESS_CHECK_SECONDS (5s) between checks.`
- `_cancel_jobs_with_expired_heartbeats (jobs.py:407-450): any non-terminal job whose`
`last_client_heartbeat_at <= now - OPTIMIZE_CLIENT_HEARTBEAT_TIMEOUT_SECONDS (60s) is marked`
`client_heartbeat_expired=True, cancel_requested=True, error = "Optimization cancelled because the client heartbeat expired." (jobs.py:420). QUEUED jobs finish immediately as CANCELLED (complete event); running jobs go to CANCELLING.`
- `last_client_heartbeat_at is seeded at creation to created_at (jobs.py:252) and`
refreshed by CON-API-06. The frontend MUST call `POST /optimize/{id}/heartbeat more`
frequently than every 60s while a job is active, or the backend will cancel it.

## Conformance Notes for the new frontend

1. **CORS / origin allow-list (serve.py:411-432): **`allow_origin_regex =`
 `^(http://(localhost|127\.0\.0\.1):[0-9]+|https://([a-zA-Z0-9-]+\.)?nursescheduling\.org)$.`
 Allowed: `http://localhost:<port>, http://127.0.0.1:<port>, and any`
 `https://[subdomain.]nursescheduling.org. The frontend MUST be served from an`
 origin matching this regex. `allow_methods=["*"], allow_headers=["*"],`
 `allow_credentials=True.`
2. **Credentialed requests: the client-UUID cookie is **`HttpOnly and requires`
 `credentials: "include" (fetch) / withCredentials (XHR) on every call so the`
 cookie round-trips; `allow_credentials=True is set. Because the cookie is`
 `HttpOnly, JS cannot read it — rely on the browser to send it.`
3. **Exposed response headers (serve.py:417-421, 431): only**
 `Content-Disposition, X-Schedule-Score, X-Schedule-Status are CORS-exposed.`
 For CON-API-09 the frontend MUST read the filename from `Content-Disposition`
 and the score/status from `X-Schedule-Score / X-Schedule-Status (these are the`
 only cross-origin-readable headers).
4. **Submission contract: send **`multipart/form-data; provide exactly one of`
 `file / yaml_content; keep payload under 2 MiB; timeout in [1, 3600];`
 **do not send a ****`solver`**** field (the backend always uses OR-Tools CP-SAT**
 regardless of any value the frontend might send; see C4 CON-EXE-01).
 Cancel / finish-now are supported for the current backend
 (no "unsupported-solver" `409 branch).`
5. **Async flow: **`POST /optimize returns 202 + job object; then either open the`
 SSE stream (CON-API-05) or poll (CON-API-04). Treat `complete/error SSE events`
 as terminal and close the stream. XLSX is available (CON-API-09) once
 `xlsxReady === true / status is a feasible-or-better terminal state.`
6. **Error-detail shapes: several **`409/404 responses return a structured`
 `detail object ({ "message", "status", ... }), while others return a plain`
 string `detail. The frontend MUST handle both detail being a string and being`
 an object (see CON-API-06/07/08/09/10). FastAPI wraps `detail under a top-level`
 `"detail" key in the response body.`
7. **Heartbeat cadence: while a job is queued/running, POST heartbeats well within**
 the 60s timeout (recommend using the 5s liveness cadence as a guide) to avoid
 server-side cancellation.
8. **Statelessness across restarts: jobs are in-memory only; a **`404 on a`
 previously-known job id may mean TTL expiry, retention eviction, or a backend
 restart. The frontend MUST tolerate `404 on any /optimize/{id} sub-resource.`

## Cross-References

- Solver progress payload serialization (`serialize_solver_progress,`
`serialize_schedule_phase_progress, ScheduleProgress, SchedulePhaseProgress):`
`core/nurse_scheduling/solver_interface.py (imported serve.py:62-67) — governs`
`progress/phase SSE payload fields (out of scope here).`
- Scheduling engine (`scheduler.schedule) and XLSX export (exporter.export_to_excel):`
`core/nurse_scheduling/scheduler.py, core/nurse_scheduling/exporter.py`
(imported serve.py:38) — produce the `score, solver_status, and XLSX bytes surfaced here.`
- Sentry hooks (`capture_invalid_request, capture_optimize_exception, init_sentry):`
`core/nurse_scheduling/sentry.py (imported serve.py:68) — observability only, no client contract.`
- In-memory job state module: `core/nurse_scheduling/jobs.py — authoritative source`
for the job-response object, status enum, limits, and lifecycle referenced above.
