# Timefold ideas on CP-SAT: experiment results

Date: 2026-09-30. Bead `nursing-sheduler-a5pb`. Branch `exp/timefold-on-cpsat` (from `origin/develop` b6d51c54). This branch is not merged into develop, and the user has not adopted the plan.
Inputs: plan `00-plan.md` with its user decisions, reports 01-04, and the l3m infeasible-core spec with the plan's amendments.

## Answer

- **P1 penalty ledger: works.** On every measured roster the ledger sums exactly to the objective. Read-out takes 31 ms on the 87-person ward (49,754 terms). The assistant gets a per-rule, per-nurse and per-date breakdown, plus a diff against the previous run keyed by stable rule ids.
- **P2 why-solve: works on 18 of 20 infeasible wards.** It names a clash on the 12 small wards and on 6 of the 8 synthetic 36-116 person wards. All 16 cores marked minimal pass the drop-one re-check. The core names the intended cause on all 6 synthetic wards where it finds one. p95 is 10 s, which is the budget.
- **A new finding moved 3 wards from INCONCLUSIVE to proven INFEASIBLE.** On the three wards where the normal Optimize run times out with no roster, a no-objective check proves infeasibility in 1.6-4.1 s. Develop cannot prove these in 60 s.
- **P3 smallest-fix solve: works on small and synthetic wards, weak on the w8 wards.** It returns up to 3 ranked remedies in the approved order. All 39 remedies on 18 wards, each re-applied alone to a freshly built model, solve. The web turns them into repair options with `evidence: "solver_witness"` that pass the existing safety checks.
- **In the l3m 45-scenario measurement, unknowns fell from 11 to 7-8.** Generated small wards went from 3 to 0. Real wards went from 8 to 7-8, or to 4-5 when a named clash with no allowed fix counts as resolved. On the w8 wards the 10 s fix solve finds only large, unproven-cheapest fixes.
- **G1: the normal run is unchanged.** Guards are built only when a run ends with no roster. The optimising model is byte-identical to develop's, and a test pins this. The only added cost on a feasible run is the ledger read.
- **Not built: P4** (what-if and recommend-a-nurse).
- **Recommendation: adopt P1 and P2 after one fix; adopt P3 behind a flag.** Details and conditions are at the end.

## Setup

- OR-Tools 9.15.6755, Python 3.14 (`/usr/bin/python3`), AMD Ryzen 9 9950X3D. Other agents kept the machine at load 5-14 throughout.
- Every timing is pinned to 2 physical cores (`taskset -c 4,5`) with `num_workers = 2`, a 15 s limit, and develop's `max_lp_sym`. Each run goes through `scheduler.schedule` on canonicalized YAML.
- "develop" means `origin/develop` b6d51c54 (the corpus copy in `/tmp/wave/corpus/core-src/core`). Runs alternate develop and branch per seed on the same cores.
- Wards:
  - `/tmp/wave/bench/{october,genmed,large87}.yaml`
  - the corpus `/tmp/wave/corpus`: 43 feasible wards, 12 small infeasible wards, and 8 synthetic infeasible wards (36-116 people) with a documented intended cause each.
- Scripts are in `/tmp/wave/exp/`:
  - `g1.py` / `g1.sh`: develop against branch, one JSON line per run
  - `gate_inf.py`: infeasible wards, with `--recheck` and `--replay`
  - `record_patch.py`: writes an upstream patch and its manifest rows
- Raw results are the `*.jsonl` files in the same folder.

## What was built

| Phase | Core (`core/nurse_scheduling/`) | Web (`web/`) | Upstream patch |
|---|---|---|---|
| P1 ledger | `utils.add_objective(key=, truth=)` records each finite term. The 10 call sites pass their (day, shift, person) key. `explain.read_ledger`. `schedule(on_explanation=)`. The runner puts the result on `OptimizationResult.explanation`, carried through redis, API and SSE. | `lib/optimize/explanation.ts` (rule ids, resolve, summary, diff). The run view keeps the previous run's ledger. The strict payload parsers accept `explanation`. `get_optimize_result` returns `explanation.score` and `sinceLastRun`. | `a5pb-ledger.patch`, `a5pb-ledger-truth.patch` |
| P2 why | Guard literal per hard rule unit in `ORToolsSolver.add_constraint/add_bool_or`. Unit keys come from the handlers: request cell, staffing per date and shift group, skill mix, qualification, nurse cap, succession per nurse, covering per date. `explain.core_units` and `why_infeasible`. Guards are built only on the rebuild of a run with no roster. | Core resolved to rule ids and real people, with one sentence per date. The assistant guidance says the clash is solver-proven. | `a5pb-why-solve.patch`, `a5pb-explain-rebuild.patch` |
| P3 fix | `explain.smallest_fixes`: a weighted correction set on every worker, with a staffing slack on the head-count constraint and a cap priced per place over. Up to 3 remedies by blocking. | `witnessOptions` / `rankRepairOptions({witness})` / `buildFeasibilityReport(state, run, witness)`. New `evidence: "solver_witness"`. `suggest_feasibility_options` passes the run's remedies unless the run is stale. | none (v2-only `explain.py`) |

`core/upstream-patches/manifest.toml` changes:

- `context.py` and `utils.py` go from verbatim to patched.
- The 4 patches, `explain.py` and `test_explain.py` get their rows. The two new files are v2-only.
- The T19 origin table is regenerated.

`test_core_matches_recorded_upstream` passes.

## P1: penalty ledger (G3)

| Ward | Status | Terms | Non-zero matches | Balanced | Read-out | JSON |
|---|---|---|---|---|---|---|
| october | OPTIMAL 810 | 594 | 81 | yes | 0.6 ms | 5.8 KB |
| genmed | OPTIMAL 449 | 481 | 91 | yes | 0.6 ms | 6.0 KB |
| large87 | FEASIBLE | 49,754 | 1000 of more (capped) | yes | 31 ms (84 ms before the proto fast path) | 89 KB |
| 67 `basics/*.yaml` | all | - | - | yes, and `unattributed == 0` | - | - |

Notes on the ledger:

- **G3 passes.** The sum equals the objective exactly on every roster, and read-out is ≤ 50 ms on large87.
- `matches` holds the top 1000 by points. The per-rule totals stay exact, and `truncated` says whether matches were cut.
- **Coordinator heads-up, fixed.** A negative soft literal succession only bounds `is_match` from below, so a FEASIBLE roster could carry `is_match = 1` with no real match. The ledger now reads that term from the roster pattern (`truth=`). Points such a variable still costs show as `unattributed`, not as a violation. Two tests cover this: a faked spurious bound, and a real forced match.
- **Diff.** Matches are keyed by (rule id, nurse, date, shift), as in Timefold's `ScoreAnalysis.diff`.
  - A rule id comes from the submitted canonical document: `request:<person>:<date>:<shift>`, or `<kind>:<label>` with `#n` on repeats. It survives edits to other rules.
  - It is **not** the card uid: see Limits.

## G1: the normal Optimize run (develop against branch)

The final design builds no guards in the optimising run. `test_explanations_leave_the_optimising_model_byte_identical` checks that the model text is identical with and without `on_explanation`, on basics and on every repair fixture (feasible and infeasible).

The table has 4 seeds each, run sequentially on cores 4,5 (`g1-final.jsonl`):

| Ward | develop | branch | develop wall mean | branch wall mean | Gap (median) |
|---|---|---|---|---|---|
| october | OPTIMAL 810 ×4 | OPTIMAL 810 ×4 | 0.403 s | 0.407 s | 0 / 0 |
| genmed | OPTIMAL 449 ×4 | OPTIMAL 449 ×4 | 1.131 s | 0.961 s | 0 / 0 |
| ward-8 (32 p) | OPTIMAL 724 ×4 | OPTIMAL 724 ×4 | 7.774 s | 7.551 s | 0 / 0 |
| large87 | FEASIBLE ×4 | FEASIBLE ×4 | 16.064 s | 16.109 s | 1.86 / 1.59 |

Corpus, 43 feasible wards, 2 seeds (`g1-corpus-s{1,2}.jsonl`):

- These ran with guards still pinned in the normal run.
- The two seeds ran in parallel on cores 4,5 and 6,7, with the core suite on other cores, so the walls are noisy.
- Results: the same status set on 42 of 43 wards, the same score on all 29 all-OPTIMAL wards, and a median wall ratio of 1.008 on the wards under 14 s.
- The one miss was ward-8. It proved optimality on 1 of 2 seeds with guards.

Focused re-run, sequential, 4-8 seeds (`g1-focus.jsonl`, `g1-sg.jsonl`):

- The medium synthetic gaps move both ways (noise).
- sg-28day is extremely seed-sensitive. develop ran 2.4-15 s and found no roster on 2 of 8 seeds. The branch ran 0.75-13.4 s, all OPTIMAL.
- ward-8 was +4.8% over 8 seeds with pinned guards. That is too close to the 5% gate, so guards moved to a rebuild after a run with no roster (the l3m G1 fallback).
- That rebuild costs one extra parse and build, only on a run with no roster.

**G1 passes:** same model, same status and score, wall within noise. The large87 ledger read adds about 45 ms.

## P2: why-solve (G2) and P3: smallest fix (G4/G5)

The table covers all 20 infeasible wards (`gate_final.jsonl`). The run order is:

1. The main optimising run.
2. A rebuild with guards.
3. For an UNKNOWN run only, a no-objective proof check (10 s cap).
4. The core solve: one worker, presolve off first, then linearization 2. 10 s budget, 3 s per shrink solve.
5. The fix solve: every worker, 10 s budget, up to 3 remedies.

Table conventions:

- "re-check" means the core is infeasible and dropping any one member makes the rest feasible.
- "replay" means each remedy, re-applied alone to a fresh build, solves.
- `*` marks a remedy found in time but not proven cheapest.

| Ward | Proof | Core | Minimal | Re-check | Why s | Fixable | Remedy costs | Fix s | Replay | Total wall s |
|---|---|---|---|---|---|---|---|---|---|---|
| syn-inf-preceptor-unavailable-100p | main run | 16 | no (budget) | - | 10.0 | yes | 10, 10, 17410* | 10.0 | 3/3 | 21.1 |
| syn-inf-skill-mix-floor-date-92p | main run | 4 | yes | pass | 3.6 | yes | 1000, 1000, 30710* | 10.0 | 3/3 | 16.6 |
| syn-inf-history-consecutive-days-84p | main run | 2 | yes | pass | 0.9 | yes | 10 | 2.6 | 1/1 | 5.4 |
| syn-inf-headcount-ceiling-vs-contract-70p | check 4.1 s | none | - | - | 10 (none) | **no** | - | 3.7 | - | 33.6 |
| syn-inf-contract-hours-vs-rest-58p | check 1.6 s | 5 | no (budget) | - | 10.0 | **no** | - | 3.0 | - | 30.3 |
| syn-inf-leave-cluster-night-nic-44p | main run | 7 | yes | pass | 1.2 | yes | 100, 2000, 2000 | 7.2 | 3/3 | 10.2 |
| syn-inf-leave-vs-hard-pin-36p | main run | 2 | yes | pass | 0.4 | yes | 10, 1000 | 5.7 | 2/2 | 6.8 |
| syn-inf-max-nights-cap-116p | check 2.1 s | none | - | - | 10 (none) | yes | 410* | 10.0 | 1/1 | 38.4 |
| 12 small wards (repair fixtures, flow-c, basics) | main run | 1-9 | all yes | all pass | ≤ 0.006 | all yes | e.g. onlyRnOnLeave 100, 1000 | ≤ 0.014 | 25/25 | ≤ 0.03 |

Totals over the 20 wards:

- A core on 18. 16 are minimal, and all 16 pass the re-check.
- Why p50 is 0.003 s and p95 is 10.0 s (budget). Fix p50 is 0.009 s and p95 is 10.0 s (budget).
- 39 remedies, all 39 replayed feasible.
- 2 wards with no fix (the rule clashes only with rules that are never relaxed).

Does the core name the intended cause (the `causes/*.json` files)?

| Ward | Intended cause | Core kinds | First remedy | Intended repair |
|---|---|---|---|---|
| preceptor-unavailable | the new graduate's night pin; every preceptor on leave or pinned to the workshop | covering + 3 leave + 12 requests: exactly that set | soften one preceptor's pin (SSN-15), 10 | release one preceptor |
| skill-mix-floor-date | skill-mix floor on one date against leave | skill_mix + 3 leave | move one leave (SSN-08), 1000 | lower the floor, or move one leave day |
| history-consecutive-days | history run against a day-1 pin | succession + request | soften the day-1 pin, 10 | drop the day-1 pin |
| leave-cluster-night-nic | course leave clusters the night NICs | 6 leave + staffing N_sup | run N_sup 1 short, 100 | remove the course leave for one NIC |
| leave-vs-hard-pin | a BLS pin on a leave day | leave + request | soften the pin, 10 | move the BLS pin |
| contract-hours-vs-rest | 176 h exact against 2 rest days in 7 | contracted_hours + 4 rest-window counts | none: never relaxed | change the contract |
| max-nights-cap | cap of 4 nights against 16 night staff | no core in 10 s | soften one request, and raise nurses' night caps by 20 places in total (to 5-7 each), 410* | raise the cap (7) |
| headcount-ceiling-vs-contract | preferredNumPeople ceiling against contracts | no core in 10 s | none | raise preferredNumPeople |

### Findings that change the plan

- **Presolve off makes the one-worker core solve 8-10x faster.** Raw core, one worker, all guards assumed:
  - skill-mix 92p: 13.8 s to 1.7 s
  - history 84p: 2.06 s to 0.22 s
  - leave-cluster 44p: 0.93 s to 0.11 s
  - preceptor 100p: 2.72 s to 0.31 s

  Linearization 2 on top slows the easy cores (skill-mix 1.8 s to 5.6 s). It is kept only as the fallback, and it finds the contract-hours core (3.7 s) that plain search misses.
- **Assuming only hard units does not help.** It was 0-5% faster, and it timed out on skill-mix.
- **The coordinator's question about linearization 2 and max_lp_sym.** The key is dropping the objective, not the subsolver. These are no-objective checks on 2 workers, with guards pinned:

| Ward | develop Optimize | Check with max_lp_sym | Check, default portfolio | Core solve, one worker (presolve off / + lin2) |
|---|---|---|---|---|
| max-nights-cap 116p | UNKNOWN at 60 s | INFEASIBLE 4.0 s | INFEASIBLE 2.0 s | UNKNOWN 30 s / UNKNOWN 30 s |
| contract-hours-vs-rest 58p | INFEASIBLE at 50 s | INFEASIBLE 2.1 s | INFEASIBLE 1.5 s | UNKNOWN 30 s / INFEASIBLE 3.7 s, core 5 |
| headcount-ceiling 70p | INFEASIBLE at 45 s | INFEASIBLE 2.2 s | INFEASIBLE 4.0 s | UNKNOWN 30 s / UNKNOWN 30 s |

  The branch runs that check (default portfolio, 10 s) only after an UNKNOWN run with no roster. An INFEASIBLE result upgrades the run to INFEASIBLE. The runner then reports `infeasibility_proven` instead of an inconclusive timeout. This is a real proof and a behaviour change, and qb5v tracks the develop side.
- **Relaxing a cap needs a size.** Dropping a cap outright let the witness raise a cap from 4 to 18. Pricing each place over the cap at 20 gives "raise ben's cap 3 to 4".
- **A remedy past rank 1 can be large and not proven cheapest** (17410*, 30710*: many short slots). The web drops any option with more than `MAX_ASSISTANT_OPERATIONS` operations, so these rarely show. A cost ceiling relative to rank 1 would be cleaner (not done).

## 45-scenario infeasibility measurement (l3m acceptance)

Command: `PYTHON=/usr/bin/python3 RUN_INFEASIBILITY_MEASURE=1 pnpm vitest run lib/ai/assistant/infeasibility-measure`, pinned to cores 8-31, 90 s per solve, pool 4. It ran once without and twice with `A5PB_WITNESS=1`. The witness arm makes the baseline run return the explanation, and the report ranks the proven remedies first, as the app does. Logs: `/tmp/wave/exp/measure-{base,witness,witness2}.log`.

The harness was broken on develop before this work: `w8-nights-5` now fails the C1 check (preferred 4 below required 9), and that aborted the whole run. The harness now marks such a scenario `excluded_not_submittable` instead.

| Verdict (46 scenarios) | develop behaviour | witness arm, run 1 | witness arm, run 2 |
|---|---|---|---|
| certain | 20 | 20 | 20 |
| fix_found | 13 | 17 | 16 |
| unknown | 11 | 7 | 8 |
| excluded (baseline UNKNOWN at 90 s, not submittable) | 2 | 2 | 2 |
| wall | 401 s | 429 s | 417 s |

What changed in the witness arm:

- **Generated small wards: unknown drops from 3 to 0.** rest-DN-2n-max5, skill-mix-night-rest-leave and hard-never-night-rest are each fixed by a proven option (borrow into the group, or ask about leave), where the playbook's blind guesses had all failed.
- **Real 28-day wards (sg-*, w8-*): unknown drops from 8 to 7 (run 1) or 8 (run 2).** The harness still counts as "unknown" three kinds of result:
  - **3 end as a named clash that only a never-relaxed rule can fix** (`fixable: false`):
    - sg-hours-150h: the core is the 150 h contract alone.
    - sg-max-2-nights-in-a-row and sg-recovery-3-days: the rest rules plus staffing.

    The l3m target accepts this ending ("a plain 'only a never-relaxed rule can fix this'"). The oracle's single-rule fixes there all soften a rest rule, which the approved policy never offers.
  - **3 w8 wards: the backend found a fix, but a large one.** It has 15-31 changes (cost 2220-11200), is not proven cheapest in 10 s, and is filtered out before the options (safety check or operation cap). The oracle shows single-nurse request blocks that fix w8-senior-hard-offs-weekend at a far lower cost. So the 10 s correction-set solve on the 32-person, 16-shift ward is the weak spot. w8-senior-leave-cluster was fixed in run 1 and not in run 2.
  - **sg-leave-3-days: a core is named, but the fix solve timed out** (`fixable: null`).
- Counted by the l3m G5 definition (a named clash counts as resolved), real-ward unknowns go from 8 to 4 or 5 of 10. That meets the "≤ 5" target narrowly. By the harness verdict alone it does not.
- **Cost: the baseline run now includes the explanation.** It takes up to 20-26 s on the w8 and sg wards (why 10 s + fix 10 s), against 0.1-3.8 s before. Candidate copies fall, since a proven option needs no copy.

Next step, not built: a core-guided fix solve. First allow only the core's units to relax, then widen. This should find the cheap block fixes on w8 inside the budget.

## What does not work, and limits

- **A headcount ceiling is not relaxable.** A `preferredNumPeople` ceiling or an exact count that is too low has no slack upward. So headcount-ceiling-vs-contract reads "no fix among relaxable rules", although raising the ceiling fixes it. The approved remedy order has no "raise the staffing" step. That is a product decision.
- **Two synthetic wards get no core in 10 s** (max-nights 116p, headcount-ceiling 70p). The one-worker assumption solve cannot find these counting proofs. Both are still proven infeasible, and max-nights still gets a proven fix. Possible next steps: a larger budget, or a core from the correction set (the plan's MCS-hitting-set duality).
- **The UNKNOWN path is slow.** The user waits for the main run, then the check, the core and the fix: 30-38 s on the 58-116 person wards. The 90 s executor grace still covers it. There is no progress event for these steps, because an `explaining_infeasibility` phase code was not added: the web's phase map was not checked.
- **Rule id to card mapping is by label.** The web maps a remedy back to its card by description and ordinal (`#n`). A card without a description falls back to position, which is only safe for requirement cards. The l3m design (a `preferenceSources(state)` loop emitted alongside `mapPreferences`, with card uids) is the robust version. It is not built, because rest-day expansion and temporary covers make the parallel loop larger than this experiment.
- **No tier breakdown.** The vjbv ladder's `tierOf` does not exist on develop, so `summarizeLedger` gives lost and earned points, not points per tier.
- **Plan simplifications:**
  - One keyword callback (`on_explanation`) replaces the plan's two (`on_infeasible_core`, `on_relaxed_roster`).
  - The plan's stage 2 (optimise soft terms under the stage 1 cap) is dropped, because the backup roster is proof only and never shown.
  - The staffing slack serves both "run short" and "borrow a nurse". The web offers both from one proof, and a borrow goes into the requirement's named group.
- **Web path to the assistant.** It is covered by unit tests only (payload parsing, run view, summary, witness options). No browser or e2e run was done.
- **P4 was not built.** It covers what-if scoring, recommend-a-nurse, and the churn-penalty re-solve.

## Quality gates run

- Core, full suite at the final commit (`PYTHONPATH=. python3 -m pytest`): 1602 passed. The 4 failures are pre-existing, since the pulp and highs runtimes are not installed here. `tests/test_explain.py` has 125 tests. `ruff check .`, `ruff format --check .` and `scripts.check_upstream_sync` pass with 0 problems.
- Web: `pnpm typecheck`, `pnpm lint` (oxlint + ast-grep) and oxfmt on touched files are clean.
- Web, full vitest at the final commit: 8692 passed, 1 failed. `dev-launcher.test.ts` fails on develop as well. The `new-schedule-button` C-23 load test is flaky: it failed 2 of 5 runs on develop, and passed in the final run.
- Web tests added: `lib/optimize/explanation.test.ts`, `lib/ai/assistant/witness-options.test.ts`, and parser cases in `lib/query/event-payloads.test.ts`.

## Recommendation

1. **Adopt P1 (ledger and diff).** It is cheap, exact, and needs no new solve. Before merging, map rule ids to card uids (the l3m `preferenceSources` refactor) and add the ladder tier when vjbv lands.
2. **Adopt P2 (why-solve), including the no-objective proof check.**
   - It changes nothing in the normal run.
   - It names the intended clash on every ward where it finds a core.
   - It turns "inconclusive" into a proof on the hardest synthetic wards.

   Conditions: add a phase event so the web can show "explaining" for the extra 10-25 s. Re-time on tc1 (2 shared cores), since all numbers here come from a fast desktop.
3. **Adopt P3 (proven remedies) behind a flag first.** The proofs held on every replay, and the options reuse the playbook's safety checks. Four gaps remain before it is on by default:
   - add the core-guided pass to the fix solve. Today real-ward fix_found barely moves, because the 10 s solve finds only large fixes on the w8 wards.
   - decide whether to relax a staffing ceiling
   - cap remedy size relative to rank 1
   - map to cards by uid

   Then re-run the 45-scenario measurement with the witness arm as the acceptance gate.
4. **Keep P4 for later.** Nothing here needs it, and the ledger (P1) is its scoring base.
