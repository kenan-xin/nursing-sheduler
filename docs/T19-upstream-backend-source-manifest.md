# T19 — Upstream backend source manifest and rebuild adaptations

Execution note for ticket **T19 — Upstream modular backend, Redis JobStore and
Workspace gate**. Records the source mapping, the intentional rebuild
adaptations, dependency pins, and the net-new modules so every checked-in file
either maps to the pinned upstream revision or has a documented adaptation.

- **Upstream source:** `/home/kenan/work/nurse-scheduling`
- **Pinned revision:** `0420ccdc0cb3f9aa29db85d288bd36a0d4f37046` (T19 baseline);
  refreshed to `5027e2f5fd7d16b7006ed1ab572b905fa6845ea1` for the public-diagnostics
  refresh — see [U30a refresh](#u30a--upstream-5027e2f-public-diagnostics-refresh);
  refreshed again to `d63519bdbfa6140558afee00f78a5766ad179e6d` for the supervised
  optimization-execution work — see
  [U31 refresh](#u31--upstream-5027e2fd63519b-supervised-optimization-refresh).
- **Governing plan:** rebuild-tech-plan → `upstream-redis-workspace-protocol-technical-plan`;
  the `5027e2f` refresh is governed by `upstream-public-diagnostics-refresh-2026-07-19`;
  the `d63519b` refresh is governed by the
  `d63519b-process-supervision-addendum` and ticket `U31`.
- **Sync target (2026-09-25):** v1 branch `feature/genie` at `1bf4b85`. The old pin
  `d63519b` is a genie commit, not a `dev` commit; its merge base with v1 `dev` is
  `89190ab`. Genie contains all of `dev` through merge `1b6f7e5`. The upstream delta
  for v2 is `d63519b..feature/genie`. Governing design:
  `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md`.
- **Requirements split (W0):** runtime `core/requirements.txt`, optional
  `core/requirements-optional.txt`. v2 differences from genie: `ruamel.yaml` and
  `pydantic` pinned; `pulp` in the optional file; the `ai/`-only packages omitted.

## Upstream tracking table (from W1)

`core/upstream-patches/manifest.toml` is the source of truth for which `core/` files
track v1 `feature/genie` and how: `verbatim` (byte-identical) or `patched` (with the
named patch files in `core/upstream-patches/`). `core/scripts/check_upstream_sync.py`
checks it, and the `core` CI job runs that check through pytest. W1 patches: P0 fixture
hash re-stamp (upstream bug, report it), P2-P3 `skillMix` and per-date overrides, P4
`on_roster`. P1 `Person.temporary` was retired after W2 (bead `nursing-sheduler-pknr`).
The web no longer writes it. Located Workspace errors stay in the v2-only
`server/workspace.py` (spec X14).

W2 adds the server layer. It adds 9 `verbatim` rows: `version.py`, `retry.py`,
`process_tree.py`, `process_executor.py`, `request_limits.py`, `auth.py`,
`solver_capabilities.py`, `solver_options.py` and `tests/test_retry.py`. It also adds 8
`patched` rows. Each has one `W2-<file>.patch`. The patch header maps every hunk to a
patch ID:

- P5: Workspace boundary.
- P6: event cursors.
- P7: roster container.
- P8: basis and INCONCLUSIVE.
- P9: purpose queues.
- P11: maintenance liveness.
- P12: T19 fence bridge. W6 deletes it.
- P13: `default_prettify=False`.
- P14: diagnostic path mode and cleanup.

`JOB_MAX_PENDING=8` and the diagnostic concurrency of 1 now live in `docker/compose.yml`
and `scripts/dev.sh`. The web owns user-facing failure wording (`web/lib/bff/errors.ts`).

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

## W5: origin of every core file and the sync recipe

W5 gives every file in `core/`, tests included, one row in
`core/upstream-patches/manifest.toml`. The manifest is the one source of truth. The
table below is generated from it, and the check fails if the two differ. There are
four classes:

- `verbatim`: the same bytes as the genie file. The row records the genie blob SHA.
- `patched`: the genie file plus one v2 patch file in `core/upstream-patches/`. The row
  records the genie blob SHA, and the table shows the patch IDs from the patch header.
- `v2-only`: genie has no such file. The row says why v2 has it.
- `excluded`: a genie path (a glob) that v2 does not vendor. The row says why. No file
  in `core/` may match it.

`python -m scripts.check_upstream_sync` (run from `core/`, also run by the core suite)
checks that every file in `core/` has exactly one row, that no row names a missing
file, that each `verbatim` and `patched` file equals its genie blob once the patches are
reversed, and that the table below is current. `--write-table` rewrites the table.

W5 added 6 patch files, so that files which differed from genie with no row now
have one: `W0-pyproject.patch`, `W0-requirements.patch` (both requirements files),
`W2-tests-test_process_executor.patch`, `W2-tests-test_public_diagnostic.patch`,
`W5-tests-real-README.patch` and `W5-AGENTS.patch`. `core/AGENTS.md` is the genie file
with one v2 section added at the end (lane 07 D17, lane 05 L5-30). W5 also restored one
genie `# noqa: BLE001` comment in `tests/test_process_executor.py`, to keep that patch
small. It rebuilt `P2-P3-skillmix-overrides.patch`: the hunk line numbers were stale
after P1 was retired, and the content is unchanged.

Upstream at the time of W5 (2026-09-27): v1 `feature/genie` is still at `1bf4b85`, so
v1 has not moved past the pin.

### Sync recipe

Run from `core/`, with the v1 clone at `~/work/nurse-scheduling`, on a new branch from
`develop`:

```sh
git -C ~/work/nurse-scheduling fetch origin
python -m scripts.sync_upstream --repo ~/work/nurse-scheduling --to origin/feature/genie
python -m scripts.sync_upstream --repo ~/work/nurse-scheduling --to origin/feature/genie --apply
python -m scripts.check_upstream_sync --write-table
ruff check . && ruff format --check . && pytest
```

The first `sync_upstream` call is a dry run. It diffs the pinned genie commit against
the new head for `core/` and prints one line for each changed genie file:

- `copy` for a `verbatim` file.
- `patch` for a `patched` file: copy it, then re-apply its v2 patch.
- `skip` for a file under an `excluded` row.

It also prints a `PROBLEM` line, and `--apply` refuses to run, when:

- a genie file has no row. Add a row first.
- genie adds a file that v2 owns as `v2-only`. Decide which one wins.
- genie deletes a tracked file.
- a recorded blob does not match the genie tree at the pin.

`--apply` writes the files, moves `upstream_commit` and the blob SHAs in the manifest to
the new commit, and rebuilds each patch file against the new genie blobs. The `#`
header lines of each patch stay. If a patch does not apply, it leaves `*.rej` files. Fix
the file by hand, delete the `*.rej` files, run `python -m scripts.sync_upstream --repo
~/work/nurse-scheduling --refresh-patches`, and update the patch header if the hunks
changed. Then run the
check and the suite. Also read the genie commit log for the range. A change in an
`excluded` file, or in a v2-only area, can still matter (for example a new `/info` key).

Dry run on the current pins (`1bf4b85` to `origin/feature/genie`, which is `1bf4b85`):
0 changed files and 0 problems. Every genie file at `1bf4b85` has a row or matches an
`excluded` glob, and every recorded blob matches the genie tree. `--refresh-patches` on
the current pins rebuilt every patch file byte for byte, except the stale P2-P3 line
numbers noted above.

`--apply` was also tried in a scratch worktree against a made-up genie commit on top of
`1bf4b85`. The commit changed `cli.py` (verbatim), `server/config.py` (patched) and
added a file under `ai/` (excluded). The script copied `cli.py`, copied `config.py` and
re-applied its patch, skipped the `ai/` file, and the check then passed with 0 problems.
A second made-up commit changed a line inside the `config.py` patch context. The script
then stopped with a `.rej` file, as described above.

### Upstream candidates

Each change that upstream accepts moves its files from `patched` or `v2-only` to
`verbatim`, and its patch hunks go away.

| Candidate | v2 files today | Notes |
| --- | --- | --- |
| Per-date overrides (P3) | `models.py`, `preference_types.py` (P2-P3 patch) | `required_by_date`. A date outside the requirement fails at load time. |
| `skillMix` (P2) | `models.py`, `preference_types.py` (P2-P3 patch) | Resolved floors in `CompiledShiftTypeRequirements`. |
| `on_roster` callback (P4) | `scheduler.py` | Keyword-only day-state callback. |
| INCONCLUSIVE outcome (P8) | `jobs/models.py`, `jobs/runner.py`, both stores, `api/schemas.py` | A timeout with no incumbent is not a failure. |
| Opaque event cursors and replay snapshot (P6) | `event_cursor.py` (v2-only), `job_store.py`, `jobs/controller.py`, both stores, `api/optimize.py` | Job-bound cursors and a `WATCH`/`MULTI`/`EXEC` replay snapshot. |
| Purpose queues (P9) | `queue_state.py` (v2-only), `job_store.py`, `jobs/*`, both stores, `config.py`, `errors.py`, `maintenance.py`, `app.py` | Offer only if v1 wants assistant probes on the job server. |
| Worker shutdown write gate (P10) | `jobs/worker.py` | No worker write lands after `stop()`. |
| Diagnostic path mode and idempotent cleanup (P14) | `diagnostic.py`, `tests/test_public_diagnostic.py` | Lets the diagnostic run through a BFF prefix. |
| Fixture hash re-stamp (P0) | `tests/testcases/real/large-ward-with-87-people-2025-11.assignment-01.json` | Upstream bug: the `scenarioSha256` is stale. Report it. |
| Solver process residue audit (r6g) | `tests/real/solver_capabilities_residue.py` (v2-only) | Linux `/proc` check that no solver child outlives a cancelled job. |
| `httpx2` for the Starlette test client (bead `qq0.27.5`) | `requirements-optional.txt` | Merged into `develop` (PR #110). `W0-requirements.patch` carries it. Starlette prefers `httpx2`, and genie would see the same warning. |
| SG 28-day compliance case | `tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml`, `tests/test_sg_compliance_roster.py` | Real ward case (lane 07 D19). |

### Origin table

<!-- origin-table:start (generated by core/scripts/check_upstream_sync.py --write-table) -->
Upstream: j3soon/nurse-scheduling feature/genie at `1bf4b85`.

| File (under `core/`) | Class | Genie blob | Patches or reason |
| --- | --- | --- | --- |
| `AGENTS.md` | patched | `1a5ca4f2565f` | `W5-AGENTS.patch` |
| `nurse_scheduling/__init__.py` | verbatim | `f95dc39cacc6` |  |
| `nurse_scheduling/ai/*` | excluded |  | X5: v1 Python AI package. v2 has its own web assistant |
| `nurse_scheduling/ai_serve.py` | excluded |  | X5: AI service entry |
| `nurse_scheduling/cli.py` | verbatim | `8a204b863f7e` |  |
| `nurse_scheduling/constants.py` | verbatim | `9fdcc4a54b1c` |  |
| `nurse_scheduling/context.py` | patched | `0242cfd9a79b` | `a5pb-ledger.patch` |
| `nurse_scheduling/explain.py` | v2-only |  | a5pb run explanations: penalty ledger, infeasibility core, smallest fix |
| `nurse_scheduling/exporter.py` | patched | `1b1eb7f5192a` | `99db-D03-xlsx-text-cells.patch` |
| `nurse_scheduling/frontend_validation.py` | excluded |  | X5: used only by the v1 AI package |
| `nurse_scheduling/group_map.py` | verbatim | `c619776c6420` |  |
| `nurse_scheduling/loader.py` | verbatim | `308e2076a579` |  |
| `nurse_scheduling/model_build_stats.py` | verbatim | `77640eb47261` |  |
| `nurse_scheduling/models.py` | patched | `edcdab1503ea` | `P2-P3-skillmix-overrides.patch` (P2, P3). `99db-D05-head-count-bound.patch`. `99db-C1-required-not-above-preferred.patch` |
| `nurse_scheduling/preference_types.py` | patched | `51f7cb3570bd` | `P2-P3-skillmix-overrides.patch` (P2, P3). `99db-B1-history-completed-hard-sequence.patch`. `99db-B5-leave-satisfies-hard-off.patch`. `a5pb-ledger.patch`. `a5pb-why-solve.patch` |
| `nurse_scheduling/report.py` | verbatim | `8cff02666faf` |  |
| `nurse_scheduling/scheduler.py` | patched | `7867e7d1b159` | `P4-on-roster.patch` (P4). `a5pb-ledger.patch`. `a5pb-why-solve.patch` |
| `nurse_scheduling/serve.py` | verbatim | `8a844abe3b79` |  |
| `nurse_scheduling/server/__init__.py` | verbatim | `7b3119b1236e` |  |
| `nurse_scheduling/server/api/__init__.py` | verbatim | `10c7354468e8` |  |
| `nurse_scheduling/server/api/optimize.py` | patched | `5da18e2b4951` | `W2-server-api-optimize.patch` (P5, P6, P7, P8, P9) |
| `nurse_scheduling/server/api/schemas.py` | patched | `c0ed76c4fe7f` | `W2-server-api-schemas.patch` (P8, P9). `a5pb-ledger.patch` |
| `nurse_scheduling/server/api/sse.py` | verbatim | `7b5e8dfa6fe4` |  |
| `nurse_scheduling/server/app.py` | patched | `31e62ad1cfc5` | `W2-server-app.patch` (P5, P8, P9, P11). `99db-D01-child-memory-cap.patch`. `99db-D07-per-client-queue-cap.patch` |
| `nurse_scheduling/server/auth.py` | verbatim | `f292e5c6cae4` |  |
| `nurse_scheduling/server/basis_admission.py` | v2-only |  | P8 basis admission: checks a basis claim before a job is created |
| `nurse_scheduling/server/canonical.py` | v2-only |  | P5 canonical strict YAML dumper |
| `nurse_scheduling/server/config.py` | patched | `8f517ab71b5a` | `W2-server-config.patch` (P9, P13). `99db-D01-child-memory-cap.patch`. `99db-D07-per-client-queue-cap.patch` |
| `nurse_scheduling/server/diagnostic.py` | patched | `e09e2002eead` | `W2-server-diagnostic.patch` (P14) |
| `nurse_scheduling/server/errors.py` | patched | `a1c4eb810f1a` | `W2-server-errors.patch` (P9) |
| `nurse_scheduling/server/event_cursor.py` | v2-only |  | P6 opaque job-bound event cursors |
| `nurse_scheduling/server/job_store.py` | patched | `fb656a30e27b` | `W6-server-job_store.patch` (P6, P9) |
| `nurse_scheduling/server/jobs/__init__.py` | verbatim | `ec33f2782dcb` |  |
| `nurse_scheduling/server/jobs/controller.py` | patched | `a18fb0bd1a34` | `W6-server-jobs-controller.patch` (P6, P8, P9). `a5pb-ledger.patch` |
| `nurse_scheduling/server/jobs/models.py` | patched | `1b358ba15342` | `W6-server-jobs-models.patch` (P6, P8, P9). `99db-D07-per-client-queue-cap.patch`. `a5pb-ledger.patch` |
| `nurse_scheduling/server/jobs/process_executor.py` | patched | `183712393bfc` | `99db-D01-child-memory-cap.patch` |
| `nurse_scheduling/server/jobs/process_tree.py` | verbatim | `8d5d3687550e` |  |
| `nurse_scheduling/server/jobs/runner.py` | patched | `0ebde2edb9c4` | `W2-server-jobs-runner.patch` (P7, P8). `a5pb-ledger.patch` |
| `nurse_scheduling/server/jobs/worker.py` | patched | `ff808a06deff` | `W6-server-jobs-worker.patch` (P10). `99db-D01-child-memory-cap.patch` |
| `nurse_scheduling/server/maintenance.py` | patched | `2adb7af1de57` | `W2-server-maintenance.patch` (P9, P11) |
| `nurse_scheduling/server/optimize_basis.py` | v2-only |  | P8 optimize basis: the basis fields a job records |
| `nurse_scheduling/server/queue_state.py` | v2-only |  | P9 queue snapshot for describe_queue_state() |
| `nurse_scheduling/server/request_limits.py` | verbatim | `b258b13f6e80` |  |
| `nurse_scheduling/server/retry.py` | verbatim | `89d82ba6bd2b` |  |
| `nurse_scheduling/server/roster_container.py` | v2-only |  | P7 roster container artifact |
| `nurse_scheduling/server/runtime_identity.py` | verbatim | `d4ff822cb69e` |  |
| `nurse_scheduling/server/scheduling_errors.py` | v2-only |  | P5 the 422 scheduling-content envelope |
| `nurse_scheduling/server/scheduling_input.py` | v2-only |  | P5 parse-once submit boundary, CP-SAT only (X4) |
| `nurse_scheduling/server/semantic_profile.py` | v2-only |  | P8 solver semantic profile (X12) |
| `nurse_scheduling/server/solver_capabilities.py` | verbatim | `f8c0f5f5c94d` |  |
| `nurse_scheduling/server/solver_options.py` | verbatim | `6e098779587b` |  |
| `nurse_scheduling/server/stores/__init__.py` | verbatim | `538df653cb11` |  |
| `nurse_scheduling/server/stores/memory.py` | patched | `076668c1005f` | `W6-server-stores-memory.patch` (P6, P9). `99db-D07-per-client-queue-cap.patch` |
| `nurse_scheduling/server/stores/redis.py` | patched | `a5892b308668` | `W6-server-stores-redis.patch` (P6, P8, P9). `99db-D07-per-client-queue-cap.patch`. `a5pb-ledger.patch` |
| `nurse_scheduling/server/usage_metrics.py` | verbatim | `9dcd9e84c6d3` |  |
| `nurse_scheduling/server/usage_report.py` | excluded |  | X6: no usage telemetry |
| `nurse_scheduling/server/workspace.py` | v2-only |  | P5 Workspace V1 input and located errors (X14) |
| `nurse_scheduling/solver_interface.py` | verbatim | `63db2a420257` |  |
| `nurse_scheduling/solver_ortools_cp_sat.py` | patched | `346f334d6713` | `3c91-solver-max-lp-sym.patch`. `a5pb-why-solve.patch` |
| `nurse_scheduling/solver_ortools_linear.py` | verbatim | `36c4d411e7ae` |  |
| `nurse_scheduling/solver_ortools_mathopt.py` | verbatim | `b2a2cf0db547` |  |
| `nurse_scheduling/solver_pulp.py` | verbatim | `a796fcb7e684` |  |
| `nurse_scheduling/solver_pulp_glpk.py` | verbatim | `1a489f7b6b67` |  |
| `nurse_scheduling/solver_pulp_python.py` | verbatim | `b3c028f4f84d` |  |
| `nurse_scheduling/utils.py` | patched | `28f99473b6c5` | `a5pb-ledger.patch` |
| `nurse_scheduling/version.py` | verbatim | `8a848d24ced7` |  |
| `pyproject.toml` | patched | `da988b91d33d` | `W0-pyproject.patch` |
| `requirements-optional.txt` | patched | `edfeae4e5dcd` | `W0-requirements.patch` (P5, X4, X5) |
| `requirements.txt` | patched | `8d39f8b82f67` | `W0-requirements.patch` (P5, X4, X5) |
| `scripts/__init__.py` | v2-only |  | sync tooling |
| `scripts/check_upstream_sync.py` | v2-only |  | sync tooling: checks this manifest |
| `scripts/sync_upstream.py` | v2-only |  | sync tooling: the sync recipe |
| `tests/__init__.py` | verbatim | `e69de29bb2d1` |  |
| `tests/ai_eval/*` | excluded |  | X5: v1 AI evals (studied in W4) |
| `tests/ai_test_helper.py` | excluded |  | X5: AI test helper |
| `tests/catalogue_oracle.py` | v2-only |  | CP-SAT oracle for the web conflict catalogue |
| `tests/conftest.py` | v2-only |  | v2 test setup. UPSTREAM_DEVIATIONS skips 9 genie tests in test_serve.py that v2 changes on purpose (P5, P6, P7, P8, X4), each with the v2 test that replaces it |
| `tests/export_test_helper.py` | verbatim | `78cd8e94575a` |  |
| `tests/fixtures/assistant_repair/busyNightsWithRestRule.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/busyNightsWithRestRule.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/busyNightsWithRestRule.run_one_short.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/conflictingRequirements.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/conflictingRequirements.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/onlyRnOnLeave.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/onlyRnOnLeave.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/personalCapsTooLow.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/personalCapsTooLow.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/rnMixOnLeave.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/rnMixOnLeave.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/ruleTooStrict.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/ruleTooStrict.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/shortOnLeaveDay.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/shortOnLeaveDay.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/shortOnLeaveDay.run_one_short.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/tooFewNurses.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/tooFewNurses.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/understaffedNight.after.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/assistant_repair/understaffedNight.before.yaml` | v2-only |  | assistant repair fixture |
| `tests/fixtures/temporary_cover/date_split.after.yaml` | v2-only |  | temporary cover fixture |
| `tests/fixtures/temporary_cover/date_split.before.yaml` | v2-only |  | temporary cover fixture |
| `tests/fixtures/temporary_cover/rn_cover.after.yaml` | v2-only |  | temporary cover fixture |
| `tests/fixtures/temporary_cover/rn_cover.before.yaml` | v2-only |  | temporary cover fixture |
| `tests/fixtures/temporary_cover/shift_split.after.yaml` | v2-only |  | temporary cover fixture |
| `tests/fixtures/temporary_cover/shift_split.before.yaml` | v2-only |  | temporary cover fixture |
| `tests/real/README.md` | patched | `af19df716ceb` | `W5-tests-real-README.patch` (X4) |
| `tests/real/__init__.py` | verbatim | `6c79a45cde2e` |  |
| `tests/real/assignment_fixture.py` | verbatim | `60caf55255a2` |  |
| `tests/real/performance_benchmark.py` | excluded |  | Docker performance benchmark not adopted (lane 05 D5) |
| `tests/real/run_schedule.py` | verbatim | `fe8b19714a22` |  |
| `tests/real/schedule_ortools_cp_sat.py` | verbatim | `3b090ba6d501` |  |
| `tests/real/schedule_real_helper.py` | verbatim | `b7b7e8f8c943` |  |
| `tests/real/schedule_score_ground_truth.py` | verbatim | `b5c8445ce63c` |  |
| `tests/real/solver_capabilities.py` | verbatim | `e713cdbaf7e3` |  |
| `tests/real/solver_capabilities_residue.py` | v2-only |  | Linux /proc solver-process residue audit kept from the retired v2 probe (r6g) |
| `tests/schedule_test_helper.py` | verbatim | `cd35d2b02d5f` |  |
| `tests/server_support.py` | v2-only |  | helpers for the v2 test_server_* suites |
| `tests/solver_test_utils.py` | verbatim | `e22d07ca2dd4` |  |
| `tests/test_ai_*.py` | excluded |  | X5: AI tests |
| `tests/test_assistant_repair_fixtures.py` | v2-only |  | assistant repair fixtures solve as expected |
| `tests/test_catalogue_oracle_g7.py` | v2-only |  | proves web catalogue check G7 is sound |
| `tests/test_check_upstream_sync.py` | v2-only |  | runs the sync check in the core suite |
| `tests/test_cli.py` | verbatim | `75d0d16b66dc` |  |
| `tests/test_explain.py` | v2-only |  | a5pb run explanation tests |
| `tests/test_export_formatting.py` | verbatim | `0c773e90a93d` |  |
| `tests/test_export_xlsx_ortools_cp_sat.py` | verbatim | `45d8278a04b2` |  |
| `tests/test_exporter.py` | patched | `f974c0e0018f` | `99db-D03-xlsx-text-cells.patch` |
| `tests/test_frontend_validation.py` | excluded |  | X5: tests frontend_validation.py |
| `tests/test_hours_contract_field.py` | verbatim | `a493c596f095` |  |
| `tests/test_hours_contract_validation.py` | verbatim | `53b75c6d1a86` |  |
| `tests/test_job_response_contract.py` | v2-only |  | pins the job response contract golden |
| `tests/test_leave_daystate.py` | patched | `c2367ad6ecfd` | `99db-B5-leave-satisfies-hard-off.patch` |
| `tests/test_loader.py` | verbatim | `52e8a5289bd2` |  |
| `tests/test_models_validation.py` | verbatim | `7a3bc9fb4c3f` |  |
| `tests/test_optimize_basis.py` | v2-only |  | P8 basis |
| `tests/test_optimize_basis_admission.py` | v2-only |  | P8 basis admission |
| `tests/test_optimize_job_backends.py` | verbatim | `c6586bafd54a` |  |
| `tests/test_performance_benchmark.py` | excluded |  | Docker performance benchmark not adopted (lane 05 D5) |
| `tests/test_person_temporary.py` | v2-only |  | temporary staff in Workspace input (P1 retired, bead pknr) |
| `tests/test_preference_validation.py` | verbatim | `8ab8e8de5fc8` |  |
| `tests/test_process_executor.py` | patched | `2fe233743b2b` | `W2-tests-test_process_executor.patch` (X4). `99db-D01-child-memory-cap.patch` |
| `tests/test_public_diagnostic.py` | patched | `b45cadd61187` | `W2-tests-test_public_diagnostic.patch` (P14) |
| `tests/test_real_run_schedule.py` | verbatim | `2c3b74aa2246` |  |
| `tests/test_real_schedule_helper.py` | verbatim | `86f0202bb4c9` |  |
| `tests/test_real_solver_capabilities.py` | verbatim | `dcd4f9c72723` |  |
| `tests/test_requirement_overrides.py` | v2-only |  | P3 per-date overrides |
| `tests/test_retry.py` | verbatim | `724b206e0095` |  |
| `tests/test_roster_container.py` | v2-only |  | P7 roster container |
| `tests/test_roster_routes.py` | v2-only |  | P7 /xlsx and /roster routes |
| `tests/test_runner_inconclusive.py` | v2-only |  | P8 INCONCLUSIVE outcome |
| `tests/test_runner_real_inconclusive.py` | v2-only |  | P8 real scheduler reaches INCONCLUSIVE |
| `tests/test_runner_termination.py` | v2-only |  | P7 roster handoff on each termination |
| `tests/test_schedule_ortools_cp_sat.py` | verbatim | `18d0697bddd4` |  |
| `tests/test_schedule_ortools_mathopt_cp_sat.py` | verbatim | `81d13a3ecb77` |  |
| `tests/test_schedule_ortools_mathopt_gscip.py` | verbatim | `6d31e03ae628` |  |
| `tests/test_schedule_ortools_mathopt_highs.py` | verbatim | `6f0b66c44012` |  |
| `tests/test_schedule_ortools_mpsolver_bop.py` | verbatim | `1fda1bb6934e` |  |
| `tests/test_schedule_ortools_mpsolver_cbc.py` | verbatim | `7c5292150b21` |  |
| `tests/test_schedule_ortools_mpsolver_cp_sat.py` | verbatim | `7eff3b47430f` |  |
| `tests/test_schedule_ortools_mpsolver_scip.py` | verbatim | `56c2c9353b90` |  |
| `tests/test_schedule_pulp_glpk.py` | verbatim | `a4b4ae59afd5` |  |
| `tests/test_schedule_pulp_highs.py` | verbatim | `e232c450b15a` |  |
| `tests/test_schedule_pulp_scip.py` | verbatim | `2920bc5a6e5f` |  |
| `tests/test_scheduler.py` | patched | `d82103a534ad` | `99db-B1-history-completed-hard-sequence.patch` |
| `tests/test_scheduler_on_roster.py` | v2-only |  | P4 on_roster callback |
| `tests/test_serve.py` | patched | `00598907deac` | `W6-tests-test_serve.patch` (P5, P8, P11). conftest.py UPSTREAM_DEVIATIONS skips 9 of its genie tests |
| `tests/test_serve_curl.sh` | verbatim | `6eedfbee5736` |  |
| `tests/test_server_api.py` | v2-only |  | v2 HTTP API suite (P5 to P9, P11) |
| `tests/test_server_backend_parity.py` | v2-only |  | memory, fakeredis and real Redis behave the same |
| `tests/test_server_controller_retry.py` | v2-only |  | controller retry paths |
| `tests/test_server_identity.py` | v2-only |  | runtime identity in /info |
| `tests/test_server_lifecycle_gates.py` | v2-only |  | job lifecycle gates, rewritten onto the W6 lease API |
| `tests/test_server_priority_queue.py` | v2-only |  | P9 purpose queues. W6: the memory variant of 5 residue tests skips (the genie memory store has no queue index), and the 2-line hash-tag test was deleted (Lua only) |
| `tests/test_server_replay.py` | v2-only |  | P6 event replay |
| `tests/test_server_scheduling_input.py` | v2-only |  | P5 submit boundary |
| `tests/test_server_store_contract.py` | v2-only |  | store contract on every backend |
| `tests/test_server_worker_loss.py` | v2-only |  | worker loss recovery. W6 deleted the claim_expires_at and worker_id equality lines (Lua only) |
| `tests/test_server_worker_loss_multiprocess.py` | v2-only |  | real-Redis SIGKILL worker-loss gate |
| `tests/test_sg_compliance_roster.py` | v2-only |  | SG 28-day compliance ward case (upstream candidate) |
| `tests/test_shift_type_covering_preference.py` | verbatim | `ebe0c2d46e3a` |  |
| `tests/test_shift_type_working_time.py` | verbatim | `8c8caf53830a` |  |
| `tests/test_skill_mix.py` | v2-only |  | P2 skillMix |
| `tests/test_solver_interface.py` | verbatim | `523fc735d17e` |  |
| `tests/test_solver_ortools_cp_sat.py` | patched | `794aad1fceb4` | `3c91-solver-max-lp-sym.patch` |
| `tests/test_solver_ortools_linear.py` | verbatim | `ad85c5496d0f` |  |
| `tests/test_solver_ortools_mathopt.py` | verbatim | `5dd68e6d1afe` |  |
| `tests/test_solver_pulp_glpk.py` | verbatim | `be94ac4ce248` |  |
| `tests/test_solver_pulp_python.py` | verbatim | `9d25e7b5690f` |  |
| `tests/test_temporary_cover_equivalence.py` | v2-only |  | temporary cover fixtures solve alike |
| `tests/test_usage_metrics.py` | excluded |  | X6: tests telemetry that v2 keeps off |
| `tests/test_utils.py` | verbatim | `0850cbb2d6aa` |  |
| `tests/test_version.py` | v2-only |  | v2 version stamping |
| `tests/test_ward_shift_patterns_roster.py` | v2-only |  | 8-shift-pattern ward case |
| `tests/test_workspace_holiday_import_switch.py` | v2-only |  | P5 holiday-import switch in Workspace input (6975) |
| `tests/test_workspace_temporary_cover.py` | v2-only |  | P5 temporary cover in Workspace input |
| `tests/test_yaml_bound.py` | v2-only |  | coded 400 for the YAML expansion bound |
| `tests/testcases/artificial/ortools/README.md` | verbatim | `8e5bfb197203` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution.csv` | verbatim | `dc543f5000cf` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution.prettify.xlsx` | verbatim | `bc51fc0fb6cd` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution.xlsx` | verbatim | `5177485d8690` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution.yaml` | verbatim | `7b9e14f90ed1` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_all_mse.csv` | verbatim | `a3a6a6b03ce3` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_all_mse.prettify.xlsx` | verbatim | `cfeecb04a986` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_all_mse.xlsx` | verbatim | `3fdd37a78da7` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_all_mse.yaml` | verbatim | `fc4332bf1fd5` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_nested.csv` | verbatim | `dc543f5000cf` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_nested.prettify.xlsx` | verbatim | `bc51fc0fb6cd` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_nested.xlsx` | verbatim | `5177485d8690` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_nested.yaml` | verbatim | `75771eb8a213` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_offs.csv` | verbatim | `dc543f5000cf` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_offs.prettify.xlsx` | verbatim | `bc51fc0fb6cd` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_offs.xlsx` | verbatim | `5177485d8690` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_offs.yaml` | verbatim | `43c701d9b28b` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_penalty.csv` | verbatim | `dc543f5000cf` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_penalty.prettify.xlsx` | verbatim | `bc51fc0fb6cd` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_penalty.xlsx` | verbatim | `5177485d8690` |  |
| `tests/testcases/artificial/ortools/ex1_even_shift_distribution_count_penalty.yaml` | verbatim | `9edfc09acc40` |  |
| `tests/testcases/artificial/ortools/ex2_multiple_date_formats.csv` | verbatim | `e5864cc021c6` |  |
| `tests/testcases/artificial/ortools/ex2_multiple_date_formats.prettify.xlsx` | verbatim | `41e8a7121ba0` |  |
| `tests/testcases/artificial/ortools/ex2_multiple_date_formats.xlsx` | verbatim | `5774fb00bd08` |  |
| `tests/testcases/artificial/ortools/ex2_multiple_date_formats.yaml` | verbatim | `6e090e1b95d4` |  |
| `tests/testcases/artificial/ortools/ex2_multiple_shift_requests.csv` | verbatim | `99392c859a1f` |  |
| `tests/testcases/artificial/ortools/ex2_multiple_shift_requests.prettify.xlsx` | verbatim | `bcdcb911b2b8` |  |
| `tests/testcases/artificial/ortools/ex2_multiple_shift_requests.xlsx` | verbatim | `fc09d55d7f22` |  |
| `tests/testcases/artificial/ortools/ex2_multiple_shift_requests.yaml` | verbatim | `d820b695ca02` |  |
| `tests/testcases/artificial/ortools/ex2_shorthand_dates.csv` | verbatim | `e5864cc021c6` |  |
| `tests/testcases/artificial/ortools/ex2_shorthand_dates.prettify.xlsx` | verbatim | `8e0ba7230fe9` |  |
| `tests/testcases/artificial/ortools/ex2_shorthand_dates.xlsx` | verbatim | `5774fb00bd08` |  |
| `tests/testcases/artificial/ortools/ex2_shorthand_dates.yaml` | verbatim | `91c531f3b0b5` |  |
| `tests/testcases/basics/01_1nurse_1shift_12day_fix_shift_count_penalty_ortools_9.12_bug.csv` | verbatim | `3f842aeba9dc` |  |
| `tests/testcases/basics/01_1nurse_1shift_12day_fix_shift_count_penalty_ortools_9.12_bug.prettify.xlsx` | verbatim | `bbd40c6696ca` |  |
| `tests/testcases/basics/01_1nurse_1shift_12day_fix_shift_count_penalty_ortools_9.12_bug.xlsx` | verbatim | `81138d60d0c8` |  |
| `tests/testcases/basics/01_1nurse_1shift_12day_fix_shift_count_penalty_ortools_9.12_bug.yaml` | verbatim | `5916e2c81550` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day.csv` | verbatim | `012778dd0614` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day.prettify.xlsx` | verbatim | `39609182f76d` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day.xlsx` | verbatim | `a3b222a61f10` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day.yaml` | verbatim | `bbafd44288b8` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_all_prefs.csv` | verbatim | `6379882a616d` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_all_prefs.prettify.xlsx` | verbatim | `e6bb40889d22` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_all_prefs.xlsx` | verbatim | `c70edc72dfc9` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_all_prefs.yaml` | verbatim | `bbf99ad75f54` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_dates_group_keyword_all_error.txt` | verbatim | `29047bcabe13` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_dates_group_keyword_all_error.yaml` | verbatim | `d676ff52eb76` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_dates_group_keyword_monday_error.txt` | verbatim | `3bda98421cc2` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_dates_group_keyword_monday_error.yaml` | verbatim | `1f1815867aff` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_dates_group_keyword_weekday_error.txt` | verbatim | `6d04a7b3218f` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_dates_group_keyword_weekday_error.yaml` | verbatim | `e1d9296c43bd` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_extra_parameter_error.txt` | verbatim | `91e3e902491e` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_extra_parameter_error.yaml` | verbatim | `5d124a388ee5` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_infeasible.csv` | verbatim | `d7580c7303f6` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_infeasible.yaml` | verbatim | `0b672883c947` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_pattern_not_list_error.txt` | verbatim | `d8addb71b627` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_pattern_not_list_error.yaml` | verbatim | `f03a7b45fa4c` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_people_group_keyword_all_error.txt` | verbatim | `1057b856318d` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_people_group_keyword_all_error.yaml` | verbatim | `b1004fa01e65` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_shift_type_requirement_off_error.txt` | verbatim | `59627852ed8d` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_shift_type_requirement_off_error.yaml` | verbatim | `492ad4bc3590` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_shift_types_group_keyword_all_error.txt` | verbatim | `35521dac3200` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_shift_types_group_keyword_all_error.yaml` | verbatim | `b0a12100a34e` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_weight_floating_point_error.txt` | verbatim | `a98fa7fcf705` |  |
| `tests/testcases/basics/01_1nurse_1shift_1day_weight_floating_point_error.yaml` | verbatim | `767c3f6e2664` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_aggregate.csv` | verbatim | `4b07e8a62e4f` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_aggregate.prettify.xlsx` | verbatim | `f5bf578f8698` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_aggregate.xlsx` | verbatim | `cc0f1a834698` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_aggregate.yaml` | verbatim | `5cd2d95614d8` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_duplicate.csv` | verbatim | `d87429f07541` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_duplicate.prettify.xlsx` | verbatim | `47dc91d4d933` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_duplicate.xlsx` | verbatim | `fa595661d398` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_duplicate.yaml` | verbatim | `ab45d832f098` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_group_aggregate.csv` | verbatim | `41b282f21f0f` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_group_aggregate.prettify.xlsx` | verbatim | `bc995deee44e` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_group_aggregate.xlsx` | verbatim | `56d927426e95` |  |
| `tests/testcases/basics/02_1nurse_2shifts_2days_shift_type_requirement_nested_group_aggregate.yaml` | verbatim | `f05b754cbade` |  |
| `tests/testcases/basics/02_2nurses_2shifts_1day_shift_type_requirement_flat_list_independent.csv` | verbatim | `efc5158665f1` |  |
| `tests/testcases/basics/02_2nurses_2shifts_1day_shift_type_requirement_flat_list_independent.prettify.xlsx` | verbatim | `ab87ce680469` |  |
| `tests/testcases/basics/02_2nurses_2shifts_1day_shift_type_requirement_flat_list_independent.xlsx` | verbatim | `806202e41d8e` |  |
| `tests/testcases/basics/02_2nurses_2shifts_1day_shift_type_requirement_flat_list_independent.yaml` | verbatim | `cfd4e1330a23` |  |
| `tests/testcases/basics/02_2nurses_2shifts_6days_shift_count_coefficients_balance.csv` | verbatim | `d8042f04fac6` |  |
| `tests/testcases/basics/02_2nurses_2shifts_6days_shift_count_coefficients_balance.prettify.xlsx` | verbatim | `64fc2e7eb845` |  |
| `tests/testcases/basics/02_2nurses_2shifts_6days_shift_count_coefficients_balance.xlsx` | verbatim | `f92bae30fac9` |  |
| `tests/testcases/basics/02_2nurses_2shifts_6days_shift_count_coefficients_balance.yaml` | verbatim | `1932ee869fc9` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day.csv` | verbatim | `5c27dfda5f00` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day.prettify.xlsx` | verbatim | `4799c3218cc3` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day.xlsx` | verbatim | `dbf922d73e8f` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day.yaml` | verbatim | `9da77055e633` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_attract.csv` | verbatim | `e508d123e20c` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_attract.prettify.xlsx` | verbatim | `cb681b9bdef0` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_attract.xlsx` | verbatim | `c14196a52130` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_attract.yaml` | verbatim | `a8424e31c65b` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_attract_off.csv` | verbatim | `19eb87679575` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_attract_off.prettify.xlsx` | verbatim | `cea0678aca6e` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_attract_off.xlsx` | verbatim | `e09fcbd9fd6f` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_attract_off.yaml` | verbatim | `3414fe8b30db` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_repel.csv` | verbatim | `80e726b88422` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_repel.prettify.xlsx` | verbatim | `a5d60f4f4de4` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_repel.xlsx` | verbatim | `de03e639e943` |  |
| `tests/testcases/basics/02_3nurses_1shift_1day_shift_affinity_repel.yaml` | verbatim | `1dc71f7b4aa3` |  |
| `tests/testcases/basics/02_3nurses_2shifts_5days_shift_type_requirement_coefficients_balance_weighted.csv` | verbatim | `422f7bcd21cc` |  |
| `tests/testcases/basics/02_3nurses_2shifts_5days_shift_type_requirement_coefficients_balance_weighted.prettify.xlsx` | verbatim | `5b1ab79b559a` |  |
| `tests/testcases/basics/02_3nurses_2shifts_5days_shift_type_requirement_coefficients_balance_weighted.xlsx` | verbatim | `a0735f8f49e7` |  |
| `tests/testcases/basics/02_3nurses_2shifts_5days_shift_type_requirement_coefficients_balance_weighted.yaml` | verbatim | `2976bca29914` |  |
| `tests/testcases/basics/02_3nurses_2shifts_6days_shift_type_requirement_coefficients_balance_all.csv` | verbatim | `7cf60e46c0bc` |  |
| `tests/testcases/basics/02_3nurses_2shifts_6days_shift_type_requirement_coefficients_balance_all.prettify.xlsx` | verbatim | `ac3bb28e7cf0` |  |
| `tests/testcases/basics/02_3nurses_2shifts_6days_shift_type_requirement_coefficients_balance_all.xlsx` | verbatim | `5b39d97eb318` |  |
| `tests/testcases/basics/02_3nurses_2shifts_6days_shift_type_requirement_coefficients_balance_all.yaml` | verbatim | `1eafd0a5900c` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days.csv` | verbatim | `21b46ee70bbf` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days.prettify.xlsx` | verbatim | `e3ee89eecb24` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days.xlsx` | verbatim | `ccce1b961c83` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days.yaml` | verbatim | `732dbbde7c51` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_dates_group_odd.csv` | verbatim | `4e649ef8c168` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_dates_group_odd.prettify.xlsx` | verbatim | `53f2a33453db` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_dates_group_odd.xlsx` | verbatim | `ffba2a5108e3` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_dates_group_odd.yaml` | verbatim | `a38159d2268f` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_monday_blue.csv` | verbatim | `37d378463aab` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_monday_blue.prettify.xlsx` | verbatim | `8314e12286ca` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_monday_blue.xlsx` | verbatim | `f04d2975296e` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_monday_blue.yaml` | verbatim | `b2954833afbe` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_shift_request_shift_type_mixed_off_shift_count_equals.csv` | verbatim | `01dd1efced8a` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_shift_request_shift_type_mixed_off_shift_count_equals.prettify.xlsx` | verbatim | `0c3ae8750371` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_shift_request_shift_type_mixed_off_shift_count_equals.xlsx` | verbatim | `f20ea088ea9d` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_shift_request_shift_type_mixed_off_shift_count_equals.yaml` | verbatim | `719c7b313bf2` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_shift_request_shift_type_mixed_off_shift_count_mse.csv` | verbatim | `01dd1efced8a` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_shift_request_shift_type_mixed_off_shift_count_mse.prettify.xlsx` | verbatim | `0c3ae8750371` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_shift_request_shift_type_mixed_off_shift_count_mse.xlsx` | verbatim | `f20ea088ea9d` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_shift_request_shift_type_mixed_off_shift_count_mse.yaml` | verbatim | `9d4cc36f3c4e` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_all_all_all.csv` | verbatim | `e83ceca3227e` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_all_all_all.prettify.xlsx` | verbatim | `38c5536d42f8` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_all_all_all.xlsx` | verbatim | `711a45d0d425` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_all_all_all.yaml` | verbatim | `9e234ebf8ab6` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_all_all_all_with_shift_request_off.csv` | verbatim | `985eb190b9f8` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_all_all_all_with_shift_request_off.prettify.xlsx` | verbatim | `5ac78a50f27e` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_all_all_all_with_shift_request_off.xlsx` | verbatim | `f27966dfc41a` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_all_all_all_with_shift_request_off.yaml` | verbatim | `9ef4d7692358` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_off_off.csv` | verbatim | `4684c7a57c20` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_off_off.prettify.xlsx` | verbatim | `74731d3a2268` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_off_off.xlsx` | verbatim | `737f684b8d75` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_off_off.yaml` | verbatim | `410a43beba2c` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_off_off_with_history.csv` | verbatim | `dc543f5000cf` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_off_off_with_history.prettify.xlsx` | verbatim | `bd6ecaf929e7` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_off_off_with_history.xlsx` | verbatim | `c44c2a7d8f93` |  |
| `tests/testcases/basics/02_4nurses_3shifts_3days_unwanted_patterns_off_off_with_history.yaml` | verbatim | `88ea86960c24` |  |
| `tests/testcases/basics/03_3nurses_3shifts_8days_shift_type_requirement_coefficients_balance_weighted.csv` | verbatim | `d8418416069f` |  |
| `tests/testcases/basics/03_3nurses_3shifts_8days_shift_type_requirement_coefficients_balance_weighted.prettify.xlsx` | verbatim | `9a8619b9f7d8` |  |
| `tests/testcases/basics/03_3nurses_3shifts_8days_shift_type_requirement_coefficients_balance_weighted.xlsx` | verbatim | `124a004f7ee9` |  |
| `tests/testcases/basics/03_3nurses_3shifts_8days_shift_type_requirement_coefficients_balance_weighted.yaml` | verbatim | `c91ffcd3c774` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts.csv` | verbatim | `4eda085fc651` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts.prettify.xlsx` | verbatim | `fcc5bd689608` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts.xlsx` | verbatim | `89885d8c27fb` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts.yaml` | verbatim | `4f9a46ca6d33` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts_prefer.csv` | verbatim | `f6c6bc9cd1f7` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts_prefer.prettify.xlsx` | verbatim | `f26ada526195` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts_prefer.xlsx` | verbatim | `2d9ebca40e1d` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts_prefer.yaml` | verbatim | `606cda39449e` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts_prefer_with_dates.csv` | verbatim | `34b2556d94b0` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts_prefer_with_dates.prettify.xlsx` | verbatim | `3ebf0fc23114` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts_prefer_with_dates.xlsx` | verbatim | `d24e04c172f8` |  |
| `tests/testcases/basics/03_4nurses_3shifts_5days_unwanted_pattern_three_consecutive_shifts_prefer_with_dates.yaml` | verbatim | `f37a31fea673` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days.csv` | verbatim | `770b36448a2a` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days.prettify.xlsx` | verbatim | `72278ac8240b` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days.xlsx` | verbatim | `12e660501e0f` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days.yaml` | verbatim | `918226af1d9c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_avoid_night_shifts.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_avoid_night_shifts.prettify.xlsx` | verbatim | `37cc713dcea3` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_avoid_night_shifts.xlsx` | verbatim | `35ab65945635` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_avoid_night_shifts.yaml` | verbatim | `1d04cbb8f03c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_person_list_dates_range.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_person_list_dates_range.prettify.xlsx` | verbatim | `9053f3dbb6d5` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_person_list_dates_range.xlsx` | verbatim | `4c76ee8b99a4` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_person_list_dates_range.yaml` | verbatim | `698c65e9fe57` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_group.csv` | verbatim | `603a715f186c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_group.prettify.xlsx` | verbatim | `ec6df09201a2` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_group.xlsx` | verbatim | `018ad3afc343` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_group.yaml` | verbatim | `7c1d55d7da53` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_group_nested.csv` | verbatim | `603a715f186c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_group_nested.prettify.xlsx` | verbatim | `ec6df09201a2` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_group_nested.xlsx` | verbatim | `018ad3afc343` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_group_nested.yaml` | verbatim | `f1fbc467c8b3` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_length_1.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_length_1.prettify.xlsx` | verbatim | `9053f3dbb6d5` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_length_1.xlsx` | verbatim | `35ab65945635` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_length_1.yaml` | verbatim | `7322166d34fc` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_penalty.csv` | verbatim | `603a715f186c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_penalty.prettify.xlsx` | verbatim | `d7fbe00cece8` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_penalty.xlsx` | verbatim | `61811caffcea` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_penalty.yaml` | verbatim | `3e1c4449b668` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_penalty_infinite.csv` | verbatim | `603a715f186c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_penalty_infinite.prettify.xlsx` | verbatim | `d7fbe00cece8` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_penalty_infinite.xlsx` | verbatim | `6ec479eb3ad6` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_request_shift_type_list_penalty_infinite.yaml` | verbatim | `ceab37ed8066` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_people_all.csv` | verbatim | `bc7d6e5ff746` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_people_all.prettify.xlsx` | verbatim | `372403084932` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_people_all.xlsx` | verbatim | `1fd36dc962aa` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_people_all.yaml` | verbatim | `6eb35ae2dbc2` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_qualified_people.csv` | verbatim | `8f0bfefc51f6` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_qualified_people.prettify.xlsx` | verbatim | `b38514e05ad2` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_qualified_people.xlsx` | verbatim | `a0bb5ccb8298` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_qualified_people.yaml` | verbatim | `8af819c57e39` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_shift_type_all.csv` | verbatim | `33e417540aea` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_shift_type_all.prettify.xlsx` | verbatim | `497cd1c160b9` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_shift_type_all.xlsx` | verbatim | `ca1f51111f8d` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_shift_type_requirement_shift_type_all.yaml` | verbatim | `cbfb859b23b3` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_history.csv` | verbatim | `5fc0f2424703` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_history.prettify.xlsx` | verbatim | `ea6a05ea4682` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_history.xlsx` | verbatim | `a7da1b01ffe3` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_history.yaml` | verbatim | `aeefe297b3b7` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_history_shift_request_must_violate.csv` | verbatim | `064141125478` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_history_shift_request_must_violate.prettify.xlsx` | verbatim | `77464bf79a70` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_history_shift_request_must_violate.xlsx` | verbatim | `fa656ce3c2bb` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_history_shift_request_must_violate.yaml` | verbatim | `f8f33cb44c8c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_inf.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_inf.prettify.xlsx` | verbatim | `9053f3dbb6d5` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_inf.xlsx` | verbatim | `4c76ee8b99a4` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_inf.yaml` | verbatim | `b60a56f04272` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_ninf.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_ninf.prettify.xlsx` | verbatim | `9053f3dbb6d5` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_ninf.xlsx` | verbatim | `4c76ee8b99a4` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_ninf.yaml` | verbatim | `4e18bea1eb11` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_groups.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_groups.prettify.xlsx` | verbatim | `02010b16ec57` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_groups.xlsx` | verbatim | `4c76ee8b99a4` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_groups.yaml` | verbatim | `3a140c418753` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_groups_nested.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_groups_nested.prettify.xlsx` | verbatim | `02010b16ec57` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_groups_nested.xlsx` | verbatim | `4c76ee8b99a4` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_groups_nested.yaml` | verbatim | `01019269bff6` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_ids_reversed.csv` | verbatim | `60b385b050d3` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_ids_reversed.prettify.xlsx` | verbatim | `8844bba189ed` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_ids_reversed.xlsx` | verbatim | `0f339f63da21` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_ids_reversed.yaml` | verbatim | `a9d46a20bd5e` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_ids_string.csv` | verbatim | `6516d79fef90` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_ids_string.prettify.xlsx` | verbatim | `00bd2512d2f0` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_ids_string.xlsx` | verbatim | `a05b1de451f1` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_people_ids_string.yaml` | verbatim | `78b0eb6a7d67` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns.csv` | verbatim | `555d8cd74f8c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns.prettify.xlsx` | verbatim | `ee3cfed90217` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns.xlsx` | verbatim | `37f210b687f4` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns.yaml` | verbatim | `236e1c8591b3` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns_2.csv` | verbatim | `555d8cd74f8c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns_2.prettify.xlsx` | verbatim | `19dd62700411` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns_2.xlsx` | verbatim | `6faab3029f22` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns_2.yaml` | verbatim | `cb6226f97b4d` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns_nested.csv` | verbatim | `555d8cd74f8c` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns_nested.prettify.xlsx` | verbatim | `19dd62700411` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns_nested.xlsx` | verbatim | `e5997b1040b5` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_real_patterns_nested.yaml` | verbatim | `ab40d5db2eb5` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_single_shift.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_single_shift.prettify.xlsx` | verbatim | `37cc713dcea3` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_single_shift.xlsx` | verbatim | `c7f65dc3f681` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_single_shift.yaml` | verbatim | `0b03310fbb22` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_two_consecutive_shifts.csv` | verbatim | `ae6a4aa9a960` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_two_consecutive_shifts.prettify.xlsx` | verbatim | `62ab70caf1a7` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_two_consecutive_shifts.xlsx` | verbatim | `2471978b1d39` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_two_consecutive_shifts.yaml` | verbatim | `0f71c7534098` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_two_nurses.csv` | verbatim | `899bd6c5d4ce` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_two_nurses.prettify.xlsx` | verbatim | `9053f3dbb6d5` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_two_nurses.xlsx` | verbatim | `4c76ee8b99a4` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_two_nurses.yaml` | verbatim | `012f5345ad0b` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_weighted.csv` | verbatim | `8533b98aa0ea` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_weighted.prettify.xlsx` | verbatim | `c409cfd74730` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_weighted.xlsx` | verbatim | `065dfdf2fd87` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_pattern_weighted.yaml` | verbatim | `507399e5fce9` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_patterns_all_all_all_with_history.csv` | verbatim | `3809ce0813e7` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_patterns_all_all_all_with_history.prettify.xlsx` | verbatim | `20c9d111519b` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_patterns_all_all_all_with_history.xlsx` | verbatim | `5d420aa8d122` |  |
| `tests/testcases/basics/03_4nurses_3shifts_7days_unwanted_patterns_all_all_all_with_history.yaml` | verbatim | `2099cd70ccc2` |  |
| `tests/testcases/basics/03_4nurses_3shifts_9days_fix_dates_range_modified_during_date_parsing_bug.csv` | verbatim | `049d2db1a2ed` |  |
| `tests/testcases/basics/03_4nurses_3shifts_9days_fix_dates_range_modified_during_date_parsing_bug.prettify.xlsx` | verbatim | `fe19a1b09201` |  |
| `tests/testcases/basics/03_4nurses_3shifts_9days_fix_dates_range_modified_during_date_parsing_bug.xlsx` | verbatim | `53527dbf739e` |  |
| `tests/testcases/basics/03_4nurses_3shifts_9days_fix_dates_range_modified_during_date_parsing_bug.yaml` | verbatim | `3a5ea07d156d` |  |
| `tests/testcases/basics/03_4nurses_4shifts_7days_shift_type_requirement_date_range.csv` | verbatim | `46f324d02cf9` |  |
| `tests/testcases/basics/03_4nurses_4shifts_7days_shift_type_requirement_date_range.prettify.xlsx` | verbatim | `184a3e21e9a2` |  |
| `tests/testcases/basics/03_4nurses_4shifts_7days_shift_type_requirement_date_range.xlsx` | verbatim | `d861e64c0127` |  |
| `tests/testcases/basics/03_4nurses_4shifts_7days_shift_type_requirement_date_range.yaml` | verbatim | `8b0287a95713` |  |
| `tests/testcases/basics/03_4nurses_4shifts_7days_shift_type_requirement_date_weekday.csv` | verbatim | `e9bdfbf19978` |  |
| `tests/testcases/basics/03_4nurses_4shifts_7days_shift_type_requirement_date_weekday.prettify.xlsx` | verbatim | `bdd3cdfd6e6d` |  |
| `tests/testcases/basics/03_4nurses_4shifts_7days_shift_type_requirement_date_weekday.xlsx` | verbatim | `b0176ca27717` |  |
| `tests/testcases/basics/03_4nurses_4shifts_7days_shift_type_requirement_date_weekday.yaml` | verbatim | `fd88549c89c7` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days.csv` | verbatim | `273fabaaad97` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days.prettify.xlsx` | verbatim | `0fdc68b1126a` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days.xlsx` | verbatim | `95f14611e6a1` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days.yaml` | verbatim | `0ad116987cb0` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_date.csv` | verbatim | `c0d268ab2498` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_date.prettify.xlsx` | verbatim | `0f99df7245c6` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_date.xlsx` | verbatim | `fc769882143f` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_date.yaml` | verbatim | `fa0b1778bc04` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_repel_multiple_people1.csv` | verbatim | `a48042a773ec` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_repel_multiple_people1.prettify.xlsx` | verbatim | `83fbb208213a` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_repel_multiple_people1.xlsx` | verbatim | `401113309383` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_repel_multiple_people1.yaml` | verbatim | `1e135127d271` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_repel_multiple_people1_nested.csv` | verbatim | `a48042a773ec` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_repel_multiple_people1_nested.prettify.xlsx` | verbatim | `ca8513f31481` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_repel_multiple_people1_nested.xlsx` | verbatim | `74b85e967564` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_attract_repel_multiple_people1_nested.yaml` | verbatim | `898ea5af1d9f` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2.csv` | verbatim | `059408770421` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2.prettify.xlsx` | verbatim | `c9f342351bd9` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2.xlsx` | verbatim | `7e502ddc9802` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2.yaml` | verbatim | `5791c354ef4a` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2_nested.csv` | verbatim | `059408770421` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2_nested.prettify.xlsx` | verbatim | `683bab43b638` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2_nested.xlsx` | verbatim | `b146173793ff` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2_nested.yaml` | verbatim | `bbb7a6eea9fb` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2_nested_nested.csv` | verbatim | `059408770421` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2_nested_nested.prettify.xlsx` | verbatim | `c9f342351bd9` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2_nested_nested.xlsx` | verbatim | `7e502ddc9802` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_affinity_repel_multiple_people1_people2_nested_nested.yaml` | verbatim | `623c5f6c9586` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_type_requirement_preferred_num_people.csv` | verbatim | `273fabaaad97` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_type_requirement_preferred_num_people.prettify.xlsx` | verbatim | `0fdc68b1126a` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_type_requirement_preferred_num_people.xlsx` | verbatim | `95f14611e6a1` |  |
| `tests/testcases/basics/03_6nurses_3shifts_7days_shift_type_requirement_preferred_num_people.yaml` | verbatim | `e954544deab7` |  |
| `tests/testcases/basics/03_6nurses_6shifts_7days_shift_affinity_attract_multiple_shift_types.csv` | verbatim | `db2a1afca741` |  |
| `tests/testcases/basics/03_6nurses_6shifts_7days_shift_affinity_attract_multiple_shift_types.prettify.xlsx` | verbatim | `69d6d6984925` |  |
| `tests/testcases/basics/03_6nurses_6shifts_7days_shift_affinity_attract_multiple_shift_types.xlsx` | verbatim | `7e1a87d50844` |  |
| `tests/testcases/basics/03_6nurses_6shifts_7days_shift_affinity_attract_multiple_shift_types.yaml` | verbatim | `19199611e222` |  |
| `tests/testcases/basics/03_6nurses_6shifts_7days_shift_affinity_attract_multiple_shift_types_expand.csv` | verbatim | `db2a1afca741` |  |
| `tests/testcases/basics/03_6nurses_6shifts_7days_shift_affinity_attract_multiple_shift_types_expand.prettify.xlsx` | verbatim | `835d89d0083a` |  |
| `tests/testcases/basics/03_6nurses_6shifts_7days_shift_affinity_attract_multiple_shift_types_expand.xlsx` | verbatim | `22ecc4d39b13` |  |
| `tests/testcases/basics/03_6nurses_6shifts_7days_shift_affinity_attract_multiple_shift_types_expand.yaml` | verbatim | `5158c9cff365` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2023.csv` | verbatim | `594ce8847d97` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2023.prettify.xlsx` | verbatim | `89a594da4fd4` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2023.xlsx` | verbatim | `33d025043df5` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2024.csv` | verbatim | `d2d3bced72e9` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2024.prettify.xlsx` | verbatim | `52a5eab2d0c5` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2024.xlsx` | verbatim | `63d986eb461b` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2025.csv` | verbatim | `a2e62d1bb00f` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2025.prettify.xlsx` | verbatim | `3651ba9d0e7f` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2025.xlsx` | verbatim | `4bcb505999b2` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2025_labor.csv` | verbatim | `f01275ca988b` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2025_labor.prettify.xlsx` | verbatim | `938d7f6e8767` |  |
| `tests/testcases/basics/04_1nurses_1shifts_1years_shift_type_requirement_date_workday_2025_labor.xlsx` | verbatim | `97d61fd2fc79` |  |
| `tests/testcases/real/large-ward-with-87-people-2025-11.assignment-01.json` | patched | `4221af315e07` | `P0-fixture-restamp.patch` (P0) |
| `tests/testcases/real/large-ward-with-87-people-2025-11.yaml` | verbatim | `8ec166c666d5` |  |
| `tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml` | v2-only |  | SG compliance ward case |
| `tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml` | v2-only |  | 8-shift-pattern ward case |
| `upstream-patches/3c91-solver-max-lp-sym.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/99db-B1-history-completed-hard-sequence.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/99db-B5-leave-satisfies-hard-off.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/99db-C1-required-not-above-preferred.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/99db-D01-child-memory-cap.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/99db-D03-xlsx-text-cells.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/99db-D05-head-count-bound.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/99db-D07-per-client-queue-cap.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/P0-fixture-restamp.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/P2-P3-skillmix-overrides.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/P4-on-roster.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W0-pyproject.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W0-requirements.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-server-api-optimize.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-server-api-schemas.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-server-app.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-server-config.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-server-diagnostic.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-server-errors.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-server-jobs-runner.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-server-maintenance.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-tests-test_process_executor.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W2-tests-test_public_diagnostic.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W5-AGENTS.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W5-tests-real-README.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W6-server-job_store.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W6-server-jobs-controller.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W6-server-jobs-models.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W6-server-jobs-worker.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W6-server-stores-memory.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W6-server-stores-redis.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/W6-tests-test_serve.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/a5pb-ledger.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/a5pb-why-solve.patch` | v2-only |  | sync patch or manifest |
| `upstream-patches/manifest.toml` | v2-only |  | sync patch or manifest |
<!-- origin-table:end -->

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

## Dependency pins (`core/requirements.txt`, `core/requirements-optional.txt`)

- `ruamel.yaml==0.19.1` and `pydantic==2.13.4` — the canonical-boundary versions
  that define the golden canonical bytes, validation locations, and 422 fixtures.
- `redis` is in the runtime file (imported lazily; memory mode never imports it). Since the W0 split (2026-09-25), `core/requirements.txt` holds the runtime pins and no test tools. `core/requirements-optional.txt` starts with `-r requirements.txt` and adds `pulp==3.3.2`, `highspy==1.12.0`, `pyscipopt==6.2.1`, `pytest==9.1.1`, `pytest-cov==7.1.0`, `fakeredis>=2,<3`, and `ruff==0.15.22`: W1 restores the upstream multi-solver library, while the product stays CP-SAT only at the server boundary (spec decision X4).

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

### Net-new catalogue-oracle test modules (2026-07-27)

No upstream counterpart. Both are **net-new, additive, and test-only** — nothing under
`nurse_scheduling/` was touched, so upstream drift is unchanged.

| File | Purpose |
| --- | --- |
| `core/tests/catalogue_oracle.py` | Reusable CP-SAT oracle harness for vetting frontend Tier-1 conflict-catalogue checks: tiny-scenario YAML builder (people/shift-types/groups/preferences), `solve()` reducing an outcome to `INFEASIBLE`/`SOLVED`, and `assert_sound()`. Helper module, not collected as tests — same role as `schedule_test_helper.py` / `solver_test_utils.py`. |
| `core/tests/test_catalogue_oracle_g7.py` | Vets catalogue check **G7** (weighted attainable-max) across 19 candidate shapes, and pins the three build-time premises its soundness rests on: coefficients >= 1, duplicate coefficient entries rejected, `at most one shift per day` mandatory. |

**Why it lives in `tests/` rather than `scripts/`.** `pyproject.toml` scopes discovery to
the test tree so runnable tools under `core/scripts` (e.g. `check_upstream_sync.py`) are
never collected. That exemption exists for *runtime*,
and does not apply here: these scenarios are 1-2 people over 6-28 days, so the whole
sweep solves in **~0.5 s** and belongs in the ordinary run.

**Contract — assert only the sound direction.** `predicted infeasible => solver returns
INFEASIBLE`. The converse is deliberately never asserted: catalogue checks are bounded
relaxations, so a solver-proven-infeasible scenario may sit outside every check (low
recall, the intended trade). A check firing on a solvable scenario is a false positive —
if one appears, drop the check rather than weakening the test.

**Verification (2026-07-27):** `pytest tests/test_catalogue_oracle_g7.py` — 24 passed in
0.49 s. Full `core` suite — 600 passed, 51 skipped. `ruff check` + `ruff format --check`
on `tests/` — clean.

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

## U31 — Upstream `5027e2f..d63519b` supervised optimization refresh

Execution note for ticket **U31 — Refresh the rebuild to upstream `d63519b`**.
Reconciles the full upstream delta `git diff 5027e2f..d63519b` (34 changed
paths) against the rebuild. U31 imports upstream's per-job **process-supervision**
work (spawned, process-tree-supervised child; forced timeout/cancel; cooperative
finish-now) but **not** its re-widened multi-solver product. It does not reopen
the settled Redis, Workspace, replay, BFF, runtime-identity, or deployment
architecture. Governed by the rebuild-tech-plan
`d63519b-process-supervision-addendum` and split across children U31a–U31e.

### Settled adaptation invariants

- **CP-SAT stays the only solver.** Upstream `d63519b` restored a `solver`
  selector on its CLI/HTTP boundary and a multi-solver capability registry
  (`server/solver_capabilities.py`) plus PuLP/CBC. The rebuild keeps the
  previously settled single-solver boundary: `STOPPABLE_SOLVERS` is narrowed to
  `{ortools/cp-sat}` in `server/jobs/models.py` and `solver_supports_stop` is
  retained there; upstream's `server/solver_capabilities.py`, PuLP source/tests,
  and the multi-solver docs matrix are **excluded**. The browser sends no solver
  field; the backend accepts only a missing/default or exact `ortools/cp-sat`
  selector before capacity is reserved.
- **One spawned child per claimed job.** `server/jobs/process_tree.py` is imported
  verbatim and `server/jobs/process_executor.py` is imported with one small
  adaptation (a child-side `OptimizationExecutionError` → `JobFailure` bridge, see
  the table); together they run each optimization in a process-tree-supervised
  child. The lease-owning worker remains the only store/controller client (one
  Uvicorn worker, private Redis unchanged).
- **Timeout grace is positive-finite, default 90s.** `OPTIMIZE_TIMEOUT_GRACE_SECONDS`
  (`server/config.py` `timeout_grace_seconds`) arms the watchdog from child launch
  through terminal delivery and forces termination after `timeout + grace`. A
  native feasible timeout classifies as `solver_timeout`; a forced watchdog
  failure classifies as `process_timeout`. The rebuild retains its own
  `OptimizationExecutionError` classification path in `server/jobs/runner.py`
  rather than upstream's `JobFailure`-return refactor.
- **Cancel / finish-now / lease-loss are unchanged product behavior.** Cancel is
  server-enforced for a running CP-SAT job, kills the child tree, discards output,
  and settles `cancelled` via the new lease-fenced `complete_cancellation`. Finish
  now is cooperative (`user_requested` incumbent). Worker shutdown or claim loss
  writes nothing and leaves maintenance to own the eventual `worker_lost`. The
  rebuild keeps its narrow `solver_supports_stop` cancel/early-completion guard in
  `server/jobs/controller.py` (dead for the CP-SAT-only product, so cancel of a
  running job always succeeds) rather than adopting upstream's removal of that
  guard.
- **`JOB_MAX_PENDING=8`, opaque cursors, runtime/store identity, `APP_VERSION` →
  `/app/VERSION`, non-root, and the private one-worker topology are all preserved
  untouched.** No public `JobResponse` key, lifecycle state, SSE event name, or BFF
  route changed; `solver_timeout` / `process_timeout` are purely additive; legacy
  `limit_or_stop` remains readable during retention.

### Source coverage — all 34 upstream paths

Legend: **direct** = imported verbatim; **adapted** = imported with the invariants
above; **excluded** = intentionally not applied (owner/reason noted); **mapped** =
the rebuild has no identically-named file, so the upstream behavior is represented
in a differently-organized rebuild path.

**Partly superseded by W1/W2.** This table records the T19 rebuild disposition. W1 and
W2 have since adopted most of these paths byte-identical to genie `1bf4b85`, tracked per
file in `core/upstream-patches/manifest.toml` (classes `verbatim` / `patched`). That
manifest is the source of truth: where the two disagree, the manifest wins.

| Upstream path | Disposition | Notes |
| --- | --- | --- |
| `core/nurse_scheduling/server/jobs/process_executor.py` | adapted | Spawned-child supervisor (`run_optimization_process`, `ProcessControl`, `ProcessStatus`) imported by U31a, with one rebuild adaptation: it imports `OptimizationExecutionError` and adds a child-side `except OptimizationExecutionError` branch that buffers a structured `JobFailure(code, message)` terminal frame — because the rebuild runner **raises** those expected failures rather than returning them (upstream returns `JobFailure`). This keeps the public FAILED contract without pickling the exception across the pipe. |
| `core/nurse_scheduling/server/jobs/process_tree.py` | direct | Verbatim process-tree kill/reap guard with platform fallbacks (byte-identical to upstream `d63519b`). Imported by U31a. |
| `core/nurse_scheduling/server/config.py` | adapted | Added `timeout_grace_seconds` / `OPTIMIZE_TIMEOUT_GRACE_SECONDS` (positive-finite, default 90s) to `ServerSettings` and `from_env`. |
| `core/nurse_scheduling/server/app.py` | adapted | Threads `settings.timeout_grace_seconds` into the worker/controller wiring; no other change. |
| `core/nurse_scheduling/server/jobs/runner.py` | adapted | CP-SAT-only `scheduler.schedule` bridge; classifies `solver_timeout` / `user_requested`; **retains** `OptimizationExecutionError` for `invalid_model` / `no_solution_found` rather than upstream's `JobFailure`-return refactor. |
| `core/nurse_scheduling/server/jobs/worker.py` | adapted | Runs the claimed job through `run_optimization_process` behind the lease-owning worker; arms the timeout-grace watchdog; aborts the child and writes nothing on shutdown / lease loss; keeps mandatory worker-ID + observed-deadline commit fencing. |
| `core/nurse_scheduling/server/jobs/controller.py` | adapted | Added lease-fenced `complete_cancellation(job_id, *, worker_id=…)`; retains T19 mandatory-worker-identity/observed-deadline fence and the narrow `solver_supports_stop` cancel/early-completion guard (dead for CP-SAT-only). |
| `core/nurse_scheduling/server/jobs/models.py` | adapted | Narrows `STOPPABLE_SOLVERS` to `{ortools/cp-sat}` and **retains** `solver_supports_stop`; upstream instead deleted both and moved capability lookup into `solver_capabilities.py`. |
| `core/nurse_scheduling/server/api/schemas.py` | adapted | `JobResponse` shape preserved; keeps `solver_supports_stop` from `models` for `controls.cancellable` / `early_completion_available` instead of upstream's `solver_capabilities.solver_supports_finish_now`. |
| `core/nurse_scheduling/server/api/optimize.py` | adapted | CP-SAT-only selector boundary; keeps `solver_supports_stop` for the SSE control projection; unchanged public-cursor SSE and reconcile-before-commit. |
| `core/nurse_scheduling/server/errors.py` | adapted | **Retains** `OptimizationExecutionError` (upstream removed it), because the rebuild's runner still raises it for the expected/unexpected failure split. |
| `core/nurse_scheduling/server/solver_capabilities.py` | excluded | Multi-solver capability registry (`solver_supports_finish_now`, graceful-timeout traits for CBC/SCIP/BOP/MathOpt). Not imported; the rebuild keeps its narrow `solver_supports_stop` in `models.py`. |
| `core/nurse_scheduling/solver_pulp.py` | excluded | PuLP feasibility-check change. No PuLP backend exists in the rebuild. |
| `core/tests/test_process_executor.py` | adapted | Imported as the executor/tree suite: startup guard, hard timeout, buffered-terminal priority, cancel-vs-abort, descendant cleanup, abrupt child, platform fallbacks. |
| `core/tests/real/solver_capabilities.py` | direct | Adopted byte-identical to genie `1bf4b85` by wave bead `nursing-sheduler-r6g` (manifest class `verbatim`), replacing the T19-era CP-SAT-only `core/scripts/solver_capability_probe.py`. It drives the real app (`create_app` / `TestClient` / `MemoryJobStore`) over the large 87-person scenario; run it with `--solver ortools/cp-sat` (X4). Not collected by the default suite (no `test_` prefix). Its six E402 findings are exempted per file in `core/pyproject.toml`; the file is never reformatted. |
| `core/tests/test_real_solver_capabilities.py` | direct | Adopted byte-identical to genie `1bf4b85` by wave bead `nursing-sheduler-r6g` (manifest class `verbatim`), replacing `core/tests/test_real_solver_capability_probe.py`. Always collected and fast: it never launches the solver, only the pure classification/reporting helpers over monkeypatched observations. |
| `core/tests/real/README.md` | adapted | Keeps the rebuild's real-world-check text and documents the adopted v1 probe, plus `solver_capabilities_residue.py`, which carries the retired v2 probe's Linux `/proc` process-residue audit as one separate opt-in check. |
| `core/tests/test_optimize_job_backends.py` | mapped | Target has no such file (T19 deleted the monolithic backend test); the `complete_cancellation` owner/stale assertions are represented by the rebuild's `test_server_*` worker/store suites. |
| `core/tests/test_serve.py` | excluded (mapped) | The rebuild has no monolithic `test_serve.py` (deleted at T19); upstream's new-behavior assertions are represented in the `test_server_*` suites and its multi-solver additions are not ported. |
| `core/tests/test_solver_pulp_cbc.py` | excluded | PuLP/CBC feasibility tests; no PuLP backend in the rebuild. |
| `docker/compose.backend.yml` | adapted (mapped) | The rebuild's `compose.yml` already passes the `APP_VERSION` build arg to the backend; U31e adds an **active** `OPTIMIZE_TIMEOUT_GRACE_SECONDS: ${OPTIMIZE_TIMEOUT_GRACE_SECONDS:-90}` passthrough on the backend service (default 90, behavior-neutral), while `docker/.env.example` only documents the optional override. The private one-worker topology is unchanged. |
| `docker/compose.backend.memory.yml` | adapted (mapped) | Mapped to `compose.memory.yml`, which already passes `APP_VERSION`; unchanged private topology. |
| `docker/README.md` | adapted | The rebuild's deploy runbook. U31e adds a **Supervised optimization execution** section (parent/child/guard, forced cancel, cooperative finish-now, timeout grace, lease-loss write-nothing, CP-SAT-only) and the optional grace knob. Upstream's `.app-version` / `git describe` staging text does not apply. |
| `docker/Dockerfile.api.staging` | excluded (superseded) | Upstream reworks the staging image's `.app-version` / `git describe` derivation. The rebuild has no staging image: `Dockerfile.backend` stamps `APP_VERSION` → `/app/VERSION` with no runtime Git (DL11 D2). |
| `docker/Dockerfile.api.staging.dockerignore` | excluded (superseded) | Same staging-image boundary; superseded by the rebuild's selective-copy Dockerfiles. |
| `AGENTS.md` | excluded | Upstream contributor-workflow text; repository/agent instructions already govern the rebuild. |
| `core/AGENTS.md` | excluded | Upstream module workflow file; not vendored. |
| `docs/AGENTS.md` | excluded | Upstream module workflow file; not vendored. |
| `docs/backend-server.md` | excluded | New upstream mkdocs backend page (multi-solver server narrative). The rebuild's operational docs live in `docker/README.md`; the mkdocs site is not vendored. |
| `docs/solvers.md` | excluded | Multi-solver support matrix (CBC/SCIP/BOP/MathOpt/HiGHS). Directly contradicts the rebuild's CP-SAT-only boundary; not ported. |
| `docs/mkdocs.yml` | excluded | Upstream mkdocs site config (adds the backend/solvers pages, mermaid fences). The rebuild ships no mkdocs site. |
| `README.md` | excluded | Upstream project README tweaks (RedisInsight `docker run --rm`, absolute CONTRIBUTORS link). Not part of the rebuild's runtime or deploy contract. |
| `.vscode/settings.json` | excluded | Editor config (`omlet.rootPath`); U31 out-of-scope. |
| `plans/handoffs/HANDOFF_rebuild-kickoff_2026-07-15.md` | excluded | Historical upstream handoff note; U31 out-of-scope. |

### Verification performed (U31, 2026-07-20)

From `core/`, `PYTHONPATH=.`, system Python 3.14 user-site (see the
`backend-test-invocation` note); Web from `web/` with pnpm; deploy from the repo
root. The source manifest was advanced to `d63519b` only after the rebuild source
(commits `a204889`, `0647f01`, `05b6e0d`) and these gates landed.

- `ruff check` and `ruff format --check` on `nurse_scheduling/`, `tests/`, and
  `scripts/`: clean (89 files already formatted). `python -m compileall
  nurse_scheduling`: clean.
- Full backend `pytest` with no configured Redis: **579 passed, 47 skipped**
  (the real-Redis-gated identity/lease/replay/worker-loss variants).
- Full backend `pytest` against a real Redis 8 container (`NURSE_TEST_REDIS_URL`):
  **626 passed, 0 skipped**, including the supervised-worker, lease-fence,
  cancellation-commit, and process-timeout-vs-worker-loss gates.
- Supervised CP-SAT capability gate
  (`scripts/solver_capability_probe.py --solver ortools/cp-sat`) on the
  87-person real scenario: all five rounds **PASS** — native `solver_timeout`
  (feasible artifact), forced `process_timeout`, cancellation with discarded
  output, cooperative `user_requested`, and 17 intermediate incumbents — with a
  clean post-run process-tree residue audit on each cancel/watchdog round.
  *(Superseded 2026-09-27 by bead `nursing-sheduler-r6g`: that probe was replaced
  by the genie `tests/real/solver_capabilities.py` verbatim, which runs four
  rounds through the real app; only the residue audit survives, in
  `tests/real/solver_capabilities_residue.py`.)*
- Full Web: `tsc --noEmit`, `oxlint`, `oxfmt --check` clean; Vitest **1,963
  passed, 63 skipped**; Next production build succeeded.
- `make verify-deploy` (private-base build, network segmentation, non-root,
  version equality, restart persistence, replay, worker-loss, redis-outage
  fail-closed): recorded with the U31e closure evidence.

Installed boundary versions unchanged: `pydantic 2.13.4`, `ruamel.yaml 0.19.1`,
`redis 8.x`, `fakeredis 2.x`. No new runtime dependency was introduced by the
`d63519b` refresh.

## B1 — `scheduler.py` additive `on_roster` day-state callback

Governed by the in-app roster viewer tech plan (Backend §1) and ticket B1
(`nursing-sheduler-cjr.1.1`). This is the only adaptation to the vendored solver
core outside the `server/` package.

| File | Origin | Adaptation from upstream |
| --- | --- | --- |
| `core/nurse_scheduling/scheduler.py` | adapted | Added an **optional keyword-only** `on_roster` callback alongside the existing `progress_callback` / `should_stop` / `model_build_stats_callback` seams, plus the module-private `_build_roster_payload(ctx, prettify)` that assembles its payload. |
| `core/tests/test_scheduler_on_roster.py` | net-new | Day-state, FEASIBLE, skipped-callback, return-shape, typed-axes, history/prettify coordinate, and real-scenario callback-to-container coordinate-parity coverage. |

What the adaptation does, and deliberately does not do:

- **Return arity is unchanged.** `schedule` still returns the five-value
  `(df, solution, score, status, cell_export_info)` tuple, so none of the ~25
  five-tuple call sites (`server/jobs/runner.py`, `cli.py`, the test helpers,
  `tests/test_exporter.py`, `tests/test_scheduler.py`) needed migration.
  `on_roster` is keyword-only, so every existing positional parameter keeps its
  position.
- **No model-building or solve-logic change.** The callback is invoked exactly
  once, after the final dataframe is built and while `ctx` is still alive, and
  only on the `OPTIMAL` / `FEASIBLE` path — an infeasible or no-solution run
  never fires it.
- **Payload** (index-aligned ordered records only, never id-keyed maps): ordered
  `people[{id}]` from `ctx.people.items` with the authored `number | string` id
  type preserved; expanded ordered `dates[{iso}]` from `ctx.dates.items`;
  `solvedDays[personIdx][dateIdx]` as a single-state
  `{kind: "shift", shiftId} | {kind: "off"} | {kind: "leave"}` derived from
  `ctx.shifts` / `ctx.offs` / `ctx.leaves`; and a `coordinateMap` of explicit
  1-based `peopleRows[]` / `dateColumns[]` plus `firstPeopleRow`, `leadingCols`,
  `historyCols`, and `prettify`.
- **The exclusivity constraint `offs + Σshifts + leaves == 1`** guarantees
  exactly one state per cell and makes a worked day exactly one shift, so
  `shiftId` is a scalar rather than a list. A cell that somehow resolves to a
  different number of worked shifts raises rather than silently degrading.
- **`historyCols` is computed, not read off `ctx`.** `Context` carries no
  worksheet-layout fields. `_build_roster_payload` mirrors the exporter's exact
  existing rule — 2 leading rows, 1 leading column, and history columns equal to
  the globally longest person history and only under `prettify`. `exporter.py`
  stays **untouched**; the callback-to-workbook coordinate-parity test is what
  keeps the two in step, and it fails visibly on exporter drift.

The container/artifact and the `/roster` route are B2's; B1 exercises the
handoff through a test-local container-shaped JSON roundtrip only.

## B2 — roster container artifact, `/xlsx` extract and `/roster` route

Governed by the same tech plan (Backend §§2–3) and ticket B2
(`nursing-sheduler-cjr.1.2`). Entirely inside the `server/` package: the vendored
solver core, `exporter.py`, `models.py`, both stores, the Redis Lua fence, the
controller and `api/schemas.py` are **untouched**.

| File | Origin | Adaptation from upstream |
| --- | --- | --- |
| `core/nurse_scheduling/server/roster_container.py` | net-new | Deterministic `roster-container/1` build/parse, one shared strict contract validator, the two frozen size caps, and the synthesized workbook download name/media type. |
| `core/nurse_scheduling/server/jobs/runner.py` | adapted | Passes B1's `on_roster` callback, and stores the roster container (media type `application/json`) as the job's single `StoredArtifact` instead of the raw workbook. Termination classification is unchanged. |
| `core/nurse_scheduling/server/api/optimize.py` | adapted | `GET /optimize/{id}/xlsx` now parses the container and streams the decoded workbook; net-new `GET /optimize/{id}/roster` returns the container minus `xlsx.base64`. |
| `core/tests/test_roster_container.py` | net-new | Hash parity with the exporter bytes, real-scenario coordinate parity with/without prettify, both cap boundaries, the two child-pipe proofs, and the adversarial field-by-field / cross-field contract cases on both directions. |
| `core/tests/test_roster_routes.py` | net-new | Byte-identical `/xlsx`, synthesized header safety, `/roster` projection, 404/409 surfaces, unreadable-container 500 on both routes, and the rejected-output no-commit proofs. |
| `core/tests/test_runner_termination.py` | adapted | The scheduler stub now drives `on_roster`, and the artifact assertions moved to the container; adds handoff-missing and cap regressions. |

What the adaptation does, and deliberately does not do:

- **The container is assembled from the callback payload verbatim.** Ordered
  index-aligned `people` / `dates`, the immutable complete single-state
  `solvedDays` grid, and the explicit 1-based `coordinateMap` are copied from
  B1's handoff. B2 never reparses the canonical scenario and never re-derives
  exporter coordinates. There are no id-keyed maps anywhere in the document.
- **Encoding is deterministic:** UTF-8 JSON with sorted object keys, no
  insignificant whitespace, `allow_nan=False`, and array order preserved, so the
  same logical container always produces the same bytes.
- **One shared strict validator governs both directions** (added by fixup
  `nursing-sheduler-cjr.1.2.1` after the B2 cold review found the parser accepted
  malformed documents). It requires the exact frozen field set at every level and
  enforces the realistic cross-field invariants: finite typed scalar person/shift
  ids (number or string, never boolean), `YYYY-MM-DD` calendar dates, a
  rectangular `solvedDays` grid whose cardinality matches `people` × `dates`,
  exact day-state unions (a worked day carries exactly one scalar `shiftId`),
  strictly increasing positive 1-based axes matching the people/date counts and
  anchored on `firstPeopleRow` and `leadingCols + historyCols + 1`, `historyCols`
  zero unless `prettify`, a finite numeric `score`, a solved-run `solverStatus`
  (`OPTIMAL` or `FEASIBLE`), and exact workbook metadata with strictly decodable
  base64. Reads additionally reject Python's non-standard `NaN` / `Infinity` JSON
  extensions via `parse_constant`. The explicit B1 axis arrays remain the
  authority: the validator checks their declared types, cardinality, and internal
  consistency, and still never reparses the scenario or reconstructs exporter
  geometry. Because the payload is validated at parse time, `/xlsx` and `/roster`
  fail together on a corrupt artifact — neither serves half of one.
- **Frozen v1 size caps, no new config surface.** `MAX_RAW_XLSX_BYTES`
  (33,554,432) is checked on the exported workbook before base64 and
  `MAX_ROSTER_CONTAINER_BYTES` (50,331,648) on the final encoded document before
  `RunOutput` is constructed. Both fail with the stable terminal code
  `roster_output_too_large`, so oversized output never crosses the child result
  pipe and no artifact is committed. The limits are injectable arguments for
  boundary tests only; production always uses the module constants.
- **`/xlsx` output is byte-identical**, proved by base64/SHA-256 parity against
  the exporter's own bytes. The `Content-Disposition` filename and the media
  type are **synthesized** — path segments, quotes, and control characters are
  stripped from the stored name, and any media type other than the workbook one
  is replaced rather than echoed.
- **`/roster` is reached by URL convention.** `JobResponse.links` gains no
  roster field, so `api/schemas.py` stays verbatim relative to its T19 state.
- **New stable codes.** Three terminal job-failure codes are raised through the
  existing `OptimizationExecutionError` path, all before `RunOutput` exists, so
  none of them can cross the child result pipe or reach a store commit:
  `roster_output_too_large` (either size cap), `roster_handoff_missing` (a
  schedule produced without exactly one callback handoff), and
  `roster_output_invalid` (the assembled container fails the shared contract — an
  internal handoff regression). On the read side, `roster_container_invalid` is a
  `ServerApplicationError` for an unreadable stored artifact, which the existing
  app handler maps to 500. `errors.py` is unchanged — the new application error
  subclasses `ServerApplicationError` inside the net-new module.
- **Ordering is deliberate:** the raw size cap is checked first, then the
  contract, then the encoded size cap. An oversized workbook is reported as too
  large even when its handoff is also malformed.
- **The stored artifact name changed** from `nurse-scheduling-<ts>.xlsx` to
  `nurse-scheduling-<ts>.roster.json`, because the stored bytes are now the
  container. The workbook's real name and MIME live inside `xlsx.name` /
  `xlsx.mime` and drive the download header. `links.schedule` is name-independent.
