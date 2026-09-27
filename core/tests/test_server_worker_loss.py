"""Worker-loss claim expiry and Redis-outage fail-closed behavior."""

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

import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.errors import JobArtifactNotFoundError
from nurse_scheduling.server.jobs.controller import JobController
from nurse_scheduling.server.jobs.models import (
    JobFailure,
    JobState,
    OptimizationOutcome,
    OptimizationResult,
    StoredArtifact,
    StoreLimits,
    WorkerLease,
)
from nurse_scheduling.server.jobs.process_executor import ProcessControl, ProcessResult, ProcessStatus
from nurse_scheduling.server.jobs.worker import JobWorker
from nurse_scheduling.server.maintenance import JobMaintenance
from nurse_scheduling.server.stores.memory import MemoryJobStore


def _controller_with_clock(store, clock, *, lease=3.0):
    return JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=24 * 60 * 60,
        worker_lease_seconds=lease,
        clock=clock,
    )


def test_expired_claim_becomes_worker_lost():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=3.0)

    job = controller.create_job(
        input_name="in.yaml",
        client_id="c",
        solver="ortools/cp-sat",
        prettify=None,
        timeout_seconds=300,
        input_bytes=b"x",
    )
    controller.claim_next_job(controller.register_worker("worker-1"))
    assert controller.get_job(job.id).state == JobState.RUNNING

    moment[0] += timedelta(seconds=4)  # lease of 3s has now expired
    expired_ids = controller.expire_worker_claims()

    assert job.id in expired_ids
    lost = controller.get_job(job.id)
    assert lost.state == JobState.FAILED
    assert lost.failure.code == "worker_lost"
    assert lost.finished_at is not None


def test_cancelled_job_expiry_is_cancelled_not_worker_lost():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=3.0)

    job = controller.create_job(
        input_name="in.yaml",
        client_id="c",
        solver="ortools/cp-sat",
        prettify=None,
        timeout_seconds=300,
        input_bytes=b"x",
    )
    controller.claim_next_job(controller.register_worker("worker-1"))
    controller.cancel_job(job.id)  # cp-sat supports cooperative cancellation

    moment[0] += timedelta(seconds=4)
    controller.expire_worker_claims()

    cancelled = controller.get_job(job.id)
    assert cancelled.state == JobState.CANCELLED
    assert cancelled.failure.code == "cancelled"


def test_maintenance_thread_expires_lost_worker():
    store = MemoryJobStore()
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=24 * 60 * 60,
        worker_lease_seconds=0.2,  # test-only short lease
    )
    job = controller.create_job(
        input_name="in.yaml",
        client_id="c",
        solver="ortools/cp-sat",
        prettify=None,
        timeout_seconds=300,
        input_bytes=b"x",
    )
    controller.claim_next_job(
        controller.register_worker("worker-1")
    )  # running, lease expires in 0.2s and is never renewed
    maintenance = JobMaintenance(controller, interval_seconds=0.05)
    maintenance.start()
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if controller.get_job(job.id).state.terminal:
                break
            time.sleep(0.05)
    finally:
        maintenance.stop()

    lost = controller.get_job(job.id)
    assert lost.state == JobState.FAILED
    assert lost.failure.code == "worker_lost"


def _claimed_job(store, controller, worker_id="worker-1"):
    """Create and claim one job, returning it in the RUNNING state."""
    job = controller.create_job(
        input_name="in.yaml",
        client_id="c",
        solver="ortools/cp-sat",
        prettify=None,
        timeout_seconds=300,
        input_bytes=b"x",
    )
    lease = controller.register_worker(worker_id)
    controller.claim_next_job(lease)
    return job, lease


def test_expired_worker_cannot_write_progress_result_or_failure():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=3.0)
    job, lease = _claimed_job(store, controller)

    moment[0] += timedelta(seconds=4)  # the 3s lease has expired without renewal

    # A stale worker's progress, result, and failure writes are all refused.
    controller.record_event(job.id, "job.progressed", {"stale": True}, lease=lease)
    controller.complete_job(
        job.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
        None,
        lease=lease,
    )
    controller.fail_job(job.id, JobFailure("optimization_failed", "stale"), lease=lease)
    assert controller.get_job(job.id).state == JobState.RUNNING

    # Only maintenance may terminate the abandoned job, as worker_lost.
    assert controller.expire_worker_claims() == [job.id]
    lost = controller.get_job(job.id)
    assert lost.state == JobState.FAILED
    assert lost.failure.code == "worker_lost"


def test_expired_worker_cannot_persist_artifact_bytes():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=3.0)
    job, lease = _claimed_job(store, controller)

    moment[0] += timedelta(seconds=4)  # lease expired
    artifact = StoredArtifact("schedule.xlsx", "application/test", b"stale-bytes")
    controller.complete_job(
        job.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
        artifact,
        lease=lease,
    )
    current = controller.get_job(job.id)
    assert current.state == JobState.RUNNING
    assert current.artifact_name is None  # no stale artifact bytes were persisted


def test_foreign_worker_cannot_complete_or_fail():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=90.0)
    job, _lease = _claimed_job(store, controller, worker_id="worker-1")
    intruder = controller.register_worker("intruder")

    controller.complete_job(
        job.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
        None,
        lease=intruder,
    )
    controller.fail_job(job.id, JobFailure("optimization_failed", "x"), lease=intruder)
    assert controller.get_job(job.id).state == JobState.RUNNING


def test_active_worker_with_valid_lease_can_complete():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=90.0)
    job, lease = _claimed_job(store, controller)

    completed = controller.complete_job(
        job.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 7, "OPTIMAL", "optimality_proven"),
        None,
        lease=lease,
    )
    assert completed.state == JobState.COMPLETED
    assert completed.result.score == 7


def _late_write(controller, created_id, operation, lease):
    """Issue one worker-originated write (W6 lease API)."""
    if operation == "event":
        return controller.record_event(created_id, "job.phase_changed", {"phase": "late"}, lease=lease)
    if operation == "complete":
        return controller.complete_job(
            created_id,
            OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
            StoredArtifact("late.xlsx", "application/test", b"late"),
            lease=lease,
        )
    if operation == "fail":
        return controller.fail_job(created_id, JobFailure("solver_failed", "late"), lease=lease)
    if operation == "complete_cancellation":
        return controller.complete_cancellation(created_id, lease)
    return controller.renew_worker(lease)


def _claimed_for_fence(store, operation, lease_seconds):
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=2, max_retained=4),
        retention_seconds=60,
        worker_lease_seconds=lease_seconds,
    )
    created = controller.create_job(
        input_name="late.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=False,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )
    lease = controller.register_worker("worker-1")
    claimed = controller.claim_next_job(lease)
    assert claimed is not None
    if operation == "complete_cancellation":
        # cancel_job carries no worker lease, so it commits before the fence window.
        assert controller.cancel_job(created.id).state == JobState.CANCELLING
    return controller, created, lease


def _assert_stale_write_changed_nothing(controller, store, created, operation, settled_before, events_before):
    """After maintenance committed the loss, the late worker write changed nothing."""
    settled = controller.get_job(created.id)
    assert settled.revision == settled_before.revision
    assert settled.state == settled_before.state
    assert settled.result is None
    assert settled.artifact_name is None
    with pytest.raises(JobArtifactNotFoundError):
        store.get_artifact(created.id, "late.xlsx")
    assert controller.prepare_event_replay(created.id, None).initial_events == events_before
    if operation == "complete_cancellation":
        assert settled.state == JobState.CANCELLED
        assert settled.failure.code == "cancelled"
    else:
        assert settled.failure.code == "worker_lost"


@pytest.mark.parametrize("operation", ["event", "complete", "fail", "renew", "complete_cancellation"])
def test_worker_commit_fence_rejects_writes_that_reach_store_after_worker_lost(store_factory, operation):
    """W6 delayed-commit probe: a write admitted before expiry reaches the store only after
    maintenance committed `worker_lost`. It must change nothing.

    T19 expected the write to be refused at expiry. W6 accepts that a write CAN land between
    expiry and the `worker_lost` commit (spec W6, accepted semantic change); this probe pins
    the new expected result.
    """
    store = store_factory()
    controller, created, lease = _claimed_for_fence(store, operation, 0.05)
    target = "renew_worker" if operation == "renew" else "update_job"
    original = getattr(store, target)
    settled_before = []

    def delayed(*args, **kwargs):
        if target == "update_job" and kwargs.get("worker_lease") is None:
            return original(*args, **kwargs)
        time.sleep(0.08)  # the 0.05s lease has expired
        if not settled_before:
            assert controller.expire_worker_claims() == [created.id]
            settled_before.append(controller.get_job(created.id))
            settled_before.append(list(controller.prepare_event_replay(created.id, None).initial_events))
        return original(*args, **kwargs)

    setattr(store, target, delayed)
    result = _late_write(controller, created.id, operation, lease)
    if operation == "renew":
        assert result is None
    _assert_stale_write_changed_nothing(controller, store, created, operation, *settled_before)


def test_w6_accepted_gap_late_write_before_worker_lost_lands(store_factory):
    """Evidence for the accepted W6 semantic change: a worker write stamped before lease
    expiry and committed after it, with no maintenance pass in between, SUCCEEDS.

    T19 refused this write with one Redis clock inside one Lua commit.
    """
    store = store_factory()
    controller, created, lease = _claimed_for_fence(store, "complete", 0.05)
    original = store.update_job

    def delayed(*args, **kwargs):
        if kwargs.get("worker_lease") is not None:
            time.sleep(0.08)  # the 0.05s lease has expired, maintenance has not run
        return original(*args, **kwargs)

    store.update_job = delayed
    _late_write(controller, created.id, "complete", lease)
    landed = controller.get_job(created.id)
    assert landed.state == JobState.COMPLETED
    assert landed.artifact_name == "late.xlsx"


class _MultiHookPipeline:
    """Delegate to a redis-py pipeline and run a hook once when MULTI starts."""

    def __init__(self, inner, hook):
        self._inner = inner
        self._hook = hook

    def __enter__(self):
        self._inner.__enter__()
        return self

    def __exit__(self, *exc):
        return self._inner.__exit__(*exc)

    def multi(self):
        hook, self._hook[0] = self._hook[0], None
        if hook is not None:
            hook()
        return self._inner.multi()

    def __getattr__(self, name):
        return getattr(self._inner, name)


@pytest.mark.parametrize("operation", ["event", "complete", "fail", "renew", "complete_cancellation"])
@pytest.mark.parametrize("store_factory", ["fakeredis", "redis"], indirect=True)
def test_redis_worker_commit_aborts_when_maintenance_commits_inside_watch_window(store_factory, operation):
    """W6 rewrite of the T19 fakeredis commit-window test.

    The worker's WATCH-guarded write passes its lease check, then maintenance commits
    `worker_lost` before the worker reaches EXEC. The watched keys changed, so EXEC aborts,
    and the retry then sees a terminal job and writes nothing.
    """
    store = store_factory()
    controller, created, lease = _claimed_for_fence(store, operation, 0.2)
    settled_before = []

    def maintenance_inside_window():
        time.sleep(0.25)  # the 0.2s lease has expired
        assert controller.expire_worker_claims() == [created.id]
        settled_before.append(controller.get_job(created.id))
        settled_before.append(list(controller.prepare_event_replay(created.id, None).initial_events))

    hook = [maintenance_inside_window]
    original_pipeline = store._redis.pipeline
    store._redis.pipeline = lambda *a, **k: _MultiHookPipeline(original_pipeline(*a, **k), hook)
    result = _late_write(controller, created.id, operation, lease)
    store._redis.pipeline = original_pipeline
    assert hook == [None], "the hook must have run inside the worker's watched transaction"
    if operation == "renew":
        assert result is None
    _assert_stale_write_changed_nothing(controller, store, created, operation, *settled_before)


def test_worker_stops_execution_when_renewal_outage_outlasts_lease(monkeypatch):
    # A worker whose lease renewals keep failing must abort its child once the lease
    # expires, rather than run against an unrenewed lease, and must write no terminal
    # result so maintenance owns `worker_lost`. W6: renewal is the genie worker heartbeat.
    job = _make_running_job()
    now = datetime.now(timezone.utc)
    lease = WorkerLease("worker-1", "token", now + timedelta(seconds=0.3))
    claims = [job]

    class _RenewalOutageController:
        def register_worker(self, worker_id):
            return lease

        def claim_next_job(self, _lease):
            return claims.pop() if claims else None

        def get_input(self, job_id):
            return b""

        def renew_worker(self, _lease):
            raise RuntimeError("store outage")

        def expire_worker_claims(self):
            raise RuntimeError("store outage")

        def unregister_worker(self, _lease):
            pass

        def is_stop_requested(self, job_id, _lease):
            return False

        def complete_job(self, *args, **kwargs):
            raise AssertionError("must not commit a result after a renewal outage")

        def fail_job(self, *args, **kwargs):
            raise AssertionError("must not commit a failure after a renewal outage")

        def complete_cancellation(self, *args, **kwargs):
            raise AssertionError("must not commit a cancellation after a renewal outage")

    aborted = []

    def fake_run_optimization_process(*_args, control, **_kwargs):
        deadline = time.monotonic() + 2
        while control() is not ProcessControl.ABORT:
            if time.monotonic() >= deadline:
                raise AssertionError("worker did not abort after the renewal outage outlasted its lease")
            time.sleep(0.005)
        aborted.append(time.monotonic())
        return ProcessResult(status=ProcessStatus.ABORTED)

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(
        _RenewalOutageController(),
        object(),
        worker_id="worker-1",
        claim_poll_seconds=0.05,
        worker_lease_seconds=0.3,
    )
    started = time.monotonic()
    worker.start()
    try:
        deadline = time.monotonic() + 3
        while not aborted and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        worker.stop()

    assert len(aborted) == 1
    assert aborted[0] - started < 2.0  # aborted near the 0.3s lease deadline, not indefinitely


def _make_running_job():
    from nurse_scheduling.server.jobs.models import Job, JobRequest

    now = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return Job(
        id="job_run",
        state=JobState.RUNNING,
        request=JobRequest("in.yaml", "c", "ortools/cp-sat", None, 300),
        created_at=now,
        worker_id="worker-1",
    )


def test_maintenance_reports_unhealthy_when_passes_stall():
    store = MemoryJobStore()
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=24 * 60 * 60,
        worker_lease_seconds=90.0,
    )
    clock = [0.0]
    # A large interval means the injected clock is the only thing that advances
    # liveness, so no real pass completes during the test.
    maintenance = JobMaintenance(controller, interval_seconds=1000.0, clock=lambda: clock[0])
    assert not maintenance.is_healthy()  # never started
    maintenance.start()
    try:
        assert maintenance.is_healthy()  # started within the liveness window
        clock[0] = 10_000.0  # far beyond interval * liveness factor with no successful pass
        assert not maintenance.is_healthy()
    finally:
        maintenance.stop()


def test_stalled_maintenance_makes_ready_fail_closed():
    app = create_app(start_background=True)
    with TestClient(app) as client:
        assert client.get("/ready").status_code == 200
        # A dead maintenance loop must fail readiness closed even while the store
        # and worker remain healthy.
        client.app.state.job_maintenance.stop()
        ready = client.get("/ready")
        assert ready.status_code == 503
        assert ready.json()["reason"] == "job_maintenance_unavailable"


class _FlakyStore:
    """Minimal store stand-in whose health can be toggled to simulate an outage."""

    def __init__(self):
        self.healthy = True
        self.store_id = "flaky-store"

    def check_health(self):
        if not self.healthy:
            raise RuntimeError("redis is unavailable")


def test_redis_outage_makes_health_and_ready_fail_closed():
    store = _FlakyStore()
    app = create_app(store=store, start_background=False)
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code == 200

        store.healthy = False
        health = client.get("/health")
        ready = client.get("/ready")
        assert health.status_code == 503
        assert health.json()["reason"] == "job_store_unavailable"
        assert ready.status_code == 503

        # Recovery is independent of worker death and restores readiness.
        store.healthy = True
        assert client.get("/health").status_code == 200
        assert client.get("/ready").status_code == 200


def test_maintenance_backoff_cap_stays_inside_the_liveness_window():
    # After an outage the loop may sleep for the capped delay before its next pass.
    # That sleep alone must never make /ready fail once the store is back.
    maintenance = JobMaintenance(object(), interval_seconds=2.0)
    for _ in range(10):
        maintenance._failures.report()
    assert maintenance._failures.delay_seconds() < maintenance._liveness_timeout_seconds
