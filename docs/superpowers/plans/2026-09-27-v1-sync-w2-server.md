# v1 sync W2: server adoption Implementation Plan

Confidence: 6.9/10. The file-by-file diffs against genie `1bf4b85` were read in full. The genie W2 files pass the v2 Ruff 0.15.22 gate as they are (measured: `ruff check` and `ruff format --check` clean on all 16 source files and the 4 genie server test files). A `git apply -R` probe showed that a patch file can start with a comment header. The score is lower because W2 had no spike, unlike W1 and W6. The three largest rebases (`app.py`, `api/optimize.py`, `api/schemas.py`) must land in one commit. The tests ported from genie `test_serve.py` were chosen by name and not run. The Docker gates depend on local Docker.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use `- [ ]` boxes for tracking.

**Goal:** Every W2 server file becomes `verbatim` (byte-identical to genie `1bf4b85`) or `patched` (genie plus one recorded per-file patch). The v2 product keeps its behaviour, except for the changes that the spec lists. `check_upstream_sync.py` proves the result.

**Architecture:** Each W2 file starts from the genie copy. The v2 hunks named in this plan are then applied again. W2 does not rewrite or track the six W6 files (see Global Constraints). It adds only small shims there. With them, the genie W2 files can call `JobController.get_activity`, `JobWorker.is_ready` and the `auth_credential_id` keyword now. W6 replaces those files with genie. Each patched file gets one `core/upstream-patches/W2-<file>.patch`. Its comment header maps every hunk to a v2 patch ID, because the server features interleave within one file. The genie `test_retry.py` is taken verbatim. The genie `test_serve.py` coverage for auth, request limits and solver options is ported into one v2-only file. W6 deletes that file after it restores `test_serve.py`.

**Tech Stack:** Python 3.12, FastAPI/Starlette, Pydantic 2.13.4, Redis 8 (real and fakeredis), pytest, Ruff 0.15.22, TypeScript/Vitest and Playwright (`web/`), Docker Compose, git.

**Spec:** `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md`, section 3 (W2), with decisions X3, X6, X7, X8, X10 and X13. Evidence is in `docs/research/2026-09-25-v1-sync/`. It is `02-server-runtime.md` (S01 to S15) and `03-server-new-modules.md` (L3-01 to L3-12). It is also `07-v2-deviation-inventory.md` (D03, D08 to D15), `09-spike-w6.md` section 3.2 and `12-test-gap.md` sections 2a, 2d, 2e and 2f. Sibling plans: `2026-09-25-v1-sync-w0-foundations.md`, `2026-09-25-v1-sync-w1-solver-core.md`. Both are merged into `develop`. `core/upstream-patches/manifest.toml` has 51 rows and patches P0 to P4.

**Spec corrections this plan relies on:**

1. The spec says "The web submits Workspace V1". That is stale. The web submits strict YAML (`web/components/optimize/optimize-and-export-screen.tsx:478`), so web users take the legacy strict path. The X14 located errors reach only Workspace submitters, such as the assistant, the tests and the diagnostic. W2 keeps the Workspace boundary (P5) unchanged. It does not change which path the web uses (see Unresolved questions).
2. `version.py` resolves `parents[2]` = `/app` inside the images (`WORKDIR /app/core`). So `/app/.app-version` is the correct target, as the spec says. Genie `app.py` keeps its own `get_app_version` copy, which reads the same file (`parents[3]` of `server/app.py` = `/app`). This plan keeps that genie copy instead of importing `version.py` (decision W2-D1). The result is zero patch lines and the same runtime result.

## Global Constraints

- Upstream: v1 repo `/home/kenan/work/nurse-scheduling`, branch `feature/genie`, commit `1bf4b85`. Read it only with `git -C /home/kenan/work/nurse-scheduling show|diff|log|rev-parse`.
- Base: `develop` with W0 and W1 merged. W2 is one branch, `feat/v1-sync-w2`, in its own worktree, merged back into `develop` (`CLAUDE.md` branch flow). Unlike W1, **every commit on the branch must pass** the core suite, Ruff, `check_upstream_sync.py` and the web tests (spec W2 acceptance: "after each step").
- W2 owns these genie paths. Source: `version.py`, `server/{retry,request_limits,auth,solver_capabilities,solver_options,config,app,diagnostic,maintenance,errors}.py`, `server/api/{optimize,schemas}.py`, `server/jobs/{runner,process_executor,process_tree}.py`. Test: `tests/test_retry.py`. W2 must not track the W6 files and must not change their store, lease or fence logic. It adds only the shims named in Task 8. The W6 files are `job_store.py`, `jobs/models.py`, `jobs/controller.py`, `jobs/worker.py`, `stores/memory.py` and `stores/redis.py`.
- Not adopted: `usage_report.py`, `usage_metrics.py` (W6 vendors it only as an import), `suspicion.py`, `sentry.py`, `ai_serve.py`, `frontend_validation.py` (X5, X6). Auth stays off (X7).
- The product stays CP-SAT only. `scheduling_input.parse_solver` runs before the genie allowlist. `OPTIMIZE_SOLVERS` can list another solver, but that solver still gets a 422 `unsupported_solver`.
- `SOLVER_SEMANTIC_VERSION` does not change in W2. Solve meaning does not change: the runner now forwards `job.request.solver`, which is always `ortools/cp-sat`, and an omitted `prettify` still resolves to `false`.
- API version becomes `0.2.0` (X8). The YAML document key `apiVersion: alpha` is a different field. **Never edit it.**
- Upstream Ruff: the W2 genie files pass the v2 pin with no ignores (measured). If a later step finds a violation, fix the v2 file. Never reformat a genie file.
- Shell convention (copied from W1). Shell state does not persist between blocks. Every block starts with `cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh`. It names the interpreter as `$PY` and runs `core/` or `web/` commands in a subshell, for example `(cd core && …)`.
- Exit codes. Never pipe a test run into `tail` or `grep` to decide pass or fail. Write the output to a log, keep the exit status, then read the log.
- Real Redis. `NURSE_TEST_REDIS_URL=redis://localhost:16399/0` on every full core run (Task 1 starts the container). If the log of a full run contains a `NURSE_TEST_REDIS_URL` skip reason, the run does not count. The fakeredis variants run in the same parametrized suites without extra setup.
- Commits run only after the user approves this plan for execution. Do not push. Push and merge need separate approval (conservative profile). The bead-wave pre-approval covers wave beads, not this branch. Task tracking uses `bd`. Use `cp -rf` and `rm -rf`.

## Patch IDs used in W2 patch headers

| ID | v2 concern | W2 files that carry hunks | Removed by |
| --- | --- | --- | --- |
| P5 | Workspace boundary, canonical strict YAML, 422 envelope, coded YAML bound (W1) | `app.py`, `api/optimize.py` | never (v2-only boundary) |
| P6 | Opaque event cursors and replay window | `api/optimize.py` | upstream candidate (W5) |
| P7 | Roster container artifact, `/xlsx` extract, `/roster` | `api/optimize.py`, `jobs/runner.py` | upstream candidate |
| P8 | Basis admission, semantic profile, INCONCLUSIVE, `expires_at` | `app.py`, `api/optimize.py`, `api/schemas.py`, `jobs/runner.py` | INCONCLUSIVE is an upstream candidate |
| P9 | T09 purpose queues (reserve, errors, residue repair, key prefix `v1`) | `config.py`, `app.py`, `errors.py`, `maintenance.py`, `api/optimize.py`, `api/schemas.py` | upstream candidate. W6 bumps the prefix (X13). |
| P11 | Maintenance liveness, `/health` shim, readiness gate | `maintenance.py`, `app.py` | never |
| P12 | T19 fence bridge: `claim_lease_seconds`, v2 `RedisJobStore` args, `/info` `workers.online` from the process worker | `config.py`, `app.py` | **W6 deletes every P12 hunk** |
| P13 | Deployment default `default_prettify=False` (X10) | `config.py` | never |
| P14 | Diagnostic `api_path_mode` and idempotent cleanup | `diagnostic.py` | upstream candidate |

P10 (the shutdown write gate) is a W6 patch and has no W2 hunks.

## Target origin class per W2 file

| File (under `core/`) | Class | Patch IDs | Notes |
| --- | --- | --- | --- |
| `nurse_scheduling/version.py` | verbatim | none | new |
| `nurse_scheduling/server/retry.py` | verbatim | none | adds `RepeatedFailure` |
| `nurse_scheduling/server/jobs/process_tree.py` | verbatim | none | Darwin kill retry |
| `nurse_scheduling/server/jobs/process_executor.py` | verbatim | none | the v2 bridge goes with the runner change (D03). UK text leaves it. |
| `nurse_scheduling/server/request_limits.py` | verbatim | none | new |
| `nurse_scheduling/server/auth.py` | verbatim | none | new, off by default |
| `nurse_scheduling/server/solver_capabilities.py` | verbatim | none | new, replaces `STOPPABLE_SOLVERS` |
| `nurse_scheduling/server/solver_options.py` | verbatim | none | new |
| `tests/test_retry.py` | verbatim | none | new |
| `nurse_scheduling/server/errors.py` | patched | P9 | `OptimizationExecutionError` moves into `roster_container.py` |
| `nurse_scheduling/server/maintenance.py` | patched | P9, P11 | |
| `nurse_scheduling/server/jobs/runner.py` | patched | P7, P8 | genie `JobFailure` return |
| `nurse_scheduling/server/diagnostic.py` | patched | P14 | |
| `nurse_scheduling/server/config.py` | patched | P9, P12, P13 | |
| `nurse_scheduling/server/app.py` | patched | P5, P8, P9, P11, P12 | |
| `nurse_scheduling/server/api/optimize.py` | patched | P5, P6, P7, P8, P9 | |
| `nurse_scheduling/server/api/schemas.py` | patched | P8, P9 | |

After W2 the manifest has 51 + 17 = 68 rows. `api/__init__.py`, `api/sse.py`, `runtime_identity.py` and the `__init__.py` files are already identical to genie. W5 adds their rows, together with the `v2-only` and `excluded` classes that `check_upstream_sync.py` does not accept yet.

## Review Focus

- `/api/info` must stay 200 through the BFF once core adds `jobs`, `workers`, `auth` and `claimed_performance`. The browser response must not gain those keys. Pinned by Task 8 Steps 1 and 9 and Task 10 Step 4.
- `api_version` becomes `0.2.0` in `/info`, `/health` and the `runtime` object of `job.state_changed`. YAML `apiVersion: alpha` must not change. Pinned by Task 8 Step 1.
- A non-CP-SAT solver returns 422 `unsupported_solver`. This stays true with `OPTIMIZE_SOLVERS` set to allow it. Pinned by Task 8 Step 1.
- Auth is off by default: no `Authorization` header is needed, `links.events` carries no token, and `/docs` stays public. Pinned by the ported tests in Task 8.
- A roster over the size cap, a missing roster handoff, `invalid_model` and `no_solution_found` must still end as FAILED jobs with the same codes. They must not become `unexpected_error` once the runner returns `JobFailure`. Pinned by Task 4 Step 1.
- The maintenance backoff cap (4x) must stay below the liveness window. Pinned by Task 2 Step 1.
- `ServerSettings()` built directly defaults to `ordinary_reserved_slots=0`, so genie-style `ServerSettings(max_pending_jobs=1)` is accepted. `from_env()` and compose still give 1. Pinned by Task 7 Step 1.
- A job created without `prettify` now stores `false` instead of `null` (genie resolves the default at submit). `basis_id` does not change, because the basis already used `bool(prettify)`. Pinned by Task 8 Step 8 (contract golden review).
- The T19 fence, T09 queue and real-Redis gates are untouched: the full suite on real Redis passes at every commit.

## Parallel-safe groups

- **Group A** (after Task 1, in parallel. Each task edits disjoint files, except `manifest.toml`): Task 2, Tasks 3 and 4 (one agent, in that order, because both edit `tests/test_process_executor.py`), Task 5, Task 6, Task 9.
- **Group B** (serial, after Group A merges into the branch): Task 7, then Task 8.
- **Group C** (serial): Task 10, then Task 11.
- Manifest rule for parallel agents. `manifest.toml` rows and `patch_order` are append-only. Each agent commits its manifest change as the last commit of its task. The integrator resolves the append-only conflicts and appends `patch_order` entries in task-number order. Then it runs `python -m scripts.check_upstream_sync` before it merges the next agent's work.

## Waiting beads and where they land

| Bead | Placement | Unblocked by |
| --- | --- | --- |
| `nursing-sheduler-cjr.1.2` (B2 roster container) | Code already on `develop` (`roster_container.py`, `/roster`, `/xlsx` extract). W2 keeps it as P7. Task 11 re-checks its acceptance and closes it. | Task 4 (size cap as `JobFailure`), Task 8 (routes on the genie router) |
| `nursing-sheduler-cjr.1.3` (B3 BFF `/roster` proxy) | Code already on `develop` (`web/app/api/optimize/[id]/roster/route.ts`). Task 11 re-checks and closes it. | Task 8 |
| `nursing-sheduler-cjr.1` (roster-data endpoint) | Close in Task 11 once `.2` and `.3` are closed. | Task 8 |
| `nursing-sheduler-2by.7` (timeout bounds from `/optimize/options`) | After W2: un-defer in Task 11. A web wave bead adds the BFF route and the UI. | Task 8 (`GET /optimize/options`) |
| `nursing-sheduler-r6g` (v1 solver capability probe) | After W2: un-defer in Task 11 as a wave bead, and re-check at W6. Its needs land in W2: verbatim `solver_capabilities.py` and `solver_options.py`, the genie `create_app`, and `ServerSettings(max_pending_jobs=1)` being accepted. | Tasks 7 and 8 |
| `nursing-sheduler-l3m` (infeasibility explanation) | After W6: new result fields must be serialized in the W6 stores. Task 11 updates its note. | W6 |
| `nursing-sheduler-qq0.27.5` (TestClient httpx deprecation) | After W6: the server suites are rewritten there. Task 11 updates its note. | W6 |

---

### Task 1: Worktree, venv, Redis, baselines, helper library

**Files:**
- Create (outside the repo): `/tmp/v1sync-w2-root`, `/tmp/v1sync-w2-lib.sh`, `/tmp/v1sync-w2-venv`

- [ ] **Step 1: Create the worktree and the venv**

```bash
cd /home/kenan/orca/workspaces/nursing-sheduler/damselfish
wt switch --create feat/v1-sync-w2 --base develop --no-cd
git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch refs\/heads\/feat\/v1-sync-w2$/{print p}' > /tmp/v1sync-w2-root
cat /tmp/v1sync-w2-root
uv venv /tmp/v1sync-w2-venv --python 3.12
uv pip install --python /tmp/v1sync-w2-venv/bin/python -r "$(cat /tmp/v1sync-w2-root)/core/requirements-optional.txt"
which glpsol
docker run -d --rm --name v1sync-w2-redis -p 16399:6379 redis:8.8.0-alpine
docker exec v1sync-w2-redis redis-cli ping
```
Expected: one absolute path, a `glpsol` path, then `PONG`.

- [ ] **Step 2: Write the helper library**

`/tmp/v1sync-w2-lib.sh`:
```bash
# Sourced by every W2 command block. Run from the worktree root.
UPSTREAM=/home/kenan/work/nurse-scheduling
PIN=1bf4b85
PY=/tmp/v1sync-w2-venv/bin/python
RUFF=/tmp/v1sync-w2-venv/bin/ruff
REDIS_URL=redis://localhost:16399/0
MANIFEST=core/upstream-patches/manifest.toml

# Copy one genie file into core/.  $1 = path under core/
w2_take() { mkdir -p "core/$(dirname "$1")"; git -C "$UPSTREAM" show "$PIN:core/$1" > "core/$1"; }

# Append one manifest row unless present.  $1 = path, $2 = class, $3 = patch file (patched only)
w2_row() {
  grep -q "^path = \"$1\"$" "$MANIFEST" && return 0
  local sha; sha=$(git -C "$UPSTREAM" rev-parse "$PIN:core/$1")
  printf '\n[[file]]\npath = "%s"\nclass = "%s"\nupstream_blob = "%s"\n' "$1" "$2" "$sha" >> "$MANIFEST"
  if [ -n "${3:-}" ]; then printf 'patches = ["%s"]\n' "$3" >> "$MANIFEST"; fi
}

# (Re)write the per-file patch genie -> current file and record it.
# $1 = path under core/, remaining args = header lines ("hunk: <what> (P<n>)").
w2_patch() {
  local p="$1"; shift
  local name; name="W2-$(printf '%s' "$p" | sed 's#^nurse_scheduling/##; s#/#-#g; s#\.py$##').patch"
  local scratch; scratch=$(mktemp -d)
  git -C "$scratch" init -q
  mkdir -p "$scratch/core/$(dirname "$p")"
  git -C "$UPSTREAM" show "$PIN:core/$p" > "$scratch/core/$p"
  git -C "$scratch" add -A
  git -C "$scratch" -c user.name=w2 -c user.email=w2@localhost commit -qm genie
  cp -f "core/$p" "$scratch/core/$p"
  if git -C "$scratch" diff --quiet -- "core/$p"; then
    echo "w2_patch: $p equals genie; record it with w2_row $p verbatim" >&2; rm -rf "$scratch"; return 1
  fi
  { printf '# %s\n' "W2 patch for core/$p against genie $PIN." "$@"; printf '\n'; git -C "$scratch" diff -- "core/$p"; } \
    > "core/upstream-patches/$name"
  rm -rf "$scratch"
  grep -q "\"$name\"" "$MANIFEST" || sed -i "s/^patch_order = \[\(.*\)\]$/patch_order = [\1, \"$name\"]/" "$MANIFEST"
  w2_row "$p" patched "$name"
  echo "$name"
}

# Full core gate: ruff, upstream check, pytest on memory + fakeredis + real Redis.  $1 = log tag
w2_core() {
  (cd core && $RUFF check . ../docker && $RUFF format --check . ../docker) || return 1
  (cd core && PYTHONPATH=. $PY -m scripts.check_upstream_sync) || return 1
  (cd core && NURSE_TEST_REDIS_URL=$REDIS_URL PYTHONPATH=. $PY -m pytest -q -rs -p no:cacheprovider) \
    > "/tmp/v1sync-w2-$1.log" 2>&1
  local status=$?
  tail -1 "/tmp/v1sync-w2-$1.log"
  if grep -q 'NURSE_TEST_REDIS_URL' "/tmp/v1sync-w2-$1.log"; then echo "real Redis skipped" >&2; return 1; fi
  return $status
}
```
Every later block starts with `cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh`.

- [ ] **Step 3: Record the baselines**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
w2_core base; echo "core exit=$?"
(cd web && pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm exec oxfmt --check . && PYTHON=$PY pnpm test) > /tmp/v1sync-w2-web-base.log 2>&1; echo "web exit=$?"
(cd web && PYTHON=$PY RUN_DIFFERENTIAL=1 pnpm exec vitest run lib/scenario/differential) > /tmp/v1sync-w2-diff-base.log 2>&1; echo "differential exit=$?"
grep -E '^ *(×|✗|FAIL) ' /tmp/v1sync-w2-diff-base.log | sort > /tmp/v1sync-w2-diff-base-ids.txt; wc -l < /tmp/v1sync-w2-diff-base-ids.txt
```
Expected: `core exit=0` (the W1 tip had about 1,283 tests), with `checked 51 files against 1bf4b85: 0 problem(s)`, and `web exit=0`. Record the differential failure ids. Task 10 compares ids, not counts.

- [ ] **Step 4: Track the work**

```bash
cd "$(cat /tmp/v1sync-w2-root)"
bd create "v1 sync W2: server adoption (plan docs/superpowers/plans/2026-09-27-v1-sync-w2-server.md)" -t task -p 2
```
Claim the printed id with `bd update <id> --claim`.

### Task 2: `retry.py` verbatim, maintenance outage backoff (spec W2 step 1)

**Files:**
- Replace from genie: `core/nurse_scheduling/server/retry.py`, `core/tests/test_retry.py` (new)
- Rebase on genie: `core/nurse_scheduling/server/maintenance.py` (P9, P11)
- Modify: `core/tests/test_server_worker_loss.py` (the liveness test near line 475, plus one new test)

**Interfaces:**
- Consumes: genie `retry.RepeatedFailure(base_delay_seconds, max_delay_seconds)`, `.report()`, `.delay_seconds()`, `.recovered()`.
- Produces: `maintenance.LIVENESS_INTERVAL_FACTOR = 5.0` (was 3.0), so the genie cap of 4x the interval stays inside the window. W6 takes the claim-loop backoff with genie `worker.py`.

- [ ] **Step 1: Write the failing tests**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
w2_take tests/test_retry.py
```
Append to `core/tests/test_server_worker_loss.py`:
```python
def test_maintenance_backoff_cap_stays_inside_the_liveness_window():
    # After an outage the loop may sleep for the capped delay before its next pass.
    # That sleep alone must never make /ready fail once the store is back.
    maintenance = JobMaintenance(object(), interval_seconds=2.0)
    for _ in range(10):
        maintenance._failures.report()
    assert maintenance._failures.delay_seconds() < maintenance._liveness_timeout_seconds
```
In the existing liveness test, change `clock[0] = 5000.0` to `clock[0] = 10_000.0`. The window grows from 3,000 to 5,000.

- [ ] **Step 2: Run them to see them fail**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_retry.py tests/test_server_worker_loss.py -k "retry or backoff or maintenance or liveness"); echo "exit=$?"
```
Expected: `ImportError: cannot import name 'RepeatedFailure'`. Non-zero exit.

- [ ] **Step 3: Take `retry.py` and rebase `maintenance.py`**

`w2_take nurse_scheduling/server/retry.py`. Then `w2_take nurse_scheduling/server/maintenance.py`, and apply these v2 hunks to the genie file again. Copy the code from `git show develop:core/nurse_scheduling/server/maintenance.py`:
- P11: imports `time` and `Callable`. `MaintenanceClock` and `LIVENESS_INTERVAL_FACTOR = 5.0`, with the docstring `"""Missed-pass allowance before maintenance is considered unhealthy; above the 4x outage backoff cap."""`. The `clock` keyword in `__init__`, and the `_clock`, `_liveness_timeout_seconds`, `_progress_lock`, `_started_at` and `_last_success_at` fields. The progress reset in `start()`. `is_alive()` and `is_healthy()`.
- P9: `self._controller.repair_queue_residue()` after `expire_jobs()`, with the develop comment above it.
- Keep the genie `_failures` field and the genie loop. Record the success timestamp on the success path, before `recovered()`:
```python
        while not self._stop.wait(self._failures.delay_seconds()):
            try:
                self._controller.expire_worker_claims()
                self._controller.expire_jobs()
                # (develop comment on residue repair)
                self._controller.repair_queue_residue()
            except Exception:
                if self._failures.report():
                    server_logger.exception("[server:maintenance] job retention check failed")
                continue
            with self._progress_lock:
                self._last_success_at = self._clock()
            ended_failures = self._failures.recovered()
            if ended_failures:
                server_logger.warning(
                    "[server:maintenance] resumed after %d failed passes",
                    ended_failures,
                )
```
Keep the genie class and `_run` docstrings.

- [ ] **Step 4: Run the tests**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_retry.py tests/test_server_worker_loss.py tests/test_server_priority_queue.py); echo "exit=$?"
```
Expected: all pass. The genie test pins the delays `[1, 1, 2, 4, 4]`.

- [ ] **Step 5: Record the rows and the patch, run the gate, commit**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
w2_row nurse_scheduling/server/retry.py verbatim
w2_row tests/test_retry.py verbatim
w2_patch nurse_scheduling/server/maintenance.py \
  "hunk: clock, liveness window, is_alive, is_healthy, success timestamp (P11)" \
  "hunk: repair_queue_residue on every pass (P9)"
w2_core task2; echo "gate exit=$?"
git add core && git commit -m "feat(core): take genie retry and maintenance outage backoff; keep liveness and residue repair (v1 sync W2)"
```
Expected: `W2-server-maintenance.patch`, `checked 54 files …: 0 problem(s)`, `gate exit=0`.

### Task 3: Darwin process-tree kill retry (spec W2 step 2)

**Files:**
- Replace from genie: `core/nurse_scheduling/server/jobs/process_tree.py`
- Modify: `core/tests/test_process_executor.py` (the reap-before-signal test)

- [ ] **Step 1: Port the genie test delta**

Take the two tests from `git -C /home/kenan/work/nurse-scheduling diff d63519b 1bf4b85 -- core/tests/test_process_executor.py`. In the v2 file, rename `test_cleanup_reaps_exited_child_before_signaling_process_group` to `test_cleanup_retries_group_signal_after_child_becomes_reapable` and make the genie body changes: `if timeout:` in `join`, `calls.append` before the raise, and the two extra expected calls. Then add `test_cleanup_kills_direct_child_before_raising_persistent_group_error` verbatim.

- [ ] **Step 2: Check red, take genie, check green**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_process_executor.py -k cleanup); echo "red exit=$?"
w2_take nurse_scheduling/server/jobs/process_tree.py
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_process_executor.py); echo "green exit=$?"
```
Expected: `red exit` non-zero (the 2 cleanup tests fail), then `green exit=0`.

- [ ] **Step 3: Record, gate, commit**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
w2_row nurse_scheduling/server/jobs/process_tree.py verbatim
w2_core task3; echo "gate exit=$?"
git add core && git commit -m "fix(core): take genie Darwin process-tree kill retry (v1 sync W2)"
```

### Task 4: Runner returns `JobFailure`, with `process_executor.py` verbatim and `errors.py` on genie (spec W2 step 9, lane 07 D03)

**Files:**
- Rebase on genie: `core/nurse_scheduling/server/jobs/runner.py` (P7, P8), `core/nurse_scheduling/server/errors.py` (P9)
- Replace from genie: `core/nurse_scheduling/server/jobs/process_executor.py`
- Modify: `core/nurse_scheduling/server/roster_container.py` (defines `OptimizationExecutionError`, which moves out of `errors.py`)
- Test: `core/tests/test_runner_inconclusive.py`, `test_runner_termination.py`, `test_roster_container.py`, `test_process_executor.py`, `test_runner_real_inconclusive.py` (unchanged, must pass)

**Interfaces:**
- Produces: `OptimizationRunner.run(...) -> RunOutput | JobFailure` (genie `RunResult`). `roster_container.OptimizationExecutionError(code, message)` has the same class body, now in its only raising module.
- Failure codes do not change: `invalid_model`, `no_solution_found`, `roster_handoff_missing`, and the roster size-cap and invalid-output codes from `roster_container.py`.

- [ ] **Step 1: Change the tests to the return contract**

- `test_runner_inconclusive.py`: replace each `with pytest.raises(OptimizationExecutionError) as error:` block (near lines 83 and 91) with `failure = runner.run(...)`, then `assert isinstance(failure, JobFailure)` and `assert failure.code == "<same code>"`. Import `JobFailure` from `nurse_scheduling.server.jobs.models`.
- `test_runner_termination.py` (near lines 214, 237 and 250): the same change for `roster_handoff_missing` and the roster cap codes.
- `test_roster_container.py`: change the import to `from nurse_scheduling.server.roster_container import OptimizationExecutionError`. The `build_roster_container` tests keep `pytest.raises`: the builder still raises, and the runner converts.
- `test_process_executor.py`: the bridge test near line 643 (a runner that raises `OptimizationExecutionError`) becomes a runner that returns `JobFailure("invalid_model", "The generated solver model is invalid")`, with the same FAILED assertion. Change the expected messages near lines 667 and 734 to the genie text: `"The optimization process did not return"` and `"Optimization process closed its result channel"`.

- [ ] **Step 2: Check red**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_runner_inconclusive.py tests/test_runner_termination.py tests/test_roster_container.py tests/test_process_executor.py); echo "exit=$?"
```
Expected: failures (the runner still raises, the import path does not exist yet, and the UK text is still in place). Non-zero exit.

- [ ] **Step 3: Implement**

1. `roster_container.py`: delete `OptimizationExecutionError` from the `from .errors import …` line. Paste the class from `errors.py` (develop lines 105-112) under the module constants. Its docstring becomes `"""The roster container could not be built from a scheduler result."""`.
2. `w2_take nurse_scheduling/server/errors.py`, then add the P9 classes `DiagnosticCapacityError` and `QueueInvariantError` from develop, verbatim, after `JobCapacityError`.
3. `w2_take nurse_scheduling/server/jobs/process_executor.py`.
4. `w2_take nurse_scheduling/server/jobs/runner.py`, then apply the v2 hunks again. Keep genie's `schedule_result` style and its `solver=` and `prettify=` arguments.
   - P7 and P8 imports: `from ..roster_container import CONTAINER_MEDIA_TYPE, XLSX_MEDIA_TYPE, OptimizationExecutionError, build_roster_container`, plus the develop `INCONCLUSIVE_*` constants and `_inconclusive_reason`.
   - P7: the `RunOutput.artifact` docstring, the `run` docstring from develop (drop its `Raises:` block), `roster_payloads: list[dict[str, Any]] = []`, and `on_roster=roster_payloads.append` as the last `scheduler.schedule` argument.
   - Replace genie's single branch `if normalized_status not in {"OPTIMAL", "FEASIBLE"} or schedule_result.dataframe is None: return JobFailure(...)` with:
```python
        if normalized_status not in {"OPTIMAL", "FEASIBLE"}:
            # (develop comment: a terminal state without proof is a NORMAL completion)
            return RunOutput(
                result=OptimizationResult(
                    outcome=OptimizationOutcome.INCONCLUSIVE,
                    score=None,
                    solver_status=normalized_status,
                    termination_reason=_inconclusive_reason(normalized_status, stop_requested_when_solver_returned),
                ),
                artifact=None,
            )
        if schedule_result.dataframe is None:
            return JobFailure(
                code="no_solution_found",
                message=f"No schedule was produced. Solver status: {normalized_status}",
            )
        if len(roster_payloads) != 1:
            return JobFailure(
                code="roster_handoff_missing",
                message=f"A schedule was produced with {len(roster_payloads)} roster handoffs instead of exactly one",
            )
```
   - P7: after the termination reason, build the container, and return the roster artifact from develop (the `.roster.json` name and `CONTAINER_MEDIA_TYPE`):
```python
        try:
            container_bytes = build_roster_container(
                roster_payloads[0],
                xlsx_bytes=output_buffer.getvalue(),
                xlsx_name=output_filename,
                xlsx_mime=XLSX_MEDIA_TYPE,
                score=schedule_result.score,
                solver_status=normalized_status,
            )
        except OptimizationExecutionError as error:
            # The caps are enforced before RunOutput exists, so oversized output never
            # crosses the child result pipe and no artifact is committed.
            return JobFailure(code=error.code, message=str(error))
```
   - Genie's `MODEL_INVALID` branch is used as it is.

- [ ] **Step 4: Check green**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_runner_inconclusive.py tests/test_runner_termination.py tests/test_roster_container.py tests/test_process_executor.py tests/test_runner_real_inconclusive.py tests/test_roster_routes.py tests/test_server_api.py); echo "exit=$?"
grep -rn "OptimizationExecutionError" core/nurse_scheduling | grep -v roster_container.py | grep -v jobs/runner.py; echo "stray=$?"
```
Expected: `exit=0`. `stray=1` (no other module uses the class).

- [ ] **Step 5: Record, gate, commit**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
w2_row nurse_scheduling/server/jobs/process_executor.py verbatim
w2_patch nurse_scheduling/server/errors.py "hunk: DiagnosticCapacityError, QueueInvariantError (P9)"
w2_patch nurse_scheduling/server/jobs/runner.py \
  "hunk: INCONCLUSIVE reasons and branch (P8)" \
  "hunk: roster handoff, container build, container artifact (P7)"
w2_core task4; echo "gate exit=$?"
git add core && git commit -m "refactor(core): runner returns JobFailure as on genie; take genie process_executor and errors (v1 sync W2)"
```

### Task 5: Diagnostic on genie (spec W2 step 9, lane 02 S13)

**Files:**
- Rebase on genie: `core/nurse_scheduling/server/diagnostic.py` (P14)
- Modify: `core/tests/test_public_diagnostic.py`

- [ ] **Step 1: Port the genie test delta**

Apply the genie changes from `git -C /home/kenan/work/nurse-scheduling diff d63519b 1bf4b85 -- core/tests/test_public_diagnostic.py` to the v2 file:
- `import logging`.
- `monkeypatch.setattr(diagnostic_module, "log_report", Mock())` in `test_main_runs_without_creating_process_lock`.
- The new parametrized `test_log_report_emits_summary_and_findings`.
- The `caplog` form of `test_cleanup_run_and_cli_paths_report_errors`.
- The five auth-token tests at the end: `test_diagnostic_sends_the_configured_shared_token`, `…_rejects_a_shared_token_for_an_http_target`, `…_omits_the_header_without_a_shared_token`, `…_normalizes_the_configured_shared_token`, `…_reads_the_shared_token_from_env`.

Check that the v2 helpers `_diagnostic` and `_config` pass `auth_token=` through to `DiagnosticConfig`. If they do not, extend them the way genie does. The v2 `api_path_mode` and cleanup tests stay.

- [ ] **Step 2: Check red, then rebase**

Run `(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_public_diagnostic.py)`. Expect failures on `log_report` and `auth_token`. Then `w2_take nurse_scheduling/server/diagnostic.py` and apply the P14 hunks again from develop:
- `API_PATH_PREFIXES` and `DEFAULT_API_PATH_MODE`, placed after `DEFAULT_SCENARIO_PATH`.
- The `api_path_mode` field, its check at the top of `__post_init__`, the `api_prefix` property, and the `api_path_mode` parameter and env read in `from_env`.
- `_path(*segments)`, and each of the 8 request sites routed through `self._path(...)`. In the events block, keep genie's parenthesized `with (…)` form and change only the path argument.
- Cleanup idempotence: `job.deleted = True` on a GET 404, and `deleted.status_code in {204, 404}`, each with its develop comment.
- `"apiPathMode": self.config.api_path_mode` in the report.
- The `--api-path-mode` argument, and `api_path_mode=args.api_path_mode` in genie `_run`.

Take the genie value `expected_concurrency = 3`. `docker/compose.yml` already sets `DIAGNOSTIC_EXPECTED_CONCURRENCY: ${…:-1}` (X10). Update any v2 test that asserts the old default of 1.

- [ ] **Step 3: Check green, record, gate, commit**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_public_diagnostic.py); echo "exit=$?"
grep -n "DIAGNOSTIC_EXPECTED_CONCURRENCY" docker/compose.yml
w2_patch nurse_scheduling/server/diagnostic.py \
  "hunk: api_path_mode config, _path builder, every request path, report field, CLI flag (P14)" \
  "hunk: cleanup treats GET/DELETE 404 as confirmed deletion (P14)"
w2_core task5; echo "gate exit=$?"
git add core && git commit -m "feat(core): take genie diagnostic logging and auth header; keep api_path_mode and idempotent cleanup (v1 sync W2)"
```
Expected: `exit=0`, the compose line with `:-1`, `gate exit=0`.

### Task 6: `version.py` verbatim and the `.app-version` build stamp (spec W2 step 4, first half)

**Files:**
- Replace from genie: `core/nurse_scheduling/version.py` (new)
- Create: `core/tests/test_version.py` (v2-only)
- Modify: `docker/Dockerfile.backend`, `docker/Dockerfile.diagnostic`, `docker/test_diagnostic_version.sh`, `docker/README.md` (the version sentences near lines 101, 363 and 387)

**Interfaces:**
- Produces: `/app/.app-version` in both images, containing `$APP_VERSION`. `version.get_app_version()` (and, after Task 8, genie `app.get_app_version()`) returns it. `ENV APP_VERSION` stays in the images: it is harmless, and the build check reads it.

- [ ] **Step 1: Write the failing test**

`core/tests/test_version.py`:
```python
"""Genie version resolution: build stamp file, then git describe, then fallback."""

import subprocess

from nurse_scheduling import version


def test_generated_stamp_wins(tmp_path, monkeypatch):
    stamp = tmp_path / ".app-version"
    stamp.write_text("v9.9.9-stamp\n", encoding="utf-8")
    monkeypatch.setattr(version, "APP_VERSION_FILE", stamp)
    assert version.get_app_version() == "v9.9.9-stamp"


def test_blank_stamp_falls_back_to_git(tmp_path, monkeypatch):
    stamp = tmp_path / ".app-version"
    stamp.write_text("  \n", encoding="utf-8")
    monkeypatch.setattr(version, "APP_VERSION_FILE", stamp)
    monkeypatch.setattr(version.subprocess, "check_output", lambda *a, **k: "v1.2.3-4-gabc\n")
    assert version.get_app_version() == "v1.2.3-4-gabc"


def test_missing_stamp_and_git_fall_back_to_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(version, "APP_VERSION_FILE", tmp_path / "absent")

    def fail(*_args, **_kwargs):
        raise subprocess.CalledProcessError(128, "git")

    monkeypatch.setattr(version.subprocess, "check_output", fail)
    assert version.get_app_version() == "v0.0.0-unknown"
```

- [ ] **Step 2: Check red, take genie, check green**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_version.py); echo "red exit=$?"
w2_take nurse_scheduling/version.py
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_version.py); echo "green exit=$?"
```
Expected: `ModuleNotFoundError`, then `3 passed`.

- [ ] **Step 3: Stamp the images**

In both Dockerfiles, directly after the `ENV APP_VERSION=${APP_VERSION}` line, add:
```dockerfile
# Genie version.py and app.py read <repo>/.app-version (= /app here) before git.
RUN mkdir -p /app && printf '%s\n' "$APP_VERSION" > /app/.app-version
```
In `docker/test_diagnostic_version.sh`, keep the `app.get_app_version()` probe. Add a second probe with `import nurse_scheduling.version as v; print(v.get_app_version())`, which must also equal `$APP_VERSION`. Rewrite the three `docker/README.md` sentences: the backend version now comes from `/app/.app-version`, which the build writes from `APP_VERSION`.

- [ ] **Step 4: Check the image (needs Docker)**

```bash
cd "$(cat /tmp/v1sync-w2-root)"
APP_VERSION=v0.0.0-w2probe make diagnostic-version-check; echo "exit=$?"
```
Expected: every line `ok`, `exit=0`. If Docker cannot build here, record this step as blocked in the Task 11 report. Do not skip the stamp.

- [ ] **Step 5: Record, gate, commit**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
w2_row nurse_scheduling/version.py verbatim
w2_core task6; echo "gate exit=$?"
git add core docker && git commit -m "feat(core,docker): take genie version.py; stamp /app/.app-version in both images (v1 sync W2)"
```

### Task 7: New genie modules and genie `config.py` (spec W2 steps 5 and 6)

**Files:**
- Replace from genie: `core/nurse_scheduling/server/auth.py`, `request_limits.py`, `solver_capabilities.py`, `solver_options.py` (all new)
- Rebase on genie: `core/nurse_scheduling/server/config.py` (P9, P12, P13)
- Create: `core/tests/test_server_upstream_surface.py` (v2-only. W6 deletes it after it restores `test_serve.py`.)
- Modify: `core/tests/test_server_priority_queue.py` (`test_server_settings_default_reserves_one_of_eight_slots`), `docker/compose.yml` (backend env), `scripts/dev.sh`

**Interfaces:**
- Produces: `ServerSettings` with the genie fields (`solver_ids`, `default_solver`, `min_timeout_seconds`, `default_prettify`, `claimed_performance`, `auth_*`, `usage_metrics_*` inert, `cookie_secure`, `stream_token_ttl_seconds`). It also keeps the v2 fields `ordinary_reserved_slots` (dataclass default **0**, `from_env` default 1) and `claim_lease_seconds` (P12, until W6 renames it). `config.MIN_USAGE_METRICS_RETENTION_DAYS` exists for W6 (spike W6 section 3.2).
- `app.py` does not read the new fields until Task 8.

- [ ] **Step 1: Write the failing tests**

`core/tests/test_server_upstream_surface.py` starts with the license header used by the other v2 test files, and these tests:
```python
"""Upstream (genie) server surface ported from genie tests/test_serve.py until W6 restores it."""

import pytest

from nurse_scheduling.server.config import ServerSettings


def test_direct_settings_reserve_no_slot_so_upstream_shapes_stay_valid():
    settings = ServerSettings(max_pending_jobs=1)
    assert settings.ordinary_reserved_slots == 0


def test_env_settings_keep_the_v2_reserve_and_prettify_default(monkeypatch):
    for name in ("JOB_ORDINARY_RESERVED_SLOTS", "JOB_MAX_PENDING", "OPTIMIZE_DEFAULT_PRETTIFY"):
        monkeypatch.delenv(name, raising=False)
    settings = ServerSettings.from_env()
    assert settings.ordinary_reserved_slots == 1
    assert settings.max_pending_jobs == 32  # genie default; compose and dev.sh set 8
    assert settings.default_prettify is False
    assert settings.redis_key_prefix == "nurse_scheduling:jobs:v1"
    assert settings.solver_ids == ("ortools/cp-sat",)
    assert settings.auth_required is False and settings.auth_token is None


def test_claim_lease_keeps_its_v2_name_until_w6(monkeypatch):
    monkeypatch.setenv("JOB_CLAIM_LEASE_SECONDS", "12")
    assert ServerSettings.from_env().claim_lease_seconds == 12.0
```
Then port these genie `test_serve.py` tests verbatim. Change only the imports and the helpers.
- Settings: `test_server_settings_load_optimization_options_from_env`, `test_server_settings_load_claimed_performance_from_env`, `test_server_settings_require_complete_claimed_performance`, `test_server_settings_require_timezone_in_claimed_performance_time`.
- Auth settings, part 1: `test_required_authentication_accepts_boolean_spellings`, `test_required_authentication_rejects_a_non_boolean_value`, `test_blank_shared_tokens_disable_authentication`, `test_authentication_stays_off_by_default_for_local_runs`.
- Auth settings, part 2: `test_enabled_authentication_requires_a_token`, `test_enabled_authentication_rejects_a_short_token`, `test_enabled_authentication_accepts_a_configured_token`.
- Auth settings, part 3: `test_enabled_authentication_accepts_identified_tokens_without_the_legacy_token`, `test_authentication_can_be_turned_off_deliberately`, `test_a_token_alone_still_enables_authentication`.
- Registry and tokens: `test_solver_capability_registry_matches_canonical_choices`, `test_stream_tokens_are_scoped_signed_and_expiring`, `test_stream_token_lifetime_covers_the_longest_allowed_run`.

If one of them needs an HTTP client, move it to Task 8 and name it in the commit body.

In `test_server_priority_queue.py`, rename `test_server_settings_default_reserves_one_of_eight_slots` to `test_server_settings_env_reserves_one_slot`. It asserts `ServerSettings.from_env().ordinary_reserved_slots == 1` (with the env cleared), keeps the `:v1` prefix and the reserve-equals-capacity `ValueError` assertions, and drops `max_pending_jobs == 8`.

- [ ] **Step 2: Check red**

`(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_server_upstream_surface.py tests/test_server_priority_queue.py)`. Expect import errors and attribute errors.

- [ ] **Step 3: Take the modules and rebase `config.py`**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
for p in auth request_limits solver_capabilities solver_options config; do w2_take "nurse_scheduling/server/$p.py"; done
```
Then apply these hunks to genie `config.py` again:
- P9: `_non_negative_int` after `_positive_int` (from develop). `redis_key_prefix` defaults to `"nurse_scheduling:jobs:v1"`, with the develop docstring. The new field after `max_pending_jobs`:
```python
    ordinary_reserved_slots: int = 0
    """Pending slots only ordinary work may be admitted into (T09).

    Zero for direct construction, so upstream-shaped settings such as
    `ServerSettings(max_pending_jobs=1)` stay valid. `from_env` and the compose file
    supply the shipped value of 1.
    """
```
  The check after the `max_retained_jobs` one: `if not 0 <= self.ordinary_reserved_slots < self.max_pending_jobs: raise ValueError("ordinary_reserved_slots must satisfy 0 <= reserve < max_pending_jobs")`. In `from_env`: the `v1` prefix default and `ordinary_reserved_slots=_non_negative_int("JOB_ORDINARY_RESERVED_SLOTS", 1),`.
- P12: `worker_lease_seconds` becomes `claim_lease_seconds: float = 90.0`, with the docstring `"""Time a worker claim remains valid without renewal (renamed worker_lease_seconds by W6)."""`. The `__post_init__` name list uses the same name. In `from_env`: `claim_lease_seconds=_positive_float("JOB_CLAIM_LEASE_SECONDS", 90.0),`.
- P13: `default_prettify: bool = False` and `_boolean("OPTIMIZE_DEFAULT_PRETTIFY", False)`.

Keep everything else genie: `max_pending_jobs = 32`, the inert telemetry settings and all the auth settings.

- [ ] **Step 4: Move the deployment values to the environment (X10)**

`docker/compose.yml`, backend `environment`, after `JOB_ORDINARY_RESERVED_SLOTS`:
```yaml
      # The one-worker deployment's pending capacity (upstream default 32).
      JOB_MAX_PENDING: ${JOB_MAX_PENDING:-8}
```
`scripts/dev.sh`: in the `repo-core` branch, before `BACKEND_CMD=` is built, add `export JOB_MAX_PENDING="${JOB_MAX_PENDING:-8}"` with the comment `# v2 capacity; core now carries the upstream default.`.

- [ ] **Step 5: Check green, record, gate, commit**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_server_upstream_surface.py tests/test_server_priority_queue.py); echo "exit=$?"
(cd web && pnpm exec vitest run dev-launcher.test.ts); echo "launcher exit=$?"
for p in auth request_limits solver_capabilities solver_options; do w2_row "nurse_scheduling/server/$p.py" verbatim; done
w2_patch nurse_scheduling/server/config.py \
  "hunk: _non_negative_int, ordinary_reserved_slots (dataclass 0, env 1), key prefix v1 (P9)" \
  "hunk: claim_lease_seconds and JOB_CLAIM_LEASE_SECONDS until W6 (P12)" \
  "hunk: default_prettify False (P13)"
w2_core task7; echo "gate exit=$?"
git add core docker scripts && git commit -m "feat(core): take genie auth, request limits, solver options and config; move JOB_MAX_PENDING=8 to compose and dev.sh (v1 sync W2)"
```
Expected: all `exit=0`, and `checked 65 files …: 0 problem(s)`. If Group A merged in a different order, the count is the number of rows present at that point.

### Task 8: Server API on genie, with `/info` and API version `0.2.0` and the BFF parser in one commit (spec W2 steps 3, 4, 5, 7 and 8)

**Files:**
- Rebase on genie: `core/nurse_scheduling/server/app.py` (P5, P8, P9, P11, P12), `api/optimize.py` (P5 to P9), `api/schemas.py` (P8, P9)
- Shims in W6-owned files. W6 replaces these files, and the manifest does not track them.
  - `server/jobs/models.py`: add genie `ServerActivity`. Delete `STOPPABLE_SOLVERS` and `solver_supports_stop`.
  - `server/jobs/controller.py`: `get_activity()`, the `auth_credential_id` keyword on `create_job`, and the `solver_supports_finish_now` import.
  - `server/jobs/worker.py`: `is_ready()` and the `solver_supports_finish_now` import.
- Tests: `core/tests/test_server_upstream_surface.py` (HTTP tests), `test_server_api.py`, `test_server_store_contract.py` and `test_optimize_basis_admission.py`.
- Tests: `test_version.py` takes the old app-version cases. Delete `test_app_version.py`.
- Contract: `contracts/job-response.golden.json`. If its test fails, regenerate it.
- Web: `web/app/api/info/validate.ts`, `types.ts`, `info.route.test.ts`, `info.integration.test.ts`, `web/lib/query/event-payloads.ts` and its test, `web/lib/query/sse.test.ts`, `web/lib/optimize/optimize-server-info.ts` and its tests, `web/e2e/support/optimize-durable.ts:2132`. Find every `api_version` literal with `grep -rn 'api_version' web/app web/lib web/components web/e2e`.

**Interfaces:**
- Produces: `GET /optimize/options` (`OptimizationOptionsResponse`, `schema_version: "alpha"`). `/info` ready gains `jobs {running, queued, cancelling}`, `workers {online}`, `auth {required, scheme}` and `claimed_performance`, which is `null`. `/info` unavailable gains `auth` and `claimed_performance`. `API_VERSION = "0.2.0"`. `/` returns the genie `{message, api_version, app_version}`. No v2 code calls it. `MaxBodySizeMiddleware` gives 413 `request_too_large`. Auth dependencies are installed and pass everything while auth is off. `events_router` is separate.
- Consumes: `JobController.get_activity() -> ServerActivity`. Its v2 shim counts states from `describe_queue_state()`. Its `online_workers` is 0 by contract, because `/info` reads the process worker (P12) until W6. Also `JobWorker.is_ready()` (an alias of `is_alive()`).

- [ ] **Step 1: Write the failing tests**

In `core/tests/test_server_upstream_surface.py`, port these genie `test_serve.py` tests verbatim. Change only the `_client` and `_create` helpers, so that they build v2 `create_app(settings=…, store=MemoryJobStore(), runner=…, start_background=…)`.
- `/info`, part 1: `test_info_and_readiness_report_status_without_caching`, `test_info_reports_self_claimed_performance_with_provenance`, `test_info_reports_cancelling_jobs_separately`.
- `/info`, part 2: `test_info_and_readiness_fail_when_job_store_is_unavailable`, `test_info_and_readiness_fail_when_job_worker_stops`.
- Options: `test_app_startup_fails_when_a_configured_solver_is_unavailable`, `test_optimization_options_use_configured_canonical_solver_metadata`, `test_job_creation_enforces_advertised_options`.
- Requests: `test_client_cookie_is_marked_secure_when_the_deployment_says_so`, `test_declared_oversize_body_is_refused_before_the_upload_is_buffered`, `test_file_input_uses_configured_limit_above_multipart_text_default`.
- Auth routes: `test_discovery_routes_stay_public_when_authentication_is_enabled`, `test_browser_preflight_allows_the_authorization_header`, `test_generated_docs_are_disabled_when_authentication_is_enabled`.
- Stream tokens: every test from `test_event_stream_links_carry_a_scoped_token_when_authentication_is_enabled` through `test_stream_tokens_do_not_authorize_other_routes`.
- Any Task 7 test that needed a client. `test_info_reports_shared_job_and_worker_activity` uses `register_worker`, so write its v2 form instead: with background threads on, `/info` has `workers == {"online": 1}` and `jobs == {"running": 0, "queued": 0, "cancelling": 0}`. Genie tests that need `WorkerLease`, `register_worker` or store `get_activity` are not ported. List them in the commit body. W6 restores them.

Add these v2 tests:
```python
def test_a_non_cp_sat_solver_stays_a_422_even_when_the_allowlist_names_it():
    settings = ServerSettings(job_backend="memory", solver_ids=("ortools/cp-sat", "pulp/glpk"))
    with TestClient(create_app(settings=settings, start_background=False)) as client:
        response = client.post("/optimize", data={"yaml_content": MINIMAL_WORKSPACE, "solver": "pulp/glpk"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unsupported_solver"


def test_runtime_identity_reports_api_version_0_2_0():
    with TestClient(create_app(settings=ServerSettings(job_backend="memory"), start_background=False)) as client:
        assert client.get("/info").json()["api_version"] == "0.2.0"
        assert client.get("/health").json()["apiVersion"] == "0.2.0"
```
Take `MINIMAL_WORKSPACE` from `test_server_api.py`. Change the `"alpha"` runtime assertions at `test_server_api.py:245`, `test_server_store_contract.py:117` and `test_optimize_basis_admission.py` to `"0.2.0"`, where they refer to `api_version` (not YAML `apiVersion`). Change `test_server_api.py:173` to the genie text: `"Optimization timeout must be between 1 and "`. Move the useful cases from `test_app_version.py` into `test_version.py` as genie `app.get_app_version` cases (monkeypatch `app_module.APP_VERSION_FILE`), then delete `test_app_version.py`: the env-first behaviour is gone on purpose.

Web red tests:
- `info.route.test.ts` and `info.integration.test.ts`: the ready fixture gains `jobs`, `workers`, `auth` and `claimed_performance`. The unavailable fixture gains `auth` and `claimed_performance`. `api_version` becomes `"0.2.0"`. Add three cases. A ready body without `jobs` gives 502 `invalid_upstream_response`. A ready body with `workers.online: "1"` (a string) gives 502. The browser response has no `jobs`, `workers`, `auth` or `claimed_performance` key.
- `event-payloads.test.ts`: a `runtime` with `api_version: "0.2.0"` is accepted, and `"alpha"` is rejected.

- [ ] **Step 2: Check red**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_server_upstream_surface.py tests/test_server_api.py tests/test_version.py) > /tmp/v1sync-w2-t8-red.log 2>&1; echo "core exit=$?"
(cd web && pnpm exec vitest run app/api/info lib/query/event-payloads.test.ts) > /tmp/v1sync-w2-t8-red-web.log 2>&1; echo "web exit=$?"
```
Expected: both non-zero.

- [ ] **Step 3: Add the shims in the W6-owned files**

- `jobs/models.py`: paste genie `ServerActivity` verbatim (genie `jobs/models.py` lines 169-180). Delete `STOPPABLE_SOLVERS` and `solver_supports_stop`.
- `jobs/controller.py` and `jobs/worker.py`: import `solver_supports_finish_now` from `..solver_capabilities` and replace every `solver_supports_stop(` call.
- `jobs/controller.py`: `create_job(…, auth_credential_id: str | None = None)`. It is accepted and unused, as the spike W6 notes. Add:
```python
    def get_activity(self) -> ServerActivity:
        """Return aggregate job activity from one atomic queue snapshot.

        v2 bridge until W6: worker presence is not in the T19 store, so
        `online_workers` is always 0 here and `/info` reads the process worker.
        """
        snapshot = self._store.describe_queue_state()
        states = [facts.state for facts in snapshot.jobs.values()]
        return ServerActivity(
            queued_jobs=states.count(JobState.QUEUED),
            running_jobs=states.count(JobState.RUNNING),
            cancelling_jobs=states.count(JobState.CANCELLING),
            online_workers=0,
        )
```
- `jobs/worker.py`: `def is_ready(self) -> bool: """Genie readiness name; the v2 worker is ready while its thread runs.""" return self.is_alive()`.

- [ ] **Step 4: Rebase `api/schemas.py`**

`w2_take nurse_scheduling/server/api/schemas.py`, then apply again:
- P9: the `JobPurpose` import, and `purpose: JobPurpose` on `JobRequestResponse`.
- P8: `NormalizedOptionsResponse` and `JobBasisResponse` from develop. `basis: JobBasisResponse | None` on `JobRequestResponse`, and `_basis_response(job)`. `expires_at: datetime | None` on `JobResponse`, after `created_at`.
- P8 and P9 in `from_job`: `expires_at=job.expires_at`, `purpose=job.request.purpose` and `basis=_basis_response(job)`.

Keep the genie `from_job(job, events_token=None)`, the genie `queue_position` docstring and the genie controls, which use `solver_supports_finish_now`.

- [ ] **Step 5: Rebase `api/optimize.py`**

`w2_take nurse_scheduling/server/api/optimize.py`, then apply again, in file order:
- Imports: `JSONResponse`. `BasisClaim` and `verify_basis_claim` (P8). `EventCursorExpired`, `EventCursorInvalid` and `encode_cursor` (P6). `JobEvent` and `JobPurpose`. The five `roster_container` functions (P7). `CODE_SCHEDULING_DATA_TOO_COMPLEX`, `MalformedInputError`, `canonicalize_submission` and `parse_solver` from `..scheduling_input` (P5).
- `create_job` parameters: the develop `purpose` form field (P9), and the ten basis form fields (P8) after genie's `solver`.
- P5, first line of the body after `_read_input`: `parse_solver(solver if solver is not None else settings.default_solver)` with the comment `# v2: the product is CP-SAT only (X4); a 422 unsupported_solver even if OPTIMIZE_SOLVERS widens.`
- P5: in the genie YAML guard, the `except SchedulingDataTooComplexError` body becomes:
```python
        request.state.invalid_reason = "yaml_expansion_bomb"
        return JSONResponse(
            status_code=400,
            content={"error": {"code": CODE_SCHEDULING_DATA_TOO_COMPLEX, "message": str(error)}},
        )
```
- After the guard: the develop purpose parse (P9), `canonical_bytes = await run_in_threadpool(canonicalize_submission, content)` with `MalformedInputError` mapped to 400 (P5), and `verify_basis_claim(…)` (P8) with `resolved_solver=normalized_solver` and `resolved_prettify=prettify if prettify is not None else settings.default_prettify`.
- In the `create_job` controller call: `input_bytes=canonical_bytes` (P5), then `basis=verified_basis,` and `purpose=job_purpose,` (P8, P9). Keep genie `auth_credential_id=`.
- P6: `_enrich_state_event(controller, job_id, event)` holds genie's inline `job.state_changed` block, with the genie semantics (`solver_supports_finish_now`, `cancellable = not terminal and not cancel_requested`). Genie `stream_events`, still on `events_router`, gains the develop replay window, the 409 and 400 cursor responses, `to_frame`, and the initial-events loop. The live loop calls `to_frame(event)`.
- P7: `_roster_container`, the container-extract `/xlsx` body, and `/roster` from develop, with `JobResponse.from_job(…, _events_token(…))` left as genie wherever a job is returned.

- [ ] **Step 6: Rebase `app.py`**

`w2_take nurse_scheduling/server/app.py`, then apply again:
- Imports: `QueueInvariantError` (P9), `SchedulingContentError` (P5), `semantic_profile` (P8).
- P12: in `_create_store`, drop the two `usage_metrics_*` arguments, because the v2 `RedisJobStore` has no telemetry. W6 restores them.
- P9: `ordinary_reserved_slots=settings.ordinary_reserved_slots` in `StoreLimits`. P12: `claim_lease_seconds=settings.claim_lease_seconds` in both the controller and the worker.
- P9: `QueueInvariantError` in the 409 tuple. P5: the `SchedulingContentError` handler from develop.
- P11: `health_payload` and the `/health` route from develop. In `check_readiness`, add the `maintenance.is_healthy()` block after genie's worker check, with the genie `[server:readiness]` log tag.
- P8: `info_payload` returns `{"status": status, **runtime_identity, "auth": auth_descriptor, "claimed_performance": claimed_performance, "semantic_profile": semantic_profile()}`.
- P12: in `/info`, `"workers": {"online": activity.online_workers},` becomes `"workers": {"online": int(worker.is_ready())},  # v2 bridge until the W6 lease registry`.

Everything else stays genie: `API_VERSION = "0.2.0"`, genie `get_app_version`, `/`, the middleware, the auth routers and the genie docs switch.

- [ ] **Step 7: Change the BFF parser and the version checks**

- `web/app/api/info/validate.ts`: `READY_KEYS` adds `jobs`, `workers`, `auth` and `claimed_performance`. `UNAVAILABLE_KEYS` adds `auth` and `claimed_performance`. Add strict readers:
  - `jobs`: an exact key set `{running, queued, cancelling}`, each a non-negative integer.
  - `workers`: an exact key set `{online}`, a non-negative integer.
  - `auth`: an exact key set `{required, scheme}`, a boolean and a non-empty string.
  - `claimed_performance`: `null`, or an exact key set `{score, app_version, measured_at}` of a positive finite number and two non-empty strings.

  Any failure returns `null`. `serializeInfoPayload` does not change, so the browser never sees these keys. Add the comment "Checked because core owns them (v1 sync X8). Not relayed: no v2 screen uses them."
- `web/app/api/info/types.ts`: no type change is needed.
- `web/lib/query/event-payloads.ts`: `value.api_version === "0.2.0"`.
- Change the `api_version` fixtures and mocks, not YAML `apiVersion`, to `"0.2.0"`. The `/info` mock in `web/e2e/support/optimize-durable.ts` is one of them.

- [ ] **Step 8: Check green, and review the contract golden**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && PYTHONPATH=. $PY -m pytest -q tests/test_job_response_contract.py); echo "contract exit=$?"
```
If it fails, run it again with `UPDATE_JOB_RESPONSE_CONTRACT=1` and read `git diff contracts/job-response.golden.json`. Allowed changes: `request.prettify` `null` to `false` for jobs that omitted it, and the ids, links and timestamps. Any change to `basis_id`, `normalized_options` or the controls is a bug: stop and report it.
```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd web && pnpm typecheck && pnpm lint && pnpm exec oxfmt --check . && PYTHON=$PY pnpm test) > /tmp/v1sync-w2-t8-web.log 2>&1; echo "web exit=$?"
```

- [ ] **Step 9: Record, gate, commit (one commit)**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
w2_patch nurse_scheduling/server/api/schemas.py "hunk: basis and normalized options, expires_at (P8)" "hunk: purpose (P9)"
w2_patch nurse_scheduling/server/api/optimize.py \
  "hunk: CP-SAT-only parse_solver before the allowlist, coded YAML bound, canonical strict input (P5)" \
  "hunk: opaque cursor replay window and _enrich_state_event (P6)" \
  "hunk: roster container /xlsx and /roster (P7)" \
  "hunk: basis form fields and verify_basis_claim (P8)" \
  "hunk: purpose form field (P9)"
w2_patch nurse_scheduling/server/app.py \
  "hunk: 422 SchedulingContentError handler (P5)" \
  "hunk: semantic_profile in /info (P8)" \
  "hunk: reserve in StoreLimits, QueueInvariantError 409 (P9)" \
  "hunk: /health shim, maintenance liveness in readiness (P11)" \
  "hunk: claim_lease_seconds, no telemetry store args, workers.online from the process worker (P12, W6 deletes)"
w2_core task8; echo "gate exit=$?"
git add core web contracts && git commit -m "feat(core,web): take genie app, optimize and schemas; /info activity, auth, options, API 0.2.0 with the BFF parser (v1 sync W2)"
```
Expected: `gate exit=0`, `checked 68 files`, `web exit=0`.

### Task 9: The web owns user-facing spelling (spec W2 step 11, lane 03 L3-02 code map)

**Files:**
- Modify: `web/lib/bff/errors.ts`, `web/lib/bff/errors.test.ts`, `web/lib/optimize/run-view.ts` (the `boundError("job", …)` sites near lines 714 and 867), `web/lib/optimize/run-view.test.ts`

**Interfaces:**
- Produces: `CODE_TO_KIND.request_too_large = "too-large"`, and `jobFailureMessage(code: string | null, backendMessage: string): string`, which returns web copy for the known failure codes and the backend text otherwise.

Backend messages that a v2 screen shows today: the job `error.message` in `run-status-panel.tsx:350`, reached through `run-view.ts` `boundError("job", …)`. The failure codes and backend text that change with W2 and W6 are `cancelled`, `worker_lost`, `process_timeout`, `invalid_model` and `no_solution_found`. HTTP error messages for 422 content errors come from v2-only `scheduling_errors.py` and do not change. The timeout-range `detail` is not shown, because the client clamps the timeout before it submits.

- [ ] **Step 1: Write the failing tests**

`errors.test.ts`:
```ts
  it("classifies the upstream body-size middleware as too-large", () => {
    expect(classifyOptimizeError(413, envelope({ code: "request_too_large", message: "x" })).kind).toBe("too-large");
  });

  it("owns the wording of known job failures and passes unknown ones through", () => {
    expect(jobFailureMessage("cancelled", "Optimization cancelled.")).toBe("Optimisation cancelled.");
    expect(jobFailureMessage("worker_lost", "x")).toBe("The optimisation worker stopped before the job completed.");
    expect(jobFailureMessage("some_new_code", "Backend text.")).toBe("Backend text.");
    expect(jobFailureMessage(null, "Backend text.")).toBe("Backend text.");
  });
```
In `run-view.test.ts`, add one case: a failed job whose error is `{ code: "process_timeout", message: "The optimization process did not return …" }` renders `view.error.message === "The optimisation run did not finish within its time limit and was stopped."`.

- [ ] **Step 2: Implement**

`errors.ts`: add `request_too_large: "too-large",` to `CODE_TO_KIND`, and:
```ts
// Web-owned wording for job failure codes. The backend text follows upstream
// (US spelling, v1 sync X10); a code this map does not know keeps the backend text.
const JOB_FAILURE_MESSAGES: Record<string, string> = {
  cancelled: "Optimisation cancelled.",
  worker_lost: "The optimisation worker stopped before the job completed.",
  process_timeout: "The optimisation run did not finish within its time limit and was stopped.",
  invalid_model: "The generated solver model is invalid.",
  no_solution_found: "No schedule was produced.",
};

export function jobFailureMessage(code: string | null, backendMessage: string): string {
  return (code !== null && JOB_FAILURE_MESSAGES[code]) || backendMessage;
}
```
`run-view.ts`: at the two `boundError("job", code, message)` sites, pass `jobFailureMessage(code, message)` as the message.

- [ ] **Step 3: Check and commit**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd web && pnpm typecheck && pnpm lint && pnpm exec oxfmt --check . && PYTHON=$PY pnpm test) > /tmp/v1sync-w2-t9-web.log 2>&1; echo "web exit=$?"
git add web && git commit -m "feat(web): own job-failure wording by code; classify request_too_large (v1 sync W2)"
```

### Task 10: Full gates

**Files:** none changed unless a gate fails. If one fails, fix it in the task that owns the file.

- [ ] **Step 1: Core, all backends, upstream check, score replay**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
w2_core tip; echo "core exit=$?"
(cd core && PYTHONPATH=. $PY -m pytest -q tests/real/schedule_score_ground_truth.py); echo "replay exit=$?"
(cd core && PYTHONPATH=. $PY -m scripts.check_upstream_sync); echo "check exit=$?"
echo >> core/nurse_scheduling/server/app.py
(cd core && PYTHONPATH=. $PY -m scripts.check_upstream_sync); echo "drift exit=$?"
git restore -- core/nurse_scheduling/server/app.py
```
Expected: `core exit=0` with no Redis skip, `replay exit=0`, `checked 68 files against 1bf4b85: 0 problem(s)`, then a line naming `app.py` (or the W2 patch no longer reversing) with `drift exit=1`.

- [ ] **Step 2: Web unit, differential oracle, base e2e**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd web && pnpm typecheck && pnpm lint && pnpm exec oxfmt --check . && PYTHON=$PY pnpm test) > /tmp/v1sync-w2-web.log 2>&1; echo "web exit=$?"
(cd web && PYTHON=$PY RUN_DIFFERENTIAL=1 pnpm exec vitest run lib/scenario/differential) > /tmp/v1sync-w2-diff.log 2>&1; echo "differential exit=$?"
grep -E '^ *(×|✗|FAIL) ' /tmp/v1sync-w2-diff.log | sort | diff /tmp/v1sync-w2-diff-base-ids.txt -; echo "new-failures exit=$?"
(cd web && pnpm test:e2e) > /tmp/v1sync-w2-e2e.log 2>&1; echo "e2e exit=$?"
```
Expected: `web exit=0`. `new-failures exit=0` (the same failure ids as the Task 1 baseline). `e2e exit=0`: the base suite mocks `/api/info` with `0.2.0`.

- [ ] **Step 3: The live backend and the real-backend e2e (needs Docker)**

```bash
cd "$(cat /tmp/v1sync-w2-root)"
APP_VERSION=v0.0.0-w2 make verify-deploy > /tmp/v1sync-w2-verify-deploy.log 2>&1; echo "verify-deploy exit=$?"
APP_VERSION=v0.0.0-w2 make verify-stream > /tmp/v1sync-w2-verify-stream.log 2>&1; echo "verify-stream exit=$?"
```
Expected: both `exit=0`. `verify-deploy` covers the `/app/.app-version` stamp (`/api/health appVersion == APP_VERSION`), the Redis outage 503 and the `SIGKILL` gate. `verify-stream` runs the assembled Browser to Next to FastAPI specs. Read how each Makefile target needs `APP_VERSION` and `docker/.env` before you run it. If Docker is unavailable, record both as blocked.

- [ ] **Step 4: `/api/info` returns 200 through the BFF (without Docker)**

```bash
cd "$(cat /tmp/v1sync-w2-root)" && . /tmp/v1sync-w2-lib.sh
(cd core && JOB_BACKEND=memory PYTHONPATH=. $PY -m uvicorn nurse_scheduling.serve:app --host 127.0.0.1 --port 18000 --no-access-log) > /tmp/v1sync-w2-uvicorn.log 2>&1 &
(cd web && pnpm build > /tmp/v1sync-w2-build.log 2>&1 && BACKEND_API_URL=http://127.0.0.1:18000 PUBLIC_ORIGIN=http://127.0.0.1:13000 PORT=13000 HOSTNAME=127.0.0.1 pnpm start) > /tmp/v1sync-w2-next.log 2>&1 &
sleep 20
curl -s -o /tmp/v1sync-w2-info.json -w '%{http_code}\n' http://127.0.0.1:13000/api/info
curl -s http://127.0.0.1:18000/info | $PY -c 'import json,sys; b=json.load(sys.stdin); print(sorted(b), b["api_version"])'
grep -c '"jobs"\|"workers"\|"auth"\|"claimed_performance"' /tmp/v1sync-w2-info.json
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18000/optimize/options
kill %1 %2
```
Expected: `200`. The backend key list includes `auth`, `claimed_performance`, `jobs`, `semantic_profile` and `workers`, with `0.2.0`. The grep count is `0` (the BFF does not relay them). Options return `200`.

### Task 11: Docs, beads, hand-off

**Files:**
- Modify: `docs/T19-upstream-backend-source-manifest.md` (the "Upstream tracking table" section)

- [ ] **Step 1: Point the T19 manifest at the W2 rows**

Append to the W1 section:
```markdown
W2 adds the server layer: 9 `verbatim` rows (`version.py`, `retry.py`, `process_tree.py`,
`process_executor.py`, `request_limits.py`, `auth.py`, `solver_capabilities.py`,
`solver_options.py`, `tests/test_retry.py`) and 8 `patched` rows, each with one
`W2-<file>.patch` whose header maps every hunk to a patch ID: P5 Workspace boundary, P6
cursors, P7 roster, P8 basis and INCONCLUSIVE, P9 purpose queues, P11 maintenance
liveness, P12 T19 fence bridge (W6 deletes it), P13 `default_prettify=False`, P14
diagnostic path mode and cleanup. `JOB_MAX_PENDING=8` and the diagnostic concurrency of 1
now live in `docker/compose.yml` and `scripts/dev.sh`. The web owns user-facing
failure wording (`web/lib/bff/errors.ts`).
```
Commit: `git add docs && git commit -m "docs(t19): record W2 upstream rows and patch IDs (v1 sync W2)"`.

- [ ] **Step 2: Beads**

```bash
cd "$(cat /tmp/v1sync-w2-root)"
bd update nursing-sheduler-2by.7 --status open --notes "W2 landed GET /optimize/options (branch feat/v1-sync-w2). Un-deferred."
bd update nursing-sheduler-r6g --status open --notes "W2 landed verbatim solver_capabilities/solver_options, genie create_app, and ServerSettings(max_pending_jobs=1) valid (reserve default 0). Run as a wave bead; re-check at W6."
bd update nursing-sheduler-l3m --notes "Still deferred: needs result fields serialized in the W6 genie stores. Un-defer after W6."
bd update nursing-sheduler-qq0.27.5 --notes "Still deferred: W6 rewrites the server suites. Un-defer after W6."
```
Only after merge into `develop` and a check of each acceptance line, close `nursing-sheduler-cjr.1.2` ("base64 hash-parity, size-cap path, runner/store-contract/export-parity suites green": `test_roster_container.py`, `test_runner_termination.py`, `test_roster_routes.py`), then `nursing-sheduler-cjr.1.3` (`optimize.integration.test.ts` roster cases), then `nursing-sheduler-cjr.1`.

Record the W6 obligations:
```bash
bd remember "v1sync-w2-handoff: W6 must (1) delete every P12 hunk in W2-server-config.patch and W2-server-app.patch and regenerate both, (2) delete core/tests/test_server_upstream_surface.py once test_serve.py is restored, (3) drop the W2 shims: JobController.get_activity (online_workers=0), create_job auth_credential_id, JobWorker.is_ready, (4) keep ServerSettings.ordinary_reserved_slots dataclass default 0 / env 1."
```

- [ ] **Step 3: Report**

Report the branch, the commit list, the Task 10 results and the `check_upstream_sync` line. Name any blocked Docker gate. List the genie tests that were not ported (from the Task 7 and Task 8 commit bodies). Propose `git push -u origin feat/v1-sync-w2`, then a PR into `develop`. Do not push or merge until the user approves. Close the W2 tracking bead only after merge.

---

## Unresolved questions

1. W2-D1: genie `app.py` keeps its own `get_app_version` copy (zero patch lines, same file read) instead of importing `version.py`, as spec step 4 asks. Accept?
2. Per-file `W2-<file>.patch` with a hunk-to-ID header, instead of one file per feature as in W1. Accept? Per-feature files need a staged rebuild of each file.
3. Web users submit strict YAML, so the X14 located errors never reach them. Do we move the web to Workspace submission (a separate bead), or remove that claim from the spec?
4. `LIVENESS_INTERVAL_FACTOR` 3.0 to 5.0 slows stall detection from 90 s to 150 s at the default 30 s interval. Acceptable, or cap the genie backoff at 3x instead (a patch hunk on a genie line)?
5. The web copy for `process_timeout` drops the seconds that the backend message carries. Acceptable?

## Assumptions

- W0 and W1 are merged into `develop`: `requirements-optional.txt`, the `core` CI job, the 51-row manifest and `check_upstream_sync.py` exist (checked in this worktree).
- No v2 code calls the backend `GET /` or reads its legacy `version` and `appVersion` keys. A `grep` over `web/`, `docker/`, `scripts/` and `core/tests/` found none. `/health` keeps those keys.
- The web BFF never sends a solver other than `ortools/cp-sat`, and it always resolves `prettify` before it submits.
- No deployment sets `JOB_CLAIM_LEASE_SECONDS` or depends on the default `JOB_MAX_PENDING` without compose.
- Docker is available for Redis and for `verify-deploy` and `verify-stream`. If it is not, those gates are reported as blocked, not skipped silently.
- The genie tests named for porting run against the v2 app with only helper changes. Any that need `WorkerLease` wait for W6. This is not checked: the port was chosen by name, not run.
