"""v2 run explanations: the penalty ledger of a solved roster."""

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

# This file is mostly AI generated.

import logging
import time
from typing import Any

from ortools.sat.python import cp_model

from . import constants
from .context import Context

logger = logging.getLogger(__name__)

# ponytail: the top matches by |points| only; per-rule totals stay exact. Raise if a ward needs more.
MAX_LEDGER_MATCHES = 1000

_RESERVED_SHIFTS = {constants.OFF_sid: constants.OFF, constants.LEAVE_sid: constants.LEAVE}


def _names(ctx: Context):
    people = [person.id for person in ctx.scenario.people.items]
    dates = [str(date) for date in ctx.compiled_schedule.dates]
    shifts = [shift.id for shift in ctx.scenario.shiftTypes.items]
    return people, dates, shifts


def _key_fields(key, names) -> dict[str, Any]:
    """Map a (d, s, p) index key to {date, shift, nurse} ids, leaving out unknown parts."""
    if key is None:
        return {}
    people, dates, shifts = names
    d, s, p = key
    out: dict[str, Any] = {}
    if p is not None:
        out["nurse"] = people[p]
    if d is not None:
        out["date"] = dates[d]
    if s is not None:
        out["shift"] = _RESERVED_SHIFTS.get(s) or shifts[s]
    return out


def read_ledger(ctx: Context) -> dict[str, Any]:
    """Per-term points of the solved roster, like Timefold's ScoreAnalysis.

    Every finite objective term was recorded by utils.add_objective. A term's
    points are weight * value. The points of all terms sum to the objective
    exactly; `balanced` is False only if a term bypassed add_objective.
    """
    started = time.monotonic()
    names = _names(ctx)
    solver = ctx.solver
    value = solver.get_value
    if isinstance(getattr(solver, "model", None), cp_model.CpModel) and solver._active_solution_callback is None:
        # One proto read instead of ~50k Value() calls on the 87-person ward (84 ms -> a few ms).
        solution = list(solver.solver.response_proto.solution)
        slow = value

        def value(expression):
            if isinstance(expression, cp_model.IntVar):
                return solution[expression.index]
            return slow(expression)

    rules: dict[int, dict[str, int]] = {}
    matches = []
    total = 0
    for rule, key, weight, expression in ctx.objective_terms:
        points = weight * value(expression)
        if not points:
            continue
        total += points
        entry = rules.setdefault(rule, {"rule": rule, "points": 0, "matches": 0})
        entry["points"] += points
        entry["matches"] += 1
        matches.append({"rule": rule, **_key_fields(key, names), "points": points})
    objective = solver.get_objective_value()
    if total != objective:
        logger.error("Ledger total %s differs from objective %s", total, objective)
    matches.sort(key=lambda m: -abs(m["points"]))
    return {
        "objective": objective,
        "balanced": total == objective,
        "terms": len(ctx.objective_terms),
        "rules": sorted(rules.values(), key=lambda r: r["rule"]),
        "matches": matches[:MAX_LEDGER_MATCHES],
        "truncated": len(matches) > MAX_LEDGER_MATCHES,
        "seconds": round(time.monotonic() - started, 4),
    }
