---
title: "Contract C3 — Preference & Constraint Semantics"
kind: spec
---

# Contract C3 — Preference & Constraint Semantics

## Purpose & Scope

This contract fixes the exact preference/constraint semantics of the Python
scheduling core so the rebuilt frontend generates scenarios the core will
accept and solve as intended, and so users can predict solver behavior. The
Python core is NOT being rebuilt: this is a **conformance-only reference.**
Every rule, parameter default, and error string below is transcribed from the
current sources and MUST be matched verbatim by the frontend where it mirrors
core behavior (weight validation, keyword/date parsing, list-vs-nested-list
conventions, error text shown to users).

<user_quoted_section>Narrow DL09 target delta: all existing solver arithmetic and selector semanticsremain conformance-only. WT1 changes only marked metadata/grid validation and adds theexpression-pair index to diagnostic identifiers; it does not change how generic ShiftCounts, ALL, or groups solve.</user_quoted_section>

Scope covers:

- The three-state decision-variable model and the day-state invariant
(worked / OFF / LEAVE).
- WEIGHT semantics through `add_objective.`
- The **seven preference types and their hard/soft classification —**
structural (no-op handler, enforced by the offs/shifts invariant) for
`at most one shift per day; hard staffing bounds with optional soft`
preferred-shortfall objective for `shift type requirement; soft`
weighted objectives with `±Infinity → hard for shift request /`
`shift type successions / shift count / shift affinity; hard`
reified (weight ignored) for `shift type covering,`
their parameters/defaults, and the exact constraint/objective each builds.
- Group / keyword / date resolution rules.
- The validation error catalog with exact messages (the load-bearing entries;
this is a documented subset, **not** an exhaustive mirror of every message the
core can emit — the shipped catalog has additional entries not transcribed here).

Out of scope: solver backend internals (current source: OR-Tools CP-SAT
only — historical PuLP/CBC/cuOpt backends have been removed; see C4),
export formatting, and the transport/serve layer. Helper primitives such as
`create_bool_var_with_constraint, create_bool_and_var,`
`should_use_bool_and_var, add_abs_equality, add_squared_equality, and`
`negate are referenced abstractly; their contract is "produce a variable`
constrained per the stated relation."

## Core Model & Weight Semantics

### Decision variables

For every day `d ∈ [0, n_days), shift type s ∈ [0, n_shift_types), and person`
`p ∈ [0, n_people), the core creates a boolean variable`
`shifts[(d, s, p)] (shift_d{d}_s{s}_p{p}), = 1 iff person p works shift`
type `s on day d (core/nurse_scheduling/scheduler.py:151-155).`

For every `(d, p) the core creates THREE boolean day-state variables — the`
worked-shift `shifts above, plus offs[(d, p)] (off_d{d}_p{p}) and`
`leaves[(d, p)] (leave_d{d}_p{p}) — and adds the defining invariant`
(`scheduler.py:185-201):`

```
offs[(d, p)] + Σ_s shifts[(d, s, p)] + leaves[(d, p)] == 1   # for all (d, p)
```

This single equation simultaneously (a) **defines the three peer day-states**
— exactly one of a worked shift, an `OFF (rest) day, or a LEAVE (paid-leave)`
day per (day, person) — and (b) enforces **at most one worked shift per**
person per day (the sum of shift booleans is 0 or 1). There is no separate
`<= 1 constraint; the at most one shift per day preference is a no-op`
precisely because this invariant already encodes it (see CON-SEM-01).
`Leave is an input-only day-state (CON-SEM-08): pinned to 1 by a LEAVE shift`
request and forced to 0 everywhere else, so the solver never invents leave
(`scheduler.py:276-284).`

<user_quoted_section>Re-baselined (decision log 06). The three-state model above is theshipped backend, not a future extension. CON-SEM-08 describes the liveLEAVE semantics; the earlier "Option C / future" framing is superseded.</user_quoted_section>

- `n_days = (endDate - startDate).days + 1 (scheduler.py:81).`
- Concrete shift = `(d, s); OFF and LEAVE are represented by the reserved`
sentinel shift ids `OFF_sid = -1 and LEAVE_sid = -2`
(`core/nurse_scheduling/constants.py:22-26), and in expressions by`
`offs[(d, p)] / leaves[(d, p)] rather than any shifts[...] entry.`

### `add_objective weight semantics`

All soft terms and infinity-as-hard terms flow through
`utils.add_objective(ctx, weight, expression)`
(`core/nurse_scheduling/utils.py:32-46):`

```
if weight == +inf:  ctx.solver.add_constraint(expression == 1)   # HARD: force true
elif weight == -inf: ctx.solver.add_constraint(expression == 0)  # HARD: force false
else:               ctx.objective += weight * expression         # SOFT
```

The global objective is **MAXIMIZED: **`ctx.solver.set_objective(ctx.objective, maximize=True) (scheduler.py:290). Consequences:`

- `+inf → the term's expression is hard-pinned to 1 (satisfied).`
- `-inf → hard-pinned to 0 (forbidden).`
- Finite integer weight: sign is intent. Because the objective is maximized, a
**positive weight ***encourages the expression toward 1, a ***negative**
weight *discourages it (drives toward 0). Magnitude sets relative priority.*
- Only `±inf floats are permitted. validate_weight`
(`core/nurse_scheduling/models.py:38-43) rejects any other float with`
`"Float weights can only be positive infinity or negative infinity.".`
Integer weights of any magnitude are allowed at the schema level; individual
preference types add further restrictions (see per-type sections).

`weight field defaults per model (models.py): shift request = 1,`
`shift type successions = 1, shift affinity = 1,`
`shift type requirement = -1, shift count = -1.`

## Preference Types

The dispatch map `PREFERENCE_TYPES_TO_FUNC`
(`core/nurse_scheduling/preference_types.py:780-788) binds each type string`
to its handler. Handlers run in scenario order (`scheduler.py:260-274).`

Type string constants (`models.py:29-35):`
`"at most one shift per day", "shift type requirement", "shift request",`
`"shift type successions", "shift count", "shift affinity",`
`"shift type covering".`

**List-vs-nested-list convention (applies to the reified multi-selector**
**preference types — successions, affinities, coverings — NOT shift count).**
For those, a **top-level list element = one separate equation/term,** while a
**nested list (or a group id that expands to multiple ids) = an aggregate**
**combined inside a single equation/term.** Each type below states how this
applies. **Exception — `shift count`:** `countShiftTypes` is parsed into one
deduped set and produces a **single** aggregate count
`x = Σ coefficient[s]·day_state` over the selected dates × types
(`preference_types.py:448-453,470-474`); a top-level `[D, E]` is the combined
D+E count, **not** two independent count terms. See the shift-count section.

### CON-SEM-00 — Top-level input preconditions (enforced before any preference runs)

Before any preference handler executes, `schedule() (core/nurse_scheduling/scheduler.py:54)`
asserts two structural preconditions on the scenario root:

- **`apiVersion ****must equal **"alpha"; otherwise NotImplementedError(f"Unsupported API version: {scenario.apiVersion}") (scheduler.py:77-78). Catalogued as E50.`
- **`country ****must be **None or the literal "SG" (Singapore); otherwise ValueError(f"Country {ctx.country} is not supported yet") (scheduler.py:108-110). Catalogued as E51. **The previously accepted `**`"TW" literal is no longer supported — see decision log ****decision-logs/01-singapore-english-only for the locale change.`

The current Python core does **not branch on **`country beyond this precondition: there is no per-country day-type rule, no Taiwan-style WORKDAY/NON-WORKDAY holiday table, and no Singapore-specific date classifier wired into scheduler.py. The country field is currently a guard against unreleased/in-development country features only; the core's date handling is country-agnostic. When country is None (the model default), schedule() runs unchanged; when "SG", it runs unchanged; any other value raises E51.`

**Out of scope for this contract: the frontend's supported holiday-import window is not a backend concern. The frontend fetches Singapore public holidays live from **`data.gov.sg (resource d_8ef23381f9417e4d4254ee8b4dcdb176, see frontend spec 02 FR-DC-22..29) and derives its supported range from the dataset's min/max entry dates. There is **no hardcoded **2023-01-01–2026-12-31 window — neither in this contract nor in the backend. The frontend spec is the authoritative source for holiday-import range semantics.`

### CON-SEM-01 — `at most one shift per day`

- **Model: **`MaxOneShiftPerDayPreference (models.py:243-247). Fields:`
`type, optional description. No selectors.`
- **Handler: **`all_people_work_at_most_one_shift_per_day`
(`preference_types.py:195-203) — body is pass.`
- **Purpose / constraint built: none directly. The at-most-one-per-day rule**
is already encoded by the day-state invariant
`offs + Σ shifts + leaves == 1 created for every (d, p) (scheduler.py:201).`
This preference exists so the invariant is conceptually "owned" by an
explicit preference.
- **Required: exactly this preference type MUST be present in every scenario;**
its absence raises `"Missing required preferences: {missing}"`
(`models.py:375-379).`
- **OFF handling: it is the mechanism that makes **`offs meaningful.`
- **Hard/soft: hard (structural invariant); has no **`weight.`

### CON-SEM-02 — `shift type requirement`

- **Model: **`ShiftTypeRequirementsPreference (models.py:249-266). Params:`
  - `shiftType: str | list[str | list[str]] (required).`
  - `requiredNumPeople: int (required).`
  - `shiftTypeCoefficients: list[tuple[str, int]] | None = None.`
  - `qualifiedPeople: (int|str) | list | None = None (None or "ALL" = all`
people).
  - `preferredNumPeople: int | None = None.`
  - `date: ... | None = None (None or "ALL" = all dates).`
  - `weight: int | float = -1.`
- **Handler: **`shift_type_requirements (preference_types.py:92-192). Marked`
"Hard constraint."
- **Dates: all days if **`date is None, else parse_dates(...)`
(`preference_types.py:117-119).`
- **shiftType normalization via **`_parse_shift_type_requirement_groups`
(`preference_types.py:32-56): produces a list of requirement `**groups**
(each an equation):
  - `D → [[D]]; ALL → [[D,E,N]]; group G=[D,E] → [[D,E]].`
  - `[D, E] → [[D],[E]] (two independent equations).`
  - `[ALL] → [[D,E,N]]; [G] → [[D,E]].`
  - `[[D, E]] → [[D,E]] (one aggregate equation, deduped+sorted).`
So a **top-level scalar/group element = one staffing equation; a nested**
**list or group id = an aggregate inside that equation.**
- **Empty / OFF / LEAVE guards: empty result →**
`"Non-empty shift types are required, but got {preference.shiftType}"`
(`preference_types.py:136-137). Any group containing OFF_sid →`
`"'OFF' is not allowed in shift type requirement preferences. To specify a zero-shift day, define an ALL shift type for that date with requiredNumPeople set to 0." (:138-143). Any group containing`
`LEAVE_sid → "'LEAVE' is not allowed in shift type requirement preferences. Paid leave is not a worked shift and provides no coverage." (:144-148).`
- **Coefficients via **`_parse_shift_type_requirement_coefficients`
(`:59-89): default coefficient 1 per selected shift type. Coefficients are`
only allowed when `shiftType normalizes to exactly one group, else`
`"Shift type requirement coefficients are only supported when shiftType normalizes to one requirement group." (:66-69). Each entry: coefficient`
`< 1 → "Shift type requirement coefficient for '{id}' must be at least 1."`
(`:74-75); id not covered by shiftType →`
`"...must be covered by shiftType." (:78-79); overlapping ids →`
`"Duplicate shift type requirement coefficient for '{id}'." (:80-82).`
- **Constraint built (per date **`d, per requirement group ss):`
  - Qualified people: default `ctx.map_ds_p[(d,s)] per s; if`
`qualifiedPeople given, restrict to those ps and add hard`
`Σ_{p∉qualified} shifts[(d,s,p)] == 0 for each s (:153-163).`
`None-vs-"ALL" equivalence caveat: this is only true because`
`ctx.map_ds_p[(d,s)] is currently populated as every person`
(`scheduler.py:215-218 builds it over the full (d,s,p) product with no`
restriction). `None (skip the exclusion constraint) and explicit "ALL"`
(`parse_pids("ALL") = all people, exclusion sum over the empty`
complement = vacuous `0 == 0) therefore build identical models today.`
If `map_ds_p is ever narrowed to a restricted per-shift eligibility set,`
the two paths would diverge and this equivalence would need re-deriving.
  - `actual_n_people = Σ_{s∈ss, p∈qualified} coefficients[s] * shifts[(d,s,p)]`
(`:169).`
  - If `preferredNumPeople is None: hard exact actual_n_people == requiredNumPeople (:172-173).`
  - If `preferredNumPeople is not None: hard band`
`actual_n_people >= requiredNumPeople (:170-171) `**and**
`actual_n_people <= preferredNumPeople (:176-177), plus a soft penalty:`
integer `diff var in [0, preferredNumPeople],`
`diff == preferredNumPeople - actual_n_people (:178-183), then`
`add_objective(ctx, weight, diff). With the default/typical negative`
weight this maximizes toward `diff == 0 (fully staffed to preferred).`
  - **Infinity ban with preferred: if **`preferredNumPeople is set and`
`weight ∈ {+inf, -inf} →`
`"Infinity weights are not allowed for shift type requirement with 'preferredNumPeople'. Use 'requiredNumPeople' instead to enforce hard constraints." (:187-190).`
- **Aggregate vs concrete layering: a concrete **`(date, shift type) may`
appear in multiple requirement equations (including aggregates); all matching
constraints apply. Duplicate coverage is logged (info) via
`ctx.shift_type_requirement_coverage (:136-148), not an error.`
- **OFF handling: OFF is forbidden in **`shiftType (see guard above). LEAVE`
is likewise forbidden (it provides no coverage).
- **Hard/soft: the staffing bound is always hard; the preferred-shortfall**
penalty is soft.

### CON-SEM-03 — `shift request`

- **Model: **`ShiftRequestPreference (models.py:213-221). Params: person`
(id/group or list), `date (single or list), shiftType: str | list[str],`
`weight: int|float = 1.`
- **Handler: **`shift_request (preference_types.py:206-244). "Soft`
constraint."
- **Resolution: **`ds = parse_dates(date), ss = parse_sids(shiftType),`
`ps = parse_pids(person) (:211-213).`
- **Objective built (per **`d, per p):`
  - If `ss is equivalent to ALL shift types (is_ss_equivalent_to_all):`
request "work that day" → the **worked-day indicator**
`worked_sum = Σ_s shifts[(d,s,p)] (which is 0/1 under the day-state`
invariant), `add_objective(ctx, weight, worked_sum)`
(`preference_types.py:238-243). This is **not **negate(offs): a leave`
day has `offs == 0 but worked_sum == 0, so ALL correctly excludes both OFF`
and LEAVE.
  - Else, per `s in ss (each a `**separate objective term — top-level list**
element = separate equation):
    - `s == OFF_sid: add_objective(ctx, weight, offs[(d,p)]) (:250-258) —`
requesting an OFF day.
    - `s == LEAVE_sid: a paid-leave pin — **hard, regardless of weight.The handler doesadd_constraint(leaves[(d,p)] == 1) and records (d,p) in ctx.pinned_leaves (:259-264). Leave is input-only (INV1); therequestweight is **not read for a LEAVE target. This is the sole`
mechanism by which leave enters the model.
    - otherwise `add_objective(ctx, weight, shifts[(d,s,p)]) (:272-280).`
- **Weight: positive encourages the requested shift/OFF; negative discourages**
  1. `±inf is allowed and, via add_objective, hard-forces the requested`
variable to 1 (or, for `-inf, to 0). **Exception: a LEAVE target is a hard pin for any weight (see above).`
- **OFF handling: **`OFF selects offs[(d,p)]; LEAVE pins leaves[(d,p)] (hard);`
both explicit and supported here.
- **Hard/soft: soft by default; hard when **`weight = ±inf; a LEAVE target is`
always hard.

### CON-SEM-04 — `shift type successions`

- **Model: **`ShiftTypeSuccessionsPreference (models.py:228-236). Params:`
`person, pattern: list[str | list[str]] (required), date: ... | None = None, weight: int|float = 1.`
- **Handler: **`shift_type_successions (preference_types.py:247-374). "Soft`
constraint" (but supports hard via `±inf).`
- **Pattern typing: **`pattern must be a list, else`
`"Pattern must be a list, but got {type}" (:254-255). Each element is`
flattened to a sorted deduped id set (a nested list / group aggregates into a
single position); a position equivalent to ALL becomes the `ALL sentinel`
(`:257-274). Pattern length = number of consecutive days matched.`
- **Dates: all days if **`date is None, else parse_dates (:276-279).`
- **Window scan: for each person **`p and each start day d_begin such that`
the whole window `[d_begin, d_begin+len) lies inside ds, evaluate the`
pattern (`:289-292).`
- **Per-position match expression **`_pattern_element_match_expr`
(`preference_types.py:317-327):`
  - `ALL position → the worked-day indicator Σ_s shifts[(d,s,p)] (any worked`
shift matches; OFF and LEAVE do `**not match an ALL position — it is not`
`negate(offs), so a leave day does not satisfy ALL).`
  - single-id position → that day-state variable via `_day_state_expr`
(`shifts[(d,s,p)] for a worked id, offs[(d,p)] for OFF_sid, leaves[(d,p)]`
for `LEAVE_sid).`
  - multi-id position → sum of the member day-state variables (OFF member =
`offs, LEAVE member = leaves).`
- **History integration (**`:296-317): only for d_begin == 0 and when`
`people[p].history is set. History ids are parsed; a history entry that is`
nested → `"History must not include nested ID, but got {entry}"`
(`:301-304), or equals ALL → "History must not include 'ALL', but got {entry}" (:305-306). For each suffix length, if the history suffix matches`
the pattern prefix, the remaining pattern suffix is added as an additional
pattern to check (so patterns straddling history→future are honored). A
fully history-satisfied pattern yields `target_n_matched == 0, handled by`
forcing an `is_match == 1 term with add_objective(weight, is_match)`
(`:323-330).`
- **Objective / constraint built per window (**`:318-374), with`
`target_n_matched = len(pattern) and`
`actual_n_matched = Σ position-match-exprs:`
  - `weight == -inf: hard actual_n_matched <= target - 1 (forbid the full`
succession) (`:338-340).`
  - `weight == +inf: hard actual_n_matched == target (force it) (:341-343).`
  - finite `weight < 0 with an all-literal pattern: create is_match with`
`is_match >= actual_n_matched - target + 1 and add_objective(weight, is_match) — marks/penalizes a violation, preferring is_match == 0`
(`:348-358).`
  - otherwise: build `is_match = (all positions match) via a bool-and var or`
an EQ-constrained bool var (`create_bool_and_var /`
`create_bool_var_with_constraint), then add_objective(weight, is_match)`
(`:359-373).`
- **List-vs-nested: within **`pattern, each `**top-level element = one day**
**position; a nested list at a position = aggregate of acceptable shift**
types for that day.
- **OFF handling: **`OFF at a position matches via offs; LEAVE via leaves`
(both through `_day_state_expr). ALL matches any worked shift only — it`
excludes both OFF and LEAVE.
- **Hard/soft: soft for finite weights; hard for **`±inf.`

### CON-SEM-05 — `shift count`

- **Model: **`ShiftCountPreference (models.py:283-302). Params: person,`
`countDates (single/list), countShiftTypes: str | list[str],`
`countShiftTypeCoefficients: list[tuple[str,int]] | None = None,`
`expression: str | list[str], target: int | list[int],`
`hoursContract: HoursContractMetadata | None = None (authoring-only),`
`weight: int|float = -1.`
- **`hoursContract` is solver-inert.** The optional strict metadata (C1 CON-YAML-25)
is not read by `shift_count` or any handler: presence, fixed unit, policy, target
marker fields never alter `x`, coefficients, target, weight,
constraints, or objective. The shared raw fields below are the sole solve inputs.
- **Handler: **`shift_count (preference_types.py:403-498). "Soft`
constraint."
- **Resolution: **`ps = parse_pids(person), c_ds = parse_dates(countDates),`
`c_ss = parse_sids(countShiftTypes); empty c_ss →`
`"Non-empty count shift types are required, but got {countShiftTypes}"`
(`:408-412).`
- **Coefficients via **`_parse_shift_count_coefficients (:377-400): default`
`1; entry < 1 → "Shift count coefficient for '{id}' must be at least 1."`
(`:387); not covered by countShiftTypes → "...must be covered by countShiftTypes." (:391); overlapping → "Duplicate shift count coefficient for '{id}'." (:393).`
- **Expression/target pairing (**`:415-420): both normalized to lists via`
`ensure_list; lengths must match else "Number of expressions ({n}) must match number of targets ({m})"; empty → "Expression must not be empty".`
Each **top-level expression/target pair = one separate soft equation (per**
person).
**DL09 target diagnostic fix:** include the pair index in each generated model-variable
and report prefix so Range lower/upper comparisons do not overwrite or duplicate names.
- **Count expression (**`preference_types.py:470-474): per person,`
`x = Σ_{d∈c_ds, s∈c_ss} coefficients[s] * _day_state_expr(d, s, p), where`
`_day_state_expr maps a worked id → shifts[(d,s,p)], OFF_sid → offs[(d,p)],`
and `LEAVE_sid → leaves[(d,p)]. So OFF days and LEAVE days are countable`
(credited by their coefficient), exactly like worked shifts.
`max_x = len(c_ds) * max(coefficient) (at most one selected day-state per`
day).
- **Target guard: **`T < 0 → "Target must be non-negative, but got {T}"`
(`:424-425).`
- **Supported expressions (**`:441):`
`["|x - T|^2", "x >= T", "x <= T", "x > T", "x < T", "x = T"]. Any other →`
`"Unsupported expression: {expression}. Supported expressions are: [...]"`
(`:495-498).`
  - `"|x - T|^2" (:443-474): build abs_diff = |x - T| then squared = abs_diff^2, and add_objective(weight, squared). Weight rules:`
`weight == +inf → "'.inf' weights are not allowed for shift count with '|x - T|^2'." (:468-469); weight finite and > 0 (and not -inf) →`
`"Weight must be non-positive for shift count with '|x - T|^2'."`
(`:470-472). So only non-positive finite weights or -inf are allowed`
(`-inf hard-forces squared == 0, i.e. x == T).`
  - comparison expressions (`:475-494): build a boolean expr var =`
`(x <op> T) via create_bool_var_with_constraint over (0, max_x), then`
`add_objective(weight, expr). Sign of weight = encourage/discourage the`
comparison holding; `±inf hard-forces it true/false.`
- **OFF handling: **`OFF in countShiftTypes counts OFF days via offs; LEAVE`
counts leave days via leaves (both through `_day_state_expr, coefficient-`
weighted). This is how leave hours are credited toward a contracted-hours
target.
- **Hard/soft: soft; comparison forms may be hardened with **`±inf; squared`
form allows only `-inf as hard.`
- **Guided Contracted Hours encoding (DL09; authoring contract).** Exact emits one
comparison pair (`x = T`, scalar target) with `+inf`. Allowed Range emits two pairs
(`x >= T`, `x <= T`) with `[minimum, maximum]` and `+inf`. `add_objective` hard-pins
each comparison true. Therefore Contracted Hours contributes no finite objective term
and cannot numerically overwhelm other soft preferences. This is a constrained use of
the existing handler; generic unmarked Shift Counts retain every supported expression
and weight above. Marked rules preserve the same dynamic group/`ALL` selectors. A
scenario-root authoring validator expands them before solve and requires complete
explicit concrete coefficient coverage; the handler's generic default `1` remains
unchanged for unmarked counts.

### CON-SEM-06 — `shift affinity`

- **Model: **`ShiftAffinityPreference (models.py:305-318). Params: date`
(single/list), `people1: list[... | list], people2: list[... | list],`
`shiftTypes: list[str | list[str]], weight: int|float = 1.`
- **Handler: **`shift_affinity (preference_types.py:501-619). "Soft`
constraint."
- **Typing guards: **`people1, people2, shiftTypes must each be lists, else`
`"People1 must be a list, but got {type}" (:532-533),`
`"People2 must be a list, but got {type}" (:534-535),`
`"Shift types must be a list, but got {type}" (:560-561).`
- **Flattening (**`:536-573): each top-level element of people1, people2,`
`shiftTypes is flattened to a sorted deduped id set (nested list / group id`
aggregates). Each **top-level element = one independent selector;**
the term is built for **every combination **`(i, j, k) of a people1`
selector, a `people2 selector, and a shiftTypes selector, per date.`
- **Term built per **`(d, i, j, k) (:575-619):`
  - `sum1 = Σ_{p∈p1s, s∈ss} _day_state_expr(d, s, p) (worked shift, OFF, or`
LEAVE member); `some_p1_matched = (sum1 >= 1) over range (0, len(p1s)*len(ss)).`
  - `sum2 / some_p2_matched symmetric for p2s.`
  - `is_match = (some_p1_matched + some_p2_matched == 2) over (0, 2) — true`
iff at least one member of each side works one of the selected shift types
(not necessarily the same one).
  - `add_objective(weight, is_match).`
- **Semantics: positive weight encourages the two sides working together**
(affinity); negative weight discourages it (repulsion). `±inf hard-forces`
togetherness on/off. Formulation is "at least one of each side" (not
pairwise, not same-shift-type) by design.
- **OFF/LEAVE handling: **`OFF and LEAVE in shiftTypes route through`
`_day_state_expr (offs / leaves), so affinity/repulsion can be defined over`
shared OFF days or shared LEAVE days.
- **Hard/soft: soft; **`±inf makes it hard.`

### CON-SEM-07 — `shift type covering`

- **Model: **`ShiftTypeCoveringPreference (models.py:321-345). Params:`**
**`date: (int|str|date) | list[...] | None (default None),`**
**`preceptors: list[int|str | list[int|str]],`**
**`preceptees: list[int|str | list[int|str]],`**
**`shiftTypes: list[str | list[str]],`**
**`weight: int|float = 1.`**
`date` semantics (**updated — see [decision log 08](../../decision-logs/08-covering-omitted-date-all-dates/index.md)**):
the model field is `Optional` with default `None`, documented `None = ALL`. The
handler (`preference_types.py:672-680`) now mirrors the shift-type-requirement
and successions handlers — an omitted date applies to **all** dates:

```python
ds = range(ctx.n_days)
if preference.date is not None:
    ds = utils.parse_dates(preference.date, ...)
```

| `date` | Meaning |
| --- | --- |
| **omitted / `None`** | **all dates** (rule constrains every day) |
| `[ALL]` / concrete date ids | those dates |
| **`[]` (explicit empty list)** | **no dates** — no-op (`parse_dates([]) == []`) |

Only a *provided* `date` is passed to `parse_dates`, so an explicit `date: []`
is still a no-op, but an **omitted** `date` now means all dates. This corrects a
prior handler bug (`parse_dates(None)` returned `[]`, making an omitted date a
silent no-op) that contradicted the model's `None = ALL` docstring, the sibling
handlers, and the UI label — and that made every covering rule authored in the
current UI (which drops `date` on save, FR-PR-84) a no-op. A rebuild may target
all dates by omitting `date` **or** emitting `date: [ALL]`.

- **Handler: **`shift_type_covering (preference_types.py:622-732).`
Dispatch entry in `PREFERENCE_TYPES_TO_FUNC at preference_types.py:742`
(`models.SHIFT_TYPE_COVERING: shift_type_covering). "Hard constraint."`
- **Typing guards (**`:636-641): preceptors, preceptees, shiftTypes`
must each be lists, else
`"Preceptors must be a list, but got {type}",`
`"Preceptees must be a list, but got {type}",`
`"Shift types must be a list, but got {type}".`
- **Flattening (**`:643-664, _flatten_persons and _flatten_shifts):`
same convention as `shift affinity (CON-SEM-06). Each top-level element`
is flattened to a sorted deduped index set (nested lists and group ids
expand); each top-level element becomes **one independent selector.**
- **Empty-selector errors (**`:670-675):`
  - `preceptors flattened to [] →`
`Preceptors list must contain at least one valid person or group.`
  - `preceptees flattened to [] →`
`Preceptees list must contain at least one valid person or group.`
  - `shiftTypes flattened to [] →`
`Shift types list must contain at least one valid shift type.`
- **Term built per **`(d, preceptor_group, preceptee_group, shift_type_group)`
cross product (`:677-732):`
  - `preceptor_vars = [shifts[(d, s, p)] for s ∈ shift_type_group for p ∈ preceptor_group]`
  - `preceptee_vars = [shifts[(d, s, p)] for s ∈ shift_type_group for p ∈ preceptee_group]`
  - `any_preceptee = create_bool_var_with_constraint(sum(preceptee_vars) >= 1, (0, len(preceptee_vars)))`
  - `at_least_one_preceptor = create_bool_var_with_constraint(sum(preceptor_vars) >= 1, (0, len(preceptor_vars)))`
  - **Hard constraint: **`any_preceptee <= at_least_one_preceptor (:721).`
This encodes
`(sum(preceptors shifts) >= 1)  OR  (sum(preceptees shifts) < 1)`
over the full cartesian product of the cross-product terms. **Note**
**on aggregate semantics: the **`preceptor_vars and preceptee_vars`
are built by iterating `for s in shift_type_group for p in person_group,`
so the "shift" half of the index covers **every shift in**
**`shift_type_group, not the same `**`s in both halves. In other`
words, a covering rule with `shiftTypes: [[D, E]] is satisfied`
whenever a preceptor works **either D or E to cover a preceptee**
working D or E; it does **not require the same shift on both**
sides. For strict per-shift coverage semantics, the frontend must
emit independent top-level elements (e.g. `shiftTypes: [D, E],`
which expands to the two terms `[[D]] and [[E]]).`
- **`weight** is accepted but not used. The handler always emits a hard**`**
constraint. Passing `weight: float('inf') or weight: -1 produces`
identical hard-constraint behavior. The model keeps the field for
schema uniformity with the other preference types.
- **OFF/LEAVE handling: both are `**explicitly rejected before any variable`
is built. After flattening `shiftTypes, if any group contains OFF_sid or`
`LEAVE_sid the handler raises`
`"'OFF' and 'LEAVE' are not allowed in shift type covering preferences; covering applies to worked shifts only." (preference_types.py:716-720).`
Covering is a worked-shifts-only implication, so neither OFF nor LEAVE may
appear in its shift-type selector. `[incidental quirk] the current frontend`
covering editor still exposes both auto-generated OFF and LEAVE items in its
shift-type selector (`shift-type-coverings/page.tsx:440-452), so a user can`
author a covering card the backend will reject at solve time. The binding
requirement for a rebuild is the backend error; the new UI SHOULD filter OFF
and LEAVE out of the covering selector to prevent the rejection, but is not
required to replicate the current exposed-but-rejected behavior.
- **Cross-product semantics: the handler builds the constraint per**
`(preceptor_group, preceptee_group, shift_type_group) tuple`
(`:677-686). `**Each top-level `preceptors` element is a separate**
**required selector (conjunctive over preceptor groups), each**
top-level `preceptees element is a separate antecedent, and each`
top-level `shiftTypes element is one equation's shift group`
(aggregate over its inner list, per the aggregate-semantics note
above). A covering rule with `preceptors: [[A], [B]] therefore`
requires **both group A to be present AND group B to be present**
whenever a preceptee works (it is not "any group"). To express
alternatives, put them in a single nested selector or a single
people group, e.g. `preceptors: [[A, B]]. The cross-product`
expansion reifies one Boolean OR implication per tuple.
- **Hard/soft: hard; non-negotiable. The solver cannot leave a**
preceptee working without a preceptor present. There is no soft variant.
- **Reporting: each reified bool is appended to **`ctx.reports`
(`:723-732): pref_<idx>_d_<d>_<...>_any and pref_<idx>_d_<d>_<...>_cover`
with skip-condition `x == 1 (skip the satisfied case). Used for`
per-preference DEBUG logging, not exposed via the HTTP API.

### CON-SEM-08 — The LEAVE day-state (shipped three-state model)

<user_quoted_section>Re-baselined (decision log 06). This is the current, shipped backendmodel, not a future extension. The single reserved LEAVE day-state sitsbeside OFF; both are built in and not user-authored. The earlier "Option C /multi-type / leaveTypes" design is not implemented — see "Deferred(future)" at the end of this section.</user_quoted_section>

- **Reserved, always-present, single. **`LEAVE is a reserved keyword with`
sentinel `LEAVE_sid = -2 (constants.py:25-26), exactly paralleling OFF /`
`OFF_sid = -1. There is exactly one built-in leave type; it is auto-provided`
and never created as a `shiftTypes.items entry (it is forbidden as a user`
shift-type id/group — see Reserved-id rules).
- **One leave variable per (day, person). **`the core creates leaves[(d, p)]`
(leave_d{d}_p{p}) alongside offs[(d, p)] (scheduler.py:188-194; context.py:56-63).
The day-state invariant is `offs + Σ shifts + leaves == 1 (see Decision`
variables) — exactly one of worked / leave / off per (day, person).
- **INV1 — leave is input-only. **`leaves[(d, p)] is pinned to 1 where a LEAVE`
shift request places it (recorded in `ctx.pinned_leaves, preference_types.py:264)`
and `add_constraint(leaves[(d,p)] == 0) is added for every other (d, p)`
(scheduler.py:276-284). The solver has no freedom to invent, add, or move
leave.
- **INV2 — leave never counts toward coverage. **`shift type requirement`
(CON-SEM-02) and `shift type covering (CON-SEM-07) operate on worked-shift`
variables only; `LEAVE (like OFF) is forbidden in their selectors and rejected`
with a validation error. A nurse on leave does not satisfy staffing.
- **INV3 — intended leave is always honored. **`leaves[(d, p)] == 1 forces`
`offs and all shifts to 0 that (d, p) via the day-state invariant. No worked`
shift or OFF can be substituted for an intended leave day.
- **Day-state selector resolution. **`within every preference that takes a`
shift-type selector, a position resolves through `_day_state_expr`
(preference_types.py:32-44): worked id → `shifts[(d,s,p)]; OFF_sid →`
`offs[(d,p)]; LEAVE_sid → leaves[(d,p)]. LEAVE is selectable (as the`
reserved keyword) in shift request, successions, shift count, and shift
affinity; it is forbidden in shift type requirement and shift type covering.
`ALL expands to worked shift types only and excludes both OFF and LEAVE`
(scheduler.py:89-91). To target leave explicitly, name `LEAVE; never use ALL.`
- **Leave contributes credited hours via shift count (CON-SEM-05). **`LEAVE`
selected in `countShiftTypes counts as coefficient[LEAVE] × leaves[(d,p)] —`
the same coefficient shape as worked shifts and OFF. The solver reads the
coefficient the user set in `countShiftTypeCoefficients (keyed by the LEAVE`
keyword); there is no built-in credit value in the shipped backend. `OFF is`
excluded from an hours count simply by not being listed. A count may carry the
solver-inert `hoursContract` marker (CON-SEM-05 / C1 CON-YAML-25) declaring it a
monthly-hours contract; the marker only drives the frontend guard against leaving
`LEAVE` out of exactly this credit, and does not change the credit arithmetic.
- **Leave request pins (CON-SEM-03). **`a shift request whose shiftType`
resolves to `LEAVE hard-pins leaves[(d,p)] == 1 regardless of its weight`
(preference_types.py:259-264). This is the sole mechanism by which leave
enters the model (INV1).
- **History may contain LEAVE. **`a person's pre-period history entry may be a`
worked-shift id, `OFF, or LEAVE (models.py:410-416).`

**Deferred (future — NOT shipped; decision log 05/06). The following were**
designed in spec 12 / decision log 05 but are `**not implemented** in the`
current core and must not be relied on by a parity rebuild: a top-level
`leaveTypes` container; configurable leave credit (`creditMinutes`) and
half-day/multiple leave types; and a Leave Types editor. The shipped model is
the single reserved `LEAVE` sentinel described above. (The pre-Pydantic `LV`
migration once designed here is **removed entirely** — a non-issue, not a
deferred target; decision log 06.)

## Group, Keyword & Date Resolution

### Shift type ids — `parse_sids (utils.py:95-102)`

Resolves each id through `ctx.map_sid_s, extends with the mapped index list,`
returns `sorted(set(...)). Map is built in scheduler.py:86-93:`

- each concrete shift type id → `[s].`
- `ALL ("ALL") → list(range(n_shift_types)) — worked shift types only; it`
excludes both OFF and LEAVE (scheduler.py:89-91).
- `OFF ("OFF") → [OFF_sid] = [-1].`
- `LEAVE ("LEAVE") → [LEAVE_sid] = [-2] (scheduler.py:93).`
- each shift type group id → union of its members' indices (deduped, sorted;
members may be other groups).
Unknown id → `"Unknown shift type ID: {sid}" (utils.py:99-100).`

<user_quoted_section>A selector position is then resolved to a day-state variable by_day_state_expr (preference_types.py:32-44): a worked index → shifts,OFF_sid → offs, LEAVE_sid → leaves. See CON-SEM-08 for the per-handlerLEAVE branches.</user_quoted_section>

### Person ids — `parse_pids (utils.py:105-112)`

Through `ctx.map_pid_p (scheduler.py:97-106): each person id → [p]; ALL →`
all people; each people group id → union of members. Unknown →
`"Unknown person ID: {pid}" (utils.py:109-110). Note: there is no OFF for`
people.

### Dates — `parse_dates / _parse_single_date (utils.py:49-92)`

`ctx.map_did_d (scheduler.py:108-132) maps:`

- each concrete date `str(date_obj) (YYYY-MM-DD) → [d].`
- keyword filters (`constants.py:35-39): ALL (all days), WEEKDAY`
(`weekday() < 5), WEEKEND (weekday() >= 5).`
- weekday keywords (`constants.py:26-34): MONDAY, TUESDAY, WEDNESDAY,`
`THURSDAY, FRIDAY, SATURDAY, SUNDAY (matched by weekday() index).`
- date group ids → union of member indices (members resolved via map or
`parse_dates).`

`parse_dates(dates, ...) (utils.py:69-92): normalizes to a list of strings;`
for each token:

- if in `map_did_d → expand to its day indices.`
- else if it matches `^([\d-]+)~([\d-]+)$ → a **range **A~B; both ends parsed`
by `_parse_single_date, expands to the inclusive day span.`
- else parse as a single date via `_parse_single_date.`
Finally every resolved date must satisfy `startdate <= date <= enddate, else`
`"Date '{date}' is out of the range of start date and end date."`
(`utils.py:88-89). Result is sorted(set(day_indices)).`

`_parse_single_date shorthands (utils.py:49-66):`

- `D (^\d{1,2}$): day-of-month; `**only if start and end share the same year**
**and month, else **`"Pure day format (D) is not allowed when start date and end date are not in the same month.\n- Start date: {start}\n- End date: {end}\n".`
- `MM-DD (^(\d{2})-(\d{2})$): `**only if start and end share the same year,**
else `"Pure month-day format (MM-DD) is not allowed when start date and end date are not in the same year.\n- Start date: {start}\n- End date: {end}\n".`
- `YYYY-MM-DD (^(\d{4})-(\d{2})-(\d{2})$): absolute date.`
- none match → `"Date '{date}' is not in the format of YYYY-MM-DD, MM-DD, or D.\n- Start date: {start}\n- End date: {end}\n".`

### Reserved-id / naming rules (enforced at load, `models.py:369-447)`

- Shift type reserved ids: `{ALL, OFF, LEAVE} upper-cased; person reserved:`
`{ALL}; date-group reserved: all weekday keywords + {ALL, WEEKDAY, WEEKEND}`
upper-cased. Reserved-id and format collisions produce the messages in the
catalog below.
- `OFF_sid = -1 and LEAVE_sid = -2 are the reserved sentinels; ALL, OFF, and`
`LEAVE are string constants (constants.py:22-26). A user shift-type id or`
group matching any of these (case-insensitively) is rejected.

## Validation Error Catalog

Messages are transcribed verbatim (f-string placeholders shown in `{...}).`
Pydantic-generated messages (schema layer) are prefixed accordingly. The
`core/tests/testcases/basics/*_error.txt files contain the (sometimes`
truncated) substring each test asserts; cross-references given where a fixture
exists.

| # | Exact message | Source (@line) | Trigger | Testcase fixture |
| --- | --- | --- | --- | --- |
| E01 | `Float weights can only be positive infinity or negative infinity.` | models.py:42 | Any non-`±inf float weight` | `01_..._weight_floating_point_error.txt (asserts Value error, Float weights can only be positive infinity or negative infinity.)` |
| E02 | `Extra inputs are not permitted` | pydantic (`extra="forbid", models.py:48 etc.)` | Unknown/extra field | `01_..._extra_parameter_error.txt` |
| E03 | `Input should be a valid list` | pydantic type check | `pattern/list field given a non-list` | `01_..._pattern_not_list_error.txt` |
| E04 | `Missing required preferences: {missing}` | models.py:375 | `at most one shift per day absent` | — |
| E05 | `enddate must be after or equal to startdate` | models.py:379 | `endDate < startDate` | — |
| E06 | `Duplicated shift type ID: {id!r}` | models.py:387 | Duplicate shift type id | — |
| E07 | `Shift type ID {id!r} cannot be one of the reserved values: {shift_type_reserved_ids}` | models.py:388-391 | Shift type id = ALL/OFF/LEAVE (any case) | — |
| E08 | `Duplicated shift type group (or shift type) ID: {id!r}` | models.py:395 | Group id collides | — |
| E09 | `Shift type group ID {id!r} cannot be one of the reserved values: {shift_type_reserved_ids}` | models.py:396-399 | Shift type group id = ALL/OFF/LEAVE | `01_..._shift_types_group_keyword_all_error.txt (...Shift type group ID 'ALL' cannot be one of the reserved values)` |
| E10 | `Duplicated person ID: {id!r}` | models.py:407 | Duplicate person id | — |
| E11 | `Person ID {id!r} cannot be one of the reserved values: {people_reserved_ids}` | models.py:408-409 | Person id = ALL | — |
| E12 | `History must not include 'ALL', but got {id!r}` | models.py:412 | `history entry = ALL (load-time)` | — |
| E13 | `History must not include group ID, but got {id!r}` | models.py:414 | `history entry is a group id` | — |
| E14 | `Unknown shift type ID in history: {id!r}` | models.py:416 | `history id not OFF, not LEAVE, and not a known shift type` | — |
| E15 | `Duplicated people group (or person) ID: {id!r}` | models.py:420 | People group id collides | — |
| E16 | `People group ID {id!r} cannot be one of the reserved values: {people_reserved_ids}` | models.py:421-424 | People group id = ALL | `01_..._people_group_keyword_all_error.txt (...People group ID 'ALL' cannot be one of the reserved values)` |
| E17 | `dates.items is not allowed since it is automatically generated from dates.range` | models.py:429 | `dates.items supplied` | — |
| E18 | `Duplicated date group ID: {id!r}` | models.py:434 | Duplicate date group id | — |
| E19 | `Date group ID {id!r} cannot be one of the reserved values: {date_reserved_ids}` | models.py:435-438 | Date group id = ALL/WEEKDAY/WEEKEND/weekday name (any case) | `01_..._dates_group_keyword_all_error.txt (...'all'...), ..._monday_error.txt (...'monday'...), ..._weekday_error.txt (...'Weekday'...)` |
| E20 | `Date group ID {id!r} must not be in the format of YYYY-MM-DD, MM-DD, or D` | models.py:444 | Date group id looks like a date literal | — |
| E21 | `Shift type requirement coefficients are only supported when shiftType normalizes to one requirement group.` | preference_types.py:67-69 | Coefficients + multiple requirement groups | — |
| E22 | `Shift type requirement coefficient for '{id}' must be at least 1.` | preference_types.py:75 | Coefficient `< 1` | — |
| E23 | `Shift type requirement coefficient for '{id}' must be covered by shiftType.` | preference_types.py:79 | Coefficient id not in `shiftType` | — |
| E24 | `Duplicate shift type requirement coefficient for '{id}'.` | preference_types.py:82 | Overlapping coefficient ids | — |
| E25 | `Non-empty shift types are required, but got {shiftType}` | preference_types.py:122 | Empty normalized `shiftType` | — |
| E26 | `'OFF' is not allowed in shift type requirement preferences. To specify a zero-shift day, define an ALL shift type for that date with requiredNumPeople set to 0.` | preference_types.py:138-143 | `OFF in requirement shiftType` | `01_..._shift_type_requirement_off_error.txt ('OFF' is not allowed in shift type requirement preferences.)` |
| E26a | `'LEAVE' is not allowed in shift type requirement preferences. Paid leave is not a worked shift and provides no coverage.` | preference_types.py:144-148 | `LEAVE in requirement shiftType` | — |
| E26b | `'OFF' and 'LEAVE' are not allowed in shift type covering preferences; covering applies to worked shifts only.` | preference_types.py:716-720 | `OFF or LEAVE in covering shiftTypes` | — |
| E27 | `Infinity weights are not allowed for shift type requirement with 'preferredNumPeople'. Use 'requiredNumPeople' instead to enforce hard constraints.` | preference_types.py:188-190 | `preferredNumPeople set + weight = ±inf` | — |
| E28 | `Pattern must be a list, but got {type}` | preference_types.py:255 | `pattern not a list (handler-level)` | — |
| E29 | `History must not include nested ID, but got {entry}` | preference_types.py:302-304 | Nested id in `history (successions eval)` | — |
| E30 | `History must not include 'ALL', but got {entry}` | preference_types.py:305-306 | `ALL in history (successions eval)` | — |
| E31 | `Shift count coefficient for '{id}' must be at least 1.` | preference_types.py:387 | Coefficient `< 1` | — |
| E32 | `Shift count coefficient for '{id}' must be covered by countShiftTypes.` | preference_types.py:391 | Coefficient id not in `countShiftTypes` | — |
| E33 | `Duplicate shift count coefficient for '{id}'.` | preference_types.py:393 | Overlapping coefficient ids | — |
| E34 | `Non-empty count shift types are required, but got {countShiftTypes}` | preference_types.py:412 | Empty `countShiftTypes` | — |
| E35 | `Number of expressions ({n}) must match number of targets ({m})` | preference_types.py:418 | Length mismatch | — |
| E36 | `Expression must not be empty` | preference_types.py:420 | Zero expressions | — |
| E37 | `Target must be non-negative, but got {T}` | preference_types.py:425 | `target < 0` | — |
| E38 | `'.inf' weights are not allowed for shift count with '{expression}'.` (at runtime `{expression}` is the squared form `\|x - T\|^2`) | preference_types.py:469 | `weight = +inf` with the squared expression | — |
| E39 | `Weight must be non-positive for shift count with '{expression}'.` (at runtime `{expression}` is the squared form `\|x - T\|^2`) | preference_types.py:472 | finite `weight > 0` with the squared expression | — |
| E40 | `Unsupported expression: {expression}. Supported expressions are: {SUPPORTED_EXPRESSIONS}` | preference_types.py:497-498 | Expression not in supported set | — |
| E41 | `People1 must be a list, but got {type}` | preference_types.py:533 | `people1 not a list` | — |
| E42 | `People2 must be a list, but got {type}` | preference_types.py:535 | `people2 not a list` | — |
| E43 | `Shift types must be a list, but got {type}` | preference_types.py:561 | `shiftTypes not a list (affinity)` | — |
| E43a | `Preceptors must be a list, but got {type}` | preference_types.py:637 | `preceptors not a list (covering)` | — |
| E43b | `Preceptees must be a list, but got {type}` | preference_types.py:639 | `preceptees not a list (covering)` | — |
| E43c | `Shift types must be a list, but got {type}` | preference_types.py:641 | `shiftTypes not a list (covering)` | — |
| E43d | `Preceptors list must contain at least one valid person or group.` | preference_types.py:671 | Empty `preceptors (covering)` | — |
| E43e | `Preceptees list must contain at least one valid person or group.` | preference_types.py:673 | Empty `preceptees (covering)` | — |
| E43f | `Shift types list must contain at least one valid shift type.` | preference_types.py:675 | Empty `shiftTypes (covering)` | — |
| E44 | `Unknown shift type ID: {sid}` | utils.py:100 | Unresolvable shift id | — |
| E45 | `Unknown person ID: {pid}` | utils.py:110 | Unresolvable person id | — |
| E46 | `Pure day format (D) is not allowed when start date and end date are not in the same month.\\\\\\\\n- Start date: {start}\\\\\\\\n- End date: {end}\\\\\\\\n` | utils.py:53-56 | `D shorthand spanning months` | — |
| E47 | `Pure month-day format (MM-DD) is not allowed when start date and end date are not in the same year.\\\\\\\\n- Start date: {start}\\\\\\\\n- End date: {end}\\\\\\\\n` | utils.py:59-62 | `MM-DD shorthand spanning years` | — |
| E48 | `Date '{date}' is not in the format of YYYY-MM-DD, MM-DD, or D.\\\\\\\\n- Start date: {start}\\\\\\\\n- End date: {end}\\\\\\\\n` | utils.py:66 | Unparseable date token | — |
| E49 | `Date '{date}' is out of the range of start date and end date.` | utils.py:89 | Resolved date outside `[start, end]` | asserted in `test_scheduler.py:76 (out of the range of start date and end date)` |
| E50 | `Unsupported API version: {apiVersion}` (raised as `NotImplementedError`; the class name is not part of `str(error)`) | scheduler.py:78 | `apiVersion != "alpha"` | asserted `test_scheduler.py:46` |
| E51 | `Country {country} is not supported yet` | scheduler.py:110 | `country not None/"SG"` | asserted `test_scheduler.py:53` |
| E52 | **(REMOVED from current backend.) Historical message** |  |  |  |
| `Unsupported solver configuration: backend={backend!r}, engine={engine!r}` |  |  |  |  |
| is no longer raised by the current code — the `schedule() function` |  |  |  |  |
| unconditionally instantiates `ORToolsSolver and no solver-string` |  |  |  |  |
| dispatch exists (`scheduler.py:136-139). The PuLP/CBC/cuOpt` |  |  |  |  |
| solver modules that previously could produce this string have been |  |  |  |  |
| removed from the source tree. The row is preserved here as a |  |  |  |  |
| migration marker; do not implement it in a rebuilt frontend or |  |  |  |  |
| test. | — | — | — |  |
| E53 | `Invalid value: {value}` | scheduler.py:188 | `avoid_solution value not 0/1` | asserted `test_scheduler.py:68` |
| E54 | `No solution found! Status: {status}` | scheduler.py:333 | Solver returns non-OPTIMAL/FEASIBLE/INFEASIBLE/MODEL_INVALID | asserted `test_scheduler.py:638` |

Notes on reserved-id fixtures (E07/E09/E16/E19): the `.txt fixtures assert a`
**prefix substring ending before **`: {reserved_set} (e.g. Value error, Date group ID 'all' cannot be one of the reserved values), and are prefixed with`
`Value error, because they surface through pydantic's model_validator. The`
canonical full message is the code string in the Source column. The `id!r`
repr and the comparison being case-insensitive (`.upper()) explain why input`
`all/monday/Weekday all trigger E19.`

## Conformance Notes

- This is a **contract: the rebuilt frontend MUST produce scenarios that obey**
these semantics and SHOULD surface the exact error strings above when it
mirrors a validation the core performs. It MUST NOT redefine any semantics.
- Preference handlers execute in scenario order; hard constraints from any
handler (including `±inf objective terms) combine with the OFF invariant.`
Infeasible combinations yield E54 / INFEASIBLE, not a validation error.
- `add_objective is the single funnel for ±inf→hard and finite→soft; the`
objective is always maximized (`scheduler.py:290). Sign conventions`
(positive = encourage, negative = discourage) follow directly from that.
- The list-vs-nested-list convention is uniform: top-level element = separate
equation/term; nested list or expanding group = aggregate within one
equation/term. It is realized independently in
`_parse_shift_type_requirement_groups (CON-SEM-02), pattern flattening`
(CON-SEM-04), and `people1/people2/shiftTypes flattening (CON-SEM-06);`
in `shift request (CON-SEM-03) each top-level shiftType yields a separate`
objective term.
- `OFF (-1) and LEAVE (-2) are valid day-state selectors in shift request,`
`shift type successions, shift count, and shift affinity (via offs / leaves).`
They are `**forbidden in shift type requirement (E26 / E26a) and shift type** **covering (E26b). LEAVE in a shift request is a hard pin regardless of`
weight (CON-SEM-03/08). `ALL is never a valid concrete id or group id, and is`
not a valid history entry; OFF and LEAVE `**are valid history entries.**
- Only `±inf floats are ever accepted (E01); all other magnitudes must be`
integers.

## Cross-References

- Sources: `core/nurse_scheduling/preference_types.py,`
`core/nurse_scheduling/scheduler.py, core/nurse_scheduling/utils.py,`
`core/nurse_scheduling/constants.py, core/nurse_scheduling/models.py.`
- Error fixtures: `core/tests/testcases/basics/*_error.txt (see catalog`
column) and assertions in `core/tests/test_scheduler.py.`
- Related contracts: C1/C2 scenario schema & data model (this contract assumes
the pydantic models in `models.py as the field-level schema authority).`
