# Timefold tricks, part 6: what else to borrow, and Timefold as our solver

Date: 2026-09-30. Scope E of the Timefold tricks research. Timefold docs were read as AsciiDoc source from `TimefoldAI/timefold-solver` `main` (2.7.0, released 2026-09-24) and on docs.timefold.ai. The quickstart is `TimefoldAI/timefold-quickstarts` branch `stable` (solver 2.7.0). OR-Tools sources are pinned to tag `v9.15`. Our code line numbers are from `core/nurse_scheduling/`. Items marked [UNCONFIRMED] name where we looked.

Builds on, and does not repeat: the [plan][int-plan], reports [01][int-01] (score analysis), [02][int-02] (overconstrained, pinning, windows, recommend), [03][int-03] (cores, hinted re-solve), [04][int-04] (tuning), [07][int-07] (Timefold Community as our solver), and solver alternatives [02][int-alt02] and [03][int-alt03].

## Answer

1. **Keep CP-SAT. Do not adopt Timefold Solver.** I agree with report [07][int-07]. Community Edition is Apache 2.0, but it is Java or Kotlin only, and the Python beta is frozen since July 2025. It needs a JVM service on a shared 2-core, 3.6 GB server and a port of 7 rule types. It loses our infeasibility proofs and optimality bounds. Section 10 adds only new evidence and two disagreements with 07.
2. **The best new borrow is a custom LNS loop** (Timefold's ruin-and-recreate move on CP-SAT). On the 87-person ward, at 2 workers and 15 s, it beat plain CP-SAT on all 3 seeds. With small neighbourhoods it reached the objective that plain CP-SAT reaches only with 8 workers or 60 s. On small wards it is worse, because it cannot prove optimality. So it must be size-gated.
3. **Four borrows need no core change.** Pinning a cell is a hard shift request (weight `+inf`). "Minimise changes" is a soft shift request on the previous roster. Fairness across the ward is our squared shift count with the target set to the ward mean. A benchmarker already exists as scripts in `/tmp/wave/bench/`.
4. Timefold's `loadBalance` unfairness is `sqrt(sum of (x_i - mean)^2)`. I confirmed it from the source. Our squared shift count ranks rosters the same way when the target equals the mean. The only real gap is carry-in load from earlier months.
5. Recommended Fit was Community in 1.x and is Enterprise in 2.x. Our plan already covers it (plan §4.4). Nearby selection, multithreaded solving and partitioned search are Enterprise. CP-SAT already has its own portfolio, so we skip them.

## 1. Our rule model, as the code builds it

This is the baseline for every comparison below.

| Rule type | Hard or soft | Code |
|---|---|---|
| Shift type requirements | Required count is hard (`== required`, or `>= required` when a preferred count exists). Preferred count is soft, weight on `preferred - actual`. Skill mix is a hard floor. Date overrides replace the required count. | `preference_types.py:48-152`, hard at `:122`, `:124`, soft at `:151` |
| Shift requests | Soft, weight times the cell. OFF uses the `offs` variable. LEAVE is always hard (`leaves == 1`). | `preference_types.py:166-222`, LEAVE at `:205` |
| Shift type successions | Soft or hard (`+inf` / `-inf`). Patterns can start in history. | `preference_types.py:225-329`, history at `:266`, hard at `:293` |
| Shift counts | Linear comparisons (`x >= T` and others) as a soft Boolean, or `|x - T|^2` as a squared deviation. Contracted hours use a hard range. | `preference_types.py:332-410`, squared at `:364-387` |
| Shift affinities | Soft, one Boolean per date and group pair. | `preference_types.py:413-488` |
| Shift type coverings | Always hard: a preceptee on a shift needs a preceptor. | `preference_types.py:491-546`, at `:543` |
| Weights | `+inf` / `-inf` become constraints. A finite weight goes into one objective, maximised. | `utils.py:35-49`, `scheduler.py:412` |
| Solve | `max_time_in_seconds` from the request. Deterministic mode sets 1 worker. No hints. `forced_solution` fixes every cell. `avoid_solution` forbids one roster. | `solver_ortools_cp_sat.py:107`, `:115`, `scheduler.py:300`, `:325` |
| History | `person.history`, used only by successions. | `models.py:62` |

Shift counts do not read history. So no rule carries a load from last month into this month.

## 2. Q1a. Construction heuristics, local search, and speeding up CP-SAT

### 2.1 What Timefold does

- A construction heuristic "builds a pretty good initial solution in a finite length of time". It "isn't always feasible" ([construction heuristics][d-ch]). First Fit "never changes a planning entity after it has been assigned". First Fit Decreasing places "more difficult" entities first (same page).
- Local search "starts from an initial solution and evolves that single solution" and "needs to start from an initialized solution" ([local search][d-ls]). Acceptors give Hill Climbing, Tabu Search, Simulated Annealing, Late Acceptance, Great Deluge, Step Counting and Variable Neighborhood Descent ([algorithms overview][d-ov]).
- The default is "a Construction Heuristic phase followed by a Local Search phase". The advice is First Fit Decreasing, then Late Acceptance, then the benchmarker (same page).
- Moves: change, swap, pillar change, pillar swap, sub-pillar moves ([neighborhoods][d-nb]). A pillar is "the group of entities that currently share the same value" (same page).
- Ruin and recreate: it "selects a subset of entities and sets their values to null", then "runs a construction heuristic to assign them again". It helps "to escape from a local optimum". Defaults are 5 to 20 ruined entities. It is "not enabled by default" ([move selector reference][d-msr]). No Enterprise tag, so Community.
- Nearby selection is Enterprise ([move selector reference][d-msr], `_only-enterprise` include). Multistage moves, "useful for creating specialized ruin-and-recreate moves", are Enterprise too ([multistage moves][d-msm]).
- Timefold's old nurse rostering example (INRC-I data, branch `0.8.x`) used `WEAKEST_FIT`, then Tabu Search with `entityTabuSize` 7 and `acceptedCountLimit` 800. Its moves were change, swap, pillar change and pillar swap over day sequences ([nurseRosteringSolverConfig.xml][s-nrcfg]). The example is gone from 1.x and 2.x ([0.8.x docs][d-nr08]).
- The INRC-II literature uses the same idea. Ceschia and Schaerf use neighbourhoods that change "the assignments of a nurse ... for multiple consecutive days" or swap two nurses. They report results close "to the level of the best available ones" ([PATAT 2018][l-cs]).

### 2.2 What CP-SAT already has

- CP-SAT runs its own local search. Feasibility jump is on by default (`use_feasibility_jump`, [sat_parameters.proto L1292][o-sp]). Violation local search workers exist (`num_violation_ls`, L1337).
- CP-SAT runs LNS by default (`use_lns`, L1483). The neighbourhoods are generic: `rins/rens`, `rnd_var_lns`, `rnd_cst_lns`, `graph_var_lns`, `graph_arc_lns`, `graph_cst_lns`, `graph_dec_lns` ([cp_model_solver.cc L1879-L1935][o-cms]). The CP-SAT primer says CP-SAT "has no way of knowing the structure of your problem" ([primer LNS][pr-lns]).
- Hints. "There is also no guarantee that the solver will use this hint" ([cp_model.proto L656-L667][o-cmp]). `repair_hint` "tries to repair the solution given in the hint" until `hint_conflict_limit` (default 10). `fix_variables_to_their_hinted_value` fixes hinted variables ([sat_parameters.proto L1196-L1207][o-sp]). Report [03 §6][int-03] found that a hint alone moved 97 to 570 cells.
- LNS knobs: `lns_initial_difficulty` (0.5), `solution_pool_size` (3), `ignore_subsolvers` and `filter_subsolvers` "work on LNS or LS names" ([sat_parameters.proto L742-L758, L1476-L1497][o-sp]).

### 2.3 Local test: a custom LNS loop on our models

I ran this for this report. Script: `/tmp/wave/timefold/lns/exp.py`. Raw lines: `/tmp/wave/timefold/lns/results.jsonl`. Models: the production-built dumps from `/tmp/wave/bench/` (see [04][int-04]). OR-Tools 9.15.6755, `taskset -c 0,1`, `num_workers = 2`, `extra_subsolvers = ["max_lp_sym"]` (shipped), 15 s total, seeds 1 to 3.

The loop is ruin and recreate on CP-SAT:

1. Solve until the first solution (`stop_after_first_solution`).
2. Pick a neighbourhood at random: all cells in W consecutive days, or all days of P% of nurses.
3. Fix every other `shift`, `off` and `leave` cell to the incumbent by domain. Hint the incumbent. Solve for at most L seconds.
4. Keep the result if the objective is better. Repeat until 15 s.

Objective (maximised). Bound near 4.478e12 on large87.

| Model | Seed | Plain CP-SAT, 15 s | LNS W=7, P=15, L=2 s | LNS W=3, P=6, L=1 s |
|---|---|---|---|---|
| large87 | 1 | -36.5e12 | -17.2e12 | **+2.04e12** |
| large87 | 2 | -13.1e12 | +1.87e12 | **+2.59e12** |
| large87 | 3 | -19.2e12 | -5.75e12 | **-0.57e12** |
| genmed | 1 / 2 / 3 | 449 / 449 / 449, OPTIMAL in 1.4-1.7 s | 449 / 449 / 449, no proof | 449 / 446 / 446, no proof |
| october | 1 | 810, OPTIMAL in 0.9 s | 810, no proof | not run |

For reference, the earlier benchmark got 2.4e12 to 3.1e12 on large87 with 8 workers for 15 s, and 2.1e12 to 2.7e12 with 2 workers for 60 s (`/tmp/wave/bench/RESULTS.md`).

Findings:

- On large87, the small-neighbourhood loop moved 2 of 3 seeds from a large negative objective (heavy-weight rules broken) to a positive one. That is near the 8-worker result, on 2 cores.
- Every large-neighbourhood sub-solve hit its 2 s cap. Smaller neighbourhoods gave more steps (12 to 15) and better results. Neighbourhood size is the key knob, as the primer says: "adjust the size adaptively" ([primer LNS][pr-lns]).
- On small wards the loop loses. It never proves optimality, and 2 of 3 genmed seeds ended at 446, not 449. Plain CP-SAT proves 449 in under 2 s.
- The first solution took about 4.7 s on large87 in these runs. That is a third of the budget.
- Caveats: one large model, 3 seeds, a fast desktop CPU. tc1 is slower. This is a spike, not a gate.

### 2.4 What to borrow

| Idea | Borrow? | How on CP-SAT | Effort | Priority |
|---|---|---|---|---|
| Size-gated LNS loop (ruin and recreate) | Yes | In `ORToolsSolver.solve`: for models above a size gate, run to the first solution, then loop day-window and nurse-group neighbourhoods with fixed domains and a hint. Adapt the window size to the sub-solve result. Keep the progress callback, `should_stop` and finish-now working across iterations. | M | P2 |
| Hint the previous roster on re-solve | Yes, already planned | `add_hint` for every cell ([cp_model.py L1650][o-cpm]). Plan §4.4, phase P5. | S | P1 (in plan) |
| Greedy First Fit start as a hint | No | It needs a second copy of every rule in Python. CP-SAT finds a first solution in 0.04-0.06 s on small wards. Only large87 is slow, and the LNS loop covers it. | M | P3 |
| Tabu, Late Acceptance, Simulated Annealing | No | These are acceptors over single moves. CP-SAT's feasibility jump and LNS cover this role. | L | skip |
| Nearby selection | No (Enterprise) | Day windows and nurse groups are "nearby" by construction. | none | skip |
| Pin generic LNS names | No | `filter_subsolvers` can do it, but report [04][int-04] showed per-model tuning overfits. | S | skip |

## 3. Q1b. Fairness and load balancing

### 3.1 What Timefold computes

- The collector: `ConstraintCollectors.loadBalance(balancedItemFunction, loadFunction, initialLoadFunction)`. The initial load gives "initial state without requiring the entire previous planning windows in the working memory" ([ConstraintCollectors.java L1971-L1997][s-cc]).
- The quickstart counts shifts per employee, adds employees with zero shifts, and penalises `LoadBalance::unfairness` at `ONE_SOFT` ([EmployeeSchedulingConstraintProvider.java L114-L121][q-cp]).
- The formula. `DefaultLoadBalance` keeps the sum and an incremental sum of squares. `unfairness()` returns `sqrt(fractionNumerator / n + integralPart)` with 6 significant digits ([DefaultLoadBalance.java L65-L112][s-dlb]). I replayed the update code in Python on the doc's 7 example schedules. It equals `sqrt(sum of (x_i - mean)^2)` in every case. So unfairness is the square root of n times the variance, which is the L2 distance from a perfectly even load.
- The docs say fairness means "the employee with most tasks has as few tasks as possible" ([load balancing][d-lb]). The metric does not do exactly that. Schedules D (5,5,2,2,1) and E (6,3,3,2,1) both score 3.741657, but the doc ranks D as fairer. I found this by computation. Timefold does not state it.
- The docs recommend `BigDecimal` scores, or multiply by "some power of ten" and round ([load balancing][d-lb]). The paid Employee Shift Scheduling model does the latter: "load-balance unfairness value scaled by 100 and rounded to a long". It adds past work with `employeeToPublishedShiftCount` ([ESS balance shift count][p-essf], commercial).
- Edition: Community. The collector is in the open `core` module and the page has no Enterprise tag.

### 3.2 Our squared shift count against it

- Ours is `weight * (x_p - T)^2` per nurse, with a fixed target T per rule (`preference_types.py:364-387`). The square uses `AddMultiplicationEquality` (`solver_ortools_cp_sat.py:237-239`).
- Identity: `sum (x_p - T)^2 = sum (x_p - mean)^2 + n * (mean - T)^2`. When the total S is fixed (exact staffing), the second term is a constant. So with T equal to the mean, our term ranks rosters exactly like Timefold's (the square root does not change the order).
- The trade-off against other rules differs. Ours grows with the square of the imbalance, Timefold's grows linearly. A square punishes one very unfair nurse more. For a ward, that is a good property.
- Gaps: (1) T is a fixed number that the manager picks, not the ward mean. (2) No carry-in load from earlier months. (3) The mean is often not an integer.

### 3.3 How to model it in CP-SAT

| Form | CP-SAT | Cost |
|---|---|---|
| Variance, exact | Minimise `sum (n * x_p - S)^2`. This is `n^2` times the sum of squared deviations, with integers only. Each term uses `AddMultiplicationEquality` ([cp_model.py L1085][o-cpm]). | Non-linear. Weak LP relaxation. |
| Our current form | `(x_p - T)^2` with `T = round(S / n)`. Off by a constant when S is fixed. | Already built. |
| L1 deviation | `|x_p - T|` with `AddAbsEquality`. Linear, LP-friendly. | Cheaper. Tolerates one outlier more. |
| Minimax | `max_p x_p` with `AddMaxEquality`, optionally minus `min_p x_p`. | Cheapest. Looks only at the extremes. |

**Recommendation.** Keep the squared form. It is built, tested and upstream. Let the web compute T as the ward mean for the counted shifts and emit the existing `|x - T|^2` count. When staffing is exact, S is known before the solve (sum of required counts over the dates). Add history carry-in later as a core option, only if managers ask for fairness across months. Effort S (web only), P2. A native "target = mean" expression is effort M with an upstream patch, P3.

## 4. Q1c. Real-time planning, pinning and windows

Report [02 §2.4][int-02] covers the window stages (history, published, draft) and `@PlanningPin`. This section adds what is new.

- `ProblemChange.doChange(workingSolution, problemChangeDirector)`: every change goes through the director, and `lookUpWorkingObject()` finds the working copy ([real-time planning][d-rtp]). The solver "restarts from the adjusted best solution". Community ("Real-time planning & pinning" is a Community item on the [pricing page][p-pr]).
- 2.x removed `PinningFilter`: "We have removed the long-deprecated the `pinningFilter` field ... and replaced it with ... `@PlanningPin`" ([upgrade guide][d-up]). `@PlanningPinToIndex` pins the head of a list variable ([modeling][d-mpp]). We have no list variables, so it does not apply.
- The old nurse example pinned everything before the planning window with a `PinningFilter`: `return !nurseRoster.getNurseRosterParametrization().isInPlanningWindow(shiftDate)` ([ShiftAssignmentPinningFilter.java][s-nrpin]).
- The paid Employee Shift Scheduling model pins by `"pinned": true` plus the employee on the shift ([ESS manual intervention][p-essm], commercial).

Mapping to us:

| Timefold | Our equivalent | Change |
|---|---|---|
| `@PlanningPin` on one assignment | A shift request with weight `+inf` on that cell. `add_objective` turns it into `cell == 1` (`utils.py:35-49`). For a pinned OFF, request OFF. | Web only. S. P1 |
| Pin a whole published window | The same hard requests for every cell before date X. | Web only. S. P2 |
| History window | `person.history` for successions. Counts do not use it (section 3.2). | Core option. M. P3 |
| `ProblemChange` into a running solver | Not needed. A 15 s solve restarts in full, with a hint (plan P5). CP-SAT has no incremental re-solve ([alternatives 02][int-alt02]). | skip |
| Fixing by domain | Faster than assumptions. The proto says fixing the domain is cheaper ([report 02 §3][int-02]). | Core, only for the LNS loop |

One caution. A hard pin that clashes with a hard rule makes the run INFEASIBLE. The l3m core then names the pin, because each request block is one rule unit ([plan §4.2][int-plan]). That is the right answer: "your lock on Ana's night clashes with her leave".

## 5. Q1d. Schedule stability: minimise changes from the published roster

- Timefold documents two tools. **Pinning** to "completely prevent specific assignments from changing". **Non-disruptive replanning**, where "the gain of changing an assignment must outweigh the disruption cost". Its example penalises `talk.getTimeslot() != talk.getPublishedTimeslot()` with `HardSoftScore.ofSoft(1000)` ([non-disruptive replanning][d-ndr]). This is a pattern, not an API, so it is Community.
- The paid model says "You can use pinning in real-time planning to minimize the disruption" ([ESS manual intervention][p-essm]).
- Report [03 §6][int-03] measured it on CP-SAT. A hint alone moved 97 to 570 of 2100 cells. A penalty of 1 point per changed person-day moved 8 to 10.

New here: **we can build the penalty with rules we already have.** Our objective is maximised. A soft shift request on the previous state of each person-day (the worked shift, or OFF) adds `w` when the cell keeps its old value. Rewarding "same" is the same as penalising "changed", up to a constant. So:

1. The web reads the last published roster.
2. For each nurse and date in the new horizon, it emits one soft request with weight `w_stable` for the old state. LEAVE stays hard as today.
3. `w_stable` sits below the lowest ladder tier, so a change happens only when it wins points elsewhere. This follows the vjbv ladder and the plan's "below tier 5".

Cost: about 2,436 extra Boolean terms for 87 nurses and 28 days. No new variables. No core change, so no upstream patch. The score ledger ([plan §4.1][int-plan]) then reports "stability: 9 changes" per nurse for free. Effort S. P1.

The hint (plan P5) still needs a small core change. It speeds the solve, but the penalty alone gives the stability.

## 6. Q1e. The employee-scheduling quickstart and the paid model

### 6.1 Domain model (quickstart, Community, Apache 2.0)

- `Employee`: `name` (`@PlanningId`), `skills`, `unavailableDates`, `undesiredDates`, `desiredDates` ([Employee.java L10-L16][q-emp]).
- `Shift`: `@PlanningEntity` with `start`, `end`, `location`, `requiredSkill` and `@PlanningVariable Employee employee` ([Shift.java L13-L25][q-shift]). One entity is one head on one shift. Empty shifts are not allowed ([report 02 §2.2][int-02]).
- `EmployeeSchedule`: employees as the value range, shifts as entities, `HardSoftBigDecimalScore`, and a `SolverStatus` field ([EmployeeSchedule.java L13-L26][q-sched]).

### 6.2 Constraint list and our equivalents

All from [EmployeeSchedulingConstraintProvider.java][q-cp] (solver 2.7.0).

| Their constraint (exact name) | Level, weight | Our equivalent | Gap |
|---|---|---|---|
| `Missing required skill` | hard, 1 per shift | `qualifiedPeople` on requirements, skill mix (`preference_types.py:104-137`) | None. Ours also has skill mix floors. |
| `Overlapping shift` | hard, minutes of overlap | One day-state per day (`offs + shifts + leaves == 1`, `scheduler.py:362`) | We model days, not clock times. Fine for wards. |
| `At least 10 hours between 2 shifts` | hard, minutes short of 10 h | Successions with `-inf`, for example forbid Night then Day | Ours needs one pattern per bad pair. Theirs uses clock times. |
| `Max one shift per day` | hard, 1 per pair | Same day-state constraint | None |
| `Unavailable employee` | hard, minutes overlap | LEAVE request (hard), or OFF request with `+inf` | None |
| `Undesired day for employee` | soft penalty, minutes | Shift request with negative weight | Ours weights by rule, not by minutes. |
| `Desired day for employee` | soft reward, minutes | Shift request with positive weight | Same |
| `Balance employee shift assignments` | soft, `loadBalance` unfairness | Squared shift count (section 3) | Target is not the mean. No carry-in. |
| none | none | Staffing counts with preferred counts and date overrides | Theirs has one entity per head. Counts are implicit. |
| none | none | Succession patterns with history, contracted hours, affinities, supervision cover | Quickstart has none. The paid model has most (below). |

### 6.3 The paid Employee Shift Scheduling model (commercial, Timefold Platform)

- It "is one of the Scheduling APIs available on the Timefold Platform" and "includes Timefold Enterprise Solver". Datasets are capped at 400,000 shifts ([ESS introduction][p-ess]). No price is public ([pricing][p-pr]).
- Levels: "Constraints can be considered hard, medium, or soft". Medium constraints "help manage plans when resources are limited". The maximum weight is one trillion ([ESS constraints][p-essc]).
- Its constraint groups cover work limits, rolling windows, consecutive days, weekends and days off. They also cover shift rotations, sequence patterns, pairing, skills, demand, cost, and fairness ("Balance time worked", "Balance shift count") ([ESS introduction][p-ess]). Nearly every group has a match in our 7 rule types. Rolling windows and cost have no direct match. [UNCONFIRMED: per-constraint levels. The constraints page gives no full table. It points to a Platform page behind login.]

### 6.4 UI patterns

From [app.js][q-js] and `index.html` in the quickstart:

- Two `vis.Timeline` views: by location and by employee, in tabs.
- Availability as background bands per employee row: unavailable, undesired and desired dates, each with its own colour at `opacity: 0.5`.
- A score badge ("Score: ...") beside Solve and Stop buttons, and an Analyze button that opens the constraint table ([report 01 §7][int-01]).
- Polling every 2 s (`setInterval(refreshSchedule, 2000)`) while the solver status is not `NOT_SOLVING`.

Worth copying: request bands behind the roster cells, so a manager sees a broken wish at a glance. I did not audit our roster grid for this. [UNCONFIRMED: current grid rendering in `web/`.] Effort S. P2.

### 6.5 REST job API and solver status

- `SolverManager` runs many problems in parallel. `solveBuilder()` takes a problem id, a problem finder and a best-solution consumer ([SolverManager.java][s-sm]). `solveAndListen` is the short form.
- `SolverStatus` has three values: `SOLVING_SCHEDULED` ("No solver thread started solving this problem yet"), `SOLVING_ACTIVE`, and `NOT_SOLVING` ("terminated or the problem was never submitted") ([SolverStatus.java L21-L36][s-ss]).
- Quickstart endpoints under `/schedules` ([EmployeeScheduleResource.java][q-res]): `GET` lists job ids. `POST` returns a UUID job id and starts solving. `GET /{jobId}` returns the best solution so far. `GET /{jobId}/status` returns only score and status. `DELETE /{jobId}` calls `terminateEarly` and returns the best so far. `PUT /analyze` returns score analysis. Errors are kept per job.
- The 2.x "service" module wraps this as `POST /<root>`, `GET /<root>/{id}`, `DELETE /<root>/{id}` and `GET /<root>/{id}/score-analysis`. It is "Timefold Solver with an opinionated" wrapper ([service overview][d-svc]). The page carries a preview note.
- Config: `termination.spent-limit=30s`. `move-thread-count=AUTO` is only in the `%enterprise` profile ([application.properties][q-props]).

Our web, at a high level: `POST /api/optimize` starts a job. `GET /api/optimize/{id}` polls. `/events` is an SSE stream with reconnect cursors. `/cancel` and `/finish-now` stop the job. `/roster` and `/xlsx` fetch results (`web/app/api/optimize/`). Job states are `queued`, `running`, `completed`, `failed`, `cancelled`.

| Timefold | Ours | Verdict |
|---|---|---|
| `SOLVING_SCHEDULED` | `queued` | Same |
| `SOLVING_ACTIVE` | `running` | Same |
| `NOT_SOLVING` | `completed`, `failed`, `cancelled` | Ours is richer |
| `DELETE` returns best so far | `finish-now` (best so far) and `cancel` | Same idea |
| 2 s polling | SSE with `Last-Event-ID` | Ours is better |
| `/status` returns score only | Not checked | [UNCONFIRMED] |
| Throttling best-solution events | Enterprise in Timefold ([commercial editions][d-ce]) | Check our SSE rate. P3 |

Nothing major to borrow here. Our job API already matches or beats the quickstart.

## 7. Q1f. Benchmarker

- The benchmarker is a separate artifact, `timefold-solver-benchmark`, and runs solver configs against datasets ([benchmarking][d-bm]). The pricing page lists "Solver manager & benchmarker" under Community ([pricing][p-pr]).
- Reports: rank 0 is "the favorite Solver". Rankings are `TOTAL_SCORE` (default), `WORST_SCORE`, `TOTAL_RANKING` (for datasets that "differ greatly in size"). "Best score over time" "is run by default". `subSingleCount` repeats each run to reduce the effect of "the Random Number Generator" (same page).
- The docs warn: "Do not assess quality on small data sets" ([algorithms overview][d-ov]).

We already own most of this. `/tmp/wave/bench/` has `dump.py` (builds the production model), `bench.py` (one solve per run, JSON line with status, objective, bound, gap, wall, first solution), `run.sh` (pinned cores, seeds) and `table.py` (markdown tables). It lives in `/tmp`, so it is at risk.

Tiny equivalent for CP-SAT:

1. Move the four scripts into `core/scripts/bench/`. The repo policy lets production-side scripts read files.
2. Add a best-over-time trace: the solution callback appends `(wall, objective, bound)`. This is Timefold's "best score over time".
3. Add two rankings: total normalised gap per model (like `TOTAL_SCORE`) and mean rank per model (like `TOTAL_RANKING`, since our objectives range from 449 to 4e12).
4. Corpus: october, genmed, large87, plus the wards named in plan decision 6. Budgets 15 and 60 s. Seeds 1 to 3. `taskset -c 0,1`.

This is the gate tool for the LNS loop and for plan phase "later". Effort S. P1.

## 8. Q1g. Other items

### 8.1 Termination

- Timefold offers spent limit, unimproved spent limit (with `unimprovedScoreDifferenceThreshold`), best score limit, `bestScoreFeasible`, step counts, and diminished returns. It recommends diminished returns, which stops when "the rate of improvement is below a percentage of the initial rate" ([algorithms overview][d-ov]). It warns that time limits are "hardware-specific".
- CP-SAT has `max_time_in_seconds`, `relative_gap_limit` and `absolute_gap_limit` ([sat_parameters.proto L378-L379][o-sp]) and `stop_after_first_solution` (L1469). It has no "unimproved for N seconds" stop. We can build one in the existing solution callback and stop watcher (`solver_ortools_cp_sat.py:145`, `:317`).
- Value for us: small. Since `max_lp_sym` shipped, small wards prove optimality in about 1 s ([04][int-04]). An unimproved stop on large87 ends the run early with a worse roster. Keep the fixed menu from plan §4.5. Effort S. P3.

### 8.2 Score levels

Hard, medium and soft levels, and why stages beat huge weights on CP-SAT, are in [report 02][int-02] and plan §4.3. Nothing new.

### 8.3 Constraint weight overrides

- `ConstraintWeightOverrides.of(Map)` sets per-solution weights by constraint name. A weight of `0hard` disables a constraint ([constraint overrides][d-cwo]). The docs advise to "Provide a UI to adjust the constraint weights and visualize the resulting solution". Community: the class is in the open `core` API ([ConstraintWeightOverrides.java][s-cwo]).
- We already have this. Every rule card carries its own weight in the YAML, and the vjbv ladder groups them into tiers. Nothing to borrow. P3.

### 8.4 Recommended Fit

- What it is: for one unassigned entity, try each value with the construction heuristic and "incremental calculation", and return options "in the order of decreasing preference", each with its score difference ([recommendation API][d-rec]).
- Edition: **Community in 1.x.** `recommendAssignment` and `recommendFit` are implemented in the open `DefaultSolutionManager` on branch `1.x` ([DefaultSolutionManager.java L148-L161][s-dsm1]). **Enterprise in 2.x.** "Recommended assignment no longer open-source" ([upgrade guide][d-up]). This closes an unconfirmed item in [report 01][int-01].
- On CP-SAT this is plan §4.4 ("recommend a nurse for an empty slot"). Two steps: evaluate each qualified nurse with the roster fixed (propagation only), then repair the top 5 with a ±3 day window free. A toy took 2.5 s for 20 candidates ([report 02 §4][int-02]). The LNS loop in section 2.4 and the repair step are the same code with a different neighbourhood. Build them together. Effort M. P2.

### 8.5 Multithreaded solving

- Multithreaded incremental solving, partitioned search, constraint profiling, node sharing and throttled events are Enterprise ([commercial editions][d-ce]). The sweet spot for move threads is "up to 10 thousand" move evaluations per second ([multithreaded solving][d-mt]). On 2 cores this gives little.
- CP-SAT's portfolio already uses both cores. Skip.

## 9. Summary table of borrow ideas

| Idea | Community / Enterprise | Value for us | CP-SAT or web approach | Effort | Priority |
|---|---|---|---|---|---|
| Benchmarker, best score over time | Community | Gate for every solver change | Move `/tmp/wave/bench` scripts to `core/scripts/bench/`, add trace and rankings | S | P1 |
| Pinning (`@PlanningPin`) | Community | Manager locks a cell, AI respects it | Web emits hard shift requests (`+inf`) | S | P1 |
| Non-disruptive replanning | Community (pattern) | Few changes after a remedy or a month edit | Web emits soft requests on the previous roster, weight below the lowest tier | S | P1 |
| Hint previous roster | Community (warm start in `ProblemChange`) | Faster re-solve | `add_hint` in core (plan P5) | S | P1 (in plan) |
| Ruin and recreate LNS | Community | Large wards on 2 cores: large87 from -13e12..-37e12 to about +2e12 | Size-gated loop in `ORToolsSolver.solve` with day and nurse neighbourhoods | M | P2 |
| Recommended Fit | Community 1.x, Enterprise 2.x | Manual fill of an empty slot | Evaluate plus repair (plan §4.4), shares LNS code | M | P2 |
| `loadBalance` fairness | Community | Fair load without a hand-picked target | Web sets T to the ward mean in the squared count | S | P2 |
| Published window | Community (pattern) | Freeze already published weeks | Web emits hard requests before date X | S | P2 |
| Availability bands in the roster view | Community (quickstart UI) | Broken wishes visible at a glance | Web UI | S | P2 |
| Fairness carry-in across months | Community (`initialLoadFunction`) | Fair over a quarter, not a month | Core option: history counts in shift count | M | P3 |
| Unimproved-time termination | Community | Small CPU saving | Solution callback plus stop watcher | S | P3 |
| Constraint weight overrides | Community | Already have it | none | none | P3 |
| Greedy construction heuristic | Community | Faster first solution on large wards only | Python greedy as hint | M | P3 |
| Nearby selection | Enterprise | Covered by LNS neighbourhoods | none | none | skip |
| Multithreaded, partitioned search | Enterprise | CP-SAT portfolio covers it | none | none | skip |
| Score analysis, diff | Enterprise in 2.x | Covered in plan §4.1 | none here | none | see [01][int-01] |

## 10. Q2. Can we use Timefold Solver Community Edition as our solver?

**Verdict: no.** Report [07][int-07] is the full study: licence and editions, Java 21, the Python end, JVM memory, a 33 to 50 developer-day port estimate, and the lack of proofs. I agree with its verdict and its triggers. This section adds only evidence that 07 lacks, and two points where I disagree.

### 10.1 Evidence 07 does not have

- **Python status, primary sources.** The announcement of 2025-07-11 says "Timefold will not release new features or bug fixes for the Python Solver" ([discussion #1698][g-1698]). The `timefold-solver-python` repo is archived, Apache 2.0, last push 2025-07-11 ([repo][g-py]). The last PyPI build, `timefold 1.24.0b0`, was uploaded on 2025-07-08 and is not yanked ([PyPI][g-pypi]). So a Python install still works, but it is a frozen beta on the 1.x line.
- **No head-to-head benchmark exists.** Timefold's own "OR-Tools versus Timefold" post (2023-11-24, updated 2025-11-12) has no timing or score numbers. It "covered only the features in the free, open source edition" and admits "our natural bias towards Timefold" ([blog][b-ortv]). I searched the web and the old 0.8.x nurse rostering example ([0.8.x docs][d-nr08]). I found no run of Timefold or OptaPlanner against CP-SAT on INRC-I, INRC-II or Curtois instances.
- **Timefold's own nurse config.** If a 07 trigger fires, the spike has a starting point. The 0.8.x INRC-I example used `WEAKEST_FIT`, Tabu Search with `entityTabuSize` 7, `acceptedCountLimit` 800, and change, swap and sequence pillar moves ([nurseRosteringSolverConfig.xml][s-nrcfg]). It pinned days before the planning window with a `PinningFilter` ([ShiftAssignmentPinningFilter.java][s-nrpin]). `PinningFilter` is gone in 2.x ([upgrade guide][d-up]).
- **Timefold's main strength is portable.** 07 lists "Unknown quality on large wards" as a risk. Local search is what wins on INRC-II ([Ceschia and Schaerf][l-cs]). Section 2.3 shows that the same idea, as an LNS loop inside CP-SAT, lifts large87 at 2 workers and 15 s to about the 8-worker result. That removes much of the case for a second solver, and it keeps the CP-SAT proofs.
- **Recommended Fit edition.** 07 marks it Enterprise, which is true for 2.x. On 1.x it is Community ([DefaultSolutionManager.java L148-L161][s-dsm1]). This matters only if someone proposes a 1.x-only adoption, and 1.x reaches EOL in early 2027 ([07 §2.1][int-07]).

### 10.2 Where I disagree with 07

1. **Fairness without a target is not a core patch.** 07 §11 proposes a new "balance" count form (effort M, v2-only core patch). With exact staffing the total S is known before the solve. So the web can set T to the ward mean and emit the existing `|x - T|^2` count. That ranks rosters the same way as the sum of squared counts, with no core change (section 3.2). Effort S. A core form is needed only for preferred-count wards, where S varies, or for carry-in from earlier months.
2. **The diminishing-returns stop is not a first step.** 07 §11 and its recommendation 3 start with it (S). I rate it P3. Since `max_lp_sym` shipped, october and genmed prove optimality in about 1 s, so there is little CPU to save ([04][int-04], `/tmp/wave/bench/RESULTS.md`). On large87 the objective still climbs at 15 s and at 60 s (same file), so an early stop gives a worse roster. The benchmarker (section 7) must show a gain before we ship it.

07 §11 also proposes per-rule unit tests on the ledger and reporting runs as single matches. Both fit next to section 8 here. I have nothing to add to them.

## Unconfirmed items

- Per-constraint score levels in the paid Employee Shift Scheduling model. I read the ESS constraints page and introduction. The full list sits on a Platform page behind login.
- JVM memory and porting effort. I defer to the estimates in [07][int-07]. Nobody measured them.
- A head-to-head benchmark of Timefold or OptaPlanner and CP-SAT on INRC. I searched the web, the Timefold blog and the 0.8.x example. None found.
- Whether our roster grid already shows request bands and whether our job API has a score-only status call. I read only the route files in `web/app/api/optimize/`.
- Whether our SSE progress events need throttling. Not checked.
- LNS gains on tc1. I ran on a desktop CPU with 2 pinned cores, one large model, 3 seeds.
- Whether feasibility jump and violation LS run at all with 2 workers. I read the proto defaults, not the 2-worker portfolio log.

## Recommendation

1. **Promote the benchmarker** (`/tmp/wave/bench` to `core/scripts/bench/`, add the best-over-time trace). It is the gate for every item below. S.
2. **Pinning and stability in the web**, with no core change. Locked cells become hard shift requests. The last published roster becomes soft requests with a weight below the lowest tier. S each.
3. **Hint the previous roster** on re-solve, as plan P5 says. S.
4. **Fairness to the mean**: let the web compute T from the required totals for balanced counts. S.
5. **Spike the size-gated LNS loop** in core, on the benchmark corpus and on tc1. Adopt it only if large wards gain and small wards keep their proofs. Build Recommended Fit (plan §4.4) on the same code. M.
6. **Skip** Timefold as a solver, greedy construction, nearby selection, multithreading and termination tweaks. Revisit Q2 only on the triggers in [07][int-07]. Check the "large ward" trigger with the benchmarker and the LNS loop first.

## Sources

[int-plan]: 00-plan.md
[int-01]: 01-score-analysis-explainability.md
[int-02]: 02-overconstrained-never-infeasible.md
[int-03]: 03-cpsat-infeasibility-explanation.md
[int-04]: 04-cpsat-autotune.md
[int-07]: 07-adopt-timefold-community.md
[int-alt02]: ../../research/2026-09-28-solver-alternatives/02-solver-alternatives.md
[int-alt03]: ../../research/2026-09-28-solver-alternatives/03-nurse-rostering-evidence.md
[d-ch]: https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/construction-heuristics
[d-ls]: https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/local-search
[d-ov]: https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/overview
[d-nb]: https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/neighborhoods
[d-msr]: https://docs.timefold.ai/timefold-solver/latest/optimization-algorithms/move-selector-reference
[d-msm]: https://docs.timefold.ai/timefold-solver/latest/commercial-editions/multistage-moves
[d-lb]: https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/load-balancing-and-fairness
[d-rtp]: https://docs.timefold.ai/timefold-solver/latest/responding-to-change/real-time-planning
[d-ndr]: https://docs.timefold.ai/timefold-solver/latest/responding-to-change/non-disruptive-replanning
[d-rec]: https://docs.timefold.ai/timefold-solver/latest/responding-to-change/recommendation-api
[d-mpp]: https://docs.timefold.ai/timefold-solver/latest/domain-modeling/modeling-planning-problems
[d-bm]: https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/benchmarking-and-tweaking
[d-cwo]: https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/library/constraint-overrides
[d-mt]: https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/multithreaded-solving
[d-svc]: https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/service/overview
[d-ce]: https://docs.timefold.ai/timefold-solver/latest/commercial-editions/commercial-editions
[d-up]: https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1
[d-nr08]: https://docs.timefold.ai/timefold-solver/0.8.x/use-cases-and-examples/nurse-rostering/nurse-rostering
[p-pr]: https://timefold.ai/pricing
[p-ess]: https://docs.timefold.ai/employee-shift-scheduling/latest/introduction
[p-essc]: https://docs.timefold.ai/employee-shift-scheduling/latest/user-guide/constraints
[p-essf]: https://docs.timefold.ai/employee-shift-scheduling/latest/employee-resource-constraints/fairness/balance-shift-count
[p-essm]: https://docs.timefold.ai/employee-shift-scheduling/latest/manual-intervention
[s-cc]: https://github.com/TimefoldAI/timefold-solver/blob/main/core/src/main/java/ai/timefold/solver/core/api/score/stream/ConstraintCollectors.java#L1971-L1997
[s-dlb]: https://github.com/TimefoldAI/timefold-solver/blob/main/core/src/main/java/ai/timefold/solver/core/impl/score/stream/collector/DefaultLoadBalance.java#L65-L112
[s-ss]: https://github.com/TimefoldAI/timefold-solver/blob/main/core/src/main/java/ai/timefold/solver/core/api/solver/SolverStatus.java#L21-L36
[s-sm]: https://github.com/TimefoldAI/timefold-solver/blob/main/core/src/main/java/ai/timefold/solver/core/api/solver/SolverManager.java
[s-cwo]: https://github.com/TimefoldAI/timefold-solver/blob/main/core/src/main/java/ai/timefold/solver/core/api/domain/solution/ConstraintWeightOverrides.java
[s-dsm1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/impl/solver/DefaultSolutionManager.java#L148-L161
[s-nrcfg]: https://github.com/TimefoldAI/timefold-solver/blob/0.8.x/examples/src/main/resources/ai/timefold/solver/examples/nurserostering/nurseRosteringSolverConfig.xml
[s-nrpin]: https://github.com/TimefoldAI/timefold-solver/blob/0.8.x/examples/src/main/java/ai/timefold/solver/examples/nurserostering/domain/solver/ShiftAssignmentPinningFilter.java
[q-cp]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/java/org/acme/employeescheduling/solver/EmployeeSchedulingConstraintProvider.java
[q-emp]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/java/org/acme/employeescheduling/domain/Employee.java#L10-L16
[q-shift]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/java/org/acme/employeescheduling/domain/Shift.java#L13-L25
[q-sched]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/java/org/acme/employeescheduling/domain/EmployeeSchedule.java#L13-L26
[q-res]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/java/org/acme/employeescheduling/rest/EmployeeScheduleResource.java#L41-L186
[q-props]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/resources/application.properties
[q-js]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/resources/META-INF/resources/app.js
[g-1698]: https://github.com/TimefoldAI/timefold-solver/discussions/1698
[g-py]: https://github.com/TimefoldAI/timefold-solver-python
[g-pypi]: https://pypi.org/project/timefold/
[b-ortv]: https://timefold.ai/blog/google-or-tools-versus-timefold-comparison
[o-sp]: https://github.com/google/or-tools/blob/v9.15/ortools/sat/sat_parameters.proto
[o-cmp]: https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto#L656-L667
[o-cms]: https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model_solver.cc#L1879-L1935
[o-cpm]: https://github.com/google/or-tools/blob/v9.15/ortools/sat/python/cp_model.py
[pr-lns]: https://github.com/d-krupke/cpsat-primer/blob/main/chapters/lns.md
[l-cs]: https://patatconference.org/patat2018/files/proceedings/paper46.pdf

- Internal: [plan][int-plan], [01][int-01], [02][int-02], [03][int-03], [04][int-04], [07][int-07], [alternatives 02][int-alt02], [alternatives 03][int-alt03].
- Timefold docs: [construction heuristics][d-ch], [local search][d-ls], [algorithms overview][d-ov], [neighborhoods][d-nb], [move selectors][d-msr], [load balancing][d-lb], [real-time planning][d-rtp], [non-disruptive replanning][d-ndr], [recommendation API][d-rec], [benchmarking][d-bm], [constraint overrides][d-cwo], [commercial editions][d-ce], [upgrade guide][d-up], [pricing][p-pr], [ESS][p-ess].
- Timefold source: [DefaultLoadBalance][s-dlb], [ConstraintCollectors][s-cc], [SolverStatus][s-ss], [DefaultSolutionManager 1.x][s-dsm1], [quickstart constraints][q-cp], [quickstart resource][q-res], [0.8.x nurse config][s-nrcfg].
- OR-Tools: [sat_parameters.proto][o-sp], [cp_model.proto][o-cmp], [cp_model_solver.cc][o-cms], [cp_model.py][o-cpm].
