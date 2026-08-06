"""Pre-job verification of a claimed Optimize submission basis, and its exposure (T08)."""

import pytest
from fastapi.testclient import TestClient

from nurse_scheduling.server import semantic_profile as profile
from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.config import ServerSettings
from nurse_scheduling.server.optimize_basis import (
    NormalizedOptions,
    OptimizeBasisV2,
    compute_basis_id,
    sha256_hex,
)
from tests.server_support import MINIMAL_SCENARIO


@pytest.fixture
def idle_client():
    """A client with background threads disabled so an accepted job stays queued."""
    app = create_app(settings=ServerSettings(job_backend="memory"), start_background=False)
    with TestClient(app) as test_client:
        yield test_client


SUBMITTED = MINIMAL_SCENARIO
"""The exact bytes the client claims a digest over. Note this is the SUBMITTED
document, not the canonical strict form the server stores for execution."""

TIMEOUT_SECONDS = 60


def _basis(**overrides) -> OptimizeBasisV2:
    """Build the basis a well-behaved client would compute for `SUBMITTED`."""
    options = overrides.pop("normalized_options", None) or NormalizedOptions(
        solver="ortools/cp-sat", prettify=False, timeout_seconds=TIMEOUT_SECONDS
    )
    fields = dict(
        submission_contract_version=profile.SUBMISSION_CONTRACT_VERSION,
        workspace_schema_version="1",
        serializer_version="canonical-strict-yaml-v1",
        anonymization_mode="none",
        input_sha256=sha256_hex(SUBMITTED.encode("utf-8")),
        normalized_options=options,
        solver_semantic_version=profile.SOLVER_SEMANTIC_VERSION,
        backend_capability_version=profile.BACKEND_CAPABILITY_VERSION,
    )
    fields.update(overrides)
    return OptimizeBasisV2(**fields)


def _form(basis: OptimizeBasisV2, **overrides) -> dict:
    """Build the submission form a client sends for a basis claim."""
    form = {
        "yaml_content": SUBMITTED,
        "prettify": "false",
        "timeout": str(basis.normalized_options.timeout_seconds),
        "basis_id": compute_basis_id(basis),
        "input_sha256": basis.input_sha256,
        "submission_contract_version": basis.submission_contract_version,
        "workspace_schema_version": basis.workspace_schema_version,
        "serializer_version": basis.serializer_version,
        "anonymization_mode": basis.anonymization_mode,
        "expected_solver_semantic_version": basis.solver_semantic_version,
        "expected_backend_capability_version": basis.backend_capability_version,
    }
    form.update(overrides)
    return form


# --------------------------------------------------------------------------
# Semantic profile boundary
# --------------------------------------------------------------------------


def test_info_advertises_the_semantic_profile(idle_client):
    """The browser reads the semantics it is about to submit under from `/info`."""
    body = idle_client.get("/info").json()
    assert body["semantic_profile"] == {
        "submission_contract_version": profile.SUBMISSION_CONTRACT_VERSION,
        "solver_semantic_version": profile.SOLVER_SEMANTIC_VERSION,
        "backend_capability_version": profile.BACKEND_CAPABILITY_VERSION,
    }


def test_semantic_profile_is_not_folded_into_runtime_identity(idle_client):
    """Job events embed `runtime_identity` verbatim under a closed key set.

    Advertising scheduling semantics must not change the event contract, so the
    profile stays a sibling object rather than extra identity keys.
    """
    body = idle_client.get("/info").json()
    assert set(body) == {
        "status",
        "service_name",
        "api_version",
        "app_version",
        "deployment_id",
        "instance_id",
        "started_at",
        "job_backend",
        "job_store_id",
        "semantic_profile",
    }


# --------------------------------------------------------------------------
# Accepted claims
# --------------------------------------------------------------------------


def test_a_matching_claim_is_accepted_and_exposed_as_identifiers(idle_client):
    """A verified basis is retained on the immutable request and echoed back."""
    basis = _basis()
    response = idle_client.post("/optimize", data=_form(basis))
    assert response.status_code == 202
    stored = response.json()["request"]["basis"]
    assert stored["basis_id"] == compute_basis_id(basis)
    assert stored["input_sha256"] == basis.input_sha256
    assert stored["solver_semantic_version"] == profile.SOLVER_SEMANTIC_VERSION
    assert stored["backend_capability_version"] == profile.BACKEND_CAPABILITY_VERSION
    assert stored["normalized_options"] == {
        "solver": "ortools/cp-sat",
        "prettify": False,
        "timeout_seconds": TIMEOUT_SECONDS,
    }
    assert stored["parent_basis_id"] is None
    assert stored["transform_digest"] is None


def test_a_submission_without_a_claim_still_works(idle_client):
    """Ordinary Optimize must stay fully usable with no basis and no assistant."""
    response = idle_client.post("/optimize", data={"yaml_content": SUBMITTED})
    assert response.status_code == 202
    assert response.json()["request"]["basis"] is None


def test_candidate_ownership_fields_round_trip(idle_client):
    """A candidate carries its parent basis and transform; T10 creates them."""
    basis = _basis()
    response = idle_client.post(
        "/optimize",
        data=_form(basis, parent_basis_id="a" * 64, transform_digest="b" * 32),
    )
    assert response.status_code == 202
    stored = response.json()["request"]["basis"]
    assert stored["parent_basis_id"] == "a" * 64
    assert stored["transform_digest"] == "b" * 32


def test_every_accepted_job_advertises_an_expiry(idle_client):
    """Evidence validity is bounded by an advertised expiry, never open-ended."""
    body = idle_client.post("/optimize", data={"yaml_content": SUBMITTED}).json()
    assert body["expires_at"] is not None
    assert body["expires_at"] > body["created_at"]


# --------------------------------------------------------------------------
# Rejected claims — all before job creation
# --------------------------------------------------------------------------


def _assert_rejected(idle_client, form, code):
    """Assert a claim is rejected pre-job and left no job behind."""
    response = idle_client.post("/optimize", data=form)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code


def test_a_digest_that_does_not_match_the_received_bytes_is_rejected(idle_client):
    """The server digests what it received; it never trusts the claimed value."""
    _assert_rejected(
        idle_client,
        _form(_basis(), input_sha256="c" * 64),
        "basis_input_digest_mismatch",
    )


def test_substituted_bytes_are_caught_even_with_a_self_consistent_claim(idle_client):
    """A claim computed for a DIFFERENT document cannot be laundered onto these bytes."""
    other = SUBMITTED + "\n# a different document\n"
    claim = _basis(input_sha256=sha256_hex(other.encode("utf-8")))
    _assert_rejected(idle_client, _form(claim), "basis_input_digest_mismatch")


def test_a_stale_solver_semantic_version_is_rejected(idle_client):
    """A backend that moved must not silently solve under different semantics."""
    _assert_rejected(
        idle_client,
        _form(_basis(), expected_solver_semantic_version="ortools/cp-sat@0"),
        "semantic_profile_mismatch",
    )


def test_a_stale_backend_capability_version_is_rejected(idle_client):
    _assert_rejected(
        idle_client,
        _form(_basis(), expected_backend_capability_version="nurse-scheduling-backend@0"),
        "semantic_profile_mismatch",
    )


def test_a_stale_submission_contract_version_is_rejected(idle_client):
    _assert_rejected(
        idle_client,
        _form(_basis(), submission_contract_version="optimize-yaml-v0"),
        "semantic_profile_mismatch",
    )


def test_a_partial_claim_is_rejected_rather_than_completed_with_defaults(idle_client):
    """Half a claim is a client bug; the server never guesses the rest."""
    form = _form(_basis())
    del form["serializer_version"]
    _assert_rejected(idle_client, form, "basis_claim_incomplete")


def test_an_unsupported_anonymization_mode_is_rejected(idle_client):
    _assert_rejected(
        idle_client,
        _form(_basis(), anonymization_mode="groups"),
        "basis_claim_incomplete",
    )


def test_a_basis_id_computed_over_different_fields_is_rejected(idle_client):
    """Any field the client encoded differently changes the id and is caught."""
    honest = _basis()
    forged = compute_basis_id(_basis(serializer_version="some-other-serializer"))
    _assert_rejected(idle_client, _form(honest, basis_id=forged), "basis_id_mismatch")


def test_options_the_client_guessed_wrong_fail_the_identity_comparison(idle_client):
    """The basis binds the server's RESOLVED options, not the client's assumption.

    The client here computed its id assuming `prettify: true` while submitting
    `prettify: false`, so the recomputed identity disagrees and no job is created
    under options the solver would never have used.
    """
    claimed = _basis(
        normalized_options=NormalizedOptions(solver="ortools/cp-sat", prettify=True, timeout_seconds=TIMEOUT_SECONDS)
    )
    _assert_rejected(idle_client, _form(claimed, prettify="false"), "basis_id_mismatch")


def test_a_rejected_claim_creates_no_job(idle_client):
    """Rejection happens before creation, so no capacity or evidence is consumed."""
    before = idle_client.post("/optimize", data=_form(_basis()))
    assert before.status_code == 202
    idle_client.post("/optimize", data=_form(_basis(), input_sha256="d" * 64))
    # The only job that exists is the accepted one; the rejected id never resolves.
    assert idle_client.get(f"/optimize/{before.json()['id']}").status_code == 200
