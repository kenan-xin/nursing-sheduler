"""Tests for the durable, authoring-only working-time fields on `ShiftType`.

`startTime` / `endTime` ("HH:MM" clock times) and `restMinutes` (unpaid break)
are persisted alongside `durationMinutes` so the frontend can derive the paid
working minutes and keep them editable on reopen (WT1). They round-trip through
the YAML posted to `schedule()`, but the solver reads nothing from them, so
adding them must not change any scheduling behavior. These tests assert:

  1. The new fields are accepted and round-trip through load + YAML.
  2. A scenario with and without the time fields solves identically.
  3. A legacy `durationMinutes`-only shift type still loads + solves unchanged.
  4. Malformed values are rejected (bad time format, wrong type, extra key).
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
from nurse_scheduling.loader import load_data
from nurse_scheduling.models import ShiftType
from pydantic import ValidationError
from ruamel.yaml import YAML
from io import BytesIO, StringIO


def _run(yaml_text: str):
    df, solution, score, status, _cell_export_info = nurse_scheduling.schedule(yaml_text.encode("utf-8"))
    return df, solution, score, status


# A minimal solvable scenario. The `{shiftFields}` slot fills in the extra
# working-time fields on shift type D per-variant below.
SCENARIO = """
apiVersion: alpha
description: Minimal solve for shift-type working-time field parity
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
      description: 8h day shift{shiftFields}
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    description: Nurse 0 works D on Feb 2
    shiftType: D
    date: 2
    requiredNumPeople: 1
"""

LEGACY_DURATION_ONLY = SCENARIO.format(shiftFields="\n      durationMinutes: 480")
WITH_TIME_FIELDS = SCENARIO.format(
    shiftFields=(
        "\n      durationMinutes: 480\n      startTime: '08:00'\n      endTime: '17:00'\n      restMinutes: 60"
    )
)
WITHOUT_ANY_FIELDS = SCENARIO.format(shiftFields="")


# --- Schema-level: acceptance, round-trip, rejection ---


def test_time_fields_accepted():
    st = ShiftType(id="D", startTime="08:00", endTime="17:00", restMinutes=60, durationMinutes=480)
    assert st.startTime == "08:00"
    assert st.endTime == "17:00"
    assert st.restMinutes == 60
    assert st.durationMinutes == 480


def test_time_fields_optional_default_none():
    st = ShiftType(id="D")
    assert st.startTime is None
    assert st.endTime is None
    assert st.restMinutes is None
    assert st.durationMinutes is None


def test_time_fields_round_trip_through_yaml():
    # Load the scenario, re-dump the shift type to YAML, reload it, and confirm
    # the working-time fields survive unchanged.
    data = load_data(WITH_TIME_FIELDS.encode("utf-8"))
    shift_type = data.shiftTypes.items[0]

    yaml = YAML(typ="safe")
    buf = StringIO()
    yaml.dump(shift_type.model_dump(exclude_none=True), buf)
    reloaded = ShiftType(**yaml.load(BytesIO(buf.getvalue().encode("utf-8"))))

    assert reloaded == shift_type
    assert reloaded.startTime == "08:00"
    assert reloaded.endTime == "17:00"
    assert reloaded.restMinutes == 60
    assert reloaded.durationMinutes == 480


@pytest.mark.parametrize("bad_time", ["8:00", "24:00", "08:60", "0800", "08:00:00", "morning"])
def test_bad_time_format_rejected(bad_time):
    with pytest.raises(ValidationError):
        ShiftType(id="D", startTime=bad_time)


def test_wrong_typed_time_field_rejected():
    # An integer is not a valid "HH:MM" string (pydantic does not coerce).
    with pytest.raises(ValidationError):
        ShiftType(id="D", startTime=800)


def test_wrong_typed_rest_minutes_rejected():
    with pytest.raises(ValidationError):
        ShiftType(id="D", restMinutes="sixty")


def test_extra_shift_type_key_rejected():
    with pytest.raises(ValidationError):
        ShiftType(id="D", breakMinutes=60)


# --- Grid invariant (DL09 D7 / C1 CON-YAML-26): accepted shapes --------------


def test_bare_duration_grid_valid_accepted():
    st = ShiftType(id="D", durationMinutes=450)  # 7.5h, divisible by 30
    assert st.durationMinutes == 450
    assert st.startTime is None and st.endTime is None and st.restMinutes is None


def test_clock_without_rest_accepted():
    # Absent rest means zero; paid duration equals the full span.
    st = ShiftType(id="D", startTime="08:00", endTime="16:30", durationMinutes=510)
    assert st.restMinutes is None
    assert st.durationMinutes == 510


def test_explicit_zero_rest_canonicalized_to_omission():
    # `restMinutes: 0` is accepted at the input boundary but stored as omission.
    st = ShiftType(id="D", startTime="08:00", endTime="16:00", restMinutes=0, durationMinutes=480)
    assert st.restMinutes is None
    assert st.durationMinutes == 480


def test_overnight_shift_accepted():
    # An earlier end time means the shift crosses midnight (+24h): 22:00 -> 06:00
    # is an 8h span; with a 30m rest the paid duration is 450.
    st = ShiftType(id="N", startTime="22:00", endTime="06:00", restMinutes=30, durationMinutes=450)
    assert st.durationMinutes == 450


# --- Grid invariant: rejected shapes -----------------------------------------


@pytest.mark.parametrize("bad_grid_time", ["08:15", "08:45", "12:01"])
def test_off_grid_clock_time_rejected(bad_grid_time):
    with pytest.raises(ValidationError):
        ShiftType(id="D", startTime=bad_grid_time, endTime="16:00", durationMinutes=480)


def test_start_only_rejected():
    with pytest.raises(ValidationError, match="must be provided together"):
        ShiftType(id="D", startTime="08:00", durationMinutes=480)


def test_end_only_rejected():
    with pytest.raises(ValidationError, match="must be provided together"):
        ShiftType(id="D", endTime="16:00", durationMinutes=480)


def test_rest_only_rejected():
    with pytest.raises(ValidationError, match="restMinutes requires startTime and endTime"):
        ShiftType(id="D", restMinutes=30, durationMinutes=480)


def test_equal_start_end_rejected():
    with pytest.raises(ValidationError, match="must differ"):
        ShiftType(id="D", startTime="08:00", endTime="08:00", durationMinutes=480)


def test_clock_without_duration_rejected():
    with pytest.raises(ValidationError, match="durationMinutes is required"):
        ShiftType(id="D", startTime="08:00", endTime="16:00")


def test_duration_disagreement_rejected():
    # 08:00-16:00 span 480, rest 60 -> paid 420, but durationMinutes says 480.
    with pytest.raises(ValidationError, match="must equal the paid working minutes"):
        ShiftType(id="D", startTime="08:00", endTime="16:00", restMinutes=60, durationMinutes=480)


def test_rest_not_less_than_span_rejected():
    # 08:00-09:00 span 60, rest 60 is not strictly less than the span.
    with pytest.raises(ValidationError, match="less than the shift span"):
        ShiftType(id="D", startTime="08:00", endTime="09:00", restMinutes=60, durationMinutes=0)


def test_rest_off_grid_rejected():
    with pytest.raises(ValidationError, match="multiple of 30"):
        ShiftType(id="D", startTime="08:00", endTime="16:00", restMinutes=45, durationMinutes=435)


@pytest.mark.parametrize("bad_duration", [0, -30, 450 - 15])
def test_bare_non_positive_or_off_grid_duration_rejected(bad_duration):
    with pytest.raises(ValidationError):
        ShiftType(id="D", durationMinutes=bad_duration)


# --- Solver-inert: parity with/without the fields, legacy unchanged ---


def test_time_fields_do_not_change_scheduling():
    # Accept-and-ignore: the solver reads nothing from the working-time fields,
    # so a scenario with and without them must produce an identical solve.
    df_without, sol_without, score_without, status_without = _run(LEGACY_DURATION_ONLY)
    df_with, sol_with, score_with, status_with = _run(WITH_TIME_FIELDS)

    assert status_with == status_without == "OPTIMAL"
    assert score_with == score_without
    assert sol_with == sol_without
    assert df_with.equals(df_without)


def test_legacy_duration_only_matches_bare_shift_type():
    # A bare shift type and a legacy `durationMinutes`-only one both load and
    # solve identically — no forced re-authoring.
    df_bare, sol_bare, score_bare, status_bare = _run(WITHOUT_ANY_FIELDS)
    df_legacy, sol_legacy, score_legacy, status_legacy = _run(LEGACY_DURATION_ONLY)

    assert status_legacy == status_bare == "OPTIMAL"
    assert score_legacy == score_bare
    assert sol_legacy == sol_bare
    assert df_legacy.equals(df_bare)
