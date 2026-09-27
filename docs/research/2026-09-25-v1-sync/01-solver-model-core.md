# Lane 01: Solver and model core (v1 `feature/genie` 1bf4b85 against v2 `develop`)

Scope: `core/nurse_scheduling/` modules outside `server/` and `ai/`, plus their tests in `core/tests`.

Baseline (coordinator correction, verified here): `d63519b` is on v1 branch `feature/genie`. It is not an ancestor of `dev`. The merge-base of the two is `89190ab`. `feature/genie` (HEAD `1bf4b85`) contains all of `dev` through merge `1b6f7e5` ("Merge dev into feature/genie", 2026-09-24). The target that v2 must absorb is `d63519b..feature/genie`.

Origin tags:

- DEV: a change from a commit in `89190ab..dev`.
- GENIE-ONLY: a change that exists only on genie. In this lane, that is the conflict resolution inside merge `1b6f7e5`. The 4 non-merge genie commits after the pin (`0320d3e`, `ecb5eee`, `6b2f274`, `1bf4b85`) touch no in-scope file. `ecb5eee` changes only `core/nurse_scheduling/ai/references/schema-core.md` in `core/`.
- PRE-PIN GENIE: GENIE-ONLY work from before `d63519b` (part of `dev..feature/genie`). v2 already has it. It is listed only where the merge changed its form.
- V2-ONLY: v2 `develop` work that is not in any v1 branch.

Method: read-only `git log`, `git show` and `git diff` on the v1 repo. I extracted `git archive` trees to `/tmp/l01` for `89190ab`, `d63519b`, `dev` and `feature/genie`. I also ran 11 genie core test files from the `/tmp/l01/fg` archive (details in section 1). Line numbers refer to those trees or to this worktree.

## 1. Summary

The DEV change in this lane is one large refactor and one security fix. The refactor is in 4 commits: `9ff14d1`, `a64094a`, `86ce350` and `4e9aea2`. It moves every selector expansion and semantic check into Pydantic validation, and it builds an immutable `CompiledSchedule`. It also replaces the Pydantic `Context` with a dataclass that holds `scenario` and `compiled_schedule`. I read every handler in the new `preference_types.py` line by line, and the solver formulation does not change. Invalid input now fails at load time, not at solve time. The security fix is in `3a77ad4`, `1990a1e`, `3f60999` and `63dfc54`. It sets a bound on YAML alias expansion and on nesting depth.

The GENIE-ONLY merge `1b6f7e5` already re-expressed the genie features on the compiled API. It covers the LEAVE day state, hoursContract, shift type covering and the working-time fields. v2 has 5 genie test files, and 4 of them are byte-identical to the genie copies (`test_leave_daystate.py`, `test_shift_type_covering_preference.py`, `test_shift_type_working_time.py`, `test_hours_contract_field.py`). I ran these 4 files plus `test_hours_contract_validation`, `test_models_validation`, `test_preference_validation`, `test_loader`, `test_exporter`, `test_scheduler` and `test_utils` on the genie archive. The result is 243 passed and 1 failed. The failure (`test_r4_prototype_160h_leave_credit_is_load_bearing`) reads `prototype/leave_daystate...`, which is outside `core/`, so my archive does not have it. The failure is an artifact of the archive.

This means v2 can take the genie core files verbatim. Only the V2-ONLY features remain as a v2 patch set: skillMix, per-date overrides, `temporary`, `on_roster`, the CP-SAT-only scheduler, and the `country` field.

Three facts in the brief change on this baseline:

- `group_map.py` is not deleted. It exists on genie, and the merge changed its API. `build_shift_type_index_map` is removed, and `validate_contracted_hours` now takes the compiled map.
- `solver_pulp_cbc.py` and `solver_pulp_cuopt.py` are not new. They exist at the merge-base and on `dev`. Genie `7d1c220` deleted them, and genie still omits them.
- Most of the "models.py +741 / preference_types.py -524" figures come from comparing the genie pin with `dev`. The real change from the pin to `feature/genie` (`git diff --numstat`) is +675/-20 lines in `models.py` and +94/-336 lines in `preference_types.py`.

Headline risks:

1. v2 core is at the pin plus V2-ONLY edits. Every V2-ONLY feature uses the old `ctx.map_*`, `ctx.people` and `ctx.dates.items` API, which genie deleted. The sync is a take-then-reapply of 4 features. It is not a textual merge.
2. DEV `c571665` removed `country`, and genie kept that removal. v2 web still emits `country: SG` (`web/lib/scenario/canonical.ts:328`), and 2 v2 test cases carry it. The genie model rejects the field as an extra key.
3. v2 accepts YAML aliases with no bound, at `server/scheduling_input.py:69-84` and at `loader.py`. The DEV commit `3a77ad4` says: "A 342-byte document whose YAML aliases nest nine wide and eight deep names about 387 million nodes".
4. `server/workspace.py:25` imports `group_map.build_shift_type_index_map`. Genie removed that function, so the server lane must adapt when the genie `group_map.py` lands.
5. The v2 scheduler has an older error path (this is not in the 437 commits). v2 `scheduler.py:377-379` raises `ValueError` on status UNKNOWN. Genie and DEV return the status, and they have done so since `2f24d31`, which is already in the merge-base. The v2 runner has an INCONCLUSIVE path for UNKNOWN (`server/jobs/runner.py:141-155`), but only tests with a mocked scheduler cover it. The real v2 job outcome for a timeout with no incumbent is UNVERIFIED.

## 2. Change table

### 2a. Upstream delta `d63519b..feature/genie`

Status key: absent, partial, conflicts, equivalent already. Action key: adopt verbatim, adopt with adaptation, skip, NEEDS DECISION.

| ID | Origin | v1 commits | Files | What it does | Solver semantics / YAML schema | v2 status | Conflict notes vs v2 | Proposed action | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C01 | DEV | `2f86e7c`, `ac3e3ee` (core part) | `cli.py`, `context.py`, `exporter.py`, `loader.py`, `models.py`, `preference_types.py`, `report.py`, `scheduler.py`, `solver_interface.py`, `solver_ortools_cp_sat.py`, `utils.py`, `model_build_stats.py`, test helpers | Ruff fixes. They sort imports, add a per-module `logger`, add `noqa` markers, and remove `pass` from abstract methods. | None / none. | absent | Text only. On genie, `solver_ortools_cp_sat.py` differs from v2 only by this row, and `cli.py`, `loader.py` and `solver_interface.py` are identical to `dev` (verified by diff). | adopt verbatim (with the whole-file take in C02) | S | Low |
| C02 | DEV | `9ff14d1` (models part), `a64094a`, `86ce350`, `4e9aea2` | `models.py`, `context.py`, `preference_types.py`, `exporter.py`, `scheduler.py`, `utils.py`, `loader.py` (`model_validate`); tests `test_models_validation.py`, `test_preference_validation.py`, `test_exporter.py`, `test_scheduler.py`, `export_test_helper.py` | Compiles every selector once, at validation. It adds frozen `Compiled*` dataclasses and `CompiledSchedule` (genie `models.py`, from `_FrozenMapping` to `CompiledSchedule`). `NurseSchedulingData._compiled_schedule` is a `PrivateAttr`. `Context` becomes a dataclass with `scenario` and `compiled_schedule`. Each handler takes a 4th argument, `compiled_preference`. The scheduler drops the map-building block and the 5 Cartesian lookup maps. | Constraints: unchanged (compared handler by handler). `qualified_ps_by_s` changes from `map_ds_p[(d,s)]` to `range(n_people)`, which is the same set. Schema: stricter at load time. Unknown IDs in any selector, coefficient errors, infinite weights with `preferredNumPeople`, bad `\|x - T\|^2` weights, unsupported expressions, a bad `weightRange` and history errors now fail during validation. New rejections: an empty succession `pattern` (dev `models.py:759`) and empty affinity lists (dev `models.py:873-876`). Progress events: the phase `creating_lookup_maps` and the build step `create_lookup_maps` are gone. | conflicts | V2-ONLY rows V1 to V4 use the old API. v2 tests pin `create_lookup_maps` (`core/tests/test_scheduler.py:479`, `:553`). A job that failed at solve time now fails at submission with a 422. The v2 422 translation (`server/scheduling_errors.py`) then receives root-level `value_error` items. How it places them is UNVERIFIED (server lane). | adopt with adaptation: take the genie files verbatim, then re-apply V1 to V4 | L | High |
| C03 | DEV, kept by genie | `c571665` | `models.py`, `scheduler.py`, `frontend_validation.py`, `test_models_validation.py`, `test_scheduler.py` | Removes the `country` field and its check. | None / breaking: `country` becomes an unknown key under `extra="forbid"`. Genie has no `country` in `core/nurse_scheduling/*.py` and none in `web-frontend/src` (checked with `git grep`). | conflicts | v2 keeps `country` (`models.py:507`) and requires `SG` (`scheduler.py:160`). v2 web emits it (`canonical.ts:328`, `workspace.ts:179`, `import-scenario.ts:195`). `server/workspace.py:171` and `:467` copy it. 2 v2 test cases carry `country: SG` (`sg-28day-160h-compliance-14-nurses.yaml:67`, `ward-8-shift-patterns-senior-on-every-shift.yaml:100`). | NEEDS DECISION (D1) | S | Medium |
| C04 | DEV | `3a77ad4`, `190c587`, `1990a1e`, `3f60999`, `63dfc54` (loader parts) | `loader.py`, `test_loader.py` | `measure_yaml_expansion()` counts nodes from parse events and follows aliases. It rejects input above `MAX_EXPANDED_NODES = 200_000` or `MAX_NESTING_DEPTH = 64` with `SchedulingDataTooComplexError`. `_parse_events` turns bare parser assertions into `YAMLError`. `_load_yaml` requires a top-level mapping, and it can reject aliases. `63dfc54` removed the raw bracket prescan from `3f60999`, because the prescan rejected valid text. | None / a new input bound. The commit says the largest real scenario expands to 4448 nodes and project data nests 5 levels deep. | absent | v2 `loader.py` is the 55-line version from before this change. v2 `scheduling_input._parse_once` has no bound. On genie, `loader.py` is identical to `dev`. `test_loader.py` differs only by renaming `SENTRY_MOJIBAKE_YAML` to `MOJIBAKE_YAML`. | adopt verbatim. The server lane must call `measure_yaml_expansion` in `_parse_once`. | S | Low |
| C05 | DEV | `9ff14d1`, `c571665`, `9f56b85`, `1fbdfb7`, `63dfc54` | `frontend_validation.py` (new), `test_frontend_validation.py` | `_FrontendNurseSchedulingData` subclass. It requires string IDs, descriptions, flat string lists, and one person and one shift type per shift request. It rejects aliases. Its only caller is `ai/validation.py:28`. | None / a subset policy that only the AI proposal check uses. | absent | v2 has its own web input boundary in `server/workspace.py`. | skip. Revisit only if the AI lane adopts v1 `ai/`. | S | Low |
| C06 | DEV | `aee23bc`, `96cc2aa`, `37259be`, `9048f7e`, `5af0419` (test part), `3f2c919`, `5689c84` (README) | `scheduler.py` (`forced_solution`), `tests/real/assignment_fixture.py`, `tests/real/schedule_score_ground_truth.py`, `tests/real/performance_benchmark.py`, `tests/real/README.md`, `test_performance_benchmark.py`, `test_scheduler.py`, `testcases/real/large-ward-with-87-people-2025-11.assignment-01.json` | `schedule(..., forced_solution=...)` pins every `shifts[(d,s,p)]` to a given 0/1 value, and it requires an exact key match (dev `scheduler.py:250-273`). An assignment fixture keyed by person ID and shift ID replays one real solution and checks its canonical score in seconds. A Docker benchmark scores machine speed. | Additive keyword argument / none. | absent | `schedule_score_ground_truth.py:53` reads `result.solution`, so it needs the `ScheduleResult` return (C08). The fixture uses IDs, not group names, so the pre-pin genie rename from `FREEDAY` to `NON-WORKDAY` (`96e9ba9`) does not affect it. Genie carries all C06 files. | adopt verbatim: `forced_solution`, the fixture and the ground-truth test. NEEDS DECISION (D3) for the benchmark. | S | Low |
| C07 | DEV | `034fbf6` | `solver_pulp.py`, `model_build_stats.py`, `test_solver_pulp_cbc.py` | PuLP uses model-owned APIs (`model.numConstraints()`), which removes a flood of deprecation warnings in CI. | None / none. | absent (PuLP excluded) | On genie, `solver_pulp.py` differs from `dev` by 186 lines. Genie drops the CBC and cuOpt log-tail progress code. | skip the PuLP files. Take `model_build_stats.py` verbatim (C10). | S | Low |
| C11 | DEV | `2f86e7c`, `ac3e3ee`, `034fbf6` (backend parts) | `solver_ortools_linear.py`, `solver_ortools_mathopt.py`, `solver_pulp.py`, `tests/real/solver_capabilities.py`, backend tests | Lint and PuLP API changes in solver backends that v2 does not ship. | None / none. | absent (U31 excluded them) | Genie deletes `test_solver_pulp_cbc.py` and keeps linear, MathOpt, GLPK and PuLP-python. | skip | S | Low |
| C12 | DEV | `ac3e3ee` | `anonymize_scheduling_data.py` | Adds one `noqa`. The module serves only `sentry.py`. | None / none. | absent | Genie has neither `anonymize_scheduling_data.py` nor `sentry.py` (pre-pin `64c84a3`). v2 matches genie. | skip | S | Low |
| G1 | GENIE-ONLY (merge `1b6f7e5`) | `1b6f7e5` re-expresses pre-pin `f06402b` and `7764e80` | `constants.py`, `context.py`, `models.py`, `scheduler.py`, `preference_types.py`, `exporter.py` | Re-applies the LEAVE day state on the compiled API. It adds `LEAVE: (LEAVE_sid,)` to the shift-type reserved seed and allows LEAVE in history. It rejects LEAVE in requirements at compile time. It adds `leaves` and `pinned_leaves` to the dataclass `Context`. It adds `_day_state_expr`. "ALL" in shift requests and in succession patterns becomes `Σshifts`, not `negate(offs)`. | Same semantics as v2 today (the 4 identical test files pass on genie). Schema is unchanged from v2. | equivalent already (in behavior), conflicts (in code form) | v2 `preference_types.py` holds the same logic in the old form. | adopt verbatim | M | Low |
| G2 | GENIE-ONLY (merge `1b6f7e5`) | re-expresses pre-pin `9aef889` and `7764e80` | `group_map.py`, `models.py`, `preference_types.py`, `test_hours_contract_validation.py` | `validate_contracted_hours(map_sid_s, shift_type_groups, preferences)` now takes the compiled `shift_map` from `_validate_and_compile_schedule`. `build_shift_type_index_map` is deleted. The shift count keeps the `_pair_{i}` variable-name suffix. | Unchanged. | conflicts | v2 `group_map.py` differs from genie by 58 lines. `server/workspace.py:25` and `:245-252` still call `build_shift_type_index_map`. v2 `test_hours_contract_validation.py` differs from genie by 18 lines, for the signature change. | adopt verbatim. Then the server lane either rebuilds the map in `workspace.py`, or it keeps `build_shift_type_index_map` as a v2 patch (D6). | S | Medium |
| G3 | GENIE-ONLY (merge `1b6f7e5`) | re-expresses pre-pin `7d1c220` and `31c5125` | `models.py` (`CompiledShiftTypeCovering`), `preference_types.py` (`shift_type_covering`) | Covering compiles its groups once. It drops empty groups, and it rejects OFF and LEAVE at compile time. The handler keeps only the solver loop. Model variable names change to `pref_{idx}_d_{d}_preceptee_group_{i}_{j}_k_{k}_any`. | Constraints unchanged. The variable names change, which only affects logs and debug reports. | conflicts (code form) | v2 has the old handler with validation inside it. | adopt verbatim | S | Low |
| G4 | PRE-PIN GENIE, kept by the merge | pre-pin `64c84a3`, `a8a6b77` | `models.py` `ShiftType` | Adds the authoring-only fields `durationMinutes`, `startTime`, `endTime` and `restMinutes`, with `_validate_working_time`. | None / unchanged from v2. | equivalent already | None. | adopt verbatim (it comes with the models take) | S | Low |
| G5 | GENIE-ONLY (merge `1b6f7e5`) | `1b6f7e5` | `scheduler.py`, `tests/test_scheduler.py`, `tests/test_cli.py` | Genie keeps the multi-solver selector from `dev`, but without `pulp/cbc` and `pulp/cuopt` (`PULP_ENGINES = ("glpk", "highs", "scip")`). Tests move from `pulp/cbc` to `ortools/cp-sat`. `test_scheduler.py` expects 2 variables per (day, person) in the off/leave step. | None for CP-SAT. | conflicts | v2 deleted the whole selector and the `solver` argument (see C08). | NEEDS DECISION (D2) | S | Low |

### 2b. v1 code at the merge-base that v2 changed

These rows are not in the 437 commits. They are older v2 deviations that block the goal of keeping v2 core close to v1.

| ID | Origin | Files | v2 deviation | Solver semantics / YAML schema | Proposed action | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C08 | merge-base, kept by genie | `scheduler.py`, `cli.py`, `tests/schedule_test_helper.py`, `tests/real/schedule_real_helper.py`, CP-SAT wrapper tests | v2 deleted the solver selector registry and the `solver` argument. v2 returns a plain 5-tuple, where v1 returns the `ScheduleResult` NamedTuple. v2 `cli.py` dropped `--solver`. | None for CP-SAT. | NEEDS DECISION (D2). Recommendation: take genie `scheduler.py` and `cli.py` verbatim, and add a one-line v2 patch `SUPPORTED_SOLVER_CHOICES = (ORTOOLS_CP_SAT_SOLVER,)`. A NamedTuple still unpacks as a 5-tuple, so `server/jobs/runner.py:117` and the other 5-tuple call sites keep working. | S | Low |
| C09 | `2f24d31` (in merge-base) | `scheduler.py` | v2 `scheduler.py:377-379` raises `ValueError` for any status other than OPTIMAL, FEASIBLE, INFEASIBLE and MODEL_INVALID. Genie returns `ScheduleResult(None, None, None, status, None)` for UNKNOWN. `test_scheduler.py:640` pins the v2 raise. | Error path only. | adopt verbatim with C08. The v2 runner INCONCLUSIVE branch then handles a real timeout with no incumbent. | S | Medium |
| C10 | merge-base, kept by genie | `solver_interface.py`, `model_build_stats.py` | v2 deleted `validate_square_constant` (dev `solver_interface.py:120-133`) and the MPSolver and MathOpt branches in `get_model_entity_counts`. | None (dead code for CP-SAT). | adopt verbatim. This removes 2 v2 deltas at no cost. | S | Low |

### 2c. V2-ONLY patches to re-apply on top of genie

These are the only rows that stay as a documented v2 core patch set.

| ID | Origin | v2 files today | What it does | Re-expression on the genie compiled API | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | v2 `e220807` | `models.py` `Person.temporary: StrictBool` | An authoring-only flag for a borrowed nurse. | Add 1 field to the genie `Person`. There is no conflict. | S | Low |
| V2 | v2 `3e4bc25`, `fd98a98` | `models.py` (`SkillMixEntry`, `skillMix`, `validate_skill_mix`), `preference_types.py:205-215` | A floor of k named people on a shift, which bans nobody. | Keep the field validator. Add `skill_mix: tuple[tuple[tuple[int, ...], int], ...]` to `CompiledShiftTypeRequirements`, and resolve it with `utils.parse_pids(entry.people, people_map)`. That also rejects unknown IDs at load time. The handler then loops over the compiled tuples. | S | Medium |
| V3 | v2 `dbab7c4` | `models.py` (`requiredNumPeopleOverrides` and 2 validators), `preference_types.py:151-159`, `:199-203` | Per-date exceptions to `requiredNumPeople`. | Add `required_by_date: tuple[tuple[int, int], ...]` to `CompiledShiftTypeRequirements`. Map each date to its index, and require the index to be in the compiled `dates`. This moves the "not one of this requirement's dates" error from solve time to load time. The handler uses `dict(compiled.required_by_date).get(d, preference.requiredNumPeople)`. | S | Low |
| V4 | v2 `556740a` (manifest B1) | `scheduler.py:54-100` `_build_roster_payload`, `on_roster` keyword argument | A structured roster handoff after a solve. | Change `ctx.people.items` to `ctx.scenario.people.items`, `ctx.dates.items` to `ctx.compiled_schedule.dates`, and `ctx.shiftTypes.items` to `ctx.scenario.shiftTypes.items`. Keep `on_roster` keyword-only, after `forced_solution`. The return contract does not change. | S | Low |
| V5 | v2 T19 and U31 | `scheduler.py`, `cli.py` | CP-SAT only. | See D2. It becomes 1 line if you accept the recommendation. | S | Low |
| V6 | pre-pin genie `7d1c220` (`TW` changed to `SG`) | `models.py:507`, `scheduler.py:160` | Accepts `country`, and allows only `SG`. | Depends on D1. If you keep it, it is a 2-line model patch plus 1 check at compile time. | S | Low |
| V7 | v2 server | `group_map.py` | `build_shift_type_index_map` for `server/workspace.py`. | Depends on D6. | S | Low |

## 3. Dependencies and order

1. Land C04 (the YAML bounds) first. It has no dependency, and it is the only security fix.
2. Decide D1, D2 and D6 before step 3, because each one changes the files that step 3 replaces.
3. Replace these v2 core modules with the genie versions in one change: `models.py`, `context.py`, `preference_types.py`, `exporter.py`, `scheduler.py`, `cli.py`, `loader.py`, `utils.py`, `report.py`, `constants.py`, `group_map.py`, `solver_interface.py`, `solver_ortools_cp_sat.py` and `model_build_stats.py`. This change covers C01, C02, C04, C06 (`forced_solution`), C08, C09, C10 and G1 to G5. It also brings in the genie versions of the matching tests.
4. Before you re-apply V1 to V4, run the genie score ground-truth test (C06), the XLSX and schedule regressions, and the genie LEAVE, covering and hoursContract suites. These tests prove that scores and genie behavior do not change.
5. Re-apply the V2-ONLY patches. V2 (skillMix) and V3 (overrides) touch the same compile branch and the same handler, so land them together. V4 (`on_roster`) reads `ctx.leaves`, which G1 provides. V1, V5, V6 and V7 can land at any point.
6. The server lane then adapts `server/workspace.py` (G2 and V7) and `scheduling_errors.py` (C02 root-level errors). It also wires C04 into `scheduling_input.py`. The web lane handles D1.

Steps 3 and 5 must land together on one branch. Step 3 alone breaks the v2 skill-mix, override and `on_roster` tests (`test_skill_mix.py`, `test_requirement_overrides.py`, `test_scheduler_on_roster.py`). The gate is the full core test suite plus all real test cases.

## 4. Open decisions

| ID | Question | Recommendation |
| --- | --- | --- |
| D1 | Keep `country` in the core model as a v2 patch, or follow DEV and genie and remove it? | Follow DEV and genie. The field has no solver effect, because v2 only checks that it equals `SG`. Keep accepting `country` in Workspace V1 input, and drop it in `convert_workspace_to_strict`, so that old saved files still load. Stop emitting it in `web/lib/scenario/canonical.ts`, and remove it from the 2 SG test cases. |
| D2 | Keep the v2 CP-SAT-only rewrite of `scheduler.py` and `cli.py`, or take genie verbatim with the selector? | Take genie verbatim and limit `SUPPORTED_SOLVER_CHOICES` to CP-SAT with a one-line patch. The server boundary already rejects other solvers (`server/scheduling_input.py:54-66`). The other backends are lazy imports that never run. This removes about 110 lines of v2 delta. |
| D3 | Adopt the Docker performance benchmark (`tests/real/performance_benchmark.py`, `test_performance_benchmark.py`)? | Skip it. Take only the assignment fixture and the score ground-truth test. The benchmark needs v1 Docker images, `scripts/run_performance_benchmark.sh`, and server performance claims, which are outside this lane. |
| D4 | Offer the V2-ONLY core features to genie upstream? | Yes, if the genie owner agrees. Start with V3 (per-date overrides) and V2 (skillMix), because both are small and generic. Every feature that upstream takes removes one row from section 2c. |
| D5 | Adopt `frontend_validation.py`? | Skip it, unless the AI lane adopts v1 `ai/`. |
| D6 | How does `server/workspace.py` get the ordered shift-type map after G2? | Put the loop back inside `workspace.py`, where it is the only user. It is 15 lines (`group_map.py` lines 35-68 in v2). This keeps `group_map.py` byte-identical to genie. The other option is a v2 patch that keeps `build_shift_type_index_map` in `group_map.py`. |

## 5. Coverage note

This note covers every in-scope file that differs between `d63519b` and `feature/genie`. It also covers every in-scope file where v2 differs from genie.

Core modules:

| File | Rows |
| --- | --- |
| `cli.py` | C01, C08, G5 |
| `constants.py` | G1 (genie matches v2) |
| `context.py` | C01, C02, G1 |
| `exporter.py` | C01, C02, G1 |
| `frontend_validation.py` | C05 |
| `group_map.py` | G2, V7 |
| `loader.py` | C01, C02, C04 |
| `model_build_stats.py` | C01, C07, C10 |
| `models.py` | C01, C02, C03, G1 to G4, V1 to V3, V6 |
| `preference_types.py` | C01, C02, G1 to G3, V2, V3 |
| `report.py` | C01 |
| `scheduler.py` | C01, C02, C06, C08, C09, G1, G5, V4 to V6 |
| `solver_interface.py` | C01, C10 |
| `solver_ortools_cp_sat.py` | C01 (the only difference from genie) |
| `solver_ortools_linear.py`, `solver_ortools_mathopt.py`, `solver_pulp.py` | C07, C11 |
| `solver_pulp_cbc.py`, `solver_pulp_cuopt.py`, `anonymize_scheduling_data.py` | C11 and C12. They exist on `dev` but not on genie or v2, so no action is needed. |
| `utils.py` | C01, C02 |
| `ai_serve.py`, `serve.py`, `version.py`, `sentry.py` (dev only) | out of lane (server and AI lanes) |

Tests:

| File | Rows |
| --- | --- |
| `export_test_helper.py`, `schedule_test_helper.py` | C01, C02, C08 |
| `real/README.md`, `real/performance_benchmark.py`, `test_performance_benchmark.py` | C06 (D3) |
| `real/assignment_fixture.py`, `real/schedule_score_ground_truth.py`, `testcases/real/large-ward-with-87-people-2025-11.assignment-01.json` | C06 |
| `real/schedule_real_helper.py`, `test_schedule_ortools_cp_sat.py`, `test_export_xlsx_ortools_cp_sat.py` | C01, C08 |
| `real/solver_capabilities.py`, `test_real_solver_capabilities.py` | C11. v2 maps the probe to `core/scripts/solver_capability_probe.py` (U31). |
| `test_cli.py` | C01, G5 |
| `test_utils.py` | C01 |
| `test_exporter.py`, `test_preference_validation.py` | C02 |
| `test_models_validation.py` | C02, C03 |
| `test_scheduler.py` | C02, C03, C06, C09, G5 |
| `test_loader.py` | C02, C04 |
| `test_frontend_validation.py` | C05 |
| `test_hours_contract_validation.py` | G2 |
| `test_leave_daystate.py`, `test_shift_type_covering_preference.py`, `test_shift_type_working_time.py`, `test_hours_contract_field.py` | G1, G3, G4. Byte-identical in v2 and genie. They pass on genie, except for the one archive-only failure in section 1. |
| `test_schedule_ortools_mpsolver_bop.py`, `test_schedule_pulp_glpk.py`, `test_solver_ortools_linear.py`, `test_solver_ortools_mathopt.py`, `test_solver_pulp_cbc.py` (deleted on genie) | C07, C11 |
| `test_skill_mix.py`, `test_requirement_overrides.py`, `test_scheduler_on_roster.py` (v2 only) | V2, V3, V4 |
| `test_optimize_job_backends.py`, `test_process_executor.py`, `test_public_diagnostic.py`, `test_retry.py`, `test_serve.py`, `test_usage_metrics.py` | out of lane (server). They appear in the `core/tests` diff only. |

UNVERIFIED items:

- The real v2 job outcome for an UNKNOWN solver status (C09).
- How `server/scheduling_errors.py` places root-level validation errors after C02.
- The full genie core suite. I ran only the 11 files in section 1.
