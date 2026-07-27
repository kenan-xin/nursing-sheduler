"""Oracle vetting for catalogue check G7 — weighted attainable-max.

G7 warns that a scenario cannot build when a **hard** shift count carries a
**lower-bound** predicate whose target exceeds the loosest total the model can
produce::

    x >= T, x = T   infeasible when  T  >  n_dates * max(coefficient)
    x > T           infeasible when  T >=  n_dates * max(coefficient)

It generalises check 9, which fires only on unit coefficients and so misses the
ordinary contracted-hours shape (shifts of differing length).

Why it cannot false-positive: the model enforces exactly one day-state per
person-day unconditionally (``offs + sum(shifts) + leaves == 1``), and
``at most one shift per day`` is a *required* preference the loader rejects a
scenario for omitting. So each day contributes at most ``max(coefficient)``.

Two further hazards are closed by **build-time validation** rather than by detector
logic — coefficients must be >= 1, and duplicate coefficient entries are rejected.
Both are pinned below: if either validation is relaxed, G7 stops being sound and
these tests fail loudly rather than the check silently going wrong.

Only the sound direction is asserted — see ``catalogue_oracle``.
"""

# This file is part of Nurse Scheduling Project, see <https://github.com/j3soon/nurse-scheduling>.
#
# Copyright (C) 2023-2026 Johnson Sun
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.

import pytest
from tests.catalogue_oracle import (
    HARD,
    INFEASIBLE,
    OracleCase,
    assert_sound,
    max_attainable,
    scenario,
    shift_count,
    solve,
)

LOWER_BOUND_STRICT = ("x > T",)
LOWER_BOUND_INCLUSIVE = ("x >= T", "x = T")


def g7_predicts_infeasible(*, n_dates, coefficients, expression, target, weight):
    """The candidate check, as code. A multi-pair count fires if any pair does."""
    if weight != HARD:
        return False
    expressions = expression if isinstance(expression, list) else [expression]
    targets = target if isinstance(target, list) else [target]
    bound = max_attainable(n_dates=n_dates, coefficients=coefficients)
    for expr, tgt in zip(expressions, targets):
        if expr in LOWER_BOUND_INCLUSIVE and tgt > bound:
            return True
        if expr in LOWER_BOUND_STRICT and tgt >= bound:
            return True
    return False


def _count_case(
    name,
    *,
    coefficients,
    expression,
    target,
    days=6,
    weight=HARD,
    people=("p1",),
    shift_types=("D", "N"),
    count_shift_types=None,
    count_dates="ALL",
    count_person=None,
    n_dates=None,
    must_solve=False,
    probes="",
    **scenario_kwargs,
):
    """Build an OracleCase whose prediction comes from the check itself."""
    predicted = g7_predicts_infeasible(
        n_dates=n_dates if n_dates is not None else days,
        coefficients=coefficients,
        expression=expression,
        target=target,
        weight=weight,
    )
    return OracleCase(
        name=name,
        yaml=scenario(
            people=list(people),
            shift_types=list(shift_types),
            days=days,
            preferences=[
                shift_count(
                    person=count_person if count_person is not None else people[0],
                    coefficients=coefficients,
                    expression=expression,
                    target=target,
                    weight=weight,
                    count_dates=count_dates,
                    count_shift_types=count_shift_types,
                )
            ],
            **scenario_kwargs,
        ),
        predicted_infeasible=predicted,
        must_solve=must_solve,
        probes=probes,
    )


CASES = [
    # --- unit coefficients: the shape check 9 already covered -----------------
    _count_case(
        "unit-above-bound",
        coefficients={"D": 1},
        shift_types=("D",),
        expression="x >= T",
        target=7,
        probes="baseline; equals check 9",
    ),
    _count_case(
        "unit-at-bound",
        coefficients={"D": 1},
        shift_types=("D",),
        expression="x >= T",
        target=6,
        must_solve=True,
        probes="boundary must stay reachable",
    ),
    # --- weighted coefficients: the gap G7 closes -----------------------------
    _count_case(
        "weighted-above-bound",
        coefficients={"D": 2, "N": 3},
        expression="x >= T",
        target=19,
        probes="the case check 9 misses",
    ),
    _count_case(
        "weighted-at-bound",
        coefficients={"D": 2, "N": 3},
        expression="x >= T",
        target=18,
        must_solve=True,
        probes="off-by-one guard: fire only strictly above",
    ),
    _count_case(
        "weighted-equality", coefficients={"D": 2, "N": 3}, expression="x = T", target=19, probes="'x = T' arm"
    ),
    _count_case(
        "weighted-strict-gt",
        coefficients={"D": 2, "N": 3},
        expression="x > T",
        target=18,
        probes="'x > T' needs 19, one above the bound",
    ),
    # --- contracted-hours shape: half-hour coefficients over a real window ----
    _count_case(
        "half-hours-above-bound",
        coefficients={"D": 16, "N": 24},
        expression="x >= T",
        target=673,
        days=28,
        probes="the motivating unit-confusion case",
    ),
    _count_case(
        "half-hours-at-bound",
        coefficients={"D": 16, "N": 24},
        expression="x >= T",
        target=672,
        days=28,
        must_solve=True,
        probes="28-day boundary",
    ),
    # --- structural edges: can x ever exceed n_dates * max(coeff)? ------------
    _count_case(
        "reserved-off-in-count",
        coefficients={"D": 2, "OFF": 7},
        shift_types=("D",),
        count_shift_types=["D", "OFF"],
        expression="x >= T",
        target=43,
        probes="OFF is a day-state and can carry the max coefficient",
    ),
    _count_case(
        "reserved-leave-in-count",
        coefficients={"D": 2, "LEAVE": 10},
        shift_types=("D",),
        count_shift_types=["D", "LEAVE"],
        expression="x >= T",
        target=61,
        probes="LEAVE inflates the bound; check must still be sound above it",
    ),
    _count_case(
        "all-day-states",
        coefficients={"ALL": 5, "OFF": 5, "LEAVE": 5},
        count_shift_types=["ALL", "OFF", "LEAVE"],
        expression="x >= T",
        target=31,
        probes="ALL selector expansion",
    ),
    _count_case(
        "duplicate-shift-entry",
        coefficients={"D": 3},
        shift_types=("D",),
        count_shift_types=["D", "D"],
        expression="x >= T",
        target=19,
        probes="a repeated entry must not double-count a day",
    ),
    _count_case(
        "multi-pair-range",
        coefficients={"D": 2, "N": 3},
        expression=["x >= T", "x <= T"],
        target=[19, 25],
        probes="contracted-hours Range emits two pairs",
    ),
    _count_case(
        "date-group-above-bound",
        coefficients={"D": 2, "N": 3},
        expression="x >= T",
        target=10,
        count_dates="FIRST3",
        n_dates=3,
        date_groups={"FIRST3": [1, 2, 3]},
        probes="bound uses the EXPANDED date count, not the range length",
    ),
    _count_case(
        "date-group-at-bound",
        coefficients={"D": 2, "N": 3},
        expression="x >= T",
        target=9,
        count_dates="FIRST3",
        n_dates=3,
        date_groups={"FIRST3": [1, 2, 3]},
        must_solve=True,
        probes="expanded-count boundary",
    ),
    _count_case(
        "person-group",
        coefficients={"D": 2, "N": 3},
        expression="x >= T",
        target=19,
        people=("p1", "p2"),
        count_person="TEAM",
        probes="constraint replicated per member; bound unchanged",
        people_groups={"TEAM": ["p1", "p2"]},
    ),
    # --- must never fire ------------------------------------------------------
    _count_case(
        "upper-bound-le",
        coefficients={"D": 2, "N": 3},
        expression="x <= T",
        target=19,
        must_solve=True,
        probes="upper bounds are satisfiable at any T",
    ),
    _count_case(
        "upper-bound-lt",
        coefficients={"D": 2, "N": 3},
        expression="x < T",
        target=19,
        must_solve=True,
        probes="upper bounds are satisfiable at any T",
    ),
    _count_case(
        "soft-weight",
        coefficients={"D": 2, "N": 3},
        expression="x >= T",
        target=19,
        weight=100,
        must_solve=True,
        probes="a finite weight is soft and must never read as a conflict",
    ),
]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_g7_is_sound(case):
    """Every shape G7 calls infeasible really is, and every pinned boundary solves."""
    assert_sound(case)


def test_person_group_case_covers_two_people():
    """Guard the person-group fixture: a silently-empty group would prove nothing."""
    case = next(c for c in CASES if c.name == "person-group")
    assert b"TEAM" in case.yaml and b"p2" in case.yaml


def test_g7_is_deliberately_low_recall():
    """A truly-infeasible scenario under the bound stays silent — by design.

    ``max_x`` assumes the best-coefficient shift is workable every date. LEAVE is
    forced to 0 when unpinned, so a LEAVE-dominated count is unreachable long before
    the bound. G7 must not fire here; the solver still proves it impossible.
    """
    coefficients = {"D": 2, "LEAVE": 10}
    case = _count_case(
        "leave-under-bound",
        coefficients=coefficients,
        shift_types=("D",),
        count_shift_types=["D", "LEAVE"],
        expression="x >= T",
        target=59,
    )
    assert case.predicted_infeasible is False, "59 is under the bound of 60, so G7 must stay silent"
    assert solve(case.yaml) == INFEASIBLE, "only 12 is reachable, so this really is infeasible"


# --- the build-time validations G7's soundness rests on -----------------------
# These are not G7 tests; they pin the premises. If either stops raising, the
# attainable-max bound no longer holds and G7 must be re-verified before shipping.


def test_premise_coefficients_must_be_at_least_one():
    """A coefficient below 1 would break ``max(coefficients)`` as a per-day bound."""
    with pytest.raises(ValueError, match="at least 1"):
        solve(
            scenario(
                people=["p1"],
                shift_types=["D", "N"],
                preferences=[shift_count(person="p1", coefficients={"D": 5, "N": -3}, expression="x >= T", target=31)],
            )
        )


def test_premise_duplicate_coefficients_are_rejected():
    """Overlapping entries could let one day contribute twice, exceeding the bound."""
    with pytest.raises(ValueError, match="Duplicate shift count coefficient"):
        solve(
            scenario(
                people=["p1"],
                shift_types=["D", "N"],
                shift_groups={"WORK": ["D", "N"]},
                preferences=[
                    shift_count(person="p1", coefficients={"WORK": 3, "D": 3}, expression="x >= T", target=19)
                ],
            )
        )


def test_premise_one_shift_per_day_is_mandatory():
    """The loader must reject a scenario omitting it — the bound assumes it holds."""
    import yaml as _yaml

    doc = _yaml.safe_load(
        scenario(
            people=["p1"],
            shift_types=["D"],
            preferences=[shift_count(person="p1", coefficients={"D": 1}, expression="x >= T", target=7)],
        )
    )
    doc["preferences"] = [p for p in doc["preferences"] if p.get("type") != "at most one shift per day"]
    with pytest.raises(Exception, match="at most one shift per day"):
        solve(_yaml.safe_dump(doc, sort_keys=False).encode("utf-8"))
