# v1 test and test-data gap report

Date: 2026-09-25. Read-only investigation. Question: are there test cases or test data in
v1 upstream (`feature/genie`, `1bf4b85`) that v2 did not bring over?

- v1 upstream: `/home/kenan/work/nurse-scheduling`, branch `feature/genie`, `1bf4b85`.
- v2 baseline: this worktree (`feature/update-main`, `afc25cf`), which carries the v2 `core/`.
- v1 `core/` maps to v2 `core/`. v1 `web-frontend/` is a different app from v2 `web/`
  (a rebuild), so web tests are compared by behaviour, not by path.
- W1 plan read: `docs/superpowers/plans/2026-09-25-v1-sync-w1-solver-core.md` (51 files listed).
- Lane reports read: `00-summary.md` and `01` to `07`.

## 1. Summary

v1 `feature/genie` has **541** files under `core/tests/`. v2 has **417**. **365** paths are shared.
Test data is effectively synced: **334** of the **335** v1 `tests/testcases/**` files are
byte-identical in v2 (all of `artificial/ortools/**` and `basics/**`), and the one missing file is
already scheduled in W1.

Counts per class, for the **176** v1 test files that are absent from v2, plus the **17** shared files
whose contents differ:

| Class | Count | Notes |
| --- | --- | --- |
| present-identical | 348 | 334 `testcases/**` + 14 test/support files |
| present-differs | 17 | 14 are planned-W1; 3 are v2-server-owned |
| missing-planned-W1 | 17 | 14 multi-solver tests + 2 real-scenario helpers + 1 assignment JSON |
| missing-intentionally-excluded | 152 | 150 AI (X5) + `test_frontend_validation.py` (X5) + `test_usage_metrics.py` (X6) |
| missing-intentionally-replaced (restore in W6, per X3) | 2 | `test_serve.py`, `test_optimize_job_backends.py` (lane 07 D18) |
| missing-planned-W2 | 1 | `test_retry.py` (spec W2 step 1) |
| missing-covered-by-v2-equivalent | 2 | `test_real_solver_capabilities.py`, `real/solver_capabilities.py` (lane 07 D03) |
| missing-deferred, unplanned | 2 | `test_performance_benchmark.py`, `real/performance_benchmark.py` (lane 05 D5) |
| **missing-gap (new, unplanned)** | **0** | none found beyond the items above |
| total absent from v2 | 176 | |

**Answer: no unplanned test gap in `core/`. Every v1 test file that v2 lacks is either already
scheduled (W1/W2), or deliberately excluded, or replaced by a v2 equivalent. The material risk is in
four places where the item is scheduled but the plan is thin, and in three web defects whose v2
tests assert the wrong behaviour.**

Top risks:

1. **The 14 multi-solver tests are planned-W1 but cannot run until W0 lands.** W0 must create
   `core/requirements-optional.txt` and install `glpsol`; neither exists in this worktree
   (`ls core/requirements-optional.txt` -> absent). `pulp`, `highspy`, `pyscipopt` and `glpsol` are
   the runtime needs. Without W0, the W1 tip fails on these files.
2. **`tests/test_serve.py` (2,583 lines) and `tests/test_optimize_job_backends.py` (1,054 lines)
   have no direct v2 equivalent.** v2 replaced them with 11 parametrised `test_server_*` suites
   (lane 07 D18). They also hold the only tests for `auth.py`, `request_limits.py` and
   `solver_options.py` (lane 03). Spec decision X3 adopts the v1 lease registry in W6, so the W6
   plan must restore both files and retire the v2 suites that test the replaced fence.
3. **`tests/test_retry.py` is planned-W2, not W1.** v1 `server/retry.py` has a `RepeatedFailure`
   class and `DEFAULT_OUTAGE_MAX_DELAY_SECONDS`; v2 `server/retry.py` has neither (verified by
   comparing both files). Nothing tests the outage-backoff behaviour in v2 today.
4. **Three v2 web defects have v2 tests that assert the defect.** v1 fixed each and has tests for the
   fixed behaviour: history truncation on shift-type delete (`personHistory.test.ts`),
   nested-group coefficient eligibility (`countShiftTypeCoefficients.test.ts`), and the Singapore
   holiday year range (`useSingaporeHolidays.test.ts`, `singaporeHolidays.test.ts`). Beads
   B-F13/B-F14/B-F18 already cover them.
5. **The 87-person example YAML is not shipped to the browser in v2.** The file is byte-identical in
   v2 `core/tests/testcases/real/` (sha `8ec166c`), but v2 `web/public/` has no `examples/` dir, so
   the v1 Home "Example" flow has no data and no test. Bead B-F07.

## 2. Gaps and diverged files

### 2a. present-differs (17)

The 14 rows marked **W1** are in the W1 51-file list and will be replaced by the genie copy. The
three rows marked **keep** are not in W1 and should not be: their v2 versions are newer and adapted
to the v2 server, so replacing them with the v1 copy would break against v2's server design.

| v1 path | v1 lines | v2 lines | What it tests | On v2 as-is | Action |
| --- | --- | --- | --- | --- | --- |
| `tests/export_test_helper.py` | 210 | 205 | export fixture helpers | needs W1 | W1 |
| `tests/schedule_test_helper.py` | 162 | 158 | solver `solver=` arg helper | needs W1 | W1 |
| `tests/real/schedule_real_helper.py` | 126 | 126 | real-scenario wrapper | needs W1 | W1 |
| `tests/test_cli.py` | 381 | 367 | CLI, `--solver`, model-build stats | needs W1 | W1 |
| `tests/test_exporter.py` | 1039 | 1013 | XLSX/CSV export | needs W1 | W1 |
| `tests/test_export_xlsx_ortools_cp_sat.py` | 28 | 28 | XLSX CP-SAT golden | needs W1 | W1 |
| `tests/test_hours_contract_validation.py` | 364 | 370 | hoursContract rules | needs W1 | W1 |
| `tests/test_loader.py` | 228 | 123 | YAML load + validation | needs W1 | W1 |
| `tests/test_models_validation.py` | 328 | 156 | model validation | needs W1 | W1 |
| `tests/test_preference_validation.py` | 873 | 902 | preference rules | needs W1 | W1 |
| `tests/test_scheduler.py` | 749 | 663 | scheduler selection + scoring | needs W1 | W1 |
| `tests/test_solver_interface.py` | 103 | 87 | solver interface | needs W1 | W1 |
| `tests/test_utils.py` | 74 | 74 | utils (2 lines differ) | needs W1 | W1 |
| `tests/test_schedule_ortools_cp_sat.py` | 24 | 24 | CP-SAT schedule golden | needs W1 | W1 |
| `tests/test_process_executor.py` | 572 | 852 | process supervision; v2 grew it for the fence design | passes (v2 copy) | keep (W2 area) |
| `tests/test_public_diagnostic.py` | 1166 | 1427 | public diagnostic workflow; v2 grew it (D10/D15/D18) | passes (v2 copy) | keep (W2 area) |
| `tests/real/README.md` | 177 | 51 | real-check docs | passes | keep; v1 text documents the excluded probe and benchmark |

Note on `tests/real/README.md`: v1 documents the capability probe and the Docker performance
benchmark (both excluded). v2 adapted it to point at `core/scripts/README.md`. Neither version
documents `schedule_score_ground_truth.py`, which W1 brings. After W1 the file is stale but correct.
Low risk; a one-line W1 amendment would close it.

### 2b. missing-planned-W1 (17)

These are absent from v2 and in the W1 51-file list. The 14 multi-solver tests are absent because
v2 removed the multi-solver library at T01 (lane 07 D01); W1 restores the library, so they belong
with it.

| v1 path | What it tests | Needs |
| --- | --- | --- |
| `tests/test_schedule_ortools_mathopt_cp_sat.py` | MathOpt CP-SAT schedule | W0 (mathopt is in `ortools`) |
| `tests/test_schedule_ortools_mathopt_gscip.py` | MathOpt SCIP | W0 + `pyscipopt` |
| `tests/test_schedule_ortools_mathopt_highs.py` | MathOpt HiGHS | W0 + `highspy` |
| `tests/test_schedule_ortools_mpsolver_bop.py` | MPSolver BOP | W0 |
| `tests/test_schedule_ortools_mpsolver_cbc.py` | MPSolver CBC | W0 |
| `tests/test_schedule_ortools_mpsolver_cp_sat.py` | MPSolver CP-SAT | W0 |
| `tests/test_schedule_ortools_mpsolver_scip.py` | MPSolver SCIP | W0 |
| `tests/test_schedule_pulp_glpk.py` | PuLP GLPK schedule | W0 + `pulp` + `glpsol` on PATH |
| `tests/test_schedule_pulp_highs.py` | PuLP HiGHS schedule | W0 + `pulp` + `highspy` |
| `tests/test_schedule_pulp_scip.py` | PuLP SCIP schedule | W0 + `pulp` + `pyscipopt` |
| `tests/test_solver_ortools_linear.py` | OR-Tools linear solver unit | W0 |
| `tests/test_solver_ortools_mathopt.py` | MathOpt solver unit | W0 |
| `tests/test_solver_pulp_glpk.py` | PuLP GLPK solver unit | W0 + `glpsol` |
| `tests/test_solver_pulp_python.py` | PuLP Python solver unit | W0 + `pulp` |
| `tests/real/assignment_fixture.py` | forced-assignment replay fixture | W1 |
| `tests/real/schedule_score_ground_truth.py` | score ground-truth replay | W1 |
| `tests/testcases/real/large-ward-with-87-people-2025-11.assignment-01.json` | forced-assignment data for the 87-person case | W1 |

### 2c. missing-intentionally-excluded (152)

| v1 path | Count | Decision | Evidence |
| --- | --- | --- | --- |
| `tests/ai_eval/**` | 120 | X5 (v1 Python AI service not adopted) | spec line 151; lane 04 D1/D5; lane 05 D2 |
| `tests/test_ai_*.py` + `tests/ai_test_helper.py` | 30 | X5 | spec line 151; lane 04 D1 |
| `tests/test_frontend_validation.py` | 1 | X5 | spec line 151 ("not adopted in W2: `frontend_validation.py` (X5)"); lane 01 C05/D5 |
| `tests/test_usage_metrics.py` | 1 | X6 (usage telemetry not adopted) | spec line 151; lane 05 D3 |

The AI exclusion is 150 files and about 15,900 lines of tests. Lane 04 D5 and the summary (X5)
recommend reusing the 109 `ai_eval/cases/basics/**` JSON cases as a prompt corpus for the v2
assistant evals; v2 already has `web/evals/cases`. The genie `ai_eval/fixtures/singapore-holidays.json`
is referenced only by `ai_eval/runner.py` and `skills/sync-upstream/SKILL.md`, so it is not needed
outside the AI package (checked with `git grep`).

### 2d. missing-covered-by-v2-equivalent (2)

| v1 path | v2 equivalent | Evidence |
| --- | --- | --- |
| `tests/real/solver_capabilities.py`, `tests/test_real_solver_capabilities.py` | `core/scripts/solver_capability_probe.py` (+ `core/scripts/README.md`, `core/scripts/__init__.py`) and `core/tests/test_real_solver_capability_probe.py` | lane 07 D03; lane 05 L5-18. v2 moved the probe under `scripts/` so pytest never collects the slow real rounds. Decision 2026-09-25: take the v1 probe verbatim in W1, run it with `--solver ortools/cp-sat`, and keep the v2 process-residue check as a separate test (bead `nursing-sheduler-r6g`). |

### 2e. missing-intentionally-replaced, restore in W6 (2)

| v1 path | v1 lines | v2 replacement | Evidence |
| --- | --- | --- | --- |
| `tests/test_serve.py` | 2583 | 11 parametrised suites: `conftest.py`, `server_support.py`, `test_server_api.py`, `test_server_backend_parity.py`, `test_server_controller_retry.py`, `test_server_identity.py`, `test_server_lifecycle_gates.py`, `test_server_priority_queue.py`, `test_server_replay.py`, `test_server_scheduling_input.py`, `test_server_store_contract.py`, `test_server_worker_loss*.py`, `test_runner_termination.py`, `test_runner_inconclusive.py` | lane 07 D18; lane 05 L5-12/L5-13 |
| `tests/test_optimize_job_backends.py` | 1054 | `tests/test_server_store_contract.py` (memory + fakeredis + real Redis contract) | lane 07 D18; lane 05 L5-12 |

v2 deleted both and rebuilt the server test surface for the T19 fence (lane 07 D18). Lane 07 D18's
action is conditional: "If Q2 takes the v1 lease model, restore `test_serve.py` and
`test_optimize_job_backends.py` and delete the v2 suites that test the replaced fence. Otherwise
keep and map by hand." Spec decision X3 settled Q2: W6 takes the v1 lease model, so W6 restores both files. These two files also carry the only tests for `auth.py`, `request_limits.py`
and `solver_options.py` (lane 03), which W2 step 3 and step 5 wire up; the new coverage will need to
land with those steps. Effort L, risk Medium.

### 2f. missing-planned-W2 (1)

| v1 path | v1 lines | What it tests | Evidence |
| --- | --- | --- | --- |
| `tests/test_retry.py` | 111 | `server.retry.RepeatedFailure` and `server.maintenance.JobMaintenance` outage backoff | spec W2 step 1: "`retry.py` `RepeatedFailure` verbatim, with `test_retry.py`"; summary safe-first-step 3; lane 05 L5-14 |

Verified absent today: v2 `core/nurse_scheduling/server/retry.py` has only `retry_with_backoff` and no
`RepeatedFailure`, and `grep -rn RepeatedFailure core/` returns nothing. So this test cannot pass
against v2 core as-is; it needs W2 step 1.

### 2g. missing-deferred, unplanned (2)

| v1 path | What it tests | Evidence |
| --- | --- | --- |
| `tests/test_performance_benchmark.py` | opt-in Docker performance benchmark harness | lane 05 D5: "Adopt only the ground-truth score replay. Defer the benchmark."; lane 05 L5-16 |
| `tests/real/performance_benchmark.py` | the benchmark driver | same |

These are deferred by decision D5, not scheduled anywhere. If the benchmark is adopted later, the
paired ground-truth replay (planned-W1) already comes first. Low risk.

### 2h. Test data outside `core/tests`

| v1 data | v2 status | Action |
| --- | --- | --- |
| `web-frontend/public/examples/large-ward-with-87-people-2025-11.yaml` | Byte-identical file exists at `core/tests/testcases/real/large-ward-with-87-people-2025-11.yaml` (all three shas are `8ec166c`), but v2 `web/public/` has no `examples/` dir | Bead B-F07 port the file into the v2 web example flow |
| `prototype/leave_daystate_160h.yaml` | Byte-identical in v2 `prototype/` (sha `b8e45ac`) | none |
| `prototype/hours_via_coefficients.yaml` | Absent from v2 `prototype/` (which has only `leave_daystate_160h.yaml`) | low value: a spike input. No test depends on it. Skip |
| `docs/` sample inputs | v1 `docs/` has no `.yaml/.json/.csv/.xlsx` files | none |

Note: W1 modifies two v2-origin data files, `core/tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml`
and `ward-8-shift-patterns-senior-on-every-shift.yaml`, to drop `country: SG`. Those two files are
v2-only (v1 `feature/genie` has neither); they are not gaps.

### 2i. Web tests (behaviour comparison, not path)

v1 `web-frontend/` has 111 Playwright specs and 76 unit tests. v2 `web/` has 426 test files
(40 Playwright specs, the rest Vitest). Path comparison is invalid because v2 is a rebuild. The
only behaviour-level coverage gaps whose feature v2 **has** are the three known defects, where the
v2 test asserts the defect:

| v1 test | v2 test that asserts the defect | Defect | Action |
| --- | --- | --- | --- |
| `web-frontend/src/utils/personHistory.test.ts` | `web/lib/cascade/cascade.test.ts:200-202` — `expect(after.staff[0].history).toEqual(["", "D"])` | v2 `lib/cascade/delete.ts:102-106` blanks deleted shift-type ids to `""`; v1 keeps the valid right-anchored suffix (`personHistory.ts`) | bead B-F13 (W3) |
| `web-frontend/src/utils/countShiftTypeCoefficients.test.ts` | `web/components/card-editor/coefficient-fields.test.ts` | v2 `coefficient-model.ts` expands a group one level only; v1 recurses with a cycle guard | bead B-F14 (W3) |
| `web-frontend/src/utils/useSingaporeHolidays.test.ts`, `singaporeHolidays.test.ts` | `web/lib/dates/holidays-sg.test.ts` | v2 `holidays-sg.ts` range ends at the last listed holiday; v1 extends to whole calendar years | bead B-F18 (W3) |

Other v1 web tests map onto v2 features that already have v2 tests (for example
`contractedHours*.test.ts` -> `components/counts/contracted-model.test.ts`,
`restorePeopleIdsInXlsx.test.ts` -> `lib/optimize/restore-people-ids-in-xlsx.test.ts`,
`anonymizeSchedulingState.test.ts` -> `lib/scenario/anonymize.test.ts`,
`shiftWorkingTime.test.ts` -> `components/entity-editor/core/working-time.test.ts`). v1
`web-frontend/e2e/experimental-ai-*.spec.ts` are X5-excluded. No additional behaviour-level gap was
found.

## 3. Coverage note

Commands used (read-only; nothing checked out or modified):

- `git -C /home/kenan/work/nurse-scheduling ls-tree -r --name-only 1bf4b85 core/tests` — v1 file list.
- `find <v2>/core/tests -type f` — v2 file list. Both normalised by stripping the leading `core/`.
- `comm -23`, `comm -13`, `comm -12` on the two sorted lists — absent, v2-only, shared.
- `git -C <v1> rev-parse 1bf4b85:core/<path>` versus `git -C <v2> hash-object core/<path>` for every
  shared path — byte-identity check (348 identical, 17 differ).
- `git -C <v1> show 1bf4b85:core/<path>` and `diff` against the v2 file — present-differs detail
  (line counts and changed-line counts).
- `git -C <v1> ls-tree -r --name-only 1bf4b85` filtered for `examples/`, `prototype/`, `docs/`,
  `web-frontend/**`, and data extensions, plus `git -C <v1> grep -ln` for `frontend_validation` and
  `singapore-holidays.json`.
- `find <v2>/web` for `*.test.ts(x)` and `e2e/*.spec.ts`; `find <v2> -iname '*large-ward*'`.
- Plan and spec evidence: `docs/superpowers/plans/2026-09-25-v1-sync-w1-solver-core.md` (51-file
  list extracted from the Step 3 heredoc), `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md`
  (W2 scope and X5/X6), and lane reports `00`, `01`, `03`, `04`, `05`, `06`, `07`.

No test was executed. v2 `core/requirements-optional.txt` is absent, so W0 has not landed; the
W1 multi-solver tests cannot run in this worktree until it does.
