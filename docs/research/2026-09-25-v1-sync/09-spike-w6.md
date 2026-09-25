# Spike W6: genie worker lease registry with the T09 queue rebuilt on it

Date: 2026-09-25. Branch `kenan-xin/spike-w6-lease`, from `develop` at `970c956`. Last commit `220d7a6`. Throwaway evidence, not code to keep.

## 1. Summary

- The spike proves that the T09 purpose queues and the reserved ordinary slot can run on the genie `WATCH`/`MULTI` store with no Lua. The same code path runs on memory, fakeredis and real Redis.
- Spike `stores/redis.py` is 1,238 lines. Genie has 921, so the diff is +347/-30. Develop has 2,064 lines for the same job (`redis.py` 1,623 plus `queue_script.py` 441), so the spike is 40% smaller.
- All seven T19 suites pass after the rewrite: 273 pass and 5 skip, against 271 on develop. Only 4 assertion lines are deleted: 2 in the hash-tag test and 2 on T19-only claim fields. The memory variant of 5 residue tests skips.
- The real-Redis SIGKILL gate passes: the killed job ends `worker_lost`, and a replacement process claims the next job. The delayed-commit probes pass with the new expected result.
- A new probe proves the accepted semantic change on all 3 backends: a late write with no maintenance pass in between lands.
- The full core suite with real Redis passes: 1,099 passed, 5 skipped, 4 runs out of 4 after one test-helper fix. Develop gives 1,070 passed.
- The spec W6 section needs 12 edits (section 4). The largest gap is a missing worker patch. I name it P10, a shutdown write gate, and 5 v2 lifecycle assertions need it.
- W6 has 3 hidden dependencies on W1 and W2 (section 3.2). The spike bridges them with about 70 lines of shims.
- Effort estimate for the real W6: M.

## 2. Measurements

| Claim from the spec | What I did | Result | Verdict |
| --- | --- | --- | --- |
| T09 purpose queues and the reserved slot can be rebuilt on genie `WATCH`/`MULTI` without Lua (P9). | Patched genie `stores/redis.py` and `stores/memory.py`. Deleted `stores/queue_script.py`. | `test_server_priority_queue.py`: 78 pass, 5 skip, 0 fail on 3 backends. The reserve gate probe passes over HTTP on real Redis: `GATE_RESULT:OK:7-diagnostics-then-reserved-slot`. | confirmed |
| "The size after P9 is not yet measured." | Measured the patched files. | See table 2.1. Spike `redis.py` 1,238 lines. W6 files without `usage_metrics.py`: 3,474 lines, against 4,388 on develop. | measured |
| P6 `prepare_event_replay` as a `WATCH`/`MULTI`/`EXEC` snapshot in both stores. | Copied the v2 method into the genie stores. | `test_server_replay.py` 50/50, including the flaky-pipeline `WatchError` retry. Redis +72 lines, memory +36 lines. | confirmed |
| P8 basis and INCONCLUSIVE fields with explicit serialize and deserialize code. | Added fields to `jobs/models.py` and field-by-field code to `stores/redis.py`. | About +56 lines in `redis.py`, +33 in `models.py`. Basis admission and INCONCLUSIVE suites pass. | confirmed |
| P7 roster hooks: runner and controller lines, "if W2 did not already place them outside these files". | Searched the W6 files for roster code. | The roster hooks live only in `jobs/runner.py`. P7 needs 0 lines in the W6 files. `test_roster_routes.py` passes. | confirmed, no-op |
| "The W6 files differ from genie only by the lines of P6 to P9." | Ran the v2 lifecycle suite against unpatched genie `worker.py`. | 5 tests fail: `test_worker_shutdown_discards_buffered_event`, `..._buffered_result`, `..._suppresses_abort_cleanup_failure`, `test_stop_blocks_until_admitted_completion_persists`, `..._event_persists`. They need a worker patch, P10 (+34/-15 lines). | wrong |
| "Create, claim, update and queue repair each `WATCH` the pending set and both purpose queues." | Implemented the smallest correct watch set per operation. | Create and repair watch pending plus both queues. Claim watches both queues and the worker keys. Update watches both queues only when a job leaves QUEUED. Pending is not needed for claim or update. | partly |
| "One reserved ordinary slot on the genie claim path." | Read the v2 rule in `queue_state.admission_decision`. | The reserve is an admission rule in `create`. The claim path applies ordinary-first order. | partly (wording) |
| Real-Redis SIGKILL gate: a replacement worker recovers, and the killed job ends `worker_lost`. | Rewrote `test_server_worker_loss_multiprocess.py`. The replacement process now also claims a second job under its own lease. | Passes 12 of 12 solo runs, and 4 of 4 full runs after the fix in section 3.3. `docker/deploy_gate_driver.py workerlost` prints `GATE_RESULT:OK`. | confirmed |
| Delayed-commit probes: after maintenance commits `worker_lost`, a stale write changes nothing. | Rewrote the delayed-save probe (5 operations x 3 backends). Rewrote the fakeredis commit-window test as a real race: maintenance commits inside the worker's WATCH-to-EXEC window (5 operations x fakeredis and real Redis). | 25 items pass. In the race test, EXEC aborts, and the retry sees a terminal job and writes nothing. | confirmed |
| Accepted semantic change: a worker write can land between lease expiry and the `worker_lost` commit. | Added `test_w6_accepted_gap_late_write_before_worker_lost_lands`. | Passes on memory, fakeredis and real Redis: the late `complete_job` lands as COMPLETED. | confirmed |
| The genie production path is the same code that the fakeredis tests run. | Removed the v2 `client=` and `test_lease_commit_boundary` store arguments. fakeredis now enters through a patched `redis.Redis.from_url`, as the genie tests do. | No fakeredis branch remains in `stores/redis.py`. | confirmed |
| Port the genie lease tests. | Extracted 17 lease tests from genie `test_serve.py` and `test_optimize_job_backends.py` into `tests/test_server_genie_lease.py`. | 27 items pass on 3 backends. 8 `StoreLimits(max_pending=1)` sites needed `ordinary_reserved_slots=0`. | confirmed |
| Rename to `worker_lease_seconds` (`JOB_WORKER_LEASE_SECONDS`, updated in `docker/` environment files). | Renamed in `config.py` and `app.py`. Searched every Docker file. | No Docker or script file sets `JOB_CLAIM_LEASE_SECONDS`. There is nothing to update. | wrong (no-op) |
| Bump the key prefix to `nurse_scheduling:jobs:v2` and `QUEUE_STATE_MACHINE_VERSION` (X13). | Bumped `config.py`, `docker/compose.yml` and `queue_state.py`. | 2 version-pin assertions rewritten from `v1` to `v2`. | confirmed |
| `/info` `workers.online` switches to the registry count. | Checked develop `/info`. | Develop `/info` has no `workers` key yet. W2 step 8 adds it. `JobController.get_activity()` is ready. | not measured |
| Full core suite. | Ran the whole suite with Python 3.12 and real Redis 8. | Spike: 1,099 passed, 5 skipped, 4 runs. Without real Redis: 1,019 passed, 85 skipped. Develop: 1,070 passed. | confirmed |

### 2.1 File size and diff against genie `1bf4b85`

| File | Genie | Spike | Diff vs genie (+/-) | Develop | Patches |
| --- | --- | --- | --- | --- | --- |
| `stores/redis.py` | 921 | 1,238 | +347 / -30 | 1,623 | P6 about 76, P8 about 56, P9 about 215 |
| `stores/queue_script.py` | none | deleted | none | 441 | Lua, gone |
| `stores/memory.py` | 498 | 610 | +117 / -5 | 681 | P6 36, P9 about 81 |
| `jobs/controller.py` | 681 | 703 | +22 / -0 | 767 | P6 4, P8 8, P9 7 |
| `jobs/worker.py` | 489 | 508 | +34 / -15 | 399 | P10 only |
| `jobs/models.py` | 180 | 213 | +33 / -0 | 271 | P6, P8, P9 |
| `job_store.py` | 183 | 202 | +20 / -1 | 206 | P6, P9 |
| `usage_metrics.py` | 576 | 576 | 0 | none | verbatim (X6) |
| Total, W6 files | 3,528 | 4,050 | +573 / -51 | 4,388 | |

The per-patch split in `redis.py` comes from counting added lines by enclosing function. Genie files pass the v2 Ruff pin `0.15.22` with 0 format changes and 0 lint errors, so the diff holds no style noise.

Files outside the W6 list that changed: `queue_state.py` +23 (version bump and 2 shared rules, `queue_sort_key` and `validate_transition`), `retry.py` +52 (genie verbatim), `solver_capabilities.py` 11 (new shim), `config.py` 11, `app.py` 3, `api/optimize.py` 2, `api/schemas.py` 2.

### 2.2 T19 suites: assertions kept, rewritten and deleted

Assertion lines count `assert` and `pytest.raises` lines.

| Suite | Items dev to spike | Assertion lines dev to spike | Kept | Rewritten | Deleted, with reason |
| --- | --- | --- | --- | --- | --- |
| `test_server_store_contract.py` | 42 to 42 | 29 to 29 | 27 | 2: FIFO claim uses 3 workers, because one lease owns one active job. `find_claimed_before` becomes `find_jobs_without_live_workers`. | 0 |
| `test_server_replay.py` | 50 to 50 | 27 to 27 | 27 | 0 (one `save` call renamed to `update_job`) | 0 |
| `test_server_worker_loss_multiprocess.py` | 1 to 1 | 6 to 8 | 6 | 0. Added 2: the replacement worker claims the next job. | 0 |
| `test_server_worker_loss.py` | 31 to 39 | 61 to 51 | 33 in the 8 plain tests | Delayed-commit probe: new expected result. Commit-window test: now a WATCH race on fakeredis and real Redis. Renewal-outage test: now uses the genie heartbeat. The two probes share one assertion helper, which explains most of the drop. | 2: `claim_expires_at` equality (a T19-only field that genie does not have) and `worker_id` equality (the revision check covers it). |
| `test_server_backend_parity.py` | 50 to 50 | 49 to 49 | 43 | 6: two failure texts now use the genie US spelling ("Optimization cancelled."). `renew_claim` becomes `renew_worker`. `is_stop_requested` takes the lease. The `WatchError` injector now fires only on watching pipelines. | 0 |
| `test_server_lifecycle_gates.py` | 13 to 13 | 57 to 57 | 56 | 1: renewal asserts the worker lease expiry, not a job claim expiry. | 0. 5 tests need P10. |
| `test_server_priority_queue.py` | 84 to 83 (78 pass, 5 skip) | 134 to 132 | 127 | 5: two `pytest.raises(StoreWriteConflictError)` become "returns the unchanged job" (genie contract). Two version pins `v1` to `v2`. One `find_claimed_before` call. | 2: `test_every_state_machine_key_shares_one_hash_tag`. The Lua script needed every key in one cluster slot. Genie keys have no hash tag. |
| Total | 271 to 278 | 363 to 353 | | | 4 assertion lines deleted, plus 5 memory variants skipped |

The memory variant of these 5 tests skips: orphan repair, stale-member repair, explicit repair pass, residue capacity, bounded repair records. Genie memory derives its queues and pending set from the job records, so residue cannot exist there. The fakeredis and real-Redis variants run.

Other suites that also called the T19 API: `test_roster_routes.py` (`claim_next_job("worker")`, 2 lines), `test_server_identity.py` and `server_support.py` (the `client=` store argument), and `docker/deploy_gate_driver.py` (4 call sites). All of them pass after the rewrite. The gate driver prints `GATE_RESULT:OK` for `seed`, `check`, `replay`, `workerlost` and `cleanup` on real Redis.

## 3. Surprises and blockers

### 3.1 Missing patch P10: the v2 worker shutdown write gate

The v2 worker holds `_shutdown_lock` across each shutdown check and its controller write. So no buffered event, result or failure lands after `stop()`, and `stop()` waits for a write that already passed the gate. The genie worker has no such gate. Genie `stop()` unregisters the lease only after it joins the threads, so a buffered write before that point still lands. Evidence: with genie `worker.py` verbatim, the 5 lifecycle tests in table 2 fail with, for example, `assert <JobState.FAILED: 'failed'> == <JobState.RUNNING: 'running'>`. With P10 (+34/-15 lines) all 13 lifecycle tests and all 27 genie lease tests pass. P10 also keeps the v2 branch that settles an observed cancellation through `complete_cancellation` when cleanup raises.

### 3.2 Hidden dependencies on W1 and W2

| Needed by | Dependency | Owner | Spike bridge |
| --- | --- | --- | --- |
| `jobs/worker.py` | `retry.RepeatedFailure`, `DEFAULT_OUTAGE_MAX_DELAY_SECONDS` | W2 step 1 | Genie `retry.py` verbatim (+52). `retry_with_backoff` is identical. |
| `jobs/worker.py`, `jobs/controller.py` | `solver_capabilities.solver_supports_finish_now` | W2 step 5, and the genie file imports `scheduler.CANONICAL_SOLVER_CHOICES`, which only W1 adds | 11-line shim. `api/optimize.py` and `api/schemas.py` import from it. |
| `usage_metrics.py` | `config.MIN_USAGE_METRICS_RETENTION_DAYS` | W2 step 6 (genie `config.py`) | One constant in v2 `config.py`. |
| `usage_metrics.py` | `loader._load_yaml` | W1 (genie signature adds `reject_aliases`) | None needed. The v2 function accepts the call. |
| `jobs/controller.py` | `auth_credential_id` argument | W2 step 5 (auth) | None needed. The argument is optional and unused. |
| `jobs/controller.py` | failure text "Optimization cancelled." and "The optimization worker stopped..." | W2 step 11 (web owns UK spelling) | None. `run-view` shows `error.message`, so W6 changes visible text until W2 step 11 lands. |
| `/info` | `workers.online` from the registry | W2 step 8 | Not done. |

W6 can land on develop before W2 with these bridges. The order in X3 (W6 after W2) removes the bridges.

### 3.3 fakeredis construction leaked a global patch across threads

The SIGKILL gate first failed in 8 of 10 full runs and 0 of 12 solo runs. On develop it passed 10 of 10 solo runs. The child process saw empty queues in real Redis, while the parent saw the job queued. The parent store was a `fakeredis._connection.FakeRedis`, because `redis.Redis.from_url` was still patched. An autouse probe named the source: `test_redis_store_identity_is_shared_by_one_namespace` builds 8 stores in a thread pool, and `mock.patch.object` is not thread-safe. Two threads restored each other's patch. A lock in the test helper fixed it: 4 of 4 full runs pass afterwards. This cost follows directly from the genie store, which takes no injected client. The real W6 needs this lock, or one test-level `monkeypatch` per test, as genie does.

### 3.4 The reserve default breaks ported genie tests

v2 `StoreLimits.ordinary_reserved_slots` defaults to 1 and requires `reserve < max_pending`. Genie tests build `StoreLimits(max_pending=1, ...)`, so 11 of 27 genie items failed with `ValueError: ordinary_reserved_slots must satisfy 0 <= reserve < max_pending`. The port needed 8 edits. The same edit recurs at every sync that brings new genie tests.

### 3.5 Genie refuses a fenced write by returning the job, not by raising

v2 raised `StoreWriteConflictError` for a lost claim. Genie `update_job` returns the unchanged job. Two priority-queue assertions changed shape for this reason. The controller behavior is the same: the write changes nothing.

### 3.6 One bug found in the spike code

My first `describe_queue_state` sent `WATCH` with no keys when the store held no job. Real Redis and fakeredis both answered `wrong number of arguments for 'watch' command`. The bounded-records test caught it. The fix is a guard of 1 line.

### 3.7 Small notes

- The spike `describe_queue_state` ends with `MULTI`/`EXEC`, so the snapshot is validated. The develop fakeredis mirror only called `unwatch()`, so its snapshot was not atomic.
- The spike `create` repairs residue inside the same transaction as admission. The develop fakeredis mirror used a separate transaction.
- Genie `cancel_job` does not refuse a running job whose solver cannot stop. The server allows only CP-SAT, and `api/optimize.py` still checks, so no test changed.
- `docker/verify-stream.sh` uses `nurse_scheduling:jobs:v0*` and `docker/README.md` says `v0`, while develop uses `v1`. This drift predates W6.
- `maintenance.py`, `diagnostic.py`, `jobs/runner.py` and all of `web/` needed no change.

## 4. Recommended spec edits

All edits are in `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md`, section 3, W6, unless the edit names another place.

1. "Why v1 wins", replace "The size after P9 is not yet measured." with: "After P6 to P10, `stores/redis.py` has 1,238 lines (+347/-30 against genie), and the W6 files have 4,050 lines against 4,388 on develop (spike W6, `09-spike-w6.md`)."
2. Patch table, add a row: "P10 shutdown write gate | Keep the v2 `_shutdown_lock` in `jobs/worker.py`: no worker event, result or failure lands after `stop()`, and a cancellation observed under a live lease still settles."
3. Patch table, P7 row: "No lines in the W6 files. The roster hooks live in `jobs/runner.py`."
4. Patch table, P9 row: "Two purpose queues (ordinary and assistant diagnostic). Admission enforces the reserved ordinary slot. Claim takes the ordinary FIFO head first. Create and queue repair `WATCH` the pending set and both purpose queues. Claim `WATCH`es both queues and the worker keys. Update `WATCH`es both queues when a job leaves QUEUED. Repair runs inside the create transaction. No Lua."
5. After "Take verbatim from genie", add: "W6 also needs genie `retry.py` (W2 step 1), `solver_supports_finish_now` (W2 step 5, which needs W1 `scheduler.CANONICAL_SOLVER_CHOICES`) and `MIN_USAGE_METRICS_RETENTION_DAYS` (W2 step 6). If W6 lands first, bridge them with a shim and record it in the manifest."
6. Replace "(`JOB_WORKER_LEASE_SECONDS`, updated in `docker/` environment files)" with "(`JOB_WORKER_LEASE_SECONDS`). No `docker/` file sets the old name."
7. Delete list, add: "the `RedisJobStore` `client=` and `test_lease_commit_boundary` arguments. Tests build fakeredis stores by patching `redis.Redis.from_url` under a lock, because a thread pool test constructs stores in parallel."
8. Suite list, add: "`test_roster_routes.py`, `test_server_identity.py`, `tests/server_support.py` and `docker/deploy_gate_driver.py` also call the T19 API." Add the deletions to the manifest: the hash-tag test, the `claim_expires_at` and `worker_id` equality assertions, and the memory variant of 5 residue tests.
9. Acceptance item 4, replace with: "The W6 files differ from genie only by the lines of P6 to P10."
10. Add a W2 dependency to W6: "W6 brings the genie failure text (US spelling). Land W2 step 11 first, or the run view shows the new text."
11. Consider this change to P9: "`StoreLimits.ordinary_reserved_slots` defaults to 0, and `ServerSettings` supplies 1." Then genie tests with `max_pending=1` port without edits (8 edits in the spike).
12. Section 4 risks, the row "W6 weakens the T09 queue or worker-loss recovery": add "Measured in the spike: all T09 and worker-loss assertions pass on real Redis, except 4 deleted assertion lines listed in the manifest."

## 5. Effort estimate for the real W6

M. The spike did the store, controller, worker and test work in one session, and every gate passes. The real W6 still needs these steps:

1. Split the changes into `.patch` files under `core/upstream-patches/`, with manifest rows.
2. Remove the 3 shims when W1 and W2 land.
3. Review P10 and the WATCH sets.
4. Switch `/info` to the registry count.
5. Update the docs: `docker/README.md`, the T19 manifest and the `verify-stream.sh` prefix.
6. Run `docker/verify-deploy.sh` in Docker.

## 6. Reproduction

Branch `kenan-xin/spike-w6-lease` in `/home/kenan/orca/workspaces/nursing-sheduler/spike-w6-lease`. Last commit `220d7a626e02d92a75b1a1605482801d49c6de28`. The branch has 9 commits on top of `970c956`, one per step.

```bash
git -C /home/kenan/work/nurse-scheduling archive 1bf4b85 core | tar -x -C /tmp/w6-genie
git archive 970c956 core | tar -x -C /tmp/w6-dev
docker run -d --name spike-w6-redis -p 16401:6379 redis:8-alpine
uv venv /tmp/w6-venv --python 3.12
uv pip install --python /tmp/w6-venv/bin/python -r core/requirements.txt pytest fakeredis
cd core
NURSE_TEST_REDIS_URL=redis://localhost:16401/0 PYTHONPATH=. /tmp/w6-venv/bin/python -m pytest -q -p no:cacheprovider
PYTHONPATH=. /tmp/w6-venv/bin/python -m pytest -q -p no:cacheprovider
/tmp/w6-venv/bin/ruff check . && /tmp/w6-venv/bin/ruff format --check .
JOB_REDIS_URL=redis://localhost:16401/0 GATE_PREFIX=nurse_gate:w6spike:v2 PYTHONPATH=. /tmp/w6-venv/bin/python ../docker/deploy_gate_driver.py workerlost
JOB_REDIS_URL=redis://localhost:16401/0 GATE_PREFIX=nurse_gate:w6reserve:v2 GATE_PORT=18431 PYTHONPATH=. /tmp/w6-venv/bin/python ../docker/reserve_gate_probe.py
cp /tmp/w6-genie/core/nurse_scheduling/server/jobs/worker.py nurse_scheduling/server/jobs/worker.py  # P10 proof, then git checkout the file
docker rm -f spike-w6-redis
```

The develop baseline used the same venv and Redis on `/tmp/w6-dev/core`: 1,070 passed. The per-suite develop counts in table 2.2 come from that tree.
