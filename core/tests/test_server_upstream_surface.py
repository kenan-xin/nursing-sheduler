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

from nurse_scheduling.scheduler import CANONICAL_SOLVER_CHOICES
from nurse_scheduling.server.auth import AuthCredential, create_stream_token, verify_stream_token
from nurse_scheduling.server.config import ClaimedPerformance, ServerSettings
from nurse_scheduling.server.solver_capabilities import SOLVER_CAPABILITIES

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
