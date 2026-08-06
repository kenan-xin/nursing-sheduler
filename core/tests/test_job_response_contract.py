"""The server-to-web `JobResponse` contract, captured from REAL FastAPI responses (C2F3).

WHY THIS EXISTS. T09 added a required `request.purpose` to `JobResponse`. The web
parser validates the response against an EXACT key set and rejects any key it did
not declare, so the moment the field shipped, every real 202 and every subsequent
poll became an invalid API response to the browser. Nothing caught it, because the
web fixtures were hand-written and simply had not grown the field: both sides were
internally consistent and disagreed with each other.

SO THE FIXTURE IS NO LONGER HAND-WRITTEN. `contracts/job-response.golden.json`
holds bodies captured verbatim from this app's own HTTP responses. This module
proves the committed bodies still match what FastAPI emits today;
`web/lib/query/job-response-contract.test.ts` proves the web's exact parser accepts
those same bytes and preserves the purpose. A one-sided change now fails on one
side or the other instead of quietly forking the contract.

REFRESHING IT. `UPDATE_JOB_RESPONSE_CONTRACT=1 pytest tests/test_job_response_contract.py`
rewrites the file from a live run. That is a DELIBERATE, reviewable act: the diff
is the contract change.
"""

import json
import os
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nurse_scheduling.server import semantic_profile as profile
from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.config import ServerSettings
from nurse_scheduling.server.jobs.models import JobPurpose
from nurse_scheduling.server.optimize_basis import (
    NormalizedOptions,
    OptimizeBasisV2,
    compute_basis_id,
    sha256_hex,
)
from tests.server_support import MINIMAL_SCENARIO

CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contracts" / "job-response.golden.json"
"""The SAME file `web/lib/query/job-response-contract.test.ts` parses."""

CONTRACT_VERSION = "job-response/v1"

UPDATE = os.environ.get("UPDATE_JOB_RESPONSE_CONTRACT") == "1"

TIMEOUT_SECONDS = 60

PARENT_BASIS_ID = "a" * 64
TRANSFORM_DIGEST = "b" * 32


@pytest.fixture
def idle_client():
    """A client with background threads disabled so an accepted job stays queued."""
    app = create_app(settings=ServerSettings(job_backend="memory"), start_background=False)
    with TestClient(app) as test_client:
        yield test_client


def _basis() -> OptimizeBasisV2:
    """The basis a well-behaved client computes for `MINIMAL_SCENARIO`."""
    return OptimizeBasisV2(
        submission_contract_version=profile.SUBMISSION_CONTRACT_VERSION,
        workspace_schema_version="1",
        serializer_version="canonical-strict-yaml-v1",
        anonymization_mode="none",
        input_sha256=sha256_hex(MINIMAL_SCENARIO.encode("utf-8")),
        normalized_options=NormalizedOptions(solver="ortools/cp-sat", prettify=False, timeout_seconds=TIMEOUT_SECONDS),
        solver_semantic_version=profile.SOLVER_SEMANTIC_VERSION,
        backend_capability_version=profile.BACKEND_CAPABILITY_VERSION,
    )


def _form(purpose: JobPurpose) -> dict:
    """The submission form for a basis-claiming run of the given purpose.

    The diagnostic is submitted the way T10 will submit a candidate — hanging off a
    parent basis and a transform — so the candidate ownership fields are part of the
    captured contract rather than a shape only a unit test has ever seen.
    """
    basis = _basis()
    form = {
        "yaml_content": MINIMAL_SCENARIO,
        "prettify": "false",
        "timeout": str(TIMEOUT_SECONDS),
        "purpose": purpose.value,
        "basis_id": compute_basis_id(basis),
        "input_sha256": basis.input_sha256,
        "submission_contract_version": basis.submission_contract_version,
        "workspace_schema_version": basis.workspace_schema_version,
        "serializer_version": basis.serializer_version,
        "anonymization_mode": basis.anonymization_mode,
        "expected_solver_semantic_version": basis.solver_semantic_version,
        "expected_backend_capability_version": basis.backend_capability_version,
    }
    if purpose is JobPurpose.ASSISTANT_DIAGNOSTIC:
        form["parent_basis_id"] = PARENT_BASIS_ID
        form["transform_digest"] = TRANSFORM_DIGEST
    return form


def _capture(client: TestClient) -> list[dict]:
    """Drive real submissions and polls, and return the wire bodies in order.

    The ordinary run is submitted FIRST so the diagnostic's effective queue position
    genuinely counts the ordinary queue ahead of it (T09) instead of coincidentally
    being 1.
    """
    vectors: list[dict] = []
    for purpose in (JobPurpose.ORDINARY, JobPurpose.ASSISTANT_DIAGNOSTIC):
        accepted = client.post("/optimize", data=_form(purpose))
        assert accepted.status_code == 202, accepted.text
        body = accepted.json()
        vectors.append(
            {
                "name": f"{purpose.value}-accepted",
                "method": "POST",
                "path": "/optimize",
                "status": 202,
                "purpose": purpose.value,
                "body": body,
            }
        )
        polled = client.get(f"/optimize/{body['id']}")
        assert polled.status_code == 200, polled.text
        vectors.append(
            {
                "name": f"{purpose.value}-poll",
                "method": "GET",
                "path": "/optimize/{id}",
                "status": 200,
                "purpose": purpose.value,
                "body": polled.json(),
            }
        )
    return vectors


VOLATILE_TIMES = ("created_at", "expires_at", "started_at", "finished_at")
"""Fields whose VALUE is a fresh instant per run. Their presence is still asserted."""

VOLATILE_STRINGS = (("id",), ("request", "input_name"))
"""Per-run identifiers. `input_name` is synthesized from the wall clock when a
submission arrives as raw content rather than as an uploaded file, so it varies by
the second even though everything around it is fixed."""


def _mask(body: dict) -> dict:
    """Replace only per-run values, leaving every key and every other value intact.

    Masking by VALUE and never by key is the point: a field the backend adds or
    removes still changes the masked document, so the comparison stays exact
    everywhere it can be.
    """
    masked = json.loads(json.dumps(body))
    job_id = masked["id"]
    assert isinstance(job_id, str) and job_id, "a response must carry a job id"
    for path in VOLATILE_STRINGS:
        target = masked
        for key in path[:-1]:
            target = target[key]
        assert isinstance(target[path[-1]], str) and target[path[-1]], path
        target[path[-1]] = f"<{'.'.join(path)}>"
    for key in VOLATILE_TIMES:
        assert key in masked, f"the contract requires a `{key}` field, even when null"
        if masked[key] is not None:
            masked[key] = f"<{key}>"
    masked["links"] = {
        name: (value.replace(job_id, "<job-id>") if isinstance(value, str) else value)
        for name, value in masked["links"].items()
    }
    return masked


def _write_contract(vectors: list[dict]) -> None:
    """Rewrite the committed contract from a live capture."""
    document = {
        "contractVersion": CONTRACT_VERSION,
        "note": (
            "Captured verbatim from real FastAPI responses by "
            "core/tests/test_job_response_contract.py. Refresh with "
            "UPDATE_JOB_RESPONSE_CONTRACT=1 pytest tests/test_job_response_contract.py."
        ),
        "vectors": vectors,
    }
    CONTRACT_PATH.write_text(json.dumps(document, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def _load_contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_captured_contract_matches_live_responses(idle_client):
    """Every committed body is still exactly what a real response looks like."""
    live = _capture(idle_client)
    if UPDATE:
        _write_contract(live)

    committed = _load_contract()
    assert committed["contractVersion"] == CONTRACT_VERSION
    assert [vector["name"] for vector in committed["vectors"]] == [vector["name"] for vector in live]
    for expected, actual in zip(committed["vectors"], live, strict=True):
        assert expected["method"] == actual["method"]
        assert expected["status"] == actual["status"]
        assert expected["purpose"] == actual["purpose"]
        assert _mask(expected["body"]) == _mask(actual["body"]), expected["name"]


def test_every_captured_body_carries_its_declared_purpose():
    """`request.purpose` is present, immutable across the poll, and the closed value."""
    for vector in _load_contract()["vectors"]:
        request = vector["body"]["request"]
        assert "purpose" in request, vector["name"]
        assert request["purpose"] == vector["purpose"]
        assert request["purpose"] in {member.value for member in JobPurpose}


def test_the_contract_covers_both_purposes_and_both_hops():
    """A contract that only ever captured one purpose would not have caught this bug."""
    vectors = _load_contract()["vectors"]
    assert {vector["purpose"] for vector in vectors} == {member.value for member in JobPurpose}
    assert {vector["status"] for vector in vectors} == {202, 200}


def test_committed_volatile_fields_are_real_values():
    """The web parser must see a realistic response, not masked placeholders.

    The masking above exists for COMPARISON only. What is committed — and what the
    web parser is handed — has to be the genuine id and the genuine backend
    timestamp format, or the parser gate proves nothing about real traffic.
    """
    for vector in _load_contract()["vectors"]:
        body = vector["body"]
        assert body["id"] and not body["id"].startswith("<")
        assert body["request"]["input_name"].endswith(".yaml")
        assert body["links"]["self"] == f"/optimize/{body['id']}"
        for key in VOLATILE_TIMES:
            value = body[key]
            if value is not None:
                # Raises on anything that is not a real ISO-8601 instant.
                datetime.fromisoformat(value)


def test_the_diagnostic_carries_its_candidate_ownership(idle_client):
    """A diagnostic candidate's parent/transform reach the web unchanged."""
    diagnostic = next(
        vector for vector in _load_contract()["vectors"] if vector["purpose"] == JobPurpose.ASSISTANT_DIAGNOSTIC.value
    )
    basis = diagnostic["body"]["request"]["basis"]
    assert basis["parent_basis_id"] == PARENT_BASIS_ID
    assert basis["transform_digest"] == TRANSFORM_DIGEST
