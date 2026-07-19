"""Workspace V1 conversion, normative 422 envelopes, and canonical handoff."""

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

from nurse_scheduling import scheduler
from nurse_scheduling.loader import load_data
from nurse_scheduling.server.canonical import dump_canonical_strict_yaml
from nurse_scheduling.server.scheduling_errors import SchedulingContentError
from nurse_scheduling.server.scheduling_input import (
    MalformedInputError,
    canonicalize_submission,
    parse_solver,
)

LEGACY_EQUIVALENT = """
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
    - id: bob
shiftTypes:
  items:
    - id: day
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
"""

WORKSPACE = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
    - id: bob
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    enabled: true
    type: at most one shift per day
  - workspaceId: r2
    enabled: true
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
  - workspaceId: r3
    enabled: false
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day
guidedRules:
  - id: g1
    constraintKind: requirements
    constraintId: r2
    category: Coverage
    quickFields: [requiredNumPeople]
appVersion: 1.0.0
"""


def test_legacy_and_workspace_converge_on_same_strict():
    # The disabled r3 preference and all authoring metadata are stripped, so the
    # workspace canonicalizes to the same strict document as the legacy input.
    workspace_canonical = canonicalize_submission(WORKSPACE.encode())
    legacy_canonical = canonicalize_submission(LEGACY_EQUIVALENT.encode())
    # appVersion is retained (moved last) in the workspace canonical form.
    assert b"appVersion: 1.0.0" in workspace_canonical
    workspace_model = load_data(workspace_canonical)
    assert len(workspace_model.preferences) == 2
    assert workspace_canonical.replace(b"appVersion: 1.0.0\n", b"") == legacy_canonical
    assert b"workspaceId" not in workspace_canonical
    assert b"guidedRules" not in workspace_canonical
    assert b"enabled" not in workspace_canonical


def test_canonical_is_idempotent_and_worker_reparses():
    canonical = canonicalize_submission(LEGACY_EQUIVALENT.encode())
    # Worker-side reparse of the stored bytes succeeds and re-canonicalizes stably.
    reparsed = load_data(canonical)
    assert dump_canonical_strict_yaml(reparsed) == canonical
    assert canonicalize_submission(canonical) == canonical


def test_canonical_dumper_encodes_infinite_weight_and_order():
    scenario = """
apiVersion: alpha
appVersion: build-123
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - type: at most one shift per day
  - type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day
    weight: .inf
"""
    canonical = canonicalize_submission(scenario.encode())
    text = canonical.decode("utf-8")
    assert "weight: .inf" in text
    assert text.endswith("\n") and not text.endswith("\n\n")
    assert "\r" not in text
    # appVersion is emitted last.
    assert text.rstrip().splitlines()[-1].strip() == "appVersion: build-123"


def test_workspace_and_legacy_solver_outcomes_agree():
    workspace_canonical = canonicalize_submission(WORKSPACE.encode())
    legacy_canonical = canonicalize_submission(LEGACY_EQUIVALENT.encode())
    ws_df, _s, ws_score, ws_status, _c = scheduler.schedule(file_content=workspace_canonical)
    lg_df, _s2, lg_score, lg_status, _c2 = scheduler.schedule(file_content=legacy_canonical)
    assert ws_status == lg_status
    assert ws_score == lg_score
    assert ws_df.equals(lg_df)


# --- Solver boundary ----------------------------------------------------------


def test_default_and_exact_solver_accepted():
    assert parse_solver("ortools/cp-sat") == "ortools/cp-sat"


def test_non_cp_sat_solver_rejected():
    with pytest.raises(SchedulingContentError) as excinfo:
        parse_solver("pulp/cbc")
    error = excinfo.value
    assert error.error_code == "unsupported_solver"
    assert error.as_response()["error"]["issues"] == [
        {
            "path": ["solver"],
            "code": "unsupported_value",
            "message": "Unsupported solver. Only ortools/cp-sat is available.",
        }
    ]


# --- Normative 422 envelopes --------------------------------------------------


def _content_error(document: str) -> SchedulingContentError:
    with pytest.raises(SchedulingContentError) as excinfo:
        canonicalize_submission(document.encode())
    return excinfo.value


def test_unsupported_workspace_version():
    error = _content_error("workspaceVersion: 2\napiVersion: alpha\n")
    assert error.error_code == "unsupported_workspace_version"
    assert error.message == "Unsupported workspaceVersion: 2."
    assert error.as_response()["error"]["issues"] == [
        {"path": ["workspaceVersion"], "code": "unsupported_value", "message": "Unsupported workspaceVersion: 2."}
    ]


def test_workspace_incomplete_dates():
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: null
    endDate: null
people:
  items: []
shiftTypes:
  items: []
preferences: []
"""
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    codes = {(tuple(issue.path), issue.code) for issue in error.issues}
    assert (("dates", "range", "startDate"), "workspace_incomplete") in codes
    assert (("dates", "range", "endDate"), "workspace_incomplete") in codes


def test_workspace_duplicate_workspace_id():
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: dup
    type: at most one shift per day
  - workspaceId: dup
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
"""
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(issue.code == "duplicate_workspace_id" for issue in error.issues)


def test_workspace_broken_guided_pin():
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    type: at most one shift per day
guidedRules:
  - id: g1
    constraintKind: requirements
    constraintId: does-not-exist
    category: Coverage
    quickFields: []
"""
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(issue.code == "unresolved_workspace_reference" for issue in error.issues)


def test_workspace_unknown_top_level_field():
    document = """
workspaceVersion: 1
apiVersion: alpha
mysteryField: 1
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    type: at most one shift per day
"""
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"
    assert any(issue.code == "unknown_field" for issue in error.issues)


def test_legacy_invalid_scheduling_data():
    # Missing the required "at most one shift per day" preference is a strict contract failure.
    document = """
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences: []
"""
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"


def test_malformed_yaml_raises_malformed():
    with pytest.raises(MalformedInputError):
        canonicalize_submission(b"just a string, not a mapping")
    with pytest.raises(MalformedInputError):
        canonicalize_submission(b"key: [unbalanced\n")


# --- Empty collections and unresolved references (workspace_not_ready) --------


def _workspace_with_preferences(preferences: str) -> str:
    return f"""
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
{preferences}
"""


def test_workspace_empty_people_and_shift_types_are_not_ready():
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items: []
shiftTypes:
  items: []
preferences:
  - workspaceId: r1
    type: at most one shift per day
"""
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    codes = {(tuple(issue.path), issue.code) for issue in error.issues}
    assert (("people", "items"), "workspace_incomplete") in codes
    assert (("shiftTypes", "items"), "workspace_incomplete") in codes


def test_workspace_unknown_person_reference_is_not_ready():
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift request
    person: ghost
    date: 2025-01-01
    shiftType: day"""
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert (["preferences", 1, "person"], "unresolved_workspace_reference") in [
        (issue.path, issue.code) for issue in error.issues
    ]


def test_workspace_unknown_shift_type_reference_is_not_ready():
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: missing"""
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(
        issue.path == ["preferences", 1, "shiftType"] and issue.code == "unresolved_workspace_reference"
        for issue in error.issues
    )


def test_workspace_unknown_date_reference_is_not_ready():
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift request
    person: alice
    date: not-a-date
    shiftType: day"""
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(
        issue.path == ["preferences", 1, "date"] and issue.code == "unresolved_workspace_reference"
        for issue in error.issues
    )


@pytest.mark.parametrize("date_value", ['"2025-99-99"', '"32"', '"2025-02-01"'])
def test_workspace_invalid_or_out_of_range_date_is_not_ready(date_value):
    # Single-day schedule (2025-01-01): an impossible literal, an out-of-month day,
    # and an in-format but out-of-range date are all rejected pre-job with the
    # date's source path, matching the scheduler's real resolution.
    document = _workspace_with_preferences(
        f"""  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift request
    person: alice
    date: {date_value}
    shiftType: day"""
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(
        issue.path == ["preferences", 1, "date"] and issue.code == "unresolved_workspace_reference"
        for issue in error.issues
    )


def test_workspace_invalid_date_group_member_is_not_ready():
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
  groups:
    - id: holidays
      members: ["2025-99-99"]
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    type: at most one shift per day
"""
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(
        issue.path == ["dates", "groups", 0, "members", 0] and issue.code == "unresolved_workspace_reference"
        for issue in error.issues
    )


def test_unquoted_invalid_yaml_timestamp_is_malformed_400():
    # ruamel constructs the unquoted date as a timestamp and raises ValueError;
    # this maps to the 400 malformed-source path, never HTTP 500.
    with pytest.raises(MalformedInputError):
        canonicalize_submission(b"apiVersion: alpha\ndate: 2025-99-99\n")


def test_workspace_disabled_preference_references_are_not_checked():
    # A disabled record is stripped before solving, so its (broken) references do
    # not block readiness and never reach the canonical strict document.
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    enabled: false
    type: shift request
    person: ghost
    date: 2025-01-01
    shiftType: missing"""
    )
    canonical = canonicalize_submission(document.encode())
    assert b"ghost" not in canonical


# --- Infinite-weight preservation through Workspace projection (T19d) ----------


def test_workspace_enabled_infinite_weight_preference_survives_projection():
    # A generic enabled preference with an infinite weight must reach the strict
    # model and canonical YAML as `.inf`, not be coerced to None by the raw-dict
    # `dict[str, Any]` JSON dump.
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    enabled: true
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day
    weight: .inf"""
    )
    canonical = canonicalize_submission(document.encode())
    assert "weight: .inf" in canonical.decode("utf-8")
    model = load_data(canonical)  # strict-loader reparse of the stored bytes
    weights = [p.weight for p in model.preferences if getattr(p, "type", None) == "shift request"]
    assert weights == [float("inf")]


def test_workspace_enabled_leave_pin_survives_projection():
    # The production path the disabled fixtures hid: an ordinary LEAVE pin
    # serializes as `weight: .inf` and must survive the Workspace projection.
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    enabled: true
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: LEAVE
    weight: .inf"""
    )
    canonical = canonicalize_submission(document.encode())
    text = canonical.decode("utf-8")
    assert "shiftType: LEAVE" in text
    assert "weight: .inf" in text
    model = load_data(canonical)  # strict-loader reparse of the stored bytes
    leave = [p for p in model.preferences if getattr(p, "shiftType", None) == "LEAVE"]
    assert leave and leave[0].weight == float("inf")


# --- Lossless Guided record (T19e) --------------------------------------------


def test_workspace_guided_rule_every_constraint_kind_is_accepted_and_stripped():
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
    - id: bob
shiftTypes:
  items:
    - id: day
    - id: night
preferences:
  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: p_req
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
  - workspaceId: p_succ
    type: shift type successions
    person: alice
    pattern: [[day], [night]]
  - workspaceId: p_count
    type: shift count
    person: alice
    countDates: ALL
    countShiftTypes: [day]
    expression: x = T
    target: 1
  - workspaceId: p_aff
    type: shift affinity
    date: ALL
    people1: [alice]
    people2: [bob]
    shiftTypes: [[day]]
  - workspaceId: p_cov
    type: shift type covering
    preceptors: [alice]
    preceptees: [bob]
    shiftTypes: [[day]]
guidedRules:
  - id: g_req
    constraintKind: requirements
    constraintId: p_req
    category: Coverage
    quickFields: [requiredNumPeople]
  - id: g_succ
    constraintKind: successions
    constraintId: p_succ
    category: Patterns
    quickFields: []
  - id: g_count
    constraintKind: counts
    constraintId: p_count
    category: Balance
    quickFields: [target]
    description: Balance the workload
  - id: g_aff
    constraintKind: affinities
    constraintId: p_aff
    category: Teams
    quickFields: []
  - id: g_cov
    constraintKind: coverings
    constraintId: p_cov
    category: Mentoring
    quickFields: []
"""
    canonical = canonicalize_submission(document.encode())
    # Every Guided field is solver-inert and stripped from the canonical document.
    assert b"guidedRules" not in canonical
    assert b"constraintKind" not in canonical
    assert b"quickFields" not in canonical


def test_workspace_guided_rule_kind_source_mismatch_is_not_ready():
    # constraintKind claims counts, but the pinned preference is a requirement.
    document = (
        _workspace_with_preferences(
            """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: p_req
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1"""
        )
        + """guidedRules:
  - id: g1
    constraintKind: counts
    constraintId: p_req
    category: X
    quickFields: []
"""
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(
        issue.path == ["guidedRules", 0, "constraintKind"] and issue.code == "unresolved_workspace_reference"
        for issue in error.issues
    )


def test_workspace_duplicate_guided_rule_id_is_not_ready():
    document = (
        _workspace_with_preferences(
            """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: p_req
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1"""
        )
        + """guidedRules:
  - id: g1
    constraintKind: requirements
    constraintId: p_req
    category: X
    quickFields: []
  - id: g1
    constraintKind: requirements
    constraintId: p_req
    category: Y
    quickFields: []
"""
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(
        issue.path == ["guidedRules", 1, "id"] and issue.code == "duplicate_workspace_id" for issue in error.issues
    )


def test_workspace_guided_rule_unknown_constraint_kind_is_invalid():
    document = (
        _workspace_with_preferences(
            """  - workspaceId: r1
    type: at most one shift per day"""
        )
        + """guidedRules:
  - id: g1
    constraintKind: mystery
    constraintId: r1
    category: X
    quickFields: []
"""
    )
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"
    assert any(issue.path == ["guidedRules", 0, "constraintKind"] for issue in error.issues)


# --- Strict Workspace authoring models (F3) -----------------------------------


def test_workspace_non_boolean_enabled_is_invalid():
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    enabled: 1
    type: at most one shift per day"""
    )
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"
    assert any(issue.path == ["preferences", 0, "enabled"] for issue in error.issues)


def test_workspace_guided_rule_unknown_field_is_invalid():
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    type: at most one shift per day
guidedRules:
  - id: g1
    constraintKind: requirements
    constraintId: r1
    category: Coverage
    quickFields: []
    mystery: 1
"""
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"
    assert any(issue.path == ["guidedRules", 0, "mystery"] and issue.code == "unknown_field" for issue in error.issues)


def test_workspace_guided_rule_missing_quick_fields_is_invalid():
    # `quickFields` is a required durable T14 field; a record omitting it is one the
    # durable pin type could never author, so it fails structural validation.
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - workspaceId: r1
    type: at most one shift per day
guidedRules:
  - id: g1
    constraintKind: requirements
    constraintId: r1
    category: Coverage
"""
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"
    assert any(
        issue.path == ["guidedRules", 0, "quickFields"] and issue.code == "missing_field" for issue in error.issues
    )


def test_workspace_duplicate_guided_rule_source_is_not_ready():
    # Two rules with distinct ids pin the SAME (constraintKind, constraintId) source,
    # violating the durable T14 one-pin-per-source invariant.
    document = (
        _workspace_with_preferences(
            """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: p_req
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1"""
        )
        + """guidedRules:
  - id: g1
    constraintKind: requirements
    constraintId: p_req
    category: X
    quickFields: []
  - id: g2
    constraintKind: requirements
    constraintId: p_req
    category: Y
    quickFields: []
"""
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert any(
        issue.path == ["guidedRules", 1, "constraintId"] and issue.code == "duplicate_workspace_id"
        for issue in error.issues
    )


@pytest.mark.parametrize(
    "raw_version",
    ["true", "false", "null", '"1"', "'1'", "1.0", "2", "1_0", "0o2"],
)
def test_non_integer_or_non_one_workspace_version_is_unsupported(raw_version):
    document = f"workspaceVersion: {raw_version}\napiVersion: alpha\n"
    error = _content_error(document)
    assert error.error_code == "unsupported_workspace_version"
    assert error.issues[0].path == ["workspaceVersion"]
    assert error.issues[0].code == "unsupported_value"


# Every scalar the authoritative ruamel safe loader resolves to integer 1 must
# select V1 (here reaching `workspace_not_ready` for the empty body, NOT
# `unsupported_workspace_version`). Frozen bidirectionally with the TypeScript
# `classifyWorkspaceSource` matrix (web/lib/scenario/workspace.test.ts).
@pytest.mark.parametrize("raw_version", ["1", "+1", "01", "0o1", "0x1", "0b1", "1  # v", "!!int 1"])
def test_integer_one_workspace_version_forms_select_v1(raw_version):
    document = f"workspaceVersion: {raw_version}\napiVersion: alpha\n"
    error = _content_error(document)
    assert error.error_code != "unsupported_workspace_version"


def test_anchored_and_aliased_workspace_version_select_v1():
    # An anchored `&v 1` and an alias `*v` both resolve to integer 1 and select V1.
    for document in (
        "workspaceVersion: &v 1\nx: *v\napiVersion: alpha\n",
        "anchor: &v 1\nworkspaceVersion: *v\napiVersion: alpha\n",
    ):
        error = _content_error(document)
        assert error.error_code != "unsupported_workspace_version"


def test_absent_workspace_version_uses_legacy_path():
    # No workspaceVersion key: legacy strict validation, not unsupported-version.
    error = _content_error("apiVersion: alpha\n")
    assert error.error_code == "invalid_scheduling_data"


# --- Source-document 422 paths (F4) -------------------------------------------


def test_workspace_body_issue_uses_clean_source_path():
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift request
    person: alice
    date: 2025-01-01"""  # missing shiftType
    )
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"
    assert error.as_response()["error"]["issues"] == [
        {"path": ["preferences", 1, "shiftType"], "code": "missing_field", "message": "Field required"}
    ]


def test_workspace_preserves_source_index_across_disabled_filtering():
    # A disabled valid record precedes an enabled invalid one; the issue must report
    # the source index (2), not a post-filter index.
    document = _workspace_with_preferences(
        """  - workspaceId: r0
    enabled: false
    type: shift request
    person: alice
    date: 2025-01-01
    shiftType: day
  - workspaceId: r1
    type: at most one shift per day
  - workspaceId: r2
    type: shift request
    person: alice
    date: 2025-01-01"""  # missing shiftType at source index 2
    )
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"
    assert [issue.path for issue in error.issues] == [["preferences", 2, "shiftType"]]


def test_legacy_union_errors_drop_class_labels_and_branch_noise():
    document = """
apiVersion: alpha
dates:
  range:
    startDate: 2025-01-01
    endDate: 2025-01-01
people:
  items:
    - id: alice
shiftTypes:
  items:
    - id: day
preferences:
  - type: at most one shift per day
  - type: shift request
    person: alice
    date: 2025-01-01
"""  # missing shiftType
    error = _content_error(document)
    assert error.error_code == "invalid_scheduling_data"
    # Only the matched branch's real error survives; no union class names appear.
    assert error.as_response()["error"]["issues"] == [
        {"path": ["preferences", 1, "shiftType"], "code": "missing_field", "message": "Field required"}
    ]
    for issue in error.issues:
        assert not any(isinstance(segment, str) and segment.endswith("Preference") for segment in issue.path)


def test_issue_ordering_is_deterministic():
    document = """
workspaceVersion: 1
apiVersion: alpha
dates:
  range:
    startDate: null
    endDate: null
people:
  items: []
shiftTypes:
  items: []
preferences: []
"""
    error = _content_error(document)
    encoded = [(issue.path, issue.code, issue.message) for issue in error.issues]
    assert encoded == sorted(encoded, key=lambda item: (str(item[0]), item[1], item[2]))
