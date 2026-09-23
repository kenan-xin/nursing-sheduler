"""Compliance regression for the 28-day / 160-hour Singapore roster fixture.

``testcases/real/sg-28day-160h-compliance-14-nurses.yaml`` exists to demonstrate
one thing: that a set of statutory rest rules can be encoded in a day-granular
solver and actually hold. Nothing else in the repo checked that, and two of the
rules are fragile in ways that are invisible on inspection:

* The 48-hour night recovery lands at exactly 48.0 h only because Morning starts
  no earlier than Night ends. Moving Morning to 06:30 -- a change that looks
  entirely harmless -- silently makes it 47.5 h.
* The minimum-night-block rule is spelled as nine separate succession cards,
  because the web UI's pattern builder cannot author a multi-value position.
  Deleting any one of them silently re-legalises isolated single nights.

So the checks below recompute every rule from the shift clock times DECLARED IN
THE FIXTURE rather than from constants of their own. Edit a start time and the
arithmetic here moves with it. Only the statutory thresholds are fixed, because
those are the requirements the fixture exists to satisfy.

Two layers guard the nine cards: ``test_succession_rule_set_is_intact`` catches a
deleted card structurally without solving, and the roster checks catch a roster
that violates a rule however that came about.

The negative-control tests are not decoration. A compliance checker that cannot
fail proves nothing, and an earlier version of this one passed a roster it should
have rejected. Each mutation is a coverage-preserving swap, so per-day staffing is
untouched and only the per-nurse rules can break -- otherwise the coverage check
fires first and masks the rule under test.

The solve is multi-threaded and so returns a different valid roster from run to
run. That is deliberate: the rules must hold for ANY solution, not one blessed
answer. (``deterministic=True`` would pin it but costs ~78 s against ~1.7 s,
and single-solution testing is exactly what hid the checker bug mentioned above.)
"""

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

import datetime as dt
from pathlib import Path

import pytest

import nurse_scheduling
from nurse_scheduling.loader import load_data
from nurse_scheduling.models import SHIFT_TYPE_REQUIREMENT, SHIFT_TYPE_SUCCESSIONS

FIXTURE = Path(__file__).parent / "testcases" / "real" / "sg-28day-160h-compliance-14-nurses.yaml"

# The requirements the fixture exists to satisfy. These are the ONLY fixed
# numbers here -- clock times, histories and the ward establishment all come from
# the fixture, so editing it changes what is checked instead of quietly passing.
CONTRACT_HOURS = 160.0
NIGHTS_PER_NURSE = 6
MIN_INTERVAL_H = 11.0
STATUTORY_REST_H = 30.0
NIGHT_RECOVERY_H = 48.0
MIN_NIGHT_BLOCK = 2
MAX_NIGHT_BLOCK = 3
MAX_CONSECUTIVE_WORKED = 6

# The fixture's shape. Pinned so that renaming or adding a shift type fails here
# loudly rather than letting the rules below silently check less than they claim.
MORNING, AFTERNOON, NIGHT = "M", "A", "N"
EXPECTED_SHIFT_IDS = {MORNING, AFTERNOON, NIGHT}
NOT_NIGHT_TOKENS = ("DayOrAfternoon", "OFF", "LEAVE")


def _clock(value: str) -> dt.time:
    return dt.time.fromisoformat(value)


def _span(shift, day_index: int, day0: dt.date) -> tuple[dt.datetime, dt.datetime, float]:
    """Absolute start/end and PAID hours for `shift` worked on `day_index`.

    Derived from the fixture's own clock times, which is the whole point: the
    48-hour recovery margin is a consequence of these values, not a constant.
    """
    base = dt.datetime.combine(day0 + dt.timedelta(days=day_index), _clock(shift.startTime))
    end = dt.datetime.combine(day0 + dt.timedelta(days=day_index), _clock(shift.endTime))
    if end <= base:
        end += dt.timedelta(days=1)  # an earlier end time means the shift crosses midnight
    paid = (end - base).total_seconds() / 3600 - (shift.restMinutes or 0) / 60
    return base, end, paid


def _timeline(scenario, grid, p) -> list[tuple[int, str | None]]:
    """The person's history at negative day indices, then the solved horizon.

    History is included so the cycle boundary is checked. Succession windows are
    only evaluated where they fit inside the horizon, so without it the first
    days of the roster would be unguarded.
    """
    history = list(scenario.people.items[p].history or [])
    out = [(i - len(history), c) for i, c in enumerate(history)]
    out += list(enumerate(grid[p]))
    return out


def _coverage_violations(scenario, grid) -> list[str]:
    """Per-day staffing against the fixture's own declared establishment."""
    n_days = len(grid[0])
    out: list[str] = []
    for pref in scenario.preferences:
        if pref.type != SHIFT_TYPE_REQUIREMENT:
            continue
        # Every requirement here is ward-wide and all-dates. A date-scoped one
        # would need group expansion; fail loudly rather than check less than
        # this test claims to.
        assert pref.date in (None, "ALL", ["ALL"]), f"unsupported date scope: {pref.date!r}"
        wanted = pref.shiftType if isinstance(pref.shiftType, list) else [pref.shiftType]
        for sid in wanted:
            for d in range(n_days):
                got = sum(1 for row in grid if row[d] == sid)
                if got != pref.requiredNumPeople:
                    out.append(f"day {d + 1}: {sid} staffed {got}, required {pref.requiredNumPeople}")
    return out


def _person_violations(scenario, grid, p) -> list[str]:
    shifts = {s.id: s for s in scenario.shiftTypes.items}
    day0 = scenario.dates.range.startDate
    n_days = len(grid[0])
    who = scenario.people.items[p].id
    out: list[str] = []

    timeline = _timeline(scenario, grid, p)
    worked = [(d, c) for d, c in timeline if c in shifts]

    hours = sum(_span(shifts[c], d, day0)[2] for d, c in worked if d >= 0)
    if abs(hours - CONTRACT_HOURS) > 1e-9:
        out.append(f"{who}: {hours} contracted hours, expected {CONTRACT_HOURS}")

    nights = sum(1 for c in grid[p] if c == NIGHT)
    if nights != NIGHTS_PER_NURSE:
        out.append(f"{who}: {nights} nights, expected {NIGHTS_PER_NURSE}")

    def gap_between(pair_a, pair_b) -> float:
        (d1, c1), (d2, c2) = pair_a, pair_b
        return (_span(shifts[c2], d2, day0)[0] - _span(shifts[c1], d1, day0)[1]).total_seconds() / 3600

    for first, second in zip(worked, worked[1:]):
        (d1, c1), (d2, c2) = first, second
        gap = gap_between(first, second)
        if gap < MIN_INTERVAL_H:
            out.append(f"{who}: {c1} d{d1 + 1} -> {c2} d{d2 + 1} gap {gap} h < {MIN_INTERVAL_H}")
        if c2 == MORNING and c1 in (AFTERNOON, NIGHT) and d2 == d1 + 1:
            out.append(f"{who}: quick return {c1} d{d1 + 1} -> {MORNING} d{d2 + 1}")
        # Recovery is measured after the LAST night of a block, so only when the
        # following worked shift is not itself a night.
        if c1 == NIGHT and c2 != NIGHT and gap < NIGHT_RECOVERY_H:
            out.append(f"{who}: night block ends d{d1 + 1}, returns {c2} d{d2 + 1} after {gap} h < {NIGHT_RECOVERY_H}")

    run = 0
    for d in range(n_days):
        run = run + 1 if grid[p][d] is not None else 0
        if run > MAX_CONSECUTIVE_WORKED:
            out.append(f"{who}: more than {MAX_CONSECUTIVE_WORKED} consecutive worked days, ending d{d + 1}")
            break

    # Night-block lengths across history+horizon, so a block straddling the cycle
    # boundary is measured whole. A block touching either edge is truncated by the
    # window rather than by the roster, so it is exempt.
    states = [c for _, c in timeline]
    start = None
    for i, c in enumerate([*states, None]):
        if c == NIGHT and start is None:
            start = i
        elif c != NIGHT and start is not None:
            length = i - start
            if not (start == 0 or i == len(states)) and not (MIN_NIGHT_BLOCK <= length <= MAX_NIGHT_BLOCK):
                out.append(f"{who}: night block of {length} outside [{MIN_NIGHT_BLOCK}, {MAX_NIGHT_BLOCK}]")
            start = None

    # Statutory rest: one unbroken >= 30 h break in every rolling 7-day window.
    rested: set[int] = set()
    for first, second in zip(worked, worked[1:]):
        if gap_between(first, second) >= STATUTORY_REST_H:
            rested.update(range(first[0], second[0] + 1))
    if worked:
        # The break after the final shift has no following shift to measure
        # against, so measure it to the horizon end. Without this a nurse whose
        # last shift sits a few days from the end is falsely reported unrested --
        # a real false positive this checker once produced.
        d_last, c_last = worked[-1]
        horizon_end = dt.datetime.combine(day0 + dt.timedelta(days=n_days), dt.time.min)
        if (horizon_end - _span(shifts[c_last], d_last, day0)[1]).total_seconds() / 3600 >= STATUTORY_REST_H:
            rested.update(range(d_last, n_days))
    for w in range(n_days - 6):
        if not any((w + i) in rested for i in range(7)):
            out.append(f"{who}: no >= {STATUTORY_REST_H} h unbroken rest in the window starting d{w + 1}")

    return out


def compliance_violations(scenario, grid) -> list[str]:
    out = _coverage_violations(scenario, grid)
    for p in range(len(scenario.people.items)):
        out += _person_violations(scenario, grid, p)
    return out


@pytest.fixture(scope="module")
def scenario():
    return load_data(FIXTURE.read_bytes())


@pytest.fixture(scope="module")
def grid(scenario):
    """One solve, reduced to `grid[person][day] = shift id or None`.

    Read from the raw `solution` map rather than the exported dataframe, so the
    checks never depend on export formatting.
    """
    _df, solution, _score, status, _info = nurse_scheduling.schedule(FIXTURE.read_bytes())
    assert status in {"OPTIMAL", "FEASIBLE"}, f"fixture did not solve: {status}"
    n_days = (scenario.dates.range.endDate - scenario.dates.range.startDate).days + 1
    ids = [s.id for s in scenario.shiftTypes.items]
    out = []
    for p in range(len(scenario.people.items)):
        row = []
        for d in range(n_days):
            worked = [ids[s] for s in range(len(ids)) if solution[(d, s, p)]]
            assert len(worked) <= 1, f"person {p} has {len(worked)} shifts on day {d + 1}"
            row.append(worked[0] if worked else None)
        out.append(row)
    return out


def test_fixture_shape_is_what_these_checks_assume(scenario):
    """Pin the assumptions the rule checks are written against.

    Renaming a shift type or dropping its clock times would otherwise let every
    check below silently pass while verifying less than it claims.
    """
    assert {s.id for s in scenario.shiftTypes.items} == EXPECTED_SHIFT_IDS
    for shift in scenario.shiftTypes.items:
        assert shift.startTime and shift.endTime, f"{shift.id} has no clock times to derive rest from"
    assert all(p.history for p in scenario.people.items), "history guards the cycle boundary"


def test_headcount_matches_establishment(scenario):
    """`requiredNumPeople` is a hard equality and the contract pins each nurse to
    an exact shift count, so total demand must divide exactly by that count.
    Violating this makes the scenario infeasible outright rather than merely
    tight, which is a confusing failure to debug from a solver status alone.
    """
    n_days = (scenario.dates.range.endDate - scenario.dates.range.startDate).days + 1
    demand = sum(p.requiredNumPeople for p in scenario.preferences if p.type == SHIFT_TYPE_REQUIREMENT) * n_days
    shift_hours = {s.id: s.durationMinutes / 60 for s in scenario.shiftTypes.items}
    assert len(set(shift_hours.values())) == 1, "mixed shift lengths break the identity below"
    supply = len(scenario.people.items) * int(CONTRACT_HOURS / next(iter(shift_hours.values())))
    assert supply == demand, f"{len(scenario.people.items)} nurses supply {supply} shifts, ward needs {demand}"


def test_succession_rule_set_is_intact(scenario):
    """Structural guard, no solve required.

    The minimum-night-block rule is nine cards because the web UI cannot author a
    multi-value pattern position. Deleting any one of them re-legalises a shape of
    isolated night, and a solver run would only notice if it happened to produce
    that shape. This notices immediately.
    """
    patterns = {
        tuple(tuple(x) if isinstance(x, list) else x for x in p.pattern)
        for p in scenario.preferences
        if p.type == SHIFT_TYPE_SUCCESSIONS
    }
    isolated_night = {(a, NIGHT, b) for a in NOT_NIGHT_TOKENS for b in NOT_NIGHT_TOKENS}
    missing = isolated_night - patterns
    assert not missing, f"minimum-night-block rule is incomplete, missing: {sorted(missing)}"

    for required in (
        (AFTERNOON, MORNING),
        (NIGHT, "DayOrAfternoon"),
        (NIGHT, "OFF", "ALL"),
        (NIGHT, "LEAVE", "ALL"),
        (NIGHT, NIGHT, NIGHT, NIGHT),
        tuple(["ALL"] * 7),
    ):
        assert required in patterns, f"missing succession rule: {required}"

    nested = [p for p in patterns if any(isinstance(x, tuple) for x in p)]
    assert not nested, f"nested pattern positions are not authorable in the web UI: {nested}"


def test_roster_satisfies_every_rule(scenario, grid):
    violations = compliance_violations(scenario, grid)
    assert violations == [], "\n".join(violations)


# --------------------------------------------------------- negative controls --
# Exchanging two nurses' cells on the SAME day leaves that day's assignment
# multiset identical, so per-day coverage cannot change and only the per-nurse
# rules can break. That matters: a mutation that also breaks coverage makes the
# coverage check fire first and mask the rule actually under test.


def _swap(grid, p1, p2, day):
    out = [list(row) for row in grid]
    out[p1][day], out[p2][day] = out[p2][day], out[p1][day]
    return out


def _find_quick_return(grid):
    """Give someone who worked an Afternoon a Morning the very next day."""
    for d in range(len(grid[0]) - 1):
        for p1, row1 in enumerate(grid):
            if row1[d] != AFTERNOON or row1[d + 1] == MORNING:
                continue
            for p2, row2 in enumerate(grid):
                if p2 != p1 and row2[d + 1] == MORNING:
                    return p1, p2, d + 1
    return None


def _find_hours_shift(grid):
    """Move one shift between a working and a resting nurse: 168 h and 152 h."""
    for d in range(len(grid[0])):
        busy = next((p for p, row in enumerate(grid) if row[d] is not None), None)
        idle = next((p for p, row in enumerate(grid) if row[d] is None), None)
        if busy is not None and idle is not None:
            return busy, idle, d
    return None


def _find_night_reassignment(grid):
    """Exchange a Night with a non-Night worked shift, unbalancing night load."""
    for d in range(len(grid[0])):
        owner = next((p for p, row in enumerate(grid) if row[d] == NIGHT), None)
        other = next((p for p, row in enumerate(grid) if row[d] not in (NIGHT, None)), None)
        if owner is not None and other is not None:
            return owner, other, d
    return None


@pytest.mark.parametrize(
    "finder,expected",
    [
        (_find_quick_return, "quick return"),
        (_find_hours_shift, "contracted hours"),
        (_find_night_reassignment, "nights, expected"),
    ],
    ids=["quick-return ban", "160 h contract", "night-load fairness"],
)
def test_checker_rejects_a_broken_roster(scenario, grid, finder, expected):
    spot = finder(grid)
    assert spot is not None, "no applicable mutation found -- the roster shape changed"
    violations = compliance_violations(scenario, _swap(grid, *spot))
    assert not any("staffed" in v for v in violations), (
        f"the mutation changed coverage, so it does not isolate {expected!r}: {violations[:3]}"
    )
    assert any(expected in v for v in violations), f"expected {expected!r} among: {violations[:5]}"
