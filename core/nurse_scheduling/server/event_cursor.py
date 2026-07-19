"""Opaque, versioned, job-bound SSE cursor codec and replay-window outcomes."""

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

import base64
import binascii
import re


CURSOR_VERSION = "v1"
"""Wire version prefix of the public event cursor."""

_SEGMENT_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
"""Unpadded base64url segment: URL-safe alphabet only, no `=` padding, non-empty."""


class EventCursorInvalid(Exception):
    """The requested cursor is malformed, foreign, future, or otherwise not exact."""


class EventCursorExpired(Exception):
    """The requested cursor is valid but older than the retained event floor."""

    def __init__(self, oldest_public_cursor: str | None):
        """Carry the oldest retained public cursor for client recovery."""
        super().__init__("Requested event history is no longer retained.")
        self.oldest_public_cursor = oldest_public_cursor
        """Public cursor of the oldest retained event, or `None` when none remain."""


def _encode_segment(text: str) -> str:
    """Return the unpadded base64url encoding of a UTF-8 string."""
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_segment(segment: str) -> str:
    """Decode one canonical unpadded base64url segment to text.

    Beyond alphabet/padding and UTF-8, the decoded text must re-encode to exactly
    the submitted segment. Base64 has multiple spellings that decode to the same
    bytes (for example `MR` and `MQ` both yield `"1"`); requiring a byte-for-byte
    round trip rejects aliases the server never emitted before native comparison.

    Raises:
        EventCursorInvalid: If the segment is not a canonical unpadded base64url UTF-8 spelling.
    """
    if not _SEGMENT_PATTERN.match(segment):
        raise EventCursorInvalid("Cursor segment is not unpadded base64url")
    padding = "=" * (-len(segment) % 4)
    try:
        decoded = base64.urlsafe_b64decode(segment + padding).decode("utf-8")
    except (binascii.Error, ValueError, UnicodeDecodeError) as error:
        raise EventCursorInvalid("Cursor segment could not be decoded") from error
    if _encode_segment(decoded) != segment:
        raise EventCursorInvalid("Cursor segment is not in canonical base64url form")
    return decoded


def encode_cursor(job_id: str, native_event_id: str) -> str:
    """Encode a native store event ID into its public job-bound cursor."""
    return f"{CURSOR_VERSION}.{_encode_segment(job_id)}.{_encode_segment(native_event_id)}"


def decode_cursor(token: str, expected_job_id: str) -> str:
    """Validate a public cursor's version and job binding and return the native ID.

    Raises:
        EventCursorInvalid: If the token is malformed, wrong-versioned, or bound to another job.
    """
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != CURSOR_VERSION:
        raise EventCursorInvalid("Cursor version or shape is unsupported")
    job_id = _decode_segment(parts[1])
    native_event_id = _decode_segment(parts[2])
    if job_id != expected_job_id:
        raise EventCursorInvalid("Cursor is bound to a different job")
    return native_event_id
