"""Real-Redis multi-process worker-loss gate: SIGKILL a live worker, recover.

This exercises the durability contract that a process-local in-memory store cannot
satisfy: a worker process claims a job on real Redis and actively renews its lease,
is killed with `SIGKILL` so renewal stops, and a separate replacement process
observes the expired lease and records terminal `worker_lost`. The gate runs only
when `NURSE_TEST_REDIS_URL` is configured; an explicitly configured but unreachable
endpoint fails hard rather than skipping.
"""

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

import multiprocessing
import os
import signal
import sys
import time
from uuid import uuid4

import pytest

from nurse_scheduling.server.jobs.controller import JobController
from nurse_scheduling.server.jobs.models import JobState, StoreLimits
from nurse_scheduling.server.stores.redis import RedisJobStore
from tests.server_support import real_redis_url

LEASE_SECONDS = 2.0


def _controller(store) -> JobController:
    return JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=3600,
        claim_lease_seconds=LEASE_SECONDS,
    )


def _hold_claim_forever(url: str, prefix: str, job_id: str, lease: float) -> None:
    """Child-process worker: claim the job and keep renewing until killed."""
    store = RedisJobStore(url=url, key_prefix=prefix)
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=3600,
        claim_lease_seconds=lease,
    )
    claimed = controller.claim_next_job("child-worker")
    if claimed is None:
        return
    while True:
        controller.renew_claim(claimed.id, "child-worker")
        time.sleep(lease / 3)


def _replacement_expire(url: str, prefix: str, job_id: str, lease: float, deadline_seconds: float) -> None:
    """Replacement-process maintenance: expire the abandoned claim to worker_lost.

    Exits 0 only after observing terminal `worker_lost`, so the parent asserts on
    a genuine second process rather than impersonating the replacement itself.
    """
    store = RedisJobStore(url=url, key_prefix=prefix)
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=3600,
        claim_lease_seconds=lease,
    )
    end = time.monotonic() + deadline_seconds
    while time.monotonic() < end:
        controller.expire_worker_claims()
        job = controller.get_job(job_id)
        if job.state.terminal:
            sys.exit(0 if job.failure is not None and job.failure.code == "worker_lost" else 2)
        time.sleep(0.25)
    sys.exit(3)


def _wait_for(predicate, timeout: float, interval: float = 0.1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def test_sigkilled_worker_becomes_worker_lost_in_replacement_process():
    url = real_redis_url()
    if url is None:
        pytest.skip("real Redis not available (set NURSE_TEST_REDIS_URL)")

    prefix = f"nurse_test:mp:{uuid4().hex}:v0"
    store = RedisJobStore(url=url, key_prefix=prefix)
    controller = _controller(store)
    job = controller.create_job(
        input_name="in.yaml",
        client_id="c",
        solver="ortools/cp-sat",
        prettify=None,
        timeout_seconds=300,
        input_bytes=b"x",
    )

    context = multiprocessing.get_context("spawn")
    worker_process = context.Process(target=_hold_claim_forever, args=(url, prefix, job.id, LEASE_SECONDS))
    worker_process.start()
    try:
        assert _wait_for(lambda: controller.get_job(job.id).state == JobState.RUNNING, timeout=15.0)
        # The lease is actively renewed across processes: the job stays RUNNING well
        # past one lease rather than expiring on its own.
        time.sleep(LEASE_SECONDS + 0.5)
        assert controller.get_job(job.id).state == JobState.RUNNING

        os.kill(worker_process.pid, signal.SIGKILL)
        worker_process.join(timeout=5)
        assert not worker_process.is_alive()

        # A genuine replacement PROCESS (not this pytest process) detects the
        # now-unrenewed claim and records terminal worker_lost.
        replacement = context.Process(
            target=_replacement_expire,
            args=(url, prefix, job.id, LEASE_SECONDS, LEASE_SECONDS * 3 + 5.0),
        )
        replacement.start()
        replacement.join(timeout=LEASE_SECONDS * 3 + 20.0)
        assert replacement.exitcode == 0

        # The parent only observes the durable outcome; it never performed the expiry.
        lost = controller.get_job(job.id)
        assert lost.state == JobState.FAILED
        assert lost.failure.code == "worker_lost"
    finally:
        if worker_process.is_alive():
            worker_process.kill()
            worker_process.join(timeout=5)
        keys = list(store._redis.scan_iter(f"{prefix}:*"))
        if keys:
            store._redis.delete(*keys)
