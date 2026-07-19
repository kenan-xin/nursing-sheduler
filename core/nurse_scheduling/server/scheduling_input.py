"""Pre-job submission boundary: parse, validate, convert, and canonicalize input."""

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

from io import BytesIO
from typing import Any

from pydantic import ValidationError
from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from ..models import NurseSchedulingData
from .canonical import dump_canonical_strict_yaml
from .scheduling_errors import (
    CODE_UNSUPPORTED_SOLVER,
    CODE_UNSUPPORTED_WORKSPACE_VERSION,
    ISSUE_UNSUPPORTED_VALUE,
    MESSAGE_UNSUPPORTED_SOLVER,
    SchedulingContentError,
    SchedulingIssue,
    invalid_scheduling_data,
)
from .workspace import convert_workspace_to_strict


# The rebuild server exposes exactly one solver. A missing/default selector maps
# to this value; any other selector is rejected before job creation.
SUPPORTED_SOLVER = "ortools/cp-sat"


class MalformedInputError(Exception):
    """The submitted bytes are not a valid YAML scheduling document.

    The HTTP boundary maps this to a native 400 (`detail`) response, distinct
    from the scheduling-content 422 envelope.
    """


def parse_solver(solver: str) -> str:
    """Return the canonical solver value or raise the normative 422 for others.

    Raises:
        SchedulingContentError: If the solver is not the supported CP-SAT selector.
    """
    if solver == SUPPORTED_SOLVER:
        return SUPPORTED_SOLVER
    raise SchedulingContentError(
        CODE_UNSUPPORTED_SOLVER,
        MESSAGE_UNSUPPORTED_SOLVER,
        [SchedulingIssue(["solver"], ISSUE_UNSUPPORTED_VALUE, MESSAGE_UNSUPPORTED_SOLVER)],
    )


def _parse_once(content: bytes) -> dict[str, Any]:
    """Parse submitted bytes exactly once into a mapping.

    Raises:
        MalformedInputError: If the bytes are not YAML or not a mapping.
    """
    try:
        parsed = YAML(typ="safe").load(BytesIO(content))
    except (YAMLError, ValueError) as error:
        # ruamel constructs typed scalars (e.g. an unquoted `2025-99-99` timestamp)
        # during load and raises ValueError, not YAMLError, for an out-of-range
        # date. Both are malformed source and map to the same 400 response rather
        # than escaping as an unhandled 500.
        raise MalformedInputError(f"The scheduling document is not valid YAML: {error}") from error
    if not isinstance(parsed, dict):
        raise MalformedInputError("The scheduling document must be a YAML mapping.")
    return parsed


def _validate_workspace_version(parsed: dict[str, Any]) -> NurseSchedulingData:
    """Select the strict or workspace validation path from `workspaceVersion`.

    Only an absent key selects the legacy strict path; an explicit value (including
    `null` and booleans) must be the integer `1` to select Workspace V1. Every
    other value returns the normative unsupported-version issue rather than falling
    through to legacy validation.

    Raises:
        SchedulingContentError: For unsupported versions or content validation failures.
    """
    if "workspaceVersion" not in parsed:
        try:
            return NurseSchedulingData(**parsed)
        except ValidationError as error:
            raise invalid_scheduling_data(error) from error
    version = parsed["workspaceVersion"]
    # `bool` is a subclass of `int` and `True == 1`, so booleans are excluded
    # explicitly before the integer check.
    if not isinstance(version, bool) and isinstance(version, int) and version == 1:
        return convert_workspace_to_strict(parsed)
    message = f"Unsupported workspaceVersion: {version}."
    raise SchedulingContentError(
        CODE_UNSUPPORTED_WORKSPACE_VERSION,
        message,
        [SchedulingIssue(["workspaceVersion"], ISSUE_UNSUPPORTED_VALUE, message)],
    )


def canonicalize_submission(content: bytes) -> bytes:
    """Validate submitted YAML and return canonical strict bytes for a durable job.

    Both legacy strict input and Workspace V1 input converge on the strict model,
    which is then serialized with the canonical dumper. The worker later reparses
    and revalidates these bytes.

    Raises:
        MalformedInputError: If the submitted bytes are not a YAML mapping.
        SchedulingContentError: For scheduling-content validation failures.
    """
    parsed = _parse_once(content)
    strict_model = _validate_workspace_version(parsed)
    return dump_canonical_strict_yaml(strict_model)
