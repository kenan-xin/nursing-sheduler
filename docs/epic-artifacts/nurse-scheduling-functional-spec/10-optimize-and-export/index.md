---
kind: spec
title: "Optimize & Export"
status: 1
---

# Optimize & Export

Prefix: **OE**. Fidelity: strict behavioral parity. Requirements are written
UI-agnostically — they describe *what* the app does with data, state, backend
endpoints, and user-visible strings, not how any control is laid out.

Primary sources:
- `web-frontend/src/app/optimize-and-export/page.tsx`
- `web-frontend/src/app/optimize-and-export/serverSelection.ts`
- `web-frontend/src/components/OptimizationProgressChart.tsx`
- `web-frontend/src/utils/restorePeopleIdsInXlsx.ts`
- `web-frontend/src/utils/anonymizeSchedulingState.ts`

## Purpose & Scope

The Optimize & Export domain orchestrates a backend optimization job from the
frontend: it selects and health-checks a backend, submits the current scheduling
scenario (optionally anonymized) as YAML, streams live progress, allows
cancel / finish-now control, and downloads the resulting XLSX (restoring
anonymized people IDs when applicable). It owns:

- The **backend candidate list** and user-managed **server options**
  (add / edit / remove / reorder / reset), persisted to `localStorage`.
- **Auto** backend selection (first online server by priority order) and
  per-server **health probing** against `GET /health`.
- **Preconditions** that gate optimization (missing schedule data, offline
  backend) and the associated contextual messages.
- **Run options** (Prettify XLSX, Anonymize schedule data, Solver Timeout) and
  their validation.
- **Job submission** (multipart `POST /optimize`), **progress reporting** via
  SSE with a **1000 ms polling fallback**, **client heartbeat**, and
  **cancel / finish-now** control.
- The **live incumbent score**, the **progress chart**, the **event log**, and
  the **result download** (with **Download Again**).

Out of scope: the YAML content itself (see 08 — Save/Load & YAML and contract
C1), export layout content (09 — Export Layout, contract C5), and the backend
HTTP/job semantics (contract C2). This domain conforms to those contracts; it
does not define them.

## Functional Requirements

### Backend candidate list & server model

- **FR-OE-01** — Two built-in backend candidates exist: LOCAL
  `http://localhost:8000` and PRODUCTION `https://api.nursescheduling.org`
  (`serverSelection.ts:33-34`).
- **FR-OE-02** — The PRODUCTION candidate is dropped when
  `process.env.NODE_ENV === 'test'` **or**
  `process.env.NEXT_PUBLIC_DISABLE_HOSTED_OPTIMIZE_API === '1'`; in that case the
  candidate list is `[LOCAL]`, otherwise `[LOCAL, PRODUCTION]`. The initial
  backend URL is `candidates[0]` (`serverSelection.ts:35-40`).
- **FR-OE-03** — Each server entry carries: `endpoint`, `status`
  (`unchecked` | `checking` | `online` | `offline`), `health`, `error`,
  `lastCheckedAt`, `pingMs`, and `healthProbeId`. New entries start `unchecked`
  with all other fields null/0 (`page.tsx:81-124`).
- **FR-OE-04** — An endpoint is normalized by trimming whitespace and stripping
  all trailing slashes: `endpoint.trim().replace(/\/+$/, '')`
  (`page.tsx:215-217`).
- **FR-OE-05** — API URLs are built with `buildApiUrl(endpoint, path)`: if
  `path` starts with `http://` or `https://` it is used verbatim; otherwise the
  normalized endpoint is prefixed and a leading `/` is ensured
  (`page.tsx:219-224`). This lets job `links` be either absolute or relative.

### Server-options persistence

- **FR-OE-06** — Server options persist under `localStorage` key
  `nurse-scheduling-optimize-server-options` (`page.tsx:108`). The stored shape
  is `{ servers: [{ endpoint }], selectedServerEndpoint }` (`page.tsx:95-102`,
  `132-140`).
- **FR-OE-07** — On load: if the key is absent, JSON is invalid, or
  `parsed.servers` is not an array, fall back to the default candidate entries
  (FR-OE-01/02) with selection `'auto'`. Otherwise dedupe/normalize stored
  servers, and accept the stored selection only if it is `'auto'` or matches an
  existing (deduped) endpoint — else `'auto'` (`page.tsx:163-194`).
- **FR-OE-08** — Dedup/normalization (`dedupeServerEntries`): skip entries whose
  `endpoint` is not a string; normalize each endpoint; skip empties and any
  endpoint already seen (first occurrence wins) (`page.tsx:142-161`).
- **FR-OE-09** — Options are persisted (overwriting the key) on any mutating
  action — select, edit, add, remove, reorder (`page.tsx:196-201`, `567-569`).
  **Reset** removes the key entirely (`page.tsx:203-205`, `1066-1078`).
- **FR-OE-10** — Server options and selection are loaded from storage on mount
  into state and the initial ref (isomorphic layout effect;
  `page.tsx:560-565`). SSR default is the built-in candidates with `'auto'`
  (`page.tsx:163-166`).

### Add / edit / remove / reorder / reset

- **FR-OE-11 (Add)** — Adding an empty (post-normalization) URL silently cancels
  the add. A duplicate URL sets add error `"Backend URL already exists."` and
  does not add. Otherwise the entry is appended, persisted, and immediately
  health-checked (`page.tsx:1026-1046`). The add field placeholder is
  `"https://backend.example.test"` with empty hint `"Double-click to add URL"`
  (`page.tsx:1246-1247`).
- **FR-OE-12 (Edit)** — Editing an endpoint to empty sets that entry's error to
  `"Backend URL is required."`; to a duplicate sets `"Backend URL already
  exists."`; either case invalidates the entry's in-flight probe and resets it
  to `unchecked` without persisting the bad value (`page.tsx:954-996`).
  A valid edit normalizes the endpoint, resets the entry to `unchecked`, updates
  the active selection if it referenced the old endpoint, persists, and starts a
  fresh health check (`page.tsx:998-1024`).
- **FR-OE-13 (Remove)** — Removing an entry drops it from the list; if it was the
  selected server the selection reverts to `'auto'`; its in-flight probe is
  aborted; the result is persisted (`page.tsx:1048-1056`).
- **FR-OE-14 (Reorder)** — Server entries may be reordered; the auto row is not
  a server and is excluded; the new order is persisted (`page.tsx:1058-1064`).
  Reorder is disabled while optimizing or while an endpoint is being edited/added
  (`page.tsx:1353`).
- **FR-OE-15 (Reset)** — Reset aborts all in-flight probes, deletes the stored
  options, restores the default candidate entries, sets selection `'auto'`,
  clears any add-in-progress state, and re-checks every default server
  (`page.tsx:1066-1078`).
- **FR-OE-16** — All server-management controls (select, edit, add, remove,
  per-row check, Check all, Reset, reorder) are disabled while `isOptimizing` is
  true (`page.tsx:1093`, `1102`, `1140`, `1153`, `1210`, `1223`, `1245`, `1353`,
  `1361`).

### Auto selection & resolved endpoint

- **FR-OE-17 (Auto)** — When selection is `'auto'`, the chosen server is the
  first server (by list order / original index) whose `status === 'online'` and
  that has a `health` payload. `selectPreferredServer` sorts online candidates by
  their original index and returns the first (`page.tsx:461-470`,
  `serverSelection.ts:48-50`). The Auto row shows `Uses <endpoint>` when
  resolved, else `"Uses the first online server by priority."`
  (`page.tsx:1126`).
- **FR-OE-18** — `resolvedServer` is the auto-chosen server when selection is
  `'auto'`, else the explicitly selected server. `resolvedOptimizeEndpoint` =
  `lockedOptimizeEndpoint ?? resolvedServer.endpoint ?? serverEntries[0].endpoint
  ?? ''` (`page.tsx:471-474`).
- **FR-OE-19 (Auto status)** — `autoServerStatus` is `online` if an auto server
  resolved; else `checking` if any server is checking; else `offline` if any is
  offline; else `unchecked` (`page.tsx:475-481`).
- **FR-OE-20 (Active status/health)** — `activeServerStatus` is `autoServerStatus`
  under Auto, else the selected server's status (default `unchecked`).
  `activeServerHealth` under Auto is the resolved server's health, else the first
  checking server that already has a health payload, else null; under explicit
  selection it is the selected server's health (`page.tsx:482-487`).

### Health probing

- **FR-OE-21** — A health probe issues `GET <endpoint>/health` with
  `cache: 'no-store'` and an `AbortController` that aborts after **3000 ms**
  (`HEALTH_CHECK_TIMEOUT_MS` and `INITIAL_HEALTH_CHECK_TIMEOUT_MS`, both 3000).
  It also aborts on an external signal (`page.tsx:106-107`, `226-255`).
- **FR-OE-22** — A probe resolves to a health object **only if** the response is
  OK **and** the parsed JSON has `status === 'ok'`; a non-OK response, non-`ok`
  status, or any thrown error resolves to `null` (offline)
  (`page.tsx:243-254`).
- **FR-OE-23** — The expected health payload is
  `{ status, version, apiVersion?, appVersion }` (`serverSelection.ts:20-25`).
- **FR-OE-24** — Starting a probe sets the entry to `checking` and clears its
  error; on completion it sets `status` to `online`/`offline`, stores `health`,
  sets `error` to `null` (online) or `"Backend is not responding."` (offline),
  records `lastCheckedAt = new Date()`, and records `pingMs = round(now - start)`
  (`page.tsx:571-623`).
- **FR-OE-25** — Probe results are applied only if still current: same page mount
  id, same normalized endpoint, and same `healthProbeId` — otherwise the update
  is ignored (stale-guard) (`page.tsx:600-607`). Each new probe supersedes any
  in-flight probe for the same endpoint (its controller is aborted)
  (`page.tsx:582-584`).
- **FR-OE-26** — On page mount, every initial server is health-checked; on
  unmount all in-flight probe controllers are aborted (`page.tsx:631-646`).
  `Check all` re-checks every server (`page.tsx:625-629`, `1092`); a per-row
  check button re-checks a single server (`page.tsx:1204-1216`).
- **FR-OE-27** — While any server is `checking`, an indicator text
  `"Checking API endpoints..."` is shown (`page.tsx:1378-1380`).

### Version display & mismatch note (KEEP — functional)

- **FR-OE-28** — When an active health payload exists, the version summary is
  shown as: `API version: <apiVersion ?? version> · Frontend version:
  <CURRENT_APP_VERSION> · Backend version: <appVersion>` (`page.tsx:1386-1388`).
  `CURRENT_APP_VERSION` comes from `NEXT_PUBLIC_APP_VERSION` (default `'unknown'`).
- **FR-OE-29** — An app-version mismatch is flagged when the frontend and backend
  `appVersion` strings differ, **or** either version is "dirty" (ends with
  `-dirty`) (`page.tsx:207-213`; `hasVersionMismatch` at `page.tsx:488`). On
  mismatch, this non-blocking note is displayed and MUST be kept:
  `"Frontend and backend versions do not match. If nothing breaks, you can
  continue."` (`page.tsx:1389-1393`). It does not disable optimization.

### Preconditions & disable rules

- **FR-OE-30** — Missing-data flags: dates are missing when there is no start
  date, no end date, or zero date items; people are missing when there are zero
  people items; shift types are missing when there are zero shift-type items
  **and** zero shift-type groups. `isRequiredDataMissing` is the OR of these
  three (`page.tsx:489-492`).
- **FR-OE-31** — A contextual banner is shown when required data is missing, with
  priority dates → people → shift types (only the highest-priority missing one
  shows). Exact text (verbatim, with tab link):
  - Dates: `"Please set up your dates first by visiting the Dates tab."`
    (link to `/dates`).
  - People: `"Please set up your people first by visiting the People tab."`
    (link to `/people`).
  - Shift Types: `"Please set up your shift types first by visiting the Shift
    Types tab."` (link to `/shift-types`).
  (`page.tsx:1309-1339`.)
- **FR-OE-32** — The optimize action is disabled when `isOptimizing`, **or**
  required data is missing, **or** `activeServerStatus !== 'online'`
  (`page.tsx:500`). The contextual disabled reason is
  `"Complete the missing schedule configuration before optimizing."` when data
  is missing, else `"Backend unavailable. Check or select an online backend."`
  when the backend is not online, else none (`page.tsx:501-505`, `1496-1498`).
- **FR-OE-33** — The active-server status indicator shows `Server: <label>` where
  label ∈ {`Checking`, `Online`, `Offline`, `Unchecked`} plus the
  `resolvedOptimizeEndpoint` (or `"No backend"` when empty)
  (`page.tsx:400-411`, `1298-1305`). When the active server is offline, an
  advisory is shown: `"Backend is not responding at the configured endpoint."`
  (`page.tsx:1397-1403`).

### Run options

- **FR-OE-34 (Prettify)** — `Prettify XLSX` boolean, **default true**. Label
  `"Prettify XLSX"`, help `"Apply formatting to the generated workbook."`
  (`page.tsx:435`, `1414-1426`).
- **FR-OE-35 (Anonymize)** — `Anonymize schedule data` boolean, **default true**.
  Label `"Anonymize schedule data"`, help `"Anonymize people IDs and remove
  descriptions before sending to the backend."` (`page.tsx:436`, `1428-1439`).
- **FR-OE-36 (Timeout)** — `Solver Timeout` integer, **default 300**, unit label
  `"sec"`, input min `1`, max `3600`, placeholder `"300"` (`page.tsx:437`,
  `1441-1462`). The input accepts empty and coerces integer strings to numbers
  (`page.tsx:1448-1452`).
- **FR-OE-37** — Timeout validation: the run is rejected when the value is
  empty, not a number, not an integer, or `< 1`, with message
  `"Solver timeout must be a valid positive integer."` (`page.tsx:789-793`;
  message also cleared on edit).

### Job submission

- **FR-OE-38 (Guard order)** — On optimize: (1) if required data is missing,
  reset all run/result state and return (no request) (`page.tsx:775-787`);
  (2) else validate timeout (FR-OE-37); (3) else if the active server is not
  online or the resolved endpoint is empty, set error `"Select an online backend
  before optimizing."` and return (`page.tsx:795-799`).
- **FR-OE-39 (Lock)** — On a valid run, the resolved endpoint is captured as
  `runEndpoint` and set as `lockedOptimizeEndpoint`, so all subsequent requests
  for that run (status/events/xlsx/heartbeat/control/delete) target the same
  endpoint even if selection/health changes mid-run. The lock is cleared in the
  `finally` block (`page.tsx:801-802`, `905`).
- **FR-OE-40 (State reset)** — Starting a run clears: timeout error, error/success
  messages, score, status, job id, job, incumbent, progress points, saved
  download (revoking its object URL), and the SSE event log; and sets
  `isOptimizing = true` (`page.tsx:803-814`). This is the "repeat run resets
  state" behavior.
- **FR-OE-41 (Anonymize path)** — When Anonymize is on, the filtered export state
  is anonymized via `anonymizeSchedulingStateWithMapping(state, {
  anonymizePeopleItems: true, anonymizePeopleGroups: false, removeDescriptions:
  true })`, producing the transformed state plus a reverse map
  `originalIdByAnonymizedId`. When off, the raw filtered state is used and no map
  is produced (`page.tsx:816-823`).
- **FR-OE-42 (Anonymization semantics)** — People item IDs are remapped to
  `P1, P2, …` (skipping any collisions with retained IDs); group IDs are left
  intact (groups not anonymized here). Every reference to a person ID is remapped
  consistently across people/groups members, all preference types
  (requirement `qualifiedPeople`; request/successions/count `person`; affinity
  `people1`/`people2` reference trees; **shift type covering
  `preceptors` / `preceptees`** — `anonymizeSchedulingState.ts:76-82`),
  and export `formatting[].people` / `extraRows[].countPeople`. **Note
  on covering `shiftTypes`**: the current implementation also passes
  `shiftTypes` through the same people-anonymization map (via
  `mapReferenceIdTree`), so a shift-type id that collides with an
  anonymized people/group id would be rewritten. In practice shift-type
  ids do not collide with people/group ids (the namespaces are
  separate), so this is normally a no-op. With `removeDescriptions`, every
  `description` field is recursively removed from the payload
  (`anonymizeSchedulingState.ts:43-149`).
- **FR-OE-43 (Multipart body)** — The request body is `FormData` with:
  `yaml_content` = YAML generated from the (anonymized or raw) state
  **with `export: effectiveExportData` always set** (see FR-OE-43a);
  `prettify` = `String(prettifyArg)` (appended only when not null/undefined);
  `timeout` = `String(timeoutArg)` (`page.tsx:825-833`).
  The current backend signature declares only these fields and **no
  `solver` field** (see Contract C2 CON-API-03). The frontend does not
  send or read a solver selection.

- **FR-OE-43a (Optimize payload always includes `export`).** The optimize
  payload builder assembles `filteredState` with
  `export: effectiveExportData` unconditionally
  (`page.tsx:507-516`), where
  `effectiveExportData = state.export ?? generateExportLayoutConfig(...)`
  (`useSchedulingData.ts:975-976`). This is asymmetric with the
  Save/Load download (which includes `export` only when `state.export`
  is truthy — see spec 08 FR-SL-01/02): the optimize payload therefore
  always carries a frontend-generated default export layout even when
  the user has not authored one. A rebuilder that mirrors spec 08's
  `...(exportData ? { export: exportData } : {})` for optimize will
  lose the default layout and change the backend's prettified xlsx
  output.
- **FR-OE-44 (Create request)** — `POST <normalized runEndpoint>/optimize` with
  the multipart body. A non-OK response throws
  `Server error (<status>): <detail>` (`page.tsx:835-842`). The created job's
  `jobId`, full job object, and `status` are stored (`page.tsx:844-847`).
- **FR-OE-45 (Error detail)** — `<detail>` is extracted from the response body:
  if the body is JSON with a string `detail`, use it; if `detail` is present but
  non-string, use its JSON stringification; otherwise use the raw response text
  (`page.tsx:275-289`).

### Progress reporting: SSE + polling fallback

- **FR-OE-46 (Terminal statuses)** — The terminal job statuses are exactly
  `optimal`, `feasible`, `infeasible`, `cancelled`, `failed`
  (`page.tsx:104`). `waitForOptimizeJob` resolves immediately if the created job
  is already terminal (`page.tsx:705-708`).
- **FR-OE-47 (SSE)** — When `EventSource` is available, an `EventSource` is opened
  at `buildApiUrl(runEndpoint, job.links.events)` and listens for named events
  `status`, `progress`, `phase`, `complete`, `error` (`page.tsx:710-767`). Each
  event's `data` is JSON-parsed when possible, else kept as the raw string
  (`page.tsx:302-312`).
- **FR-OE-48 (status event)** — Appends a log entry; if the payload carries a
  `status`, updates the run status; merges the payload into the current job
  (`page.tsx:714-722`).
- **FR-OE-49 (progress event)** — Appends a log entry; a payload is a progress
  event when it is an object containing `currentBestScore`. It updates the
  incumbent result; when `currentBestScore` is a number it updates the displayed
  score; when both `currentBestScore` and `elapsedSeconds` are numbers it appends
  a chart point `{ currentBestScore, elapsedSeconds, commentCount, solutionIndex,
  source }` (`page.tsx:321-323`, `724-742`).
- **FR-OE-50 (phase event)** — Appends a log entry (`page.tsx:744-747`).
- **FR-OE-51 (complete event)** — Closes the stream, appends a log entry, sets the
  current job to the completed payload, and resolves the wait
  (`page.tsx:749-756`).
- **FR-OE-52 (error event)** — If the error event has a non-empty string `data`,
  the stream is closed, the entry logged, and the wait is rejected with
  `parsedData.error ?? "Optimization failed"`. Otherwise (transport
  disconnect) it only logs `"Optimization event stream disconnected; waiting to
  reconnect"` and lets `EventSource` reconnect (no close, no reject)
  (`page.tsx:758-767`).
- **FR-OE-53 (Polling fallback)** — When `EventSource` is undefined, the job is
  polled: `GET buildApiUrl(runEndpoint, job.links.status)` with `cache:
  'no-store'` every **1000 ms** until a terminal status; each poll updates the
  current job and status; a non-OK poll throws `Server error (<status>):
  <detail>`; the loop resolves on terminal status and rejects on error
  (`page.tsx:669-703`, `769-771`).
- **FR-OE-54 (Completion handling)** — After the wait resolves, the current job
  and status are updated; if `score !== null` the score is set; if `solverStatus`
  is present the displayed status is set to it. If the job has an `error`, it is
  thrown. If `xlsxReady` is false, throw `No downloadable schedule is available.
  Job status: <status>` (`page.tsx:849-865`).

### Client heartbeat

- **FR-OE-55** — While a job is active (`isJobActive`), the frontend sends a
  heartbeat every **10000 ms** (`OPTIMIZE_CLIENT_HEARTBEAT_INTERVAL_MS`):
  `POST buildApiUrl(runEndpoint, currentJob.links.heartbeat ??
  '/optimize/<jobId>/heartbeat')` with `cache: 'no-store'`; errors are swallowed
  (the backend watchdog decides whether missed heartbeats cancel the job). The
  interval is cleared when the job is no longer active (`page.tsx:105`,
  `648-667`).
- **FR-OE-56 (Job-active definition)** — `isJobActive` is true when a job id
  exists, `isOptimizing` is true, a status exists, and that status
  (lower-cased) is not terminal (`page.tsx:493-498`).

### Cancel & finish-now

- **FR-OE-57** — Cancel and finish-now issue
  `POST buildApiUrl(runEndpoint, '/optimize/<jobId>/<action>')` where `<action>`
  is `cancel` or `finish-now`; a non-OK response throws `Server error
  (<status>): <detail>`; the returned job updates the current job and status
  (`page.tsx:909-925`). On failure the error message is the thrown message, or
  the fallback `"Unable to cancel optimization"` (cancel) /
  `"Unable to request current results"` (finish-now) (`page.tsx:926-932`).
- **FR-OE-58 (Control button rules)** — The cancel/finish-now controls appear only
  while a job is active. `isCancelling` is true when the status is `cancelling`.
  The finish-now control (`"Get Results Now"`) is disabled when
  `currentJob.finishNowRequested` is truthy or `isCancelling`. The cancel control
  is disabled when `isCancelling` and its label switches to `"Cancelling..."`
  from `"Cancel"` (`page.tsx:499`, `1580-1602`).

### Progress chart

- **FR-OE-59 (Render condition)** — The chart renders only when there are **≥ 2**
  progress points; it receives `isActive = isJobActive` (`page.tsx:1562-1564`).
- **FR-OE-60 (Series)** — A **Score** line (`currentBestScore`, `stepAfter`,
  color `#2563eb`) is always shown; a **Comments** line (`commentCount`,
  `stepAfter`, color `#d97706`, `connectNulls`) is shown/hidden by a toggle
  labeled `"Hide comments"` / `"Show comments"`, **default shown**
  (`OptimizationProgressChart.tsx:177`, `223-228`, `280-371`). Header text:
  `"Incumbent Progress"` and `"Higher scores are better. Hover to inspect a
  solution."` (`OptimizationProgressChart.tsx:216-219`).
- **FR-OE-61 (Live-extrapolated x-axis)** — The X axis is elapsed seconds. When
  `isActive`, a 250 ms interval extrapolates a live elapsed value =
  `latestElapsedSeconds + (now - start)/1000`; the domain max is
  `max(liveElapsed, latestElapsed, 1)`. The domain min is `0` for the Full range,
  else the first visible point's elapsed, clamped so the span is at least
  `max(domainMax * 0.01, 0.1)` (`OptimizationProgressChart.tsx:174-206`).
- **FR-OE-62 (Range presets)** — Range presets: `Full`, `Last 1 min` (last 60 s),
  `Last 10 min` (last 600 s), `Last 10` (last 10 points), `Last 50` (last 50
  points); default `Full`. Time-window presets start at the first point whose
  elapsed ≥ `latestElapsed − window`; point-count presets start at
  `max(length − count, 0)` (`OptimizationProgressChart.tsx:63-120`, `374-391`).
- **FR-OE-63 (Dot rendering)** — Point dots are drawn only when the visible point
  count is ≤ **30** (`DOT_LIMIT`); above that, dots are hidden and the note
  `"Points hidden · hover to inspect"` is shown. A `ReferenceDot` always marks
  the latest score, and the latest comments point when its `commentCount` is a
  number (`OptimizationProgressChart.tsx:60`, `209`, `239`, `290-300`,
  `357-367`).
- **FR-OE-64 (Tooltip)** — Hover tooltip shows elapsed (`… elapsed`), Score,
  Comments (`N/A` when not numeric), Solution (`#<index>` or `N/A`), and Source
  when present (`OptimizationProgressChart.tsx:122-167`).

### Live result & downloads

- **FR-OE-65 (Score panel)** — The score label is `"Live Incumbent Score"` while
  optimizing, `"Final Score"` when a score exists after finishing, else
  `"Score"`; the value is the formatted score or `"No incumbent yet"`, with
  caption `"Higher scores are better."` Scores are formatted with
  `Intl.NumberFormat` at ≤ 2 fraction digits (`page.tsx:329-333`, `1522-1528`).
- **FR-OE-66 (Run status text)** — Run status = `formatRunStatus(status,
  queuePosition)` when a status exists (→ `Idle` when null; `Queued, position
  <n>` when status is `queued` with a queue position; else the raw status),
  else `"Starting"` while optimizing, else `"Idle"` (`page.tsx:344-352`,
  `1265-1269`).
- **FR-OE-67 (Status detail lines)** — Below the score: no job → `"No optimization
  has been started."`; optimizing & `queued` → `"Waiting in optimization queue at
  position <n>."` or `"Waiting in optimization queue."`; optimizing without an
  incumbent → `"Waiting for first feasible solution..."`; with an incumbent →
  `"<Solution #<idx>|Incumbent> · <elapsed|time unavailable> · <n comments|comments
  unavailable>[ · <source>]"`; else `"Job <jobId>"`. When a job id exists,
  `"Job ID: <jobId>"` is also shown (`page.tsx:1536-1559`).
- **FR-OE-68 (XLSX fetch)** — On success, `GET buildApiUrl(runEndpoint,
  completedJob.links.xlsx)`; a non-OK response throws `Server error (<status>):
  <detail>` (`page.tsx:867-873`).
- **FR-OE-69 (ID restoration)** — When the run was anonymized, the downloaded XLSX
  is post-processed by `restorePeopleIdsInXlsx(blob, originalIdByAnonymizedId,
  peopleCount)` before download; when not anonymized the raw blob is used
  (`page.tsx:876-883`). Restoration reads the first worksheet, iterates rows
  `3 … 3 + peopleCount − 1`, column 1, and where a cell holds a string that maps
  back to an original ID, replaces it; the workbook is re-serialized with MIME
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  (`restorePeopleIdsInXlsx.ts:25-49`).
- **FR-OE-70 (Filename)** — The download filename is parsed from the
  `Content-Disposition` header via `filename="?([^"]+)"?`; the default when the
  header is absent or unmatched is `"output.xlsx"` (`page.tsx:257-264`, `886`).
- **FR-OE-71 (Auto-download & save)** — The blob is turned into an object URL,
  saved (URL + filename) so it can be re-downloaded, and a synthetic anchor click
  triggers an immediate download (`page.tsx:266-273`, `885-889`).
- **FR-OE-72 (Cleanup)** — After download the job is deleted fire-and-forget:
  `DELETE buildApiUrl(runEndpoint, '/optimize/<jobId>')` (`page.tsx:891-893`).
- **FR-OE-73 (Success/finally)** — On success the message
  `"Schedule optimized and downloaded successfully!"` is shown
  (`page.tsx:895`). The `finally` block always sets `isOptimizing = false` and
  clears `lockedOptimizeEndpoint` (`page.tsx:903-906`).
- **FR-OE-74 (Error message)** — Any thrown error during the run sets the error
  message to `error.message`, or `"An unexpected error occurred during
  optimization"` for non-Error throws (`page.tsx:896-902`).
- **FR-OE-75 (Download Again)** — When a saved download exists, a `"Download
  Again"` control re-triggers the download of the saved object URL with the saved
  filename (`page.tsx:935-940`, `1568-1577`). The saved object URL is revoked on
  a new run and on unmount (`page.tsx:518-548`).

### Event log

- **FR-OE-76** — Every SSE/log entry stores `{ type, data, receivedAt }` and is
  appended to the event log; the log shows a count `"<n> events"` and per-type
  color badges (`complete` green, `error` red, `progress` blue, `phase` amber,
  otherwise gray) (`page.tsx:371-385`, `526-539`, `1632-1645`).
- **FR-OE-77 (Auto-scroll)** — Before each append, the log records whether it is
  scrolled to (within 4 px of) the bottom; after the append, it auto-scrolls to
  the bottom only if it was at/near the bottom, so manual scroll-up is preserved
  (`page.tsx:526-539`, `550-558`).
- **FR-OE-78 (Empty & summary)** — Empty log shows `"Waiting for optimization
  events..."` while optimizing, else `"No optimization events yet."`. Progress
  entries render a summary line joined by `" · "`
  (`Score: <formatted|N/A>`, optional `Comments: <n>`, optional
  `Elapsed: <n>s`, optional `Solution: #<idx>`, optional `Source: <src>`); phase
  entries render their `message`; every entry exposes `"Raw event data"`
  (`page.tsx:314-368`, `1635-1658`).

## Validation Rules & Messages

| Rule / trigger | Condition | Message (verbatim) | Source |
|---|---|---|---|
| Dates missing | no start/end date or 0 date items | `Please set up your dates first by visiting the Dates tab.` (link `/dates`) | `page.tsx:1312-1319` |
| People missing | 0 people items | `Please set up your people first by visiting the People tab.` (link `/people`) | `page.tsx:1320-1327` |
| Shift types missing | 0 items and 0 groups | `Please set up your shift types first by visiting the Shift Types tab.` (link `/shift-types`) | `page.tsx:1328-1336` |
| Optimize disabled — data | required data missing | `Complete the missing schedule configuration before optimizing.` | `page.tsx:501-502` |
| Optimize disabled — backend | active server not online | `Backend unavailable. Check or select an online backend.` | `page.tsx:503-504` |
| Timeout invalid | empty / non-number / non-integer / `< 1` | `Solver timeout must be a valid positive integer.` | `page.tsx:789-790` |
| Backend not online at submit | active status ≠ online or empty endpoint | `Select an online backend before optimizing.` | `page.tsx:796` |
| Add backend empty | normalized URL empty | (silently cancels add — no message) | `page.tsx:1027-1032` |
| Add backend duplicate | endpoint already exists | `Backend URL already exists.` | `page.tsx:1034` |
| Edit backend empty | normalized URL empty | `Backend URL is required.` | `page.tsx:971` |
| Edit backend duplicate | endpoint already exists | `Backend URL already exists.` | `page.tsx:988` |
| Health probe offline | non-OK / not `status:'ok'` / error | entry error `Backend is not responding.` | `page.tsx:613` |
| Active backend offline advisory | active status = offline | `Backend is not responding at the configured endpoint.` | `page.tsx:1401` |
| Checking indicator | any server checking | `Checking API endpoints...` | `page.tsx:1379` |
| Version mismatch (KEEP) | frontend ≠ backend or either dirty | `Frontend and backend versions do not match. If nothing breaks, you can continue.` | `page.tsx:1391` |
| Create/status/xlsx/control non-OK | HTTP not OK | `Server error (<status>): <detail>` | `page.tsx:841,872,920,676` |
| No downloadable result | `xlsxReady` false | `No downloadable schedule is available. Job status: <status>` | `page.tsx:864` |
| SSE fatal error | error event has string data | `<payload.error>` or `Optimization failed` | `page.tsx:763` |
| SSE transport disconnect | error event without data | log `Optimization event stream disconnected; waiting to reconnect` | `page.tsx:765` |
| Cancel failure fallback | non-Error throw on cancel | `Unable to cancel optimization` | `page.tsx:930` |
| Finish-now failure fallback | non-Error throw on finish-now | `Unable to request current results` | `page.tsx:930` |
| Generic run failure | non-Error throw during run | `An unexpected error occurred during optimization` | `page.tsx:901` |
| Success | download completed | `Schedule optimized and downloaded successfully!` | `page.tsx:895` |

## Edge Cases & Quirks

- **Locked endpoint survives selection change** — Once a run starts, all its
  requests target the captured `runEndpoint`; changing the selected/auto server
  or its health mid-run does not redirect the in-flight run (`page.tsx:801`,
  `474`).
- **Auto uses list order, not ping** — Auto picks the first online server by list
  position (index), independent of `pingMs` (`serverSelection.ts:48-50`).
  [incidental quirk]
- **Active health under Auto can borrow a checking server's stale health** —
  When no server has resolved yet, `activeServerHealth` may fall back to the
  first *checking* server that still carries a prior health payload
  (`page.tsx:485-487`). [incidental quirk]
- **`selectOfflineFallbackBackendApiUrl` is exported but unused** on this page;
  offline resolution instead falls through to `serverEntries[0]` via
  `resolvedOptimizeEndpoint` (`serverSelection.ts:42-46`, `page.tsx:474`).
- **Dirty version always flags mismatch** — Even when frontend and backend
  versions are identical, a `-dirty` suffix on either forces the mismatch note
  (`page.tsx:207-213`).
- **`prettify` omitted only if null/undefined** — Since it is always a boolean in
  state, `prettify` is effectively always sent as `"true"`/`"false"`
  (`page.tsx:829-831`). [incidental quirk]
- **Required-data click resets instead of erroring** — Clicking optimize while
  data is missing clears all result state and returns without a message; the
  banner/disabled reason already explains why (`page.tsx:775-787`).
- **SSE transport errors auto-reconnect** — A data-less error event does not fail
  the run; only an error event carrying string `data` rejects it
  (`page.tsx:758-767`).
- **`solverStatus` overrides displayed status** — After completion the displayed
  status is replaced by `completedJob.solverStatus` when present, which may
  differ from the terminal job `status` (`page.tsx:856-858`).
- **Restore touches only the schedule sheet's people column** — Only worksheet 0,
  rows `3 … 3+peopleCount−1`, column 1, string cells that map back are rewritten;
  other cells and unmapped values are left as-is (`restorePeopleIdsInXlsx.ts:34-44`).
- **Anonymization ID collisions are skipped** — `P#`/`G#` indices advance past any
  ID already retained/used, so anonymized IDs never collide with retained ones
  (`anonymizeSchedulingState.ts:43-59`).
- **Chart minimum visible span** — With near-zero elapsed the X domain is widened
  to at least `max(domainMax*0.01, 0.1)` so the line is not degenerate
  (`OptimizationProgressChart.tsx:202-206`).
- **Chart hidden below 2 points** — A single progress point never renders the
  chart (`page.tsx:1562`).
- **Stale probe guard** — Results from superseded probes (older mount id or
  probe id, or renamed endpoint) are discarded; renaming/clearing an endpoint
  bumps the probe id to invalidate in-flight results (`page.tsx:600-607`,
  `955-960`).

## Acceptance Criteria

- **AC-OE-01** — Given `NODE_ENV` is not `test` and the hosted-API disable flag
  is unset, when the page loads with no stored options, then the backend
  candidate list is exactly `http://localhost:8000` then
  `https://api.nursescheduling.org`, selection is Auto.
- **AC-OE-02** — Given `NODE_ENV === 'test'` or
  `NEXT_PUBLIC_DISABLE_HOSTED_OPTIMIZE_API === '1'`, when the page loads, then the
  production candidate is absent and only `http://localhost:8000` is offered.
- **AC-OE-03** — Given stored options exist, when the page loads, then servers
  are restored after normalization/dedup, and the stored selection is applied
  only if it is Auto or matches a remaining endpoint (else Auto).
- **AC-OE-04** — Given a stored payload that is missing/corrupt or whose
  `servers` is not an array, when the page loads, then the default candidates and
  Auto selection are used.
- **AC-OE-05** — When a server is added, edited, removed, reordered, or selected,
  then the persisted options reflect the change; when Reset is invoked, then the
  stored key is removed and defaults with Auto are restored and re-checked.
- **AC-OE-06** — Given an endpoint with surrounding whitespace or trailing
  slashes, when it is added/edited, then it is stored normalized (trimmed,
  trailing slashes removed).
- **AC-OE-07** — When adding/editing to a URL that duplicates an existing
  (normalized) endpoint, then the change is rejected with `Backend URL already
  exists.`; editing to empty yields `Backend URL is required.`; adding empty
  silently cancels.
- **AC-OE-08** — When a health check runs, then it issues `GET <endpoint>/health`
  with no-store caching, aborts after 3000 ms, and marks the server online only
  when the response is OK with a JSON body whose `status` is `ok`; otherwise
  offline with error `Backend is not responding.`.
- **AC-OE-09** — Given selection is Auto and multiple servers are online, when
  resolving the active server, then the first online server by list order is
  used and the resolved endpoint reflects it.
- **AC-OE-10** — Given an active health payload, when displayed, then the version
  line shows `apiVersion` (falling back to `version`), the frontend version, and
  the backend `appVersion`; when the frontend/backend versions differ or either
  is dirty, then the mismatch note is shown and optimization remains allowed.
- **AC-OE-11** — When required schedule data (dates, people, or shift types) is
  missing, then optimize is disabled, the priority-ordered contextual banner is
  shown, and the disabled reason is `Complete the missing schedule configuration
  before optimizing.`.
- **AC-OE-12** — When the active server is not online, then optimize is disabled
  with reason `Backend unavailable. Check or select an online backend.`.
- **AC-OE-13** — Given the run options, when the page loads, then Prettify XLSX is
  on, Anonymize schedule data is on, and Solver Timeout is 300 (min 1, max 3600).
- **AC-OE-14** — When submitting with a timeout that is empty, non-integer, or
  `< 1`, then no request is made and the message is `Solver timeout must be a
  valid positive integer.`.
- **AC-OE-15** — When a valid run is submitted, then a multipart `POST /optimize`
  is sent to the resolved endpoint containing `yaml_content`, `prettify`, and
  `timeout`, and that endpoint is locked for the remainder of the run.
- **AC-OE-16** — Given Anonymize is on, when submitting, then people item IDs are
  remapped to `P#`, descriptions are stripped, all person references are remapped
  consistently, and a reverse map is retained for result restoration; given
  Anonymize is off, the raw filtered state is sent and no restoration occurs.
- **AC-OE-17** — Given `EventSource` is supported, when a job runs, then progress
  is consumed from SSE `status`/`progress`/`phase`/`complete`/`error` events, the
  incumbent score updates on numeric `currentBestScore`, and a chart point is
  recorded whenever both `currentBestScore` and `elapsedSeconds` are numeric.
- **AC-OE-18** — Given `EventSource` is unavailable, when a job runs, then the job
  status is polled every 1000 ms until a terminal status.
- **AC-OE-19** — Given a job is active, when 10 s elapse, then a heartbeat POST is
  sent to the job's heartbeat link (or `/optimize/<jobId>/heartbeat`), and errors
  are ignored.
- **AC-OE-20** — Given a job is active, when finish-now is requested, then
  `POST /optimize/<jobId>/finish-now` is sent and the button is disabled once
  `finishNowRequested` is set or while cancelling; when cancel is requested,
  `POST /optimize/<jobId>/cancel` is sent and the control shows `Cancelling...`
  while the status is `cancelling`.
- **AC-OE-21** — When a job reaches a terminal status of `optimal`, `feasible`,
  `infeasible`, `cancelled`, or `failed`, then the wait completes; a job `error`
  surfaces as the error message, and `xlsxReady === false` yields `No downloadable
  schedule is available. Job status: <status>`.
- **AC-OE-22** — When the result is fetched, then the filename comes from
  `Content-Disposition` (default `output.xlsx`), the file auto-downloads, the job
  is deleted via `DELETE /optimize/<jobId>`, and the success message is `Schedule
  optimized and downloaded successfully!`.
- **AC-OE-23** — Given the run was anonymized, when the XLSX is received, then
  people IDs in the first worksheet (rows 3…3+peopleCount−1, column 1) are
  restored to their original values before download.
- **AC-OE-24** — After a completed run, when Download Again is invoked, then the
  previously saved file re-downloads with the same filename without a new job.
- **AC-OE-25** — When a new run starts, then prior error/success, score, status,
  job, incumbent, progress points, saved download, and event log are all cleared
  before submission.
- **AC-OE-26** — Given ≥ 2 progress points, when the chart renders, then it shows
  a step-after score line, a toggleable comments line (shown by default), an
  elapsed x-axis that live-extrapolates while the job is active, range presets
  (Full / Last 1 min / Last 10 min / Last 10 / Last 50), and hides point dots
  above 30 visible points with the note `Points hidden · hover to inspect`.
- **AC-OE-27** — When events arrive, then each is appended to the event log with a
  type badge and timestamp, the count updates, and the log auto-scrolls to the
  bottom only when already at/near the bottom.

## Cross-References

- **Contract C2 — HTTP Serve API** (`../contracts/index.md`, prefix CON-API):
  authoritative source for `GET /health` (health payload shape), `POST /optimize`
  (multipart `yaml_content`/`prettify`/`timeout` — **no `solver` field**;
  see C2 CON-API-03), the job-response object shape
  (`jobId`/`status`/`queuePosition`/`inputName`/`prettify`/`timeout`/`score`/
  `solverStatus`/`error`/`cancelRequested`/`finishNowRequested`/
  `clientHeartbeatExpired`/`xlsxReady`/`links` — **no `solver` key**; see
  C2 Job-Response Object), the SSE event stream
  (`status`/`progress`/`phase`/`complete`/`error`), job status polling
  (`links.status`), heartbeat (`links.heartbeat`), cancel / finish-now
  (no "unsupported-solver" 409 — only the current single backend
  exists), `DELETE /optimize/<jobId>`, xlsx retrieval (`links.xlsx`,
  including `Content-Disposition`), status codes, queue semantics, and
  terminal statuses. This domain must conform to C2 exactly.
- **Contract C1 — YAML Scenario Schema** and **08 — Save/Load & YAML**: the
  `yaml_content` body is produced by the shared YAML generator over the filtered
  (and optionally anonymized) scheduling state.
- **05 — Card Preference Editors** and **09 — Export Layout**: anonymization
  remaps person references across all preference types and export
  `formatting`/`extraRows` (`anonymizeSchedulingState.ts:61-141`).
- **Contract C5 — Exporter Output**: defines the XLSX structure that
  `restorePeopleIdsInXlsx` post-processes (schedule sheet, people column layout).
- **07 — State, History & Persistence**: server options use the `localStorage`
  key `nurse-scheduling-optimize-server-options`, independent of the main
  scheduling store.
