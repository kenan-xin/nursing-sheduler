"""Adapter from a job request to the synchronous scheduler and XLSX exporter."""

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

from collections.abc import Callable
from dataclasses import dataclass
from datetime import timezone
from io import BytesIO
from typing import Any

from ... import exporter, scheduler
from ...solver_interface import (
    SchedulePhaseProgress,
    ScheduleProgress,
    serialize_schedule_phase_progress,
    serialize_solver_progress,
)
from ..errors import OptimizationExecutionError
from ..roster_container import CONTAINER_MEDIA_TYPE, XLSX_MEDIA_TYPE, build_roster_container
from .models import Job, OptimizationOutcome, OptimizationResult, StoredArtifact


EventCallback = Callable[[str, dict[str, Any], int | None], None]
StopCallback = Callable[[], bool]


@dataclass(frozen=True)
class RunOutput:
    """Normalized result and optional artifact produced by one execution."""

    result: OptimizationResult
    """Normalized result for a completed scheduling run."""
    artifact: StoredArtifact | None
    """Generated roster container artifact, absent when no schedule exists."""


class OptimizationRunner:
    """Run the scheduling engine without knowing job persistence or HTTP."""

    def run(
        self,
        job: Job,
        input_bytes: bytes,
        *,
        event_callback: EventCallback,
        should_stop: StopCallback | None,
    ) -> RunOutput:
        """Run the scheduler, export the schedule, and build the roster container.

        Progress and phase changes are forwarded through `event_callback`. The
        single stored artifact is the deterministic roster container, which
        embeds the exported workbook bytes alongside the scheduler's structured
        day-state handoff.

        Raises:
            OptimizationExecutionError: If the model is invalid, no normal result
                is produced, no roster handoff arrives with a schedule, or the
                output exceeds a frozen size cap.
        """
        roster_payloads: list[dict[str, Any]] = []

        def publish_progress(payload: ScheduleProgress) -> None:
            """Normalize scheduler progress into job-domain events."""
            if isinstance(payload, SchedulePhaseProgress):
                event_callback("job.phase_changed", serialize_schedule_phase_progress(payload), None)
                return
            data = serialize_solver_progress(payload, include_export_summary=True)
            event_callback("job.progressed", data, payload.currentBestScore)

        # The rebuild scheduler is CP-SAT only: it takes no solver selector and
        # returns a positional tuple rather than an object. `job.request.solver`
        # is the constant diagnostic value "ortools/cp-sat" and is not forwarded.
        #
        # `prettify` is optional on the request, and every scheduler/exporter use
        # is a truthiness test, so an absent preference already behaved as False.
        # Normalizing it here keeps the container's typed `prettify` honest
        # without changing solve or export behavior.
        dataframe, _solution, score, solver_status, cell_export_info = scheduler.schedule(
            file_content=input_bytes,
            prettify=bool(job.request.prettify),
            timeout=job.request.timeout_seconds,
            progress_callback=publish_progress,
            should_stop=should_stop,
            on_roster=roster_payloads.append,
        )
        stop_requested_when_solver_returned = should_stop is not None and should_stop()

        normalized_status = str(solver_status)
        if normalized_status == "INFEASIBLE":
            return RunOutput(
                result=OptimizationResult(
                    outcome=OptimizationOutcome.INFEASIBLE,
                    score=None,
                    solver_status=normalized_status,
                    termination_reason="infeasibility_proven",
                ),
                artifact=None,
            )
        if normalized_status == "MODEL_INVALID":
            raise OptimizationExecutionError("invalid_model", "The generated solver model is invalid")
        if normalized_status not in {"OPTIMAL", "FEASIBLE"} or dataframe is None:
            raise OptimizationExecutionError(
                "no_solution_found",
                f"No schedule was produced. Solver status: {normalized_status}",
            )

        # The callback fires exactly once on the OPTIMAL/FEASIBLE path, so a
        # schedule without a handoff means the authoritative structured source
        # is missing; it is not silently reconstructed from the dataframe.
        if len(roster_payloads) != 1:
            raise OptimizationExecutionError(
                "roster_handoff_missing",
                f"A schedule was produced with {len(roster_payloads)} roster handoffs instead of exactly one",
            )

        output_buffer = BytesIO()
        exporter.export_to_excel(dataframe, output_buffer, cell_export_info)
        created_at = job.created_at.astimezone(timezone.utc)
        output_filename = f"nurse-scheduling-{created_at:%Y%m%dT%H%M%SZ}.xlsx"
        outcome = OptimizationOutcome.OPTIMAL if normalized_status == "OPTIMAL" else OptimizationOutcome.FEASIBLE
        # A feasible-but-not-optimal result is classified by why the solver
        # stopped: a cooperative finish-now request (`user_requested`) or the
        # native timeout expiring (`solver_timeout`).
        if outcome == OptimizationOutcome.OPTIMAL:
            termination_reason = "optimality_proven"
        elif stop_requested_when_solver_returned:
            termination_reason = "user_requested"
        else:
            termination_reason = "solver_timeout"
        # Both size caps are enforced inside the builder, before `RunOutput`
        # exists, so oversized output never crosses the child result pipe and no
        # artifact is committed.
        container_bytes = build_roster_container(
            roster_payloads[0],
            xlsx_bytes=output_buffer.getvalue(),
            xlsx_name=output_filename,
            xlsx_mime=XLSX_MEDIA_TYPE,
            score=score,
            solver_status=normalized_status,
        )
        return RunOutput(
            result=OptimizationResult(
                outcome=outcome,
                score=score,
                solver_status=normalized_status,
                termination_reason=termination_reason,
            ),
            artifact=StoredArtifact(
                name=f"nurse-scheduling-{created_at:%Y%m%dT%H%M%SZ}.roster.json",
                media_type=CONTAINER_MEDIA_TYPE,
                content=container_bytes,
            ),
        )
