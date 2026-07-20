# Backend scripts

Runnable operational tools for the nurse-scheduling backend. These are **not**
tests: pytest is scoped to `core/tests` (see `pyproject.toml` `testpaths`), so
nothing here is ever collected or executed by an ordinary test run.

## Supervised CP-SAT capability gate

`solver_capability_probe.py` proves that the supervised optimization process
behaves correctly on the large real scenario. It drives the real
`OptimizationRunner` through `run_optimization_process` (the same supervisor the
worker uses) and classifies each termination behavior in an isolated,
hard-watchdog subprocess. It is CP-SAT only: there is no solver matrix or
selector widening.

Rounds, in order:

1. **timeout** — native graceful timeout (`solver_timeout` with a feasible schedule).
2. **hard-watchdog** — forced hard watchdog (`process_timeout`).
3. **cancel** — forced cancellation with discarded output.
4. **finish-now** — cooperative finish (`user_requested` with the current feasible incumbent).
5. **intermediate-scores** — intermediate incumbent scores emitted before terminal.

The cancel and watchdog rounds also audit the process tree for residual children
(Linux only; the audit is skipped elsewhere while the terminal classification
still runs).

This gate is slow and platform-sensitive. Its pure classification and reporting
helpers are covered by the fast, always-collected
`tests/test_real_solver_capability_probe.py`.

Run the gate explicitly and optionally emit a machine-readable report:

```sh
cd core
PYTHONPATH=. python scripts/solver_capability_probe.py \
  --json-output cp-sat-capability-report.json
```

The process exits non-zero if any round fails.
