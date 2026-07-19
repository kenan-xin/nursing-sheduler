"""HTTP API behavior for the revised optimize job protocol."""

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

import json
import time

import pytest
from fastapi.testclient import TestClient

from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.config import ServerSettings
from tests.server_support import MINIMAL_SCENARIO


@pytest.fixture
def client():
    """A client whose app runs the real worker/maintenance threads."""
    app = create_app(start_background=True)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def idle_client():
    """A client with background threads disabled so queued jobs stay queued."""
    settings = ServerSettings(job_backend="memory", max_pending_jobs=1)
    app = create_app(settings=settings, start_background=False)
    with TestClient(app) as test_client:
        yield test_client


def _run_to_terminal(client, scenario=MINIMAL_SCENARIO):
    response = client.post("/optimize", data={"yaml_content": scenario})
    assert response.status_code == 202
    job_id = response.json()["id"]
    for _ in range(200):
        job = client.get(f"/optimize/{job_id}").json()
        if job["terminal"]:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not reach a terminal state")


def test_create_returns_revised_schema(client):
    response = client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO})
    assert response.status_code == 202
    assert response.headers["location"].startswith("/optimize/")
    body = response.json()
    assert set(body) >= {"id", "state", "terminal", "request", "result", "error", "controls", "links"}
    assert body["request"]["solver"] == "ortools/cp-sat"
    assert body["links"]["events"] == f"/optimize/{body['id']}/events"
    assert "nurse_scheduling_client_id" in response.cookies


def test_completed_job_produces_downloadable_schedule(client):
    job = _run_to_terminal(client)
    assert job["state"] == "completed"
    assert job["result"]["outcome"] in {"optimal", "feasible"}
    assert job["links"]["schedule"] is not None
    download = client.get(job["links"]["schedule"])
    assert download.status_code == 200
    assert "attachment" in download.headers["content-disposition"]
    assert len(download.content) > 0


def test_non_cp_sat_solver_is_pre_job_422(client):
    response = client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO, "solver": "pulp/cbc"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unsupported_solver"


def test_workspace_validation_error_is_422(client):
    document = "workspaceVersion: 9\napiVersion: alpha\n"
    response = client.post("/optimize", data={"yaml_content": document})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unsupported_workspace_version"


WORKSPACE_BROKEN_REFERENCE = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: missing
"""


def test_workspace_broken_reference_is_pre_job_422_without_consuming_capacity(idle_client):
    # A broken reference is rejected before job creation, so the single pending
    # slot stays free for the next valid submission.
    rejected = idle_client.post("/optimize", data={"yaml_content": WORKSPACE_BROKEN_REFERENCE})
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "workspace_not_ready"
    assert idle_client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO}).status_code == 202


WORKSPACE_INVALID_DATE = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift request
    person: alice
    date: "2025-99-99"
    shiftType: day
"""


def test_workspace_invalid_date_is_pre_job_422_without_consuming_capacity(idle_client):
    rejected = idle_client.post("/optimize", data={"yaml_content": WORKSPACE_INVALID_DATE})
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "workspace_not_ready"
    # The invalid date never created a job, so the single pending slot is free.
    assert idle_client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO}).status_code == 202


def test_unquoted_invalid_date_is_400_not_500(client):
    response = client.post("/optimize", data={"yaml_content": "apiVersion: alpha\ndate: 2025-99-99\n"})
    assert response.status_code == 400


def test_malformed_yaml_is_400(client):
    response = client.post("/optimize", data={"yaml_content": "just a string"})
    assert response.status_code == 400


def test_oversized_input_is_413(client):
    huge = "apiVersion: alpha\n" + ("#padding\n" * (2 * 1024 * 1024))
    response = client.post("/optimize", data={"yaml_content": huge})
    assert response.status_code == 413


def test_events_replay_uses_public_cursor_ids(client):
    job = _run_to_terminal(client)
    response = client.get(job["links"]["events"])
    assert response.status_code == 200
    text = response.text
    assert "event: job.state_changed" in text
    assert "id: v1." in text


def test_reconnect_with_last_event_id_resumes_strictly_after(client):
    import re

    job = _run_to_terminal(client)
    events_url = job["links"]["events"]
    ids = re.findall(r"^id: (v1\.[^\n]+)$", client.get(events_url).text, re.M)
    assert len(ids) > 1

    resumed = client.get(events_url, headers={"Last-Event-ID": ids[0]})
    assert resumed.status_code == 200
    resumed_ids = re.findall(r"^id: (v1\.[^\n]+)$", resumed.text, re.M)
    assert ids[0] not in resumed_ids
    assert resumed_ids == ids[1:]


def test_invalid_last_event_id_is_400_before_stream(client):
    job = _run_to_terminal(client)
    response = client.get(job["links"]["events"], headers={"Last-Event-ID": "garbage"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_event_cursor"


def test_foreign_last_event_id_is_400(client):
    job = _run_to_terminal(client)
    from nurse_scheduling.server.event_cursor import encode_cursor

    foreign = encode_cursor("job_other", "1")
    response = client.get(job["links"]["events"], headers={"Last-Event-ID": foreign})
    assert response.status_code == 400


def test_health_info_and_ready(client):
    # /health is retained as a compatibility surface with the legacy camelCase shape.
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert "appVersion" in health.json()

    # /info is the no-store snake_case identity and readiness surface.
    info = client.get("/info")
    assert info.status_code == 200
    body = info.json()
    assert body["status"] == "ready"
    assert body["service_name"] == "nurse-scheduling-api"
    assert body["api_version"] == "alpha"
    assert body["app_version"] == client.app.state.app_version
    assert body["deployment_id"] == client.app.state.deployment_id
    assert body["instance_id"] == client.app.state.instance_id
    assert body["job_backend"] == "memory"
    assert body["job_store_id"] == client.app.state.job_store.store_id
    # The default memory store adopts the process instance identity.
    assert body["job_store_id"] == client.app.state.instance_id
    assert info.headers["cache-control"] == "no-store"

    ready = client.get("/ready")
    assert ready.status_code == 200
    assert ready.json() == {"status": "ready"}
    assert ready.headers["cache-control"] == "no-store"
    # /ready omits version and identity metadata.
    assert "appVersion" not in ready.json()
    assert "app_version" not in ready.json()


def test_event_stream_carries_runtime_identity(client):
    job = _run_to_terminal(client)
    text = client.get(job["links"]["events"]).text
    payloads = [json.loads(line.removeprefix("data: ")) for line in text.splitlines() if line.startswith("data: ")]
    queued = next(payload for payload in payloads if payload.get("state") == "queued")
    running = next(payload for payload in payloads if payload.get("state") == "running")
    assert queued["runtime"] == client.app.state.runtime_identity
    assert running["runtime"] == client.app.state.runtime_identity
    assert running["worker_id"] == client.app.state.instance_id


def test_pre_job_failures_do_not_consume_capacity(idle_client):
    # With one pending slot and no worker, invalid submissions must not consume it.
    assert idle_client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO, "solver": "x"}).status_code == 422
    assert idle_client.post("/optimize", data={"yaml_content": "not-a-mapping"}).status_code == 400
    assert (
        idle_client.post("/optimize", data={"yaml_content": "workspaceVersion: 5\napiVersion: alpha\n"}).status_code
        == 422
    )
    # The single pending slot is still free for the first valid job.
    assert idle_client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO}).status_code == 202
    # Now the slot is taken, so the next valid job is rejected for capacity.
    assert idle_client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO}).status_code == 429


def test_missing_job_is_404(client):
    response = client.get("/optimize/job_missing")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "job_not_found"
