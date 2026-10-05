# Scope F: Timefold Solver Community Edition as our solver (desk study)

Date: 2026-09-30. Scope F of the Timefold tricks research. This is a desk study. I ran no Timefold code. Timefold docs were read as AsciiDoc source from `TimefoldAI/timefold-solver` `main` (commit `3d233796`, `docs/src/modules/ROOT/pages/`) and on docs.timefold.ai (2.7.0). Our code facts come from `origin/develop` of this repo, read with `git show`.

Builds on, and does not repeat: [solver alternatives 02][int-alt02] (Timefold row, Python end), [01 score analysis][int-01], [02 overconstrained planning][int-02], [03 infeasibility][int-03], [04 autotune][int-04] and the [combined plan 00][int-00].

## Answer

1. **Licence and edition.** Community is Apache-2.0 and free. The latest release is 2.7.0 (24 Sep 2026). Community has Constraint Streams, construction heuristics, local search, pinning, real-time planning, the benchmarker and the Quarkus / Spring Boot integration. Score analysis, recommendations, multithreaded solving, nearby selection and partitioned search are Enterprise only.
2. **Runtime.** 2.x needs Java 21. It is a JVM service next to our Python core. The Python binding ended in July 2025. So "adopt Timefold" means a second runtime and a Java port of every rule.
3. **Fit.** Each of our 7 rule types can be written in Constraint Streams. The port is about 33 to 50 developer-days. The largest parity risks are exact counts as hard rules, arbitrary succession patterns with history, and hard rules that must become graded penalties.
4. **The blocker is proof.** Local search never proves optimality or infeasibility. Our "why no roster" flow, and the whole plan in 00 §4.2, rest on a CP-SAT INFEASIBLE proof. So CP-SAT must stay. Timefold can only be a second solver, never a replacement.
5. **Host.** Timefold wants "one CPU core per active Solver, plus at least one for the operating system". Our host has 2 shared cores and 3.6 GB. A JVM solver adds an estimated 0.7 to 1.0 GB per running instance.
6. **Recommendation: do not adopt.** Keep CP-SAT. Borrow 4 small Timefold ideas (section 11). Revisit only on the triggers in the Recommendation.

## 1. Licence

- The repo licence file starts: "Apache License", "Version 2.0, January 2004" ([LICENSE.txt][s-lic]).
- The published POMs say the same. The 2.7.0 service POM lists "The Apache Software License, Version 2.0" ([service POM][mvn-svc]).
- Enterprise is a separate product. "Unlike _Timefold Solver Community Edition_, this commercial edition is not open-source" ([commercial editions][d-ce]).
- Since 2.0, "the Enterprise binaries are now protected by a license check" ([v2.0.0 release][gh-200]). The Enterprise artifacts are on Maven Central under `ai.timefold.solver.enterprise` ([Maven Central listing][mvn-ent]).
- No prices are public. The pricing page shows "Get in touch" for Enterprise ([pricing][p-pr]).
- Our core is AGPL-3.0 (`core/nurse_scheduling/preference_types.py:7-10` on origin/develop: "GNU Affero General Public License"). Apache-2.0 is compatible with that. Enterprise terms against AGPL: Unconfirmed (no Timefold page covers it).

## 2. Versions and editions

### 2.1 Current release line

| Version | Date | Note | Source |
|---|---|---|---|
| 2.7.0 | 2026-09-24 | "Latest". Maven `release` = 2.7.0 | [releases][gh-rel], [Maven metadata][mvn-core] |
| 2.0.0 | 2026-04-22 | "The solver now requires Java 21 (or later) to run." | [v2.0.0][gh-200] |
| 1.34.0 | 2026-08-03 | "Only 2 more of these are planned before Timefold Solver 1.x EOL in early 2027." | [v1.34.0][gh-1340] |

The 2.0.0 notes also say that Timefold will "move explainability features incl. score analysis to the Enterprise Edition" ([v2.0.0][gh-200]). So a new adopter starts on 2.x, where explanations are paid.

### 2.2 Community vs Enterprise

The Enterprise page lists these rows, each checked for Enterprise only: "Score Analysis", "Recommendation API", "Performance improvements", "Nearby selection", "Multithreaded solving", "Partitioned search", "Constraint profiling", "Multistage moves", "Throttling best solution events" ([commercial editions][d-ce]).

| Feature | Edition | Source (quote) |
|---|---|---|
| Constraint Streams, `groupBy`, `ifExists`, collectors | Community | Pricing lists "Constraint streams API" under Community ([pricing][p-pr]) |
| Construction heuristics and local search | Community | "Construction & local search heuristics" ([pricing][p-pr]) |
| Pinning and real-time planning | Community | "Real-time planning & pinning" ([pricing][p-pr]) |
| `SolverManager` and benchmarker | Community | "Solver manager & benchmarker" ([pricing][p-pr]) |
| Quarkus and Spring Boot integration | Community | "Quarkus & Spring Boot support" ([pricing][p-pr]) |
| `ConstraintVerifier` unit tests | Community | 2.x: "`timefold-solver-test` dependency removed (testing APIs merged into core)" ([upgrade guide][d-up]) |
| `ScoreAnalysis`, explainability | **Enterprise** | "Explainability", "Score Analysis" ([pricing][p-pr]) |
| Recommendation API | **Enterprise** | "Recommendation API" ([commercial editions][d-ce]) |
| Multithreaded incremental solving | **Enterprise** | "This feature is exclusive to Timefold Solver Enterprise Edition." ([multithreaded solving][d-mt]) |
| Partitioned search | **Enterprise** | Same sentence, same page ([multithreaded solving][d-mt]) |
| Nearby selection, constraint profiling | **Enterprise** | Rows in the Enterprise table ([commercial editions][d-ce]) |
| "As a service" module (REST) | Community, **Preview** | POM name "(Preview) Timefold Solver Service dependencies", Apache licence ([service POM][mvn-svc]) |
| Service endpoint `GET /<root>/{id}/score-analysis` | **Enterprise** (inferred) | The endpoint is listed ([service overview][d-svc]). It returns `ScoreAnalysis`, which is Enterprise. I did not run it |
| Timefold Platform (hosted models, for example Employee Shift Scheduling) | Commercial SaaS | Spark / Flow / Horizon tiers, no prices ([pricing][p-pr]) |
| Deploy a custom model to the Platform | Commercial, preview | "currently only available to a limited set of partners" ([platform preview note][d-plat]) |

## 3. Runtime

- **JDK.** "Timefold Solver 2.x requires Java 21 or later to run, whereas Timefold Solver 1.x supported Java 17 and later" ([upgrade guide][d-up]). The FAQ says "It is therefore recommended using the latest available JDK" ([FAQ][d-faq]).
- **Frameworks.** The FAQ support table lists 2.x with Java 21, Quarkus 3.x and Spring Boot 4.x ([FAQ][d-faq]). The quickstart overview offers a service mode on Quarkus, or a library in plain Java, Quarkus or Spring Boot ([quickstart overview][d-qs]).
- **Native image.** Community supports it, tested "with Quarkus and Spring Boot plugins to create native executables" ([FAQ][d-faq]). The same answer warns: "these benefits are often overshadowed by slower solving speeds due to lack of JIT optimizations".
- **Native image numbers.** The Timefold blog measured start-up of "0.07 seconds" native against "1.216 seconds" on the JVM. It also says "Timefold Solver ran about 42% slower compared to a JVM run" ([native image blog][b-native], April 2024). For a fixed 15 s budget, native trades a 1 s start for about 40% less search. That is a bad trade for us.

## 4. Memory and CPU on our host

Published guidance ([FAQ][d-faq]):

- RAM: "Provision plenty, but no need to provide more."
- Heap: "around 300 to 500MB above the dataset size, regardless of the problem scale".
- CPU: "One CPU core per active Solver, plus at least one for the operating system."
- Shared hosts: "Avoid a cloud environment in which you share your CPU core(s) with other virtual machines or containers."
- GC: "ParallelGC can be potentially between 5% and 35% faster than G1GC (the default)."
- JIT: without the C2 compiler, hot code runs "typically 10x–50x slower than fully JIT-compiled code".

Our host: 2 cores, 3.6 GB, shared by prod, dev and builds. Default solve time is 15 s.

**Estimates (not measured):**

| Item | Estimate | Basis |
|---|---|---|
| Dataset in heap, 87 nurses x 28 days | under 50 MB | About 2,400 person-day entities plus rule facts |
| Heap (`-Xmx`) | 512 to 768 MB | FAQ rule: dataset + 300 to 500 MB |
| JVM resident memory per solver service | 0.7 to 1.0 GB | Heap + metaspace + code cache + threads. Estimate |
| Two services (prod + dev) | 1.4 to 2.0 GB | Both live on the same 3.6 GB host |
| JVM start-up | about 1 to 2 s | Blog JVM start 1.2 s on a Spring Boot app |
| JIT warm-up | first seconds of each solve in a fresh JVM | Tiered compilation. Timefold publishes no number. A long-lived service avoids repeat cost |
| Parallel solves | 1 at a time | FAQ core rule on 2 cores |

Consequences:

- A long-lived JVM keeps JIT warm but holds 0.7 to 1.0 GB all day. A per-job JVM frees memory but pays start-up and warm-up inside the 15 s budget.
- CP-SAT runs 2 workers today (`solver_ortools_cp_sat.py:42-43` on origin/develop: `extra_subsolvers.append("max_lp_sym")`, see [04][int-04]). Community Timefold runs 1 search thread. Multithreaded solving needs Enterprise, and with 2 shared cores it adds little.
- Builds already compete for the same 2 cores. The FAQ warns that shared CPU makes "Performance (and therefore solution quality)" unreliable ([FAQ][d-faq]).

## 5. Python support

- "As of today, Timefold is halting active development on the Beta version of our Python Solver." Posted 11 July 2025 ([discussion #1698][gh-1698]).
- Reasons: "The Python Solver did not meet our quality standards" and matching Java "is substantial" work (same post).
- "Timefold will not release new features or bug fixes for the Python Solver" (same post).
- v1.25.0 "no longer includes Python support" ([v1.25.0][gh-1250]). The last PyPI build is `timefold 1.24.0b0` ([solver alternatives 02][int-alt02]).

For us: there is no supported way to call Timefold in-process from `core/`. The constraints must be written in Java or Kotlin. Our Python core then becomes a front end that compiles the YAML and calls a JVM.

## 6. Integration options

| Option | How | Edition | Notes |
|---|---|---|---|
| A. JVM sidecar with the Timefold service module | Python worker posts the compiled problem as JSON. `POST /<root>`, poll `GET /<root>/{id}`, stop with `DELETE /<root>/{id}` ([service overview][d-svc]) | Community, **Preview** | Preview pages describe functions that can be "changed or even removed in a future release" ([service preview note][d-svc-prev]). Least plumbing, most churn risk |
| B. JVM sidecar, own REST on Quarkus with `SolverManager` | Same flow, our own endpoints | Community | Stable APIs. The Spring Boot guide warns that solving on REST threads causes HTTP time-outs, so `SolverManager` runs solves on a pool ([quickstart overview][d-qs]) |
| C. CLI per job | Python worker runs `java -jar solver.jar in.json out.json` | Community | No idle memory. Pays JVM start and warm-up on every job |
| D. Timefold Platform model | Hosted Employee Shift Scheduling API | Commercial SaaS | Our rule model is not theirs. Data leaves our servers. Price unknown |

What the JVM reads:

- Do not port the YAML compiler. `models.py` on origin/develop is 1,283 lines of selector expansion and validation. The Pydantic compiler is the "Input parsing and selector expansion" authority (`preference_types.py:29-30`).
- Python sends the compiled, integer-indexed problem (`Compiled*` dataclasses in `models.py:562-705`) as JSON. Java sees only indices, weights and patterns.
- The canonical YAML (`server/canonical.py`) stays the stored input. The JSON is an internal wire format.

Keep CP-SAT as the fallback and the proof engine. Section 8 shows why this is not optional.

## 7. Porting our rule types to Constraint Streams

### 7.1 Planning model

Two shapes exist:

- **Slot model** (the quickstart). One `Shift` entity per seat, with `@PlanningVariable private Employee employee` ([Shift.java][q-shift]). Coverage is then fixed by the number of slots.
- **Person-day model.** One entity per (nurse, day), the variable is the day-state (a shift type or OFF). This matches our core. We have "exactly one day-state per person per day" (`scheduler.py:356-362`: `offs + dp_shifts_sum + leaves == 1`).

The person-day model is the better fit. Our requirements use ranges (`requiredNumPeople` to `preferredNumPeople`), aggregate groups and coefficients. A slot model cannot express these without optional slots. LEAVE becomes a pinned value (`@PlanningPin`, Community, see [02][int-02]). History becomes pinned entities before day 0.

### 7.2 Our semantics that the port must copy

- Weights are integers or ±inf. "Float weights can only be positive infinity or negative infinity." (`models.py:47-50`)
- `+inf` means the term must equal 1, `-inf` means it must equal 0: `if weight == math.inf: ctx.solver.add_constraint(expression == 1)` (`utils.py`, `add_objective`).
- Finite weights add to one objective that is maximised: `ctx.solver.set_objective(ctx.objective, maximize=True)` (`scheduler.py:412`). Positive weights reward, negative weights penalise.
- Exact vs preferred staffing: `if preference.preferredNumPeople is not None: ... actual_n_people >= required` else `actual_n_people == required` (`preference_types.py:121-124`). Over-staffing an exact rule is a hard break.
- A requirement with a `+inf` weight and a preferred count forces `diff == 1` through `add_objective` (`preference_types.py:147-151`). This is an odd corner. A port must copy it or reject it at compile time.
- Skill mix is a hard floor. With nobody eligible, the core adds an empty OR, "an empty OR is always false -> INFEASIBLE" (`preference_types.py:131-137`).
- LEAVE is a hard pin at any weight (`preference_types.py:206-211`). Leave exists only where pinned (`scheduler.py:401-409`). A hard OFF also accepts a leave day (`preference_types.py:194-197`).
- Successions match a pattern at every start date. History prefixes add suffix patterns at day 0 (`preference_types.py:268-277`). A `-inf` pattern that history already completed binds nothing (`preference_types.py:283-288`).
- Shift counts: `|x - T|^2` becomes an abs var and a squared var (`preference_types.py:373-399`). The 5 linear forms become a 0/1 indicator times the weight (`preference_types.py:401-417`).
- Covering is always hard. The handler never reads `weight` (`preference_types.py:500-555`), although the model has a `weight` field (`models.py:517`).

### 7.3 Per-rule table

Effort is developer-days for one developer who knows Java and Constraint Streams. It includes `ConstraintVerifier` tests per rule. All numbers are estimates.

| Rule type | Constraint Streams approach | Effort (days) | Parity risk |
|---|---|---|---|
| Domain, JSON wire format, pinned LEAVE and history | Person-day entity, day-state value range, `@PlanningPin` for leave and history days | 3 to 4 | Medium. History as pinned days changes which patterns count at the boundary |
| Shift type requirements (exact, preferred, coefficients, aggregate groups, `qualifiedPeople`) | Iterate a `Requirement(date, group)` fact, join assigned person-days, `groupBy` a weighted sum. Hard penalty by distance from the range. Soft `weight * (preferred - actual)` | 4 to 5 | **High.** A group with zero staff produces no group, so the stream must start from the requirement fact or use `complement` ([score calculation][d-sc]). Exact `==` must become a graded hard penalty |
| Skill mix | Same requirement stream, filtered sum over named people, hard floor | 1 | Medium. The empty-OR INFEASIBLE case becomes a hard break that local search cannot prove |
| Date overrides (`requiredNumPeopleOverrides`) | Resolve in the compiled JSON. The fact carries the date's count | 0.5 | Low |
| Shift requests (OFF, LEAVE, "work any shift", ±inf) | `forEach(PersonDay)` filter by request fact, `reward` or `penalize` by weight. ±inf as hard | 1.5 to 2 | Low to Medium. The OFF-plus-leave rule under `+inf` must be copied |
| Shift type successions (patterns, history, ±inf) | Patterns of length up to 4 with joins. Longer patterns need tuple mapping, because "Timefold Solver currently does not support constraint stream cardinalities higher than 4" ([score calculation][d-sc]). Or a custom collector over each nurse's sorted days | 5 to 7 | **High.** `toConsecutiveSequences` fits runs of one kind ("maximum consecutive working days", [score calculation][d-sc]), not mixed patterns such as N,N,OFF. `+inf` means "match at every start", which is rare and easy to get wrong |
| Shift counts, linear (`x >= T` and 4 others), contracted hours ranges | `forEach(PersonDay)` `groupBy(person, sum(coefficient))`, plus `complement` for nurses with zero ([score calculation][d-sc]). Indicator times weight | 2 | Medium. Strict `>`, `<` and the per-pair indicator must match exactly |
| Shift counts, squared `\|x - T\|^2` | Same group, `penalize` with match weight `(x - T)^2` | 1 to 2 | Medium. Not `loadBalance`, which measures unfairness between nurses, not distance to a target ([load balancing][d-lb]) |
| Shift affinities | `forEach(AffinityKey(date, p1s, p2s, ss))` `ifExists` a p1s person-day in ss, `ifExists` a p2s person-day in ss, then reward or penalise | 2 | Medium. Nested-group cross products must match `preference_types.py:457-497` |
| Shift type coverings (supervision) | `forEach(preceptee person-day in ss)` `ifNotExists(preceptor person-day on same date in ss)`, hard penalty | 1.5 | Low to Medium |
| Weights and score type | One hard level, one soft level. 2.x "Long score variants were folded into their base score types" ([01][int-01] §5), so weights near 1e12 fit | 1 | Medium. Timefold calls big weights in place of levels "score folding" and says it "is broken" ([02][int-02] §1). Our tier ladder does exactly that |
| Solver settings and tuning | Construction heuristic, then local search with change, swap and pillar moves. Termination at 15 s | 3 to 5 | **High.** Quality on `large87` is unknown until measured |
| Service, Docker image, CI, health, metrics | Quarkus app, one image, one CI job | 3 to 4 | Low |
| Parity test set | Solve the 88 test YAMLs under `core/tests/testcases/` and the 3 bench dumps. Score every Timefold roster with the CP-SAT fixed-roster scorer ([00][int-00] §4.4). Compare with the CP-SAT objective | 5 to 7 | Needed to find the risks above |
| Python runner integration | Route jobs, map progress to SSE, map cancel to `DELETE`, map statuses | 3 to 4 | Medium. See section 8 for statuses |

Total: about **33 to 50 developer-days**, midpoint about 41. Every future rule change then costs two implementations.

### 7.4 Hard rules become penalties

CP-SAT enforces a hard rule exactly. Timefold only scores it. Local search needs a slope. Timefold warns about a "score trap". A trapped constraint "uses the same weight for different constraint matches" ([performance][d-perf]). So each ±inf rule needs a distance-based hard penalty. That is new design work per rule, and it changes nothing in CP-SAT.

## 8. Proof of optimality and infeasibility

What Timefold says:

- "Finding the optimal solution cannot be relied on". The reason: "a metaheuristic algorithm is generally unaware of the optimal solution" ([algorithms overview][d-algo]).
- Exhaustive search "will always find the global optimum and recognize it too". The same page says it fails to scale beyond toy data sets ([exhaustive search][d-exh]).
- Feasibility needs "all hard levels" to be "at least zero" ([score overview][d-so]).
- A construction heuristic builds "a pretty good initial solution", but not always a feasible one ([construction heuristics][d-ch]).

So a Timefold result with a negative hard score means "not found in the time", never "impossible".

What our product does today:

- The runner turns CP-SAT INFEASIBLE into `termination_reason="infeasibility_proven"` (`server/jobs/runner.py:124-131`).
- It keeps "no proof" separate. The comment warns against "infeasibility evidence the solver never produced" (`runner.py:136-141`).
- The web "why no roster" search submits up to `MAX_DIAGNOSTIC_CANDIDATES = 5` changed copies (`web/lib/ai/diagnostic/search-record.ts:34`). It stops on `"first_feasible"` or `"exhausted"` (same file). For an honest "exhausted", each failed copy must be a proof.
- The combined plan adds cores and correction sets from CP-SAT assumptions ([00][int-00] §4.2, [03][int-03]).

Impact of Timefold:

| Case | CP-SAT today | Timefold Community |
|---|---|---|
| Feasible roster found | Witness, plus OPTIMAL or a gap | Witness, no bound, no gap |
| Ward is truly infeasible | INFEASIBLE proof, then core and remedies | Best roster with hard < 0. Same result as a hard ward that needs more time |
| Diagnostic copy fails | Proven infeasible, so the candidate is ruled out | Unknown, so the candidate stays open |
| Explain the clash | Assumption core (planned) | Only per-constraint breaks, and `ScoreAnalysis` is Enterprise in 2.x |

Timefold has one real plus. It always returns a full roster, even a broken one. Today `large87` at 1 worker finds no roster in 15 s ([00][int-00] §2). But the relaxed backup roster in [02][int-02] and [00][int-00] §4.3 gives the same benefit on CP-SAT, with a proof path kept.

## 9. Determinism, testing and operations

### 9.1 Determinism

- Default mode `PHASE_ASSERT` is reproducible. "All modes other than `NON_REPRODUCIBLE` are reproducible." ([solver diagnostics][d-diag])
- 2.x removed the name `REPRODUCIBLE`. "Use `EnvironmentMode.STEP_ASSERT` and `EnvironmentMode.NO_ASSERT` respectively." ([upgrade guide][d-up]). This corrects [solver alternatives 02][int-alt02], which read it as a loss of the feature.
- A time limit breaks it. Time-based termination "will most likely sacrifice perfect reproducibility (even with `environmentMode` `NO_ASSERT`)" ([algorithms overview][d-algo]). Our 15 s limit is time-based. Repeatable runs need a step-count limit, which gives a different roster quality per machine.
- `randomSeed` sets the seed of the single `RandomGenerator` ([solver diagnostics][d-diag]).
- Multithreading (Enterprise): "Multi-threaded solving is _still reproducible_, as long as the resolved `moveThreadCount` is stable." ([multithreaded solving][d-mt])
- Today, CP-SAT deterministic mode sets `random_seed = 0` and `num_workers = 1` (`solver_ortools_cp_sat.py:106-107`). So neither solver gives repeatable results at our production settings.

### 9.2 Testing

- `ConstraintVerifier` is in Community core in 2.x (section 2.2). The docs name it "the Constraint Verifier" for unit tests of constraint streams ([score calculation][d-sc]).
- It checks one constraint with `verifyThat(...).given(...).penalizesBy(...)`, or the whole provider with `.scores(...)` (same page).
- Our current tests are end-to-end: 88 YAML cases with expected rosters under `core/tests/testcases/`. A Timefold roster can differ from the CP-SAT roster at equal score. So parity must compare scores, not rosters.

### 9.3 Operations cost

| Item | Added cost |
|---|---|
| Second runtime | JDK 21 in the image, Maven or Gradle in CI, Java dependency updates |
| Image size | Estimate 250 to 350 MB extra (JRE plus Quarkus app). Not measured |
| Memory | 0.7 to 1.0 GB per running JVM (section 4) |
| CI | A Java build and test job, plus the parity job on every rule change |
| Monitoring | JVM heap, GC and solver logs next to our Python logs |
| Upstream sync | Our core tracks "j3soon/nurse-scheduling feature/genie" (`core/upstream-patches/manifest.toml`). Upstream rule changes land in Python only. Each one needs a Java port |
| People | The team then owns Java and Python solver code |

## 10. Total effort and risk

| Block | Days (estimate) |
|---|---|
| Rule port and domain (section 7.3, rows 1 to 11) | 22 to 32 |
| Service, image, CI | 3 to 4 |
| Parity test set | 5 to 7 |
| Runner integration | 3 to 4 |
| **Total** | **33 to 47, round to 33 to 50 with slack** |

Risks, highest first:

1. **No proof** (section 8). This cannot be fixed. It forces two solvers.
2. **Unknown quality** on large wards with 1 thread on 2 shared cores. Nothing is measured.
3. **Parity drift.** Exact counts, successions with history and graded hard penalties.
4. **Explainability** is Enterprise in 2.x. Our own ledger ([01][int-01]) must then read Timefold rosters through the CP-SAT scorer.
5. **Memory** on a 3.6 GB host shared with builds.
6. **Preview APIs** in the service module (option A).

## 11. Other Timefold ideas we can borrow

Only items not covered by [00][int-00] to [04][int-04]. Pinning, real-time planning, overconstrained planning, recommendations, score analysis, justifications and the diff are already covered there.

| Idea | Timefold source (quote) | Edition | Our move on CP-SAT | Effort |
|---|---|---|---|---|
| Per-rule unit tests | `verifyThat(...).given(...).penalizesBy(...)` with "the Constraint Verifier" ([score calculation][d-sc]) | Community | A pytest helper: one rule, a tiny fixed roster, assert the ledger terms for that rule. Uses the scorer of [00][int-00] §4.4 and the ledger of [01][int-01]. Runtime test, no source parsing | S |
| Stop on diminishing returns | The diminished returns termination works on "the relative rate of improvement" ([algorithms overview][d-algo]). `unimprovedSpentLimit` stops after a quiet period. For each new best, "the timer basically resets" (same page) | Community | In the solution callback, record the time of the last better objective. Stop the search after N s with no gain. Add CP-SAT `relative_gap_limit`, where "if the gap is reached, the search status will be OPTIMAL" ([sat_parameters.proto v9.15][o-proto]). Frees the 2 shared cores early. Server-side only, per [00][int-00] §4.5. Gate it on the [04][int-04] corpus | S |
| Fairness without a target | `ConstraintCollectors.loadBalance(...)`. "A lower value indicates a fairer solution." ([load balancing][d-lb]) | Community | A new "balance" count form: minimise the sum of squared per-nurse counts. With a fixed total this is the variance, so no `T` is needed. New rule form, so a v2-only core patch and a product decision | M |
| Runs as first-class matches | `toConsecutiveSequences` for "maximum consecutive working days" ([score calculation][d-sc]) | Community | Keep our pattern encoding. Report a run (nurse, start, end, length) as one ledger match, not N pattern hits. Clearer text for the assistant | S |

## Unconfirmed

- JVM memory, start-up and warm-up on our 2-core host. All numbers in section 4 are estimates. I read the FAQ and the native image blog only.
- Timefold roster quality on `large87` at 15 s with 1 thread. No published nurse benchmark against CP-SAT. I searched the docs and [03 evidence][int-alt03].
- Whether the service `score-analysis` endpoint works without Enterprise. I read the service overview and REST pages. Neither names an edition.
- Enterprise licence terms with an AGPL product. I read the commercial editions and pricing pages.
- Image size for a JDK 21 plus Quarkus service. Not built.
- Effort numbers. They assume one developer fluent in Java and Constraint Streams. No spike ran.

## Recommendation

1. **Do not adopt Timefold Solver as our solver.** Keep OR-Tools CP-SAT 9.15.
   - It cannot prove infeasibility, and our "why no roster" flow depends on that proof.
   - It needs a second runtime, a 33 to 50 day Java port and a permanent double implementation.
   - Its explanation features are Enterprise in 2.x.
   - Our 2-core, 3.6 GB shared host matches the setup the Timefold FAQ warns against.
2. **Get the one real benefit on CP-SAT.** Timefold always returns a roster. The relaxed backup roster in [00][int-00] §4.3 (P3) gives the same result with a proof path kept.
3. **Borrow the 4 ideas in section 11.** Start with per-rule tests and the diminishing-returns stop (both S).
4. **Revisit on one of these triggers:**
   - After P3, a real ward still gets no roster in its budget on CP-SAT.
   - The host grows to 4 or more dedicated cores and 8 GB or more.
   - The team takes on Java ownership for other reasons.
5. **If a trigger fires,** run a throwaway spike of 3 to 5 days first. Port requirements, requests and one succession rule. Solve `large87` for 15 s on 2 pinned cores. Score the result with the CP-SAT scorer. Adopt Timefold only on a clear win over CP-SAT plus the relaxed roster.

[int-00]: ./00-plan.md
[int-01]: ./01-score-analysis-explainability.md
[int-02]: ./02-overconstrained-never-infeasible.md
[int-03]: ./03-cpsat-infeasibility-explanation.md
[int-04]: ./04-cpsat-autotune.md
[int-alt02]: ../../research/2026-09-28-solver-alternatives/02-solver-alternatives.md
[int-alt03]: ../../research/2026-09-28-solver-alternatives/03-nurse-rostering-evidence.md
[s-lic]: https://github.com/TimefoldAI/timefold-solver/blob/main/LICENSE.txt
[gh-rel]: https://github.com/TimefoldAI/timefold-solver/releases
[gh-200]: https://github.com/TimefoldAI/timefold-solver/releases/tag/v2.0.0
[gh-1340]: https://github.com/TimefoldAI/timefold-solver/releases/tag/v1.34.0
[gh-1250]: https://github.com/TimefoldAI/timefold-solver/releases/tag/v1.25.0
[gh-1698]: https://github.com/TimefoldAI/timefold-solver/discussions/1698
[mvn-core]: https://repo1.maven.org/maven2/ai/timefold/solver/timefold-solver-core/maven-metadata.xml
[mvn-svc]: https://repo1.maven.org/maven2/ai/timefold/solver/timefold-solver-service/2.7.0/timefold-solver-service-2.7.0.pom
[mvn-ent]: https://repo1.maven.org/maven2/ai/timefold/solver/enterprise/
[d-ce]: https://docs.timefold.ai/timefold-solver/latest/commercial-editions/commercial-editions
[p-pr]: https://timefold.ai/pricing
[d-up]: https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1
[d-faq]: https://docs.timefold.ai/timefold-solver/latest/frequently-asked-questions
[d-qs]: https://docs.timefold.ai/timefold-solver/latest/quickstart/overview
[d-mt]: https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/multithreaded-solving
[d-diag]: https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/solver-diagnostics
[d-algo]: https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/overview
[d-exh]: https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/exhaustive-search
[d-ch]: https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/construction-heuristics
[d-sc]: https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/score-calculation
[d-so]: https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/overview
[d-lb]: https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/load-balancing-and-fairness
[d-perf]: https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/performance
[d-svc]: https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/service/overview
[d-svc-prev]: https://github.com/TimefoldAI/timefold-solver/blob/main/docs/src/modules/ROOT/pages/running-timefold-solver/service/_preview-note.adoc
[d-plat]: https://github.com/TimefoldAI/timefold-solver/blob/main/docs/src/modules/ROOT/pages/deploying-to-platform/_preview-note.adoc
[b-native]: https://timefold.ai/blog/how-to-speed-up-timefold-solver-startup-time-by-20x-with-native-images
[q-shift]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/java/org/acme/employeescheduling/domain/Shift.java
[o-proto]: https://github.com/google/or-tools/blob/v9.15/ortools/sat/sat_parameters.proto#L362-L379
