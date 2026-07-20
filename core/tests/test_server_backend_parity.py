"""Ported upstream lifecycle, concurrency, lease, and store-contract parity tests.

These adapt the pinned upstream `test_optimize_job_backends.py` coverage to the
rebuild's memory/fakeredis/real-Redis fixtures so the migration keeps its
lifecycle, cancellation, revision, concurrency, retention, and Redis-specific
guarantees. Real Redis runs whenever `NURSE_TEST_REDIS_URL` is set; an explicitly
configured but unreachable endpoint fails hard rather than skipping.
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

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
import redis

from nurse_scheduling.server.errors import JobCapacityError, JobNotFoundError, StoreWriteConflictError
from nurse_scheduling.server.jobs.controller import JobController
from nurse_scheduling.server.jobs.models import (
    JobFailure,
    JobState,
    OptimizationOutcome,
    OptimizationResult,
    StoreLimits,
    StoredArtifact,
)
from nurse_scheduling.server.stores.memory import MemoryJobStore
from nurse_scheduling.server.stores.redis import RedisJobStore
from tests.server_support import _make_fakeredis_store as make_fakeredis_store
from tests.server_support import real_redis_url


def _controller(store, *, max_pending=8, max_retained=32, now=None):
    clock = (lambda: now) if now is not None else (lambda: datetime.now(timezone.utc))
    sequence = iter(f"job_{index}" for index in range(1000))
    return JobController(
        store,
        limits=StoreLimits(max_pending=max_pending, max_retained=max_retained),
        retention_seconds=60,
        claim_lease_seconds=30,
        clock=clock,
        id_factory=lambda: next(sequence),
    )


def _create(controller, input_name="input.yaml"):
    return controller.create_job(
        input_name=input_name,
        client_id="client",
        solver="ortools/cp-sat",
        prettify=True,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )


# --- Lifecycle and event ordering --------------------------------------------


def test_store_round_trips_lifecycle_input_events_and_artifact(store):
    controller = _controller(store)
    created = _create(controller)
    assert created.state == JobState.QUEUED
    assert controller.get_input(created.id) == b"apiVersion: alpha\n"

    claimed = controller.claim_next_job("worker")
    assert claimed is not None and claimed.state == JobState.RUNNING
    controller.record_event(claimed.id, "job.phase_changed", {"message": "Solving"}, worker_id="worker")
    artifact = StoredArtifact("input.xlsx", "application/test", b"xlsx")
    completed = controller.complete_job(
        claimed.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 42, "OPTIMAL", "optimality_proven"),
        artifact,
        worker_id="worker",
    )
    assert completed.state == JobState.COMPLETED
    assert controller.get_artifact(completed.id, "input.xlsx") == artifact

    events = [e for e in controller.stream_events(completed.id, after_id=None, keepalive_seconds=0.01) if e is not None]
    assert [event.type for event in events] == [
        "job.state_changed",
        "job.state_changed",
        "job.phase_changed",
        "job.state_changed",
        "job.result_available",
    ]


def test_store_rejects_events_from_stale_workers_and_terminal_jobs(store):
    controller = _controller(store)
    _create(controller)
    claimed = controller.claim_next_job("worker")
    assert claimed is not None

    accepted = controller.record_score_and_event(claimed.id, 42, {"source": "accepted"}, worker_id="worker")
    stale = controller.record_event(claimed.id, "job.phase_changed", {"source": "stale"}, worker_id="other-worker")
    assert stale.revision == accepted.revision

    terminal = controller.fail_job(claimed.id, JobFailure("solver_failed", "failed"), worker_id="worker")
    late = controller.record_event(claimed.id, "job.phase_changed", {"source": "late"}, worker_id="worker")
    assert late.revision == terminal.revision


def test_store_caps_replayable_events_per_job(store_factory):
    # An owning worker records progress under an active lease, then fails the job
    # so it terminates and the stream ends; the retained window is capped.
    controller = _controller(store_factory(max_events_per_job=4))
    created = _create(controller)
    controller.claim_next_job("worker")
    for index in range(6):
        controller.record_event(created.id, "job.test", {"index": index}, worker_id="worker")
    failed = controller.fail_job(created.id, JobFailure("optimization_failed", "x"), worker_id="worker")
    assert failed.state == JobState.FAILED

    events = [e for e in controller.stream_events(created.id, after_id=None, keepalive_seconds=0.01) if e is not None]
    assert len(events) == 4


# --- Cancellation, revision, and retention -----------------------------------


def test_controller_cancellation_policy_is_shared_by_stores(store):
    controller = _controller(store)
    queued = _create(controller)
    assert controller.cancel_job(queued.id).state == JobState.CANCELLED

    running = _create(controller, "running.yaml")
    controller.claim_next_job("worker")
    assert controller.cancel_job(running.id).state == JobState.CANCELLING
    failed = controller.fail_job(running.id, JobFailure("solver_failed", "ignored"), worker_id="worker")
    assert failed.state == JobState.CANCELLED


def test_complete_cancellation_is_lease_fenced_across_stores(store):
    # A cooperatively cancelled job is finalized only by its owning worker under a
    # still-active claim; a foreign worker cannot manufacture the terminal write.
    controller = _controller(store)
    running = _create(controller)
    controller.claim_next_job("worker")
    assert controller.cancel_job(running.id).state == JobState.CANCELLING

    foreign = controller.complete_cancellation(running.id, worker_id="other-worker")
    assert foreign.state == JobState.CANCELLING

    cancelled = controller.complete_cancellation(running.id, worker_id="worker")
    assert cancelled.state == JobState.CANCELLED
    assert cancelled.failure == JobFailure("cancelled", "Optimization cancelled.")

    # Re-finalizing a terminal job is a no-op.
    assert controller.complete_cancellation(running.id, worker_id="worker").state == JobState.CANCELLED


def test_complete_cancellation_after_lease_expiry_defers_to_maintenance(store):
    # Once the lease lapses the worker can no longer settle the cancellation; the
    # write is refused and maintenance retains authority to terminate the job.
    start = datetime.now(timezone.utc)
    controller = _controller(store, now=start)
    running = _create(controller)
    controller.claim_next_job("worker")
    assert controller.cancel_job(running.id).state == JobState.CANCELLING

    expired = _controller(store, now=start + timedelta(seconds=31))
    unchanged = expired.complete_cancellation(running.id, worker_id="worker")
    assert unchanged.state == JobState.CANCELLING

    assert expired.expire_worker_claims() == [running.id]
    assert expired.get_job(running.id).state == JobState.CANCELLED


def test_process_timeout_failure_does_not_overwrite_worker_lost(store):
    # A watchdog process_timeout arriving from a worker that already lost its claim
    # must not overwrite the worker_lost outcome maintenance settled first.
    start = datetime.now(timezone.utc)
    controller = _controller(store, now=start)
    running = _create(controller)
    controller.claim_next_job("worker")

    expired = _controller(store, now=start + timedelta(seconds=31))
    assert expired.expire_worker_claims() == [running.id]
    assert expired.get_job(running.id).failure.code == "worker_lost"

    refused = expired.fail_job(running.id, JobFailure("process_timeout", "timed out"), worker_id="worker")
    assert refused.state == JobState.FAILED
    assert refused.failure.code == "worker_lost"


def test_revision_prevents_late_overwrite(store):
    controller = _controller(store)
    created = _create(controller)
    stale = controller.get_job(created.id)
    controller.cancel_job(created.id)
    with pytest.raises(StoreWriteConflictError):
        store.save(stale, stale.revision, [])


def test_retention_cleanup_removes_old_terminal_jobs(store):
    now = datetime.now(timezone.utc)
    controller = _controller(store, now=now)
    created = _create(controller)
    controller.cancel_job(created.id)

    later = JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=32),
        retention_seconds=60,
        claim_lease_seconds=30,
        clock=lambda: now + timedelta(seconds=61),
    )
    assert later.expire_jobs() == [created.id]


# --- Concurrency --------------------------------------------------------------


def test_store_enforces_capacity_across_concurrent_creates(store):
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=4, max_retained=4),
        retention_seconds=60,
        claim_lease_seconds=30,
    )

    def create(index: int):
        try:
            return controller.create_job(
                input_name=f"{index}.yaml",
                client_id="client",
                solver="ortools/cp-sat",
                prettify=False,
                timeout_seconds=60,
                input_bytes=b"apiVersion: alpha\n",
            )
        except JobCapacityError as error:
            return error

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(create, range(8)))
    assert sum(not isinstance(result, JobCapacityError) for result in results) == 4


def test_store_claims_each_job_at_most_once_under_concurrency(store):
    controller = _controller(store)
    created_ids = {_create(controller, f"{index}.yaml").id for index in range(6)}
    with ThreadPoolExecutor(max_workers=6) as executor:
        claimed = list(executor.map(lambda index: controller.claim_next_job(f"worker-{index}"), range(6)))
    claimed_ids = {job.id for job in claimed if job is not None}
    assert claimed_ids == created_ids
    assert len(claimed_ids) == len(claimed)


# --- Lease handoff across processes/controllers ------------------------------


def test_expired_worker_claim_fails_job_and_releases_capacity(store):
    now = datetime.now(timezone.utc)
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=1, max_retained=2),
        retention_seconds=60,
        claim_lease_seconds=10,
        clock=lambda: now,
        id_factory=lambda: "job_abandoned",
    )
    abandoned = _create(controller)
    controller.claim_next_job("lost-worker")

    recovery = JobController(
        store,
        limits=StoreLimits(max_pending=1, max_retained=2),
        retention_seconds=60,
        claim_lease_seconds=10,
        clock=lambda: now + timedelta(seconds=11),
        id_factory=lambda: "job_replacement",
    )
    assert recovery.renew_claim(abandoned.id, "lost-worker") is None
    assert recovery.is_stop_requested(abandoned.id, "lost-worker") is True
    assert recovery.expire_worker_claims() == [abandoned.id]
    failed = recovery.get_job(abandoned.id)
    assert failed.state == JobState.FAILED
    assert failed.failure == JobFailure("worker_lost", "The optimization worker stopped before the job completed.")
    # Capacity is released: the replacement controller can queue a fresh job.
    assert _create(recovery).state == JobState.QUEUED


def test_completed_job_replays_after_client_reconnect(store):
    controller = _controller(store)
    created = _create(controller)
    running = controller.claim_next_job("worker")
    assert running is not None

    stream = controller.stream_events(running.id, after_id=None, keepalive_seconds=0.01)
    while True:
        last_seen = next(stream)
        if last_seen is not None and last_seen.data.get("state") == "running":
            break

    artifact = StoredArtifact("input.xlsx", "application/test", b"xlsx")
    controller.complete_job(
        running.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 42, "OPTIMAL", "optimality_proven"),
        artifact,
        worker_id="worker",
    )

    window = controller.prepare_event_replay(created.id, None)
    replayed = [event.type for event in window.initial_events]
    assert "job.result_available" in replayed
    assert controller.get_artifact(created.id, artifact.name) == artifact


# --- Redis-specific behavior --------------------------------------------------


def _raise_watch_error_once(store) -> None:
    original_pipeline = store._redis.pipeline
    pending = {"error": True}

    class _WatchErrorPipeline:
        def __init__(self, pipeline):
            self._pipeline = pipeline

        def __enter__(self):
            self._pipeline.__enter__()
            return self

        def __exit__(self, *args):
            return self._pipeline.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self._pipeline, name)

        def execute(self):
            if pending["error"]:
                pending["error"] = False
                raise redis.WatchError
            return self._pipeline.execute()

    store._redis.pipeline = lambda: _WatchErrorPipeline(original_pipeline())


@pytest.mark.parametrize("operation", ["create", "claim", "save", "delete"])
def test_redis_store_retries_watch_errors(operation):
    store = make_fakeredis_store()
    controller = _controller(store)
    if operation == "create":
        _raise_watch_error_once(store)
        assert _create(controller).state == JobState.QUEUED
        return

    created = _create(controller)
    if operation == "delete":
        created = controller.cancel_job(created.id)
    _raise_watch_error_once(store)
    if operation == "claim":
        assert controller.claim_next_job("worker").state == JobState.RUNNING
    elif operation == "save":
        assert controller.cancel_job(created.id).state == JobState.CANCELLED
    else:
        controller.delete_job(created.id)
        with pytest.raises(JobNotFoundError):
            controller.get_job(created.id)


@pytest.mark.parametrize(
    "settings",
    [
        {"key_prefix": ":"},
        {"event_stream_keepalive_seconds": 0},
        {"event_stream_keepalive_seconds": float("inf")},
        {"max_events_per_job": 0},
    ],
)
def test_redis_store_rejects_invalid_configuration(settings):
    import fakeredis

    configuration = {
        "url": "redis://localhost/0",
        "key_prefix": "test:jobs",
        "client": fakeredis.FakeStrictRedis(server=fakeredis.FakeServer()),
        **settings,
    }
    with pytest.raises(ValueError):
        RedisJobStore(**configuration)


def test_memory_store_rejects_nonpositive_event_limit():
    with pytest.raises(ValueError, match="max_events_per_job must be positive"):
        MemoryJobStore(max_events_per_job=0)


def test_explicitly_configured_unreachable_redis_fails_hard():
    # An explicitly configured but unreachable endpoint must raise at construction,
    # never silently degrade. Port 6390 is expected to refuse connections.
    with pytest.raises(redis.RedisError):
        RedisJobStore(url="redis://127.0.0.1:6390/0", key_prefix="nurse_test:unreachable")


def test_wrong_authentication_real_redis_fails_hard():
    # Committed auth-rejection gate: temporarily require a password on the
    # configured real Redis, prove that wrong credentials fail hard at construction
    # (never skip or silently degrade) while the correct password connects, then
    # restore the no-auth state.
    url = real_redis_url()
    if url is None:
        pytest.skip("real Redis not available (set NURSE_TEST_REDIS_URL)")
    scheme, _, rest = url.partition("://")
    correct = "t19b-correct-secret"
    admin = redis.Redis.from_url(url)
    admin.config_set("requirepass", correct)
    try:
        with pytest.raises(redis.RedisError):
            RedisJobStore(url=f"{scheme}://:wrong-secret@{rest}", key_prefix="nurse_test:wrongauth")
        # The correct password still connects, confirming the failure was auth, not reachability.
        RedisJobStore(url=f"{scheme}://:{correct}@{rest}", key_prefix="nurse_test:rightauth")
    finally:
        reset = redis.Redis.from_url(f"{scheme}://:{correct}@{rest}")
        reset.config_set("requirepass", "")
