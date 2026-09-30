# Scope C: CP-SAT infeasibility explanation, remedies and score breakdown

Date: 2026-09-30. Solver: `ortools==9.15.6755`. Primary OR-Tools sources are pinned to tag `v9.15`.
This report builds on the l3m core spec (`docs/superpowers/specs/2026-09-27-infeasible-core-design.md`), the vjbv ladder spec (`2026-09-29-priority-ladder-design.md`) and `docs/research/2026-09-28-solver-alternatives/`. It does not repeat their CP-SAT facts. It adds new facts, a local experiment, the literature and concrete designs.

## Answer

1. **New pitfall for the l3m design.** In 9.15, any model with assumptions runs on one worker, even with an objective. The l3m spec (§4.2) adds every scope literal as an assumption to the normal Optimize run and says the run stays unchanged. It does not. The normal run drops to 1 worker. Pin guard literals by domain in the normal run. Add assumptions only in the core solve.
2. CP-SAT's raw core was close to minimal in every test. Deletion shrink removed 0 to 2 members. On a 25 x 28 ward the raw core took 0.05 to 0.5 s and the full shrink took 0.7 to 1.4 s on 2 pinned cores.
3. A MUS names *why*. An MCS names *what to change*. Hitting-set duality links them. One weighted MCS solve (ladder weights) gives a ranked remedy and a witness roster that proves the fix. It took 0.4 to 0.9 s on the 25 x 28 ward.
4. A solution hint alone did not keep the roster stable after a change (97 to 570 of 2100 shift variables moved). A hint plus a change penalty moved 8 to 10 variables, at the same wish cost, and solved faster.
5. Timefold's score analysis, recommendations and solution diff are Enterprise-only in 2.x. Its overconstrained planning and nonvolatile replanning are modelling patterns that we can copy on CP-SAT.

## 1. Local experiment

Scripts: `/tmp/wave/timefold/scope-c/core_experiment.py`, `/tmp/wave/timefold/scope-c/hint_experiment.py`, `/tmp/wave/timefold/scope-c/issue4324_check.py`. Raw output: `run2.json`, `run_hint.json` in the same folder.

- Setup: `python3 -m venv /tmp/wave/timefold/scope-c/venv && venv/bin/pip install 'ortools==9.15.*'`. It installed 9.15.6755 on Python 3.12.13.
- Command: `taskset -c 0,1 venv/bin/python core_experiment.py` (2 pinned cores of an AMD Ryzen 9 9950X3D). The whole run took 17 s. Peak RSS was 197 MB.
- Model: bool `x[nurse, day, shift]`. One shift a day per nurse is background (never assumed). Every other hard rule *instance* gets its own guard literal via `only_enforce_if`: cover per (day, shift), leave per (nurse, day), max nights in a row per (nurse, start day), no day shift after a night per (nurse, day, shift), 2 rest days in any 7 per (nurse, window), a shift cap per nurse, and "no nights" per nurse. Off wishes are soft (weight 20, ladder tier 3).
- Instances. Toy: 5 nurses x 7 days, D/N, Ana and Ben on leave on day 4 when 2 D + 2 N are needed. Large: 25 nurses x 28 days, D/E/N, 6% random leave, 3 seeds each of two variants. `leave_cluster` puts 12 nurses on leave on day 15. `night_overdemand` lets only 5 nurses work nights with 4 night places a day.
- The script asserts that the toy's minimal core is exactly the 4 expected rules.

| instance | guards | raw core, 1 worker | presolve off | 2 workers | with objective | shrink | MCS (2 workers) |
|---|---|---|---|---|---|---|---|
| toy 5x7 | 82 | 4 in 0.003 s | 4 in 0.001 s | 4 | all 82 | 4, 4 solves, 0.006 s | 1 rule, 0.008 s |
| leave_cluster s1 | 2695 | 17 in 0.049 s | 17 in 0.017 s | 17 | all 2695 | 15, 17 solves, 1.00 s | 1 rule, 0.46 s |
| leave_cluster s2 | 2680 | 15 in 0.456 s | 15 in 0.477 s | 15 | all | 15, 15 solves, 0.71 s | 1 rule, 0.85 s |
| leave_cluster s3 | 2686 | 16 in 0.066 s | 16 in 0.037 s | 16 | all | 15, 16 solves, 0.92 s | 1 rule, 0.44 s |
| night_overdemand s1 | 2703 | 23 in 0.047 s | 23 in 0.012 s | 23 | all | 23, 23 solves, 1.10 s | 1 rule, 0.55 s |
| night_overdemand s2 | 2690 | 23 in 0.046 s | 23 in 0.012 s | 23 | all | 23, 23 solves, 1.10 s | 1 rule, 0.56 s |
| night_overdemand s3 | 2696 | 29 in 0.046 s | 29 in 0.012 s | 29 | all | 29, 29 solves, 1.40 s | 1 rule, 0.58 s |

What the numbers show:

- Every shrunk core was proven minimal inside the budget. The raw core was already minimal in 5 of 7 cases.
- "2 workers" gave the same core as 1 worker, because 9.15 forces 1 worker (section 2).
- Presolve off was faster for the core solve on these easy proofs. It did not change the core.
- The toy core renders as: "2 D nurses needed on day 4. 2 N nurses needed on day 4. Ana is on leave on day 4. Ben is on leave on day 4." The MCS said: relax "2 N nurses needed on day 4".
- Limit: these proofs are easy. The l3m spec measured 0.03 to 5.6 s per proof on real wards. At 5 s per deletion solve, a 15-member core costs 75 s. The time cap in the design below handles that.

Pin cost (feasible busy 25 x 28 ward, 16 places a day, 35% of person-days carry an off wish, 15 s limit, 2 workers):

| seed | guards pinned by domain | guards pinned by assumptions |
|---|---|---|
| 1 | OPTIMAL 0.26 s, first roster 0.066 s | OPTIMAL 0.22 s, first roster 0.216 s |
| 2 | OPTIMAL 0.25 s, first roster 0.066 s | OPTIMAL 0.52 s, first roster 0.291 s |

The assumption run logged "Starting search at 0.03s with 1 workers." This ward is easy. On ward-8, 1 worker found no roster in 60 s (solver-alternatives report 01, L1).

Hinted re-solve after a change (`hint_experiment.py`): solve the busy ward, then put 3 more nurses on leave on day 11, and re-solve. "Changed" counts the 2100 shift variables that differ from the old roster.

| seed | cold | hint | hint + `repair_hint` | hint + change penalty (1 point per changed variable) |
|---|---|---|---|---|
| 1 | 0.30 s, 618 changed | 0.93 s, 570 changed | 0.46 s, 602 changed | 0.13 s, 8 changed |
| 2 | 0.49 s, 574 changed | 1.10 s, 97 changed | 0.38 s, 622 changed | 0.16 s, 10 changed |

All runs reached OPTIMAL with the same wish cost (1180 and 1000).

## 2. CP-SAT assumptions: facts beyond the l3m spec

- **Assumptions force one worker, with or without an objective.** `AdaptGlobalParameters` logs "Forcing sequential search as assumptions are not supported in multi-thread." and then calls `params->set_num_workers(1)` ([cp_model_solver_helpers.cc L2179-2191](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model_solver_helpers.cc#L2179-L2191)). It runs before the "non-fully supported setting" check ([cp_model_solver.cc L2546, L2712-2722](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model_solver.cc#L2712-L2722)). Reproduced in the pin-cost test above.
- **Assumptions also turn off lossy presolve.** The same block logs "Forcing presolve to keep all feasible solutions in the presence of assumptions." (same lines). This is a second cost for a normal run that carries assumptions.
- The docs still say the user sets the worker count: "the number of workers must be set to 1" ([troubleshooting.md L93-94](https://github.com/google/or-tools/blob/v9.15/ortools/sat/docs/troubleshooting.md)). In 9.15 the solver does it for you.
- The maintainer on objectives: "If you have an objective, move the assumptions to the objective." On parallel cores: "the current algorithm is inherently sequential" ([issue #2563](https://github.com/google/or-tools/issues/2563)).
- The core is a MUS candidate, not a correction set: "the system returns a minimal unsatisfiable set, not a minimal correction set" ([issue #3983](https://github.com/google/or-tools/issues/3983)).
- The docs' route to a true MUS: "you must minimize the (weighted) sum of these assumption literals instead" ([troubleshooting.md L89-91](https://github.com/google/or-tools/blob/v9.15/ortools/sat/docs/troubleshooting.md)). The proto phrases it as "minimize the number of assumptions at false" ([cp_model.proto L787-789](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto#L777-L796)). My reading: that optimisation returns a minimum-cost *correction* set (section 3), not a MUS. It is the MCS solve in section 1.
- Hints plus assumptions once returned OPTIMAL on an UNSAT model ([issue #4324](https://github.com/google/or-tools/issues/4324), closed for v9.13). The issue's repro returns INFEASIBLE on 9.15 with presolve on and off (`issue4324_check.py`).
- Scope: `only_enforce_if` is the only per-constraint hook. The primer warns: "not all constraints in CP-SAT support reification" ([primer, parameters](https://github.com/d-krupke/cpsat-primer/blob/main/chapters/parameters.md)).

## 3. MUS, MCS and the duality between them

- **Definitions.** A MUS is a conflict. "A minimal correction set (MCS) M of a constraint system C is a subset M ⊆ C such that C \ M is satisfiable" and minimal ([Liffiton et al., Constraints 2016, p. 4](https://sun.iwu.edu/~mliffito/publications/constraints_liffiton_marco.pdf)).
- **Duality.** "every MUS of a constraint system is a minimal hitting set of the system's MCSes and every MCS is a minimal hitting set of its MUSes" (same paper). So one MCS breaks every conflict at once. One MUS member fixes only that one conflict. This explains the l3m note that softening one core member "does not promise" a fix.
- **Deletion-based MUS.** CPMpy's `mus()` does it on OR-Tools: it "Will extract an unsat core and then shrink the core further by repeatedly omitting one assumption variable" and refines to the new core on each UNSAT step ([cpmpy/tools/explain/mus.py](https://github.com/CPMpy/cpmpy/blob/master/cpmpy/tools/explain/mus.py), Apache 2.0). This is the l3m §4.3 loop.
- **QuickXplain** (Junker, AAAI 2004). It picks a *preferred* conflict: "a user of an interactive application, however, desires explanations and relaxations containing the most important constraints" ([AAAI04-027](https://cdn.aaai.org/AAAI/2004/AAAI04-027.pdf)). It needs `2k·log(n/k) + 2k` consistency checks in the worst case, for a conflict of size k among n (Table 4). Deletion needs n. QuickXplain wins only when the raw core is much larger than the MUS. Our raw cores were within 2 of minimal, so deletion is enough. CPMpy ships `quickxplain()` in the same file.
- **Preference order matters.** Junker's method returns the conflict that keeps the most preferred rules. The deletion loop does the same when it deletes the least preferred rules first. l3m §4.3 already takes a caller order. The ladder gives that order (section 5).
- **MARCO** enumerates many MUSes and MCSes: "MARCO produces MUSes earlier in its execution and more steadily" than CAMUS ([MARCO page](https://sun.iwu.edu/~mliffito/marco/)). CPMpy has `marco.py`. We need one conflict and a few ranked fixes, not full enumeration. So MARCO is P2 at most.
- **Minimum-cost MCS by optimisation.** CPMpy's `mcs_opt` "Computes a subset of constraints which minimizes the sum of all weights of constraints" ([mcs.py](https://github.com/CPMpy/cpmpy/blob/master/cpmpy/tools/explain/mcs.py)). MCS algorithms in general: Marques-Silva et al., "On Computing Minimal Correction Subsets", IJCAI 2013 ([PDF](https://www.ijcai.org/Proceedings/13/Papers/098.pdf)). I did not read the full IJCAI paper.
- **Smallest MUS.** CPMpy's `ocus`/`optimal_mus` use the hitting-set duality: they work "by iteratively generating correction subsets and computing optimal hitting sets" (mus.py, after Gamba, Bogaerts and Guns, JAIR 2023). It is many solves. Not worth it for 15 s runs.

## 4. Explaining infeasible rosters: literature

- Workforce allocation (Airbus, CPMpy on OR-Tools and other back ends) offers both modes. MUS: "resolving each MUS conflict one by one in an interactive manner". MCS: "computes one of the minimal correction subsets (MCS) to resolve all conflicts simultaneously", and it "re-computes a new MCS after a user has relaxed some constraints". Their MUS uses "the well-known deletion-based method" ([Povéda et al., PTHG-24, arXiv:2412.10272](https://arxiv.org/abs/2412.10272), §3.2 and §4.1.2).
- Nurse rostering: Böðvarsdóttir, Smet, Vanden Berghe and Stidsen tie target thresholds to MUSes: thresholds for a component are "directly linked to finding minimal unsatisfiable subsets". They claim their method "provides the user with clear reasoning behind the trade-offs made, as opposed to methods employing a single evaluation function" ([EJOR 2021 preprint](https://people.cs.kuleuven.be/~pieter.smet/preprints/compromise-rostering-2021-preprint.pdf)).
- "Explainability Results for the Rotating Workforce Scheduling Problem" (Springer 2026) uses MCSes for infeasible instances ([chapter](https://link.springer.com/chapter/10.1007/978-3-032-27242-3_20)). **Unconfirmed**: the page redirected to a login. I saw only a search snippet.
- The CP 2021 MUS/MCS visualiser and the SMT vs MILP study are in solver-alternatives report 03, §5. Not repeated here.

## 5. Core to ward text, and remedy ranking by the ladder

Templates key on the guard's metadata, not on solver output. Each guard literal maps to one rule instance: `{rule, rule_id, tier, date, shift, nurses, need, limit}`. The web already maps index to source (l3m §4.7 `PreferenceSource`). A template per rule kind turns one instance into one clause. An aggregator then joins members that share a date and shift into one sentence:

- Group: cover(14 Oct, N, need 3) + leave(Ana, 14 Oct) + leave(Ben, 14 Oct).
- Count: nurses able to work N on 14 Oct = all nurses minus those blocked by a member of the core.
- Text: "3 night nurses are needed on 14 Oct, but only 2 can work: Ana and Ben are on leave."

The count comes from one check per nurse over the shrunk core members, with no solve. The sentence is built by the host. The assistant receives the structured members and the sentence, and it rewrites them in ward words. It must not invent members.

Remedy ranking. The ladder (vjbv §10) says: "first relax the lowest tier that unblocks the roster, then extra staff, then move leave, then cancel leave." Every core member is tier H, so the MCS solve needs an order inside H. Proposed relax costs:

| rule instance kind | remedy | relax cost |
|---|---|---|
| hard request block | soften to a tier-3 wish (20) | 10 |
| editable cap (not an exact count) | relax the cap by 1 | 20 |
| staffing minimum | run one short on that date and shift | 100 |
| virtual agency nurse (new) | borrow a temporary nurse | 200 per shift |
| leave | move leave (with the nurse's agreement) | 1000 |
| sleep day, max 4 nights, max 6 days, contracted hours, safety floor | never relaxed: no guard in the MCS solve | none |

The virtual agency nurse is Timefold's "virtual values" idea on CP-SAT: extra nurse columns that cost points when used. Timefold says the overload entities go to "dummy values provided by the user" and calls it "inferior" to unassigned values ([1.x responding to change](https://docs.timefold.ai/timefold-solver/1.x/responding-to-change/responding-to-change)). On CP-SAT the cost term makes it exact, so it is sound here. A staffing slack (integer "places short") is the unassigned-values analogue.

## 6. Hinted re-solve after a remedy

- The proto: "There is also no guarantee that the solver will use this hint or try to return a solution "close" to this assignment" ([cp_model.proto L656-667](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto#L656-L667)). Our test confirms it: 97 to 570 variables moved with a hint.
- `repair_hint`: "the solver tries to repair the solution given in the hint. This search terminates after the 'hint_conflict_limit' is reached" (default 10) ([sat_parameters.proto L1196-1207](https://github.com/google/or-tools/blob/v9.15/ortools/sat/sat_parameters.proto#L1196-L1207)). It gave no stability gain in our test.
- `fix_variables_to_their_hinted_value` fixes hinted variables. The primer calls it "simpler and deterministic" for checking a hint ([primer](https://github.com/d-krupke/cpsat-primer/blob/main/chapters/parameters.md)). Use it to check a pinned partial roster, not for re-optimising.
- Presolve can break a hint. The primer's workaround is `keep_all_feasible_solutions_in_presolve = True`, which "may degrade solver performance" (same page).
- Stability comes from the objective. Timefold's nonvolatile replanning does the same: "the gain of changing a plan must be higher than the disruption it causes" ([1.x responding to change](https://docs.timefold.ai/timefold-solver/1.x/responding-to-change/responding-to-change)). A churn term below tier 5 (1 point per changed person-day) keeps the ladder intact.

## 7. Timefold comparison points (brief)

| feature | edition | source |
|---|---|---|
| `ScoreAnalysis` (per constraint, per match, justification) | Enterprise only in 2.x: "now provided exclusively by Timefold Solver Enterprise Edition" | [upgrade guide](https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1) |
| Recommended assignment, solution diff | Enterprise: "now requires Timefold Solver Enterprise Edition on the classpath" | same |
| `Indictment` (per entity) | removed: "There is no replacement type for `Indictment`." | same |
| `justifyWith(...)` in Constraint Streams | no Enterprise note on its page | [score calculation](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/score-calculation) |
| Multithreaded solving, nearby selection, constraint profiling | Enterprise | [commercial editions](https://docs.timefold.ai/timefold-solver/latest/commercial-editions/commercial-editions) |
| Overconstrained planning, pinning, `ProblemChange` | not on the commercial list. **Unconfirmed** as Community: no page states it | [real-time planning](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/real-time-planning) |

What ScoreAnalysis gives: "Which constraints are broken, and how many times" and "Which planning entities and problem facts are responsible" ([understanding the score](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/understanding-the-score)). What it does not give: the maintainer says "The solver unfortunately cannot tell you why something didn't happen" ([discussion #1617](https://github.com/TimefoldAI/timefold-solver/discussions/1617)). CP-SAT with guards can: an INFEASIBLE proof plus a core is a real "why not".

## 8. Unconfirmed items

- The Rotating Workforce Scheduling chapter (Springer login wall). I used a search snippet only.
- The full IJCAI 2013 MCS paper. I used the search abstract.
- Timefold edition of pinning and overconstrained planning. I read the commercial editions page and the real-time planning page. Neither states it.
- All timings are on 2 pinned cores of a fast desktop CPU, not on tc1 (2 shared cores under build load). The toy wards are easier than the real 28-day wards. Real-ward core and MCS timings remain the l3m G2 gate.

## Implement on CP-SAT

Budgets assume tc1 (2 cores) and the l3m step running after the main solve proves INFEASIBLE.

**D1. Guard literals per rule instance, pinned by domain, assumptions only in the core solve.** P0, S (on top of l3m P5).
- Change to l3m §4.2: in the normal run, set each guard's domain to `[1, 1]` (proto `variables[i].domain[0] = 1`, tested in the script). Do not call `add_assumptions` there. In the core solve, reset domains to `[0, 1]`, clear the objective, add the assumptions.
- G1 then measures the right thing. Also log the solver's "Starting search ... with N workers" line in G1.
- Cost: none in the normal run. Core solve: 0.05 to 0.5 s on the 25 x 28 toy. Real wards: 0.03 to 5.6 s (l3m).

**D2. Deletion shrink with a time cap, ladder order.** P0, S.
- The l3m §4.3 loop, with deletion order = highest relax cost first (leave, staffing, then caps, then requests). The surviving MUS then names the cheapest rules to change, as in QuickXplain's preferred conflict.
- Cap: `min(10 s, remaining)` total, 3 s per solve. On timeout return the current core with `minimal: false`.
- Cost: 0.7 to 1.4 s for 15 to 29 members on the toy. It grows linearly with core size times proof time.

**D3. Weighted MCS for ranked remedies.** P1, M.
- Relax only guards in the relaxable rows of the section 5 table. Add staffing slack and virtual agency nurses. Minimise the sum of relax costs. Use 2 workers (no assumptions), limit 10 s.
- Result: the cheapest set of changes plus a witness roster. The witness proves the fix, so no `test_feasibility_candidates` copy is needed for this candidate. FEASIBLE (not OPTIMAL) still gives a valid correction set, but maybe not the cheapest.
- Alternatives: add a clause "at least one of this MCS stays enforced" and solve again, 2 more times, for 3 ranked remedies.
- Cost: 0.4 to 0.9 s per solve on the toy. Real wards unmeasured.

**D4. Core-to-text templates.** P0, S (web).
- One template per rule kind keyed on `PreferenceSource`, plus the date/shift aggregator in section 5. Pure functions with Vitest cases.
- Cost: no solve.

**D5. Per-rule, per-nurse, per-date score breakdown (ScoreAnalysis analogue).** P1, M.
- The core keeps, per soft term, `(rule index, nurse, date, weight, variable)`. After the solve it reads `solver.value(variable)` and emits every non-zero term. The web adds the tier from vjbv `tierOf`.
- Cost: no extra solve. One value read per soft term. The script builds this dict (`score_breakdown_sample`, `breakdown_top`).

**D6. Hinted re-solve with a churn penalty.** P2, M.
- After the user applies a remedy, hint the previous roster and add `1 point x changed person-day` to the objective. Offer a "keep the roster stable" switch. Do not use `fix_variables_to_their_hinted_value` except for a feasibility check.
- Cost: faster than cold in our test (0.13 vs 0.30 s). It needs the previous roster in the job request.

Data the assistant receives (one JSON per Optimize run):

```json
{
  "status": "INFEASIBLE",
  "core": {
    "minimal": true, "solves": 17, "seconds": 1.0,
    "members": [
      {"rule_id": "card:req-night", "kind": "requirement", "tier": "H", "date": "2026-10-14", "shift": "N", "need": 3},
      {"rule_id": "request:ana:2026-10-14", "kind": "leave", "tier": "H", "date": "2026-10-14", "nurses": ["Ana"]}
    ],
    "text": "3 night nurses are needed on 14 Oct, but only 2 can work: Ana and Ben are on leave."
  },
  "remedies": [
    {"rank": 1, "action": "run_one_short", "relax": ["card:req-night@2026-10-14"], "cost": 100, "proven": true},
    {"rank": 2, "action": "borrow_temporary_nurse", "shifts": 1, "cost": 200, "proven": true}
  ],
  "score": {
    "total": -60,
    "by_tier": {"1": 0, "2": 0, "3": -60},
    "matches": [{"rule_id": "request:dev:2026-10-02", "tier": "3", "nurse": "Dev", "date": "2026-10-02", "points": -20}]
  }
}
```

`score` is filled for FEASIBLE and OPTIMAL runs. `core` and `remedies` are filled only for a proven INFEASIBLE run.
