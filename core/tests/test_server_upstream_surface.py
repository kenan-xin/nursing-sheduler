"""Upstream (genie) server surface ported from genie tests/test_serve.py until W6 restores it."""

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

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from nurse_scheduling.scheduler import CANONICAL_SOLVER_CHOICES
from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.auth import AuthCredential, create_stream_token, verify_stream_token
from nurse_scheduling.server.config import ClaimedPerformance, ServerSettings
from nurse_scheduling.server.semantic_profile import semantic_profile
from nurse_scheduling.server.solver_capabilities import SOLVER_CAPABILITIES
from nurse_scheduling.server.stores.memory import MemoryJobStore
from tests.server_support import MINIMAL_SCENARIO

AUTH_TOKEN = "integration-shared-token"
AUTH_TOKENS = (
    AuthCredential(id="institution-a", token="institution-a-auth-token"),
    AuthCredential(id="person_b", token="person-b-auth-token"),
)


def _settings(**updates) -> ServerSettings:
    values = {
        "claim_poll_seconds": 0.005,
        "maintenance_interval_seconds": 60,
        "sse_keepalive_seconds": 0.01,
    }
    values.update(updates)
    return ServerSettings(**values)


class SuccessfulRunner:
    """Unused while background work is off; the v2 runner contract otherwise."""

    def run(self, job, input_bytes, *, event_callback, should_stop):
        raise AssertionError("background work is off in these tests")


def _client(runner=None, *, start_background=True, settings=None) -> TestClient:
    app = create_app(
        settings=settings or _settings(),
        store=MemoryJobStore(),
        runner=runner or SuccessfulRunner(),
        start_background=start_background,
    )
    return TestClient(app)


def _create(client: TestClient, headers=None, **data):
    # v2: a valid strict scenario, because P5 canonicalizes before the job exists.
    return client.post(
        "/optimize",
        data={"yaml_content": MINIMAL_SCENARIO, **data},
        headers=headers,
    )


def _auth_header(token: str = AUTH_TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


MISSING_JOB_ID = "job_does_not_exist"


def _stream_status(client: TestClient, job_id: str, query: str = "", **kwargs) -> int:
    """Return the status of an event-stream request without consuming the stream.

    An unknown job is rejected with 404 only after credentials are accepted, so the status
    distinguishes an authorization failure from a missing job without opening a stream.
    """
    return client.get(f"/optimize/{job_id}/events{query}", **kwargs).status_code


def test_direct_settings_reserve_no_slot_so_upstream_shapes_stay_valid():
    settings = ServerSettings(max_pending_jobs=1)
    assert settings.ordinary_reserved_slots == 0


def test_env_settings_keep_the_v2_reserve_and_prettify_default(monkeypatch):
    for name in ("JOB_ORDINARY_RESERVED_SLOTS", "JOB_MAX_PENDING", "OPTIMIZE_DEFAULT_PRETTIFY"):
        monkeypatch.delenv(name, raising=False)
    settings = ServerSettings.from_env()
    assert settings.ordinary_reserved_slots == 1
    assert settings.max_pending_jobs == 32  # genie default; compose and dev.sh set 8
    assert settings.default_prettify is False
    assert settings.redis_key_prefix == "nurse_scheduling:jobs:v1"
    assert settings.solver_ids == ("ortools/cp-sat",)
    assert settings.auth_required is False and settings.auth_token is None


def test_claim_lease_keeps_its_v2_name_until_w6(monkeypatch):
    monkeypatch.setenv("JOB_CLAIM_LEASE_SECONDS", "12")
    assert ServerSettings.from_env().claim_lease_seconds == 12.0


def test_solver_capability_registry_matches_canonical_choices():
    assert tuple(item.value for item in SOLVER_CAPABILITIES) == CANONICAL_SOLVER_CHOICES

    by_value = {item.value: item for item in SOLVER_CAPABILITIES}
    expected = {
        "ortools/cp-sat": (True, True, True),
    }
    for selector, capabilities in by_value.items():
        assert (
            capabilities.graceful_timeout,
            capabilities.finish_now,
            capabilities.intermediate_scores,
        ) == expected.get(selector, (False, False, False))

    assert by_value["ortools/cp-sat"].label == "OR-Tools | CP-SAT"


def test_server_settings_load_optimization_options_from_env(monkeypatch):
    monkeypatch.setenv("OPTIMIZE_SOLVERS", " ORTOOLS/CP-SAT, PULP/HIGHS ")
    monkeypatch.setenv("OPTIMIZE_DEFAULT_SOLVER", " PULP/HIGHS ")
    monkeypatch.setenv("OPTIMIZE_MIN_TIMEOUT_SECONDS", "10")
    monkeypatch.setenv("OPTIMIZE_DEFAULT_TIMEOUT_SECONDS", "120")
    monkeypatch.setenv("OPTIMIZE_MAX_TIMEOUT_SECONDS", "900")
    monkeypatch.setenv("OPTIMIZE_DEFAULT_PRETTIFY", "false")

    settings = ServerSettings.from_env()

    assert settings.solver_ids == ("ortools/cp-sat", "pulp/highs")
    assert settings.default_solver == "pulp/highs"
    assert settings.min_timeout_seconds == 10
    assert settings.default_timeout_seconds == 120
    assert settings.max_timeout_seconds == 900
    assert settings.default_prettify is False


def test_server_settings_load_claimed_performance_from_env(monkeypatch):
    monkeypatch.setenv("CLAIMED_PERFORMANCE_SCORE", "41.524445")
    monkeypatch.setenv("CLAIMED_PERFORMANCE_APP_VERSION", "v0.2.0-66-g959adc4")
    monkeypatch.setenv("CLAIMED_PERFORMANCE_MEASURED_AT", "2026-08-28T19:12:54.974377+00:00")

    claimed_performance = ServerSettings.from_env().claimed_performance

    assert claimed_performance == ClaimedPerformance(
        score=41.524445,
        app_version="v0.2.0-66-g959adc4",
        measured_at=datetime(2026, 8, 28, 19, 12, 54, 974377, tzinfo=timezone.utc),
    )


def test_server_settings_require_complete_claimed_performance(monkeypatch):
    monkeypatch.setenv("CLAIMED_PERFORMANCE_SCORE", "41.524445")

    with pytest.raises(ValueError, match="must be set together"):
        ServerSettings.from_env()


def test_server_settings_require_timezone_in_claimed_performance_time(monkeypatch):
    monkeypatch.setenv("CLAIMED_PERFORMANCE_SCORE", "41.524445")
    monkeypatch.setenv("CLAIMED_PERFORMANCE_APP_VERSION", "v0.2.0-66-g959adc4")
    monkeypatch.setenv("CLAIMED_PERFORMANCE_MEASURED_AT", "2026-08-28T19:12:54")

    with pytest.raises(ValueError, match="must include a timezone"):
        ServerSettings.from_env()


def test_stream_tokens_are_scoped_signed_and_expiring():
    issued_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    token = create_stream_token(AUTH_TOKEN, "job_1", now=issued_at, ttl_seconds=60)

    assert verify_stream_token(AUTH_TOKEN, "job_1", token, now=issued_at)
    assert verify_stream_token(AUTH_TOKEN, "job_1", token, now=issued_at + timedelta(seconds=60))
    assert not verify_stream_token(AUTH_TOKEN, "job_1", token, now=issued_at + timedelta(seconds=61))
    assert not verify_stream_token(AUTH_TOKEN, "job_2", token, now=issued_at)
    assert not verify_stream_token("a-different-shared-token", "job_1", token, now=issued_at)
    assert not verify_stream_token(AUTH_TOKEN, "job_1", None, now=issued_at)


@pytest.mark.parametrize(
    "raw_value,expected",
    [("true", True), ("1", True), ("yes", True), ("on", True), ("false", False), ("0", False), ("off", False)],
)
def test_required_authentication_accepts_boolean_spellings(monkeypatch, raw_value, expected):
    monkeypatch.setenv("API_AUTH_REQUIRED", raw_value)
    monkeypatch.setenv("API_AUTH_TOKEN", AUTH_TOKEN)

    assert ServerSettings.from_env().auth_required is expected


def test_required_authentication_rejects_a_non_boolean_value(monkeypatch):
    monkeypatch.setenv("API_AUTH_REQUIRED", "maybe")
    monkeypatch.setenv("API_AUTH_TOKEN", AUTH_TOKEN)

    with pytest.raises(ValueError, match="API_AUTH_REQUIRED must be a boolean"):
        ServerSettings.from_env()


@pytest.mark.parametrize(
    "configured,expected",
    [
        (None, None),
        ("", None),
        ("   ", None),
        (f"  {AUTH_TOKEN}  ", AUTH_TOKEN),
    ],
)
def test_blank_shared_tokens_disable_authentication(configured, expected):
    assert _settings(auth_token=configured).auth_token == expected


def test_authentication_stays_off_by_default_for_local_runs(monkeypatch):
    monkeypatch.delenv("API_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("API_AUTH_TOKENS", raising=False)
    monkeypatch.delenv("API_AUTH_REQUIRED", raising=False)
    settings = ServerSettings.from_env()

    assert settings.auth_required is False
    assert settings.auth_token is None


def test_enabled_authentication_requires_a_token(monkeypatch):
    monkeypatch.setenv("API_AUTH_REQUIRED", "true")
    monkeypatch.delenv("API_AUTH_TOKEN", raising=False)

    with pytest.raises(ValueError, match="API_AUTH_REQUIRED is set, so API_AUTH_TOKEN or API_AUTH_TOKENS"):
        ServerSettings.from_env()

    monkeypatch.setenv("API_AUTH_TOKEN", "   ")
    with pytest.raises(ValueError, match="API_AUTH_REQUIRED is set, so API_AUTH_TOKEN or API_AUTH_TOKENS"):
        ServerSettings.from_env()


def test_enabled_authentication_rejects_a_short_token(monkeypatch):
    monkeypatch.setenv("API_AUTH_REQUIRED", "true")
    monkeypatch.setenv("API_AUTH_TOKEN", "x")

    with pytest.raises(ValueError, match="API_AUTH_TOKEN must be at least 16 characters"):
        ServerSettings.from_env()


def test_enabled_authentication_accepts_a_configured_token(monkeypatch):
    monkeypatch.setenv("API_AUTH_REQUIRED", "true")
    monkeypatch.setenv("API_AUTH_TOKEN", AUTH_TOKEN)
    settings = ServerSettings.from_env()

    assert settings.auth_required is True
    assert settings.auth_token == AUTH_TOKEN


def test_enabled_authentication_accepts_identified_tokens_without_the_legacy_token(monkeypatch):
    monkeypatch.setenv("API_AUTH_REQUIRED", "true")
    monkeypatch.delenv("API_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("API_AUTH_TOKENS", '{"institution-a":"institution-a-auth-token"}')

    settings = ServerSettings.from_env()

    assert settings.auth_required is True
    assert settings.auth_token is None
    assert settings.auth_tokens == AUTH_TOKENS[:1]


def test_info_and_readiness_report_status_without_caching():
    with _client(start_background=False) as client:
        info = client.get("/info")
        ready = client.get("/ready")

        assert info.json() == {
            "status": "ready",
            "service_name": "nurse-scheduling-api",
            "api_version": "0.2.0",
            "app_version": client.app.state.app_version,
            "deployment_id": client.app.state.deployment_id,
            "instance_id": client.app.state.instance_id,
            "started_at": client.app.state.started_at.isoformat(),
            "job_backend": "memory",
            "job_store_id": client.app.state.job_store.store_id,
            "auth": {"required": False, "scheme": "bearer"},
            "claimed_performance": None,
            "jobs": {"running": 0, "queued": 0, "cancelling": 0},
            "workers": {"online": 0},
            "semantic_profile": semantic_profile(),  # v2 (P8)
        }
        assert ready.json() == {"status": "ready"}
        assert info.headers["cache-control"] == "no-store"
        assert ready.headers["cache-control"] == "no-store"
        assert client.get("/health").status_code == 200  # v2 keeps the /health shim (P11)


def test_info_reports_self_claimed_performance_with_provenance():
    claimed_performance = ClaimedPerformance(
        score=41.524445,
        app_version="v0.2.0-66-g959adc4",
        measured_at=datetime(2026, 8, 28, 19, 12, 54, tzinfo=timezone.utc),
    )

    with _client(start_background=False, settings=_settings(claimed_performance=claimed_performance)) as client:
        info = client.get("/info")

        assert info.json()["claimed_performance"] == {
            "score": 41.524445,
            "app_version": "v0.2.0-66-g959adc4",
            "measured_at": "2026-08-28T19:12:54+00:00",
        }


def test_info_reports_cancelling_jobs_separately():
    with _client(start_background=False) as client:
        created = _create(client).json()
        controller = client.app.state.job_controller
        # v2: no worker lease registry until W6; claim by worker id.
        assert controller.claim_next_job("test-worker") is not None
        controller.cancel_job(created["id"])

        info = client.get("/info")

        assert info.json()["jobs"] == {"running": 0, "queued": 0, "cancelling": 1}
        # v2 bridge (P12): workers.online reads the process worker, idle here.
        assert info.json()["workers"] == {"online": 0}


def test_info_and_readiness_fail_when_job_store_is_unavailable():
    class UnhealthyStore(MemoryJobStore):
        def check_health(self):
            raise ConnectionError("store unavailable")

    app = create_app(
        settings=_settings(),
        store=UnhealthyStore(),
        runner=SuccessfulRunner(),
        start_background=False,
    )
    with TestClient(app) as client:
        info = client.get("/info")
        ready = client.get("/ready")

    assert info.status_code == 503
    assert info.json()["status"] == "unavailable"
    assert info.json()["reason"] == "job_store_unavailable"
    assert info.json()["instance_id"] == app.state.instance_id
    assert ready.status_code == 503
    assert ready.json()["reason"] == "job_store_unavailable"


def test_info_and_readiness_fail_when_job_worker_stops():
    app = create_app(
        settings=_settings(),
        store=MemoryJobStore(),
        runner=SuccessfulRunner(),
    )
    with TestClient(app) as client:
        app.state.job_worker.stop()
        info = client.get("/info")
        ready = client.get("/ready")

    assert info.status_code == 503
    assert info.json()["reason"] == "job_worker_unavailable"
    assert ready.status_code == 503
    assert ready.json()["reason"] == "job_worker_unavailable"


def test_app_startup_fails_when_a_configured_solver_is_unavailable(monkeypatch):
    monkeypatch.setattr(
        "nurse_scheduling.server.solver_options.solver_is_available",
        lambda _solver_id: False,
    )

    with pytest.raises(ValueError, match="Configured solver is unavailable: ortools/cp-sat"):
        create_app(settings=_settings(), start_background=False)


def test_optimization_options_use_configured_canonical_solver_metadata(monkeypatch):
    monkeypatch.setattr(
        "nurse_scheduling.server.app.validate_solver_availability",
        lambda _solver_ids: None,
    )
    settings = _settings(
        solver_ids=("ortools/cp-sat", "pulp/highs"),
        default_solver="pulp/highs",
        min_timeout_seconds=10,
        default_timeout_seconds=120,
        max_timeout_seconds=900,
        default_prettify=False,
    )

    with _client(start_background=False, settings=settings) as client:
        response = client.get("/optimize/options")

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == {
        "schema_version": "alpha",
        "solver": {
            "default": "pulp/highs",
            "choices": [
                {
                    "value": "ortools/cp-sat",
                    "label": "OR-Tools | CP-SAT",
                    "compute": "cpu",
                    "timeout": {"default": 120, "minimum": 10, "maximum": 900},
                    "controls": {"cancel_running": True, "finish_now": True},
                },
                {
                    "value": "pulp/highs",
                    "label": "PuLP | HiGHS",
                    "compute": "cpu",
                    "timeout": {"default": 120, "minimum": 10, "maximum": 900},
                    "controls": {"cancel_running": True, "finish_now": False},
                },
            ],
        },
        "prettify": {"default": False},
    }


def test_job_creation_enforces_advertised_options():
    settings = _settings(
        min_timeout_seconds=10,
        default_timeout_seconds=30,
        max_timeout_seconds=60,
        default_prettify=False,
    )
    with _client(start_background=False, settings=settings) as client:
        defaulted = _create(client)
        # v2 (P5): only the exact CP-SAT selector passes parse_solver, before the allowlist.
        normalized = _create(client, solver="ortools/cp-sat", timeout="10", prettify="true")
        disabled_solver = _create(client, solver="pulp/highs")
        unknown_solver = _create(client, solver="unknown/solver")
        below_minimum = _create(client, timeout="9")
        above_maximum = _create(client, timeout="61")
        non_integer = _create(client, timeout="10.5")

    assert defaulted.status_code == 202
    assert defaulted.json()["request"]["solver"] == "ortools/cp-sat"
    assert defaulted.json()["request"]["prettify"] is False
    assert defaulted.json()["request"]["timeout_seconds"] == 30
    assert normalized.status_code == 202
    assert normalized.json()["request"]["solver"] == "ortools/cp-sat"
    assert normalized.json()["request"]["timeout_seconds"] == 10
    assert normalized.json()["request"]["prettify"] is True
    assert disabled_solver.status_code == 422
    assert disabled_solver.json()["error"]["code"] == "unsupported_solver"
    assert unknown_solver.status_code == 422
    assert below_minimum.status_code == 400
    assert above_maximum.status_code == 400
    assert non_integer.status_code == 422


def test_client_cookie_is_marked_secure_when_the_deployment_says_so():
    # A TLS-terminating proxy forwards plain HTTP, so the request scheme alone
    # would leave the cookie unmarked on an HTTPS deployment.
    with _client(start_background=False, settings=_settings()) as client:
        response = _create(client)  # v2: the cookie is set only for an admitted job
        assert "secure" not in response.headers["set-cookie"].lower()

    with _client(start_background=False, settings=_settings(cookie_secure=True)) as client:
        response = _create(client)
        assert "; Secure" in response.headers["set-cookie"]


def test_declared_oversize_body_is_refused_before_the_upload_is_buffered():
    # FastAPI resolves upload parameters before the route runs, so a route-level
    # size check only fires once Starlette has spooled the whole body.
    settings = _settings(max_yaml_bytes=1024)
    with _client(start_background=False, settings=settings) as client:
        refused = client.post(
            "/optimize",
            files={"file": ("schedule.yaml", b"x" * (1024 * 1024), "application/x-yaml")},
        )
        assert refused.status_code == 413
        assert refused.json()["error"]["code"] == "request_too_large"

        # A body the middleware admits still reaches the route's own limit.
        oversized = client.post(
            "/optimize",
            files={"file": ("schedule.yaml", b"x" * 1025, "application/x-yaml")},
        )
        assert oversized.status_code == 413
        assert oversized.json()["detail"] == "Scheduling YAML is too large"


def test_file_input_uses_configured_limit_above_multipart_text_default():
    max_yaml_bytes = 1024 * 1024 + 1
    settings = _settings(max_yaml_bytes=max_yaml_bytes)
    with _client(start_background=False, settings=settings) as client:
        # v2 (P5): the accepted file must be a valid scenario, padded to the limit.
        scenario = MINIMAL_SCENARIO.encode("utf-8")
        padded = scenario + b"#" * (max_yaml_bytes - len(scenario))
        accepted = client.post(
            "/optimize",
            files={"file": ("schedule.yaml", padded, "application/x-yaml")},
        )
        assert accepted.status_code == 202

        oversized = client.post(
            "/optimize",
            files={"file": ("schedule.yaml", b"x" * (max_yaml_bytes + 1), "application/x-yaml")},
        )
        assert oversized.status_code == 413


def test_discovery_routes_stay_public_when_authentication_is_enabled():
    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        info = client.get("/info")

        assert info.status_code == 200
        assert info.json()["auth"] == {"required": True, "scheme": "bearer"}
        assert client.get("/ready").status_code == 200


def test_event_stream_links_carry_a_scoped_token_when_authentication_is_enabled():
    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        job = _create(client, headers=_auth_header()).json()
        events_path, separator, query = job["links"]["events"].partition("?")

        assert events_path == f"/optimize/{job['id']}/events"
        assert separator == "?"
        assert query.startswith("token=")


def test_event_stream_links_stay_plain_without_authentication():
    with _client(start_background=False) as client:
        job = _create(client).json()

        assert job["links"]["events"] == f"/optimize/{job['id']}/events"


def test_event_stream_accepts_either_the_shared_token_or_a_stream_token():
    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        stream_token = create_stream_token(AUTH_TOKEN, MISSING_JOB_ID, ttl_seconds=60)

        assert _stream_status(client, MISSING_JOB_ID, f"?token={stream_token}") == 404
        assert _stream_status(client, MISSING_JOB_ID, headers=_auth_header()) == 404


def test_identified_token_mints_a_resolvable_stream_token_without_a_credential_hint():
    credential = AUTH_TOKENS[0]
    with _client(start_background=False, settings=_settings(auth_tokens=AUTH_TOKENS)) as client:
        job = _create(client, headers=_auth_header(credential.token)).json()
        token = job["links"]["events"].split("token=", 1)[1]

        # Nothing stable and key-derived may reach a URL, so the token carries only the
        # job's expiry and signature and the server tries each configured key.
        assert credential.id not in token
        expiry, _, signature = token.partition(".")
        assert expiry.isdigit() and signature
        assert verify_stream_token(credential.token, job["id"], token)
        assert not verify_stream_token(AUTH_TOKENS[1].token, job["id"], token)

    with _client(start_background=False, settings=_settings(auth_tokens=AUTH_TOKENS)) as client:
        assert _stream_status(client, job["id"], f"?token={token}") == 404


def test_stream_tokens_from_different_keys_never_share_a_prefix():
    first, second = AUTH_TOKENS[0], AUTH_TOKENS[1]
    with _client(start_background=False, settings=_settings(auth_tokens=AUTH_TOKENS)) as client:
        first_job = _create(client, headers=_auth_header(first.token)).json()
        second_job = _create(client, headers=_auth_header(second.token)).json()

    first_token = first_job["links"]["events"].split("token=", 1)[1]
    second_token = second_job["links"]["events"].split("token=", 1)[1]

    # A per-key prefix would correlate every stream URL a key ever opens.
    assert first_token.count(".") == second_token.count(".") == 1
    assert first_token.split(".")[1] != second_token.split(".")[1]


def test_stream_tokens_are_rejected_for_a_job_created_with_another_key():
    first, second = AUTH_TOKENS[0], AUTH_TOKENS[1]
    with _client(start_background=False, settings=_settings(auth_tokens=AUTH_TOKENS)) as client:
        job = _create(client, headers=_auth_header(first.token)).json()
        forged = create_stream_token(second.token, "another-job", ttl_seconds=60)

        assert _stream_status(client, job["id"], f"?token={forged}") == 401


def test_removing_an_identified_key_revokes_its_stream_tokens():
    credential = AUTH_TOKENS[0]
    with _client(start_background=False, settings=_settings(auth_tokens=AUTH_TOKENS)) as client:
        job = _create(client, headers=_auth_header(credential.token)).json()
        token = job["links"]["events"].split("token=", 1)[1]

    with _client(start_background=False, settings=_settings(auth_tokens=AUTH_TOKENS[1:])) as client:
        assert _stream_status(client, job["id"], f"?token={token}") == 401


def test_event_stream_rejects_missing_or_unusable_stream_tokens():
    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        other_job_token = create_stream_token(AUTH_TOKEN, "job_for_someone_else", ttl_seconds=60)

        assert _stream_status(client, MISSING_JOB_ID) == 401
        assert _stream_status(client, MISSING_JOB_ID, f"?token={other_job_token}") == 401
        assert _stream_status(client, MISSING_JOB_ID, "?token=9999999999.deadbeef") == 401
        assert _stream_status(client, MISSING_JOB_ID, "?token=nonsense") == 401
        assert _stream_status(client, MISSING_JOB_ID, "?token=not-a-number.deadbeef") == 401
        assert _stream_status(client, MISSING_JOB_ID, "?token=") == 401


def test_stream_tokens_do_not_authorize_other_routes():
    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        stream_token = create_stream_token(AUTH_TOKEN, MISSING_JOB_ID, ttl_seconds=60)

        assert client.get(f"/optimize/options?token={stream_token}").status_code == 401


def test_browser_preflight_allows_the_authorization_header():
    """Browsers send the token only if the preflight advertises the header as allowed."""
    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        response = client.options(
            "/optimize/options",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )

        assert response.status_code == 200
        allowed = response.headers["access-control-allow-headers"].lower()
        assert "authorization" in allowed or allowed == "*"
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_generated_docs_are_disabled_when_authentication_is_enabled():
    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        for path in ("/openapi.json", "/docs", "/redoc"):
            assert client.get(path).status_code == 404
            assert client.get(path, headers=_auth_header()).status_code == 404


def test_stream_token_lifetime_covers_the_longest_allowed_run():
    """A stream must stay authorized for a full optimization plus its termination grace."""
    settings = _settings(max_timeout_seconds=120, default_timeout_seconds=60, timeout_grace_seconds=5.5)

    assert settings.stream_token_ttl_seconds == 120 + 6 + 10

    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        job = _create(client, headers=_auth_header()).json()
        expiry = int(job["links"]["events"].split("token=")[1].split(".")[0])
        expected_ttl = client.app.state.settings.stream_token_ttl_seconds
        issued_ttl = expiry - int(datetime.now(timezone.utc).timestamp())

        assert expected_ttl - 5 <= issued_ttl <= expected_ttl


def test_authentication_can_be_turned_off_deliberately(monkeypatch):
    monkeypatch.setenv("API_AUTH_REQUIRED", "false")
    monkeypatch.delenv("API_AUTH_TOKEN", raising=False)
    settings = ServerSettings.from_env()

    assert settings.auth_required is False
    assert settings.auth_token is None
    with _client(start_background=False, settings=_settings(auth_required=False)) as client:
        assert client.get("/optimize/options").status_code == 200


def test_a_token_alone_still_enables_authentication():
    with _client(start_background=False, settings=_settings(auth_token=AUTH_TOKEN)) as client:
        assert client.get("/optimize/options").status_code == 401
        assert client.get("/optimize/options", headers=_auth_header()).status_code == 200


def test_a_non_cp_sat_solver_stays_a_422_even_when_the_allowlist_names_it(monkeypatch):
    monkeypatch.setattr("nurse_scheduling.server.app.validate_solver_availability", lambda _solver_ids: None)
    settings = ServerSettings(job_backend="memory", solver_ids=("ortools/cp-sat", "pulp/glpk"))
    with TestClient(create_app(settings=settings, start_background=False)) as client:
        response = client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO, "solver": "pulp/glpk"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unsupported_solver"


def test_runtime_identity_reports_api_version_0_2_0():
    with TestClient(create_app(settings=ServerSettings(job_backend="memory"), start_background=False)) as client:
        assert client.get("/info").json()["api_version"] == "0.2.0"
        assert client.get("/health").json()["apiVersion"] == "0.2.0"


def test_info_reports_job_activity_and_the_process_worker():
    # v2 form of genie test_info_reports_shared_job_and_worker_activity: no lease
    # registry until W6, so workers.online reads the running process worker (P12).
    with _client() as client:
        body = client.get("/info").json()
    assert body["workers"] == {"online": 1}
    assert body["jobs"] == {"running": 0, "queued": 0, "cancelling": 0}
