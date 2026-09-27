---
title: "Optimize & Export"
kind: spec
status: 1
---

# Optimize & Export

Prefix: **OE. Fidelity: strict behavioral parity. Requirements are written**
UI-agnostically — they describe *what the app does with data, state, backend*
endpoints, and user-visible strings, not how any control is laid out.

The wire contract for every backend call in this section is Contract C2.

## Durable-protocol reconciliation (2026-07-19)

The product authority was the old upstream application, especially its Optimize page, chart,
anonymization transform, XLSX restoration, and tests. That application now uses
the durable job protocol; the older in-memory/heartbeat descriptions later in
this document are historical mechanism notes, not rebuild requirements.

The binding interpretation for the rebuild is:

- Preserve the old application's user-visible run options, validation,
progress chart, live score, event log, cancel/finish-now controls,
anonymization, restored XLSX IDs, automatic download, and Download Again.
- Use the current snake_case `JobResponse`: lifecycle `state` is
`queued | running | cancelling | completed | cancelled | failed`; solver
meaning is `result.outcome = optimal | feasible | infeasible`.
- Render controls from the server-provided `controls` object and queue text from
`queue_position`; do not infer capabilities from local status tables.
- Use persisted opaque SSE event IDs and reconnect/reconcile behavior through
the same-origin BFF. Browser disconnect has no job-lifecycle meaning and no
client heartbeat is sent.
- Surface structured error codes, including queue capacity, cursor recovery,
missing jobs/artifacts, and `worker_lost`; do not classify failures from old
English detail strings.
- Probe the rebuilt deployment through `/api/info` for readiness and version
identity. `/api/health` remains a compatibility/fallback probe, not the
primary version contract.
- Submit the strict projection of Workspace V1 through `/api/optimize`; the BFF
maps public `/api/*` paths to the backend's `/optimize*` surface.

Accordingly, FR-OE-21..29, FR-OE-44..58, FR-OE-66..74, AC-OE-08..12, and
AC-OE-15..24 are retained for their user-visible intent but their old endpoint,
heartbeat, lifecycle, and response-shape mechanisms are superseded by this
section and the current Contract C2. FR-OE-55 and AC-OE-19 are removed: durable
jobs deliberately send no browser heartbeat.

Deployment verification follows the old repository's actual evidence: direct
Browser → Next → FastAPI streaming is release-blocking. A real Cloudflare
tunnel smoke is optional operational evidence when credentials are available;
it is not required to close T16.

## Upstream `d63519b` execution reconciliation (2026-07-20)

The old repository now exposes multiple solver selectors in its backend and CLI,
but the rebuild intentionally retains the already-settled single-solver product
experience. Optimize & Export shows no solver picker and sends no solver form
field; the rebuilt backend defaults to and accepts only `ortools/cp-sat`.

The new process execution semantics are user-visible only through existing run
and error surfaces:

- a feasible solver-native timeout is a completed feasible run with
`termination_reason="solver_timeout"`;
- a hard watchdog termination is a failed run with
`error.code="process_timeout"` and no download;
- retained legacy jobs may report `limit_or_stop` and remain renderable;
- Cancel is server-enforced and discards any result, while Finish now remains
the cooperative "use the current feasible result" action;
- worker or lease loss remains the distinct retained `worker_lost` failure with
Resubmit behavior.

No new controls, recovery mechanism, or solver-selection UI is introduced.
Historical statements below that the old server has no `solver` form field are
stale source observations; the binding rebuild behavior is still to omit the
field and expose CP-SAT only.

## Purpose & Scope

The Optimize & Export domain orchestrates a backend optimization job from the
frontend: it selects and health-checks a backend, submits the current scheduling
scenario (optionally anonymized) as YAML, streams live progress, allows
cancel / finish-now control, and downloads the resulting XLSX (restoring
anonymized people IDs when applicable). It owns:

- ~~The **backend candidate list and user-managed server options**~~
~~(add / edit / remove / reorder / reset), persisted to `localStorage.`~~
**[SUPERSEDED by [decision log 07](../decision-logs/07-backend-url-via-env/index.md):**
**the backend URL is a single build-time `NEXT_PUBLIC_BACKEND_API_URL` (default**
**`http://localhost:8000`); there is no in-app server management.]**
- **Readiness/version probing** through same-origin `GET /api/info`, with
`/api/health` as compatibility fallback (feeds the status badge; no
auto-selection / multi-candidate priority).
- **Preconditions that gate optimization (missing schedule data, offline**
backend) and the associated contextual messages.
- **Run options (Prettify XLSX, Anonymize schedule data, Solver Timeout) and**
their validation.
- **Job submission through the same-origin BFF, durable SSE/poll recovery, and**
**cancel / finish-now control. No browser heartbeat is sent.**
- The **live incumbent score, the progress chart, the event log, and**
the **result download (with Download Again).**

Out of scope: the YAML content itself (see 08 — Save/Load & YAML and contract
C1), export layout content (09 — Export Layout, contract C5), and the backend
HTTP/job semantics (contract C2). This domain conforms to those contracts; it
does not define them.

## Functional Requirements

<user_quoted_section>⚠️ Superseded in part by decision log 07.The multi-server model below — candidate list, localStorage server options,add/edit/remove/reorder/reset, auto-selection, and the multi-server healthcontrols (FR-OE-01..20 and the "Check all" / per-row / reorder parts ofFR-OE-26) — is removed from the shipped app and from the rebuild paritycontract. What survives, in single-URL form: the backend URL resolves fromNEXT_PUBLIC_BACKEND_API_URL (default http://localhost:8000); buildApiUrl(FR-OE-05); one health probe of that URL (FR-OE-21..25) feeding the statusbadge; and the version display + mismatch note (FR-OE-28/29, KEEP). Everythingfrom Preconditions onward (run options, submission, SSE progress,cancel / finish-now, download) is unchanged.</user_quoted_section>

### Backend candidate list & server model  [SUPERSEDED — DL07]

- **FR-OE-01 — Two built-in backend candidates exist: LOCAL**
`http://localhost:8000 and PRODUCTION https://api.nursescheduling.org`.
- **FR-OE-02 — The PRODUCTION candidate is dropped when**
`process.env.NODE_ENV === 'test' `**or**
`process.env.NEXT_PUBLIC_DISABLE_HOSTED_OPTIMIZE_API === '1'; in that case the`
candidate list is `[LOCAL], otherwise [LOCAL, PRODUCTION]. The initial`
backend URL is `candidates[0].`
- **FR-OE-03 — Each server entry carries: **`endpoint, status`
(`unchecked | checking | online | offline), health, error,`
`lastCheckedAt, pingMs, and healthProbeId. New entries start unchecked`
with all other fields null/0`.`
- **FR-OE-04 — An endpoint is normalized by trimming whitespace and stripping**
all trailing slashes: `endpoint.trim().replace(/\/+$/, '')`.
- **FR-OE-05 — API URLs are built with **`buildApiUrl(endpoint, path): if`
`path starts with http:// or https:// it is used verbatim; otherwise the`
normalized endpoint is prefixed and a leading `/ is ensured`
`. This lets job links be either absolute or relative.`

### Server-options persistence  [SUPERSEDED — DL07]

- **FR-OE-06 — Server options persist under **`localStorage key`
`nurse-scheduling-optimize-server-options. The stored shape`
is `{ servers: [{ endpoint }], selectedServerEndpoint }.`
- **FR-OE-07 — On load: if the key is absent, JSON is invalid, or**
`parsed.servers is not an array, fall back to the default candidate entries`
(FR-OE-01/02) with selection `'auto'. Otherwise dedupe/normalize stored`
servers, and accept the stored selection only if it is `'auto' or matches an`
existing (deduped) endpoint — else `'auto'.`
- **FR-OE-08 — Dedup/normalization (**`dedupeServerEntries): skip entries whose`
`endpoint is not a string; normalize each endpoint; skip empties and any`
endpoint already seen (first occurrence wins)`.`
- **FR-OE-09 — Options are persisted (overwriting the key) on any mutating**
action — select, edit, add, remove, reorder`.`
**Reset removes the key entirely.**
- **FR-OE-10 — Server options and selection are loaded from storage on mount**
into state and the initial ref (isomorphic layout effect). SSR default is the
built-in candidates with `'auto'`.

### Add / edit / remove / reorder / reset

- **FR-OE-11 (Add) — Adding an empty (post-normalization) URL silently cancels**
the add. A duplicate URL sets add error `"Backend URL already exists." and`
does not add. Otherwise the entry is appended, persisted, and immediately
health-checked`. The add field placeholder is`
`"https://backend.example.test" with empty hint "Double-click to add URL"`.
- **FR-OE-12 (Edit) — Editing an endpoint to empty sets that entry's error to**
`"Backend URL is required."; to a duplicate sets "Backend URL already exists."; either case invalidates the entry's in-flight probe and resets it`
to `unchecked without persisting the bad value.`
A valid edit normalizes the endpoint, resets the entry to `unchecked, updates`
the active selection if it referenced the old endpoint, persists, and starts a
fresh health check`.`
- **FR-OE-13 (Remove) — Removing an entry drops it from the list; if it was the**
selected server the selection reverts to `'auto'; its in-flight probe is`
aborted; the result is persisted`.`
- **FR-OE-14 (Reorder) — Server entries may be reordered; the auto row is not**
a server and is excluded; the new order is persisted`.`
Reorder is disabled while optimizing or while an endpoint is being edited/added.
- **FR-OE-15 (Reset) — Reset aborts all in-flight probes, deletes the stored**
options, restores the default candidate entries, sets selection `'auto',`
clears any add-in-progress state, and re-checks every default server.
- **FR-OE-16 — All server-management controls (select, edit, add, remove,**
per-row check, Check all, Reset, reorder) are disabled while `isOptimizing is`
true.

### Auto selection & resolved endpoint  [SUPERSEDED — DL07: resolved endpoint = the single env URL]

- **FR-OE-17 (Auto) — When selection is **`'auto', the chosen server is the`
first server (by list order / original index) whose `status === 'online' and`
that has a `health payload. selectPreferredServer sorts online candidates by`
their original index and returns the first. The Auto row shows `Uses <endpoint> when`
resolved, else `"Uses the first online server by priority."`.
- **FR-OE-18 — **`resolvedServer is the auto-chosen server when selection is`
`'auto', else the explicitly selected server. resolvedOptimizeEndpoint =`
`lockedOptimizeEndpoint ?? resolvedServer.endpoint ?? serverEntries[0].endpoint ?? ''.`
- **FR-OE-19 (Auto status) — **`autoServerStatus is online if an auto server`
resolved; else `checking if any server is checking; else offline if any is`
offline; else `unchecked.`
- **FR-OE-20 (Active status/health) — **`activeServerStatus is autoServerStatus`
under Auto, else the selected server's status (default `unchecked).`
`activeServerHealth under Auto is the resolved server's health, else the first`
checking server that already has a health payload, else null; under explicit
selection it is the selected server's health`.`

### Health probing  [single configured URL only — DL07]

- **FR-OE-21 — A health probe issues **`GET <endpoint>/health with`
`cache: 'no-store' and an AbortController that aborts after `**3000 ms**
(`HEALTH_CHECK_TIMEOUT_MS and INITIAL_HEALTH_CHECK_TIMEOUT_MS, both 3000).`
It also aborts on an external signal`.`
- **FR-OE-22 — A probe resolves to a health object only if the response is**
OK **and the parsed JSON has **`status === 'ok'; a non-OK response, non-ok`
status, or any thrown error resolves to `null (offline)`.
- **FR-OE-23 — The expected health payload is**
`{ status, version, apiVersion?, appVersion }.`
- **FR-OE-24 — Starting a probe sets the entry to **`checking and clears its`
error; on completion it sets `status to online/offline, stores health,`
sets `error to null (online) or "Backend is not responding." (offline),`
records `lastCheckedAt = new Date(), and records pingMs = round(now - start)`.
- **FR-OE-25 — Probe results are applied only if still current: same page mount**
id, same normalized endpoint, and same `healthProbeId — otherwise the update`
is ignored (stale-guard)`. Each new probe supersedes any`
in-flight probe for the same endpoint (its controller is aborted).
- **FR-OE-26 — On page mount, every initial server is health-checked; on**
unmount all in-flight probe controllers are aborted`.`
`Check all re-checks every server; a per-row`
check button re-checks a single server`.`
- **FR-OE-27 — While any server is **`checking, an indicator text`
`"Checking API endpoints..." is shown.`

### Version display & mismatch note (KEEP — functional)

- **FR-OE-28 — When an active health payload exists, the version summary is**
shown as: `API version: <apiVersion ?? version> · Frontend version: <CURRENT_APP_VERSION> · Backend version: <appVersion>.`
`CURRENT_APP_VERSION comes from NEXT_PUBLIC_APP_VERSION (default 'unknown').`
- **FR-OE-29 — An app-version mismatch is flagged when the frontend and backend**
`appVersion strings differ, `**or either version is "dirty" (ends with**
`-dirty). On`
mismatch, this non-blocking note is displayed and MUST be kept:
`"Frontend and backend versions do not match. If nothing breaks, you can continue.". It does not disable optimization.`

### Preconditions & disable rules

- **FR-OE-30 — Missing-data flags: dates are missing when there is no start**
date, no end date, or zero date items; people are missing when there are zero
people items; shift types are missing when there are zero shift-type items
**and zero shift-type groups. **`isRequiredDataMissing is the OR of these`
three`.`
- **FR-OE-31 — A contextual banner is shown when required data is missing, with**
priority dates → people → shift types (only the highest-priority missing one
shows). Exact text (verbatim, with tab link):
  - Dates: `"Please set up your dates first by visiting the Dates tab."`
(link to `/dates).`
  - People: `"Please set up your people first by visiting the People tab."`
(link to `/people).`
  - Shift Types: `"Please set up your shift types first by visiting the Shift Types tab." (link to /shift-types).`
- **FR-OE-32 — The optimize action is disabled when **`isOptimizing, `**or**
required data is missing, **or **`activeServerStatus !== 'online'`
`. The contextual disabled reason is`
`"Complete the missing schedule configuration before optimizing." when data`
is missing, else `"Backend unavailable. Check or select an online backend."`
when the backend is not online, else none`.`
- **FR-OE-33 — The active-server status indicator shows **`Server: <label> where`
label ∈ {`Checking, Online, Offline, Unchecked} plus the`
`resolvedOptimizeEndpoint (or "No backend" when empty)`
`. When the active server is offline, an`
advisory is shown: `"Backend is not responding at the configured endpoint."`.

### Run options

- **FR-OE-34 (Prettify) — **`Prettify XLSX boolean, `**default true. Label**
`"Prettify XLSX", help "Apply formatting to the generated workbook."`.
- **FR-OE-35 (Anonymize) — **`Anonymize schedule data boolean, `**default true.**
Label `"Anonymize schedule data", help "Anonymize people IDs and remove descriptions before sending to the backend.".`
- **FR-OE-36 (Timeout) — **`Solver Timeout integer, `**default 300, unit label**
`"sec", input min 1, max 3600, placeholder "300"`. The input accepts empty
and coerces integer strings to numbers.
- **FR-OE-37 — Timeout validation: the run is rejected when the value is**
empty, not a number, not an integer, or `< 1, with message`
`"Solver timeout must be a valid positive integer."` (the
message is also cleared on edit).

### Job submission

- **FR-OE-38 (Guard order) — On optimize: (1) if required data is missing,**
reset all run/result state and return (no request)`;`
(2) else validate timeout (FR-OE-37); (3) else if the active server is not
online or the resolved endpoint is empty, set error `"Select an online backend before optimizing." and return.`
- **FR-OE-39 (Lock) — On a valid run, the resolved endpoint is captured as**
`runEndpoint and set as lockedOptimizeEndpoint, so all subsequent requests`
for that run (status/events/xlsx/heartbeat/control/delete) target the same
endpoint even if selection/health changes mid-run. The lock is cleared in the
`finally block.`
- **FR-OE-40 (State reset) — Starting a run clears: timeout error, error/success**
messages, score, status, job id, job, incumbent, progress points, saved
download (revoking its object URL), and the SSE event log; and sets
`isOptimizing = true. This is the "repeat run resets`
state" behavior.
- **FR-OE-41 (Anonymize path) — When Anonymize is on, the filtered export state**
is anonymized via `anonymizeSchedulingStateWithMapping(state, { anonymizePeopleItems: true, anonymizePeopleGroups: false, removeDescriptions: true }), producing the transformed state plus a reverse map`
`originalIdByAnonymizedId. When off, the raw filtered state is used and no map`
is produced`.`
- **FR-OE-42 (Anonymization semantics) — People item IDs are remapped to**
`P1, P2, … (skipping any collisions with retained IDs); group IDs are left`
intact (groups not anonymized here). Every reference to a person ID is remapped
consistently across people/groups members, all preference types
(requirement `qualifiedPeople; request/successions/count person; affinity`
`people1/people2 reference trees; `**shift type covering**
**`preceptors** / ****`**`preceptees),`
and export `formatting[].people / extraRows[].countPeople. `**Note**
**on covering ****`shiftTypes: the current implementation also passes**`
`shiftTypes through the same people-anonymization map (via`
`mapReferenceIdTree), so a shift-type id that collides with an`
anonymized people/group id would be rewritten. In practice shift-type
ids do not collide with people/group ids (the namespaces are
separate), so this is normally a no-op. With `removeDescriptions, every`
`description field is recursively removed from the payload`.
- **FR-OE-43 (Multipart body) — The request body is `FormData with:`**
**`yaml_content = YAML generated from the (anonymized or raw) state`**
**with `export: effectiveExportData` always set (see FR-OE-43a);**
**`prettify = String(prettifyArg) (appended only when not null/undefined);`**
**`timeout = String(timeoutArg).`**
**The frontend sends no `solver` field; the backend runs CP-SAT only and**
**rejects any other solver value (see Contract C2 `POST /optimize`). The**
**frontend does not** send or read a solver selection.
- **FR-OE-43a (Optimize payload always includes `export`). The optimize**
payload builder assembles `filteredState with`
`export: effectiveExportData unconditionally`
`, where`
`effectiveExportData = state.export ?? generateExportLayoutConfig(...)`
`. This is asymmetric with the`
Save/Load download (which includes `export only when state.export`
is truthy — see spec 08 FR-SL-01/02): the optimize payload therefore
always carries a frontend-generated default export layout even when
the user has not authored one. A rebuilder that mirrors spec 08's
`...(exportData ? { export: exportData } : {}) for optimize will`
lose the default layout and change the backend's prettified xlsx
output.
- **FR-OE-44 (Create request) — **`POST <normalized runEndpoint>/optimize with`
the multipart body. A non-OK response throws
`Server error (<status>): <detail>. The created job's`
`id, full job object, and state are stored.`
- **FR-OE-45 (Error detail) — **`<detail> is extracted from the response body:`
if the body is JSON with a string `detail, use it; if detail is present but`
non-string, use its JSON stringification; otherwise use the raw response text.

### Progress reporting: SSE + polling fallback

- **FR-OE-46 (Terminal statuses) — The terminal job statuses are exactly**
`optimal, feasible, infeasible, cancelled, failed`
`. waitForOptimizeJob resolves immediately if the created job`
is already terminal`.`
- **FR-OE-47 (SSE) — When **`EventSource is available, an EventSource is opened`
at `buildApiUrl(runEndpoint, job.links.events) and listens for named events`
`status, progress, phase, complete, error. Each`
event's `data is JSON-parsed when possible, else kept as the raw string`.
- **FR-OE-48 (status event) — Appends a log entry; if the payload carries a**
`status, updates the run status; merges the payload into the current job`.
- **FR-OE-49 (progress event) — Appends a log entry; a payload is a progress**
event when it is an object containing `currentBestScore. It updates the`
incumbent result; when `currentBestScore is a number it updates the displayed`
score; when both `currentBestScore and elapsedSeconds are numbers it appends`
a chart point `{ currentBestScore, elapsedSeconds, commentCount, solutionIndex, source }.`
- **FR-OE-50 (phase event) — Appends a log entry.**
- **FR-OE-51 (complete event) — Closes the stream, appends a log entry, sets the**
current job to the completed payload, and resolves the wait.
- **FR-OE-52 (error event) — If the error event has a non-empty string **`data,`
the stream is closed, the entry logged, and the wait is rejected with
`parsedData.error ?? "Optimization failed". Otherwise (transport`
disconnect) it only logs `"Optimization event stream disconnected; waiting to reconnect" and lets EventSource reconnect (no close, no reject)`.
- **FR-OE-53 (Polling fallback) — When **`EventSource is undefined, the job is`
polled: `GET buildApiUrl(runEndpoint, job.links.self) with cache: 'no-store' every `**1000 ms until a terminal status; each poll updates the**
current job and status; a non-OK poll throws `Server error (<status>): <detail>; the loop resolves on terminal status and rejects on error`.
- **FR-OE-54 (Completion handling) — After the wait resolves, the current job**
and state are updated; if `result.score` is not null the score is set; if
`result.solver_status` is present the displayed status is set to it. If the job
has an `error`, it is thrown. If `links.schedule` is null, throw
`No downloadable schedule is available. Job status: <status>.`

### Client heartbeat

- **FR-OE-55 — Removed.** Durable jobs send no browser heartbeat, and the
backend has no heartbeat endpoint (see the reconciliation section above and
Contract C2).
- **FR-OE-56 (Job-active definition) — **`isJobActive is true when a job id`
exists, `isOptimizing is true, a status exists, and that status`
(lower-cased) is not terminal`.`

### Cancel & finish-now

- **FR-OE-57 — Cancel and finish-now issue**
`POST buildApiUrl(runEndpoint, '/optimize/<id>/<action>') where <action>`
is `cancel or finish-now; a non-OK response throws Server error (<status>): <detail>; the returned job updates the current job and status`
`. On failure the error message is the thrown message, or`
the fallback `"Unable to cancel optimization" (cancel) /`
`"Unable to request current results" (finish-now).`
- **FR-OE-58 (Control button rules) — The cancel/finish-now controls appear only**
while a job is active. `isCancelling is true when the status is cancelling.`
The finish-now control (`"Get Results Now") is disabled when`
`currentJob.finishNowRequested is truthy or isCancelling. The cancel control`
is disabled when `isCancelling and its label switches to "Cancelling..."`
from `"Cancel".`

### Progress chart

- **FR-OE-59 (Render condition) — The chart renders only when there are ≥ 2**
progress points; it receives `isActive = isJobActive.`
- **FR-OE-60 (Series) — A Score line (**`currentBestScore, stepAfter,`
color `#2563eb) is always shown; a `**Comments line (**`commentCount,`
`stepAfter, color #d97706, connectNulls) is shown/hidden by a toggle`
labeled `"Hide comments" / "Show comments", `**default shown**
`. Header text:`
`"Incumbent Progress" and "Higher scores are better. Hover to inspect a solution.".`
- **FR-OE-61 (Live-extrapolated x-axis) — The X axis is elapsed seconds. When**
`isActive, a 250 ms interval extrapolates a live elapsed value =`
`latestElapsedSeconds + (now - start)/1000; the domain max is`
`max(liveElapsed, latestElapsed, 1). The domain min is 0 for the Full range,`
else the first visible point's elapsed, clamped so the span is at least
`max(domainMax * 0.01, 0.1).`
- **FR-OE-62 (Range presets) — Range presets: **`Full, Last 1 min (last 60 s),`
`Last 10 min (last 600 s), Last 10 (last 10 points), Last 50 (last 50`
points); default `Full. Time-window presets start at the first point whose`
elapsed ≥ `latestElapsed − window; point-count presets start at`
`max(length − count, 0).`
- **FR-OE-63 (Dot rendering) — Point dots are drawn only when the visible point**
count is ≤ **30 (**`DOT_LIMIT); above that, dots are hidden and the note`
`"Points hidden · hover to inspect" is shown. A ReferenceDot always marks`
the latest score, and the latest comments point when its `commentCount is a`
number.
- **FR-OE-64 (Tooltip) — Hover tooltip shows elapsed (**`… elapsed), Score,`
Comments (`N/A when not numeric), Solution (#<index> or N/A), and Source`
when present`.`

### Live result & downloads

- **FR-OE-65 (Score panel) — The score label is **`"Live Incumbent Score" while`
optimizing, `"Final Score" when a score exists after finishing, else`
`"Score"; the value is the formatted score or "No incumbent yet", with`
caption `"Higher scores are better." Scores are formatted with`
`Intl.NumberFormat at ≤ 2 fraction digits.`
- **FR-OE-66 (Run status text) — Run status = **`formatRunStatus(status, queuePosition) when a status exists (→ Idle when null; Queued, position <n> when status is queued with a queue position; else the raw status),`
else `"Starting" while optimizing, else "Idle".`
- **FR-OE-67 (Status detail lines) — Below the score: no job → **`"No optimization has been started."; optimizing & queued → "Waiting in optimization queue at position <n>." or "Waiting in optimization queue."; optimizing without an`
incumbent → `"Waiting for first feasible solution..."; with an incumbent →`
`"<Solution #<idx>|Incumbent> · <elapsed|time unavailable> · <n comments|comments unavailable>[ · <source>]"; else "Job <id>". When a job id exists,`
`"Job ID: <id>" is also shown.`
- **FR-OE-68 (XLSX fetch) — On success, **`GET buildApiUrl(runEndpoint, completedJob.links.xlsx); a non-OK response throws Server error (<status>): <detail>.`
- **FR-OE-69 (ID restoration) — When the run was anonymized, the downloaded XLSX**
is post-processed by `restorePeopleIdsInXlsx(blob, reverseMap, peopleCount)`
before download; when not anonymized the raw blob is passed through unchanged
(never parsed or re-serialized). Restoration reads the first worksheet and
rewrites column A for rows `3 … 3 + peopleCount − 1`, then re-serializes with MIME
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Unlike the
pre-rebuild app, restoration **fails closed**: it throws `XlsxRestorationError`
on any deviation from the expected C5 layout — a non-string or unmapped people-id
cell, a duplicate anonymized id, a shifted `Score`/`Status` boundary, a missing
header row, a wrong freeze boundary, or any unused reverse-map entry — so the user
is never handed a file that looks restored while still leaking an anonymized `P#`
.
- **FR-OE-70 (Filename) — The download filename is parsed from the**
`Content-Disposition header via filename="?([^"]+)"?; the default when the`
header is absent or unmatched is `"output.xlsx".`
- **FR-OE-71 (Auto-download & save) — The blob is turned into an object URL,**
saved (URL + filename) so it can be re-downloaded, and a synthetic anchor click
triggers an immediate download`.`
- **FR-OE-72 (Cleanup) — After download the job is deleted via**
`DELETE /api/optimize/<id>`, and the deletion is an **awaited, gating** cleanup
step — not fire-and-forget. It runs as a tracked cleanup phase (`cleanupPhase`)
that the user can **Retry** or **Abandon** on failure, and a pending/failed
cleanup blocks starting the next run until it is resolved (`web/components/optimize`).
A successful delete relays the backend's `204 No Content`.
- **FR-OE-73 (Success/finally) — On success the message**
`"Schedule optimized and downloaded successfully!" is shown`
`. The finally block always sets isOptimizing = false and`
clears `lockedOptimizeEndpoint.`
- **FR-OE-74 (Error message) — Any thrown error during the run sets the error**
message to `error.message, or "An unexpected error occurred during optimization" for non-Error throws.`
- **FR-OE-75 (Download Again) — When a saved download exists, a **`"Download Again" control re-triggers the download of the saved object URL with the saved`
filename`. The saved object URL is revoked on`
a new run and on unmount`.`

### Event log

- **FR-OE-76 — Every SSE/log entry stores **`{ type, data, receivedAt } and is`
appended to the event log; the log shows a count `"<n> events" and per-type`
color badges (`complete green, error red, progress blue, phase amber,`
otherwise gray)`.`
- **FR-OE-77 (Auto-scroll) — Before each append, the log records whether it is**
scrolled to (within 4 px of) the bottom; after the append, it auto-scrolls to
the bottom only if it was at/near the bottom, so manual scroll-up is preserved.
- **FR-OE-78 (Empty & summary) — Empty log shows **`"Waiting for optimization events..." while optimizing, else "No optimization events yet.". Progress`
entries render a summary line joined by `" · "`
(`Score: <formatted|N/A>, optional Comments: <n>, optional`
`Elapsed: <n>s, optional Solution: #<idx>, optional Source: <src>); phase`
entries render their `message; every entry exposes "Raw event data"`.

## Validation Rules & Messages

| Rule / trigger | Condition | Message (verbatim) |
| --- | --- | --- |
| Dates missing | no start/end date or 0 date items | `Please set up your dates first by visiting the Dates tab. (link /dates)` |
| People missing | 0 people items | `Please set up your people first by visiting the People tab. (link /people)` |
| Shift types missing | 0 items and 0 groups | `Please set up your shift types first by visiting the Shift Types tab. (link /shift-types)` |
| Optimize disabled — data | required data missing | `Complete the missing schedule configuration before optimizing.` |
| Optimize disabled — backend | active server not online | `Backend unavailable. Check or select an online backend.` |
| Timeout invalid | empty / non-number / non-integer / `< 1` | `Solver timeout must be a valid positive integer.` |
| Backend not online at submit | active status ≠ online or empty endpoint | `Select an online backend before optimizing.` |
| Add backend empty | normalized URL empty | (silently cancels add — no message) |
| Add backend duplicate | endpoint already exists | `Backend URL already exists.` |
| Edit backend empty | normalized URL empty | `Backend URL is required.` |
| Edit backend duplicate | endpoint already exists | `Backend URL already exists.` |
| Health probe offline | non-OK / not `status:'ok' / error` | entry error `Backend is not responding.` |
| Active backend offline advisory | active status = offline | `Backend is not responding at the configured endpoint.` |
| Checking indicator | any server checking | `Checking API endpoints...` |
| Version mismatch (KEEP) | frontend ≠ backend or either dirty | `Frontend and backend versions do not match. If nothing breaks, you can continue.` |
| Create/status/xlsx/control non-OK | HTTP not OK | `Server error (<status>): <detail>` |
| No downloadable result | `links.schedule` is null | `No downloadable schedule is available. Job status: <status>` |
| SSE fatal error | error event has string data | `<payload.error> or Optimization failed` |
| SSE transport disconnect | error event without data | log `Optimization event stream disconnected; waiting to reconnect` |
| Cancel failure fallback | non-Error throw on cancel | `Unable to cancel optimization` |
| Finish-now failure fallback | non-Error throw on finish-now | `Unable to request current results` |
| Generic run failure | non-Error throw during run | `An unexpected error occurred during optimization` |
| Success | download completed | `Schedule optimized and downloaded successfully!` |

## Edge Cases & Quirks

- **Locked endpoint survives selection change — Once a run starts, all its**
requests target the captured `runEndpoint; changing the selected/auto server`
or its health mid-run does not redirect the in-flight run.
- **Auto uses list order, not ping — Auto picks the first online server by list**
position (index), independent of `pingMs.`
[incidental quirk]
- **Active health under Auto can borrow a checking server's stale health —**
When no server has resolved yet, `activeServerHealth may fall back to the`
first *checking server that still carries a prior health payload*
`. [incidental quirk]`
- **`selectOfflineFallbackBackendApiUrl** is exported but unused on this page;**`**
offline resolution instead falls through to `serverEntries[0] via`
`resolvedOptimizeEndpoint.`
- **Dirty version always flags mismatch — Even when frontend and backend**
versions are identical, a `-dirty suffix on either forces the mismatch note`.
- **`prettify** omitted only if null/undefined — Since it is always a boolean in**`**
state, `prettify is effectively always sent as "true"/"false"`
`. [incidental quirk]`
- **Required-data click resets instead of erroring — Clicking optimize while**
data is missing clears all result state and returns without a message; the
banner/disabled reason already explains why`.`
- **SSE transport errors auto-reconnect — A data-less error event does not fail**
the run; only an error event carrying string `data rejects it`.
- **`solverStatus** overrides displayed status — After completion the displayed**`**
status is replaced by `completedJob.solverStatus when present, which may`
differ from the terminal job `status.`
- **Restore touches only the schedule sheet's people column, and fails closed on**
**anything unexpected — Only worksheet 0, rows `3 … 3+peopleCount−1, column 1`**
are rewritten; every other cell is left untouched. But a people-id cell that is
not a mapped `P#`, or any unused reverse-map entry, is **not** skipped — it throws
`XlsxRestorationError` rather than leaving it as-is
.
- **Anonymization ID collisions are skipped — **`P#/G# indices advance past any`
ID already retained/used, so anonymized IDs never collide with retained ones.
- **Chart minimum visible span — With near-zero elapsed the X domain is widened**
to at least `max(domainMax*0.01, 0.1) so the line is not degenerate`.
- **Chart hidden below 2 points — A single progress point never renders the**
chart`.`
- **Stale probe guard — Results from superseded probes (older mount id or**
probe id, or renamed endpoint) are discarded; renaming/clearing an endpoint
bumps the probe id to invalidate in-flight results.

## Acceptance Criteria

- **AC-OE-01 — Given **`NODE_ENV is not test and the hosted-API disable flag`
is unset, when the page loads with no stored options, then the backend
candidate list is exactly `http://localhost:8000 then`
`https://api.nursescheduling.org, selection is Auto.`
- **AC-OE-02 — Given **`NODE_ENV === 'test' or`
`NEXT_PUBLIC_DISABLE_HOSTED_OPTIMIZE_API === '1', when the page loads, then the`
production candidate is absent and only `http://localhost:8000 is offered.`
- **AC-OE-03 — Given stored options exist, when the page loads, then servers**
are restored after normalization/dedup, and the stored selection is applied
only if it is Auto or matches a remaining endpoint (else Auto).
- **AC-OE-04 — Given a stored payload that is missing/corrupt or whose**
`servers is not an array, when the page loads, then the default candidates and`
Auto selection are used.
- **AC-OE-05 — When a server is added, edited, removed, reordered, or selected,**
then the persisted options reflect the change; when Reset is invoked, then the
stored key is removed and defaults with Auto are restored and re-checked.
- **AC-OE-06 — Given an endpoint with surrounding whitespace or trailing**
slashes, when it is added/edited, then it is stored normalized (trimmed,
trailing slashes removed).
- **AC-OE-07 — When adding/editing to a URL that duplicates an existing**
(normalized) endpoint, then the change is rejected with `Backend URL already exists.; editing to empty yields Backend URL is required.; adding empty`
silently cancels.
- **AC-OE-08 — When a health check runs, then it issues **`GET <endpoint>/health`
with no-store caching, aborts after 3000 ms, and marks the server online only
when the response is OK with a JSON body whose `status is ok; otherwise`
offline with error `Backend is not responding..`
- **AC-OE-09 — Given selection is Auto and multiple servers are online, when**
resolving the active server, then the first online server by list order is
used and the resolved endpoint reflects it.
- **AC-OE-10 — Given an active health payload, when displayed, then the version**
line shows `apiVersion (falling back to version), the frontend version, and`
the backend `appVersion; when the frontend/backend versions differ or either`
is dirty, then the mismatch note is shown and optimization remains allowed.
- **AC-OE-11 — When required schedule data (dates, people, or shift types) is**
missing, then optimize is disabled, the priority-ordered contextual banner is
shown, and the disabled reason is `Complete the missing schedule configuration before optimizing.`
- **AC-OE-12 — When the active server is not online, then optimize is disabled**
with reason `Backend unavailable. Check or select an online backend.`
- **AC-OE-13 — Given the run options, when the page loads, then Prettify XLSX is**
on, Anonymize schedule data is on, and Solver Timeout is 300 (min 1, max 3600).
- **AC-OE-14 — When submitting with a timeout that is empty, non-integer, or**
`< 1, then no request is made and the message is Solver timeout must be a valid positive integer.`
- **AC-OE-15 — When a valid run is submitted, then a multipart **`POST /optimize`
is sent to the resolved endpoint containing `yaml_content, prettify, and`
`timeout, and that endpoint is locked for the remainder of the run.`
- **AC-OE-16 — Given Anonymize is on, when submitting, then people item IDs are**
remapped to `P#, descriptions are stripped, all person references are remapped`
consistently, and a reverse map is retained for result restoration; given
Anonymize is off, the raw filtered state is sent and no restoration occurs.
- **AC-OE-17 — Given **`EventSource is supported, when a job runs, then progress`
is consumed from SSE `status/progress/phase/complete/error events, the`
incumbent score updates on numeric `currentBestScore, and a chart point is`
recorded whenever both `currentBestScore and elapsedSeconds are numeric.`
- **AC-OE-18 — Given **`EventSource is unavailable, when a job runs, then the job`
status is polled every 1000 ms until a terminal status.
- **AC-OE-19 — Removed** (no browser heartbeat; see FR-OE-55).
- **AC-OE-20 — Given a job is active, when finish-now is requested, then**
`POST /optimize/<id>/finish-now is sent and the button is disabled once`
`controls.early_completion_available is false or while cancelling; when cancel is requested,`
`POST /optimize/<id>/cancel is sent and the control shows Cancelling...`
while the status is `cancelling.`
- **AC-OE-21 — When a job reaches a terminal status of **`optimal, feasible,`
`infeasible, cancelled, or failed, then the wait completes; a job error`
surfaces as the error message, and a null `links.schedule` yields
`No downloadable schedule is available. Job status: <status>.`
- **AC-OE-22 — When the result is fetched, then the filename comes from**
`Content-Disposition (default output.xlsx), the file auto-downloads, the job`
is deleted via an awaited, gating `DELETE /api/optimize/<id>` (retryable /
abandonable on failure, and blocking the next run until resolved), and the
success message is `Schedule optimized and downloaded successfully!`.
- **AC-OE-23 — Given the run was anonymized, when the XLSX is received, then**
people IDs in the first worksheet (rows 3…3+peopleCount−1, column 1) are
restored to their original values before download; and given any deviation from
the expected C5 layout or an unmapped/unused id, then restoration throws
`XlsxRestorationError` and no file is downloaded (fail-closed — never a
partially-restored file).
- **AC-OE-24 — After a completed run, when Download Again is invoked, then the**
previously saved file re-downloads with the same filename without a new job.
- **AC-OE-25 — When a new run starts, then prior error/success, score, status,**
job, incumbent, progress points, saved download, and event log are all cleared
before submission.
- **AC-OE-26 — Given ≥ 2 progress points, when the chart renders, then it shows**
a step-after score line, a toggleable comments line (shown by default), an
elapsed x-axis that live-extrapolates while the job is active, range presets
(Full / Last 1 min / Last 10 min / Last 10 / Last 50), and hides point dots
above 30 visible points with the note `Points hidden · hover to inspect.`
- **AC-OE-27 — When events arrive, then each is appended to the event log with a**
type badge and timestamp, the count updates, and the log auto-scrolls to the
bottom only when already at/near the bottom.

## Cross-References

- **Contract C2 — HTTP Serve API (**`../contracts/index.md, prefix CON-API):`
authoritative source for `GET /health (health payload shape), POST /optimize`
(multipart `yaml_content/prettify/timeout — `**no `solver` field;**
see C2 `POST /optimize`), the job-response object shape (the current **snake_case**
wire contract: `id`, `state`, `terminal`, `queue_position`, timestamps, retained
`request`, nullable `result` (with `result.outcome`), nullable structured
`error`, server-derived `controls`, and `links` — **no `solver` key; see**
C2 `JobResponse`), the SSE event stream (`job.*` event types with opaque
cursors), job status polling (`links.self`), cancel / finish-now
(`links.cancellation`, `links.early_completion`), `DELETE /optimize/<id>`,
xlsx retrieval (`links.schedule`, including `Content-Disposition`), the roster
route, status codes, queue semantics, and terminal states. This domain must conform to C2 exactly.
- **Contract C1 — YAML Scenario Schema and 08 — Save/Load & YAML: the**
`yaml_content body is produced by the shared YAML generator over the filtered`
(and optionally anonymized) scheduling state.
- **05 — Card Preference Editors and 09 — Export Layout: anonymization**
remaps person references across all preference types and export
`formatting/extraRows.`
- **Contract C5 — Exporter Output: defines the XLSX structure that**
`restorePeopleIdsInXlsx post-processes (schedule sheet, people column layout).`
- **07 — State, History & Persistence: server options use the **`localStorage`
key `nurse-scheduling-optimize-server-options, independent of the main`
scheduling store.
