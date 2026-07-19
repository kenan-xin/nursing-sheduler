"""Runtime deployment identity and job-store identity behavior."""

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

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock
from uuid import uuid4

import pytest
import redis

from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.config import ServerSettings
from nurse_scheduling.server.retry import DEFAULT_RETRY_MAX_ATTEMPTS
from nurse_scheduling.server.runtime_identity import get_deployment_id
from nurse_scheduling.server.stores import redis as redis_store
from nurse_scheduling.server.stores.memory import MemoryJobStore
from nurse_scheduling.server.stores.redis import RedisJobStore
from tests.server_support import real_redis_url


def _fakeredis_store(*, key_prefix: str | None = None, server=None) -> RedisJobStore:
    """Build a fakeredis-backed store, optionally sharing one server namespace."""
    import fakeredis

    server = server or fakeredis.FakeServer()
    client = fakeredis.FakeStrictRedis(server=server)
    return RedisJobStore(
        url="redis://fake",
        key_prefix=key_prefix or f"nurse_test:identity:{uuid4().hex}:v0",
        client=client,
    )


def test_runtime_deployment_identity_is_shared_within_one_server_launch(monkeypatch):
    supervisor = type("Supervisor", (), {"pid": 123})()
    monkeypatch.setattr("nurse_scheduling.server.runtime_identity.parent_process", lambda: supervisor)
    monkeypatch.setattr("nurse_scheduling.server.runtime_identity.socket.gethostname", lambda: "container-123")
    monkeypatch.setattr("nurse_scheduling.server.runtime_identity._boot_marker", lambda: "boot-123")
    monkeypatch.setattr(
        "nurse_scheduling.server.runtime_identity._process_start_marker",
        lambda _pid: "start-123",
    )

    first = get_deployment_id()
    second = get_deployment_id()

    assert first == second
    assert first.startswith("deployment-")

    monkeypatch.setattr(
        "nurse_scheduling.server.runtime_identity._process_start_marker",
        lambda _pid: "start-456",
    )
    assert get_deployment_id() != first


def test_default_memory_store_uses_the_process_instance_identity():
    app = create_app(settings=ServerSettings(job_backend="memory"), start_background=False)

    assert app.state.job_store.store_id == app.state.instance_id


def test_memory_store_identity_can_match_its_process_instance():
    store = MemoryJobStore(store_id="instance-123")

    assert store.store_id == "instance-123"


def test_memory_store_rejects_empty_identity():
    with pytest.raises(ValueError, match="store_id must not be empty"):
        MemoryJobStore(store_id=" ")


def test_redis_store_builds_bounded_and_streaming_clients(monkeypatch):
    operation_client = Mock()
    operation_client.get.return_value = b"existing-store-id"
    stream_client = Mock()
    from_url = Mock(side_effect=[operation_client, stream_client])
    monkeypatch.setattr(redis_store.redis.Redis, "from_url", from_url)

    store = RedisJobStore(
        url="redis://redis.example/0",
        key_prefix="test:jobs",
        event_stream_keepalive_seconds=2.5,
    )

    assert from_url.call_args_list[0].kwargs["socket_timeout"] == redis_store.REDIS_OPERATION_TIMEOUT_SECONDS
    assert from_url.call_args_list[1].kwargs["socket_timeout"] == 2.5 + redis_store.SOCKET_TIMEOUT_MARGIN_SECONDS
    assert store._stream_redis is stream_client
    operation_client.ping.assert_called_once_with()

    # check_health reads the identity key once and never falls back to PING.
    operation_client.reset_mock()
    operation_client.get.return_value = b"existing-store-id"
    store.check_health()
    operation_client.get.assert_called_once_with(store._store_id_key)
    operation_client.ping.assert_not_called()


def test_redis_store_identity_is_shared_by_one_namespace():
    import fakeredis

    server = fakeredis.FakeServer()
    prefix = f"nurse_test:identity:{uuid4().hex}"

    with ThreadPoolExecutor(max_workers=8) as executor:
        shared = list(executor.map(lambda _index: _fakeredis_store(key_prefix=prefix, server=server), range(8)))
    separate = _fakeredis_store(key_prefix=f"{prefix}:separate", server=server)

    assert len({store.store_id for store in shared}) == 1
    assert shared[0].store_id != separate.store_id


def test_redis_store_health_rejects_identity_change():
    store = _fakeredis_store()
    startup_store_id = store.store_id
    store._redis.set(store._store_id_key, "replacement-store-id")

    with pytest.raises(redis.RedisError, match="identity changed"):
        store.check_health()

    assert store.store_id == startup_store_id


def test_redis_store_health_does_not_retry_failed_identity_reads(monkeypatch):
    store = _fakeredis_store()
    get = Mock(side_effect=redis.TimeoutError("timed out"))
    monkeypatch.setattr(store._redis, "get", get)

    with pytest.raises(redis.TimeoutError, match="timed out"):
        store.check_health()

    get.assert_called_once_with(store._store_id_key)


def test_redis_store_identity_failure_is_fatal_during_construction(monkeypatch):
    client = Mock()
    client.get.return_value = None
    monkeypatch.setattr(redis_store.redis.Redis, "from_url", Mock(return_value=client))
    monkeypatch.setattr("nurse_scheduling.server.retry.time.sleep", lambda _seconds: None)

    with pytest.raises(redis.RedisError, match="identity could not be initialized"):
        RedisJobStore(url="redis://redis.example/0", key_prefix="test:jobs")

    assert client.get.call_count == DEFAULT_RETRY_MAX_ATTEMPTS * 2


def test_real_redis_store_identity_persists_across_reconnects():
    url = real_redis_url()
    if url is None:
        pytest.skip("real Redis not available (set NURSE_TEST_REDIS_URL)")
    prefix = f"nurse_test:identity:{uuid4().hex}:v0"
    first = RedisJobStore(url=url, key_prefix=prefix)
    second = RedisJobStore(url=url, key_prefix=prefix)

    assert first.store_id == second.store_id
    second.check_health()
