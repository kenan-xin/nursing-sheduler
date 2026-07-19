"""Lifecycle-owned periodic maintenance for retained server jobs."""

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

import logging
import threading
import time
from collections.abc import Callable

from .jobs.controller import JobController


server_logger = logging.getLogger("nurse_scheduling.server")

MaintenanceClock = Callable[[], float]
LIVENESS_INTERVAL_FACTOR = 3.0
"""Missed-pass allowance before maintenance is considered unhealthy."""


class JobMaintenance:
    """Periodically expire lost-worker claims and retained job history."""

    def __init__(
        self,
        controller: JobController,
        *,
        interval_seconds: float,
        clock: MaintenanceClock = time.monotonic,
    ):
        """Configure periodic job cleanup without starting its thread."""
        self._controller = controller
        """Controller that expires lost-worker claims and retained job history."""
        self._interval_seconds = interval_seconds
        """Delay between maintenance passes."""
        self._clock = clock
        """Monotonic clock used for liveness timing and deterministic tests."""
        self._liveness_timeout_seconds = interval_seconds * LIVENESS_INTERVAL_FACTOR
        """Age of the last successful pass beyond which readiness fails closed."""
        self._stop = threading.Event()
        """Signal that interrupts the maintenance wait and stops the loop."""
        self._thread: threading.Thread | None = None
        """Daemon maintenance thread, or `None` when no thread is retained."""
        self._progress_lock = threading.Lock()
        """Lock guarding the start and last-success timestamps."""
        self._started_at: float | None = None
        """Monotonic time the current loop started, before any pass completes."""
        self._last_success_at: float | None = None
        """Monotonic time of the most recent fully successful maintenance pass."""

    def start(self) -> None:
        """Start the daemon maintenance loop unless it is already running."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        with self._progress_lock:
            self._started_at = self._clock()
            self._last_success_at = None
        self._thread = threading.Thread(target=self._run, name="job-maintenance", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Request shutdown and wait briefly for the maintenance thread to exit."""
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=5)
        if self._thread is thread and (thread is None or not thread.is_alive()):
            self._thread = None

    def is_alive(self) -> bool:
        """Return whether the maintenance thread is currently running."""
        return self._thread is not None and self._thread.is_alive()

    def is_healthy(self) -> bool:
        """Return whether maintenance is live and making timely successful passes.

        Healthy means the thread is running and a successful pass (or, before the
        first pass, the loop start) happened within the liveness window. A stalled
        thread or one that stopped completing passes reports unhealthy so `/health`
        and `/ready` can fail closed while expired claims would otherwise never
        become `worker_lost`.
        """
        if not self.is_alive():
            return False
        with self._progress_lock:
            reference = self._last_success_at if self._last_success_at is not None else self._started_at
        if reference is None:
            return False
        return (self._clock() - reference) <= self._liveness_timeout_seconds

    def _run(self) -> None:
        """Apply claim expiry and retention cleanup at each interval.

        A fully successful pass records its completion time for liveness. Failures
        are logged without terminating future maintenance passes.
        """
        while not self._stop.wait(self._interval_seconds):
            try:
                self._controller.expire_worker_claims()
                self._controller.expire_jobs()
            except Exception:
                server_logger.exception("[server:maintenance] job retention check failed")
            else:
                with self._progress_lock:
                    self._last_success_at = self._clock()
