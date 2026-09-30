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
from ..roster_container import (
    CONTAINER_MEDIA_TYPE,
    XLSX_MEDIA_TYPE,
    OptimizationExecutionError,
    build_roster_container,
)
from .models import Job, JobFailure, JobPurpose, OptimizationOutcome, OptimizationResult, StoredArtifact

EventCallback = Callable[[str, dict[str, Any], int | None], None]
StopCallback = Callable[[], bool]

INCONCLUSIVE_SOLVER_TIMEOUT = "solver_timeout_no_solution"
"""The native timeout expired before the solver found any schedule or proof."""
INCONCLUSIVE_NO_PROOF = "no_proof"
"""A cooperative stop arrived before the solver reached either proof."""
INCONCLUSIVE_SOLVER_UNKNOWN = "solver_unknown"
"""A terminal solver status outside the known set; no proof either way."""

INCONCLUSIVE_TERMINATION_REASONS = frozenset(
    {INCONCLUSIVE_SOLVER_TIMEOUT, INCONCLUSIVE_NO_PROOF, INCONCLUSIVE_SOLVER_UNKNOWN}
)
"""The closed set of reasons an INCONCLUSIVE result may carry."""


def _inconclusive_reason(solver_status: str, stop_requested: bool) -> str:
    """Classify WHY a terminal run produced no proof, without inventing evidence.

    A stop request that beat the solver to a proof is reported as such rather than
    as a timeout, so the UI can offer a deliberate retry instead of implying the
    budget was too small. A status outside CP-SAT's known terminal set is never
    guessed at — it fails closed to `solver_unknown`.
    """
    if solver_status != "UNKNOWN":
        return INCONCLUSIVE_SOLVER_UNKNOWN
    return INCONCLUSIVE_NO_PROOF if stop_requested else INCONCLUSIVE_SOLVER_TIMEOUT


@dataclass(frozen=True)
class RunOutput:
    """Normalized result and optional artifact produced by one execution."""

    result: OptimizationResult
    """Normalized result for a completed scheduling run."""
    artifact: StoredArtifact | None
    """Generated roster container artifact, absent when no schedule exists."""


RunResult = RunOutput | JobFailure


class OptimizationRunner:
    """Run the scheduling engine without knowing job persistence or HTTP."""

    def run(
        self,
        job: Job,
        input_bytes: bytes,
        *,
        event_callback: EventCallback,
        should_stop: StopCallback | None,
    ) -> RunResult:
        """Run the scheduler, export the schedule, and build the roster container.

        Progress and phase changes are forwarded through `event_callback`. The
        single stored artifact is the deterministic roster container, which
        embeds the exported workbook bytes alongside the scheduler's structured
        day-state handoff. Expected failures are returned as `JobFailure`.
        """
        roster_payloads: list[dict[str, Any]] = []
        # v2 run explanation (penalty ledger, or why there is no roster); ordinary runs only,
        # so diagnostic copies skip the extra solves.
        explanations: list[dict[str, Any]] = []
        explain = job.request.purpose == JobPurpose.ORDINARY

        def publish_progress(payload: ScheduleProgress) -> None:
            """Normalize scheduler progress into job-domain events."""
            if isinstance(payload, SchedulePhaseProgress):
                event_callback("job.phase_changed", serialize_schedule_phase_progress(payload), None)
                return
            data = serialize_solver_progress(payload, include_export_summary=True)
            event_callback("job.progressed", data, payload.currentBestScore)

        schedule_result = scheduler.schedule(
            file_content=input_bytes,
            # An omitted preference must reach the roster handoff as a typed bool.
            prettify=bool(job.request.prettify),
            timeout=job.request.timeout_seconds,
            solver=job.request.solver,
            progress_callback=publish_progress,
            should_stop=should_stop,
            on_roster=roster_payloads.append,
            on_explanation=explanations.append if explain else None,
        )
        stop_requested_when_solver_returned = should_stop is not None and should_stop()

        normalized_status = schedule_result.solver_status
        if normalized_status == "INFEASIBLE":
            return RunOutput(
                result=OptimizationResult(
                    outcome=OptimizationOutcome.INFEASIBLE,
                    score=None,
                    solver_status=normalized_status,
                    termination_reason="infeasibility_proven",
                    explanation=explanations[0] if explanations else None,
                ),
                artifact=None,
            )
        if normalized_status == "MODEL_INVALID":
            return JobFailure(code="invalid_model", message="The generated solver model is invalid")
        if normalized_status not in {"OPTIMAL", "FEASIBLE"}:
            # The solver reached a terminal state without proving either side. That
            # is a NORMAL completion carrying "no proof", not an execution failure
            # (T08): reporting it as FAILED would erase the difference between "we
            # have no answer" and "the run broke", and reporting it as INFEASIBLE
            # would manufacture infeasibility evidence the solver never produced.
            return RunOutput(
                result=OptimizationResult(
                    outcome=OptimizationOutcome.INCONCLUSIVE,
                    score=None,
                    solver_status=normalized_status,
                    termination_reason=_inconclusive_reason(normalized_status, stop_requested_when_solver_returned),
                ),
                artifact=None,
            )
        if schedule_result.dataframe is None:
            return JobFailure(
                code="no_solution_found",
                message=f"No schedule was produced. Solver status: {normalized_status}",
            )
        # The callback fires exactly once on the OPTIMAL/FEASIBLE path, so a
        # schedule without a handoff means the authoritative structured source
        # is missing; it is not silently reconstructed from the dataframe.
        if len(roster_payloads) != 1:
            return JobFailure(
                code="roster_handoff_missing",
                message=f"A schedule was produced with {len(roster_payloads)} roster handoffs instead of exactly one",
            )

        output_buffer = BytesIO()
        exporter.export_to_excel(schedule_result.dataframe, output_buffer, schedule_result.cell_export_info)
        created_at = job.created_at.astimezone(timezone.utc)
        output_filename = f"nurse-scheduling-{created_at:%Y%m%dT%H%M%SZ}.xlsx"
        outcome = OptimizationOutcome.OPTIMAL if normalized_status == "OPTIMAL" else OptimizationOutcome.FEASIBLE
        if outcome == OptimizationOutcome.OPTIMAL:
            termination_reason = "optimality_proven"
        elif stop_requested_when_solver_returned:
            termination_reason = "user_requested"
        else:
            termination_reason = "solver_timeout"
        try:
            container_bytes = build_roster_container(
                roster_payloads[0],
                xlsx_bytes=output_buffer.getvalue(),
                xlsx_name=output_filename,
                xlsx_mime=XLSX_MEDIA_TYPE,
                score=schedule_result.score,
                solver_status=normalized_status,
            )
        except OptimizationExecutionError as error:
            # The caps are enforced before RunOutput exists, so oversized output never
            # crosses the child result pipe and no artifact is committed.
            return JobFailure(code=error.code, message=str(error))
        return RunOutput(
            result=OptimizationResult(
                outcome=outcome,
                score=schedule_result.score,
                solver_status=normalized_status,
                termination_reason=termination_reason,
                explanation=explanations[0] if explanations else None,
            ),
            artifact=StoredArtifact(
                name=f"nurse-scheduling-{created_at:%Y%m%dT%H%M%SZ}.roster.json",
                media_type=CONTAINER_MEDIA_TYPE,
                content=container_bytes,
            ),
        )
