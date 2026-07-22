"""Flat Workspace V1 schema and its conversion to the strict scheduling model."""

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

import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError

from ..constants import ALL, LEAVE, MAP_DATE_KEYWORD_TO_FILTER, MAP_WEEKDAY_TO_STR, OFF
from ..group_map import build_shift_type_index_map
from ..utils import parse_dates
from ..models import (
    DateGroup,
    ExportConfig,
    MaxOneShiftPerDayPreference,
    NurseSchedulingData,
    PeopleContainer,
    ShiftAffinityPreference,
    ShiftCountPreference,
    ShiftRequestPreference,
    ShiftTypeCoveringPreference,
    ShiftTypeRequirementsPreference,
    ShiftTypesContainer,
    ShiftTypeSuccessionsPreference,
)
from .scheduling_errors import (
    CODE_INVALID_SCHEDULING_DATA,
    CODE_WORKSPACE_NOT_READY,
    ISSUE_DUPLICATE_WORKSPACE_ID,
    ISSUE_INVALID_VALUE,
    ISSUE_UNRESOLVED_WORKSPACE_REFERENCE,
    ISSUE_WORKSPACE_INCOMPLETE,
    MESSAGE_INVALID_SCHEDULING_DATA,
    MESSAGE_WORKSPACE_NOT_READY,
    SchedulingContentError,
    SchedulingIssue,
    invalid_scheduling_data,
    issues_at_prefix,
)


class WorkspaceDateRange(BaseModel):
    """Authoring date range whose bounds may be `null` while setup is incomplete."""

    model_config = ConfigDict(extra="forbid")
    startDate: datetime.date | None = None
    endDate: datetime.date | None = None


class WorkspaceDateContainer(BaseModel):
    """Workspace dates: a nullable range plus authoring groups; items stay generated."""

    model_config = ConfigDict(extra="forbid")
    range: WorkspaceDateRange
    items: list[datetime.date] = Field(default_factory=list)
    groups: list[DateGroup] = Field(default_factory=list)


# The five pinnable constraint kinds and the strict preference `type` each pins.
# A Guided rule pins exactly one constraint card (never a matrix request or the
# structural max-one-shift-per-day), so `constraintKind` maps one-to-one onto a
# strict preference type. Kept in sync with the TypeScript `GuidedRuleConstraintKind`.
GUIDED_CONSTRAINT_KIND_TO_TYPE: dict[str, str] = {
    "requirements": "shift type requirement",
    "successions": "shift type successions",
    "counts": "shift count",
    "affinities": "shift affinity",
    "coverings": "shift type covering",
}


class WorkspaceGuidedRule(BaseModel):
    """Authoring-only Guided rule pinning one strict constraint into the Guided lens.

    Guided rules never reach the solver; they are stripped during conversion. The
    record is the exact, lossless serialization of the durable store pin type
    (T14 `GuidedRulePin`): a stable pin `id`, the pinned constraint's
    `constraintKind` + `constraintId` (a preference `workspaceId`), the shortcut
    `category`, the required `quickFields` exposed as inline adjust controls, and
    an optional description. `id` and `quickFields` are required (not defaulted),
    so the wire record cannot accept a document the durable type could never
    author. Unknown fields are rejected so malformed authoring data cannot pass
    the workspace boundary silently.
    """

    model_config = ConfigDict(extra="forbid")
    id: str
    constraintKind: Literal["requirements", "successions", "counts", "affinities", "coverings"]
    constraintId: str
    category: str
    quickFields: list[str]
    description: str | None = None


class _WorkspacePreferenceFields(BaseModel):
    """Authoring metadata carried by every Workspace preference record.

    `enabled` is boolean-only (`StrictBool`) so truthy placeholders cannot enable
    or disable a preference by accident; a missing `enabled` means enabled.
    """

    workspaceId: str
    enabled: StrictBool = True


class _WorkspaceMaxOneShiftPerDay(MaxOneShiftPerDayPreference, _WorkspacePreferenceFields):
    """Strict "at most one shift per day" preference with authoring metadata."""


class _WorkspaceShiftRequest(ShiftRequestPreference, _WorkspacePreferenceFields):
    """Strict "shift request" preference with authoring metadata."""


class _WorkspaceShiftTypeSuccessions(ShiftTypeSuccessionsPreference, _WorkspacePreferenceFields):
    """Strict "shift type successions" preference with authoring metadata."""


class _WorkspaceShiftTypeRequirements(ShiftTypeRequirementsPreference, _WorkspacePreferenceFields):
    """Strict "shift type requirement" preference with authoring metadata."""


class _WorkspaceShiftCount(ShiftCountPreference, _WorkspacePreferenceFields):
    """Strict "shift count" preference with authoring metadata."""


class _WorkspaceShiftAffinity(ShiftAffinityPreference, _WorkspacePreferenceFields):
    """Strict "shift affinity" preference with authoring metadata."""


class _WorkspaceShiftTypeCovering(ShiftTypeCoveringPreference, _WorkspacePreferenceFields):
    """Strict "shift type covering" preference with authoring metadata."""


# Dispatch each authoring preference to exactly one strict model, keyed by its
# `type`. Validating one known model per record keeps 422 issue paths free of
# Pydantic union-branch class names.
_WORKSPACE_PREFERENCE_MODELS: dict[str, type[BaseModel]] = {
    model.model_fields["type"].default: model
    for model in (
        _WorkspaceMaxOneShiftPerDay,
        _WorkspaceShiftRequest,
        _WorkspaceShiftTypeSuccessions,
        _WorkspaceShiftTypeRequirements,
        _WorkspaceShiftCount,
        _WorkspaceShiftAffinity,
        _WorkspaceShiftTypeCovering,
    )
}

# Preference fields that reference declared people, shift types, or dates. Values
# may be a scalar id, a flat list, or a nested list; coefficient fields carry
# `[id, coefficient]` pairs whose first element is the referenced id.
_PEOPLE_REFERENCE_FIELDS = ("person", "qualifiedPeople", "people1", "people2", "preceptors", "preceptees")
_SHIFT_TYPE_REFERENCE_FIELDS = ("shiftType", "shiftTypes", "pattern", "countShiftTypes")
_SHIFT_TYPE_COEFFICIENT_FIELDS = ("shiftTypeCoefficients", "countShiftTypeCoefficients")
_DATE_REFERENCE_FIELDS = ("date", "countDates")


# `workspaceVersion` is the file-format contract number for saved scheduling
# documents — deliberate and rarely bumped, distinct from build provenance
# (appVersion/backendVersion). Bump only on a breaking format change, and keep
# every prior version routable. The frontend mirrors this as `WORKSPACE_VERSION`.
CURRENT_WORKSPACE_VERSION = 1
SUPPORTED_WORKSPACE_VERSIONS = frozenset({CURRENT_WORKSPACE_VERSION})


class WorkspaceSchedulingDataV1(BaseModel):
    """Flat superset of the strict scheduling document preserving authoring state.

    People, shift types, and export configuration reuse the strict models because
    their shape is identical. Preferences stay raw at this level and are validated
    one strict authoring model at a time (see `_preference_body_issues`) so union
    branches never leak into error paths. `guidedRules` is authoring metadata
    stripped before solving.
    """

    model_config = ConfigDict(extra="forbid")
    workspaceVersion: int
    apiVersion: str
    description: str | None = None
    dates: WorkspaceDateContainer
    country: str | None = None
    people: PeopleContainer
    shiftTypes: ShiftTypesContainer
    preferences: list[dict[str, Any]] = Field(default_factory=list)
    guidedRules: list[WorkspaceGuidedRule] = Field(default_factory=list)
    export: ExportConfig = Field(default_factory=ExportConfig)
    appVersion: str | None = None


def _not_ready(issues: list[SchedulingIssue]) -> SchedulingContentError:
    """Build the `workspace_not_ready` error carrying its readiness issues."""
    return SchedulingContentError(CODE_WORKSPACE_NOT_READY, MESSAGE_WORKSPACE_NOT_READY, issues)


def _preference_body_issues(preferences: list[dict[str, Any]]) -> list[SchedulingIssue]:
    """Validate each preference body against its strict authoring model.

    Each record is validated with the single model matching its `type`, so issue
    paths stay at the source index without union-branch class names.
    """
    issues: list[SchedulingIssue] = []
    for index, preference in enumerate(preferences):
        preference_type = preference.get("type")
        model = _WORKSPACE_PREFERENCE_MODELS.get(preference_type) if isinstance(preference_type, str) else None
        if model is None:
            issues.append(
                SchedulingIssue(
                    ["preferences", index, "type"],
                    ISSUE_INVALID_VALUE,
                    f"Unsupported preference type: {preference_type!r}.",
                )
            )
            continue
        try:
            model(**preference)
        except ValidationError as error:
            issues.extend(issues_at_prefix(["preferences", index], error))
    return issues


def _flatten_ids(value: Any) -> list[Any]:
    """Flatten a scalar/list/nested-list reference value into its leaf ids."""
    if isinstance(value, list):
        leaves: list[Any] = []
        for element in value:
            leaves.extend(_flatten_ids(element))
        return leaves
    return [] if value is None else [value]


def _people_universe(people: PeopleContainer) -> tuple[set[Any], list[SchedulingIssue]]:
    """Return resolvable people ids and any group-member reference issues.

    Person ids, the `ALL` keyword, and group ids resolve. Groups resolve through
    ids declared before them, matching the solver's ordered people-group map.
    """
    resolvable: set[Any] = {person.id for person in people.items}
    resolvable.add(ALL)
    issues: list[SchedulingIssue] = []
    for group_index, group in enumerate(people.groups):
        for member_index, member in enumerate(group.members):
            if member not in resolvable:
                issues.append(
                    SchedulingIssue(
                        ["people", "groups", group_index, "members", member_index],
                        ISSUE_UNRESOLVED_WORKSPACE_REFERENCE,
                        f"People group references unknown person or group id: {member!r}.",
                    )
                )
        resolvable.add(group.id)
    return resolvable, issues


def _shift_type_universe(shift_types: ShiftTypesContainer) -> tuple[set[Any], list[SchedulingIssue]]:
    """Return resolvable shift-type ids and any group-member reference issues.

    Reuses the solver's ordered shift-type index map so item ids, the
    `ALL`/`OFF`/`LEAVE` keywords, and validated groups resolve identically.
    """
    try:
        resolvable = set(build_shift_type_index_map(shift_types.items, shift_types.groups))
        return resolvable, []
    except ValueError as error:
        base = {shift_type.id for shift_type in shift_types.items}
        base.update({ALL, OFF, LEAVE})
        base.update(group.id for group in shift_types.groups)
        issue = SchedulingIssue(["shiftTypes", "groups"], ISSUE_UNRESOLVED_WORKSPACE_REFERENCE, str(error))
        return base, [issue]


def _build_date_index_map(dates: WorkspaceDateContainer) -> tuple[dict[str, list[int]], list[SchedulingIssue], bool]:
    """Build the scheduler's date-token → day-index map and validate group members.

    Mirrors the scheduler's construction (schedule range → generated days →
    date/weekday keywords → date groups resolved through prior tokens) so date
    references resolve with identical semantics. Each unresolvable date-group
    member yields a deterministic `dates.groups[*].members[*]` issue. The boolean
    is `False` when the range is invalid (end before start), in which case the
    strict model reports it and date references are not checked here.
    """
    range_ = dates.range
    date_map: dict[str, list[int]] = {}
    issues: list[SchedulingIssue] = []
    number_of_days = (range_.endDate - range_.startDate).days + 1
    if number_of_days <= 0:
        return date_map, issues, False

    days = [range_.startDate + datetime.timedelta(days=offset) for offset in range(number_of_days)]
    for index, day in enumerate(days):
        date_map[str(day)] = [index]
    for keyword, keep in MAP_DATE_KEYWORD_TO_FILTER.items():
        date_map[keyword] = [index for index, day in enumerate(days) if keep(day)]
    for keyword in MAP_WEEKDAY_TO_STR:
        weekday_index = MAP_WEEKDAY_TO_STR.index(keyword)
        date_map[keyword] = [index for index, day in enumerate(days) if day.weekday() == weekday_index]

    for group_index, group in enumerate(dates.groups):
        indices: set[int] = set()
        for member_index, member in enumerate(group.members):
            if str(member) in date_map:
                indices.update(date_map[str(member)])
                continue
            try:
                indices.update(parse_dates(member, date_map, range_))
            except ValueError as error:
                issues.append(
                    SchedulingIssue(
                        ["dates", "groups", group_index, "members", member_index],
                        ISSUE_UNRESOLVED_WORKSPACE_REFERENCE,
                        f"Date group references an unresolvable date: {member!r} ({error}).",
                    )
                )
        date_map[group.id] = sorted(indices)
    return date_map, issues, True


def _reference_issues(workspace: WorkspaceSchedulingDataV1) -> list[SchedulingIssue]:
    """Collect unresolved people/shift-type/date references in enabled preferences.

    Only enabled preferences are checked because disabled records are stripped
    before solving. Group-member integrity is reported regardless. Date references
    use the scheduler's real resolution (literals, ranges, keywords, groups, and
    schedule-range membership).
    """
    people_ids, issues = _people_universe(workspace.people)
    shift_ids, shift_issues = _shift_type_universe(workspace.shiftTypes)
    issues.extend(shift_issues)
    date_map, date_group_issues, date_range_ok = _build_date_index_map(workspace.dates)
    issues.extend(date_group_issues)

    for index, preference in enumerate(workspace.preferences):
        if preference.get("enabled", True) is False:
            continue
        for field in _PEOPLE_REFERENCE_FIELDS:
            for leaf in _flatten_ids(preference.get(field)):
                if leaf not in people_ids:
                    issues.append(_reference_issue(index, field, leaf, "person or people group"))
        for field in _SHIFT_TYPE_REFERENCE_FIELDS:
            for leaf in _flatten_ids(preference.get(field)):
                if leaf not in shift_ids:
                    issues.append(_reference_issue(index, field, leaf, "shift type or shift type group"))
        for field in _SHIFT_TYPE_COEFFICIENT_FIELDS:
            for pair in preference.get(field) or []:
                if isinstance(pair, (list, tuple)) and pair and pair[0] not in shift_ids:
                    issues.append(_reference_issue(index, field, pair[0], "shift type or shift type group"))
        if date_range_ok:
            for field in _DATE_REFERENCE_FIELDS:
                value = preference.get(field)
                if value is None:
                    continue
                try:
                    parse_dates(value, date_map, workspace.dates.range)
                except ValueError as error:
                    issues.append(
                        SchedulingIssue(
                            ["preferences", index, field],
                            ISSUE_UNRESOLVED_WORKSPACE_REFERENCE,
                            f"Preference references an unresolvable date: {value!r} ({error}).",
                        )
                    )
    return issues


def _reference_issue(index: int, field: str, value: Any, kind: str) -> SchedulingIssue:
    """Build one unresolved-reference issue for a preference reference field."""
    return SchedulingIssue(
        ["preferences", index, field],
        ISSUE_UNRESOLVED_WORKSPACE_REFERENCE,
        f"Preference references unknown {kind}: {value!r}.",
    )


def _guided_rule_issues(workspace: WorkspaceSchedulingDataV1, declared_types: dict[str, Any]) -> list[SchedulingIssue]:
    """Validate each Guided rule's uniqueness and kind/source relationship.

    A rule's `id` must be unique among rules; at most one rule may pin a given
    `(constraintKind, constraintId)` source (the durable T14 one-pin-per-source
    invariant); its `constraintId` must reference a declared preference; and that
    preference's `type` must be the one its `constraintKind` pins (per
    `GUIDED_CONSTRAINT_KIND_TO_TYPE`). Structural field shape and the closed
    `constraintKind` set are already enforced by the Pydantic model.
    """
    issues: list[SchedulingIssue] = []
    seen_rule_ids: set[str] = set()
    seen_sources: set[tuple[str, str]] = set()
    for rule_index, rule in enumerate(workspace.guidedRules):
        if rule.id in seen_rule_ids:
            issues.append(
                SchedulingIssue(
                    ["guidedRules", rule_index, "id"],
                    ISSUE_DUPLICATE_WORKSPACE_ID,
                    f"Duplicate guided rule id: {rule.id}.",
                )
            )
        seen_rule_ids.add(rule.id)

        source = (rule.constraintKind, rule.constraintId)
        if source in seen_sources:
            issues.append(
                SchedulingIssue(
                    ["guidedRules", rule_index, "constraintId"],
                    ISSUE_DUPLICATE_WORKSPACE_ID,
                    f"Duplicate guided rule source: ({rule.constraintKind}, {rule.constraintId}).",
                )
            )
        seen_sources.add(source)

        if rule.constraintId not in declared_types:
            issues.append(
                SchedulingIssue(
                    ["guidedRules", rule_index, "constraintId"],
                    ISSUE_UNRESOLVED_WORKSPACE_REFERENCE,
                    f"Guided rule references unknown preference workspaceId: {rule.constraintId}.",
                )
            )
            continue
        expected_type = GUIDED_CONSTRAINT_KIND_TO_TYPE[rule.constraintKind]
        if declared_types[rule.constraintId] != expected_type:
            issues.append(
                SchedulingIssue(
                    ["guidedRules", rule_index, "constraintKind"],
                    ISSUE_UNRESOLVED_WORKSPACE_REFERENCE,
                    f"Guided rule constraintKind {rule.constraintKind!r} does not match the pinned "
                    f"preference {rule.constraintId!r}.",
                )
            )
    return issues


def _readiness_issues(workspace: WorkspaceSchedulingDataV1) -> list[SchedulingIssue]:
    """Collect authoring-completeness and reference-integrity issues.

    Covers incomplete dates, empty people/shift-type collections, unique
    preference `workspaceId`, Guided-pin integrity, and — once the entity
    prerequisites hold — unresolved scheduling references.
    """
    issues: list[SchedulingIssue] = []

    if workspace.dates.range.startDate is None:
        issues.append(
            SchedulingIssue(
                ["dates", "range", "startDate"], ISSUE_WORKSPACE_INCOMPLETE, "The schedule start date is not set."
            )
        )
    if workspace.dates.range.endDate is None:
        issues.append(
            SchedulingIssue(
                ["dates", "range", "endDate"], ISSUE_WORKSPACE_INCOMPLETE, "The schedule end date is not set."
            )
        )
    if not workspace.people.items:
        issues.append(
            SchedulingIssue(["people", "items"], ISSUE_WORKSPACE_INCOMPLETE, "At least one person is required.")
        )
    if not workspace.shiftTypes.items:
        issues.append(
            SchedulingIssue(["shiftTypes", "items"], ISSUE_WORKSPACE_INCOMPLETE, "At least one shift type is required.")
        )

    declared_types: dict[str, Any] = {}
    seen_ids: set[str] = set()
    for index, preference in enumerate(workspace.preferences):
        workspace_id = preference.get("workspaceId")
        if not isinstance(workspace_id, str) or not workspace_id:
            issues.append(
                SchedulingIssue(
                    ["preferences", index, "workspaceId"],
                    ISSUE_WORKSPACE_INCOMPLETE,
                    "The preference is missing a workspaceId.",
                )
            )
            continue
        declared_types[workspace_id] = preference.get("type")
        if workspace_id in seen_ids:
            issues.append(
                SchedulingIssue(
                    ["preferences", index, "workspaceId"],
                    ISSUE_DUPLICATE_WORKSPACE_ID,
                    f"Duplicate preference workspaceId: {workspace_id}.",
                )
            )
        seen_ids.add(workspace_id)

    issues.extend(_guided_rule_issues(workspace, declared_types))

    # Scheduling references can only resolve once dates and entities exist. When a
    # prerequisite is missing, reporting those readiness issues alone avoids a
    # cascade of derivative unresolved-reference noise.
    prerequisites_met = (
        workspace.dates.range.startDate is not None
        and workspace.dates.range.endDate is not None
        and workspace.people.items
        and workspace.shiftTypes.items
    )
    if prerequisites_met:
        issues.extend(_reference_issues(workspace))
    return issues


def _iso_or_passthrough(value: Any) -> Any:
    """Return a `date` as an ISO string, leaving any other value (or `None`) as is."""
    return value.isoformat() if isinstance(value, datetime.date) else value


def _strict_dict(workspace: WorkspaceSchedulingDataV1) -> dict[str, Any]:
    """Project a ready workspace into a strict `NurseSchedulingData` input dict.

    Disabled preferences are filtered out and authoring metadata (`workspaceId`,
    `enabled`, `guidedRules`, `workspaceVersion`) is stripped. Absent `enabled`
    means enabled.

    The dump uses `mode="python"`, not `mode="json"`: preferences are stored as
    raw `dict[str, Any]`, and JSON mode coerces a non-finite nested weight (every
    LEAVE pin serializes as `.inf`) to `None`, which the strict model would then
    reject. Python mode preserves those infinities; the strict model accepts the
    resulting `date`/float values and the canonical dumper re-serializes them.
    The nullable date-range bounds keep their explicit ISO conversion.
    """
    dump = workspace.model_dump(mode="python", exclude_none=True)

    range_dump = dump["dates"].get("range", {})
    strict: dict[str, Any] = {
        "apiVersion": dump["apiVersion"],
        "dates": {
            "range": {
                "startDate": _iso_or_passthrough(range_dump.get("startDate")),
                "endDate": _iso_or_passthrough(range_dump.get("endDate")),
            }
        },
    }
    if dump["dates"].get("groups"):
        strict["dates"]["groups"] = dump["dates"]["groups"]
    strict["people"] = dump["people"]
    strict["shiftTypes"] = dump["shiftTypes"]
    strict["export"] = dump.get("export", {})
    for optional in ("description", "country", "appVersion"):
        if optional in dump:
            strict[optional] = dump[optional]

    preferences: list[dict[str, Any]] = []
    for preference in dump.get("preferences", []):
        if not preference.get("enabled", True):
            continue
        preferences.append({key: value for key, value in preference.items() if key not in {"workspaceId", "enabled"}})
    strict["preferences"] = preferences
    return strict


def convert_workspace_to_strict(parsed: dict[str, Any]) -> NurseSchedulingData:
    """Validate Workspace V1 input and convert it to the strict scheduling model.

    Validation proceeds in fixed stages so each failure maps to one normative
    envelope: structural/body failures are `invalid_scheduling_data`, authoring
    incompleteness and unresolved references are `workspace_not_ready`, and
    residual strict-model/contract failures are `invalid_scheduling_data`.

    Raises:
        SchedulingContentError: For any workspace validation failure.
    """
    try:
        workspace = WorkspaceSchedulingDataV1(**parsed)
    except ValidationError as error:
        raise invalid_scheduling_data(error) from error

    body_issues = _preference_body_issues(workspace.preferences)
    if body_issues:
        raise SchedulingContentError(CODE_INVALID_SCHEDULING_DATA, MESSAGE_INVALID_SCHEDULING_DATA, body_issues)

    readiness = _readiness_issues(workspace)
    if readiness:
        raise _not_ready(readiness)

    try:
        return NurseSchedulingData(**_strict_dict(workspace))
    except ValidationError as error:
        raise invalid_scheduling_data(error) from error
