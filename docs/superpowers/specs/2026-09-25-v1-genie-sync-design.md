# v1 genie sync: design

Date: 2026-09-25. Status: approved in conversation, pending written review.

Evidence: `docs/research/2026-09-25-v1-sync/` (summary `00-summary.md`, lane reports `01` to `07`).

## 1. Intent

v2 is a frontend rebuild (`web/`) with a vendored Python backend (`core/`). The v1 upstream in `/home/kenan/work/nurse-scheduling` kept moving after v2 last synced. This work brings those upstream changes into v2 `develop`.

Success criteria:

1. v2 `core/` is as close to upstream as the v2 product allows. Every remaining difference is listed in one table with a reason.
2. The next upstream sync is mechanical: one `git diff` between two upstream pins, read against that table.
3. v1 user-facing features and fixes that v2 lacks are tracked as beads.
4. The v2 product does not change behavior, except for the listed fixes.

## 2. Decisions

| ID | Decision |
| --- | --- |
| X1 | The upstream target is v1 branch `feature/genie` at `1bf4b85`. The old pin `d63519b` is a genie commit. Its merge base with v1 `dev` is `89190ab`. Genie contains all of `dev` through merge `1b6f7e5`. |
| X2 | Sync method C, split by layer. The solver core resets to genie. The server layer adopts upstream changes file by file. |
| X3 | Keep the v2 worker fence (T19 Lua `TIME` fence) and the T09 ordinary-first queue for this sync. Record them as a deviation. Adopting the v1 worker lease registry is a separate, later decision. |
| X4 | Restore the genie multi-solver library. The product stays CP-SAT only through the server boundary and the solver allowlist. |
| X5 | Exclude the v1 Python AI package (`core/nurse_scheduling/ai/`, `ai_serve.py`). Study it to improve the v2 assistant (W4). |
| X6 | No Sentry, no suspicion reports, no usage telemetry, no `usage-reporter` service. This matches genie for Sentry and suspicion. Telemetry is excluded because it writes inside the Redis store transactions that v2 keeps (X3). |
| X7 | Vendor `server/auth.py` and leave auth off. The v2 backend is private behind the web BFF. |
| X8 | Adopt the new `/info` keys and API version `0.2.0`, with the paired BFF parser change in the same commit. |
| X9 | Remove `country` from the core model, as genie does. Workspace V1 input still accepts `country` and drops it, so that old saved files load. `web/` stops sending it. |
| X10 | Take the upstream message text, `version.py` and the default config values. v2-specific values move to `docker/` environment files. Spelling for users is a web-layer concern. |
| X11 | Track v1 frontend gaps as beads (W3). |

## 3. Workstreams

```text
W0 foundations ──> W1 solver core (one branch) ──> W2 server (small commits) ──> W5 manifest and recipe
W3 frontend beads and W4 AI study: independent, no core code
```

Each code workstream uses its own branch from `develop` in its own worktree, and merges back into `develop` (see `CLAUDE.md`, branch and deploy flow).

### W0: foundations

W0 makes CI gate every later step.

1. Split `core/requirements.txt` into runtime and `requirements-optional.txt`, in the genie form (lane 05 L5-01). The v2 patch keeps the `ruamel.yaml==0.19.1` and `pydantic==2.13.4` pins, because canonical YAML bytes depend on them. It also leaves out the packages that only `ai/` imports: `psycopg`, `e2b`, `Pillow`, `defusedxml`, `pypdf` and `pypdfium2`.
2. Make the production image install only the runtime file. `pytest`, `pytest-cov`, `ruff` and `fakeredis` leave the image.
3. Add a Linux core CI job to `.github/workflows/ci.yml`: `ruff check`, and `pytest` with a real Redis service (lane 05 L5-10). No macOS or Windows jobs.
4. Record the new baseline in `docs/T19-upstream-backend-source-manifest.md`: target `feature/genie` `1bf4b85`, old pin `d63519b`, merge base `89190ab`.

Acceptance: the new CI job runs on a pull request and passes on current `develop`.

### W1: solver core reset

Scope: every module in `core/nurse_scheduling/` outside `server/` and `ai/`, and their tests. W1 lands as one branch, because the genie files alone break the v2 skill-mix, override and `on_roster` tests.

Take verbatim from genie `1bf4b85`:

- `cli.py`, `constants.py`, `context.py`, `exporter.py`, `group_map.py`, `loader.py`, `model_build_stats.py`, `models.py`, `preference_types.py`, `report.py`, `scheduler.py`, `solver_interface.py`, `solver_ortools_cp_sat.py`, `utils.py`.
- The restored solver modules: `solver_ortools_linear.py`, `solver_ortools_mathopt.py`, `solver_pulp.py`, `solver_pulp_glpk.py`, `solver_pulp_python.py`.
- The matching genie tests, the assignment fixture and the score ground-truth replay (lane 01 C06). Not the Docker performance benchmark.
- `pulp==3.3.2` in the runtime requirements. `highspy` and `pyscipopt` in the optional file.

This take brings in the compiled-schedule API, `ScheduleResult`, the YAML expansion and nesting bound, `forced_solution`, and the genie LEAVE, `hoursContract`, covering and working-time code. `ScheduleResult` returns status UNKNOWN, so the v2 INCONCLUSIVE runner branch can run with the real scheduler.

Apply the v2 patches again (lane 01 section 2c):

| Patch | Change on the genie code |
| --- | --- |
| P1 `Person.temporary` | One `StrictBool` field on `Person`. |
| P2 `skillMix` | Keep the field validator. Add the resolved floors to `CompiledShiftTypeRequirements`. Unknown people fail at load time. |
| P3 per-date overrides | Add `required_by_date` to `CompiledShiftTypeRequirements`. A date outside the requirement fails at load time, not at solve time. |
| P4 `on_roster` | Read `ctx.scenario` and `ctx.compiled_schedule`. Keyword-only, after `forced_solution`. |

P2 and P3 edit the same compile step and handler, so they land together.

Adapt the callers in the same branch:

- `server/workspace.py`: move the ordered shift-type map loop out of `group_map.build_shift_type_index_map` (removed on genie) into `workspace.py`. `group_map.py` stays equal to genie.
- `server/scheduling_input.py`: call `loader.measure_yaml_expansion` before canonicalization. Reject with 400.
- `server/scheduling_errors.py`: place the new root-level validation errors correctly (lane 01, UNVERIFIED item).
- `server/workspace.py`: accept and drop `country`. Stop emitting it in `web/lib/scenario/canonical.ts` and the other emitters. Remove it from the 2 SG test cases.
- The server keeps rejecting any solver other than CP-SAT (`server/scheduling_input.py`).

Acceptance:

1. Every W1 file in the verbatim list is byte-identical to genie `1bf4b85`, except the lines of P1 to P4.
2. The full core suite, the genie score ground-truth replay and all real test cases pass.
3. A new test runs the real scheduler to UNKNOWN (timeout with no incumbent) and gets the INCONCLUSIVE job outcome.
4. The web unit tests pass with `country` removed.

### W2: server adoption

W2 keeps these v2 server designs, because upstream has no equivalent or X3 keeps them: Workspace input and canonical YAML, the 422 envelope, opaque event cursors, the roster container, basis admission and the semantic profile, the T19 fence, the T09 queue, maintenance liveness, and the `/health` shim.

Land in this order, one commit each where possible (lane 02 section 3, lane 03 section 3):

1. `retry.py` `RepeatedFailure` verbatim. Outage backoff in the maintenance and claim loops. Keep the maintenance backoff cap inside the v2 liveness window (`LIVENESS_INTERVAL_FACTOR`), so that `/ready` does not fail after recovery.
2. The Darwin process-tree kill retry (`jobs/process_tree.py`) with its tests.
3. `request_limits.py` verbatim, wired in `app.py`. Map the code `request_too_large` to kind `too-large` in `web/lib/bff/errors.ts`.
4. `version.py` verbatim. The v2 Docker build writes `.app-version` from `APP_VERSION`. `app.py` imports `version.py`, so only one copy exists.
5. `auth.py` verbatim, with auth off by default. `solver_capabilities.py` and `solver_options.py` verbatim, with the default allowlist `ortools/cp-sat`. The genie finish-now capability replaces the v2 `STOPPABLE_SOLVERS` adaptation.
6. Genie `config.py` verbatim, plus a small v2 patch for `ordinary_reserved_slots`. `JOB_REDIS_KEY_PREFIX=nurse_scheduling:jobs:v1`, `JOB_MAX_PENDING=8` and `OPTIMIZE_DEFAULT_PRETTIFY=false` move to `docker/` environment files. The inert telemetry settings stay, because they are part of the verbatim file. The rename from `claim_lease_seconds` to `worker_lease_seconds` does not apply, because X3 keeps the v2 lease.
7. `GET /optimize/options` in `api/optimize.py`.
8. `/info` gains `jobs` (from `describe_queue_state()`), `workers.online` (from `worker.is_alive()`), `auth` and `claimed_performance`. API version becomes `0.2.0`. The same commit extends `web/app/api/info/validate.ts` and `web/lib/query/event-payloads.ts` and their tests.
9. Ruff style changes land with each file they touch. Keep the v2 Ruff pin. Record any upstream Ruff violation that v2 ignores in the manifest.

Not adopted: the worker lease registry (X3), Sentry and suspicion (X6), usage telemetry and `usage_report.py` (X6), `ai_serve.py` and `frontend_validation.py` (X5).

Acceptance: the core suite and the web tests pass after each step. `/api/info` returns 200 with the new keys through the BFF. The real-Redis gates from T19 still pass.

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

1. A per-file origin table for every file in `core/`: `verbatim`, `patched` (with the patch ID), `v2-only`, or `excluded` (with the reason).
2. A sync recipe of a few commands: diff the old genie pin against the new genie head for `core/`, then act on each changed file by its origin class. `verbatim` files copy. `patched` files copy and re-apply the patch. `excluded` files skip.
3. The upstream candidates: the per-date overrides, `skillMix`, the INCONCLUSIVE outcome, opaque cursors and the T19 fence. Each one that upstream accepts moves from `patched` or `v2-only` to `verbatim`.

Acceptance: every file in `core/` has exactly one row, and the recipe runs on the current pins with no unexplained difference.

## 4. Risks

| Risk | Control |
| --- | --- |
| The W1 reset changes solver scores. | The genie score ground-truth replay and all real test cases gate W1. |
| `/api/info` breaks if the core and BFF changes ship apart. | W2 step 8 is one commit. |
| Upstream Ruff violations fail the v2 gate. | Fix or ignore per file, and record each one in the manifest. |
| Old saved files carry `country`. | Workspace input accepts and drops it (X9). |
| The maintenance backoff breaks readiness. | W2 step 1 keeps the backoff cap inside the liveness window. |

## 5. Out of scope

- The v1 worker lease registry (X3). Revisit after this sync.
- Wiring or vendoring the v1 Python AI service (X5).
- Any v2 frontend redesign. W3 only files beads.
