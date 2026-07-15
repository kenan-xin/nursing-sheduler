"""Tests for the authoring-only `hoursContract` marker on shift counts.

`hoursContract` marks a shift count as a fixed half-hour contracted-hours
contract (DL09 D1/D4). It is `{unit: "half-hour", policy: "exact"|"range"}` with
`extra="forbid"`, and the solver reads nothing from it, so adding valid metadata
must not change any scheduling behavior. Cross-field / coverage validation of
marked contracts lives in `test_hours_contract_validation.py`; this file covers:

  1. A scenario with and without a valid `hoursContract` solves identically.
  2. Valid `{unit, policy}` metadata is accepted by Pydantic.
  3. Malformed metadata is rejected (missing field, retired unit, extra key).
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
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nurse_scheduling
import pytest
from nurse_scheduling.models import HoursContractMetadata
from pydantic import ValidationError


def _run(yaml_text: str):
    df, solution, score, status, _cell_export_info = nurse_scheduling.schedule(yaml_text.encode("utf-8"))
    return df, solution, score, status


# A scenario whose shift count is exactly the kind an author would mark as an
# hours contract. The `{hoursContract}` slot is filled in per-variant below.
HOURS_CONTRACT_SCENARIO = """
apiVersion: alpha
description: Exact monthly hours only reachable if leave credits 8h (16 half-hours)
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-02
people:
  items:
    - id: 0
shiftTypes:
  items:
    - id: D
      description: 8h day shift
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    description: Nurse 0 works D on Feb 2
    shiftType: D
    date: 2
    requiredNumPeople: 1
  - type: shift request
    description: Nurse 0 on paid leave Feb 1 (hard pin)
    person: 0
    date: 1
    shiftType: LEAVE
    weight: .inf
  - type: shift count
    description: Worked hours + paid-leave credit must equal exactly 32 half-hours.
    person: 0
    countDates: ALL
    countShiftTypes: [D, LEAVE]
    countShiftTypeCoefficients:
      - [D, 16]
      - [LEAVE, 16]
    expression: 'x = T'
    target: 32
    weight: .inf{hoursContract}
"""

WITHOUT_FIELD = HOURS_CONTRACT_SCENARIO.format(hoursContract="")
WITH_FIELD = HOURS_CONTRACT_SCENARIO.format(
    hoursContract="\n    hoursContract:\n      unit: half-hour\n      policy: exact"
)


def test_hours_contract_field_does_not_change_scheduling():
    # Accept-and-ignore: the solver reads nothing from `hoursContract`, so a
    # scenario with and without it must produce an identical solve.
    df_without, sol_without, score_without, status_without = _run(WITHOUT_FIELD)
    df_with, sol_with, score_with, status_with = _run(WITH_FIELD)

    assert status_with == status_without == "OPTIMAL"
    assert score_with == score_without
    assert sol_with == sol_without
    assert df_with.equals(df_without)


@pytest.mark.parametrize("policy", ["exact", "range"])
def test_valid_metadata_accepted(policy):
    meta = HoursContractMetadata(unit="half-hour", policy=policy)
    assert meta.unit == "half-hour"
    assert meta.policy == policy


def test_valid_hours_contract_accepted_in_full_scenario():
    # A full solve must not reject the valid nested metadata.
    _df, _sol, _score, status = _run(WITH_FIELD)
    assert status == "OPTIMAL"


def test_missing_unit_rejected():
    with pytest.raises(ValidationError):
        HoursContractMetadata(policy="exact")


def test_missing_policy_rejected():
    with pytest.raises(ValidationError):
        HoursContractMetadata(unit="half-hour")


@pytest.mark.parametrize("unit", ["hour", "minute", "minutes", "half_hour"])
def test_retired_or_bad_unit_rejected(unit):
    # The retired "hour"/"minute" units (and any other value) are rejected:
    # there is no compatibility branch, only the fixed "half-hour".
    with pytest.raises(ValidationError):
        HoursContractMetadata(unit=unit, policy="exact")


def test_bad_policy_rejected():
    with pytest.raises(ValidationError):
        HoursContractMetadata(unit="half-hour", policy="flexible")


def test_extra_nested_key_rejected():
    with pytest.raises(ValidationError):
        HoursContractMetadata(unit="half-hour", policy="exact", precision="high")
