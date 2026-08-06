"""Deterministic roster container: structured day-states plus the exported workbook.

The container is the single stored artifact of a completed job. It carries the
authoritative `on_roster` handoff (ordered index-aligned people/date axes, the
immutable complete `solvedDays` grid, and explicit 1-based worksheet
coordinates) alongside the original XLSX bytes, so the API can serve the
structured roster and a byte-identical workbook download from one artifact.

Everything structural comes from the scheduler callback. This module never
reparses the canonical scenario and never re-derives exporter coordinates.
"""

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
import json
import math
import re
from datetime import date
from typing import Any, NoReturn

from .errors import OptimizationExecutionError, ServerApplicationError

SCHEMA_VERSION = "roster-container/1"
"""Frozen v1 container schema; a consumer rejects any other value."""

CONTAINER_MEDIA_TYPE = "application/json"
"""Media type the container is stored under as the job's single artifact."""

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
"""Media type synthesized for the embedded workbook download."""

MAX_RAW_XLSX_BYTES = 32 * 1024 * 1024
"""Frozen v1 cap (33,554,432 bytes) on the exported workbook before base64."""

MAX_ROSTER_CONTAINER_BYTES = 48 * 1024 * 1024
"""Frozen v1 cap (50,331,648 bytes) on the final encoded container bytes.

This leaves more than 5 MiB beyond the worst-case base64 expansion of a
maximum-size raw workbook for the structured JSON, while staying an order of
magnitude below Redis's 512 MiB bulk ceiling."""

OUTPUT_TOO_LARGE_CODE = "roster_output_too_large"
"""Stable terminal code for either overflow; no artifact is committed."""

INVALID_OUTPUT_CODE = "roster_output_invalid"
"""Stable terminal code for a build whose container fails the v1 contract.

Raised for an internal regression — a malformed scheduler handoff — so it fails
before `RunOutput` exists rather than committing an unusable artifact. The read
side reports the same class of defect as `roster_container_invalid`."""

FALLBACK_XLSX_NAME = "schedule.xlsx"
"""Download filename used when the embedded name sanitizes to nothing."""

MAX_DOWNLOAD_NAME_BYTES = 128
"""Upper bound on the synthesized `Content-Disposition` filename."""

_UNSAFE_NAME_CHARACTERS = re.compile(r"[^A-Za-z0-9._-]")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SOLVED_RUN_STATUSES = frozenset({"OPTIMAL", "FEASIBLE"})
_CONTAINER_FIELDS = (
    "schemaVersion",
    "people",
    "dates",
    "solvedDays",
    "score",
    "solverStatus",
    "coordinateMap",
    "xlsx",
)
_COORDINATE_FIELDS = (
    "peopleRows",
    "dateColumns",
    "firstPeopleRow",
    "leadingCols",
    "historyCols",
    "prettify",
)
_WORKBOOK_FIELDS = ("base64", "name", "mime")


class RosterContainerInvalidError(ServerApplicationError):
    """A stored artifact is not a readable `roster-container/1` document.

    The container is produced by this server, so an unreadable one is a server
    fault: the HTTP adapter maps it to 500 through the default branch.
    """

    code = "roster_container_invalid"


class _ContractViolation(Exception):
    """Internal signal that a document violates the frozen v1 contract.

    One validator serves both directions, so the two callers translate this into
    the error their own surface owns: a terminal execution failure on build, and
    `RosterContainerInvalidError` on read.
    """


def _fail(message: str) -> NoReturn:
    """Reject a document with a specific, locatable reason."""
    raise _ContractViolation(message)


def _reject_json_constant(name: str) -> NoReturn:
    """Reject the non-standard JSON constants Python would otherwise accept."""
    _fail(f"The roster container uses the non-standard JSON constant {name}")


def _is_scalar_id(value: Any) -> bool:
    """Return whether a value is a usable person or shift id.

    Ids are authored as a number or a string and preserved with that type; a
    boolean is neither, and a non-finite number cannot survive strict JSON.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    return isinstance(value, str) and value != ""


def _is_index(value: Any, *, minimum: int) -> bool:
    """Return whether a value is an integer coordinate at or above `minimum`."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _validate_exact_fields(value: Any, expected: tuple[str, ...], label: str) -> None:
    """Require an object carrying exactly the frozen field set."""
    if not isinstance(value, dict):
        _fail(f"{label} is not an object")
    missing = sorted(set(expected) - set(value))
    unexpected = sorted(set(value) - set(expected))
    if missing:
        _fail(f"{label} is missing the required fields {missing}")
    if unexpected:
        _fail(f"{label} carries the unexpected fields {unexpected}")


def _validate_day_state(day: Any, person_index: int, date_index: int) -> None:
    """Require one exact day-state union member.

    A worked day carries exactly one scalar `shiftId`: the solver's exclusivity
    constraint guarantees one state per cell, so a list is a contract violation.
    """
    label = f"solvedDays[{person_index}][{date_index}]"
    if not isinstance(day, dict):
        _fail(f"{label} is not an object")
    kind = day.get("kind")
    if kind in ("off", "leave"):
        _validate_exact_fields(day, ("kind",), label)
        return
    if kind == "shift":
        _validate_exact_fields(day, ("kind", "shiftId"), label)
        if not _is_scalar_id(day["shiftId"]):
            _fail(f"{label}.shiftId is not a finite number or non-empty string")
        return
    _fail(f"{label}.kind is not one of off, leave, shift: {kind!r}")


def _validate_axis(axis: Any, expected_length: int, start: int, label: str) -> None:
    """Require an ordered 1-based worksheet axis matching the exporter's formula.

    The exporter lays out each axis as one contiguous run of worksheet
    coordinates beginning at `start`, so every entry must equal `start + index`.
    Checking the exact formula — not just strict increase — rejects a later gap
    the exporter itself could never produce, such as `[3, 5]` for two rows.
    """
    if not isinstance(axis, list):
        _fail(f"{label} is not an array")
    if len(axis) != expected_length:
        _fail(f"{label} has {len(axis)} entries for {expected_length} records")
    for index, value in enumerate(axis):
        if not _is_index(value, minimum=1):
            _fail(f"{label}[{index}] is not a 1-based worksheet index")
        expected = start + index
        if value != expected:
            _fail(f"{label}[{index}] is {value}, not the contiguous coordinate {expected}")


def _validate_coordinate_map(coordinate_map: Any, people_count: int, dates_count: int) -> None:
    """Require complete, internally consistent coordinate metadata."""
    _validate_exact_fields(coordinate_map, _COORDINATE_FIELDS, "coordinateMap")
    for field, minimum in (("firstPeopleRow", 1), ("leadingCols", 0), ("historyCols", 0)):
        if not _is_index(coordinate_map[field], minimum=minimum):
            _fail(f"coordinateMap.{field} is not an integer of at least {minimum}")
    if not isinstance(coordinate_map["prettify"], bool):
        _fail("coordinateMap.prettify is not a boolean")
    if not coordinate_map["prettify"] and coordinate_map["historyCols"] != 0:
        _fail("coordinateMap.historyCols is non-zero without prettify")

    expected_first_column = coordinate_map["leadingCols"] + coordinate_map["historyCols"] + 1
    _validate_axis(
        coordinate_map["peopleRows"], people_count, coordinate_map["firstPeopleRow"], "coordinateMap.peopleRows"
    )
    _validate_axis(coordinate_map["dateColumns"], dates_count, expected_first_column, "coordinateMap.dateColumns")


def _validate_workbook(workbook: Any) -> None:
    """Require complete workbook metadata and a strictly decodable payload."""
    _validate_exact_fields(workbook, _WORKBOOK_FIELDS, "xlsx")
    encoded = workbook["base64"]
    if not isinstance(encoded, str):
        _fail("xlsx.base64 is not a string")
    try:
        base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        _fail("xlsx.base64 is not strict base64")
    name = workbook["name"]
    if not isinstance(name, str) or not name.endswith(".xlsx"):
        _fail("xlsx.name is not an .xlsx filename")
    if workbook["mime"] != XLSX_MEDIA_TYPE:
        _fail("xlsx.mime is not the workbook media type")


def _validate_container(container: Any) -> None:
    """Fail closed unless a document satisfies the whole `roster-container/1` contract.

    Shared by build and read so one definition governs both: a malformed
    scheduler handoff can never be stored, and a malformed stored artifact can
    never be served.
    """
    _validate_exact_fields(container, _CONTAINER_FIELDS, "The roster container")
    if container["schemaVersion"] != SCHEMA_VERSION:
        _fail(f"Unsupported roster container schema version: {container['schemaVersion']!r}")

    people = container["people"]
    if not isinstance(people, list):
        _fail("people is not an array")
    for index, person in enumerate(people):
        _validate_exact_fields(person, ("id",), f"people[{index}]")
        if not _is_scalar_id(person["id"]):
            _fail(f"people[{index}].id is not a finite number or non-empty string")

    dates = container["dates"]
    if not isinstance(dates, list):
        _fail("dates is not an array")
    for index, date_record in enumerate(dates):
        _validate_exact_fields(date_record, ("iso",), f"dates[{index}]")
        iso = date_record["iso"]
        if not isinstance(iso, str) or not _ISO_DATE.match(iso):
            _fail(f"dates[{index}].iso is not an ISO calendar date: {iso!r}")
        try:
            date.fromisoformat(iso)
        except ValueError:
            _fail(f"dates[{index}].iso is not a real calendar date: {iso!r}")

    solved_days = container["solvedDays"]
    if not isinstance(solved_days, list):
        _fail("solvedDays is not an array")
    if len(solved_days) != len(people):
        _fail(f"solvedDays has {len(solved_days)} rows for {len(people)} people")
    for person_index, person_days in enumerate(solved_days):
        if not isinstance(person_days, list):
            _fail(f"solvedDays[{person_index}] is not an array")
        if len(person_days) != len(dates):
            _fail(f"solvedDays[{person_index}] has {len(person_days)} cells for {len(dates)} dates")
        for date_index, day in enumerate(person_days):
            _validate_day_state(day, person_index, date_index)

    score = container["score"]
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
        _fail("score is not a finite number")
    if container["solverStatus"] not in _SOLVED_RUN_STATUSES:
        _fail(f"solverStatus is not a solved-run status: {container['solverStatus']!r}")

    _validate_coordinate_map(container["coordinateMap"], len(people), len(dates))
    _validate_workbook(container["xlsx"])


def _encode_deterministic_json(container: dict[str, Any]) -> bytes:
    """Encode a container as deterministic UTF-8 JSON bytes.

    Object keys are sorted and insignificant whitespace is dropped, so the same
    logical container always produces the same bytes. Array order — the people,
    date, and coordinate axes — is preserved exactly as the scheduler emitted it.
    """
    return json.dumps(
        container,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def build_roster_container(
    roster_payload: dict[str, Any],
    *,
    xlsx_bytes: bytes,
    xlsx_name: str,
    xlsx_mime: str,
    score: int | None,
    solver_status: str,
    max_raw_xlsx_bytes: int | None = None,
    max_container_bytes: int | None = None,
) -> bytes:
    """Build the deterministic container bytes for one completed run.

    `roster_payload` is the scheduler's `on_roster` handoff, used verbatim: its
    ordered `people` / `dates` records, complete single-state `solvedDays` grid,
    and explicit 1-based `coordinateMap` are index-aligned by construction.

    The raw workbook is checked before base64 and the final encoded document is
    checked before the bytes are returned, so an oversized run fails here rather
    than crossing the child result pipe or reaching a store commit. Both limits
    are injectable for boundary tests only; production always uses the frozen
    module constants.

    The assembled container is validated against the same shared contract the
    read path enforces, so a malformed handoff fails before any output exists
    instead of being committed as a completed job.

    Raises:
        OptimizationExecutionError: If either size cap is exceeded, or the
            assembled container violates the `roster-container/1` contract.
    """
    raw_limit = MAX_RAW_XLSX_BYTES if max_raw_xlsx_bytes is None else max_raw_xlsx_bytes
    encoded_limit = MAX_ROSTER_CONTAINER_BYTES if max_container_bytes is None else max_container_bytes

    if len(xlsx_bytes) > raw_limit:
        raise OptimizationExecutionError(
            OUTPUT_TOO_LARGE_CODE,
            f"The exported schedule is {len(xlsx_bytes)} bytes, above the {raw_limit}-byte limit",
        )

    if not isinstance(roster_payload, dict):
        raise OptimizationExecutionError(INVALID_OUTPUT_CODE, "The roster handoff is not a structured payload")
    missing = sorted({"people", "dates", "solvedDays", "coordinateMap"} - set(roster_payload))
    if missing:
        raise OptimizationExecutionError(
            INVALID_OUTPUT_CODE,
            f"The roster handoff is missing the required fields {missing}",
        )

    container = {
        "schemaVersion": SCHEMA_VERSION,
        "people": roster_payload["people"],
        "dates": roster_payload["dates"],
        "solvedDays": roster_payload["solvedDays"],
        "score": score,
        "solverStatus": solver_status,
        "coordinateMap": roster_payload["coordinateMap"],
        "xlsx": {
            "base64": base64.b64encode(xlsx_bytes).decode("ascii"),
            "name": xlsx_name,
            "mime": xlsx_mime,
        },
    }
    try:
        _validate_container(container)
    except _ContractViolation as error:
        raise OptimizationExecutionError(
            INVALID_OUTPUT_CODE,
            f"The roster container failed its contract: {error}",
        ) from error

    encoded = _encode_deterministic_json(container)
    if len(encoded) > encoded_limit:
        raise OptimizationExecutionError(
            OUTPUT_TOO_LARGE_CODE,
            f"The roster container is {len(encoded)} bytes, above the {encoded_limit}-byte limit",
        )
    return encoded


def parse_roster_container(content: bytes) -> dict[str, Any]:
    """Parse stored container bytes, failing closed on anything unreadable.

    Parsing is strict standard JSON — Python's `NaN` / `Infinity` extensions are
    rejected — and the decoded document must satisfy the whole v1 contract before
    any route can serve it, so `/roster` and `/xlsx` fail together.

    Raises:
        RosterContainerInvalidError: If the bytes are not a valid
            `roster-container/1` document.
    """
    try:
        container = json.loads(content.decode("utf-8"), parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RosterContainerInvalidError("The stored roster container is not valid UTF-8 JSON") from error
    except _ContractViolation as error:
        raise RosterContainerInvalidError(str(error)) from error
    try:
        _validate_container(container)
    except _ContractViolation as error:
        raise RosterContainerInvalidError(str(error)) from error
    return container


def decode_workbook(container: dict[str, Any]) -> bytes:
    """Decode the embedded workbook back to its exact exported bytes.

    Raises:
        RosterContainerInvalidError: If the embedded payload is not valid base64.
    """
    try:
        return base64.b64decode(container["xlsx"]["base64"], validate=True)
    except (binascii.Error, ValueError) as error:
        raise RosterContainerInvalidError("The embedded workbook is not valid base64") from error


def workbook_download_name(container: dict[str, Any]) -> str:
    """Synthesize a safe `Content-Disposition` filename for the workbook.

    The stored name is server-generated, but the download header is synthesized
    rather than echoed: path segments, quotes, and control characters cannot
    reach the response, and an empty result falls back to a fixed name.
    """
    stored = container["xlsx"].get("name")
    if not isinstance(stored, str):
        return FALLBACK_XLSX_NAME
    basename = stored.replace("\\", "/").rsplit("/", 1)[-1]
    sanitized = _UNSAFE_NAME_CHARACTERS.sub("_", basename).lstrip(".")[:MAX_DOWNLOAD_NAME_BYTES]
    return sanitized or FALLBACK_XLSX_NAME


def workbook_media_type(container: dict[str, Any]) -> str:
    """Return the synthesized media type for the workbook download.

    This endpoint only ever serves a workbook, so the stored value is confirmed
    against the one expected type rather than echoed: no stored string can
    change how a browser interprets the response.
    """
    stored = container["xlsx"].get("mime")
    return stored if stored == XLSX_MEDIA_TYPE else XLSX_MEDIA_TYPE


def roster_view(container: dict[str, Any]) -> dict[str, Any]:
    """Return the container with only the embedded workbook bytes removed.

    The workbook's `name` and `mime` stay, so a client knows what the download
    endpoint will serve without carrying the bytes twice.
    """
    workbook = {key: value for key, value in container["xlsx"].items() if key != "base64"}
    return {**container, "xlsx": workbook}
