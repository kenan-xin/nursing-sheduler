# Spike W1: genie solver core reset (throwaway)

Date: 2026-09-25. Spike branch: `kenan-xin/spike-w1-genie-core` (from `develop` at `970c956`), last commit `da06553`. Upstream target: v1 `feature/genie` at `1bf4b85`.

## 1. Summary

W1 works as the spec describes. After the verbatim take, P1 to P4 and the caller changes, the full core suite passes: 1201 passed, 69 skipped, 0 failed. The v2 baseline was 1001 passed, 69 skipped.

- P1 to P4 apply as described. The total patch size is 166 lines added and 3 removed, in 3 genie files. Reverse-applying the 3 patch files gives the exact genie blob SHAs for `models.py`, `preference_types.py` and `scheduler.py`.
- INCONCLUSIVE is now reachable with the real scheduler. A 0.01 s timeout and a 1 s timeout (the product minimum) on the 87-person case both end INCONCLUSIVE with `solver_timeout_no_solution`. On v2 today the same call raises `ValueError: No solution found! Status: UNKNOWN`, so the job ends FAILED.
- The real 87-person smoke test passes (139 s). The 2 SG real cases pass inside the normal suite.
- The genie score ground-truth replay fails upstream, at `1bf4b85` itself. The fixture hashes an older YAML. With the hash guard bypassed, the replay is OPTIMAL and matches the expected score 4477324836724 exactly.
- Ruff 0.15.22: `ruff check` passes and `ruff format --check` passes (133 files).
- Web: `vitest run` gives 7473 passed and 1 flaky UI failure that passes when run alone. The gated differential suite gives 66 passed and 3 failed, and the same 3 fail on unchanged `develop`.
- The C5 goldens do not change in content. Only the `docProps/core.xml` timestamps differ.
- "One branch, 5 commits" is realistic in size. But commits 1 to 4 each leave the core suite red, because the genie model rejects `country`, which commit 5 removes.

## 2. Measurements

| Claim from the spec | What I did | Result | Verdict |
| --- | --- | --- | --- |
| Take the 14 listed modules and the 5 restored solver modules verbatim | Copied the 19 files from the `1bf4b85` archive | 19 files. `core/nurse_scheduling` changes by +3054/-890 lines against `develop` (patches included) | confirmed |
| Take the matching genie tests, the fixture and the replay | Took 22 shared core test files, 14 new solver-backend test files, `tests/real/assignment_fixture.py`, `schedule_score_ground_truth.py`, `schedule_real_helper.py` and `...assignment-01.json`. Kept the v2 server tests and `tests/real/README.md` | The genie tests all pass. The new solver tests run and do not skip, because the venv has `pulp==3.3.2`, `highspy==1.12.0` and `pyscipopt==6.2.1` | confirmed |
| The verbatim take alone breaks the v2 skill-mix, override and `on_roster` tests | Ran the full suite after commit 1 | 50 failed, 22 errors, 1126 passed. Failures: `test_skill_mix` 12, `test_requirement_overrides` 12, `test_scheduler_on_roster` 10, `test_assistant_repair_fixtures` 9, `test_roster_container` 3, `test_server_scheduling_input` 3, `test_server_api` 1. Errors: `test_ward_shift_patterns_roster` 12, `test_sg_compliance_roster` 7, `test_roster_routes` 3 | confirmed, and the list is longer than the spec says (see section 3) |
| P1 `Person.temporary`: one `StrictBool` field | Added the field and the `StrictBool` import | +5/-1, `models.py` only | confirmed |
| P2 skillMix and P3 overrides on `CompiledShiftTypeRequirements` | Added `skill_mix` and `required_by_date` to the dataclass, resolved them in the compile step, and read them in the handler | +96/-2 in `models.py` (+78/0) and `preference_types.py` (+18/-2). 100 of 100 targeted tests pass (`test_skill_mix`, `test_requirement_overrides`, `test_assistant_repair_fixtures`, `test_server_scheduling_input`) | confirmed |
| P3: an override outside the requirement dates fails at load time | Probed `canonicalize_submission` | Spike: 422 `invalid_scheduling_data`. v2 `develop`: accepted at submit, fails later in the solve | confirmed |
| P2: unknown skillMix people fail at load time | Same probe | Spike: 422 "Unknown person ID: carol". v2 `develop`: accepted at submit | confirmed |
| P4 `on_roster` reads `ctx.scenario` and `ctx.compiled_schedule`, keyword-only after `forced_solution` | Moved `_build_roster_payload` and changed 4 reads | +65/0, `scheduler.py` only. All 10 `test_scheduler_on_roster` tests pass once `country` is gone | confirmed |
| Total patch set | Measured with `git diff --numstat` | 166 added, 3 removed, in `models.py`, `preference_types.py`, `scheduler.py` | measured |
| Patches can be reverse-applied to prove "genie plus patches" (W1 acceptance 1) | `git apply -R` P4, then P2-P3, then P1, then `git hash-object` | All 3 files equal the genie blobs (`models.py` `edcdab15`, `preference_types.py` `51f7cb35`, `scheduler.py` `7867e7d1`). The order matters: reverse the newest patch first | confirmed |
| `workspace.py` gets a public map function and `group_map.py` stays equal to genie | Added `build_shift_type_index_map` to `server/workspace.py` | +28/-2 in `workspace.py`. `group_map.py` is verbatim | confirmed |
| The oracle imports the function from `workspace.py` | Changed 3 lines in `oracle.py` | +3/-2 | confirmed |
| "This oracle runs in the web unit tests, so W1 breaks web CI without this change" | Read the gate and CI | The differential suite runs only with `RUN_DIFFERENTIAL=1` (`web/lib/scenario/differential/oracle-client.ts:41`). `.github/workflows/ci.yml` runs `pnpm test` without it (line 68). Web CI does not break. Only the gated suite breaks | wrong |
| The oracle must drop `country` before it calls `schedule` | Ran the gated differential suite with no `country` code in the oracle | 66 passed, 3 failed. The same 3 fail on `develop` (`workspace-differential.test.ts`, "full authoring state hydrates through the real load path"). No oracle input carries `country` | not needed |
| `country`: accept and drop in `workspace.py`, stop emitting it in `canonical.ts`, remove it from the 2 SG test cases | Did all 3 | `workspace.py` +3/-1, `canonical.ts` -1, 2 YAML lines removed. The spec misses `web/lib/scenario/canonical.test.ts:93`, which asserts `doc.country` is `"SG"` | partly (misses 1 web test) |
| Wire `measure_yaml_expansion` in `server/scheduling_input.py`: 400 with code `scheduling_data_too_complex` | Called it in `_parse_once` before the load. Added the code to `CODE_TO_KIND` | `scheduling_input.py` +13. A 9-wide, 8-deep alias bomb returns 400 with `error.code` = `scheduling_data_too_complex` (spike test). The spec misses 2 facts: `api/optimize.py` must change too (+13/-1), and the call must sit outside the existing `ValueError` handler | partly (see section 3) |
| Bump `SOLVER_SEMANTIC_VERSION` and update the web fixtures that pin it | Changed `ortools/cp-sat@1` to `@2` | 1 test fails: `core/tests/test_job_response_contract.py`, because `contracts/job-response.golden.json` pins the value. Regenerating it changes 80 lines (IDs, times and `basis_id` also change). 13 web test files contain `cp-sat@1`, but they are free mock values and all pass unchanged. `contracts/optimize-basis-v2.golden.json` (35 hits) is a set of encoder vectors and passes unchanged | partly (the spec points at web fixtures, the real pin is a core contract golden) |
| Full core suite passes after the patches | `PYTHONPATH=. python -m pytest -q` (memory and fakeredis, no real Redis) | 1201 passed, 69 skipped, 0 failed, 90 s | confirmed |
| All real test cases pass | `tests/real/schedule_ortools_cp_sat.py`, plus the 2 SG cases through `test_sg_compliance_roster.py` and `test_ward_shift_patterns_roster.py` | 87-person smoke: 1 passed in 139 s (baseline 148 s). SG cases: 19 of 19 pass | confirmed |
| The genie score ground-truth replay passes | `tests/real/schedule_score_ground_truth.py` | FAILED: "Assignment fixture does not match the scenario content." With the hash guard bypassed: OPTIMAL, score 4477324836724 equals the expected score, solution equal | wrong as written (upstream fixture bug), scores are preserved |
| Ruff with the v2 pin | `ruff check .` and `ruff format --check .` with ruff 0.15.22 | Both pass, 133 files | confirmed |
| Web unit tests pass, including the oracle | `PYTHON=<venv> vitest run`, then `RUN_DIFFERENTIAL=1 vitest run lib/scenario/differential` | 375 files and 7473 tests pass. 1 failure (`roster-screen.test.tsx` empty state) passes 3 of 3 when run alone. Differential: 66 passed, 3 failed, same as `develop` | confirmed (no W1 regressions) |
| Rerun the C5 generator and commit the goldens that change | Ran `generate-c5-goldens.py` against the spike core and against `develop` core | Spike: runs. `develop`: crashes with `AttributeError: 'tuple' object has no attribute 'dataframe'`. All 4 workbooks are semantically equal to the committed ones (`xlsx-semantic-diff.py` gives no diffs). The only byte change is the timestamp in `docProps/core.xml`. `manifest.json` is equal except for JSON formatting | wrong premise: nothing changes |
| A timeout with no incumbent becomes INCONCLUSIVE (W1 acceptance 3) | Spike test: `OptimizationRunner().run(...)` on canonical bytes of the 87-person case | 0.01 s: INCONCLUSIVE, `solver_timeout_no_solution`, 1.2 s total. 1 s: INCONCLUSIVE, 1.9 s total. `develop`: `ValueError`, so FAILED | confirmed |
| Callers the spec does not list | Grep of every `nurse_scheduling` import in `server/`, `scripts/`, `web/` and the test run | 4 files: `api/optimize.py`, `contracts/job-response.golden.json`, `web/lib/scenario/canonical.test.ts`, the replay fixture. `core/scripts/solver_capability_probe.py` and `server/jobs/runner.py` still work (the `ScheduleResult` NamedTuple unpacks as a 5-tuple) | measured |
| One branch, 5 commits | Made the 5 commits in the spec order | The sizes are small (see section 3). Commits 1 to 4 are red: after commit 1, 50 failed and 22 errors. After commit 4, 7 failed and 22 errors, all from `country` | partly |

## 3. Surprises and blockers

1. The genie replay is broken upstream. Genie commit `96e9ba9` (2026-07-08) renamed the date group `FREEDAY` to `NON-WORKDAY` in `large-ward-with-87-people-2025-11.yaml` (12 changed lines). Dev commit `aee23bc` (2026-08-29) captured the fixture against the dev YAML, which has `scenarioSha256` `296dc6e6...`. Merge `1b6f7e5` kept the genie YAML (`0db947b0...`) and the dev fixture. `deserialize_assignment_fixture` rejects the hash mismatch before it solves (`tests/real/assignment_fixture.py:91-92`). Lane 01 said the rename does not affect the fixture. That is true for the assignments, but not for the hash guard. The fix is one field: set `scenarioSha256` to `0db947b0e16d77f9eed62fc83c3b8635ccfc0e5bedba0fc42fd9797355ce06dc`.
2. Every intermediate commit is red. Genie `NurseSchedulingData` forbids extra keys, and 2 real test cases carry `country: SG`. So 22 roster tests error and 7 roster tests fail until commit 5. This hides whether commits 2 to 4 are correct. If the `country` change moves into commit 1, commit 1 fails only the V2-ONLY feature tests, and each later commit turns its own tests green.
3. The coded 400 is a v2 design, not upstream. Genie `api/optimize.py:158-164` returns `HTTPException(400, detail=str(error))` with no code. The v2 400 path also returns only `detail` (`api/optimize.py:166-167`). To return `{"error": {"code": "scheduling_data_too_complex"}}`, `api/optimize.py` must change. I used a direct `JSONResponse` (+13/-1).
4. There is a trap in `_parse_once`. `SchedulingDataTooComplexError` is a subclass of `ValueError`. The existing handler turns `YAMLError` and `ValueError` into `MalformedInputError`. If you call `measure_yaml_expansion` inside that `try`, the bomb becomes a plain 400 with no code.
5. The submit path never calls `load_data`. The strict path calls `NurseSchedulingData(**parsed)` directly (`scheduling_input.py:99`). So the genie loader bound does not protect the submit path by itself, and the explicit call is required. The worker path does call `load_data`, through `scheduler.schedule`.
6. The new load-time 422 issues lose their location. Unknown person, unknown skillMix person and a bad override date all return one issue with `path: []` and code `strict_contract_violation`. The message names the ID but not the preference index. On `develop` these inputs were accepted at submit.
7. The C5 generator never ran against v2 `core/`. It uses `result.dataframe` (the v1 `ScheduleResult`), and its header says to run it from the v1 repo. W1 makes it runnable against v2 `core/` for the first time. Rerunning it only changes timestamps, so committing the output adds noise and no information.
8. The semantic version pin is in a core contract golden, not in web fixtures. Regenerating `contracts/job-response.golden.json` with `UPDATE_JOB_RESPONSE_CONTRACT=1` rewrites 80 lines, because job IDs, times, input names and `basis_id` are captured live.
9. The gated differential suite already has 3 failures on `develop`. CI does not run it, so it is not a guard for W1 unless someone fixes it first.
10. A small inconsistency in the restored backends: `solver_ortools_mathopt.py` has no `add_bool_or`. The P2 empty-group path calls `ctx.solver.add_bool_or([])`. This is harmless while the product stays CP-SAT only, but a skillMix scenario with an empty group would crash on MathOpt.

## 4. Recommended spec edits

Section 3, W1, "Take verbatim", third bullet. Add: "The genie fixture `large-ward-with-87-people-2025-11.assignment-01.json` has a stale `scenarioSha256` at `1bf4b85` (genie `96e9ba9` renamed `FREEDAY`, merge `1b6f7e5` kept the dev fixture). Re-stamp it to `0db947b0e16d77f9eed62fc83c3b8635ccfc0e5bedba0fc42fd9797355ce06dc` as a recorded patch, and report the bug upstream. The score is unchanged (4477324836724)."

Section 3, W1, "Adapt the callers", oracle bullet. Replace with: "`web/lib/scenario/differential/oracle.py`: import the function from `workspace.py`. No `country` change is needed. The differential suite is gated on `RUN_DIFFERENTIAL=1` and CI does not set it, so run it by hand. It already has 3 failures on `develop` in `workspace-differential.test.ts`."

Section 3, W1, "Adapt the callers", C5 bullet. Replace with: "`generate-c5-goldens.py`: after W1 it runs against v2 `core/` (before W1 it crashes on the 5-tuple). Run it once and compare with `xlsx-semantic-diff.py`. Do not commit the output if only `docProps/core.xml` timestamps change."

Section 3, W1, "Adapt the callers", YAML bound bullet. Replace with: "`server/scheduling_input.py`: call `loader.measure_yaml_expansion` in `_parse_once`, before the load and outside the `ValueError` handler, because `SchedulingDataTooComplexError` is a `ValueError`. `server/api/optimize.py`: map the error to 400 with `{error: {code: scheduling_data_too_complex, message}}`. Genie returns a bare `detail`, so this is a v2 patch. Map the code in `CODE_TO_KIND` in `web/lib/bff/errors.ts`."

Section 3, W1, "Adapt the callers", `country` bullet. Add: "Update `web/lib/scenario/canonical.test.ts:93`."

Section 3, W1, "Adapt the callers", semantic version bullet. Replace with: "Bump `SOLVER_SEMANTIC_VERSION`, and regenerate `contracts/job-response.golden.json` with `UPDATE_JOB_RESPONSE_CONTRACT=1`. The web test files that contain `cp-sat@1` are free mock values and need no change."

Section 3, W1, commit list. Move `country` into commit 1: "1. The verbatim take, the genie tests, the `workspace.py` (map function and `country` drop), oracle, `canonical.ts`, SG test case and YAML bound changes. 2. P1. 3. P2 and P3. 4. P4. 5. The semantic version bump and the contract golden." Add: "Commits 1 to 3 are red for the V2-ONLY tests that later commits fix. Only the branch tip must pass."

Section 1, success criterion 4, second item. Add: "The 422 for these errors has `path: []`. It names the bad ID but not the preference." Then decide if W2 must add a preference index.

Section 3, W1, acceptance 1. Add: "Reverse-apply the patches newest first."

## 5. Reproduction

Branch `kenan-xin/spike-w1-genie-core`, commits `ad9efb8` (take and callers), `47c3b7e` (P1), `a011662` (P2 and P3), `f489182` (P4), `da06553` (`country`, version, bound, spike tests). Patch files: `/tmp/spike-w1/patches/` (also available as `git show` of commits 2 to 4).

```sh
# Upstream archive and venv
git -C /home/kenan/work/nurse-scheduling archive 1bf4b85 core | tar -x -C /tmp/spike-w1/genie
uv venv /tmp/spike-w1-venv --python 3.12
uv pip install --python /tmp/spike-w1-venv/bin/python -r core/requirements.txt pulp==3.3.2 highspy==1.12.0 pyscipopt==6.2.1

# Core gates (from core/)
PYTHONPATH=. /tmp/spike-w1-venv/bin/python -m pytest -q -p no:cacheprovider
PYTHONPATH=. /tmp/spike-w1-venv/bin/python -m pytest -q tests/real/schedule_ortools_cp_sat.py tests/real/schedule_score_ground_truth.py
PYTHONPATH=. /tmp/spike-w1-venv/bin/python -m pytest -q -s tests/test_spike_w1_real_inconclusive.py
/tmp/spike-w1-venv/bin/ruff check . && /tmp/spike-w1-venv/bin/ruff format --check .
UPDATE_JOB_RESPONSE_CONTRACT=1 PYTHONPATH=. /tmp/spike-w1-venv/bin/python -m pytest -q tests/test_job_response_contract.py

# Replay with the hash guard bypassed (script at /tmp/spike-w1/replay.py)
PYTHONPATH=. /tmp/spike-w1-venv/bin/python /tmp/spike-w1/replay.py

# Web (from web/)
PYTHON=/tmp/spike-w1-venv/bin/python pnpm exec vitest run
PYTHON=/tmp/spike-w1-venv/bin/python RUN_DIFFERENTIAL=1 pnpm exec vitest run lib/scenario/differential

# C5 goldens (in a scratch copy, then compare)
PYTHONPATH=<worktree>/core /tmp/spike-w1-venv/bin/python generate-c5-goldens.py
python xlsx-semantic-diff.py <committed.xlsx> <regenerated.xlsx>
```

Baselines came from a copy of `develop` core at `/tmp/spike-w1/v2core-baseline` and a `git archive 970c956` tree at `/tmp/spike-w1/base-tree`. Real Redis was not used (`NURSE_TEST_REDIS_URL` unset). The 69 skipped tests are the same count as the baseline. I did not check each skip reason.
