"""v2 run explanations: the penalty ledger of a solved roster, and why a run found no roster."""

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
import math
import os
import threading
import time
from typing import Any

from ortools.sat.python import cp_model

from . import constants, models
from .context import Context
from .solver_interface import SolverStatus

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
    points are weight * value. The variables' points sum to the objective exactly;
    `balanced` is False only if a term bypassed add_objective. A term the model only
    bounds (a negative soft succession's is_match) is read from the roster instead,
    so a non-optimal roster never shows a violation that did not happen; the points
    such a variable still costs are `unattributed`.
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
    total = counted = 0
    for rule, key, weight, expression, truth in ctx.objective_terms:
        points = weight * value(expression)
        counted += points
        if truth is not None:
            points = weight * truth(value)
        if not points:
            continue
        total += points
        entry = rules.setdefault(rule, {"rule": rule, "points": 0, "matches": 0})
        entry["points"] += points
        entry["matches"] += 1
        matches.append({"rule": rule, **_key_fields(key, names), "points": points})
    objective = solver.get_objective_value()
    if counted != objective:
        logger.error("Ledger total %s differs from objective %s", counted, objective)
    matches.sort(key=lambda m: -abs(m["points"]))
    return {
        "objective": objective,
        "balanced": counted == objective,
        "unattributed": objective - total,
        "terms": len(ctx.objective_terms),
        "rules": sorted(rules.values(), key=lambda r: r["rule"]),
        "matches": matches[:MAX_LEDGER_MATCHES],
        "truncated": len(matches) > MAX_LEDGER_MATCHES,
        "seconds": round(time.monotonic() - started, 4),
    }


# Each hard rule unit (a request cell, one staffing slot, one nurse's cap, ...) got a
# guard literal when the model was rebuilt for this explanation, pinned true by its
# domain. Here the guards are freed and assumed: CP-SAT then runs on one worker,
# returns a sufficient core, and a deletion loop shrinks it to a minimal one.

# Budgets (seconds). The no-objective check proved the counting-type synthetic wards
# (58-116 people) infeasible in 1.6-4.1 s on 2 workers; the core solve p95 was 10 s on a fast desktop,
# so the core gets 30 s for slower 2-vCPU hosts (check + core stay inside the 90 s watchdog grace).
PROOF_SECONDS = float(os.getenv("OPTIMIZE_INFEASIBILITY_CHECK_SECONDS", "10"))
WHY_BUDGET_SECONDS = float(os.getenv("OPTIMIZE_INFEASIBILITY_WHY_SECONDS", "30"))
WHY_SOLVE_SECONDS = 3.0
WHY_FIRST_TRY_SECONDS = 4.0
# Presolve off made the one-worker core solve 8-10x faster on 36-100 person wards;
# linearization 2 finds counting cores (hours vs rest) that the plain search misses.
CORE_TRIES = ({"cp_model_presolve": False}, {"cp_model_presolve": False, "linearization_level": 2})

# Relax cost of each unit kind, in the approved remedy order (soften a hard request, relax
# a cap, change a staffing number, move leave). It only orders the core's deletion: kinds
# not listed are never relaxed, so they are dropped first and the surviving core names
# the cheapest rules to change. A staffing unit holds both its floor and its ceiling.
RELAX_COST = {"request": 10, "cap": 20, "staffing": 100, "leave": 1000}
NEVER = 10**9

_UPPER = {(math.inf, "x <= T"), (math.inf, "x < T"), (-math.inf, "x > T"), (-math.inf, "x >= T")}


def unit_kind(ctx: Context, key) -> str:
    """What a guard unit is, in remedy terms."""
    i, detail = key
    preference = ctx.scenario.preferences[i]
    compiled = ctx.compiled_schedule.preferences[i]
    if preference.type == models.SHIFT_REQUEST:
        return "leave" if constants.LEAVE_sid in compiled.shift_types else "request"
    if preference.type == models.SHIFT_TYPE_REQUIREMENT:
        return {"staff": "staffing", "mix": "skill_mix", "who": "qualification"}[detail[0]]
    if preference.type == models.SHIFT_COUNT:
        if preference.hoursContract is not None or any(c != 1 for _, c in compiled.coefficients):
            return "contracted_hours"
        upper = (preference.weight, compiled.expressions[detail[1]]) in _UPPER
        return "cap" if upper else "count"  # a floor or an exact count: never relaxed
    return {
        models.SHIFT_TYPE_SUCCESSIONS: "succession",
        models.SHIFT_TYPE_COVERING: "covering",
        models.SHIFT_AFFINITY: "affinity",
    }.get(preference.type, "other")


def unit_fields(ctx: Context, key, names) -> dict[str, Any]:
    """JSON for one guard unit: its rule index, kind and where it applies."""
    people, dates, shifts = names
    shift_id = lambda s: _RESERVED_SHIFTS.get(s) or shifts[s]  # noqa: E731
    i, detail = key
    kind = unit_kind(ctx, key)
    compiled = ctx.compiled_schedule.preferences[i]
    out: dict[str, Any] = {"rule": i, "kind": kind}
    if kind in ("staffing", "skill_mix", "qualification"):
        _tag, d, g = detail
        out["date"] = dates[d]
        out["shift"] = [shift_id(s) for s in compiled.shift_type_groups[g]]
        if kind == "staffing":
            # The unit is the floor and the ceiling: at least `need` and at most `max`
            # (the preferred head count, or exactly `need` when there is none).
            need = dict(compiled.required_by_date).get(d, ctx.scenario.preferences[i].requiredNumPeople)
            preferred = ctx.scenario.preferences[i].preferredNumPeople
            out.update(need=need, max=need if preferred is None else preferred)
    elif kind in ("request", "leave"):
        d, p = detail
        out.update(nurse=people[p], date=dates[d], shift=[shift_id(s) for s in compiled.shift_types])
        if kind == "request":
            # A hard request is a must (+inf) or a must-not (-inf).
            out["must"] = ctx.scenario.preferences[i].weight == math.inf
    elif ctx.scenario.preferences[i].type == models.SHIFT_COUNT:
        p, pair = detail
        out.update(nurse=people[p], expression=compiled.expressions[pair], target=compiled.targets[pair])
    elif ctx.scenario.preferences[i].type == models.SHIFT_TYPE_SUCCESSIONS:
        out["nurse"] = people[detail[0]]
    elif ctx.scenario.preferences[i].type == models.SHIFT_TYPE_COVERING:
        out["date"] = dates[detail[0]]
    return out


def _cpsat(workers: int = 1, seconds: float = 1.0, **parameters) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = workers
    solver.parameters.max_time_in_seconds = max(0.01, seconds)
    for name, value in parameters.items():
        setattr(solver.parameters, name, value)
    return solver


def _solve(solver: cp_model.CpSolver, model: cp_model.CpModel, should_stop=None):
    """Solve, stopping the search soon after `should_stop()` turns true."""
    if should_stop is None:
        return solver.solve(model)
    done = threading.Event()

    def watch():
        while not done.wait(0.2):
            if should_stop():
                solver.stop_search()
                return

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        return solver.solve(model)
    finally:
        done.set()
        watcher.join()


def core_units(ctx: Context, should_stop=None) -> dict[str, Any] | None:
    """A minimal (within budget) set of hard rule units (guard keys) that cannot all hold.

    Deletion order: never-relaxed units first, then the costliest to change, so the
    surviving core names the rules that are cheapest to change (QuickXplain's
    preferred conflict). Every intermediate core is a valid proof, so a timeout
    returns the current one with `minimal: False`.
    """
    started = time.monotonic()
    model, guards = ctx.solver.model, ctx.solver.guards
    cost = {key: RELAX_COST.get(unit_kind(ctx, key), NEVER) for key in guards}
    order = {key: n for n, key in enumerate(sorted(guards, key=lambda k: -cost[k]))}
    by_index = {literal.index: key for key, literal in guards.items()}
    for literal in guards.values():
        model.proto.variables[literal.index].domain[0] = 0
    model.clear_objective()
    solves = 0

    def remaining() -> float:
        return WHY_BUDGET_SECONDS - (time.monotonic() - started)

    tried = CORE_TRIES[0]

    def solve(assumed, seconds):
        nonlocal solves
        solves += 1
        model.clear_assumptions()
        model.add_assumptions([guards[key] for key in assumed])
        solver = _cpsat(seconds=seconds, **tried)
        status = _solve(solver, model, should_stop)
        if status == cp_model.INFEASIBLE:
            core = {by_index[i] for i in solver.sufficient_assumptions_for_infeasibility()}
            return "infeasible", sorted(core, key=order.get)
        return ("feasible" if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else "unknown"), None

    everything = sorted(guards, key=order.get)
    verdict, core = solve(everything, min(WHY_FIRST_TRY_SECONDS, remaining()))
    if verdict == "unknown" and remaining() > 0.5:
        tried = CORE_TRIES[1]
        verdict, core = solve(everything, remaining())
    if verdict != "infeasible":
        # "feasible" would contradict the run's proof; the proof stands either way.
        log = logger.error if verdict == "feasible" else logger.warning
        log("Infeasibility core solve ended %s after %.2fs", verdict, time.monotonic() - started)
        model.clear_assumptions()
        return None
    minimal = True
    for unit in list(core):
        if unit not in core:
            continue  # an earlier refinement already dropped it
        if remaining() <= 0 or (should_stop is not None and should_stop()):
            minimal = False
            break
        verdict, smaller = solve([k for k in core if k != unit], min(WHY_SOLVE_SECONDS, remaining()))
        if verdict == "infeasible":
            core = smaller
        elif verdict == "unknown":
            minimal = False
    model.clear_assumptions()
    return {
        "units": core,
        "minimal": minimal,
        "solves": solves,
        "guards": len(guards),
        "seconds": round(time.monotonic() - started, 3),
    }


def why_infeasible(ctx: Context, should_stop=None) -> dict[str, Any] | None:
    """The core as JSON: each unit's rule index, kind and where it applies."""
    core = core_units(ctx, should_stop)
    if core is None:
        return None
    names = _names(ctx)
    units = core.pop("units")
    return {"members": [unit_fields(ctx, key, names) for key in units], **core}


def explain_no_roster(ctx: Context, status: SolverStatus, should_stop=None) -> dict[str, Any] | None:
    """Explain a run that found no roster, if it is proven INFEASIBLE.

    An UNKNOWN run (time ran out with no roster and no proof) first gets a short
    feasibility check without the objective: on the synthetic 58-116 person wards it
    proved in 2-4 s what the optimising run could not in 60 s. Returns None when there
    is no proof. Never raises: the run's own status stands without it.
    """
    try:
        proof = "main_run"
        if status == SolverStatus.UNKNOWN:
            if should_stop is not None and should_stop():
                return None
            ctx.solver.model.clear_objective()
            started = time.monotonic()
            # The default portfolio, not the optimising run's extra max_lp_sym worker.
            check = _cpsat(workers=ctx.solver.solver.parameters.num_workers, seconds=PROOF_SECONDS)
            if _solve(check, ctx.solver.model, should_stop) != cp_model.INFEASIBLE:
                return None
            proof = f"feasibility_check:{time.monotonic() - started:.2f}s"
        elif status != SolverStatus.INFEASIBLE:
            return None
    except Exception:
        logger.exception("The infeasibility proof check failed")
        return None
    try:
        core = why_infeasible(ctx, should_stop)
    except Exception:
        # The proof stands without a named clash.
        logger.exception("The infeasibility core solve failed")
        core = None
    return {"kind": "infeasible", "proof": proof, "core": core}
