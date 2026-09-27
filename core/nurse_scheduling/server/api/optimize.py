"""HTTP routes for creating and controlling optimization jobs."""

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

from dataclasses import replace
from datetime import datetime, timezone
from io import BytesIO
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from ruamel.yaml.error import YAMLError
from starlette.concurrency import run_in_threadpool

from ...loader import SchedulingDataTooComplexError, measure_yaml_expansion
from ..auth import create_stream_token
from ..basis_admission import BasisClaim, verify_basis_claim
from ..config import ServerSettings
from ..event_cursor import EventCursorExpired, EventCursorInvalid, encode_cursor
from ..jobs.controller import JobController
from ..jobs.models import JobEvent, JobPurpose, JobState
from ..roster_container import (
    decode_workbook,
    parse_roster_container,
    roster_view,
    workbook_download_name,
    workbook_media_type,
)
from ..scheduling_input import (
    CODE_SCHEDULING_DATA_TOO_COMPLEX,
    MalformedInputError,
    canonicalize_submission,
    parse_solver,
)
from ..solver_capabilities import solver_supports_finish_now
from ..solver_options import normalize_solver_option
from .schemas import JobResponse, OptimizationOptionsResponse
from .sse import format_sse_event

router = APIRouter()
# The event stream authorizes through a URL token as well, so it carries its own dependency.
events_router = APIRouter()
CLIENT_ID_COOKIE_NAME = "nurse_scheduling_client_id"
"""Cookie used to correlate jobs from the same browser for diagnostics."""
CLIENT_ID_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
"""Seven-day correlation lifetime; the cookie does not control job liveness."""


def _controller(request: Request) -> JobController:
    """Return the application-scoped job controller."""
    return request.app.state.job_controller


def _events_token(request: Request, job_id: str) -> str | None:
    """Mint the stream credential embedded in a job's events link, when authentication is on."""
    registry = request.app.state.auth_registry
    if not registry.enabled:
        return None
    credential_id = request.state.auth_credential_id
    credential = registry.get(credential_id)
    if credential is None:
        raise RuntimeError("authenticated request has no matching credential")
    return create_stream_token(
        credential.token,
        job_id,
        ttl_seconds=_settings(request).stream_token_ttl_seconds,
    )


def _settings(request: Request) -> ServerSettings:
    """Return the validated application-scoped server settings."""
    return request.app.state.settings


async def _read_input(
    file: UploadFile | None,
    yaml_content: str | None,
    max_bytes: int,
) -> tuple[bytes, str]:
    """Read exactly one YAML input source and enforce its byte limit.

    Raises:
        HTTPException: If the source selection, extension, or size is invalid.
    """
    if file is None and yaml_content is None:
        raise HTTPException(status_code=400, detail="Either 'file' or 'yaml_content' must be provided")
    if file is not None and yaml_content is not None:
        raise HTTPException(status_code=400, detail="Provide either 'file' or 'yaml_content', not both")
    if file is not None:
        filename = file.filename or "schedule.yaml"
        if not filename.lower().endswith((".yaml", ".yml")):
            raise HTTPException(status_code=400, detail="The uploaded file must be YAML")
        content = await file.read(max_bytes + 1)
        input_name = filename
    else:
        assert yaml_content is not None
        content = yaml_content.encode("utf-8")
        input_name = f"nurse-scheduling-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}.yaml"
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail="Scheduling YAML is too large")
    return content, input_name


def _client_id(request: Request, response: Response) -> str:
    """Return a valid client cookie ID, creating a replacement when needed."""
    raw_client_id = request.cookies.get(CLIENT_ID_COOKIE_NAME)
    try:
        client_id = UUID(raw_client_id).hex if raw_client_id is not None else None
    except ValueError:
        client_id = None
    if client_id is None:
        client_id = uuid4().hex
        response.set_cookie(
            key=CLIENT_ID_COOKIE_NAME,
            value=client_id,
            max_age=CLIENT_ID_COOKIE_MAX_AGE_SECONDS,
            httponly=True,
            samesite="lax",
            # A TLS-terminating proxy forwards plain HTTP, so the scheme alone cannot
            # tell whether the browser reached this deployment over HTTPS.
            secure=_settings(request).cookie_secure or request.url.scheme == "https",
            path="/",
        )
    return client_id


@router.post("/optimize", status_code=202, response_model=JobResponse)
async def create_job(
    request: Request,
    response: Response,
    file: UploadFile | None = File(None, description="YAML file with scheduling data"),  # noqa: B008
    yaml_content: str | None = Form(None, description="YAML content as a string"),
    prettify: bool | None = Form(None),
    timeout: int | None = Form(None),
    solver: str | None = Form(None, description="Solver value returned by GET /optimize/options"),
    purpose: str = Form(
        JobPurpose.ORDINARY.value,
        description="Job purpose deciding queue priority and admission (T09).",
    ),
    basis_id: str | None = Form(None, description="Claimed OptimizeBasisV2 identity (T08)."),
    input_sha256: str | None = Form(None, description="Claimed SHA-256 of the exact submitted bytes."),
    submission_contract_version: str | None = Form(None),
    workspace_schema_version: str | None = Form(None),
    serializer_version: str | None = Form(None),
    anonymization_mode: str | None = Form(None, description="Which anonymization transform produced the bytes."),
    expected_solver_semantic_version: str | None = Form(None),
    expected_backend_capability_version: str | None = Form(None),
    parent_basis_id: str | None = Form(None, description="Ordinary parent basis a candidate derives from."),
    transform_digest: str | None = Form(None, description="Digest of the validated transform for a candidate."),
):
    """Validate an optimization request and enqueue a durable job."""
    settings = _settings(request)
    content, input_name = await _read_input(file, yaml_content, settings.max_yaml_bytes)
    # v2: the product is CP-SAT only (X4); a 422 unsupported_solver even if OPTIMIZE_SOLVERS widens.
    parse_solver(solver if solver is not None else settings.default_solver)
    try:
        normalized_solver = normalize_solver_option(solver if solver is not None else settings.default_solver)
    except ValueError:
        normalized_solver = ""
    if normalized_solver not in settings.solver_ids:
        choices = ", ".join(settings.solver_ids)
        raise HTTPException(status_code=400, detail=f"Solver must be one of: {choices}")
    timeout_seconds = timeout if timeout is not None else settings.default_timeout_seconds
    if timeout_seconds < settings.min_timeout_seconds or timeout_seconds > settings.max_timeout_seconds:
        # Clients discover this range from GET /optimize/options, so exceeding it is reported.
        request.state.invalid_reason = "timeout_out_of_range"
        raise HTTPException(
            status_code=400,
            detail=(
                "Optimization timeout must be between "
                f"{settings.min_timeout_seconds} and {settings.max_timeout_seconds} seconds"
            ),
        )
    try:
        # Read only once the free checks above have passed, so a request that was going to be
        # rejected never pays for it, and off the event loop because the data is untrusted.
        await run_in_threadpool(measure_yaml_expansion, content)
    except SchedulingDataTooComplexError as error:
        request.state.invalid_reason = "yaml_expansion_bomb"
        return JSONResponse(
            status_code=400,
            content={"error": {"code": CODE_SCHEDULING_DATA_TOO_COMPLEX, "message": str(error)}},
        )
    except YAMLError:
        # The optimization reports the parse error usefully, so the request is still accepted.
        pass
    # Validated BEFORE the job exists, like every other admission check, so an
    # unrecognized purpose is a request error rather than a job silently admitted
    # as ordinary and given capacity a diagnostic was never entitled to.
    try:
        job_purpose = JobPurpose(purpose.strip().lower())
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Unsupported job purpose") from error
    try:
        canonical_bytes = await run_in_threadpool(canonicalize_submission, content)
    except MalformedInputError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    # Verified against `content` — the EXACT bytes the client sent — not against
    # `canonical_bytes`. The client's evidence is bound to what it submitted; the
    # canonical form is an internal execution detail it never digested.
    verified_basis = verify_basis_claim(
        BasisClaim(
            basis_id=basis_id,
            input_sha256=input_sha256,
            submission_contract_version=submission_contract_version,
            workspace_schema_version=workspace_schema_version,
            serializer_version=serializer_version,
            anonymization_mode=anonymization_mode,
            expected_solver_semantic_version=expected_solver_semantic_version,
            expected_backend_capability_version=expected_backend_capability_version,
            parent_basis_id=parent_basis_id,
            transform_digest=transform_digest,
        ),
        received_bytes=content,
        resolved_solver=normalized_solver,
        resolved_prettify=prettify if prettify is not None else settings.default_prettify,
        resolved_timeout_seconds=timeout_seconds,
    )
    # Unlike the synchronous endpoints below, create_job must remain async for
    # upload reading. Offload its synchronous controller/store write so it cannot
    # block the ASGI event loop.
    job = await run_in_threadpool(
        _controller(request).create_job,
        input_name=input_name,
        client_id=_client_id(request, response),
        solver=normalized_solver,
        prettify=prettify if prettify is not None else settings.default_prettify,
        timeout_seconds=timeout_seconds,
        input_bytes=canonical_bytes,
        basis=verified_basis,
        purpose=job_purpose,
        auth_credential_id=request.state.auth_credential_id,
    )
    response.headers["Location"] = f"/optimize/{job.id}"
    response.headers["Retry-After"] = "1"
    return JobResponse.from_job(job, _events_token(request, job.id))


@router.get("/optimize/options", response_model=OptimizationOptionsResponse)
def get_optimization_options(request: Request, response: Response):
    """Return the run options advertised and enforced by this deployment."""
    response.headers["Cache-Control"] = "no-store"
    return OptimizationOptionsResponse.from_settings(_settings(request))


@router.get("/optimize/{job_id}", response_model=JobResponse)
def get_job(request: Request, job_id: str):
    """Return the current job representation."""
    job = _controller(request).get_job(job_id)
    return JobResponse.from_job(job, _events_token(request, job_id))


def _enrich_state_event(controller: JobController, job_id: str, event: JobEvent) -> JobEvent:
    """Attach terminal and control flags to a state-changed event from current job state."""
    if event.type != "job.state_changed":
        return event
    job = controller.get_job(job_id)
    event_state = JobState(str(event.data["state"]))
    supports_finish_now = solver_supports_finish_now(job.request.solver)
    cancel_requested = bool(event.data.get("cancel_requested", False))
    early_completion_requested = bool(event.data.get("early_completion_requested", False))
    return replace(
        event,
        data={
            **event.data,
            "terminal": event_state.terminal,
            "controls": {
                "cancellable": not event_state.terminal and not cancel_requested,
                "early_completion_available": event_state == JobState.RUNNING
                and supports_finish_now
                and not early_completion_requested,
            },
        },
    )


@events_router.get("/optimize/{job_id}/events")
def stream_events(request: Request, job_id: str, last_event_id: str | None = Header(None)):
    """Replay and stream job events after the client's last event cursor.

    The raw `Last-Event-ID` never reaches the streaming loop: the store validates
    and snapshots the replay window first, returning normative pre-stream errors
    for expired or invalid cursors. Every emitted `id` is the opaque job-bound
    cursor. Disconnecting closes only this response stream; the durable job continues.
    """
    controller = _controller(request)
    controller.get_job(job_id)
    requested_cursor = last_event_id or None
    try:
        window = controller.prepare_event_replay(job_id, requested_cursor)
    except EventCursorExpired as expired:
        return JSONResponse(
            status_code=409,
            content={
                "error": {
                    "code": "event_cursor_expired",
                    "message": "Requested event history is no longer retained.",
                    "oldest_event_id": expired.oldest_public_cursor,
                }
            },
        )
    except EventCursorInvalid:
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "invalid_event_cursor",
                    "message": "Last-Event-ID is not valid for this job.",
                }
            },
        )

    def to_frame(event: JobEvent) -> str:
        """Enrich, encode the public cursor, and serialize one event as an SSE frame."""
        enriched = _enrich_state_event(controller, job_id, event)
        if enriched.id is not None:
            enriched = replace(enriched, id=encode_cursor(job_id, enriched.id))
        return format_sse_event(enriched)

    def generate():
        """Yield the prepared replay batch, then live frames until the job is terminal."""
        for event in window.initial_events:
            yield to_frame(event)
        for event in controller.stream_events(
            job_id,
            after_id=window.next_cursor,
            keepalive_seconds=_settings(request).sse_keepalive_seconds,
        ):
            if event is None:
                yield ": keepalive\n\n"
                continue
            yield to_frame(event)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/optimize/{job_id}/cancel", status_code=202, response_model=JobResponse)
def cancel_job(request: Request, job_id: str):
    """Cancel a queued job or request cancellation of a running job."""
    job = _controller(request).cancel_job(job_id)
    return JobResponse.from_job(job, _events_token(request, job_id))


@router.post("/optimize/{job_id}/finish-now", status_code=202, response_model=JobResponse)
def finish_job_now(request: Request, job_id: str):
    """Ask a supported running solver to return its current result."""
    job = _controller(request).request_early_completion(job_id)
    return JobResponse.from_job(job, _events_token(request, job_id))


def _roster_container(request: Request, job_id: str) -> dict:
    """Load and parse the job's single roster-container artifact.

    Raises:
        JobNotFoundError: If the job does not exist.
        JobArtifactNotReadyError: If the job produced no artifact.
        RosterContainerInvalidError: If the stored artifact is unreadable.
    """
    controller = _controller(request)
    job = controller.get_job(job_id)
    artifact = controller.get_artifact(job_id, job.artifact_name or "roster.json")
    return parse_roster_container(artifact.content)


@router.get("/optimize/{job_id}/xlsx")
def download_xlsx(request: Request, job_id: str):
    """Stream the workbook embedded in a completed job's roster container.

    The bytes are byte-identical to what the exporter produced; the filename and
    media type are synthesized from the container rather than echoed verbatim.
    """
    container = _roster_container(request, job_id)
    filename = workbook_download_name(container)
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(
        BytesIO(decode_workbook(container)),
        media_type=workbook_media_type(container),
        headers=headers,
    )


@router.get("/optimize/{job_id}/roster")
def get_roster(request: Request, job_id: str):
    """Return the structured roster container without the embedded workbook bytes.

    Reached by URL convention: `JobResponse.links` intentionally carries no
    roster field, so the public job schema stays unchanged.
    """
    return JSONResponse(content=roster_view(_roster_container(request, job_id)))


@router.delete("/optimize/{job_id}", status_code=204)
def delete_job(request: Request, job_id: str):
    """Delete a terminal job and all associated retained data."""
    _controller(request).delete_job(job_id)
    return Response(status_code=204)
