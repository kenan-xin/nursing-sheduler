"""Shared fixtures and helpers for server, store, and protocol tests."""

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

import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from threading import RLock
from uuid import uuid4

import pytest

from nurse_scheduling.server.jobs.models import Job, JobRequest, JobState
from nurse_scheduling.server.stores.memory import MemoryJobStore
from nurse_scheduling.server.stores.redis import RedisJobStore


# A minimal, always-feasible legacy strict scenario.
MINIMAL_SCENARIO = """
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
    - id: bob
shiftTypes:
  items:
    - id: day
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
"""


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp for building test jobs."""
    return datetime.now(timezone.utc)


def make_job(job_id: str = "job_test", *, solver: str = "ortools/cp-sat", created_at: datetime | None = None) -> Job:
    """Build a queued job for direct store tests."""
    return Job(
        id=job_id,
        state=JobState.QUEUED,
        request=JobRequest(input_name="in.yaml", client_id="client", solver=solver, prettify=None, timeout_seconds=300),
        created_at=created_at or utc_now(),
    )


def _make_memory_store(*, max_events_per_job: int = 1_000) -> MemoryJobStore:
    """Build an in-process store."""
    return MemoryJobStore(max_events_per_job=max_events_per_job)


class FakeredisLeaseCommitBoundary:
    """Share one reentrant critical section with fakeredis command execution."""

    def __init__(self, server, before_commit: Callable[[], None] | None = None):
        self._lock = RLock()
        server.lock = self._lock
        self._before_commit = before_commit or (lambda: None)

    @contextmanager
    def commit(self) -> Iterator[None]:
        self._before_commit()
        with self._lock:
            yield


def _make_fakeredis_store(
    *,
    max_events_per_job: int = 1_000,
    before_commit: Callable[[], None] | None = None,
) -> RedisJobStore:
    """Build a Redis store backed by an isolated fakeredis server."""
    import fakeredis

    server = fakeredis.FakeServer()
    commit_boundary = FakeredisLeaseCommitBoundary(server, before_commit)
    client = fakeredis.FakeStrictRedis(server=server)
    return RedisJobStore(
        url="redis://fake",
        key_prefix=f"nurse_test:{uuid4().hex}:v0",
        max_events_per_job=max_events_per_job,
        client=client,
        test_lease_commit_boundary=commit_boundary.commit,
    )


def real_redis_url() -> str | None:
    """Return the configured real Redis URL, or `None` when none is configured.

    When `NURSE_TEST_REDIS_URL` is set the endpoint must be reachable: an
    unreachable or authentication-rejecting endpoint fails hard rather than
    silently converting an explicit configuration into a skip. Only an unset
    variable yields `None` (the run legitimately has no real Redis).
    """
    url = os.environ.get("NURSE_TEST_REDIS_URL")
    if not url:
        return None
    import redis

    try:
        redis.Redis.from_url(url, socket_connect_timeout=2).ping()
    except redis.RedisError as error:
        raise RuntimeError(
            f"NURSE_TEST_REDIS_URL={url!r} is set but unreachable or rejected: {error}. "
            "Explicit Redis configuration must not be converted into a skip."
        ) from error
    return url


def _make_real_redis_store(*, max_events_per_job: int = 1_000) -> RedisJobStore:
    """Build a Redis store against a real Redis server with an isolated prefix."""
    url = real_redis_url()
    if url is None:
        pytest.skip("real Redis not available (set NURSE_TEST_REDIS_URL)")
    return RedisJobStore(
        url=url,
        key_prefix=f"nurse_test:{uuid4().hex}:v0",
        max_events_per_job=max_events_per_job,
    )


STORE_FACTORIES = {
    "memory": _make_memory_store,
    "fakeredis": _make_fakeredis_store,
    "redis": _make_real_redis_store,
}
