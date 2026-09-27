"""Real-solver proof for temporary cover (bead nursing-sheduler-d582).

The web harness (web/lib/scenario/temporary-cover.fixtures.test.ts) writes each ward
as YAML before and after the submission transform. The split pairs change the
document's shape only (a card split per selector, or per date into explicit ISO date
lists), so the solver must give the same status and objective. The RN cover pair
lowers one night's need by one. Regenerate the fixtures with
`pnpm vitest run lib/scenario/temporary-cover.fixtures -u` (in web/).
"""

from pathlib import Path

from nurse_scheduling import scheduler

FIXTURES = Path(__file__).parent / "fixtures" / "temporary_cover"
CASES = sorted({path.name.split(".")[0] for path in FIXTURES.glob("*.before.yaml")})


def _solve(case: str, side: str) -> tuple[str, float | None]:
    path = FIXTURES / f"{case}.{side}.yaml"
    _df, _solution, score, status, _cells = scheduler.schedule(path.read_bytes(), timeout=30)
    return status, score


def test_the_harness_wrote_every_case():
    assert CASES == ["date_split", "rn_cover", "shift_split"]


def _assert_equivalent(case: str):
    before = _solve(case, "before")
    assert before[0] == "OPTIMAL"
    assert _solve(case, "after") == before


def test_shift_split_is_solver_equivalent():
    _assert_equivalent("shift_split")


def test_date_split_is_solver_equivalent_with_no_cover():
    _assert_equivalent("date_split")


def test_rn_cover_makes_an_rn_short_night_feasible():
    assert _solve("rn_cover", "before")[0] == "INFEASIBLE"
    assert _solve("rn_cover", "after")[0] in {"FEASIBLE", "OPTIMAL"}
