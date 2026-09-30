# Scope D: cpsat-autotune and CP-SAT parameter tuning on a 2-core budget

Date: 2026-09-30. Solver: `ortools==9.15.6755`. Tool: `cpsat-autotune` 0.6.0 (PyPI, uploaded 2025-09-23) with `optuna` 5.0.0.
This report builds on the worker benchmark in `/tmp/wave/bench/RESULTS.md` (bead 3c91). That benchmark shipped `extra_subsolvers=["max_lp_sym"]` (patch `core/upstream-patches/3c91-solver-max-lp-sym.patch`). This report calls that configuration "shipped".

## Answer

1. cpsat-autotune is an Optuna wrapper that tunes CP-SAT parameters for one model. The author calls it "highly experimental". Version 0.6.0 does not run on OR-Tools 9.15 without patches, and part of its search space is stale.
2. With a 2-worker patch, it found strong sets for each model. Each set is overfitted: a set that wins on one ward loses on another. No single set beat "shipped" on all three models.
3. The measured trade-off follows ward size. Small wards need an LP worker to prove optimality. The 87-person ward needs a fast search without LP or presolve. A size-gated "large ward" preset is a plausible next step, but one large model is not enough evidence to ship it.
4. Keep "shipped" as the one global parameter set. Do not let the AI assistant set raw CP-SAT parameters. It can offer a longer timeout from a fixed menu and explain the result status and gap.

## 1. What the tool does

Sources: README and source at https://github.com/d-krupke/cpsat-autotune (HEAD c02589f). The installed 0.6.0 wheel has the same source.

- Purpose: "a Python library designed to optimize the hyperparameters of Google's OR-Tools CP-SAT solver for specific problem instances" (README.md L3-5).
- Status: "This project is highly experimental and is developed on low priority." (README.md L20).
- Target use: "specifically designed to enhance solver efficiency in targeted scenarios, particularly within the context of Adaptive Large Neighborhood Search (ALNS)" (README.md L24-27). In ALNS, CP-SAT solves many similar sub-problems, so one tuned set pays off many times.
- Method: "uses the `optuna` library to perform hyperparameter tuning on a preselected set of parameters" and assumes "that the default parameters are already well-tuned" (README.md L323-328). The sampler is Optuna TPE (`tune.py`, `_tune`). The default configuration runs as trial 0.
- Three metrics (`metrics.py`): time to optimal (a run that does not prove optimality scores 10 x the time limit), objective in a time limit, and relative gap `|obj - bound| / max(1, |obj|)` in a time limit.
- Noise: each solve gets `random_seed = random.randint(0, 2**31 - 1)` (`metrics.py` L123). A trial stops early after one sample that is worse than the baseline. A promising trial gets more samples. At the end, it drops each parameter in turn and keeps only the parameters that matter (`parameter_evaluator.py`).
- Placement: global parameters go on `solver.parameters`. Parameters marked as subsolver-level go into a new subsolver `tuned_solver` that is added through `extra_subsolvers` (`caching_solver.py` L108-135). All 11 default parameters are global.
- Default search space (11): `optimize_with_core`, `search_branching`, `boolean_encoding_level`, `linearization_level`, `core_minimization_level`, `cp_model_probing_level`, `cp_model_presolve`, `clause_cleanup_ordering`, `binary_minimization_algorithm`, `minimization_algorithm`, `use_phase_saving`. The list comes from CPMPy and is "Maybe outdated" (`cpsat_parameters.py` L20-22).
- CLI: `cpsat-autotune time|quality|gap MODEL --max-time F --n-trials 100 --n-samples-trial 10 --n-samples-verification 30`. The CLI has no flag for `num_workers` or for a fixed seed. It tunes one model per run.

The author's own warnings:

- "it also increases the risk of overfitting ... could result in excessive solve times or failure on problems that deviate from the training set" (README.md L314-319).
- "CP-SAT can have a very high variance (when using random seeds)" (README.md L344).
- "If consistent performance across a variety of instances is crucial, stick with the default CP-SAT parameters." (README.md L334-335).

The CP-SAT primer does not mention autotuning. It says: "fine-tuning such a solver is not a simple task, and often you do more harm than good by tinkering around" (https://github.com/d-krupke/cpsat-primer/blob/main/chapters/parameters.md L401-402). On extra subsolvers it warns that they "might push some predefined subsolvers out of the portfolio if there are not enough workers available" (same file, L930-933).

OR-Tools facts that matter at 2 workers (https://github.com/google/or-tools, `ortools/sat/cp_model_search.cc` L1009-1010 in the 9.15 copy at `/tmp/wave/bench/`): `if (num_workers == 1) return 1; if (num_workers <= 4) return num_workers - 1;`. So 2 workers keep one full subsolver. `extra_subsolvers` are "added at the beginning of the list" (`sat_parameters.proto`). A global parameter therefore changes that one full worker, and an extra subsolver replaces `default_lp` in that slot.

## 2. Version drift found in the tool

cpsat-autotune 0.6.0 pins no versions. On OR-Tools 9.15 I found four faults:

1. `import_model` fails. It calls `text_format.Parse` on `CpModel.Proto()`, which is a pybind object in 9.15 (`AttributeError: ... has no attribute 'DESCRIPTOR'`). It also reads text format only. Our dumps are binary.
2. Enum parameters fail. 9.15 `SatParameters` rejects plain ints for enum fields (`TypeError: incompatible function arguments`).
3. `binary_minimization_algorithm` samples 0 to 4 with default 1. In 9.15, values 2 to 4 are `reserved` and the default is 5 (`sat_parameters.proto` L127-134).
4. `clause_cleanup_protection` no longer exists. The tool thinks `use_lb_relax_lns` defaults to false, but 9.15 defaults it to true.

The driver `/tmp/wave/timefold/autotune/drive.py` works around faults 1 and 2 (a protobuf `SatParameters`, copied as text at solve time). It drops the two stale parameters and `num_workers`, and it fixes `num_workers=2`.

## 3. Local results

Setup: `python3.14 -m venv venv && venv/bin/pip install ortools==9.15.6755 cpsat-autotune` in `/tmp/wave/timefold/autotune/`. The machine is an AMD Ryzen 9 9950X3D. Every run is pinned with `taskset` to 2 physical cores and sets `num_workers=2`. The three tuning runs ran at the same time on separate core pairs. Background load was about 9. Models are the production dumps from bead 3c91: `october` (1,756 vars), `genmed` (2,138 vars), `large87` (48,589 vars, weights about 1e12). Logs: `october.log`, `genmed.log`, `large87.log`. Raw results: `v_*.jsonl`.

### 3.1 Tuning runs (total 17 min wall, 08:10 to 08:27)

| model | metric | budget | result |
|---|---|---|---|
| october | time to optimal, 10 s cap | 40 trials x 3 samples, 5 to verify | default never proves (score 100). Tuned: mean 0.21 s. `search_branching: 1` gives 99.85% of the gain. |
| genmed | time to optimal, 10 s cap | 40 trials x 3 samples | no trial proved optimality. The tool discarded the result. |
| large87 | gap, 15 s cap | 30 trials x 2 samples, 3 to verify | default gap mean 1.22 (122%). Tuned gap 0.0 in the tool's table (0.13% measured). All 7 parameters "essential". |

Tuned sets:

- `oct_tuned`: `minimization_algorithm 1, clause_cleanup_ordering 1, cp_model_probing_level 3, search_branching 1, core_minimization_level 0`.
- `large_tuned`: `use_phase_saving false, minimization_algorithm 1, clause_cleanup_ordering 1, cp_model_presolve false, search_branching 3, linearization_level 0, boolean_encoding_level 0`.

### 3.2 Verification at production settings (2 workers, 15 s, seeds 1, 2, 3)

Script: `verify.py`. "first" is the wall time to the first solution. The objective is maximized. The best known large87 bound is about 4.4785e12.

| model | config | status | objective | bound | gap % | wall s (mean) | first s (mean) |
|---|---|---|---|---|---|---|---|
| october | default | FEA/FEA/FEA | 810, 810, 810 | 2950, 2930, 2960 | 263 | 15.00 | 0.05 |
| october | shipped | OPT/OPT/OPT | 810 x3 | 810 x3 | 0 | 0.48 | 0.05 |
| october | oct_tuned | OPT/OPT/OPT | 810 x3 | 810 x3 | 0 | 0.20 | 0.05 |
| october | sb1 only | OPT/OPT/OPT | 810 x3 | 810 x3 | 0 | 0.27 | 0.05 |
| october | shipped + oct_tuned | OPT/OPT/OPT | 810 x3 | 810 x3 | 0 | 0.24 | 0.06 |
| october | large_tuned | FEA/FEA/FEA | 810 x3 | 3760, 3770, 3770 | 365 | 15.00 | 0.01 |
| october | shipped + large_tuned | OPT/OPT/OPT | 810 x3 | 810 x3 | 0 | 0.07 | 0.01 |
| genmed | default | FEA/FEA/FEA | 449 x3 | 1947 x3 | 334 | 15.00 | 0.07 |
| genmed | shipped | OPT/OPT/OPT | 449 x3 | 449 x3 | 0 | 1.20 | 0.07 |
| genmed | oct_tuned | FEA/FEA/FEA | 449 x3 | 452, 452, 501 | 0.7 to 11.6 | 15.00 | 0.08 |
| genmed | shipped + sb1 | FEA/FEA/FEA | 449 x3 | 606, 561, 556 | 25 to 35 | 15.00 | 0.06 |
| genmed | shipped + oct_tuned | FEA/FEA/FEA | 449 x3 | 452, 452, 501 | 0.7 to 11.6 | 15.00 | 0.07 |
| genmed | large_tuned | FEA/FEA/FEA | 449 x3 | 1952 x3 | 335 | 15.00 | 0.01 |
| genmed | shipped + large_tuned | OPT/OPT/OPT | 449 x3 | 449 x3 | 0 | 0.37 | 0.01 |
| large87 | default | FEA/FEA/FEA | -3.6e13, -9.0e12, -5.0e12 | 4.4798e12, 4.4785e12, 4.4785e12 | 112 to 189 | 15.03 | 2.89 |
| large87 | shipped | FEA/FEA/FEA | -2.8e13, -7.9e12, -9.0e12 | 4.4798e12, 4.4784e12, 4.4787e12 | 116 to 156 | 15.03 | 2.88 |
| large87 | large_tuned | FEA/FEA/FEA | 4.4725e12, 4.4715e12, 4.4721e12 | 4.4785e12 x3 | 0.13 to 0.16 | 15.03 | 0.81 |
| large87 | shipped + large_tuned | FEA/FEA/FEA | -3.5e12, -1.6e12, -9.8e12 | 4.4798e12 x3 | 146 to 389 | 15.04 | 0.99 |
| large87 | presolve off only | FEA/FEA/FEA | -1.2e13, -9.8e12, -5.0e12 | 4.4785e12 x3 | 137 to 189 | 15.04 | 3.26 |
| large87 | sb3 only | FEA/FEA/FEA | -2.5e13, -1.9e13, -7.2e12 | 4.4785e12 x3 | 118 to 162 | 15.03 | 3.43 |

What the table shows:

- Overfitting is real on our models. `oct_tuned` is 2.4 x faster than "shipped" on October, but it stops genmed from proving optimality, even with `max_lp_sym` on. The global `search_branching: 1` changes the one full worker.
- `large_tuned` at 2 workers and 15 s gets a large87 gap of 0.13 to 0.16%. The 3c91 benchmark needed 8 workers and 60 s for 0.2%. The same set loses the proof on both small wards.
- "shipped + large_tuned" is the fastest set on the small wards (0.07 s and 0.37 s) but fails on large87. With `max_lp_sym` in the only full slot, the LP work is too slow on 48,589 vars.
- No single parameter explains the large87 gain. Presolve off alone or `search_branching: 3` alone did not help. The tool marked all 7 parameters as essential.
- The chosen roster was the same on the small wards in every run (810 and 449). Only the proof time changed. On large87 the tuned set also changes the roster quality.

Limits: three models, three seeds, one fast desktop CPU with background load. The production server (2 cores, 3.6 GB) is slower. I did not run anything on it.

## 4. Answers to the four questions

1. Offline tuning. It works as an idea generator, not as a source of production settings. It found the large87 set, which no hand-picked variant in 3c91 found. Each result needs a cross-check on other wards before use.
2. Per-ward or per-shape tuning. Per-ward tuning is not worth it. Wards change every month, and each tuned set broke another ward. A per-shape preset has support in the data because the winner splits by size: LP proof for small wards, a fast no-LP search for very large wards. One large model cannot set a safe size threshold. Collect more large models first.
3. The AI assistant. It must not choose raw parameters. Wrong parameters are silent: the run still returns a roster, but slower or worse, and the manager cannot see why. Safe knobs:
   - a timeout from a fixed server-clamped menu (15, 30, 60, 120 s)
   - later, a named preset from a vetted list ("standard", "large ward"), picked by the server from model size, not by the model
   - an explanation of the result: "best roster found, not proven best" when the status is FEASIBLE, with the gap.
   With "shipped", small wards prove optimality in about 1 s. If a small ward uses the full timeout, the cause is the model (for example a very large objective range), not the timeout. The assistant must say that and not suggest more time. For large wards, 60 s at 2 workers improved the gap from 168% to 81% in 3c91, so a longer timeout is a fair suggestion there.
4. Risks:
   - Overfitting: measured above. Three models are too few for a global change.
   - Nondeterminism: the tool uses random seeds and wall-clock time. Parallel CP-SAT is not deterministic. Our deterministic mode sets `num_workers=1`, which ignores `extra_subsolvers`, and large87 finds no solution at 1 worker (3c91 result 7).
   - Version drift: the tool is already stale for 9.15 (section 2). The CP-SAT portfolio also changes by release (the primer's worker table is for 9.9). Re-run the benchmark on each OR-Tools upgrade.
   - Scale: large87 uses weights near 1e12. Parameter tuning hides that problem but does not fix it. The priority ladder work is the real fix.

## 5. Recommendation

Keep "shipped" (`extra_subsolvers=["max_lp_sym"]`) as the global default. Do not add cpsat-autotune as a dependency, to CI, or to the runtime. Use it offline with `drive.py` to find candidates, then check every candidate across a model corpus with `verify.py`. The only candidate worth work now is a size-gated "large ward" preset, after a corpus check.

## Implement

Core changes need user approval. Each core change needs an upstream-patch record: a new file in `core/upstream-patches/`, the patch name on the `solver_ortools_cp_sat.py` row of `core/upstream-patches/manifest.toml`, and a refresh with `python -m scripts.sync_upstream --repo <v1 clone> --refresh-patches` (`core/AGENTS.md` L274-279).

1. Build a solver benchmark corpus (M, P1). Dump 10 or more real models, with at least 4 wards of 80 or more people. Keep `bench.py`, `verify.py` and `drive.py` with it. Put the scripts in a `v2-only` location.
2. Record the solve outcome per run in the server log (S, P1): status, objective, bound, gap, wall time, first-solution time, variable count. Telemetry stays off (X6), so keep this local. It gives the data for items 3 and 4.
3. Size-gated "large ward" preset in `solver_ortools_cp_sat.py` (M, P2). Ship only if item 1 shows a gain on every large model and no loss on the small ones. The threshold is unknown. It lies between 2,138 and 48,589 variables. Sketch, not tested:

   ```python
   # v2: bench 2026-09-30. Large wards at 2 workers do better without an LP full worker or presolve.
   if len(self.model.proto.variables) >= LARGE_WARD_VARS:
       p = self.solver.parameters
       p.extra_subsolvers.clear()  # checked on 9.15 pybind SatParameters
       p.cp_model_presolve = False
       p.linearization_level = 0
       # plus the other 5 large_tuned values, after the corpus check
   ```

   Record it as a new patch, for example `<bead>-solver-large-ward-preset.patch`.
4. Assistant knobs (S, P2). Add a timeout choice from a fixed menu, clamped by the server. Add a result explanation that uses status and gap. Do not add a parameters field to any assistant operation.
5. Upgrade guard (S, P3). On each OR-Tools version bump, re-run `verify.py` on the corpus and compare with the last table.
6. Deterministic mode (M, P3). It runs at 1 worker and loses `max_lp_sym`. Measure `interleave_search: true` at 2 workers as the deterministic mode. It proved October and genmed in 3c91 but delayed the first large87 solution to 9.6 s.

## Unconfirmed

- I did not measure the size threshold for item 3, and I did not measure the presets on the production server.
- I read the primer quotes from the GitHub chapter files, not from the rendered site.
- I did not check the tool's other opt-in parameters (for example `use_objective_shaving_search`). The runs used the default 11, minus the 2 stale ones.
