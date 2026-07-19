"""Public cursor codec and shared replay-window resolution across all stores."""

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

import pytest

from nurse_scheduling.server.errors import JobNotFoundError
from nurse_scheduling.server.event_cursor import (
    EventCursorExpired,
    EventCursorInvalid,
    decode_cursor,
    encode_cursor,
)
from nurse_scheduling.server.jobs.models import JobEvent, StoreLimits
from tests.server_support import _make_fakeredis_store as _make_fakeredis
from tests.server_support import make_job, utc_now

LIMITS = StoreLimits(max_pending=8, max_retained=128)


def _append(store, job_id, count):
    """Append `count` progress events to a job and return their native IDs in order."""
    current = store.get(job_id)
    for index in range(count):
        current = store.save(
            current,
            current.revision,
            [JobEvent(type="job.progressed", data={"i": index}, occurred_at=utc_now())],
        )
    window = store.prepare_event_replay(job_id, None)
    return [event.id for event in window.initial_events]


def _bump_native(native: str) -> str:
    """Return a well-formed native ID strictly greater than the given one."""
    if "-" in native:
        milliseconds, sequence = native.split("-")
        return f"{milliseconds}-{int(sequence) + 1}"
    return str(int(native) + 1)


# --- Codec unit tests (no store) ---------------------------------------------


def test_cursor_round_trip():
    token = encode_cursor("job_abc", "42-0")
    assert token.startswith("v1.")
    assert "=" not in token
    assert decode_cursor(token, "job_abc") == "42-0"


@pytest.mark.parametrize("token", ["", "v1", "v1.only", "v2.aa.bb", "v1.aa.bb.cc", "v1.aa=.bb", "not-a-cursor"])
def test_cursor_rejects_malformed(token):
    with pytest.raises(EventCursorInvalid):
        decode_cursor(token, "job_abc")


def test_cursor_rejects_foreign_job():
    token = encode_cursor("job_other", "1")
    with pytest.raises(EventCursorInvalid):
        decode_cursor(token, "job_abc")


# Noncanonical base64url spellings that decode to the canonical `job_a`/`1` cursor
# (`v1.am9iX2E.MQ`) but were never emitted: `MR`→`1` (native alias) and
# `am9iX2F`→`job_a` (job alias).
NONCANONICAL_BASE64URL_CURSORS = ["v1.am9iX2E.MR", "v1.am9iX2F.MQ"]


@pytest.mark.parametrize("token", NONCANONICAL_BASE64URL_CURSORS)
def test_cursor_rejects_noncanonical_base64url_segment(token):
    with pytest.raises(EventCursorInvalid):
        decode_cursor(token, "job_a")


@pytest.mark.parametrize("token", NONCANONICAL_BASE64URL_CURSORS)
def test_noncanonical_base64url_cursor_rejected_by_stores(store, token):
    # The shared decoder rejects the alias before any native comparison, so both
    # the memory and Redis replay paths reject it identically.
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    _append(store, "job_a", 1)
    with pytest.raises(EventCursorInvalid):
        store.prepare_event_replay("job_a", token)


# --- Replay window across stores ---------------------------------------------


def test_absent_cursor_starts_at_floor(store):
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    ids = _append(store, "job_a", 3)
    window = store.prepare_event_replay("job_a", None)
    assert [event.id for event in window.initial_events] == ids
    assert window.oldest_event_id == encode_cursor("job_a", ids[0])
    assert window.next_cursor == ids[-1]


def test_exact_cursor_resumes_strictly_after(store):
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    ids = _append(store, "job_a", 4)
    cursor = encode_cursor("job_a", ids[1])
    window = store.prepare_event_replay("job_a", cursor)
    assert [event.id for event in window.initial_events] == ids[2:]


def test_empty_stream_absent_cursor(store):
    store.create(make_job("job_a"), b"x", LIMITS, [])
    window = store.prepare_event_replay("job_a", None)
    assert window.initial_events == []
    assert window.next_cursor is None
    assert window.oldest_event_id is None


def test_malformed_cursor_invalid(store):
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    with pytest.raises(EventCursorInvalid):
        store.prepare_event_replay("job_a", "garbage")


def test_foreign_cursor_invalid(store):
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    ids = _append(store, "job_a", 1)
    foreign = encode_cursor("job_other", ids[0])
    with pytest.raises(EventCursorInvalid):
        store.prepare_event_replay("job_a", foreign)


def test_future_cursor_invalid(store):
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    ids = _append(store, "job_a", 2)
    future = encode_cursor("job_a", _bump_native(ids[-1]))
    with pytest.raises(EventCursorInvalid):
        store.prepare_event_replay("job_a", future)


def test_expired_cursor_below_floor(store_factory):
    store = store_factory(max_events_per_job=5)
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    window0 = store.prepare_event_replay("job_a", None)
    oldest_native = window0.initial_events[0].id
    stale_cursor = encode_cursor("job_a", oldest_native)
    _append(store, "job_a", 20)  # overflow trims the original floor away
    with pytest.raises(EventCursorExpired) as excinfo:
        store.prepare_event_replay("job_a", stale_cursor)
    # The error carries the current oldest retained public cursor for recovery.
    current_floor = store.prepare_event_replay("job_a", None).oldest_event_id
    assert excinfo.value.oldest_public_cursor == current_floor


def test_more_than_1000_events_expires_old_cursor(store_factory):
    store = store_factory(max_events_per_job=1000)
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    window0 = store.prepare_event_replay("job_a", None)
    stale_cursor = encode_cursor("job_a", window0.initial_events[0].id)
    _append(store, "job_a", 1100)
    with pytest.raises(EventCursorExpired):
        store.prepare_event_replay("job_a", stale_cursor)


def test_trim_between_snapshot_and_continuation_skips_no_event(store_factory):
    store = store_factory(max_events_per_job=5)
    store.create(make_job("job_a"), b"x", LIMITS, [])
    first_batch = _append(store, "job_a", 5)
    window = store.prepare_event_replay("job_a", None)
    assert [event.id for event in window.initial_events] == first_batch
    # Appending more trims the oldest but must not orphan the continuation cursor.
    second_batch = _append(store, "job_a", 3)
    streamed = []
    for event in store.stream_events("job_a", window.next_cursor, keepalive_seconds=0.1):
        if event is None:
            break
        streamed.append(event.id)
        if len(streamed) >= 3:
            break
    assert streamed == second_batch[-3:]
    # No event between the snapshot tail and the streamed head was skipped.
    assert window.initial_events[-1].id == first_batch[-1]


# --- Non-canonical native cursor aliases (F8) --------------------------------


def _noncanonical_aliases(native: str) -> list[str]:
    """Return native-id spellings that decode to `native` but were never emitted."""
    if "-" in native:
        milliseconds, sequence = native.split("-")
        return [f"0{milliseconds}-{sequence}", f"{milliseconds}-0{sequence}", f"{milliseconds}-{sequence} "]
    return [f"+{native}", f"0{native}", f"{native} "]


def test_noncanonical_native_alias_is_invalid(store):
    store.create(make_job("job_a"), b"x", LIMITS, [JobEvent("job.state_changed", {"state": "queued"}, utc_now())])
    ids = _append(store, "job_a", 2)
    # The exact cursor is accepted; every alias of it is rejected as non-exact.
    store.prepare_event_replay("job_a", encode_cursor("job_a", ids[0]))
    for alias in _noncanonical_aliases(ids[0]):
        with pytest.raises(EventCursorInvalid):
            store.prepare_event_replay("job_a", encode_cursor("job_a", alias))


# --- Redis snapshot atomicity and fail-closed exhaustion (F5) ----------------


def _wrap_pipeline_execute(store, watch_errors: int) -> None:
    """Make the store's pipeline raise `WatchError` on its first `watch_errors` execs."""
    import redis

    original_pipeline = store._redis.pipeline
    remaining = {"count": watch_errors}

    class _FlakyPipeline:
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
            if remaining["count"] > 0:
                remaining["count"] -= 1
                raise redis.WatchError
            return self._pipeline.execute()

    store._redis.pipeline = lambda: _FlakyPipeline(original_pipeline())


def test_redis_replay_retries_until_snapshot_is_stable():
    store = _make_fakeredis()
    store.create(make_job("job_a"), b"x", LIMITS, [])
    ids = _append(store, "job_a", 3)
    _wrap_pipeline_execute(store, watch_errors=2)  # two concurrent-change retries, then success
    window = store.prepare_event_replay("job_a", None)
    assert [event.id for event in window.initial_events] == ids


def test_redis_replay_fails_closed_when_snapshot_never_stabilizes():
    from nurse_scheduling.server.errors import JobOperationContentionError

    store = _make_fakeredis()
    store.create(make_job("job_a"), b"x", LIMITS, [])
    _append(store, "job_a", 3)
    _wrap_pipeline_execute(store, watch_errors=10_000)  # never stabilizes
    with pytest.raises(JobOperationContentionError):
        store.prepare_event_replay("job_a", None)


def test_redis_replay_includes_job_existence_in_boundary():
    store = _make_fakeredis()
    store.create(make_job("job_a"), b"x", LIMITS, [])
    _append(store, "job_a", 2)
    store.delete("job_a", store.get("job_a").revision)
    with pytest.raises(JobNotFoundError):
        store.prepare_event_replay("job_a", None)
