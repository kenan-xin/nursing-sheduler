"""`INCONCLUSIVE` is a normal completion carrying no proof either way (T08).

These mock the scheduler so the production classification branch in `runner.py`
executes directly, matching `test_runner_termination.py`.
"""

from datetime import datetime, timezone

import pytest

from nurse_scheduling.server.errors import OptimizationExecutionError
from nurse_scheduling.server.jobs.models import Job, JobRequest, JobState, OptimizationOutcome
from nurse_scheduling.server.jobs.runner import (
    INCONCLUSIVE_NO_PROOF,
    INCONCLUSIVE_SOLVER_TIMEOUT,
    INCONCLUSIVE_SOLVER_UNKNOWN,
    INCONCLUSIVE_TERMINATION_REASONS,
    OptimizationRunner,
)


def _job() -> Job:
    return Job(
        id="job_inconclusive",
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


def _mock_scheduler(monkeypatch, *, solver_status, dataframe=None):
    """Replace the scheduler with one returning a fixed status and dataframe."""

    def fake_schedule(**_kwargs):
        return dataframe, None, None, solver_status, None

    monkeypatch.setattr("nurse_scheduling.server.jobs.runner.scheduler.schedule", fake_schedule)


def _run(monkeypatch, *, solver_status, stop_requested=False, dataframe=None):
    _mock_scheduler(monkeypatch, solver_status=solver_status, dataframe=dataframe)
    return OptimizationRunner().run(
        _job(),
        b"input",
        event_callback=lambda *_args: None,
        should_stop=(lambda: stop_requested),
    )


def test_unknown_without_a_stop_request_is_a_timeout_with_no_solution(monkeypatch):
    """The native timeout expired before any schedule or proof existed."""
    output = _run(monkeypatch, solver_status="UNKNOWN")
    assert output.result.outcome == OptimizationOutcome.INCONCLUSIVE
    assert output.result.termination_reason == INCONCLUSIVE_SOLVER_TIMEOUT
    assert output.result.score is None
    assert output.artifact is None


def test_unknown_after_a_stop_request_is_reported_as_no_proof(monkeypatch):
    """A deliberate stop that beat the solver is not reported as too small a budget."""
    output = _run(monkeypatch, solver_status="UNKNOWN", stop_requested=True)
    assert output.result.outcome == OptimizationOutcome.INCONCLUSIVE
    assert output.result.termination_reason == INCONCLUSIVE_NO_PROOF


@pytest.mark.parametrize("solver_status", ["ABNORMAL", "NOT_SOLVED", "SOME_FUTURE_STATUS", ""])
def test_an_unrecognized_terminal_status_fails_closed_to_solver_unknown(monkeypatch, solver_status):
    """An unknown future status is never guessed into feasibility or infeasibility."""
    output = _run(monkeypatch, solver_status=solver_status)
    assert output.result.outcome == OptimizationOutcome.INCONCLUSIVE
    assert output.result.termination_reason == INCONCLUSIVE_SOLVER_UNKNOWN
    assert output.result.solver_status == solver_status


def test_model_invalid_remains_a_hard_failure(monkeypatch):
    """A broken model is an execution failure, not an absence of proof."""
    with pytest.raises(OptimizationExecutionError) as error:
        _run(monkeypatch, solver_status="MODEL_INVALID")
    assert error.value.code == "invalid_model"


@pytest.mark.parametrize("solver_status", ["OPTIMAL", "FEASIBLE"])
def test_a_claimed_schedule_that_is_missing_remains_a_hard_failure(monkeypatch, solver_status):
    """OPTIMAL/FEASIBLE promises a schedule; its absence is a broken contract."""
    with pytest.raises(OptimizationExecutionError) as error:
        _run(monkeypatch, solver_status=solver_status, dataframe=None)
    assert error.value.code == "no_solution_found"


def test_every_reason_the_runner_can_emit_is_in_the_closed_set(monkeypatch):
    """The product outcome map is exhaustive only if the producer set is closed."""
    emitted = {
        _run(monkeypatch, solver_status="UNKNOWN").result.termination_reason,
        _run(monkeypatch, solver_status="UNKNOWN", stop_requested=True).result.termination_reason,
        _run(monkeypatch, solver_status="WHATEVER").result.termination_reason,
    }
    assert emitted == INCONCLUSIVE_TERMINATION_REASONS
