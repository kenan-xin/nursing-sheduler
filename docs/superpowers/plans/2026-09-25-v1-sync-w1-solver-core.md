# v1 sync W1: solver core reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every non-server module in `core/nurse_scheduling/` with upstream genie `1bf4b85`, re-apply the four v2 features as recorded patches, and make "identical to upstream except the patches" a checked fact.

**Architecture:** Copy the genie files verbatim (the multi-solver library included), then apply four small patches on the genie code: `Person.temporary` (P1), `skillMix` and per-date overrides (P2-P3), and `on_roster` (P4), plus a fixture re-stamp (P0). v2-only files (`server/workspace.py`, `server/scheduling_input.py`, `server/api/optimize.py`, the web) adapt to the new API. `core/scripts/check_upstream_sync.py` reverse-applies the patches and compares each file with the genie blob SHA recorded in `core/upstream-patches/manifest.toml`.

**Tech Stack:** Python 3.12, Pydantic 2.13.4, OR-Tools CP-SAT, pytest, Ruff 0.15.22, TypeScript/Vitest (web), git.

**Spec:** `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md` (section 3, W1; decisions X4, X9, X12, X14). Evidence: `docs/research/2026-09-25-v1-sync/01-solver-model-core.md`, `08-spike-w1.md`. Reference implementation: spike branch `kenan-xin/spike-w1-genie-core` (kept on purpose), commits `ad9efb8` (take and callers), `47c3b7e` (P1), `a011662` (P2-P3), `f489182` (P4), `da06553` (country, version, bound).

## Global Constraints

- Upstream: v1 repo `/home/kenan/work/nurse-scheduling`, branch `feature/genie`, commit `1bf4b85`. Read it only with `git -C /home/kenan/work/nurse-scheduling show|diff|log|rev-parse`.
- Depends on W0 (`docs/superpowers/plans/2026-09-25-v1-sync-w0-foundations.md`) being merged into `develop`: the `core` CI job and `core/requirements-optional.txt` must exist.
- Branch: `wt switch --create feat/v1-sync-w1 --base develop --no-cd`. W1 is one branch with the commits below. Intermediate commits may fail the v2-only tests that a later commit fixes. Only the branch tip must pass.
- Every genie file stays byte-identical to `1bf4b85` except the lines of P0 to P4.
- The server keeps rejecting every solver other than `ortools/cp-sat` (`server/scheduling_input.py`).
- Do not port the Docker performance benchmark or `tests/real/solver_capabilities.py` (fails the Ruff pin with 6 E402; v2 maps it to `core/scripts/solver_capability_probe.py`).
- `SOLVER_SEMANTIC_VERSION` becomes `ortools/cp-sat@2` (X12).
- Do not push or merge without the user's approval. Task tracking uses `bd`.

## Review Focus

- An old saved Workspace file that still carries `country: SG` must still load and solve, with `country` absent from the canonical strict output. Pinned by Task 1 Step 7.
- A legacy strict (non-Workspace) submission that names an unknown person must return a 422 content error, never a 500. Pinned by Task 1 Step 7.
- A Workspace per-date override whose date is outside its requirement's dates must return a located 422 at `preferences.<i>.requiredNumPeopleOverrides` (X14). Pinned by Task 3 Step 1.
- A YAML alias bomb must return 400 with code `scheduling_data_too_complex` before any job exists. Pinned by Task 5 Step 1.
- A timeout with no incumbent must end INCONCLUSIVE, not FAILED. Pinned by Task 5 Step 1.

---

### Task 1: Take the genie solver core and adapt the callers

**Files:**
- Replace from genie (50 files, listed in Step 3): `core/nurse_scheduling/*.py` outside `server/`, and the matching tests under `core/tests/`.
- Modify: `core/nurse_scheduling/server/workspace.py` (imports near line 25; new function after `_people_universe`; `_strict_dict` near line 490)
- Modify: `core/nurse_scheduling/server/scheduling_input.py` (imports, new constant, `_parse_once`)
- Modify: `core/nurse_scheduling/server/api/optimize.py` (imports near line 41; `create_job` exception handling near line 165)
- Modify: `web/lib/scenario/differential/oracle.py:31,92`
- Modify: `web/lib/scenario/canonical.ts:328`, `web/lib/scenario/canonical.test.ts:93`, `web/lib/bff/errors.ts:89`
- Modify: `core/tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml`, `core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml` (remove the `country: SG` line)
- Test: `core/tests/test_server_scheduling_input.py` (2 new tests)

**Interfaces:**
- Consumes: genie `loader.measure_yaml_expansion(content: bytes)` and `loader.SchedulingDataTooComplexError` (a `ValueError`); genie `scheduler.schedule(...) -> ScheduleResult` (a NamedTuple that still unpacks as the old 5-tuple).
- Produces: `nurse_scheduling.server.workspace.build_shift_type_index_map(items, groups) -> dict` (moved from `group_map`, same behavior); `nurse_scheduling.server.scheduling_input.CODE_SCHEDULING_DATA_TOO_COMPLEX = "scheduling_data_too_complex"`.

- [ ] **Step 1: Create the worktree and venv**

```bash
wt switch --create feat/v1-sync-w1 --base develop --no-cd
cd <path printed by wt>
uv venv /tmp/v1sync-w1-venv --python 3.12
uv pip install --python /tmp/v1sync-w1-venv/bin/python -r core/requirements-optional.txt
export PY=/tmp/v1sync-w1-venv/bin/python
```

- [ ] **Step 2: Record the baseline**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q 2>&1 | tail -3`
Expected: 0 failed. Record the passed and skipped counts (the spike saw 1001 passed, 69 skipped).

- [ ] **Step 3: Copy the genie files**

```bash
FILES=(
  nurse_scheduling/cli.py nurse_scheduling/constants.py nurse_scheduling/context.py nurse_scheduling/exporter.py
  nurse_scheduling/group_map.py nurse_scheduling/loader.py nurse_scheduling/model_build_stats.py
  nurse_scheduling/models.py nurse_scheduling/preference_types.py nurse_scheduling/report.py
  nurse_scheduling/scheduler.py nurse_scheduling/solver_interface.py nurse_scheduling/solver_ortools_cp_sat.py
  nurse_scheduling/solver_ortools_linear.py nurse_scheduling/solver_ortools_mathopt.py nurse_scheduling/solver_pulp.py
  nurse_scheduling/solver_pulp_glpk.py nurse_scheduling/solver_pulp_python.py nurse_scheduling/utils.py
  tests/export_test_helper.py tests/schedule_test_helper.py
  tests/real/assignment_fixture.py tests/real/schedule_real_helper.py tests/real/schedule_score_ground_truth.py
  tests/testcases/real/large-ward-with-87-people-2025-11.assignment-01.json
  tests/test_cli.py tests/test_exporter.py tests/test_export_xlsx_ortools_cp_sat.py tests/test_hours_contract_validation.py
  tests/test_loader.py tests/test_models_validation.py tests/test_preference_validation.py tests/test_scheduler.py
  tests/test_solver_interface.py tests/test_utils.py tests/test_schedule_ortools_cp_sat.py
  tests/test_schedule_ortools_mathopt_cp_sat.py tests/test_schedule_ortools_mathopt_gscip.py
  tests/test_schedule_ortools_mathopt_highs.py tests/test_schedule_ortools_mpsolver_bop.py
  tests/test_schedule_ortools_mpsolver_cbc.py tests/test_schedule_ortools_mpsolver_cp_sat.py
  tests/test_schedule_ortools_mpsolver_scip.py tests/test_schedule_pulp_glpk.py tests/test_schedule_pulp_highs.py
  tests/test_schedule_pulp_scip.py tests/test_solver_ortools_linear.py tests/test_solver_ortools_mathopt.py
  tests/test_solver_pulp_glpk.py tests/test_solver_pulp_python.py
)
for p in "${FILES[@]}"; do
  mkdir -p "core/$(dirname "$p")"
  git -C /home/kenan/work/nurse-scheduling show "1bf4b85:core/$p" > "core/$p"
done
echo "${#FILES[@]} files"
```
Expected: `50 files`.

- [ ] **Step 4: Move the shift-type map helper into `workspace.py`**

In `core/nurse_scheduling/server/workspace.py`, replace the two import lines:
```python
from ..constants import ALL, LEAVE, MAP_DATE_KEYWORD_TO_FILTER, MAP_WEEKDAY_TO_STR, OFF
from ..group_map import build_shift_type_index_map
```
with:
```python
from ..constants import ALL, LEAVE, LEAVE_sid, MAP_DATE_KEYWORD_TO_FILTER, MAP_WEEKDAY_TO_STR, OFF, OFF_sid
```
Then add this function directly after `_people_universe`:
```python
def build_shift_type_index_map(items, groups) -> dict:
    """Build the ordered shift-type ``id -> [indices]`` map.

    Insertion order is items, then the ALL/OFF/LEAVE keywords, then groups in
    definition order. Groups resolve through the map built so far, so a forward
    reference, a cycle, or an unknown id fails immediately (DL09 D5). Upstream
    genie removed this from ``group_map``; it now lives here, its only owner.
    """
    map_sid_s: dict = {}
    for s, item in enumerate(items):
        map_sid_s[item.id] = [s]
    map_sid_s[ALL] = list(range(len(items)))
    map_sid_s[OFF] = [OFF_sid]
    map_sid_s[LEAVE] = [LEAVE_sid]
    for group in groups:
        indices: set = set()
        for member in group.members:
            if member not in map_sid_s:
                raise ValueError(
                    f"Shift type group {group.id!r} references undefined shift type or group ID {member!r} "
                    f"(forward reference, cycle, or unknown id)."
                )
            indices.update(map_sid_s[member])
        map_sid_s[group.id] = sorted(indices)
    return map_sid_s
```
In `_strict_dict`, replace:
```python
    for optional in ("description", "country", "appVersion"):
```
with:
```python
    # `country` is accepted for old saved files and dropped: the strict model
    # (upstream genie) no longer has it.
    for optional in ("description", "appVersion"):
```

- [ ] **Step 5: Point the oracle at the moved helper**

In `web/lib/scenario/differential/oracle.py`, change `from nurse_scheduling import exporter, group_map  # noqa: E402` to `from nurse_scheduling import exporter  # noqa: E402`, add `from nurse_scheduling.server.workspace import build_shift_type_index_map  # noqa: E402` after the `scheduling_errors` import, and change `result = group_map.build_shift_type_index_map(items, groups)` to `result = build_shift_type_index_map(items, groups)`.

- [ ] **Step 6: Stop sending `country`, and wire the YAML bound**

`web/lib/scenario/canonical.ts`: delete the line `    country: source.meta.country,` in `projectScenarioDocument`.

`web/lib/scenario/canonical.test.ts:93`: change `expect(doc.country).toBe("SG");` to `expect(doc.country).toBeUndefined();`.

Remove the `country: SG` line from both SG test cases:
```bash
sed -i '/^country: SG$/d' core/tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml
```

`core/nurse_scheduling/server/scheduling_input.py`: add `from ..loader import SchedulingDataTooComplexError, measure_yaml_expansion` to the imports; add after `SUPPORTED_SOLVER = "ortools/cp-sat"`:
```python
CODE_SCHEDULING_DATA_TOO_COMPLEX = "scheduling_data_too_complex"
"""400 code: the YAML expands past the node or nesting bound (upstream loader)."""
```
and at the top of `_parse_once`, before the existing `try`, add:
```python
    # Measured before the full load and outside the try below: the error is a
    # ValueError, which that handler would otherwise turn into a plain 400.
    try:
        measure_yaml_expansion(content)
    except SchedulingDataTooComplexError:
        raise
    except (YAMLError, ValueError) as error:
        raise MalformedInputError(f"The scheduling document is not valid YAML: {error}") from error
```
Add `SchedulingDataTooComplexError: If the bytes expand past the upstream bound.` to its `Raises:` docstring.

`core/nurse_scheduling/server/api/optimize.py`: replace the `from ..scheduling_input import ...` line with:
```python
from ...loader import SchedulingDataTooComplexError
from ..scheduling_input import (
    CODE_SCHEDULING_DATA_TOO_COMPLEX,
    SUPPORTED_SOLVER,
    MalformedInputError,
    canonicalize_submission,
    parse_solver,
)
```
and after `except MalformedInputError as error: raise HTTPException(status_code=400, detail=str(error)) from error` in `create_job`, add:
```python
    except SchedulingDataTooComplexError as error:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": CODE_SCHEDULING_DATA_TOO_COMPLEX, "message": str(error)}},
        )
```
`web/lib/bff/errors.ts`: add `  scheduling_data_too_complex: "request-invalid",` to `CODE_TO_KIND` after `unsupported_solver: "validation",`.

- [ ] **Step 7: Add the two Review Focus tests**

Append to `core/tests/test_server_scheduling_input.py`:
```python
def test_workspace_country_is_accepted_and_dropped():
    document = WORKSPACE.replace("apiVersion: alpha\n", "apiVersion: alpha\ncountry: SG\n", 1)
    canonical = canonicalize_submission(document.encode())
    assert b"country" not in canonical
    assert load_data(canonical) is not None


def test_legacy_unknown_person_is_a_content_error_not_a_crash():
    document = LEGACY_EQUIVALENT + """  - type: shift request
    person: ghost
    date: 2025-01-01
    shiftType: day
"""
    with pytest.raises(SchedulingContentError) as caught:
        canonicalize_submission(document.encode())
    assert any("ghost" in issue.message for issue in caught.value.issues)
```
The genie `load_data(content: bytes)` takes bytes.

- [ ] **Step 8: Run the suite and Ruff**

Run:
```bash
cd core && PYTHONPATH=. $PY -m pytest -q 2>&1 | tail -15
$PY -m ruff check . && $PY -m ruff format --check .
```
Expected: Ruff clean. Failures only in the v2-only feature tests that later tasks fix: `test_skill_mix.py`, `test_requirement_overrides.py`, `test_scheduler_on_roster.py`, and any test whose YAML uses `temporary`. Write the failing test ids into the commit message body. Any other failure is a caller the spec missed: stop and report it.

- [ ] **Step 9: Commit**

```bash
git add -A core web/lib/scenario web/lib/bff/errors.ts
git commit -m "feat(core): take genie 1bf4b85 solver core; adapt workspace, oracle, country, YAML bound (v1 sync W1)"
```

- [ ] **Step 10: Re-stamp the stale genie fixture (patch P0)**

Genie `96e9ba9` renamed `FREEDAY`, and merge `1b6f7e5` kept the old fixture hash. The score does not change.
```bash
F=core/tests/testcases/real/large-ward-with-87-people-2025-11.assignment-01.json
sed -i 's/"scenarioSha256":"296dc6e6cfef745cfd9dca0b0d68a01066b230f63e83810b73d8a799edbb44ea"/"scenarioSha256":"0db947b0e16d77f9eed62fc83c3b8635ccfc0e5bedba0fc42fd9797355ce06dc"/' $F
grep -c 0db947b0e16d77f9eed62fc83c3b8635ccfc0e5bedba0fc42fd9797355ce06dc $F
cd core && PYTHONPATH=. $PY -m pytest -q tests/real/schedule_score_ground_truth.py
```
Expected: `1`, then the replay passes with score `4477324836724`.
```bash
git add $F && git commit -m "test(core): re-stamp stale genie assignment fixture hash (patch P0)"
```

### Task 2: Patch P1, `Person.temporary`

**Files:**
- Modify: `core/nurse_scheduling/models.py` (the `pydantic` import line; class `Person`)
- Create: `core/tests/test_person_temporary.py`

**Interfaces:**
- Consumes: genie `models.Person`.
- Produces: `Person.temporary: StrictBool | None`.

- [ ] **Step 1: Write the failing test**

`core/tests/test_person_temporary.py` (v2-only file, so genie's `test_models_validation.py` stays verbatim):
```python
"""v2 patch P1: `Person.temporary` is an authoring-only strict boolean."""

import pytest
from pydantic import ValidationError

from nurse_scheduling.models import Person


def test_temporary_true_is_accepted():
    assert Person(id="float1", temporary=True).temporary is True


def test_temporary_defaults_to_none():
    assert Person(id="alice").temporary is None


@pytest.mark.parametrize("value", ["yes", 1])
def test_temporary_rejects_non_bool(value):
    with pytest.raises(ValidationError):
        Person(id="alice", temporary=value)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q tests/test_person_temporary.py`
Expected: FAIL on `temporary=True` (extra field forbidden or unknown attribute).

- [ ] **Step 3: Apply P1**

In `core/nurse_scheduling/models.py`, add `StrictBool` to the import: `from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, StrictBool, field_validator, model_validator`. In `class Person`, after `history: list[str] | None = None`, add:
```python
    # Authoring-only: a nurse borrowed from another ward, float pool or agency. The
    # frontend derives the lending-ward confirmation from it; the solver reads nothing
    # from it. StrictBool, so "yes" or 1 cannot pass as true.
    temporary: StrictBool | None = None
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q tests/test_person_temporary.py`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add core/nurse_scheduling/models.py core/tests/test_person_temporary.py
git commit -m "feat(core): re-apply Person.temporary on genie models (patch P1)"
```

### Task 3: Patches P2-P3 (`skillMix`, per-date overrides) and the X14 workspace check

**Files:**
- Modify: `core/nurse_scheduling/models.py` (new `SkillMixEntry`; fields and validators on `ShiftTypeRequirementsPreference`; `CompiledShiftTypeRequirements`; `_compile_preference`)
- Modify: `core/nurse_scheduling/preference_types.py` (`shift_type_requirements`)
- Modify: `core/nurse_scheduling/server/workspace.py` (`_reference_issues`)
- Test: existing `core/tests/test_skill_mix.py`, `core/tests/test_requirement_overrides.py`; new tests in `core/tests/test_server_scheduling_input.py`

**Interfaces:**
- Consumes: genie `CompiledShiftTypeRequirements(dates, shift_type_groups, coefficients, qualified_people)`, `utils.parse_pids(value, people_map)`, `utils.parse_dates(value, date_map, date_range) -> list[int]`.
- Produces: `CompiledShiftTypeRequirements.skill_mix: tuple[tuple[tuple[int, ...], int], ...] = ()` and `.required_by_date: tuple[tuple[int, int], ...] = ()`.

- [ ] **Step 1: Write the failing X14 tests**

Append to `core/tests/test_server_scheduling_input.py`:
```python
_OVERRIDE_WORKSPACE = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-03
people:
  items:
    - id: alice
    - id: bob
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 2
{extra}
"""


def test_workspace_override_date_outside_requirement_is_located():
    document = _OVERRIDE_WORKSPACE.format(
        extra="    date: [2025-01-01]\n    requiredNumPeopleOverrides: [[2025-01-02, 1]]"
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert (["preferences", 1, "requiredNumPeopleOverrides"], "unresolved_workspace_reference") in [
        (issue.path, issue.code) for issue in error.issues
    ]


def test_workspace_override_date_inside_requirement_is_accepted():
    document = _OVERRIDE_WORKSPACE.format(extra="    requiredNumPeopleOverrides: [[2025-01-02, 1]]")
    assert b"requiredNumPeopleOverrides" in canonicalize_submission(document.encode())
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q tests/test_server_scheduling_input.py -k override tests/test_skill_mix.py tests/test_requirement_overrides.py`
Expected: FAIL. The genie model has no `skillMix` or `requiredNumPeopleOverrides` field yet.

- [ ] **Step 3: Apply P2-P3 from the spike commit**

The spike diff applies cleanly onto the genie files and touches only `models.py` and `preference_types.py`:
```bash
git diff a011662~1 a011662 -- core/nurse_scheduling/models.py core/nurse_scheduling/preference_types.py | git apply --index
git diff --cached --stat
```
Expected: `2 files changed, 96 insertions(+), 2 deletions(-)`. The added code is the `SkillMixEntry` class, the `skillMix` and `requiredNumPeopleOverrides` fields with their validators, the two `CompiledShiftTypeRequirements` fields, their compilation in `_compile_preference` (unknown `skillMix` people fail through `utils.parse_pids`; an override date outside the requirement raises `requiredNumPeopleOverrides date '<d>' is not one of this requirement's dates.`), and in `shift_type_requirements` the per-date `required` count and the skill-mix floors (`sum >= minNumPeople`, or an empty `add_bool_or([])` when nobody is eligible).

- [ ] **Step 4: Add the X14 check to `workspace.py`**

In `_reference_issues`, inside the existing `if date_range_ok:` block, after the `for field in _DATE_REFERENCE_FIELDS:` loop, add:
```python
            overrides = preference.get("requiredNumPeopleOverrides") or []
            if overrides:
                try:
                    selected = set(parse_dates(preference.get("date") or ALL, date_map, workspace.dates.range))
                except ValueError:
                    selected = None  # the `date` field itself is already reported above
                for entry in overrides if selected is not None else []:
                    if not isinstance(entry, (list, tuple)) or not entry:
                        continue
                    try:
                        override_days = parse_dates(entry[0], date_map, workspace.dates.range)
                    except ValueError as error:
                        override_days = None
                        message = f"Preference overrides an unresolvable date: {entry[0]!r} ({error})."
                    else:
                        message = f"Preference overrides {entry[0]!r}, which is not one of this requirement's dates."
                    if override_days is None or not set(override_days) <= selected:
                        issues.append(
                            SchedulingIssue(
                                ["preferences", index, "requiredNumPeopleOverrides"],
                                ISSUE_UNRESOLVED_WORKSPACE_REFERENCE,
                                message,
                            )
                        )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q tests/test_server_scheduling_input.py tests/test_skill_mix.py tests/test_requirement_overrides.py`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add core/nurse_scheduling/models.py core/nurse_scheduling/preference_types.py core/nurse_scheduling/server/workspace.py core/tests/test_server_scheduling_input.py
git commit -m "feat(core): re-apply skillMix and per-date overrides on genie (patch P2-P3); locate override-date errors (X14)"
```

### Task 4: Patch P4, `on_roster`

**Files:**
- Modify: `core/nurse_scheduling/scheduler.py` (new `_build_roster_payload`; `schedule` signature; the export step)
- Test: existing `core/tests/test_scheduler_on_roster.py`

**Interfaces:**
- Consumes: genie `Context` fields `scenario`, `compiled_schedule`, `solver`, `shifts`, `offs`, `leaves`, `n_people`, `n_days`, `n_shift_types`.
- Produces: `schedule(..., forced_solution=None, *, on_roster: Callable[[dict], None] | None = None) -> ScheduleResult`. The payload keys are `people`, `dates`, `solvedDays`, `coordinateMap` (unchanged from `develop`, consumed by `server/roster_container.py`).

- [ ] **Step 1: Run the existing test to verify it fails**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q tests/test_scheduler_on_roster.py`
Expected: FAIL with `unexpected keyword argument 'on_roster'`.

- [ ] **Step 2: Apply P4 from the spike commit**

```bash
git diff f489182~1 f489182 -- core/nurse_scheduling/scheduler.py | git apply --index
git diff --cached --stat
```
Expected: `1 file changed, 65 insertions(+)`. The added code is `_build_roster_payload(ctx, prettify)`, which reads `ctx.scenario.people.items`, `ctx.scenario.shiftTypes.items`, `ctx.compiled_schedule.dates`, `ctx.leaves` and `ctx.offs`; the keyword-only `on_roster` parameter after `forced_solution`; and the call `on_roster(_build_roster_payload(ctx, prettify))` right after `exporter.get_people_versus_date_dataframe`, reached only for OPTIMAL or FEASIBLE.

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q tests/test_scheduler_on_roster.py tests/test_roster_routes.py`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add core/nurse_scheduling/scheduler.py
git commit -m "feat(core): re-apply on_roster callback on genie scheduler (patch P4)"
```

### Task 5: Semantic version, contract golden, and the INCONCLUSIVE and YAML-bound gates

**Files:**
- Modify: `core/nurse_scheduling/server/semantic_profile.py:36`
- Modify: `contracts/job-response.golden.json` (regenerated)
- Create: `core/tests/test_runner_real_inconclusive.py`, `core/tests/test_yaml_bound.py`

**Interfaces:**
- Consumes: `server.jobs.runner.OptimizationRunner().run(job, canonical, event_callback, should_stop)`, `runner.INCONCLUSIVE_SOLVER_TIMEOUT`, `server.app.create_app(start_background=False)`.
- Produces: `SOLVER_SEMANTIC_VERSION = "ortools/cp-sat@2"`.

- [ ] **Step 1: Write the two gate tests**

`core/tests/test_runner_real_inconclusive.py`:
```python
"""The real scheduler reaches UNKNOWN on a short timeout, and the runner reports INCONCLUSIVE."""

from datetime import datetime, timezone
from pathlib import Path

import pytest

from nurse_scheduling.server.jobs.models import Job, JobRequest, JobState, OptimizationOutcome
from nurse_scheduling.server.jobs.runner import INCONCLUSIVE_SOLVER_TIMEOUT, OptimizationRunner
from nurse_scheduling.server.scheduling_input import canonicalize_submission

REAL = Path(__file__).parent / "testcases" / "real" / "large-ward-with-87-people-2025-11.yaml"


def _job(timeout_seconds) -> Job:
    return Job(
        id="job_real_unknown",
        state=JobState.RUNNING,
        request=JobRequest(
            input_name="input.yaml",
            client_id="client",
            solver="ortools/cp-sat",
            prettify=False,
            timeout_seconds=timeout_seconds,
        ),
        created_at=datetime.now(timezone.utc),
    )


@pytest.mark.parametrize("timeout_seconds", [0.01, 1])
def test_real_scheduler_timeout_without_incumbent_is_inconclusive(timeout_seconds):
    canonical = canonicalize_submission(REAL.read_bytes())
    output = OptimizationRunner().run(
        _job(timeout_seconds), canonical, event_callback=lambda *_a: None, should_stop=lambda: False
    )
    assert output.result.solver_status == "UNKNOWN"
    assert output.result.outcome == OptimizationOutcome.INCONCLUSIVE
    assert output.result.termination_reason == INCONCLUSIVE_SOLVER_TIMEOUT
    assert output.artifact is None
```
`core/tests/test_yaml_bound.py`:
```python
"""A YAML alias bomb is a coded 400 before any job exists."""

from fastapi.testclient import TestClient

from nurse_scheduling.server.app import create_app


def _alias_bomb() -> str:
    text = "a: &a [x, x, x, x, x, x, x, x, x]\n"
    previous = "a"
    for i in range(1, 9):
        text += f"a{i}: &a{i} [" + ", ".join([f"*{previous}"] * 9) + "]\n"
        previous = f"a{i}"
    return text


def test_yaml_bomb_is_a_coded_400_before_any_job(monkeypatch):
    monkeypatch.setenv("JOB_STORE", "memory")
    with TestClient(create_app(start_background=False)) as client:
        response = client.post("/optimize", data={"yaml_content": _alias_bomb()})
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "scheduling_data_too_complex"
        assert client.get("/info").status_code == 200
```

- [ ] **Step 2: Run them**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q tests/test_runner_real_inconclusive.py tests/test_yaml_bound.py`
Expected: 3 passed (Tasks 1 to 4 already made both paths work). If the INCONCLUSIVE test fails, the genie `ScheduleResult` path did not land: stop and report.

- [ ] **Step 3: Bump the semantic version and regenerate the contract golden**

In `core/nurse_scheduling/server/semantic_profile.py`, change `SOLVER_SEMANTIC_VERSION = "ortools/cp-sat@1"` to `SOLVER_SEMANTIC_VERSION = "ortools/cp-sat@2"`. Then:
```bash
cd core && UPDATE_JOB_RESPONSE_CONTRACT=1 PYTHONPATH=. $PY -m pytest -q tests/test_job_response_contract.py
git diff --stat ../contracts/job-response.golden.json
```
Expected: the golden changes only in `solver_semantic_version`, `basis_id`, job ids, timestamps and input names. The web test files that contain `cp-sat@1` are free mock values and need no change.

- [ ] **Step 4: Run every gate on the branch tip**

```bash
cd core && PYTHONPATH=. $PY -m pytest -q 2>&1 | tail -3
PYTHONPATH=. $PY -m pytest -q tests/real/schedule_score_ground_truth.py tests/real/schedule_ortools_cp_sat.py
$PY -m ruff check . && $PY -m ruff format --check .
cd ../web && PYTHON=$PY pnpm test
PYTHON=$PY RUN_DIFFERENTIAL=1 pnpm exec vitest run lib/scenario/differential
```
Expected: core 0 failed (the spike saw about 1,200 passed); the replay and real cases pass; Ruff clean; web unit tests pass; the differential run shows no failure beyond the 3 that already fail on `develop` in `workspace-differential.test.ts`.

- [ ] **Step 5: Check the C5 goldens**

```bash
cd web/lib/optimize/__fixtures__/c5
cp -r . /tmp/v1sync-c5 && cd /tmp/v1sync-c5
PYTHONPATH=<worktree>/core $PY generate-c5-goldens.py
for f in *.xlsx; do $PY xlsx-semantic-diff.py "<worktree>/web/lib/optimize/__fixtures__/c5/$f" "$f"; done
```
Expected: no semantic difference (the spike saw only `docProps/core.xml` timestamps). Commit nothing from this step. If a semantic difference appears, stop and report it.

- [ ] **Step 6: Commit**

```bash
git add core/nurse_scheduling/server/semantic_profile.py contracts/job-response.golden.json core/tests/test_runner_real_inconclusive.py core/tests/test_yaml_bound.py
git commit -m "feat(core): bump solver semantic version to cp-sat@2; gate INCONCLUSIVE and YAML bound (v1 sync W1)"
```

### Task 6: Record the patches and add the upstream check

**Files:**
- Create: `core/upstream-patches/P0-fixture-restamp.patch`, `P1-person-temporary.patch`, `P2-P3-skillmix-overrides.patch`, `P4-on-roster.patch`
- Create: `core/upstream-patches/manifest.toml`
- Create: `core/scripts/check_upstream_sync.py`
- Create: `core/tests/test_check_upstream_sync.py`
- Modify: `docs/T19-upstream-backend-source-manifest.md` (one pointer paragraph)

**Interfaces:**
- Consumes: the Task 1 to 4 commits.
- Produces: `check_upstream_sync.git_blob_sha(data: bytes) -> str` and `check_upstream_sync.main() -> int` (0 when every tracked file matches). W2, W5 and W6 add rows to `manifest.toml` and patches to `patch_order`.

- [ ] **Step 1: Write the failing test**

`core/tests/test_check_upstream_sync.py`:
```python
"""core/ matches the recorded upstream blobs once the v2 patches are reversed."""

from scripts import check_upstream_sync


def test_git_blob_sha_matches_git_hash_object():
    assert check_upstream_sync.git_blob_sha(b"") == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"


def test_core_matches_recorded_upstream():
    assert check_upstream_sync.main() == 0
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd core && PYTHONPATH=. $PY -m pytest -q tests/test_check_upstream_sync.py`
Expected: FAIL with `ImportError: cannot import name 'check_upstream_sync'`.

- [ ] **Step 3: Write the patch files from the commits**

Each patch commit names its patch in the subject, so the SHAs come from `git log`:
```bash
mkdir -p core/upstream-patches
P0=$(git log --format=%h --grep='(patch P0)' develop..HEAD)
P1=$(git log --format=%h --grep='(patch P1)' develop..HEAD)
P23=$(git log --format=%h --grep='(patch P2-P3)' develop..HEAD)
P4=$(git log --format=%h --grep='(patch P4)' develop..HEAD)
echo "$P0 $P1 $P23 $P4"
git diff $P0~1 $P0 -- core/tests/testcases/real/large-ward-with-87-people-2025-11.assignment-01.json > core/upstream-patches/P0-fixture-restamp.patch
git diff $P1~1 $P1 -- core/nurse_scheduling/models.py > core/upstream-patches/P1-person-temporary.patch
git diff $P23~1 $P23 -- core/nurse_scheduling/models.py core/nurse_scheduling/preference_types.py > core/upstream-patches/P2-P3-skillmix-overrides.patch
git diff $P4~1 $P4 -- core/nurse_scheduling/scheduler.py > core/upstream-patches/P4-on-roster.patch
wc -l core/upstream-patches/*.patch
```
Expected: the `echo` prints 4 short SHAs (one each), and `wc` shows 4 non-empty files. The P2-P3 patch has only the two genie files, not `workspace.py`.

- [ ] **Step 4: Generate `manifest.toml` from genie**

```bash
cd core
{
  echo '# Origin of each core/ file that tracks upstream. Paths are relative to core/.'
  echo '# Read by core/scripts/check_upstream_sync.py. See docs/T19-upstream-backend-source-manifest.md.'
  echo 'upstream = "j3soon/nurse-scheduling feature/genie"'
  echo 'upstream_commit = "1bf4b85"'
  echo '# Oldest first. The check reverse-applies them newest first.'
  echo 'patch_order = ["P0-fixture-restamp.patch", "P1-person-temporary.patch", "P2-P3-skillmix-overrides.patch", "P4-on-roster.patch"]'
  for p in "${FILES[@]}"; do
    sha=$(git -C /home/kenan/work/nurse-scheduling rev-parse "1bf4b85:core/$p")
    case "$p" in
      nurse_scheduling/models.py) cls=patched; patches='["P1-person-temporary.patch", "P2-P3-skillmix-overrides.patch"]' ;;
      nurse_scheduling/preference_types.py) cls=patched; patches='["P2-P3-skillmix-overrides.patch"]' ;;
      nurse_scheduling/scheduler.py) cls=patched; patches='["P4-on-roster.patch"]' ;;
      tests/testcases/real/large-ward-with-87-people-2025-11.assignment-01.json) cls=patched; patches='["P0-fixture-restamp.patch"]' ;;
      *) cls=verbatim; patches='' ;;
    esac
    printf '\n[[file]]\npath = "%s"\nclass = "%s"\nupstream_blob = "%s"\n' "$p" "$cls" "$sha"
    [ -n "$patches" ] && printf 'patches = %s\n' "$patches"
  done
} > upstream-patches/manifest.toml
$PY -c "import tomllib; d = tomllib.load(open('upstream-patches/manifest.toml', 'rb')); print(len(d['file']))"
```
`FILES` is the array from Task 1 Step 3; define it again in this shell if needed. Expected: `50`. For example, `nurse_scheduling/models.py` must record `edcdab1503ea2ca11977d1693b259a53449d5245` and `nurse_scheduling/cli.py` must record `8a204b863f7e697a6929dd631d26a75a8807cb87`.

- [ ] **Step 5: Write `core/scripts/check_upstream_sync.py`**

```python
"""Check that core/ matches the recorded upstream (v1 feature/genie) blobs.

For every `verbatim` or `patched` row in upstream-patches/manifest.toml, copy the
file into a scratch tree, reverse-apply the recorded v2 patches newest first, and
compare the git blob SHA with the recorded upstream blob. Needs `git` on PATH but
no access to the upstream repository.

Run from core/: `python -m scripts.check_upstream_sync`.
"""

import hashlib
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

CORE = Path(__file__).resolve().parents[1]
PATCH_DIR = CORE / "upstream-patches"
TRACKED = ("verbatim", "patched")


def git_blob_sha(data: bytes) -> str:
    """Return the SHA-1 that `git hash-object` gives these bytes."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def main() -> int:
    manifest = tomllib.loads((PATCH_DIR / "manifest.toml").read_text(encoding="utf-8"))
    tracked = [entry for entry in manifest["file"] if entry["class"] in TRACKED]
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        for entry in tracked:
            target = root / "core" / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(CORE / entry["path"], target)
        for name in reversed(manifest["patch_order"]):
            result = subprocess.run(
                ["git", "apply", "-R", str(PATCH_DIR / name)], cwd=root, capture_output=True, text=True
            )
            if result.returncode != 0:
                failures.append(f"{name}: does not reverse-apply: {result.stderr.strip()}")
        for entry in tracked:
            actual = git_blob_sha((root / "core" / entry["path"]).read_bytes())
            if actual != entry["upstream_blob"]:
                failures.append(f"{entry['path']}: blob {actual} differs from upstream {entry['upstream_blob']}")
    for failure in failures:
        print(failure, file=sys.stderr)
    print(f"checked {len(tracked)} files against {manifest['upstream_commit']}: {len(failures)} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: Run the check and the test**

Run:
```bash
cd core && PYTHONPATH=. $PY -m scripts.check_upstream_sync
PYTHONPATH=. $PY -m pytest -q tests/test_check_upstream_sync.py
$PY -m ruff check . && $PY -m ruff format --check .
```
Expected: `checked 50 files against 1bf4b85: 0 problem(s)`, then 2 passed, then Ruff clean. To prove the check can fail, add a blank line to `core/nurse_scheduling/cli.py`, run the script (expect exit 1 naming `cli.py`), then `git checkout core/nurse_scheduling/cli.py`.

- [ ] **Step 7: Point the T19 manifest at the machine-readable table**

Add to `docs/T19-upstream-backend-source-manifest.md`, after the header bullets:
```markdown
## Upstream tracking table (from W1)

`core/upstream-patches/manifest.toml` is the source of truth for which `core/` files
track v1 `feature/genie` and how: `verbatim` (byte-identical) or `patched` (with the
named patch files in `core/upstream-patches/`). `core/scripts/check_upstream_sync.py`
checks it, and the `core` CI job runs that check through pytest. W1 patches: P0 fixture
hash re-stamp (upstream bug, report it), P1 `Person.temporary`, P2-P3 `skillMix` and
per-date overrides, P4 `on_roster`. Located Workspace errors stay in the v2-only
`server/workspace.py` (spec X14).
```

- [ ] **Step 8: Commit**

```bash
git add core/upstream-patches core/scripts/check_upstream_sync.py core/tests/test_check_upstream_sync.py docs/T19-upstream-backend-source-manifest.md
git commit -m "feat(core): record upstream patches and check core against genie blobs (v1 sync W1)"
```

### Task 7: Hand off

- [ ] **Step 1: Report**

Report to the user: the branch name, the commit list, the Task 5 Step 4 counts, the `check_upstream_sync` output, and the pull request command into `develop`. Mention the upstream bug to report (stale `scenarioSha256` in the genie assignment fixture). File a bead for the later small web branch that removes the remaining `country` touchpoints: `web/lib/scenario/types.ts`, `workspace.ts`, `import-scenario.ts`, `schemas/import.ts`, `schemas/producer.ts`, `web/lib/store/persistence.ts`, `web/components/ai/use-context-tools.ts` (import keeps accepting `country`). Do not push or merge until the user approves. Acceptance for W1: the `core` job passes on the pull request, including `test_check_upstream_sync.py`.
