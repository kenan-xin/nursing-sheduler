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

The supervised CP-SAT capability gate is a separate opt-in tool that lives
outside the test tree; see `core/scripts/README.md`.
