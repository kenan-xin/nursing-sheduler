# Timefold: what else to borrow, and a hands-on spike with Timefold Community as our solver

Date: 2026-09-30. Scope G of the Timefold wave. Local spike only, under `/tmp/wave/timefold/spike/`. No repo file changed. No server was contacted.

Inputs read first, and not repeated here: [00-plan.md](00-plan.md), [01](01-score-analysis-explainability.md), [02](02-overconstrained-never-infeasible.md), [03](03-cpsat-infeasibility-explanation.md), [04](04-cpsat-autotune.md), and the solver-alternatives reports `2026-09-28-solver-alternatives/01..03`. Those reports already cover ScoreAnalysis, indictments, score diff, overconstrained planning, HardMediumSoft, recommendations, pinning, score folding, the dummy-nurse antipattern, the Enterprise search features, continuous planning, and the end of the Python build.

## 1. Short answer

1. Borrow three more things from Timefold, all on top of CP-SAT: per-rule tests on a fixed roster (ConstraintVerifier), an independent score recompute after each solve (FULL_ASSERT), and an early stop when improvement slows (diminished returns). All three are Community ideas and need no new dependency.
2. Do not use Timefold Community as our solver. On the October ward it finds a legal roster fast, but with its default settings it stops at 600 to 630 points of the 810 that CP-SAT proves in 0.3 to 0.5 s. With tabu search it reaches 810 in 3.5 to 23.5 s, but it can never say "this is the best" or "this is impossible". Our explanation plan needs both statements.

## 2. The spike

### 2.1 Set-up

- Machine: the local desktop (AMD Ryzen 9 9950X3D). Every solve was pinned to 2 cores with `taskset -c 0-1`. A desktop core is faster than a server vCPU, so absolute times on the production server will be worse.
- Timefold Solver Community 2.7.0 from Maven Central. Maven Central lists `<latest>2.7.0</latest>` with `<lastUpdated>20260924171224</lastUpdated>` ([maven-metadata.xml](https://repo1.maven.org/maven2/ai/timefold/solver/timefold-solver-core/maven-metadata.xml)). Java 26.0.2 runtime. Maven 3.9.11 came through the Maven wrapper (`maven-wrapper-distribution` 3.3.4, script only) into `~/.m2`. Nothing was installed system-wide.
- CP-SAT: the repo core at `origin/develop` (`b6d51c54`), exported with `git archive` into `/tmp/wave/timefold/spike/core-copy/`. It ran through the real path, `canonicalize_submission` then `scheduler.schedule`, on Python 3.14 with OR-Tools 9.15.6755, `num_workers = 2`, `random_seed` 1 to 3. The shipped `max_lp_sym` setting was active.
- Scenario: `/tmp/wave/bench/october.yaml`. It has 11 nurses (3 Seniors), 28 days, and 6 shift types.
- Checker: `check.py` scores any roster CSV with the core semantics, independent of Timefold. It counts broken hard rules and computes our objective. It agreed with Timefold's own soft score on every run.

### 2.2 What the October scenario asks, in core semantics

I read `preference_types.py` and `utils.py` at `origin/develop` to fix the meaning of each rule.

| Rule in the YAML | Core meaning | Timefold port |
|---|---|---|
| 6 staffing requirements, weight -1, no `preferredNumPeople` | Exact count: `actual_n_people == required` (`shift_type_requirements`). The weight has no effect without a preferred count. `A_sup` needs exactly 0. | One planning entity (a "slot") per required place: M 2, M_sup 1, A 2, N 2, N_sup 1. Exact staffing is built in and cannot break. |
| `qualifiedPeople: Seniors` on M_sup and N_sup | Hard: `unqualified_n_people == 0` | Hard constraint "lead shift needs a senior" |
| at most one shift per day | Hard, part of the day-state identity `offs + shifts + leaves == 1` | Hard constraint over pairs of slots on the same day |
| 4 successions `N` or `N_sup`, then `M` or `M_sup`, weight `-.inf` | Hard: the pattern must not match | Hard constraint, a join on nurse and next day |
| succession `ALL` x 7, weight `-.inf` | Hard: no 7 worked days in a row | Hard constraint with `toConsecutiveSequences`, penalty = run length minus 6 |
| successions `N` or `N_sup`, then `OFF`, weight 10 | +10 for each match, maximised. The pattern must fit inside the 28 days. | Soft reward of 10 with `ifNotExists` for a slot on the next day, only up to day 27 |

The optimum of 810 has a simple meaning. The ward staffs 3 nights a day. Nights on days 1 to 27 give 81 nights that can be followed by a day off, and 81 x 10 = 810. Each day 8 of 11 nurses work. So the 3 nurses off on a day must be exactly the 3 who worked the night before. This makes the problem very tight.

### 2.3 Results

Objective is our objective (maximised), computed by `check.py`. "First feasible" is the time from solve start to the first roster with 0 broken hard rules. CP-SAT stops by itself when it proves OPTIMAL. Timefold always runs to its time limit, because it has no proof of optimality.

| Solver | Limit | Seeds 1 / 2 / 3: objective | Hard rules broken | First feasible | Time to 810 | Wall time per run | Peak RSS |
|---|---|---|---|---|---|---|---|
| CP-SAT 9.15, 2 workers | 15 s | 810 / 810 / 810, OPTIMAL | 0 | 0.04 s (from `RESULTS.md`, 2-worker runs) | 0.32 to 0.50 s (proven) | 0.32 to 0.50 s solve, plus 0.24 s Python import | 165 to 167 MB |
| CP-SAT 9.15, 2 workers | 60 s | 810 / 810 / 810, OPTIMAL | 0 | same | 0.32 to 0.35 s (proven) | same | 163 to 165 MB |
| Timefold 2.7.0 default (late acceptance), `-Xmx512m` | 15 s | 620 / 610 / 620 | 0 | 0.40 / 0.40 / 0.57 s | never | 15.25 s | 208 to 253 MB |
| Timefold 2.7.0 default (late acceptance), `-Xmx512m` | 60 s | 630 / 630 / 620 | 0 | 0.38 / 0.41 / 0.54 s | never | 60.26 s | 198 to 303 MB |
| Timefold 2.7.0 tabu search, `-Xmx512m` | 15 s | 810 / 810 / 800 | 0 | 1.10 / 2.22 / 3.00 s | 3.5 / 5.6 s / not reached | 15.3 to 15.6 s | 187 to 204 MB |
| Timefold 2.7.0 tabu search, `-Xmx512m` | 60 s | 810 / 810 / 810 | 0 | 1.85 / 2.11 / 2.96 s | 4.7 / 5.3 / 23.5 s | 60.5 to 60.6 s | 216 to 245 MB |
| Timefold default, `-XX:+UseSerialGC -Xmx512m`, seed 1 | 15 s | 600 | 0 | 0.76 s | never | 15.48 s | 114 MB |
| Timefold default, no heap flag, seed 1 | 15 s | 620 | 0 | 0.86 s | never | 15.94 s | 843 MB |

Other local search types, 15 s, seed 1: `GREAT_DELUGE` ended at -30 hard / 410 soft, so it broke 30 hard rules. `SIMULATED_ANNEALING` did not start without a tuned starting temperature: "The acceptorType (SIMULATED_ANNEALING) requires non-null acceptorConfig.getSimulatedAnnealingStartingTemperature()." `DIVERSIFIED_LATE_ACCEPTANCE` did not start: "The preview feature DIVERSIFIED_LATE_ACCEPTANCE is not enabled."

JVM start-up and overhead:

- JVM start to `main()`: 4 to 6 ms with `-Xmx512m`, 24 ms with the default heap. The JVM reports this time itself (`RuntimeMXBean.getStartTime`).
- Building the solver (`SolverFactory.create(...).buildSolver()`): 172 to 181 ms in the default runs, 189 to 451 ms in the tabu runs, and 678 ms with the default heap.
- Whole process wall time minus the solve limit: 0.25 to 0.63 s. This is start-up, solver build, and output together. For comparison, the Python import of the core takes 0.24 s.
- Without a heap flag, the JVM took 843 MB on this 32-thread desktop, because the default heap is sized from the machine RAM. On a shared 3.6 GB server, a heap cap is required. With `-Xmx512m` the peak RSS was 187 to 303 MB. With the serial collector it was 114 MB.

### 2.4 What the numbers mean

- Timefold finds a legal roster fast. The first feasible roster came in 0.4 to 3.0 s, and no final roster broke a hard rule.
- The default configuration is not good enough on this ward. Timefold defaults to a construction heuristic and then local search: "If no phases are configured, Timefold Solver will default to a Construction Heuristic phase followed by a Local Search phase" ([local search docs, v2.7.0 source](https://raw.githubusercontent.com/TimefoldAI/timefold-solver/v2.7.0/docs/src/modules/ROOT/pages/optimization-algorithms/local-search.adoc)). The default local search type is late acceptance: `Objects.requireNonNullElse(phaseConfig.getLocalSearchType(), LocalSearchType.LATE_ACCEPTANCE)` ([DefaultLocalSearchPhaseFactory.java, v2.7.0](https://github.com/TimefoldAI/timefold-solver/blob/v2.7.0/core/src/main/java/ai/timefold/solver/core/impl/localsearch/DefaultLocalSearchPhaseFactory.java)). It stayed 22 to 26 % below the optimum even after 60 s.
- Tabu search closes the gap, but the time to 810 varies from 3.5 s to 23.5 s by seed. One 15 s run ended at 800. So a user gets a different roster quality for the same input, and a 15 s limit is not always enough. CP-SAT gave 810 on every seed in under 0.5 s.
- Timefold cannot stop early on its own. It does not know that 810 is the best. The only way to stop at 810 is a `bestScoreLimit`, and that needs the optimum in advance. So every Timefold solve used its full time on our 2-core server, which is shared by prod, dev and builds.
- One tuning step (the local search type) changed the result from 620 to 810. This is a real cost: each ward shape can need its own tuning, and a wrong choice (for example great deluge) breaks hard rules without an error.
- Memory is acceptable with a heap cap. It is 1.2 to 1.8 times the Python process, and less with the serial collector.

### 2.5 Rules I did not port, and why

The October port covers every rule in that YAML. It is still not a general port. The data is hard-coded in `Spike.java`, not read from YAML. The list below covers what is missing.

October rules ported with a narrower meaning:

1. `ALL` x 7 successions. Correct only without history. The core adds history-prefix patterns at day 0. The port has no history.
2. `N` then `OFF`. The port treats "no slot on the next day" as OFF. In the core, OFF excludes LEAVE. October has no leave, so the result is the same, but a general port needs a separate leave state.
3. Staffing as slots. This works only because every October requirement is exact and names one shift type. See items 5 and 6.

Rule types our core supports that the spike did not port, because October does not use them:

4. Preferred counts (`preferredNumPeople`). They need optional extra slots with `allowsUnassigned` and a soft reward. That is a model redesign, see [02](02-overconstrained-never-infeasible.md).
5. Aggregate requirements (`shiftType: [[D, E]]` or a shift type group) and `coefficients`. A slot has a fixed shift type, so "1 nurse on D or E" needs the shift type as a second planning variable. This is the hardest mismatch with the slot model.
6. Date overrides (`requiredNumPeopleOverrides`). These are easy: they only change the slot count per date.
7. Skill mix ("at least k of these people"). Possible with `groupBy` and a conditional count, not tried.
8. Shift requests: wishes for shifts or OFF (soft), and hard LEAVE (a pinned day state). Possible, not tried.
9. History look-back for all successions, and `+.inf` successions ("must match"). History needs pinned past slots. Not tried.
10. Shift counts, linear and squared, and contracted hours. Easy in Java with `groupBy(nurse, count())` and a penalty lambda. Not tried.
11. Shift affinities (pairings) and shift type coverings (supervision). Possible with joins and `ifNotExists`. Not tried.
12. The compile layer: people groups, date groups, selectors such as `ALL`, and the canonical input. All of this lives in Python today and would need a Java copy or a JSON hand-off.
13. Not rules, but lost features: the OPTIMAL status, the objective bound and gap, the INFEASIBLE proof, and the `Report` list that the diagnostic tests pin.

## 3. Question 1: what else we can borrow

The background desk research for this wave is in `/tmp/wave/timefold/spike/desk-research.md` (not committed). This section keeps only the items that are new, with its primary-source quotes.

| Idea | Edition | What it is | How to borrow on CP-SAT | Value |
|---|---|---|---|---|
| ConstraintVerifier | Community | "Constraint streams include the Constraint Verifier unit testing harness". A test gives fixed facts and asserts the penalty, for example `.given(vehicleA, visit1, visit2).penalizesBy(20)` ([score calculation](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/score-calculation)). In 2.x the "`timefold-solver-test` dependency [was] removed (testing APIs merged into core)" ([upgrade from v1](https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1)). | Build the model with one preference, fix every `shifts[(d,s,p)]` to a given roster, and assert that the rule's objective part equals N, or that a hard rule gives INFEASIBLE. It reuses the penalty ledger of 00-plan §4.1. | High |
| Score corruption checks (`FULL_ASSERT`) | Community | `FULL_ASSERT` "will fail-fast on a bug in a Move implementation, a constraint, the engine itself" ([solver diagnostics](https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/solver-diagnostics)). | Recompute every rule's points from the final roster in plain Python, and compare with the CP-SAT objective and the `Report` list. The spike's `check.py` is a small example of this: it matched Timefold's score on all 17 spike rosters. | High |
| Diminished-returns termination | Community | "The diminished returns termination terminates when the rate of improvement is below a percentage of the initial rate of improvement." There is also an unimproved-time limit that "Terminates when the best score has not improved in a specified amount of time" ([algorithms overview](https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/overview)). | In the existing solution callback, track objective and `wall_time()`, and call `stop_search()` when improvement slows. This frees CPU on the shared server for large wards that never prove OPTIMAL. | High |
| Benchmarker and report | Community | "a benchmarker, which allows you to play out different solver phases with different settings against each other" ([benchmarking](https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/benchmarking-and-tweaking)). The pricing page lists "solver manager and benchmarker" under Community ([pricing](https://timefold.ai/pricing)). | Turn `/tmp/wave/bench/bench.py` into a standing script: wards x settings x seeds, objective over time, one ranked report. Run it before each solver or rule-encoding change. | Medium |
| Fairness with `loadBalance` | Community | "A schedule is fair if the employee with most tasks has as few tasks as possible" ([load balancing and fairness](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/load-balancing-and-fairness)). | Our squared counts use a fixed target per person. Add a mode that squares `n x count_p - total` over a group, which measures distance from the group mean without division. | Medium |
| Consecutive sequences as objects | Community | `toConsecutiveSequences` gives runs and "any and all breaks between those matches" ([score calculation](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/score-calculation)). The spike used it for the 6-day limit. | Keep our encoding. In the ledger, merge overlapping violated windows into one run: "Ana worked 7 days in a row, 3 to 9 Oct". | Medium (explanations only) |
| Constraint weight overrides | Community, changed in 2.x | "The `@ConstraintConfiguration`, `@ConstraintConfigurationProvider`, and `@ConstraintWeight` annotations have been removed" ([upgrade from v1](https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1)). Weights now come from `ConstraintWeightOverrides`, and a weight of zero means the rule "will be disabled entirely" ([constraint overrides](https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/library/constraint-overrides)). | A weight profile per run, keyed by stable rule id, 0 = off. The assistant can then re-solve "same roster, other weights" and diff the runs. | Medium |
| Throttled best-solution events, constraint profiling | **Enterprise** | Listed as Enterprise in the [commercial editions](https://docs.timefold.ai/timefold-solver/latest/commercial-editions/commercial-editions) table. | Not needed. Our callback and `model_build_stats` cover them. | Low |

The spike added one lesson of its own. A local search solver needs its algorithm tuned per problem shape. The October result moved from 620 to 810 when only the local search type changed. CP-SAT did not need that step here. This supports the rule in 00-plan §4.5 that the assistant must never set raw solver parameters.

One possible bug came out of the desk reading. It is **unconfirmed** because nobody reproduced it. For negative soft successions, the core only puts a lower bound on `is_match` (the `weight < 0 and is_literal_pattern` branch in `shift_type_successions`). If a solve stops before OPTIMAL, `is_match` can stay at 1 with no real match, and the `Report` list then shows a false violation. The score recompute above catches this class of bug.

## 4. Question 2: Timefold Community as our solver

| Fact | Source |
|---|---|
| Community is Apache 2.0: "Apache License Version 2.0, January 2004". The pricing page says "Open-source, Apache 2.0. The full constraint solver engine, free forever" and "No support". | [LICENSE.txt](https://github.com/TimefoldAI/timefold-solver/blob/main/LICENSE.txt), [pricing](https://timefold.ai/pricing) |
| Enterprise only in 2.7.0: "Score Analysis", "Recommendation API", "Performance improvements", "Nearby selection", "Multithreaded solving", "Partitioned search", "Constraint profiling", "Multistage moves", "Throttling best solution events". Also: "Unlike Timefold Solver Community Edition, this commercial edition is not open-source". No price is published. | [commercial editions](https://docs.timefold.ai/timefold-solver/latest/commercial-editions/commercial-editions), [pricing](https://timefold.ai/pricing) |
| Java: "Timefold Solver 2.x requires Java 21 or later to run". | [upgrade from v1](https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1) |
| No Python route. The last `timefold-solver-python-core` on Maven Central is 1.24.0. The last PyPI `timefold` is 1.24.0b0. | [Maven metadata](https://repo1.maven.org/maven2/ai/timefold/solver/timefold-solver-python-core/maven-metadata.xml), [PyPI](https://pypi.org/project/timefold/) |
| No proof of optimality: "it is usually impossible for anyone or anything to find the optimal solution. Therefore, Timefold Solver focuses on finding the best solution in available time". | [algorithms overview](https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/overview) |
| A 2.x "Run as a Service" module exists, but the page warns it "may be changed or even removed in a future release". Whether it is fully Community is **unconfirmed** (inferred from its Maven group only). | [service overview](https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/service/overview) |
| Memory guidance is vague: "Provision plenty, but no need to provide more." The smallest hosted tier lists "1 thread, 4GB memory". The spike measured 187 to 303 MB peak RSS with `-Xmx512m` on October. Large wards are **not measured**. | [FAQ](https://docs.timefold.ai/timefold-solver/latest/frequently-asked-questions), [pricing](https://timefold.ai/pricing), spike |

What a switch costs us:

1. The explanation plan in 00-plan §4.2 to §4.3 needs an INFEASIBLE proof, cores and correction sets. With Timefold, a negative hard score only means "not found in time".
2. Score analysis is Enterprise in 2.x, so we must build the ledger ourselves in both cases.
3. Each solve uses its full time limit, because there is no OPTIMAL stop. Today CP-SAT frees the CPU after 0.3 to 0.5 s on October.
4. The result quality depends on local search tuning and on the seed (800 or 810 at 15 s with tabu).
5. A second runtime (a JVM with a heap cap) on a 3.6 GB server shared by prod, dev and builds.
6. A Java port of 6 rule types, the history logic and the compile layer, plus parity tests. The slot model does not fit aggregate requirements (item 5 in §2.5). Every upstream v1 core fix then needs a Java port too. My rough size is several weeks. That is an estimate, not a measurement.

Timefold is strong in some places. The constraint stream API expresses every rule type we have, and squared counts and supervision coverings are shorter in Java than in CP-SAT. On very large wards, local search could beat CP-SAT at 2 workers, where large87 now ends with a mean gap of 168 % at 2 workers and 15 s (`/tmp/wave/bench/RESULTS.md`). The spike did not test large87, so that point is **unconfirmed**.

## 5. Recommendation

1. Stay on CP-SAT. Do not adopt Timefold Community as the solver. On our real ward it is slower, less stable across seeds, needs tuning, and removes the proofs that our explanation plan depends on.
2. Borrow three Community ideas, in this order, all in Python on top of CP-SAT:
   1. An independent score recompute after each solve, in tests and behind a debug flag (FULL_ASSERT). Use it first to confirm or reject the `is_match` false-violation risk.
   2. Per-rule tests on a fixed roster (ConstraintVerifier). They reuse the penalty ledger from 00-plan P2.
   3. An early stop when improvement slows (diminished returns), for large wards that never reach OPTIMAL.
3. Later, and only on demand: a standing benchmark script, a group-mean fairness mode, weight profiles by rule id, and merged runs in the ledger.
4. Look at Timefold again only if one of two things happens: upstream v1 leaves CP-SAT, or large wards (80+ people) become a real workload and CP-SAT still fails there on 2 cores. In that case, run this spike again on `large87.yaml` before any decision.

## 6. Unconfirmed items

- Timefold on large87. Not run. Looked at: nothing, out of the time budget.
- The `is_match` false violation for negative soft successions. Found by reading code only, not reproduced.
- Whether the 2.x Community benchmarker still shows per-constraint statistics, and whether the service module is fully Community. Looked at: the v2.7.0 docs source and Maven group ids.
- Absolute times on the production server. All runs used a desktop pinned to 2 cores.
- The effort estimate for a full port.

## 7. How to reproduce

```sh
# CP-SAT (repo core at origin/develop, exported to a scratch copy)
cd /tmp/wave/timefold/spike/core-copy/core
PYTHONPATH=. taskset -c 0-1 /usr/bin/python3.14 /tmp/wave/timefold/spike/cpsat_run.py 15 1

# Timefold 2.7.0 (build once with the Maven wrapper)
cd /tmp/wave/timefold/spike/model && ./mvnw -q -B package
taskset -c 0-1 java -Xmx512m -cp "target/tf-october-1.jar:target/lib/*" spike.Spike 15 1 ../out/r.csv TABU_SEARCH
python3 ../check.py ../out/r.csv
```

Raw results: `cpsat_results.jsonl`, `tf_results.jsonl` (default and heap variants), `tabu_results.jsonl`, `ls_results.txt`, all in `/tmp/wave/timefold/spike/`.
