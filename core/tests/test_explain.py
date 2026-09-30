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

import nurse_scheduling
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


def test_diagnostic_copies_get_no_explanation():
    _job, output = _run(f"{TESTCASES}/basics/01_1nurse_1shift_1day_all_prefs.yaml", JobPurpose.ASSISTANT_DIAGNOSTIC)
    assert output.result.explanation is None
