"""v2 run explanations: the penalty ledger."""

# This file is part of Nurse Scheduling Project, see <https://github.com/j3soon/nurse-scheduling>.
#
# Copyright (C) 2023-2026 Johnson Sun
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

# This test is mostly AI generated.

import glob
import os
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from ortools.sat.python import cp_model

import nurse_scheduling
from nurse_scheduling import explain, solver_ortools_cp_sat
from nurse_scheduling.solver_interface import SolverStatus
from nurse_scheduling.server.jobs.models import Job, JobPurpose, JobRequest, JobState
from nurse_scheduling.server.jobs.runner import OptimizationRunner
from nurse_scheduling.server.stores.redis import RedisJobStore

TESTCASES = os.path.join(os.path.dirname(os.path.realpath(__file__)), "testcases")
BASICS = sorted(
    path for path in glob.glob(f"{TESTCASES}/basics/*.yaml") if "_error" not in path and "_infeasible" not in path
)


def _explain(path: str, **kwargs):
    with open(path, "rb") as f:
        content = f.read()
    out = []
    result = nurse_scheduling.schedule(content, deterministic=True, on_explanation=out.append, **kwargs)
    return result, out


@pytest.mark.parametrize("path", BASICS, ids=os.path.basename)
def test_ledger_sums_to_the_objective(path):
    result, out = _explain(path)
    if result.solver_status not in ("OPTIMAL", "FEASIBLE"):
        assert out == []
        return
    [explanation] = out
    ledger = explanation["ledger"]
    assert explanation["kind"] == "ledger"
    assert ledger["balanced"], path
    assert ledger["unattributed"] == 0  # deterministic runs are OPTIMAL here
    assert ledger["objective"] == result.score
    assert sum(m["points"] for m in ledger["matches"]) == result.score
    assert sum(r["points"] for r in ledger["rules"]) == result.score
    assert all(m["points"] != 0 for m in ledger["matches"])


def _solved_models(monkeypatch, content, **kwargs):
    """The text of every model the optimising solve ran on."""
    models = []
    real = solver_ortools_cp_sat.ORToolsSolver.solve

    def solve(self, *args, **kw):
        models.append(str(self.model.proto))
        return real(self, *args, **kw)

    monkeypatch.setattr(solver_ortools_cp_sat.ORToolsSolver, "solve", solve)
    result = nurse_scheduling.schedule(content, deterministic=True, **kwargs)
    return result, models


@pytest.mark.parametrize("path", [*BASICS[::4], *sorted(glob.glob(f"{TESTCASES}/../fixtures/assistant_repair/*.yaml"))])
def test_explanations_leave_the_optimising_model_byte_identical(monkeypatch, path):
    with open(path, "rb") as f:
        content = f.read()
    plain, [plain_model] = _solved_models(monkeypatch, content)
    explained, models = _solved_models(monkeypatch, content, on_explanation=lambda _: None)
    # An INFEASIBLE run rebuilds a guarded model to explain itself, but never re-optimises.
    assert models == [plain_model]
    assert explained.score == plain.score


def test_ledger_names_nurse_date_and_shift():
    path = f"{TESTCASES}/basics/01_1nurse_1shift_1day_all_prefs.yaml"
    result, [explanation] = _explain(path)
    keys = {k for m in explanation["ledger"]["matches"] for k in m}
    assert result.score != 0
    assert {"rule", "points", "nurse", "date"} <= keys


def test_ledger_reads_a_negative_succession_from_the_roster_not_its_bound():
    """is_match is only bounded below: a non-optimal roster may carry it at 1 with no match."""
    ctx = SimpleNamespace(
        scenario=SimpleNamespace(
            people=SimpleNamespace(items=[SimpleNamespace(id="ana")]),
            shiftTypes=SimpleNamespace(items=[SimpleNamespace(id="N")]),
        ),
        compiled_schedule=SimpleNamespace(dates=["2026-11-01"]),
        solver=SimpleNamespace(get_value={"is_match": 1, "matched": 1}.get, get_objective_value=lambda: -10),
        # A two-night pattern with one night worked: is_match = 1 is legal, but no match.
        objective_terms=[(3, (0, None, 0), -10, "is_match", lambda value: int(value("matched") == 2))],
    )
    ledger = explain.read_ledger(ctx)
    assert (ledger["balanced"], ledger["matches"], ledger["unattributed"]) == (True, [], -10)


def test_ledger_reports_a_real_negative_succession_match():
    content = b"""apiVersion: alpha
dates: {range: {startDate: 2026-11-01, endDate: 2026-11-02}}
people: {items: [{id: ana}]}
shiftTypes: {items: [{id: N}]}
preferences:
  - type: at most one shift per day
  - {type: shift type requirement, shiftType: N, requiredNumPeople: 1}
  - {type: shift type successions, person: ana, pattern: [N, N], weight: -10}
"""
    out = []
    result = nurse_scheduling.schedule(content, on_explanation=out.append)
    ledger = out[0]["ledger"]
    assert result.score == -10
    assert ledger["matches"] == [{"rule": 2, "nurse": "ana", "date": "2026-11-01", "points": -10}]
    assert ledger["unattributed"] == 0


def _run(path: str, purpose=JobPurpose.ORDINARY):
    job = Job(
        id="job_explain",
        state=JobState.RUNNING,
        request=JobRequest(
            input_name="input.yaml",
            client_id="client",
            solver="ortools/cp-sat",
            prettify=False,
            timeout_seconds=30,
            purpose=purpose,
        ),
        created_at=datetime.now(timezone.utc),
    )
    with open(path, "rb") as f:
        output = OptimizationRunner().run(job, f.read(), event_callback=lambda *_: None, should_stop=None)
    return job, output


def test_runner_puts_the_explanation_on_the_result_and_redis_keeps_it():
    job, output = _run(f"{TESTCASES}/basics/01_1nurse_1shift_1day_all_prefs.yaml")
    assert output.result.explanation["kind"] == "ledger"
    stored = replace(job, state=JobState.COMPLETED, result=output.result)
    assert RedisJobStore._deserialize_job(RedisJobStore._serialize_job(stored)).result == output.result


INFEASIBLE = [
    f"{TESTCASES}/basics/01_1nurse_1shift_1day_infeasible.yaml",
    *sorted(glob.glob(f"{TESTCASES}/../fixtures/assistant_repair/*.before.yaml")),
]


def _core_with_ctx(monkeypatch, path, **kwargs):
    seen = {}
    real = explain.core_units

    def spy(ctx, should_stop=None):
        core = real(ctx, should_stop)
        if core:
            # Re-check now: the fix-solve changes the model next.
            units = core["units"]
            seen["core_holds"] = not _feasible_with(ctx, units)
            seen["drop_one"] = [_feasible_with(ctx, [u for u in units if u != unit]) for unit in units]
        return core

    monkeypatch.setattr(explain, "core_units", spy)
    result, out = _explain(path, **kwargs)
    return result, out, seen


def _feasible_with(ctx, units) -> bool:
    model, guards = ctx.solver.model, ctx.solver.guards
    model.clear_assumptions()
    model.add_assumptions([guards[unit] for unit in units])
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    return solver.solve(model) != cp_model.INFEASIBLE


@pytest.mark.parametrize("path", INFEASIBLE, ids=os.path.basename)
def test_infeasible_core_is_a_minimal_clash(monkeypatch, path):
    result, out, seen = _core_with_ctx(monkeypatch, path)
    [explanation] = out
    core = explanation["core"]
    assert result.solver_status == "INFEASIBLE"
    assert (explanation["kind"], explanation["proof"]) == ("infeasible", "main_run")
    assert core["minimal"] and core["members"]
    assert seen["core_holds"]
    assert all(seen["drop_one"])  # drop any one member and the rest can hold


def test_core_names_the_staffing_slot_and_the_leave():
    _result, [explanation] = _explain(f"{TESTCASES}/../fixtures/assistant_repair/onlyRnOnLeave.before.yaml")
    kinds = {member["kind"]: member for member in explanation["core"]["members"]}
    assert kinds["staffing"]["need"] == 1 and kinds["staffing"]["date"] == kinds["leave"]["date"]
    assert kinds["leave"]["nurse"] == "rn1"


REPAIR = f"{TESTCASES}/../fixtures/assistant_repair"


def test_smallest_fixes_rank_one_short_before_moving_leave():
    _result, [explanation] = _explain(f"{REPAIR}/onlyRnOnLeave.before.yaml")
    fixes = explanation["fixes"]
    assert fixes["fixable"] is True
    first, second = fixes["remedies"][:2]
    assert (first["cost"], first["optimal"], first["proof"]) == (100, True, "backup_solve")
    [short] = first["members"]
    assert (short["kind"], short["short"], short["filled"]) == ("staffing", 1, short["need"] - 1)
    assert [(m["kind"], m["nurse"]) for m in second["members"]] == [("leave", "rn1")]


def test_smallest_fix_raises_a_cap_by_the_least():
    _result, [explanation] = _explain(f"{REPAIR}/personalCapsTooLow.before.yaml")
    [cap] = explanation["fixes"]["remedies"][0]["members"]
    assert (cap["kind"], cap["cap"], cap["needed"]) == ("cap", 3, 4)


def test_a_clash_of_never_relaxed_rules_has_no_fix():
    content = b"""apiVersion: alpha
dates: {range: {startDate: 2023-08-18, endDate: 2023-08-19}}
people: {items: [{id: 0}]}
shiftTypes: {items: [{id: D}]}
preferences:
  - type: at most one shift per day
  - {type: shift count, person: 0, countDates: ALL, countShiftTypes: D, expression: 'x = T', target: 1, weight: .inf}
  - {type: shift type successions, person: 0, pattern: [OFF], weight: .inf}
"""
    out = []
    result = nurse_scheduling.schedule(content, on_explanation=out.append)
    [explanation] = out
    assert result.solver_status == "INFEASIBLE"
    assert {m["kind"] for m in explanation["core"]["members"]} == {"count", "succession"}
    assert explanation["fixes"] == {**explanation["fixes"], "remedies": [], "fixable": False}


def _unknown_main_run(monkeypatch):
    """Make the optimising run end UNKNOWN, as the 58-116 person synthetic wards do in 15 s."""
    real = solver_ortools_cp_sat.ORToolsSolver.solve

    def solve(self, *args, **kwargs):
        real(self, *args, **kwargs)
        self.solver_status = SolverStatus.UNKNOWN
        return SolverStatus.UNKNOWN

    monkeypatch.setattr(solver_ortools_cp_sat.ORToolsSolver, "solve", solve)


def test_an_unknown_run_proven_infeasible_by_the_check_becomes_infeasible(monkeypatch):
    _unknown_main_run(monkeypatch)
    result, [explanation] = _explain(INFEASIBLE[0])
    assert result.solver_status == "INFEASIBLE"
    assert explanation["proof"].startswith("feasibility_check:")
    assert explanation["core"]["members"]


def test_an_unknown_run_stays_unknown_when_stopped_or_feasible(monkeypatch):
    _unknown_main_run(monkeypatch)
    result, out = _explain(INFEASIBLE[0], should_stop=lambda: True)
    assert (result.solver_status, out) == ("UNKNOWN", [])
    result, out = _explain(BASICS[0])
    assert (result.solver_status, out) == ("UNKNOWN", [])


def test_diagnostic_copies_get_no_explanation():
    _job, output = _run(f"{TESTCASES}/basics/01_1nurse_1shift_1day_all_prefs.yaml", JobPurpose.ASSISTANT_DIAGNOSTIC)
    assert output.result.explanation is None
