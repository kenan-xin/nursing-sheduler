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
