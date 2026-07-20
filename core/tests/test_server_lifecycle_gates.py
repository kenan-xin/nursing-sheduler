"""Ported upstream ASGI/lifecycle gates adapted to the rebuild server.

Restores the pinned-upstream regression coverage the closure review required:
synchronous store access and job creation stay off the ASGI event loop,
running-worker cancellation discards the result, Finish now completes with the
current feasible result, a long-running worker renews its lease, and the worker
survives a store outage during failure persistence.
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

import asyncio
import multiprocessing
import threading
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi.testclient import TestClient

from nurse_scheduling.server.app import create_app
from nurse_scheduling.server.config import ServerSettings
from nurse_scheduling.server.jobs.controller import JobController
from nurse_scheduling.server.jobs.models import (
    JobState,
    OptimizationOutcome,
    OptimizationResult,
    StoredArtifact,
    StoreLimits,
)
from nurse_scheduling.server.jobs.process_executor import ProcessControl, ProcessResult, ProcessStatus
from nurse_scheduling.server.jobs.runner import RunOutput
from nurse_scheduling.server.jobs.worker import JobWorker
from nurse_scheduling.server.stores.memory import MemoryJobStore
from tests.server_support import MINIMAL_SCENARIO


class SuccessfulRunner:
    def run(self, job, input_bytes, *, event_callback, should_stop):
        event_callback("job.phase_changed", {"message": "Solving"}, None)
        return RunOutput(
            result=OptimizationResult(OptimizationOutcome.OPTIMAL, 42, "OPTIMAL", "optimality_proven"),
            artifact=StoredArtifact("schedule.xlsx", "application/test", b"fake xlsx"),
        )


class StoppableRunner:
    def __init__(self):
        # Spawn-shared events stay observable across the supervised child boundary.
        context = multiprocessing.get_context("spawn")
        self.started = context.Event()
        self.finished = context.Event()

    def run(self, job, input_bytes, *, event_callback, should_stop):
        self.started.set()
        while should_stop is not None and not should_stop():
            time.sleep(0.005)
        self.finished.set()
        return RunOutput(
            result=OptimizationResult(OptimizationOutcome.FEASIBLE, 7, "FEASIBLE", "user_requested"),
            artifact=StoredArtifact("schedule.xlsx", "application/test", b"partial"),
        )


def _settings(**updates) -> ServerSettings:
    values = {"claim_poll_seconds": 0.005, "maintenance_interval_seconds": 60, "sse_keepalive_seconds": 0.01}
    values.update(updates)
    return ServerSettings(**values)


def _client(runner=None, *, start_background=True) -> TestClient:
    app = create_app(
        settings=_settings(),
        store=MemoryJobStore(),
        runner=runner or SuccessfulRunner(),
        start_background=start_background,
    )
    return TestClient(app)


def _create(client, **data):
    return client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO, **data})


def _wait_for_terminal(client, job_id: str) -> dict:
    for _ in range(400):
        body = client.get(f"/optimize/{job_id}").json()
        if body["terminal"]:
            return body
        time.sleep(0.01)
    raise AssertionError(f"Job did not finish: {job_id}")


def test_synchronous_store_reads_do_not_block_the_asgi_event_loop():
    class BlockingGetStore(MemoryJobStore):
        def __init__(self):
            super().__init__()
            self.block_reads = False
            self.read_started = threading.Event()
            self.release_reads = threading.Event()

        def get(self, job_id):
            if self.block_reads:
                self.read_started.set()
                self.release_reads.wait(timeout=2)
            return super().get(job_id)

    store = BlockingGetStore()
    app = create_app(settings=_settings(), store=store, runner=SuccessfulRunner(), start_background=False)
    created = app.state.job_controller.create_job(
        input_name="input.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=False,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )
    store.block_reads = True

    async def exercise_requests():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            release_timer = threading.Timer(1, store.release_reads.set)
            release_timer.start()
            started_at = time.monotonic()
            job_request = asyncio.create_task(client.get(f"/optimize/{created.id}"))
            try:
                await asyncio.sleep(0)
                health = await client.get("/health")
                health_elapsed = time.monotonic() - started_at
            finally:
                store.release_reads.set()
                release_timer.cancel()
            await job_request
            return health, health_elapsed

    health, health_elapsed = asyncio.run(exercise_requests())
    assert store.read_started.is_set()
    assert health.status_code == 200
    assert health_elapsed < 0.5


def test_job_creation_offloads_the_synchronous_store_write():
    class ThreadRecordingStore(MemoryJobStore):
        create_thread_id = None

        def create(self, *args, **kwargs):
            self.create_thread_id = threading.get_ident()
            return super().create(*args, **kwargs)

    store = ThreadRecordingStore()
    app = create_app(settings=_settings(), store=store, runner=SuccessfulRunner(), start_background=False)

    async def create_job():
        event_loop_thread_id = threading.get_ident()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post("/optimize", data={"yaml_content": MINIMAL_SCENARIO})
        return event_loop_thread_id, response

    event_loop_thread_id, response = asyncio.run(create_job())
    assert response.status_code == 202
    assert store.create_thread_id is not None
    assert store.create_thread_id != event_loop_thread_id


def test_cancel_running_job_stops_worker_and_discards_result():
    runner = StoppableRunner()
    with _client(runner) as client:
        created = _create(client).json()
        assert runner.started.wait(timeout=3)
        response = client.post(f"/optimize/{created['id']}/cancel")
        assert response.status_code == 202
        assert response.json()["state"] in {"cancelling", "cancelled"}

        cancelled = _wait_for_terminal(client, created["id"])
        assert cancelled["state"] == "cancelled"
        assert cancelled["result"] is None


def test_finish_now_completes_with_current_feasible_result():
    runner = StoppableRunner()
    with _client(runner) as client:
        created = _create(client).json()
        assert runner.started.wait(timeout=3)
        response = client.post(f"/optimize/{created['id']}/finish-now")
        assert response.status_code == 202

        completed = _wait_for_terminal(client, created["id"])
        assert completed["state"] == "completed"
        assert completed["result"]["outcome"] == "feasible"


def test_worker_survives_when_failure_persistence_also_fails():
    from nurse_scheduling.server.jobs.models import Job, JobRequest

    job = Job(
        id="job_store_failure",
        state=JobState.RUNNING,
        request=JobRequest("input.yaml", "client", "ortools/cp-sat", True, 60),
        created_at=datetime.now(timezone.utc),
    )

    class FailingController:
        def __init__(self):
            self.claim_calls = 0
            self.next_claim_attempted = threading.Event()

        def claim_next_job(self, _worker_id):
            self.claim_calls += 1
            if self.claim_calls == 1:
                return job
            self.next_claim_attempted.set()
            return None

        def renew_claim(self, _job_id, _worker_id):
            return job

        def get_input(self, _job_id):
            raise ConnectionError("store unavailable")

        def fail_job(self, _job_id, _failure, *, worker_id=None):
            raise ConnectionError("store still unavailable")

    controller = FailingController()
    worker = JobWorker(
        controller, SuccessfulRunner(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=60
    )
    worker.start()
    try:
        assert controller.next_claim_attempted.wait(timeout=2)
        assert worker.is_alive()
    finally:
        worker.stop()


def _claimed_running_job(store, clock):
    """Create and claim one running job under a frozen-clock controller."""
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=1, max_retained=2),
        retention_seconds=60,
        claim_lease_seconds=30,
        clock=lambda: clock[0],
    )
    controller.create_job(
        input_name="input.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=True,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )
    claimed = controller.claim_next_job("worker")
    assert claimed is not None
    return controller, claimed


def test_worker_shutdown_discards_buffered_event(monkeypatch):
    # A buffered child event the executor drains ahead of an abort must not be
    # persisted once shutdown is in effect; maintenance owns the eventual worker_lost.
    clock = [datetime.now(timezone.utc)]
    store = MemoryJobStore()
    controller, claimed = _claimed_running_job(store, clock)
    before_events = list(controller.prepare_event_replay(claimed.id, None).initial_events)

    def fake_run_optimization_process(*_args, event_callback, control, **_kwargs):
        worker._stop.set()
        event_callback("job.phase_changed", {"phase": "buffered"}, None)
        return ProcessResult(status=ProcessStatus.ABORTED)

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(controller, object(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=30)
    worker._execute(claimed)

    assert controller.get_job(claimed.id).state == JobState.RUNNING
    assert controller.prepare_event_replay(claimed.id, None).initial_events == before_events

    clock[0] += timedelta(seconds=31)
    assert controller.expire_worker_claims() == [claimed.id]
    assert controller.get_job(claimed.id).failure.code == "worker_lost"


def test_worker_shutdown_discards_buffered_result(monkeypatch):
    # A completion the executor returns ahead of an abort must not commit once
    # shutdown is in effect; the job stays running for maintenance to reclaim.
    clock = [datetime.now(timezone.utc)]
    store = MemoryJobStore()
    controller, claimed = _claimed_running_job(store, clock)

    def fake_run_optimization_process(*_args, control, **_kwargs):
        worker._stop.set()
        return ProcessResult(
            status=ProcessStatus.COMPLETED,
            output=RunOutput(
                result=OptimizationResult(OptimizationOutcome.OPTIMAL, 42, "OPTIMAL", "optimality_proven"),
                artifact=StoredArtifact("schedule.xlsx", "application/test", b"fake xlsx"),
            ),
        )

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(controller, object(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=30)
    worker._execute(claimed)

    current = controller.get_job(claimed.id)
    assert current.state == JobState.RUNNING
    assert current.result is None
    assert current.artifact_name is None

    clock[0] += timedelta(seconds=31)
    assert controller.expire_worker_claims() == [claimed.id]
    assert controller.get_job(claimed.id).failure.code == "worker_lost"


def test_worker_shutdown_suppresses_abort_cleanup_failure(monkeypatch):
    # An abort-path cleanup exception raised during shutdown must not persist a
    # failure over the still-valid lease; maintenance owns the worker_lost write.
    clock = [datetime.now(timezone.utc)]
    store = MemoryJobStore()
    controller, claimed = _claimed_running_job(store, clock)

    def fake_run_optimization_process(*_args, control, **_kwargs):
        worker._stop.set()
        raise OSError("abort cleanup failed")

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(controller, object(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=30)
    worker._execute(claimed)

    current = controller.get_job(claimed.id)
    assert current.state == JobState.RUNNING
    assert current.failure is None

    clock[0] += timedelta(seconds=31)
    assert controller.expire_worker_claims() == [claimed.id]
    assert controller.get_job(claimed.id).failure.code == "worker_lost"


def test_stop_blocks_until_admitted_completion_persists(monkeypatch):
    # Linearization: a completion admitted past the shutdown gate holds
    # _shutdown_lock across the controller write, so stop() cannot set the shutdown
    # flag until the write resolves. The write admitted before stop therefore
    # completes, and stop() only returns afterward.
    clock = [datetime.now(timezone.utc)]
    store = MemoryJobStore()
    base_controller, claimed = _claimed_running_job(store, clock)

    write_entered = threading.Event()
    release_write = threading.Event()

    class PausingController:
        def __getattr__(self, name):
            return getattr(base_controller, name)

        def complete_job(self, *args, **kwargs):
            write_entered.set()
            assert release_write.wait(timeout=2)
            return base_controller.complete_job(*args, **kwargs)

    def fake_run_optimization_process(*_args, control, **_kwargs):
        return ProcessResult(
            status=ProcessStatus.COMPLETED,
            output=RunOutput(
                result=OptimizationResult(OptimizationOutcome.OPTIMAL, 42, "OPTIMAL", "optimality_proven"),
                artifact=StoredArtifact("schedule.xlsx", "application/test", b"fake xlsx"),
            ),
        )

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(
        PausingController(), object(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=30
    )

    execute_thread = threading.Thread(target=worker._execute, args=(claimed,))
    execute_thread.start()
    stop_returned = threading.Event()
    try:
        assert write_entered.wait(timeout=2)

        def do_stop():
            worker.stop()
            stop_returned.set()

        stop_thread = threading.Thread(target=do_stop)
        stop_thread.start()
        try:
            # stop() is blocked acquiring _shutdown_lock; it cannot enter between
            # the write's admission and its persistence.
            assert not stop_returned.wait(timeout=0.2)
            assert not worker._stop.is_set()

            release_write.set()
            assert stop_returned.wait(timeout=3)
            assert worker._stop.is_set()
        finally:
            stop_thread.join(timeout=3)
        execute_thread.join(timeout=3)
        assert base_controller.get_job(claimed.id).state == JobState.COMPLETED
    finally:
        release_write.set()
        worker.stop()
        execute_thread.join(timeout=3)


def test_stop_blocks_until_admitted_event_persists(monkeypatch):
    # The same serialization protects the progress-event write: an event admitted
    # before stop persists, and stop() cannot set the flag mid-write.
    clock = [datetime.now(timezone.utc)]
    store = MemoryJobStore()
    base_controller, claimed = _claimed_running_job(store, clock)
    before_events = list(base_controller.prepare_event_replay(claimed.id, None).initial_events)

    write_entered = threading.Event()
    release_write = threading.Event()

    class PausingController:
        def __getattr__(self, name):
            return getattr(base_controller, name)

        def record_event(self, *args, **kwargs):
            write_entered.set()
            assert release_write.wait(timeout=2)
            return base_controller.record_event(*args, **kwargs)

    def fake_run_optimization_process(*_args, event_callback, control, **_kwargs):
        event_callback("job.phase_changed", {"phase": "admitted"}, None)
        return ProcessResult(status=ProcessStatus.ABORTED)

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(
        PausingController(), object(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=30
    )

    execute_thread = threading.Thread(target=worker._execute, args=(claimed,))
    execute_thread.start()
    stop_returned = threading.Event()
    try:
        assert write_entered.wait(timeout=2)

        def do_stop():
            worker.stop()
            stop_returned.set()

        stop_thread = threading.Thread(target=do_stop)
        stop_thread.start()
        try:
            assert not stop_returned.wait(timeout=0.2)
            assert not worker._stop.is_set()

            release_write.set()
            assert stop_returned.wait(timeout=3)
        finally:
            stop_thread.join(timeout=3)
        execute_thread.join(timeout=3)
        events_after = list(base_controller.prepare_event_replay(claimed.id, None).initial_events)
        assert len(events_after) == len(before_events) + 1
    finally:
        release_write.set()
        worker.stop()
        execute_thread.join(timeout=3)


def test_cancellation_settles_when_cleanup_raises_after_shutdown(monkeypatch):
    # Cancellation observed under a valid claim beats a later ordinary shutdown even
    # when executor cleanup raises: it settles cancelled immediately through the
    # lease-fenced complete_cancellation rather than waiting for maintenance.
    store = MemoryJobStore()
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=1, max_retained=2),
        retention_seconds=60,
        claim_lease_seconds=30,
    )
    created = controller.create_job(
        input_name="input.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=True,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )
    process_started = threading.Event()
    cleanup_raised = threading.Event()

    def fake_run_optimization_process(*_args, control, **_kwargs):
        process_started.set()
        deadline = time.monotonic() + 3
        while control() is not ProcessControl.CANCEL:
            if time.monotonic() >= deadline:
                raise AssertionError("worker did not observe cancellation")
            time.sleep(0.005)
        # Ordinary shutdown races in after cancellation was observed, then the
        # executor's abort cleanup fails.
        worker._stop.set()
        cleanup_raised.set()
        raise OSError("abort cleanup failed")

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(controller, object(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=30)
    worker.start()
    try:
        assert process_started.wait(timeout=3)
        controller.cancel_job(created.id)
        for _ in range(400):
            if controller.get_job(created.id).state.terminal:
                break
            time.sleep(0.005)

        assert cleanup_raised.is_set()
        settled = controller.get_job(created.id)
        assert settled.state == JobState.CANCELLED
        assert settled.failure.code == "cancelled"
    finally:
        worker.stop()


def test_worker_cancellation_takes_priority_over_concurrent_shutdown(monkeypatch):
    # A cancellation observed under a valid claim must beat an ordinary shutdown
    # that races in afterward, and settle the job cancelled via complete_cancellation.
    store = MemoryJobStore()
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=1, max_retained=2),
        retention_seconds=60,
        claim_lease_seconds=30,
    )
    created = controller.create_job(
        input_name="input.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=True,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )
    process_started = threading.Event()
    control_selected = threading.Event()
    selected_controls = []

    def fake_run_optimization_process(*_args, control, **_kwargs):
        process_started.set()
        deadline = time.monotonic() + 3
        while control() is not ProcessControl.CANCEL:
            if time.monotonic() >= deadline:
                raise AssertionError("worker did not observe cancellation")
            time.sleep(0.005)
        # Shutdown begins after the worker observed cancellation but before the
        # executor consumes the highest-priority pending control.
        worker._stop.set()
        selected = control()
        selected_controls.append(selected)
        control_selected.set()
        status = ProcessStatus.CANCELLED if selected is ProcessControl.CANCEL else ProcessStatus.ABORTED
        return ProcessResult(status=status)

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(controller, object(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=30)
    worker.start()
    try:
        assert process_started.wait(timeout=3)
        controller.cancel_job(created.id)
        assert control_selected.wait(timeout=3)
        for _ in range(200):
            if controller.get_job(created.id).state.terminal:
                break
            time.sleep(0.005)

        assert selected_controls == [ProcessControl.CANCEL]
        assert controller.get_job(created.id).state == JobState.CANCELLED
    finally:
        worker.stop()


def test_worker_renews_claim_during_long_running_job(monkeypatch):
    # The supervised child is emulated in-thread so lease renewal and the
    # finish-now hand-off are observed deterministically, without the spawn
    # latency that the rebuild's real-time confirmed-deadline abort reacts to.
    # A real clock and a several-second lease keep the store's wall-clock claim
    # fence satisfied while the heartbeat (lease/3) still renews within the test.
    store = MemoryJobStore()
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=1, max_retained=2),
        retention_seconds=60,
        claim_lease_seconds=3.0,
    )
    created = controller.create_job(
        input_name="input.yaml",
        client_id="client",
        solver="ortools/cp-sat",
        prettify=True,
        timeout_seconds=60,
        input_bytes=b"apiVersion: alpha\n",
    )

    class ControllerWithRenewalSignal:
        def __init__(self, delegate):
            self.delegate = delegate
            self.renewal_allowed = threading.Event()
            self.claim_renewed = threading.Event()
            self.renewed_job = None

        def __getattr__(self, name):
            return getattr(self.delegate, name)

        def renew_claim(self, job_id, worker_id):
            self.renewal_allowed.wait(timeout=2)
            renewed = self.delegate.renew_claim(job_id, worker_id)
            if renewed is not None:
                self.renewed_job = renewed
                self.claim_renewed.set()
            return renewed

    worker_controller = ControllerWithRenewalSignal(controller)
    process_started = threading.Event()
    finish_observed = threading.Event()

    def fake_run_optimization_process(*_args, control, **_kwargs):
        process_started.set()
        deadline = time.monotonic() + 3
        while True:
            requested = control()
            if requested is ProcessControl.FINISH:
                finish_observed.set()
                return ProcessResult(
                    status=ProcessStatus.COMPLETED,
                    output=RunOutput(
                        result=OptimizationResult(OptimizationOutcome.FEASIBLE, 7, "FEASIBLE", "user_requested"),
                        artifact=StoredArtifact("schedule.xlsx", "application/test", b"partial"),
                    ),
                )
            if requested is ProcessControl.ABORT or time.monotonic() >= deadline:
                return ProcessResult(status=ProcessStatus.ABORTED)
            time.sleep(0.005)

    monkeypatch.setattr(
        "nurse_scheduling.server.jobs.worker.run_optimization_process",
        fake_run_optimization_process,
    )
    worker = JobWorker(
        worker_controller, object(), worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=3.0
    )
    worker.start()
    try:
        assert process_started.wait(timeout=3)
        initial_claim = controller.get_job(created.id)
        worker_controller.renewal_allowed.set()
        assert worker_controller.claim_renewed.wait(timeout=5)
        assert worker_controller.renewed_job.claim_expires_at > initial_claim.claim_expires_at

        controller.request_early_completion(created.id)
        assert finish_observed.wait(timeout=3)
        for _ in range(200):
            if controller.get_job(created.id).state == JobState.COMPLETED:
                break
            time.sleep(0.005)
        assert controller.get_job(created.id).state == JobState.COMPLETED
    finally:
        worker.stop()
