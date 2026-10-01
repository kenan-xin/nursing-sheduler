"""Score of negative soft shift-type successions equals a hand count (bead 304s).

The literal negative branch of `shift_type_successions` used to only lower-bound
`is_match`, so the model allowed is_match = 1 with no real match. These tests
check that the returned score never carries such a false violation: forced
rosters (OPTIMAL), a free solve, and first-solution stops (FEASIBLE), with
history crossing into day 0 and a pattern cut off at month end.
"""

import random

import pytest

import nurse_scheduling

SIDS = ["D", "E", "N"]
PATTERNS = [(["N", "D"], -1), (["E", "D", "N"], -3)]


def _yaml(histories, days, required=1, patterns=PATTERNS):
    people = "".join(f"    - id: {p}\n      history: [{', '.join(h)}]\n" for p, h in enumerate(histories))
    prefs = "".join(
        f"  - type: shift type successions\n    person: ALL\n    pattern: [{', '.join(pat)}]\n    weight: {w}\n"
        for pat, w in patterns
    )
    return f"""apiVersion: alpha
dates:
  range:
    startDate: 2023-08-01
    endDate: 2023-08-{days:02d}
people:
  items:
{people}shiftTypes:
  items:
    - id: D
    - id: E
    - id: N
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: [D, E, N]
    requiredNumPeople: {required}
{prefs}""".encode()


def _hand_count(solution, histories, days, patterns=PATTERNS):
    # A match counts when its last element is the last history day or later
    # (v1 semantics); matches running past month end are not counted.
    total = 0
    for p, history in enumerate(histories):
        seq = list(history)
        for d in range(days):
            seq.append(next((SIDS[s] for s in range(3) if solution[(d, s, p)]), "OFF"))
        for pat, weight in patterns:
            for start in range(len(seq) - len(pat) + 1):
                if start + len(pat) - 1 >= len(history) - 1 and seq[start : start + len(pat)] == pat:
                    total += weight
    return total


# Nurse 0's history completes E,D,N (-3, fixed) and ends N; nurse 1's ends E.
HISTORIES = [["E", "D", "N"], ["E"], []]


@pytest.mark.parametrize(
    ("roster", "expected"),
    [
        # n0: E D N|N D N E -> history E,D,N -3; N,D -1.
        # n1: E|D N D N     -> E,D,N across day 0 -3; N,D -1.
        # n2: E E E D       -> E,D cut off at month end: 0.
        (["NDE", "DNE", "NDE", "END"], -8),
        # No forbidden sequence inside the month; only the history-completed -3.
        (["END"] * 4, -3),
    ],
)
def test_forced_roster_score_matches_hand_count(roster, expected):
    # roster[d][p] is nurse p's shift on day d.
    days = len(roster)
    solution = {(d, s, p): int(roster[d][p] == SIDS[s]) for d in range(days) for s in range(3) for p in range(3)}
    assert _hand_count(solution, HISTORIES, days) == expected
    result = nurse_scheduling.schedule(_yaml(HISTORIES, days), forced_solution=solution)
    assert result.solver_status == "OPTIMAL"
    assert result.score == expected


def test_optimal_solve_score_matches_hand_count():
    days = 10
    result = nurse_scheduling.schedule(_yaml(HISTORIES, days), deterministic=True)
    assert result.solver_status == "OPTIMAL"
    assert result.score == _hand_count(result.solution, HISTORIES, days)


HARD_PATTERNS = [
    (["N", "D"], -5),
    (["N", "E"], -3),
    (["E", "D"], -2),
    (["D", "N"], -1),
    (["N", "N", "N"], -4),
    (["E", "E", "D"], -1),
]


@pytest.mark.parametrize("solver", ["ortools/cp-sat", "ortools/mpsolver/scip"])
def test_first_solution_score_matches_hand_count(solver):
    # Stopping at the first solution is where a free is_match could stay 1.
    rng = random.Random(2)
    histories = [[rng.choice(SIDS) for _ in range(rng.randint(0, 3))] for _ in range(12)]
    days = 31
    result = nurse_scheduling.schedule(
        _yaml(histories, days, required=3, patterns=HARD_PATTERNS),
        solver=solver,
        should_stop=lambda: True,
    )
    assert result.solver_status in ("OPTIMAL", "FEASIBLE")
    assert result.score == _hand_count(result.solution, histories, days, HARD_PATTERNS)
