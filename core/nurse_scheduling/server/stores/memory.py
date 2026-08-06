"""In-process implementation of the optimization job store."""

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

import threading
from collections import deque
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from uuid import uuid4

from ..errors import (
    DiagnosticCapacityError,
    JobArtifactNotFoundError,
    JobCapacityError,
    JobInputNotFoundError,
    JobNotFoundError,
    QueueInvariantError,
    StoreWriteConflictError,
)
from ..event_cursor import EventCursorExpired, EventCursorInvalid, decode_cursor, encode_cursor
from ..jobs.models import (
    EventReplayWindow,
    Job,
    JobEvent,
    JobPurpose,
    JobState,
    StoredArtifact,
    StoreLimits,
)
from ..queue_state import (
    ADMISSION_OK,
    ADMISSION_ORDINARY_RESERVED,
    INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER,
    INVARIANT_ERROR_STALE_PENDING_MEMBER,
    INVARIANT_ERROR_STALE_QUEUE_MEMBER,
    MAX_RETAINED_INVARIANT_ERRORS,
    EffectivePosition,
    JobQueueFacts,
    QueueMember,
    DIAGNOSTIC_CAPACITY_MESSAGE,
    QueueStateSnapshot,
    admission_decision,
    effective_positions,
)


PENDING_STATES = frozenset({JobState.QUEUED, JobState.RUNNING, JobState.CANCELLING})
"""States that occupy one pending-capacity slot."""


@dataclass
class _MemoryJobRecord:
    """All process-local data retained for one job."""

    job: Job
    """Current persisted job snapshot."""
    input_bytes: bytes
    """Original submitted input."""
    artifacts: dict[str, StoredArtifact] = field(default_factory=dict)
    """Generated artifacts indexed by filename."""
    events: list[JobEvent] = field(default_factory=list)
    """Replayable events in insertion order."""
    next_event_id: int = 1
    """Monotonic integer assigned to the next appended event."""


class MemoryJobStore:
    """Thread-safe process-local job metadata, queue, events, and blobs."""

    def __init__(self, *, store_id: str | None = None, max_events_per_job: int = 1_000):
        """Initialize an empty store protected by a shared reentrant lock."""
        if max_events_per_job <= 0:
            raise ValueError("max_events_per_job must be positive")
        self._store_id = str(uuid4()) if store_id is None else store_id
        """Opaque identity unique to this process-local store."""
        if not self._store_id.strip():
            raise ValueError("store_id must not be empty")
        self._records: dict[str, _MemoryJobRecord] = {}
        """Job records indexed by job ID."""
        self._pending: set[str] = set()
        """Explicit pending-capacity index (T09 invariant 1).

        Kept EXPLICITLY rather than recomputed from `_records` on demand, even
        though one lock would make derivation safe here. The Redis backend has no
        choice but to keep real index keys, and an index that cannot desync is an
        index whose repair path is never exercised. Mirroring the structure keeps
        both backends honest under the same invariants and the same repair tests.
        """
        self._queues: dict[JobPurpose, dict[str, datetime]] = {purpose: {} for purpose in JobPurpose}
        """One queue per purpose, mapping queued job ID to its FIFO score."""
        self._leases: dict[str, str] = {}
        """Fenced claim tokens for jobs a worker currently owns, indexed by job ID."""
        self._invariant_errors: deque[dict[str, str]] = deque(maxlen=MAX_RETAINED_INVARIANT_ERRORS)
        """Bounded record of defensive repairs, holding stable codes and IDs only."""
        self._max_events_per_job = max_events_per_job
        """Maximum replayable events retained for any one job."""
        self._lock = threading.RLock()
        """Re-entrant lock guarding all record, queue, artifact, and event access."""
        self._changed = threading.Condition(self._lock)
        """Condition backed by `_lock` that adds `wait()` and `notify_all()` for job changes."""

    @property
    def store_id(self) -> str:
        """Return this process-local store's opaque identity."""
        return self._store_id

    def create(
        self,
        job: Job,
        input_bytes: bytes,
        limits: StoreLimits,
        events: Sequence[JobEvent],
    ) -> Job:
        """Atomically create a job while enforcing pending and retained limits.

        The oldest finished jobs are removed when retained capacity is needed.

        Raises:
            StoreWriteConflictError: If the job ID already exists.
            JobCapacityError: If pending or retained capacity is exhausted.
            DiagnosticCapacityError: If only the reserved ordinary slots remain.
            QueueInvariantError: If the job is not admissible as a queued job.
        """
        with self._changed:
            if job.id in self._records:
                raise StoreWriteConflictError(f"Job already exists: {job.id}")
            if job.state != JobState.QUEUED:
                raise QueueInvariantError("A job may only be admitted in the queued state")
            # Repair first, so a stale index entry can never make a genuinely free
            # slot look occupied and refuse admission that the invariants allow.
            self._repair_residue(job.created_at)
            decision = admission_decision(
                job.request.purpose,
                pending_count=len(self._pending),
                max_pending=limits.max_pending,
                ordinary_reserved_slots=limits.ordinary_reserved_slots,
            )
            if decision == ADMISSION_ORDINARY_RESERVED:
                raise DiagnosticCapacityError(DIAGNOSTIC_CAPACITY_MESSAGE)
            if decision != ADMISSION_OK:
                raise JobCapacityError("Too many jobs are queued or running")

            while len(self._records) >= limits.max_retained:
                terminal = sorted(
                    (record.job for record in self._records.values() if record.job.state.terminal),
                    key=lambda candidate: candidate.finished_at or candidate.created_at,
                )
                if not terminal:
                    raise JobCapacityError("Too many jobs are retained")
                # Only terminal jobs are eligible, so retained eviction can never
                # reclaim a slot by deleting live pending work.
                self._forget(terminal[0].id)

            record = _MemoryJobRecord(job=replace(job, revision=1, queue_position=None), input_bytes=input_bytes)
            self._records[job.id] = record
            self._pending.add(job.id)
            self._queues[job.request.purpose][job.id] = job.created_at
            created = self._with_queue_position(record.job)
            self._append_events(record, self._with_initial_queue_position(events, created.queue_position))
            self._append_queue_position_events_for_queued_jobs(job.created_at, exclude_job_id=job.id)
            # notify() may wake an unrelated stream; extra notify_all() wake-ups are acceptable because pending jobs are bounded.
            self._changed.notify_all()
            return created

    def get(self, job_id: str) -> Job:
        """Return a job snapshot with its current queue position.

        Raises:
            JobNotFoundError: If the job does not exist.
        """
        with self._lock:
            return self._with_queue_position(self._record(job_id).job)

    def get_input(self, job_id: str) -> bytes:
        """Return the original input submitted for a job.

        Raises:
            JobNotFoundError: If the job does not exist.
            JobInputNotFoundError: If the job has no stored input.
        """
        with self._lock:
            record = self._record(job_id)
            if record.input_bytes is None:
                raise JobInputNotFoundError("Job input was not found")
            return record.input_bytes

    def get_artifact(self, job_id: str, name: str) -> StoredArtifact:
        """Return a named artifact stored within a job record.

        Raises:
            JobNotFoundError: If the job does not exist.
            JobArtifactNotFoundError: If the named artifact does not exist.
        """
        with self._lock:
            artifact = self._record(job_id).artifacts.get(name)
            if artifact is None:
                raise JobArtifactNotFoundError("Job artifact was not found")
            return artifact

    def claim_next(
        self,
        worker_id: str,
        started_at: datetime,
        claim_expires_at: datetime,
        runtime_identity: Mapping[str, str] | None = None,
    ) -> Job | None:
        """Atomically assign the effective head of the priority queues to a worker.

        The ordinary queue is drained before any diagnostic is considered, so
        ordinary work overtakes queued diagnostics. A RUNNING diagnostic is never
        touched here: claiming is the only thing this does, and it only ever removes
        a QUEUED member, which is what makes running work non-pre-emptive.

        Return the claimed running job, or `None` when both queues are empty.
        """
        with self._changed:
            self._repair_residue(started_at)
            ordered = self._effective_positions()
            if not ordered:
                return None
            record = self._records[ordered[0].job_id]
            claimed = replace(
                record.job,
                state=JobState.RUNNING,
                started_at=started_at,
                worker_id=worker_id,
                claim_expires_at=claim_expires_at,
                queue_position=None,
                revision=record.job.revision + 1,
            )
            record.job = claimed
            # Exactly the claimed member leaves its queue; pending is retained
            # because a running job still occupies one capacity slot.
            self._queues[claimed.request.purpose].pop(claimed.id, None)
            self._leases[claimed.id] = self._lease_token(claimed)
            self._append_events(
                record,
                [
                    JobEvent(
                        type="job.state_changed",
                        data={
                            "state": JobState.RUNNING.value,
                            "queue_position": None,
                            "cancel_requested": False,
                            "early_completion_requested": False,
                            "worker_id": worker_id,
                            **({"runtime": dict(runtime_identity)} if runtime_identity is not None else {}),
                        },
                        occurred_at=started_at,
                    )
                ],
            )
            self._append_queue_position_events_for_queued_jobs(started_at)
            # notify() may wake an unrelated stream; extra notify_all() wake-ups are acceptable because pending jobs are bounded.
            self._changed.notify_all()
            return claimed

    def save(
        self,
        job: Job,
        expected_revision: int,
        events: Sequence[JobEvent],
        artifact: StoredArtifact | None = None,
        *,
        worker_id: str | None = None,
        expected_claim_expires_at: datetime | None = None,
    ) -> Job:
        """Save a job update only if no concurrent update has occurred.

        Raises:
            JobNotFoundError: If the job does not exist.
            StoreWriteConflictError: If the stored revision no longer matches.
        """
        with self._changed:
            record = self._record(job.id)
            if record.job.revision != expected_revision:
                raise StoreWriteConflictError(f"Job revision changed: {job.id}")
            if worker_id is not None:
                current_deadline = record.job.claim_expires_at
                if (
                    record.job.worker_id != worker_id
                    or current_deadline is None
                    or current_deadline != expected_claim_expires_at
                    or current_deadline <= datetime.now(timezone.utc)
                ):
                    raise StoreWriteConflictError(f"Worker claim is no longer active: {job.id}")
            was_queued = record.job.state == JobState.QUEUED
            self._validate_transition(record.job, job)
            updated_job = replace(job, revision=expected_revision + 1, queue_position=None)
            record.job = updated_job
            self._apply_membership(updated_job)
            if artifact is not None:
                record.artifacts[artifact.name] = artifact
            self._append_events(record, events)
            if was_queued and updated_job.state != JobState.QUEUED:
                occurred_at = events[-1].occurred_at if events else datetime.now(updated_job.created_at.tzinfo)
                self._append_queue_position_events_for_queued_jobs(occurred_at)
            # notify() may wake an unrelated stream; extra notify_all() wake-ups are acceptable because pending jobs are bounded.
            self._changed.notify_all()
            return self._with_queue_position(updated_job)

    def prepare_event_replay(self, job_id: str, requested_cursor: str | None) -> EventReplayWindow:
        """Snapshot the initial replay batch under the store lock.

        Native memory IDs are contiguous positive integers, so an in-range value
        is always an exact retained event.

        Raises:
            JobNotFoundError: If the job does not exist.
            EventCursorExpired: If the cursor is valid but older than the retained floor.
            EventCursorInvalid: If the cursor is malformed, foreign, future, or non-exact.
        """
        with self._lock:
            record = self._record(job_id)
            events = record.events
            if not events:
                if requested_cursor is None:
                    return EventReplayWindow(initial_events=[], next_cursor=None, oldest_event_id=None)
                decode_cursor(requested_cursor, job_id)
                raise EventCursorExpired(None)

            floor = int(events[0].id or 0)
            tail = int(events[-1].id or 0)
            oldest_public = encode_cursor(job_id, events[0].id or "")
            if requested_cursor is None:
                return EventReplayWindow(
                    initial_events=list(events),
                    next_cursor=events[-1].id,
                    oldest_event_id=oldest_public,
                )

            native = decode_cursor(requested_cursor, job_id)
            try:
                value = int(native)
            except ValueError as error:
                raise EventCursorInvalid("Cursor native ID is not an integer") from error
            # The server only ever emits canonical decimal ids. Reject aliases such
            # as "+1", "01", or "1_0" that decode to a retained value but were never
            # emitted, so a non-exact cursor is invalid rather than accepted.
            if native != str(value):
                raise EventCursorInvalid("Cursor native ID is not in canonical form")
            if value <= 0:
                raise EventCursorInvalid("Cursor native ID is out of range")
            if value < floor:
                raise EventCursorExpired(oldest_public)
            if value > tail:
                raise EventCursorInvalid("Cursor native ID is newer than the retained tail")
            initial = [event for event in events if int(event.id or 0) > value]
            next_cursor = initial[-1].id if initial else native
            return EventReplayWindow(
                initial_events=initial,
                next_cursor=next_cursor,
                oldest_event_id=oldest_public,
            )

    def stream_events(
        self,
        job_id: str,
        after_id: str | None,
        keepalive_seconds: float,
    ) -> Iterator[JobEvent | None]:
        """Yield events after the requested ID until the job becomes terminal.

        Iteration blocks up to the keepalive interval when no newer event exists.
        Yield `None` when the keepalive interval passes without a new event.

        Raises:
            JobNotFoundError: If the job does not exist or is deleted while streaming.
        """
        try:
            last_seen = int(after_id) if after_id is not None else 0
        except ValueError:
            last_seen = 0

        while True:
            with self._changed:
                record = self._record(job_id)
                available = [event for event in record.events if int(event.id or 0) > last_seen]
                if not available and not record.job.state.terminal:
                    self._changed.wait(timeout=keepalive_seconds)
                    record = self._record(job_id)
                    available = [event for event in record.events if int(event.id or 0) > last_seen]
                    if not available:
                        keepalive = True
                    else:
                        keepalive = False
                else:
                    keepalive = False
                terminal = record.job.state.terminal

            if keepalive:
                yield None
                continue
            for event in available:
                last_seen = int(event.id or last_seen)
                yield event
            if terminal:
                return

    def find_finished_before(self, cutoff: datetime) -> list[Job]:
        """Return jobs finished before the retention cutoff.

        Maintenance deletes them to keep retained job history bounded.
        """
        with self._lock:
            return [
                self._with_queue_position(record.job)
                for record in self._records.values()
                if record.job.finished_at is not None and record.job.finished_at < cutoff
            ]

    def find_claimed_before(self, cutoff: datetime) -> list[Job]:
        """Return active jobs whose worker claim expired by the cutoff.

        Maintenance terminates them because their worker is presumed lost.
        """
        with self._lock:
            return [
                self._with_queue_position(record.job)
                for record in self._records.values()
                if record.job.state in {JobState.RUNNING, JobState.CANCELLING}
                and record.job.claim_expires_at is not None
                and record.job.claim_expires_at <= cutoff
            ]

    def check_health(self) -> None:
        """The in-process store has no external dependency to probe."""

    def delete(self, job_id: str, expected_revision: int) -> None:
        """Delete a job and its data if its revision still matches.

        Raises:
            JobNotFoundError: If the job does not exist.
            StoreWriteConflictError: If the stored revision no longer matches.
        """
        with self._changed:
            record = self._record(job_id)
            if record.job.revision != expected_revision:
                raise StoreWriteConflictError(f"Job revision changed: {job_id}")
            # Deletion releases the job's OWN indexes together with the job in one
            # locked step, so it can never leave a queue member or a pending slot
            # behind for work that no longer exists. Whether a job is deletable at
            # all is lifecycle policy and stays with the controller, which admits
            # only terminal jobs from the public delete and the retention reaper.
            self._forget(job_id)
            # notify() may wake an unrelated stream; extra notify_all() wake-ups are acceptable because pending jobs are bounded.
            self._changed.notify_all()

    def _record(self, job_id: str) -> _MemoryJobRecord:
        """Return the internal record for a job.

        Raises:
            JobNotFoundError: If the job does not exist.
        """
        record = self._records.get(job_id)
        if record is None:
            raise JobNotFoundError("Job was not found")
        return record

    def _with_queue_position(self, job: Job) -> Job:
        """Return a job copy carrying its authoritative effective queue position.

        Derived from one snapshot of both queues under the store lock, so a caller
        never has to combine separate queue reads to learn where a job stands.
        """
        if job.state != JobState.QUEUED:
            return replace(job, queue_position=None)
        for entry in self._effective_positions():
            if entry.job_id == job.id:
                return replace(job, queue_position=entry.position)
        return replace(job, queue_position=None)

    def _effective_positions(self) -> list[EffectivePosition]:
        """Return the authoritative effective queue order under the store lock."""
        return effective_positions(self._snapshot())

    def _snapshot(self) -> QueueStateSnapshot:
        """Capture one consistent queue-state view; callers must hold the lock."""
        return QueueStateSnapshot(
            jobs={
                job_id: JobQueueFacts(
                    state=record.job.state,
                    purpose=record.job.request.purpose,
                    created_at=record.job.created_at,
                    has_claim_lease=job_id in self._leases,
                )
                for job_id, record in self._records.items()
            },
            pending_ids=frozenset(self._pending),
            ordinary_members=tuple(
                QueueMember(job_id=job_id, created_at=score)
                for job_id, score in self._queues[JobPurpose.ORDINARY].items()
            ),
            diagnostic_members=tuple(
                QueueMember(job_id=job_id, created_at=score)
                for job_id, score in self._queues[JobPurpose.ASSISTANT_DIAGNOSTIC].items()
            ),
        )

    def describe_queue_state(self) -> QueueStateSnapshot:
        """Return one atomic snapshot of the complete queue state."""
        with self._lock:
            return self._snapshot()

    def recent_invariant_errors(self) -> list[dict[str, str]]:
        """Return the bounded record of defensive repairs, oldest first."""
        with self._lock:
            return list(self._invariant_errors)

    def repair_queue_residue(self, occurred_at: datetime | None = None) -> list[str]:
        """Remove inconsistent index entries and report the repairs performed."""
        with self._changed:
            repaired = self._repair_residue(occurred_at or datetime.now(timezone.utc))
            if repaired:
                self._changed.notify_all()
            return repaired

    @staticmethod
    def _lease_token(job: Job) -> str:
        """Build the fenced claim token identifying one worker's active claim."""
        deadline = job.claim_expires_at.isoformat() if job.claim_expires_at is not None else ""
        return f"{job.worker_id}|{job.revision}|{deadline}"

    @staticmethod
    def _validate_transition(current: Job, replacement: Job) -> None:
        """Reject a saved transition the queue state machine does not define.

        This is not defensive noise: without it a terminal job could be walked back
        into a pending state, re-entering a queue whose capacity was already
        released, and an active state could be persisted with no owner to fence it.

        Raises:
            QueueInvariantError: If the transition would break an invariant.
        """
        if current.state.terminal and replacement.state != current.state:
            raise QueueInvariantError("A terminal job cannot change state")
        if replacement.request.purpose != current.request.purpose:
            raise QueueInvariantError("A job purpose is immutable")
        if replacement.state in {JobState.RUNNING, JobState.CANCELLING} and replacement.worker_id is None:
            raise QueueInvariantError("An active job must name the worker holding its claim")
        if replacement.state == JobState.QUEUED and current.state != JobState.QUEUED:
            raise QueueInvariantError("A job cannot return to the queue")

    def _apply_membership(self, job: Job) -> None:
        """Reconcile pending, queue, and lease membership with a job's new state.

        One place decides membership for EVERY transition, so cancel, completion,
        cancellation completion, and claim expiry cannot each drift into their own
        slightly different idea of which indexes to release.
        """
        if job.state.terminal:
            self._pending.discard(job.id)
            self._leases.pop(job.id, None)
            for queue in self._queues.values():
                queue.pop(job.id, None)
            return
        self._pending.add(job.id)
        if job.state != JobState.QUEUED:
            for queue in self._queues.values():
                queue.pop(job.id, None)
        if job.state in {JobState.RUNNING, JobState.CANCELLING} and job.claim_expires_at is not None:
            self._leases[job.id] = self._lease_token(job)
        else:
            self._leases.pop(job.id, None)

    def _forget(self, job_id: str) -> None:
        """Remove every trace of one job.

        Child material (input, artifacts, events) lives inside the record, so
        dropping the record removes it together with the job shell under one lock
        — the memory equivalent of the Redis child-before-parent deletion order.
        """
        self._records.pop(job_id, None)
        self._pending.discard(job_id)
        self._leases.pop(job_id, None)
        for queue in self._queues.values():
            queue.pop(job_id, None)

    def _repair_residue(self, occurred_at: datetime) -> list[str]:
        """Remove index entries that contradict the job records they reference.

        Residue is REMOVED, never claimed and never counted as capacity: an entry
        the store cannot justify must not be able to start work or to keep a slot
        occupied. Each removal is recorded as a bounded stable code, so repeated
        repair cannot grow memory or leak anything about a submission.
        """
        repaired: list[str] = []
        for purpose, queue in self._queues.items():
            for job_id in list(queue):
                record = self._records.get(job_id)
                if record is None:
                    kind = INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER
                elif record.job.state != JobState.QUEUED or record.job.request.purpose != purpose:
                    kind = INVARIANT_ERROR_STALE_QUEUE_MEMBER
                else:
                    continue
                del queue[job_id]
                repaired.append(kind)
                self._record_invariant_error(kind, job_id, occurred_at)
        for job_id in list(self._pending):
            record = self._records.get(job_id)
            if record is not None and record.job.state in PENDING_STATES:
                continue
            self._pending.discard(job_id)
            repaired.append(INVARIANT_ERROR_STALE_PENDING_MEMBER)
            self._record_invariant_error(INVARIANT_ERROR_STALE_PENDING_MEMBER, job_id, occurred_at)
        return repaired

    def _record_invariant_error(self, kind: str, job_id: str, occurred_at: datetime) -> None:
        """Record one bounded repair fact carrying no submitted content."""
        self._invariant_errors.append({"kind": kind, "job_id": job_id, "occurred_at": occurred_at.isoformat()})

    def _append_events(self, record: _MemoryJobRecord, events: Sequence[JobEvent]) -> None:
        """Append events with monotonic IDs and discard the oldest overflow."""
        for event in events:
            record.events.append(replace(event, id=str(record.next_event_id)))
            record.next_event_id += 1
        overflow = len(record.events) - self._max_events_per_job
        if overflow > 0:
            del record.events[:overflow]

    @staticmethod
    def _with_initial_queue_position(
        events: Sequence[JobEvent],
        queue_position: int | None,
    ) -> list[JobEvent]:
        """Add the initial queue position to queued state events."""
        return [
            replace(event, data={**event.data, "queue_position": queue_position})
            if event.type == "job.state_changed" and event.data.get("state") == JobState.QUEUED.value
            else event
            for event in events
        ]

    def _append_queue_position_events_for_queued_jobs(
        self,
        occurred_at: datetime,
        exclude_job_id: str | None = None,
    ) -> None:
        """Append effective position events for queued jobs except the excluded job.

        Every affected position changes in the same locked transition that moved the
        queue, so a subscriber never sees a position that was true only between two
        halves of one transition.
        """
        for entry in self._effective_positions():
            if entry.job_id == exclude_job_id:
                continue
            position = entry.position
            record = self._records[entry.job_id]
            self._append_events(
                record,
                [
                    JobEvent(
                        type="job.state_changed",
                        data={
                            "state": JobState.QUEUED.value,
                            "queue_position": position,
                            "cancel_requested": False,
                            "early_completion_requested": False,
                        },
                        occurred_at=occurred_at,
                    )
                ],
            )
