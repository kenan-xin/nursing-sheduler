"""Reusable CP-SAT oracle for the Tier-1 conflict catalogue.

The frontend's conflict catalogue (28 checks) exists to warn, before a run, about
rule combinations that are *guaranteed* infeasible. Its entire value is the
zero-false-positive guarantee: every member was admitted only after the real
CP-SAT scheduler was run as an oracle on candidate shapes, and anything that came
back solvable was cut. This module is that bar, made reusable.

**The one rule this harness enforces: only the sound direction is asserted.**

    predicted infeasible  =>  the solver MUST return INFEASIBLE

The converse is deliberately *not* asserted. The catalogue's checks are bounded
relaxations, so a scenario the solver proves infeasible may well sit outside every
check — that is low recall, which is the intended trade. A check that fires on a
solvable scenario is a false positive, and one false alarm costs more user trust
than a narrow check can earn back.

To vet a *new* candidate check:

  1. Write a predicate over the scenario's parameters (see ``g7_predicts_infeasible``).
  2. Enumerate candidate shapes, including the exact boundary and every structural
     edge you can think of (group expansion, reserved day-states, multi-pair
     predicates, competing constraints).
  3. Assert only the sound direction. If any predicted-infeasible shape solves, the
     check is dead — do not weaken the test, drop the check.

Scenarios built here are intentionally tiny (1-2 people, a handful of days), so a
full sweep solves in well under a second and belongs in the ordinary test run.
Contrast ``core/scripts/solver_capability_probe.py``, which is a slow real-scale
probe deliberately kept out of the test tree.
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
from dataclasses import dataclass, field
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nurse_scheduling
import yaml

#: Weight that makes a preference a hard constraint. Staffing and coverings are
#: hard at any weight; requests / successions / counts / affinities are soft at a
#: finite weight and hard only at +/- infinity (LEAVE requests always pin).
HARD = float("inf")
FORBID = -float("inf")

INFEASIBLE = "INFEASIBLE"
SOLVED = "SOLVED"

#: The loader rejects any scenario omitting this, and the model separately enforces
#: exactly one day-state per person-day. Both facts underpin every attainable-max
#: argument, so the builder always emits it.
ONE_SHIFT_PER_DAY = {"type": "at most one shift per day"}


def scenario(
    *,
    people,
    shift_types,
    preferences,
    days=6,
    start="2025-01-01",
    people_groups=None,
    shift_groups=None,
    date_groups=None,
):
    """Build a minimal scenario document as YAML bytes.

    ``preferences`` are appended after the mandatory one-shift-per-day preference.
    Group arguments take ``{group_id: [member, ...]}`` and are emitted in the
    ``groups`` block of the matching section.
    """
    first = date.fromisoformat(start)
    doc = {
        "apiVersion": "alpha",
        "dates": {"range": {"startDate": first, "endDate": first + timedelta(days=days - 1)}},
        "people": {"items": [{"id": p} for p in people]},
        "shiftTypes": {"items": [{"id": s} for s in shift_types]},
        "preferences": [ONE_SHIFT_PER_DAY, *preferences],
    }
    for section, groups in (("dates", date_groups), ("people", people_groups), ("shiftTypes", shift_groups)):
        if groups:
            doc[section]["groups"] = [{"id": gid, "members": list(members)} for gid, members in groups.items()]
    return yaml.safe_dump(doc, sort_keys=False).encode("utf-8")


def shift_count(*, person, coefficients, expression, target, weight=HARD, count_dates="ALL", count_shift_types=None):
    """A `shift count` preference. ``coefficients`` maps shift-type id to coefficient."""
    return {
        "type": "shift count",
        "person": person,
        "countDates": count_dates,
        "countShiftTypes": list(count_shift_types if count_shift_types is not None else coefficients),
        "countShiftTypeCoefficients": [[s, c] for s, c in coefficients.items()],
        "expression": expression,
        "target": target,
        "weight": weight,
    }


def solve(yaml_bytes):
    """Run the real scheduler and reduce the outcome to ``INFEASIBLE`` / ``SOLVED``.

    Build-time rejections propagate: a candidate shape the loader or validator
    refuses is a finding in its own right, not something to swallow.
    """
    dataframe, _solution, _score, _status, _cell_export_info = nurse_scheduling.schedule(yaml_bytes)
    return INFEASIBLE if dataframe is None else SOLVED


@dataclass(frozen=True)
class OracleCase:
    """One candidate shape: how to build it, and what the check predicts."""

    name: str
    yaml: bytes
    predicted_infeasible: bool
    #: Free-text note on what structural edge this shape probes.
    probes: str = ""
    #: Set when the shape is expected to be solvable, to pin a boundary in place.
    must_solve: bool = False
    tags: tuple = field(default_factory=tuple)


def assert_sound(case):
    """Assert the sound direction, and any explicitly-pinned boundary.

    Raises ``AssertionError`` with the case name and what it probes, so a failure
    reads as "this candidate check is unsound because of X" rather than a bare
    status mismatch.
    """
    actual = solve(case.yaml)
    if case.predicted_infeasible and actual != INFEASIBLE:
        raise AssertionError(
            f"UNSOUND: {case.name!r} was predicted infeasible but the solver returned {actual}. "
            f"Probes: {case.probes or 'n/a'}. A check that fires here is a false positive — drop the check."
        )
    if case.must_solve and actual != SOLVED:
        raise AssertionError(
            f"BOUNDARY MOVED: {case.name!r} must stay solvable but the solver returned {actual}. "
            f"Probes: {case.probes or 'n/a'}. The check's threshold is off by one, or a premise changed."
        )
    return actual


def max_attainable(*, n_dates, coefficients):
    """Loosest possible total for a shift count: one day-state per day, best coefficient.

    Mirrors ``max_x`` in ``preference_types``. It ignores whether the best-coefficient
    shift is actually assignable on every date (leave pinning, staffing caps,
    successions), so it is an upper bound only — which is exactly what makes a check
    built on it sound but low-recall.
    """
    return n_dates * max(coefficients.values())
