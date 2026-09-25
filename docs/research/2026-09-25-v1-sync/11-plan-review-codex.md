# Independent review of W0 and W1 implementation plans

Date: 2026-09-25. Reviewer: Codex, fresh read-only review.

## 1. Verdict

**Revise before execution; confidence that the plans execute without rework: 4.5/10.** The core reset and recorded patches work in scratch, but the supplied X14 implementation misses an input case, the intermediate failure gate stops on expected callers, and the shell/format instructions contain reproducible failures. These are repairable plan defects; I found no reason to abandon the reset-and-reapply design.

Scope: W0/W1 plans, their approved design and the four requested evidence reports, current `develop` at `970c95601666c34a595ba75c18d4515b4f555ac5`, upstream `1bf4b85`, and the retained spike commits. All code execution and experimental edits were under `/tmp/codex-plan-review-28297`; this report is the only authored repository change. No commits, worktrees, pushes, issue mutations, or upstream writes.

## 2. Findings, most severe first

### F1 — major | W1 Task 3 Step 4 | X14 incorrectly treats an empty date selector as ALL

**Problem.** `preference.get("date") or ALL` changes the meaning of `date: []`. The actual upstream compiler distinguishes absent/None from an empty list. With an override, the proposed Workspace precheck therefore allows the document through and the strict compiler returns an unlocated error, violating X14.

**Evidence.** W1 plan line 394; spike `core/nurse_scheduling/models.py:1032-1045` uses `if preference.date is not None`, then rejects override dates absent from that selection. Running the exact proposed X14 code and `_OVERRIDE_WORKSPACE` fixture with:

```yaml
    date: []
    requiredNumPeopleOverrides: [[2025-01-02, 1]]
```

returned:

```text
invalid_scheduling_data
[([], "Value error, requiredNumPeopleOverrides date '2025-01-02' is not one of this requirement's dates.")]
```

This should be `workspace_not_ready`, with `preferences.1.requiredNumPeopleOverrides` / `unresolved_workspace_reference` as specified. Ordinary ISO dates, safe-loaded `datetime.date` objects, explicit `ALL`, missing `date`, and disabled preferences worked in separate probes.

**Exact replacement** for the `selected = ...` line:

```python
                    date_selector = preference.get("date")
                    selected = set(
                        parse_dates(
                            ALL if date_selector is None else date_selector,
                            date_map,
                            workspace.dates.range,
                        )
                    )
```

Replace the outside-requirement test declaration/setup with a parameterized case:

```python
@pytest.mark.parametrize("date_selector", ["[2025-01-01]", "[]"])
def test_workspace_override_date_outside_requirement_is_located(date_selector):
    document = _OVERRIDE_WORKSPACE.format(
        extra=f"    date: {date_selector}\n    requiredNumPeopleOverrides: [[2025-01-02, 1]]"
    )
```

Keep its existing assertions. Add explicit ALL and disabled-preference cases to retain the behavior already verified here.

### F2 — major | W1 Task 1 Step 8 | The stated failure whitelist stops the plan on known, expected failures

**Problem.** The plan says failures are limited to three named feature files and tests whose YAML uses `temporary`, then orders the implementer to stop on anything else. Moving `country` earlier removes the country errors, but does not restore `on_roster` or `skillMix` for their other callers.

**Evidence.** W1 plan line 230; `core/nurse_scheduling/server/jobs/runner.py:118` always supplies `on_roster`. A scratch Task-1 state, using the exact 50 upstream files, adapted callers, early country removal, and the two new Task-1 tests produced:

```text
53 failed, 1144 passed, 69 skipped, 3 errors in 82.12s
```

Three failures were the expected archive limitation in `test_app_version.py` (no `.git`); excluding those leaves 50 real intermediate failures and 3 setup errors. Additional affected files include:

- `test_roster_container.py`: three failures with `unexpected keyword argument 'on_roster'`.
- `test_roster_routes.py`: three setup errors for the same missing callback.
- `test_server_api.py::test_completed_job_produces_downloadable_schedule`.
- Three existing `test_server_scheduling_input.py` skill-mix tests.
- `test_assistant_repair_fixtures.py`, including skill-mix/override inputs without `temporary`.

The spike already disclosed these caller families in `08-spike-w1.md`, section 2. They do not mean the spec missed a caller requiring another production change.

**Exact replacement** for the Expected paragraph:

> Expected: Ruff clean after formatting the edited v2 files. Until P1–P4 land, failures caused by missing `temporary`, `skillMix`, `requiredNumPeopleOverrides`, or `on_roster` are expected, including their callers in `test_assistant_repair_fixtures.py`, `test_roster_container.py`, `test_roster_routes.py`, `test_server_api.py`, and `test_server_scheduling_input.py`, as well as the three feature test files. Record failing node IDs and their missing-feature cause. Stop only on failures outside these causes. After Task 4, rerun the full suite and require zero such failures.

### F3 — major | Both plans, repeated shell steps; especially W1 Task 1 Steps 2–3/10 and Task 6 Steps 4–6 | Working-directory state makes later commands fail or silently target nothing

**Problem.** Commands alternate between repository-relative paths and persistent `cd core` / `cd web` without establishing a root or subshell convention. This matters especially for patch extraction: from `core/`, the pathspec `core/nurse_scheduling/...` addresses `core/core/...` and can produce an empty diff. W1 Task 1 Step 10 sets `F=core/tests/...`, changes into `core`, then says `git add $F`; Task 6 similarly changes into `core` before later `cd core` and `git checkout core/...` instructions.

**Evidence.** W1 lines 62–70, 243–250, 555–577, 644, 734–738; W0 lines 125–126, 164–175. In scratch, resolving the P0 `$F` from `core/` failed (`test -f` exit 1), and another `cd core` returned `No such file or directory`. Fresh shells do not fully solve this: the plans also rely on shell-local `FILES`, `F`, and exported `PY` surviving.

**Exact replacement convention** to add to both plans after entering the created worktree:

```bash
export SYNC_ROOT="$PWD"
```

> Run repository commands from `$SYNC_ROOT`; use subshells for commands in `core/`, `web/`, or scratch. Begin each later shell block with `cd "$SYNC_ROOT"`. Re-declare arrays in the block that consumes them.

For example, replace P0's replay/commit sequence with:

```bash
(cd "$SYNC_ROOT/core" && PYTHONPATH=. "$PY" -m pytest -q tests/real/schedule_score_ground_truth.py)
git -C "$SYNC_ROOT" add -- core/tests/testcases/real/large-ward-with-87-people-2025-11.assignment-01.json
git -C "$SYNC_ROOT" commit -m "test(core): re-stamp stale genie assignment fixture hash (patch P0)"
```

Wrap the manifest generator's `cd core` and brace group in a subshell, and use `git -C "$SYNC_ROOT" restore -- core/nurse_scheduling/cli.py` only after verifying the drift experiment started clean. Apply the same convention to all `git diff ... | git apply` commands and the C5 copy step. Use `cp -rf`, as required by AGENTS.md.

### F4 — major | W0 Task 2 Steps 1/3; W1 baseline and full-suite gates | Pipelines report success after pytest fails

**Problem.** `pytest ... | tail` returns `tail`'s status in a shell without `pipefail`. The Redis check is worse: `pytest ... | grep ... || echo "no redis skips"` prints the success message if pytest fails without a matching skip, even if `pipefail` is enabled. This undermines the stated stop-before-red-CI safety boundary.

**Evidence.** W0 lines 164, 175; W1 lines 62, 227, 563. Direct shell probes:

```text
false | tail -3                         -> exit 0
false | grep -i 'SKIPPED.*redis' || echo "no redis skips"
                                       -> no redis skips
```

The CI `run: python3 -m pytest -q -rs` itself is correct; this defect is in the local acceptance commands.

**Exact replacement** for each acceptance pipeline:

```bash
(cd "$SYNC_ROOT/core" && NURSE_TEST_REDIS_URL=redis://localhost:16402/0 \
  PYTHONPATH=. /tmp/v1sync-w0-venv/bin/python -m pytest -q -rs) \
  > /tmp/v1sync-w0-pytest.log 2>&1
pytest_status=$?
tail -30 /tmp/v1sync-w0-pytest.log
if [ "$pytest_status" -ne 0 ]; then exit "$pytest_status"; fi
if grep -i 'SKIPPED.*redis' /tmp/v1sync-w0-pytest.log; then
  echo "ERROR: real Redis tests skipped" >&2
  exit 1
fi
```

Use the same explicit exit-status capture for W1, without the Redis-skip assertion when Redis is intentionally absent. For the no-Redis control, use `env -u NURSE_TEST_REDIS_URL` so an inherited variable cannot invalidate the experiment. Avoid rerunning the entire W0 suite merely to inspect its skip summary.

### F5 — major | W1 Task 1 Steps 7–8 | The supplied test fails the immediately following Ruff format gate

**Problem.** The new `LEGACY_EQUIVALENT + """..."""` assignment is not formatted as required by Ruff 0.15.22. No formatting step precedes the promised clean check, so a literal implementation stops here and the new core CI job also fails.

**Evidence.** W1 lines 209–218. In scratch, with the plan's test appended verbatim:

```text
ruff check .              -> All checks passed!
ruff format --check .     -> Would reformat: tests/test_server_scheduling_input.py
                            1 file would be reformatted, 137 files already formatted
```

`ruff format --diff` changes only this assignment. The other new standalone Python files and the X14 snippet passed formatting.

**Exact replacement:**

```python
    document = (
        LEGACY_EQUIVALENT
        + """  - type: shift request
    person: ghost
    date: 2025-01-01
    shiftType: day
"""
    )
```

Alternatively add an explicit `ruff format` command scoped to edited v2-only files before checking. Do not broadly reformat upstream tracked files and quietly expand the patch set.

### F6 — minor | W1 Task 5 Step 1 | YAML-bound test sets the wrong backend environment variable

**Problem.** `JOB_STORE` is unused; the application reads `JOB_BACKEND`. The test passes only because memory is the default. A developer with Redis selected can fail before exercising the YAML guard, or use a real configured store unintentionally.

**Evidence.** W1 line 538; `core/nurse_scheduling/server/config.py:168`. The exact test passes in a clean environment, but:

```bash
JOB_BACKEND=redis JOB_REDIS_URL=redis://127.0.0.1:1 \
  python -m pytest -q tests/test_yaml_bound.py
```

fails in `create_app` with `redis.exceptions.ConnectionError`, despite the test's `JOB_STORE=memory` monkeypatch.

**Exact replacement:**

```python
    monkeypatch.setenv("JOB_BACKEND", "memory")
```

The current test proves the coded response and that `/info` still works. Its title's stronger “before any job” assertion would be clearer with a store/controller admission spy; response status alone does not assert the absence of a job record.

## 3. Claims verified as correct

### Upstream reset, patch mechanics, manifest, and replay

- Upstream `rev-parse --short feature/genie` returned `1bf4b85`. Every path in W1's `FILES` array exists there; the array contains exactly **50** entries.
- Generated fresh files with `git show 1bf4b85:core/<path>`. Applied the P1, P2–P3 and P4 spike diffs in that order to the scratch tree: all exited **0**. Reverse-applied P4, P2–P3, P1 from a directory with **no `.git`**: all exited **0**. Default `git apply` prefix handling is correct for these `a/core/...` / `b/core/...` patches and the checker's `root/core/...` layout. This is not a blocker.
- Ran the **exact Bash manifest-generator block**, with the provided `FILES` array and a correct starting directory: exit **0**, **50** parsed TOML file rows. Ran the plan's exact checker against the patched scratch tree and P0–P4: `checked 50 files against 1bf4b85: 0 problem(s)`.
- Added one newline to scratch `cli.py`: the checker named `cli.py`, reported one mismatch and returned **1**; restored the original bytes in `finally`. The checker does not need the upstream repository at runtime.
- P0's old hash occurs in the upstream fixture. The proposed replacement and the upstream replay work together: `tests/real/schedule_score_ground_truth.py` plus the two checker tests returned **3 passed in 1.46s**. No assignment edits were needed.
- The checker is a reasonable small use of standard-library copying/hash functions plus Git, not a repository-owned source parser. No additional patch application framework is needed.

### New behavior and compatibility

- Ran the plan's new person, country, unknown-person, X14, YAML-bound and real-INCONCLUSIVE tests, alongside existing scheduling-input tests: **63 passed in 3.66s**. `_content_error`, `WORKSPACE`, `LEGACY_EQUIVALENT`, `load_data`, and the proposed imports resolve as written.
- YAML safe load yields `datetime.date` for unquoted ISO override dates. Upstream `utils.parse_dates` converts selector leaves with `str` (`core/nurse_scheduling/utils.py:72-75`), so the date object is handled correctly. There is no datetime/string TypeError in the proposed normal case.
- Explicit `ALL`, missing `date`, and disabled preferences worked. A date outside the schedule range produced a located Workspace issue. The empty-list defect is specifically F1.
- The alias-bomb generator is valid and the guard returns the expected coded 400. The bound is correctly placed outside the existing generic `ValueError` translation. The existing `JSONResponse` import supports the new exception branch.
- Both 0.01-second and 1-second real-runner cases reached UNKNOWN/INCONCLUSIVE locally. The NamedTuple remains compatible with the runner's five-value unpacking; P4 supplies the callback it requires.
- Full scratch post-patch suite, including the exact new tests/checker and retained spike tests: **1206 passed, 69 skipped, 4 warnings in 91.93s**. Command: `python -m pytest -q -p no:cacheprovider --ignore=tests/test_app_version.py --tb=short`. The version-test exclusion is necessary because this is an archive, not a checkout; this is not a full real-Redis CI acceptance claim.
- **Correction to spike evidence:** `08-spike-w1.md` section 3 item 10 says MathOpt lacks `add_bool_or` and would crash. It inherits that implementation from `ORToolsLinearSolver` (`solver_ortools_mathopt.py:44`, `solver_ortools_linear.py:192-199`). Ran the existing empty-group skill-mix fixture through CP-SAT, MathOpt/CP-SAT and MathOpt/GSCIP: all returned **INFEASIBLE**. Do not add an unnecessary repair based on that warning.

### W0, CI structure, and production dependencies

- W0's runtime and optional file relationship is coherent: `-r requirements.txt` resolves relative to the optional file. Backend and diagnostic Dockerfiles already install only `core/requirements.txt` (`docker/Dockerfile.backend:23-24`, `docker/Dockerfile.diagnostic:25-26`), so neither needs an installation-path change.
- Installed the exact runtime block into a fresh Python **3.12.13** venv. `find_spec` for `pytest`, `ruff`, `fakeredis`, and `pulp` returned **[]**. The W1 application constructed successfully, and a CP-SAT fixture solved **OPTIMAL** using that venv. PuLP imports are lazy inside the scheduler's selected-backend branches (`scheduler.py:261-267` in the spike), so restoring the modules does not force PuLP into runtime.
- Searched web Python/test sources for `pytest`, `fakeredis`, and `pulp`: no hits. The runtime-only application/solve probe supports the split; I did not rerun the full web suite.
- `APP_VERSION=w0-check docker compose -f docker/compose.yml config --images` returned `docker-backend` and `docker-web` (plus Redis), confirming the proposed backend image name. Without `APP_VERSION`, the plan's explanatory bare `config --images` command is incomplete because compose requires that build argument.
- Baseline Ruff format check: **111 files already formatted**. W1 scratch lint: clean. F5 accounts for the new formatting failure.
- The core job's `working-directory: core` applies to `run` steps; it does not relocate action inputs. Root `.python-version` and `core/requirements*.txt` cache paths therefore match the existing workflow convention. GitHub documents these as [run-step defaults](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#defaultsrun). The mapped Redis port and localhost URL agree for a runner-host job.
- `core/tests/server_support.py:140-166` explicitly fails when `NURSE_TEST_REDIS_URL` is set but unreachable; only an unset URL skips the real-store fixture. The new CI command itself does not hide the pytest exit status.
- W1's W0 dependency is appropriate: W0 establishes the optional solver packages and the core job before the reset. The plan covers the spike's section-4 changes: P0, oracle relocation, C5 semantic comparison, coded YAML errors, canonical country assertion, semantic-version golden, and newest-first reverse application. X1/X4/X9/X12/X14 are addressed; F1 is an incomplete X14 implementation. Server changes assigned to W2/W6 are not missing W0/W1 work.

## 4. Unverified items and remaining risks

- **Actual GitHub runner / real Redis:** did not create a PR, execute hosted CI, start a Redis service, or build Docker images. The 69 skips are not evidence that real Redis passes. W0's live Redis acceptance and both PR gates remain mandatory.
- **Web and C5:** checked imports/paths and spike evidence, but did not rerun all web tests, the gated differential suite, or regenerate XLSX files. The known three differential failures must be compared by exact test ID/cause, not merely accepted as an arbitrary count of three.
- **Wall-clock tests:** local UNKNOWN results do not guarantee every machine returns UNKNOWN within the same 1-second budget. Faster hardware could find an incumbent; slower CI is more likely to remain UNKNOWN, not less. Replace “the genie ScheduleResult path did not land” with “inspect actual solver status and failure before diagnosing the port; timing alone does not identify the cause.” Keep the tiny-timeout real integration gate and existing deterministic mocked-runner tests; consider the product-minimum 1-second case a separately measured smoke test if it flakes.
- **Long solver work:** restored regression helpers perform solves without per-call timeouts (`tests/schedule_test_helper.py:94-104`); the real 87-person helper also omits `timeout` (`tests/real/schedule_real_helper.py:111-117`). The default CI pytest discovery excludes `schedule_*.py` under `tests/real`, but it includes solver backend wrappers and SG roster fixtures. A job-level `timeout-minutes` is sensible; changing upstream helper timeouts is another recorded patch, not an invisible test-only adjustment.
- **Install cost:** the existing test venv successfully runs the pinned optional solvers, but I did not measure a cold pip download/build on Ubuntu Actions. Local installed footprint is roughly **6.1 MB highspy + 32 MB pyscipopt + 23 MB pyscipopt.libs**; all are optional and excluded from the runtime venv. Cache configuration is appropriate, but no cold CI installation-time claim is established.
- **Exact checkout-only assertions:** three archive failures in the Task-1 experiment depend on `git describe`; they are not plan regressions. The post-patch suite explicitly excludes the entire version-test module. All scratch outputs are reproducible from `/tmp/codex-plan-review-28297`; the report retains the relevant commands and results in case scratch files disappear.
- **Small command corrections:** W0's PyYAML fallback should be `uv pip install --python /tmp/v1sync-w0-venv/bin/python pyyaml`, not an unqualified install into an unactivated venv. W0's allowed-upstream-command list should include its own later `rev-parse` / `merge-base` reads, or replace those steps with permitted evidence commands. W1 Task 3 Step 2's `-k override` filters all three files, so it does not actually run most skill-mix red tests; split the X14 selection from the two feature suites.

No implementation changes are included. The six findings above should be applied to the plans before dispatching an implementer.

🌱 graft saved ~54,526 tokens this review, 1 call.
