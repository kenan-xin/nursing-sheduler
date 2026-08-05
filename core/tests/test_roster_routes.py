"""Route tests for the roster container's two read surfaces.

`GET /optimize/{id}/xlsx` must still hand back byte-identical workbook bytes now
that they live inside the container, and `GET /optimize/{id}/roster` exposes the
structured document without them. Both fail closed on an unreadable artifact, and
an output-too-large run commits no artifact at all.
"""

# This file is part of Nurse Scheduling Project, see <https://github.com/j3soon/nurse-scheduling>.
#
# Copyright (C) 2023-2026 Johnson Sun
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.

import hashlib
import json
import time

import pytest
from fastapi.testclient import TestClient

from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.config import ServerSettings
from nurse_scheduling.server.jobs.models import OptimizationOutcome, OptimizationResult, StoredArtifact
from nurse_scheduling.server.roster_container import (
    CONTAINER_MEDIA_TYPE,
    INVALID_OUTPUT_CODE,
    XLSX_MEDIA_TYPE,
    build_roster_container,
)
from nurse_scheduling.server.stores.memory import MemoryJobStore
from tests.server_support import MINIMAL_SCENARIO
from tests.test_roster_container import (
    REAL_SCENARIO,
    ROSTER_PAYLOAD,
    InvalidHandoffRunner,
    OversizedRosterRunner,
    run_with_export_spy,
)

ARTIFACT_NAME = "nurse-scheduling-20260201T000000Z.roster.json"


def _container(*, xlsx_name: str = "nurse-scheduling-20260201T000000Z.xlsx") -> bytes:
    """A small but fully contract-valid container, as the builder would store it."""
    return build_roster_container(
        ROSTER_PAYLOAD,
        xlsx_bytes=b"workbook",
        xlsx_name=xlsx_name,
        xlsx_mime=XLSX_MEDIA_TYPE,
        score=42,
        solver_status="OPTIMAL",
    )


def _settings(**updates) -> ServerSettings:
    values = {"claim_poll_seconds": 0.005, "maintenance_interval_seconds": 60, "sse_keepalive_seconds": 0.01}
    values.update(updates)
    return ServerSettings(**values)


def _client_with_committed_container(container_bytes: bytes) -> tuple[TestClient, str]:
    """Commit a container as a completed job's artifact and return a client for it.

    The bytes are committed through the real controller/store path, so the routes
    read exactly what a worker would have written.
    """
    app = create_app(settings=_settings(), store=MemoryJobStore(), start_background=False)
    controller = app.state.job_controller
    created = controller.create_job(
        input_name="scenario.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=True,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )
    controller.claim_next_job("worker")
    controller.complete_job(
        created.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 42, "OPTIMAL", "optimality_proven"),
        StoredArtifact(name=ARTIFACT_NAME, media_type=CONTAINER_MEDIA_TYPE, content=container_bytes),
        worker_id="worker",
    )
    return TestClient(app), created.id


@pytest.fixture(scope="module")
def solved_container(module_monkeypatch) -> tuple[dict, bytes, bytes]:
    """One real solved run: the parsed container, its stored bytes, exporter bytes."""
    return run_with_export_spy(module_monkeypatch, REAL_SCENARIO, prettify=True)


@pytest.fixture(scope="module")
def module_monkeypatch():
    from _pytest.monkeypatch import MonkeyPatch

    patcher = MonkeyPatch()
    yield patcher
    patcher.undo()


# --- /xlsx --------------------------------------------------------------------


def test_xlsx_route_streams_byte_identical_workbook_bytes(solved_container):
    container, stored, exported = solved_container
    client, job_id = _client_with_committed_container(stored)

    response = client.get(f"/optimize/{job_id}/xlsx")

    assert response.status_code == 200
    assert response.content == exported
    assert hashlib.sha256(response.content).hexdigest() == hashlib.sha256(exported).hexdigest()
    assert response.headers["content-type"] == XLSX_MEDIA_TYPE
    workbook_name = container["xlsx"]["name"]
    assert response.headers["content-disposition"] == f'attachment; filename="{workbook_name}"'


def test_xlsx_route_synthesizes_a_safe_filename():
    client, job_id = _client_with_committed_container(_container(xlsx_name='../evil"; filename="other.xlsx'))

    response = client.get(f"/optimize/{job_id}/xlsx")

    assert response.status_code == 200
    assert response.content == b"workbook"
    # A stored name can never inject a second header parameter or a path segment.
    assert response.headers["content-disposition"] == 'attachment; filename="evil___filename__other.xlsx"'
    assert response.headers["content-type"] == XLSX_MEDIA_TYPE


# --- /roster ------------------------------------------------------------------


def test_roster_route_returns_the_container_without_workbook_bytes(solved_container):
    container, stored, _exported = solved_container
    client, job_id = _client_with_committed_container(stored)

    response = client.get(f"/optimize/{job_id}/roster")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert "base64" not in body["xlsx"]
    assert body["xlsx"] == {"name": container["xlsx"]["name"], "mime": container["xlsx"]["mime"]}
    assert body["schemaVersion"] == "roster-container/1"
    assert body["people"] == container["people"]
    assert body["dates"] == container["dates"]
    assert body["solvedDays"] == container["solvedDays"]
    assert body["coordinateMap"] == container["coordinateMap"]
    assert body["score"] == container["score"]
    assert body["solverStatus"] == container["solverStatus"]


def test_roster_route_is_reached_by_url_convention_without_a_links_field(solved_container):
    _container, stored, _exported = solved_container
    client, job_id = _client_with_committed_container(stored)

    job = client.get(f"/optimize/{job_id}").json()

    assert set(job["links"]) == {"self", "events", "cancellation", "early_completion", "schedule"}
    assert job["links"]["schedule"] == f"/optimize/{job_id}/xlsx"
    assert client.get(f"/optimize/{job_id}/roster").status_code == 200


# --- Failure surfaces ---------------------------------------------------------


@pytest.mark.parametrize("suffix", ["xlsx", "roster"])
def test_both_routes_are_404_for_an_unknown_job(suffix):
    client, _job_id = _client_with_committed_container(_container())

    response = client.get(f"/optimize/job_missing/{suffix}")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "job_not_found"


@pytest.mark.parametrize("suffix", ["xlsx", "roster"])
def test_both_routes_are_409_before_an_artifact_exists(suffix):
    app = create_app(settings=_settings(), store=MemoryJobStore(), start_background=False)
    controller = app.state.job_controller
    created = controller.create_job(
        input_name="scenario.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=None,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )

    response = TestClient(app).get(f"/optimize/{created.id}/{suffix}")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "job_artifact_not_ready"


def _corrupted(**mutations) -> bytes:
    """A stored container mutated past the frozen contract."""
    container = json.loads(_container())
    for field, value in mutations.items():
        if field == "xlsx":
            container["xlsx"].update(value)
        else:
            container[field] = value
    return json.dumps(container, separators=(",", ":")).encode("utf-8")


@pytest.mark.parametrize("suffix", ["xlsx", "roster"])
@pytest.mark.parametrize(
    "stored",
    [
        pytest.param(b"not json", id="not-json"),
        pytest.param(_corrupted(schemaVersion="roster-container/2"), id="wrong-schema-version"),
        pytest.param(_corrupted(solvedDays=[[{"kind": "off"}]]), id="misaligned-grid"),
        pytest.param(_corrupted(score=None), id="missing-score"),
        pytest.param(_corrupted(solverStatus="INFEASIBLE"), id="unsolved-status"),
        pytest.param(_corrupted(xlsx={"mime": "text/html"}), id="wrong-workbook-mime"),
        # Both routes must reject an undecodable workbook: the structured document
        # and the bytes it describes are one artifact, so neither is served alone.
        pytest.param(_corrupted(xlsx={"base64": "not base64!"}), id="invalid-base64"),
    ],
)
def test_both_routes_fail_closed_on_an_unreadable_container(suffix, stored):
    client, job_id = _client_with_committed_container(stored)

    response = client.get(f"/optimize/{job_id}/{suffix}")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "roster_container_invalid"


@pytest.mark.parametrize(
    ("runner", "expected_code"),
    [
        pytest.param(OversizedRosterRunner(), "roster_output_too_large", id="output-too-large"),
        pytest.param(InvalidHandoffRunner(), INVALID_OUTPUT_CODE, id="invalid-handoff"),
    ],
)
def test_a_rejected_container_fails_the_job_and_commits_no_artifact(runner, expected_code):
    # End-to-end through the real worker and supervised child: the run terminates
    # with the stable code, nothing is stored, and neither route can serve bytes.
    app = create_app(settings=_settings(), store=MemoryJobStore(), runner=runner)
    with TestClient(app) as client:
        created = client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO})
        assert created.status_code == 202
        job_id = created.json()["id"]
        for _ in range(200):
            job = client.get(f"/optimize/{job_id}").json()
            if job["terminal"]:
                break
            time.sleep(0.05)
        else:
            raise AssertionError("job did not reach a terminal state")

        assert job["state"] == "failed"
        assert job["error"]["code"] == expected_code
        assert job["result"] is None
        assert job["links"]["schedule"] is None
        assert app.state.job_store.get(job_id).artifact_name is None
        assert client.get(f"/optimize/{job_id}/xlsx").status_code == 409
        assert client.get(f"/optimize/{job_id}/roster").status_code == 409
