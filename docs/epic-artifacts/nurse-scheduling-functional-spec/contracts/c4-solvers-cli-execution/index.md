---
kind: spec
title: "Contract C4 — Solvers, CLI & Execution"
---

# Contract C4 — Solvers, CLI & Execution

## Purpose & Scope

This contract fixes the observable behavior of the Python core's solving engine, its command-line interface, and the progress/status wire payloads that the (rebuilt) frontend must select against and consume. The Python core is **NOT** being rebuilt; this document records its exact behavior for **STRICT PARITY** conformance.

Scope covered:
- Solver selection strings and dispatch (`ortools/cp-sat`, `pulp/cbc`, `pulp/cuopt`).
- Per-solver capabilities: native Boolean vs. linear (Big-M / one-hot) encodings; cuOpt GPU/`pulp.CUOPT` requirement.
- Cooperative stop (`should_stop`) support — only OR-Tools; PuLP raises `NotImplementedError`.
- Solve options: `timeout`, `deterministic` (seed/workers).
- Progress payloads (`SolverProgress`, `SchedulePhaseProgress`), their serialization, `commentCount`, and the phase codes emitted by `schedule()`.
- `SolverStatus` enum, per-solver status mapping, infeasibility / no-solution handling.
- Input preconditions enforced by `schedule()` (`apiVersion == "alpha"`, `country in {None, "SG"}`).
- CLI surface: positional args, flags, choices, exit codes, error strings, model-build-stats format.

The frontend's role is **conformance-only**: it selects the solver/timeout/prettify options and consumes the progress/score/status outputs. It does not re-implement solving.

> Boundary note: The `schedule()` function accepts additional parameters (`deterministic`, `avoid_solution`, `should_stop`) that the CLI does **not** expose. They are documented here because they are part of the fixed core contract that a future non-CLI frontend caller may invoke; the current CLI never sets them (`core/nurse_scheduling/cli.py:190-197`).

---

## Solvers & Selection [CON-EXE-nn]

### CON-EXE-01 — Selection string format

The `solver` argument is a single string of the form `"<backend>/<engine>"`. `schedule()` lowercases it and splits on the **first** `/`: `solver_backend, solver_engine = solver.lower().split("/", maxsplit=1)` (`core/nurse_scheduling/scheduler.py:137`). The default is `"ortools/cp-sat"` (`core/nurse_scheduling/scheduler.py:60`; CLI default `core/nurse_scheduling/cli.py:116`).

Dispatch table (`core/nurse_scheduling/scheduler.py:140-156`):

| `solver` string | backend / engine | Solver class | Module |
| --- | --- | --- | --- |
| `ortools/cp-sat` (default) | `ortools` / `cp-sat` | `ORToolsSolver` | `solver_ortools_cp_sat.py` |
| `pulp/cbc` | `pulp` / `cbc` | `PuLPSolver` | `solver_pulp_cbc.py` |
| `pulp/cuopt` | `pulp` / `cuopt` | `PuLPCuOptSolver` | `solver_pulp_cuopt.py` |

### CON-EXE-02 — Unsupported selection

Any backend/engine combination not in the table above raises:

```
ValueError(f"Unsupported solver configuration: backend={solver_backend!r}, engine={solver_engine!r}")
```

(`core/nurse_scheduling/scheduler.py:155-156`). Note the values are `repr`-formatted (quoted). The CLI never triggers this path directly because argparse `choices` restrict `--solver` to the three valid strings (`core/nurse_scheduling/cli.py:117`); a non-CLI caller passing an arbitrary string can hit it.

### CON-EXE-03 — Common solver interface

All solvers subclass `SolverInterface` (`core/nurse_scheduling/solver_interface.py:120`). Every implementation must provide: `new_bool_var`, `new_int_var`, `add_constraint`, `add_bool_or`, `create_bool_and_var`, `should_use_bool_and_var`, `set_objective`, `solve`, `get_status_name`, `get_value`, `get_objective_value`, `get_statistics`, `validate_model`, `negate`, `create_bool_var_with_constraint`, `add_abs_equality`, `add_squared_equality`, `create_solution_callback`. `__init__` sets `objective_expr = None` and `maximize = True` (`core/nurse_scheduling/solver_interface.py:127-130`). Objective is always maximization in `schedule()`: `ctx.solver.set_objective(ctx.objective, maximize=True)` (`core/nurse_scheduling/scheduler.py:290`).

### CON-EXE-04 — Native Boolean (OR-Tools/CP-SAT) capabilities

- Boolean/int vars are native CP-SAT vars (`model.NewBoolVar`, `model.NewIntVar`) (`core/nurse_scheduling/solver_ortools_cp_sat.py:43-49`).
- `add_bool_or` uses native `model.AddBoolOr` (`:57`).
- `create_bool_and_var` uses native `AddBoolAnd(...).OnlyEnforceIf(var)` plus a reverse `AddBoolOr` (`:59-77`).
- `should_use_bool_and_var(n)` returns **`True`** unconditionally — native Boolean AND (`:79-81`).
- `create_bool_var_with_constraint` uses reification via `OnlyEnforceIf` for each operator `EQ/NE/GE/GT/LE/LT`; unknown operator raises `NotImplementedError(f"Operator {operator} not implemented for OR-Tools solver.")` (`:201-228`).
- `add_abs_equality` uses native `model.AddAbsEquality` (`:230-232`).
- `add_squared_equality` uses native `model.AddMultiplicationEquality(target, [x, x])` (`:234-236`).
- `negate(var)` returns `var.Not()` (`:197-199`).

### CON-EXE-05 — Linear-encoding (PuLP shared base) capabilities

`BasePuLPSolver` (`core/nurse_scheduling/solver_pulp.py:34`) builds a `pulp.LpProblem("NurseScheduling", pulp.LpMaximize)` (`:40`) and encodes everything as linear constraints:

- Vars are `pulp.LpVariable` with `cat=pulp.LpBinary` / `cat=pulp.LpInteger` (`:166-178`). Names are deduplicated via `_unique_name` / `unique_constraint_name` (`:123-133`).
- `add_bool_or` linearizes `OR(x1..xn)` as `sum(xi) >= 1` (`:187-198`).
- `create_bool_and_var` linearizes `var <=> AND(literals)` with `var <= literal_i` upper bounds and `var >= sum(literals) - n + 1` lower bound (`:200-224`).
- `should_use_bool_and_var(n)` returns **`n_literals <= 3`** — linear AND encoding is only preferred while compact (`:226-228`). This is the key behavioral difference from OR-Tools.
- `create_bool_var_with_constraint` uses **Big-M** reification (auxiliary `side_var`, threshold shifting for GT/LT/GE/LE, and constant-fold shortcuts `_fix_bool(0/1, ...)` when the comparison is trivially true/false) (`:412-541`). Requires valid `source_expr_range`; raises `ValueError` on invalid or out-of-inferred-bounds ranges (`:418-425`). Unknown operator raises `NotImplementedError(f"Operator {operator} not implemented for PuLP solver.")` (`:541`).
- `add_abs_equality` linearizes `t = |x|` with a binary `sign_var` and Big-M bounds (`:543-596`); validates bounds against inferred bounds (`ValueError` on mismatch).
- `add_squared_equality` uses **exact one-hot value enumeration** over the integer domain of `source_var` (`:598-650`). Constraints: negative lower bound raises `ValueError` (`:623-624`); domain size `> 128` raises `NotImplementedError(f"Domain too large for exact square linearization: {domain_size}. ...")` (`:630-634`).
- `negate(var)` returns `1 - var` (affine) (`:408-410`).
- `get_value` normalizes near-integers via `_normalize_numeric_value` (snaps to int within `1e-6`) (`:367-369`, `:50-59`).
- `create_solution_callback` returns **`None`** and logs `"Solution callbacks are not supported by PuLP solver"` (`:656-670`).

### CON-EXE-06 — CBC engine specifics (`pulp/cbc`)

`PuLPSolver(BasePuLPSolver)` with `engine="cbc"` (`core/nurse_scheduling/solver_pulp_cbc.py:47-48`).

- Uses `pulp.PULP_CBC_CMD`. Base `solve()` sets `solver_kwargs["msg"] = 0` for CBC, and appends solver options `"randomS 0"` and `"threads 1"` when `deterministic=True` (`core/nurse_scheduling/solver_pulp.py:292-301`).
- Log stream **is** replayed to stdout for CBC (`replay_output = (self.engine == "cbc")`, `:286`).
- Progress is parsed from the CBC solver log via regexes matching `Cbc####I Integer solution of ...`, `Cbc0048I Final check on integer solution of ...`, and `Objective value: ...` (`core/nurse_scheduling/solver_pulp_cbc.py:40-77`).
- CBC-specific sign handling: for non-`final-objective` maximization incumbents, the logged (negated minimization) value is negated back: `score = -score` (`:50-56`). Scores are asserted integral via `assert_int_score(..., label="PuLP/CBC progress score")`.

### CON-EXE-07 — cuOpt engine specifics (`pulp/cuopt`)

`PuLPCuOptSolver(BasePuLPSolver)` with `engine="cuopt"` (`core/nurse_scheduling/solver_pulp_cuopt.py:54-55`).

- Requires `pulp.CUOPT` to be present, else base `solve()` raises `RuntimeError("PuLP cuOpt backend is unavailable: pulp.CUOPT is not present. Install a PuLP build/version with cuOpt support.")` (`core/nurse_scheduling/solver_pulp.py:302-307`).
- cuOpt is a **GPU** MILP backend (NVIDIA cuOpt). If the constructed solver reports `available()` false, base `solve()` raises `RuntimeError(f"PuLP/{self.engine} backend is not available in this environment. Ensure the required solver runtime is installed and configured.")` (`:314-320`).
- `deterministic=True` is **not implemented**; base `solve()` logs `"Deterministic mode is not implemented for PuLP/cuOpt; ignoring."` and proceeds (`:308-309`).
- Log stream is **not** replayed to stdout (`replay_output` is only true for `cbc`).
- Progress parsed from cuOpt log rows: branch-and-bound (`^[A-Z]\s+\d+\s+\d+\s+<num>`), heuristic (`^H\s+<num>`), primal-heuristic, root-optimal (`Optimal solution found at root node. Objective <num>`), final-objective (`Solution objective: <num>`) (`core/nurse_scheduling/solver_pulp_cuopt.py:42-52`). Scores asserted integral via `assert_int_score(..., label="PuLP/cuOpt progress score")`.

### CON-EXE-08 — Cooperative stop (cancel / finish-now)

The `should_stop: Callable[[], bool] | None` parameter is defined on `SolverInterface.solve` (`core/nurse_scheduling/solver_interface.py:222`) and threaded through `schedule()` (`core/nurse_scheduling/scheduler.py:62`, passed at `:312`).

- **OR-Tools supports it.** `solve()` guards the callback with a `threading.Lock`, starts a daemon `ortools-stop-watcher` thread polling `should_stop()` every `0.2s`, and calls `self.solver.StopSearch()` when it returns true; the solution callback also re-checks and calls `self.StopSearch()` (`core/nurse_scheduling/solver_ortools_cp_sat.py:120-153`, `:310-314`). This is what lets a frontend implement **cancel** / **finish-now** (stop early, keep current best incumbent) with the OR-Tools backend.
- **PuLP does NOT support it.** Both PuLP engines raise immediately in base `solve()`:
  ```
  if should_stop is not None:
      raise NotImplementedError("PuLP solvers do not support cooperative stop callbacks.")
  ```
  (`core/nurse_scheduling/solver_pulp.py:265-266`). Therefore a frontend using `pulp/cbc` or `pulp/cuopt` cannot request cooperative early stop; it can only rely on `--timeout`.
- The CLI never passes `should_stop` (it is a `schedule()`/programmatic-caller feature).

---

## Options & Determinism

### CON-EXE-09 — Timeout

`timeout: int | None` (seconds). Default `None` (no limit).

- **OR-Tools:** sets `self.solver.parameters.max_time_in_seconds = float(timeout)`; on `ValueError/TypeError/AttributeError` it logs a warning and proceeds without a limit (`core/nurse_scheduling/solver_ortools_cp_sat.py:110-118`).
- **PuLP:** passes `solver_kwargs["timeLimit"] = timeout` (`core/nurse_scheduling/solver_pulp.py:271-272`).
- CLI flag `--timeout` is `type=int, default=None`; help text: *"Maximum running time in seconds. If reached, the solver will stop and the current best result (if any) will be exported."* (`core/nurse_scheduling/cli.py:107-112`).

### CON-EXE-10 — Deterministic mode

`deterministic: bool` (default `False`). **Not exposed by the CLI**; `schedule()` default is `False` (`core/nurse_scheduling/scheduler.py:56`).

- **OR-Tools:** sets `random_seed = 0` and `num_workers = 1`, logging `"Configuring deterministic solver..."` (`core/nurse_scheduling/solver_ortools_cp_sat.py:101-107`).
- **PuLP/CBC:** appends CBC options `"randomS 0"` and `"threads 1"` (`core/nurse_scheduling/solver_pulp.py:295-297`).
- **PuLP/cuOpt:** ignored with a warning (see CON-EXE-07).
- **PuLP base:** logs `"Deterministic mode requested (support varies by solver)"` (`core/nurse_scheduling/solver_pulp.py:259-260`).

### CON-EXE-11 — Score integrality

Objective scores are integers. `assert_int_score(value, label, integer_tolerance=1e-6)` rounds and asserts integrality, raising `AssertionError(f"{label} should be an integer, but got {value}.")` otherwise (`core/nurse_scheduling/solver_interface.py:112-117`). PuLP's `get_objective_value` returns `0` when the objective value is `None`, and raises `ValueError(f"Objective value should be an integer, but got {val}.")` for a non-int value (`core/nurse_scheduling/solver_pulp.py:371-383`).

---

## Progress & Phases

### CON-EXE-12 — `SolverProgress` payload

Frozen dataclass (`core/nurse_scheduling/solver_interface.py:42-55`):

| field | type | notes |
| --- | --- | --- |
| `source` | `str` | e.g. `ortools/cp-sat:solution-callback`, `pulp/cbc:final-result`, `cli:final-result` |
| `currentBestScore` | `int` | best incumbent objective |
| `elapsedSeconds` | `float` | rounded to 3 decimals |
| `solutionIndex` | `int \| None` | OR-Tools incumbent index; `None` for PuLP |
| `df` | `Any \| None` | optional exported dataframe (in-memory only) |
| `cell_export_info` | `Any \| None` | optional export metadata (in-memory only) |

Wire serialization `serialize_solver_progress(payload, include_export_summary=False)` (`:85-99`) emits exactly:

```json
{"source": ..., "currentBestScore": ..., "elapsedSeconds": ..., "solutionIndex": ...}
```

When `include_export_summary=True`, it additionally adds `"commentCount"` = `count_export_comments(cell_export_info)` (`:97-98`). `count_export_comments` returns `None` unless `cell_export_info` is a dict with a `comments` dict, in which case it returns `sum(len(notes) for notes in comments.values())` (`:75-82`). Note that `df` and `cell_export_info` themselves are **never** put on the wire.

### CON-EXE-13 — `SchedulePhaseProgress` payload

Frozen dataclass (`core/nurse_scheduling/solver_interface.py:58-69`). Wire serialization `serialize_schedule_phase_progress` (`:102-109`) emits exactly:

```json
{"source": ..., "code": ..., "message": ..., "elapsedSeconds": ...}
```

`source` is always `"scheduler:phase"` (`core/nurse_scheduling/scheduler.py:46`). `ScheduleProgress = SolverProgress | SchedulePhaseProgress` (`core/nurse_scheduling/solver_interface.py:72`).

### CON-EXE-14 — Phase codes emitted by `schedule()`

`_emit_phase_progress` emits `SchedulePhaseProgress` events in this order (`core/nurse_scheduling/scheduler.py:36-51` and call sites). All `elapsedSeconds` are relative to the start of `schedule()`.

| # | `code` | `message` | file:line |
| --- | --- | --- | --- |
| 1 | `loading_scenario` | `Loading schedule configuration` | `:66-71` |
| 2 | `parsing_data` | `Parsing schedule data` | `:75` |
| 3 | `initializing_solver` | `Initializing solver model` | `:134` |
| 4 | `creating_shift_variables` | `Creating shift variables` | `:158` |
| 5 | `creating_off_variables` | `Creating off variables` | `:199` |
| 6 | `creating_lookup_maps` | `Creating lookup indexes` | `:223` |
| 7 | `adding_preferences` | `Adding preferences and constraints` | `:264-269` |
| 8 | `solving` | `Solving schedule` | `:306` |
| 9 | `exporting` | `Preparing schedule output` | `:358` (only when a solution was found) |

The `exporting` phase is emitted only on the found path (after the `if not found: return ...` early return at `:355-356`).

### CON-EXE-15 — Progress emission per solver

- **OR-Tools** emits a `SolverProgress` with `source="ortools/cp-sat:solution-callback"` on each improving incumbent, with `solutionIndex` set (`core/nurse_scheduling/solver_ortools_cp_sat.py:294-302`). Callback failures are caught and logged, not propagated (`:303-304`).
- **PuLP (both engines)** emit `SolverProgress` parsed from the solver log stream during solving (see CON-EXE-06/07) plus a final `source=f"pulp/{engine}:final-result"` event when status is `OPTIMAL` or `FEASIBLE` (`core/nurse_scheduling/solver_pulp.py:355-363`). `solutionIndex` is `None` for PuLP.
- **`prettify` interaction:** when `prettify=True` and a progress callback is present, `schedule()` wraps the callback so that each `SolverProgress` (not phase) event is enriched with a freshly exported `df` and `cell_export_info` via `exporter.get_people_versus_date_dataframe(ctx, prettify=True)` (`core/nurse_scheduling/scheduler.py:294-304`). This is what populates `commentCount` on the wire.
- **CLI `cli:final-result`:** after `schedule()` returns with a non-null `df` and `--progress-output` is set, the CLI emits one final `SolverProgress(source="cli:final-result", currentBestScore=score, ..., df=df, cell_export_info=cell_export_info)` (`core/nurse_scheduling/cli.py:198-207`).

---

## Status & Infeasibility Handling

### CON-EXE-16 — `SolverStatus` enum

`Enum` with string values (`core/nurse_scheduling/solver_interface.py:32-39`):

```
OPTIMAL = "OPTIMAL"
FEASIBLE = "FEASIBLE"
INFEASIBLE = "INFEASIBLE"
MODEL_INVALID = "MODEL_INVALID"
UNKNOWN = "UNKNOWN"
```

`get_status_name()` returns `self.solver_status.value` for both backends (`solver_ortools_cp_sat.py:238-240`; `solver_pulp.py:652-654`).

### CON-EXE-17 — OR-Tools status mapping

(`core/nurse_scheduling/solver_ortools_cp_sat.py:155-167`)

| CP-SAT status | `SolverStatus` |
| --- | --- |
| `cp_model.OPTIMAL` | `OPTIMAL` |
| `cp_model.FEASIBLE` | `FEASIBLE` |
| `cp_model.INFEASIBLE` | `INFEASIBLE` |
| `cp_model.MODEL_INVALID` | `MODEL_INVALID` |
| anything else | `UNKNOWN` |

### CON-EXE-18 — PuLP status mapping

(`core/nurse_scheduling/solver_pulp.py:332-353`)

| PuLP status | `SolverStatus` | notes |
| --- | --- | --- |
| `LpStatusOptimal` | `OPTIMAL` | |
| `LpStatusNotSolved` + feasible incumbent | `FEASIBLE` | logs *"Solver returned 'Not Solved' but produced a feasible incumbent; treating status as FEASIBLE."* |
| `LpStatusNotSolved` + no incumbent | `UNKNOWN` | |
| `LpStatusInfeasible` | `INFEASIBLE` | |
| `LpStatusUnbounded` | `UNKNOWN` | logs *"Model is unbounded"* |
| `LpStatusUndefined` | `UNKNOWN` | logs *"Solver returned undefined status"* |
| other | `UNKNOWN` | |

`_has_feasible_solution()` returns true when the objective value is non-`None` or any tracked variable has a value (`:61-66`). PuLP never returns `MODEL_INVALID`.

### CON-EXE-19 — `schedule()` outcome mapping

(`core/nurse_scheduling/scheduler.py:319-364`)

- `found = status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)`.
- `OPTIMAL` / `FEASIBLE` → returns a 5-tuple `(df, solution, objective_value, solver_status_name, cell_export_info)`.
- `INFEASIBLE` / `MODEL_INVALID` → `not found`, returns `(None, None, None, ctx.solver_status, None)` (`:355-356`). For `MODEL_INVALID`, `validate_model()` output is logged first (`:327-330`).
- **`UNKNOWN` (and any other non-found, non-infeasible/-invalid status)** → raises `ValueError(f"No solution found! Status: {ctx.solver_status}")` (`:331-333`). This is the important asymmetry: `UNKNOWN` is an exception, not a `None`-tuple.

`ctx.solver_status` in these messages is the string value from `get_status_name()` (e.g. `"UNKNOWN"`).

### CON-EXE-20 — Input preconditions enforced by `schedule()`

- `scenario.apiVersion` **must** equal `"alpha"`, else `NotImplementedError(f"Unsupported API version: {scenario.apiVersion}")` (`core/nurse_scheduling/scheduler.py:77-78`).
- `ctx.country` **must** be `None` or `"SG"`, else `ValueError(f"Country {ctx.country} is not supported yet")` (`:109-110`).

### CON-EXE-21 — Statistics per backend

`get_statistics()` returns a dict:

- **OR-Tools:** `{"conflicts", "branches", "wall_time"}` (`core/nurse_scheduling/solver_ortools_cp_sat.py:185-191`).
- **PuLP (both):** `{"status" (= pulp.LpStatus[self.status]), "wall_time" (= self.solve_time), "engine", "solver" (str or "None")}` (`core/nurse_scheduling/solver_pulp.py:385-392`).

These are logged in `schedule()` at INFO level (`core/nurse_scheduling/scheduler.py:335-338`) and are not part of the returned tuple or the progress wire payloads.

---

## CLI Reference

Entry point: `main()` in `core/nurse_scheduling/cli.py`. Program description: `"Nurse Scheduling Tool"` (`:95`).

### CON-EXE-22 — Arguments and flags

| arg / flag | kind | default | behavior |
| --- | --- | --- | --- |
| `input_file_path` | positional, `nargs="?"` | — | Path to input file. If `None` (and not `--version`), `parser.error("the following arguments are required: input_file_path")` (`:96`, `:133-134`) |
| `output_path` | positional, `nargs="?"` | `None` | Optional output file; format inferred from extension (`:97`, `:153-166`) |
| `--version` | `store_true` | — | Prints `f"nurse-scheduling {_get_app_version()}"` and returns (exit 0) (`:98`, `:130-132`) |
| `--prettify` | `store_true` | `False` | Enhanced output formatting; enables progress export enrichment (`:99`) |
| `-v` / `--verbose` | `count` | `0` | `>=2` → DEBUG, `==1` → INFO, else WARNING (`:100-106`, `:146-151`) |
| `--timeout` | `int` | `None` | Solver time limit, seconds (`:107-112`) |
| `--solver` | `str`, `choices=["ortools/cp-sat","pulp/cbc","pulp/cuopt"]` | `"ortools/cp-sat"` | Solver selector (`:113-119`) |
| `--show-model-build-stats` | `store_true` | `False` | Print model-build timing/deltas (`:120-124`) |
| `--progress-output` | `str` | `None` | Write progress events as JSON Lines; **requires `--prettify`** (`:125-128`) |

### CON-EXE-23 — CLI validation & error exits

- `--progress-output` without `--prettify`: prints `"Error: --progress-output requires --prettify"`, `sys.exit(1)` (`:141-143`).
- Output extension `.csv` with `--prettify`: prints `"Error: Prettify mode is not supported for CSV files"`, `sys.exit(1)` (`:159-163`).
- Output extension not `.csv`/`.xlsx` (and non-empty): prints `f"Error: Unsupported output file extension '{file_ext}'. Supported formats: .csv, .xlsx"`, `sys.exit(1)` (`:164-166`).
- Input file missing: prints `f"Error: File '{filepath}' not found"`, `sys.exit(1)` (`:169-171`).
- Output format inference: `.xlsx` → `"xlsx"`, `.csv` → `"csv"` (`:156-163`).

### CON-EXE-24 — CLI output / exit behavior

After reading the input, the CLI prints `f"nurse-scheduling {_get_app_version()}"` (`:176`), then calls `scheduler.schedule(...)` with `prettify`, `timeout`, `solver`, `progress_callback`, `model_build_stats_callback` (`:190-197`). Note the CLI does **not** pass `should_stop` or `deterministic`.

- If `df is None` (no solution): prints `"No solution found"` and `sys.exit(0)` (`:214-216`). (Note: `UNKNOWN` status raises inside `schedule()` before reaching here — see CON-EXE-19.)
- With `output_path`: exports via `exporter.export_to_excel` or `export_to_csv`, writes the file, then prints `f"Results saved to {output_path}"`, `f"Score: {score}"`, `f"Status: {status}"`, and (if `count_export_comments` is non-`None`) `f"Comments: {comment_count}"` (`:218-235`).
- Without `output_path`, with `--show-model-build-stats`: prints `Score`, `Status`, and optional `Comments` (`:236-241`).
- Without `output_path`, no stats flag: prints optional `Comments` then `print(df, solution, score, status)` (`:242-246`).

### CON-EXE-25 — CLI progress printer

`_create_cli_progress_callback(progress_output_file, print_to_stdout)` (`:65-91`):

- `SchedulePhaseProgress` payloads: serialized and written (one JSON object per line, `sort_keys=True`) to `progress_output_file` if set; **not** printed to stdout.
- `SolverProgress` payloads: serialized with `include_export_summary=True` (adds `commentCount`); written to the file if set; and, when `print_to_stdout` is true, printed as:
  ```
  [+] NURSE-SCHEDULING PROGRESS (score=<currentBestScore>, source=<source>, elapsed=<elapsedSeconds>s[, comments=<commentCount>])
  ```
  The `, comments=N` fragment is included only when `commentCount is not None` (`:80-89`).
- Wiring (`:184-189`): `progress_callback` is created when `not args.show_model_build_stats` **or** a progress-output file is open; `print_to_stdout = not args.show_model_build_stats`. So `--show-model-build-stats` suppresses stdout progress lines but still writes the JSONL file when `--progress-output` is given.

### CON-EXE-26 — App version

`_get_app_version()` runs `git describe --tags --always --dirty` against the repo root; on `OSError`/`CalledProcessError` returns `"v0.0.0-unknown"` (`:43-62`).

### CON-EXE-27 — Model-build-stats format

`ModelBuildStatsSummary.print_summary()` prints a header line then tab-separated rows (`core/nurse_scheduling/model_build_stats.py:89-107`):

```
MODEL_BUILD_STATS<TAB>step<TAB>count<TAB>elapsed_seconds<TAB>variables_added<TAB>constraints_added<TAB>total_variables<TAB>total_constraints
<step><TAB><count><TAB><elapsed_seconds:.6f><TAB><variables_added><TAB><constraints_added><TAB><total_variables><TAB><total_constraints>
```

- Rows are keyed by `step`; preference steps are re-keyed to `f"pref:{preferenceType}"` and aggregated (count summed, elapsed/vars/constraints accumulated, totals overwritten with latest) (`:77-87`).
- If no rows buffered, nothing is printed (`:91-92`).
- `ModelBuildStats` per-event dataclass fields: `step, elapsedSeconds, variablesAdded, constraintsAdded, totalVariables, totalConstraints, preferenceIndex, preferenceType` (`:32-56`).
- Entity counts come from `get_model_entity_counts`: OR-Tools uses `model.Proto()` var/constraint counts; PuLP uses `len(solver.variables)` and `len(model.constraints)`; fallback `(len(ctx.model_vars), 0)` (`:110-124`). This means `totalConstraints` reads `0` when only the fallback applies, and OR-Tools/PuLP counts are not directly comparable.
- Emission is best-effort: `emit_model_build_stats` swallows callback exceptions with `logging.exception("Model build stats callback failed")` (`:141-155`). Timing uses `time.perf_counter()` rounded to 6 decimals (`:145`).
- Build steps instrumented by `schedule()`: `create_shift_variables`, `avoid_solution` (only if `avoid_solution` given), `create_off_variables`, `create_lookup_maps`, and one `add_preference` per preference (`core/nurse_scheduling/scheduler.py:160-287`).

---

## Conformance Notes

This is a **conformance-only** contract. The rebuilt frontend MUST:

1. **Select** the solver by passing one of exactly `ortools/cp-sat` (default), `pulp/cbc`, `pulp/cuopt`. Do not invent other strings; unsupported values raise `ValueError` (CON-EXE-02).
2. Treat **cooperative stop / cancel / finish-now** as an **OR-Tools-only** capability. With either PuLP engine, `should_stop` raises `NotImplementedError`; the only early-termination lever there is `--timeout` (CON-EXE-08).
3. Consume progress payloads by their **exact serialized shape** (CON-EXE-12/13). `SolverProgress` wire fields: `source, currentBestScore, elapsedSeconds, solutionIndex` (+ optional `commentCount`). `SchedulePhaseProgress`: `source, code, message, elapsedSeconds`. Discriminate the two by presence of `code`/`message` vs `currentBestScore`.
4. Handle **phase codes** as the fixed set in CON-EXE-14 (nine codes, `exporting` conditional). `solutionIndex` is `None` for PuLP progress.
5. Interpret **status** via the five-value `SolverStatus` string set (CON-EXE-16). Expect `None`-tuple results for `INFEASIBLE`/`MODEL_INVALID`, but expect an **exception** (`"No solution found! Status: ..."`) for `UNKNOWN` (CON-EXE-19). PuLP never emits `MODEL_INVALID`.
6. Respect `apiVersion == "alpha"` and `country in {None, "SG"}` as hard preconditions (CON-EXE-20).
7. Honor CLI coupling rules: `--progress-output` requires `--prettify`; `--prettify` is incompatible with `.csv` output; exit codes `1` for the listed errors, `0` for the no-solution/`--version`/success paths (CON-EXE-23/24).
8. Not assume statistics are comparable across backends (different keys and counting semantics — CON-EXE-21, CON-EXE-27).

Callback failures (progress, solution, stop, model-build-stats) are all defensively caught and logged inside the core and never abort a solve; the frontend must not rely on a callback exception to signal anything.

---

## Cross-References

- **C1–C3 contracts** (input schema / preferences / export): `apiVersion`, `country`, preference types (`PREFERENCE_TYPES_TO_FUNC`), and the exporter (`get_people_versus_date_dataframe`, `export_to_excel`, `export_to_csv`, cell export/comments metadata) that feed `commentCount`.
- Source of truth files: `core/nurse_scheduling/solver_interface.py`, `solver_ortools_cp_sat.py`, `solver_pulp.py`, `solver_pulp_cbc.py`, `solver_pulp_cuopt.py`, `cli.py`, `scheduler.py`, `model_build_stats.py`, `report.py`.
- `Report` dataclass (`core/nurse_scheduling/report.py:24-28`): `{description, variable, skip_condition}` — used only for DEBUG-level diagnostic logging in `schedule()` (`scheduler.py:346-351`); not part of any wire payload or return tuple.
