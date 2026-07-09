---
title: "Contract C4 — Solvers, CLI & Execution"
kind: spec
---

# Contract C4 — Solvers, CLI & Execution

## Purpose & Scope

This contract fixes the observable behavior of the Python core's solving engine, its command-line interface, and the progress/status wire payloads that the (rebuilt) frontend must select against and consume. The Python core is **NOT being rebuilt; this document records its exact behavior for STRICT PARITY conformance.**

Scope covered:

- Solver: OR-Tools CP-SAT only. The core unconditionally instantiates `ORToolsSolver; there is no solver-string dispatch and no other solver backend is built or selectable in the current tree. The historical PuLP/CBC/cuOpt backends (previously solver_pulp.py, solver_pulp_cbc.py, solver_pulp_cuopt.py) have been `**removed from the source tree. Any prior contract text that mentioned them is superseded by this contract.**
- Cooperative stop (`should_stop) support — OR-Tools is the only implementation; there is no PuLP path that could raise NotImplementedError today (it would raise ModuleNotFoundError instead).`
- Solve options: `timeout, deterministic (seed/workers).`
- Progress payloads (`SolverProgress, SchedulePhaseProgress), their serialization, commentCount, and the phase codes emitted by schedule().`
- `SolverStatus enum, OR-Tools status mapping, infeasibility / no-solution handling.`
- Input preconditions enforced by `schedule() (apiVersion == "alpha", country in {None, "SG"}).`
- CLI surface: positional args, flags, choices, exit codes, error strings, model-build-stats format.

The frontend's role is **conformance-only: it selects timeout/prettify and consumes progress/score/status. It does not send a solver string, and it must not assume a solver field on the job response (see Contract C2 — there is none).**

<user_quoted_section>Boundary note: The schedule() function accepts additional parameters (deterministic, avoid_solution, should_stop) that the CLI does not expose. They are documented here because they are part of the fixed core contract that a future non-CLI frontend caller may invoke; the current CLI never sets them.</user_quoted_section>

## Solvers & Selection [CON-EXE-nn]

### CON-EXE-01 — Only one solver is selectable

`schedule() unconditionally instantiates ORToolsSolver`
(`core/nurse_scheduling/scheduler.py:136-139):`

```python
from .solver_ortools_cp_sat import ORToolsSolver
ctx.solver = ORToolsSolver()
```

There is **no ****`solver`**** parameter on **`schedule(); the function signature is`

```
schedule(file_content, deterministic=False, avoid_solution=None, prettify=False,
          timeout: int | None = None, progress_callback=..., should_stop=...,
          model_build_stats_callback=...)
```

(`core/nurse_scheduling/scheduler.py:54-62). Any prior solver=<string> argument is unsupported. A rebuilder must not pass a solver string.`

### CON-EXE-02 — OR-Tools native capabilities

The single backend is OR-Tools CP-SAT (`core/nurse_scheduling/solver_ortools_cp_sat.py). The SolverInterface contract still exists, but the only concrete implementation is OR-Tools. OR-Tools specifics:`

- Boolean/int vars are native CP-SAT vars (`model.NewBoolVar, model.NewIntVar) (solver_ortools_cp_sat.py:43-49).`
- `add_bool_or uses native model.AddBoolOr (:57).`
- `create_bool_and_var uses native AddBoolAnd(...).OnlyEnforceIf(var) plus a reverse AddBoolOr (:59-77).`
- `should_use_bool_and_var(n) returns `**`True unconditionally — native Boolean AND (`**`:79-81).`
- `create_bool_var_with_constraint uses reification via OnlyEnforceIf for each operator EQ/NE/GE/GT/LE/LT; unknown operator raises NotImplementedError(f"Operator {operator} not implemented for OR-Tools solver.") (:201-228).`
- `add_abs_equality uses native model.AddAbsEquality (:230-232).`
- `add_squared_equality uses native model.AddMultiplicationEquality(target, [x, x]) (:234-236).`
- `negate(var) returns var.Not() (:197-199).`

### CON-EXE-03 — Cooperative stop (cancel / finish-now) — OR-Tools only

The `should_stop: Callable[[], bool] | None parameter is defined on SolverInterface.solve (solver_interface.py:222) and threaded through schedule() (scheduler.py:62, passed at :312).`

OR-Tools is the **only current implementation. **`solve() guards the callback with a threading.Lock, starts a daemon ortools-stop-watcher thread polling should_stop() every 0.2s, and calls self.solver.StopSearch() when it returns true; the solution callback also re-checks and calls self.StopSearch() (solver_ortools_cp_sat.py:120-153, :310-314). This is what lets a frontend implement `**cancel / finish-now (stop early, keep current best incumbent).**

<user_quoted_section>Historical note: prior PuLP backends raised NotImplementedError("PuLP solvers do not support cooperative stop callbacks."); the corresponding PuLP source files are no longer in the tree. The HTTP API (C2) therefore does not need an "unsupported-solver" 409 branch — every request can be cooperatively stopped.</user_quoted_section>

## Options & Determinism

### CON-EXE-04 — Timeout

`timeout: int | None (seconds). Default None (no limit).`

- **OR-Tools: sets **`self.solver.parameters.max_time_in_seconds = float(timeout); on ValueError/TypeError/AttributeError it logs a warning and proceeds without a limit (solver_ortools_cp_sat.py:110-118).`
- CLI flag `--timeout is type=int, default=None; help text: `*"Maximum running time in seconds. If reached, the solver will stop and the current best result (if any) will be exported." (*`cli.py:107-112).`

### CON-EXE-05 — Deterministic mode

`deterministic: bool (default False). `**Not exposed by the CLI; **`schedule() default is False (scheduler.py:56).`

- **OR-Tools: sets **`random_seed = 0 and num_workers = 1, logging "Configuring deterministic solver..." (solver_ortools_cp_sat.py:101-107).`

### CON-EXE-06 — Score integrality

Objective scores are integers. `assert_int_score(value, label, integer_tolerance=1e-6) rounds and asserts integrality, raising AssertionError(f"{label} should be an integer, but got {value}.") otherwise (solver_interface.py:112-117). The OR-Tools backend returns the integer objective directly; the assertion guards against any future regression.`

## Progress & Phases

### CON-EXE-07 — `SolverProgress payload`

Frozen dataclass (`solver_interface.py:42-55):`

| field | type | notes |
| --- | --- | --- |
| `source` | `str` | e.g. `ortools/cp-sat:solution-callback, cli:final-result` |
| `currentBestScore` | `int` | best incumbent objective |
| `elapsedSeconds` | `float` | rounded to 3 decimals |
| `solutionIndex` | `int \| None` | OR-Tools incumbent index (always non-null in current path) |
| `df` | `Any \| None` | optional exported dataframe (in-memory only) |
| `cell_export_info` | `Any \| None` | optional export metadata (in-memory only) |

Wire serialization `serialize_solver_progress(payload, include_export_summary=False) (solver_interface.py:85-99) emits exactly:`

```json
{"source": ..., "currentBestScore": ..., "elapsedSeconds": ..., "solutionIndex": ...}
```

When `include_export_summary=True, it additionally adds "commentCount" = count_export_comments(cell_export_info) (:97-98). count_export_comments returns None unless cell_export_info is a dict with a comments dict, in which case it returns sum(len(notes) for notes in comments.values()) (:75-82). df and cell_export_info themselves are `**never put on the wire.**

### CON-EXE-08 — `SchedulePhaseProgress payload`

Frozen dataclass (`solver_interface.py:58-69). Wire serialization serialize_schedule_phase_progress (:102-109) emits exactly:`

```json
{"source": ..., "code": ..., "message": ..., "elapsedSeconds": ...}
```

`source is always "scheduler:phase" (scheduler.py:46). ScheduleProgress = SolverProgress | SchedulePhaseProgress (solver_interface.py:72).`

### CON-EXE-09 — Phase codes emitted by `schedule()`

`_emit_phase_progress emits SchedulePhaseProgress events in this order (scheduler.py:36-51 and call sites). All elapsedSeconds are relative to the start of schedule().`

| # | `code` | `message` | @line |
| --- | --- | --- | --- |
| 1 | `loading_scenario` | `Loading schedule configuration` | `scheduler.py:66-71` |
| 2 | `parsing_data` | `Parsing schedule data` | `:75` |
| 3 | `initializing_solver` | `Initializing solver model` | `:134` |
| 4 | `creating_shift_variables` | `Creating shift variables` | `:158` |
| 5 | `creating_off_variables` | `Creating off variables` | `:199` |
| 6 | `creating_lookup_maps` | `Creating lookup indexes` | `:223` |
| 7 | `adding_preferences` | `Adding preferences and constraints` | `:264-269` |
| 8 | `solving` | `Solving schedule` | `:306` |
| 9 | `exporting` | `Preparing schedule output` | `:358 (only when a solution was found)` |

The `exporting phase is emitted only on the found path (after the if not found: return ... early return at :355-356).`

### CON-EXE-10 — Progress emission per solver

- **OR-Tools emits a **`SolverProgress with source="ortools/cp-sat:solution-callback" on each improving incumbent, with solutionIndex set (solver_ortools_cp_sat.py:294-302). Callback failures are caught and logged, not propagated (:303-304).`
- **`prettify`**** interaction: when **`prettify=True and a progress callback is present, schedule() wraps the callback so that each SolverProgress (not phase) event is enriched with a freshly exported df and cell_export_info via exporter.get_people_versus_date_dataframe(ctx, prettify=True) (scheduler.py:294-304). This is what populates commentCount on the wire.`
- **CLI ****`cli:final-result`****: after **`schedule() returns with a non-null df and --progress-output is set, the CLI emits one final SolverProgress(source="cli:final-result", currentBestScore=score, ..., df=df, cell_export_info=cell_export_info) (cli.py:198-207).`

## Status & Infeasibility Handling

### CON-EXE-11 — `SolverStatus enum`

`Enum with string values (solver_interface.py:32-39):`

```
OPTIMAL = "OPTIMAL"
FEASIBLE = "FEASIBLE"
INFEASIBLE = "INFEASIBLE"
MODEL_INVALID = "MODEL_INVALID"
UNKNOWN = "UNKNOWN"
```

`get_status_name() returns self.solver_status.value (solver_ortools_cp_sat.py:238-240).`

### CON-EXE-12 — OR-Tools status mapping

(`solver_ortools_cp_sat.py:155-167)`

| CP-SAT status | `SolverStatus` |
| --- | --- |
| `cp_model.OPTIMAL` | `OPTIMAL` |
| `cp_model.FEASIBLE` | `FEASIBLE` |
| `cp_model.INFEASIBLE` | `INFEASIBLE` |
| `cp_model.MODEL_INVALID` | `MODEL_INVALID` |
| anything else | `UNKNOWN` |

### CON-EXE-13 — `schedule() outcome mapping`

(`scheduler.py:319-364)`

- `found = status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE).`
- `OPTIMAL / FEASIBLE → returns a 5-tuple (df, solution, objective_value, solver_status_name, cell_export_info).`
- `INFEASIBLE / MODEL_INVALID → not found, returns (None, None, None, ctx.solver_status, None) (:355-356). For MODEL_INVALID, validate_model() output is logged first (:327-330).`
- **`UNKNOWN`**** (and any other non-found, non-infeasible/-invalid status) → raises **`ValueError(f"No solution found! Status: {ctx.solver_status}") (:331-333). This is the important asymmetry: UNKNOWN is an exception, not a None-tuple.`

`ctx.solver_status in these messages is the string value from get_status_name() (e.g. "UNKNOWN").`

### CON-EXE-14 — Input preconditions enforced by `schedule()`

- `scenario.apiVersion `**must equal **`"alpha", else NotImplementedError(f"Unsupported API version: {scenario.apiVersion}") (scheduler.py:77-78).`
- `ctx.country `**must be **`None or "SG", else ValueError(f"Country {ctx.country} is not supported yet") (:108-110).`

### CON-EXE-15 — Statistics

`get_statistics() returns a dict: {"conflicts", "branches", "wall_time"} (solver_ortools_cp_sat.py:185-191).`

These are logged in `schedule() at INFO level (scheduler.py:335-338) and are not part of the returned tuple or the progress wire payloads.`

## CLI Reference

Entry point: `main() in cli.py. Program description: "Nurse Scheduling Tool" (:95).`

### CON-EXE-16 — Arguments and flags

| arg / flag | kind | default | behavior |
| --- | --- | --- | --- |
| `input_file_path` | positional, `nargs="?"` | — | Path to input file. If `None (and not --version), parser.error("the following arguments are required: input_file_path") (:96, :133-134)` |
| `output_path` | positional, `nargs="?"` | `None` | Optional output file; format inferred from extension (`:97, :153-166)` |
| `--version` | `store_true` | — | Prints `f"nurse-scheduling {_get_app_version()}" and returns (exit 0) (:98, :130-132)` |
| `--prettify` | `store_true` | `False` | Enhanced output formatting; enables progress export enrichment (`:99)` |
| `-v / --verbose` | `count` | `0` | `>=2 → DEBUG, ==1 → INFO, else WARNING (:100-106, :146-151)` |
| `--timeout` | `int` | `None` | Solver time limit, seconds (`:107-112)` |
| `--show-model-build-stats` | `store_true` | `False` | Print model-build timing/deltas (`:113-117)` |
| `--progress-output` | `str` | `None` | Write progress events as JSON Lines; **requires ****`--prettify (`**`:118-122)` |

<user_quoted_section>Removed flags: there is no --solver flag. (A prior --solver argument was removed when the PuLP backends were deleted; the schedule() function never accepted a solver string in the current tree.)</user_quoted_section>

### CON-EXE-17 — CLI validation & error exits

- `--progress-output without --prettify: prints "Error: --progress-output requires --prettify", sys.exit(1) (:135-137).`
- Output extension `.csv with --prettify: prints "Error: Prettify mode is not supported for CSV files", sys.exit(1) (:153-157).`
- Output extension not `.csv/.xlsx (and non-empty): prints f"Error: Unsupported output file extension '{file_ext}'. Supported formats: .csv, .xlsx", sys.exit(1) (:158-160).`
- Input file missing: prints `f"Error: File '{filepath}' not found", sys.exit(1) (:163-165).`
- Output format inference: `.xlsx → "xlsx", .csv → "csv" (:150-157).`

### CON-EXE-18 — CLI output / exit behavior

After reading the input, the CLI prints `f"nurse-scheduling {_get_app_version()}" (:170), then calls scheduler.schedule(...) with prettify, timeout, progress_callback, model_build_stats_callback (:184-191). Note the CLI does `**not pass **`should_stop or deterministic.`

- If `df is None (no solution): prints "No solution found" and sys.exit(0) (:208-210). (Note: UNKNOWN status raises inside schedule() before reaching here — see CON-EXE-13.)`
- With `output_path: exports via exporter.export_to_excel or export_to_csv, writes the file, then prints f"Results saved to {output_path}", f"Score: {score}", f"Status: {status}", and (if count_export_comments is not None) f"Comments: {comment_count}" (:212-229).`
- Without `output_path, with --show-model-build-stats: prints Score, Status, and optional Comments (:230-235).`
- Without `output_path, no stats flag: prints optional Comments then print(df, solution, score, status) (:236-240).`

### CON-EXE-19 — CLI progress printer

`_create_cli_progress_callback(progress_output_file, print_to_stdout) (:65-91):`

- `SchedulePhaseProgress payloads: serialized and written (one JSON object per line, sort_keys=True) to progress_output_file if set; `**not printed to stdout.**
- Wiring (`:178-183): progress_callback is created when not args.show_model_build_stats `**or a progress-output file is open; **`print_to_stdout = not args.show_model_build_stats. So --show-model-build-stats suppresses stdout progress lines but still writes the JSONL file when --progress-output is given.`

### CON-EXE-20 — App version

`_get_app_version() runs git describe --tags --always --dirty against the repo root; on OSError/CalledProcessError returns "v0.0.0-unknown" (:43-62).`

### CON-EXE-21 — Model-build-stats format

`ModelBuildStatsSummary.print_summary() prints a header line then tab-separated rows (model_build_stats.py:89-107):`

```
MODEL_BUILD_STATS<TAB>step<TAB>count<TAB>elapsed_seconds<TAB>variables_added<TAB>constraints_added<TAB>total_variables<TAB>total_constraints
<step><TAB><count><TAB><elapsed_seconds:.6f><TAB><variables_added><TAB><constraints_added><TAB><total_variables><TAB><total_constraints
```

- Rows are keyed by `step; preference steps are re-keyed to f"pref:{preferenceType}" and aggregated (count summed, elapsed/vars/constraints accumulated, totals overwritten with latest) (:77-87).`
- If no rows buffered, nothing is printed (`:91-92).`
- `ModelBuildStats per-event dataclass fields: step, elapsedSeconds, variablesAdded, constraintsAdded, totalVariables, totalConstraints, preferenceIndex, preferenceType (:32-56).`
- Entity counts come from `get_model_entity_counts: OR-Tools uses model.Proto() var/constraint counts; fallback (len(ctx.model_vars), 0) (:110-124). totalConstraints reads 0 when only the fallback applies.`
- Emission is best-effort: `emit_model_build_stats swallows callback exceptions with logging.exception("Model build stats callback failed") (:141-155). Timing uses time.perf_counter() rounded to 6 decimals (:145).`
- Build steps instrumented by `schedule(): create_shift_variables, avoid_solution (only if avoid_solution given), create_off_variables, create_lookup_maps, and one add_preference per preference (scheduler.py:160-287).`

## Conformance Notes

This is a **conformance-only contract. The rebuilt frontend MUST:**

1. **Not send a solver string. There is no solver selection parameter on **`schedule(), no solver field on the HTTP /optimize request, and no solver field on the job response. The backend always uses OR-Tools CP-SAT (CON-EXE-01, see also Contract C2).`
2. **Cancel / finish-now is implemented unconditionally for the current single backend: **`should_stop is threaded into schedule() (CON-EXE-03). The HTTP API (C2) does not need an "unsupported solver" 409 branch.`
3. Consume progress payloads by their **exact serialized shape (CON-EXE-07/08). **`SolverProgress wire fields: source, currentBestScore, elapsedSeconds, solutionIndex (+ optional commentCount). SchedulePhaseProgress: source, code, message, elapsedSeconds. Discriminate the two by presence of code/message vs currentBestScore.`
4. Handle **phase codes as the fixed set in CON-EXE-09 (nine codes, **`exporting conditional).`
5. Interpret **status via the five-value **`SolverStatus string set (CON-EXE-11). Expect None-tuple results for INFEASIBLE/MODEL_INVALID, but expect an `**exception (**`"No solution found! Status: ...") for UNKNOWN (CON-EXE-13).`
6. Respect `apiVersion == "alpha" and country in {None, "SG"} as hard preconditions (CON-EXE-14).`
7. Honor CLI coupling rules: `--progress-output requires --prettify; --prettify is incompatible with .csv output; exit codes 1 for the listed errors, 0 for the no-solution/--version/success paths (CON-EXE-17/18).`

Callback failures (progress, solution, stop, model-build-stats) are all defensively caught and logged inside the core and never abort a solve; the frontend must not rely on a callback exception to signal anything.

## Cross-References

- **C1–C3 contracts (input schema / preferences / export): **`apiVersion, country, preference types (PREFERENCE_TYPES_TO_FUNC), and the exporter (get_people_versus_date_dataframe, export_to_excel, export_to_csv, cell export/comments metadata) that feed commentCount.`
- Source of truth files: `core/nurse_scheduling/solver_interface.py, solver_ortools_cp_sat.py, cli.py, scheduler.py, model_build_stats.py, report.py.`
- `Report dataclass (core/nurse_scheduling/report.py:24-28): {description, variable, skip_condition} — used only for DEBUG-level diagnostic logging in schedule() (scheduler.py:346-351); not part of any wire payload or return tuple.`
