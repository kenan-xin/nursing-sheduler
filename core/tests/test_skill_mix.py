"""Skill mix: at least k of a group among a shift's staff, banning nobody."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nurse_scheduling
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


PEOPLE = ["rn1", "rn2", "rn3", "en1", "en2", "en3", "en4", "en5"]
RNS = {"rn1", "rn2", "rn3"}


def _ward(
    night_extra: str = "", extra_prefs: str = "", groups: str = "[rn1, rn2, rn3]", night_required: int = 4
) -> str:
    items = "\n".join(f"    - id: {p}" for p in PEOPLE)
    # RNs would rather not do nights (soft). Without a skill mix the optimum puts
    # zero RNs on nights. With one, the solver is forced to place exactly the floor.
    avoid = "\n".join(
        f"""  - type: shift request
    person: {p}
    date: ALL
    shiftType: N
    weight: -1"""
        for p in sorted(RNS)
    )
    return f"""
apiVersion: alpha
dates:
  range:
    startDate: 2026-11-01
    endDate: 2026-11-07
people:
  items:
{items}
  groups:
    - id: RN
      members: {groups}
    - id: Senior
      members: [rn1, en1]
shiftTypes:
  items:
    - id: D
    - id: N
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    description: Day needs exactly 2
    shiftType: D
    requiredNumPeople: 2
  - type: shift type requirement
    description: Night needs exactly {night_required}
    shiftType: N
    requiredNumPeople: {night_required}
    qualifiedPeople: ALL
{night_extra}
{avoid}
{extra_prefs}
"""


MIX_2_RN = """    skillMix:
      - people: RN
        minNumPeople: 2"""


def _nights(df, day: int) -> set[str]:
    # Non-prettify layout: 2 header rows, 1 id column, people in item order.
    return {p for i, p in enumerate(PEOPLE) if df.iloc[2 + i, 1 + day] == "N"}


def _solve(yaml_text: str):
    df, _solution, _score, status, _cells = nurse_scheduling.schedule(yaml_text.encode("utf-8"))
    return df, status


def test_control_without_skill_mix_rns_avoid_nights():
    df, status = _solve(_ward())
    assert status == "OPTIMAL"
    assert all(len(_nights(df, d) & RNS) == 0 for d in range(7))


def test_at_least_two_rns_among_four_night_staff_and_others_not_banned():
    df, status = _solve(_ward(MIX_2_RN))
    assert status == "OPTIMAL"
    for d in range(7):
        night = _nights(df, d)
        assert len(night) == 4, "headcount stays exact"
        assert len(night & RNS) == 2, "the floor is met and, because RNs avoid nights, not exceeded"
        assert len(night - RNS) == 2, "non-RNs still work nights: nobody is banned"


def test_infeasible_when_only_one_rn_is_available():
    leave = """  - type: shift request
    person: [rn2, rn3]
    date: 2026-11-03
    shiftType: LEAVE
    weight: .inf"""
    df, status = _solve(_ward(MIX_2_RN, leave))
    assert df is None
    assert status == "INFEASIBLE"


def test_empty_group_is_infeasible_not_a_crash():
    df, status = _solve(_ward(MIX_2_RN, groups="[]"))
    assert df is None
    assert status == "INFEASIBLE"


def test_overlapping_groups_count_toward_both():
    # rn1 is both RN and Senior. With a night headcount of only 2, "2 RN + 1
    # Senior" is satisfiable at all only if one person counts toward both
    # floors: rn1 + one more RN. Disjoint counting would need a 3rd person for
    # Senior and be infeasible at headcount 2, so OPTIMAL here proves the
    # overlap. rn1 (the only Senior) is then pinned onto nights every day.
    mix = (
        MIX_2_RN
        + """
      - people: Senior
        minNumPeople: 1"""
    )
    df, status = _solve(_ward(mix, night_required=2))
    assert status == "OPTIMAL"
    for d in range(7):
        night = _nights(df, d)
        assert len(night) == 2
        assert "rn1" in night


def test_aggregate_group_needs_one_across_the_group_not_one_each():
    # 5 people, AM (am1+am2 combined) needs exactly 4. Without s1, the other 4
    # (n1-n4) exactly fill AM, so nothing but the skill mix forces s1 in: s1
    # softly avoids both am1 and am2, so if the floor only needed s1 on both
    # shift types ("one each"), the solver could still skip him. Instead s1 is
    # pinned onto exactly one AM shift per day ("one across the group"),
    # because "at most one shift per day" bars him from covering both.
    yaml_text = """
apiVersion: alpha
dates:
  range: {startDate: 2026-11-01, endDate: 2026-11-02}
people:
  items: [{id: s1}, {id: n1}, {id: n2}, {id: n3}, {id: n4}]
  groups: [{id: Senior, members: [s1]}]
shiftTypes:
  items: [{id: am1}, {id: am2}]
  groups: [{id: AM, members: [am1, am2]}]
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: AM
    requiredNumPeople: 4
    skillMix: [{people: Senior, minNumPeople: 1}]
  - type: shift type requirement
    shiftType: am1
    requiredNumPeople: 2
  - type: shift request
    person: s1
    date: ALL
    shiftType: [am1, am2]
    weight: -1
"""
    df, status = _solve(yaml_text)
    assert status == "OPTIMAL"
    for d in range(2):
        s1_shift = df.iloc[2, 1 + d]  # s1 is the first person row
        assert s1_shift in ("am1", "am2"), "the floor forces s1 onto exactly one AM shift, not both"
