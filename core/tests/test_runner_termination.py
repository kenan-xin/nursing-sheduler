"""Direct tests for `OptimizationRunner.run` termination-reason classification."""

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

# These tests mock the scheduler and exporter so the production classification
# branch in `runner.py` executes directly. Executor delivery tests forward
# pre-labelled results and cannot exercise this boundary.

from datetime import datetime, timezone

from nurse_scheduling.server.jobs.models import Job, JobRequest, JobState, OptimizationOutcome
from nurse_scheduling.server.jobs.runner import OptimizationRunner


def _job() -> Job:
    return Job(
        id="job_classification",
        state=JobState.RUNNING,
        request=JobRequest(
            input_name="input.yaml",
            client_id="client",
            solver="ortools/cp-sat",
            prettify=False,
            timeout_seconds=60,
        ),
        created_at=datetime.now(timezone.utc),
    )


def _mock_scheduler(monkeypatch, *, score, solver_status):
    """Force `scheduler.schedule` to return a fixed CP-SAT tuple and mock export."""
    dataframe = object()
    cell_export_info = object()

    def fake_schedule(**_kwargs):
        return dataframe, None, score, solver_status, cell_export_info

    def fake_export(passed_dataframe, buffer, passed_cell_export_info):
        assert passed_dataframe is dataframe
        assert passed_cell_export_info is cell_export_info
        buffer.write(b"fake xlsx")

    monkeypatch.setattr("nurse_scheduling.scheduler.schedule", fake_schedule)
    monkeypatch.setattr("nurse_scheduling.exporter.export_to_excel", fake_export)


def test_feasible_without_finish_request_is_solver_timeout(monkeypatch):
    _mock_scheduler(monkeypatch, score=7, solver_status="FEASIBLE")

    output = OptimizationRunner().run(
        _job(),
        b"apiVersion: alpha\n",
        event_callback=lambda *_args: None,
        should_stop=lambda: False,
    )

    assert output.result.outcome is OptimizationOutcome.FEASIBLE
    assert output.result.termination_reason == "solver_timeout"
    assert output.result.score == 7
    assert output.artifact is not None
    assert output.artifact.content == b"fake xlsx"


def test_feasible_with_finish_request_is_user_requested(monkeypatch):
    _mock_scheduler(monkeypatch, score=7, solver_status="FEASIBLE")

    output = OptimizationRunner().run(
        _job(),
        b"apiVersion: alpha\n",
        event_callback=lambda *_args: None,
        should_stop=lambda: True,
    )

    assert output.result.outcome is OptimizationOutcome.FEASIBLE
    assert output.result.termination_reason == "user_requested"


def test_feasible_without_stop_callback_is_solver_timeout(monkeypatch):
    _mock_scheduler(monkeypatch, score=7, solver_status="FEASIBLE")

    output = OptimizationRunner().run(
        _job(),
        b"apiVersion: alpha\n",
        event_callback=lambda *_args: None,
        should_stop=None,
    )

    assert output.result.termination_reason == "solver_timeout"


def test_optimal_is_optimality_proven_even_when_stop_requested(monkeypatch):
    _mock_scheduler(monkeypatch, score=3, solver_status="OPTIMAL")

    output = OptimizationRunner().run(
        _job(),
        b"apiVersion: alpha\n",
        event_callback=lambda *_args: None,
        should_stop=lambda: True,
    )

    assert output.result.outcome is OptimizationOutcome.OPTIMAL
    assert output.result.termination_reason == "optimality_proven"
