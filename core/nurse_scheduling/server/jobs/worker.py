"""Background worker that claims and executes optimization jobs."""

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

from ..config import DEFAULT_TIMEOUT_GRACE_SECONDS
from ..errors import JobNotFoundError
from .controller import JobController
from .models import Job, JobFailure, JobState, solver_supports_stop
from .process_executor import ProcessControl, ProcessStatus, run_optimization_process
from .runner import OptimizationRunner


server_logger = logging.getLogger("nurse_scheduling.server")
CONTROL_POLL_SECONDS = 1.0
"""Maximum delay before forwarding a cooperative solver control to the child."""


class JobWorker:
    """Own one process-local claim/run loop."""

    def __init__(
        self,
        controller: JobController,
        runner: OptimizationRunner,
        *,
        worker_id: str,
        claim_poll_seconds: float,
        claim_lease_seconds: float,
        timeout_grace_seconds: float = DEFAULT_TIMEOUT_GRACE_SECONDS,
        unexpected_error_formatter: Callable[[Exception], str] = str,
    ):
        """Configure a process-local worker without starting its thread."""
        self._controller = controller
        """Controller used for claims, events, control requests, and outcomes."""
        self._runner = runner
        """Runner executed inside each supervised optimization child process."""
        self._timeout_grace_seconds = timeout_grace_seconds
        """Extra time past the native timeout before the child is force-terminated."""
        self._worker_id = worker_id
        """Stable identity recorded on jobs claimed by this worker."""
        self._claim_poll_seconds = claim_poll_seconds
        """Delay between claim attempts and after recoverable loop errors."""
        self._claim_lease_seconds = claim_lease_seconds
        """Lease duration granted to each claim, used to bound renewal outages."""
        self._claim_heartbeat_seconds = claim_lease_seconds / 3
        """Claim-renewal interval set to one third of the lease for retry margin."""
        self._unexpected_error_formatter = unexpected_error_formatter
        """Formatter used to produce unexpected failure messages."""
        self._stop = threading.Event()
        """Signal that stops claiming jobs and aborts the active child on shutdown."""
        self._lock = threading.Lock()
        """Lock guarding worker-thread creation, inspection, and cleanup."""
        self._shutdown_lock = threading.Lock()
        """Serializes shutdown activation with each worker-originated write section.

        `stop()` sets the shutdown flag under this lock, and every gated write
        (events, completion, failure, exception-path failure) holds it across the
        shutdown check and the controller call. A write admitted before shutdown
        therefore completes, and no write is admitted once `stop()` has returned.
        The controller/store keeps its own authoritative T19 lease fence; this lock
        only closes the local shutdown check-and-write window.
        """
        self._thread: threading.Thread | None = None
        """Daemon claim-loop thread, or `None` when no thread is retained."""

    def start(self) -> None:
        """Start the daemon claim loop unless it is already running."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="optimization-job-worker", daemon=True)
            self._thread.start()
        server_logger.info("[server:worker] started worker_id=%s", self._worker_id)

    def stop(self) -> None:
        """Request shutdown and wait briefly for the worker thread to exit.

        Shutdown activation is taken under `_shutdown_lock` so it cannot land
        between a worker write's shutdown check and its controller call: any write
        already inside that critical section finishes first, and once this returns
        no further worker write is admitted. The blocking join stays outside the
        lock to avoid stalling in-flight writes against a deadlock.
        """
        with self._shutdown_lock:
            self._stop.set()
        with self._lock:
            thread = self._thread
        if thread is not None:
            thread.join(timeout=5)
        with self._lock:
            if self._thread is thread and (thread is None or not thread.is_alive()):
                self._thread = None

    def is_alive(self) -> bool:
        """Return whether the worker thread is currently running."""
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def _run(self) -> None:
        """Claim and execute jobs until shutdown is requested.

        Recoverable claim and reporting failures are logged before retrying.
        """
        while not self._stop.is_set():
            try:
                job = self._controller.claim_next_job(self._worker_id)
            except Exception:
                server_logger.exception("[server:worker] failed to claim job worker_id=%s", self._worker_id)
                self._stop.wait(self._claim_poll_seconds)
                continue
            if job is None:
                self._stop.wait(self._claim_poll_seconds)
                continue
            try:
                self._execute(job)
            except Exception:
                server_logger.exception(
                    "[server:worker] failed to report execution outcome job_id=%s worker_id=%s",
                    job.id,
                    self._worker_id,
                )
                self._stop.wait(self._claim_poll_seconds)

    def _execute(self, job: Job) -> None:
        """Execute one claimed job in a supervised child and report its outcome.

        The runner runs inside a spawned, process-tree-supervised child; this
        worker remains the only store/controller client. Every progress, result,
        failure, and cancellation commit carries this worker's identity, so a
        stale, foreign, or expired claim writes nothing and maintenance retains
        authority for `worker_lost`.
        """
        content = b""
        # Stops the heartbeat and control threads. When set while the child is
        # running it aborts the child tree so a lost claim writes no result.
        monitor_stop = threading.Event()
        # Asks the solver to return its current feasible result cooperatively.
        finish_now_requested = threading.Event()
        # Cancels the job, killing the child tree and discarding its output.
        cancellation_requested = threading.Event()

        def renew_claim() -> None:
            """Renew the worker claim until execution ends, the job disappears, or the lease lapses.

            A confirmed claim resets the local lease deadline. If renewal cannot be
            confirmed past that deadline — a store outage that outlasts the lease —
            the child tree is aborted rather than run against an unrenewed claim
            that maintenance will treat as `worker_lost`.
            """
            confirmed_deadline = time.monotonic() + self._claim_lease_seconds
            while not monitor_stop.wait(self._claim_heartbeat_seconds):
                try:
                    renewed = self._controller.renew_claim(job.id, self._worker_id)
                    if renewed is None or renewed.state.terminal or renewed.worker_id != self._worker_id:
                        monitor_stop.set()
                        return
                    confirmed_deadline = time.monotonic() + self._claim_lease_seconds
                except JobNotFoundError:
                    monitor_stop.set()
                    return
                except Exception:
                    server_logger.exception("[server:worker] failed to renew claim job_id=%s", job.id)
                    if time.monotonic() >= confirmed_deadline:
                        monitor_stop.set()
                        return

        # Lease renewal runs separately because supervising the child blocks this thread.
        heartbeat_thread = threading.Thread(
            target=renew_claim,
            name=f"optimization-job-heartbeat-{job.id}",
            daemon=True,
        )
        heartbeat_thread.start()
        control_thread: threading.Thread | None = None

        def shutting_down() -> bool:
            """Return whether ordinary shutdown or a monitor abort forbids any write.

            An orderly shutdown still owns a valid lease, so the store fence cannot
            catch it; every worker-originated event and terminal write must
            therefore consult this gate and leave the eventual `worker_lost`
            transition to maintenance. The observed-cancellation settle path is
            deliberately exempt and finalizes via `complete_cancellation`.
            """
            return self._stop.is_set() or monitor_stop.is_set()

        try:
            content = self._controller.get_input(job.id)

            def publish(event_type: str, data: dict, score: int | None) -> None:
                """Persist one runner event and its score while no abort is in effect.

                The executor drains a buffered child event ahead of an abort, so a
                shutdown or monitor abort must drop it here rather than persist
                progress the terminal write will not follow. The shutdown check and
                the controller write share `_shutdown_lock` so `stop()` cannot slip
                in between them.
                """
                with self._shutdown_lock:
                    if shutting_down():
                        return
                    if score is None:
                        self._controller.record_event(job.id, event_type, data, worker_id=self._worker_id)
                    else:
                        self._controller.record_score_and_event(job.id, score, data, worker_id=self._worker_id)

            def watch_controls() -> None:
                """Poll cancellation, finish-now, and ownership controls for the child.

                A cancellation observed while this worker still owns the claim wins:
                it stops the watcher without setting `monitor_stop`, so the child is
                cancelled and settled rather than silently aborted. Terminal state,
                lost ownership, or an expired claim set `monitor_stop`, aborting the
                child without writing a result.
                """
                stop_check_error_logged = False
                while not monitor_stop.is_set():
                    try:
                        if self._controller.is_stop_requested(job.id, self._worker_id):
                            current = self._controller.get_job(job.id)
                            if current.state.terminal or current.worker_id != self._worker_id:
                                monitor_stop.set()
                                return
                            if current.cancel_requested:
                                cancellation_requested.set()
                                return
                            elif current.early_completion_requested:
                                finish_now_requested.set()
                            else:
                                monitor_stop.set()
                                return
                        stop_check_error_logged = False
                    except JobNotFoundError:
                        monitor_stop.set()
                        return
                    except Exception:
                        # Claim renewal logs store outages and keeps retrying; do
                        # not spam the log for the same ongoing outage here.
                        if not stop_check_error_logged:
                            server_logger.exception("[server:worker] failed to check stop request job_id=%s", job.id)
                            stop_check_error_logged = True
                    monitor_stop.wait(CONTROL_POLL_SECONDS)

            control_thread = threading.Thread(
                target=watch_controls,
                name=f"optimization-job-control-{job.id}",
                daemon=True,
            )
            control_thread.start()
            finish_now_supported = solver_supports_stop(job.request.solver)

            def process_control() -> ProcessControl | None:
                """Return the highest-priority control for the optimization child.

                Claim loss aborts ahead of every other control. A cancellation
                observed under a valid claim beats an ordinary worker shutdown.
                """
                if monitor_stop.is_set():
                    return ProcessControl.ABORT
                if cancellation_requested.is_set():
                    return ProcessControl.CANCEL
                if self._stop.is_set():
                    return ProcessControl.ABORT
                if finish_now_supported and finish_now_requested.is_set():
                    return ProcessControl.FINISH
                return None

            process_result = run_optimization_process(
                self._runner,
                job,
                content,
                event_callback=publish,
                control=process_control,
                hard_timeout_seconds=job.request.timeout_seconds + self._timeout_grace_seconds,
                finish_now_enabled=finish_now_supported,
            )
            if process_result.status is ProcessStatus.COMPLETED:
                if process_result.output is None:
                    raise RuntimeError("Completed optimization process has no output")
                # A buffered completion the executor returned ahead of an abort must
                # not be persisted once shutdown or claim loss is in effect. The
                # check and the commit are held together so shutdown cannot land
                # between them over a still-valid lease.
                with self._shutdown_lock:
                    if shutting_down():
                        server_logger.info(
                            "[server:worker] discarded buffered completion during shutdown job_id=%s worker_id=%s",
                            job.id,
                            self._worker_id,
                        )
                    else:
                        self._controller.complete_job(
                            job.id,
                            process_result.output.result,
                            process_result.output.artifact,
                            worker_id=self._worker_id,
                        )
            elif process_result.status is ProcessStatus.FAILED:
                if process_result.failure is None:
                    raise RuntimeError("Failed optimization process has no failure")
                with self._shutdown_lock:
                    if shutting_down():
                        server_logger.info(
                            "[server:worker] discarded buffered failure during shutdown job_id=%s worker_id=%s",
                            job.id,
                            self._worker_id,
                        )
                    else:
                        self._controller.fail_job(job.id, process_result.failure, worker_id=self._worker_id)
            elif process_result.status is ProcessStatus.CANCELLED:
                # Cancellation observed under a valid claim beats a later ordinary
                # shutdown; it settles through the lease-fenced complete_cancellation.
                self._controller.complete_cancellation(job.id, worker_id=self._worker_id)
            elif process_result.status is ProcessStatus.ABORTED:
                server_logger.info(
                    "[server:worker] aborted child execution without writing job_id=%s worker_id=%s",
                    job.id,
                    self._worker_id,
                )
            else:
                raise RuntimeError(f"Unknown optimization process status: {process_result.status}")
        except JobNotFoundError:
            server_logger.warning("[server:worker] job disappeared while running job_id=%s", job.id)
        except Exception as error:
            # A cancellation already observed under a valid claim beats a later
            # ordinary shutdown even when executor cleanup raises: settle it through
            # the lease-fenced complete_cancellation rather than suppressing it. Only
            # a monitor abort / claim loss (which the store fence would reject anyway)
            # forfeits this to maintenance.
            if cancellation_requested.is_set() and not monitor_stop.is_set():
                self._controller.complete_cancellation(job.id, worker_id=self._worker_id)
                server_logger.info(
                    "[server:worker] cancelled-after-cleanup-exception job_id=%s exception_type=%s error=%s worker_id=%s",
                    job.id,
                    type(error).__name__,
                    str(error),
                    self._worker_id,
                    exc_info=(type(error), error, error.__traceback__),
                )
                return
            # Otherwise an abort-path cleanup error raised during ordinary shutdown or
            # a monitor abort must not persist a failure over a still-valid lease;
            # maintenance owns the eventual worker_lost transition. The shutdown check
            # and the failure commit share `_shutdown_lock` so stop() cannot land
            # between them.
            with self._shutdown_lock:
                if shutting_down():
                    server_logger.info(
                        "[server:worker] suppressed failure persistence during shutdown job_id=%s exception_type=%s worker_id=%s",
                        job.id,
                        type(error).__name__,
                        self._worker_id,
                        exc_info=(type(error), error, error.__traceback__),
                    )
                    return
                failure = JobFailure(code="optimization_failed", message=self._unexpected_error_formatter(error))
                failed = self._controller.fail_job(job.id, failure, worker_id=self._worker_id)
            if failed.state == JobState.CANCELLED:
                server_logger.info(
                    "[server:worker] cancelled-after-exception job_id=%s exception_type=%s error=%s worker_id=%s",
                    job.id,
                    type(error).__name__,
                    str(error),
                    self._worker_id,
                    exc_info=(type(error), error, error.__traceback__),
                )
                return
            server_logger.exception(
                "[server:worker] failed job_id=%s worker_id=%s",
                job.id,
                self._worker_id,
                exc_info=(type(error), error, error.__traceback__),
            )
        finally:
            monitor_stop.set()
            if control_thread is not None:
                control_thread.join(timeout=1)
            heartbeat_thread.join(timeout=1)
