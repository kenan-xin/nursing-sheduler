# How often does an infeasible schedule end "cause unknown"?

Bead: `nursing-sheduler-l3m` (user decision 2026-09-27: measure first, no core change).
Date: 2026-09-27. Base: `origin/develop` @ `1190095`. Solver: OR-Tools CP-SAT 9.15.6755, 90 s per solve.

## Answer

Of 45 confirmed-infeasible scenarios, the assistant's diagnosis ended:

| outcome | count | rate |
|---|---|---|
| **certain cause** (static check finds a gap; `buildFeasibilityReport` findings) | 20 | 44% |
| **proven sufficient fix** (no certain cause; a candidate copy solved) | 11 | 24% |
| **cause unknown** (no certain cause; every tested copy still infeasible) | 14 | 31% |

- All 14 unknowns are the "all still infeasible" kind. None was inconclusive (no timeout) and none had zero candidates.
- The rate depends on the ward. On the 12 variants of the two real 28-day wards, **9 of 12 (75%)** ended unknown, 3 were certain and none got a proven fix. On the 10 scripted wards the evals and repair fixtures use, it was 0 of 10.
- Time is not the cause. The slowest single solve on the app path took 10.5 s against a 90 s budget, measured with 4 scenarios running in parallel. The 90 s timeout never stopped a solve on the app path.
- Picking the wrong candidate is the cause. On the unexplained path the app tests the **first** hard rest rule, the **first** editable limit and the **first** hard request, in rule order. For **9 of the 14** unknowns, softening one other hard rule alone makes the schedule solvable. An explanation that named that rule, such as an infeasible core, could have found the fix. The other 5 have no single-rule fix. They need a change to two or more rules, or a structural change such as relief staff or a looser hours contract.

## Method

This used no model calls. The measurement drives the deterministic parts of the diagnosis directly:

1. **Baseline.** Each scenario goes through the path an Optimize run takes (`withCoverOverrides` -> `toCanonicalScenarioDocument` -> `prepareOptimizeSubmission`). The real CP-SAT solver then runs on the YAML with the job's `timeout_seconds` (90). A scenario counts only if it is proven `INFEASIBLE`.
2. **Certain or not.** `buildFeasibilityReport(state, true)`. A scenario with any finding counts as certain.
3. **Candidates.** The report's ranked options that carry operations stand in for the model's candidates, in order, at most 5 (`MAX_DIAGNOSTIC_CANDIDATES`). Each one is checked against `violatesSafetyFloor`, applied with `applyAssistantCommands`, serialized as in `runOneCandidate`, and solved at 90 s. Testing stops at the first feasible copy, which is `test_feasibility_candidates` without `compare`. Result: fix found, all infeasible, or inconclusive (UNKNOWN or an error).
4. **Oracle (not an app path, unknown rows only).** Each hard sequence rule, each hard count (contracted-hours counts excepted, since the backend requires them hard) and each nurse's hard requests is softened on its own, and the copy is solved. This gives an upper bound on what naming one culprit rule could offer.

Harness: `web/lib/ai/assistant/infeasibility-measure.test.ts`. It is opt-in and skipped in the default suite. It solves through the differential oracle (`web/lib/scenario/differential/oracle.py`, whose `schedule` op now takes an optional `timeout` and reports `seconds`). Run:

```bash
cd web && PYTHON=/usr/bin/python3 pnpm measure:infeasibility   # ~7 min; MEASURE_TIMEOUT_S, MEASURE_POOL
```

Wall time was 412 s with 4 scenarios in parallel. The app path alone takes about 65 s. The oracle probe adds 161 solves.

## Corpus (46 built, 45 infeasible)

| source | n | what |
|---|---|---|
| scripted | 10 | every infeasible ward in `lib/rules/ward-fixtures.test-support.ts`: the repair-eval fixtures (9) plus `restRuleTooTight`. The `repair` / `regressions` / `safety` eval cases seed from these. |
| eval_yaml | 1 | `evals/fixtures/flow-c-infeasible-demo.yaml` (eval `flow-c-diagnose`) |
| core_testcase | 1 | `core/tests/testcases/basics/01_1nurse_1shift_1day_infeasible.yaml` |
| generated_small | 21 | 7-day wards, each built around one clash: rest rules (quick return, no double night, night recovery, max days in a row), limits against rest rules, skill mix against rest or leave, hard requests against rest, leave clusters, and head-count controls |
| generated_real | 13 | variants of `core/tests/testcases/real/sg-28day-160h-compliance-14-nurses.yaml` (SG rest law, exact hours, exactly 6 nights) and `ward-8-shift-patterns-senior-on-every-shift.yaml` (40 nurses, a senior on every shift): leave clusters, tighter night limits and recovery, a lower hours contract, hard requests, more seniors per night, more nights |

The differential suite builds its wards with `makeValidUiState` and inline YAML. They are load, accept and reject contract fixtures, not infeasible starting points, so none is included. (Only the builders were checked, not every inline case.) Each generated variant is kept only if the solver proves it infeasible. Variants that turned out feasible were tightened while the corpus was built, and 4 that stayed feasible were dropped. `w8-max-2-nights-rest` is excluded: its baseline found a schedule after 51 to 93 s, and one 10 s pilot ended UNKNOWN, which the app would report as inconclusive rather than infeasible.

`cause` is the rule each scenario was built to break (ground truth). It is not what the app sees.

## Rates

### By cause

| cause | n | certain | fix found | unknown | unknown split (all infeasible/inconclusive/no candidates) | unknown with a single-rule fix | solver s median / max |
|---|---|---|---|---|---|---|---|
| count_cap | 7 | 4 (57%) | 3 (43%) | 0 (0%) | 0/0/0 | 0/0 | 0.1 / 1.2 |
| hard_request | 5 | 1 (20%) | 0 (0%) | 4 (80%) | 4/0/0 | 4/4 | 0.1 / 17.0 |
| head_count | 9 | 8 (89%) | 0 (0%) | 1 (11%) | 1/0/0 | 0/1 | 0.1 / 12.0 |
| hours_contract | 1 | 0 (0%) | 0 (0%) | 1 (100%) | 1/0/0 | 0/1 | 0.3 / 0.3 |
| leave_cluster | 6 | 1 (17%) | 3 (50%) | 2 (33%) | 2/0/0 | 0/2 | 0.1 / 0.7 |
| requirement_conflict | 1 | 1 (100%) | 0 (0%) | 0 (0%) | 0/0/0 | 0/0 | 0.1 / 0.1 |
| rest_rule | 8 | 0 (0%) | 5 (63%) | 3 (38%) | 3/0/0 | 3/3 | 0.1 / 1.7 |
| skill_mix | 8 | 5 (63%) | 0 (0%) | 3 (38%) | 3/0/0 | 2/3 | 0.1 / 18.9 |
| **all** | 45 | 20 (44%) | 11 (24%) | 14 (31%) | 14/0/0 | 9/14 | 0.1 / 18.9 |

### By source

| source | n | certain | fix found | unknown | unknown split (all infeasible/inconclusive/no candidates) | unknown with a single-rule fix | solver s median / max |
|---|---|---|---|---|---|---|---|
| core_testcase | 1 | 1 (100%) | 0 (0%) | 0 (0%) | 0/0/0 | 0/0 | 0.1 / 0.1 |
| eval_yaml | 1 | 1 (100%) | 0 (0%) | 0 (0%) | 0/0/0 | 0/0 | 0.1 / 0.1 |
| generated_real | 12 | 3 (25%) | 0 (0%) | 9 (75%) | 9/0/0 | 4/9 | 1.2 / 18.9 |
| generated_small | 21 | 6 (29%) | 10 (48%) | 5 (24%) | 5/0/0 | 5/5 | 0.1 / 0.1 |
| scripted | 10 | 9 (90%) | 1 (10%) | 0 (0%) | 0/0/0 | 0/0 | 0.1 / 0.1 |
| **all** | 45 | 20 (44%) | 11 (24%) | 14 (31%) | 14/0/0 | 9/14 | 0.1 / 18.9 |


"Solver s" is the seconds a user waits: the failed run plus the candidate copies, in sequence. It was measured with 4 scenarios in parallel on 32 cores, so it runs higher than on an idle machine.

### Why the 14 end unknown

| scenario | what the app tested (all still infeasible) | a single-rule softening that fixes it (oracle) |
|---|---|---|
| rest-DN-2n-max5 | first rest rule (no day after night) | max-5-days-in-a-row |
| skill-mix-night-rest-leave | first rest rule | no-double-night |
| hard-never-night-rest | n1's first hard request (one day of seven); first rest rule | no-double-night, max-5-days |
| hard-must-days-rest | n1's first hard request (one day); first rest rule | max-5-days, all of n1's requests |
| hard-never-nights-two | n1's first hard request; first rest rule | no-double-night, n1/n2/n3 requests |
| sg-max-2-nights-in-a-row | "exactly 6 nights" 6 -> 7; first rest rule (A -> M) | three night rules (night -> night-or-rest, second clear day, max-3-nights) |
| sg-recovery-3-days | same two | the same three, or the added third-clear-day rule |
| w8-senior-hard-offs-weekend | SN-XinYi's childcare request (the first hard request); first rest rule | any one of the 7 seniors' weekend hard offs |
| w8-senior-leave-cluster | SN-XinYi's request; first rest rule | day-after-night-must-be-night-or-off |
| sg-leave-3-days, sg-leave-cluster-3-nurses | "exactly 6 nights" 6 -> 7; first rest rule | none of 16. Paid leave breaks the exact-hours identity (worked cover = 14 x 20 - leave < 280) |
| sg-hours-150h | same two | none of 16 (contracted hours stay hard) |
| w8-four-seniors-per-night, w8-nights-5 | SN-XinYi's request; first rest rule | none of 14 |

Three patterns:

1. **The unexplained path picks candidates blindly.** `REPAIR_ORDER.unexplained` builds each option from the first matching rule: `hard[0]`, the first `editableCap`, and the first hard rest rule (`softenRestRule`). On the small wards the first rest rule is usually the culprit: it gave 9 of the 11 fixes, and the other 2 came from the first limit. On the real wards, with 14 to 20 hard rules, the first-rule guesses fixed none of the 9 cases that had no certain cause.
2. **`relax_count_rule` "relaxes" an exact count.** `capOf` treats `x = T` as a cap, so the unexplained builder raises SG's "exactly six nights" from 6 to 7. That asks for 98 nights where 84 exist, so it cannot help, yet it uses a candidate slot on 5 of the 9 real-ward unknowns. This is a heuristic defect that is separate from l3m. It was not changed here (no product changes).
3. **A request is softened one cell at a time.** `soften_hard_request` softens one cell (one date). A nurse with a week of "never nights" stays infeasible, while softening all of her requests fixes 2 of the 3 hard-request cases.

### What this means for l3m

- **"Cause unknown" is common, not an edge case.** It is 31% overall and 75% on the realistic 28-day wards. Every case finished well inside the 90 s budget, so the problem is which candidates get picked, not the timeout.
- **An infeasible core would help most of the time, but not always.** In 9 of 14 unknowns, one named rule is enough to fix the schedule. A core (CP-SAT assumptions over hard rules or request groups) that named those rules would turn each of them into a named cause plus a tested fix. In the other 5, no single rule fixes it: 3 hit the exact-hours identity and 2 are over-demand spread across many rules. There a core would at best name a group of rules, with no safe single fix.
- **A step without a core exists, but it is slow.** The oracle above softens each hard rule in turn. As a host-side search, not a model guess, it would have found a proven fix for the same 9 of 14 with no core patch, which fits "no core change now". But it took up to 20 solves per scenario, and on the real wards 30 s to 6 min in total (sequential, loaded machine), against the 5-candidate cap the app has today. A core finds the culprits in one solve. Two cheap heuristic fixes would lift the app's own candidates without either: stop "relaxing" `x = T` counts, and soften a nurse's whole block of hard requests rather than one cell.
- The corpus is small and hand-built (45 cases), so treat the rates as orders of magnitude. The by-source split matters more than the overall rate.

## Limits

- **Candidates are a proxy.** The model sees the same options and is told to test them in order, but it may write up to 5 of its own. It may do better or worse than the ranked options. This was not measured, because doing so needs paid model calls.
- **The corpus is synthetic.** Real-ward variants come from 2 real wards. Small wards are hand-built to clash, and the mix of causes is chosen, not sampled from real use.
- **Timings are from the oracle, not the deployed job queue.** They cover the same `scheduler.schedule(..., timeout=90)` call but leave out queueing, HTTP and polling. Runs were parallel.
- **Ground-truth labels are the author's.** `w8-nights-5`, for example, is labelled head_count because the head count was raised, but the static check cannot see it because the shortfall only appears through the recovery rules.

## Per-scenario results (final run, 90 s)

Verdicts were identical in two full 90 s runs. Timings vary with load.

| scenario | source | cause | verdict | findings | baseline | candidates | diag s | single-rule fixes (oracle) |
|---|---|---|---|---|---|---|---|---|
| understaffedNight | scripted | head_count | certain | 1 | INFEASIBLE(0.03s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.04s) | 0.0 | - |
| onlyRnOnLeave | scripted | skill_mix | certain | 1 | INFEASIBLE(0.04s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.04s) | 0.0 | - |
| rnMixOnLeave | scripted | skill_mix | certain | 1 | INFEASIBLE(0.03s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.04s) | 0.0 | - |
| ruleTooStrict | scripted | count_cap | certain | 1 | INFEASIBLE(0.04s) | relax_count_rule[max-nights]:OPTIMAL(0.05s) | 0.1 | - |
| tooFewNurses | scripted | head_count | certain | 5 | INFEASIBLE(0.05s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.04s) | 0.0 | - |
| personalCapsTooLow | scripted | count_cap | certain | 1 | INFEASIBLE(0.04s) | extra_shift_willing_nurse[ana-nights]:OPTIMAL(0.05s) | 0.1 | - |
| conflictingRequirements | scripted | requirement_conflict | certain | 5 | INFEASIBLE(0.03s) | align_overlapping_requirements[night-total]:OPTIMAL(0.04s) | 0.0 | - |
| busyNightsWithRestRule | scripted | head_count | certain | 2 | INFEASIBLE(0.03s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.04s) | 0.0 | - |
| shortOnLeaveDay | scripted | leave_cluster | certain | 1 | INFEASIBLE(0.04s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.04s) | 0.0 | - |
| restRuleTooTight | scripted | rest_rule | fix_found | 0 | INFEASIBLE(0.04s) | soften_rest_rule[no-day-after-night]:OPTIMAL(0.05s) | 0.1 | - |
| flow-c-infeasible-demo | eval_yaml | head_count | certain | 5 | INFEASIBLE(0.04s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.06s) | 0.1 | - |
| core-1nurse-1shift-infeasible | core_testcase | head_count | certain | 1 | INFEASIBLE(0.03s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.04s) | 0.0 | - |
| rest-DEN-3n-quickreturn | generated_small | rest_rule | fix_found | 0 | INFEASIBLE(0.05s) | soften_rest_rule[no-day-after-night]:OPTIMAL(0.05s) | 0.1 | - |
| rest-DN-3n-no-DN-max5 | generated_small | rest_rule | fix_found | 0 | INFEASIBLE(0.05s) | soften_rest_rule[no-day-after-night]:OPTIMAL(0.04s) | 0.0 | - |
| rest-DN-4n-D2-max5 | generated_small | rest_rule | fix_found | 0 | INFEASIBLE(0.05s) | soften_rest_rule[no-day-after-night]:OPTIMAL(0.04s) | 0.0 | - |
| rest-DN-2n-max5 | generated_small | rest_rule | unknown_all_infeasible | 0 | INFEASIBLE(0.04s) | soften_rest_rule[no-day-after-night]:INFEASIBLE(0.03s) | 0.0 | 1/2: successions:max-5-days-in-a-row |
| rest-DEN-4n-recovery | generated_small | rest_rule | fix_found | 0 | INFEASIBLE(0.04s) | soften_rest_rule[no-day-after-night]:OPTIMAL(0.05s) | 0.1 | - |
| cap-nights-2-recovery | generated_small | count_cap | fix_found | 0 | INFEASIBLE(0.04s) | relax_count_rule[max-nights]:INFEASIBLE(0.03s), soften_rest_rule[no-day-after-night]:OPTIMAL(0.04s) | 0.1 | - |
| cap-work-4-each | generated_small | count_cap | fix_found | 0 | INFEASIBLE(0.04s) | relax_count_rule[max-shifts]:OPTIMAL(0.04s) | 0.0 | - |
| cap-work-5-rest | generated_small | count_cap | fix_found | 0 | INFEASIBLE(0.04s) | relax_count_rule[max-shifts]:OPTIMAL(0.04s) | 0.0 | - |
| cap-personal-nights-rest | generated_small | count_cap | certain | 1 | INFEASIBLE(0.04s) | extra_shift_willing_nurse[n1-nights]:OPTIMAL(0.04s) | 0.0 | - |
| skill-rn-day-night-rest | generated_small | skill_mix | certain | 5 | INFEASIBLE(0.03s) | borrow_temporary_nurse[add_temporary_cover]:INFEASIBLE(0.03s) | 0.0 | - |
| skill-mix-night-rest-leave | generated_small | skill_mix | unknown_all_infeasible | 0 | INFEASIBLE(0.03s) | soften_rest_rule[no-day-after-night]:INFEASIBLE(0.03s) | 0.0 | 1/2: successions:no-double-night |
| skill-mix-rn-cap | generated_small | skill_mix | certain | 1 | INFEASIBLE(0.04s) | relax_count_rule[rn-nights]:OPTIMAL(0.04s) | 0.0 | - |
| skill-rn-leave-rest | generated_small | skill_mix | certain | 5 | INFEASIBLE(0.03s) | - | 0.0 | - |
| hard-never-night-rest | generated_small | hard_request | unknown_all_infeasible | 0 | INFEASIBLE(0.03s) | soften_hard_request[n1]:INFEASIBLE(0.04s), soften_rest_rule[no-day-after-night]:INFEASIBLE(0.04s) | 0.1 | 2/5: successions:no-double-night; successions:max-5-days-in-a-row |
| hard-must-days-rest | generated_small | hard_request | unknown_all_infeasible | 0 | INFEASIBLE(0.03s) | soften_hard_request[n1]:INFEASIBLE(0.03s), soften_rest_rule[no-day-after-night]:INFEASIBLE(0.04s) | 0.1 | 2/4: successions:max-5-days-in-a-row; requests:n1 |
| hard-never-nights-two | generated_small | hard_request | unknown_all_infeasible | 0 | INFEASIBLE(0.03s) | soften_hard_request[n1]:INFEASIBLE(0.03s), soften_rest_rule[no-day-after-night]:INFEASIBLE(0.03s) | 0.1 | 4/5: successions:no-double-night; requests:n1; requests:n2; requests:n3 |
| leave-cluster-rest | generated_small | leave_cluster | fix_found | 0 | INFEASIBLE(0.03s) | soften_rest_rule[no-day-after-night]:OPTIMAL(0.04s) | 0.0 | - |
| leave-cluster-cap | generated_small | leave_cluster | fix_found | 0 | INFEASIBLE(0.03s) | relax_count_rule[max-nights]:INFEASIBLE(0.03s), soften_rest_rule[no-day-after-night]:OPTIMAL(0.04s) | 0.1 | - |
| leave-cluster-DEN | generated_small | leave_cluster | fix_found | 0 | INFEASIBLE(0.04s) | soften_rest_rule[no-day-after-night]:OPTIMAL(0.05s) | 0.1 | - |
| head-short-weekend | generated_small | head_count | certain | 1 | INFEASIBLE(0.04s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.05s) | 0.1 | - |
| head-short-DEN | generated_small | head_count | certain | 5 | INFEASIBLE(0.03s) | borrow_temporary_nurse[add_temporary_cover]:OPTIMAL(0.05s) | 0.1 | - |
| sg-leave-3-days | generated_real | leave_cluster | unknown_all_infeasible | 0 | INFEASIBLE(0.19s) | relax_count_rule[count-0]:INFEASIBLE(0.19s), soften_rest_rule[seq-0]:INFEASIBLE(0.36s) | 0.6 | 0/16: none |
| sg-leave-cluster-3-nurses | generated_real | leave_cluster | unknown_all_infeasible | 0 | INFEASIBLE(0.23s) | relax_count_rule[count-0]:INFEASIBLE(0.21s), soften_rest_rule[seq-0]:INFEASIBLE(0.27s) | 0.5 | 0/16: none |
| sg-night-fairness-5 | generated_real | count_cap | certain | 1 | INFEASIBLE(0.24s) | relax_count_rule[count-0]:OPTIMAL(1s) | 1.0 | - |
| sg-hours-150h | generated_real | hours_contract | unknown_all_infeasible | 0 | INFEASIBLE(0.09s) | relax_count_rule[count-0]:INFEASIBLE(0.17s), soften_rest_rule[seq-0]:INFEASIBLE(0.09s) | 0.3 | 0/16: none |
| sg-max-2-nights-in-a-row | generated_real | rest_rule | unknown_all_infeasible | 0 | INFEASIBLE(0.23s) | relax_count_rule[count-0]:INFEASIBLE(0.25s), soften_rest_rule[seq-0]:INFEASIBLE(0.24s) | 0.5 | 3/16: successions:night-then-night-or-rest; successions:second-clear-day-after-nights; successions:At most three consecutive nights |
| sg-never-nights-one-nurse | generated_real | hard_request | certain | 1 | INFEASIBLE(0.12s) | relax_count_rule[count-0]:INFEASIBLE(0.09s) | 0.1 | - |
| sg-recovery-3-days | generated_real | rest_rule | unknown_all_infeasible | 0 | INFEASIBLE(0.51s) | relax_count_rule[count-0]:INFEASIBLE(0.61s), soften_rest_rule[seq-0]:INFEASIBLE(0.53s) | 1.1 | 4/17: successions:night-then-night-or-rest; successions:second-clear-day-after-nights; successions:At most three consecutive nights; successions:sg-third-clear-day |
| w8-senior-hard-offs-weekend | generated_real | hard_request | unknown_all_infeasible | 0 | INFEASIBLE(4.22s) | soften_hard_request[SN-XinYi]:INFEASIBLE(7.67s), soften_rest_rule[seq-0]:INFEASIBLE(5.13s) | 12.8 | 7/20: requests:SSN-Devi; requests:SSN-Siti; requests:SSN-MeiLing; requests:SSN-Priya; requests:SSN-Kavitha; requests:SSN-Aishah; requests:SSN-WeiLing |
| sg-night-4 | generated_real | head_count | certain | 1 | INFEASIBLE(0.44s) | relax_count_rule[count-0]:INFEASIBLE(0.41s) | 0.4 | - |
| w8-senior-leave-cluster | generated_real | skill_mix | unknown_all_infeasible | 0 | INFEASIBLE(3.45s) | soften_hard_request[SN-XinYi]:INFEASIBLE(10.53s), soften_rest_rule[seq-0]:INFEASIBLE(4.94s) | 15.5 | 1/14: successions:day-after-night-must-be-night-or-off |
| w8-four-seniors-per-night | generated_real | skill_mix | unknown_all_infeasible | 0 | INFEASIBLE(5.63s) | soften_hard_request[SN-XinYi]:INFEASIBLE(5.12s), soften_rest_rule[seq-0]:INFEASIBLE(5.35s) | 10.5 | 0/14: none |
| w8-max-2-nights-rest | generated_real | rest_rule | excluded_feasible | 0 | FEASIBLE(92.74s) | - | 0.0 | - |
| w8-nights-5 | generated_real | head_count | unknown_all_infeasible | 0 | INFEASIBLE(3.77s) | soften_hard_request[SN-XinYi]:INFEASIBLE(4.18s), soften_rest_rule[seq-0]:INFEASIBLE(4.05s) | 8.2 | 0/14: none |
