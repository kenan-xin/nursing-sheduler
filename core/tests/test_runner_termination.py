"""Direct tests for `OptimizationRunner.run` classification and container output."""

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

import base64
import json
from datetime import datetime, timezone

import pytest

from nurse_scheduling.server import roster_container
from nurse_scheduling.server.errors import OptimizationExecutionError
from nurse_scheduling.server.jobs.models import Job, JobRequest, JobState, OptimizationOutcome
from nurse_scheduling.server.jobs.runner import OptimizationRunner

# A minimal but structurally valid `on_roster` handoff: two people, two dates,
# index-aligned single-state day grid, explicit 1-based coordinates.
ROSTER_PAYLOAD = {
    "people": [{"id": 0}, {"id": "N02"}],
    "dates": [{"iso": "2026-02-01"}, {"iso": "2026-02-02"}],
    "solvedDays": [
        [{"kind": "shift", "shiftId": "D"}, {"kind": "off"}],
        [{"kind": "leave"}, {"kind": "shift", "shiftId": "D"}],
    ],
    "coordinateMap": {
        "peopleRows": [3, 4],
        "dateColumns": [2, 3],
        "firstPeopleRow": 3,
        "leadingCols": 1,
        "historyCols": 0,
        "prettify": False,
    },
}


def _job(prettify: bool | None = False) -> Job:
    return Job(
        id="job_classification",
        state=JobState.RUNNING,
        request=JobRequest(
            input_name="input.yaml",
            client_id="client",
            solver="ortools/cp-sat",
            prettify=prettify,
            timeout_seconds=60,
        ),
        created_at=datetime.now(timezone.utc),
    )


def _mock_scheduler(monkeypatch, *, score, solver_status, xlsx_bytes=b"fake xlsx", emit_roster=True):
    """Force `scheduler.schedule` to return a fixed CP-SAT tuple and mock export.

    The stub also drives the real `on_roster` seam, because the runner now feeds
    that handoff into the roster container it stores.
    """
    dataframe = object()
    cell_export_info = object()

    def fake_schedule(**kwargs):
        if emit_roster:
            kwargs["on_roster"](ROSTER_PAYLOAD)
        return dataframe, None, score, solver_status, cell_export_info

    def fake_export(passed_dataframe, buffer, passed_cell_export_info):
        assert passed_dataframe is dataframe
        assert passed_cell_export_info is cell_export_info
        buffer.write(xlsx_bytes)

    monkeypatch.setattr("nurse_scheduling.scheduler.schedule", fake_schedule)
    monkeypatch.setattr("nurse_scheduling.exporter.export_to_excel", fake_export)


def _run(**kwargs):
    """Run the production runner over the mocked scheduler."""
    return OptimizationRunner().run(
        _job(),
        b"apiVersion: alpha\n",
        event_callback=lambda *_args: None,
        **kwargs,
    )


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
    # The single artifact is now the roster container, not the raw workbook.
    assert output.artifact.media_type == "application/json"
    assert output.artifact.name.endswith(".roster.json")
    container = json.loads(output.artifact.content.decode("utf-8"))
    assert container["schemaVersion"] == "roster-container/1"
    assert container["score"] == 7
    assert container["solverStatus"] == "FEASIBLE"
    assert container["people"] == ROSTER_PAYLOAD["people"]
    assert container["dates"] == ROSTER_PAYLOAD["dates"]
    assert container["solvedDays"] == ROSTER_PAYLOAD["solvedDays"]
    assert container["coordinateMap"] == ROSTER_PAYLOAD["coordinateMap"]
    assert base64.b64decode(container["xlsx"]["base64"], validate=True) == b"fake xlsx"
    assert container["xlsx"]["name"].endswith(".xlsx")
    assert container["xlsx"]["mime"] == ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


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


def test_an_absent_prettify_preference_reaches_the_scheduler_as_false(monkeypatch):
    # The request field is optional, but the container's coordinate metadata is
    # typed, so the runner must not forward `None`.
    seen = {}

    def fake_schedule(**kwargs):
        seen["prettify"] = kwargs["prettify"]
        kwargs["on_roster"](ROSTER_PAYLOAD)
        return object(), None, 3, "OPTIMAL", object()

    monkeypatch.setattr("nurse_scheduling.scheduler.schedule", fake_schedule)
    monkeypatch.setattr(
        "nurse_scheduling.exporter.export_to_excel",
        lambda _dataframe, buffer, _info: buffer.write(b"fake xlsx"),
    )

    output = OptimizationRunner().run(
        _job(prettify=None),
        b"apiVersion: alpha\n",
        event_callback=lambda *_args: None,
        should_stop=None,
    )

    assert seen["prettify"] is False
    container = json.loads(output.artifact.content.decode("utf-8"))
    assert container["coordinateMap"]["prettify"] is False


def test_container_bytes_are_deterministic_across_runs(monkeypatch):
    _mock_scheduler(monkeypatch, score=3, solver_status="OPTIMAL")

    first = _run(should_stop=None)
    second = _run(should_stop=None)

    assert first.artifact.content == second.artifact.content


def test_a_schedule_without_a_roster_handoff_fails_with_a_stable_code(monkeypatch):
    _mock_scheduler(monkeypatch, score=3, solver_status="OPTIMAL", emit_roster=False)

    with pytest.raises(OptimizationExecutionError) as raised:
        _run(should_stop=None)

    assert raised.value.code == "roster_handoff_missing"


def test_raw_workbook_at_the_frozen_limit_is_accepted(monkeypatch):
    # The production constants are patched rather than injected: the runner never
    # passes limits, so this proves the frozen defaults are the ones enforced.
    monkeypatch.setattr(roster_container, "MAX_RAW_XLSX_BYTES", 1024)
    _mock_scheduler(monkeypatch, score=3, solver_status="OPTIMAL", xlsx_bytes=b"x" * 1024)

    output = _run(should_stop=None)

    assert output.artifact is not None
    container = json.loads(output.artifact.content.decode("utf-8"))
    assert base64.b64decode(container["xlsx"]["base64"], validate=True) == b"x" * 1024


def test_raw_workbook_one_byte_over_the_frozen_limit_is_rejected(monkeypatch):
    monkeypatch.setattr(roster_container, "MAX_RAW_XLSX_BYTES", 1024)
    _mock_scheduler(monkeypatch, score=3, solver_status="OPTIMAL", xlsx_bytes=b"x" * 1025)

    with pytest.raises(OptimizationExecutionError) as raised:
        _run(should_stop=None)

    assert raised.value.code == "roster_output_too_large"
    assert "1025 bytes" in str(raised.value)


def test_encoded_container_over_the_frozen_limit_is_rejected(monkeypatch):
    # The raw workbook is well within its own cap, so only the encoded-document
    # check can reject this run.
    monkeypatch.setattr(roster_container, "MAX_ROSTER_CONTAINER_BYTES", 512)
    _mock_scheduler(monkeypatch, score=3, solver_status="OPTIMAL", xlsx_bytes=b"x" * 1024)

    with pytest.raises(OptimizationExecutionError) as raised:
        _run(should_stop=None)

    assert raised.value.code == "roster_output_too_large"
    assert "roster container is" in str(raised.value)
