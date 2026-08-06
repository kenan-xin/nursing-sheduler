"""Redis implementation of the optimization job store contract."""

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

import json
import math
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import AbstractContextManager
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, overload
from uuid import uuid4

import redis

from ..errors import (
    DiagnosticCapacityError,
    JobArtifactNotFoundError,
    JobCapacityError,
    JobInputNotFoundError,
    JobNotFoundError,
    JobOperationContentionError,
    QueueInvariantError,
    StoreWriteConflictError,
)
from ..event_cursor import EventCursorExpired, EventCursorInvalid, decode_cursor, encode_cursor
from ..optimize_basis import NormalizedOptions, OptimizeBasisV2
from ..jobs.models import (
    EventReplayWindow,
    Job,
    JobEvent,
    JobFailure,
    JobRequest,
    JobState,
    OptimizationOutcome,
    JobPurpose,
    OptimizationResult,
    StoredArtifact,
    StoreLimits,
)
from ..queue_state import (
    ADMISSION_OK,
    ADMISSION_ORDINARY_RESERVED,
    DIAGNOSTIC_CAPACITY_MESSAGE,
    INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER,
    INVARIANT_ERROR_STALE_PENDING_MEMBER,
    INVARIANT_ERROR_STALE_QUEUE_MEMBER,
    MAX_RETAINED_INVARIANT_ERRORS,
    EffectivePosition,
    JobQueueFacts,
    QueueMember,
    QueueStateSnapshot,
    admission_decision,
    fifo_sorted,
)
from ..retry import retry_with_backoff
from .queue_script import (
    OPERATION_ADMIT,
    OPERATION_CLAIM,
    OPERATION_COMMIT,
    OPERATION_DELETE,
    OPERATION_DESCRIBE,
    OPERATION_POSITIONS,
    OPERATION_REPAIR,
    QUEUE_KEY_HASH_TAG,
    QUEUE_STATE_MACHINE_SCRIPT,
    STATUS_CLAIM_LOST,
    STATUS_CONFLICT,
    STATUS_EMPTY,
    STATUS_EXISTS,
    STATUS_INVALID_TRANSITION,
    STATUS_MISSING,
    STATUS_OK,
    STATUS_ORDINARY_RESERVED,
    STATUS_PENDING_EXHAUSTED,
    STATUS_RESIDUE,
    STATUS_RETAINED_EXHAUSTED,
)


SOCKET_TIMEOUT_MARGIN_SECONDS = 5.0
"""Additional socket time allowed beyond one blocking event-stream read."""

REDIS_OPERATION_TIMEOUT_SECONDS = 2.0
"""Short timeout for ordinary Redis operations and deployment probes."""


def _serialize_basis(basis: OptimizeBasisV2 | None) -> dict[str, Any] | None:
    """Serialize an immutable submission basis for the stored job record (T08).

    Written field by field rather than by reflection: a field added to the basis
    without a matching line here is a persistence bug that must surface, not a
    value that silently stops round-tripping and changes a recomputed identity.
    """
    if basis is None:
        return None
    return {
        "schema_version": basis.schema_version,
        "submission_contract_version": basis.submission_contract_version,
        "workspace_schema_version": basis.workspace_schema_version,
        "serializer_version": basis.serializer_version,
        "anonymization_mode": basis.anonymization_mode,
        "input_sha256": basis.input_sha256,
        "normalized_options": {
            "solver": basis.normalized_options.solver,
            "prettify": basis.normalized_options.prettify,
            "timeout_seconds": basis.normalized_options.timeout_seconds,
        },
        "solver_semantic_version": basis.solver_semantic_version,
        "backend_capability_version": basis.backend_capability_version,
    }


def _deserialize_basis(data: Any) -> OptimizeBasisV2 | None:
    """Rebuild an immutable submission basis from a stored job record."""
    if not isinstance(data, dict):
        return None
    options = data["normalized_options"]
    return OptimizeBasisV2(
        schema_version=data["schema_version"],
        submission_contract_version=data["submission_contract_version"],
        workspace_schema_version=data["workspace_schema_version"],
        serializer_version=data["serializer_version"],
        anonymization_mode=data["anonymization_mode"],
        input_sha256=data["input_sha256"],
        normalized_options=NormalizedOptions(
            solver=options["solver"],
            prettify=options["prettify"],
            timeout_seconds=options["timeout_seconds"],
        ),
        solver_semantic_version=data["solver_semantic_version"],
        backend_capability_version=data["backend_capability_version"],
    )


REPLAY_INITIAL_BATCH_COUNT = 1_000
"""Maximum events returned in one prepared replay batch."""

REPLAY_SNAPSHOT_MAX_ATTEMPTS = 50
"""Bound on retrying-atomic-read attempts before reporting store contention."""


def _now_iso() -> str:
    """Return the current UTC instant as the isoformat the state machine records.

    Used only to stamp operational repair records. Every LIFECYCLE timestamp still
    comes from the controller's injected clock, so tests keep deterministic control
    of job timing.
    """
    return datetime.now(timezone.utc).isoformat()


def _parse_stream_id(native_id: str) -> tuple[int, int]:
    """Parse a canonical Redis stream ID `<ms>-<seq>` into a comparable tuple.

    Both components must be canonical decimal integers. The server only ever emits
    canonical stream ids, so aliases with leading zeros (`01737-0`) or a padded
    sequence (`1737-00`) decode to a retained event yet were never emitted; they
    are non-exact and rejected here.

    Raises:
        EventCursorInvalid: If the value is not a canonical stream ID.
    """
    parts = native_id.split("-")
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
        raise EventCursorInvalid("Cursor native ID is not a stream ID")
    if str(int(parts[0])) != parts[0] or str(int(parts[1])) != parts[1]:
        raise EventCursorInvalid("Cursor native ID is not in canonical form")
    return int(parts[0]), int(parts[1])


@overload
def _decode(value: bytes | str) -> str: ...


@overload
def _decode(value: None) -> None: ...


def _decode(value: bytes | str | None) -> str | None:
    """Normalize an optional Redis value to text.

    Raises:
        UnicodeDecodeError: If a byte value is not valid UTF-8.
    """
    if value is None:
        return None
    return value.decode("utf-8") if isinstance(value, bytes) else value


class RedisJobStore:
    """Store jobs, queue state, events, input, and artifacts in Redis."""

    def __init__(
        self,
        *,
        url: str,
        key_prefix: str,
        event_stream_keepalive_seconds: float = 10.0,
        max_events_per_job: int = 1_000,
        client=None,
        test_lease_commit_boundary: Callable[[], AbstractContextManager[None]] | None = None,
    ):
        """Connect to Redis and initialize namespaced index keys.

        An explicit `client` (e.g. a `fakeredis` instance) is used as-is for tests;
        otherwise a binary-safe client is built from `url`.

        Raises:
            ValueError: If a connection setting or the key prefix is invalid.
            redis.RedisError: If Redis cannot be reached.
        """
        self._prefix = key_prefix.rstrip(":")
        """Namespace that isolates this store's keys from other applications."""
        if not self._prefix:
            raise ValueError("JOB_REDIS_KEY_PREFIX must not be empty")
        if not math.isfinite(event_stream_keepalive_seconds) or event_stream_keepalive_seconds <= 0:
            raise ValueError("event_stream_keepalive_seconds must be positive")
        if max_events_per_job <= 0:
            raise ValueError("max_events_per_job must be positive")
        self._max_events_per_job = max_events_per_job
        """Maximum entries retained in each replayable event stream."""
        if client is not None:
            # An injected client (e.g. fakeredis) backs both ordinary and blocking
            # reads; it shares one connection because it has no real socket timeout.
            self._redis = client
            self._stream_redis = client
        else:
            # Bound ordinary Redis waits without inheriting the longer timeout
            # required by blocking event-stream reads.
            self._redis = redis.Redis.from_url(
                url,
                decode_responses=False,
                socket_connect_timeout=REDIS_OPERATION_TIMEOUT_SECONDS,
                socket_timeout=REDIS_OPERATION_TIMEOUT_SECONDS,
            )
            self._stream_redis = redis.Redis.from_url(
                url,
                decode_responses=False,
                socket_connect_timeout=REDIS_OPERATION_TIMEOUT_SECONDS,
                socket_timeout=event_stream_keepalive_seconds + SOCKET_TIMEOUT_MARGIN_SECONDS,
            )
        """Binary-safe Redis client for bounded ordinary operations."""
        self._redis.ping()
        self._use_test_lease_commit_path = client is not None and client.__class__.__module__.startswith("fakeredis")
        """fakeredis lacks Lua; its isolated test client uses the explicit Python test path.

        This is the ONLY reason a second code path exists. It is confined to the
        injected in-memory test double, never reachable from a deployed store, and
        release evidence must additionally run against real Redis, because a suite
        that only ever proved the fallback would have proved nothing about the
        state machine that actually ships (T09).
        """
        self._supports_lua = not self._use_test_lease_commit_path
        """Whether this client can execute the versioned Lua state-machine module."""
        self._queue_script = self._redis.register_script(QUEUE_STATE_MACHINE_SCRIPT) if self._supports_lua else None
        """The registered state machine, invoked by digest with an EVAL fallback."""
        self._test_lease_commit_boundary = test_lease_commit_boundary
        """Test-store critical section shared with fakeredis command execution."""
        self._store_id_key = self._key("metadata:store_id")
        """Persistent UUID identifying this Redis database and key namespace."""
        self._store_id = self._resolve_store_id()
        """Persistent identity captured during startup."""
        self._jobs_key = self._key("jobs")
        """Sorted-set key (`ZADD`) of retained job IDs scored by creation time."""
        self._pending_key = self._key("pending")
        """Set key (`SADD`) of non-terminal job IDs used for pending-capacity checks."""
        self._queue_keys = {purpose: self._key("queue", purpose.value) for purpose in JobPurpose}
        """One sorted-set key (`ZADD`) per purpose, scored by creation time for FIFO claims.

        Two indexes rather than one index plus a stored priority: the ordinary head
        must be findable without reading any job record, or "ordinary first" would
        need a scan whose result could change before the claim committed.
        """
        self._invariant_errors_key = self._key("metadata", "invariant_errors")
        """Bounded stream (`XADD MAXLEN`) recording defensive queue repairs."""
        self._state_machine_namespace = f"{self._prefix}:{QUEUE_KEY_HASH_TAG}"
        """Hash-tagged base from which the Lua module derives per-job keys."""

    @property
    def store_id(self) -> str:
        """Return the persistent identity of this Redis database and namespace."""
        return self._store_id

    def _resolve_store_id(self) -> str:
        """Atomically create or read the persistent Redis store identity."""
        return retry_with_backoff(
            self._resolve_store_id_once,
            retry_on=redis.RedisError,
        )

    def _resolve_store_id_once(self) -> str:
        """Create or read the store identity in one retryable attempt."""
        value = _decode(self._redis.get(self._store_id_key))
        if isinstance(value, str) and value.strip():
            return value
        candidate = str(uuid4())
        self._redis.set(self._store_id_key, candidate, nx=True)
        value = _decode(self._redis.get(self._store_id_key))
        if isinstance(value, str) and value.strip():
            return value
        raise redis.RedisError("Redis job store identity could not be initialized")

    def _run_state_machine(self, operation: str, payload: dict[str, Any], blob: bytes = b"") -> dict[str, Any]:
        """Execute one atomic queue transition and decode its JSON reply.

        Raises:
            redis.RedisError: If the script cannot execute or replies unusably.
        """
        assert self._queue_script is not None
        complete = {
            "max_events": self._max_events_per_job,
            "max_invariant_errors": MAX_RETAINED_INVARIANT_ERRORS,
            **payload,
        }
        raw = self._queue_script(
            keys=[
                self._jobs_key,
                self._pending_key,
                self._queue_keys[JobPurpose.ORDINARY],
                self._queue_keys[JobPurpose.ASSISTANT_DIAGNOSTIC],
                self._invariant_errors_key,
            ],
            args=[operation, self._state_machine_namespace, json.dumps(complete, separators=(",", ":")), blob],
        )
        decoded = json.loads(_decode(raw))
        if not isinstance(decoded, dict) or "status" not in decoded:
            raise redis.RedisError("Queue state machine returned an unusable reply")
        if decoded["status"] == STATUS_INVALID_TRANSITION:
            raise QueueInvariantError(f"Queue transition rejected: {decoded.get('reason', 'unspecified')}")
        return decoded

    @staticmethod
    def _positions(reply: Mapping[str, Any]) -> list[EffectivePosition]:
        """Decode the authoritative effective-position snapshot from a script reply.

        Lua encodes an empty table as `{}`, not `[]`, so an empty snapshot is
        normalized here rather than being mistaken for a malformed reply.
        """
        raw = reply.get("positions")
        if not isinstance(raw, list):
            return []
        return [EffectivePosition(job_id=entry["job_id"], position=int(entry["position"])) for entry in raw]

    @staticmethod
    def _event_payloads(events: Sequence[JobEvent], *, mark_queued_state: bool = False) -> list[dict[str, Any]]:
        """Serialize events for the script, flagging those needing a queue position.

        The flag is computed HERE rather than by matching state strings in Lua so
        the two implementations cannot disagree about which event carries a position.
        """
        payloads = []
        for event in events:
            entry: dict[str, Any] = {
                "type": event.type,
                "data": json.dumps(event.data, separators=(",", ":")),
                "occurred_at": event.occurred_at.isoformat(),
            }
            if mark_queued_state:
                entry["queued_state"] = (
                    event.type == "job.state_changed" and event.data.get("state") == JobState.QUEUED.value
                )
            payloads.append(entry)
        return payloads

    def create(
        self,
        job: Job,
        input_bytes: bytes,
        limits: StoreLimits,
        events: Sequence[JobEvent],
    ) -> Job:
        """Atomically admit a job, enforcing pending, reserve, and retained limits.

        The oldest finished jobs are removed when retained capacity is needed.

        Raises:
            StoreWriteConflictError: If the job ID already exists.
            JobCapacityError: If pending or retained capacity is exhausted.
            DiagnosticCapacityError: If only the reserved ordinary slots remain.
            QueueInvariantError: If the job is not admissible as a queued job.
            redis.RedisError: If a Redis operation fails.
        """
        if job.state != JobState.QUEUED:
            raise QueueInvariantError("A job may only be admitted in the queued state")
        if not self._supports_lua:
            return self._create_via_transaction(job, input_bytes, limits, events)
        reply = self._run_state_machine(
            OPERATION_ADMIT,
            {
                "job_id": job.id,
                "purpose": job.request.purpose.value,
                "score": job.created_at.timestamp(),
                "job": self._serialize_job(replace(job, revision=1, queue_position=None)),
                "max_pending": limits.max_pending,
                "max_retained": limits.max_retained,
                "reserve": limits.ordinary_reserved_slots,
                "occurred_at": job.created_at.isoformat(),
                "events": self._event_payloads(events, mark_queued_state=True),
            },
            input_bytes,
        )
        status = reply["status"]
        if status == STATUS_EXISTS:
            raise StoreWriteConflictError(f"Job already exists: {job.id}")
        if status == STATUS_ORDINARY_RESERVED:
            raise DiagnosticCapacityError(DIAGNOSTIC_CAPACITY_MESSAGE)
        if status == STATUS_PENDING_EXHAUSTED:
            raise JobCapacityError("Too many jobs are queued or running")
        if status == STATUS_RETAINED_EXHAUSTED:
            raise JobCapacityError("Too many jobs are retained")
        if status != STATUS_OK:
            raise redis.RedisError(f"Unexpected admission status: {status}")
        position = reply.get("position")
        return replace(job, revision=1, queue_position=int(position) if isinstance(position, int) else None)

    def _create_via_transaction(
        self,
        job: Job,
        input_bytes: bytes,
        limits: StoreLimits,
        events: Sequence[JobEvent],
    ) -> Job:
        """Mirror `create` for the injected fakeredis test client, which has no Lua.

        Raises:
            StoreWriteConflictError: If the job ID already exists.
            JobCapacityError: If pending or retained capacity is exhausted.
            DiagnosticCapacityError: If only the reserved ordinary slots remain.
            redis.RedisError: If a Redis operation fails.
        """
        # Repair BEFORE counting, matching the script's ordering, so stale index
        # entries cannot make a free slot look occupied. Unlike the script this is a
        # separate transaction, which is one more reason the fallback is confined to
        # the test double and real Redis carries the release evidence.
        self._repair_via_transaction(datetime.now(timezone.utc))
        while True:
            try:
                with self._redis.pipeline() as transaction:
                    job_key = self._job_key(job.id)
                    transaction.watch(self._jobs_key, self._pending_key, *self._queue_keys.values(), job_key)
                    if transaction.exists(job_key):
                        transaction.unwatch()
                        raise StoreWriteConflictError(f"Job already exists: {job.id}")
                    pending_count = transaction.scard(self._pending_key)
                    decision = admission_decision(
                        job.request.purpose,
                        pending_count=pending_count,
                        max_pending=limits.max_pending,
                        ordinary_reserved_slots=limits.ordinary_reserved_slots,
                    )
                    if decision == ADMISSION_ORDINARY_RESERVED:
                        transaction.unwatch()
                        raise DiagnosticCapacityError(DIAGNOSTIC_CAPACITY_MESSAGE)
                    if decision != ADMISSION_OK:
                        transaction.unwatch()
                        raise JobCapacityError("Too many jobs are queued or running")

                    prune_ids: list[str] = []
                    retained_count = transaction.zcard(self._jobs_key)
                    if retained_count >= limits.max_retained:
                        terminal = sorted(
                            (candidate for candidate in self._all_jobs() if candidate.state.terminal),
                            key=lambda candidate: candidate.finished_at or candidate.created_at,
                        )
                        prune_count = retained_count - limits.max_retained + 1
                        if len(terminal) < prune_count:
                            transaction.unwatch()
                            raise JobCapacityError("Too many jobs are retained")
                        prune_ids = [candidate.id for candidate in terminal[:prune_count]]

                    members = self._read_queue_members(transaction)
                    members[job.request.purpose].append(
                        QueueMember(job_id=job.id, created_at=job.created_at.timestamp())
                    )
                    queue_order = [entry.job_id for entry in self._effective_order(members)]
                    queue_position = queue_order.index(job.id) + 1

                    saved = replace(job, revision=1, queue_position=None)
                    transaction.multi()
                    for prune_id in prune_ids:
                        self._stage_job_deletion(transaction, prune_id)
                    transaction.set(job_key, self._serialize_job(saved))
                    transaction.set(self._input_key(job.id), input_bytes)
                    transaction.zadd(self._jobs_key, {job.id: job.created_at.timestamp()})
                    transaction.zadd(self._queue_keys[job.request.purpose], {job.id: job.created_at.timestamp()})
                    transaction.sadd(self._pending_key, job.id)
                    self._stage_event_appends(
                        transaction,
                        job.id,
                        self._with_initial_queue_position(events, queue_position),
                    )
                    for position, queued_id in enumerate(queue_order, start=1):
                        if queued_id != job.id:
                            self._stage_queue_position_event(transaction, queued_id, position, job.created_at)
                    transaction.execute()
                return self.get(job.id)
            except redis.WatchError:
                continue

    def get(self, job_id: str) -> Job:
        """Return a job snapshot with its current queue position.

        Raises:
            JobNotFoundError: If the job does not exist.
            redis.RedisError: If a Redis operation fails.
        """
        raw = self._redis.get(self._job_key(job_id))
        if raw is None:
            raise JobNotFoundError("Job was not found")
        return self._with_queue_position(self._deserialize_job(raw))

    def get_input(self, job_id: str) -> bytes:
        """Return the original input submitted for a job.

        Raises:
            JobNotFoundError: If the job does not exist.
            JobInputNotFoundError: If the job has no stored input.
            redis.RedisError: If a Redis operation fails.
        """
        if not self._redis.exists(self._job_key(job_id)):
            raise JobNotFoundError("Job was not found")
        content = self._redis.get(self._input_key(job_id))
        if content is None:
            raise JobInputNotFoundError("Job input was not found")
        return content

    def get_artifact(self, job_id: str, name: str) -> StoredArtifact:
        """Return the named artifact stored for a job.

        Raises:
            JobNotFoundError: If the job does not exist.
            JobArtifactNotFoundError: If the named artifact does not exist.
            redis.RedisError: If a Redis operation fails.
        """
        job = self.get(job_id)
        if job.artifact_name != name:
            raise JobArtifactNotFoundError("Job artifact was not found")
        content = self._redis.get(self._artifact_key(job_id))
        if content is None:
            raise JobArtifactNotFoundError("Job artifact was not found")
        metadata = self._redis.hgetall(self._artifact_metadata_key(job_id))
        stored_name = _decode(metadata.get(b"name")) or name
        media_type = _decode(metadata.get(b"media_type")) or "application/octet-stream"
        return StoredArtifact(name=stored_name, media_type=media_type, content=content)

    def claim_next(
        self,
        worker_id: str,
        started_at: datetime,
        claim_expires_at: datetime,
        runtime_identity: Mapping[str, str] | None = None,
    ) -> Job | None:
        """Atomically assign the effective head of the priority queues to a worker.

        The ordinary queue is drained before any diagnostic is considered, so
        ordinary work overtakes queued diagnostics. Only a QUEUED member is ever
        removed and no other job is touched, which is precisely why a RUNNING solve
        — diagnostic or ordinary — is never pre-empted by a new claim.

        Return the claimed running job, or `None` when both queues are empty.

        Raises:
            redis.RedisError: If a Redis operation fails.
        """
        if not self._supports_lua:
            return self._claim_next_via_transaction(worker_id, started_at, claim_expires_at, runtime_identity)
        claim_event_data = {
            "state": JobState.RUNNING.value,
            "queue_position": None,
            "cancel_requested": False,
            "early_completion_requested": False,
            "worker_id": worker_id,
            **({"runtime": dict(runtime_identity)} if runtime_identity is not None else {}),
        }
        # A residue reply means the head could not be justified by its record and was
        # removed instead of claimed. Retrying lets the next real head be claimed in
        # the same poll; the bound stops a pathologically corrupt index from spinning.
        for _attempt in range(REPLAY_SNAPSHOT_MAX_ATTEMPTS):
            reply = self._run_state_machine(
                OPERATION_CLAIM,
                {
                    "worker_id": worker_id,
                    "started_at": started_at.isoformat(),
                    "claim_expires_at": claim_expires_at.isoformat(),
                    "claim_expires_ms": self._timestamp_milliseconds(claim_expires_at),
                    "claim_event_data": json.dumps(claim_event_data, separators=(",", ":")),
                    "occurred_at": started_at.isoformat(),
                },
            )
            status = reply["status"]
            if status == STATUS_EMPTY:
                return None
            if status == STATUS_RESIDUE:
                continue
            if status != STATUS_OK:
                raise redis.RedisError(f"Unexpected claim status: {status}")
            return replace(self._deserialize_job(reply["job"]), queue_position=None)
        raise JobOperationContentionError("Queue head did not stabilize for claiming")

    def _claim_next_via_transaction(
        self,
        worker_id: str,
        started_at: datetime,
        claim_expires_at: datetime,
        runtime_identity: Mapping[str, str] | None = None,
    ) -> Job | None:
        """Mirror `claim_next` for the injected fakeredis test client, which has no Lua.

        Raises:
            redis.RedisError: If a Redis operation fails.
        """
        while True:
            try:
                with self._redis.pipeline() as transaction:
                    transaction.watch(*self._queue_keys.values())
                    order = self._effective_order(self._read_queue_members(transaction))
                    queued = [order[0].job_id] if order else []
                    if not queued:
                        transaction.unwatch()
                        return None
                    job_id = _decode(queued[0])
                    job_key = self._job_key(job_id)
                    transaction.watch(job_key)
                    raw = transaction.get(job_key)
                    if raw is None:
                        # Simply continuing would suffice if a normal transaction removed this job.
                        # Remove the orphan defensively in case the stored data is inconsistent,
                        # so it cannot block later claims.
                        transaction.multi()
                        self._stage_queue_removal(transaction, job_id)
                        self._stage_invariant_error(
                            transaction, INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER, job_id, started_at
                        )
                        transaction.execute()
                        continue
                    current = self._deserialize_job(raw)
                    if current.state != JobState.QUEUED:
                        # Another worker may have claimed the job after this queue read.
                        # Simply continuing would suffice for that normal race. Remove the entry
                        # defensively if its state and queue index are inconsistent, so it cannot
                        # block later claims.
                        transaction.multi()
                        self._stage_queue_removal(transaction, job_id)
                        self._stage_invariant_error(transaction, INVARIANT_ERROR_STALE_QUEUE_MEMBER, job_id, started_at)
                        transaction.execute()
                        continue
                    claimed = replace(
                        current,
                        state=JobState.RUNNING,
                        started_at=started_at,
                        worker_id=worker_id,
                        claim_expires_at=claim_expires_at,
                        revision=current.revision + 1,
                        queue_position=None,
                    )
                    event = JobEvent(
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
                    remaining_ids = [entry.job_id for entry in order[1:]]
                    transaction.multi()
                    transaction.set(job_key, self._serialize_job(claimed))
                    transaction.set(
                        self._lease_key(job_id),
                        self._lease_token(claimed.worker_id, claimed.revision, claimed.claim_expires_at),
                        pxat=self._timestamp_milliseconds(claimed.claim_expires_at),
                    )
                    transaction.zrem(self._queue_keys[claimed.request.purpose], job_id)
                    self._stage_event_appends(transaction, job_id, [event])
                    self._stage_queue_position_events(transaction, remaining_ids, started_at)
                    transaction.execute()
                return claimed
            except redis.WatchError:
                continue

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
            redis.RedisError: If a Redis operation fails.
        """
        if worker_id is not None and expected_claim_expires_at is None:
            raise StoreWriteConflictError(f"Worker claim is no longer active: {job.id}")
        if self._supports_lua:
            # EVERY transition — worker-fenced or not — goes through the one state
            # machine, so cancel, completion, cancellation completion, and claim
            # expiry cannot disagree about membership, leases, or positions.
            return self._commit_via_script(
                job,
                expected_revision,
                events,
                artifact,
                worker_id,
                expected_claim_expires_at,
            )
        if worker_id is not None:
            if self._test_lease_commit_boundary is None:
                raise redis.RedisError("fakeredis worker commits require an atomic test commit boundary")
            return self._save_fenced_for_fakeredis(
                job,
                expected_revision,
                events,
                artifact,
                worker_id,
                expected_claim_expires_at,
            )
        return self._save_via_transaction(job, expected_revision, events, artifact)

    def _commit_via_script(
        self,
        job: Job,
        expected_revision: int,
        events: Sequence[JobEvent],
        artifact: StoredArtifact | None,
        worker_id: str | None,
        expected_claim_expires_at: datetime | None,
    ) -> Job:
        """Commit one job transition, its membership, lease, events, and positions.

        Raises:
            JobNotFoundError: If the job does not exist.
            StoreWriteConflictError: If the revision or the worker claim no longer holds.
            QueueInvariantError: If the transition is not one the state machine defines.
            redis.RedisError: If a Redis operation fails.
        """
        updated = replace(job, revision=expected_revision + 1, queue_position=None)
        active = updated.state in {JobState.RUNNING, JobState.CANCELLING}
        deadline = updated.claim_expires_at if active else None
        reply = self._run_state_machine(
            OPERATION_COMMIT,
            {
                "job_id": job.id,
                "expected_revision": expected_revision,
                "job": self._serialize_job(updated),
                "purpose": job.request.purpose.value,
                "new_state": updated.state.value,
                "new_worker_id": updated.worker_id,
                "worker_id": worker_id,
                "expected_claim_expires_at": (
                    expected_claim_expires_at.isoformat() if expected_claim_expires_at is not None else None
                ),
                "expected_claim_expires_ms": (
                    self._timestamp_milliseconds(expected_claim_expires_at)
                    if expected_claim_expires_at is not None
                    else 0
                ),
                "next_claim_expires_ms": self._timestamp_milliseconds(deadline) if deadline is not None else 0,
                "next_lease_token": (
                    self._lease_token(updated.worker_id, updated.revision, deadline)
                    if deadline is not None and updated.worker_id is not None
                    else ""
                ),
                "artifact_present": artifact is not None,
                "artifact_name": artifact.name if artifact is not None else "",
                "artifact_media_type": artifact.media_type if artifact is not None else "",
                "events": self._event_payloads(events),
                "occurred_at": (
                    events[-1].occurred_at if events else datetime.now(updated.created_at.tzinfo)
                ).isoformat(),
            },
            artifact.content if artifact is not None else b"",
        )
        status = reply["status"]
        if status == STATUS_MISSING:
            raise JobNotFoundError("Job was not found")
        if status == STATUS_CONFLICT:
            raise StoreWriteConflictError(f"Job revision changed: {job.id}")
        if status == STATUS_CLAIM_LOST:
            raise StoreWriteConflictError(f"Worker claim is no longer active: {job.id}")
        if status != STATUS_OK:
            raise redis.RedisError(f"Unexpected commit status: {status}")
        position = reply.get("position")
        return replace(updated, queue_position=position if isinstance(position, int) else None)

    def _save_via_transaction(
        self,
        job: Job,
        expected_revision: int,
        events: Sequence[JobEvent],
        artifact: StoredArtifact | None,
    ) -> Job:
        """Mirror an unfenced `save` for the fakeredis test client, which has no Lua.

        Raises:
            JobNotFoundError: If the job does not exist.
            StoreWriteConflictError: If the stored revision no longer matches.
            redis.RedisError: If a Redis operation fails.
        """
        job_key = self._job_key(job.id)
        while True:
            try:
                with self._redis.pipeline() as transaction:
                    transaction.watch(job_key)
                    raw = transaction.get(job_key)
                    if raw is None:
                        transaction.unwatch()
                        raise JobNotFoundError("Job was not found")
                    current = self._deserialize_job(raw)
                    if current.revision != expected_revision:
                        transaction.unwatch()
                        raise StoreWriteConflictError(f"Job revision changed: {job.id}")
                    updated_job = replace(job, revision=expected_revision + 1, queue_position=None)
                    self._validate_transition(current, job)
                    remaining_queue_ids: list[str] = []
                    if current.state == JobState.QUEUED and updated_job.state != JobState.QUEUED:
                        transaction.watch(*self._queue_keys.values())
                        remaining_queue_ids = [
                            entry.job_id
                            for entry in self._effective_order(self._read_queue_members(transaction))
                            if entry.job_id != updated_job.id
                        ]
                    transaction.multi()
                    transaction.set(job_key, self._serialize_job(updated_job))
                    if updated_job.state != JobState.QUEUED:
                        self._stage_queue_removal(transaction, updated_job.id)
                    if updated_job.state.terminal:
                        transaction.srem(self._pending_key, updated_job.id)
                        transaction.delete(self._lease_key(updated_job.id))
                    elif current.claim_expires_at is not None and current.worker_id is not None:
                        transaction.set(
                            self._lease_key(updated_job.id),
                            self._lease_token(
                                current.worker_id,
                                updated_job.revision,
                                current.claim_expires_at,
                            ),
                            pxat=self._timestamp_milliseconds(current.claim_expires_at),
                        )
                    if artifact is not None:
                        transaction.set(self._artifact_key(updated_job.id), artifact.content)
                        transaction.hset(
                            self._artifact_metadata_key(updated_job.id),
                            mapping={"name": artifact.name, "media_type": artifact.media_type},
                        )
                    self._stage_event_appends(transaction, updated_job.id, events)
                    if remaining_queue_ids:
                        occurred_at = events[-1].occurred_at if events else datetime.now(updated_job.created_at.tzinfo)
                        self._stage_queue_position_events(transaction, remaining_queue_ids, occurred_at)
                    transaction.execute()
                return self.get(updated_job.id)
            except redis.WatchError:
                continue

    def _save_fenced_for_fakeredis(
        self,
        job: Job,
        expected_revision: int,
        events: Sequence[JobEvent],
        artifact: StoredArtifact | None,
        worker_id: str,
        expected_claim_expires_at: datetime,
    ) -> Job:
        """Exercise the same store contract in fakeredis, which cannot execute Lua."""
        assert self._test_lease_commit_boundary is not None
        job_key = self._job_key(job.id)
        lease_key = self._lease_key(job.id)
        while True:
            try:
                with self._redis.pipeline() as transaction:
                    transaction.watch(job_key, lease_key)
                    raw = transaction.get(job_key)
                    if raw is None:
                        transaction.unwatch()
                        raise JobNotFoundError("Job was not found")
                    current = self._deserialize_job(raw)
                    if (
                        current.revision != expected_revision
                        or current.worker_id != worker_id
                        or current.claim_expires_at != expected_claim_expires_at
                        or current.claim_expires_at <= datetime.now(current.claim_expires_at.tzinfo)
                        or transaction.get(lease_key)
                        != self._lease_token(worker_id, expected_revision, expected_claim_expires_at).encode()
                    ):
                        transaction.unwatch()
                        raise StoreWriteConflictError(f"Worker claim is no longer active: {job.id}")
                    with self._test_lease_commit_boundary():
                        raw = transaction.get(job_key)
                        current = self._deserialize_job(raw) if raw is not None else None
                        now = datetime.now(expected_claim_expires_at.tzinfo)
                        if raw is None:
                            transaction.unwatch()
                            raise JobNotFoundError("Job was not found")
                        if (
                            current.revision != expected_revision
                            or current.worker_id != worker_id
                            or current.claim_expires_at != expected_claim_expires_at
                            or expected_claim_expires_at <= now
                            or transaction.get(lease_key)
                            != self._lease_token(worker_id, expected_revision, expected_claim_expires_at).encode()
                        ):
                            transaction.unwatch()
                            raise StoreWriteConflictError(f"Worker claim is no longer active: {job.id}")
                        updated_job = replace(job, revision=expected_revision + 1, queue_position=None)
                        if updated_job.claim_expires_at is not None and updated_job.claim_expires_at <= now:
                            transaction.unwatch()
                            raise StoreWriteConflictError(f"Worker claim is no longer active: {job.id}")
                        transaction.multi()
                        transaction.set(job_key, self._serialize_job(updated_job))
                        if updated_job.state.terminal:
                            transaction.srem(self._pending_key, updated_job.id)
                            transaction.delete(lease_key)
                            self._stage_queue_removal(transaction, updated_job.id)
                        elif updated_job.claim_expires_at is not None:
                            transaction.set(
                                lease_key,
                                self._lease_token(worker_id, updated_job.revision, updated_job.claim_expires_at),
                                pxat=self._timestamp_milliseconds(updated_job.claim_expires_at),
                            )
                        if artifact is not None:
                            transaction.set(self._artifact_key(job.id), artifact.content)
                            transaction.hset(
                                self._artifact_metadata_key(job.id),
                                mapping={"name": artifact.name, "media_type": artifact.media_type},
                            )
                        self._stage_event_appends(transaction, job.id, events)
                        if expected_claim_expires_at <= datetime.now(expected_claim_expires_at.tzinfo):
                            transaction.reset()
                            raise StoreWriteConflictError(f"Worker claim is no longer active: {job.id}")
                        transaction.execute()
                return self.get(job.id)
            except redis.WatchError:
                continue

    def prepare_event_replay(self, job_id: str, requested_cursor: str | None) -> EventReplayWindow:
        """Snapshot the initial replay batch inside one atomic Redis transaction.

        Codec version/job-binding validation runs first. Job existence, the floor
        and tail ids, the exact-cursor probe, and the batch read are then captured
        in a single `WATCH`/`MULTI`/`EXEC` snapshot of the job and its event stream.
        Any concurrent append or trim invalidates the watch and the snapshot is
        retried, so the returned floor/tail/batch always coexisted. Exhausting the
        retry bound fails closed with a contention error rather than returning
        stale or never-coexistent values.

        Raises:
            JobNotFoundError: If the job does not exist.
            EventCursorExpired: If the cursor is valid but older than the retained floor.
            EventCursorInvalid: If the cursor is malformed, foreign, future, or non-exact.
            JobOperationContentionError: If a stable snapshot is not obtained in the retry bound.
            redis.RedisError: If a Redis operation fails.
        """
        native = decode_cursor(requested_cursor, job_id) if requested_cursor is not None else None
        native_key = _parse_stream_id(native) if native is not None else None
        events_key = self._events_key(job_id)
        job_key = self._job_key(job_id)

        for _attempt in range(REPLAY_SNAPSHOT_MAX_ATTEMPTS):
            try:
                with self._redis.pipeline() as transaction:
                    transaction.watch(job_key, events_key)
                    if not transaction.exists(job_key):
                        transaction.unwatch()
                        raise JobNotFoundError("Job was not found")
                    transaction.multi()
                    transaction.xrange(events_key, count=1)
                    transaction.xrevrange(events_key, count=1)
                    if native is not None:
                        transaction.xrange(events_key, min=native, max=native, count=1)
                        transaction.xrange(events_key, min=f"({native}", max="+", count=REPLAY_INITIAL_BATCH_COUNT)
                    else:
                        transaction.xrange(events_key, count=REPLAY_INITIAL_BATCH_COUNT)
                    results = transaction.execute()
                break
            except redis.WatchError:
                continue
        else:
            raise JobOperationContentionError("Event replay snapshot did not stabilize")

        first, last = results[0], results[1]
        exact = results[2] if native is not None else None
        batch = results[3] if native is not None else results[2]

        if not first:
            if native is None:
                return EventReplayWindow(initial_events=[], next_cursor=None, oldest_event_id=None)
            raise EventCursorExpired(None)

        floor_id = _decode(first[0][0])
        tail_id = _decode(last[0][0])
        oldest_public = encode_cursor(job_id, floor_id)
        if native_key is not None:
            if native_key < _parse_stream_id(floor_id):
                raise EventCursorExpired(oldest_public)
            if native_key > _parse_stream_id(tail_id):
                raise EventCursorInvalid("Cursor native ID is newer than the retained tail")
            if len(exact) != 1:
                raise EventCursorInvalid("Cursor native ID is not an exact retained event")

        events = [self._event_from_entry(raw_id, fields) for raw_id, fields in batch]
        next_cursor = events[-1].id if events else native
        return EventReplayWindow(initial_events=events, next_cursor=next_cursor, oldest_event_id=oldest_public)

    @staticmethod
    def _event_from_entry(raw_id, fields) -> JobEvent:
        """Build a `JobEvent` from one raw Redis stream entry."""
        return JobEvent(
            id=_decode(raw_id),
            type=_decode(fields.get(b"type")) or "job.event",
            data=json.loads(_decode(fields.get(b"data")) or "{}"),
            occurred_at=datetime.fromisoformat(_decode(fields.get(b"occurred_at")) or ""),
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
            redis.RedisError: If a Redis operation fails.
        """
        self.get(job_id)
        last_id = after_id or "0-0"
        block_ms = max(1, int(keepalive_seconds * 1000))
        while True:
            terminal = self.get(job_id).state.terminal
            try:
                streams = self._stream_redis.xread(
                    {self._events_key(job_id): last_id},
                    block=None if terminal else block_ms,
                )
            except redis.exceptions.TimeoutError:
                streams = []
            if not streams:
                if terminal:
                    return
                yield None
                continue
            for _stream, entries in streams:
                for raw_id, fields in entries:
                    last_id = _decode(raw_id)
                    yield JobEvent(
                        id=last_id,
                        type=_decode(fields.get(b"type")) or "job.event",
                        data=json.loads(_decode(fields.get(b"data")) or "{}"),
                        occurred_at=datetime.fromisoformat(_decode(fields.get(b"occurred_at")) or ""),
                    )
            if terminal or self.get(job_id).state.terminal:
                return

    def find_finished_before(self, cutoff: datetime) -> list[Job]:
        """Return jobs finished before the retention cutoff.

        Maintenance deletes them to keep retained job history bounded.

        Raises:
            redis.RedisError: If a Redis operation fails.
        """
        return [job for job in self._all_jobs() if job.finished_at is not None and job.finished_at < cutoff]

    def find_claimed_before(self, cutoff: datetime) -> list[Job]:
        """Return active jobs whose worker claim expired by the cutoff.

        Maintenance terminates them because their worker is presumed lost.

        Raises:
            redis.RedisError: If a Redis operation fails.
        """
        return [
            job
            for job in self._all_jobs()
            if job.state in {JobState.RUNNING, JobState.CANCELLING}
            and job.claim_expires_at is not None
            and job.claim_expires_at <= cutoff
        ]

    def describe_queue_state(self) -> QueueStateSnapshot:
        """Return one atomic snapshot of the complete queue state.

        Atomic by construction: the script reads every index in one execution, and
        the fallback reads them inside one watched transaction. Assembling this from
        separate reads would let a concurrent transition fabricate an apparent
        invariant violation, or hide a real one.

        Raises:
            redis.RedisError: If a Redis operation fails.
        """
        if self._supports_lua:
            reply = self._run_state_machine(OPERATION_DESCRIBE, {"occurred_at": _now_iso()})
            jobs = {
                entry["job_id"]: JobQueueFacts(
                    state=JobState(entry["state"]),
                    purpose=JobPurpose(entry["purpose"]),
                    created_at=datetime.fromisoformat(entry["created_at"]),
                    has_claim_lease=bool(entry["has_claim_lease"]),
                )
                for entry in (reply.get("jobs") if isinstance(reply.get("jobs"), list) else [])
            }
            return QueueStateSnapshot(
                jobs=jobs,
                pending_ids=frozenset(reply.get("pending") if isinstance(reply.get("pending"), list) else []),
                ordinary_members=self._members_from_flat(reply.get("ordinary")),
                diagnostic_members=self._members_from_flat(reply.get("diagnostic")),
            )
        while True:
            try:
                with self._redis.pipeline() as transaction:
                    transaction.watch(self._jobs_key, self._pending_key, *self._queue_keys.values())
                    members = self._read_queue_members(transaction)
                    pending = {_decode(raw_id) for raw_id in transaction.smembers(self._pending_key)}
                    job_ids = [_decode(raw_id) for raw_id in transaction.zrange(self._jobs_key, 0, -1)]
                    facts: dict[str, JobQueueFacts] = {}
                    for job_id in job_ids:
                        raw = transaction.get(self._job_key(job_id))
                        if raw is None:
                            continue
                        job = self._deserialize_job(raw)
                        facts[job_id] = JobQueueFacts(
                            state=job.state,
                            purpose=job.request.purpose,
                            created_at=job.created_at,
                            has_claim_lease=bool(transaction.exists(self._lease_key(job_id))),
                        )
                    transaction.unwatch()
                return QueueStateSnapshot(
                    jobs=facts,
                    pending_ids=frozenset(pending),
                    ordinary_members=tuple(members[JobPurpose.ORDINARY]),
                    diagnostic_members=tuple(members[JobPurpose.ASSISTANT_DIAGNOSTIC]),
                )
            except redis.WatchError:
                continue

    @staticmethod
    def _members_from_flat(raw: Any) -> tuple[QueueMember, ...]:
        """Rebuild queue members from a Lua `ZRANGE ... WITHSCORES` flat reply."""
        if not isinstance(raw, list):
            return ()
        pairs = zip(raw[0::2], raw[1::2])
        return tuple(QueueMember(job_id=str(job_id), created_at=float(score)) for job_id, score in pairs)

    def recent_invariant_errors(self) -> list[dict[str, str]]:
        """Return the bounded record of defensive repairs, oldest first.

        Raises:
            redis.RedisError: If a Redis operation fails.
        """
        entries = self._redis.xrange(self._invariant_errors_key)
        return [
            {
                "kind": _decode(fields.get(b"kind")) or "",
                "job_id": _decode(fields.get(b"job_id")) or "",
                "occurred_at": _decode(fields.get(b"occurred_at")) or "",
            }
            for _raw_id, fields in entries
        ]

    def repair_queue_residue(self, occurred_at: datetime | None = None) -> list[str]:
        """Remove inconsistent index entries and report the repairs performed.

        Raises:
            redis.RedisError: If a Redis operation fails.
        """
        stamp = (occurred_at or datetime.now(timezone.utc)).isoformat()
        if self._supports_lua:
            reply = self._run_state_machine(OPERATION_REPAIR, {"occurred_at": stamp})
            repaired = reply.get("repaired")
            return [str(kind) for kind in repaired] if isinstance(repaired, list) else []
        return self._repair_via_transaction(datetime.fromisoformat(stamp))

    def _repair_via_transaction(self, occurred_at: datetime) -> list[str]:
        """Mirror `repair_queue_residue` for the fakeredis client, which has no Lua."""
        while True:
            try:
                with self._redis.pipeline() as transaction:
                    transaction.watch(self._pending_key, *self._queue_keys.values())
                    repairs: list[tuple[str, str, JobPurpose | None]] = []
                    for purpose, queue_members in self._read_queue_members(transaction).items():
                        for member in queue_members:
                            raw = transaction.get(self._job_key(member.job_id))
                            if raw is None:
                                repairs.append((INVARIANT_ERROR_ORPHAN_QUEUE_MEMBER, member.job_id, purpose))
                                continue
                            job = self._deserialize_job(raw)
                            if job.state != JobState.QUEUED or job.request.purpose != purpose:
                                repairs.append((INVARIANT_ERROR_STALE_QUEUE_MEMBER, member.job_id, purpose))
                    for raw_id in transaction.smembers(self._pending_key):
                        job_id = _decode(raw_id)
                        raw = transaction.get(self._job_key(job_id))
                        job = self._deserialize_job(raw) if raw is not None else None
                        if job is None or job.state.terminal:
                            repairs.append((INVARIANT_ERROR_STALE_PENDING_MEMBER, job_id, None))
                    if not repairs:
                        transaction.unwatch()
                        return []
                    transaction.multi()
                    for kind, job_id, purpose in repairs:
                        if purpose is None:
                            transaction.srem(self._pending_key, job_id)
                        else:
                            transaction.zrem(self._queue_keys[purpose], job_id)
                        self._stage_invariant_error(transaction, kind, job_id, occurred_at)
                    transaction.execute()
                return [kind for kind, _job_id, _purpose in repairs]
            except redis.WatchError:
                continue

    def check_health(self) -> None:
        """Raise an error when Redis is unavailable or its identity changed.

        Raises:
            redis.RedisError: If the Redis health check fails.
        """
        # GET verifies connectivity and store identity in one bounded command.
        # Avoid PING and retries so readiness uses one bounded Redis operation.
        resolved_store_id = _decode(self._redis.get(self._store_id_key))
        if resolved_store_id != self._store_id:
            raise redis.RedisError("Redis job store identity changed")

    def delete(self, job_id: str, expected_revision: int) -> None:
        """Delete a job and its Redis data if its revision still matches.

        Serves both explicit delete and retention cleanup. Every index the job
        occupied is released in the SAME atomic step as the job and its child
        material, so neither path can leave a queue member or a pending slot behind
        for work that no longer exists. Whether a job is deletable at all is
        lifecycle policy and stays with the controller, which admits only terminal
        jobs from the public delete and the retention reaper.

        Raises:
            JobNotFoundError: If the job does not exist.
            StoreWriteConflictError: If the stored revision no longer matches.
            redis.RedisError: If a Redis operation fails.
        """
        if self._supports_lua:
            reply = self._run_state_machine(
                OPERATION_DELETE,
                {"job_id": job_id, "expected_revision": expected_revision, "occurred_at": _now_iso()},
            )
            status = reply["status"]
            if status == STATUS_MISSING:
                raise JobNotFoundError("Job was not found")
            if status == STATUS_CONFLICT:
                raise StoreWriteConflictError(f"Job revision changed: {job_id}")
            if status != STATUS_OK:
                raise redis.RedisError(f"Unexpected delete status: {status}")
            return
        job_key = self._job_key(job_id)
        while True:
            try:
                with self._redis.pipeline() as transaction:
                    transaction.watch(job_key)
                    raw = transaction.get(job_key)
                    if raw is None:
                        transaction.unwatch()
                        raise JobNotFoundError("Job was not found")
                    current = self._deserialize_job(raw)
                    if current.revision != expected_revision:
                        transaction.unwatch()
                        raise StoreWriteConflictError(f"Job revision changed: {job_id}")
                    transaction.multi()
                    self._stage_job_deletion(transaction, job_id)
                    transaction.execute()
                return
            except redis.WatchError:
                continue

    def _all_jobs(self) -> list[Job]:
        """Return all jobs referenced by the retained-jobs index.

        Raises:
            redis.RedisError: If a Redis operation fails.
        """
        raw_ids = self._redis.zrange(self._jobs_key, 0, -1)
        job_ids = [_decode(raw_id) for raw_id in raw_ids]
        if not job_ids:
            return []
        raw_jobs = self._redis.mget([self._job_key(job_id) for job_id in job_ids])
        return [self._deserialize_job(raw) for raw in raw_jobs if raw is not None]

    def _with_queue_position(self, job: Job) -> Job:
        """Return a job copy carrying its authoritative effective queue position.

        The whole order comes from ONE snapshot — an atomic script reply, or a
        single watched transaction on the fallback. A rank read from one queue key
        would be meaningless here: a diagnostic's position depends on the ordinary
        queue's size, so two independent reads could report a position that never
        actually held.

        Raises:
            redis.RedisError: If the queue order cannot be read.
        """
        if job.state != JobState.QUEUED:
            return replace(job, queue_position=None)
        for entry in self._effective_position_snapshot():
            if entry.job_id == job.id:
                return replace(job, queue_position=entry.position)
        return replace(job, queue_position=None)

    def _effective_position_snapshot(self) -> list[EffectivePosition]:
        """Return one consistent effective-position snapshot across both queues."""
        if self._supports_lua:
            return self._positions(self._run_state_machine(OPERATION_POSITIONS, {"occurred_at": _now_iso()}))
        while True:
            try:
                with self._redis.pipeline() as transaction:
                    transaction.watch(*self._queue_keys.values())
                    order = self._effective_order(self._read_queue_members(transaction))
                    transaction.unwatch()
                return order
            except redis.WatchError:
                continue

    def _read_queue_members(self, reader) -> dict[JobPurpose, list[QueueMember]]:
        """Read both purpose queues with their FIFO scores through one reader."""
        return {
            purpose: [
                QueueMember(job_id=_decode(raw_id), created_at=score)
                for raw_id, score in reader.zrange(self._queue_keys[purpose], 0, -1, withscores=True)
            ]
            for purpose in JobPurpose
        }

    @staticmethod
    def _effective_order(members: Mapping[JobPurpose, list[QueueMember]]) -> list[EffectivePosition]:
        """Return the effective order: all ordinary work in FIFO, then diagnostics."""
        ordered = fifo_sorted(members[JobPurpose.ORDINARY]) + fifo_sorted(members[JobPurpose.ASSISTANT_DIAGNOSTIC])
        return [
            EffectivePosition(job_id=member.job_id, position=index) for index, member in enumerate(ordered, start=1)
        ]

    def _stage_queue_removal(self, transaction, job_id: str) -> None:
        """Stage removal of a job from BOTH purpose queues.

        Both, not just the one its purpose names: a removal that trusted the purpose
        would leave residue behind if a record were ever inconsistent, and residue
        is exactly what must not survive a transition.
        """
        for queue_key in self._queue_keys.values():
            transaction.zrem(queue_key, job_id)

    def _stage_invariant_error(self, transaction, kind: str, job_id: str, occurred_at: datetime) -> None:
        """Stage one bounded repair record carrying no submitted content."""
        transaction.xadd(
            self._invariant_errors_key,
            {"kind": kind, "job_id": job_id, "occurred_at": occurred_at.isoformat()},
            maxlen=MAX_RETAINED_INVARIANT_ERRORS,
            approximate=False,
        )

    @staticmethod
    def _validate_transition(current: Job, replacement: Job) -> None:
        """Reject a saved transition the queue state machine does not define.

        Mirrors the guards inside the Lua module so the fallback adapter cannot
        accept a transition real Redis would refuse.

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

    def _stage_event_appends(self, transaction, job_id: str, events: Sequence[JobEvent]) -> None:
        """Stage event-stream appends in an active Redis transaction."""
        for event in events:
            transaction.xadd(
                self._events_key(job_id),
                {
                    "type": event.type,
                    "data": json.dumps(event.data, separators=(",", ":")),  # eliminate whitespace for compact storage
                    "occurred_at": event.occurred_at.isoformat(),
                },
                maxlen=self._max_events_per_job,
                approximate=False,
            )

    def _stage_job_deletion(self, transaction, job_id: str) -> None:
        """Stage deletion of all job data and indexes in an active Redis transaction.

        CHILD MATERIAL BEFORE THE JOB SHELL (T08 retention ordering). The whole
        MULTI is atomic, so no reader observes a partial state, but the ordering
        is still the durable statement of the invariant: the raw submitted input
        and generated artifact must never outlive the job record that governs
        their retention. Should this ever be split across commands, or replayed
        by a later Lua state machine, the safe order is already the written one.
        """
        transaction.delete(
            self._input_key(job_id),
            self._artifact_key(job_id),
            self._artifact_metadata_key(job_id),
            self._events_key(job_id),
            self._lease_key(job_id),
        )
        transaction.delete(self._job_key(job_id))
        transaction.zrem(self._jobs_key, job_id)
        self._stage_queue_removal(transaction, job_id)
        transaction.srem(self._pending_key, job_id)

    @staticmethod
    def _serialize_job(job: Job) -> str:
        """Serialize a job to the compact JSON representation stored in Redis."""
        data: dict[str, Any] = {
            "id": job.id,
            "state": job.state.value,
            "request": {
                "input_name": job.request.input_name,
                "client_id": job.request.client_id,
                "solver": job.request.solver,
                "prettify": job.request.prettify,
                "timeout_seconds": job.request.timeout_seconds,
                # Purpose is written INSIDE request because it is immutable request
                # data, and mirrored at the top level because the Lua state machine
                # reads it on every transition and must not depend on nesting.
                "purpose": job.request.purpose.value,
                "basis": _serialize_basis(job.request.basis),
                "basis_id": job.request.basis_id,
                "parent_basis_id": job.request.parent_basis_id,
                "transform_digest": job.request.transform_digest,
            },
            "created_at": job.created_at.isoformat(),
            "expires_at": job.expires_at.isoformat() if job.expires_at is not None else None,
            "revision": job.revision,
            "started_at": job.started_at.isoformat() if job.started_at is not None else None,
            "finished_at": job.finished_at.isoformat() if job.finished_at is not None else None,
            "worker_id": job.worker_id,
            "claim_expires_at": job.claim_expires_at.isoformat() if job.claim_expires_at is not None else None,
            "result": (
                {
                    "outcome": job.result.outcome.value,
                    "score": job.result.score,
                    "solver_status": job.result.solver_status,
                    "termination_reason": job.result.termination_reason,
                }
                if job.result is not None
                else None
            ),
            "failure": (
                {"code": job.failure.code, "message": job.failure.message} if job.failure is not None else None
            ),
            "purpose": job.request.purpose.value,
            "cancel_requested": job.cancel_requested,
            "early_completion_requested": job.early_completion_requested,
            "artifact_name": job.artifact_name,
        }
        return json.dumps(data, separators=(",", ":"))

    @staticmethod
    def _deserialize_job(raw: bytes | str) -> Job:
        """Deserialize a stored JSON value into a job model."""
        data = json.loads(_decode(raw))
        request = data["request"]
        result = data.get("result")
        failure = data.get("failure")
        return Job(
            id=data["id"],
            state=JobState(data["state"]),
            request=JobRequest(
                input_name=request["input_name"],
                client_id=request["client_id"],
                solver=request["solver"],
                prettify=request.get("prettify"),
                timeout_seconds=request["timeout_seconds"],
                # A record written before purpose existed reads as ordinary, which is
                # what it semantically was; guessing diagnostic would move existing
                # work into the wrong queue and the wrong admission class.
                purpose=JobPurpose(request.get("purpose", JobPurpose.ORDINARY.value)),
                basis=_deserialize_basis(request.get("basis")),
                basis_id=request.get("basis_id"),
                parent_basis_id=request.get("parent_basis_id"),
                transform_digest=request.get("transform_digest"),
            ),
            created_at=datetime.fromisoformat(data["created_at"]),
            expires_at=datetime.fromisoformat(data["expires_at"]) if data.get("expires_at") else None,
            revision=data["revision"],
            started_at=datetime.fromisoformat(data["started_at"]) if data.get("started_at") else None,
            finished_at=datetime.fromisoformat(data["finished_at"]) if data.get("finished_at") else None,
            worker_id=data.get("worker_id"),
            claim_expires_at=(
                datetime.fromisoformat(data["claim_expires_at"]) if data.get("claim_expires_at") else None
            ),
            result=(
                OptimizationResult(
                    outcome=OptimizationOutcome(result["outcome"]),
                    score=result.get("score"),
                    solver_status=result["solver_status"],
                    termination_reason=result.get("termination_reason"),
                )
                if result is not None
                else None
            ),
            failure=JobFailure(**failure) if failure is not None else None,
            cancel_requested=bool(data.get("cancel_requested", False)),
            early_completion_requested=bool(data.get("early_completion_requested", False)),
            artifact_name=data.get("artifact_name"),
        )

    def _key(self, *parts: str) -> str:
        """Build a Redis key beneath the configured hash-tagged namespace.

        EVERY key goes through here, so every key this store touches carries the
        same hash tag and lands in one Redis slot. Phase 1 is not a cluster
        topology; this keeps that boundary honest rather than silently unsafe, so a
        later clustered deployment cannot quietly turn the atomic state machine
        into a cross-slot, non-atomic protocol (T09).
        """
        return ":".join((self._prefix, QUEUE_KEY_HASH_TAG, *parts))

    def _job_key(self, job_id: str) -> str:
        """Return the string key (`SET`) containing serialized job metadata."""
        return self._key("job", job_id)

    def _lease_key(self, job_id: str) -> str:
        """Return the expiring Redis key that fences one worker's active claim."""
        return self._key("job", job_id, "lease")

    @staticmethod
    def _timestamp_milliseconds(value: datetime) -> int:
        """Convert an aware deadline to the absolute Redis millisecond epoch."""
        return int(value.timestamp() * 1000)

    @staticmethod
    def _lease_token(worker_id: str | None, revision: int, deadline: datetime | None) -> str:
        """Build the lease-key value bound to the persisted owner and revision."""
        assert worker_id is not None
        assert deadline is not None
        return f"{worker_id}|{revision}|{deadline.isoformat()}"

    def _input_key(self, job_id: str) -> str:
        """Return the string key (`SET`) containing the submitted input bytes."""
        return self._key("job", job_id, "input")

    def _artifact_key(self, job_id: str) -> str:
        """Return the string key (`SET`) containing the generated artifact bytes."""
        return self._key("job", job_id, "artifact")

    def _artifact_metadata_key(self, job_id: str) -> str:
        """Return the hash key (`HSET`) containing the artifact name and media type."""
        return self._key("job", job_id, "artifact_metadata")

    def _events_key(self, job_id: str) -> str:
        """Return the stream key (`XADD`) containing persisted job events."""
        return self._key("job", job_id, "events")

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

    def _stage_queue_position_events(self, transaction, job_ids: Sequence[str], occurred_at: datetime) -> None:
        """Stage position events for an ordered sequence of queued jobs in an active Redis transaction."""
        for position, job_id in enumerate(job_ids, start=1):
            self._stage_queue_position_event(transaction, job_id, position, occurred_at)

    def _stage_queue_position_event(
        self,
        transaction,
        job_id: str,
        position: int,
        occurred_at: datetime,
    ) -> None:
        """Stage one job state event with its updated queue position in an active Redis transaction."""
        self._stage_event_appends(
            transaction,
            job_id,
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
