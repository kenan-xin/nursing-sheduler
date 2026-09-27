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
from datetime import datetime, timedelta, timezone
from threading import Lock
from unittest import mock
from uuid import uuid4

import pytest

from nurse_scheduling.server.jobs.models import Job, JobPurpose, JobRequest, JobState, WorkerLease
from nurse_scheduling.server.queue_state import QueueStateSnapshot, check_queue_invariants
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


def make_job(
    job_id: str = "job_test",
    *,
    solver: str = "ortools/cp-sat",
    created_at: datetime | None = None,
    purpose: JobPurpose = JobPurpose.ORDINARY,
) -> Job:
    """Build a queued job for direct store tests."""
    return Job(
        id=job_id,
        state=JobState.QUEUED,
        request=JobRequest(
            input_name="in.yaml",
            client_id="client",
            solver=solver,
            prettify=None,
            timeout_seconds=300,
            purpose=purpose,
        ),
        created_at=created_at or utc_now(),
    )


def register_lease(store, worker_id: str, *, now: datetime | None = None, seconds: float = 90.0) -> WorkerLease:
    """Register a live worker lease directly on a store (W6 lease API)."""
    now = now or utc_now()
    lease = WorkerLease(worker_id=worker_id, token=uuid4().hex, expires_at=now + timedelta(seconds=seconds))
    assert store.register_worker(lease, now), f"worker {worker_id} could not register"
    return lease


def claim(store, worker_id: str = "worker-1", *, now: datetime | None = None, seconds: float = 90.0, runtime=None):
    """Register a fresh lease for `worker_id` and claim the effective queue head with it.

    Returns `(job_or_none, lease)`. Replaces the T19 `store.claim_next(worker, now, deadline)`.
    """
    now = now or utc_now()
    lease = register_lease(store, worker_id, now=now, seconds=seconds)
    return store.claim_next_job(lease, now, runtime), lease


def assert_queue_invariants(store, *, context: str = "") -> QueueStateSnapshot:
    """Assert all six queue invariants against what the store actually persisted.

    Reads ONE atomic snapshot from the store rather than trusting what a transition
    reported about itself, so a transition that returned a plausible answer while
    leaving the indexes inconsistent still fails here. Returns the snapshot so a
    caller can make further assertions against the same consistent view.
    """
    snapshot = store.describe_queue_state()
    violations = check_queue_invariants(snapshot)
    assert not violations, f"queue invariants violated{' after ' + context if context else ''}: {violations}"
    return snapshot


def _make_memory_store(*, max_events_per_job: int = 1_000) -> MemoryJobStore:
    """Build an in-process store."""
    return MemoryJobStore(max_events_per_job=max_events_per_job)


_FROM_URL_PATCH_LOCK = Lock()
"""`mock.patch` of the process-global `redis.Redis.from_url` is not thread-safe: two racing
constructions can restore each other's patch and leak it into later real-Redis tests."""


def fakeredis_store(*, server=None, key_prefix: str | None = None, **kwargs) -> RedisJobStore:
    """Build the production Redis store over a fakeredis server, as the genie tests do.

    The store runs the SAME WATCH/MULTI code as against real Redis; only the
    connection factory is replaced.
    """
    import fakeredis
    import redis

    server = server or fakeredis.FakeServer()
    with (
        _FROM_URL_PATCH_LOCK,
        mock.patch.object(
            redis.Redis,
            "from_url",
            lambda url, **options: fakeredis.FakeRedis.from_url(url, server=server, **options),
        ),
    ):
        return RedisJobStore(url="redis://fake", key_prefix=key_prefix or f"nurse_test:{uuid4().hex}:v0", **kwargs)


def _make_fakeredis_store(*, max_events_per_job: int = 1_000) -> RedisJobStore:
    """Build a Redis store backed by an isolated fakeredis server."""
    return fakeredis_store(max_events_per_job=max_events_per_job)


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
