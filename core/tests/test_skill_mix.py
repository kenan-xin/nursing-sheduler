"""Skill mix: at least k of a group among a shift's staff, banning nobody."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from pydantic import ValidationError

from nurse_scheduling.models import ShiftTypeRequirementsPreference


def _req(**extra):
    base = {"shiftType": "N", "requiredNumPeople": 4, "qualifiedPeople": "ALL"}
    return ShiftTypeRequirementsPreference(**{**base, **extra})


def test_skill_mix_is_optional_and_parsed():
    assert _req().skillMix is None
    pref = _req(skillMix=[{"people": "RN", "minNumPeople": 2}])
    assert pref.skillMix[0].people == "RN"
    assert pref.skillMix[0].minNumPeople == 2


@pytest.mark.parametrize(
    "extra, message",
    [
        ({"skillMix": [{"people": "RN", "minNumPeople": 0}]}, "between 1 and requiredNumPeople"),
        ({"skillMix": [{"people": "RN", "minNumPeople": 5}]}, "between 1 and requiredNumPeople"),
        (
            {"skillMix": [{"people": "RN", "minNumPeople": 1}, {"people": "RN", "minNumPeople": 2}]},
            "more than once",
        ),
        ({"qualifiedPeople": ["RN"], "skillMix": [{"people": "RN", "minNumPeople": 1}]}, "open to everyone"),
        (
            {"shiftTypeCoefficients": [["N", 2]], "skillMix": [{"people": "RN", "minNumPeople": 1}]},
            "shiftTypeCoefficients",
        ),
        ({"skillMix": [{"people": "RN", "minNumPeople": 1, "weight": 1}]}, "Extra inputs"),
    ],
)
def test_invalid_skill_mix_is_rejected(extra, message):
    with pytest.raises(ValidationError, match=message):
        _req(**extra)


def test_omitted_qualified_people_counts_as_everyone():
    pref = ShiftTypeRequirementsPreference(
        shiftType="N", requiredNumPeople=2, skillMix=[{"people": "RN", "minNumPeople": 1}]
    )
    assert pref.skillMix[0].minNumPeople == 1
