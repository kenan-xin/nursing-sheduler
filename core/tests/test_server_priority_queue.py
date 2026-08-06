"""Atomic ordinary-first priority queue semantics across every backend (T09).

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

Every test here runs against memory, the isolated fakeredis fallback, AND real
Redis when `NURSE_TEST_REDIS_URL` is configured. That breadth is the point: the
fakeredis adapter exists only because fakeredis cannot execute Lua, so a suite
that passed only there would have proved nothing about the state machine that
actually ships.

After every transition the six invariants are asserted against a fresh atomic
snapshot of what the store PERSISTED, not against what the transition returned
about itself. A non-atomic transition shows up as a torn intermediate state that
no legal snapshot could contain.
"""

import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from nurse_scheduling.server.app import create_app

from nurse_scheduling.server.errors import (
    DiagnosticCapacityError,
    JobCapacityError,
    QueueInvariantError,
    StoreWriteConflictError,
)
from nurse_scheduling.server.config import ServerSettings
from nurse_scheduling.server.jobs.models import (
    Job,
    JobEvent,
    JobFailure,
    JobPurpose,
    JobState,
    StoreLimits,
)
from nurse_scheduling.server.queue_state import (
    INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER,
    INVARIANT_ERROR_STALE_QUEUE_MEMBER,
    MAX_RETAINED_INVARIANT_ERRORS,
    QUEUE_STATE_MACHINE_VERSION,
    JobQueueFacts,
    QueueMember,
    QueueStateSnapshot,
    admission_decision,
    check_queue_invariants,
    effective_positions,
)
from nurse_scheduling.server.stores.queue_script import QUEUE_KEY_HASH_TAG
from tests.server_support import (
    MINIMAL_SCENARIO,
    _make_fakeredis_store,
    assert_queue_invariants,
    make_job,
    utc_now,
)


DEPLOYED_LIMITS = StoreLimits(max_pending=8, max_retained=128, ordinary_reserved_slots=1)
"""The shipped configuration: eight pending slots, one reserved for ordinary work."""

ORDINARY = JobPurpose.ORDINARY
DIAGNOSTIC = JobPurpose.ASSISTANT_DIAGNOSTIC


def _state_event(state: str) -> JobEvent:
    """Build the lifecycle event a store records alongside a transition."""
    return JobEvent(type="job.state_changed", data={"state": state}, occurred_at=utc_now())


def _admit(store, job_id, purpose, *, offset_seconds=0.0, limits=DEPLOYED_LIMITS) -> Job:
    """Admit one job whose creation time fixes its FIFO rank within its purpose."""
    created_at = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc) + timedelta(seconds=offset_seconds)
    job = make_job(job_id, purpose=purpose, created_at=created_at)
    return store.create(job, b"input", limits, [_state_event("queued")])


def _claim(store, worker_id="worker-1", *, lease_seconds=90.0) -> Job | None:
    """Claim the effective queue head for a worker holding a live lease."""
    now = utc_now()
    return store.claim_next(worker_id, now, now + timedelta(seconds=lease_seconds))


def _terminalize(store, job: Job, state: JobState, *, worker_id=None) -> Job:
    """Drive one job to a terminal state through the ordinary save contract."""
    current = store.get(job.id)
    terminal = replace(
        current,
        state=state,
        finished_at=utc_now(),
        claim_expires_at=None,
        worker_id=current.worker_id,
        failure=JobFailure(code=state.value, message="settled") if state != JobState.COMPLETED else None,
    )
    return store.save(
        terminal,
        current.revision,
        [_state_event(state.value)],
        worker_id=worker_id,
        expected_claim_expires_at=current.claim_expires_at if worker_id is not None else None,
    )


def test_purpose_defaults_to_ordinary_and_survives_persistence(store):
    """An unqualified submission is ordinary work with full pending capacity."""
    created = store.create(make_job("job_default"), b"input", DEPLOYED_LIMITS, [_state_event("queued")])
    assert created.request.purpose is ORDINARY
    assert store.get("job_default").request.purpose is ORDINARY
    snapshot = assert_queue_invariants(store, context="default-purpose admission")
    assert [member.job_id for member in snapshot.ordinary_members] == ["job_default"]
    assert snapshot.diagnostic_members == ()


def test_purpose_round_trips_and_cannot_be_rewritten(store):
    """Purpose is immutable: a save that changes it is refused, not applied."""
    admitted = _admit(store, "job_diag", DIAGNOSTIC)
    assert admitted.request.purpose is DIAGNOSTIC
    assert store.get("job_diag").request.purpose is DIAGNOSTIC

    current = store.get("job_diag")
    rewritten = replace(current, request=replace(current.request, purpose=ORDINARY))
    with pytest.raises(QueueInvariantError):
        store.save(rewritten, current.revision, [])
    # Refused, not partially applied: the stored purpose and its queue are unchanged.
    assert store.get("job_diag").request.purpose is DIAGNOSTIC
    snapshot = assert_queue_invariants(store, context="refused purpose rewrite")
    assert [member.job_id for member in snapshot.diagnostic_members] == ["job_diag"]


def test_seven_diagnostics_leave_one_ordinary_slot(store):
    """The reserve is a floor on ordinary admission, proved at the boundary."""
    for index in range(7):
        _admit(store, f"job_diag_{index}", DIAGNOSTIC, offset_seconds=index)
    assert_queue_invariants(store, context="seven diagnostics")

    # The eighth slot exists, but it is reserved: a diagnostic is refused with the
    # stable code, and the refusal names nothing about the submission.
    with pytest.raises(DiagnosticCapacityError) as refusal:
        _admit(store, "job_diag_over", DIAGNOSTIC, offset_seconds=7)
    assert refusal.value.code == "diagnostic_capacity_reserved"
    assert "input" not in str(refusal.value)
    assert "job_diag_over" not in str(refusal.value)

    # ...and the reserved slot is genuinely usable by ordinary work.
    accepted = _admit(store, "job_ordinary", ORDINARY, offset_seconds=8)
    assert accepted.state is JobState.QUEUED
    snapshot = assert_queue_invariants(store, context="ordinary into the reserved slot")
    assert len(snapshot.pending_ids) == 8

    # Now every slot is gone, so even ordinary work is refused — with the ordinary
    # capacity code, which a client must be able to tell apart from the reserve.
    with pytest.raises(JobCapacityError) as exhausted:
        _admit(store, "job_ordinary_over", ORDINARY, offset_seconds=9)
    assert exhausted.value.code == "job_capacity_exceeded"
    assert_queue_invariants(store, context="pending capacity exhausted")


def test_ordinary_head_is_claimed_before_older_queued_diagnostics(store):
    """Ordinary work overtakes queued diagnostics even when it arrived later."""
    _admit(store, "job_diag_old", DIAGNOSTIC, offset_seconds=0)
    _admit(store, "job_diag_new", DIAGNOSTIC, offset_seconds=1)
    _admit(store, "job_ord_late", ORDINARY, offset_seconds=5)

    snapshot = assert_queue_invariants(store, context="mixed queue")
    positions = {entry.job_id: entry.position for entry in effective_positions(snapshot)}
    # The ordinary job is position 1 despite being the newest; each diagnostic's
    # position counts the whole ordinary queue ahead of it.
    assert positions == {"job_ord_late": 1, "job_diag_old": 2, "job_diag_new": 3}

    # The position snapshot is a PREDICTION of the next claim, and it holds.
    assert _claim(store).id == "job_ord_late"
    assert_queue_invariants(store, context="ordinary claim")
    assert _claim(store, "worker-2").id == "job_diag_old"
    assert _claim(store, "worker-3").id == "job_diag_new"
    assert _claim(store, "worker-4") is None
    assert_queue_invariants(store, context="drained queues")


def test_effective_positions_exclude_active_and_terminal_jobs(store):
    """Only queued jobs hold positions; claiming and settling remove them."""
    _admit(store, "job_a", ORDINARY, offset_seconds=0)
    _admit(store, "job_b", ORDINARY, offset_seconds=1)
    _admit(store, "job_c", DIAGNOSTIC, offset_seconds=2)

    running = _claim(store)
    assert running.id == "job_a"
    assert running.queue_position is None
    snapshot = assert_queue_invariants(store, context="one running job")
    assert {entry.job_id for entry in effective_positions(snapshot)} == {"job_b", "job_c"}
    # The remaining jobs were renumbered by the same transition that claimed job_a.
    assert store.get("job_b").queue_position == 1
    assert store.get("job_c").queue_position == 2

    _terminalize(store, running, JobState.COMPLETED, worker_id="worker-1")
    snapshot = assert_queue_invariants(store, context="completion")
    assert {entry.job_id for entry in effective_positions(snapshot)} == {"job_b", "job_c"}
    assert store.get("job_a").queue_position is None


def test_queued_cancellation_releases_capacity_exactly_once(store):
    """A cancelled queued job frees exactly one slot and cannot be claimed after."""
    _admit(store, "job_keep", ORDINARY, offset_seconds=0)
    cancelled = _admit(store, "job_drop", DIAGNOSTIC, offset_seconds=1)

    _terminalize(store, cancelled, JobState.CANCELLED)
    snapshot = assert_queue_invariants(store, context="queued cancellation")
    # One slot released, and the cancelled job is gone from its queue — not merely
    # marked, which is what would let it be claimed or double-counted later.
    assert snapshot.pending_ids == frozenset({"job_keep"})
    assert snapshot.diagnostic_members == ()

    # Repeating the same terminal save is idempotent and must not free a second slot.
    current = store.get("job_drop")
    store.save(replace(current, state=JobState.CANCELLED), current.revision, [])
    repeated = assert_queue_invariants(store, context="repeated cancellation")
    assert repeated.pending_ids == frozenset({"job_keep"})

    # The only claimable job is the survivor; the cancelled one never comes back.
    assert _claim(store).id == "job_keep"
    assert _claim(store, "worker-2") is None
    assert_queue_invariants(store, context="claim after cancellation")


def test_running_job_is_not_preempted_and_cancellation_is_explicit(store):
    """A running diagnostic keeps its slot; later ordinary work queues behind it."""
    _admit(store, "job_diag_running", DIAGNOSTIC, offset_seconds=0)
    running = _claim(store)
    assert running.id == "job_diag_running"

    # Ordinary work arriving now is ACCEPTED and QUEUED. It does not evict, stop, or
    # reclaim the running diagnostic: claiming only ever removes a queued member.
    ordinary = _admit(store, "job_ord", ORDINARY, offset_seconds=1)
    assert ordinary.state is JobState.QUEUED
    assert ordinary.queue_position == 1
    snapshot = assert_queue_invariants(store, context="ordinary queued behind a running diagnostic")
    assert store.get("job_diag_running").state is JobState.RUNNING
    assert snapshot.jobs["job_diag_running"].has_claim_lease is True

    # Freeing the worker requires an EXPLICIT cancellation, and it is observable:
    # cancelling passes through a pending, still-claimed intermediate state.
    current = store.get("job_diag_running")
    cancelling = store.save(
        replace(current, state=JobState.CANCELLING, cancel_requested=True),
        current.revision,
        [_state_event("cancelling")],
    )
    assert cancelling.state is JobState.CANCELLING
    snapshot = assert_queue_invariants(store, context="cancellation requested")
    assert "job_diag_running" in snapshot.pending_ids
    assert snapshot.jobs["job_diag_running"].has_claim_lease is True

    _terminalize(store, cancelling, JobState.CANCELLED, worker_id="worker-1")
    snapshot = assert_queue_invariants(store, context="cancellation completed")
    assert snapshot.pending_ids == frozenset({"job_ord"})
    assert snapshot.jobs["job_diag_running"].has_claim_lease is False


def test_expired_claim_terminalization_releases_capacity_once(store):
    """Claim expiry terminalizes a lost worker's job and frees its slot once."""
    _admit(store, "job_lost", ORDINARY, offset_seconds=0)
    now = utc_now()
    claimed = store.claim_next("worker-gone", now, now - timedelta(seconds=1))
    assert claimed is not None
    assert store.find_claimed_before(now) == [store.get("job_lost")]

    current = store.get("job_lost")
    # Maintenance terminalizes WITHOUT the worker's fence: the worker is presumed
    # lost, so requiring its live claim would leave the slot occupied forever.
    store.save(
        replace(
            current,
            state=JobState.FAILED,
            failure=JobFailure(code="worker_lost", message="worker stopped"),
            finished_at=utc_now(),
            claim_expires_at=None,
        ),
        current.revision,
        [_state_event("failed")],
    )
    snapshot = assert_queue_invariants(store, context="claim-expiry terminalization")
    assert snapshot.pending_ids == frozenset()
    assert snapshot.jobs["job_lost"].has_claim_lease is False
    # The released slot is genuinely reusable, so capacity was freed exactly once.
    for index in range(8):
        _admit(store, f"job_refill_{index}", ORDINARY, offset_seconds=10 + index)
    assert_queue_invariants(store, context="refilled after claim expiry")


def test_stale_worker_cannot_commit_after_its_claim_lapses(store):
    """Lease and revision fencing survive the move onto the state machine."""
    _admit(store, "job_fenced", ORDINARY, offset_seconds=0)
    now = utc_now()
    claimed = store.claim_next("worker-1", now, now + timedelta(seconds=90))

    # A foreign worker's write is refused even with the correct revision.
    with pytest.raises(StoreWriteConflictError):
        store.save(
            replace(claimed, state=JobState.COMPLETED, finished_at=utc_now()),
            claimed.revision,
            [_state_event("completed")],
            worker_id="worker-2",
            expected_claim_expires_at=claimed.claim_expires_at,
        )
    # So is the owner's write against a deadline it never observed.
    with pytest.raises(StoreWriteConflictError):
        store.save(
            replace(claimed, state=JobState.COMPLETED, finished_at=utc_now()),
            claimed.revision,
            [_state_event("completed")],
            worker_id="worker-1",
            expected_claim_expires_at=now + timedelta(seconds=999),
        )
    snapshot = assert_queue_invariants(store, context="refused stale worker commits")
    assert snapshot.jobs["job_fenced"].state is JobState.RUNNING
    assert snapshot.pending_ids == frozenset({"job_fenced"})


def test_terminal_state_cannot_be_walked_back_into_the_queue(store):
    """Resurrection is refused: a released slot cannot be silently re-occupied."""
    admitted = _admit(store, "job_done", ORDINARY, offset_seconds=0)
    _terminalize(store, admitted, JobState.COMPLETED)
    current = store.get("job_done")

    with pytest.raises(QueueInvariantError):
        store.save(replace(current, state=JobState.QUEUED, finished_at=None), current.revision, [])
    with pytest.raises(QueueInvariantError):
        store.save(replace(current, state=JobState.RUNNING, worker_id="worker-9"), current.revision, [])
    snapshot = assert_queue_invariants(store, context="refused resurrection")
    assert snapshot.jobs["job_done"].state is JobState.COMPLETED
    assert snapshot.pending_ids == frozenset()


def _inject_queue_member(store, job_id: str, purpose: JobPurpose, score: float) -> None:
    """Force an index entry no job record justifies, reaching past the state machine.

    Deliberate fault injection through the backend's own index. The state machine
    cannot create this state, which is exactly why the repair path needs a test that
    can: an unexercised repair path is an untested one.
    """
    if hasattr(store, "_queues"):
        store._queues[purpose][job_id] = datetime.fromtimestamp(score, tz=timezone.utc)
        return
    store._redis.zadd(store._queue_keys[purpose], {job_id: score})


def test_orphan_queue_member_is_repaired_and_never_claimed(store):
    """A queue entry with no job record is removed, not started."""
    real = _admit(store, "job_real", ORDINARY, offset_seconds=5)
    _inject_queue_member(store, "job_ghost", ORDINARY, real.created_at.timestamp() - 100)

    # The ghost sorts ahead of the real job, so a store that trusted its index would
    # try to claim it. The claim must skip it and start the job that actually exists.
    claimed = _claim(store)
    assert claimed is not None
    assert claimed.id == "job_real"
    snapshot = assert_queue_invariants(store, context="orphan repair during claim")
    assert "job_ghost" not in {member.job_id for member in snapshot.ordinary_members}

    kinds = [record["kind"] for record in store.recent_invariant_errors()]
    assert INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER in kinds
    # The repair record is bounded and content-free: codes and IDs, never input.
    for record in store.recent_invariant_errors():
        assert set(record) == {"kind", "job_id", "occurred_at"}
        assert "input" not in record["job_id"]


def test_stale_queue_member_for_a_running_job_is_repaired(store):
    """An index entry contradicting its job's state is removed, not double-claimed."""
    admitted = _admit(store, "job_running", ORDINARY, offset_seconds=0)
    claimed = _claim(store)
    assert claimed.id == "job_running"

    # Re-index the RUNNING job. Left alone this is exactly the double-claim bug: one
    # job handed to two workers, each believing it owns the solve.
    _inject_queue_member(store, "job_running", ORDINARY, admitted.created_at.timestamp())
    assert _claim(store, "worker-2") is None

    snapshot = assert_queue_invariants(store, context="stale member repair")
    assert snapshot.ordinary_members == ()
    assert snapshot.jobs["job_running"].state is JobState.RUNNING
    assert store.get("job_running").worker_id == "worker-1"
    assert INVARIANT_ERROR_STALE_QUEUE_MEMBER in [record["kind"] for record in store.recent_invariant_errors()]


def test_explicit_repair_pass_reports_and_clears_residue(store):
    """The standalone repair pass is idempotent and reports what it removed."""
    _admit(store, "job_real", ORDINARY, offset_seconds=0)
    _inject_queue_member(store, "job_ghost_a", ORDINARY, 1.0)
    _inject_queue_member(store, "job_ghost_b", DIAGNOSTIC, 2.0)

    repaired = store.repair_queue_residue()
    assert sorted(repaired) == [INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER, INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER]
    snapshot = assert_queue_invariants(store, context="explicit repair pass")
    assert [member.job_id for member in snapshot.ordinary_members] == ["job_real"]
    # Nothing left to repair, so a second pass is a no-op rather than a re-report.
    assert store.repair_queue_residue() == []


def test_residue_does_not_consume_admission_capacity(store):
    """Repair runs before counting, so residue cannot refuse a legal admission."""
    for index in range(7):
        _admit(store, f"job_ord_{index}", ORDINARY, offset_seconds=index)
    _inject_queue_member(store, "job_ghost", ORDINARY, 100.0)

    # Seven real pending jobs plus a ghost. If the ghost were counted, the reserve
    # boundary would move and this ordinary admission would be wrongly refused.
    accepted = _admit(store, "job_ord_last", ORDINARY, offset_seconds=50)
    assert accepted.state is JobState.QUEUED
    snapshot = assert_queue_invariants(store, context="admission alongside residue")
    assert len(snapshot.pending_ids) == 8


def test_concurrent_admissions_respect_the_reserve_exactly(store):
    """Racing diagnostic admissions cannot collectively overrun the reserve."""
    limits = StoreLimits(max_pending=4, max_retained=64, ordinary_reserved_slots=1)

    def admit(index: int):
        """Attempt one diagnostic admission and report whether it was accepted."""
        try:
            _admit(store, f"job_race_{index}", DIAGNOSTIC, offset_seconds=index, limits=limits)
            return True
        except JobCapacityError:
            return False

    with ThreadPoolExecutor(max_workers=12) as pool:
        accepted = list(pool.map(admit, range(12)))

    # Exactly max_pending - reserve diagnostics fit. Any other number means two
    # admissions passed the same capacity check, which is the race this closes.
    assert sum(accepted) == limits.max_pending - limits.ordinary_reserved_slots
    snapshot = assert_queue_invariants(store, context="concurrent diagnostic admissions")
    assert len(snapshot.pending_ids) == 3
    # And the reserve is still there for ordinary work afterwards.
    _admit(store, "job_ord", ORDINARY, offset_seconds=99, limits=limits)
    assert len(assert_queue_invariants(store, context="reserve honoured after the race").pending_ids) == 4


def test_concurrent_duplicate_admission_admits_one_job(store):
    """Racing admissions of the same ID produce one job, not a lost or doubled one."""

    def admit(_index: int):
        """Attempt to admit the SAME job ID and report whether this attempt won."""
        try:
            _admit(store, "job_duplicate", ORDINARY)
            return True
        except StoreWriteConflictError:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(admit, range(8)))

    assert sum(results) == 1
    snapshot = assert_queue_invariants(store, context="concurrent duplicate admission")
    assert snapshot.pending_ids == frozenset({"job_duplicate"})
    assert [member.job_id for member in snapshot.ordinary_members] == ["job_duplicate"]


def test_concurrent_claims_never_hand_one_job_to_two_workers(store):
    """Every queued job is claimed exactly once, ordinary work first."""
    for index in range(4):
        _admit(store, f"job_ord_{index}", ORDINARY, offset_seconds=index)
    for index in range(3):
        _admit(store, f"job_diag_{index}", DIAGNOSTIC, offset_seconds=index)

    def claim(index: int):
        """Claim on behalf of one distinct worker."""
        job = _claim(store, f"worker-{index}")
        return job.id if job is not None else None

    with ThreadPoolExecutor(max_workers=10) as pool:
        claimed = [job_id for job_id in pool.map(claim, range(10)) if job_id is not None]

    assert len(claimed) == len(set(claimed)) == 7
    snapshot = assert_queue_invariants(store, context="concurrent claims")
    assert snapshot.ordinary_members == ()
    assert snapshot.diagnostic_members == ()
    # Each claim wrote exactly one fenced lease, so no job has two owners.
    assert all(facts.has_claim_lease for facts in snapshot.jobs.values())
    assert len({store.get(job_id).worker_id for job_id in claimed}) == 7


def test_terminal_delete_and_retention_cleanup_release_every_index(store):
    """Deleting terminal work leaves no queue member, pending slot, or lease behind."""
    first = _admit(store, "job_old", ORDINARY, offset_seconds=0)
    claimed = _claim(store)
    completed = _terminalize(store, claimed, JobState.COMPLETED, worker_id="worker-1")
    _admit(store, "job_live", DIAGNOSTIC, offset_seconds=1)
    assert first.id == completed.id

    # Retention cleanup selects on finished_at and must find only the settled job,
    # never the live one — that is what stops cleanup reclaiming an occupied slot.
    expired = store.find_finished_before(utc_now() + timedelta(seconds=1))
    assert [job.id for job in expired] == ["job_old"]

    store.delete("job_old", store.get("job_old").revision)
    snapshot = assert_queue_invariants(store, context="terminal delete")
    assert "job_old" not in snapshot.jobs
    assert snapshot.pending_ids == frozenset({"job_live"})
    assert [member.job_id for member in snapshot.diagnostic_members] == ["job_live"]
    # The live job is untouched and still claimable.
    assert _claim(store, "worker-2").id == "job_live"
    assert_queue_invariants(store, context="claim after cleanup")


def test_retained_eviction_never_removes_live_pending_work(store):
    """With no terminal job to evict, admission is refused rather than stealing one."""
    limits = StoreLimits(max_pending=3, max_retained=2, ordinary_reserved_slots=1)
    _admit(store, "job_one", ORDINARY, offset_seconds=0, limits=limits)
    _admit(store, "job_two", ORDINARY, offset_seconds=1, limits=limits)

    with pytest.raises(JobCapacityError):
        _admit(store, "job_three", ORDINARY, offset_seconds=2, limits=limits)
    snapshot = assert_queue_invariants(store, context="refused retained eviction")
    assert snapshot.pending_ids == frozenset({"job_one", "job_two"})


def test_active_state_without_a_worker_is_refused(store):
    """An active job must name an owner, or nothing could ever fence or expire it."""
    admitted = _admit(store, "job_unowned", ORDINARY, offset_seconds=0)
    with pytest.raises(QueueInvariantError):
        store.save(replace(admitted, state=JobState.RUNNING, worker_id=None), admitted.revision, [])
    assert_queue_invariants(store, context="refused unowned active job")


def test_invariant_error_records_stay_bounded(store):
    """Repeated repair cannot grow storage: the oldest records are discarded."""
    overflow = MAX_RETAINED_INVARIANT_ERRORS + 20
    for index in range(overflow):
        _inject_queue_member(store, f"job_ghost_{index}", ORDINARY, float(index))
        store.repair_queue_residue()

    records = store.recent_invariant_errors()
    assert len(records) == MAX_RETAINED_INVARIANT_ERRORS
    # The retained window is the most RECENT repairs, so the bound drops history
    # rather than stopping recording once it is reached.
    assert records[-1]["job_id"] == f"job_ghost_{overflow - 1}"
    assert_queue_invariants(store, context="bounded invariant records")


def test_position_snapshots_come_from_one_consistent_read(store):
    """A diagnostic's position counts the ordinary queue, so it needs one snapshot."""
    _admit(store, "job_diag", DIAGNOSTIC, offset_seconds=0)
    assert store.get("job_diag").queue_position == 1

    # Adding ordinary work moves the diagnostic backwards. A client that had read the
    # queues separately could have combined an old ordinary size with a new
    # diagnostic rank; the store reports the position from one snapshot instead.
    _admit(store, "job_ord_a", ORDINARY, offset_seconds=1)
    _admit(store, "job_ord_b", ORDINARY, offset_seconds=2)
    assert store.get("job_diag").queue_position == 3
    assert store.get("job_ord_a").queue_position == 1
    assert store.get("job_ord_b").queue_position == 2

    snapshot = assert_queue_invariants(store, context="position authority")
    # The store's own reported positions agree with the normative definition applied
    # to the same snapshot, so no backend is quietly using a different rule.
    for entry in effective_positions(snapshot):
        assert store.get(entry.job_id).queue_position == entry.position


# --- Rules stated once, independent of any backend ---------------------------------


@pytest.mark.parametrize(
    ("purpose", "pending", "expected"),
    [
        (ORDINARY, 6, "ok"),
        (ORDINARY, 7, "ok"),  # the reserved slot IS usable by ordinary work
        (ORDINARY, 8, "pending_exhausted"),
        (DIAGNOSTIC, 6, "ok"),
        (DIAGNOSTIC, 7, "ordinary_reserved"),  # refused at the reserve boundary
        (DIAGNOSTIC, 8, "pending_exhausted"),
    ],
)
def test_admission_boundary_is_exact(purpose, pending, expected):
    """Ordinary reaches eight pending; a diagnostic stops at seven."""
    assert admission_decision(purpose, pending_count=pending, max_pending=8, ordinary_reserved_slots=1) == expected


def test_zero_reserve_lets_diagnostics_use_every_slot():
    """An explicit zero reserve is the pre-T09 behaviour, not a broken reserve."""
    assert admission_decision(DIAGNOSTIC, pending_count=7, max_pending=8, ordinary_reserved_slots=0) == "ok"
    assert (
        admission_decision(DIAGNOSTIC, pending_count=8, max_pending=8, ordinary_reserved_slots=0) == "pending_exhausted"
    )


@pytest.mark.parametrize("reserve", [8, 9, -1])
def test_store_limits_refuse_a_reserve_that_leaves_no_diagnostic_slot(reserve):
    """A reserve at or above total capacity would silently disable diagnostics."""
    with pytest.raises(ValueError):
        StoreLimits(max_pending=8, max_retained=32, ordinary_reserved_slots=reserve)


def test_server_settings_default_reserves_one_of_eight_slots():
    """The shipped deployment reserves exactly one ordinary slot."""
    settings = ServerSettings()
    assert settings.max_pending_jobs == 8
    assert settings.ordinary_reserved_slots == 1
    # The Redis namespace version moved with the queue layout, so a v0 namespace's
    # single-queue entries can never be misread by the new state machine.
    assert settings.redis_key_prefix.endswith(":v1")
    with pytest.raises(ValueError):
        ServerSettings(max_pending_jobs=8, ordinary_reserved_slots=8)


def test_reserve_is_configurable_from_the_environment(monkeypatch):
    """An operator can widen the reserve without touching code."""
    monkeypatch.setenv("JOB_ORDINARY_RESERVED_SLOTS", "3")
    assert ServerSettings.from_env().ordinary_reserved_slots == 3
    monkeypatch.setenv("JOB_ORDINARY_RESERVED_SLOTS", "-1")
    with pytest.raises(ValueError):
        ServerSettings.from_env()


def test_every_state_machine_key_shares_one_hash_tag():
    """All keys occupy one slot, so a later cluster cannot break atomicity silently."""
    store = _make_fakeredis_store()
    keys = [
        store._jobs_key,
        store._pending_key,
        store._invariant_errors_key,
        *store._queue_keys.values(),
        store._job_key("job_a"),
        store._lease_key("job_a"),
        store._events_key("job_a"),
        store._input_key("job_a"),
        store._artifact_key("job_a"),
    ]
    tags = {key[key.index("{") : key.index("}") + 1] for key in keys}
    assert tags == {QUEUE_KEY_HASH_TAG}
    # The Lua module derives per-job keys from this same tagged base, so a key it
    # builds itself cannot escape the slot the declared keys occupy.
    assert store._state_machine_namespace.endswith(QUEUE_KEY_HASH_TAG)


def test_state_machine_version_is_pinned():
    """The protocol version is explicit, so an incompatible change must be declared."""
    assert QUEUE_STATE_MACHINE_VERSION == "v1"


# --- The HTTP boundary -------------------------------------------------------------


@pytest.fixture
def queue_client():
    """An idle memory-backed API whose queued jobs stay queued.

    Background threads are off so admitted work accumulates in the queue instead of
    being claimed, which is what makes the reserve boundary observable over HTTP.
    """
    settings = ServerSettings(
        job_backend="memory",
        max_pending_jobs=3,
        ordinary_reserved_slots=1,
        max_retained_jobs=32,
    )
    app = create_app(settings=settings, start_background=False)
    with TestClient(app) as client:
        yield client


def _submit(client, purpose: str | None = None):
    """Submit one minimal scenario, optionally declaring a job purpose."""
    data = {"yaml_content": MINIMAL_SCENARIO}
    if purpose is not None:
        data["purpose"] = purpose
    return client.post("/optimize", data=data)


def test_submission_without_a_purpose_is_ordinary(queue_client):
    """The ordinary Optimize path stays usable with no knowledge of purpose."""
    response = _submit(queue_client)
    assert response.status_code == 202
    assert response.json()["request"]["purpose"] == "ordinary"


def test_diagnostic_submission_is_refused_at_the_reserve_with_a_stable_code(queue_client):
    """The reserve is visible over HTTP as a distinct, retry-meaningful code."""
    first = _submit(queue_client, "assistant_diagnostic")
    assert first.status_code == 202
    assert first.json()["request"]["purpose"] == "assistant_diagnostic"
    assert first.json()["queue_position"] == 1

    # Two of three slots are now used, leaving only the reserved one.
    second = _submit(queue_client, "assistant_diagnostic")
    assert second.status_code == 202
    refused = _submit(queue_client, "assistant_diagnostic")
    assert refused.status_code == 429
    body = refused.json()
    assert body["error"]["code"] == "diagnostic_capacity_reserved"
    # The refusal describes capacity, never the document that was refused.
    assert "apiVersion" not in body["error"]["message"]
    assert "alice" not in json.dumps(body)

    # The reserved slot is still available to ordinary work, which is the point.
    accepted = _submit(queue_client)
    assert accepted.status_code == 202
    # An ordinary submission jumps ahead of both queued diagnostics.
    assert accepted.json()["queue_position"] == 1
    assert queue_client.get(f"/optimize/{first.json()['id']}").json()["queue_position"] == 2

    # With every slot taken, ordinary work is refused with the ORDINARY code, so a
    # client can tell "the queue is full" from "this slot is not yours".
    exhausted = _submit(queue_client)
    assert exhausted.status_code == 429
    assert exhausted.json()["error"]["code"] == "job_capacity_exceeded"


def test_unknown_purpose_is_refused_before_a_job_exists(queue_client):
    """An unrecognized purpose is a request error, not a silent ordinary admission."""
    response = _submit(queue_client, "totally_unknown")
    assert response.status_code == 400
    # No capacity was consumed, so three submissions still fit afterwards.
    for _ in range(3):
        assert _submit(queue_client).status_code == 202


def test_invariant_checker_detects_each_class_of_violation():
    """The checker is not vacuous: it reports the states it exists to catch."""
    created_at = utc_now()
    running = JobQueueFacts(state=JobState.RUNNING, purpose=ORDINARY, created_at=created_at, has_claim_lease=True)
    queued = JobQueueFacts(state=JobState.QUEUED, purpose=ORDINARY, created_at=created_at, has_claim_lease=False)

    # A running job left in a queue breaks invariant 3.
    still_queued = QueueStateSnapshot(
        jobs={"job_a": running},
        pending_ids=frozenset({"job_a"}),
        ordinary_members=(QueueMember(job_id="job_a", created_at=created_at),),
        diagnostic_members=(),
    )
    assert any("invariant-3" in violation for violation in check_queue_invariants(still_queued))

    # A queued job missing from pending breaks invariant 1.
    unaccounted = QueueStateSnapshot(
        jobs={"job_a": queued},
        pending_ids=frozenset(),
        ordinary_members=(QueueMember(job_id="job_a", created_at=created_at),),
        diagnostic_members=(),
    )
    assert any("invariant-1" in violation for violation in check_queue_invariants(unaccounted))

    # A queued job in the queue its purpose does not name breaks invariant 2.
    wrong_queue = QueueStateSnapshot(
        jobs={"job_a": queued},
        pending_ids=frozenset({"job_a"}),
        ordinary_members=(),
        diagnostic_members=(QueueMember(job_id="job_a", created_at=created_at),),
    )
    assert any("invariant-2" in violation for violation in check_queue_invariants(wrong_queue))

    # A terminal job holding a lease breaks invariant 4.
    lingering_lease = QueueStateSnapshot(
        jobs={
            "job_a": JobQueueFacts(
                state=JobState.COMPLETED, purpose=ORDINARY, created_at=created_at, has_claim_lease=True
            )
        },
        pending_ids=frozenset(),
        ordinary_members=(),
        diagnostic_members=(),
    )
    assert any("invariant-4" in violation for violation in check_queue_invariants(lingering_lease))
