"""v2: a run with no roster gets a proof check and a minimal clash (beads qb5v, a5pb P2)."""

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
import random
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone

import pytest
from ortools.sat.python import cp_model

import nurse_scheduling
from nurse_scheduling import explain, solver_ortools_cp_sat
from nurse_scheduling.server.jobs.models import Job, JobPurpose, JobRequest, JobState
from nurse_scheduling.server.jobs.runner import OptimizationRunner
from nurse_scheduling.server.stores.redis import RedisJobStore
from nurse_scheduling.solver_interface import SchedulePhaseProgress, SolverStatus

TESTCASES = os.path.join(os.path.dirname(os.path.realpath(__file__)), "testcases")
REPAIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "fixtures", "assistant_repair")
BASICS = sorted(
    path for path in glob.glob(f"{TESTCASES}/basics/*.yaml") if "_error" not in path and "_infeasible" not in path
)
INFEASIBLE = [
    f"{TESTCASES}/basics/01_1nurse_1shift_1day_infeasible.yaml",
    *sorted(glob.glob(f"{REPAIR}/*.before.yaml")),
]


def _read(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _explain(content: bytes, **kwargs):
    out, phases = [], []

    def progress(payload):
        if isinstance(payload, SchedulePhaseProgress):
            phases.append(payload.code)

    kwargs.setdefault("deterministic", True)
    result = nurse_scheduling.schedule(content, on_explanation=out.append, progress_callback=progress, **kwargs)
    return result, out, phases


def contract_vs_rest_ward(n_people: int = 58, worked_days: int = 22) -> bytes:
    """A counting clash: everyone works exactly `worked_days` of 28, but the rule of at
    least 2 OFF days in every 7 caps a nurse at 20. Staffing is loose and soft requests
    give the optimising run an objective to chase, which is what keeps it from the proof."""
    rng = random.Random(5)
    start = date(2026, 11, 2)
    iso = [str(start + timedelta(days=d)) for d in range(28)]
    per_shift = n_people * 20 // 28 // 3
    lines = [
        "apiVersion: alpha",
        f"dates: {{range: {{startDate: {iso[0]}, endDate: {iso[-1]}}}}}",
        "people:",
        "  items:",
        *[f"    - id: n{i}" for i in range(n_people)],
        "shiftTypes: {items: [{id: D}, {id: E}, {id: N}]}",
        "preferences:",
        "  - type: at most one shift per day",
    ]
    for shift in "DEN":
        lines.append(
            f"  - {{type: shift type requirement, shiftType: [{shift}], requiredNumPeople: {per_shift - 1}, "
            f"preferredNumPeople: {per_shift + 2}, qualifiedPeople: [ALL], date: [ALL], weight: -1}}"
        )
    lines.append(
        "  - {type: shift count, description: contract, person: [ALL], countDates: [ALL], "
        f"countShiftTypes: [D, E, N], expression: x = T, target: {worked_days}, weight: .inf}}"
    )
    for first in range(28 - 6):
        lines.append(
            f"  - {{type: shift count, description: rest {first}, person: [ALL], "
            f"countDates: [{', '.join(iso[first : first + 7])}], countShiftTypes: [OFF], "
            "expression: x >= T, target: 2, weight: .inf}"
        )
    lines.append("  - {type: shift type successions, person: [ALL], pattern: [N, D], weight: -.inf}")
    for i in range(n_people):
        for _ in range(4):
            lines.append(
                f"  - {{type: shift request, person: n{i}, date: {rng.choice(iso)}, "
                f"shiftType: {rng.choice('DEN')}, weight: {rng.choice([-3, -1, 1, 2])}}}"
            )
    return "\n".join(lines).encode()


def _two_workers(monkeypatch):
    """Solve as a 2-CPU server does (tc1): 2 workers plus develop's max_lp_sym subsolver."""
    real = solver_ortools_cp_sat.ORToolsSolver.__init__

    def init(self):
        real(self)
        self.solver.parameters.num_workers = 2

    monkeypatch.setattr(solver_ortools_cp_sat.ORToolsSolver, "__init__", init)


def test_the_check_proves_a_counting_clash_the_optimising_run_cannot(monkeypatch):
    _two_workers(monkeypatch)
    content = contract_vs_rest_ward()
    # Measured on 2 cores: the optimising run needs 5-8 s to prove this; the check 0.2-0.3 s.
    plain = nurse_scheduling.schedule(content, timeout=2)
    assert plain.solver_status == "UNKNOWN"

    result, [explanation], phases = _explain(content, timeout=2, deterministic=False)

    assert result.solver_status == "INFEASIBLE"
    assert explanation["proof"].startswith("feasibility_check:")
    assert phases[-2:] == ["solving", "explaining_no_roster"]
    core = explanation["core"]
    assert core["minimal"]
    # The planted cause: the contract and four rest windows that cover the month.
    rules = {member["rule"] for member in core["members"]}
    contract, rest_windows = 4, range(5, 5 + 22)
    assert contract in rules and len(rules) == 5
    assert all(rule in rest_windows for rule in rules - {contract})
    assert {member["kind"] for member in core["members"]} == {"count"}
    assert len({member["nurse"] for member in core["members"]}) == 1  # one nurse is enough


def _feasible_with(ctx, units) -> bool:
    model, guards = ctx.solver.model, ctx.solver.guards
    model.clear_assumptions()
    model.add_assumptions([guards[unit] for unit in units])
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    return solver.solve(model) != cp_model.INFEASIBLE


@pytest.mark.parametrize("path", INFEASIBLE, ids=os.path.basename)
def test_an_infeasible_run_names_a_minimal_clash(monkeypatch, path):
    seen = {}
    real = explain.core_units

    def spy(ctx, should_stop=None):
        seen["ctx"], seen["core"] = ctx, real(ctx, should_stop)
        return dict(seen["core"], units=list(seen["core"]["units"]))

    monkeypatch.setattr(explain, "core_units", spy)
    result, [explanation], _phases = _explain(_read(path))

    assert result.solver_status == "INFEASIBLE"
    assert (explanation["kind"], explanation["proof"]) == ("infeasible", "main_run")
    assert explanation["core"]["minimal"] and explanation["core"]["members"]
    units = seen["core"]["units"]
    assert not _feasible_with(seen["ctx"], units)
    for unit in units:  # drop any one member and the rest can hold
        assert _feasible_with(seen["ctx"], [u for u in units if u != unit]), unit


def test_the_core_names_the_staffing_slot_and_the_leave():
    _result, [explanation], _phases = _explain(_read(f"{REPAIR}/onlyRnOnLeave.before.yaml"))
    kinds = {member["kind"]: member for member in explanation["core"]["members"]}
    assert kinds["staffing"]["need"] == 1 and kinds["staffing"]["date"] == kinds["leave"]["date"]
    assert kinds["leave"]["nurse"] == "rn1"


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


@pytest.mark.parametrize("path", [*BASICS[::4], *sorted(glob.glob(f"{REPAIR}/*.yaml"))], ids=os.path.basename)
def test_explanations_leave_the_optimising_model_byte_identical(monkeypatch, path):
    content = _read(path)
    plain, [plain_model] = _solved_models(monkeypatch, content)
    explained, models = _solved_models(monkeypatch, content, on_explanation=lambda _: None)
    # A run with no roster rebuilds a guarded model to explain itself, but never re-optimises.
    assert models == [plain_model]
    assert (explained.solver_status, explained.score) == (plain.solver_status, plain.score)


def test_a_feasible_run_runs_nothing_extra(monkeypatch):
    def fail(*_args, **_kwargs):
        raise AssertionError("explained a run that has a roster")

    monkeypatch.setattr(explain, "explain_no_roster", fail)
    result, out, phases = _explain(_read(BASICS[0]))
    assert result.solver_status == "OPTIMAL"
    assert out == [] and "explaining_no_roster" not in phases


def _unknown_main_run(monkeypatch):
    """Make the optimising run end UNKNOWN, as a timed-out run with no roster does."""
    real = solver_ortools_cp_sat.ORToolsSolver.solve

    def solve(self, *args, **kwargs):
        real(self, *args, **kwargs)
        self.solver_status = SolverStatus.UNKNOWN
        return SolverStatus.UNKNOWN

    monkeypatch.setattr(solver_ortools_cp_sat.ORToolsSolver, "solve", solve)


def test_an_unknown_run_stays_unknown_when_stopped_or_feasible(monkeypatch):
    _unknown_main_run(monkeypatch)
    result, out, phases = _explain(_read(INFEASIBLE[0]), should_stop=lambda: True)
    assert (result.solver_status, out) == ("UNKNOWN", [])
    assert "explaining_no_roster" not in phases
    result, out, _phases = _explain(_read(BASICS[0]))  # the check finds a roster: no proof
    assert (result.solver_status, out) == ("UNKNOWN", [])


def _run(content: bytes, purpose=JobPurpose.ORDINARY):
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
    output = OptimizationRunner().run(job, content, event_callback=lambda *_: None, should_stop=None)
    return job, output


def test_the_runner_puts_the_explanation_on_the_result_and_redis_keeps_it():
    job, output = _run(_read(f"{REPAIR}/onlyRnOnLeave.before.yaml"))
    assert output.result.termination_reason == "infeasibility_proven"
    assert output.result.explanation["core"]["members"]
    stored = replace(job, state=JobState.COMPLETED, result=output.result)
    assert RedisJobStore._deserialize_job(RedisJobStore._serialize_job(stored)).result == output.result


def test_the_runner_turns_a_proven_unknown_run_into_infeasibility_proven(monkeypatch):
    _unknown_main_run(monkeypatch)
    _job, output = _run(_read(INFEASIBLE[0]))
    assert (output.result.outcome.value, output.result.termination_reason) == ("infeasible", "infeasibility_proven")
    assert output.result.explanation["proof"].startswith("feasibility_check:")


def test_diagnostic_copies_get_no_explanation():
    _job, output = _run(_read(f"{REPAIR}/onlyRnOnLeave.before.yaml"), JobPurpose.ASSISTANT_DIAGNOSTIC)
    assert output.result.termination_reason == "infeasibility_proven"
    assert output.result.explanation is None
