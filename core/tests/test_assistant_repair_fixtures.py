"""Real-solver proof for the assistant's scripted repair scenarios.

The web harness (web/lib/ai/assistant/repair-eval.test.ts) writes each scripted ward
as YAML before and after the assistant's top-ranked repair. Here the real CP-SAT
solver confirms the claim the assistant makes: the ward as written cannot be solved,
and the ward after the top repair can. Regenerate the fixtures with
`pnpm vitest run lib/ai/assistant/repair-eval -u` (in web/; a vitest file-snapshot
update, not an env var).
"""

from pathlib import Path

import pytest

from nurse_scheduling import scheduler

FIXTURES = Path(__file__).parent / "fixtures" / "assistant_repair"
CASES = sorted({path.name.split(".")[0] for path in FIXTURES.glob("*.before.yaml")})


def _status(path: Path) -> str:
    _df, _solution, _score, status_name, _cells = scheduler.schedule(path.read_bytes(), timeout=30)
    return status_name


def test_the_harness_wrote_every_case():
    assert CASES == [
        "busyNightsWithRestRule",
        "conflictingRequirements",
        "onlyRnOnLeave",
        "personalCapsTooLow",
        "rnMixOnLeave",
        "ruleTooStrict",
        "tooFewNurses",
        "understaffedNight",
    ]


@pytest.mark.parametrize("case", CASES)
def test_before_is_infeasible(case):
    assert _status(FIXTURES / f"{case}.before.yaml") == "INFEASIBLE"


@pytest.mark.parametrize("case", CASES)
def test_after_the_top_repair_is_feasible(case):
    assert _status(FIXTURES / f"{case}.after.yaml") in {"FEASIBLE", "OPTIMAL"}
