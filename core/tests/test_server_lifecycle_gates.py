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
        self.started = threading.Event()
        self.finished = threading.Event()

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


def test_worker_renews_claim_during_long_running_job():
    now = [datetime.now(timezone.utc)]
    store = MemoryJobStore()
    controller = JobController(
        store,
        limits=StoreLimits(max_pending=1, max_retained=2),
        retention_seconds=60,
        claim_lease_seconds=0.06,
        clock=lambda: now[0],
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
    runner = StoppableRunner()
    worker = JobWorker(
        worker_controller, runner, worker_id="worker", claim_poll_seconds=0.005, claim_lease_seconds=0.06
    )
    worker.start()
    try:
        assert runner.started.wait(timeout=3)
        initial_claim = controller.get_job(created.id)
        now[0] += timedelta(seconds=0.01)
        worker_controller.renewal_allowed.set()
        assert worker_controller.claim_renewed.wait(timeout=3)
        assert worker_controller.renewed_job.claim_expires_at > initial_claim.claim_expires_at

        controller.request_early_completion(created.id)
        assert runner.finished.wait(timeout=3)
        assert controller.get_job(created.id).state == JobState.COMPLETED
    finally:
        worker.stop()
