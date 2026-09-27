"""Pytest fixtures shared across the server, store, and protocol test suites."""

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

import pytest

from tests.server_support import STORE_FACTORIES


@pytest.fixture(params=list(STORE_FACTORIES))
def store_factory(request):
    """Parametrize a test across memory, fakeredis, and (when available) real Redis."""
    return STORE_FACTORIES[request.param]


@pytest.fixture(params=list(STORE_FACTORIES))
def store(request):
    """Provide one store instance per backend with default event retention."""
    return STORE_FACTORIES[request.param]()


# Genie tests (restored verbatim in v1 sync W6) whose asserted behaviour v2 changes on
# purpose. Each entry names the v2 patch and the v2 suite that pins the v2 behaviour.
UPSTREAM_DEVIATIONS = {
    "tests/test_serve.py::test_create_complete_download_and_delete_job": (
        "v2 P7: the artifact is a roster container; see test_server_api.py and test_roster_routes.py"
    ),
    "tests/test_serve.py::test_optimization_runner_returns_expected_failure[UNKNOWN-expected_failure1]": (
        "v2 P8: UNKNOWN completes as INCONCLUSIVE; see test_runner_inconclusive.py"
    ),
    "tests/test_serve.py::test_optimization_runner_uses_job_timestamp_for_artifact_name": (
        "v2 P7: a schedule needs exactly one roster handoff; see test_runner_termination.py"
    ),
    "tests/test_serve.py::test_optimization_runner_classifies_feasible_termination[False-solver_timeout]": (
        "v2 P7: roster handoff; see test_runner_termination.py"
    ),
    "tests/test_serve.py::test_optimization_runner_classifies_feasible_termination[True-user_requested]": (
        "v2 P7: roster handoff; see test_runner_termination.py"
    ),
    "tests/test_serve.py::test_optimization_runner_ignores_stop_requested_after_solver_returns": (
        "v2 P7: roster handoff; see test_runner_termination.py"
    ),
    "tests/test_serve.py::test_cancellation_immediately_terminates_the_solver_process[pulp/highs]": (
        "X4: the server is CP-SAT only"
    ),
    "tests/test_serve.py::test_event_stream_has_ids_and_domain_event_names": (
        "v2 P6: opaque event cursors; see test_server_replay.py"
    ),
    "tests/test_serve.py::test_input_and_timeout_validation": (
        "v2 P5: scenarios are validated at submit; see test_server_api.py and test_server_scheduling_input.py"
    ),
}


def pytest_collection_modifyitems(config, items):
    """Skip the listed genie tests, so the restored file itself stays genie."""
    for item in items:
        reason = UPSTREAM_DEVIATIONS.get(item.nodeid)
        if reason is not None:
            item.add_marker(pytest.mark.skip(reason=reason))
