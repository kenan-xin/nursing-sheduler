"""Scenario-root validation of contracted-hours (marked) shift counts (WT1).

A shift count that carries the `hoursContract` marker is a fixed half-hour
contract. Beyond the field-level `{unit, policy}` schema (see
`test_hours_contract_field.py`), the scenario-root validator enforces:

  * policy encoding — Exact is scalar `x = T` + scalar non-negative target + .inf;
    Range is `[x >= T, x <= T]` + ordered non-negative `[min, max]` + .inf;
  * exact explicit coefficient coverage — after the dynamic `ALL`/group selectors
    expand through the shared ordered group map, the coefficient ids must equal
    the deduplicated concrete worked/`LEAVE` set exactly (no omissions, extras,
    groups, `ALL`, `OFF`, or duplicates);
  * deterministic ordered-map failure precedence (forward reference before cycle);
  * validator-vs-scheduler expansion parity and distinct Range identifiers;
  * solver inertness — valid metadata never contributes a finite objective term.

Errors raised inside the Pydantic model validator surface as `ValidationError`.
"""

# This file is part of Nurse Scheduling Project, see <https://github.com/j3soon/nurse-scheduling>.
#
# Copyright (C) 2023-2026 Johnson Sun
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nurse_scheduling
import pytest
from nurse_scheduling import group_map, models, preference_types
from nurse_scheduling.loader import load_data
from pydantic import ValidationError


def _run(yaml_text: str):
    df, solution, score, status, _cell_export_info = nurse_scheduling.schedule(yaml_text.encode("utf-8"))
    return df, solution, score, status


# Two 8h worked types (D, E) plus a group; a 2-day, 1-person window. Marked
# counts target 0 half-hours so every valid contract is solvable (nurse rests).
DEFAULT_SHIFT_TYPES = """  items:
    - id: D
      durationMinutes: 480
    - id: E
      durationMinutes: 480
  groups:
    - id: Work
      members: [D, E]"""

SCENARIO = """
apiVersion: alpha
description: contracted-hours validation
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-02
people:
  items:
    - id: 0
shiftTypes:
{shift_types}
preferences:
  - type: at most one shift per day
{count}
"""


def _build(count_block: str, shift_types: str = DEFAULT_SHIFT_TYPES) -> str:
    return SCENARIO.format(shift_types=shift_types, count=count_block)


def _exact(count_shift_types: str, coefficients: str, target: str = "0") -> str:
    return f"""  - type: shift count
    person: 0
    countDates: ALL
    countShiftTypes: {count_shift_types}
    countShiftTypeCoefficients:
{coefficients}
    expression: 'x = T'
    target: {target}
    weight: .inf
    hoursContract:
      unit: half-hour
      policy: exact"""


def _range(count_shift_types: str, coefficients: str, target: str = "[0, 32]") -> str:
    return f"""  - type: shift count
    person: 0
    countDates: ALL
    countShiftTypes: {count_shift_types}
    countShiftTypeCoefficients:
{coefficients}
    expression: [x >= T, x <= T]
    target: {target}
    weight: .inf
    hoursContract:
      unit: half-hour
      policy: range"""


DE_COEFFS = "      - [D, 16]\n      - [E, 16]"


# --- Valid Exact / Range with dynamic selectors -----------------------------


def test_exact_valid_with_all_selector():
    # `ALL` expands to the worked types only; coefficients cover D and E exactly.
    _df, _sol, score, status = _run(_build(_exact("ALL", DE_COEFFS)))
    assert status == "OPTIMAL"
    assert score == 0  # hard-only: no finite objective contribution


def test_exact_valid_with_group_selector():
    _df, _sol, _score, status = _run(_build(_exact("Work", DE_COEFFS)))
    assert status == "OPTIMAL"


def test_range_valid_with_group_selector():
    _df, _sol, score, status = _run(_build(_range("Work", DE_COEFFS)))
    assert status == "OPTIMAL"
    assert score == 0


def test_exact_valid_with_explicit_leave():
    # LEAVE is a legal marked selector and must carry an explicit coefficient.
    count = _exact("[D, E, LEAVE]", DE_COEFFS + "\n      - [LEAVE, 16]")
    _df, _sol, _score, status = _run(_build(count))
    assert status == "OPTIMAL"


def test_valid_with_nested_ordered_groups():
    shift_types = """  items:
    - id: D
      durationMinutes: 480
    - id: E
      durationMinutes: 480
  groups:
    - id: Morning
      members: [D, E]
    - id: Work
      members: [Morning]"""
    _df, _sol, _score, status = _run(_build(_exact("Work", DE_COEFFS), shift_types))
    assert status == "OPTIMAL"


# --- Invalid policy encoding -------------------------------------------------


@pytest.mark.parametrize(
    ("count", "fragment"),
    [
        # Exact must use scalar `x = T`.
        (
            _exact("Work", DE_COEFFS).replace("expression: 'x = T'", "expression: [x = T]"),
            "must use expression 'x = T'",
        ),
        # Exact must use a scalar target.
        (_exact("Work", DE_COEFFS, target="[0, 32]"), "must use a scalar target"),
        # Range must use exactly the two ordered comparisons.
        (
            _range("Work", DE_COEFFS).replace("expression: [x >= T, x <= T]", "expression: 'x = T'"),
            "must use expression",
        ),
        # Range target must be an ordered [min, max] pair.
        (_range("Work", DE_COEFFS, target="[40, 10]"), "minimum must not exceed maximum"),
        (_range("Work", DE_COEFFS, target="32"), "two-element"),
        # Marked contracts must be hard (.inf weight).
        (_exact("Work", DE_COEFFS).replace("weight: .inf", "weight: -1"), "must use weight '.inf'"),
        # Negative target rejected.
        (_exact("Work", DE_COEFFS, target="-2"), "must be non-negative"),
    ],
)
def test_invalid_policy_encoding_rejected(count, fragment):
    with pytest.raises(ValidationError, match=re.escape(fragment)):
        load_data(_build(count).encode("utf-8"))


# --- Invalid coefficient coverage -------------------------------------------


def test_missing_coefficient_rejected():
    # E selected but only D has a coefficient.
    count = _exact("[D, E]", "      - [D, 16]")
    with pytest.raises(ValidationError, match="coverage is incomplete"):
        load_data(_build(count).encode("utf-8"))


def test_missing_leave_coefficient_rejected():
    count = _exact("[D, E, LEAVE]", DE_COEFFS)  # LEAVE selected but uncovered
    with pytest.raises(ValidationError, match="coverage is incomplete"):
        load_data(_build(count).encode("utf-8"))


def test_extra_coefficient_rejected():
    # Only D selected, but a coefficient is supplied for E as well.
    count = _exact("D", DE_COEFFS)
    with pytest.raises(ValidationError, match="does not correspond to any selected shift type"):
        load_data(_build(count).encode("utf-8"))


def test_duplicate_coefficient_rejected():
    count = _exact("[D, E]", DE_COEFFS + "\n      - [D, 20]")
    with pytest.raises(ValidationError, match=re.escape("Duplicate contracted-hours coefficient for 'D'")):
        load_data(_build(count).encode("utf-8"))


def test_group_coefficient_id_rejected():
    count = _exact("Work", "      - [Work, 16]")
    with pytest.raises(ValidationError, match="must be a concrete shift type or 'LEAVE'"):
        load_data(_build(count).encode("utf-8"))


def test_all_coefficient_id_rejected():
    count = _exact("ALL", "      - [ALL, 16]")
    with pytest.raises(ValidationError, match="must be a concrete shift type or 'LEAVE'"):
        load_data(_build(count).encode("utf-8"))


def test_off_selector_rejected():
    count = _exact("[D, E, OFF]", DE_COEFFS + "\n      - [OFF, 16]")
    with pytest.raises(ValidationError, match=re.escape("'OFF' is not allowed")):
        load_data(_build(count).encode("utf-8"))


def test_non_positive_coefficient_rejected():
    count = _exact("[D, E]", "      - [D, 16]\n      - [E, 0]")
    with pytest.raises(ValidationError, match="must be at least 1"):
        load_data(_build(count).encode("utf-8"))


def test_empty_group_expansion_rejected():
    shift_types = """  items:
    - id: D
      durationMinutes: 480
  groups:
    - id: Nothing
      members: []"""
    count = _exact("Nothing", "      - [D, 16]")
    with pytest.raises(ValidationError, match="must select at least one shift type"):
        load_data(_build(count, shift_types).encode("utf-8"))


def test_unknown_selector_rejected():
    count = _exact("ZZZ", "      - [D, 16]")
    with pytest.raises(ValidationError, match="Unknown shift type ID: ZZZ"):
        load_data(_build(count).encode("utf-8"))


# --- Group membership sensitivity (Refresh-until-valid, DL09 D5/D12) --------


def test_group_membership_change_invalidates_stale_coverage():
    # Same D/E coefficients, but the group now also contains N: the expansion
    # grows and the stale coverage is rejected until the author refreshes it.
    shift_types = """  items:
    - id: D
      durationMinutes: 480
    - id: E
      durationMinutes: 480
    - id: N
      durationMinutes: 480
  groups:
    - id: Work
      members: [D, E, N]"""
    with pytest.raises(ValidationError, match="coverage is incomplete"):
        load_data(_build(_exact("Work", DE_COEFFS), shift_types).encode("utf-8"))


# --- Deterministic ordered-map failure precedence ---------------------------


def test_forward_reference_reported_before_cycle():
    # A and B reference each other. Built in definition order, group A's
    # reference to the not-yet-defined B fails first — the forward reference is
    # authoritative over any later whole-graph cycle label.
    shift_types = """  items:
    - id: D
      durationMinutes: 480
  groups:
    - id: A
      members: [B]
    - id: B
      members: [A]"""
    with pytest.raises(ValidationError, match=re.escape("Shift type group 'A' references undefined")) as exc:
        load_data(_build(_exact("A", "      - [D, 16]"), shift_types).encode("utf-8"))
    assert "'B'" in str(exc.value)


# --- Validator-vs-scheduler expansion parity + distinct Range identifiers ----


def test_validator_matches_scheduler_expansion_and_range_ids(monkeypatch):
    shift_types = """  items:
    - id: D
      durationMinutes: 480
    - id: E
      durationMinutes: 480
  groups:
    - id: Morning
      members: [D, E]
    - id: Work
      members: [Morning]"""
    scenario = _build(_range("Work", DE_COEFFS), shift_types)

    captured = {}
    original = preference_types.shift_count

    def spy(ctx, preference, preference_idx):
        original(ctx, preference, preference_idx)
        if preference.hoursContract is not None:
            captured["map_sid_s"] = dict(ctx.map_sid_s)
            captured["model_vars"] = list(ctx.model_vars.keys())
            captured["reports"] = [report.description for report in ctx.reports]

    monkeypatch.setitem(preference_types.PREFERENCE_TYPES_TO_FUNC, models.SHIFT_COUNT, spy)
    _df, _sol, _score, status = _run(scenario)
    assert status == "OPTIMAL"

    # Parity: the load-time validator builds the identical ordered map the
    # scheduler used to construct the model.
    data = load_data(scenario.encode("utf-8"))
    expected_map = group_map.build_shift_type_index_map(data.shiftTypes.items, data.shiftTypes.groups)
    assert captured["map_sid_s"] == expected_map

    # Distinct identifiers: the two Range boundaries get their own model
    # variables and reports via the expression-pair index (no collision).
    expr_vars = [name for name in captured["model_vars"] if name.endswith("_expr")]
    assert any("pair_0" in name for name in expr_vars)
    assert any("pair_1" in name for name in expr_vars)
    assert len(expr_vars) == len(set(expr_vars))
    assert len(captured["reports"]) == len(set(captured["reports"]))


# --- Negative cleanup gate: retired unit fails, does not fall back to generic -


def test_retired_unit_marked_payload_fails():
    # An old `unit: hour` marked payload is rejected outright — there is no
    # compatibility branch that silently drops the marker to a generic count.
    count = _exact("Work", DE_COEFFS).replace("unit: half-hour", "unit: hour")
    with pytest.raises(ValidationError):
        load_data(_build(count).encode("utf-8"))


# --- Generic (unmarked) shift counts retain their full behavior --------------


def test_unmarked_count_keeps_default_coefficients_and_expressions():
    # No hoursContract: `ALL` with no coefficients (generic default 1) and the
    # squared expression with a soft weight both remain valid — none of the
    # marked-only restrictions apply.
    count = """  - type: shift count
    person: 0
    countDates: ALL
    countShiftTypes: ALL
    expression: "|x - T|^2"
    target: 1
    weight: -1"""
    _df, _sol, _score, status = _run(_build(count))
    assert status == "OPTIMAL"
