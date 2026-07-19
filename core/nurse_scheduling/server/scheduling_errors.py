"""Normative scheduling-content validation errors and their 422 envelope."""

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

import json
from collections import defaultdict
from dataclasses import dataclass, replace
from typing import Any

from pydantic import ValidationError


# error.code values for the scheduling-content 422 envelope.
CODE_WORKSPACE_NOT_READY = "workspace_not_ready"
CODE_INVALID_SCHEDULING_DATA = "invalid_scheduling_data"
CODE_UNSUPPORTED_WORKSPACE_VERSION = "unsupported_workspace_version"
CODE_UNSUPPORTED_SOLVER = "unsupported_solver"

# Human-readable envelope messages fixed by the technical plan.
MESSAGE_WORKSPACE_NOT_READY = "Workspace is not ready to optimize."
MESSAGE_INVALID_SCHEDULING_DATA = "Scheduling data is invalid."
MESSAGE_UNSUPPORTED_SOLVER = "Unsupported solver. Only ortools/cp-sat is available."

# Per-issue codes.
ISSUE_MISSING_FIELD = "missing_field"
ISSUE_INVALID_TYPE = "invalid_type"
ISSUE_UNKNOWN_FIELD = "unknown_field"
ISSUE_INVALID_VALUE = "invalid_value"
ISSUE_DUPLICATE_WORKSPACE_ID = "duplicate_workspace_id"
ISSUE_UNRESOLVED_WORKSPACE_REFERENCE = "unresolved_workspace_reference"
ISSUE_WORKSPACE_INCOMPLETE = "workspace_incomplete"
ISSUE_STRICT_CONTRACT_VIOLATION = "strict_contract_violation"
ISSUE_UNSUPPORTED_VALUE = "unsupported_value"


@dataclass(frozen=True)
class SchedulingIssue:
    """One deterministic location-and-reason entry in the 422 envelope."""

    path: list[Any]
    """JSON/YAML location segments; the document root is `[]` and array positions are numbers."""
    code: str
    """Stable machine-readable issue code."""
    message: str
    """Human-readable issue explanation."""

    def as_dict(self) -> dict[str, Any]:
        """Return the wire representation of this issue."""
        return {"path": list(self.path), "code": self.code, "message": self.message}


class SchedulingContentError(Exception):
    """A pre-job scheduling-content failure mapped to the normative 422 envelope."""

    def __init__(self, error_code: str, message: str, issues: list[SchedulingIssue]):
        """Create a content error carrying its envelope code, message, and issues."""
        super().__init__(message)
        self.error_code = error_code
        """Envelope-level `error.code`."""
        self.message = message
        """Envelope-level human-readable message."""
        self.issues = _sorted_issues(issues)
        """Deterministically ordered issue list."""

    def as_response(self) -> dict[str, Any]:
        """Return the full `{error: {...}}` 422 response body."""
        return {
            "error": {
                "code": self.error_code,
                "message": self.message,
                "issues": [issue.as_dict() for issue in self.issues],
            }
        }


def _encode_path(path: list[Any]) -> str:
    """Return a stable string encoding of a path for deterministic ordering."""
    return json.dumps(path, separators=(",", ":"), ensure_ascii=True)


def _sorted_issues(issues: list[SchedulingIssue]) -> list[SchedulingIssue]:
    """Sort issues by encoded path, then issue code, then message."""
    return sorted(issues, key=lambda issue: (_encode_path(issue.path), issue.code, issue.message))


_PYDANTIC_TYPE_TO_ISSUE: dict[str, str] = {
    "missing": ISSUE_MISSING_FIELD,
    "extra_forbidden": ISSUE_UNKNOWN_FIELD,
}


def _issue_code_for(error: dict[str, Any]) -> str:
    """Map one Pydantic error to a normative issue code.

    Structural type failures become `invalid_type`; root-level cross-field
    `value_error` failures (missing required preferences, contracted-hours C3
    checks) become `strict_contract_violation`; other value failures become
    `invalid_value`.
    """
    error_type = str(error.get("type", ""))
    if error_type in _PYDANTIC_TYPE_TO_ISSUE:
        return _PYDANTIC_TYPE_TO_ISSUE[error_type]
    if error_type == "value_error":
        return ISSUE_STRICT_CONTRACT_VIOLATION if len(error.get("loc", ())) == 0 else ISSUE_INVALID_VALUE
    if error_type.endswith("_type") or error_type.endswith("_parsing"):
        return ISSUE_INVALID_TYPE
    return ISSUE_INVALID_VALUE


def _translate_loc(loc: tuple[Any, ...]) -> list[Any]:
    """Translate a Pydantic location tuple into JSON/YAML path segments.

    Integers (array indices) are preserved as numbers; every other segment is
    kept as its string form so paths remain document locations.
    """
    return [segment if isinstance(segment, int) else str(segment) for segment in loc]


# Class names Pydantic inserts as a location segment for each branch it attempts
# when validating the preference union. They are internal type labels, not
# document locations, so they are removed from issue paths.
_PREFERENCE_UNION_CLASSES = frozenset(
    {
        "MaxOneShiftPerDayPreference",
        "ShiftRequestPreference",
        "ShiftTypeSuccessionsPreference",
        "ShiftTypeRequirementsPreference",
        "ShiftCountPreference",
        "ShiftAffinityPreference",
        "ShiftTypeCoveringPreference",
    }
)
_DISCRIMINATOR_MISMATCH_TYPES = frozenset({"string_pattern_mismatch", "literal_error"})


def _issue_from_error(loc: tuple[Any, ...], error: dict[str, Any]) -> SchedulingIssue:
    """Build one issue from a Pydantic error at an already-cleaned location."""
    return SchedulingIssue(
        path=_translate_loc(loc),
        code=_issue_code_for(error),
        message=str(error.get("msg", "")),
    )


def _is_discriminator_mismatch(remainder: tuple[Any, ...], error: dict[str, Any]) -> bool:
    """Return whether an error is only a `type` discriminator mismatch on a branch."""
    return str(error.get("type", "")) in _DISCRIMINATOR_MISMATCH_TYPES and bool(remainder) and remainder[-1] == "type"


def _resolve_union_group(prefix: tuple[Any, ...], entries: list[tuple[str, tuple[Any, ...], dict[str, Any]]]):
    """Resolve one preference union location into issues for the matched branch.

    A branch matches when its `type` discriminator does not mismatch. Exactly one
    branch matches a valid preference `type`, so only that branch's real errors
    survive; when no branch matches, the `type` value itself is unsupported.
    """
    by_class: dict[str, list[tuple[tuple[Any, ...], dict[str, Any]]]] = defaultdict(list)
    for class_name, remainder, error in entries:
        by_class[class_name].append((remainder, error))

    matched = [
        class_name
        for class_name, branch_errors in by_class.items()
        if not any(_is_discriminator_mismatch(remainder, error) for remainder, error in branch_errors)
    ]
    if not matched:
        return [
            SchedulingIssue(
                _translate_loc(prefix + ("type",)),
                ISSUE_INVALID_VALUE,
                "Unsupported preference type.",
            )
        ]
    return [
        _issue_from_error(prefix + remainder, error)
        for class_name in matched
        for remainder, error in by_class[class_name]
    ]


def _dedupe_issues(issues: list[SchedulingIssue]) -> list[SchedulingIssue]:
    """Drop issues sharing the same path, code, and message, preserving order."""
    seen: set[tuple[str, str, str]] = set()
    unique: list[SchedulingIssue] = []
    for issue in issues:
        key = (_encode_path(issue.path), issue.code, issue.message)
        if key not in seen:
            seen.add(key)
            unique.append(issue)
    return unique


def issues_from_validation_error(exc: ValidationError) -> list[SchedulingIssue]:
    """Translate a Pydantic validation error into normative scheduling issues.

    Preference-union branch class names are removed from paths, and only the
    matched branch's errors are kept so irrelevant branch noise never ships. The
    result is deterministically deduplicated.
    """
    plain: list[SchedulingIssue] = []
    union_groups: dict[tuple[Any, ...], list[tuple[str, tuple[Any, ...], dict[str, Any]]]] = defaultdict(list)
    for error in exc.errors():
        loc = tuple(error.get("loc", ()))
        branch_index = next((index for index, segment in enumerate(loc) if segment in _PREFERENCE_UNION_CLASSES), None)
        if branch_index is None:
            plain.append(_issue_from_error(loc, error))
            continue
        prefix = loc[:branch_index]
        union_groups[prefix].append((loc[branch_index], loc[branch_index + 1 :], error))

    issues = list(plain)
    for prefix, entries in union_groups.items():
        issues.extend(_resolve_union_group(prefix, entries))
    return _dedupe_issues(issues)


def issues_at_prefix(prefix: list[Any], exc: ValidationError) -> list[SchedulingIssue]:
    """Translate a validation error and prepend a source-document path prefix.

    Used when a single record is validated in isolation so its issues carry the
    record's original location (for example its source index within a list).
    """
    return [replace(issue, path=[*prefix, *issue.path]) for issue in issues_from_validation_error(exc)]


def invalid_scheduling_data(exc: ValidationError) -> SchedulingContentError:
    """Build the `invalid_scheduling_data` error from a strict-model failure."""
    return SchedulingContentError(
        CODE_INVALID_SCHEDULING_DATA,
        MESSAGE_INVALID_SCHEDULING_DATA,
        issues_from_validation_error(exc),
    )
