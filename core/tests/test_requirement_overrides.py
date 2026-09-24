"""Per-date staffing overrides (bead nursing-sheduler-2se), proven with the real solver."""

import pytest

from nurse_scheduling import scheduler

# Three nurses, every day needs 1 on D and 2 on N: all three work every day.
# cara is on leave on the 2nd, so the 2nd is one short.
BASE = """
apiVersion: alpha
dates:
  range:
    startDate: 2026-11-01
    endDate: 2026-11-03
people:
  items: [{id: ana}, {id: ben}, {id: cara}]
shiftTypes:
  items: [{id: D}, {id: N}]
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
    weight: -1
  - type: shift type requirement
    shiftType: N
    requiredNumPeople: 2
{night_extra}
    weight: -1
  - type: shift request
    person: cara
    date: 2026-11-02
    shiftType: LEAVE
    weight: .inf
{more}
"""


def _status(night_extra: str = "", more: str = "") -> str:
    # str.replace, not str.format: the YAML's flow mappings use braces.
    yaml = BASE.replace("{night_extra}", night_extra).replace("{more}", more).encode()
    _df, _solution, _score, status, _cells = scheduler.schedule(yaml, timeout=30)
    return status


def test_without_override_the_leave_day_is_infeasible():
    assert _status() == "INFEASIBLE"


def test_override_on_the_leave_day_makes_it_feasible():
    assert _status("    requiredNumPeopleOverrides: [[2026-11-02, 1]]") in {"FEASIBLE", "OPTIMAL"}


def test_override_is_exact_on_its_date():
    # On the 1st nobody is away: ana and ben on N plus cara on D fits the people, so only
    # the exact override (1 on N) can make forcing two nights infeasible.
    overrides = "    requiredNumPeopleOverrides: [[2026-11-01, 1], [2026-11-02, 1]]"
    must_work = "\n".join(
        f"  - type: shift request\n    person: {p}\n    date: 2026-11-01\n    shiftType: N\n    weight: .inf"
        for p in ("ana", "ben")
    )
    assert _status(overrides) in {"FEASIBLE", "OPTIMAL"}
    assert _status(overrides, must_work) == "INFEASIBLE"


def test_override_can_raise_a_date():
    # 3 on N on the 3rd plus 1 on D needs 4 people: infeasible proves the raise applies.
    assert _status("    requiredNumPeopleOverrides: [[2026-11-02, 1], [2026-11-03, 3]]") == "INFEASIBLE"


def test_iso_string_dates_are_accepted():
    assert _status('    requiredNumPeopleOverrides: [["2026-11-02", 1]]') in {"FEASIBLE", "OPTIMAL"}


def test_override_outside_the_requirement_dates_raises():
    extra = "    date: [2026-11-01, 2026-11-03]\n    requiredNumPeopleOverrides: [[2026-11-02, 1]]"
    with pytest.raises(ValueError, match="is not one of this requirement's dates"):
        _status(extra)


def test_override_above_preferred_raises():
    extra = "    preferredNumPeople: 2\n    requiredNumPeopleOverrides: [[2026-11-02, 3]]"
    with pytest.raises(ValueError, match="must not exceed preferredNumPeople"):
        _status(extra)


def test_negative_override_raises():
    with pytest.raises(ValueError, match="must be at least 0"):
        _status("    requiredNumPeopleOverrides: [[2026-11-02, -1]]")


def test_duplicate_override_date_raises():
    with pytest.raises(ValueError, match="Duplicate requiredNumPeopleOverrides date"):
        _status("    requiredNumPeopleOverrides: [[2026-11-02, 1], [2026-11-02, 0]]")


def test_other_overlapping_requirements_still_apply():
    # A second all-dates "2 on N" rule still demands 2 on the 2nd: the override
    # relaxes only its own rule, so the leave day stays infeasible.
    second = "  - type: shift type requirement\n    shiftType: N\n    requiredNumPeople: 2\n    weight: -1"
    assert _status("    requiredNumPeopleOverrides: [[2026-11-02, 1]]", second) == "INFEASIBLE"


def test_override_lowers_the_floor_on_a_preferred_num_people_rule():
    # S1: the ">= required" branch (rule with preferredNumPeople) has no other
    # coverage. Without the override, cara's leave makes the 2nd infeasible;
    # the override must lower the *floor*, not just the exact-count branch.
    extra = "    preferredNumPeople: 2\n    requiredNumPeopleOverrides: [[2026-11-02, 1]]"
    assert _status(extra) in {"FEASIBLE", "OPTIMAL"}


def test_skill_mix_floor_still_binds_on_an_overridden_date():
    # S2: an override relaxes requiredNumPeople only; the skillMix floor for
    # that same date must still be enforced. A single-day scenario (no leave
    # day, unlike BASE) isolates the effect: force ana onto D, so she cannot
    # also cover the ana-only night floor -> infeasible proves the skill-mix
    # loop is not skipped on overridden dates.
    yaml_text = """
apiVersion: alpha
dates:
  range:
    startDate: 2026-11-01
    endDate: 2026-11-01
people:
  items: [{id: ana}, {id: ben}]
shiftTypes:
  items: [{id: D}, {id: N}]
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
    weight: -1
  - type: shift type requirement
    shiftType: N
    requiredNumPeople: 2
    qualifiedPeople: ALL
    skillMix: [{people: ana, minNumPeople: 1}]
    requiredNumPeopleOverrides: [[2026-11-01, 1]]
    weight: -1
  - type: shift request
    person: ana
    date: 2026-11-01
    shiftType: D
    weight: .inf
"""
    _df, _solution, _score, status, _cells = scheduler.schedule(yaml_text.encode(), timeout=30)
    assert status == "INFEASIBLE"


def test_override_below_skill_mix_floor_raises():
    # F1: an override must never go below the card's own skillMix floor.
    extra = (
        "    qualifiedPeople: ALL\n"
        "    skillMix: [{people: ana, minNumPeople: 2}]\n"
        "    requiredNumPeopleOverrides: [[2026-11-02, 1]]"
    )
    with pytest.raises(ValueError, match="is below skillMix minNumPeople"):
        _status(extra)
