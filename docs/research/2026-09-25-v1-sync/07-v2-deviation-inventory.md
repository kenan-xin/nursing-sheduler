# Lane 07: v2 core deviation inventory

Date: 2026-09-25. Scope: every file under `core/` where v2 (this worktree, equal to `develop`) differs from v1 at `d63519b`. The report explains each v2 change, gives its reason, classifies it, and checks whether v1 touched the same file after `d63519b`.

v1 repository: `/home/kenan/work/nurse-scheduling`. Refs used: `d63519b` (v2 sync pin), `89190ab` (merge base of `d63519b` and `dev`), `dev` = `d41a6c5`, `feature/genie` = `1bf4b85` (primary target, per the coordinator correction).

Diff command used:

```sh
T=$(mktemp -d); git -C /home/kenan/work/nurse-scheduling archive d63519b core | tar -x -C $T
git diff --no-index --stat $T/core core   # 123 paths after __pycache__ is skipped
```

Classification codes (from the task):

- (a) required by the v2 product. Keep as a patch.
- (b) duplicate of something v1 now does. Drop it and take v1.
- (c) generic improvement. Offer it upstream.
- (d) removal of v1 code. Restore it to make the diff smaller.

## 1. Summary

1. The v2 core delta against `d63519b` is 123 paths, +18,202/-8,180 lines. About 70% of the added lines are tests. The source delta falls into six groups: the CP-SAT-only cut (D01-D03), the solver-core feature patches (D04-D07), the durable server rebuild (D08-D12), the assistant server features (D13-D14), copy and tooling (D15-D18), and test-only additions (D19-D20).
2. Baseline finding. `d63519b` is not an ancestor of v1 `dev`. It is a commit on v1 `feature/genie`, which is the fork branch that carries LEAVE, hours contracts, working time, covering rules and `group_map.py`. On 2026-09-24, merge `1b6f7e5` ported these fork features onto the v1 `dev` compiled core. For that reason, `feature/genie` (not `dev`) is the correct target for a core reset.
3. The largest removal is D01. v2 deleted the non-CP-SAT solvers and the `solver` selector. `cli.py`, `model_build_stats.py` and `solver_interface.py` are byte-identical to v1 fork commit `7d1c220` (2026-07-08), which is older than the multi-solver work in v1 (`7743585`, `81db4ea`, 2026-07-12). A restore of v1 library files, with the product boundary kept CP-SAT-only in `server/`, removes about 1,900 source lines of diff.
4. Bug found (verified by code reading, not by a run). The v2 `scheduler.py` raises `ValueError("No solution found! ...")` on `UNKNOWN`. v1 returns `ScheduleResult(..., "UNKNOWN", ...)` (from `2f24d31`, before the merge base). As a result, the v2 runner branch for `INCONCLUSIVE` / `solver_timeout_no_solution` (`core/nurse_scheduling/server/jobs/runner.py:139-157`) cannot run with the real scheduler. Only stubbed tests (`core/tests/test_runner_inconclusive.py`) reach it. Adoption of the v1 scheduler (D02) fixes this.
5. Headline conflict risk. v1 rewrote the job-server lease model (`0249f67`, `ab71cfd`, `fec52e1`, `23a77bb`) and the solver core (`9ff14d1`, `a64094a`, `86ce350`, `4e9aea2`). v2 wrote its own fence (T19) and its own queue state machine (T09, `39e26f1`) over the older server files. `server/stores/redis.py` (+964/-53 in v2, +230/-21 in v1), `server/jobs/worker.py` and `server/jobs/controller.py` are the worst hotspots.
6. The v2-only product patch set that remains after a reset to `feature/genie` is small in the solver core (temporary flag, skill mix, per-date overrides, `on_roster`). It is large in `server/` (Workspace boundary, canonical YAML, 422 envelope, opaque cursors, roster container, semantic basis, priority queues).

## 2. Baseline correction and the fork layer

The commits below exist in `d63519b` but not in `dev` (`git log --no-merges dev..d63519b`, 13 commits). All are by kenan.xin. The core-relevant ones are these:

| Commit | Date | Core effect |
| --- | --- | --- |
| `7d1c220` | 2026-07-08 | "reset codebase to reference snapshot": CP-SAT only, adds `ShiftTypeCoveringPreference`, country `TW` changed to `SG`, removes PuLP CBC/cuOpt. |
| `f06402b` | 2026-07-09 | First-class LEAVE day-state (`constants.py`, `context.py`, `exporter.py`, `models.py`, `preference_types.py`, `scheduler.py`). |
| `31c5125` | 2026-07-13 | Covering rule: an omitted date applies to all dates. |
| `7764e80` | 2026-07-13 | `hoursContract` metadata and leave-credit tests. |
| `64c84a3` | 2026-07-15 | Shift working time fields. Removes `sentry.py` and `anonymize_scheduling_data.py`. |
| `9aef889` | 2026-07-15 | Exact and ranged contracted hours. Adds `group_map.py`. |

Later merges into `feature/genie` (`0420ccd`, `5027e2f`, `fd2ecc0`) brought multi-solver `dev` code back, so `d63519b` itself contains the multi-solver scheduler. v2 did not take that part (see D01).

On `feature/genie` today (`1bf4b85`): `LEAVE_sid`, `hoursContract`, `restMinutes`, `group_map` and `SHIFT_TYPE_COVERING` are present. `sentry.py`, `server/suspicion.py`, `anonymize_scheduling_data.py`, `solver_pulp_cbc.py` and `solver_pulp_cuopt.py` are absent. `ScheduleResult`, `normalize_solver_selector` and `server/solver_options.py` are present. `on_roster`, `skillMix`, `requiredNumPeopleOverrides` and `Person.temporary` are absent (`git grep` on `feature/genie -- core/nurse_scheduling`; the `temporary` hits are unrelated words in `ai/` and `exporter.py`).

Origin tags used below:

- DEV: a commit in `89190ab..dev`. All non-merge core commits in `d63519b..feature/genie` are DEV, except `ecb5eee` (GENIE-ONLY, touches only `core/nurse_scheduling/ai/references/schema-core.md`).
- GENIE-MERGE: content that exists only through the resolution of merge `1b6f7e5`. `git diff --stat dev feature/genie -- core/nurse_scheduling` shows 34 files, +755/-1,308.

## 3. Change table

Each row is one v2 deviation from `d63519b`. The column "Upstream commits on the same files" lists the v1 commits after `d63519b` that touch the same code (the conflict hotspots). "v2 status" states how the v2 code relates to `feature/genie`.

| ID | Class | v2 commits | Files | What v2 changed, and why | Upstream commits on the same files (origin) | v2 status vs `feature/genie` | Conflict notes | Proposed action | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D01 | (d) | `0997903` (T01 vendor) | deleted: `solver_ortools_linear.py`, `solver_ortools_mathopt.py`, `solver_pulp.py`, `solver_pulp_glpk.py`, `solver_pulp_python.py`. Edited: `scheduler.py` (selector block, `-162` lines), `cli.py` (`--solver`), `model_build_stats.py` (MPSolver/MathOpt count branches), `solver_interface.py` (`validate_square_constant`), `requirements.txt` (`pulp`, `highspy`, `pyscipopt`). Tests: `test_solver_ortools_linear.py`, `test_solver_ortools_mathopt.py`, `test_solver_pulp_cbc.py`, `test_solver_pulp_glpk.py`, `test_solver_pulp_python.py`, 10 `test_schedule_ortools_*`/`test_schedule_pulp_*` files, `test_scheduler.py` (selector tests), `test_solver_interface.py`, `schedule_test_helper.py` (`solver` arg), `test_cli.py` (`solver` arg). | CP-SAT is the only solver in the product. T01 vendored a CP-SAT-only snapshot. U31 kept that boundary on purpose (manifest, "CP-SAT stays the only solver"). The three edited library files are byte-identical to v1 `7d1c220`. | DEV: `ac3e3ee`, `2f86e7c` (lint), `034fbf6` (PuLP model-owned APIs, `model_build_stats.py`), solver files touched by 2-3 commits each. GENIE-MERGE: `solver_pulp.py` +60/-156. | Absent in v2. Present in genie. `test_solver_pulp_cbc.py` is also absent in genie, so that one deletion is now equivalent. | Restore is mechanical, because the files are separate modules. The v2 edit to `scheduler.py` overlaps D02 and D04. | NEEDS DECISION (see Q1). Recommend: restore the v1 library files verbatim and keep the CP-SAT-only rule at the HTTP boundary only (`server/scheduling_input.py`, `server/api/optimize.py`). | M | Low. The optional wheels stay optional: genie `requirements.txt` has `pulp` only, `highspy`/`pyscipopt` are in `requirements-optional.txt`. |
| D02 | (d), fixes a bug | `0997903` | `scheduler.py` (return type, `UNKNOWN` branch), `cli.py`, `tests/test_cli.py`, `tests/test_scheduler.py` | v2 returns a positional 5-tuple and raises `ValueError` on `UNKNOWN`. This is the pre-`2f24d31` v1 behavior that T01 vendored. The manifest records "positional tuple return, no solver argument" as a runner adaptation. | DEV: `2f24d31` (2026-07-15, in the merge base) added `ScheduleResult` and the `UNKNOWN` return. Later: `aee23bc` adds `forced_solution`, `9ff14d1`, `86ce350`, `4e9aea2`. | Conflicts. Genie keeps `ScheduleResult`. | `ScheduleResult` is a `NamedTuple`, so the positional unpack in `server/jobs/runner.py` keeps working. The v2 runner then receives `UNKNOWN` and its `INCONCLUSIVE` branch becomes live (see Summary item 4). | Adopt verbatim. Take the genie `scheduler.py` and re-apply D06 on top. | S | Low. Add one runner test that uses the real scheduler with a short timeout. |
| D03 | (d) | `0997903`, U31 mapping (`05b6e0d`) | deleted `server/solver_capabilities.py`, `tests/real/solver_capabilities.py`, `tests/test_real_solver_capabilities.py`. Edited `server/jobs/models.py` (`STOPPABLE_SOLVERS = {ortools/cp-sat}`, keeps `solver_supports_stop`), `server/errors.py` (keeps `OptimizationExecutionError`), `server/jobs/process_executor.py` (child `except OptimizationExecutionError` bridge), `server/jobs/runner.py` (raise, not return, `JobFailure`), `tests/real/README.md`. Added `scripts/solver_capability_probe.py`, `scripts/README.md`, `scripts/__init__.py`, `tests/test_real_solver_capability_probe.py`, `pyproject.toml` `testpaths`. | U31 refused the multi-solver registry and the upstream `JobFailure`-return refactor. The probe moved to `scripts/` so pytest never collects the slow real-solver rounds. | DEV: `ac3e3ee`, `2f86e7c` on `runner.py`/`process_executor.py`. GENIE-MERGE: `solver_capabilities.py` -8 lines, `tests/real/solver_capabilities.py` +10/-34, `tests/real/README.md` +92/-13. | Conflicts. | If D01 is restored, the registry works unchanged for CP-SAT. The `raise` style in the v2 runner is the only reason for the `errors.py` and `process_executor.py` patches. | Adopt with adaptation: take `solver_capabilities.py` and the upstream `JobFailure`-return runner. Keep the probe in `scripts/` only if the v1 `tests/real/` layout is not acceptable. | M | Medium. Roster-container failure codes (D11) raise through `OptimizationExecutionError` today and must move to the return style. |
| D04 | (a) | `556740a` (B1) | `scheduler.py` (`on_roster` keyword, `_build_roster_payload`), `tests/test_scheduler_on_roster.py` | Additive callback that hands the solved day-state grid and worksheet coordinates to the roster viewer. Return arity is unchanged. | DEV: `4e9aea2` (context becomes a dataclass that composes the validated scenario), `86ce350` (compiled references), `aee23bc` (`forced_solution`). GENIE-MERGE: `scheduler.py` LEAVE port. | Absent. | `_build_roster_payload` reads `ctx.people.items`, `ctx.dates.items`, `ctx.shiftTypes.items`, `ctx.offs`, `ctx.leaves`, `ctx.shifts`. Each name must be checked against the genie `Context` after `4e9aea2`. UNVERIFIED which names changed. | Adopt with adaptation. Also a (c) candidate: a structured roster handoff is generic. | M | Medium. The coordinate-parity test protects the exporter geometry. |
| D05 | (a) | `e220807` | `models.py` (`Person.temporary: StrictBool \| None`), `tests/test_models_validation.py` | Authoring-only flag for a nurse borrowed from another ward. The solver ignores it. The assistant reads it (bead `nursing-sheduler-jsx`). | DEV: `9ff14d1`, `a64094a`, `86ce350`, `c571665` (models rewrite). `9ff14d1` adds `frontend_validation.py` with per-field `Person` checks. | Absent. | Small additive field. `frontend_validation.py` in genie can reject unknown frontend shapes. UNVERIFIED whether it needs a rule for `temporary`. | Adopt with adaptation. Offer upstream as (c) if the v1 web app wants borrowed staff. | S | Low |
| D06 | (a), (c) | `3e4bc25`, `fd98a98`, `8237006` | `models.py` (`SkillMixEntry`, `skillMix`, `validate_skill_mix`), `preference_types.py` (skill-mix floor), `server/scheduling_errors.py` (union-branch wrapper regex), `server/workspace.py` (group reference check), `tests/test_skill_mix.py`, `tests/test_server_scheduling_input.py` | A shift requirement can demand "at least k of group G" without banning anyone else. Spec: `docs/superpowers/specs/2026-09-24-skill-mix-rules.md`. | DEV: `a64094a` (moves validation into `models.py`), `86ce350` (compiled references), `4e9aea2`. | Absent. | The v2 code uses `utils.parse_pids(entry.people, ctx.map_pid_p)`. Genie still has `utils.parse_pids`, but `map_pid_p` is now a compiled `_FrozenMapping` (genie `models.py:615`, `:1187`). The reference check belongs in the new compile step, not in `preference_types.py`. | Adopt with adaptation. Offer upstream (generic rostering need). | M | Medium |
| D07 | (a), (c) | `dbab7c4` | `models.py` (`requiredNumPeopleOverrides`, two validators), `preference_types.py` (per-date `required`), `tests/test_requirement_overrides.py` | Per-date staffing exceptions on one requirement (for example 14 Oct: 2 to 1). Bead `nursing-sheduler-2se`. | Same as D06. | Absent. | Same compile-step move as D06. The date must resolve through the genie compiled date map. | Adopt with adaptation. Offer upstream. | M | Medium |
| D08 | (a) | `c83592a` (T19), `c42b9fa`, `8248a74` | new: `server/canonical.py`, `server/scheduling_errors.py`, `server/scheduling_input.py`, `server/workspace.py`, `server/event_cursor.py`. Edited: `server/api/optimize.py` (Workspace conversion, replay, opaque cursor), `server/job_store.py` (`prepare_event_replay`), `server/stores/memory.py`, `server/stores/redis.py` (replay snapshot), `server/jobs/models.py` (`EventReplayWindow`), `requirements.txt` (pinned `ruamel.yaml==0.19.1`, `pydantic==2.13.4`) | The browser posts Workspace V1 YAML. The backend validates it with source-path 422 issues and canonicalizes it before a job exists. SSE uses opaque, job-bound cursors with `409 event_cursor_expired`. `8248a74` removed the guided-rules contract. | DEV: `9ff14d1` (YAML bounds, reference checks in `NurseSchedulingData`), `3a77ad4` (alias-expansion bound), `1990a1e` (nesting depth, read off event loop), `190c587`, `2f46c41`, `8142e57`, `3de3609` (auth on `optimize.py`). | Partial overlap. | The v1 checks in `9ff14d1`/`86ce350` now resolve people, shift-type and date references at model validation. The v2 `workspace.py` reference checks (T19b item 1) partly duplicate them. The 422 source-path envelope stays v2-only. | Keep as a patch. Rebase `workspace.py` reference checks on the v1 compiled validation where the error path can still be mapped. | L | High. `optimize.py` has 16 upstream commits. |
| D09 | (a) or (b), NEEDS DECISION | `c83592a` (T19, T19a, T19b), `0647f01` | `server/jobs/controller.py`, `server/jobs/worker.py`, `server/job_store.py`, `server/stores/memory.py`, `server/stores/redis.py` (Lua `TIME` commit fence), `server/maintenance.py` (liveness), `server/app.py` (`/health` fails closed on stalled maintenance) | Mandatory worker identity plus observed-deadline precondition on every worker write, checked atomically in the store. Maintenance liveness feeds `/health` and `/ready`. | DEV: `0249f67` (shared renewable worker leases, activity), `ab71cfd` (explicit lease tokens, atomic ownership), `fec52e1` (shutdown lease race), `23a77bb` (release lease after report failure), `68e2ef9`, `98dad42`, `de019fd`, `00aee65` (outage handling). | Conflicts. Both sides solved the same problem (a stale worker must not commit) in different ways. | v1 now fences with lease tokens on a per-worker lease. v2 fences with owner plus per-job deadline. Both cannot stay. | NEEDS DECISION (see Q2). Recommend: take the v1 lease-token model (b) and port only the v2 maintenance liveness gate if v1 has no equal. | L | High |
| D10 | (a), (c) | `c83592a` (U30a, U30d, U30e) | `server/diagnostic.py`, `server/app.py` (`/info` plus retained `/health`), `server/config.py` (`max_pending_jobs` 32 to 8), `tests/test_public_diagnostic.py` | Diagnostic `expected_concurrency` default 3 to 1. `api_path_mode` (`backend`/`bff`) routes every request through one path builder. Idempotent cleanup treats GET/DELETE 404 as confirmed deletion. `/health` is kept for v2 compatibility. | DEV: `8142e57`, `073951e` (auth), `bc68e90`, `87fe931` (Sentry for side processes), `ac3e3ee`. | Conflicts in `diagnostic.py` (+92/-48 upstream). | `api_path_mode` and idempotent cleanup are generic. The two defaults are deployment choices. | Offer `api_path_mode` and cleanup upstream (c). Move `expected_concurrency=1` and `JOB_MAX_PENDING=8` to environment values in `docker/` and take the v1 defaults (d). Keep `/health` only if the BFF still calls it (lane question). | M | Medium |
| D11 | (a) | `556740a`, `0e02bb1` (B2) | new `server/roster_container.py`. Edited `server/jobs/runner.py` (stores the container as the single artifact), `server/api/optimize.py` (`/xlsx` extracts the workbook, new `/roster`). Tests: `test_roster_container.py`, `test_roster_routes.py`, `test_runner_termination.py`. | Deterministic `roster-container/1` JSON with the workbook embedded, for the in-app roster viewer. | DEV: `optimize.py` commits in D08, `ac3e3ee`, `2f86e7c` on `runner.py`. | Absent. | `/xlsx` in genie streams the raw artifact. The v2 route decodes the container. The auth dependency from `8142e57` must wrap `/roster` too. | Keep as a patch. Rebase on the genie `optimize.py`. | M | Medium |
| D12 | (d) or (b) | `030b6a7` | `server/app.py` (`get_app_version`), `tests/test_app_version.py` | Version order: `APP_VERSION` env, then `git describe` when `.git` exists, then `v0.0.0-unknown`. | DEV: `3621c6b`, `5af0419`. Genie `server/app.py:63-85` reads `.app-version` first, then `git describe`. New `version.py` in dev. | Near-equivalent. | Only the source differs: env value versus generated file. | Take v1 `get_app_version`/`version.py` and make the v2 Docker build write `.app-version`, or keep a 5-line env fallback patch. See Q5. | S | Low |
| D13 | (a) | `e6d4208` (T08) | new `server/optimize_basis.py`, `server/basis_admission.py`, `server/semantic_profile.py`. Edited `server/api/schemas.py` (basis, outcome, `parent_basis_id`), `server/jobs/models.py` (`JobPurpose`, `INCONCLUSIVE`, basis fields), `server/jobs/runner.py` (`INCONCLUSIVE` reasons), `server/jobs/controller.py`, `server/stores/redis.py`, `server/app.py` (`/info` profile), `server/scheduling_errors.py` (basis codes). Tests: `test_optimize_basis.py`, `test_optimize_basis_admission.py`, `test_runner_inconclusive.py`, `test_job_response_contract.py`. | The assistant binds evidence to a canonical submission identity (`basis_id`) and a semantic profile. The server recomputes and rejects a mismatched claim before a job exists. `INCONCLUSIVE` separates "no proof" from failure. | DEV: `417d632`, `eacd021` (`/optimize/options`, `solver_options.py`, `schemas.py` +80), `5af0419` (claimed performance in `/info`), `8142e57` (auth in `schemas.py`). v1 `OptimizationOutcome` has `OPTIMAL`, `FEASIBLE`, `INFEASIBLE` only. | Absent. Partial overlap on `/info` and `schemas.py`. | `SOLVER_SEMANTIC_VERSION = "ortools/cp-sat@1"` assumes one solver. If D01 is restored, the basis already binds `normalized_options.solver`, so no change is needed. `INCONCLUSIVE` is a (c) candidate for v1. | Keep as a patch. Offer `INCONCLUSIVE` upstream. | L | High |
| D14 | (a) | `39e26f1` (T09) | new `server/queue_state.py`, `server/stores/queue_script.py` (single Redis Lua state machine). Edited `server/stores/memory.py` (+278), `server/stores/redis.py` (+768/-188), `server/config.py` (`ordinary_reserved_slots`, key prefix `v0` to `v1`), `server/errors.py` (`DiagnosticCapacityError`, `QueueInvariantError`), `server/job_store.py`, `server/jobs/controller.py`, `server/jobs/models.py`, `server/maintenance.py`, `server/api/schemas.py`, `server/api/optimize.py`, `server/app.py`. Tests: `server_support.py`, `test_server_priority_queue.py`. | Two purpose queues (ordinary first, assistant diagnostic second) with a reserved ordinary slot, so assistant probes never block a user's Optimize. | DEV: `0249f67`, `ab71cfd`, `fec52e1` (queue/claim/lease code in both stores), `ae61142`, `2205039`, `6a868fc` (usage telemetry in `redis.py`). | Absent. Conflicts. | This is the deepest structural conflict. v1 changed claim and lease code in the same store methods that T09 replaced with one Lua script. | Keep as a patch, but re-implement it on top of the v1 lease model after Q2. | L | High |
| D15 | (a) | `224b8eb`, `6144ff4` | `server/api/optimize.py`, `server/jobs/controller.py`, `server/jobs/process_executor.py`, `server/jobs/worker.py`, `server/scheduling_errors.py`, `tests/test_process_executor.py`, `tests/test_server_api.py`, `tests/test_server_backend_parity.py` | UK spelling ("optimise") in every user-visible backend message. Machine codes are unchanged. | DEV: the same four files carry 2-17 upstream commits each. | Absent. | Each changed string is a small textual conflict at every sync. | Move the spelling to the BFF or web message layer and take the v1 strings (d). If that is not accepted, keep a patch. See Q4. | S | Low |
| D16 | (a), (c) | `0997903`, `556740a` | `pyproject.toml` (`requires-python >=3.12`, `testpaths = ["tests"]`, explicit `tool.ruff.lint.select`, `target-version = py312`), `requirements.txt` (pinned `ruamel.yaml`, `pydantic`, `ruff==0.15.22`, comments) | Reproducible gates: a new Ruff release cannot silently widen the rule set. Pins define the golden canonical bytes. | DEV: `14258d2` (`requires-python >=3.12`), `ac3e3ee`, `3e1a59c` (split into `requirements-optional.txt`), `9802cb0`, `d4535d8`, `b20aa81`, `11a1b84` (AI dependencies). | `requires-python` is now equivalent (b). The rest conflicts. | v1 keeps Ruff `target-version = py310` and unpinned `ruff`, `pydantic`, `ruamel.yaml`. | Take v1 `requires-python`. Keep the `testpaths`, lint `select` and pins as a small patch, and offer the Ruff pin upstream (c). | S | Low |
| D17 | (d) | T19 note (excluded) | deleted `core/AGENTS.md` | The upstream contributor guide was not vendored because repository instructions govern v2. | DEV and GENIE: 50 commits, genie +194/-13. | Absent. | None at runtime. | Restore verbatim (d). It removes one diff entry and costs nothing. Optional. | S | None |
| D18 | (a) | `c83592a` | deleted `tests/test_serve.py`, `tests/test_optimize_job_backends.py`. Added `tests/conftest.py`, `tests/test_server_api.py`, `test_server_backend_parity.py`, `test_server_controller_retry.py`, `test_server_identity.py`, `test_server_lifecycle_gates.py`, `test_server_replay.py`, `test_server_scheduling_input.py`, `test_server_store_contract.py`, `test_server_worker_loss.py`, `test_server_worker_loss_multiprocess.py`, `test_process_executor.py` (+323), `test_public_diagnostic.py` (+347) | T19 replaced the monolithic server tests with suites that parametrize over memory, fakeredis and real Redis. `git diff` shows `conftest.py` as a rename of `test_schedule_pulp_cuopt.py`. That is a similarity artifact: the file is new. | DEV: `test_serve.py` 29 commits (+1,232/-70), `test_optimize_job_backends.py` 3 commits, `test_process_executor.py` 4, `test_public_diagnostic.py` 4. | Conflicts. | New upstream server tests cannot be ported file-to-file. Each one needs a manual map into a `test_server_*` suite. | If Q2 takes the v1 lease model, restore `test_serve.py` and `test_optimize_job_backends.py` and delete the v2 suites that test the replaced fence. Otherwise keep and map by hand. | L | Medium |
| D19 | (a) | `0e02bb1`, several | added `tests/test_ward_shift_patterns_roster.py`, `tests/test_sg_compliance_roster.py`, `tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml`, `tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml`, `tests/fixtures/assistant_repair/*.yaml` (20 files), `tests/test_assistant_repair_fixtures.py` | Real ward scenarios and assistant repair fixtures that prove the solver side of v2 product flows. | None (new paths). No add/add collision in `dev` (checked every added path with `git cat-file -e dev:<path>`). | Absent. | None. | Keep. The SG compliance case is a (c) candidate for the genie branch. | S | None |
| D20 | (a) | catalogue-oracle note (2026-07-27) | added `tests/catalogue_oracle.py`, `tests/test_catalogue_oracle_g7.py` | Test-only CP-SAT oracle that proves the web conflict-catalogue check G7 is sound. | None. | Absent. | None. | Keep. | S | None |

## 4. Dependencies and order

1. Q2 (lease model) must be decided first. D09, D14 and D18 all depend on it, and D14 is the largest single patch.
2. D01 and D02 before D04, D06 and D07. The scheduler and model files must be the genie versions before the v2 feature patches are re-applied.
3. D02 before D13. The `INCONCLUSIVE` path needs a scheduler that returns `UNKNOWN`.
4. D03 after D01. The capability registry needs the restored solver ids.
5. D03 before D11. The roster-container failure codes move from `raise` to `JobFailure` return.
6. D08 before D11, D13 and D14. They all edit the rebased `optimize.py`.
7. D06 before D07. Both edit `validate_*` on `ShiftTypeRequirementsPreference`, and the D07 override validator checks the skill-mix floor.
8. D12, D15, D16, D17, D19 and D20 are independent. They can land at any point.

## 5. Open decisions

Q1. Restore the non-CP-SAT solvers in `core/` (D01)?
Recommendation: yes, at library level. Keep the product boundary CP-SAT-only in `server/scheduling_input.py` and `server/api/optimize.py`. This removes five deleted modules, the `scheduler.py`/`cli.py`/`model_build_stats.py`/`solver_interface.py` edits and about 15 deleted test files from the patch set. Future v1 solver fixes then apply without conflict.

Q2. Which worker fence model wins (D09)?
Recommendation: take the v1 lease-token model from `0249f67`/`ab71cfd`/`fec52e1`/`23a77bb`. It is where upstream fixes will continue to land. The v2 fence (T19) has strong tests, but it is the main reason `redis.py` and `worker.py` cannot sync. Re-run the v2 multiprocess `SIGKILL` gate and the delayed-commit probes against the v1 model before you accept it.

Q3. Keep T09 priority queues as one Lua script (D14)?
Recommendation: keep the product rule (ordinary first, one reserved slot). Re-implement it after Q2 as the smallest change to the v1 claim path. Offer the purpose queue upstream only if v1 wants assistant probes on the job server.

Q4. Keep UK spelling in backend messages (D15)?
Recommendation: no. Take the v1 strings and map them in the BFF or web layer. The spelling is a presentation rule, and backend strings conflict at every sync.

Q5. Version source (D12)?
Recommendation: take the v1 `get_app_version` and `version.py`. Make the v2 Docker build write `.app-version` from `APP_VERSION`. The runtime result is the same and the patch disappears.

Q6. Deployment defaults (`JOB_MAX_PENDING=8`, diagnostic `expected_concurrency=1`, D10)?
Recommendation: take the v1 defaults in code. Set the v2 values in `docker/` environment files.

## 6. Proposed minimal patch set (core reset to `feature/genie`)

If `core/` is reset to `feature/genie` `1bf4b85`, and Q1, Q2, Q4, Q5 and Q6 follow the recommendations, these v2-only changes remain. Everything else is taken from v1.

Solver core (4 patches, all additive):

1. P1 `Person.temporary` (D05): `models.py`, one test file.
2. P2 skill mix (D06): `models.py`, `preference_types.py`, compile-step reference check, `test_skill_mix.py`.
3. P3 per-date overrides (D07): `models.py`, `preference_types.py`, `test_requirement_overrides.py`.
4. P4 `on_roster` callback (D04): `scheduler.py`, `test_scheduler_on_roster.py`.

Server (5 patches):

5. P5 Workspace boundary (D08): new `canonical.py`, `scheduling_errors.py`, `scheduling_input.py`, `workspace.py`, and their wiring in `api/optimize.py`. The skill-mix wrapper regex from D06 lives in `scheduling_errors.py`.
6. P6 opaque SSE cursor and replay snapshot (D08): new `event_cursor.py`, `prepare_event_replay` in `job_store.py` and both stores. This part can be offered upstream (c).
7. P7 roster container (D11): new `roster_container.py`, `runner.py` artifact, `/xlsx` and `/roster` in `api/optimize.py`.
8. P8 semantic basis and `INCONCLUSIVE` (D13): new `optimize_basis.py`, `basis_admission.py`, `semantic_profile.py`, plus `schemas.py`, `jobs/models.py`, `runner.py`, `controller.py`, `app.py`.
9. P9 purpose queues (D14): re-implemented on the v1 lease model.

Offer upstream, then drop from the patch set when merged: `api_path_mode` and idempotent cleanup in `diagnostic.py` (D10), `INCONCLUSIVE` (D13), the Ruff pin and `testpaths` (D16), skill mix and per-date overrides (D06, D07).

Tooling patch (P10, small): `pyproject.toml` `testpaths` and lint `select`, pinned `ruamel.yaml`/`pydantic` in `requirements.txt` (D16).

Test-only additions (no conflict risk): D18 suites that still apply after Q2, D19 and D20.

Drop from v2 and take v1: D01, D02, D03, D12, D15, D17, the `/health` compatibility shim if the BFF no longer calls it, and the fork-layer copies of LEAVE, hours contract, working time and covering. The genie merge `1b6f7e5` already re-implemented these on the compiled core.

## 7. Coverage note

Every path from `git diff --no-index --name-status $T/core core` (123 paths, `__pycache__` skipped) maps to one row.

| Path | Row |
| --- | --- |
| `core/AGENTS.md` | D17 |
| `core/nurse_scheduling/cli.py` | D01, D02 |
| `core/nurse_scheduling/model_build_stats.py` | D01 |
| `core/nurse_scheduling/models.py` | D05, D06, D07 |
| `core/nurse_scheduling/preference_types.py` | D06, D07 |
| `core/nurse_scheduling/scheduler.py` | D01, D02, D04 |
| `core/nurse_scheduling/solver_interface.py` | D01 |
| `core/nurse_scheduling/solver_ortools_linear.py` | D01 |
| `core/nurse_scheduling/solver_ortools_mathopt.py` | D01 |
| `core/nurse_scheduling/solver_pulp.py` | D01 |
| `core/nurse_scheduling/solver_pulp_glpk.py` | D01 |
| `core/nurse_scheduling/solver_pulp_python.py` | D01 |
| `core/nurse_scheduling/server/api/optimize.py` | D08, D11, D13, D14, D15 |
| `core/nurse_scheduling/server/api/schemas.py` | D13, D14 |
| `core/nurse_scheduling/server/app.py` | D09, D10, D12, D13, D14 |
| `core/nurse_scheduling/server/basis_admission.py` | D13 |
| `core/nurse_scheduling/server/canonical.py` | D08 |
| `core/nurse_scheduling/server/config.py` | D10, D14 |
| `core/nurse_scheduling/server/diagnostic.py` | D10 |
| `core/nurse_scheduling/server/errors.py` | D03, D14 |
| `core/nurse_scheduling/server/event_cursor.py` | D08 |
| `core/nurse_scheduling/server/job_store.py` | D08, D09, D14 |
| `core/nurse_scheduling/server/jobs/controller.py` | D09, D13, D14, D15 |
| `core/nurse_scheduling/server/jobs/models.py` | D03, D08, D13, D14 |
| `core/nurse_scheduling/server/jobs/process_executor.py` | D03, D15 |
| `core/nurse_scheduling/server/jobs/runner.py` | D03, D11, D13 |
| `core/nurse_scheduling/server/jobs/worker.py` | D09, D15 |
| `core/nurse_scheduling/server/maintenance.py` | D09, D14 |
| `core/nurse_scheduling/server/optimize_basis.py` | D13 |
| `core/nurse_scheduling/server/queue_state.py` | D14 |
| `core/nurse_scheduling/server/roster_container.py` | D11 |
| `core/nurse_scheduling/server/scheduling_errors.py` | D06, D08, D13, D15 |
| `core/nurse_scheduling/server/scheduling_input.py` | D08 |
| `core/nurse_scheduling/server/semantic_profile.py` | D13 |
| `core/nurse_scheduling/server/solver_capabilities.py` | D03 |
| `core/nurse_scheduling/server/stores/memory.py` | D08, D09, D14 |
| `core/nurse_scheduling/server/stores/queue_script.py` | D14 |
| `core/nurse_scheduling/server/stores/redis.py` | D08, D09, D13, D14 |
| `core/nurse_scheduling/server/workspace.py` | D06, D08 |
| `core/pyproject.toml` | D03, D16 |
| `core/requirements.txt` | D01, D08, D16 |
| `core/scripts/README.md`, `core/scripts/__init__.py`, `core/scripts/solver_capability_probe.py` | D03 |
| `core/tests/catalogue_oracle.py`, `core/tests/test_catalogue_oracle_g7.py` | D20 |
| `core/tests/conftest.py` (shown as rename of `test_schedule_pulp_cuopt.py`) | D18 (new file), D01 (deleted cuOpt test) |
| `core/tests/fixtures/assistant_repair/*.yaml` (20 files), `core/tests/test_assistant_repair_fixtures.py` | D19 |
| `core/tests/real/README.md`, `core/tests/real/solver_capabilities.py`, `core/tests/test_real_solver_capabilities.py`, `core/tests/test_real_solver_capability_probe.py` | D03 |
| `core/tests/schedule_test_helper.py`, `core/tests/test_solver_interface.py` | D01 |
| `core/tests/server_support.py` | D14, D18 |
| `core/tests/test_app_version.py` | D12 |
| `core/tests/test_cli.py`, `core/tests/test_scheduler.py` | D01, D02 |
| `core/tests/test_job_response_contract.py`, `core/tests/test_optimize_basis.py`, `core/tests/test_optimize_basis_admission.py`, `core/tests/test_runner_inconclusive.py` | D13 |
| `core/tests/test_models_validation.py` | D05 |
| `core/tests/test_optimize_job_backends.py`, `core/tests/test_serve.py` | D18 |
| `core/tests/test_process_executor.py`, `core/tests/test_public_diagnostic.py` | D18 (U31, U30d, U30e), D15 |
| `core/tests/test_requirement_overrides.py` | D07 |
| `core/tests/test_roster_container.py`, `core/tests/test_roster_routes.py`, `core/tests/test_runner_termination.py` | D11 |
| `core/tests/test_schedule_ortools_mathopt_cp_sat.py`, `..._mathopt_gscip.py`, `..._mathopt_highs.py`, `..._mpsolver_bop.py`, `..._mpsolver_cbc.py`, `..._mpsolver_cp_sat.py`, `..._mpsolver_scip.py`, `test_schedule_pulp_glpk.py`, `test_schedule_pulp_highs.py`, `test_schedule_pulp_scip.py` | D01 |
| `core/tests/test_scheduler_on_roster.py` | D04 |
| `core/tests/test_server_api.py`, `test_server_backend_parity.py`, `test_server_controller_retry.py`, `test_server_identity.py`, `test_server_lifecycle_gates.py`, `test_server_replay.py`, `test_server_scheduling_input.py`, `test_server_store_contract.py`, `test_server_worker_loss.py`, `test_server_worker_loss_multiprocess.py` | D18 |
| `core/tests/test_server_priority_queue.py` | D14 |
| `core/tests/test_sg_compliance_roster.py`, `core/tests/test_ward_shift_patterns_roster.py`, `core/tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml`, `core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml` | D19 |
| `core/tests/test_skill_mix.py` | D06 |
| `core/tests/test_solver_ortools_linear.py`, `test_solver_ortools_mathopt.py`, `test_solver_pulp_cbc.py`, `test_solver_pulp_glpk.py`, `test_solver_pulp_python.py` | D01 |

Unverified items:

- D04: which `Context` attribute names changed in `4e9aea2`. The report did not diff the genie `context.py` field by field.
- D05: whether the genie `frontend_validation.py` needs a rule for `Person.temporary`.
- Summary item 4: the `UNKNOWN` bug comes from code reading of `core/nurse_scheduling/scheduler.py:365-379` and `server/jobs/runner.py`. No real timeout run was done.
- Q2: the report did not compare the v1 lease-token fence against the v2 delayed-commit and `SIGKILL` gates. That comparison is the acceptance test for the recommendation.
