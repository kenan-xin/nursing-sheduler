"""Tests for the ShiftTypeCoveringPreference model."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nurse_scheduling
from nurse_scheduling.models import ShiftTypeCoveringPreference, SHIFT_TYPE_COVERING


def test_shift_type_covering_preference_basic_construction():
    """A minimal-valid rule parses and exposes the fields."""
    pref = ShiftTypeCoveringPreference(
        preceptors=["Anna"],
        preceptees=["Lil"],
        shiftTypes=["D"],
    )
    assert pref.type == SHIFT_TYPE_COVERING
    assert pref.preceptors == ["Anna"]
    assert pref.preceptees == ["Lil"]
    assert pref.shiftTypes == ["D"]
    assert pref.weight == 1  # default


def test_shift_type_covering_supports_description():
    pref = ShiftTypeCoveringPreference(
        description="Lil must always be paired with Anna",
        preceptors=["Anna", "Beth"],
        preceptees=["Lil"],
        shiftTypes=["D"],
    )
    assert pref.description == "Lil must always be paired with Anna"


def test_shift_type_covering_supports_nested_preceptor_lists():
    """Nested preceptor lists (groups-of-groups) must be supported in the model
    layer; the solver flattens them at encoding time."""
    pref = ShiftTypeCoveringPreference(
        preceptors=[["seniors_a"], ["seniors_b"]],
        preceptees=["Lil"],
        shiftTypes=[["Day"], ["Evening"]],
    )
    assert pref.preceptors == [["seniors_a"], ["seniors_b"]]
    assert pref.shiftTypes == [["Day"], ["Evening"]]


def test_shift_type_covering_accepts_infinity_weight():
    """Float ±∞ should validate (consistent with other preferences)."""
    pref_pos = ShiftTypeCoveringPreference(
        preceptors=["Anna"],
        preceptees=["Lil"],
        shiftTypes=["D"],
        weight=float("inf"),
    )
    pref_neg = ShiftTypeCoveringPreference(
        preceptors=["Anna"],
        preceptees=["Lil"],
        shiftTypes=["D"],
        weight=float("-inf"),
    )
    assert pref_pos.weight == float("inf")
    assert pref_neg.weight == float("-inf")


def test_shift_type_covering_rejects_non_infinity_floats():
    """Per project convention: float weights must be ±inf or be int."""
    import pytest

    with pytest.raises(ValueError):
        ShiftTypeCoveringPreference(
            preceptors=["Anna"],
            preceptees=["Lil"],
            shiftTypes=["D"],
            weight=0.5,  # not ±inf
        )


def test_shift_type_covering_rejects_extra_fields():
    from pydantic import ValidationError
    import pytest

    with pytest.raises(ValidationError):
        ShiftTypeCoveringPreference(
            preceptors=["Anna"],
            preceptees=["Lil"],
            shiftTypes=["D"],
            unknown_field="x",
        )


# --- Scheduler integration: an omitted `date` must default to all dates. ---
def _run(yaml_text: str):
    df, _solution, _score, status, _cell_export_info = nurse_scheduling.schedule(yaml_text.encode("utf-8"))
    return df, status


def _cell(df, person_row: int, date_col: int):
    # Non-prettify layout: 2 leading rows (day number, weekday), 1 leading
    # column (person id), no history columns.
    return df.iloc[2 + person_row, 1 + date_col]


# Two dates, one D slot per date (exact). The preceptee (person 1) is pulled
# toward D by a positive request. The covering rule omits `date`, so it must
# apply to EVERY date: a preceptee on D requires a preceptor on D too, but the
# single exact D slot can only hold one person. Therefore the preceptee can
# never take D and the preceptor must cover it on both days.
COVERING_NO_DATE_APPLIES_TO_ALL_DATES = """
apiVersion: alpha
description: A covering rule without a date field must apply to all dates
dates:
  range:
    startDate: 2026-02-01
    endDate: 2026-02-02
people:
  items:
    - id: preceptor
    - id: preceptee
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
    description: Preceptee would like D every day (pulls them onto D unless covered)
    person: preceptee
    date: [ALL]
    shiftType: [D]
    weight: 5
  - type: shift type covering
    description: A preceptee on D requires a preceptor on D (no date -> all dates)
    preceptors: [preceptor]
    preceptees: [preceptee]
    shiftTypes: [D]
"""


def test_shift_type_covering_without_date_applies_to_all_dates():
    df, status = _run(COVERING_NO_DATE_APPLIES_TO_ALL_DATES)
    assert status == "OPTIMAL"
    # The covering rule fires on every date: the preceptee is never left on D
    # without a preceptor, so the single D slot goes to the preceptor both days.
    assert _cell(df, person_row=0, date_col=0) == "D"
    assert _cell(df, person_row=0, date_col=1) == "D"
    assert _cell(df, person_row=1, date_col=0) != "D"
    assert _cell(df, person_row=1, date_col=1) != "D"
