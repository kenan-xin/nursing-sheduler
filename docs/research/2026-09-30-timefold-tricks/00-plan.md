# Timefold ideas on CP-SAT: one combined plan

Date: 2026-09-30. Status: plan for user review. No code changes until the user approves.
Inputs: reports [01](01-score-analysis-explainability.md), [02](02-overconstrained-never-infeasible.md), [03](03-cpsat-infeasibility-explanation.md), [04](04-cpsat-autotune.md), the l3m infeasible-core spec (`2026-09-27-infeasible-core-design.md`) and the vjbv priority ladder spec (`2026-09-29-priority-ladder-design.md`).

Confidence: 7.0/10

What raises it: each piece ran on OR-Tools 9.15.6755 in a toy. The core already sends every soft term through one function. I re-checked the one finding that breaks l3m (assumptions force one worker). What lowers it: nobody timed any step on a real 28-day ward on 2 cores. The relaxed solve (§4.3) can be slow on the 87-person ward. To show a roster that breaks a must is a product choice that the user did not make yet.

## 1. Goal

For an INFEASIBLE run, the assistant names the rules that clash, in ward words. Example: "3 night nurses are needed on 14 Oct, but only 2 can work: Ana and Ben are on leave." It then offers ranked fixes, and the solver proves the best ones. For a feasible run, it says where the points went (per rule, per nurse, per date) and what changed since the last run. We stay on CP-SAT. Solver choice is closed (solver-alternatives 01-03).

## 2. Code facts this plan rests on (checked in this worktree)

| Fact | Where |
|---|---|
| Every soft term goes through one function. `inf` / `-inf` become `add_constraint`. A finite weight does `ctx.objective += weight * expression`. The weight is known here, but no rule index or key is stored. | `core/nurse_scheduling/utils.py:35-49` |
| `Report` holds only `description`, `variable`, `skip_condition`. No weight, no nurse, no date. | `core/nurse_scheduling/report.py:26-29` |
| Reports are read after the solve, but only into debug logs. | `core/nurse_scheduling/scheduler.py:473-479` |
| The rule loop (the l3m scope hook) and the objective. | `scheduler.py:380` loop, `scheduler.py:412` `set_objective(..., maximize=True)` |
| 10 `add_objective` call sites. `Report(...)` at 12 places. | `core/nurse_scheduling/preference_types.py` (for example `:152`, `:187`, `:293`, `:399`, `:554`) |
| Shipped tuning: `extra_subsolvers.append("max_lp_sym")`. Deterministic mode sets `num_workers = 1`, which drops it. | `solver_ortools_cp_sat.py:42-43`, `:106-109` |
| `add_constraint` / `add_bool_or` are plain today. l3m is not built yet (no `preference_scope` anywhere in `core/`). | `solver_ortools_cp_sat.py:56-62` |
| `utils.py` is `verbatim` in the sync manifest. `solver_ortools_cp_sat.py` and `scheduler.py` are already `patched`. | `core/upstream-patches/manifest.toml:108`, `:102`, `:60` |
| `rankRepairOptions(state, findings, {runInfeasible})` has no core input. Evidence is only `"static_check" \| "hypothesis"`. At most 3 options, 5 diagnostic copies. | `web/lib/ai/assistant/repair-options.ts:1074-1089`, `:98`, `playbook.ts:449` (`MAX_OPTIONS = 3`), `web/lib/ai/diagnostic/search-record.ts:34` (`MAX_DIAGNOSTIC_CANDIDATES = 5`) |
| `REPAIR_ORDER.unexplained` = contracted hours, hard request, count rule, rest rule. | `web/lib/ai/assistant/playbook.ts:438-443` |
| **With assumptions in the model, 9.15 forces 1 worker, even with an objective.** I re-ran it for this plan (`taskset -c 0,1`, `num_workers = 2`). The log says "Forcing sequential search as assumptions are not supported in multi-thread" and "Starting search ... with 1 workers". | OR-Tools `cp_model_solver_helpers.cc` L2179-2191 at v9.15 (report 03 §2) |
| At 1 worker, large87 finds **no roster** in 15 s or 60 s. | `/tmp/wave/bench/RESULTS.md`, large87 table |

## 3. Timefold: what we copy, what we skip

| Timefold feature | Edition | Our move |
|---|---|---|
| `ScoreAnalysis`: constraint, weight, score, matches, justification | 1.x Community, 2.x **Enterprise** | **Copy** as the penalty ledger (§4.1) |
| `Indictment` per entity | 1.x Community, removed in 2.x | **Copy** as a group-by nurse and by date over the ledger |
| `ScoreAnalysis.diff` | 1.x Community, 2.x **Enterprise** | **Copy** as the run diff, keyed by stable rule id |
| `HardMediumSoftScore` + `allowsUnassigned` (overconstrained planning) | Community (inferred) | **Copy** as short-slot variables, only in the backup solve (§4.3) |
| `recommendAssignment` (greedy fit) | 2.x **Enterprise** | **Copy** as what-if scorer + recommend-a-nurse (§4.4) |
| Non-disruptive replanning, pinning | Community pattern | **Copy** as hint + churn penalty. Pins by fixed domain |
| "Score folding" (huge weights in place of levels) | Timefold calls it broken | **Skip**. Two-stage solves instead (vjbv §5.1 agrees) |
| Dummy / agency nurse rows | Timefold calls it an antipattern | **Skip**. Use a slack count per slot. "Borrow a temporary nurse" is a remedy label on that slack |
| Multithreaded, nearby, partitioned search | **Enterprise** | **Skip**. CP-SAT has its own portfolio |
| Continuous planning windows | Pattern | **Skip** for now. `person.history` covers carry-in |
| Timefold itself | Python beta dead since v1.25.0 | **Skip** (Java only) |

Timefold cannot say why something did not happen (discussion #1617). CP-SAT with guard literals can: an infeasibility proof plus a core is a real "why not". That is our edge.

## 4. Architecture

One model build, three kinds of solve, one vocabulary. The vocabulary is the l3m `PreferenceSource` rule id (card uid or request block). The ledger, the core, the correction set and the diff all use it. No second mapping.

### 4.1 Penalty ledger (feasible runs) + run diff

- `add_objective(ctx, weight, expression, key=None)` appends `(ctx.current_preference, key, weight, expression)` to `ctx.objective_terms`. `key` = `{nurse, date, shift}` from the call site (the 10 sites already have `d`, `s`, `p`). `scheduler.py:380` sets `ctx.current_preference = i`, the same hook as l3m's scope.
- After the solve, read `solver.value(expr) * weight` for each term. Keep non-zero terms. Assert `sum(ledger) == objective`. A mismatch means a missed call site, and the test fails.
- Group by rule (ScoreAnalysis), by nurse and by date (indictments). The web adds the vjbv tier with `tierOf(card)`. This gives the vjbv §8 line "Lost: 2 nurse wishes (40)".
- Diff: store the last ledger with the run record. Key each match by `(rule_id, nurse, date, shift)`. Output per rule: score delta, added, removed. Only by rule id, never by raw index (a new card shifts every index).
- Cost: no new variables. Toy read-out was 1.1 ms for 2,607 terms.

### 4.2 Infeasible: core solve, then a ranked correction set

1. **Guards.** l3m literals, one per rule unit (grouped request blocks). Staffing requirements get one per `(unit, date, shift)`. Then a core can say which night is short.
2. **Normal run: no assumptions.** Pin every guard by domain `[1, 1]`. Presolve removes them. Never call `add_assumptions` in the normal run: it forces 1 worker, and large87 then finds nothing.
3. **Core solve** (only after INFEASIBLE): a copy with guard domains reset to `[0, 1]`, no objective, assumptions on, 1 worker. Read `sufficient_assumptions_for_infeasibility()`. Shrink by deletion, deleting the costliest-to-change first (leave, staffing, caps, then requests), so the surviving core names cheap rules. Cap `min(10 s, remaining)`, 3 s per solve. At timeout, return `minimal: false`.
4. **Correction set (MCS) solve**: guards free, no assumptions, 2 workers. Minimise the sum of relax costs of guards set false. Never-relaxed rules get no guard in this solve. The result is the cheapest set of changes that makes the roster feasible, plus a witness roster that proves it. Block that set and solve twice more for 3 ranked remedies.

Relax costs inside tier H (report 03 §5, follows vjbv §10 order):

| Rule kind | Remedy | Cost |
|---|---|---|
| hard request block | soften to a tier-3 wish | 10 |
| editable cap (not an exact count) | relax by 1 | 20 |
| staffing minimum on a date/shift | run one short | 100 per place |
| extra staff | borrow a temporary nurse | 200 per shift |
| leave | move leave, with the nurse's agreement | 1000 |
| sleep day, max 4 nights, max 6 days, contracted hours, safety floor | never relaxed | no guard |

A MUS says why. An MCS says what to change, and one MCS breaks every clash at once (hitting-set duality). This answers l3m's 5 "no single-rule fix" cases.

### 4.3 Relaxed backup roster (always a roster, with the broken musts listed)

This is the §4.2 MCS solve run in two stages, so it is not a separate model.
- Stage 1: minimise `100 × short places + relax costs` (the table above). Short places are `count + short >= required`.
- Stage 2: cap stage 1 at its result, hint the stage 1 roster, optimise the normal objective.
- Why stages: in the toy, one solve with huge weights was 10-25x slower. Also, large87 already has weights near 1e12, so a hard tier on top risks the int64 range. Stage 1 has no soft terms.
- If even the relaxed model is infeasible (only never-relaxed rules clash, for example the exact-hours identity), return the core only.
- The normal run keeps staffing hard. Short places appear only here, each one named (report 02 §5: an empty night is a safety risk).

### 4.4 What-if and recommend-a-nurse (on demand)

- **Scorer**: the relaxed model with every cell fixed to a given roster. Propagation only. Scores a hand-edited roster, even an infeasible one: per-rule breaks, short places, points per tier.
- **Recommend a nurse for an empty slot**: for each qualified nurse, score the roster with her in the slot (evaluate). For the top 5, fix the cell, hint the roster, free ±3 days, 2 s each (repair). Whole call capped at 10 s. Accepting one voids the rest.
- **Re-solve after a remedy**: hint the previous roster plus 1 point per changed person-day (below tier 5). A hint alone moved 97-570 of 2100 cells. With the penalty, 8-10 moved.

### 4.5 Solver tuning

- Keep `max_lp_sym` as the one global set (`solver_ortools_cp_sat.py:43`).
- The assistant never sets raw CP-SAT parameters. A wrong parameter is silent: the roster just gets worse.
- Bounded knobs only: a timeout from a server-clamped menu (15/30/60/120 s), and a status explanation ("best roster found, not proven best", with the gap). On a small ward that runs to timeout, the cause is the model, so the assistant must not suggest more time.
- cpsat-autotune stays an offline idea tool, never a dependency. A size-gated "large ward" preset waits for a corpus of 4+ wards of 80+ people.

## 5. What the assistant receives

One JSON per Optimize run, built by the host. Indices are mapped to rule ids and names in the web, as l3m §4.7 does.

```json
{
  "status": "INFEASIBLE",
  "solve": {"proven": true, "gap": null, "seconds": 14.2, "timeoutChoices": [15, 30, 60]},
  "core": {"minimal": true, "solves": 17, "seconds": 1.0,
    "members": [
      {"ruleId": "card:requirements:u1", "kind": "requirement", "tier": "H", "date": "2026-10-14", "shift": "N", "need": 3},
      {"ruleId": "req:ana:2026-10-14", "kind": "leave", "tier": "H", "nurses": ["Ana"]}],
    "text": "3 night nurses are needed on 14 Oct, but only 2 can work: Ana and Ben are on leave."},
  "remedies": [
    {"rank": 1, "action": "run_one_short", "relax": ["card:requirements:u1@2026-10-14/N"], "cost": 100, "evidence": "solver_witness"},
    {"rank": 2, "action": "borrow_temporary_nurse", "shifts": 1, "cost": 200, "evidence": "solver_witness"}],
  "relaxed": {"shortSlots": [{"date": "2026-10-14", "shift": "N", "required": 3, "filled": 2}],
    "brokenRules": [], "stage1Optimal": true},
  "score": null,
  "diff": null
}
```

For a feasible run, `core`, `remedies`, `relaxed` are null and `score` is filled: `{"total", "byTier": {"1": {"lost"}, ...}, "rules": [{ruleId, tier, weight, points, matchCount, top: [...5 matches]}], "byNurse", "byDate"}`. With a previous ledger, the host also fills `diff`.

How it becomes advice:
1. The host builds the remedies (`rankRepairOptions` fed by core and MCS). The assistant does not build them from raw solver data and must not invent members or rule ids.
2. Every remedy still passes `isSafeOption` and `violatesSafetyFloor`.
3. `solver_witness` remedies are proven and skip the diagnostic copy. Core-derived single-rule options stay `hypothesis` and still go through `test_feasibility_candidates` copies.
4. The assistant shows the top 3 (`MAX_OPTIONS`), proven first, in ladder order, rewrites `core.text` in ward words, and hands the pick to Preview.

## 6. Amendments to the l3m spec

1. **§3 and §4.2 step 1-2:** remove "add every scope literal as an assumption" and "the normal solve is unchanged". Replace with: guards pinned by domain `[1, 1]` in the normal run, and assumptions only in the core copy.
2. **§4.2 G1:** also check that the solver log says "with 2 workers". Run it on the october, genmed and large87 YAMLs too.
3. **§4.1:** staffing requirements get one literal per `(unit, date, shift)`, not one per unit.
4. **§4.3:** fix the deletion order to the relax-cost table (Q2 stands). Cap each shrink solve at 3 s.
5. **§4.4:** split the 30 s budget: core + shrink ≤ 10 s, MCS / stage 1 ≤ 10 s, stage 2 ≤ 10 s. G2 sets the real values.
6. **§1 non-goals:** drop "no fix is computed in the backend" and "no ranked explanation". The backend now returns up to 3 ranked, witness-proven correction sets. Still one core per run, no chaining (Q3).
7. **§4.5:** add `RelaxedResult(correction_sets, short_slots, broken, stage1_optimal, seconds)` through a second keyword callback, `on_relaxed_roster`. `ScheduleResult` stays a 5-tuple.
8. **§4.6:** `OptimizationResult` gains `relaxed` (infeasible) and `ledger` (feasible), each serialised explicitly in the W6 Redis patch. Older records read as `None`.
9. **§4.7:** `rankRepairOptions` gains `core` and `corrections`. `evidence` gains `"solver_witness"`.
10. **§4.8:** an MCS or stage 2 failure or timeout keeps the core only. It never turns INFEASIBLE into FAILED.

## 7. Phases

Core changes need user approval and an upstream-patch record: a file in `core/upstream-patches/`, the patch name on each file's row in `manifest.toml`, then `python -m scripts.sync_upstream --repo <v1 clone> --refresh-patches` and `python -m scripts.check_upstream_sync`.

| Phase | Work | Effort | Core change | Gate |
|---|---|---|---|---|
| P0 | G2 spike (throwaway): infeasible variants of the 3 dumps (leave cluster, night over-demand) plus the 12 real variants. Time core, shrink, MCS, stage 2. | S | no | sets budgets |
| P1 | l3m as amended (§6 items 1-5). Patch `P5-infeasible-core.patch`. | M | yes: `solver_ortools_cp_sat.py`, `scheduler.py`, `solver_interface.py` | G1, G2 |
| P2 | Ledger + per-tier score + diff. Patch `<bead>-objective-ledger.patch`. | S | yes: `utils.py` becomes `patched`, `preference_types.py`, `scheduler.py` | G3 |
| P3 | MCS + relaxed two-stage roster. Patch `<bead>-relaxed-roster.patch`. | L | yes: requirement short slots in `preference_types.py`, solver | G4, G5 |
| P4 | Web: core-to-text templates, JSON of §5, `rankRepairOptions(core, corrections)`, playbook wording. | M | no | 45-scenario measurement |
| P5 | Scorer, recommend-a-nurse, churn-penalty re-solve. | M | yes: scorer entry point | G6 |
| P6 | Timeout menu, status/gap line, per-run solve log (status, objective, bound, gap, wall, first-solution time, var count). | S | log line only | none |
| later | Benchmark corpus (10+ models, 4+ with 80+ people), then maybe a large-ward preset. | M | only for a shipped preset | corpus win on every large model, no loss on small |

### Gates

All on 2 cores: `taskset -c 0,1`, `num_workers = 2`, 15 s limit, seeds 1-3, OR-Tools 9.15.6755, from `/tmp/wave/bench/{october,genmed,large87}.yaml` through `scheduler.schedule` (the `.pb` dumps lack rule keys). Baselines from report 04: october OPTIMAL 810 in 0.48 s, genmed OPTIMAL 449 in 1.20 s, large87 FEASIBLE with 116-156% gap.

- **G1 no regression:** flag on, same status and objective on october and genmed, wall within 5%. The large87 gap is not worse. The log shows 2 workers.
- **G2 core:** core + shrink p95 ≤ 10 s on the infeasible variants. Every `minimal: true` core re-checked (drop any one member, it solves).
- **G3 ledger:** `sum(ledger) == objective` exactly on all 3 YAMLs. Read-out ≤ 50 ms on large87.
- **G4 relaxed on feasible data:** stage 2 returns the normal objective with 0 short places and 0 broken rules on october and genmed.
- **G5 relaxed on infeasible data:** stage 1 + 2 p95 ≤ 10 s. Each witness, replayed as a normal run with its correction, is FEASIBLE. Real-ward unknowns go from 9 of 12 to ≤ 5 of 12. The other cases end as a named clash with a proven remedy, or with a plain "only a never-relaxed rule can fix this".
- **G6 recommend:** a 5-candidate recommend call ≤ 10 s on genmed.

Timings so far are toy-only on a fast desktop. tc1 is slower. Re-run G1, G2, G5 there before switching the flag on in production.

## 8. Open questions for the user

1. Can the assistant show the relaxed roster that breaks musts (each break named), or use it only as proof behind a remedy?
2. Do you accept the relax-cost order inside the musts: soften a hard request, then relax a cap, then run one short, then borrow a nurse, then move leave?
3. Approve four new v2-only core patches (P1, P2, P3, P5), including making `utils.py` a patched file?
4. Staffing guards per date and shift (finer than l3m's per-rule unit): yes?
5. Keep the last run's ledger in the run store for "what changed" diffs?
6. Can you supply 4+ real ward dumps with 80+ people for the tuning corpus?

## Assumptions

- The l3m `PreferenceSource` ids ship as specified. The ledger, core and diff depend on them.
- Real ward cores stay near minimal, as in the toy (raw core within 2 of minimal).
- The web run record can hold the ledger (not checked in `web/lib/query/optimize.ts`).

## User decisions (2026-09-30)

1. The backup roster that breaks musts is proof only. The assistant never shows it to the manager. It only uses it to check that a remedy works.
2. The remedy order is approved: soften a hard nurse request, relax a cap, run one nurse short, borrow a nurse, move leave (with agreement), cancel leave. Safety rules are never offered for relaxing.
3. The four core changes are approved for an EXPERIMENTAL branch only. Nothing merges into develop until the user decides to adopt the plan.
4. Staffing guards are per rule, per date and per shift.
5. Keep the last run's penalty ledger, so the assistant can compare the two most recent runs.
6. Build the tuning and gate corpus from existing wards: upstream v1 `dev` and `feature/genie`, and this repo's tests and examples.

## Round 2 verdict (2026-09-30)

Reports [06](./06-borrow-beyond-explanations.md), [07](./07-adopt-timefold-community.md) and [08](./08-timefold-spike.md) answer two questions. What else can we borrow from Timefold? Can we use Timefold Solver Community itself?

All three reports say: keep CP-SAT, do not adopt Timefold Community. Timefold cannot prove that a roster is impossible, and the "why no roster" flow depends on that proof. It is Java only, the Python binding is frozen since July 2025, and its explanation features are Enterprise in 2.x. A port costs about 33 to 50 developer-days plus a second copy of every rule. On the October ward at 2 cores, CP-SAT proved the optimum 810 in under 0.5 s. Timefold late acceptance stalled at 600 to 630 after 60 s, and tabu search took 3.5 to 23.5 s to reach 810.

Ideas to borrow, in the recommended order:

1. Per-rule tests in the style of `ConstraintVerifier`, and a score recompute check in the style of `FULL_ASSERT`.
2. An early stop when the objective stops improving (diminishing returns).
3. Pinning and "minimise changes from the published roster", done in the web layer as hard and soft shift requests. No core change.
4. Fairness to the ward mean: our squared shift count ranks rosters the same as Timefold `loadBalance` when the target is the mean.
5. A size-gated LNS loop (ruin and recreate on CP-SAT). It beat plain CP-SAT on the 87-person ward in 3 of 3 seeds at 2 workers and 15 s. It is worse on small wards, so it must be size-gated. It needs a tc1 and corpus gate run first.

Revisit Timefold only if a real ward gets no roster within its budget after P3, or the host grows to 4 or more dedicated cores and 8 GB or more. A 3 to 5 day spike on `large87` comes first.

Open items: `large87` was not run on Timefold. Report 08 found a possible false violation in `is_match` for negative soft successions by code reading only. It must be reproduced before anyone fixes it.
