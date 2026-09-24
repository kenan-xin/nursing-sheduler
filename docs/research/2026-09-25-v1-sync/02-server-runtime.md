# Lane 02: server runtime, v1 to v2 sync

Date: 2026-09-25. Scope: `core/nurse_scheduling/server/` runtime (app, config, errors, diagnostic, job store, maintenance, retry, `jobs/*`, `stores/*`, `api/*`), `serve.py`, and the server tests. Lane 03 owns `auth.py`, `request_limits.py`, `solver_options.py`, `suspicion.py`, `usage_metrics.py` and `usage_report.py`. This report covers those modules only where app, optimize, config, stores or worker wire them in.

## Baseline

The v2 pin `d63519b` is on v1 branch `feature/genie`. It is not an ancestor of v1 `dev`. The merge base with `dev` is `89190ab`. The coordinator set the target to `feature/genie` at `1bf4b85`. This report therefore uses `d63519b..feature/genie` as the upstream delta.

- DEV marks a change that came from `89190ab..dev`.
- GENIE-ONLY marks a change that exists only in `dev..feature/genie`.

Every server change in this lane is DEV in origin. Genie only subtracts from DEV. Merge `1b6f7e5` (2026-09-24, "Merge dev into feature/genie") keeps Sentry, the suspicion tracker, and the PuLP CBC and cuOpt solvers removed. Genie commit `64c84a3` (2026-07-15) removed Sentry from `app.py` and `jobs/worker.py` before the pin. v2 inherited that removal.

Commands used (v1 repo, read only):

```sh
git -C /home/kenan/work/nurse-scheduling diff d63519b feature/genie -- core/nurse_scheduling/server ...
git -C /home/kenan/work/nurse-scheduling diff dev feature/genie -- core/nurse_scheduling/server ...
git -C /home/kenan/work/nurse-scheduling log 89190ab..dev -- core/nurse_scheduling/server ...
```

## 1. Summary

In this lane, v1 made one large structural change and many small hardening changes. The large change replaces the per-job claim deadline (`Job.claim_expires_at`) with a shared, renewable worker lease registry (`WorkerLease`, commits `0249f67`, `ab71cfd`, `fec52e1`, `23a77bb`). v2 solved the same problem one day earlier with a different design: a per-job lease key and a Redis `TIME` Lua commit fence (T19b/T19c). v2 then built the T09 ordinary-first priority queue as a Lua state machine on top of that fence. The two designs are duplicate solutions, and they touch the same six files.

The small changes are mostly independent of that conflict. They are: outage backoff (`RepeatedFailure`), a Darwin process-tree fix, a YAML alias and nesting guard, a body-size middleware, a secure-cookie setting, an options endpoint, `/info` activity counts, claimed performance, API version `0.2.0`, diagnostic logging, and Ruff style.

Headline risks:

1. Security gap in v2. v2 parses, validates and canonicalizes submitted YAML inside the API process, with no alias-expansion or nesting bound (`core/nurse_scheduling/server/scheduling_input.py:65-80`). v1 `3a77ad4` and `1990a1e` close this gap. Adopt early.
2. The lease redesign is the largest single divergence. Adopting it means that v2 must re-express the T09 queue and the lease fence on v1's `WATCH`/`MULTI` store. That is L effort and high risk.
3. The web BFF validators are closed. `web/app/api/info/validate.ts` rejects any extra `/info` key, and `web/lib/query/event-payloads.ts:125` requires `api_version === "alpha"`. Every v1 `/info` or version change needs a paired web change.
4. v1 `default_prettify=True` changes behavior. v2 maps an omitted `prettify` to `False` (`jobs/runner.py:120`, `basis_admission.py:213`). Adopting v1's default changes output and the v2 basis identity for requests that omit `prettify`.

## 2. Change table

Status values: absent, partial, conflicts, equivalent already. Action values: adopt verbatim, adopt with adaptation, skip, NEEDS DECISION.

| ID | Origin | v1 commits | Files | What it does | v2 status | Conflict notes vs v2 | Proposed action | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | DEV | `0249f67`, `ab71cfd`, `fec52e1`, `23a77bb`, `00aee65` (poll part). Tests: `d4ae8aa`, `74f0ce4`, `c621490`, `663861b`, `0bb55e2`, `367b477` | `job_store.py`, `jobs/models.py`, `jobs/controller.py`, `jobs/worker.py`, `stores/memory.py`, `stores/redis.py`, `config.py`, `app.py`, `maintenance.py` (docstrings) | Replaces per-job `claim_expires_at` with a worker lease registry. `WorkerLease(worker_id, token, expires_at)` is registered at start, renewed by an always-on heartbeat thread, and recovered after expiry. Redis keys `workers:leases` (zset), `workers:tokens` (hash), `workers:active` (hash). Every worker write passes `worker_lease` to `update_job` (renamed from `save`). `claim_next` becomes `claim_next_job(lease, ...)`. `find_claimed_before` becomes `find_jobs_without_live_workers` plus `remove_expired_worker_leases`. Setting `claim_lease_seconds` becomes `worker_lease_seconds` (`JOB_WORKER_LEASE_SECONDS`). Readiness uses `worker.is_ready()`. After an unreportable outcome, the worker unregisters its lease so that maintenance can expire the job (`worker.py:298-360`, v1 `dev`). | conflicts (duplicate design) | v2 fences each worker write with a per-job lease key and a Redis `TIME` Lua commit (`stores/redis.py:700-958`, `_lease_key` at 1550). v2's queue is a Lua state machine (`stores/queue_script.py`, T09), and its claim runs in Lua. v1 fences with `WATCH`/`MULTI` and the API process clock (`stores/redis.py:501-620`, v1 `dev`). v2 requires `worker_id` on every write and checks an observed deadline. v1 uses a lease token instead. v2 worker renews per job and stops the child when the confirmed deadline passes (`jobs/worker.py:163-195`). The redesign touches every method that T09 also changed. | NEEDS DECISION (D1). Recommendation: keep v2's fence and queue for now, record S01 as a documented deviation, and propose v2's design upstream. | L | High |
| S02 | DEV | `0249f67` | `jobs/models.py` (`ServerActivity`), `job_store.py`, `stores/*` (`get_activity`), `jobs/controller.py`, `app.py` (`/info` at v1 `app.py:354-388`) | `/info` reports `jobs.running`, `jobs.queued`, `jobs.cancelling` and `workers.online`. It returns 503 `job_store_unavailable` if the counts fail. v1 frontend shows them in an Activity column. | partial | v2 `describe_queue_state()` (T09, `job_store.py:166`) already returns an atomic queue snapshot, but `/info` does not expose it. v2 has no worker-presence count without S01. `web/app/api/info/validate.ts` uses an exact key set, so the BFF rejects the new keys until you extend it. | Adopt with adaptation. Derive counts from `describe_queue_state()`. Report `workers.online` as 1 when `worker.is_alive()`, or use the S01 registry if D1 adopts it. Extend the BFF parser in the same change. | M | Medium |
| S03 | DEV (Sentry calls removed by GENIE `1b6f7e5`) | `68e2ef9`, `de019fd`, `00aee65`, `98dad42` (non-Sentry part). Tests: `test_retry.py` (new), `test_serve.py` outage cases | `retry.py`, `maintenance.py`, `jobs/worker.py` | `RepeatedFailure` (v1 `retry.py:38-81`) logs the first failure and the recovery only, and doubles the wait up to a cap (`DEFAULT_OUTAGE_MAX_DELAY_SECONDS=5.0`, maintenance cap 4x interval). The worker claim, renew and recover loops and the maintenance loop use it. `00aee65` polls at the normal interval while an owned job still runs. | absent | v2 `retry.py` is byte-identical to the pin, so the class drops in. v2 `maintenance.py` adds `is_healthy()` liveness and `repair_queue_residue()`. Merge both. v2 `LIVENESS_INTERVAL_FACTOR` is 3.0 (`maintenance.py:31`), but the v1 maintenance cap is 4x. After the store recovers, the next pass can wait 4x the interval, so `/ready` reports `job_maintenance_unavailable` for up to one extra interval. Set the cap to 3x or the factor to 4.0. The renew and recover parts exist only in the S01 worker. | Adopt `retry.py` verbatim. Adopt the maintenance and claim-loop parts with adaptation. Take the renew and recover parts only with S01. | S | Low |
| S04 | DEV | `eda4c00`, `abfdc0f` | `jobs/process_tree.py`, `test_process_executor.py` | On Darwin, retries the process-group kill once after a 1 s join when `PermissionError` occurs, finishes cleanup, then re-raises (v1 `process_tree.py:108-133`). | absent | v2 `process_tree.py` is byte-identical to the pin. No conflict. | Adopt verbatim, with its tests. | S | Low |
| S05 | DEV (report calls removed by GENIE `1b6f7e5`) | `3a77ad4`, `1990a1e` | `api/optimize.py` (v1 `optimize.py:171-181`). Needs `loader.measure_yaml_expansion` (loader.py, other lane) | Before job creation, counts YAML alias expansion from parse events (limit `MAX_EXPANDED_NODES=200_000`) and refuses nesting deeper than `MAX_NESTING_DEPTH=64`. Runs in the thread pool. Rejects with 400. A plain YAML parse error still passes to later validation. | absent | v2 `canonicalize_submission` parses with ruamel, validates with Pydantic and dumps canonical bytes, all in the API process (`scheduling_input.py:65-130`). A 342-byte alias bomb expands in memory there and in the canonical dump. v2 maps parse errors to 400 itself, so the `YAMLError` pass-through is harmless. | Adopt with adaptation. Call `measure_yaml_expansion` before `canonicalize_submission`. Depends on the loader lane porting `measure_yaml_expansion`. | S | Low (high value) |
| S06 | DEV | `9c55290` | `app.py` (wiring at v1 `app.py:306-313`), `request_limits.py` (lane 03) | `MaxBodySizeMiddleware` answers 413 from `Content-Length` before Starlette spools the body. Limit is `max_yaml_bytes + MULTIPART_OVERHEAD_BYTES`. Installed inside CORS. | absent | No conflict in `app.py`. The v2 BFF in front can also limit size (UNVERIFIED). | Adopt verbatim once lane 03 ports `request_limits.py`. | S | Low |
| S07 | DEV | `b87c4e4` | `config.py` (`cookie_secure`, `API_COOKIE_SECURE`), `api/optimize.py` (`_client_id`) | Lets the deployment force the `Secure` flag on the client-id cookie behind a TLS-terminating proxy. | absent | No conflict. The v2 backend is private behind the BFF, so the value is low. | Adopt verbatim (closeness). | S | Low |
| S08 | DEV (CBC and cuOpt removed by GENIE `1b6f7e5`) | `417d632`, `eacd021` | `config.py` (`solver_ids`, `default_solver`, `min_timeout_seconds`, `default_prettify`), `api/schemas.py` (`OptimizationOptionsResponse`), `api/optimize.py` (`GET /optimize/options`, solver form default `None`), `app.py` (`validate_solver_availability`). Needs `solver_capabilities.py` and `solver_options.py` | Advertises solver choices, timeout range and prettify default. Enforces them on `POST /optimize` (400 for a solver outside `solver_ids`). Default `solver_ids` is `(ortools/cp-sat,)`. | conflicts | U31 excluded `solver_capabilities.py`. v2 keeps `solver_supports_stop` in `jobs/models.py:269` and `parse_solver` in `scheduling_input.py`, which returns the 422 envelope, not 400. `default_prettify=True` changes the resolved prettify from `False` to `True` for omitted values. v2 binds that value into the basis (`basis_admission.py:213`), so basis ids change. | NEEDS DECISION (D2). Recommendation: adopt the config, endpoint and `solver_capabilities.py` with default `solver_ids=(ortools/cp-sat,)`. Keep v2's 422 solver error and set `OPTIMIZE_DEFAULT_PRETTIFY` default to `False` as a documented deviation. | M | Medium |
| S09 | DEV | `8142e57`, `073951e`, `3de3609`, `be0a8bc`, `e5e3686`, `820d054`, merge `cbedf3b` | `app.py` (auth dependencies, `events_router`, docs hidden when auth is on, `/info` `auth` key), `api/optimize.py` (`_events_token`), `api/schemas.py` (`from_job(job, events_token)`), `jobs/controller.py` (`auth_credential_id` in the queued log), `config.py` (auth fields), `diagnostic.py` (bearer header) | Optional bearer authentication, with a signed stream token in `links.events` because `EventSource` cannot send headers. | absent | Lane 03 owns `auth.py`. The `/info` `auth` key needs the BFF parser change. `links.events` gains `?token=` only when auth is on. v2's BFF is the only client, so the need depends on lane 03's decision. | Follow lane 03. Wiring is mechanical once `auth.py` lands. | M | Medium |
| S10 | DEV | `ae61142`, `2205039`, `6a868fc`, merge `cbedf3b` | `stores/redis.py` (stage telemetry in create, claim, update, `get_artifact`), `config.py` (`usage_metrics_*`), `app.py` (`_create_store`) | Stages minimal per-job telemetry in the same Redis transaction as each lifecycle change. | conflicts | v2 create, claim and worker commits run in Lua (`_run_state_machine`, `stores/redis.py:319`). A Lua script cannot call `RedisUsageMetrics.stage_*` on a `MULTI` pipeline, so staging needs either Lua support or a second write. | Follow lane 03. If adopted, it must land after D1. Stage telemetry after the Lua commit as a documented deviation. | M | Medium |
| S11 | DEV | `5af0419` | `config.py` (`ClaimedPerformance`, `CLAIMED_PERFORMANCE_*`), `app.py` (`/info` `claimed_performance`) | Publishes a self-reported benchmark score for server selection in the v1 frontend. | absent | The BFF `/info` parser is closed. v2 has one backend behind the BFF, so server selection does not exist. | Adopt verbatim in core, with `claimed_performance: null` by default, together with S02 so that the BFF parser changes once. Do not surface it in the UI. | S | Low |
| S12 | DEV | `3621c6b` | `app.py` (`API_VERSION = "0.2.0"`) | Stabilizes the API version string. | absent | `web/lib/query/event-payloads.ts:125` requires `api_version === "alpha"` inside `runtime` of `job.state_changed`. v2 `/` also returns legacy camelCase keys (`version`, `appVersion`), which differ from the pin already (pre-range). | Adopt with adaptation. Change the web validator in the same commit. | S | Medium |
| S13 | DEV (Sentry parts removed by GENIE `1b6f7e5`) | `8142e57`, `073951e` (auth header), `bc68e90`, `87fe931` (logging), `2f86e7c`, `ac3e3ee` (style) | `diagnostic.py`, `test_public_diagnostic.py` | Adds `DIAGNOSTIC_AUTH_TOKEN` bearer header (HTTPS only), `log_report()` structured logging, `_run`/`main` split, parenthesized `with`. | partial | v2 `diagnostic.py` differs from the pin by 74 lines (U30a concurrency default, U30d `api_path_mode`, U30e cleanup). The v1 hunks touch other functions. Expect small manual merges in `_client_headers` and the events stream block. | Adopt with adaptation. Take logging and style now. Take the auth header with S09. | S | Low |
| S14 | DEV | `bc68e90` (module), kept by genie | `version.py` (new), used by `diagnostic.py` and `usage_report.py` in `dev` | Moves `get_app_version()` into `nurse_scheduling/version.py`: `.app-version` file, then `git describe`, then `v0.0.0-unknown`. | conflicts (duplicate) | v2 `app.py:106-122` resolves `APP_VERSION` env, then `git describe` gated on `.git`, then fallback (`030b6a7`). Genie's `app.py` still has its own copy. | Adopt with adaptation. Add `version.py` and move v2's env-first, `.git`-gated logic into it as a small documented patch. Point v2 `app.py` at it. | S | Low |
| S15 | DEV | `2f86e7c`, `ac3e3ee`, `04b97a2` | `serve.py`, `jobs/process_executor.py`, `jobs/runner.py`, `retry.py`, `maintenance.py`, `stores/redis.py`, `api/optimize.py`, `controller.py`, `worker.py`, `config.py`, tests | Ruff formatting: import order, no blank line after imports, `# noqa: BLE001`, `datetime.now(timezone.utc)` for the generated input name. | absent | v2 `pyproject.toml` selects only `E4,E7,E9,F`, so v1 style passes v2 lint. v1 targets `py310` in Ruff and `>=3.12` in `requires-python` (pyproject owned by another lane, UNVERIFIED). | Adopt verbatim, file by file, while syncing each file. This removes noise from future diffs. | S | Low |
| G1 | GENIE-ONLY removal of DEV work | DEV adds: `bc68e90`, `87fe931`, `98dad42`, `d9da197`, Sentry hunks of `8142e57`. Genie removes: `64c84a3`, `1b6f7e5` | `app.py`, `jobs/worker.py`, `maintenance.py`, `diagnostic.py`, `sentry.py` | Sentry init, invalid-request capture, client-address tag, optimize-exception capture, outage-recovery events. | equivalent already | v2 has no `sentry.py` and no Sentry calls, the same as genie. | Skip (genie keeps it removed). | none | none |
| G2 | GENIE-ONLY removal of DEV work | DEV adds: `2f46c41`, `cda28e5`, `fce163a`, `190c587`, `8ddbf93`, `3f60999`, `a32052f`, `405da2a`, `0a84947`. Genie removes: `1b6f7e5` | `api/optimize.py` (`_report_foreign_job_access`, YAML shape reports), `app.py` (suspicion tracker), `config.py` (`SUSPICION_*`) | Suspicious-request reporting to Sentry. | equivalent already | v2 has none of it, the same as genie. Genie keeps `request.state.invalid_reason` assignments in `optimize.py`. They are harmless without a reader. | Skip. Keep the `invalid_reason` lines when you copy genie `optimize.py` verbatim. | none | none |
| G3 | GENIE-ONLY removal of DEV work | Genie removes: `1b6f7e5` | `solver_capabilities.py`, `solver_options.py` | Drops `pulp/cbc` and `pulp/cuopt`. | equivalent already | v2 excludes the whole registry today. It matters only if D2 adopts S08. | Follow S08. | none | none |

### v2 adaptations that can go in favour of v1 or genie

| v2 adaptation | Replace with | Condition |
| --- | --- | --- |
| `solver_supports_stop` and `STOPPABLE_SOLVERS` in `jobs/models.py` (U31) | genie `solver_capabilities.solver_supports_finish_now` | D2 adopts S08. |
| `get_app_version()` in `app.py` (`030b6a7`) | genie `version.py`, plus the env-first step | S14. |
| Per-job lease key, Lua `TIME` fence, `renew_claim`, `find_claimed_before` (T19b/T19c, U31) | genie worker lease registry | D1 chooses option A. |
| `/info` without activity counts | genie `/info` with `jobs` and `workers` | S02, with the BFF change. |

The following v2 adaptations stay, because v1 has no equivalent: maintenance liveness (`is_healthy`), `/health` compatibility, opaque event cursors, Workspace and canonical input, basis admission (T08), and the ordinary-first queue (T09).

## 3. Dependencies and order

1. S15 (style) goes with each file sync. It has no dependencies.
2. S04 (process tree) and S07 (cookie) are independent. Land them any time.
3. S05 (YAML guard) needs `loader.measure_yaml_expansion` from the loader lane. Land it early because it closes a security gap.
4. S03 `retry.py` lands before the maintenance and worker backoff parts. The worker renew and recover parts wait for D1.
5. D1 (S01) must settle before S02 `workers.online` in its final form, before S10 telemetry staging, and before the S03 renew and recover parts.
6. S02, S11 and S09's `auth` key all change `/info`. Batch them with one BFF parser change (`web/app/api/info/validate.ts`, `types.ts`) and one test update.
7. S12 (API version) needs the paired change in `web/lib/query/event-payloads.ts` and its tests.
8. S06 needs lane 03 `request_limits.py`. S09 needs lane 03 `auth.py`. S10 needs lane 03 `usage_metrics.py`.
9. S08 needs lane 03 `solver_options.py`, the genie `solver_capabilities.py`, and the scheduler selector (`scheduler.normalize_solver_selector`, other lane).
10. S13 auth header waits for S09. S13 logging and style do not wait.
11. S14 lands before or with S13, because genie code expects `nurse_scheduling/version.py` to exist.

## 4. Open decisions

D1. Worker lease model (S01).

- Option A: adopt genie's worker lease registry verbatim. Then re-express T09 admission, priority claim and queue repair on genie's `WATCH`/`MULTI` store, or re-add them as Lua with genie's lease keys. Result: the store files become close to v1. Cost: L. It replaces the T19c Redis `TIME` fence with API-process clock checks, and it needs new parity tests for T09.
- Option B: keep v2's per-job lease and Lua fence. Record S01 as a permanent deviation in the manifest. Take only S02, S03 (claim loop and maintenance), S04 and S05. Cost: S. The store files stay about 1,200 lines away from v1.
- Option C: B now, and offer v2's fence and T09 queue to v1 upstream. If upstream accepts them, the next sync becomes mechanical.
- Recommendation: C. v2's fence uses one Redis clock and one atomic commit, so it is not weaker than v1's. T09 is live v2 product (web `lib/ai/diagnostic/*` sends `purpose`). A port under A costs more than the store diff it removes.

D2. Options endpoint and solver registry (S08, G3).

- Recommendation: adopt `GET /optimize/options`, the config fields and genie `solver_capabilities.py`, with default `solver_ids=(ortools/cp-sat,)`. This keeps v2 CP-SAT only in practice and removes the U31 `solver_supports_stop` adaptation. Keep v2's 422 solver envelope. Set the `default_prettify` default to `False`, or accept new basis ids for requests that omit `prettify`. This decision needs alignment with the lane that owns the multi-solver scheduler.

D3. `/info` surface (S02, S11, S09 `auth`).

- Recommendation: extend core and the BFF parser together in one change. Keep the BFF allowlist closed. Expose `jobs` and `workers` to the browser only if a UI needs them. v2 has no Activity column today, so a core-only change with a BFF that drops the new keys is also valid.

D4. API version string (S12).

- Recommendation: adopt `0.2.0` and relax `event-payloads.ts` to accept it. The value is a label, and matching v1 removes one permanent diff line.

## 5. Coverage note

Every file in scope that changed between `d63519b` and `feature/genie`, with the rows that cover it:

| File | Rows |
| --- | --- |
| `core/nurse_scheduling/serve.py` | S15 |
| `server/app.py` | S01, S02, S06, S08, S09, S10, S11, S12, G1, G2 |
| `server/config.py` | S01, S07, S08, S09, S10, S11, G2 |
| `server/diagnostic.py` | S13, G1 |
| `server/job_store.py` | S01, S02 |
| `server/jobs/controller.py` | S01, S02, S09, S15 |
| `server/jobs/models.py` | S01, S02 |
| `server/jobs/worker.py` | S01, S03, G1, S15 |
| `server/jobs/runner.py` | S15 |
| `server/jobs/process_executor.py` | S15 |
| `server/jobs/process_tree.py` | S04, S15 |
| `server/maintenance.py` | S01, S03, G1 |
| `server/retry.py` | S03, S15 |
| `server/stores/memory.py` | S01, S02 |
| `server/stores/redis.py` | S01, S02, S10, S15 |
| `server/api/optimize.py` | S05, S07, S08, S09, S15, G2 |
| `server/api/schemas.py` | S08, S09 |
| `core/nurse_scheduling/version.py` (new) | S14 |
| `core/tests/test_serve.py` | S01 to S12 (v2 has no such file, T19 mapped it to `test_server_*.py`) |
| `core/tests/test_optimize_job_backends.py` | S01, S02 (v2 has no such file, mapped to `test_server_store_contract.py` and `test_server_backend_parity.py`) |
| `core/tests/test_process_executor.py` | S04, G3 (`pulp/cbc` to `pulp/highs` in genie) |
| `core/tests/test_public_diagnostic.py` | S13, G1 |
| `core/tests/test_retry.py` (new) | S03 |

Files in scope with no change in `d63519b..feature/genie`: `server/errors.py`, `server/api/sse.py`, `server/runtime_identity.py`, and the four `__init__.py` files. Lane 03 files that changed (`auth.py`, `request_limits.py`, `solver_options.py`, `usage_metrics.py`, `usage_report.py`) are covered here only through their wiring rows S06, S08, S09 and S10. `solver_capabilities.py` changed only by the G3 removal.

v2-only modules named in the task, with their relation to v1:

| v2 module | Relation to v1 changes |
| --- | --- |
| `workspace.py`, `scheduling_input.py`, `scheduling_errors.py`, `canonical.py` | No v1 equivalent. S05 inserts one call before `canonicalize_submission`. |
| `event_cursor.py` | No v1 equivalent. v1 did not change `sse.py`. |
| `queue_state.py`, `stores/queue_script.py` | T09 queue. These collide with S01 and S10 (D1). |
| `optimize_basis.py`, `basis_admission.py`, `semantic_profile.py` | T08 basis. These collide with S08 `default_prettify`. |
| `roster_container.py` | B2. No v1 overlap in this lane. |

UNVERIFIED items: whether the v2 BFF already limits request size (S06), and which lane owns `pyproject.toml` and `loader.py`.
