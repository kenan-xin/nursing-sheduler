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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Event

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
)
from nurse_scheduling.server.jobs.process_executor import ProcessControl, ProcessResult, ProcessStatus
from nurse_scheduling.server.jobs.worker import JobWorker
from nurse_scheduling.server.maintenance import JobMaintenance
from nurse_scheduling.server.stores.memory import MemoryJobStore
from tests.server_support import _make_fakeredis_store


def _controller_with_clock(store, clock, *, lease=3.0):
    return JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=24 * 60 * 60,
        claim_lease_seconds=lease,
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
    controller.claim_next_job("worker-1")
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
    controller.claim_next_job("worker-1")
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
        claim_lease_seconds=0.2,  # test-only short lease
    )
    job = controller.create_job(
        input_name="in.yaml",
        client_id="c",
        solver="ortools/cp-sat",
        prettify=None,
        timeout_seconds=300,
        input_bytes=b"x",
    )
    controller.claim_next_job("worker-1")  # running, claim expires in 0.2s and is never renewed
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
    controller.claim_next_job(worker_id)
    return job


def test_expired_worker_cannot_write_progress_result_or_failure():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=3.0)
    job = _claimed_job(store, controller)

    moment[0] += timedelta(seconds=4)  # the 3s lease has expired without renewal

    # A stale worker's progress, result, and failure writes are all refused.
    controller.record_event(job.id, "job.progressed", {"stale": True}, worker_id="worker-1")
    controller.complete_job(
        job.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
        None,
        worker_id="worker-1",
    )
    controller.fail_job(job.id, JobFailure("optimization_failed", "stale"), worker_id="worker-1")
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
    job = _claimed_job(store, controller)

    moment[0] += timedelta(seconds=4)  # lease expired
    artifact = StoredArtifact("schedule.xlsx", "application/test", b"stale-bytes")
    controller.complete_job(
        job.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
        artifact,
        worker_id="worker-1",
    )
    current = controller.get_job(job.id)
    assert current.state == JobState.RUNNING
    assert current.artifact_name is None  # no stale artifact bytes were persisted


def test_foreign_worker_cannot_complete_or_fail():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=90.0)
    job = _claimed_job(store, controller, worker_id="worker-1")

    controller.complete_job(
        job.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
        None,
        worker_id="intruder",
    )
    controller.fail_job(job.id, JobFailure("optimization_failed", "x"), worker_id="intruder")
    assert controller.get_job(job.id).state == JobState.RUNNING


def test_active_worker_with_valid_lease_can_complete():
    store = MemoryJobStore()
    moment = [datetime.now(timezone.utc)]
    controller = _controller_with_clock(store, lambda: moment[0], lease=90.0)
    job = _claimed_job(store, controller)

    completed = controller.complete_job(
        job.id,
        OptimizationResult(OptimizationOutcome.OPTIMAL, 7, "OPTIMAL", "optimality_proven"),
        None,
        worker_id="worker-1",
    )
    assert completed.state == JobState.COMPLETED
    assert completed.result.score == 7


@pytest.mark.parametrize("operation", ["event", "complete", "fail", "renew", "complete_cancellation"])
def test_worker_commit_fence_rejects_writes_that_reach_store_after_lease_expiry(store_factory, operation):
    """A transition admitted before expiry cannot mutate the store after it.

    `complete_cancellation` is included so owner/revision/observed-deadline
    fencing is proven for the cancellation settle path too: a cancellation that
    passes the controller pre-check but whose lease lapses before the store
    commit must write nothing and leave the terminal transition to maintenance.
    """
    store = store_factory()
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=2, max_retained=4),
        retention_seconds=60,
        claim_lease_seconds=0.05,
    )
    created = controller.create_job(
        input_name="late.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=False,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )
    claimed = controller.claim_next_job("worker-1")
    assert claimed is not None
    if operation == "complete_cancellation":
        # cancel_job carries no worker identity, so it commits before the fence
        # window under the original save and leaves a CANCELLING job to settle.
        assert controller.cancel_job(created.id).state == JobState.CANCELLING
    before = controller.get_job(created.id)
    before_events = list(controller.prepare_event_replay(created.id, None).initial_events)
    original_save = store.save

    def delayed_save(*args, **kwargs):
        time.sleep(0.08)
        return original_save(*args, **kwargs)

    store.save = delayed_save
    if operation == "event":
        controller.record_event(created.id, "job.phase_changed", {"phase": "late"}, worker_id="worker-1")
    elif operation == "complete":
        controller.complete_job(
            created.id,
            OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
            StoredArtifact("late.xlsx", "application/test", b"late"),
            worker_id="worker-1",
        )
    elif operation == "fail":
        controller.fail_job(created.id, JobFailure("solver_failed", "late"), worker_id="worker-1")
    elif operation == "complete_cancellation":
        controller.complete_cancellation(created.id, worker_id="worker-1")
    else:
        assert controller.renew_claim(created.id, "worker-1") is None

    expected_state = JobState.CANCELLING if operation == "complete_cancellation" else JobState.RUNNING
    current = controller.get_job(created.id)
    assert current.state == expected_state
    assert current.revision == before.revision
    assert current.artifact_name is None
    assert controller.prepare_event_replay(created.id, None).initial_events == before_events
    assert controller.expire_worker_claims() == [created.id]
    settled = controller.get_job(created.id)
    if operation == "complete_cancellation":
        assert settled.state == JobState.CANCELLED
        assert settled.failure.code == "cancelled"
    else:
        assert settled.failure.code == "worker_lost"


@pytest.mark.parametrize("operation", ["event", "complete", "fail", "renew", "complete_cancellation"])
def test_fakeredis_worker_commit_is_fenced_when_lease_expires_inside_commit_window(operation):
    """The fakeredis commit boundary revalidates after its pre-check pause.

    `complete_cancellation` exercises the same owner/revision/observed-deadline
    Lua revalidation for the cancellation settle path: the lease expires inside
    the commit window, so nothing mutates and maintenance owns termination.
    """
    preconditions_passed = Event()
    allow_commit = Event()

    def pause_before_commit():
        preconditions_passed.set()
        assert allow_commit.wait(timeout=2.0)

    store = _make_fakeredis_store(before_commit=pause_before_commit)
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=2, max_retained=4),
        retention_seconds=60,
        claim_lease_seconds=0.2,
    )
    created = controller.create_job(
        input_name="late.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=False,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )
    claimed = controller.claim_next_job("worker-1")
    assert claimed is not None
    if operation == "complete_cancellation":
        # cancel_job carries no worker identity, so it does not enter the fenced
        # commit boundary and settles the job into CANCELLING before the window.
        assert controller.cancel_job(created.id).state == JobState.CANCELLING
    before = controller.get_job(created.id)
    before_events = list(controller.prepare_event_replay(created.id, None).initial_events)

    def mutate():
        if operation == "event":
            return controller.record_event(
                created.id,
                "job.phase_changed",
                {"phase": "late"},
                worker_id="worker-1",
            )
        if operation == "complete":
            return controller.complete_job(
                created.id,
                OptimizationResult(OptimizationOutcome.OPTIMAL, 1, "OPTIMAL", "optimality_proven"),
                StoredArtifact("late.xlsx", "application/test", b"late"),
                worker_id="worker-1",
            )
        if operation == "fail":
            return controller.fail_job(
                created.id,
                JobFailure("solver_failed", "late"),
                worker_id="worker-1",
            )
        if operation == "complete_cancellation":
            return controller.complete_cancellation(created.id, worker_id="worker-1")
        return controller.renew_claim(created.id, "worker-1")

    with ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(mutate)
        assert preconditions_passed.wait(timeout=2.0)
        delay = max(0.0, claimed.claim_expires_at.timestamp() - time.time()) + 0.02
        time.sleep(delay)
        allow_commit.set()
        result.result(timeout=2.0)

    expected_state = JobState.CANCELLING if operation == "complete_cancellation" else JobState.RUNNING
    current = controller.get_job(created.id)
    assert current.state == expected_state
    assert current.revision == before.revision
    assert current.worker_id == before.worker_id
    assert current.claim_expires_at == before.claim_expires_at
    assert current.result is None
    assert current.failure is None
    assert current.artifact_name is None
    with pytest.raises(JobArtifactNotFoundError):
        store.get_artifact(created.id, "late.xlsx")
    assert controller.prepare_event_replay(created.id, None).initial_events == before_events
    assert controller.expire_worker_claims() == [created.id]
    settled = controller.get_job(created.id)
    if operation == "complete_cancellation":
        assert settled.state == JobState.CANCELLED
        assert settled.failure.code == "cancelled"
    else:
        assert settled.failure.code == "worker_lost"


def test_worker_stops_execution_when_renewal_outage_outlasts_lease(monkeypatch):
    # A worker whose claim renewals keep failing must abort its child once the last
    # confirmed lease deadline passes, rather than run against an unrenewed claim,
    # and must write no terminal result so maintenance owns `worker_lost`.
    class _RenewalOutageController:
        def get_input(self, job_id):
            return b""

        def renew_claim(self, job_id, worker_id):
            raise RuntimeError("store outage")

        def is_stop_requested(self, job_id, worker_id=None):
            return False

        def complete_job(self, *args, **kwargs):
            raise AssertionError("must not commit a result after a renewal outage")

        def fail_job(self, *args, **kwargs):
            raise AssertionError("must not commit a failure after a renewal outage")

        def complete_cancellation(self, *args, **kwargs):
            raise AssertionError("must not commit a cancellation after a renewal outage")

    aborted = []

    def fake_run_optimization_process(*_args, control, **_kwargs):
        # Emulate the supervised child: forward controls until the worker's
        # confirmed-deadline abort surfaces, then stop the tree writing nothing.
        deadline = time.monotonic() + 2
        while control() is not ProcessControl.ABORT:
            if time.monotonic() >= deadline:
                raise AssertionError("worker did not abort after the renewal outage outlasted its lease")
            time.sleep(0.005)
        aborted.append(True)
        return ProcessResult(status=ProcessStatus.ABORTED)

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    controller = _RenewalOutageController()
    worker = JobWorker(
        controller,
        object(),
        worker_id="worker-1",
        claim_poll_seconds=0.05,
        claim_lease_seconds=0.3,
    )
    job = _make_running_job()
    started = time.monotonic()
    worker._execute(job)
    elapsed = time.monotonic() - started

    assert aborted == [True]
    assert elapsed < 2.0  # aborted near the 0.3s lease deadline, not indefinitely


def _make_running_job():
    from nurse_scheduling.server.jobs.models import Job, JobRequest

    now = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return Job(
        id="job_run",
        state=JobState.RUNNING,
        request=JobRequest("in.yaml", "c", "ortools/cp-sat", None, 300),
        created_at=now,
        worker_id="worker-1",
        claim_expires_at=now + timedelta(seconds=0.3),
    )


def test_maintenance_reports_unhealthy_when_passes_stall():
    store = MemoryJobStore()
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=8, max_retained=128),
        retention_seconds=24 * 60 * 60,
        claim_lease_seconds=90.0,
    )
    clock = [0.0]
    # A large interval means the injected clock is the only thing that advances
    # liveness, so no real pass completes during the test.
    maintenance = JobMaintenance(controller, interval_seconds=1000.0, clock=lambda: clock[0])
    assert not maintenance.is_healthy()  # never started
    maintenance.start()
    try:
        assert maintenance.is_healthy()  # started within the liveness window
        clock[0] = 5000.0  # far beyond interval * liveness factor with no successful pass
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
