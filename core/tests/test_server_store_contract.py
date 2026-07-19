"""Shared lifecycle/capacity/revision/event/artifact contract for every job store."""

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

from dataclasses import replace
from datetime import timedelta

import pytest

from nurse_scheduling.server.errors import (
    JobArtifactNotFoundError,
    JobCapacityError,
    JobNotFoundError,
    StoreWriteConflictError,
)
from nurse_scheduling.server.jobs.models import (
    JobEvent,
    JobFailure,
    JobState,
    StoredArtifact,
    StoreLimits,
)
from tests.server_support import make_job, utc_now

LIMITS = StoreLimits(max_pending=8, max_retained=128)


def _state_event(state: str):
    return JobEvent(type="job.state_changed", data={"state": state}, occurred_at=utc_now())


def _terminal(job, state=JobState.COMPLETED):
    return replace(
        job,
        state=state,
        finished_at=utc_now(),
        queue_position=None,
        failure=JobFailure("cancelled", "x") if state == JobState.CANCELLED else None,
    )


def test_create_get_and_input(store):
    created = store.create(make_job("job_a"), b"payload", LIMITS, [_state_event("queued")])
    assert created.revision == 1
    assert created.queue_position == 1
    assert store.get("job_a").id == "job_a"
    assert store.get_input("job_a") == b"payload"


def test_get_missing_raises(store):
    with pytest.raises(JobNotFoundError):
        store.get("nope")


def test_duplicate_id_conflicts(store):
    store.create(make_job("job_a"), b"x", LIMITS, [_state_event("queued")])
    with pytest.raises(StoreWriteConflictError):
        store.create(make_job("job_a"), b"y", LIMITS, [_state_event("queued")])


def test_pending_capacity_enforced(store):
    limits = StoreLimits(max_pending=2, max_retained=128)
    store.create(make_job("job_1"), b"x", limits, [_state_event("queued")])
    store.create(make_job("job_2"), b"x", limits, [_state_event("queued")])
    with pytest.raises(JobCapacityError):
        store.create(make_job("job_3"), b"x", limits, [_state_event("queued")])


def test_retained_capacity_evicts_oldest_terminal(store):
    limits = StoreLimits(max_pending=4, max_retained=2)
    first = store.create(make_job("job_old", created_at=utc_now() - timedelta(minutes=5)), b"x", limits, [])
    store.save(_terminal(first), first.revision, [_state_event("completed")])
    second = store.create(make_job("job_new"), b"x", limits, [])
    # A third create must evict the oldest terminal job (job_old), not fail.
    store.create(make_job("job_third"), b"x", limits, [])
    with pytest.raises(JobNotFoundError):
        store.get("job_old")
    assert store.get(second.id).id == "job_new"


def test_claim_next_is_fifo_and_marks_running(store):
    store.create(make_job("job_1", created_at=utc_now() - timedelta(seconds=2)), b"x", LIMITS, [_state_event("queued")])
    store.create(make_job("job_2", created_at=utc_now()), b"x", LIMITS, [_state_event("queued")])
    now = utc_now()
    claimed = store.claim_next("worker-1", now, now + timedelta(seconds=90))
    assert claimed.id == "job_1"
    assert claimed.state == JobState.RUNNING
    assert claimed.worker_id == "worker-1"
    assert claimed.revision == 2
    assert store.claim_next("worker-1", now, now + timedelta(seconds=90)).id == "job_2"
    assert store.claim_next("worker-1", now, now + timedelta(seconds=90)) is None


def test_store_exposes_nonempty_identity(store):
    assert isinstance(store.store_id, str)
    assert store.store_id.strip()


def test_claim_next_records_worker_and_runtime_identity(store):
    runtime_identity = {
        "service_name": "nurse-scheduling-api",
        "api_version": "alpha",
        "app_version": "v-test",
        "deployment_id": "deployment-test",
        "instance_id": "instance-test",
        "started_at": utc_now().isoformat(),
        "job_backend": "redis",
        "job_store_id": "store-test",
    }
    store.create(make_job("job_1"), b"x", LIMITS, [_state_event("queued")])
    now = utc_now()
    claimed = store.claim_next("worker-1", now, now + timedelta(seconds=90), runtime_identity)
    assert claimed.id == "job_1"

    window = store.prepare_event_replay("job_1", None)
    running = next(event for event in window.initial_events if event.data.get("state") == "running")
    assert running.data["worker_id"] == "worker-1"
    assert running.data["runtime"] == runtime_identity


def test_save_revision_guard(store):
    created = store.create(make_job("job_a"), b"x", LIMITS, [_state_event("queued")])
    running = replace(created, state=JobState.RUNNING, worker_id="w")
    saved = store.save(running, created.revision, [_state_event("running")])
    assert saved.revision == created.revision + 1
    with pytest.raises(StoreWriteConflictError):
        store.save(running, created.revision, [_state_event("running")])


def test_save_missing_job_raises(store):
    with pytest.raises(JobNotFoundError):
        store.save(make_job("ghost"), 1, [])


def test_artifacts_round_trip(store):
    created = store.create(make_job("job_a"), b"x", LIMITS, [])
    artifact = StoredArtifact(name="schedule.xlsx", media_type="application/octet-stream", content=b"xlsxbytes")
    completed = replace(_terminal(created), artifact_name="schedule.xlsx")
    store.save(completed, created.revision, [_state_event("completed")], artifact=artifact)
    fetched = store.get_artifact("job_a", "schedule.xlsx")
    assert fetched.content == b"xlsxbytes"
    with pytest.raises(JobArtifactNotFoundError):
        store.get_artifact("job_a", "other.xlsx")


def test_delete_revision_guard(store):
    created = store.create(make_job("job_a"), b"x", LIMITS, [])
    terminal = _terminal(created)
    store.save(terminal, created.revision, [_state_event("completed")])
    with pytest.raises(StoreWriteConflictError):
        store.delete("job_a", created.revision)
    store.delete("job_a", created.revision + 1)
    with pytest.raises(JobNotFoundError):
        store.get("job_a")


def test_find_finished_and_claimed(store):
    created = store.create(make_job("job_done"), b"x", LIMITS, [])
    store.save(_terminal(created), created.revision, [_state_event("completed")])
    assert [job.id for job in store.find_finished_before(utc_now() + timedelta(hours=1))] == ["job_done"]

    running = store.create(make_job("job_run"), b"x", LIMITS, [_state_event("queued")])
    now = utc_now()
    store.claim_next("w", now, now + timedelta(seconds=1))
    claimed_expired = store.find_claimed_before(now + timedelta(seconds=5))
    assert running.id in {job.id for job in claimed_expired}


def test_check_health_ok(store):
    store.check_health()
