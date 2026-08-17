"""Backend-independent semantics of the atomic ordinary-first job queue (T09).

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

This module owns the RULES; the stores own the ATOMICITY. Two independent
implementations must agree on ordering, admission, and the invariants: the memory
store under its single lock, and the Redis Lua state machine, which re-expresses
these same rules in Lua because a script cannot import Python. This file is
therefore the normative statement both are checked against, and the parity suite
asserts these invariants against BOTH backends after every transition rather
than trusting either implementation's own bookkeeping.

Nothing here reads or holds submitted job input. A capacity rejection or an
invariant report carries stable codes and job identifiers only, so a queue
diagnostic can never become a disclosure channel for a submitted document.
"""

from dataclasses import dataclass
from datetime import datetime

from .jobs.models import JobPurpose, JobState


QUEUE_STATE_MACHINE_VERSION = "v1"
"""Version of the queue state-machine protocol shared by both store backends.

Bumped together with the Redis key-namespace version whenever the persisted queue
layout or a transition's meaning changes, so a rolling deployment can never run
two mutually incompatible state machines over one namespace.
"""

INVARIANT_ERROR_EVENT_TYPE = "queue.invariant_error"
"""Bounded store-level event recorded when defensive repair removes queue residue.

Deliberately NOT appended to a job's client event stream: it is an operational
fact about the index, it may concern a job that no longer exists, and a client
SSE consumer has no action to take on it.
"""

INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER = "orphan_queue_member"
"""A queue member referenced a job record that does not exist."""
INVARIANT_ERROR_STALE_QUEUE_MEMBER = "stale_queue_member"
"""A queue member's job was no longer queued, or sat in the wrong purpose queue."""
INVARIANT_ERROR_STALE_PENDING_MEMBER = "stale_pending_member"
"""A pending member's job was missing or already terminal."""

MAX_RETAINED_INVARIANT_ERRORS = 100
"""Bound on retained invariant-error records; repair must never grow unboundedly."""

DIAGNOSTIC_CAPACITY_MESSAGE = "The reserved ordinary optimisation capacity cannot be used for diagnostics"
"""Fixed refusal text shared by every backend.

A constant rather than a formatted string: nothing about the refused submission
may reach the client, and a fixed message is also what makes the rejection
comparable across backends in the parity suite.
"""

ADMISSION_OK = "ok"
"""Admission is permitted by pending capacity."""
ADMISSION_PENDING_EXHAUSTED = "pending_exhausted"
"""Total pending capacity is exhausted for any purpose."""
ADMISSION_ORDINARY_RESERVED = "ordinary_reserved"
"""Only the reserved ordinary slots remain, so a diagnostic cannot be admitted."""


@dataclass(frozen=True)
class QueueMember:
    """One queued job as the queue index knows it."""

    job_id: str
    """Identifier of the queued job."""
    created_at: datetime
    """Creation time supplying the FIFO score within a purpose."""


@dataclass(frozen=True)
class JobQueueFacts:
    """The queue-relevant projection of one retained job.

    Only what the invariants are stated over. No request, input, or result data
    reaches an invariant check.
    """

    state: JobState
    """Current lifecycle state."""
    purpose: JobPurpose
    """Immutable purpose fixed at admission."""
    created_at: datetime
    """Creation time supplying the FIFO score within a purpose."""
    has_claim_lease: bool
    """Whether a fenced worker claim currently exists for this job."""


@dataclass(frozen=True)
class QueueStateSnapshot:
    """One consistent view of the whole queue state, taken atomically.

    A snapshot must come from ONE store consistency boundary. Assembling it from
    separate reads would let a concurrent transition make a real state look like
    a violation, or hide a genuine one.
    """

    jobs: dict[str, JobQueueFacts]
    """Every retained job, indexed by ID."""
    pending_ids: frozenset[str]
    """Membership of the pending-capacity index."""
    ordinary_members: tuple[QueueMember, ...]
    """Ordinary queue members, in index order."""
    diagnostic_members: tuple[QueueMember, ...]
    """Diagnostic queue members, in index order."""


@dataclass(frozen=True)
class EffectivePosition:
    """One entry of the authoritative effective queue-position snapshot."""

    job_id: str
    """Queued job this position belongs to."""
    position: int
    """One-based effective position; position 1 is the next job a worker claims."""


def queue_purpose_of(purpose: JobPurpose) -> str:
    """Return the stable index suffix naming the queue owning a purpose."""
    return purpose.value


def fifo_sorted(members: tuple[QueueMember, ...] | list[QueueMember]) -> list[QueueMember]:
    """Sort queue members by the normative FIFO key `(created_at, job_id)`.

    The tie-break on ID is not cosmetic: two jobs can be created within the same
    clock tick, and a total order is what makes "the next claim" a single defined
    job in both backends instead of an implementation detail of a sort's stability
    or of Redis's own member ordering.
    """
    return sorted(members, key=lambda member: (member.created_at, member.job_id))


def effective_positions(snapshot: QueueStateSnapshot) -> list[EffectivePosition]:
    """Return the authoritative effective queue order for a snapshot.

    Ordinary work occupies positions `1..n` in FIFO order; a diagnostic's position
    is `ordinary queue size + its diagnostic rank`. Active and terminal jobs never
    appear, because they are not queue members.

    This is the ONLY definition of a client-visible position, and it is derived
    from one snapshot so a caller never combines two queue reads.
    """
    ordered = fifo_sorted(snapshot.ordinary_members) + fifo_sorted(snapshot.diagnostic_members)
    return [EffectivePosition(job_id=member.job_id, position=index) for index, member in enumerate(ordered, start=1)]


def admission_decision(
    purpose: JobPurpose,
    *,
    pending_count: int,
    max_pending: int,
    ordinary_reserved_slots: int,
) -> str:
    """Return whether a purpose may be admitted at the current pending count.

    Ordinary work may use every pending slot. A diagnostic may only use the slots
    outside the ordinary reserve, so an ordinary Optimize run can always still be
    accepted while diagnostics are saturating the queue. The reserve is a floor on
    ORDINARY ADMISSION, not a set of slots held empty: an ordinary job admitted
    into the reserve is an ordinary pending job like any other.
    """
    if pending_count >= max_pending:
        return ADMISSION_PENDING_EXHAUSTED
    if purpose != JobPurpose.ORDINARY and pending_count >= max_pending - ordinary_reserved_slots:
        return ADMISSION_ORDINARY_RESERVED
    return ADMISSION_OK


def check_queue_invariants(snapshot: QueueStateSnapshot) -> list[str]:
    """Return every violation of the six queue invariants in a snapshot.

    An empty list means the snapshot satisfies all six. Violations are returned
    rather than raised so a caller can report all of them at once; each message
    names only a job ID, a state, and a purpose.

    Invariant 6 (atomicity) is not checkable from a single snapshot: it is the
    property that no OTHER snapshot could ever have been observed. The stores
    deliver it structurally (one lock, one script), and the parity suite tests it
    by asserting invariants 1-5 after every transition and under concurrency,
    where a non-atomic transition would expose a torn intermediate state.
    """
    violations: list[str] = []
    ordinary_ids = {member.job_id for member in snapshot.ordinary_members}
    diagnostic_ids = {member.job_id for member in snapshot.diagnostic_members}
    queue_ids = ordinary_ids | diagnostic_ids
    pending_states = {JobState.QUEUED, JobState.RUNNING, JobState.CANCELLING}

    # 1. pending = queued + running + cancelling, and no terminal job is pending.
    expected_pending = {job_id for job_id, facts in snapshot.jobs.items() if facts.state in pending_states}
    for job_id in sorted(expected_pending - snapshot.pending_ids):
        violations.append(f"invariant-1 job {job_id} is {snapshot.jobs[job_id].state.value} but is not pending")
    for job_id in sorted(snapshot.pending_ids - expected_pending):
        state = snapshot.jobs[job_id].state.value if job_id in snapshot.jobs else "missing"
        violations.append(f"invariant-1 job {job_id} is pending but is {state}")

    for job_id in sorted(queue_ids - set(snapshot.jobs)):
        violations.append(f"invariant-2 queue member {job_id} has no job record")
    for job_id in sorted(ordinary_ids & diagnostic_ids):
        violations.append(f"invariant-2 job {job_id} is a member of both queues")

    for job_id, facts in sorted(snapshot.jobs.items()):
        in_ordinary = job_id in ordinary_ids
        in_diagnostic = job_id in diagnostic_ids
        if facts.state == JobState.QUEUED:
            # 2. A queued job is in exactly one queue, the one matching its purpose,
            #    and holds no claim lease.
            expected_ordinary = facts.purpose == JobPurpose.ORDINARY
            if in_ordinary is not expected_ordinary or in_diagnostic is expected_ordinary:
                violations.append(
                    f"invariant-2 queued job {job_id} with purpose {facts.purpose.value} "
                    f"is in the wrong queue (ordinary={in_ordinary}, diagnostic={in_diagnostic})"
                )
            if facts.has_claim_lease:
                violations.append(f"invariant-2 queued job {job_id} holds a claim lease")
        elif facts.state in pending_states:
            # 3. A running/cancelling job is in no queue and stays pending.
            if in_ordinary or in_diagnostic:
                violations.append(f"invariant-3 {facts.state.value} job {job_id} is still a queue member")
        else:
            # 4. A terminal job is in no queue, is not pending, and holds no lease.
            if in_ordinary or in_diagnostic:
                violations.append(f"invariant-4 terminal job {job_id} is still a queue member")
            if facts.has_claim_lease:
                violations.append(f"invariant-4 terminal job {job_id} holds a claim lease")

    # 5. Effective positions are contiguous from 1, ordinary-first, FIFO within a
    #    purpose, and cover exactly the queued jobs.
    positions = effective_positions(snapshot)
    if [entry.position for entry in positions] != list(range(1, len(positions) + 1)):
        violations.append("invariant-5 effective positions are not contiguous from 1")
    queued_ids = {job_id for job_id, facts in snapshot.jobs.items() if facts.state == JobState.QUEUED}
    positioned_ids = {entry.job_id for entry in positions}
    for job_id in sorted(positioned_ids - queued_ids):
        violations.append(f"invariant-5 job {job_id} has an effective position but is not queued")
    for job_id in sorted(queued_ids - positioned_ids):
        violations.append(f"invariant-5 queued job {job_id} has no effective position")
    ordinary_count = len(snapshot.ordinary_members)
    for entry in positions[:ordinary_count]:
        facts = snapshot.jobs.get(entry.job_id)
        if facts is not None and facts.purpose != JobPurpose.ORDINARY:
            violations.append(f"invariant-5 diagnostic job {entry.job_id} is ordered ahead of ordinary work")
    return violations
