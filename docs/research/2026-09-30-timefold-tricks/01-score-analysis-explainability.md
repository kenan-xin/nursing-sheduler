# Timefold score analysis and explainability, mapped to CP-SAT

Date: 2026-09-30. Scope: Timefold Solver score analysis, and how to copy its ideas on top of our OR-Tools CP-SAT 9.15 core. We keep CP-SAT. Solver choice is covered in [solver alternatives 01-03][int-alt]. Infeasible cores are covered in the [infeasible-core spec][int-l3m]. Weight tiers are covered in the [priority ladder spec][int-vjbv].

Our code line numbers are from the `damselfish` worktree at `core/nurse_scheduling/` (HEAD 44f7b773).

## Answer

1. Timefold explains a score as a list of constraints. Each constraint has a weight, a total score and a list of matches. Each match has a score and a justification object. That is the whole idea. It is a keyed ledger of penalty terms.
2. In Timefold 2.x (latest 2.7.0) score analysis, solution diff and recommendations are Enterprise-only. `Indictment` and `indictWith()` are gone with no replacement. In 1.x (1.34.0) all of these are open source.
3. Our core already has most of the parts. Every soft term goes through one function, `utils.add_objective` (`utils.py:32-46`). Every call site also appends a `Report` with the term variable (`preference_types.py:233-234, 265-266, 390-391, 535-536` and others). The core reads them after the solve, but only into debug logs (`scheduler.py:386-396`). What is missing is the weight and a structured key per term.
4. A local toy on ortools 9.15.6755 with 2 workers read back a 2,607-term ledger in 1.1 ms. So attribution costs nothing next to a 15 s solve.
5. The key gap is not code. It is design: a stable justification key (rule id, nurse, date, shift) so that analysis, indictments and diffs all line up.

## 1. SolutionManager: analyze, explain, update

- `analyze()` returns a `ScoreAnalysis`. The docs say it is "a JSON-friendly representation of the score, breaking down the score into individual constraints" ([understanding the score][d-uts]).
- `explain()` returned a `ScoreExplanation` in 1.x. Its Javadoc says it holds "ConstraintMatchTotals and Indictments necessary to explain the quality of a particular Score" ([1.x ScoreExplanation.java][s-se1]). The 1.x docs limit it to use "for processing indictments" ([1.x understanding the score][d-uts1]).
- 2.x removes `ScoreExplanation`. The guide says to "Use `ScoreAnalysis` instead, which is now provided exclusively by _Timefold Solver Enterprise Edition_" ([upgrade guide][d-up]).
- `update()` recalculates the score and shadow variables of a solution. The Javadoc: "Updates the given solution according to the SolutionUpdatePolicy" ([2.x SolutionManager.java][s-sm2]). It carries no Enterprise note.
- `ScoreAnalysisFetchPolicy` has three values ([1.x ScoreAnalysisFetchPolicy.java][s-fp1]):
  - `FETCH_ALL`: "All included ConstraintAnalysis objects include full match analysis."
  - `FETCH_SHALLOW`: "provides neither match analysis nor match count."
  - `FETCH_MATCH_COUNT`: counts only, for "too many matches to send over the wire". The enum Javadoc says "If unsure, pick FETCH_MATCH_COUNT."

## 2. ConstraintMatch, ConstraintMatchTotal, ConstraintAnalysis, MatchAnalysis

- A match is one unit of score impact. "A _Constraint match_ is created every time a constraint causes a change to the score" ([1.x understanding the score][d-uts1]).
- `ConstraintMatchTotal` is the per-constraint sum. "The sum of ConstraintMatchTotal#getScore() equals getScore()" ([1.x ScoreExplanation.java][s-se1]). Its weight is "independent to the state of the planning variables" ([1.x ConstraintMatchTotal.java][s-cmt1]). In 2.x it moved to an `impl` package ([2.x tree][s-tree2]).
- `ConstraintAnalysis` is the record `(constraintRef, weight, score, matches, matchCount)` ([1.x ConstraintAnalysis.java][s-ca1]). Without analysis, `matches` is null ("analysis not available"). A constraint with no matches gets an empty list.
- `MatchAnalysis` is the record `(constraintRef, score, justification)` ([1.x MatchAnalysis.java][s-ma1]).
- "Zero-weight constraints are never included" and the map is "ordered first by ConstraintAnalysis#weight(), then by ConstraintAnalysis#constraintRef()" ([1.x ScoreAnalysis.java][s-sa1]).

## 3. Justifications

- A justification is "user-defined objects that implement the ConstraintJustification interface", "typically created from Constraint Streams' `justifyWith(…)`" ([understanding the score][d-uts]).
- Default: "each constraint is justified with DefaultConstraintJustification" and "the final tuple makes up the indicted objects" ([score calculation][d-sc]). It holds the impact and a fact list (`getFacts()`) ([1.x DefaultConstraintJustification.java][s-dcj1]).
- Equality is the identity of a match. "If two instances of this class are equal, they are considered to be the same justification" ([1.x ConstraintJustification.java][s-cj1]). The same file says implementations "must not use Score for equals".
- `justifyWith` is not marked Enterprise in the 2.x docs ([score calculation][d-sc]). But in 2.x the only reader of justifications is `ScoreAnalysis`, which is Enterprise.

## 4. Indictments

- 1.x: `indictWith()` sets "a custom function to mark any object returned by it as responsible for causing the constraint to match". Each object "will become an Indictment and be available as a key in getIndictmentMap()" ([1.x UniConstraintBuilder.java][s-ucb1]).
- "Each Indictment is the sum of all constraints" that involve its object. Also "The sum of all the Indictment.getScoreTotal() differs from the overall score", because one match can indict two objects ([1.x understanding the score][d-uts1]).
- 2.x removes `Indictment`. "There is no replacement type for `Indictment`" ([upgrade guide][d-up]). The upgrade guide says to "filter ConstraintAnalysis.matches() by justification type" instead.

## 5. Score levels

- Types in 2.7.0: `SimpleScore`, `HardSoftScore` ("Recommended"), `HardMediumSoftScore`, `BendableScore`, each with a `BigDecimal` variant ([score overview][d-so]). "The Long score variants were folded into their base score types" in 2.x ([upgrade guide][d-up]). 1.x still has `HardSoftLongScore` and friends ([1.x tree][s-tree1]).
- Levels compare in order. "The levels of two scores are compared lexicographically" and "If those differ, the remaining score levels are ignored" ([score overview][d-so]).
- Medium: "Higher medium values take precedence over soft values irrespective of the soft value" ([score overview][d-so]).
- Overconstrained planning: set `@PlanningVariable(allowsUnassigned = true)` and "Add a score constraint at the appropriate level (usually medium, between hard and soft) to penalize each unassigned entity" ([common patterns][d-cp]). With that penalty, the solver will "only leave a shift unassigned" as the cheapest option. Without the penalty, "a solution with **all** entities unassigned scores better than one with any hard constraint violations".

## 6. Score diff

- "Think of `diff(…)` as a subtraction operation, where the second solution is subtracted from the first solution" ([understanding the score][d-uts]).
- Match identity is the justification: matches are equal for equal "justification objects". A match only in the second analysis is "included in the diff as negative" ([1.x understanding the score][d-uts1]).
- In the 1.x code, a constraint stays in the diff for a changed weight, score or match set. Constraints with matches "exactly the same" drop out. A pair of analyses with and without matches throws an exception ([1.x ScoreAnalysis.java][s-sa1], `diff()` at lines 169-235).
- A separate `SolutionManager.diff(old, new)` returns a `PlanningSolutionDiff` of changed entities. It is a preview feature and "exclusive to Timefold Solver Enterprise Edition" ([understanding the score][d-uts]).

## 7. Quickstart and Platform: REST and JSON

- The employee-scheduling quickstart (solver 2.7.0) exposes `PUT /schedules/analyze` with an optional `fetchPolicy` query param. It returns `solutionManager.analyze(problem)` ([EmployeeScheduleResource.java][q-res]).
- The UI (`app.js`) sorts constraints by hard, then medium, then soft impact. It shows a table: icon, constraint, type, "# Matches", weight, score. A red triangle marks a broken hard constraint. A green check marks zero matches ([app.js][q-js]).
- On error the UI says "Score Analysis requires Timefold Solver Enterprise Edition, which is not on the classpath" ([app.js][q-js]). The quickstart pom has an `enterprise` Maven profile for this ([pom.xml][q-pom]).
- There is no nurse rostering quickstart. The only shift use case is `use-cases/employee-scheduling` ([quickstarts tree][q-tree]).
- 1.x JSON shape, from `ScoreAnalysisJacksonSerializer` ([1.x serializer][s-ser1]). It writes `score`, `initialized`, and a `constraints` array. Each item has `package`, `name`, `weight`, `score`, optional `matches` (each `score` + `justification`) and `matchCount` (left out for `-1`). A default justification serialises as its fact list.

```json
{"score":"-2hard/-40soft","initialized":true,
 "constraints":[{"package":"org.acme","name":"Unavailable employee","weight":"-1hard/0soft","score":"-2hard/0soft",
   "matches":[{"score":"-2hard/0soft","justification":[{"id":"shift-11"},{"name":"Beth"}]}],"matchCount":1}]}
```

(The field names are from the serializer. The values are ours.) The 2.7.0 `app.js` reads `constraintAnalysis.id`, not `name`. Unconfirmed: the exact 2.x Enterprise JSON. The 2.x serializer is not in the open repo tree ([2.x tree][s-tree2]).
- Timefold Platform Employee Shift Scheduling has `GET /v1/schedules/{id}/score-analysis?includeJustifications=true` and `POST /v1/schedules/score-analysis`. Its example shows `"score": "0hard/-100medium/-600soft"` and a custom justification with `"shift"` and `"employee"` fields ([Platform score analysis][p-sa]).

## 8. A data shape for the LLM

Proposal. Keep Timefold's shape, add ward terms, drop Java noise. Rule ids come from the infeasible-core spec's `preferenceSources` (§4.7). Scores are ints. Matches are capped per constraint, like `summarize(5)`. The docs warn that the `summarize()` string is "for debugging purposes only" ([understanding the score][d-uts]), so the assistant gets JSON, not text.

```json
{"run":"r-812","status":"OPTIMAL","score":{"hard":0,"medium":-2,"soft":-340},
 "constraints":[{"rule":"card:successions:u7","label":"Full day off after sleep day","tier":1,"weight":-1000,
   "score":0,"matchCount":0},
  {"rule":"card:counts:u3","label":"Balance nights","tier":4,"weight":-4,"score":-36,"matchCount":3,
   "matches":[{"score":-16,"nurse":"n4","detail":{"actual":8,"target":6}}],"truncated":2}],
 "byNurse":{"n4":{"soft":-56,"top":["card:counts:u3","req:n4:2026-11-03:off"]}},
 "byDate":{"2026-11-03":{"medium":-1,"top":["card:requirements:u1"]}}}
```

## 9. Community vs Enterprise

| Feature | 1.x Community (Apache-2.0) | 2.x Community | 2.x Enterprise | Source |
|---|---|---|---|---|
| `justifyWith`, match weights | yes | yes | yes | [score calculation][d-sc] |
| `SolutionManager.update()` | yes | yes | yes | [2.x SolutionManager][s-sm2] |
| `ScoreAnalysis`, `analyze()`, `diff()` | yes | no | yes | [2.x ScoreAnalysis.java][s-sa2] |
| `explain()`, `ScoreExplanation`, `Indictment`, `indictWith` | yes | removed | removed | [upgrade guide][d-up] |
| Jackson ScoreAnalysis serializer | yes | no (moved) | yes (`...-enterprise-quarkus-jackson`) | [1.x serializer][s-ser1], [pom.xml][q-pom] |
| Solution diff (`PlanningSolutionDiff`) | preview | no | yes, preview | [understanding the score][d-uts] |
| Recommendations (`recommendAssignment`) | yes (`recommendFit`) | no | yes | [upgrade guide][d-up] |
| Multithreaded solving, nearby selection, partitioned search, constraint profiling | no | no | yes | [commercial editions][d-ce] |
| HardMediumSoft, Bendable scores | yes | yes | yes | [score overview][d-so] |
| Platform "Score analysis & constraint UI", "What-if scenarios", "Efficiency X-Ray" | n/a | n/a | Platform Flow / Horizon tiers | [pricing][p-pr] |

- The Timefold pricing page lists "Explainability", "Score Analysis" and "Recommendations" under Enterprise only ([pricing][p-pr]). It shows no prices.
- The repo licence is Apache 2.0 ([LICENSE.txt][s-lic]).
- In 1.x Community, `ScoreAnalysis` is a concrete record with a working `diff()` in `core` ([1.x ScoreAnalysis.java][s-sa1]).
- Unconfirmed: whether 1.x `recommendFit` needed Enterprise. I read only the 2.x upgrade guide, which says the API "now requires" Enterprise.

## 10. Mapping to CP-SAT

All API names are checked against `ortools/sat/python/cp_model.py` at tag v9.15. The file in the pip wheel 9.15.6755 is byte-identical ([cp_model.py v9.15][o-cpm]).

| Timefold idea | CP-SAT equivalent | Our core today |
|---|---|---|
| Constraint weight | The integer coefficient in `model.maximize(...)` / `minimize(...)` | `ctx.objective += weight * expression` (`utils.py:46`), maximised at `scheduler.py:336` |
| Match | One BoolVar or IntVar term (slack, `is_match`, squared distance) | Built per call site, one `Report(...)` each (`report.py:24-28`, `context.py:66`) |
| Match score | `solver.value(term) * weight`. `value()` "Returns the value of a linear expression after solve" ([cp_model.py L1787][o-cpm]) | `get_value()` (`solver_ortools_cp_sat.py:169-175`) |
| Justification | A dict key per term: rule id, nurse, date, shift | Only in the `Report.description` string, like `pref_{i}_d_{d}_p_{p}` (`preference_types.py:267`) |
| Hard constraint | A plain constraint, or weight ±inf | `add_objective` turns ±inf into `add_constraint` (`utils.py:41-44`) |
| Medium level | A slack var with a tier coefficient, or a second solve | None. Tiers are weights ([priority ladder][int-vjbv] §4-5) |
| Incumbent analysis | Read the ledger in the solution callback | `get_value` already reads from the callback (`solver_ortools_cp_sat.py:171-174`) |
| Infeasible explanation | `add_assumptions`, then `sufficient_assumptions_for_infeasibility()`, which "Returns the indices of the infeasible assumptions" ([cp_model.py L1948][o-cpm]) | Planned in the [infeasible-core spec][int-l3m] |

- CP-SAT has no score levels. The docs give no lexicographic objective. Tiers are big weights, or one solve per tier with the upper tier fixed. Unconfirmed: a native multi-objective mode in 9.15. I searched `ortools/sat/docs/*.md` at v9.15 for "lexicograph", "hierarch" and "multi-objective" and found nothing ([sat docs][o-docs]).
- Assumptions need one worker. "Solving with assumptions is not compatible with parallelism. Therefore, the number of workers must be set to 1" ([troubleshooting.md][o-ts]). The core is "minimized but not guaranteed to be minimal" (same source). The infeasible-core spec already handles both (§3, §4.3).

### Local toy (measured)

Script: `/tmp/wave/timefold/score-analysis/ledger_toy.py` and `stress.py`. Toy model: 3 shifts, a cover shortfall slack (medium), night-then-day, day-off wishes, `|count - target|` fairness, a 5-in-7 hard cap. `num_workers=2`, 15 s limit, `random_seed=0`. The host has 32 cores, so this is not the 2-core server. Toy scale only.

| Size (nurses x days) | Status | Ledger terms | Fired matches | Solve | Ledger read-out | Diff of 2 runs | JSON |
|---|---|---|---|---|---|---|---|
| 5 x 7 | FEASIBLE (hit 15 s) | 61 | 1 | 15.0 s | 0.07 ms | 0.03 ms | 0.5 KB |
| 20 x 28 | OPTIMAL | 664 | 73 | 0.21 s | 0.31 ms | 0.23 ms | 5.7 KB |
| 87 x 28 | OPTIMAL | 2,607 | 146 | 12.3 s | 1.13 ms | 0.41 ms | 11.0 KB |

The read-out is a Python loop of `solver.value(term)`. Our real model has more terms per rule (successions per pattern and date), so expect 10x the terms. At the measured rate that is still about 10 ms. Unconfirmed on our real wards.

## Implement on CP-SAT

**(a) Keyed penalty ledger + ScoreAnalysis-like JSON. P1, effort S.**
- What: one ledger row per soft term: `(rule_index, key, weight, expr)`. After the solve, read each value and group by rule.
- How: `utils.add_objective` gains `key: dict | None = None` and appends `(ctx.current_preference, key, weight, expression)` to `ctx.objective_terms`. `scheduler.py:309` sets `ctx.current_preference = i` (the same hook as the l3m `preference_scope`). The 10 call sites in `preference_types.py` pass the `d`, `s`, `p` they already have. Keep this a v2 core patch in the sync manifest, like l3m.
- Cost: zero during the solve (no new variables or constraints). About 1-10 ms after the solve. A total check `sum(ledger) == objective_value` catches missed terms.
- Assistant receives: the §8 JSON with the top N matches per rule, plus `matchCount`.
- Map `rule_index` to the web rule id with l3m's `preferenceSources`. Do not build a second mapping.

**(b) Per-nurse / per-date indictment view. P1, effort S (after a).**
- What: Timefold 1.x `getIndictmentMap`, rebuilt as a group-by over ledger matches by `nurse` and by `date`. One match with two nurses (pairing) counts for both, as in Timefold.
- How: pure Python or TypeScript over the ledger. No solver work.
- Cost: under 1 ms.
- Assistant receives: `{"byNurse":{"n4":{"soft":-56,"top":["card:counts:u3"]}},"byDate":{"2026-11-03":{"medium":-1}}}`. The UI can colour roster cells from the same data.

**(c) Score diff between two runs. P2, effort S (after a).**
- What: Timefold `diff()` semantics. `this - other`. Match identity is the justification key.
- How: key each match by `(rule_id, nurse, date, shift)`. Output per rule: score delta, added matches, removed matches. Skip rules with no change. Store the last ledger with the run record. Use it for "before vs after applying the assistant's proposal".
- Cost: under 1 ms (measured 0.41 ms at 146 matches).
- Assistant receives: `{"score":{"soft":+48},"changes":[{"rule":"req:n2:2026-11-05:off","added":[],"removed":[{"nurse":"n2","date":"2026-11-05","score":20}]}]}`.
- Rule ids must be stable across edits. A new rule shifts every index-based id after it. So diff only runs with the l3m source ids, never raw preference indices.

**(d) Hard / medium / soft tiering for overconstrained planning. P2, effort M.**
- What: a best-effort roster for a strict model that is INFEASIBLE, like Timefold's `allowsUnassigned` + medium penalty. Staffing minimums become medium: a shortfall slack per (date, shift, group) with a tier weight above all soft weights.
- How: on INFEASIBLE, rebuild with `requiredNumPeople` as `actual + short >= required` and a tier weight on `short`. Report `score.medium = -sum(short)` from the ledger. Weight sizes come from the [priority ladder][int-vjbv] §5, which already rules out strict lexicographic weights. Leave, contracted hours and hard rest rules stay hard.
- Cost: one extra solve on the infeasible path only, within the remaining timeout. Normal runs pay nothing.
- Assistant receives: `{"status":"RELAXED","score":{"hard":0,"medium":-3,"soft":-410},"uncovered":[{"date":"2026-11-03","shift":"N","missing":1}]}`.
- Upstream fit: needs a flag in the requirement handler (`preference_types.py:107-233`). This is more core diff than (a). Ask the user before adding it.

**(e) Infeasible explanation hook. P1, effort per the spec.**
- What: name the clashing rules. Do not redesign. Use the [infeasible-core spec][int-l3m] as written (§4.1-4.7): one assumption literal per rule unit, a second one-worker solve with no objective, deletion shrink, `InfeasibleCore` callback.
- Tie-in with (a): the core returns `preference_indices`. The ledger uses the same index and the same `preferenceSources` ids. So one lookup table serves both, and the assistant sees one vocabulary.
- Tie-in with (d): after a core, run (d) to show "if staffing minimums bend, 3 shifts go uncovered". That ranks remedies by real cost, not by guess.
- Cost: per the spec, a 30 s budget with 10 s per solve (§4.4, gate G2 unmeasured).
- Assistant receives: `{"status":"INFEASIBLE","core":{"rules":["card:counts:u2","req:n1:2026-10-03..09:leave"],"minimal":true},"relaxed":{"medium":-3}}`.

Skipped: recommendations (Timefold `recommendAssignment`). Our repair path already tests candidate fixes by re-solving copies. Add a "best nurse for this empty shift" API on user demand.

## Unconfirmed

- The 2.x Enterprise JSON field names (the quickstart reads `id`). I read the 2.7.0 `app.js` and the 2.x tree. The serializer is not public.
- A native lexicographic objective in CP-SAT 9.15. I searched the v9.15 `sat/docs` pages.
- Ledger read-out time on our real wards and on the 2-core server. The toy ran on a 32-core host with `num_workers=2`.

## Sources

[int-alt]: /home/kenan/work/nursing-sheduler.docs-solver-alternatives-research/docs/research/2026-09-28-solver-alternatives/
[int-l3m]: /home/kenan/work/nursing-sheduler.docs-l3m-infeasible-core-spec/docs/superpowers/specs/2026-09-27-infeasible-core-design.md
[int-vjbv]: /home/kenan/work/nursing-sheduler.docs-vjbv-priority-ladder-spec/docs/superpowers/specs/2026-09-29-priority-ladder-design.md
[d-uts]: https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/understanding-the-score
[d-uts1]: https://docs.timefold.ai/timefold-solver/1.x/constraints-and-score/understanding-the-score
[d-up]: https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1
[d-sc]: https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/score-calculation
[d-so]: https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/overview
[d-cp]: https://docs.timefold.ai/timefold-solver/latest/domain-modeling/common-patterns
[d-ce]: https://docs.timefold.ai/timefold-solver/latest/commercial-editions/commercial-editions
[p-pr]: https://timefold.ai/pricing
[p-sa]: https://docs.timefold.ai/employee-shift-scheduling/latest/user-guide/score-analysis
[s-sa1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/score/analysis/ScoreAnalysis.java
[s-sa2]: https://github.com/TimefoldAI/timefold-solver/blob/main/core/src/main/java/ai/timefold/solver/core/api/score/analysis/ScoreAnalysis.java#L33
[s-ca1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/score/analysis/ConstraintAnalysis.java#L29-L49
[s-ma1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/score/analysis/MatchAnalysis.java#L19-L20
[s-fp1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/solver/ScoreAnalysisFetchPolicy.java#L7-L32
[s-se1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/score/ScoreExplanation.java
[s-cmt1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/score/constraint/ConstraintMatchTotal.java
[s-dcj1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/score/stream/DefaultConstraintJustification.java
[s-cj1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/score/stream/ConstraintJustification.java
[s-ucb1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/core/src/main/java/ai/timefold/solver/core/api/score/stream/uni/UniConstraintBuilder.java#L21-L48
[s-ser1]: https://github.com/TimefoldAI/timefold-solver/blob/1.x/persistence/jackson/src/main/java/ai/timefold/solver/jackson/api/score/analysis/ScoreAnalysisJacksonSerializer.java
[s-sm2]: https://github.com/TimefoldAI/timefold-solver/blob/main/core/src/main/java/ai/timefold/solver/core/api/solver/SolutionManager.java#L30
[s-tree1]: https://github.com/TimefoldAI/timefold-solver/tree/1.x/core/src/main/java/ai/timefold/solver/core/api/score/buildin
[s-tree2]: https://github.com/TimefoldAI/timefold-solver/tree/main/core/src/main/java/ai/timefold/solver/core/impl/score/constraint
[s-lic]: https://github.com/TimefoldAI/timefold-solver/blob/main/LICENSE.txt
[q-tree]: https://github.com/TimefoldAI/timefold-quickstarts/tree/stable/use-cases
[q-res]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/java/org/acme/employeescheduling/rest/EmployeeScheduleResource.java#L93-L106
[q-js]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/src/main/resources/META-INF/resources/app.js#L303-L378
[q-pom]: https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/use-cases/employee-scheduling/pom.xml
[o-cpm]: https://github.com/google/or-tools/blob/v9.15/ortools/sat/python/cp_model.py#L1668-L1952
[o-ts]: https://github.com/google/or-tools/blob/v9.15/ortools/sat/docs/troubleshooting.md#using-assumptions-to-explain-infeasibility
[o-docs]: https://github.com/google/or-tools/tree/v9.15/ortools/sat/docs

- Internal: [solver alternatives][int-alt], [infeasible-core spec][int-l3m], [priority ladder spec][int-vjbv].
- Timefold docs: [understanding the score 2.7][d-uts], [1.x][d-uts1], [upgrade guide][d-up], [score calculation][d-sc], [score overview][d-so], [common patterns][d-cp], [commercial editions][d-ce], [pricing][p-pr], [Platform score analysis][p-sa].
- Timefold source: [ScoreAnalysis 1.x][s-sa1], [2.x][s-sa2], [serializer 1.x][s-ser1], [SolutionManager 2.x][s-sm2], [quickstart resource][q-res], [app.js][q-js].
- OR-Tools: [cp_model.py v9.15][o-cpm], [troubleshooting.md][o-ts].
