# T19 — Upstream backend source manifest and rebuild adaptations

Execution note for ticket **T19 — Upstream modular backend, Redis JobStore and
Workspace gate**. Records the source mapping, the intentional rebuild
adaptations, dependency pins, and the net-new modules so every checked-in file
either maps to the pinned upstream revision or has a documented adaptation.

- **Upstream source:** `/home/kenan/work/nurse-scheduling`
- **Pinned revision:** `0420ccdc0cb3f9aa29db85d288bd36a0d4f37046` (T19 baseline);
  refreshed to `5027e2f5fd7d16b7006ed1ab572b905fa6845ea1` for the public-diagnostics
  refresh — see [U30a refresh](#u30a--upstream-5027e2f-public-diagnostics-refresh).
- **Governing plan:** rebuild-tech-plan → `upstream-redis-workspace-protocol-technical-plan`;
  refresh governed by `upstream-public-diagnostics-refresh-2026-07-19`.

## Ported files (upstream → rebuild)

All paths below are relative to `core/nurse_scheduling/`. Files were vendored from
the pinned revision's `server/` package and then owned in this repository.

| File | Origin | Adaptation from upstream |
| --- | --- | --- |
| `serve.py` | `server`-based entry | Replaced the legacy monolithic `serve.py`; now the thin `create_app()` ASGI entry. |
| `server/__init__.py`, `server/api/__init__.py`, `server/jobs/__init__.py`, `server/stores/__init__.py` | verbatim | none |
| `server/config.py` | verbatim | none (defaults already match plan §2: retained 128, retention 24h, events 1000, lease 90s). |
| `server/errors.py` | verbatim | none |
| `server/maintenance.py` | adapted | Added last-success/liveness tracking (injectable monotonic clock) and `is_alive()`/`is_healthy()` so readiness can fail closed when the maintenance loop stalls. |
| `server/job_store.py` | protocol | Added `prepare_event_replay` and the worker-owner/observed-deadline commit precondition to `JobStore.save`. |
| `server/jobs/models.py` | verbatim + | Narrowed `STOPPABLE_SOLVERS` to `{ortools/cp-sat}`; added `EventReplayWindow`. |
| `server/jobs/controller.py` | adapted | Added `prepare_event_replay` delegating to the store; **mandatory worker identity** and observed-deadline precondition on every worker write, enforced atomically by the store; maintenance-driven `worker_lost` uses its own dedicated transition. |
| `server/jobs/worker.py` | adapted | Passes its `worker_id` to every progress/result/failure write; stops local execution once the last confirmed lease deadline passes during a renewal outage. |
| `server/jobs/runner.py` | adapted | Calls the rebuild's CP-SAT-only `scheduler.schedule` (positional tuple return, **no** `solver` argument); `job.request.solver` is the constant diagnostic value. |
| `server/app.py` | adapted | `get_app_version()` now reads `APP_VERSION` → `/app/VERSION` → `v0.0.0-unknown` (no `git describe`); registered the `SchedulingContentError` → 422 handler. |
| `server/api/schemas.py` | verbatim | none (`JobResponse` shape preserved). |
| `server/api/sse.py` | verbatim | none (emits public cursor `id:` supplied by the route). |
| `server/api/optimize.py` | adapted | CP-SAT-only solver boundary; pre-job canonical Workspace/legacy conversion; `prepare_event_replay` + public-cursor SSE with `409 event_cursor_expired` / `400 invalid_event_cursor`. |
| `server/stores/memory.py` | verbatim + | Added `prepare_event_replay` (snapshot under the store lock; rejects non-canonical integer cursor aliases) and one-lock worker lease commit validation using the commit-time clock. |
| `server/stores/redis.py` | verbatim + | Added `prepare_event_replay` as a **single `WATCH`/`MULTI`/`EXEC` snapshot** of the job key and its event stream; production worker writes use a Redis `TIME` Lua commit fence bound to the expiring lease key, owner, revision, and observed deadline. Fakeredis uses an explicit isolated test-only transaction path because it lacks Lua. |

Deleted: the legacy process-local `nurse_scheduling/jobs.py` and its
legacy-API test `tests/test_serve.py` (superseded by the new server and the
`test_server_*.py` suites), per T19 "delete the legacy process-local job
implementation after API parity is reached."

## Net-new rebuild modules (no direct upstream file)

| File | Purpose |
| --- | --- |
| `server/canonical.py` | Canonical strict YAML dumper: `model_dump(mode="json", exclude_none=True)`, `appVersion` last, pinned ruamel YAML 1.2 block style, LF, single trailing newline, `.inf` weights. |
| `server/scheduling_errors.py` | Normative scheduling-content 422 envelope, issue codes, deterministic ordering, Pydantic-error translation. |
| `server/workspace.py` | `WorkspaceSchedulingDataV1` schema, strict per-preference authoring models (`StrictBool` `enabled`) and a strict `WorkspaceGuidedRule`, empty-collection and people/shift-type/date reference integrity, source-index-preserving per-preference validation, filtering/stripping, and conversion to the strict model. |
| `server/scheduling_input.py` | Parse-once submission boundary: version dispatch, solver check, canonicalization; `MalformedInputError` → 400. |
| `server/event_cursor.py` | Opaque, versioned, job-bound SSE cursor codec (`v1.<b64url(job)>.<b64url(native)>`, unpadded) and `EventCursorExpired`/`EventCursorInvalid`. |

## Dependency pins (`core/requirements.txt`)

- `ruamel.yaml==0.19.1` and `pydantic==2.13.4` — the canonical-boundary versions
  that define the golden canonical bytes, validation locations, and 422 fixtures.
- Added `redis` and `fakeredis`. Redis is imported lazily (memory mode never
  imports it). `PuLP`/`HiGHS`/`SCIP` and any general solver selector are **not**
  introduced.

## Version stamping & Docker

`docker/Dockerfile.backend` is unchanged and already builds from the local
`core/` tree with `APP_VERSION` → `/app/VERSION`, matching the adapted
`get_app_version()`. No runtime Git dependency, no build-time cloning.

## Documented interpretations / deviations

1. **Redis replay snapshot uses a `WATCH`/`MULTI`/`EXEC` transaction.** The plan
   permits "one transaction/Lua snapshot or an equivalent retrying atomic read."
   `fakeredis` does not implement `EVAL`, so the snapshot is a single Redis
   transaction that watches the job key and event stream and reads job existence,
   floor, tail, the exact-cursor probe, and the initial batch in one boundary. Any
   concurrent append or trim invalidates the watch and the snapshot retries; if it
   cannot stabilize within the bound it fails closed with a contention error
   rather than returning stale or never-coexistent values. (This supersedes the
   earlier retrying-read approach, whose fall-through could return stale data.)
2. **Worker-handoff equality invariant** is canonical-bytes idempotency plus
   solver/export outcome equality — not raw Pydantic `==`. `mode="json"` renders
   preference `date` union fields as ISO strings; `utils.parse_dates` maps every
   value through `str()`, so string and `date` forms resolve to identical solver
   behavior and canonicalize to identical bytes.
3. **`appVersion` is retained (moved last)** in the canonical strict document as
   build provenance; it is never treated as scheduling semantics.

## T19a / T19b cold-review repairs

The first independent cold review raised eight findings (F1–F8); T19a repaired
all eight and the T19a closure review re-opened F1, F2, F6, and F8 as partial.
T19b closes those four. The list below is the current, fully-closed state
(superseding the earlier permissive-guided-rule and retrying-read notes above);
items marked **(T19b)** are the closure-review repairs:

1. **Workspace boundary rejects empty collections and unresolved references.**
   `workspace.py` rejects empty `people.items`/`shiftTypes.items` and validates
   people, shift-type, and date references in enabled preferences before
   canonicalization, so a broken reference never creates a job or consumes
   capacity. **(T19b)** Date references now use the scheduler's real resolution —
   literal validity, schedule-range membership, keywords, ranges, and every
   `dates.groups[*].members` entry (via `build_shift_type_index_map`,
   `utils.parse_dates`, and the reserved keyword sets) — with deterministic source
   paths; an unquoted invalid YAML timestamp is mapped to the 400 malformed-source
   response instead of escaping as a 500.
2. **Worker identity and active lease are atomically fenced at commit.**
   `record_event`, `record_score_and_event`, `complete_job`, `fail_job`, and
   `renew_claim` require a worker identity (no `worker_id=None` trust bypass).
   The controller passes that owner, revision, and observed deadline to `save()`.
   Memory evaluates all three while holding its record lock with a commit-time
   clock. Production Redis evaluates them in one Lua operation using Redis
   `TIME` and an expiring lease key before writing job state, events, artifact
   bytes, or a renewed deadline. Fakeredis uses an explicit test-store path
   because it cannot execute Lua; it is never a production fallback. A delayed
   commit suite proves event, completion/artifact, failure, and renewal writes
   leave state, revision, event stream, and artifacts unchanged after expiry;
   maintenance then performs the normal `worker_lost` transition. The worker
   also stops local execution once its last confirmed lease deadline passes
   during a renewal outage.
3. **Workspace V1 is strict at known boundaries.** Preferences and Guided rules
   are strict known models (`StrictBool` `enabled`, strict `WorkspaceGuidedRule`);
   version dispatch distinguishes an absent key from an explicit value and accepts
   only the integer `1` (rejecting `true`/`null`/other via the normative
   unsupported-version issue).
4. **Normative 422 paths are source-document locations.** Union branch class names
   are stripped, irrelevant branch errors dropped to the matched branch, issues
   deduplicated, and per-preference validation preserves source indexes across
   disabled-item filtering.
5. **Redis replay preparation is atomic** (see deviation 1 above) and includes
   job existence in the same consistency boundary.
6. **Migration evidence restored.** Ported store/controller lifecycle,
   cancellation, lease, concurrency, revision, retention, and watch-error tests
   (`test_server_backend_parity.py`) plus the upstream ASGI-nonblocking,
   running-worker cancellation/result-discard, Finish-now, long-running lease
   renewal, and failure-persistence gates (`test_server_lifecycle_gates.py`).
   **(T19b)** The real-Redis `SIGKILL` gate now spawns a genuine **replacement
   process** that performs the expiry and asserts `worker_lost`
   (`test_server_worker_loss_multiprocess.py`); the pytest process only
   coordinates and observes. A committed real-Redis **wrong-authentication** gate
   fails hard, alongside the unreachable-endpoint gate; explicit Redis
   configuration fails hard instead of skipping.
7. **Maintenance liveness feeds readiness.** `JobMaintenance` records last-success
   and exposes `is_healthy()`; `/health` and `/ready` fail closed when the
   maintenance loop stalls, independently of store and worker failures.
8. **Cursor canonicality enforced.** Both stores reject non-canonical native
   cursor aliases (`+1`, `01`, leading-zero stream ids). **(T19b)** The shared
   codec additionally re-encodes each decoded base64url job/native segment and
   requires byte-for-byte equality, rejecting noncanonical base64url spellings
   (e.g. `MR` for `1`) as `400 invalid_event_cursor` before native comparison, via
   shared alias fixtures.

## Verification performed

T19b/T19c gates (from `core/`, `PYTHONPATH=.`, system Python 3.14 user-site):

- `python -m py_compile` on the server package: clean.
- `ruff check` and `ruff format --check` on the server package and `test_server_*`
  suites: clean.
- Full backend `pytest` with no configured Redis: **452 passed, 40 skipped**.
- Full backend `pytest` against a real Redis 8 container
  (`NURSE_TEST_REDIS_URL`): **492 passed** (0 skipped), including the multi-process
  `SIGKILL` replacement-process gate, wrong-authentication gate, and delayed
  worker-commit fence probes.
- Invalid/out-of-range dates and broken references are shown to consume no
  capacity and create no job; explicit but unreachable/wrong-auth Redis fails hard.

Installed boundary versions: `pydantic 2.13.4`, `ruamel.yaml 0.19.1`, `redis 8.x`,
`fakeredis 2.x`.

## U30a — Upstream 5027e2f public-diagnostics refresh

Execution note for ticket **U30a — Import core diagnostic, runtime identity, and
store retry changes**. Reconciles the full upstream delta
`git diff 0420ccdc..5027e2f` (30 changed paths) against the rebuild. U30a owns
`core/**` and this manifest only; Docker, Web, and `.gitignore`/`AGENTS.md`
changes are recorded here for completeness but are owned by other lanes.

### Settled adaptation invariants

- `JOB_MAX_PENDING` stays **8** (upstream raised it to 32); diagnostic default
  `expected_concurrency` is **1** (upstream 3), matching the reviewed one-worker
  deployment and the rebuild's pending capacity.
- `get_app_version()` keeps the rebuild scheme `APP_VERSION` → `/app/VERSION` →
  `v0.0.0-unknown`; upstream's `.app-version`/`git describe` path is **not**
  imported. No runtime Git dependency.
- `/info` is added as the no-store snake_case identity/readiness surface. `/health`
  is **retained unchanged** (legacy camelCase) and `/ready` stays minimal (now
  `no-store`); no endpoint was removed, unlike upstream which replaced `/health`.
- Runtime identity is threaded through the controller into the queued
  `job.state_changed` event and the running event (with `worker_id`), matching the
  exact T19 event wire; the opaque public SSE cursor is unchanged.
- Store identity is atomic and fails closed: memory adopts the process instance id,
  Redis persists a per-namespace UUID (`metadata:store_id`, `SET NX`) and
  `check_health()` uses one bounded `GET` that also rejects an identity change. The
  T19c Lua/`fakeredis` commit fence, atomic lease, replay snapshot, Workspace, and
  strict error envelopes are preserved untouched.
- `httpx` is added (upstream dropped `httpx2`); the canonical `pydantic`/`ruamel`/
  `redis`/`fakeredis` pins are unchanged. It is a **shared** requirement installed
  into the backend image too (via `Dockerfile.backend`), not a diagnostic-image-only
  dependency; only the diagnostic runner entrypoint and scenario asset are
  image-specific.

### Source coverage — all 30 upstream paths

Legend: **direct** = imported verbatim; **adapted** = imported with the invariants
above; **excluded** = intentionally not applied in `core/**` (owner noted).

| Upstream path | Disposition | Notes |
| --- | --- | --- |
| `core/nurse_scheduling/server/retry.py` | direct | Verbatim shared bounded-backoff primitive. |
| `core/nurse_scheduling/server/runtime_identity.py` | direct | Verbatim launch-scoped `get_deployment_id`. |
| `core/nurse_scheduling/server/diagnostic.py` | adapted | Imported; `expected_concurrency` default 3→1 (dataclass + `from_env`). Bounded, cleanup-safe, non-root SSE client; report volume mapped to the private compose profile by the Docker lane. Adds a validated `api_path_mode` (`backend`/`bff`, `DIAGNOSTIC_API_PATH_MODE`/`--api-path-mode`): one path builder routes EVERY request — `/info`, submit, poll, events, cancel, finish-now, cleanup delete — under the mode prefix, so the private backend contract and the public same-origin `/api/*` BFF contract never mix (U30d). |
| `core/nurse_scheduling/server/app.py` | adapted | Added `SERVICE_NAME`, `deployment_id`/`instance_id`, `runtime_identity`, `/info`; kept `/health` compatibility and the rebuild version scheme; `worker_id` = `instance_id`; memory store id = `instance_id`. |
| `core/nurse_scheduling/server/config.py` | excluded | Upstream default 8→32 rejected; rebuild keeps 8. No file change. |
| `core/nurse_scheduling/server/job_store.py` | adapted | Added `store_id` and `claim_next(runtime_identity=…)` to the protocol. |
| `core/nurse_scheduling/server/jobs/controller.py` | adapted | Added `runtime_identity` (create/claim events); routed `_retry_store_write` through shared `retry_with_backoff`; preserved T19 mandatory-worker-identity + observed-deadline fence. |
| `core/nurse_scheduling/server/stores/memory.py` | adapted | Added `store_id` (default uuid4, empty rejected) and `worker_id`/`runtime` in the running event. |
| `core/nurse_scheduling/server/stores/redis.py` | adapted | Added persistent `store_id`, split bounded `_redis`/streaming `_stream_redis` clients, identity-verifying `check_health` GET, and claim `worker_id`/`runtime`; preserved T19c Lua/fakeredis lease fence and replay snapshot. |
| `core/requirements.txt` | adapted | Added `httpx`; canonical pins unchanged; `httpx2` never present. |
| `core/tests/test_public_diagnostic.py` | adapted | Upstream coverage is retained verbatim (self-contained `MockTransport`; unaffected by the concurrency default). U30d **extends** it: `api_path_mode` validation/env-parsing, a per-endpoint prefix-mapping regression test (backend + bff), and a real-socket BFF-shaped end-to-end server (only `/api/*`, backend paths 404) that drives the full workflow and delete-based cleanup. U30e **further extends** it with idempotent-cleanup coverage: confirmed-absence GET/DELETE 404 marks the job deleted (backend + bff), a lost DELETE acknowledgement (transport failure then GET 404) still passes while retaining the transport error in `requestErrors` (backend + bff), the GET→DELETE 404 race, and preserved bounded `partial`/`cleanup_incomplete` for ambiguous errors and still-present residue. Now **39 cases** (27 retained upstream + 6 U30d + 6 U30e); no longer byte-identical to upstream. |
| `core/tests/test_serve.py` | adapted (mapped) | Target has no monolithic `test_serve.py`; new-behavior assertions mapped into `test_server_api.py` (`/info` + `/health` compat + runtime events) and `test_server_identity.py` (deployment identity). The upstream `/health`→404 assertion is intentionally not ported because `/health` is retained. |
| `core/tests/test_optimize_job_backends.py` | adapted (mapped) | Target has no such file; store-identity/retry/runtime assertions mapped into `test_server_store_contract.py`, `test_server_identity.py`, and `test_server_controller_retry.py`. |
| `AGENTS.md` | excluded | Workflow text already enforced by repository instructions; not duplicated. |
| `.gitignore` | adapted | Ignores the rebuild's host-extracted `docker/diagnostic-reports/` directory. |
| `docker/compose.backend.yml` | adapted (mapped) | The rebuilt `compose.yml` keeps the private Redis-backed base and adds an opt-in, app-network-only `diagnostic` profile with no host port. |
| `docker/compose.backend.memory.yml` | adapted (mapped) | Mapped to `compose.memory.yml`, retaining the private topology while switching the backend to the memory store for diagnostic runs. |
| `docker/Dockerfile.api` | adapted (mapped) | The lean local-source selective-copy backend Dockerfile boundary is unchanged (no Git clone or test-tree copy). The shared `httpx` dependency is added to `core/requirements.txt`, which `Dockerfile.backend` installs, so it is **present in the backend image by design** — it is NOT diagnostic-image-only. Only the diagnostic **runner entrypoint and the single scenario asset** are isolated to the separate non-root `Dockerfile.diagnostic` image. |
| `docker/Dockerfile.api.dockerignore` | adapted (mapped) | The rebuild's selective Dockerfile copies supersede the broad upstream context ignore; diagnostic image-content gates prove no tests, `.git`, or caches are present. |
| `docker/Dockerfile.api.staging` | adapted (mapped) | Direct and Cloudflare production modes remain Compose overlays over the same digest-pinned private base; no duplicate staging image topology is introduced. |
| `docker/Dockerfile.api.staging.dockerignore` | adapted (mapped) | Superseded by the same local-source selective-copy boundary used for all overlays. |
| `docker/.env.example` | adapted | Added commented `DIAGNOSTIC_*` controls with rebuild defaults: concurrency 1, max jobs 8, and the internal backend target. |
| `docker/.env.staging.example` | adapted (mapped) | The rebuild has one deployment env template; staging diagnostic controls are documented in `.env.example` and the Docker runbook rather than duplicated. |
| `docker/README.md` | adapted | Documents opt-in Redis/memory diagnostic runs, report persistence/extraction, cleanup, and every topology deviation. External targeting selects the public same-origin BFF contract explicitly (`DIAGNOSTIC_API_PATH_MODE=bff`), matching the diagnostic's executable `/api/*` routing (U30d). |
| `docker/test_public_healthcheck.sh` | adapted (mapped) | A public backend probe is intentionally incompatible with the BFF-only topology; `/info` is exercised by the diagnostic and core/BFF tests while `make verify-deploy` retains public `/api/health` coverage. |
| `web-frontend/e2e/helpers.ts` | adapted (mapped) | Legacy server fixtures are represented by rebuilt `app/api/info` real-`node:http` integration helpers; the legacy React app is not vendored. |
| `web-frontend/e2e/optimize-and-export-http-server.spec.ts` | adapted (mapped) | Ready, unavailable, timeout, malformed, truncated-body, and version/identity transport intent is covered at the same-origin `/api/info` BFF boundary. |
| `web-frontend/src/app/optimize-and-export/page.test.tsx` | adapted (mapped) | Server-info behavior moved to strict BFF route/unit tests; user-facing optimize status remains owned by T16. |
| `web-frontend/src/app/optimize-and-export/page.tsx` | adapted (mapped) | The diagnostic-data fetch moved behind `/api/info`; the legacy page/server-selection UI is intentionally not copied, and rebuilt presentation remains deferred to T16. |
| `web-frontend/src/app/optimize-and-export/serverSelection.ts` | adapted (mapped) | Replaced by the same-origin BFF's closed snake_case `ready`/200 or `unavailable`/503 contract, bounded private hop, and code-first 502 failures. |

### Net-new rebuild test modules (U30a)

| File | Purpose |
| --- | --- |
| `core/tests/test_server_identity.py` | Deployment identity sharing/rotation; memory store instance-id and empty rejection; Redis persistent store id, dual-client timeouts, identity-change health rejection, no-retry read, and construction-fatal identity failure. |
| `core/tests/test_server_controller_retry.py` | Controller store-write retry uses the shared bounded backoff and converts exhausted conflicts to a contention error. |

### Verification performed (U30a)

From `core/`, `PYTHONPATH=.`, system Python 3.14 user-site:

- `python -m py_compile` on the server package: clean.
- `ruff check` and `ruff format --check` on `nurse_scheduling/` and `tests/`: clean.
- Diff-check: `retry.py` and `runtime_identity.py` are byte-identical to upstream
  `5027e2f`; `diagnostic.py` differs in the two intended `expected_concurrency`
  default lines (U30a), the U30d `api_path_mode` path-builder adaptation, and the
  U30e idempotent cleanup-absence handling (GET/DELETE 404 → confirmed deletion);
  `test_public_diagnostic.py` retains the upstream cases verbatim but is no longer
  byte-identical — U30d adds path-mode, all-endpoint, and real-socket BFF
  workflow/cleanup coverage, and U30e adds the confirmed-absence, lost-ack,
  delete-race, and ambiguous/present-residue cleanup coverage.
- `test_public_diagnostic.py`: **39 passed** (27 retained upstream + 6 U30d + 6 U30e).
- Full backend `pytest` with no configured Redis: **519 passed, 43 skipped**
  (the real-Redis-gated identity/lease/replay/worker-loss variants).
- Full backend `pytest` against a real Redis 8 container (`NURSE_TEST_REDIS_URL`):
  **562 passed, 0 skipped**, including the multiprocess `SIGKILL`
  replacement-process gate, wrong-authentication gate, delayed worker-commit
  fence, replay, Workspace, and the new identity/retry/diagnostic gates.
