# Real-World Scenario Checks

These checks solve larger real-world scenarios with a fixed optimization budget.
They are slower and less deterministic than the normal unit and regression tests.

The Python files in this directory intentionally omit pytest's `test_` filename
prefix so that the default test suite does not collect them.

Run real-world checks explicitly:

```sh
cd core
pytest --log-cli-level=INFO tests/real/schedule_ortools_cp_sat.py
```

To print model-build timing and variable/constraint deltas for the large
scenario, run:

```sh
cd core
python -m nurse_scheduling.cli \
  tests/testcases/real/large-ward-with-87-people-2025-11.yaml \
  --timeout 10 \
  --show-model-build-stats
```

To record a score/comment-count curve for later plotting, write progress events
to JSON Lines:

```sh
cd core
python -m nurse_scheduling.cli \
  tests/testcases/real/large-ward-with-87-people-2025-11.yaml \
  --timeout 180 \
  --progress-output progress.jsonl
```

To record the same progress JSONL while injecting the real-test critical-request
comment formatting rules, use the real CLI wrapper:

```sh
cd core
python tests/real/run_schedule.py \
  tests/testcases/real/large-ward-with-87-people-2025-11.yaml \
  --prettify \
  --timeout 180 \
  --progress-output progress.jsonl
```

## Solver capability probe

`solver_capabilities.py` probes the supervised optimization process through the
real FastAPI app (`create_app`, `TestClient`, `MemoryJobStore`) on the large
87-person scenario. It uses four isolated rounds in fixed order: timeout,
cancellation, finish-now, then intermediate scores. The product ships OR-Tools
CP-SAT only, so name that selector:

```sh
cd core
python tests/real/solver_capabilities.py --solver ortools/cp-sat
```

Each round runs in its own killable subprocess as a final safety boundary. The
command prints a Markdown table and exits nonzero when any round reports `FAIL`.
`INCONCLUSIVE` means the solver finished before the capability was exercised, or
finish-now stopped before a feasible incumbent was available. `NOT_CONFIRMED`
means the registry does not claim a cooperative control or progress capability.
`--json-output PATH` also writes elapsed times, terminal states, solver statuses
and runtime information.

The module omits pytest's `test_` filename prefix, so the default suite never
collects it. Its pure classification and reporting helpers are covered by the
fast, always-collected `tests/test_real_solver_capabilities.py`.

## Solver process residue

`solver_capabilities_residue.py` keeps the Linux-only `/proc` audit that the
retired v2 probe carried: once a cancelled CP-SAT job is terminal, no supervised
solver child may still be alive. It runs the probe's real cancellation round
in-process and samples `multiprocessing` spawn children of the test process. It
is opt-in as well, and skips on non-Linux platforms:

```sh
cd core
PYTHONPATH=. pytest -q tests/real/solver_capabilities_residue.py
```
