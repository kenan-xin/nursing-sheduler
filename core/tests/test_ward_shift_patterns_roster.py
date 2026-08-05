"""Compliance regression for the eight-pattern ward roster fixture.

``testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml`` rosters 32
nurses over 28 days across eight shift patterns, with a Senior Staff Nurse on
every shift and a realistic sheet of leave and day-off requests. Several of its
guarantees are quiet ones -- they hold today, and nothing would say so if an edit
broke them:

* The senior rule is carried by a naming convention. A nurse counts as senior
  only through the `SeniorStaffNurses` group; the `SSN-` prefix is cosmetic. Add
  an SSN and forget the group and the rule silently covers fewer people while the
  roster still solves.
* Leave is budgeted. Credited hours are worked + 8 h per leave day, and that has
  to land inside the contract band, so there is both a floor and a ceiling on how
  much leave the ward can carry. Cross either and the solver returns a bare
  INFEASIBLE with nothing pointing at leave.
* The 48-hour night recovery depends on the clock times. A night finishes 08:30,
  so two clear days before an 08:00 start is only 47.5 h -- which is why the
  third day bans early starts too. Move a start time and that margin moves.

So the rules below are recomputed from the shift clock times DECLARED IN THE
FIXTURE rather than from constants of their own. Only the statutory thresholds
are fixed, because those are the requirements the fixture exists to satisfy.

The negative-control tests are not decoration: a checker that cannot fail proves
nothing. Each mutation swaps two nurses' cells on ONE day, which leaves that
day's assignment multiset identical, so per-day staffing cannot change and only
the per-nurse rule under test can break. Without that, the staffing check fires
first and masks whatever was meant to be exercised.
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
from nurse_scheduling.models import SHIFT_REQUEST, SHIFT_TYPE_REQUIREMENT, SHIFT_TYPE_SUCCESSIONS

FIXTURE = Path(__file__).parent / "testcases" / "real" / "ward-8-shift-patterns-senior-on-every-shift.yaml"

# The requirements the fixture exists to satisfy. These are the only fixed
# numbers here; clock times, grades, staffing and requests all come from the
# fixture, so editing it changes what is checked instead of quietly passing.
CONTRACT_MIN_H, CONTRACT_MAX_H = 152.0, 168.0
LEAVE_CREDIT_H = 8.0  # must match the LEAVE coefficient (16 half-hours) in the contract
MIN_INTERVAL_H = 11.0
STATUTORY_REST_H = 30.0
NIGHT_RECOVERY_H = 48.0
MAX_NIGHT_RUN = 3
MAX_CONSECUTIVE_WORKED = 6

# The fixture's shape, pinned so a rename or an extra pattern fails loudly rather
# than letting the checks below verify less than they claim.
SENIOR_SUFFIX = "+"
SENIOR_GROUP = "SeniorStaffNurses"
SENIOR_PREFIX, JUNIOR_PREFIX = "SSN-", "SN-"
SENIOR_LABEL, JUNIOR_LABEL = "Senior Staff Nurse", "Staff Nurse"
EXPECTED_PATTERNS = {"am1", "am2", "am3", "pm1", "pm2", "pm3", "long", "night"}


def _clock(value: str) -> dt.time:
    return dt.time.fromisoformat(value)


def _span(shift, day_index: int, day0: dt.date) -> tuple[dt.datetime, dt.datetime, float]:
    """Absolute start/end and PAID hours for `shift` worked on `day_index`.

    Taken from the fixture's own clock times, which is the point: the 47.5 h
    versus 48 h night-recovery margin is a consequence of those values, not a
    constant someone can forget to update.
    """
    base = dt.datetime.combine(day0 + dt.timedelta(days=day_index), _clock(shift.startTime))
    end = dt.datetime.combine(day0 + dt.timedelta(days=day_index), _clock(shift.endTime))
    if end <= base:
        end += dt.timedelta(days=1)  # an earlier end time means the shift crosses midnight
    paid = (end - base).total_seconds() / 3600 - (shift.restMinutes or 0) / 60
    return base, end, paid


def _is_night(shift) -> bool:
    """A shift that runs past midnight. Derived, so it follows a time change."""
    return _clock(shift.endTime) <= _clock(shift.startTime)


def _finishes_late(shift) -> bool:
    return not _is_night(shift) and _clock(shift.endTime) >= dt.time(20, 0)


def _starts_early(shift) -> bool:
    return _clock(shift.startTime) <= dt.time(8, 0)


def _request_days(value, day0: dt.date) -> list[int]:
    return [(d - day0).days for d in (value if isinstance(value, list) else [value]) if isinstance(d, dt.date)]


def _requests(scenario) -> tuple[dict, dict, list]:
    """Split the request sheet by how strongly each entry binds.

    LEAVE always pins, whatever weight it carries. An OFF request pins only at
    infinite weight; at a finite weight it is a preference the solver may
    override, so it is collected separately and never asserted on.
    """
    day0 = scenario.dates.range.startDate
    leave: dict[str, set[int]] = {}
    hard_off: dict[str, set[int]] = {}
    soft_off: list[tuple[str, int]] = []
    for pref in scenario.preferences:
        if pref.type != SHIFT_REQUEST or not isinstance(pref.person, str):
            continue
        days = _request_days(pref.date, day0)
        if pref.shiftType == "LEAVE":
            leave.setdefault(pref.person, set()).update(days)
        elif pref.shiftType == "OFF" and pref.weight == float("inf"):
            hard_off.setdefault(pref.person, set()).update(days)
        elif pref.shiftType == "OFF":
            soft_off += [(pref.person, d) for d in days]
    return leave, hard_off, soft_off


def _staffing_violations(scenario, grid) -> list[str]:
    """Per-day headcount, and the senior-only slots, against the fixture itself."""
    people = [p.id for p in scenario.people.items]
    seniors = _senior_group(scenario)
    n_days = len(grid[0])
    out: list[str] = []
    for pref in scenario.preferences:
        if pref.type != SHIFT_TYPE_REQUIREMENT:
            continue
        # Every requirement in this fixture is ward-wide and all-dates; a scoped
        # one would need date expansion, so fail loudly rather than check less.
        assert pref.date in (None, "ALL", ["ALL"]), f"unsupported date scope: {pref.date!r}"
        for d in range(n_days):
            on_it = [people[p] for p in range(len(people)) if grid[p][d] == pref.shiftType]
            if len(on_it) != pref.requiredNumPeople:
                out.append(f"day {d + 1}: {pref.shiftType} has {len(on_it)}, needs {pref.requiredNumPeople}")
            # A senior-only slot must hold a senior. This is what qualifiedPeople
            # buys, and the check is here so removing it does not go unnoticed.
            if pref.shiftType.endswith(SENIOR_SUFFIX):
                for who in on_it:
                    if who not in seniors:
                        out.append(f"day {d + 1}: senior-only slot {pref.shiftType} filled by {who}")
    return out


def _senior_cover_violations(scenario, grid) -> list[str]:
    """The outcome the '+' slots exist to produce: a senior on every shift.

    Checked separately from the slots themselves, so the guarantee survives even
    if the mechanism behind it is ever rebuilt some other way.
    """
    people = [p.id for p in scenario.people.items]
    seniors = _senior_group(scenario)
    patterns = sorted({s.id.rstrip(SENIOR_SUFFIX) for s in scenario.shiftTypes.items})
    out: list[str] = []
    for d in range(len(grid[0])):
        for base in patterns:
            on_duty = [people[p] for p in range(len(people)) if grid[p][d] in (base, base + SENIOR_SUFFIX)]
            if on_duty and not any(w in seniors for w in on_duty):
                out.append(f"day {d + 1}: {base} has no Senior Staff Nurse on duty ({on_duty})")
    return out


def _senior_group(scenario) -> set[str]:
    return {m for g in scenario.people.groups if g.id == SENIOR_GROUP for m in g.members}


def _person_violations(scenario, grid, p, leave, hard_off) -> list[str]:
    shifts = {s.id: s for s in scenario.shiftTypes.items}
    day0 = scenario.dates.range.startDate
    n_days = len(grid[0])
    who = scenario.people.items[p].id
    out: list[str] = []

    # Requests that bind. Soft preferences are deliberately NOT asserted here:
    # the solver is entitled to override them in order to staff the ward.
    on_leave = leave.get(who, set())
    for d in sorted(on_leave):
        if grid[p][d] is not None:
            out.append(f"{who}: rostered {grid[p][d]} on d{d + 1} while on approved leave")
    for d in sorted(hard_off.get(who, set())):
        if grid[p][d] is not None:
            out.append(f"{who}: rostered {grid[p][d]} on d{d + 1} despite a hard day-off request")

    history = list(scenario.people.items[p].history or [])
    timeline = [(i - len(history), c) for i, c in enumerate(history)] + list(enumerate(grid[p]))
    worked = [(d, c) for d, c in timeline if c in shifts]

    # Paid leave counts toward the contract, so credited = worked + leave.
    hours = sum(_span(shifts[c], d, day0)[2] for d, c in worked if d >= 0) + LEAVE_CREDIT_H * len(on_leave)
    if not (CONTRACT_MIN_H - 1e-9 <= hours <= CONTRACT_MAX_H + 1e-9):
        out.append(f"{who}: {hours} h credited, outside [{CONTRACT_MIN_H}, {CONTRACT_MAX_H}]")

    for (d1, c1), (d2, c2) in zip(worked, worked[1:]):
        gap = (_span(shifts[c2], d2, day0)[0] - _span(shifts[c1], d1, day0)[1]).total_seconds() / 3600
        if gap < MIN_INTERVAL_H:
            out.append(f"{who}: {c1} d{d1 + 1} -> {c2} d{d2 + 1} gap {gap} h < {MIN_INTERVAL_H}")
        if d2 == d1 + 1 and _finishes_late(shifts[c1]) and _starts_early(shifts[c2]):
            out.append(f"{who}: early start {c2} d{d2 + 1} straight after late finish {c1} d{d1 + 1}")
        # Recovery is measured after the LAST night of a run, so only when the
        # next worked shift is not itself a night.
        if _is_night(shifts[c1]) and not _is_night(shifts[c2]) and gap < NIGHT_RECOVERY_H:
            out.append(f"{who}: nights end d{d1 + 1}, back on {c2} d{d2 + 1} after {gap} h < {NIGHT_RECOVERY_H}")

    run = 0
    for d, c in timeline:
        run = run + 1 if (c in shifts and _is_night(shifts[c])) else 0
        if run > MAX_NIGHT_RUN:
            out.append(f"{who}: {run} nights in a row ending d{d + 1}")
            break

    worked_run = 0
    for d in range(n_days):
        worked_run = worked_run + 1 if grid[p][d] else 0
        if worked_run > MAX_CONSECUTIVE_WORKED:
            out.append(f"{who}: more than {MAX_CONSECUTIVE_WORKED} worked days in a row, ending d{d + 1}")
            break

    # Statutory rest: one unbroken >= 30 h break in every rolling 7-day window.
    rested: set[int] = set()
    for (d1, c1), (d2, c2) in zip(worked, worked[1:]):
        if (_span(shifts[c2], d2, day0)[0] - _span(shifts[c1], d1, day0)[1]).total_seconds() / 3600 >= STATUTORY_REST_H:
            rested.update(range(d1, d2 + 1))
    if worked:
        # The break after the final shift has no following shift to measure
        # against, so measure it to the horizon end instead. Without this a nurse
        # whose last shift sits near the end is falsely reported as unrested.
        d_last, c_last = worked[-1]
        horizon_end = dt.datetime.combine(day0 + dt.timedelta(days=n_days), dt.time.min)
        if (horizon_end - _span(shifts[c_last], d_last, day0)[1]).total_seconds() / 3600 >= STATUTORY_REST_H:
            rested.update(range(d_last, n_days))
    for w in range(n_days - 6):
        if not any((w + i) in rested for i in range(7)):
            out.append(f"{who}: no >= {STATUTORY_REST_H} h unbroken rest in the week starting d{w + 1}")

    return out


def compliance_violations(scenario, grid) -> list[str]:
    leave, hard_off, _soft = _requests(scenario)
    out = _staffing_violations(scenario, grid) + _senior_cover_violations(scenario, grid)
    for p in range(len(scenario.people.items)):
        out += _person_violations(scenario, grid, p, leave, hard_off)
    return out


@pytest.fixture(scope="module")
def scenario():
    return load_data(FIXTURE.read_bytes())


@pytest.fixture(scope="module")
def grid(scenario):
    """One solve, reduced to `grid[person][day] = shift id or None`.

    Read from the raw `solution` map rather than the exported dataframe, so these
    checks never depend on export formatting. A leave day reads as None here;
    which days are leave comes from the request sheet, since leave is pinned
    input rather than something the solver chooses.
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
    """Pin the assumptions the rules are written against.

    Renaming a pattern, dropping a clock time or losing the histories would
    otherwise let every check below pass while verifying less than it claims.
    """
    ids = {s.id for s in scenario.shiftTypes.items}
    assert {i.rstrip(SENIOR_SUFFIX) for i in ids} == EXPECTED_PATTERNS
    for pattern in EXPECTED_PATTERNS:
        assert pattern in ids and pattern + SENIOR_SUFFIX in ids, f"{pattern} is missing its senior twin"
    for shift in scenario.shiftTypes.items:
        assert shift.startTime and shift.endTime, f"{shift.id} has no clock times to derive rest from"
    assert all(p.history for p in scenario.people.items), "history guards the roster boundary"


def test_grade_prefix_and_senior_group_agree(scenario):
    """The `SSN-` prefix is cosmetic; only the group makes a nurse senior.

    Adding a senior and forgetting the group would leave the roster solvable and
    the senior rule quietly covering fewer people, which is exactly the kind of
    edit no other check here would notice.
    """
    ids = [p.id for p in scenario.people.items]
    by_prefix = {i for i in ids if i.startswith(SENIOR_PREFIX)}
    juniors = {i for i in ids if i.startswith(JUNIOR_PREFIX) and not i.startswith(SENIOR_PREFIX)}
    group = _senior_group(scenario)

    assert by_prefix | juniors == set(ids), "every nurse id must carry a grade prefix"
    assert group == by_prefix, f"group and prefix disagree: {sorted(group ^ by_prefix)}"
    for person in scenario.people.items:
        expected = SENIOR_LABEL if person.id in group else JUNIOR_LABEL
        assert person.description.startswith(expected), f"{person.id} is labelled {person.description!r}"


def test_leave_stays_inside_the_budget_the_contract_allows(scenario):
    """Leave is budgeted, and crossing the budget reads as a bare INFEASIBLE.

    Credited hours are worked + 8 h per leave day, and must land inside the
    contract band across the ward. There is a FLOOR as well as a ceiling: too
    little leave and the ward cannot reach its minimum hours. Checked as
    arithmetic so a bad edit is explained here rather than diagnosed from a
    solver status.
    """
    n_days = (scenario.dates.range.endDate - scenario.dates.range.startDate).days + 1
    shifts = {s.id: s for s in scenario.shiftTypes.items}
    worked_h = n_days * sum(
        pref.requiredNumPeople * shifts[pref.shiftType].durationMinutes / 60
        for pref in scenario.preferences
        if pref.type == SHIFT_TYPE_REQUIREMENT
    )
    leave, _hard, _soft = _requests(scenario)
    leave_days = sum(len(v) for v in leave.values())
    n = len(scenario.people.items)
    credited = worked_h + LEAVE_CREDIT_H * leave_days

    assert CONTRACT_MIN_H * n <= credited <= CONTRACT_MAX_H * n, (
        f"{leave_days} leave days puts credited hours at {credited} h, outside "
        f"{n} nurses x [{CONTRACT_MIN_H}, {CONTRACT_MAX_H}] = "
        f"[{CONTRACT_MIN_H * n}, {CONTRACT_MAX_H * n}] h. Move headcount and leave together."
    )


def test_succession_patterns_stay_authorable_in_the_web_app(scenario):
    """No multi-value pattern position.

    The web pattern builder appends exactly one token per position, so a nested
    position still solves but turns the card read-only in the UI. Groups do that
    work here instead; this keeps it that way.
    """
    nested = [
        pref.pattern
        for pref in scenario.preferences
        if pref.type == SHIFT_TYPE_SUCCESSIONS and any(isinstance(x, list) for x in pref.pattern)
    ]
    assert not nested, f"nested pattern positions are not authorable in the web UI: {nested}"


def test_every_senior_slot_holds_a_senior_and_every_shift_has_one(scenario, grid):
    violations = _staffing_violations(scenario, grid) + _senior_cover_violations(scenario, grid)
    assert violations == [], "\n".join(violations)


def test_nobody_is_rostered_during_leave_or_a_hard_day_off(scenario, grid):
    leave, hard_off, _soft = _requests(scenario)
    assert leave, "the fixture is supposed to carry approved leave"
    assert hard_off, "the fixture is supposed to carry hard day-off requests"
    people = [p.id for p in scenario.people.items]
    clashes = [
        f"{who}: rostered {grid[people.index(who)][d]} on d{d + 1} ({label})"
        for label, book in (("approved leave", leave), ("hard day off", hard_off))
        for who, days in book.items()
        for d in days
        if grid[people.index(who)][d] is not None
    ]
    assert clashes == [], "\n".join(clashes)


def test_roster_satisfies_every_rule(scenario, grid):
    violations = compliance_violations(scenario, grid)
    assert violations == [], "\n".join(violations)


# ---------------------------------------------------------- negative controls --
# Swapping two nurses' cells on the SAME day leaves that day's assignment
# multiset identical, so per-day staffing cannot change and only the per-nurse
# rules can break. That matters: a mutation that also breaks staffing makes the
# staffing check fire first and mask the rule actually under test.


def _swap(grid, p1, p2, day):
    out = [list(row) for row in grid]
    out[p1][day], out[p2][day] = out[p2][day], out[p1][day]
    return out


def _find_junior_in_senior_slot(scenario, grid):
    """Hand a senior-only slot to a Staff Nurse who is not working that day."""
    people = [p.id for p in scenario.people.items]
    seniors = _senior_group(scenario)
    for d in range(len(grid[0])):
        holder = next((p for p in range(len(people)) if (grid[p][d] or "").endswith(SENIOR_SUFFIX)), None)
        junior = next((p for p in range(len(people)) if people[p] not in seniors and grid[p][d] is None), None)
        if holder is not None and junior is not None:
            return holder, junior, d
    return None


def _find_work_during_leave(scenario, grid):
    """Give a nurse on approved leave someone else's shift that day."""
    people = [p.id for p in scenario.people.items]
    leave, _hard, _soft = _requests(scenario)
    for who, days in leave.items():
        p1 = people.index(who)
        for d in sorted(days):
            p2 = next((p for p in range(len(people)) if grid[p][d] is not None), None)
            if p2 is not None:
                return p1, p2, d
    return None


def _find_work_on_a_hard_day_off(scenario, grid):
    people = [p.id for p in scenario.people.items]
    _leave, hard_off, _soft = _requests(scenario)
    for who, days in hard_off.items():
        p1 = people.index(who)
        for d in sorted(days):
            p2 = next((p for p in range(len(people)) if grid[p][d] is not None), None)
            if p2 is not None:
                return p1, p2, d
    return None


def _find_early_start_after_late_finish(scenario, grid):
    shifts = {s.id: s for s in scenario.shiftTypes.items}
    for d in range(len(grid[0]) - 1):
        for p1 in range(len(grid)):
            c1 = grid[p1][d]
            if not c1 or not _finishes_late(shifts[c1]):
                continue
            nxt = grid[p1][d + 1]
            if nxt and _starts_early(shifts[nxt]):
                continue
            for p2 in range(len(grid)):
                c2 = grid[p2][d + 1]
                if p2 != p1 and c2 and _starts_early(shifts[c2]):
                    return p1, p2, d + 1
    return None


@pytest.mark.parametrize(
    "finder,expected",
    [
        (_find_junior_in_senior_slot, "senior-only slot"),
        (_find_work_during_leave, "while on approved leave"),
        (_find_work_on_a_hard_day_off, "despite a hard day-off request"),
        (_find_early_start_after_late_finish, "early start"),
    ],
    ids=["senior-only slot", "approved leave", "hard day off", "early start after late finish"],
)
def test_checker_rejects_a_broken_roster(scenario, grid, finder, expected):
    spot = finder(scenario, grid)
    assert spot is not None, "no applicable mutation found -- the roster shape changed"
    violations = compliance_violations(scenario, _swap(grid, *spot))
    assert not any(" has " in v and " needs " in v for v in violations), (
        f"the mutation changed staffing, so it does not isolate {expected!r}: {violations[:3]}"
    )
    assert any(expected in v for v in violations), f"expected {expected!r} among: {violations[:5]}"
