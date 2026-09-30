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
    assert ledger["objective"] == result.score
    assert sum(m["points"] for m in ledger["matches"]) == result.score
    assert sum(r["points"] for r in ledger["rules"]) == result.score
    assert all(m["points"] != 0 for m in ledger["matches"])


@pytest.mark.parametrize("path", BASICS[::4], ids=os.path.basename)
def test_guards_leave_a_feasible_run_unchanged(path):
    with open(path, "rb") as f:
        content = f.read()
    plain = nurse_scheduling.schedule(content, deterministic=True)
    guarded = nurse_scheduling.schedule(content, deterministic=True, on_explanation=lambda _: None)
    assert (guarded.solver_status, guarded.score) == (plain.solver_status, plain.score)


def test_ledger_names_nurse_date_and_shift():
    path = f"{TESTCASES}/basics/01_1nurse_1shift_1day_all_prefs.yaml"
    result, [explanation] = _explain(path)
    keys = {k for m in explanation["ledger"]["matches"] for k in m}
    assert result.score != 0
    assert {"rule", "points", "nurse", "date"} <= keys


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
        seen["ctx"], seen["core"] = ctx, real(ctx, should_stop)
        return dict(seen["core"], units=list(seen["core"]["units"])) if seen["core"] else None

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
    units = seen["core"]["units"]
    assert not _feasible_with(seen["ctx"], units)
    for unit in units:  # drop any one member and the rest can hold
        assert _feasible_with(seen["ctx"], [u for u in units if u != unit]), unit


def test_core_names_the_staffing_slot_and_the_leave():
    _result, [explanation] = _explain(f"{TESTCASES}/../fixtures/assistant_repair/onlyRnOnLeave.before.yaml")
    kinds = {member["kind"]: member for member in explanation["core"]["members"]}
    assert kinds["staffing"]["need"] == 1 and kinds["staffing"]["date"] == kinds["leave"]["date"]
    assert kinds["leave"]["nurse"] == "rn1"


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
