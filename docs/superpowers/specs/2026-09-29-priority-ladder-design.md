# Priority ladder for rule weights (bead vjbv)

Status: draft for user review, 2026-09-29. No code changes until the user approves.
Blocks: uv8n (spare-slot bonuses). Related: msnp (leave repair).

## 1. Problem

Every soft rule carries a weight, and the solver maximizes one sum of all weights. Today each screen, each assistant operation and each playbook line picks its own number. The numbers do not follow one order, so a low-value goal can beat a high-value one. Two real examples:

- A new "ideally" staffing count defaults to -50 per empty place. A nurse's soft day off from the assistant is 10. So one optional spare place beats five nurse day offs. The user ruled the opposite: leave, offs and preferences win over spare places.
- A day off painted on the Requests screen defaults to weight 0, and weight 0 has no effect in the solver.

The user directive (2026-09-28): the assistant must plan bonuses and penalties deliberately for each ward, so the roster meets the ward's needs, wants and preferences. It must not pick arbitrary numbers.

## 2. How the core scores a roster today

- Every weight is an integer, `.inf` or `-.inf` (`core/nurse_scheduling/models.py:312,327,371,458,474,504`).
- `.inf` / `-.inf` makes the term a hard constraint. A finite weight adds `weight * expression` to one objective (`core/nurse_scheduling/utils.py:35-49`).
- The core maximizes that sum (`core/nurse_scheduling/scheduler.py:412`). So score = points earned minus points lost.
- Per rule type, one unit of the expression is:

| Rule type | One unit | Code |
|---|---|---|
| Staffing "ideally P" | one empty place on one date: `weight * (P - actual)`, with a hard ceiling `actual <= P` | `preference_types.py:137-150` |
| Request (shift, OFF) | one person-date: `weight * shift` or `weight * off`. LEAVE is a hard pin at any weight | `preference_types.py:180-214` |
| Shift sequence | one person-date where the pattern matches | `preference_types.py:267-327` |
| Count `x OP T` | one person: a true/false step, not a line | `preference_types.py:390-407` |
| Count `\|x - T\|^2` | one person: the squared distance from the target | `preference_types.py:362-388` |
| Pairing, supervision | one person-date match | `preference_types.py` (affinity, covering) |

Two facts matter for sizing. A weight counts once per unit, so a rule's real cost is `weight x units broken`. A squared count grows with the square of the distance, so no single weight puts it in one tier at every distance.

## 3. Inventory of weights in use

| Where | Value | Meaning | Code |
|---|---|---|---|
| Core defaults per type | request 1, sequence 1, requirement -1, count -1, pairing 1, covering 1 | used when YAML has no weight | `models.py` lines above, mirrored in `web/lib/scenario/import-scenario.ts:49-57` |
| Requests quick paint | 0 | no solver effect | `web/components/requests/requests-editor.tsx:74` |
| Cell editor, off wish | 0 | no solver effect | `web/components/requests/cell-preference-editor.tsx:83,91`, `use-requests.ts:400` |
| Preview wording for 0 | "no effect (weight 0)" | | `web/lib/proposal/diff.ts:313` |
| Shift sequences form | -1 | | `web/components/successions/successions-model.ts:67` |
| Shift counts form | -1 | | `web/components/counts/counts-model.ts:117` |
| Pairings form | 1 | | `web/components/affinities/affinities-model.ts:68` |
| Supervision form | 1 (assistant always sends a must) | | `web/components/coverings/coverings-model.ts:43`, `web/lib/proposal/commands.ts:358` |
| Requirement preferred count (form and shift card) | -50 | per empty place per date | `web/components/requirements/requirements-model.ts:166`, `web/components/shift-types/save-shift-card.ts:473` |
| Assistant soft request (repair softening) | 10 | `SOFT_REQUEST_WEIGHT` | `web/lib/ai/assistant/playbook.ts:443`, used in `repair-options.ts` |
| Assistant sequence guidance | "-50" discourage, "10" encourage (day off after nights) | examples in the tool schema | `web/lib/proposal/commands.ts:529-537` |
| Assistant count guidance | "10" keep to it, "-5" pull toward T | tool schema | `web/lib/proposal/commands.ts:512-527` |
| Surplus staff (4h5a, on develop) | -300 / -200 / -100 on "ideally" counts | penalty per empty place | `web/lib/ai/assistant/playbook.ts:165` |
| Rest rule, 2 in any 7 days (1v5k) | -1000 per broken 7-day window per nurse | | `web/lib/rules/rest-days.ts:32-40` |
| Spare-slot bonus (uv8n, branch only, `adc0706`) | +3 / +2 / +1 per shift, "ideally" weight 0 | reward per filled shift | `feat/uv8n-spare-slot-rewards` |
| Pairing +infinity | refused by the assistant | | `web/lib/proposal/operations.ts:1214` |
| Contracted hours | must be `.inf` | always hard | `core/nurse_scheduling/group_map.py:42-43` |

The `rest-days.ts` comment also names "usual ward preferences (8-60)" and "a preferred head count at -100000". Nothing in the code sets those numbers. They are notes, not defaults.

## 4. The tiers

From highest to lowest. A higher tier must win over any realistic amount of a lower tier.

| Tier | Name | Examples | Weight |
|---|---|---|---|
| H | Hard musts | staffing minimums, leave, contracted hours, supervision, and the hard rest rules in section 4.1 (no 7 days in a row, sleep day after nights, no day shift after a night, at most 4 nights in a row) | `.inf` / `-.inf` |
| 1 | Strong ward rules | 2 rest days in any 7 days, and the strong rest rules in section 4.1 (a full day off after the sleep day, at most 3 nights in a row, no PM then AM) | 1000 |
| 2 | Ward preferences | avoid a named pattern, keep two nurses apart where possible | 100 to 300 |
| 3 | Nurse wishes | soft day off, shift wish, "never nights" wish | 20 to 40 (default 20) |
| 4 | Fairness and balance | balance nights or weekends, `\|x - T\|^2` counts, soft caps | 4 per unit (squared: 4 per squared shift) |
| 5 | Spare-slot bonuses | optional senior lead, 3rd morning, 3rd afternoon | +1 to +3 per filled shift |

### 4.1 Rest and fatigue rules (user ruling and research, 2026-09-29)

User ruling: rest after nights is a safety rule, so nurses stay sharp and avoid incidents. It is not a ward preference. The research is in `docs/research/2026-09-29-sg-nurse-rest/` (01 Singapore law and guidance, 02 international fatigue evidence, 03 Singapore ward practice).

Findings in short:

- Singapore law is silent on rest after nights, rest between shifts and consecutive nights. The WSH Act s.12 duty and the WSH Council fatigue guidelines fill the gap (01). So these rules are a safety policy, not a legal duty.
- Union agreements give 1 rest day per week and 40 hours per week on average. MOM counts a shift worker's rest day as 30 continuous hours (01, 03).
- Singapore wards roster the day after the last night as a sleep day ("SD"), separate from a day off ("DO"). Nurses complain when the sleep day takes the place of a real day off (03, forum evidence only).
- International rules and guidance: 46 to 48 hours off after a night block, at most 4 nights in a row (3 preferred), 11 hours between shifts (02).

| Rule | Tier | Weight | How the app states it |
|---|---|---|---|
| At most 6 work days in a row | H | `-.inf` | existing legal rest rule |
| Sleep day: the day after the last night has no day shift | H | `-.inf` | sequence N then AM or PM |
| At most 4 nights in a row | H | `-.inf` | sequence of 5 N |
| A full day off after the sleep day (N, SD, DO, about 46 hours) | 1 | -1000 | sequence N, OFF, work |
| At most 3 nights in a row | 1 | -1000 | sequence of 4 N |
| No PM then AM next day (a gap of about 9 hours) | 1 | -1000 | sequence PM then AM |
| Forward rotation (AM, PM, N) | 2 | -100 | sequence of a backward pair |

Every rule in the table is a shift sequence card, so no core change is needed. The "2 rest days in any 7 days" count (1v5k) counts the sleep day as a rest day. The "full day off after the sleep day" rule makes sure that the nurse also gets a real day off. The shift names are the ward's own. The assistant maps "night", "morning" and "afternoon" to the ward's shift types and asks if the mapping is unclear.

Leave stays hard. The assistant never turns leave into a weight. Leave changes only through a move or a cancel that the nurse agrees to (msnp).

## 5. Sizing rule

### 5.1 Strict ordering is not practical

Strict (lexicographic) ordering says: the whole lower tier at its maximum must not outweigh one unit of the tier above. For a 28-day ward of 20 nurses:

- Bonus tier maximum: 3 points x 560 person-days = 1680. So a wish must be above 1680.
- 20 nurses with 8 wishes each is 160 wishes. So a ward preference must be above 160 x 1681, about 270000.
- A ward preference can apply on every person-date (560). So a strong rule must be above about 1.5 x 10^8.

CP-SAT accepts 64-bit integer coefficients, so this is legal. It is still a bad choice here:

- A spread of 10^8 weakens the LP bound. The optimality gap then does not close in 15 s on 2 cores (see `docs/research/2026-09-28-solver-alternatives/01-requirements-and-ortools-limits.md`). The roster gets worse, not better.
- A score such as 149 998 213 means nothing to a ward manager.

### 5.2 Chosen rule: local exchange

The solver trades one tier for another by changing a few person-days. So size each tier against what one person-day change can gain in the tier below:

```
unit(k) >= m x G(k+1)
G(k+1) = the most tier k+1 can gain from changing one person-day
m      = safety factor, 2 or more
```

Worked example, 28 days, 20 nurses, the ladder values in section 4:

| Step | G of the lower tier | Unit of the higher tier | Holds |
|---|---|---|---|
| Bonus to fairness | one extra shift earns at most +3 | squared count, distance 0 to 1, costs 4 | yes, 4 > 3 |
| Fairness to wishes | one extra shift moves one nurse 1 step: costs 4 (0 to 1), 12 (1 to 2), 20 (2 to 3) | one wish is 20 | yes, up to a distance of 2 from target |
| Wishes to ward preferences | one person-day breaks at most one wish, 40 at most | 100 | yes, m = 2.5 |
| Ward preferences to strong rules | one person-day breaks at most one sequence match, 300 at most | 1000 per window | yes, m = 3.3 |
| Strong rules to hard | not traded | `.inf` | yes |

Largest coefficient: 1000, the same as today's rest rule. The worst objective size is about 20 nurses x 22 windows x 1000 = 440 000. Both are safe for CP-SAT.

The rule has a known ceiling. A long chain of swaps can gain more than one person-day, so a lower tier can still win in a rare case. The pre-Run check (section 7) and the per-tier score (section 8) make that case visible.

### 5.3 Deferred: multi-stage solve

A true lexicographic solve runs one solve per tier and fixes each tier's best value before the next. It gives an exact order with small weights. It needs a core change (the core stays close to v1) and 5 solves inside one 15 s budget. Defer it until the local rule fails on a real ward.

## 6. Assistant behaviour

Recommendation: the assistant names a tier, not a number. The host turns the tier into the weight.

1. Each rule operation (requests, sequences, counts, pairings, staffing "ideally", bonus) takes `priority: "must" | "strong" | "ward" | "wish" | "fairness" | "bonus"` and an optional `rank` 1 to 3 inside the tier. The host maps them to the section 4 ranges. A raw number stays accepted for an edit of an existing rule, and the pre-Run check still reads it. This is the production-API layer from `CLAUDE.md`: an arbitrary number is no longer the easy path.
2. During setup, the assistant builds a priority plan for the ward. It lists each need with its tier in one message, before it sends the rule changes.
3. When two needs of the ward can conflict, the assistant asks on one choice card which wins, with the ladder order preselected. Example: "A nurse's day off or a 3rd nurse on mornings: which wins?" It asks only when the ward's answer can differ from the ladder.
4. Each Preview line says the points in plain words and the reason: "+3 points for each A_sup shift. Lowest priority: a nurse's day off (20 points) always wins."
5. The playbook gets one short "Priorities" block with the tier table. `PLAYBOOK_VERSION` goes up.

## 7. Pre-Run check

One pure function in production code: `web/lib/rules/priority-ladder.ts`.

- `tierOf(card)`: a `Record` keyed by card kind, so a new card kind fails the type check until someone places it in a tier.
- `checkWeightOrder(state): LadderFinding[]`: flags each enabled card whose weight breaks the section 5.2 inequalities. Examples: a bonus above a wish, an "ideally" penalty of -50 next to wishes of 20, a wish at 0.

Users of the check:

- `get_setup_progress` returns the findings. The assistant must explain each one and offer a fix before it runs Optimize.
- The Optimize screen shows the findings as a warning before Run. The warning does not block the run.
- Vitest tests on ward fixtures. No source parsing is involved.

## 8. How the score reads

Today the score is one number, and it went negative for optional places. With the ladder and uv8n bonuses, only broken rules lower the score, so a roster with no broken soft rules scores zero or above.

Proposed display: the score, then points lost per tier. Example: "Score 1078. Lost: 0 strong rules, 0 ward preferences, 2 nurse wishes (40). Earned: 1118 bonus points." That shows at a glance whether a high tier gave way. The tier split needs no core change: the web knows each card's tier and the core already reports each rule's result.

## 9. Existing defaults mapped to tiers

"Changes behaviour" means a new card or a new assistant change gets a different result. Stored scenarios keep their weights. The pre-Run check flags any stored weight that breaks the order.

| Default | Tier | Today | Proposed | Changes behaviour |
|---|---|---|---|---|
| Requests quick paint, off or shift wish | 3 | 0 | 20 | yes: a painted wish starts to count |
| Cell editor off wish | 3 | 0 | 20 | yes |
| `SOFT_REQUEST_WEIGHT` (repair softening) | 3 | 10 | 20 | yes, small |
| Assistant nurse wishes (set_off_request, shift wish) | 3 | 10 | 20 | yes, small |
| Day off after nights (assistant example) | H | +10 | sleep day `-.inf`, plus a full day off at -1000 (section 4.1) | yes: now a safety rule |
| Shift sequences form | 2 | -1 | -100 | yes |
| Shift counts form | 4 | -1 | -4 | yes |
| Pairings form, apart where possible | 2 | 1 | -100 | yes |
| Supervision form | H | 1 | `.inf` | yes, matches the assistant |
| Requirement "ideally" count | 5 | -50 | 0 with a bonus rule (uv8n) | yes: an empty spare place costs nothing |
| Surplus staff -300 / -200 / -100 (4h5a) | 5 | penalties | bonuses +3 / +2 / +1 | yes, same roster (uv8n spike e) |
| Rest rule, 2 in any 7 days | 1 | -1000 | -1000 | no |
| Legal rest, no 7 days in a row | H | `-.inf` | `-.inf` | no |
| Contracted hours | H | `.inf` | `.inf` | no |
| Leave | H | hard pin | hard pin | no |
| Core YAML defaults (`models.py`) | none | +-1 | unchanged | no: the core stays close to v1, and the web always writes an explicit weight |

## 10. How uv8n and msnp fit

- uv8n: its bonuses 3 / 2 / 1 are tier 5, rank 3 / 2 / 1. It ships after this spec is approved, with `set_spare_slot_bonus` taking `priority: "bonus"` and `rank`. Its playbook sentence moves into the new "Priorities" block. The spike already shows that a soft day off beats a bonus (uv8n notes, spike e).
- msnp: leave is tier H. The ladder never softens leave. Move leave and cancel leave stay repair options with the nurse's agreement, ranked after rule changes (user decision 2026-09-28). The repair order follows the ladder: first relax the lowest tier that unblocks the roster, then extra staff, then move leave, then cancel leave.

## 11. Open questions for the user

1. Nurse-wish default 20 instead of 10? 20 keeps a fairness rule below a wish up to 2 shifts from target. With 10, a bonus of 3 can beat a fairness step.
2. Should the Requests paint default change from 0 (no effect) to 20?
3. Should the bonus rule get a points-only editor? Today Edit then Save is refused, because the form needs 2 or more steps (AC-PR-11). The weight quick field already works.
4. Should the assistant send tier names instead of numbers (section 6, item 1)?
5. Should the score show points lost per tier (section 8)?
6. Resolved 2026-09-29: rest after nights is a safety rule (section 4.1).
7. Should the rest rules in section 4.1 be on by default for every new ward, or should the assistant propose them during setup?
8. Is "no PM then AM" a hard rule or strong (1000)? The Singapore guidance says avoid it, and wards still use it when short of staff.
9. Is the hard cap 4 nights in a row, or 3?
