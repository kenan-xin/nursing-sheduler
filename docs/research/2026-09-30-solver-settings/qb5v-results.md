# CP-SAT settings at 2 workers: replace or gate `max_lp_sym` (bead qb5v)

Date 2026-09-30. Local desktop only (AMD Ryzen 9 9950X3D). OR-Tools **9.15.6755**, `/usr/bin/python3` (3.14). No traffic went to tc1, dev or prod.

## Answer

**Keep `extra_subsolvers=["max_lp_sym"]`, and on hosts with 2 or fewer CPUs also set `num_workers=3`** (variant `sym_w3` below). With 3 workers CP-SAT keeps 2 full subsolvers, `max_lp_sym` and `default_lp`, plus one thread for LNS and local search. The 3 threads share the 2 cores.

- `default_lp` proves the counting-type infeasibilities: 58p and 70p go from 0/3 proved at 15 s to 3/3 (mean 7.3 s and 9.0 s). 116p goes from 1/3 to 2/3 at 15 s, and from UNKNOWN at 60 s (2/2 runs) to INFEASIBLE in 3.6 s and 14.6 s.
- `max_lp_sym` still proves October and genmed at 15 s (3/3, about 1.2 s instead of 0.5-0.9 s). ward-8 is proved at 60 s (9.4 s and 25 s) but only 1 time in 3 at 15 s.
- large87's first solution is not hurt (2.9 s against 3.0 s at 15 s). Its 60 s objective stays near current: 4.46e12 and 4.34e12, against 4.47e12 and 4.48e12. Plain `base` reaches only 2.1e12 to 2.5e12.
- The cost: the LNS thread gets about a third of the CPU instead of half. On some big synthetic wards the first solution comes later (120p: about 16 s instead of 8-12 s; one of 3 runs found no solution in 15 s), and some 60 s objectives are 5-20 % lower (76p, 80p, 96p). The other medium synthetic wards are level.

No 2-worker setting solves both problems. Each of these fails on at least one of the three goals:

| setting | October/genmed proof | synthetic infeasible proof | large87 quality |
|---|---|---|---|
| current (`max_lp_sym`) | yes | **no** (58p, 70p 0/3; 116p UNKNOWN at 60 s) | good |
| base (default portfolio) | **no** | yes (about 2-7 s) | **poor at 60 s** (2.1-2.5e12) |
| `linearization_level=2` | **no** (same as base, see section 1) | yes | not tested at 60 s (same full worker as base) |
| `extra_subsolvers=["max_lp"]` | yes, faster (0.1 s) | **no** (same as current) | good |
| `num_full_subsolvers=2` (keeps both LP flavours) | yes | yes | **no solution at all** on every medium or large feasible ward |
| `interleave_search=true` | yes | mostly | **no solution** on 20 of 21 large runs |
| `extra_subsolvers=["core"]` or `["no_lp"]` | **no** (genmed, ward-8) | **no** | worse |
| **`max_lp_sym` + `num_workers=3`** | yes (1.2 s) | **yes** | near current at 60 s |

A size gate does not work either. The real large87 (59k variables) needs `max_lp_sym` to reach a good objective, while the synthetic 116p (41k variables) needs `default_lp` to prove infeasibility. Both are large, so no variable-count threshold separates them. A narrower gate is possible: keep plain `max_lp_sym` below about 18k variables and use 3 workers above it. That would keep ward-8's fast proof (16.3k variables) and October's 0.5 s. But the threshold rests on a single ward on each side (ward-8 at 16.3k, 58p at 20.6k), so I do not recommend it without more mid-size wards.

## Proposed code change (not applied; core is unchanged)

`core/nurse_scheduling/solver_ortools_cp_sat.py`, `ORToolsSolver.__init__` (needs `import os`):

```python
        # 2-core servers otherwise run only default_lp and never prove optimality (benchmark: bead 3c91); ignored at num_workers=1.
        self.solver.parameters.extra_subsolvers.append("max_lp_sym")
        # At 2 workers CP-SAT keeps only one full subsolver; a 3rd worker adds default_lp, which proves
        # counting-type infeasibility that max_lp_sym alone times out on (bead qb5v). Deterministic mode still forces 1.
        if (os.cpu_count() or 1) <= 2:
            self.solver.parameters.num_workers = 3
```

Update the unit test next to `test_solver_adds_max_lp_sym_subsolver` to assert `num_workers == 3` when `os.cpu_count` is patched to 2, and `0` (auto) when it is patched to 8. On machines with 3 or more CPUs nothing changes: the auto portfolio already runs `default_lp` next to `max_lp_sym` there. Before shipping, re-check on tc1: October/genmed proof time, a synthetic infeasible ward (58p), and large87 at the production timeout.

## 1. What the settings do (OR-Tools v9.15 source)

I fetched `ortools/sat/cp_model_search.cc`, `sat_parameters.proto` and `cp_model_solver.cc` at tag `v9.15` from GitHub. They are byte-identical to the copies in `/tmp/wave/bench/`.

**Named subsolvers** (`GetNamedParameters`, cp_model_search.cc:505-528). Each one starts from the user's base parameters and then *overwrites* `linearization_level`:

```cpp
new_params.set_linearization_level(0);  strategies["no_lp"] = new_params;
new_params.set_linearization_level(1);  strategies["default_lp"] = new_params;
new_params.set_linearization_level(2);
new_params.set_add_lp_constraints_lazily(false);  strategies["max_lp"] = new_params;
new_params.set_use_symmetry_in_lp(true);          strategies["max_lp_sym"] = new_params;
```

So `max_lp` = LP level 2 (all Boolean constraints go into the LP), with every LP constraint added up front. `max_lp_sym` = `max_lp` plus the symmetry-folded LP. `default_lp` = level 1 (only linear constraints and full encodings).

**Which subsolvers run** (`GetFullWorkerParameters`, cp_model_search.cc:844-1030). `extra_subsolvers` are put *in front of* the default list `default_lp, fixed, core, no_lp, max_lp_sym|max_lp, quick_restart, ...`. The list is then cut to `num_full_subsolvers`. When that is 0, the formula is `num_workers - 1` for 2 to 4 workers. So at 2 workers exactly **one** full subsolver runs: `default_lp` by default, or the first `extra_subsolvers` entry. The search logs confirm this (`1 full problem subsolver: [max_lp_sym]` against `[default_lp]`). The second thread runs the first-solution `fj` worker, then the LNS and local-search workers. With `num_workers=3` the logs show `2 full problem subsolvers: [default_lp, max_lp_sym]`, 1 first-solution subsolver `[fj]`, and the same 9 interleaved subsolvers.

**Where a base `linearization_level` still counts.** The LNS workers (`lns_base` copies the base parameters) and the random first-solution workers (`fs_random`, `fs_random_quick_restart`, cp_model_search.cc:1040-1100) keep it. But at 2 workers only one first-solution thread is left, and `RepeatParameters(..., 1)` gives it `fj`, which uses `feasibility_jump_linearization_level` instead.

**The contradiction, resolved.** Both earlier claims are true, and they do not conflict:

- RESULTS.md was right: `linearization_level=2` alone does not change the full worker. It is still `default_lp` at level 1. On 116p, the base and lin2 search logs show the same bound steps (`-7297227`, `-21097244`, `-21997298`) and `#Done` at 7.9 s and 7.6 s. Over the corpus, lin2 matches base: 60/60 infeasible proofs each, 81 and 82 OPTIMAL, and no October or genmed proof.
- The synthetic run was also right that lin2 "proves them in about 5 s". It does so because lin2 **does not add `max_lp_sym`**, so `default_lp` keeps the only full-worker slot. The fast proofs come from `default_lp`, not from level 2. `max_lp` (level 2 without symmetry) is as slow as `max_lp_sym` on these wards (0/3 on 58p and 70p). So the level-2 LP full worker is what slows the proofs: each LP solve over 20k-40k variables with all Boolean rows is slow, and far fewer conflicts get searched.

## 2. Method

- Models: the 63 kept wards from `/tmp/wave/corpus/index.json` (41 small, 11 medium, 11 large; 19 infeasible), plus the 8 synthetic `*.repair.pb` counterparts (feasible). Total 71 protos, the same CP-SAT protos the corpus baseline used, loaded the same way as `bench.py` and `baseline.py`.
- One solve per run: `num_workers=2` (except the `*_w3` variants), 15 s, `random_seed` 1, 2 and 3, pinned with `taskset` to 2 distinct physical cores. Three lanes ran in parallel on cpu 6-7, 8-9 and 10-11 (one lane per variant of the same ward at about the same time).
- Script: `/tmp/wave/qb5v/qb.py` (one solve, one JSON line). Metrics: status, wall time (= time to proof when OPTIMAL or INFEASIBLE), first-solution time (first callback), objective (maximised), bound, gap.
- "Shortfall" = (best objective any run found on that ward - this objective) / max(1, |best|). 0 is best. Objectives on the synthetic wards and large87 carry weights up to 1e5 and 1e12, so shortfall values above 1 are common and noisy. Read them as ranks, not as percentages.
- Runs: main matrix, 8 variants x 71 models x 3 seeds = 1,704 solves. Then `core` and `no_lp` on 12 key wards (72). Then a **quiet re-run** of the 12 key wards for current, base, max_lp, sym_w3 and maxlp_w3 (180). Then **60 s runs** on the big and deciding wards (58 solves).

### Caveat: machine load (confirmed)

During the main matrix and the first 60 s pass, another session's unpinned CP-SAT runs (`exp-timefold-on-cpsat` `oracle.py`, 5-8 threads each) pushed the 5-minute load average to about 50 on 32 threads. I did not record load per run in the main matrix, so I cannot say which runs were affected. Variants of the same ward ran side by side, so the comparisons between variants are fairer than the absolute times. I threw away the contended 60 s pass (kept as `results60_contended.jsonl`), waited for load under 2, and re-ran every deciding measurement. Those runs record `load1`, and it stayed at 2.5-11, which is our own 6-9 solver threads. **The recommendation rests on the quiet runs** (tables B and C). The main matrix (table A) is for breadth.

Other caveats:
- **The infeasible wards that separate the variants are all SYNTHETIC** (`syn-inf-*`, generated by `synthetic/gen.py`). Every real infeasible ward in the corpus is small and is proved by presolve in 0.00 s under every variant. So no real ward shows the infeasibility problem. That is unconfirmed on real data, not disproved.
- A 9950X3D core is faster than a VPS vCPU. On tc1 every time will be longer, and 3 threads on 2 slow vCPUs may behave differently. **Not measured on tc1** (not allowed in this task).
- The rule `os.cpu_count() <= 2` assumes it counts the same CPUs as CP-SAT's own default. With `num_workers=0`, CP-SAT uses `std::thread::hardware_concurrency()` (cp_model_solver.cc:2194-2204). I did not check how either behaves under a container CPU quota on tc1. **Unconfirmed.**
- The production timeout is what users choose (the server default is 300 s; the web diagnostic candidates use 90 s). That is why the 60 s evidence carries more weight than the 15 s evidence.

## 3. Results

Variants: `current` = `extra_subsolvers=["max_lp_sym"]` (shipped in 3c91). `base` = nothing set. `lin2` = `linearization_level=2`. `max_lp` = `extra_subsolvers=["max_lp"]`. `sym_lin2` = current + `linearization_level=2`. `sym_full2` = current + `num_full_subsolvers=2`. `sym_w3` = current + `num_workers=3`. `maxlp_w3` = `max_lp` + `num_workers=3`. `interleave` = `interleave_search=true`. `core` and `no_lp` = that name as the only extra subsolver.

### B. Key wards, quiet machine, 15 s, 3 seeds (deciding table)

Cell: proved/runs and mean time to proof; for unproved: mean first-solution s (fs) and median shortfall vs best in this table (sf). max load1 shown last.

| ward | current | base | max_lp | sym_w3 | maxlp_w3 |
|---|---|---|---|---|---|
| october | 3/3, 0.46 s | 0/3; fs 0.0; sf 0.000 | 3/3, 0.09 s | 3/3, 1.17 s | 3/3, 0.11 s |
| flow-a-general-medicine | 3/3, 0.92 s | 0/3; fs 0.1; sf 0.000 | 3/3, 0.13 s | 3/3, 1.28 s | 3/3, 0.15 s |
| ward-8-shift-patterns-senior-on-every-shift | 3/3, 9.44 s | 1/3, 11.91 s; fs 0.7; sf 0.033 | 3/3, 8.71 s | 1/3, 14.04 s; fs 1.2; sf 0.075 | 3/3, 14.49 s |
| sg-28day-160h-compliance-14-nurses | 3/3, 5.33 s | 3/3, 5.45 s | 3/3, 4.48 s | 3/3, 3.51 s | 1/3, 1.94 s; fs 1.9; sf 0.000; 2 no sol |
| syn-inf-contract-hours-vs-rest-58p-s3003 | 0/3 | 3/3, 3.43 s | 0/3 | 3/3, 7.28 s | 3/3, 6.29 s |
| syn-inf-headcount-ceiling-vs-contract-70p-s3006 | 0/3 | 3/3, 5.47 s | 0/3 | 3/3, 9.03 s | 3/3, 9.34 s |
| syn-inf-max-nights-cap-116p-s3005 | 1/3, 5.85 s | 3/3, 6.71 s | 1/3, 6.52 s | 2/3, 7.00 s | 2/3, 5.74 s |
| large-ward-with-87-people-2025-11 | 0/3; fs 3.0; sf 14.111 | 0/3; fs 3.0; sf 12.140 | 0/3; fs 3.1; sf 9.195 | 0/3; fs 2.9; sf 19.259 | 0/3; fs 3.3; sf 30.915 |
| syn-lar-120p-s2006 | 0/3; fs 9.5; sf 0.112 | 0/3; fs 12.0; sf 1.665 | 0/3; fs 10.1; sf 0.333 | 0/3; fs 12.1; sf 1.545; 1 no sol | 0/3; fs 9.8; sf 0.880; 2 no sol |
| syn-lar-96p-s2003 | 0/3; fs 6.9; sf 1.512 | 0/3; fs 6.7; sf 1.007 | 0/3; fs 6.9; sf 1.724 | 0/3; fs 7.5; sf 4.995 | 0/3; fs 6.9; sf 3.438 |
| syn-med-76p-s1006 | 0/3; fs 1.1; sf 3.539 | 0/3; fs 2.3; sf 2.268 | 0/3; fs 1.2; sf 4.633 | 0/3; fs 3.3; sf 12.346 | 0/3; fs 1.8; sf 11.512 |
| syn-lar-80p-s2001 | 0/3; fs 7.8; sf 8.947 | 0/3; fs 6.3; sf 1.270 | 0/3; fs 5.8; sf 4.186 | 0/3; fs 8.0; sf 0.729 | 0/3; fs 8.0; sf 8.469 |

max load1 during runs: 10.5

### C. Deciding wards, quiet machine, 60 s, 2 seeds

Cell per seed: objective (fs = first-solution s), or OPT/INF with time to proof, or UNK (no solution).

| ward | current | base | max_lp | sym_w3 | maxlp_w3 |
|---|---|---|---|---|---|
| large-ward-with-87-people-2025-11 | 4.47e+12 (fs 2s); 4.48e+12 (fs 3s) | 2.11e+12 (fs 3s); 2.51e+12 (fs 3s) | 4.46e+12 (fs 3s); 4.48e+12 (fs 3s) | 4.46e+12 (fs 3s); 4.34e+12 (fs 4s) | 4.46e+12 (fs 3s); 4.38e+12 (fs 3s) |
| syn-inf-max-nights-cap-116p-s3005 | UNK (no sol); UNK (no sol) | INF 5.6s; INF 4.5s | - | INF 14.6s; INF 3.6s | INF 27.2s; INF 6.3s |
| syn-lar-120p-s2006 | -2.81e+04 (fs 12s); -2.77e+04 (fs 8s) | -2.69e+04 (fs 10s); -2.76e+04 (fs 16s) | - | -3.31e+04 (fs 16s); -2.77e+04 (fs 17s) | -5.9e+05 (fs 37s); -4.88e+04 (fs 25s) |
| syn-lar-80p-s2001 | -1.43e+04 (fs 8s); -1.32e+04 (fs 5s) | -1.43e+04 (fs 6s); -1.33e+04 (fs 6s) | - | -1.62e+04 (fs 8s); -1.55e+04 (fs 11s) | - |
| syn-lar-96p-s2003 | -3.73e+04 (fs 6s); -3.94e+04 (fs 5s) | -3.94e+04 (fs 10s); -3.93e+04 (fs 6s) | - | -4.27e+04 (fs 8s); -3.85e+04 (fs 10s) | - |
| syn-med-32p-s1001 | 278 (fs 0s); 278 (fs 0s) | - | - | 276 (fs 0s); 262 (fs 0s) | - |
| syn-med-40p-s1002 | -1.06e+07 (fs 0s); -1.05e+07 (fs 0s) | - | - | -1.08e+07 (fs 0s); -1.09e+07 (fs 0s) | - |
| syn-med-48p-s1003 | 237 (fs 1s); 255 (fs 1s) | - | - | 260 (fs 1s); 259 (fs 1s) | - |
| syn-med-56p-s1004 | 630 (fs 1s); 646 (fs 1s) | - | - | 625 (fs 1s); 620 (fs 1s) | - |
| syn-med-64p-s1005 | -1.71e+07 (fs 1s); -1.66e+07 (fs 1s) | - | - | -1.67e+07 (fs 1s); -1.72e+07 (fs 1s) | - |
| syn-med-76p-s1006 | 706 (fs 1s); 717 (fs 1s) | 735 (fs 1s); 741 (fs 1s) | - | 609 (fs 1s); 563 (fs 1s) | - |
| ward-8-shift-patterns-senior-on-every-shift | OPT 8.5s; OPT 8.3s | - | - | OPT 9.4s; OPT 25.1s | OPT 11.6s; OPT 7.0s |

### A. Main matrix, 15 s, 3 seeds, all 71 models (load not controlled, see caveat)

#### Per band

Time to proof counts an unproved run as 15 s. Shortfall = (best known objective - objective) / max(1, |best|), median over runs that found a solution.

| band | kind | wards | variant | proved runs | mean time to proof s | median first sol s | max first sol s | no-solution runs | median shortfall |
|---|---|---|---|---|---|---|---|---|---|
| small | feasible | 29 | current | 87/87 | 0.36 | 0.01 | 9.60 | 0 | 0.000 |
| small | feasible | 29 | base | 81/87 | 1.26 | 0.01 | 9.55 | 0 | 0.000 |
| small | feasible | 29 | lin2 | 81/87 | 1.26 | 0.01 | 9.62 | 0 | 0.000 |
| small | feasible | 29 | max_lp | 86/87 | 0.21 | 0.00 | 0.54 | 1 | 0.000 |
| small | feasible | 29 | sym_lin2 | 87/87 | 0.35 | 0.01 | 9.90 | 0 | 0.000 |
| small | feasible | 29 | sym_full2 | 84/87 | 0.64 | 0.01 | 0.26 | 3 | 0.000 |
| small | feasible | 29 | sym_w3 | 87/87 | 0.32 | 0.01 | 11.44 | 0 | 0.000 |
| small | feasible | 29 | interleave | 87/87 | 0.62 | 0.01 | 9.77 | 0 | 0.000 |
| small | infeasible | 12 | current | 36/36 | 0.00 | - | - | - | - |
| small | infeasible | 12 | base | 36/36 | 0.00 | - | - | - | - |
| small | infeasible | 12 | lin2 | 36/36 | 0.00 | - | - | - | - |
| small | infeasible | 12 | max_lp | 36/36 | 0.00 | - | - | - | - |
| small | infeasible | 12 | sym_lin2 | 36/36 | 0.00 | - | - | - | - |
| small | infeasible | 12 | sym_full2 | 36/36 | 0.00 | - | - | - | - |
| small | infeasible | 12 | sym_w3 | 36/36 | 0.00 | - | - | - | - |
| small | infeasible | 12 | interleave | 36/36 | 0.00 | - | - | - | - |
| medium | feasible | 7 | current | 3/21 | 14.08 | 0.81 | 1.88 | 0 | 0.054 |
| medium | feasible | 7 | base | 0/21 | 15.00 | 0.70 | 4.62 | 0 | 0.041 |
| medium | feasible | 7 | lin2 | 1/21 | 14.98 | 0.98 | 2.41 | 0 | 0.109 |
| medium | feasible | 7 | max_lp | 3/21 | 14.39 | 0.80 | 1.89 | 0 | 0.050 |
| medium | feasible | 7 | sym_lin2 | 3/21 | 14.16 | 0.70 | 2.64 | 0 | 0.145 |
| medium | feasible | 7 | sym_full2 | 0/21 | 15.00 | - | - | 21 | - |
| medium | feasible | 7 | sym_w3 | 2/21 | 14.42 | 0.86 | 4.51 | 0 | 0.442 |
| medium | feasible | 7 | interleave | 0/21 | 15.00 | - | - | 21 | - |
| medium | infeasible | 4 | current | 6/12 | 7.52 | - | - | - | - |
| medium | infeasible | 4 | base | 12/12 | 2.45 | - | - | - | - |
| medium | infeasible | 4 | lin2 | 12/12 | 2.66 | - | - | - | - |
| medium | infeasible | 4 | max_lp | 6/12 | 7.52 | - | - | - | - |
| medium | infeasible | 4 | sym_lin2 | 6/12 | 7.51 | - | - | - | - |
| medium | infeasible | 4 | sym_full2 | 12/12 | 2.69 | - | - | - | - |
| medium | infeasible | 4 | sym_w3 | 12/12 | 3.49 | - | - | - | - |
| medium | infeasible | 4 | interleave | 9/12 | 6.30 | - | - | - | - |
| large | feasible | 7 | current | 0/21 | 15.00 | 3.19 | 12.57 | 1 | 0.097 |
| large | feasible | 7 | base | 0/21 | 15.00 | 3.59 | 14.85 | 1 | 0.320 |
| large | feasible | 7 | lin2 | 0/21 | 15.00 | 2.97 | 12.27 | 2 | 2.560 |
| large | feasible | 7 | max_lp | 0/21 | 15.00 | 4.05 | 13.20 | 0 | 0.595 |
| large | feasible | 7 | sym_lin2 | 0/21 | 15.00 | 3.03 | 14.91 | 3 | 0.232 |
| large | feasible | 7 | sym_full2 | 0/21 | 15.00 | - | - | 21 | - |
| large | feasible | 7 | sym_w3 | 0/21 | 15.00 | 3.62 | 10.19 | 3 | 2.208 |
| large | feasible | 7 | interleave | 0/21 | 15.00 | 9.68 | 9.68 | 20 | 5.754 |
| large | infeasible | 4 | current | 10/12 | 3.07 | - | - | - | - |
| large | infeasible | 4 | base | 12/12 | 1.96 | - | - | - | - |
| large | infeasible | 4 | lin2 | 12/12 | 2.16 | - | - | - | - |
| large | infeasible | 4 | max_lp | 10/12 | 3.13 | - | - | - | - |
| large | infeasible | 4 | sym_lin2 | 10/12 | 3.14 | - | - | - | - |
| large | infeasible | 4 | sym_full2 | 12/12 | 1.92 | - | - | - | - |
| large | infeasible | 4 | sym_w3 | 12/12 | 2.28 | - | - | - | - |
| large | infeasible | 4 | interleave | 12/12 | 3.00 | - | - | - | - |
| repair | feasible | 8 | current | 0/24 | 15.00 | 1.04 | 11.74 | 1 | 0.040 |
| repair | feasible | 8 | base | 0/24 | 15.00 | 1.51 | 8.08 | 3 | 0.068 |
| repair | feasible | 8 | lin2 | 0/24 | 15.00 | 1.36 | 14.10 | 4 | 0.064 |
| repair | feasible | 8 | max_lp | 0/24 | 15.00 | 2.07 | 10.14 | 1 | 0.053 |
| repair | feasible | 8 | sym_lin2 | 0/24 | 15.00 | 1.73 | 8.99 | 3 | 0.081 |
| repair | feasible | 8 | sym_full2 | 0/24 | 15.00 | - | - | 24 | - |
| repair | feasible | 8 | sym_w3 | 0/24 | 15.00 | 1.70 | 8.49 | 5 | 0.127 |
| repair | feasible | 8 | interleave | 0/24 | 15.00 | - | - | 24 | - |

#### Per ward (wards where any variant needs > 0.5 s or fails to prove)

Cell: proved/seeds, mean time to proof (s, proved runs only) ; mean first-solution s ; median shortfall (runs with a solution).

| ward | band | vars | kind | current | base | lin2 | max_lp | sym_lin2 | sym_full2 | sym_w3 | interleave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| large-ward-with-87-people-2025-11 | large | 59363 | feas | 0/3 ; 4.60 ; 15.163 | 0/3 ; 5.23 ; 26.820 | 0/3 ; 4.28 ; 16.593 | 0/3 ; 5.75 ; 26.280 | 0/3 ; 4.21 ; 9.387 | 0/3 ; - ; - | 0/3 ; 3.33 ; 21.616 | 0/3 ; 9.68 ; 5.754 |
| syn-lar-120p-s2006 | large | 42091 | feas | 0/3 ; 11.60 ; 0.290 | 0/3 ; 12.96 ; 2.123 | 0/3 ; 12.27 ; 2.560 | 0/3 ; 10.94 ; 1.019 | 0/3 ; 13.06 ; 0.948 | 0/3 ; - ; - | 0/3 ; - ; - | 0/3 ; - ; - |
| syn-inf-max-nights-cap-116p-s3005 | large | 40894 | INF | 1/3, 5.85 | 3/3, 7.48 | 3/3, 8.28 | 1/3, 6.55 | 1/3, 6.58 | 3/3, 7.30 | 3/3, 8.75 | 3/3, 11.67 |
| syn-lar-112p-s2005 | large | 39453 | feas | 0/3 ; 1.83 ; 0.047 | 0/3 ; 1.62 ; 0.024 | 0/3 ; 1.74 ; 0.041 | 0/3 ; 1.64 ; 0.033 | 0/3 ; 1.74 ; 0.002 | 0/3 ; - ; - | 0/3 ; 1.81 ; 0.110 | 0/3 ; - ; - |
| syn-lar-104p-s2004 | large | 36563 | feas | 0/3 ; 2.16 ; 0.025 | 0/3 ; 2.31 ; 0.025 | 0/3 ; 2.06 ; 0.029 | 0/3 ; 2.33 ; 0.036 | 0/3 ; 2.23 ; 0.007 | 0/3 ; - ; - | 0/3 ; 2.54 ; 0.098 | 0/3 ; - ; - |
| syn-lar-96p-s2003 | large | 33937 | feas | 0/3 ; 6.74 ; 2.848 | 0/3 ; 7.11 ; 5.851 | 0/3 ; 8.05 ; 5.704 | 0/3 ; 6.94 ; 4.478 | 0/3 ; 6.46 ; 8.095 | 0/3 ; - ; - | 0/3 ; 6.77 ; 4.313 | 0/3 ; - ; - |
| syn-lar-88p-s2002 | large | 31067 | feas | 0/3 ; 1.58 ; 0.026 | 0/3 ; 2.07 ; 0.021 | 0/3 ; 1.81 ; 0.026 | 0/3 ; 1.36 ; 0.013 | 0/3 ; 1.78 ; 0.026 | 0/3 ; - ; - | 0/3 ; 2.16 ; 0.069 | 0/3 ; - ; - |
| syn-lar-80p-s2001 | large | 28394 | feas | 0/3 ; 6.54 ; 1.008 | 0/3 ; 4.93 ; 0.598 | 0/3 ; 7.99 ; 12.450 | 0/3 ; 6.21 ; 2.931 | 0/3 ; 4.90 ; 1.201 | 0/3 ; - ; - | 0/3 ; 8.50 ; 23.093 | 0/3 ; - ; - |
| syn-med-76p-s1006 | medium | 26847 | feas | 0/3 ; 1.22 ; 14.862 | 0/3 ; 2.15 ; 19.190 | 0/3 ; 1.46 ; 18.517 | 0/3 ; 1.41 ; 42.241 | 0/3 ; 1.51 ; 26.741 | 0/3 ; - ; - | 0/3 ; 2.16 ; 27.466 | 0/3 ; - ; - |
| syn-inf-headcount-ceiling-vs-contract-70p-s3006 | medium | 24862 | INF | 0/3 | 3/3, 5.32 | 3/3, 5.58 | 0/3 | 0/3 | 3/3, 5.70 | 3/3, 7.46 | 0/3 |
| syn-med-64p-s1005 | medium | 22640 | feas | 0/3 ; 1.26 ; 0.020 | 0/3 ; 1.11 ; 0.036 | 0/3 ; 1.66 ; 0.021 | 0/3 ; 1.12 ; 0.046 | 0/3 ; 1.65 ; 0.036 | 0/3 ; - ; - | 0/3 ; 1.22 ; 0.097 | 0/3 ; - ; - |
| syn-inf-contract-hours-vs-rest-58p-s3003 | medium | 20645 | INF | 0/3 | 3/3, 4.42 | 3/3, 4.99 | 0/3 | 0/3 | 3/3, 4.98 | 3/3, 6.45 | 3/3, 10.14 |
| syn-med-56p-s1004 | medium | 19992 | feas | 0/3 ; 0.92 ; 0.597 | 0/3 ; 0.81 ; 0.335 | 0/3 ; 1.14 ; 0.447 | 0/3 ; 0.96 ; 0.914 | 0/3 ; 1.05 ; 0.833 | 0/3 ; - ; - | 0/3 ; 1.22 ; 4.427 | 0/3 ; - ; - |
| syn-med-48p-s1003 | medium | 17113 | feas | 0/3 ; 0.84 ; 0.662 | 0/3 ; 0.77 ; 0.609 | 0/3 ; 1.11 ; 2.358 | 0/3 ; 0.79 ; 0.046 | 0/3 ; 0.98 ; 1.881 | 0/3 ; - ; - | 0/3 ; 1.03 ; 5.033 | 0/3 ; - ; - |
| ward-8-shift-patterns-senior-on-every-shift | medium | 16304 | feas | 3/3, 8.57 ; 0.71 ; 0.000 | 0/3 ; 0.73 ; 0.033 | 1/3, 14.65 ; 0.90 ; 0.022 | 3/3, 10.72 ; 0.75 ; 0.000 | 3/3, 9.15 ; 0.72 ; 0.000 | 0/3 ; - ; - | 2/3, 8.93 ; 1.24 ; 0.000 | 0/3 ; - ; - |
| syn-med-40p-s1002 | medium | 14466 | feas | 0/3 ; 0.65 ; 0.007 | 0/3 ; 0.76 ; 0.026 | 0/3 ; 1.07 ; 0.028 | 0/3 ; 0.86 ; 0.027 | 0/3 ; 1.20 ; 0.038 | 0/3 ; - ; - | 0/3 ; 0.88 ; 0.081 | 0/3 ; - ; - |
| syn-med-32p-s1001 | medium | 11585 | feas | 0/3 ; 0.52 ; 0.054 | 0/3 ; 0.53 ; 0.066 | 0/3 ; 0.65 ; 0.095 | 0/3 ; 0.51 ; 0.050 | 0/3 ; 0.52 ; 0.145 | 0/3 ; - ; - | 0/3 ; 0.57 ; 0.442 | 0/3 ; - ; - |
| flow-a-general-medicine | small | 3423 | feas | 3/3, 0.96 ; 0.06 ; 0.000 | 0/3 ; 0.06 ; 0.000 | 0/3 ; 0.06 ; 0.000 | 3/3, 0.16 ; 0.08 ; 0.000 | 3/3, 1.24 ; 0.07 ; 0.000 | 3/3, 1.20 ; 0.14 ; 0.000 | 3/3, 1.61 ; 0.08 ; 0.000 | 3/3, 4.67 ; 0.17 ; 0.000 |
| october | small | 3059 | feas | 3/3, 1.22 ; 0.06 ; 0.000 | 0/3 ; 0.08 ; 0.000 | 0/3 ; 0.07 ; 0.000 | 3/3, 0.18 ; 0.09 ; 0.000 | 3/3, 1.09 ; 0.08 ; 0.000 | 3/3, 1.97 ; 0.13 ; 0.000 | 3/3, 1.65 ; 0.10 ; 0.000 | 3/3, 1.73 ; 0.15 ; 0.000 |
| sg-28day-160h-compliance-14-nurses | small | 1988 | feas | 3/3, 7.67 ; 7.66 ; 0.000 | 3/3, 6.07 ; 6.07 ; 0.000 | 3/3, 5.93 ; 5.93 ; 0.000 | 2/3, 0.54 ; 0.54 ; 0.000 | 3/3, 7.36 ; 7.36 ; 0.000 | 0/3 ; - ; - | 3/3, 5.34 ; 5.33 ; 0.000 | 3/3, 8.87 ; 7.08 ; 0.000 |
| hours_via_coefficients | small | 1429 | feas | 3/3, 0.17 ; 0.17 ; 0.000 | 3/3, 0.13 ; 0.13 ; 0.000 | 3/3, 0.13 ; 0.13 ; 0.000 | 3/3, 0.10 ; 0.10 ; 0.000 | 3/3, 0.16 ; 0.16 ; 0.000 | 3/3, 0.16 ; 0.16 ; 0.000 | 3/3, 0.20 ; 0.20 ; 0.000 | 3/3, 1.25 ; 0.17 ; 0.000 |
| leave_daystate_160h | small | 1285 | feas | 3/3, 0.15 ; 0.15 ; 0.000 | 3/3, 0.24 ; 0.24 ; 0.000 | 3/3, 0.24 ; 0.24 ; 0.000 | 3/3, 0.10 ; 0.09 ; 0.000 | 3/3, 0.15 ; 0.15 ; 0.000 | 3/3, 0.15 ; 0.15 ; 0.000 | 3/3, 0.17 ; 0.17 ; 0.000 | 3/3, 1.15 ; 0.11 ; 0.000 |
| syn-inf-leave-cluster-night-nic-44p-s3001.repair | repair | - | feas | 0/3 ; 0.55 ; 0.007 | 0/3 ; 0.55 ; 0.019 | 0/3 ; 0.56 ; 0.013 | 0/3 ; 0.61 ; 0.013 | 0/3 ; 0.54 ; 0.000 | 0/3 ; - ; - | 0/3 ; 0.64 ; 0.033 | 0/3 ; - ; - |
| syn-inf-preceptor-unavailable-100p-s3004.repair | repair | - | feas | 0/3 ; 7.29 ; 4.929 | 0/3 ; 8.08 ; 12.747 | 0/3 ; 13.52 ; 7.445 | 0/3 ; 7.83 ; 4.741 | 0/3 ; 7.63 ; 5.807 | 0/3 ; - ; - | 0/3 ; - ; - | 0/3 ; - ; - |
| syn-inf-contract-hours-vs-rest-58p-s3003.repair | repair | - | feas | 0/3 ; 0.81 ; 24.300 | 0/3 ; 1.04 ; 42.600 | 0/3 ; 1.25 ; 74.850 | 0/3 ; 0.78 ; 31.450 | 0/3 ; 1.44 ; 54.250 | 0/3 ; - ; - | 0/3 ; 1.32 ; 210.650 | 0/3 ; - ; - |
| syn-inf-leave-vs-hard-pin-36p-s3008.repair | repair | - | feas | 0/3 ; 0.59 ; 0.034 | 0/3 ; 0.68 ; 0.034 | 0/3 ; 0.78 ; 0.045 | 0/3 ; 0.74 ; 0.011 | 0/3 ; 0.87 ; 0.045 | 0/3 ; - ; - | 0/3 ; 1.15 ; 0.090 | 0/3 ; - ; - |
| syn-inf-headcount-ceiling-vs-contract-70p-s3006.repair | repair | - | feas | 0/3 ; 8.32 ; 0.827 | 0/3 ; 5.99 ; 0.324 | 0/3 ; 9.93 ; 2.083 | 0/3 ; 6.98 ; 1.082 | 0/3 ; 8.42 ; 0.483 | 0/3 ; - ; - | 0/3 ; 7.65 ; 1.806 | 0/3 ; - ; - |
| syn-inf-history-consecutive-days-84p-s3007.repair | repair | - | feas | 0/3 ; 1.30 ; 0.016 | 0/3 ; 1.80 ; 0.016 | 0/3 ; 1.68 ; 0.053 | 0/3 ; 1.96 ; 0.043 | 0/3 ; 2.17 ; 0.027 | 0/3 ; - ; - | 0/3 ; 2.65 ; 0.133 | 0/3 ; - ; - |
| syn-inf-max-nights-cap-116p-s3005.repair | repair | - | feas | 0/3 ; 3.50 ; 0.040 | 0/3 ; 2.46 ; 0.015 | 0/3 ; 3.28 ; 0.056 | 0/3 ; 3.67 ; 0.043 | 0/3 ; 4.01 ; 0.136 | 0/3 ; - ; - | 0/3 ; 3.70 ; 0.102 | 0/3 ; - ; - |
| syn-inf-skill-mix-floor-date-92p-s3002.repair | repair | - | feas | 0/3 ; 5.14 ; 3.920 | 0/3 ; 2.68 ; 3.593 | 0/3 ; 1.68 ; 5.487 | 0/3 ; 2.41 ; 2.063 | 0/3 ; 1.66 ; 2.772 | 0/3 ; - ; - | 0/3 ; 2.80 ; 5.965 | 0/3 ; - ; - |

Status counts over the 213 main-matrix runs per variant ("UNK feasible" = no solution at all on a feasible ward):

| variant | OPTIMAL | INFEASIBLE | FEASIBLE | UNK feasible | UNK infeasible |
|---|---|---|---|---|---|
| current | 90 | 52 | 61 | 2 | 8 |
| base | 81 | 60 | 68 | 4 | 0 |
| lin2 | 82 | 60 | 65 | 6 | 0 |
| max_lp | 89 | 52 | 62 | 2 | 8 |
| sym_lin2 | 90 | 52 | 57 | 6 | 8 |
| sym_full2 | 84 | 60 | 0 | 69 | 0 |
| sym_w3 | 89 | 60 | 56 | 8 | 0 |
| interleave | 87 | 57 | 1 | 65 | 3 |

`core` and `no_lp` (12 key wards x 3 seeds, main-matrix conditions): `core` proved October but not genmed or ward-8, and no synthetic infeasible ward (0/9); `no_lp` proved no infeasible ward and neither October nor genmed. Both found no solution on some large wards (`core` on 120p, `no_lp` on 96p and 80p). Rejected.

## 4. Why the 3-worker setting and not the others

1. The job needs two different full workers. Only the level-2 LP (`max_lp`/`max_lp_sym`) closes the bound on October, genmed and ward-8. Only the level-1 `default_lp` proves the synthetic counting infeasibilities in seconds. `max_lp` alone is faster than `max_lp_sym` on small wards (October 0.09 s against 0.46 s) and equal on large87 at 60 s, but it has the same infeasibility gap, so swapping the name alone fixes nothing.
2. At 2 workers there is only one full-worker slot. Forcing two full workers into 2 threads (`num_full_subsolvers=2`) starves the first-solution and LNS workers: 0 solutions on every medium or large feasible ward in 15 s. `interleave_search` fails the same way.
3. A third worker thread on 2 cores keeps both full workers *and* an LNS/LS thread. It is the only candidate that met all three goals in the quiet runs, at the cost listed in the Answer.
4. `max_lp` + 3 workers is worse than `max_lp_sym` + 3 workers: sg-28day found no solution in 2 of 3 runs at 15 s, and 120p's first solution came at 25-37 s.

## 5. Files

In `/tmp/wave/qb5v/`: `qb.py` (one solve per run, all variants), `run.py` (3-lane runner), `table.py` and `keytable.py` (tables), `results.jsonl` (main matrix plus core/no_lp, 1,776 lines), `results_quiet.jsonl` (quiet key-ward runs), `results60.jsonl` (quiet 60 s runs), `results60_contended.jsonl` (discarded contended pass), `log116_*.txt` (search logs: current, base and lin2 on 116p), `src/` (v9.15 sources).
