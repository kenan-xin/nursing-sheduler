"""Controller store-write retry uses the shared bounded-backoff policy."""

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

from nurse_scheduling.server.errors import JobOperationContentionError, StoreWriteConflictError
from nurse_scheduling.server.jobs.controller import JobController


def test_controller_backs_off_between_store_write_retries(monkeypatch):
    trace: list[str] = []
    attempts = iter(range(1, 4))

    def operation() -> str:
        index = next(attempts)
        trace.append(f"operation-{index}")
        if index < 3:
            raise StoreWriteConflictError("conflict")
        return "saved"

    monkeypatch.setattr(
        "nurse_scheduling.server.retry.time.sleep",
        lambda seconds: trace.append(f"sleep-{seconds}"),
    )

    assert JobController._retry_store_write(operation) == "saved"
    assert trace == [
        "operation-1",
        "sleep-0.001",
        "operation-2",
        "sleep-0.002",
        "operation-3",
    ]


def test_controller_retry_converts_exhausted_conflicts_to_contention(monkeypatch):
    def operation() -> str:
        raise StoreWriteConflictError("conflict")

    monkeypatch.setattr("nurse_scheduling.server.retry.time.sleep", lambda _seconds: None)

    with pytest.raises(JobOperationContentionError):
        JobController._retry_store_write(operation)
