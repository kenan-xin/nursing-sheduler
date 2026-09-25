# Plan review: v1 sync W0 and W1 (Claude Opus, independent)

Date: 2026-09-25. Reviewed: `docs/superpowers/plans/2026-09-25-v1-sync-w0-foundations.md` and `docs/superpowers/plans/2026-09-25-v1-sync-w1-solver-core.md`, against the spec (W0, W1, X1 to X14), `08-spike-w1.md`, and real code.

Method: I dry-ran every W1 step (Tasks 1 to 6) in a scratch git repo at `/tmp/opusrev/w1`, built from `git archive develop`. I used the spike venv `/tmp/spike-w1-venv` (Python 3.12.13, pulp 3.3.2, OR-Tools 9.15.6755, pydantic 2.13.4, ruff 0.15.22). I extracted the code blocks from the plan text with a script, so the dry-run used the exact plan text. I ran the W0 checks on a `develop` archive with a real Redis container. No repository was modified.

## 1. Verdict

The plans are accurate in almost every command, anchor, patch and expected count. The dry-run reached `checked 50 files against 1bf4b85: 0 problem(s)` with 1209 core tests passing. One blocker remains: the new `core` CI job does not install `glpsol`, so 3 PuLP/GLPK tests fail on GitHub after W1. Two major defects will also stop or misdirect a plan-follower: the Task 1 Step 8 failure list is incomplete, and the plans depend on shell state that does not persist between tool calls.

Confidence: 6.0/10 that the plans execute without rework as written. With the fixes in section 2, my estimate is 8.5/10. The rest of the risk comes from facts that I could not measure: CI hardware timing for v2-only tests that never ran in CI, and the web gates that I did not run (section 4).

## 2. Findings, most severe first

### B1. blocker | W0 Task 2 Step 4 (core job), which breaks W1 acceptance | no GLPK binary on the runner

Problem: after W1, `tests/test_schedule_pulp_glpk.py` and `tests/test_solver_pulp_glpk.py` need the `glpsol` executable. PuLP does not bundle it. A stock `ubuntu-latest` runner does not have it. The spike did not see this, because this workstation has `/usr/bin/glpsol` (and `/usr/bin/cbc`).

Evidence:

```text
$ which glpsol            -> /usr/bin/glpsol   (workstation only)
$ PATH=/tmp/opusrev/nobin python -m pytest tests/ -k "pulp or glpk or cbc or scip or highs or linear or mathopt"
FAILED tests/test_schedule_pulp_glpk.py::test_schedule_pulp_glpk_smoke - RuntimeError: PuLP/glpk backend is not available in this environment.
FAILED tests/test_solver_pulp_glpk.py::test_pulp_glpk_solves_integer_model
FAILED tests/test_solver_pulp_glpk.py::test_pulp_glpk_supports_deterministic_solve
3 failed, 153 passed
```

Upstream CI installs the binary for this reason: `git -C /home/kenan/work/nurse-scheduling show 1bf4b85:.github/workflows/test-core.yaml` line 26 is `run: sudo apt-get update && sudo apt-get install -y glpk-utils`. The macOS and Windows workflows use `brew install glpk` and `choco install glpk`. All other backends (CBC, HiGHS, SCIP, MathOpt) pass with an empty `PATH`, because their wheels bundle them.

Fix: in W0 Task 2 Step 4, insert this step after `actions/setup-python@v5` and before `Install backend dependencies`:

```yaml
      # PuLP/GLPK backend tests (restored in W1) call the glpsol binary; PuLP does
      # not bundle it. Upstream test-core.yaml installs the same package.
      - name: Install GLPK
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends glpk-utils
```

Also add to W1 Global Constraints: "The PuLP/GLPK tests need `glpsol` on `PATH` locally (`which glpsol`). On Arch or CachyOS, install `glpk`. On Debian or Ubuntu, install `glpk-utils`."

### M1. major | W1 Task 1 Step 8 | the expected failure list is incomplete, and the plan says to stop on anything else

Problem: the plan lists only `test_skill_mix.py`, `test_requirement_overrides.py`, `test_scheduler_on_roster.py` and tests that use `temporary`. The real run has 5 more files. All of them fail for skillMix, overrides or `on_roster` reasons, and Tasks 3 and 4 fix them. But the step says "Any other failure is a caller the spec missed: stop and report it", so a literal follower stops here.

Evidence (scratch repo after Task 1 Steps 3 to 7):

```text
50 failed, 1147 passed, 69 skipped, 3 errors in 71.68s
  12 FAILED tests/test_skill_mix.py
  12 FAILED tests/test_requirement_overrides.py
  10 FAILED tests/test_scheduler_on_roster.py
   9 FAILED tests/test_assistant_repair_fixtures.py
   3 FAILED tests/test_server_scheduling_input.py   (the 3 skill-mix tests)
   3 FAILED tests/test_roster_container.py
   1 FAILED tests/test_server_api.py::test_completed_job_produces_downloadable_schedule
   3 ERROR  tests/test_roster_routes.py
```

No test failed because of `temporary`. The two new Step 7 tests pass.

Fix: replace the Step 8 "Expected" paragraph with:

> Expected: Ruff clean. Exactly these failures, all fixed by Tasks 3 and 4: `test_skill_mix.py` (12), `test_requirement_overrides.py` (12), `test_scheduler_on_roster.py` (10), `test_assistant_repair_fixtures.py` (9), `test_server_scheduling_input.py` (3: `test_workspace_unknown_skill_mix_person_is_not_ready`, `test_workspace_known_skill_mix_group_and_all_are_not_flagged`, `test_legacy_skill_mix_validator_error_has_clean_path`), `test_roster_container.py` (3), `test_server_api.py::test_completed_job_produces_downloadable_schedule` (1), and 3 errors in `test_roster_routes.py`. Total: 50 failed, 3 errors, about 1147 passed. A failure in any other file is a caller the spec missed: stop and report it.

### M2. major | both plans, every task | shell state does not persist between commands

Problem: the plans assume one long-lived shell. They depend on `cd <path printed by wt>` (W0 Task 1 Step 1, W1 Task 1 Step 1), `export PY=...`, the `FILES` array from Task 1 Step 3, and chains such as `cd core && ...` followed by a block that uses repo-root paths. In Claude Code (and in this Orca session), each Bash call resets the working directory to the primary checkout, and variables do not persist. Subagent-driven execution, which the plan header recommends, also starts each task in a new shell. The results are as follows:

1. Commands run in the primary checkout (the `damselfish` worktree on `feature/update-main`), not in the new W0 or W1 worktree. The Step 3 copy loop would overwrite the wrong tree.
2. `$PY` is empty. I saw this directly: running W1 Task 6 Step 4 in a new shell printed `command not found: -c` at the `$PY -c "import tomllib..."` line.
3. In a persistent shell, the opposite fails. For example, W1 Task 1 Step 10 runs `cd core && ... pytest`, and the next block runs `git add $F` with `F=core/tests/...`, which no longer resolves. W1 Task 6 Step 6 has the same problem with `git checkout core/nurse_scheduling/cli.py`. W1 Task 1 Step 2 (`cd core`) followed by Step 3 (`mkdir -p "core/..."`) would create `core/core/`.

Fix: add this to the Global Constraints of both plans, and apply it to every code block:

> Each command block is self-contained. Start it with `cd /absolute/path/to/worktree` (record the path that `wt` prints in Step 1). Name the interpreter literally, for example `/tmp/v1sync-w1-venv/bin/python`, instead of `$PY`. Put `cd core` only inside a subshell: `(cd core && ...)`.

For `FILES`, write the list once in W1 Task 1 Step 3 and read it back in Task 6 Step 4, in a form that works in bash and zsh:

```bash
printf '%s\n' "${FILES[@]}" > /tmp/v1sync-w1-files.txt   # end of Task 1 Step 3
while read -r p; do ...; done < /tmp/v1sync-w1-files.txt  # Task 6 Step 4 loop
```

The Step 3 loop itself works in zsh: I ran it as written, and it printed `50 files`.

### M3. major | W1 Task 1 Step 7 | the new test fails `ruff format --check`, so Step 8, Task 5 Step 4 and CI are red

Evidence:

```text
$ ruff format --check .
Would reformat: tests/test_server_scheduling_input.py
-    document = LEGACY_EQUIVALENT + """  - type: shift request
+    document = (
+        LEGACY_EQUIVALENT
+        + """  - type: shift request
```

The other new files are clean. `ruff format --check` passes for `test_runner_real_inconclusive.py`, `test_yaml_bound.py`, `check_upstream_sync.py` and `test_check_upstream_sync.py`, and for the X14 test block.

Fix: replace the second test in Step 7 with the form that Ruff accepts:

```python
def test_legacy_unknown_person_is_a_content_error_not_a_crash():
    shift_request = """  - type: shift request
    person: ghost
    date: 2025-01-01
    shiftType: day
"""
    with pytest.raises(SchedulingContentError) as caught:
        canonicalize_submission((LEGACY_EQUIVALENT + shift_request).encode())
    assert any("ghost" in issue.message for issue in caught.value.issues)
```

Also add `$PY -m ruff format --check .` after each test-file edit in Tasks 1, 3 and 5, not only at the end.

### m1. minor | W1 Task 3 Step 4 (X14) | the issue message prints a Python repr

Evidence: the unquoted YAML date loads as `datetime.date`, so `{entry[0]!r}` produces this text:

```text
Preference overrides datetime.date(2025, 1, 3), which is not one of this requirement's dates.
```

Fix: use `{str(entry[0])!r}` in both messages. The text becomes `Preference overrides '2025-01-03', ...`. The existing date-reference message in `_reference_issues` has the same repr defect, but W1 does not need to change it.

### m2. minor | W1 Task 3 Step 4 (X14) | `date: []` bypasses the located check

Problem: `preference.get("date") or ALL` treats an empty list as ALL. The P3 compile step uses `preference.date is not None`, so it treats `[]` as no dates. It then rejects every override with an unlocated 422.

Evidence (probe):

```text
empty date list: invalid_scheduling_data [([], 'strict_contract_violation', "Value error, requiredNumPeopleOverrides date '2025-01-02' is not one of this requirement's ...")]
```

Fix: replace the `selected = ...` line with:

```python
                date_value = preference.get("date")
                try:
                    selected = set(
                        parse_dates(ALL if date_value is None else date_value, date_map, workspace.dates.range)
                    )
```

### m3. minor | W0 Task 2 Step 4 and W1 Task 5 Step 4 | CI never runs the replay that proves patch P0

Problem: `core/pyproject.toml` sets `testpaths = ["tests"]`, and pytest collects only `test_*.py`. So the core job does not run `tests/real/schedule_score_ground_truth.py`, and nothing in CI checks the P0 re-stamp. The replay is cheap: `1 passed in 1.41s`.

Fix: add this to the core job, after the main pytest step:

```yaml
      - name: Score ground-truth replay (patch P0)
        env:
          PYTHONPATH: .
        run: python3 -m pytest -q tests/real/schedule_score_ground_truth.py
```

Keep the 139 s smoke test `tests/real/schedule_ortools_cp_sat.py` manual, as the plan says.

### m4. minor | W1 Task 5 Step 4, W0 Task 1 Step 6 | the web gate is narrower than CI and needs an install

Problem: the CI `checks` job runs `pnpm typecheck`, `pnpm lint` and `pnpm exec oxfmt --check .` as well as `pnpm test`. W1 edits 3 TypeScript files but runs only `pnpm test`. A fresh `wt` worktree also has no `node_modules`. W0 Step 6 also asks for "the same pass count as on develop" without a step that records it first.

Fix: in both steps, run `pnpm install --frozen-lockfile` first. In W1 Task 5 Step 4, replace the web line with `cd ../web && pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm exec oxfmt --check . && PYTHON=$PY pnpm test`. In W0 Step 6, record the `develop` pass count before the split.

Risk that I checked: `country?: string` is optional in `web/lib/scenario/types.ts`, and `CODE_TO_KIND` is `Record<string, OptimizeErrorKind>` (`web/lib/bff/errors.ts:71`). So typecheck is expected to pass.

### m5. minor | W1 Task 3 Step 2 | `-k override` also filters the other two files

Problem: `-k` applies to every listed file, so most `test_skill_mix.py` tests are deselected. The step still fails as expected, so the effect is only a misleading count.

Fix: `pytest -q "tests/test_server_scheduling_input.py::test_workspace_override_date_outside_requirement_is_located" "tests/test_server_scheduling_input.py::test_workspace_override_date_inside_requirement_is_accepted" tests/test_skill_mix.py tests/test_requirement_overrides.py`.

### m6. minor | W0 Task 1 | a stale comment in `core/pyproject.toml`

`core/pyproject.toml:22-23` says "The matching version pin lives in core/requirements.txt". After the split, the Ruff pin is in `requirements-optional.txt`. Fix: add `core/pyproject.toml` to Task 1 Files and change that line to `in core/requirements-optional.txt.`

### m7. minor | W1 scope | `serve.py` is outside the file list

The W1 goal says "Replace every non-server module". `core/nurse_scheduling/serve.py` is a top-level module that differs from genie by one blank line (line 22), and the plan neither takes it nor names it. Fix: add `nurse_scheduling/serve.py` to `FILES` (51 files, and update both "Expected: 50" lines). If you prefer to leave it, name it as a W2 file in Global Constraints.

### m8. minor | W1 Task 1 Step 6 | no web test pins the new error code

`scheduling_data_too_complex: "request-invalid"` has no test. Fix: add one case to `web/lib/bff/errors.test.ts`, which uses the existing `envelope({ code, message })` helper at line 111, and assert kind `request-invalid` for status 400.

### m9. minor | W0 Task 1 Step 5 | the image build step builds more than needed

`make ... build` builds `backend` and `web` (`Makefile`, target `build`). The web image build is slow. Fix: `APP_VERSION=w0-check docker compose -f docker/compose.yml build backend`. The image name `docker-backend` is correct, because `docker/compose.yml` has no top-level `name:`.

### m10. minor | W0 Task 2 Step 4 | job hygiene

Add `timeout-minutes: 20` to the `core` job, so that a hung worker test cannot hold a runner for 6 hours. For parity with deploy, you can pin `redis:8.8.0-alpine` as `docker/compose.yml:29` does. Adding `requirements-optional.txt` to the web job cache key (Task 1 Step 7) is harmless but not needed, because the web job installs only the runtime file.

### m11. minor | process | commit authority

`AGENTS.md` sets the Conservative profile: "Do not run git commits ... unless explicitly asked." Both plans commit in every task. Fix: add one line to Global Constraints: "The user approved the commit steps in this plan. Push and merge still need approval." Use this line only if the user gives that approval.

## 3. Claims verified as correct

| Claim | Evidence |
| --- | --- |
| Spike commits are reachable and chained | `git cat-file -t` gives `commit` for `ad9efb8`, `47c3b7e`, `a011662`, `f489182`, `da06553`. Parents chain in that order. The base is `970c956` = `develop`. |
| Step 3 copies 50 files and equals the spike take | The loop ran unchanged in zsh and printed `50 files`. `diff -rq` against `ad9efb8` shows no difference. `constants.py` is identical in develop and genie, so 49 files change. |
| All 19 modules and 31 test files are verbatim genie | Byte comparison of the spike take against `git archive 1bf4b85` shows no difference. Only `serve.py` and 2 server tests differ, and the plan does not take them. |
| Task 1 Step 4 to Step 7 anchors are exact | A script applied every replacement with an exact-count check. No anchor failed. The results equal the spike tip, except one blank line and the docstring line in `scheduling_input.py`. |
| Genie removed `group_map.build_shift_type_index_map`, and the moved helper works | The full suite passes at the tip. No remaining caller imports it from `group_map`. |
| Step 10 re-stamp | The fixture is compact JSON (`"scenarioSha256":"296dc6e6..."`). The sed matches once, and the replay gives `1 passed in 1.41s`. |
| Task 2 P1 text | Equals `git show 47c3b7e` byte for byte. `4 passed`. |
| Task 3 `git apply` of `a011662` | Applies cleanly on the Task 2 tree: `2 files changed, 96 insertions(+), 2 deletions(-)`. Then `83 passed` for the three test files. |
| X14 behavior | Located `workspace_not_ready` at `['preferences', 1, 'requiredNumPeopleOverrides']` for an override outside the requirement dates, and for one outside the schedule range. A quoted date and `date: ALL` are accepted. A disabled preference is skipped (`enabled: false` is accepted). A malformed pair still gets the located body 422 first. |
| Legacy unknown person is a 422, not a 500 | `invalid_scheduling_data [([], 'strict_contract_violation', 'Value error, Unknown person ID: ghost')]`. |
| Task 4 `git apply` of `f489182` | `1 file changed, 65 insertions(+)`. Then `40 passed` for `test_scheduler_on_roster.py` and `test_roster_routes.py`. |
| Task 5 gate tests | `3 passed in 3.62s` (0.01 s case 1.33 s, 1 s case 2.08 s, bomb 0.07 s). Both files are Ruff-clean. |
| INCONCLUSIVE margin | On a 32-thread Ryzen 9 9950X3D: 2 s and 3 s limits give UNKNOWN, and 5 s gives FEASIBLE. The 1 s case has a margin of 3x or more. Slower CI runners increase it. |
| Golden regeneration | Before regeneration: `1 failed, 4 passed`. After it: `5 passed`. The diff is 40+/40-, only in `solver_semantic_version`, `basis_id`, ids, `self` and `events` links, timestamps and `input_name`. |
| Full tip suite | `1209 passed, 69 skipped` in 90.7 s. All 69 skips are `real Redis not available`. `ruff check` passes. `ruff format` flags only M3. |
| Task 6 extraction and check | The `git log --grep='(patch Pn)'` lookups return exactly 1 SHA each. The 4 patch files are valid (`git apply -R --check` passes for each). The manifest gives 50 rows, with `models.py` = `edcdab1503ea2ca11977d1693b259a53449d5245` and `cli.py` = `8a204b863f7e697a6929dd631d26a75a8807cb87`. |
| `git apply -R` in a non-repository temp dir | `check_upstream_sync` ran in a `tempfile` directory under `/tmp` (not in a repository). The `a/` and `b/` prefixes resolve with the default `-p1` to `core/...` under the scratch root. Result: `checked 50 files against 1bf4b85: 0 problem(s)`, exit 0. The test gives `2 passed`. `from scripts import ...` works, because `core/scripts/__init__.py` exists. |
| C5 goldens | The generator writes next to itself (`OUT_DIR = os.path.dirname(os.path.abspath(__file__))`), so the `/tmp` copy is safe. `xlsx-semantic-diff.py` gives `{"diffs": []}` for all 4 workbooks. |
| YAML bound | Largest real case: 4448 nodes against `MAX_EXPANDED_NODES = 200_000`. Empty, non-UTF-8, broken, list-root and `!!python/object` input still give a plain `MalformedInputError`. Nesting of 70 levels gives the coded error. |
| X4 runtime image stays importable without `pulp` | Genie `scheduler.py:180-207` imports the optional backends inside functions. `server/solver_options.py:56` (W2) imports `pulp` lazily too. |
| ai-only packages are safe to omit | Only genie `tests/test_ai_*.py` import `PIL`, `pypdf`, `psycopg` and `e2b`. No module that W1 takes imports them. |
| Web tests need no test tools | `rg` finds no `fakeredis`, `pytest`, `pulp`, `highspy`, `pyscipopt` or `ruff` in `web/`. Production `core/` mentions `fakeredis` only in comments and a module-name check (`stores/redis.py:260`). |
| W0 on unchanged `develop` | `ruff check` passes, and `ruff format --check` gives `111 files already formatted`. With a real Redis container: 0 skips and 1067 passed. The 3 failures are `test_app_version` git-describe tests, which fail only because my archive has no `.git`. They pass in the `git init` scratch repo, and CI has `.git` from `actions/checkout`. |
| CI details | `.python-version` (3.12.13) is at the repo root. `python-version-file` and `cache-dependency-path` resolve from the workspace root, whatever `defaults.run.working-directory` says. |
| v1 baseline facts | `merge-base d63519b dev` = `89190abd...`. `d63519b` is an ancestor of `feature/genie`. `feature/genie` = `1bf4b85`. The local `dev` ref exists. |
| Optional solver size | `pyscipopt` about 55 MB, `pulp` 36 MB, `highspy` 6 MB. Wheels exist for CPython 3.12 on Linux. |
| Coverage against spike section 4 | Every recommended spec edit is in W1: the P0 re-stamp, the oracle import only, C5 as a manual check, the bound outside the `ValueError` handler plus the `optimize.py` mapping, `canonical.test.ts:93`, the contract golden, reverse newest first, and `country` in commit 1. |

## 4. Not verified, and why

- GitHub runner behavior. I cannot run Actions. v2-only core tests and the 69 real-Redis variants never ran on a 4-vCPU runner. Timing-sensitive tests (the process watchdog, multiprocess worker loss, solver `timeout=5` cases) can be slower or flaky there. The W0 acceptance (a green `core` job on a pull request) is the first real measurement.
- Web gates (`pnpm test`, `typecheck`, `lint`, `oxfmt`, and the `RUN_DIFFERENTIAL=1` suite). The scratch tree has no `node_modules`. I did not run them in the `damselfish` worktree, to keep it read-only. The spike report gives `7473` passed and the same 3 differential failures as `develop`.
- W0 Task 1 Step 5 (Docker build) and Step 6 (runtime-only web run). Not run, because of build time and the read-only rule.
- The 87-person smoke test `tests/real/schedule_ortools_cp_sat.py` (139 s in the spike). Not rerun.
- `test_app_version` in a shallow CI checkout with no tags. I infer from the `--always` flag that it passes, but I did not test a shallow clone.
