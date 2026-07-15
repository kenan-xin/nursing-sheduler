"""Ordered shift-type group map and contracted-hours (marked shift count) validation.

This module owns the single ordered shift-type ``id -> [indices]`` map used by
both scheduler context setup (`scheduler.py`) and scenario-root contracted-hours
validation (`models.NurseSchedulingData.validate_model`). Sharing one builder
guarantees a marked shift count's selectors expand through the identical
semantics the solver later uses (DL09 D5/D13).

Only `constants` is imported here so that `models` can import this module without
a circular import (`utils` imports `models`).
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

import math

from .constants import ALL, OFF, OFF_sid, LEAVE, LEAVE_sid


def build_shift_type_index_map(items, groups) -> dict:
    """Build the ordered shift-type ``id -> [indices]`` map.

    Insertion order is items, then the ALL/OFF/LEAVE keywords, then groups in
    definition order. Groups resolve through the map built so far, so a member
    that is not yet defined — a forward reference, a cycle, or an unknown id —
    fails immediately. The first ordered-map construction failure is therefore
    authoritative: a forward reference is reported before any later cycle label
    (DL09 D5).

    Worked shift types map to their index; ``ALL`` expands to the worked shift
    types only (excluding OFF/LEAVE); ``OFF``/``LEAVE`` map to their reserved
    sentinels. The result matches what the solver builds in scheduler setup.
    """
    map_sid_s: dict = {}
    n_shift_types = len(items)
    for s in range(n_shift_types):
        map_sid_s[items[s].id] = [s]
    # ALL intentionally expands to worked shift types only (excludes both the
    # OFF and LEAVE day-states).
    map_sid_s[ALL] = list(range(n_shift_types))
    map_sid_s[OFF] = [OFF_sid]
    map_sid_s[LEAVE] = [LEAVE_sid]
    for group in groups:
        indices: set = set()
        for member in group.members:
            if member not in map_sid_s:
                raise ValueError(
                    f"Shift type group {group.id!r} references undefined shift type or group ID {member!r} "
                    f"(forward reference, cycle, or unknown id)."
                )
            indices.update(map_sid_s[member])
        map_sid_s[group.id] = sorted(indices)
    return map_sid_s


def _validate_policy_encoding(preference) -> None:
    """Cross-field check that a marked shift count's raw solve fields match its
    declared Exact/Range policy (DL09 D2/D4, C1 CON-YAML-25)."""
    policy = preference.hoursContract.policy
    expression = preference.expression
    target = preference.target
    weight = preference.weight

    if weight != math.inf:
        raise ValueError(f"A {policy!r} contracted-hours shift count must use weight '.inf', but got {weight!r}.")

    if policy == "exact":
        if expression != "x = T":
            raise ValueError("An exact contracted-hours shift count must use expression 'x = T'.")
        if isinstance(target, list):
            raise ValueError("An exact contracted-hours shift count must use a scalar target.")
        if target < 0:
            raise ValueError(f"Contracted-hours target must be non-negative, but got {target}.")
    else:  # "range"
        if expression != ["x >= T", "x <= T"]:
            raise ValueError("A range contracted-hours shift count must use expression ['x >= T', 'x <= T'].")
        if not (isinstance(target, list) and len(target) == 2):
            raise ValueError("A range contracted-hours shift count must use a two-element [minimum, maximum] target.")
        minimum, maximum = target
        if minimum < 0 or maximum < 0:
            raise ValueError(f"Contracted-hours range targets must be non-negative, but got {target}.")
        if minimum > maximum:
            raise ValueError(f"Contracted-hours range minimum must not exceed maximum, but got {target}.")


def _validate_coverage(preference, map_sid_s: dict, group_ids: set) -> None:
    """Expand the marked selectors and require the explicit coefficient ids to
    equal the deduplicated expanded concrete worked/LEAVE set exactly (DL09 D4).

    ``ALL``/groups expand exactly as for a generic shift count; expanded ``OFF``,
    empty/unresolved coverage, non-concrete coefficient ids, and missing/extra/
    duplicate coefficients are all rejected.
    """
    selectors = preference.countShiftTypes
    if not isinstance(selectors, list):
        selectors = [selectors]
    if len(selectors) == 0:
        raise ValueError("A contracted-hours shift count requires non-empty countShiftTypes.")

    expanded: set = set()
    for selector in selectors:
        if selector not in map_sid_s:
            raise ValueError(f"Unknown shift type ID: {selector}")
        expanded.update(map_sid_s[selector])

    if len(expanded) == 0:
        raise ValueError("A contracted-hours shift count must select at least one shift type.")
    if OFF_sid in expanded:
        raise ValueError("'OFF' is not allowed in a contracted-hours shift count.")

    # `expanded` is now the concrete worked/LEAVE index set the coefficients must
    # match exactly.
    coefficient_entries = preference.countShiftTypeCoefficients or []
    coefficient_sids: set = set()
    for shift_type_id, coefficient in coefficient_entries:
        if coefficient < 1:
            raise ValueError(f"Contracted-hours coefficient for '{shift_type_id}' must be at least 1.")
        if shift_type_id == OFF:
            raise ValueError("'OFF' is not allowed in a contracted-hours shift count.")
        if shift_type_id == ALL or shift_type_id in group_ids:
            raise ValueError(
                f"Contracted-hours coefficient '{shift_type_id}' must be a concrete shift type or 'LEAVE', "
                f"not a group or 'ALL'."
            )
        if shift_type_id not in map_sid_s:
            raise ValueError(f"Unknown shift type ID: {shift_type_id}")
        # A concrete worked id maps to a single index and LEAVE to its sentinel;
        # ALL/OFF/groups are already rejected above.
        (sid,) = map_sid_s[shift_type_id]
        if sid in coefficient_sids:
            raise ValueError(f"Duplicate contracted-hours coefficient for '{shift_type_id}'.")
        coefficient_sids.add(sid)

    if expanded - coefficient_sids:
        raise ValueError(
            "A contracted-hours shift count must list an explicit coefficient for every selected shift "
            "type (including LEAVE); coverage is incomplete."
        )
    if coefficient_sids - expanded:
        raise ValueError("A contracted-hours coefficient does not correspond to any selected shift type.")


def validate_contracted_hours(shift_types_container, preferences) -> None:
    """Validate every marked (contracted-hours) shift count in a scenario.

    Builds the shared ordered shift-type map once and validates each marked
    preference's policy encoding and explicit coefficient coverage. A no-op when
    no shift count carries the ``hoursContract`` marker, so unmarked scenarios
    keep their existing load behavior. The marker itself stays solver-inert; this
    changes which documents load, not how valid raw fields solve.
    """
    marked = [preference for preference in preferences if getattr(preference, "hoursContract", None) is not None]
    if not marked:
        return

    map_sid_s = build_shift_type_index_map(shift_types_container.items, shift_types_container.groups)
    group_ids = {group.id for group in shift_types_container.groups}
    for preference in marked:
        _validate_policy_encoding(preference)
        _validate_coverage(preference, map_sid_s, group_ids)
