"""Tests for the ShiftTypeCoveringPreference model."""
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
    assert pref.weight == 1   # default


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
