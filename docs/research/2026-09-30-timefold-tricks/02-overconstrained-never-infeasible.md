# Timefold tricks, part 2: overconstrained planning and "never infeasible"

Date: 2026-09-30. Scope B of the Timefold tricks research. Timefold docs were read as AsciiDoc source from `TimefoldAI/timefold-solver` `main` (commit `3d233796`, `docs/src/modules/ROOT/pages/`) and on docs.timefold.ai. OR-Tools sources are pinned to tag `v9.15`. Items marked [UNCONFIRMED] name where we looked.

Builds on, and does not repeat: `docs/research/2026-09-28-solver-alternatives/` (keep CP-SAT, Timefold Python is dead), the l3m infeasible-core spec (`2026-09-27-infeasible-core-design.md`) and the vjbv priority-ladder spec (`2026-09-29-priority-ladder-design.md`).

## Answer

Timefold never answers "infeasible, no roster". It scores hard rules instead of enforcing them, so it always returns a full roster, and a negative hard score marks it infeasible. For too little staff it adds a third level: a shift can stay empty, and each empty shift costs one "medium" point. That level sits below hard rules and above every soft wish.

We can copy all of it on CP-SAT without a new solver:

1. **Short-slot variables** (the medium level) turn over-demand into "3 night places stay empty" instead of INFEASIBLE.
2. After an INFEASIBLE run, **a relaxed backup solve** with violation variables gives a least-bad roster. Two stages (minimise violations, cap them, then optimise soft) beat one solve with huge weights. On a toy model this took about 0.5 s against 3 to 8 s.
3. **A roster scorer** (the relaxed model with every cell fixed) plays the role of Timefold's score calculator. It enables what-if and "recommend a nurse" at milliseconds per candidate.
4. **Pinning** is fixed variables plus hints. CP-SAT has both natively.

The l3m core names the clash. These designs show what the least-bad roster looks like and what it costs. The two fit together.

## 1. How Timefold avoids hard infeasibility

- Hard rules are score levels, not constraints. "The levels of two scores are compared lexicographically" ([score overview](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/overview)).
- A full but infeasible roster is the normal outcome: "By default, Timefold Solver will always assign all planning variables a planning value. If there is no feasible solution, this means the best solution will be infeasible" (same page).
- Hard rules carry weights on purpose: "the least infeasible solution allows the business to estimate how many business resources they are lacking" (same page). The quickstart grades hard breaks by size, for example overlap in minutes: `.penalize(HardSoftBigDecimalScore.ONE_HARD, EmployeeSchedulingConstraintProvider::getMinuteOverlap)` ([EmployeeSchedulingConstraintProvider.java](https://github.com/TimefoldAI/timefold-quickstarts/blob/master/java/employee-scheduling/src/main/java/org/acme/employeescheduling/solver/EmployeeSchedulingConstraintProvider.java)).
- Timefold warns against big weights in place of levels. It calls that hack "score folding" and says it "is broken" ([score overview](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/overview)). This matches vjbv §5.1, which rejected strict ordering by weights. Our fix is stages, not weights (section 4).

## 2. Feature by feature

| Feature | What it does | Edition | Source (quote) |
|---|---|---|---|
| `HardMediumSoftScore` | 3 levels. "Higher medium values take precedence over soft values irrespective of the soft value" | Community [inferred: absent from the Enterprise list] | [score overview](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/overview) |
| `allowsUnassigned = true` on `@PlanningVariable` | "To allow an initialized planning variable to be ``null``, set `allowsUnassigned` to ``true``" | Community [inferred] | [modeling planning problems](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/modeling-planning-problems) |
| Old name `nullable = true` | "`@PlanningVariable(nullable = ...)` attribute renamed to `@PlanningVariable(allowsUnassigned = ...)`" in 2.0. `forEachIncludingNullVars()` became `forEachIncludingUnassigned()` | Community | [upgrade from v1](https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1) |
| `allowsUnassignedValues = true` on `@PlanningListVariable` | "To allow a planning value to be unassigned, set `allowsUnassignedValues` to ``true``" | Community [inferred] | [modeling planning problems](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/modeling-planning-problems) |
| Overconstrained pattern | "Add a score constraint at the appropriate level (usually medium, between hard and soft) to penalize each unassigned entity" | Community | [common patterns](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/common-patterns#overconstrainedPlanning) |
| `@PlanningPin` | Lets users "pin down one or more specific assignments" | Community [inferred] | [modeling planning problems](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/modeling-planning-problems) |
| `@PlanningPinToIndex` | "The first part, with indexes less than `firstUnpinnedIndex`, is pinned" | Community [inferred] | same page |
| Real-time planning, `ProblemChange` | The solver "Restarts from the adjusted best solution", a warm start that is "much faster than a cold start" | Community [inferred] | [real-time planning](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/real-time-planning) |
| Continuous planning | "we actually plan a window of 12 days, but we only publish the first four days" | Pattern, no API | [continuous planning](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/continuous-planning) |
| Non-disruptive replanning | "The gain of changing an assignment must outweigh the disruption cost" | Pattern, no API | [non-disruptive replanning](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/non-disruptive-replanning) |
| Recommendation API (`recommendAssignment`, was `recommendFit`) | "`SolutionManager.recommendFit()` renamed to `recommendAssignment()`" | **Enterprise** in 2.x: "it now requires Timefold Solver Enterprise Edition on the classpath" | [upgrade from v1](https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1) |
| Score analysis and `diff` (what-if) | "`ScoreAnalysis` instead, which is now provided exclusively by _Timefold Solver Enterprise Edition_" | **Enterprise** in 2.x | same page |
| Multithreaded solving, nearby selection, partitioned search | All three are rows in the Enterprise feature table | **Enterprise** | [Enterprise Edition](https://docs.timefold.ai/timefold-solver/latest/commercial-editions/commercial-editions) |

"Community" rows marked [inferred] rest on the Enterprise page, which lists every paid feature and does not list these. Their pages carry no `_only-enterprise` include, unlike the Recommendation API, score analysis, nearby selection and partitioned search pages.

Platform, Java and Kotlin only:

- Timefold Solver "is 100% pure Java" and "supports Kotlin" ([introduction.adoc](https://github.com/TimefoldAI/timefold-solver/blob/main/docs/src/modules/ROOT/pages/introduction.adoc)).
- The 11 July 2025 post says Timefold is "halting active development" on the Python beta ([#1698](https://github.com/TimefoldAI/timefold-solver/discussions/1698)).
- The v1.25.0 release "no longer includes Python support" ([v1.25.0](https://github.com/TimefoldAI/timefold-solver/releases/tag/v1.25.0)).

### 2.1 Unassigned work: details that matter for us

- The trap. An empty roster "scores better" than one with hard breaks ([patterns](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/common-patterns#overconstrainedPlanning)). Our short-slot variable needs a penalty in the same way.
- The rule it gives. Every other choice for an empty shift costs more "in hard or medium score than leaving it empty" (same page).
- No dummy nurse. Timefold calls a "dummy" resource an antipattern. Real rules "now also apply to the dummy resource" (same page). An agency-nurse row in our roster has the same problem. A slack count per slot does not.
- Repeated planning cost. Each restart tries "to initialize all the `null` variables again" ([modeling](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/modeling-planning-problems)). CP-SAT has no such phase, so this does not apply to us.

### 2.2 Employee scheduling: quickstart against the paid model

- The open quickstart does **not** allow empty shifts. `Shift` has a plain `@PlanningVariable private Employee employee;` ([Shift.java](https://github.com/TimefoldAI/timefold-quickstarts/blob/master/java/employee-scheduling/src/main/java/org/acme/employeescheduling/domain/Shift.java)), and the score is `HardSoftBigDecimalScore` ([EmployeeSchedule.java](https://github.com/TimefoldAI/timefold-quickstarts/blob/master/java/employee-scheduling/src/main/java/org/acme/employeescheduling/domain/EmployeeSchedule.java)). With too few staff it breaks hard rules.
- The paid Employee Shift Scheduling model uses the medium level. An empty mandatory shift breaks "The `Unassigned mandatory shift` medium constraint". An empty optional shift costs "a soft penalty" ([ESS priority](https://docs.timefold.ai/employee-shift-scheduling/latest/shift-service-constraints/priority-and-optional-shifts)). This maps to our "required" count (medium) and "ideally" count (vjbv tier 3b, soft).
- Its recommendations return a score diff per constraint, for example `"scoreDiff": "0hard/1medium/0soft"` with `"constraintName": "Unassigned mandatory shift"`. "Accepting any one recommendation invalidates all the others" ([recommendations](https://docs.timefold.ai/employee-shift-scheduling/latest/recommendations)). It is a Timefold Platform API with an API key and a free trial. Price [UNCONFIRMED: no price on that page].

### 2.3 Recommendation and what-if

- Recommendation is greedy, not a re-solve. It "uses a simple greedy algorithm together with incremental calculation". It finds a fit "in a matter of milliseconds" ([recommendation API](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/recommendation-api)).
- One gap at a time. "If the entity is unassigned, then it must be the only unassigned entity in the planning solution" (same page).
- What-if is "score a changed roster". A user asked why an entity stayed unassigned. The maintainer said to "use `SolutionManager.analyze(...)`" on a solution "simulating that situation" ([discussion #1617](https://github.com/TimefoldAI/timefold-solver/discussions/1617)). So Timefold itself has no "why empty" explanation. It evaluates a hand-made alternative.
- `ScoreAnalysis.diff` compares two rosters: "the second solution is subtracted from the first solution" ([understanding the score](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/understanding-the-score)). Enterprise in 2.x.

### 2.4 Pinning, windows and history

- Pin changes go through `ProblemChange`: "Planning pin value must never change during planning" ([modeling planning problems](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/modeling-planning-problems)).
- The planning window has stages. _History_ holds "Immutable past time periods containing only pinned entities". _Published_ periods follow, and "Normal planning will not change the published schedule". _Draft_ periods "can change freely". The draft must reach well past the published part "to avoid _painting yourself into a corner_" ([continuous planning](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/continuous-planning)).
- History keeps only recent periods: "Do not load all historic entities into memory" (same page). Our core already does this with `person.history` carry-in (`core/nurse_scheduling/models.py`, `history: list[str] | None`).
- Non-disruptive replanning is a soft penalty per changed cell: with `-1000`, a change is accepted only "if it improves the soft score for at least `1000` points per variable changed" ([non-disruptive replanning](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/non-disruptive-replanning)).

## 3. CP-SAT building blocks

| Need | CP-SAT tool | Source (quote) |
|---|---|---|
| Warm start, repair | `add_hint`. "A solution hint is not a hard constraint". "partial solution hints are fine" | [model.md](https://github.com/google/or-tools/blob/v9.15/ortools/sat/docs/model.md) |
| Hint repair mode | `repair_hint`: "the solver tries to repair the solution given in the hint" | [sat_parameters.proto:1199-1203](https://github.com/google/or-tools/blob/v9.15/ortools/sat/sat_parameters.proto#L1199-L1203) |
| Pin by hint | `fix_variables_to_their_hinted_value`: "variables appearing in the solution hints will be fixed to their hinted value" | [sat_parameters.proto:1205-1207](https://github.com/google/or-tools/blob/v9.15/ortools/sat/sat_parameters.proto#L1205-L1207) |
| Pin by bounds | `model.add(x == v)` or a fixed domain. Assumptions are "slower" than "just fixing the domain" | [cp_model.proto:669-682](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto#L669-L682) |
| Core | `sufficient_assumptions_for_infeasibility`. For a minimal set, "minimize the number of assumptions at false" | [cp_model.proto:777-796](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto#L777-L796) |
| Lexicographic levels | Solve. Then add "a constraint that the value must be at least" the stage result. Then change the objective and reuse the solution "as a hint for the next solve" | [CP-SAT primer, coding patterns](https://github.com/d-krupke/cpsat-primer/blob/main/chapters/coding_patterns.md) |

CP-SAT has no native multi-level objective [UNCONFIRMED: we read `cp_model.proto` v9.15 and found one `objective` field and no level list]. The core in this checkout sets no hints (no `add_hint` in `core/nurse_scheduling/`). It has `avoid_solution` only (`scheduler.py`).

## 4. Local experiment

Coordinator run, `/tmp/wave/timefold/overconstrained/` (`exp.py`, `RESULTS.md`, `run.log`, `run-taskset2.log`). OR-Tools 9.15.6755. 20 nurses, 28 days, 3 shifts, `num_workers = 2` under `taskset -c 0,1`, 15 s limit, seeds 0 to 2. Infeasible data: demand (6,5,4) a day, 420 slots against 360 nurse-days. Sizing: M = 2000 > max soft (1600), H = M × 504 + 1.

| Case | Time (seed 0 / 1 / 2) | Result |
|---|---|---|
| Normal, feasible | 0.20 / 0.08 / 0.07 s | OPTIMAL, score 84 |
| Relaxed, feasible data | 0.56 / 0.36 / 0.46 s | same score 84, 0 violations |
| Normal, infeasible | 0.06 / 0.07 / 0.06 s | INFEASIBLE |
| One weighted solve, huge weights | 3.21 / 7.97 / 3.75 s | OPTIMAL, 60 short slots, 0 hard violations |
| Two-stage: stage 1 (violations) | 0.28 / 0.26 / 0.21 s | |
| Two-stage: stage 2 (soft under cap) | 0.38 / 0.29 / 0.32 s | |
| Pin days 0 to 6, hint the rest | 0.04 s | |
| Recommend: 20 candidates for one night slot, fix + hint, 2 s cap each | 2.54 s total | 19 of 20 feasible |

Findings. Strict sizing did not hide the feasible optimum. Short slots absorbed all the shortfall, so no hard rule broke. Huge weights made one solve 10 to 25 times slower than two stages. Caveat: a toy model on a dev CPU faster than tc1. Its infeasibility is a plain capacity bound. Treat the numbers as relative.

## 5. Where this sits against our specs

- l3m (core). l3m names a conflict set. The relaxed solve gives a correction set plus a full roster. l3m found 2 of its 5 "no single-rule fix" cases are over-demand. Short slots answer those directly ("2 night places stay empty on 3 and 4 Oct").
- vjbv (ladder). vjbv keeps soft tiers as weights and rejects weights near 10^8 (§5.1). That stands. Stages add only the two top levels (hard, medium) above the ladder, so no soft weight grows. Leave stays hard and is never relaxed (vjbv §4.1).
- Product choice. Timefold ranks medium (empty shift) below hard. For a ward, an empty night place is itself a safety risk. So the design keeps staffing hard in the normal run and uses short slots only in the backup solve, where the user sees them named.

## Implement on CP-SAT

All designs run only after a normal run ends INFEASIBLE, except D3 and D4, which the assistant calls on demand. Real-ward timings on tc1 are unmeasured for all of them (gate G3 below).

**D1. Short-slot variables for staffing (medium level).** Effort M. Priority P1.
- Compute: for each requirement, date and shift, an integer `short >= 0` with `count + short >= required` in place of the hard floor. Stage 1 minimises `sum(short)` with every other hard rule kept. Stage 2 caps `sum(short) <= stage1` and optimises the normal objective, with the stage 1 roster as hint.
- How: a v2 core patch next to l3m P5, flag-guarded in the same `add_constraint` hook. The "ideally" count stays soft (vjbv 3b), like Timefold's optional shift.
- Cost: toy two stages about 0.5 s. Budget: the l3m 30 s cap, shared.
- Assistant data: `{"mode": "short_staffed", "short_slots": [{"date": "2026-10-03", "shift": "N", "required": 3, "filled": 2}], "total_short": 2, "stage1_optimal": true, "seconds": 0.6}`. The existing `run_one_short` and `borrow_temporary_nurse` options now carry proof.

**D2. Relaxed backup solve for the other hard rules.** Effort L. Priority P2.
- Compute: a violation variable per hard rule instance. Counts and contracted hours get `over`/`under` integers in hours or shifts. Successions get a match literal that is allowed to be true. Never relaxed: leave, one shift a day, `avoid_solution`. Stage 1 minimises `H × violations + M × short` with `H > M × total slots`. Stage 2 as in D1.
- Why stages: one solve with huge weights was 10 to 25 times slower in section 4. Timefold calls weight folding "broken".
- Cheap first step: reuse the l3m enforcement literals and minimise the weighted count of literals set false. The proto names this as the way to a minimal set. It drops whole rule units, so the roster is coarse. Per-instance slack is the full version.
- Assistant data: `{"mode": "least_infeasible", "short_slots": [...], "broken_rules": [{"preference_index": 12, "rule_id": "successions:uid-7", "tier": "H", "count": 2, "where": [{"person": "P3", "date": "2026-10-09"}]}], "stage1_optimal": true, "seconds": 4.1}`. The web maps indices to rule ids with the l3m `preferenceSources` map.

**D3. Roster scorer (what-if).** Effort M, after D2. Priority P2.
- Compute: the D2 relaxed model with every cell fixed to a given roster. The solve only propagates. It returns each rule's violations and the soft points per vjbv tier.
- Use: explain a feasible score per tier (vjbv §8), and score a roster the user edited by hand, even an infeasible one. This is Timefold's `analyze` without Enterprise.
- Cost: presolve plus propagation, expected well under 1 s [UNCONFIRMED: not timed].
- Assistant data: `{"score": 1078, "feasible": false, "hard_broken": [...], "short_slots": [...], "tiers": {"1": {"lost": 0}, "3": {"lost": 40, "items": 2}, "5": {"earned": 1118}}}`.

**D4. Recommend a nurse for a slot.** Effort M. Priority P3.
- Evaluate mode (Timefold's greedy fit): for each qualified nurse, put her in the slot in the current roster and run D3. It gives an exact score diff and the rules it breaks. No knock-on repair.
- Repair mode for the top 5: fix `x[n,d,s] = 1`, hint the current roster, unfix a window of ±3 days around the slot, cap 2 s each. Toy: 20 candidates in 2.54 s at 2 workers. On tc1 cap the whole call at 10 s.
- Assistant data: `{"slot": {"date": "2026-10-10", "shift": "N"}, "candidates": [{"person": "P4", "mode": "repair", "feasible": true, "score_delta": -20, "changes": 3, "broken": [{"rule_id": "requests:P4-off-10-10", "delta": -20}]}]}`. Like Timefold, accepting one candidate voids the rest.

**D5. Pinning and low-churn re-plan.** Effort S. Priority P3.
- Compute: fix published cells with `x == v`. Hint the draft cells with the last roster. Add a soft penalty per changed cell at a vjbv tier the user picks.
- Cost: toy pinned re-solve 0.04 s. Pins shrink the search.
- Assistant data: `{"pinned_days": ["2026-10-01", "2026-10-07"], "changed_cells": 5, "change_penalty": 100}`.

**D6. Rolling window (history, published, draft).** Skip for now. History already works through `person.history`, and wards plan one 28-day period. The trigger to add it is a ward request for rolling re-plans.

**Gates.**
- G3: time D1 and D2 stage 1 and 2 on the 12 real infeasible ward variants and the 87-person ward, on 2 cores. The pass mark is a p95 of 10 s or less.
- G4: on every feasible real fixture, check that D2 stage 2 returns the normal optimum with 0 violations. This matches experiment finding 1.

## Unconfirmed items

- Community status of `HardMediumSoftScore`, `allowsUnassigned`, pinning and `ProblemChange` is inferred from the Enterprise feature table, which does not list them. We read `commercial-editions.adoc` and each feature page for the `_only-enterprise` include.
- CP-SAT has no native multi-level objective. We read `cp_model.proto` v9.15.
- Employee Shift Scheduling pricing. We read the recommendations and priority pages.
- D3 cost and all real-ward timings. Only the toy experiment exists.

## Sources

- Timefold score and modelling: [score overview](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/overview), [common patterns](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/common-patterns), [modeling planning problems](https://docs.timefold.ai/timefold-solver/latest/domain-modeling/modeling-planning-problems), [understanding the score](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/understanding-the-score).
- Timefold change handling: [real-time](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/real-time-planning), [continuous](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/continuous-planning), [non-disruptive](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/non-disruptive-replanning), [recommendation API](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/recommendation-api).
- Timefold editions: [Enterprise Edition](https://docs.timefold.ai/timefold-solver/latest/commercial-editions/commercial-editions), [multithreaded solving](https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/multithreaded-solving), [upgrade from v1](https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1).
- Timefold docs source: [docs/src/modules/ROOT/pages](https://github.com/TimefoldAI/timefold-solver/tree/main/docs/src/modules/ROOT/pages) at `3d233796`.
- Timefold GitHub: [discussion #1698](https://github.com/TimefoldAI/timefold-solver/discussions/1698), [discussion #1617](https://github.com/TimefoldAI/timefold-solver/discussions/1617), [v1.25.0](https://github.com/TimefoldAI/timefold-solver/releases/tag/v1.25.0).
- Quickstart: [employee-scheduling](https://github.com/TimefoldAI/timefold-quickstarts/tree/master/java/employee-scheduling).
- Employee Shift Scheduling: [priority and optional shifts](https://docs.timefold.ai/employee-shift-scheduling/latest/shift-service-constraints/priority-and-optional-shifts), [recommendations](https://docs.timefold.ai/employee-shift-scheduling/latest/recommendations).
- OR-Tools v9.15: [cp_model.proto](https://github.com/google/or-tools/blob/v9.15/ortools/sat/cp_model.proto), [sat_parameters.proto](https://github.com/google/or-tools/blob/v9.15/ortools/sat/sat_parameters.proto), [model.md](https://github.com/google/or-tools/blob/v9.15/ortools/sat/docs/model.md). [CP-SAT primer](https://github.com/d-krupke/cpsat-primer/blob/main/chapters/coding_patterns.md).
- Local: `/tmp/wave/timefold/overconstrained/RESULTS.md`.
