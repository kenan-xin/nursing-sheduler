# v1 genie sync: design

Date: 2026-09-25. Status: approved in conversation. Revised after an independent review (confidence 7.5/10 before the fixes in this revision).

Evidence: `docs/research/2026-09-25-v1-sync/` (summary `00-summary.md`, lane reports `01` to `07`).

## 1. Intent

v2 is a frontend rebuild (`web/`) with a vendored Python backend (`core/`). The v1 upstream in `/home/kenan/work/nurse-scheduling` kept moving after v2 last synced. This work brings those upstream changes into v2 `develop`.

Success criteria:

1. v2 `core/` is as close to upstream as the v2 product allows. Every remaining difference is listed in one table with a reason.
2. The next upstream sync is mechanical: one `git diff` between two upstream pins, read against that table.
3. v1 user-facing features and fixes that v2 lacks are tracked as beads.
4. The v2 product does not change behavior, except for these listed changes:
   - A timeout with no incumbent ends as INCONCLUSIVE, not FAILED (W1).
   - Input errors that used to fail a job at solve time now return 422 at submit, because genie validates at load time (lane 01 C02).
   - A per-date override for a date outside its requirement fails at load time, not at solve time (P3).
   - A YAML document above the expansion or nesting bound returns 400 (W1).
   - `country` is no longer sent, so `inputSha256` changes for scenarios that carried it (X9).

## 2. Decisions

| ID | Decision |
| --- | --- |
| X1 | The upstream target is v1 branch `feature/genie` at `1bf4b85`. The old pin `d63519b` is a genie commit. Its merge base with v1 `dev` is `89190ab`. Genie contains all of `dev` through merge `1b6f7e5`. |
| X2 | Sync method C, split by layer. The solver core resets to genie. The server layer adopts upstream changes file by file. |
| X3 | Adopt the v1 worker lease registry in W6, after W2, and rebuild the T09 ordinary-first queue on it. W2 keeps the v2 T19 fence until W6 lands. See section 3, W6, for the comparison. |
| X4 | Restore the genie multi-solver library. The product stays CP-SAT only through the server boundary and the solver allowlist. `pulp` goes in `requirements-optional.txt`, not in the runtime file, so the production image does not carry it. |
| X5 | Exclude the v1 Python AI package (`core/nurse_scheduling/ai/`, `ai_serve.py`). Study it to improve the v2 assistant (W4). |
| X6 | No Sentry, no suspicion reports, no usage telemetry, no `usage-reporter` service. This matches genie for Sentry and suspicion. Telemetry stays off. W6 vendors `server/usage_metrics.py` only because genie `stores/redis.py` imports it. `USAGE_METRICS_ENABLED` stays `false`, `usage_report.py` is not vendored, and no data is collected. |
| X7 | Vendor `server/auth.py` and leave auth off. The v2 backend is private behind the web BFF. |
| X8 | Adopt the new `/info` keys and API version `0.2.0`, with the paired BFF parser change in the same commit. |
| X9 | Remove `country` from the core model, as genie does. Workspace V1 input still accepts `country` and drops it, so that old saved files load. `web/` accepts `country` on import and never sends it. The web store schema does not change. |
| X10 | Take the upstream message text, `version.py` and the default config values. Exception: `default_prettify=False` stays in `config.py` as a documented patch, so every launch path behaves the same. The other v2 values (`JOB_MAX_PENDING=8`, the diagnostic `expected_concurrency=1`) move to the `docker/` compose environment files and `scripts/dev.sh`. The web layer owns user-facing spelling (W2 step 11). |
| X11 | Track v1 frontend gaps as beads (W3). |
| X12 | W1 bumps `SOLVER_SEMANTIC_VERSION` in `server/semantic_profile.py`, because solving meaning changes (load-time rejections, reachable INCONCLUSIVE). This retires the retained assistant basis evidence once. |
| X13 | W6 bumps the Redis job key prefix and `QUEUE_STATE_MACHINE_VERSION`, because the genie store layout differs. Queued and running jobs are dropped at cutover. Deploy W6 in a quiet window. No migration code. |

## 3. Workstreams

```text
W0 foundations ──> W1 solver core (one branch) ──> W2 server (small commits) ──> W6 worker lease (one branch) ──> W5 manifest and recipe
W3 frontend beads and W4 AI study: independent, no core code
```

Each code workstream uses its own branch from `develop` in its own worktree, and merges back into `develop` (see `CLAUDE.md`, branch and deploy flow).

### W0: foundations

W0 makes CI gate every later step.

1. Split `core/requirements.txt` into runtime and `requirements-optional.txt`, in the genie form (lane 05 L5-01). The v2 patch keeps the `ruamel.yaml==0.19.1` and `pydantic==2.13.4` pins, because canonical YAML bytes depend on them. It also leaves out the packages that only `ai/` imports: `psycopg`, `e2b`, `Pillow`, `defusedxml`, `pypdf` and `pypdfium2`.
2. Make the production image install only the runtime file. `pytest`, `pytest-cov`, `ruff` and `fakeredis` leave the image.
3. Add a Linux core CI job to `.github/workflows/ci.yml`: `ruff check`, `ruff format --check`, and `pytest` with a real Redis service (lane 05 L5-10). The job installs `requirements-optional.txt`, so that after W1 the PuLP, HiGHS and SCIP tests run and do not fail on missing packages. No macOS or Windows jobs.
4. Record the new baseline in `docs/T19-upstream-backend-source-manifest.md`: target `feature/genie` `1bf4b85`, old pin `d63519b`, merge base `89190ab`.

Acceptance: the new CI job runs on a pull request and passes on current `develop`.

### W1: solver core reset

Scope: every module in `core/nurse_scheduling/` outside `server/` and `ai/`, and their tests. W1 lands as one branch, because the genie files alone break the v2 skill-mix, override and `on_roster` tests.

Take verbatim from genie `1bf4b85`:

- `cli.py`, `constants.py`, `context.py`, `exporter.py`, `group_map.py`, `loader.py`, `model_build_stats.py`, `models.py`, `preference_types.py`, `report.py`, `scheduler.py`, `solver_interface.py`, `solver_ortools_cp_sat.py`, `utils.py`.
- The restored solver modules: `solver_ortools_linear.py`, `solver_ortools_mathopt.py`, `solver_pulp.py`, `solver_pulp_glpk.py`, `solver_pulp_python.py`.
- The matching genie tests, the assignment fixture and the score ground-truth replay (lane 01 C06). Not the Docker performance benchmark. Not `tests/real/solver_capabilities.py`: it fails the v2 Ruff pin (6 E402), and v2 already maps it to `core/scripts/solver_capability_probe.py`.
- `pulp==3.3.2`, `highspy` and `pyscipopt` in the optional file (X4).

This take brings in the compiled-schedule API, `ScheduleResult`, the YAML expansion and nesting bound, `forced_solution`, and the genie LEAVE, `hoursContract`, covering and working-time code. `ScheduleResult` returns status UNKNOWN, so the v2 INCONCLUSIVE runner branch can run with the real scheduler.

Apply the v2 patches again (lane 01 section 2c):

| Patch | Change on the genie code |
| --- | --- |
| P1 `Person.temporary` | One `StrictBool` field on `Person`. |
| P2 `skillMix` | Keep the field validator. Add the resolved floors to `CompiledShiftTypeRequirements`. Unknown people fail at load time. |
| P3 per-date overrides | Add `required_by_date` to `CompiledShiftTypeRequirements`. A date outside the requirement fails at load time, not at solve time. |
| P4 `on_roster` | Read `ctx.scenario` and `ctx.compiled_schedule`. Keyword-only, after `forced_solution`. |

P2 and P3 edit the same compile step and handler, so they land together. Each patch is kept as a `.patch` file under `core/upstream-patches/`, so that it can be applied again at the next sync. W1 also adds `core/scripts/check_upstream_sync.py` and the manifest rows for the W1 files. W2 and W6 add their rows, and W5 completes the table.

Adapt the callers in the same branch:

- `server/workspace.py`: move the ordered shift-type map loop out of `group_map.build_shift_type_index_map` (removed on genie) into a public function in `workspace.py`. `group_map.py` stays equal to genie.
- `web/lib/scenario/differential/oracle.py`: import that function from `workspace.py`, and drop `country` before it calls `nurse_scheduling.schedule`. This oracle runs in the web unit tests, so W1 breaks web CI without this change.
- `web/lib/optimize/__fixtures__/c5/generate-c5-goldens.py`: run it again, and commit any golden that changes because of the genie exporter.
- `server/scheduling_input.py`: call `loader.measure_yaml_expansion` before canonicalization. Reject with 400 and the error code `scheduling_data_too_complex`. Map that code in `CODE_TO_KIND` in `web/lib/bff/errors.ts`.
- `server/workspace.py`: accept and drop `country`. `web/lib/scenario/canonical.ts` stops emitting it. Remove it from the 2 SG test cases.
- `server/semantic_profile.py`: bump `SOLVER_SEMANTIC_VERSION` (X12), and update the web profile fixtures that pin it.
- The server keeps rejecting any solver other than CP-SAT (`server/scheduling_input.py`).

Land W1 as one branch with these commits:

1. The verbatim take, the genie tests, and the `workspace.py`, oracle and C5 golden changes.
2. P1.
3. P2 and P3.
4. P4.
5. `country` in core and in `canonical.ts`, and the semantic version bump.

The other web `country` touchpoints move to a later small branch, because the Workspace path drops the field anyway: `types.ts`, `workspace.ts`, `import-scenario.ts`, `schemas/import.ts`, `schemas/producer.ts`, `store/persistence.ts` and `components/ai/use-context-tools.ts`.

Acceptance:

1. `core/scripts/check_upstream_sync.py` passes. For each file in the manifest with class `verbatim` or `patched`, it reverse-applies the recorded patches and compares `git hash-object` with the genie blob SHA recorded in the manifest. It needs no access to the v1 repo.
2. The full core suite, the genie score ground-truth replay and all real test cases pass.
3. A new test runs the real scheduler to UNKNOWN (for example, a 0.01 s timeout on the 87-person case) and gets the INCONCLUSIVE job outcome.
4. The web unit tests pass, including the differential oracle.

### W2: server adoption

W2 keeps these v2 server designs, because upstream has no equivalent: Workspace input and canonical YAML, the 422 envelope, opaque event cursors, the roster container, basis admission and the semantic profile, maintenance liveness, and the `/health` shim. W2 also keeps the T19 fence and the T09 queue, which W6 replaces.

Target origin class for each W2 file. A `patched` file is the genie file plus named v2 patches.

| File | Class | v2 patches kept |
| --- | --- | --- |
| `retry.py`, `jobs/process_tree.py`, `request_limits.py`, `version.py`, `auth.py`, `solver_capabilities.py`, `solver_options.py` | verbatim | none |
| `config.py` | patched | `ordinary_reserved_slots`, `default_prettify=False`, `claim_lease_seconds` until W6 |
| `app.py` | patched | Workspace wiring, 422 handler, `/health` shim, maintenance liveness in `/ready`, roster and basis routes |
| `api/optimize.py` | patched | Workspace boundary, public cursors, `/xlsx` and `/roster`, basis admission |
| `api/schemas.py` | patched | basis and INCONCLUSIVE fields |
| `diagnostic.py` | patched | `api_path_mode`, idempotent cleanup (both upstream candidates) |
| `maintenance.py` | patched | `is_healthy()` liveness, `repair_queue_residue()` |
| `jobs/runner.py` | patched | INCONCLUSIVE, roster artifact. Adopt the genie `JobFailure` return (lane 07 D03). |
| `jobs/process_executor.py` | patched | the v2 lines that lane 07 lists, or verbatim if none remain |
| `errors.py` | patched | `DiagnosticCapacityError`, `QueueInvariantError` |

Land in this order, one commit each where possible (lane 02 section 3, lane 03 section 3):

1. `retry.py` `RepeatedFailure` verbatim, with `test_retry.py`. Outage backoff in the maintenance loop. Keep the maintenance backoff cap inside the v2 liveness window (`LIVENESS_INTERVAL_FACTOR`), so that `/ready` does not fail after recovery. The claim-loop backoff waits for W6, because W6 replaces `worker.py`.
2. The Darwin process-tree kill retry (`jobs/process_tree.py`) with its tests.
3. `request_limits.py` verbatim, wired in `app.py`. Map the code `request_too_large` to kind `too-large` in `web/lib/bff/errors.ts`.
4. `version.py` verbatim. `docker/Dockerfile.backend` and `docker/Dockerfile.diagnostic` write `/app/.app-version` from `APP_VERSION` (`version.py` resolves `parents[2]`). Update `docker/test_diagnostic_version.sh` and `core/tests/test_app_version.py`. `app.py` imports `version.py`, so only one copy exists.
5. `auth.py` verbatim, with auth off by default, and its wiring in `app.py`, `api/optimize.py` and `api/schemas.py` (lane 02 S09). `cookie_secure` wiring (lane 02 S07). `solver_capabilities.py` and `solver_options.py` verbatim, with the default allowlist `ortools/cp-sat`. The genie finish-now capability replaces the v2 `STOPPABLE_SOLVERS` adaptation.
6. Genie `config.py` with the patch in the table above. `JOB_MAX_PENDING=8` goes to the compose environment files and `scripts/dev.sh`. The inert telemetry settings stay, because they are part of the genie file.
7. `GET /optimize/options` in `api/optimize.py`.
8. `/info` gains `jobs` (from `describe_queue_state()`), `workers.online` (from `worker.is_alive()` until W6 switches it to the lease registry), `auth` and `claimed_performance`. API version becomes `0.2.0`. The BFF validates the new keys and drops them from its browser response, because no v2 screen uses them. The same commit changes `web/app/api/info/validate.ts`, `web/app/api/info/types.ts`, `info.route.test.ts`, `info.integration.test.ts`, `web/lib/query/event-payloads.ts` and its tests, and the mocked `/info` in `web/e2e/support/optimize-durable.ts`.
9. The diagnostic `log_report` change (lane 02 S13), and the diagnostic, runner, process-executor and errors files moved to the classes in the table above.
10. Ruff style changes land with each file they touch. Keep the v2 Ruff pin and `target-version = "py312"`, and record both as tooling patches. Record any upstream Ruff violation that v2 ignores in the manifest.
11. Upstream message text. List each backend message that a v2 screen shows (for example, `run-view` shows `error.message`). Show those by error code through `web/lib/bff/errors.ts`, so that the web layer owns UK spelling and the backend text stays upstream.

Not adopted in W2: the worker lease registry (W6), Sentry and suspicion (X6), usage telemetry and `usage_report.py` (X6), `ai_serve.py` and `frontend_validation.py` (X5).

Acceptance: the core suite and the web tests pass after each step. `/api/info` returns 200 through the BFF. The real-Redis gates from T19 still pass. Every file in the table matches its class under `check_upstream_sync.py`.

### W6: worker lease registry

W6 replaces the v2 T19 fence with the genie worker lease registry (`0249f67`, `ab71cfd`, `fec52e1`, `23a77bb`, `00aee65`), and rebuilds the T09 queue on it. It lands as one branch, because the store, controller and worker change together.

Why v1 wins. The v2 fence is stronger in one narrow way: it checks lease expiry with one clock (Redis `TIME`) inside one atomic Lua commit. The v1 fence checks expiry against `observed_at`, which the worker reads from its own clock before the commit. So a write stamped just before expiry and committed after it succeeds, even with no clock skew. A stale write keeps succeeding until maintenance commits `worker_lost`, which bumps the revision and clears the active job. This gap costs little in v2, for these reasons:

- The v2 worker runs inside the API process (`worker_id=instance_id`, `server/app.py`), so the clock skew between worker and maintenance is zero.
- A lost job goes to `worker_lost` and does not run again. After maintenance acts, the token and revision checks reject every stale write, so two workers never own one job.
- Both designs make a worker abort its solver child when it loses its lease.

In return, v1 is smaller before the v2 patches (genie `stores/redis.py` has 921 lines, v2 has 1,623 plus the 441-line `queue_script.py`). The size after P9 is not yet measured. Its production path is the same code that the fakeredis tests run, where v2 keeps a mirrored Python path for fakeredis. Its always-on worker heartbeat gives worker presence for `/info` and readiness. It is also where upstream fixes land.

Take verbatim from genie: `job_store.py`, `jobs/models.py`, `jobs/controller.py`, `jobs/worker.py`, `stores/memory.py`, `stores/redis.py`, `usage_metrics.py` (import only, see X6), and the lease-related `config.py` rename to `worker_lease_seconds` (`JOB_WORKER_LEASE_SECONDS`, updated in `docker/` environment files). Port the genie lease tests (`d4ae8aa`, `74f0ce4`, `c621490`, `663861b`, `0bb55e2`, `367b477`).

Apply the v2 patches again, as the smallest changes to the genie code:

| Patch | Change on the genie code |
| --- | --- |
| P6 event replay | `prepare_event_replay` in `job_store.py` and both stores, as a `WATCH`/`MULTI`/`EXEC` snapshot. |
| P8 basis and INCONCLUSIVE | The job model fields and controller transitions from lane 07 D13. The explicit job serialize and deserialize code in both stores (purpose, basis fields, INCONCLUSIVE). |
| P9 purpose queues (T09) | Two purpose queues (ordinary and assistant diagnostic) and one reserved ordinary slot, on the genie `WATCH`/`MULTI` claim path. Create, claim, update and queue repair each `WATCH` the pending set and both purpose queues. Keep `describe_queue_state()`, queue repair and the T09 admission errors. No Lua. |
| P7 roster artifact | The runner and controller hooks for the roster container, if W2 did not already place them outside these files. |

Delete `stores/queue_script.py`, the fakeredis mirror paths and `find_claimed_before`. `/info` `workers.online` switches to the registry count. Take the claim-loop outage backoff from W2 step 1 here. Bump the job key prefix to `nurse_scheduling:jobs:v2` and `QUEUE_STATE_MACHINE_VERSION` (X13).

The v2 server suites call the T19 APIs directly (`renew_claim`, `find_claimed_before`, `worker_id` preconditions). Handle them by this rule: keep every behavior assertion, rewrite the calls to the lease API, and delete only assertions about Lua-only mechanics, with each deletion listed in the manifest. The suites are `test_server_lifecycle_gates.py`, `test_server_replay.py`, `test_server_worker_loss.py`, `test_server_priority_queue.py`, `test_server_backend_parity.py`, `test_server_worker_loss_multiprocess.py` and `test_server_store_contract.py`.

Accepted semantic change: a worker write can land between lease expiry and the `worker_lost` commit. Record this in the manifest.

Acceptance:

1. The genie lease tests and the rewritten v2 suites pass on memory, fakeredis and real Redis.
2. The real-Redis `SIGKILL` gate passes: a replacement worker recovers, and the killed job ends as `worker_lost`.
3. The delayed-commit probes pass with the new expected result: after maintenance acts, a stale worker write changes nothing.
4. The W6 files differ from genie only by the lines of P6 to P9.

### W3: frontend gap beads

File beads from the drafts in `06-frontend-gap.md` section 5:

- Fixes: history truncation on shift-type deletion (changes contract FR-RI-09), nested shift-type groups in count coefficients, Singapore holiday import for whole calendar years.
- Features: the 87-person example schedule (use the genie YAML), LAN origins for `next dev`, a copyright and AGPL-3.0 licence line (the owner confirms the text), timeout bounds from `GET /optimize/options` (after W2 step 7).
- Assistant: one-click Retry, transcript export, image and text attachments, a warning when older messages leave the prompt.

Not tracked: the v1 AI page, the backend server list, the star nudge, Sentry feedback, the token UI, the Export Layout indicator (already deferred in `qq0.15`).

### W4: v1 AI study

One research report in `docs/research/`, with no code. It compares the v1 AI package (genie version) with the v2 assistant for: optimizer data anonymization, attachment inspection (PDF, XLSX, images), prompt and schema references, conversation flow and error handling, and the 109 eval cases in `core/tests/ai_eval/cases/`. Each useful idea becomes a bead against the v2 assistant, or an eval case in `web/evals/`. The report respects the v2 decisions in `docs/ai-assistant.md`: BYO key, no server storage of chat text, user-confirmed runs.

### W5: manifest and sync recipe

Extend `docs/T19-upstream-backend-source-manifest.md` with:

1. A per-file origin table for every file in `core/`, tests included: `verbatim`, `patched` (with the patch IDs), `v2-only`, or `excluded` (with the reason). Each `verbatim` and `patched` row records the genie blob SHA that `check_upstream_sync.py` uses. For example, `test_models_validation.py` is `patched` once the P1 test is added.
2. `core/AGENTS.md` taken from genie, with a short v2 section (lane 07 D17, lane 05 L5-30).
3. A sync recipe of a few commands: diff the old genie pin against the new genie head for `core/`, then act on each changed file by its origin class. `verbatim` files copy. `patched` files copy and re-apply the patches from `core/upstream-patches/`. `excluded` files skip. Then run `check_upstream_sync.py`.
4. The upstream candidates: the per-date overrides, `skillMix`, the INCONCLUSIVE outcome, opaque cursors and the purpose queues. Each one that upstream accepts moves from `patched` or `v2-only` to `verbatim`.

Acceptance: every file in `core/` has exactly one row, and the recipe runs on the current pins with no unexplained difference.

## 4. Risks

| Risk | Control |
| --- | --- |
| The W1 reset changes solver scores. | The genie score ground-truth replay and all real test cases gate W1. |
| `/api/info` breaks if the core and BFF changes ship apart. | W2 step 8 is one commit. |
| Upstream Ruff violations fail the v2 gate. | Fix or ignore per file, and record each one in the manifest. |
| Old saved files carry `country`. | Workspace input accepts and drops it (X9). |
| The maintenance backoff breaks readiness. | W2 step 1 keeps the backoff cap inside the liveness window. |
| W6 weakens the T09 queue or worker-loss recovery. | W6 acceptance runs the T09 tests, the `SIGKILL` gate and the delayed-commit probes on real Redis. |
| W6 moves the fence to host clocks. | The worker runs in the API process, so skew is zero. Review it again if the worker moves to another process or host. |
| W6 drops in-flight jobs at cutover. | Accepted (X13). Deploy in a quiet window. |
| The W1 exporter change moves web goldens. | W1 runs the C5 golden generator again and reviews each changed golden. |
| `SOLVER_SEMANTIC_VERSION` bump retires retained assistant evidence. | Accepted (X12). |

## 5. Out of scope

- Wiring or vendoring the v1 Python AI service (X5).
- Any v2 frontend redesign. W3 only files beads.
