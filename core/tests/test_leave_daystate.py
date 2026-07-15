"""Focused tests for the first-class LEAVE day-state (Option C).

These assert the three leave invariants directly, rather than via the
snapshot-based regression harness (which also requires a unique optimal
solution that a symmetric scheduling scenario does not have):

  INV1  Leave is input-only: the solver never invents leave. Only the
        (person, date) cells pinned by a LEAVE shift request render "Leave".
  INV2  Leave provides no coverage: a nurse on leave does not satisfy any
        shift-type requirement, so someone else must cover.
  INV3  Leave is always honored: a LEAVE shift request is a hard pin.

Plus the shift-count hour credit and the coverage-forbid validation rules.
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


def _run(yaml_text: str):
    df, solution, score, status, _cell_export_info = nurse_scheduling.schedule(yaml_text.encode("utf-8"))
    return df, status


def _cell(df, person_row: int, date_col: int):
    # Non-prettify layout: 2 leading rows (day number, weekday), 1 leading
    # column (person id), no history columns.
    return df.iloc[2 + person_row, 1 + date_col]


def _count_leave_cells(df) -> int:
    return int((df == "Leave").to_numpy().sum())


# --- INV1 (input-only) + INV2 (no coverage) + INV3 (honored) + rendering ---
LEAVE_COVERAGE_SCENARIO = """
apiVersion: alpha
description: Leave honored, excluded from coverage, never invented
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-04
people:
  items:
    - id: 0
    - id: 1
shiftTypes:
  items:
    - id: D
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    description: Exactly one nurse on D every date
    shiftType: D
    requiredNumPeople: 1
  - type: shift request
    description: Nurse 0 on paid leave Feb 2 (hard pin)
    person: 0
    date: 2
    shiftType: LEAVE
    weight: .inf
"""


def test_leave_is_honored_excluded_from_coverage_and_not_invented():
    df, status = _run(LEAVE_COVERAGE_SCENARIO)
    assert status in ("OPTIMAL", "FEASIBLE")

    # INV3: the pinned leave day renders "Leave".
    assert _cell(df, person_row=0, date_col=1) == "Leave"

    # INV1: leave is not invented anywhere else. Exactly one "Leave" cell.
    assert _count_leave_cells(df) == 1

    # INV2: nurse 0 provides no coverage on the leave day, so nurse 1 must be
    # the single required person on D that date.
    assert _cell(df, person_row=1, date_col=1) == "D"


# --- Hour credit: leave contributes its credited hours to a shift count. ---
LEAVE_HOURS_SCENARIO = """
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
    description: >-
      Worked hours + paid-leave credit must equal exactly 16h (32 half-hours).
      Only reachable if the leave day credits 16 half-hours.
    person: 0
    countDates: ALL
    countShiftTypes: [D, LEAVE]
    countShiftTypeCoefficients:
      - [D, 16]
      - [LEAVE, 16]
    expression: 'x = T'
    target: 32
    weight: .inf
"""


def test_leave_credits_hours_toward_shift_count():
    df, status = _run(LEAVE_HOURS_SCENARIO)
    # If leave credited 0 (like OFF), x would be 16 != 32 and the hard exact
    # target would be infeasible. OPTIMAL proves the 16-half-hour leave credit.
    assert status == "OPTIMAL"
    assert _cell(df, person_row=0, date_col=0) == "Leave"
    assert _cell(df, person_row=0, date_col=1) == "D"


# --- Validation: LEAVE forbidden as a reserved id and in coverage rules. ---
LEAVE_AS_SHIFT_TYPE_SCENARIO = """
apiVersion: alpha
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-01
people:
  items:
    - id: 0
shiftTypes:
  items:
    - id: LEAVE
preferences:
  - type: at most one shift per day
"""

LEAVE_IN_REQUIREMENT_SCENARIO = """
apiVersion: alpha
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-01
people:
  items:
    - id: 0
shiftTypes:
  items:
    - id: D
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: LEAVE
    requiredNumPeople: 1
"""

LEAVE_IN_COVERING_SCENARIO = """
apiVersion: alpha
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-01
people:
  items:
    - id: 0
    - id: 1
shiftTypes:
  items:
    - id: D
preferences:
  - type: at most one shift per day
  - type: shift type covering
    preceptors: [0]
    preceptees: [1]
    shiftTypes: [LEAVE]
"""


def test_leave_cannot_be_a_user_shift_type():
    with pytest.raises(ValueError, match="reserved"):
        _run(LEAVE_AS_SHIFT_TYPE_SCENARIO)


def test_leave_forbidden_in_shift_type_requirement():
    with pytest.raises(ValueError, match="LEAVE"):
        _run(LEAVE_IN_REQUIREMENT_SCENARIO)


def test_leave_forbidden_in_shift_type_covering():
    with pytest.raises(ValueError, match="LEAVE"):
        _run(LEAVE_IN_COVERING_SCENARIO)


# --- ALL excludes leave (INV2) in shift type successions, not just coverage. ---
LEAVE_DOES_NOT_SATISFY_ALL_SUCCESSION_SCENARIO = """
apiVersion: alpha
description: A pinned leave day must not satisfy a hard 'work any shift' (ALL) succession
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-01
people:
  items:
    - id: 0
shiftTypes:
  items:
    - id: D
preferences:
  - type: at most one shift per day
  - type: shift request
    description: Nurse 0 on paid leave Feb 1 (hard pin)
    person: 0
    date: 1
    shiftType: LEAVE
    weight: .inf
  - type: shift type successions
    description: Nurse 0 must work any shift (ALL) - a leave day must NOT satisfy this
    person: 0
    pattern: [ALL]
    weight: .inf
"""


def test_leave_does_not_satisfy_all_succession():
    # The leave pin forces leaves==1; the hard ALL succession forces a worked
    # shift. Since ALL excludes leave, these conflict and the model is infeasible.
    _df, status = _run(LEAVE_DOES_NOT_SATISFY_ALL_SUCCESSION_SCENARIO)
    assert status == "INFEASIBLE"


# ===========================================================================
# R1-R4: characterization regressions locking the confirmed LEAVE contract
# (contract C1-C4). Every test carries a discriminating observable so it
# cannot pass without proving its claim. See the `leave-daystate-contract`
# and `guard-tech-plan` (Part 2) planning artifacts.
# ===========================================================================


# --- R1: C3 - a no-LEAVE config never activates leave. ---------------------
# Single-nurse roster: D is required on Feb 1, nothing is required on Feb 2,
# and no LEAVE is ever requested. Feb 2 is unconstrained (worked or OFF are
# equally optimal), so this test asserts only the invariant that matters: no
# cell may render "Leave".
R1_NO_LEAVE_SCENARIO = """
apiVersion: alpha
description: No LEAVE request anywhere - leave must never be activated (C3)
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
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    description: Nurse 0 works D on Feb 1
    shiftType: D
    date: 1
    requiredNumPeople: 1
"""


def test_r1_no_leave_config_never_activates_leave():
    df, status = _run(R1_NO_LEAVE_SCENARIO)
    assert status == "OPTIMAL"
    # Discriminating observable: zero "Leave" cells. This is exactly what C3
    # claims - with no LEAVE request anywhere, nothing activates leave. We do
    # NOT assert the D/OFF placement: Feb 2 is unconstrained, so D-then-OFF and
    # D-then-D are both optimal and the specific layout rides on solver
    # tie-breaking. The leave count is the invariant that does not.
    assert _count_leave_cells(df) == 0


# --- R2: C4 - OFF credits 0h, LEAVE credits its coefficient. ---------------
# One worked D (16), one pinned LEAVE, one pinned OFF, and a hard exact hours
# target of 32 over a count that lists D + LEAVE (OFF absent). The target is
# reachable only if LEAVE credits 16 AND the OFF day credits nothing: worked
# 16 + leave 16 + off 0 == 32.
R2_OFF_VS_LEAVE_SCENARIO = """
apiVersion: alpha
description: OFF credits 0h while LEAVE credits its coefficient (C4)
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-03
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
    description: Nurse 0 works D on Feb 1
    shiftType: D
    date: 1
    requiredNumPeople: 1
  - type: shift request
    description: Nurse 0 on paid leave Feb 2 (hard pin)
    person: 0
    date: 2
    shiftType: LEAVE
    weight: .inf
  - type: shift request
    description: Nurse 0 off Feb 3 (hard pin)
    person: 0
    date: 3
    shiftType: OFF
    weight: .inf
  - type: shift count
    description: >-
      Worked hours + paid-leave credit must equal exactly 32 half-hours.
      OFF (Feb 3) is not listed, so it must contribute 0.
    person: 0
    countDates: ALL
    countShiftTypes: [D, LEAVE]
    countShiftTypeCoefficients:
      - [D, 16]
      - [LEAVE, 16]
    expression: 'x = T'
    target: 32
    weight: .inf
"""

# Discriminator variant: identical, but LEAVE is dropped from the count so it
# credits 0 (the backend rejects an explicit coefficient of 0, so absence is
# how "leave credits nothing" is expressed). x then equals 16 != 32.
R2_OFF_VS_LEAVE_UNCREDITED = """
apiVersion: alpha
description: Same roster, LEAVE uncredited - the hard target becomes infeasible
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-03
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
    description: Nurse 0 works D on Feb 1
    shiftType: D
    date: 1
    requiredNumPeople: 1
  - type: shift request
    description: Nurse 0 on paid leave Feb 2 (hard pin)
    person: 0
    date: 2
    shiftType: LEAVE
    weight: .inf
  - type: shift request
    description: Nurse 0 off Feb 3 (hard pin)
    person: 0
    date: 3
    shiftType: OFF
    weight: .inf
  - type: shift count
    person: 0
    countDates: ALL
    countShiftTypes: [D]
    countShiftTypeCoefficients:
      - [D, 16]
    expression: 'x = T'
    target: 32
    weight: .inf
"""


def test_r2_off_credits_zero_leave_credits_coefficient():
    df, status = _run(R2_OFF_VS_LEAVE_SCENARIO)
    # OPTIMAL at target 32 proves D credited 16, LEAVE credited 16, OFF 0.
    assert status == "OPTIMAL"
    assert _cell(df, person_row=0, date_col=0) == "D"
    assert _cell(df, person_row=0, date_col=1) == "Leave"
    assert _cell(df, person_row=0, date_col=2) == ""  # OFF, contributes 0h
    assert _count_leave_cells(df) == 1

    # Discriminating observable: with the LEAVE credit removed the same hard
    # target is unreachable. This is what pins "LEAVE credits its coefficient"
    # rather than merely "the scenario happens to be OPTIMAL".
    _df, status_uncredited = _run(R2_OFF_VS_LEAVE_UNCREDITED)
    assert status_uncredited == "INFEASIBLE"


# --- R3: the footgun - omitting LEAVE from the count costs one worked shift.
# Nurse 0 is pinned on LEAVE Feb 1, then a hard 48-half-hour target over a
# count that lists ONLY D (LEAVE omitted - the footgun). Feb 2-4 are the only
# workable days, so she must work all three (3 x 16 == 48). Had LEAVE been
# credited (16), 48 would need only two worked D days - the omission forces
# exactly one extra worked shift. Characterization of current behavior, not a
# backend defect; it is the behavior the frontend guard is meant to catch.
R3_UNCREDITED_LEAVE_SCENARIO = """
apiVersion: alpha
description: LEAVE omitted from the hours count forces one extra worked shift
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-04
people:
  items:
    - id: 0
shiftTypes:
  items:
    - id: D
      description: 8h day shift
preferences:
  - type: at most one shift per day
  - type: shift request
    description: Nurse 0 on paid leave Feb 1 (hard pin)
    person: 0
    date: 1
    shiftType: LEAVE
    weight: .inf
  - type: shift count
    description: >-
      Hard 48 half-hours from worked shifts only - LEAVE is deliberately
      absent, so paid leave credits nothing toward the contract.
    person: 0
    countDates: ALL
    countShiftTypes: [D]
    countShiftTypeCoefficients:
      - [D, 16]
    expression: 'x = T'
    target: 48
    weight: .inf
"""


def test_r3_uncredited_leave_forces_extra_worked_shift():
    df, status = _run(R3_UNCREDITED_LEAVE_SCENARIO)
    assert status == "OPTIMAL"
    # Discriminating observable: the pinned leave day plus three worked D
    # days. If leave had credited 16 the count would be satisfied by two D
    # days; the uncredited config forces the third. Assert both exact counts.
    row = [_cell(df, person_row=0, date_col=c) for c in range(4)]
    assert row.count("D") == 3
    assert _count_leave_cells(df) == 1


# --- R4: end-to-end - the 160h LEAVE credit is load-bearing (C1+C2+C4). ----
# Half-hour coefficients of the worked shift types in the 160h prototype.
# LEAVE is intentionally excluded: R4's observable is nurse 0's *worked*
# coefficient total, which the credit shifts between 288 and 320.
_PROTOTYPE_WORKED_COEFFICIENTS = {
    "LD": 25,
    "AM1": 14,
    "AM2": 16,
    "AM3": 18,
    "PM1": 18,
    "PM2": 16,
    "PM3": 14,
}


def _prototype_yaml_path() -> str:
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(repo_root, "prototype", "leave_daystate_160h.yaml")


def _nurse_worked_total(df, person_row: int, num_dates: int) -> int:
    """Sum the half-hour coefficients of nurse `person_row`'s solved worked
    shifts. LEAVE and OFF cells contribute 0 (they are not worked shifts)."""
    return sum(_PROTOTYPE_WORKED_COEFFICIENTS.get(_cell(df, person_row, c), 0) for c in range(num_dates))


def test_r4_prototype_160h_leave_credit_is_load_bearing():
    with open(_prototype_yaml_path(), "rb") as f:
        yaml_bytes = f.read()

    # Baseline: LEAVE is credited 16 in the 160h count. Each nurse's hard
    # total is 320 half-hours; nurse 0's two pinned leave days credit 32, so
    # her worked shifts must sum to exactly 288.
    df, _solution, _score, status, _cell_export_info = nurse_scheduling.schedule(yaml_bytes)
    num_dates = 28  # Feb 2026
    assert status == "OPTIMAL"
    assert _count_leave_cells(df) == 2
    assert _nurse_worked_total(df, person_row=0, num_dates=num_dates) == 288

    # Mutated variant, constructed in-test: drop LEAVE from the 160h count so
    # paid leave credits nothing. The model stays OPTIMAL (feasibility is not
    # the signal) but nurse 0 must now reach 320 half-hours from worked shifts
    # alone - the 288 -> 320 delta is what proves the credit is load-bearing.
    #
    # ruamel.yaml (YAML 1.2) mirrors the engine's loader; PyYAML would
    # mis-parse `countShiftTypes: OFF` as the boolean False.
    from io import BytesIO, StringIO

    from ruamel.yaml import YAML

    ruamel = YAML(typ="safe")
    data = ruamel.load(BytesIO(yaml_bytes))
    mutated = False
    for pref in data["preferences"]:
        count_shift_types = pref.get("countShiftTypes")
        if pref.get("type") == "shift count" and isinstance(count_shift_types, list) and "LEAVE" in count_shift_types:
            pref["countShiftTypes"] = [s for s in count_shift_types if s != "LEAVE"]
            pref["countShiftTypeCoefficients"] = [c for c in pref["countShiftTypeCoefficients"] if c[0] != "LEAVE"]
            mutated = True
    assert mutated, "expected a 160h shift-count listing LEAVE to mutate"

    buf = StringIO()
    ruamel.dump(data, buf)
    df_mut, _s, _sc, status_mut, _c = nurse_scheduling.schedule(buf.getvalue().encode("utf-8"))
    assert status_mut == "OPTIMAL"
    assert _count_leave_cells(df_mut) == 2  # leave is still pinned (C1), still no coverage (C2)
    assert _nurse_worked_total(df_mut, person_row=0, num_dates=num_dates) == 320
