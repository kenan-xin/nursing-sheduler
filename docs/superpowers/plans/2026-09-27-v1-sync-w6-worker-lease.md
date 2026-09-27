# v1 sync W6: worker lease registry Implementation Plan

Confidence: 8.2/10. The whole plan was run once as a throwaway probe in `/tmp`, not in the repo. The probe started from `develop` at `629b5c1`, with W0, W1 and W2 merged. It added the spike W6 files from `kenan-xin/spike-w6-lease` `220d7a6` and the corrections in Task 2. It merged the spike suite rewrites 3-way onto `develop`, and it restored the genie tests with the adaptations in Task 4. On fakeredis plus real Redis 8.8 it gave 1,613 passed, 14 skipped and 6 failed. Every failure was expected. The manifest was not updated. Two failures came from the probe tree, which has no `prototype/` directory and no git checkout. Three were W2 surface tests that Task 4 deletes. The genie `test_serve.py` and `test_optimize_job_backends.py` gave 252 passed and 9 skipped, and each skip is a listed v2 deviation. The spike ran the Docker gates (`SIGKILL`, `workerlost`, reserve probe), but the probe did not. Those gates, the `.patch` generation for 7 new files and the `r6g` merge order are the remaining risk.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use `- [ ]` boxes for tracking.

**Goal:** Replace the v2 T19 fence (Lua claim leases) with the genie worker lease registry. The six W6 files become genie `1bf4b85` plus the recorded v2 patches P6, P8, P9 and P10. The T09 purpose queues are rebuilt on genie `WATCH`/`MULTI`. The genie server tests come back as tracked files, and `check_upstream_sync.py` proves the result.

**Architecture:** The spike already built each W6 file as genie plus the v2 lines. After the spike base, `develop` changed those files only by the W2 shims, and genie replaces the shims. So the spike file is the right start for each one. Task 2 takes the spike files and makes three small corrections. It reverts the W2 P12 bridge hunks, bumps the key prefix (X13) and records one `W6-<file>.patch` per patched file. Task 3 merges the spike rewrites of the v2 T19 suites onto `develop` with a 3-way merge. Task 4 restores genie `test_optimize_job_backends.py` (verbatim) and `test_serve.py` (patched), and deletes the W2 stand-in `test_server_upstream_surface.py`.

**Tech Stack:** Python 3.12, FastAPI, redis-py and fakeredis, Redis 8 (real), pytest, Ruff 0.15.22, Docker Compose, git.

**Spec:** `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md`, section 3 W6, with decisions X3, X6 and X13. Evidence: `docs/research/2026-09-25-v1-sync/09-spike-w6.md` (spike, all sections), `02-server-runtime.md`, `07-v2-deviation-inventory.md` D13 and D18, and `12-test-gap.md` section 2e. Sibling plan: `2026-09-27-v1-sync-w2-server.md` (merged). Its hand-off is in `bd recall v1sync-w2-handoff-w6-must-1-delete-every`.

**Spec corrections this plan relies on:**

1. The spec says "Port the genie lease tests (`d4ae8aa` … `367b477`)". The spike extracted 17 of them into a v2 file. This plan restores the two genie files they live in instead: `tests/test_optimize_job_backends.py` verbatim and `tests/test_serve.py` patched. Those files hold the 17 lease tests and also the only genie tests for `auth.py`, `request_limits.py` and `solver_options.py` (`12-test-gap.md` 2e, memory `v1sync-w6-tests`). The spike's `test_server_genie_lease.py` is not ported. The spec rule for the v2 T19 suites still applies: keep them and rewrite their calls.
2. P9 keeps the genie attribute `RedisJobStore._queue_key` and its key `<prefix>:queue` for the ordinary queue. The diagnostic queue gets the second key. The spike used `queue:ordinary`, and one genie test (`test_redis_store_removes_corrupt_queue_entries`) writes to `store._queue_key`. With the genie name that test runs unchanged. Measured in the probe.
3. P9 `_with_queue_position` reads both queues with plain commands, not a `MULTI` pipeline. Genie reads the rank with one plain `ZRANK`. The spike pipeline read let an injected `WatchError` escape a read-only call, so `test_redis_store_retries_watch_errors[update]` failed. The position is advisory, as it is on genie. Measured in the probe.
4. `StoreLimits.ordinary_reserved_slots` defaults to **0**, not 1 as in the spike. `ServerSettings.from_env()` and compose still give 1 (spec P9, W2 ruling). With 0 the genie tests that use `StoreLimits(max_pending=1)` need no edits.
5. `server/queue_state.py` is a v2-only file, but it changes too: `QUEUE_STATE_MACHINE_VERSION = "v2"` (X13) and the two shared rules `queue_sort_key` and `validate_transition` that both stores call (spike 2.1).

## Global Constraints

- Upstream: v1 repo `/home/kenan/work/nurse-scheduling`, branch `feature/genie`, commit `1bf4b85`. Read it only with `git -C /home/kenan/work/nurse-scheduling show|diff|log|rev-parse`.
- Spike source: branch `kenan-xin/spike-w6-lease` at `220d7a626e02d92a75b1a1605482801d49c6de28`, base `970c956`. It is present in this repo. Read it only with `git show`. It is evidence and a code source. It is never merged.
- Base: `develop` with W0, W1 and W2 merged (the manifest has 68 rows). W6 is one branch, `feat/v1-sync-w6`, in its own worktree, merged back into `develop` (`CLAUDE.md` branch flow). The Task 2 commit leaves the v2 T19 suites red, because their calls change in Task 3 (spec: "the store, controller and worker change together"). Every commit from Task 3 on must pass the full core gate.
- W6 owns these genie paths. Source: `server/job_store.py`, `server/jobs/{models,controller,worker}.py`, `server/stores/{memory,redis}.py`, `server/usage_metrics.py`. Tests: `tests/test_serve.py`, `tests/test_optimize_job_backends.py`. W6 also edits the W2 patches for `server/config.py` and `server/app.py` (only to remove P12 and bump the prefix), and the v2-only `server/queue_state.py`.
- Not adopted: `usage_report.py`, `tests/test_usage_metrics.py` (X6). `usage_metrics.py` is vendored only because genie `stores/redis.py` imports it. `USAGE_METRICS_ENABLED` stays unset (default `false`). No compose file, script or doc sets it.
- The product stays CP-SAT only. `SOLVER_SEMANTIC_VERSION` does not change: W6 changes no solve meaning.
- Key namespace: `nurse_scheduling:jobs:v2` (X13). Queued and running jobs under `:v1` are dropped at cutover. No migration code.
- Upstream Ruff: genie files pass the v2 pin as they are (measured by the spike). Never reformat a genie file. Fix only v2 lines.
- Shell convention (from W2). Shell state does not persist between blocks. Every block starts with `cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh`, uses `$PY` and runs `core/` commands in a subshell, for example `(cd core && …)`.
- Exit codes. Never pipe a test run into `tail` or `grep` to decide pass or fail. Write a log, keep the exit status, then read the log.
- Real Redis. Every full core run sets **both** `NURSE_TEST_REDIS_URL` (v2 suites) and `JOB_REDIS_TEST_URL` (genie suites). A run whose log contains a skip reason naming either variable does not count.
- Commits run only after the user approves this plan for execution. Do not push. Push and merge need separate approval (conservative profile). Track work with `bd`. Use `cp -rf` and `rm -rf`.

## Patch IDs used in W6 patch headers

| ID | v2 concern | W6 files that carry hunks |
| --- | --- | --- |
| P5 | Workspace boundary: scenarios checked at submit, `unsupported_solver` 422 | `tests/test_serve.py` |
| P6 | Event replay: `prepare_event_replay` as a `WATCH`/`MULTI`/`EXEC` snapshot | `job_store.py`, `jobs/models.py` (`EventReplayWindow`), `jobs/controller.py`, `stores/memory.py`, `stores/redis.py` |
| P7 | Roster container | none. The hooks live in `jobs/runner.py` (W2). |
| P8 | Basis and INCONCLUSIVE: job model fields, `expires_at`, explicit serialize and deserialize in `redis.py`, `semantic_profile` in `/info` | `jobs/models.py`, `jobs/controller.py`, `stores/redis.py`, `tests/test_serve.py` |
| P9 | T09 purpose queues: `JobPurpose`, reserve admission, ordinary-first claim, `describe_queue_state`, residue repair, invariant records, `QueueInvariantError` | `job_store.py`, `jobs/models.py`, `jobs/controller.py`, `stores/memory.py`, `stores/redis.py` |
| P10 | Shutdown write gate: `_shutdown_lock` in the worker, and settling an observed cancellation | `jobs/worker.py` |
| P11 | `/health` shim | `tests/test_serve.py` |

P12 (the T19 fence bridge) ends in W6: Task 2 deletes every P12 hunk from `W2-server-config.patch` and `W2-server-app.patch`.

## Target origin class per W6 file

| File (under `core/`) | Class | Patch IDs | Patch file |
| --- | --- | --- | --- |
| `nurse_scheduling/server/usage_metrics.py` | verbatim | none | none (new, X6) |
| `nurse_scheduling/server/job_store.py` | patched | P6, P9 | `W6-server-job_store.patch` |
| `nurse_scheduling/server/jobs/models.py` | patched | P6, P8, P9 | `W6-server-jobs-models.patch` |
| `nurse_scheduling/server/jobs/controller.py` | patched | P6, P8, P9 | `W6-server-jobs-controller.patch` |
| `nurse_scheduling/server/jobs/worker.py` | patched | P10 | `W6-server-jobs-worker.patch` |
| `nurse_scheduling/server/stores/memory.py` | patched | P6, P9 | `W6-server-stores-memory.patch` |
| `nurse_scheduling/server/stores/redis.py` | patched | P6, P8, P9 | `W6-server-stores-redis.patch` |
| `tests/test_optimize_job_backends.py` | verbatim | none | none (restored) |
| `tests/test_serve.py` | patched | P5, P8, P11 | `W6-tests-test_serve.patch` |
| `nurse_scheduling/server/config.py` | patched (W2 row) | P9, P13 (P12 removed) | `W2-server-config.patch`, regenerated |
| `nurse_scheduling/server/app.py` | patched (W2 row) | P5, P8, P9, P11 (P12 removed) | `W2-server-app.patch`, regenerated |

Deleted: `server/stores/queue_script.py`, `tests/test_server_upstream_surface.py`. v2-only and changed: `server/queue_state.py`, `tests/conftest.py`, the v2 T19 suites. After W6 the manifest has 68 + 9 = 77 rows. If the `r6g` branch merges first, it has 79.

## Review Focus

- **Cutover with old keys in Redis.** The first deploy of W6 meets a Redis that still holds `nurse_scheduling:jobs:v1:*` keys, maybe with queued jobs. The new app must start, report ready, and never claim or list those jobs. Pinned by Task 4 Step 1 (`test_v1_namespace_residue_is_invisible_to_the_v2_store`).
- **A worker dies mid-job (deploy restart, OOM kill).** The killed job must end `worker_lost` after the lease expires. A replacement process must claim the next job, and it must never run the lost job again. Pinned by the rewritten `test_server_worker_loss_multiprocess.py` (Task 3) and `deploy_gate_driver.py workerlost` (Task 5).
- **A graceful stop while a job runs.** After `stop()` returns, no buffered event, result or failure lands. A cancellation that the worker observed under its live lease still settles. Pinned by the 5 P10 lifecycle tests in `test_server_lifecycle_gates.py` (Task 3).
- **Diagnostics under load.** An assistant diagnostic must never take the reserved ordinary slot. Ordinary work is claimed first. Both rules hold with no Lua and under concurrent creates. Pinned by `test_server_priority_queue.py` on 3 backends (Task 3) and `docker/reserve_gate_probe.py` over HTTP on real Redis (Task 5).
- **Telemetry stays off.** With no environment set, the Redis store gets no usage-metrics prefix and writes no metrics keys. Pinned by Task 4 Step 1 (`test_env_settings_keep_the_v2_defaults` and `test_default_app_writes_no_usage_metrics_keys`).

## Waiting beads and where they land

| Bead | Placement | Unblocked by |
| --- | --- | --- |
| `nursing-sheduler-r6g` (v1 solver capability probe, in progress) | Done on unmerged branch `chore/r6g-solver-probe-verbatim` (`f810877`). The notes say "re-check at W6". Task 5 Step 4 re-runs its test and probe on the W6 tip. If `r6g` is not merged yet, Task 5 reports that, and the check runs after both merge. | Task 2 (genie `create_app` on the lease store) |
| `nursing-sheduler-l3m` (infeasibility explanation, deferred) | Needs new result fields serialized in the genie stores. After W6 it adds a P8-style hunk to `W6-server-stores-redis.patch`. Task 6 un-defers it with that note. | Task 2 |
| `nursing-sheduler-qq0.27.5` (TestClient httpx deprecation, deferred) | The server suites are final after W6. Task 6 un-defers it. The probe still shows the `StarletteDeprecationWarning`. | Task 4 |
| `USAGE_METRICS_ENABLED` | Inert on `develop` (W2 P12 dropped the store arguments). W6 restores the genie arguments. After W6, setting the variable starts writing counters to Redis. X6 keeps it unset. Task 4 pins the default, and Task 6 documents it. | Task 2 |
| W2 hand-off (`v1sync-w2-handoff…`) | (1) P12 hunks: Task 2. (2) Delete `test_server_upstream_surface.py`: Task 4. (3) Drop the shims `get_activity`, `auth_credential_id` and `is_ready`: Task 2 (the genie files carry the real ones). (4) Reserve default 0, env 1: Task 2. | Tasks 2 and 4 |

---

### Task 1: Worktree, venv, Redis, helper library, baselines

**Files:**
- Create (outside the repo): `/tmp/v1sync-w6-root`, `/tmp/v1sync-w6-lib.sh`, `/tmp/v1sync-w6-venv`

- [ ] **Step 1: Create the worktree, the venv and Redis**

```bash
cd /home/kenan/orca/workspaces/nursing-sheduler/damselfish
wt switch --create feat/v1-sync-w6 --base develop --no-cd
git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch refs\/heads\/feat\/v1-sync-w6$/{print p}' > /tmp/v1sync-w6-root
cat /tmp/v1sync-w6-root
uv venv /tmp/v1sync-w6-venv --python 3.12
uv pip install --python /tmp/v1sync-w6-venv/bin/python -r "$(cat /tmp/v1sync-w6-root)/core/requirements-optional.txt"
docker run -d --rm --name v1sync-w6-redis -p 16400:6379 redis:8.8.0-alpine
docker exec v1sync-w6-redis redis-cli ping
git -C "$(cat /tmp/v1sync-w6-root)" rev-parse --verify 220d7a626e02d92a75b1a1605482801d49c6de28^{commit}
```
Expected: one absolute path, `PONG`, then the spike SHA. If the spike commit is missing, stop and report: this plan copies code from it.

- [ ] **Step 2: Write the helper library**

`/tmp/v1sync-w6-lib.sh`:
```bash
# Sourced by every W6 command block. Run from the worktree root.
UPSTREAM=/home/kenan/work/nurse-scheduling
PIN=1bf4b85
SPIKE=220d7a626e02d92a75b1a1605482801d49c6de28
SPIKE_BASE=970c956
PY=/tmp/v1sync-w6-venv/bin/python
RUFF=/tmp/v1sync-w6-venv/bin/ruff
REDIS_URL=redis://localhost:16400/0
MANIFEST=core/upstream-patches/manifest.toml

# Copy one genie file into core/.  $1 = path under core/
w6_take() { mkdir -p "core/$(dirname "$1")"; git -C "$UPSTREAM" show "$PIN:core/$1" > "core/$1"; }

# Copy one spike file into core/.  $1 = path under core/
w6_spike_take() { git show "$SPIKE:core/$1" > "core/$1"; }

# 3-way merge the spike's change to a file onto the current file, in place.
# $1 = repo-relative path.  Returns the conflict count (0 = clean).
w6_spike_merge() {
  local base other; base=$(mktemp); other=$(mktemp)
  git show "$SPIKE_BASE:$1" > "$base" 2>/dev/null || : > "$base"
  git show "$SPIKE:$1" > "$other"
  git merge-file "$1" "$base" "$other"; local rc=$?
  rm -f "$base" "$other"; return $rc
}

# Append one manifest row unless present.  $1 = path, $2 = class, $3 = patch file (patched only)
w6_row() {
  grep -q "^path = \"$1\"$" "$MANIFEST" && return 0
  local sha; sha=$(git -C "$UPSTREAM" rev-parse "$PIN:core/$1")
  printf '\n[[file]]\npath = "%s"\nclass = "%s"\nupstream_blob = "%s"\n' "$1" "$2" "$sha" >> "$MANIFEST"
  if [ -n "${3:-}" ]; then printf 'patches = ["%s"]\n' "$3" >> "$MANIFEST"; fi
}

# (Re)write the per-file patch genie -> current file and record it. An existing patch keeps
# its place in patch_order.  $1 = W2|W6, $2 = path under core/, rest = header lines.
sync_patch() {
  local wave="$1" p="$2"; shift 2
  local name; name="$wave-$(printf '%s' "$p" | sed 's#^nurse_scheduling/##; s#/#-#g; s#\.py$##').patch"
  local scratch; scratch=$(mktemp -d)
  git -C "$scratch" init -q
  mkdir -p "$scratch/core/$(dirname "$p")"
  git -C "$UPSTREAM" show "$PIN:core/$p" > "$scratch/core/$p"
  git -C "$scratch" add -A
  git -C "$scratch" -c user.name=w6 -c user.email=w6@localhost commit -qm genie
  cp -f "core/$p" "$scratch/core/$p"
  if git -C "$scratch" diff --quiet -- "core/$p"; then
    echo "sync_patch: $p equals genie; record it with w6_row $p verbatim" >&2; rm -rf "$scratch"; return 1
  fi
  { printf '# %s\n' "$wave patch for core/$p against genie $PIN." "$@"; printf '\n'; git -C "$scratch" diff -- "core/$p"; } \
    > "core/upstream-patches/$name"
  rm -rf "$scratch"
  grep -q "\"$name\"" "$MANIFEST" || sed -i "s/^patch_order = \[\(.*\)\]$/patch_order = [\1, \"$name\"]/" "$MANIFEST"
  w6_row "$p" patched "$name"
  echo "$name"
}

# Full core gate: ruff, upstream check, pytest on memory + fakeredis + real Redis.  $1 = log tag
w6_core() {
  (cd core && $RUFF check . ../docker && $RUFF format --check . ../docker) || return 1
  (cd core && PYTHONPATH=. $PY -m scripts.check_upstream_sync) || return 1
  (cd core && NURSE_TEST_REDIS_URL=$REDIS_URL JOB_REDIS_TEST_URL=$REDIS_URL PYTHONPATH=. \
    $PY -m pytest -q -rs -p no:cacheprovider) > "/tmp/v1sync-w6-$1.log" 2>&1
  local status=$?
  tail -1 "/tmp/v1sync-w6-$1.log"
  if grep -qE 'NURSE_TEST_REDIS_URL|JOB_REDIS_TEST_URL' "/tmp/v1sync-w6-$1.log"; then echo "real Redis skipped" >&2; return 1; fi
  return $status
}
```

- [ ] **Step 3: Record the baselines**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
w6_core base; echo "core exit=$?"
grep -c '^\[\[file\]\]' "$MANIFEST"
```
Expected: `core exit=0`, `checked 68 files against 1bf4b85: 0 problem(s)`, and `68`. With `r6g` merged, both numbers are 70. Keep `/tmp/v1sync-w6-base.log`. Task 5 compares with it.

- [ ] **Step 4: Track the work**

```bash
cd "$(cat /tmp/v1sync-w6-root)"
bd create "v1 sync W6: worker lease registry (plan docs/superpowers/plans/2026-09-27-v1-sync-w6-worker-lease.md)" -t task -p 2
```
Claim the printed id with `bd update <id> --claim`.

### Task 2: Genie lease store with P6, P8, P9 and P10, and the end of P12

**Files:**
- Replace from genie: `core/nurse_scheduling/server/usage_metrics.py` (new), `core/tests/test_optimize_job_backends.py` (new)
- Replace from the spike, then correct: `core/nurse_scheduling/server/{job_store,queue_state}.py`, `core/nurse_scheduling/server/jobs/{models,controller,worker}.py`, `core/nurse_scheduling/server/stores/{memory,redis}.py`
- Delete: `core/nurse_scheduling/server/stores/queue_script.py`
- Modify: `core/nurse_scheduling/server/config.py`, `core/nurse_scheduling/server/app.py`, `docker/compose.yml:62`, `docker/verify-stream.sh:72`
- Create: `core/upstream-patches/W6-server-{job_store,jobs-models,jobs-controller,jobs-worker,stores-memory,stores-redis}.patch`. Regenerate: `W2-server-config.patch`, `W2-server-app.patch`.

**Interfaces:**
- Produces (genie):
  - `WorkerLease(worker_id, token, expires_at)`.
  - `JobController(store, limits, retention_seconds, worker_lease_seconds, runtime_identity, clock, id_factory)`.
  - Lease methods on the controller: `register_worker(worker_id) -> WorkerLease | None`, `renew_worker(lease)`, `unregister_worker(lease)`, `claim_next_job(lease) -> Job | None`, `expire_worker_claims()`.
  - Fenced writes on the controller: `record_event(…, lease=)`, `complete_job(…, lease=)`, `fail_job(…, lease=)`, `complete_cancellation(job_id, lease)`, `is_stop_requested(job_id, lease)`.
  - `get_activity() -> ServerActivity`.
  - `JobWorker(controller, runner, worker_id=, claim_poll_seconds=, worker_lease_seconds=, timeout_grace_seconds=, unexpected_error_formatter=)` with `start()`, `stop()`, `is_alive()` and `is_ready()`.
  - `ServerSettings.worker_lease_seconds` (`JOB_WORKER_LEASE_SECONDS`, default 90).
- Produces (v2 patches): `JobController.create_job(…, auth_credential_id=None, basis=None, purpose=JobPurpose.ORDINARY)`, `prepare_event_replay(job_id, requested_cursor) -> EventReplayWindow` (P6), `repair_queue_residue() -> list[str]` (P9). The stores also have `describe_queue_state() -> QueueStateSnapshot` and `recent_invariant_errors() -> list[dict[str, str]]` (P9). `StoreLimits(max_pending, max_retained, ordinary_reserved_slots=0)`. `queue_state.queue_sort_key(purpose, created_at, job_id)` and `queue_state.validate_transition(current_state, current_purpose, replacement)`.
- Removed: `RedisJobStore(client=…, test_lease_commit_boundary=…)`, `find_claimed_before`, `renew_claim`, `claim_next_job("<worker id>")`, `ServerSettings.claim_lease_seconds` and `JOB_CLAIM_LEASE_SECONDS`.

- [ ] **Step 1: Write the failing test (genie store contract, verbatim)**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
w6_take tests/test_optimize_job_backends.py
(cd core && JOB_REDIS_TEST_URL=$REDIS_URL PYTHONPATH=. $PY -m pytest -q -p no:cacheprovider tests/test_optimize_job_backends.py) > /tmp/v1sync-w6-t2-red.log 2>&1; echo "red exit=$?"
```
Expected: non-zero, with an `ImportError` on `WorkerLease` (the T19 models do not have it).

- [ ] **Step 2: Take the store, controller and worker**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
w6_take nurse_scheduling/server/usage_metrics.py
for p in job_store queue_state jobs/models jobs/controller jobs/worker stores/memory stores/redis; do
  w6_spike_take "nurse_scheduling/server/$p.py"
done
git rm -q core/nurse_scheduling/server/stores/queue_script.py
```
Each spike file is genie `1bf4b85` plus v2 lines. `queue_state.py` is v2-only, and the spike copy equals `develop` plus the version bump and the two shared rules. Both facts were checked with `diff` while this plan was written.

- [ ] **Step 3: Apply the three corrections**

(a) `core/nurse_scheduling/server/jobs/models.py`, `StoreLimits`. Change the default and its docstring:
```python
    ordinary_reserved_slots: int = 0
    """v2 P9: pending slots only ordinary work may be admitted into (T09).

    Zero for direct construction, so upstream-shaped limits such as
    `StoreLimits(max_pending=1, ...)` stay valid. `ServerSettings.from_env()` and the
    compose file supply the shipped value of 1.
    """
```
Keep the spike `__post_init__` check (`0 <= reserve < max_pending`).

(b) `core/nurse_scheduling/server/stores/redis.py`, `__init__`. Replace the spike line `self._queue_keys = {purpose: self._key("queue", purpose.value) for purpose in JobPurpose}` with:
```python
        self._queue_key = self._key("queue")
        # v2 P9: the ordinary queue keeps the genie key; diagnostics get their own queue.
        self._queue_keys = {
            JobPurpose.ORDINARY: self._queue_key,
            JobPurpose.ASSISTANT_DIAGNOSTIC: self._key("queue", JobPurpose.ASSISTANT_DIAGNOSTIC.value),
        }
```
Check that genie's own `self._queue_key = self._key("queue")` line does not remain as a duplicate: `grep -n '_queue_key = ' core/nurse_scheduling/server/stores/redis.py` must print one line.

(c) Same file, `_with_queue_position`. Replace the spike body after the `if job.state != JobState.QUEUED` guard with:
```python
        # v2 P9: plain reads of both queues, like genie's single ZRANK. The position is
        # advisory, and a read-only call must not surface a WatchError.
        order = self._effective_ids(self._read_queue_members(self._redis))
        return replace(job, queue_position=order.index(job.id) + 1 if job.id in order else None)
```

- [ ] **Step 4: End P12 in `config.py` and `app.py`, and bump the key prefix (X13)**

`config.py`: rename `claim_lease_seconds` back to the genie `worker_lease_seconds` everywhere (the field, its genie docstring `"""Time a worker remains online without renewing its shared lease."""`, the positive-number name list, and `from_env` with `JOB_WORKER_LEASE_SECONDS`). Change both `nurse_scheduling:jobs:v1` literals to `nurse_scheduling:jobs:v2`. Add one paragraph to the end of the `redis_key_prefix` docstring:
```
    Bumped v1 to v2 by v1 sync W6 (X13): the genie worker lease registry replaced the
    T19 claim keys and the Lua queue script. v1 keys are ignored, not migrated.
```
`app.py`: in `_create_store`, restore the two genie arguments after `max_events_per_job=…`:
```python
        usage_metrics_key_prefix=(settings.usage_metrics_key_prefix if settings.usage_metrics_enabled else None),
        usage_metrics_retention_days=settings.usage_metrics_retention_days,
```
Change `claim_lease_seconds=settings.claim_lease_seconds` to `worker_lease_seconds=settings.worker_lease_seconds` in the controller and in the worker. Change the `/info` line back to genie: `"workers": {"online": activity.online_workers},`.

`docker/compose.yml:62`: `JOB_REDIS_KEY_PREFIX: nurse_scheduling:jobs:v2`. `docker/verify-stream.sh:72`: `JOB_KEY_PATTERN="nurse_scheduling:jobs:v2*"`. That line was already stale at `v0`, before W6 (spike 3.7).

```bash
cd "$(cat /tmp/v1sync-w6-root)"
grep -rn "claim_lease\|JOB_CLAIM_LEASE\|queue_script\|jobs:v1" core/nurse_scheduling docker scripts; echo "left=$?"
```
Expected: `left=1` (no match). The test files still match, and Task 3 fixes them.

- [ ] **Step 5: Run the genie store contract and the stores**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
(cd core && JOB_REDIS_TEST_URL=$REDIS_URL PYTHONPATH=. $PY -m pytest -q -rs -p no:cacheprovider tests/test_optimize_job_backends.py) > /tmp/v1sync-w6-t2-green.log 2>&1; echo "green exit=$?"; tail -1 /tmp/v1sync-w6-t2-green.log
(cd core && $RUFF check nurse_scheduling && $RUFF format --check nurse_scheduling); echo "ruff exit=$?"
```
Expected: `green exit=0`, no `JOB_REDIS_TEST_URL` skip line, and `ruff exit=0`. If `test_redis_store_removes_corrupt_queue_entries` or `test_redis_store_retries_watch_errors[update]` fails, correction (b) or (c) is missing.

- [ ] **Step 6: Review the P10 gate and the WATCH sets before recording**

Read `git diff "$SPIKE_BASE" "$SPIKE" -- core/nurse_scheduling/server/jobs/worker.py` only as context. The gate is `git -C "$UPSTREAM" show "$PIN:core/nurse_scheduling/server/jobs/worker.py" | diff - core/nurse_scheduling/server/jobs/worker.py`. It must show only:
- `self._shutdown_lock` in `__init__`, and `stop()` setting `_stop` under it.
- `shutting_down()`, which returns `self._stop.is_set() or monitor_stop.is_set()`.
- `publish`, `complete_job` and both `fail_job` sites guarded by `with self._shutdown_lock: if shutting_down(): return / skip`.
- The `except Exception` branch. If `cancellation_requested.is_set() and not monitor_stop.is_set()`, it settles `complete_cancellation(job.id, lease)`.

In `redis.py` check the `WATCH` sets against spec P9:
- Create and repair watch the pending set and both queues.
- Claim watches both queues and the worker keys.
- Update watches both queues only for a job that leaves QUEUED.

Any other difference from genie is a defect. Remove it before Step 7.

- [ ] **Step 7: Record the patches and the rows, then commit**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
w6_row nurse_scheduling/server/usage_metrics.py verbatim
w6_row tests/test_optimize_job_backends.py verbatim
sync_patch W6 nurse_scheduling/server/job_store.py \
  "hunk: prepare_event_replay protocol method (P6)" \
  "hunk: describe_queue_state, repair_queue_residue, recent_invariant_errors, admission errors (P9)"
sync_patch W6 nurse_scheduling/server/jobs/models.py \
  "hunk: EventReplayWindow (P6)" \
  "hunk: INCONCLUSIVE outcome, basis fields, expires_at (P8)" \
  "hunk: JobPurpose, request purpose, StoreLimits.ordinary_reserved_slots default 0 (P9)"
sync_patch W6 nurse_scheduling/server/jobs/controller.py \
  "hunk: prepare_event_replay (P6)" \
  "hunk: basis and expires_at at create (P8)" \
  "hunk: purpose at create, repair_queue_residue (P9)"
sync_patch W6 nurse_scheduling/server/jobs/worker.py \
  "hunk: shutdown write gate and settling an observed cancellation (P10)"
sync_patch W6 nurse_scheduling/server/stores/memory.py \
  "hunk: prepare_event_replay under the store lock (P6)" \
  "hunk: reserve admission, ordinary-first order, transition rules, queue snapshot (P9)"
sync_patch W6 nurse_scheduling/server/stores/redis.py \
  "hunk: prepare_event_replay WATCH/MULTI/EXEC snapshot (P6)" \
  "hunk: explicit basis, purpose and INCONCLUSIVE serialize and deserialize (P8)" \
  "hunk: two purpose queues (ordinary keeps the genie key), reserve admission, WATCH sets, residue repair, invariant records, queue snapshot (P9)"
sync_patch W2 nurse_scheduling/server/config.py \
  "hunk: _non_negative_int, ordinary_reserved_slots (dataclass 0, env 1), key prefix v2 (P9)" \
  "hunk: default_prettify False (P13)"
sync_patch W2 nurse_scheduling/server/app.py \
  "hunk: 422 SchedulingContentError handler (P5)" \
  "hunk: semantic_profile in /info (P8)" \
  "hunk: reserve in StoreLimits, QueueInvariantError 409 (P9)" \
  "hunk: /health shim, maintenance liveness in readiness (P11)"
grep -c "P12\|claim_lease" core/upstream-patches/W2-server-config.patch core/upstream-patches/W2-server-app.patch
(cd core && PYTHONPATH=. $PY -m scripts.check_upstream_sync); echo "check exit=$?"
git add -A core docker && git commit -m "feat(core): take genie worker lease registry; re-apply P6 P8 P9 P10; end the T19 fence bridge (v1 sync W6)"
```
Expected: six `W6-…patch` names, then `W2-server-config.patch` and `W2-server-app.patch`. Both grep counts are `0`. `checked 76 files …: 0 problem(s)` (78 with `r6g`), and `check exit=0`. The v2 T19 suites are still red at this commit, and Task 3 turns them green. Say so in the commit body.

### Task 3: Rewrite the v2 T19 suites to the lease API

**Files:**
- Modify: `core/tests/test_server_upstream_surface.py` (three T19-bound tests, Step 2)
- Modify (3-way merge of the spike rewrite onto `develop`): `core/tests/server_support.py`, `core/tests/test_roster_routes.py`, `core/tests/test_server_backend_parity.py`, `core/tests/test_server_identity.py`, `core/tests/test_server_lifecycle_gates.py`, `core/tests/test_server_priority_queue.py`, `core/tests/test_server_replay.py`, `core/tests/test_server_store_contract.py`, `core/tests/test_server_worker_loss.py`, `core/tests/test_server_worker_loss_multiprocess.py`, `docker/deploy_gate_driver.py`

**Interfaces:**
- Consumes: the Task 2 lease API. `server_support.py` builds fakeredis stores by patching `redis.Redis.from_url` under a module lock (spike 3.3), because `test_redis_store_identity_is_shared_by_one_namespace` builds 8 stores in a thread pool.
- Rule (spec): keep every behaviour assertion and rewrite the calls. Delete only assertions about Lua-only mechanics. The spike deleted exactly 4 lines, listed in Step 3.

- [ ] **Step 1: Check red**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
(cd core && NURSE_TEST_REDIS_URL=$REDIS_URL PYTHONPATH=. $PY -m pytest -q -p no:cacheprovider tests/test_server_store_contract.py tests/test_server_lifecycle_gates.py) > /tmp/v1sync-w6-t3-red.log 2>&1; echo "red exit=$?"
```
Expected: non-zero. The errors are `claim_next_job` given a string, `renew_claim` missing, and `RedisJobStore` given `client=`.

- [ ] **Step 2: Merge the spike rewrites**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
for f in core/tests/server_support.py core/tests/test_roster_routes.py core/tests/test_server_backend_parity.py \
         core/tests/test_server_identity.py core/tests/test_server_lifecycle_gates.py core/tests/test_server_priority_queue.py \
         core/tests/test_server_replay.py core/tests/test_server_store_contract.py core/tests/test_server_worker_loss.py \
         core/tests/test_server_worker_loss_multiprocess.py docker/deploy_gate_driver.py; do
  w6_spike_merge "$f"; echo "$f conflicts=$?"
done
```
Expected: `conflicts=0` for all 11 files. The probe for this plan measured that result.

Three tests in the W2 stand-in `core/tests/test_server_upstream_surface.py` are bound to T19 or P12. The probe showed that they fail after Task 2. Fix them here, so this task ends green. Task 4 deletes the rest of the file.
- Delete `test_claim_lease_keeps_its_v2_name_until_w6` (P12 is gone).
- Delete `test_info_reports_cancelling_jobs_separately` in this file only. It calls the T19 `claim_next_job("<worker id>")`, and the genie copy returns in Task 4.
- In `test_env_settings_keep_the_v2_reserve_and_prettify_default`, change the prefix assertion to `"nurse_scheduling:jobs:v2"`. If a later `develop` commit causes a conflict, resolve it with this rule: keep the develop behaviour change and the spike's lease-API call. Do not port `core/tests/test_server_genie_lease.py`: Task 4 restores the genie files it came from.

- [ ] **Step 3: Check the deleted-assertion budget**

```bash
cd "$(cat /tmp/v1sync-w6-root)"
git diff -U0 HEAD -- core/tests | grep -E '^-\s*(assert|with pytest\.raises)' > /tmp/v1sync-w6-deleted.txt; wc -l < /tmp/v1sync-w6-deleted.txt
git diff -U0 HEAD -- core/tests | grep -E '^\+\s*(assert|with pytest\.raises)' | wc -l
```
Read every removed line. Each must be one of these: rewritten in place (its replacement is in the added lines), or one of the 4 spec deletions:
1. and 2. `test_server_priority_queue.py::test_every_state_machine_key_shares_one_hash_tag`, both lines. The Lua script needed one cluster slot, and genie keys have no hash tag.
3. `test_server_worker_loss.py`: the `claim_expires_at` equality. It was a T19-only field.
4. `test_server_worker_loss.py`: the `worker_id` equality. The revision check covers it.

The memory variant of the 5 residue tests skips with `memory store has no queue index to corrupt`. Any other net deletion is a defect: restore the assertion against the lease API.

- [ ] **Step 4: Check green on all three backends**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
(cd core && NURSE_TEST_REDIS_URL=$REDIS_URL JOB_REDIS_TEST_URL=$REDIS_URL PYTHONPATH=. $PY -m pytest -q -rs -p no:cacheprovider \
  tests/test_server_store_contract.py tests/test_server_replay.py tests/test_server_worker_loss.py \
  tests/test_server_worker_loss_multiprocess.py tests/test_server_backend_parity.py tests/test_server_lifecycle_gates.py \
  tests/test_server_priority_queue.py tests/test_roster_routes.py tests/test_server_identity.py tests/test_optimize_job_backends.py) \
  > /tmp/v1sync-w6-t3.log 2>&1; echo "exit=$?"; tail -1 /tmp/v1sync-w6-t3.log
grep -n "test_w6_accepted_gap_late_write_before_worker_lost_lands\|test_sigkilled_worker_becomes_worker_lost_in_replacement_process" core/tests/test_server_worker_loss*.py
```
Expected: `exit=0`. The only skips are the 5 memory residue variants. Both named tests exist: the first pins the accepted late-write gap, and the second is the `SIGKILL` gate.

- [ ] **Step 5: Full gate and commit**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
w6_core task3; echo "gate exit=$?"
git add core docker && git commit -m "test(core): rewrite the T19 suites to the genie lease API; keep every behaviour assertion (v1 sync W6)"
```
Expected: `gate exit=0`. The only failures the probe saw at this point were the three surface tests that Step 2 fixes.

### Task 4: Restore genie `test_serve.py` and retire the W2 surface file

**Files:**
- Replace from genie, then patch: `core/tests/test_serve.py` (`W6-tests-test_serve.patch`)
- Modify: `core/tests/conftest.py` (the upstream deviation list), `core/tests/test_server_api.py`, `core/tests/test_server_priority_queue.py`, `.github/workflows/ci.yml` (core job env)
- Delete: `core/tests/test_server_upstream_surface.py`

**Interfaces:**
- Produces: `tests/conftest.py::UPSTREAM_DEVIATIONS: dict[str, str]`, which maps a genie test node id to its skip reason, and a `pytest_collection_modifyitems` hook that skips those ids. The list is the one place that names the genie tests whose asserted behaviour v2 changes on purpose. If a genie rename makes an entry stale, the renamed test runs and fails, so a stale entry cannot hide a pass.

- [ ] **Step 1: Write the new v2 tests (red where W6 changed behaviour)**

Move the remaining v2-only tests out of `test_server_upstream_surface.py` and delete the rest of the file. Every other test in it is a port of a genie `test_serve.py` test (checked by name).

Append to `core/tests/test_server_priority_queue.py`:
```python
def test_direct_settings_reserve_no_slot_so_upstream_shapes_stay_valid():
    assert ServerSettings(max_pending_jobs=1).ordinary_reserved_slots == 0
    assert StoreLimits(max_pending=1, max_retained=1).ordinary_reserved_slots == 0


def test_env_settings_keep_the_v2_defaults(monkeypatch):
    for name in (
        "JOB_ORDINARY_RESERVED_SLOTS",
        "JOB_MAX_PENDING",
        "OPTIMIZE_DEFAULT_PRETTIFY",
        "JOB_REDIS_KEY_PREFIX",
        "JOB_WORKER_LEASE_SECONDS",
        "USAGE_METRICS_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)
    settings = ServerSettings.from_env()
    assert settings.ordinary_reserved_slots == 1
    assert settings.max_pending_jobs == 32  # genie default; compose and dev.sh set 8
    assert settings.default_prettify is False
    assert settings.redis_key_prefix == "nurse_scheduling:jobs:v2"  # X13
    assert settings.worker_lease_seconds == 90.0
    assert settings.usage_metrics_enabled is False  # X6
    assert settings.solver_ids == ("ortools/cp-sat",)
    assert settings.auth_required is False and settings.auth_token is None


OLD_JOB_ID = "job_" + "0" * 32


def test_v1_namespace_residue_is_invisible_to_the_v2_store(monkeypatch):
    # X13 cutover: keys left by the T19 deployment must not reach the lease store.
    server = fakeredis.FakeServer()
    monkeypatch.setattr(
        redis_store.redis.Redis,
        "from_url",
        lambda url, **kwargs: fakeredis.FakeRedis.from_url(url, server=server, **kwargs),
    )
    raw = fakeredis.FakeRedis(server=server)
    raw.zadd("nurse_scheduling:jobs:v1:{q}:queue:ordinary", {OLD_JOB_ID: 1.0})
    raw.hset(f"nurse_scheduling:jobs:v1:{{q}}:job:{OLD_JOB_ID}", mapping={"state": "queued"})
    settings = ServerSettings(job_backend="redis", redis_url="redis://localhost/0")
    with TestClient(create_app(settings=settings, start_background=False)) as client:
        assert client.get("/ready").status_code == 200
        assert client.get("/info").json()["jobs"] == {"running": 0, "queued": 0, "cancelling": 0}
        assert client.get(f"/optimize/{OLD_JOB_ID}").status_code == 404
        store = client.app.state.job_store
    now = datetime.now(timezone.utc)
    lease = WorkerLease("w", "t", now + timedelta(seconds=30))
    assert store.register_worker(lease, now)
    assert store.claim_next_job(lease, now) is None


def test_default_app_writes_no_usage_metrics_keys(monkeypatch):
    # X6: USAGE_METRICS_ENABLED stays off. Genie stages metrics at create, so a created
    # job must leave no key under the metrics prefix.
    server = fakeredis.FakeServer()
    monkeypatch.setattr(
        redis_store.redis.Redis,
        "from_url",
        lambda url, **kwargs: fakeredis.FakeRedis.from_url(url, server=server, **kwargs),
    )
    settings = ServerSettings(job_backend="redis", redis_url="redis://localhost/0")
    assert settings.usage_metrics_enabled is False
    with TestClient(create_app(settings=settings, start_background=False)) as client:
        assert client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO}).status_code == 202
    keys = [key.decode() for key in fakeredis.FakeRedis(server=server).scan_iter("*")]
    assert keys
    assert not [key for key in keys if key.startswith(settings.usage_metrics_key_prefix)]
```
Add the missing imports in sorted position: `fakeredis`, `from datetime import datetime, timedelta, timezone`, `from fastapi.testclient import TestClient`, `from nurse_scheduling.server.app import create_app`, `from nurse_scheduling.server.config import ServerSettings`, `from nurse_scheduling.server.jobs.models import StoreLimits, WorkerLease`, `from nurse_scheduling.server.stores import redis as redis_store` and `from tests.server_support import MINIMAL_SCENARIO`. Some are already there. The key literals in the residue test only need to look like old keys. The test asserts that nothing under `:v1` is read. The probe for this plan ran the three new tests in this step: all pass, and Ruff is clean.

Append to `core/tests/test_server_api.py` the two W2 tests, unchanged: `test_a_non_cp_sat_solver_stays_a_422_even_when_the_allowlist_names_it` and `test_runtime_identity_reports_api_version_0_2_0`. Copy them from `git show HEAD:core/tests/test_server_upstream_surface.py`. They build their own `create_app(settings=ServerSettings(job_backend="memory", …))`.

Then delete `core/tests/test_server_upstream_surface.py`. The new `test_env_settings_keep_the_v2_defaults` replaces its env settings test. The genie `test_info_reports_shared_job_and_worker_activity` replaces its `test_info_reports_job_activity_and_the_process_worker`.

- [ ] **Step 2: Restore `test_serve.py` and adapt it**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
w6_take tests/test_serve.py
git rm -q core/tests/test_server_upstream_surface.py
```
Apply exactly these edits to `core/tests/test_serve.py`. Each one reuses the W2 adaptation of the same test.
- Imports: add `from nurse_scheduling.server.semantic_profile import semantic_profile` directly after the `runtime_identity` import, and `from tests.server_support import MINIMAL_SCENARIO` directly after the `stores.memory` import.
- `_create`: `data={"yaml_content": MINIMAL_SCENARIO, **data},` with the comment `# v2 P5: a valid scenario, because the Workspace boundary validates at submit.` above `return`.
- `test_info_and_readiness_report_status_without_caching`: in the expected dict, after `"claimed_performance": None,`, add `"semantic_profile": semantic_profile(),  # v2 P8`. Change `client.get("/health").status_code == 404` to `== 200  # v2 P11 keeps the /health shim`.
- `test_job_creation_offloads_the_synchronous_store_write`: `data={"yaml_content": MINIMAL_SCENARIO}` (P5).
- `test_job_creation_enforces_advertised_options`: `solver="ortools/cp-sat"` for `normalized`, with the comment `# v2 P5: only the exact CP-SAT selector passes parse_solver, before the allowlist.` The `disabled_solver` asserts become `status_code == 422` and `json()["error"]["code"] == "unsupported_solver"`, and `unknown_solver` becomes `status_code == 422`.
- `test_client_cookie_is_marked_secure_when_the_deployment_says_so`: both posts become `response = _create(client)`. The first one gets the comment `# v2 P5: the cookie is set only for an admitted job`.
- `test_file_input_uses_configured_limit_above_multipart_text_default`: before `accepted =`, add
```python
        # v2 (P5): the accepted file must be a valid scenario, padded to the limit.
        scenario = MINIMAL_SCENARIO.encode("utf-8")
        padded = scenario + b"#" * (max_yaml_bytes - len(scenario))
```
  and upload `padded`.
- `test_protected_routes_accept_the_configured_shared_token`: `data={"yaml_content": MINIMAL_SCENARIO},` (P5).

Append to `core/tests/conftest.py`:
```python
# Genie tests (restored verbatim in v1 sync W6) whose asserted behaviour v2 changes on
# purpose. Each entry names the v2 patch and the v2 suite that pins the v2 behaviour.
UPSTREAM_DEVIATIONS = {
    "tests/test_serve.py::test_create_complete_download_and_delete_job": (
        "v2 P7: the artifact is a roster container; see test_server_api.py and test_roster_routes.py"
    ),
    "tests/test_serve.py::test_optimization_runner_returns_expected_failure[UNKNOWN-expected_failure1]": (
        "v2 P8: UNKNOWN completes as INCONCLUSIVE; see test_runner_inconclusive.py"
    ),
    "tests/test_serve.py::test_optimization_runner_uses_job_timestamp_for_artifact_name": (
        "v2 P7: a schedule needs exactly one roster handoff; see test_runner_termination.py"
    ),
    "tests/test_serve.py::test_optimization_runner_classifies_feasible_termination[False-solver_timeout]": (
        "v2 P7: roster handoff; see test_runner_termination.py"
    ),
    "tests/test_serve.py::test_optimization_runner_classifies_feasible_termination[True-user_requested]": (
        "v2 P7: roster handoff; see test_runner_termination.py"
    ),
    "tests/test_serve.py::test_optimization_runner_ignores_stop_requested_after_solver_returns": (
        "v2 P7: roster handoff; see test_runner_termination.py"
    ),
    "tests/test_serve.py::test_cancellation_immediately_terminates_the_solver_process[pulp/highs]": (
        "X4: the server is CP-SAT only"
    ),
    "tests/test_serve.py::test_event_stream_has_ids_and_domain_event_names": (
        "v2 P6: opaque event cursors; see test_server_replay.py"
    ),
    "tests/test_serve.py::test_input_and_timeout_validation": (
        "v2 P5: scenarios are validated at submit; see test_server_api.py and test_server_scheduling_input.py"
    ),
}


def pytest_collection_modifyitems(config, items):
    """Skip the listed genie tests, so the restored file itself stays genie."""
    for item in items:
        reason = UPSTREAM_DEVIATIONS.get(item.nodeid)
        if reason is not None:
            item.add_marker(pytest.mark.skip(reason=reason))
```

- [ ] **Step 3: Check green**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
(cd core && NURSE_TEST_REDIS_URL=$REDIS_URL JOB_REDIS_TEST_URL=$REDIS_URL PYTHONPATH=. $PY -m pytest -q -rs -p no:cacheprovider \
  tests/test_serve.py tests/test_optimize_job_backends.py tests/test_server_api.py tests/test_server_priority_queue.py) \
  > /tmp/v1sync-w6-t4.log 2>&1; echo "exit=$?"; tail -1 /tmp/v1sync-w6-t4.log
grep -c "^SKIPPED.*test_serve.py" /tmp/v1sync-w6-t4.log
(cd core && $RUFF check tests && $RUFF format --check tests); echo "ruff exit=$?"
```
Expected: `exit=0`. The 9 `test_serve.py` skips carry the reasons above (the probe measured 252 passed and 9 skipped for the two genie files), and `ruff exit=0`. If one more genie test fails, first check whether it is a submit-time input (fix it with `MINIMAL_SCENARIO`, P5). If v2 changes that behaviour on purpose, add it to `UPSTREAM_DEVIATIONS` and name the v2 test that covers it. Otherwise fix the code.

- [ ] **Step 4: Let CI run the genie Redis variants**

`.github/workflows/ci.yml`, core job, step "Pytest (memory, fakeredis, real Redis)", `env:` block: add `JOB_REDIS_TEST_URL: redis://localhost:6379/0` below `NURSE_TEST_REDIS_URL`. Change the comment above it to `# Real-Redis store variants skip unless NURSE_TEST_REDIS_URL (v2 suites) and JOB_REDIS_TEST_URL (genie suites) are set.`. Both suites use unique key prefixes, so they can share one database.

- [ ] **Step 5: Record, gate, commit**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
sync_patch W6 tests/test_serve.py \
  "hunk: valid MINIMAL_SCENARIO at every HTTP submit, unsupported_solver 422 (P5)" \
  "hunk: semantic_profile in the /info body (P8)" \
  "hunk: /health stays 200 (P11)" \
  "note: genie tests whose behaviour v2 changes are skipped by tests/conftest.py UPSTREAM_DEVIATIONS"
w6_core task4; echo "gate exit=$?"
git add -A core .github && git commit -m "test(core): restore genie test_serve and test_optimize_job_backends; retire the W2 surface file (v1 sync W6)"
```
Expected: `W6-tests-test_serve.patch`, `checked 77 files …: 0 problem(s)` (79 with `r6g`), and `gate exit=0`.

### Task 5: Full gates

**Files:** none change unless a gate fails. If one fails, fix it in the task that owns the file.

- [ ] **Step 1: Core, all backends, upstream check with a drift probe, score replay**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
w6_core tip; echo "core exit=$?"
(cd core && PYTHONPATH=. $PY -m pytest -q tests/real/schedule_score_ground_truth.py); echo "replay exit=$?"
echo >> core/nurse_scheduling/server/stores/redis.py
(cd core && PYTHONPATH=. $PY -m scripts.check_upstream_sync); echo "drift exit=$?"
git restore -- core/nurse_scheduling/server/stores/redis.py
for i in 1 2 3; do (cd core && NURSE_TEST_REDIS_URL=$REDIS_URL PYTHONPATH=. $PY -m pytest -q -p no:cacheprovider tests/test_server_worker_loss_multiprocess.py tests/test_server_identity.py tests/test_server_lifecycle_gates.py) > /tmp/v1sync-w6-rep$i.log 2>&1; echo "repeat $i exit=$?"; done
```
Expected: `core exit=0` with no Redis skip, and a pass count at least the Task 1 baseline minus the deleted surface tests plus the restored genie tests. `replay exit=0`. `drift exit=1` with a line naming `stores/redis.py`. All three repeats exit 0: the thread-safety leak in spike 3.3 showed up only in repeated full runs.

- [ ] **Step 2: Real-Redis gates without Docker images**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
for mode in seed workerlost cleanup; do
  (cd core && JOB_REDIS_URL=$REDIS_URL GATE_PREFIX=nurse_gate:w6:v2 PYTHONPATH=. $PY ../docker/deploy_gate_driver.py $mode) > /tmp/v1sync-w6-gate-$mode.log 2>&1; echo "$mode exit=$?"; grep GATE_RESULT /tmp/v1sync-w6-gate-$mode.log
done
(cd core && JOB_REDIS_URL=$REDIS_URL GATE_PREFIX=nurse_gate:w6reserve:v2 GATE_PORT=18431 PYTHONPATH=. $PY ../docker/reserve_gate_probe.py) > /tmp/v1sync-w6-reserve.log 2>&1; echo "reserve exit=$?"; grep GATE_RESULT /tmp/v1sync-w6-reserve.log
```
Expected: every mode `exit=0` with `GATE_RESULT:OK…`. The reserve probe prints `GATE_RESULT:OK:7-diagnostics-then-reserved-slot`. Read each script's argument handling first. The spike ran exactly these commands (spike section 6).

- [ ] **Step 3: Docker gates**

```bash
cd "$(cat /tmp/v1sync-w6-root)"
APP_VERSION=v0.0.0-w6 make verify-deploy > /tmp/v1sync-w6-verify-deploy.log 2>&1; echo "verify-deploy exit=$?"
APP_VERSION=v0.0.0-w6 make verify-stream > /tmp/v1sync-w6-verify-stream.log 2>&1; echo "verify-stream exit=$?"
```
Expected: both `exit=0`. `verify-deploy` covers the Redis outage 503 and the `SIGKILL` `worker_lost` gate on the built image. `verify-stream` now counts keys under `nurse_scheduling:jobs:v2*`. If Docker cannot build here, record both as blocked in Task 6. Do not skip them silently.

- [ ] **Step 4: Web unit tests and the `r6g` re-check**

```bash
cd "$(cat /tmp/v1sync-w6-root)" && . /tmp/v1sync-w6-lib.sh
(cd web && pnpm install --frozen-lockfile && pnpm typecheck && PYTHON=$PY pnpm test) > /tmp/v1sync-w6-web.log 2>&1; echo "web exit=$?"
if [ -f core/tests/real/solver_capabilities.py ]; then
  (cd core && PYTHONPATH=. $PY -m pytest -q tests/test_real_solver_capabilities.py) > /tmp/v1sync-w6-r6g.log 2>&1; echo "r6g test exit=$?"
  (cd core && PYTHONPATH=. $PY tests/real/solver_capabilities.py --solver ortools/cp-sat) > /tmp/v1sync-w6-r6g-probe.log 2>&1; echo "r6g probe exit=$?"
else echo "r6g not merged: re-check after both merge"; fi
```
Expected: `web exit=0`. W6 changes no web file. The BFF checks `workers.online` as a non-negative integer, and the registry count is one. If `r6g` is merged, both `r6g` lines exit 0 and all four probe rounds say PASS.

### Task 6: Docs, beads, hand-off

**Files:**
- Modify: `docs/T19-upstream-backend-source-manifest.md` ("Upstream tracking table" section), `docker/README.md` (the key prefix sentence near line 113 and the lease-fence paragraph near lines 150-160)

- [ ] **Step 1: Record W6 in the T19 manifest**

Append after the W2 paragraph and bullet list:
```markdown
W6 replaces the T19 fence with the genie worker lease registry. It adds 2 `verbatim` rows
(`server/usage_metrics.py`, import only, telemetry off under X6, and
`tests/test_optimize_job_backends.py`) and 7 `patched` rows, each with one
`W6-<file>.patch`: `job_store.py`, `jobs/models.py`, `jobs/controller.py`,
`jobs/worker.py`, `stores/memory.py`, `stores/redis.py` and `tests/test_serve.py`. Patch
IDs: P6 event replay snapshot, P8 basis and INCONCLUSIVE fields with explicit store
serialization, P9 purpose queues on `WATCH`/`MULTI` with no Lua (the ordinary queue keeps
the genie key), and P10 the worker shutdown write gate. P12 is gone: the W2 `config.py`
and `app.py` patches no longer carry it. `stores/queue_script.py` is deleted. The Redis
key namespace is `nurse_scheduling:jobs:v2` (X13), and in-flight v1 jobs are dropped at
cutover.

Accepted semantic change: the lease fence checks expiry against the worker's clock
before commit, so a worker write can land between lease expiry and the `worker_lost`
commit (pinned by `test_w6_accepted_gap_late_write_before_worker_lost_lands`). The
worker runs in the API process, so clock skew is zero. Review this again if the worker
moves to another process or host.

Deleted v2 assertions (Lua-only mechanics): the 2 lines of
`test_every_state_machine_key_shares_one_hash_tag`, and the `claim_expires_at` and
`worker_id` equality lines in `test_server_worker_loss.py`. The memory variant of 5
residue tests skips, because the genie memory store derives its queues from the records.
Genie tests whose behaviour v2 changes on purpose are listed, with reasons, in
`core/tests/conftest.py` `UPSTREAM_DEVIATIONS`.
```
In `docker/README.md`: the prefix sentence becomes `JOB_REDIS_KEY_PREFIX=nurse_scheduling:jobs:v2`. The lease paragraph now describes the genie registry. The worker heartbeat is always on. The lease token and the revision fence each job. Maintenance commits `worker_lost` after the lease expires. Add the accepted late-write gap above. Add the cutover note: "Deploy W6 in a quiet window. Old `nurse_scheduling:jobs:v1:*` keys are ignored. To delete them, run `redis-cli --scan --pattern 'nurse_scheduling:jobs:v1:*' | xargs -r redis-cli del`."

```bash
cd "$(cat /tmp/v1sync-w6-root)"
git add docs docker/README.md && git commit -m "docs(t19): record W6 lease registry rows, patch IDs, accepted gap and cutover (v1 sync W6)"
```

- [ ] **Step 2: Beads and memory**

```bash
cd "$(cat /tmp/v1sync-w6-root)"
bd update nursing-sheduler-l3m --notes "W6 landed (branch feat/v1-sync-w6): new result fields go into jobs/models.py and the explicit serialize/deserialize in stores/redis.py as a P8 hunk of W6-server-stores-redis.patch. Un-defer after merge."
bd update nursing-sheduler-qq0.27.5 --notes "W6 landed: server suites are final (genie test_serve.py restored). Un-defer after merge."
bd update nursing-sheduler-r6g --notes "W6 re-check: <paste Task 5 Step 4 result, or 'pending: r6g not merged'>."
bd remember "v1sync-w6-handoff: W6 done on feat/v1-sync-w6. W5 must: (1) give queue_state.py, event_cursor.py, conftest.py and the v2 test_server_* suites v2-only rows; usage_report.py and test_usage_metrics.py excluded (X6); (2) teach check_upstream_sync.py the v2-only/excluded classes; (3) carry UPSTREAM_DEVIATIONS (conftest.py) and the 4 deleted assertions into the origin table; (4) list P9 purpose queues and P6 cursors as upstream candidates; (5) the W2 hand-off memory is resolved."
```
After merge into `develop`, and once the `bd` tracking bead's acceptance lines are checked, un-defer `l3m` and `qq0.27.5` with `bd update <id> --status open`.

- [ ] **Step 3: Report**

Report the branch, the commit list, the Task 5 results and the `check_upstream_sync` line. Name any blocked Docker gate. Propose `git push -u origin feat/v1-sync-w6`, then a PR into `develop`, deployed in a quiet window (X13). Do not push or merge until the user approves. Close the W6 tracking bead only after merge.

---

## After W6: W4 and W5

**W4 (v1 AI study)** needs nothing from W6 and can start now. It produces one report in `docs/research/` with no code. The report compares genie `core/nurse_scheduling/ai/` with the v2 assistant. Read genie with `git -C /home/kenan/work/nurse-scheduling show 1bf4b85:…`. The topics are anonymization, attachment inspection, prompt and schema references, conversation flow and the 109 cases in `core/tests/ai_eval/cases/`. Each useful idea becomes a bead or a `web/evals/` case, within the `docs/ai-assistant.md` rules. No bead exists yet. At the start of W4, create one.

**W5 (manifest and sync recipe)** needs W6 merged, because it is the first point where every `core/` file has its final origin. W5 needs:
1. `check_upstream_sync.py` to accept the classes `v2-only` and `excluded`. Today it reports any other class as a problem.
2. One row for every file in `core/`, tests included. Examples: the W6 `v2-only` rows `queue_state.py`, `event_cursor.py`, `tests/conftest.py`, `tests/server_support.py` and the `test_server_*` suites. The `excluded` rows `usage_report.py`, `tests/test_usage_metrics.py`, `ai/`, `ai_serve.py`, `frontend_validation.py`, `sentry.py` and `suspicion.py`. The files already identical to genie that no wave recorded: `server/__init__.py`, `api/__init__.py`, `api/sse.py`, `runtime_identity.py`, `stores/__init__.py` and `jobs/__init__.py`.
3. `core/AGENTS.md` from genie with a short v2 section.
4. The recipe. Diff the old genie pin against the new genie head for `core/`. Act on each changed file by class: copy `verbatim`, copy and re-apply for `patched`, skip `excluded`. Check `UPSTREAM_DEVIATIONS` for renamed genie tests. Then run `check_upstream_sync.py`.
5. The upstream candidates: per-date overrides, `skillMix`, INCONCLUSIVE, opaque cursors (P6) and purpose queues (P9). If upstream takes P9, `W6-server-stores-redis.patch` shrinks the most.

## Unresolved questions

1. Restore genie `test_serve.py` (patched) and `test_optimize_job_backends.py` (verbatim) **and** keep the rewritten v2 T19 suites? The spec says rewrite the v2 suites. `12-test-gap.md` says restore genie and delete the v2 suites. **Default: both.** The genie files make the next sync mechanical, and the v2 suites hold the T09, replay and worker-loss assertions genie lacks.
2. Skip the 9 deviating genie tests from `conftest.py` (`UPSTREAM_DEVIATIONS`) instead of editing them in `test_serve.py`? **Default: yes.** It keeps the test patch to 3 hunk groups, and a stale entry fails loudly.
3. The ordinary queue keeps the genie key `<prefix>:queue` (the spike used `queue:ordinary`)? **Default: yes.** One genie test runs unchanged, and the patch is smaller.
4. `USAGE_METRICS_ENABLED`: rely on the default `false` plus tests and docs, or add a v2 patch in `app.py` that always passes `usage_metrics_key_prefix=None`? **Default: no patch.** Nothing leaves the host without the unvendored `usage_report.py`, and such a patch is a permanent deviation.
5. Stale `:v1` keys at cutover: leave them with an optional operator command in `docker/README.md`, or delete them in code? **Default: the operator command.** X13 says no migration code.
6. Merge order with `r6g` (`chore/r6g-solver-probe-verbatim`, done, not merged)? **Default: merge `r6g` first.** W6 then re-checks it in Task 5. The manifest row counts in this plan give both numbers.

## Assumptions

- W0, W1 and W2 are merged into `develop`. Checked here: the manifest has 68 rows and 11 patch files. The W6 files differ from the spike base `970c956` only by the W2 shims (`get_activity`, `auth_credential_id`, `is_ready`, `solver_supports_finish_now`).
- The spike commit `220d7a6` stays reachable in this repo. If it is gone, rebuild each file from genie plus the hunks described in `09-spike-w6.md`. That is slower, and this plan does not script it.
- The probe numbers hold on the `develop` the executor starts from: 1,613 passed, 252 passed and 9 skipped for the genie files, and clean 3-way merges for all 11 files. Task 3 Step 2 and Task 4 Step 3 check them again.
- No deployment sets `JOB_CLAIM_LEASE_SECONDS`, `JOB_WORKER_LEASE_SECONDS` or `USAGE_METRICS_ENABLED`. A search of `docker/` and `scripts/` found none.
- Docker is available for Redis and for `verify-deploy` and `verify-stream`. If it is not, those gates are reported as blocked.
- `web/` needs no change. The BFF drops `workers` from the browser response. W2 Task 9 already owns the wording for the genie failure texts (`cancelled`, `worker_lost`).
