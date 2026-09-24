# Nurse scheduling notes digest

Source root: `/home/kenan/work/nurse-scheduling-notes` (ALGORITHM.md, CAPABILITIES-AND-LIMITATIONS.md,
algorithm-guide.html, course.html, course-user.html, user-tutorial-v2.html,
user-tutorial-v2-flow-rules.md, user-tutorial-v2-yamls/). HTML files were stripped to text at
`scratchpad/research/*.txt` for quoting.

---

## 1. How the scheduling algorithm works

**Engine**: Google OR-Tools **CP-SAT** (exact constraint programming/SAT), the only solver backend
(`course.txt`, §1: "The solver used is CP-SAT (Google OR-Tools) — the only backend this project
ships."). Not ML/heuristic: `ALGORITHM.md` §1: "It is **not** an AI/ML model... It is exact
combinatorial optimization: given enough time it either finds a provably-best roster or proves
none exists."

**Decision variables** (`ALGORITHM.md` §3): for every day *d*, shift type *s*, person *p*:
`shifts[(d,s,p)]`, `offs[(d,p)]`, `leaves[(d,p)]` — all Booleans.

**The anchor equation** (`ALGORITHM.md` §4), every `(d,p)`:
```
offs[(d,p)] + Σ_s shifts[(d,s,p)] + leaves[(d,p)] == 1
```
One state per person per day. "OFF and LEAVE are defined as 'not working' ... LEAVE provides no
coverage." `ALL` in a rule means "worked shift types only — excludes both OFF and LEAVE."
`OFF` internal id `-1`, `LEAVE` internal id `-2` (§4 table).

**Hard vs soft — the central mechanism** (`ALGORITHM.md` §5), routed through `add_objective(weight, expr)`:
```
if weight == +inf:  constraint(expr == 1)   # hard, must be true
elif weight == -inf: constraint(expr == 0)  # hard, must be false
else: objective += weight * expr            # soft
```
"There is exactly **one score** for the whole roster... A reported score is only meaningful
*relative* to other rosters of the *same* problem." (also CAPABILITIES L9: "Weights are abstract
points, not hours or dollars.")

**The seven preference types** (`ALGORITHM.md` §6 / `CAPABILITIES-AND-LIMITATIONS.md` Part A):

1. **at most one shift per day** — structural no-op, already implied by the anchor equation;
   required in every scenario (`course.txt` §3: "Required — every input must include it").
2. **shift type requirement** (coverage) — hard staffing count. No `preferredNumPeople` ⇒ **exact**
   (`actual == required`); with it ⇒ range `[required, preferred]` plus soft penalty for the gap.
   `qualifiedPeople` is a **hard gate**: "nobody outside the qualified set may work that shift type
   on that date" (`ALGORITHM.md` §6.2) — this is the root cause of limitation L2 (two qualified
   groups on the same shift type are mutually exclusive → INFEASIBLE).
3. **shift request** — soft, except `shiftType: LEAVE`, which is a **hard pin**: "It forces
   `leaves[(d,p)] = 1` regardless of weight... leave stays 0 everywhere else" (§6.3). `shiftType:
   ALL` targets "the worked-day indicator."
4. **shift type successions** — day-to-day pattern. `-∞` = hard forbid; `+∞` = hard require ("Use
   with caution — combined with other hard rules this can produce a surprising INFEASIBLE"; L6);
   finite weight = reified soft match. History-aware across the window boundary (A14).
5. **shift count** — soft arithmetic over a weighted sum of day-states; this is how **hours** are
   modeled (coefficients = shift length in half-hours). Expressions: `x>=T, x<=T, x>T, x<T, x=T,
   |x-T|^2` (squared deviation, weight must be non-positive — fairness). `+∞`/`−∞` make it hard
   (e.g. per-person "never works these" lock at `x=0, weight=+∞`).
6. **shift affinity** — soft pairing: `is_match = (someone in group1 on shift) AND (someone in
   group2 on shift)`; positive weight attracts, negative repels.
7. **shift type covering** — **always hard** implication: `any_preceptee_on_shift <=
   at_least_one_preceptor_on_shift`. Weight field parsed but ignored. Grouping matters: nesting
   each side as one group (`preceptors: [[A,B]]`) means "at least one of A/B"; a flat list `[A,B]`
   becomes two one-person groups, demanding *every* one of them (§6.7).

**Selectors/vocabulary** (`ALGORITHM.md` §8): dates (`YYYY-MM-DD`, `MM-DD`, `D`, ranges with `~`,
keywords `ALL/WEEKDAY/WEEKEND/MONDAY..SUNDAY`, custom date groups); people (IDs, `ALL`, people
groups); shift types (IDs, `ALL`, reserved `OFF`/`LEAVE`, shift-type groups).
`durationMinutes` on a shift type is **authoring-only** — feeds the UI's "auto-fill coefficients"
helper and is **ignored by the solver** (§8, and CAPABILITIES L11).

**Solve statuses** (`ALGORITHM.md` §7 / algorithm-guide.txt §7): `OPTIMAL` (ship it), `FEASIBLE`
(valid but timeout hit before proof — "raise the timeout if you want proof"), `INFEASIBLE` (hard
rules conflict — relax or add capacity), `MODEL_INVALID`, `UNKNOWN`. Deterministic mode fixes seed
+ single thread for reproducibility (tests); normal runs are multi-threaded and non-deterministic
among equally-optimal rosters.

**Mental model** (`ALGORITHM.md` §10 / algorithm-guide.txt): "Every 'who works what, when' is a
light switch; hard rules are walls the solver can't cross; soft rules are magnets of different
strengths."

---

## 2. Documented capabilities and limitations (must-knows for the assistant)

Source: `CAPABILITIES-AND-LIMITATIONS.md` (Parts A/B/C).

### Capabilities (A1–A16), each with the concrete mechanism
- A1 min/exact/preferred staffing per shift per date (hard + soft-preferred)
- A2 aggregate ("any of these") coverage via shift-type groups
- A3 Qualified People as a hard gate restricting who may work a shift
- A4 coverage weighted by `shiftTypeCoefficients` within one aggregate group
- A5 personal shift requests, prefer/avoid, `ALL` = worked-day indicator
- A6 guaranteed paid LEAVE (hard pin, no coverage, hours creditable via A9)
- A7 successions: hard forbid / soft encourage / risky hard require; history-aware
- A8 shift counts: caps, floors, exact, `|x-T|^2` fairness
- A9 exact monthly hours via coefficients = shift length in half-hours (e.g. 160h = target 320)
- A10 per-person hard "never works X" (`x=0, weight=+∞`)
- A11 pair/team affinities, attract/repel
- A12 hard supervision pairing (coverings) — weight ignored
- A13 rich selectors: groups/keywords/ranges
- A14 history across the window boundary
- A15 workload fairness / multi-objective trade-off in one maximized score
- A16 operational: configurable timeout, deterministic mode, streaming/partial results, XLSX
  export with tooltips

### Limitations (L1–L17) — the assistant must know these to avoid promising the impossible
- **L1 no clock-time reasoning at all.** Shift types are opaque labels; can't reason about
  overlaps/handover/minute-level presence. "it does not know AM3 (…–1700) and PM1 (1400–…) overlap
  1400–1700." "'at least 11 hours off between two shifts' isn't computed from times — you encode
  the specific illegal transitions as forbidden successions."
- **L2 two qualified-groups on the same shift type are mutually exclusive** → INFEASIBLE. Fix:
  separate shift types per ward (`ICU_D`, `ER_D`).
- **L3 a requirement without `preferredNumPeople` is EXACT, not a minimum.**
- **L4 no native "max N consecutive working days."** Succession patterns match exact sequences
  only; `M,M,M,M,M,M` doesn't block `M,A,N,M,A,N`. Fix: combine with weekly count caps.
- **L5 no sliding/rolling window.** Counts are over a fixed date set; use per-week date groups.
- **L6 `+∞` on a succession can cause a false INFEASIBLE.** Use finite weight 5–10 instead.
  (Confirmed empirically in course-user.txt §6: "setting a succession's weight to +∞ ... makes the
  solver return INFEASIBLE even when the same problem with weight 5 is OPTIMAL.")
- **L7 a leave lock via Qualified People removes coverage** (locks out everyone else too) →
  INFEASIBLE. Fix: per-person shift-count lock (A10), not Qualified People (see Flow L).
- **L8 one planning window at a time** — no built-in multi-month rolling roster; re-run per period.
- **L9 weights are abstract points, not hours/dollars**, not comparable across scenarios.
- **L10 limited expression set**; no compound `a<=x<=b` in one rule (use two rules); targets must
  be non-negative integers.
- **L11 `durationMinutes` is authoring-only**, ignored by solver unless converted to Tab-7
  coefficients.
- **L12 no skills/competency matrix beyond groups + qualified**; no credential expiry, no
  "prefer most-qualified" scoring.
- **L13 coverage counts whole people**, not fractional FTE or nurse-hours.
- **L14 history format restricted** to single shift-type IDs or OFF — no nested lists, no `ALL`.
- **L15 country localization is a stub** — only `country: SG` (or none); auto public holidays are
  Singapore-only.
- **L16 FEASIBLE ≠ best**; optimal rosters can vary run-to-run (non-deterministic, ties).
- **L17 no fairness memory/seniority tie-break across periods** by default — must encode by hand.

### Quick "can I model X" table (Part C) — verbatim-useful for assistant refusal/redirect logic
Two wards sharing one shift type = ❌ (L2); rolling 7-day window = ❌ (L5); "3 bodies physically
present at 3pm" = ❌ (L1, not time-aware); "min 11h between shifts" = ⚠️ approximate only via
forbidden successions; "max 5 consecutive working days" = ⚠️ approximate (patterns + weekly cap);
carry fairness across months = ❌.

---

## 3. Every real-life scenario, as eval-ready cases

Sources: `user-tutorial-v2-flow-rules.md`, `course-user.txt` (v1, §4 and §7), `user-tutorial-v2.txt`
(v2 — current app; differs from v1 mainly in Tab 3 "Working time" fields and the Tab-7 "Add
Contracted Hours" editor replacing hand-typed coefficients for Flows N/O), and the 15
`user-tutorial-v2-yamls/*.yaml` files (all validated OPTIMAL except Flow C = INFEASIBLE by design,
per `user-tutorial-v2-yamls/README.md`).

Each case: **Setup**, **User goal**, **Expected correct behaviour**, **Common wrong behaviours**.

### Flow A — NUH General Medicine ward (12 staff, month roster)
File: `flow-A-nuh-general-medicine-v2.yaml` (OPTIMAL, score 449). Also
`user-tutorial-v2-flow-rules.md`.
- Setup: 12 staff (NM/SSN/SN/EN grades), M/A/N shifts w/ `_sup` lead variants, `Seniors` group
  (NM-Tan, SSN-Lim, SSN-Goh, SSN-Wong), Aug 2025 full month.
- Goal: coverage (≥2 M ideally 3, exactly 1 senior M_sup, 2 A, optional senior A_sup, 2 N daily);
  hard-forbid N→M; encourage N→OFF; soft-cap 22 M/person; ≥8 OFF days/month; SN-Nurul prefers
  Mondays off; SN-Priya avoids N_sup.
- Correct behaviour: assistant should encode "at least 2, ideally 3" as `requiredNumPeople:2,
  preferredNumPeople:3` (not exact-2); N→M forbid at `-∞`; N→OFF as *finite* positive weight
  (never `+∞`, per L6); explain fairness cap uses `x<=T` soft, not hard.
- Common wrong behaviours: using `requiredNumPeople:3` alone (loses the "at least 2" floor,
  L3-type error); using `+∞` to "require" N→OFF (triggers L6 false-INFEASIBLE); putting SN-Priya's
  avoidance as a hard forbid instead of soft (-3) which would override coverage needs.

### Flow B — Two wards sharing a night float pool (ICU + General Medicine, 20 staff)
File: `flow-B-two-wards-night-pool-v2.yaml` (OPTIMAL, score 124).
- Setup: ward-specific morning shift types (`ICU_M`, `GEN_M`, ...) + one shared `N` night pool;
  floaters; senior groups per ward + combined `NightSeniors`.
- Goal: each ward staffs its own mornings with its own seniors; anyone (incl. floaters) can cover
  the shared night; add affinity to keep two ICU nurses together on nights.
- Correct behaviour: **must not** model a single shared `M` shift with per-ward `qualifiedPeople`
  — that's exactly the L2 trap (each ward's rule forbids the other ward's staff from `M`) →
  INFEASIBLE. Correct fix is separate shift types per ward for daytime, shared only for the pooled
  shift.
- Common wrong behaviour / **the notes' own "gotcha"**: even the "working" model, without an
  explicit fairness rule, parks the *same 4 nurses* on every single night for the whole fortnight
  — still OPTIMAL, just badly unfair (quoted: "Nothing in the rules so far says nights must be
  shared... A scheduler only balances workload if you ask it to."). The fix is a `|x-T|²` fairness
  rule on Tab 7 with Target≈3 (average), Weight negative (e.g. -5); note status may become
  FEASIBLE (fairness harder to prove optimal) — assistant should warn the user of this trade-off,
  not silently report OPTIMAL→FEASIBLE as a regression.

### Flow C — Diagnose and fix an INFEASIBLE roster
File: `flow-C-infeasible-demo-v2.yaml` (INFEASIBLE, intentionally).
- Setup: 3 nurses, M requires exactly 4 people (impossible, only 3 exist), AND hard-forbidden
  `OFF→M` succession (everyone must work every day — also breaches rest rules).
- Goal: teach the standard troubleshooting pattern.
- Correct behaviour: assistant should diagnose as "Rules × People × Time" conflict — specifically
  name the M requirement (4 needed, 3 available) as the binding cause, and note the
  `OFF→M` forbid compounds it. Two valid fixes: lower `requiredNumPeople` to 2, OR add capacity
  (2 more nurses) + remove the OFF→M forbid.
- Common wrong behaviours: proposing to "just add `preferredNumPeople`" (doesn't fix an
  overconstrained *hard* minimum since required alone is still 4 > population); blaming the
  succession rule alone without noticing the headcount is the primary blocker; suggesting `+∞` on
  anything as a "stronger" fix.

### Flow D — Singapore geriatric ward (Ward 7A, 12 staff, full month incl. Chinese New Year)
File: `flow-D-geriatric-ward-7a-v2.yaml` (OPTIMAL, score 292).
- Setup: MOH grade ladder (NM/NIC/SN/EN), `PH`/`WORKDAY`/`NON-WORKDAY` groups from Singapore
  holiday import, M/A/N + `_sup` variants, weekly night cap ~3, monthly OFF floor ≥4, EN never
  works N unsupervised (`x=0,+∞`), cultural CNY leave preference.
- Goal: model culturally-aware holiday coverage — Chinese-surnamed staff get high positive weight
  (+5) for PH off; non-Chinese staff implicitly cover by omission (no explicit rule needed).
- Correct behaviour: this is a **soft** preference, not a hard block — quoted: "If a hard coverage
  rule still forces a Chinese nurse to work... the hard rule wins; the +5 only decides which nurse
  gets the day off when the solver has a choice." Assistant must not present a soft weight as a
  guarantee.
- Common wrong behaviours: treating the +5 PH-off preference as an entitlement/hard rule; using
  `WORKDAY`/`NON-WORKDAY` groups without checking Singapore-holiday-import was turned on (they're
  empty otherwise — CAPABILITIES/course note: "without holiday import WORKDAY is empty and the
  rule would do nothing"); using the weekly-3-night cap without per-week date groups if holiday
  import wasn't done.

### Flow E — SGH multi-specialty (ICU/A&E/General Medicine locked to specialty)
File: `flow-E-sgh-multi-specialty-v2.yaml` (OPTIMAL, score 92).
- Goal: staff locked to their own specialty via per-specialty shift types + `qualifiedPeople`.
- Correct: separate shift types per specialty (ICU_M, AE_M, GEN_M...), not one shared `M` with
  per-specialty Qualified People (again L2 — "mutually exclusive... returns INFEASIBLE").
- Common wrong: reusing one shared `M` shift type across specialties gated only by Qualified
  People.

### Flow F — Weekend rotation fairness (KTPH ward)
File: `flow-F-weekend-rotation-v2.yaml` (OPTIMAL, score 175).
- Goal: each nurse gets ≥1 weekend shift per fortnight via per-date-group `x>=T` count rules.
- Correct: two rules, one per fortnight date group, `x>=1`; to also cap, add a second `x<=T` rule
  (no compound inequality in one rule — L10).
- Common wrong: trying to write `1<=x<=2` as a single expression (unsupported).

### Flow G — Full-time + part-time/relief staff (CGH ward)
File: `flow-G-part-time-relief-v2.yaml` (OPTIMAL, score 18).
- Goal: part-timers get no back-to-back days (succession `M,M` forbidden, scoped to `part_time`
  group only) and ≤3 shifts/week (per-week count cap).
- Correct: succession rules can be scoped to a person-group so full-timers are unaffected.
- Common wrong: applying the back-to-back forbid to `ALL` (would also block full-timers who are
  meant to work more).

### Flow H — Seniority-based qualifications (TTSH ward)
File: `flow-H-seniority-quals-v2.yaml` (OPTIMAL, score 64).
- Goal: `M_sup`/`N_sup` gated to `seniors` group; plain `M`/`N` gated to `juniors`.
- Correct: two shift-type variants + two Qualified groups, not one shift type with mixed
  eligibility.

### Flow I — Pair preferences (attract + repel)
File: `flow-I-pair-preferences-v2.yaml` (OPTIMAL, score 21).
- Goal: mentor pair kept together (+weight affinity), clashing pair kept apart (-weight affinity)
  on the same shift types.
- Correct: positive weight = attract, negative = repel, larger magnitude wins when they conflict;
  purely soft — the notes don't claim guaranteed separation.

### Flow J — New-grad preceptorship (Tab 8b coverings)
File: `flow-J-preceptorship-v2.yaml` (OPTIMAL, score 0).
- Goal: preceptees (new grads) never work N (`x=0,+∞`), and any preceptee on M requires ≥1
  preceptor on M too (hard covering, weight ignored).
- Correct: nest each side as one group in the covering rule (`[[...]]`); a flat list would demand
  *every* named preceptor present, not just one.
- Common wrong: forgetting to nest → covering becomes "all preceptors must be on shift" (much
  stricter than intended, likely INFEASIBLE or drastically reduces solutions).
- Note per README: "Flow J additionally reports two expected, non-blocking notices" about advanced
  covering syntax outside the web editor's simple subset — still loads/optimizes correctly. The
  assistant should not treat this notice as an error.

### Flow K — MOM statutory rest (no 6-in-a-row, weekly rest floor)
File: `flow-K-mom-statutory-rest-v2.yaml` (OPTIMAL, score 75).
- Goal: forbid 6-in-a-row of the *same* shift type (three separate hard `-∞` succession patterns
  for M, A, N); ≥2 OFF/week; ≤5 working shifts/week.
- Correct: this only blocks same-type runs, not mixed-type consecutive-working-days runs (L4) —
  assistant must say so if user asks for "max 5 consecutive days worked, any shift."
- Common wrong: believing a single `M,M,M,M,M,M` forbid pattern also prevents `M,A,N,M,A,N` streaks.

### Flow L — Hard-locked annual leave (Employment Act AL)
File: `flow-L-annual-leave-lock-v2.yaml` (OPTIMAL, score 0).
- Goal: lock a named nurse off specific dates without breaking ward coverage.
- Correct mechanism: **per-person shift-count lock** (`x=0` over the leave dates and worked shift
  types, `weight=+∞`), scoped to that one person — NOT Qualified People (L7: that would forbid
  every other nurse from those shift types too, collapsing coverage → INFEASIBLE).
- Common wrong: the intuitive "Tab-4 leave lock via Qualified People" approach the docs explicitly
  warn against.

### Flow M — Weight polarity tuning
File: `flow-M-weight-polarity-v2.yaml` (OPTIMAL, score 5).
- Goal: teach that weight sign encodes want/avoid and magnitude encodes strength; `+∞` on shift
  *requests*/*counts* works fine (unlike successions, L6).
- Correct: weight table quoted verbatim — `1`=soft prefer (easily overridden), `5`=strong want
  (usually gets it), `-1`=soft avoid, `-5`=strong avoid.
- Common wrong: assuming `+∞` always risks false-INFEASIBLE (that's specific to successions, L6,
  not requests/counts) — assistant should not over-generalize the succession caveat.

### Flow N — Exact monthly contracted hours (160h) via coefficients
File: `flow-N-monthly-hours-160-v2.yaml` (OPTIMAL, score 0).
- Setup: 7 variable-length shift types (LD 12.5h, AM1/2/3, PM1/2/3), 5 nurses, half-hour
  coefficients (LD 25, AM1 14, AM2 16, AM3 18, PM1 18, PM2 16, PM3 14), target 320 (=160h),
  4 weekly-rest-floor rules (`OFF, x>=2, +∞` per week).
- v1 pattern: two rules — hard cap `x<=T` + soft floor `x>=T` (safer than exact match, avoids
  false-INFEASIBLE if coefficients don't tile cleanly). v2 pattern: current app's guided
  **"Add Contracted Hours" editor** with `Policy: Exact` — a single valid hard-exact contract
  (v2 requires "a Contracted Hours marker with both unit: half-hour and policy: exact or range").
- Correct behaviour: explain the exact-target pitfall quoted directly — "The moment your own shift
  lengths can't tile to 320 ... the solver returns INFEASIBLE, not 'close.'" — and default to
  recommending the cap+soft-floor pattern (or v2's guided editor) rather than a bare `x=T,+∞`
  unless coefficients are verified to tile.
- Common wrong: hand-picking arbitrary coefficients and hard-pinning `x=T` without checking they
  can combine to the target; forgetting `durationMinutes` is never auto-applied (L11) — coefficient
  values must be explicitly set (via auto-fill button or Contracted Hours editor) — merely setting
  a shift's duration does nothing on its own.

### Flow O — Paid leave counted toward contracted hours
File: `flow-O-paid-leave-daystate-v2.yaml` (OPTIMAL, score 0).
- Setup: builds on Flow N; SN-Priya pinned LEAVE for 2 days (`weight:+∞` on a `LEAVE` shift
  request), LEAVE added to the hours count with the fixed **8h/16-half-hour credit**, exact
  target still 320.
- Correct behaviour: LEAVE pin is safe as a hard `+∞` (unlike ordinary "must work" requests)
  because "leave gives no coverage and is forced to zero everywhere you didn't pin it, so it can't
  cascade into a false-INFEASIBLE." Assistant should proactively flag the **leave-credit
  advisory**: if a contracted-hours rule exists and a pinned LEAVE isn't included in its shift-type
  list, the solver will silently force the nurse to make up hours elsewhere instead of erroring.
- Common wrong: forgetting to add LEAVE to the hours-count shift-type list (produces a technically
  OPTIMAL but wrong-intent schedule where the on-leave nurse is overworked around the leave days,
  with no visible error).

---

## 4. Terminology nurses/notes use

- **Grades/roles (Singapore, per `course-user.txt`/`user-tutorial-v2.txt` Flow D, citing MOH Team
  Healthcare)**: Staff Nurse (SN), Senior Staff Nurse (SSN), Nurse Clinician (NC) / Assistant Nurse
  Clinician (ANC), Nurse-in-charge (NIC — "the shift-level leader on duty... almost always an SSN
  or above"), Nurse Manager (NM — "ward-level administrative manager"), Enrolled Nurse (EN —
  "NITEC/Higher NITEC-trained; supports RNs, does not work an N shift alone"). Six career tracks:
  Management, Clinical, Education, Research, Informatics, Innovation.
- **Shift naming conventions**: M/A/N (Morning/Afternoon/Night), `_sup` suffix = supervisory/lead
  variant, D/E/N (Day/Evening/Night) in the generic sample data, `+`/`-` suffixes = senior-only /
  junior variants in the seeded sample.
- **NIC** = "Nurse-in-Charge," the on-shift lead role, distinct from NM (ward manager).
- **Rostering-domain terms**: "rest day," "statutory rest" (MOM Employment Act s.36 — ≥1 rest
  day/week), "contracted hours," "preceptor/preceptee" (supervision pairing), "float pool" /
  "floater" (shared night staff across wards), "relief"/"part-time" staff, "AL" (Annual Leave).
- **App/engine terms** (glossary in `course-user.txt`/`user-tutorial-v2.txt`): Schedule, Shift,
  Shift Type, Hard requirement, Soft requirement/preference, Score, OPTIMAL/FEASIBLE/INFEASIBLE,
  Coverage rule, Qualified people, Seniority/skill levels, History, YAML, XLSX, Backend, Solver,
  Prettify, Anonymize, WEEKDAY/WEEKEND, WORKDAY/NON-WORKDAY/PH, Covering rule, Coefficient, Weight
  polarity.
- **Plain-language framing** (`algorithm-guide.txt`): "switches" (decision variables), "walls"
  (hard rules), "magnets" (soft rules).
- **Public holiday context**: `PH` group (Singapore public holidays via data.gov.sg import),
  Chinese New Year reunion-dinner cultural framing, Hari Raya Puasa, Deepavali (cited as reciprocal
  festival-cover customs).

---

## 5. Gaps between the notes and what a realistic assistant needs

1. **No repair-suggestion vocabulary.** The notes describe diagnosing INFEASIBLE ("add capacity or
   reduce demand") but give no structured taxonomy of *which* rule to suggest relaxing first, nor
   any ranking heuristic (e.g., largest offending constraint, most recently added rule). An
   assistant that "suggests repairs when infeasible" has to invent this — the notes only give
   worked examples (Flow C), not a general procedure beyond "Rules × People × Time."
2. **No coverage of partial/incremental edits.** All 15 flows are built-from-scratch narratives.
   None model the assistant's actual Preview→Apply loop against an *existing* populated scenario
   (e.g., "add one shift request to an already-solved roster and re-run") — nothing here documents
   how incremental edits interact with a prior solve, whether previous LEAVE pins persist, etc.
3. **No error-message catalogue.** CAPABILITIES/course.txt describe *categories* of failure
   (INFEASIBLE, FEASIBLE, MODEL_INVALID, UNKNOWN) but not the actual API/UI error strings the
   assistant would need to parse and explain to a user in production.
4. **v1 vs v2 drift not fully reconciled.** `user-tutorial-v2.html` updates Flow N/O to the new
   "Contracted Hours editor" and Tab 3 "Working time" fields, but Flows E–M in the v2 doc appear
   textually identical to v1 — unclear if their *YAML schema* also changed (e.g., does v2 still
   accept hand-typed Tab-7 coefficients as an alternative path, or is the editor now mandatory for
   any hours rule?). The assistant should verify against the live app/schema rather than trust the
   v1-flavored steps for E–M under v2.
5. **No multi-turn conversational examples.** All flows are procedural wizard walkthroughs (click
   tab N, set field X), not natural-language user requests. Building eval cases for an NL assistant
   requires translating "SN-Nurul requests Mondays off for childcare" (declarative fact) into a
   *user utterance* the assistant must correctly interpret and turn into the same YAML — the notes
   never show that translation step.
6. **No guidance on ambiguous/underspecified user requests.** E.g., what should the assistant do
   if a nurse says "I want fewer nights" without a target number? The notes assume the scheduler
   (a technical wizard user) always supplies exact numeric targets/weights; a nurse-facing
   assistant needs a policy for eliciting or defaulting these that isn't documented anywhere.
7. **No explicit list of what counts as a "safe" hard pin vs risky hard rule** beyond the specific
   cases called out (LEAVE pin safe; succession `+∞` risky; Qualified-People leave-lock risky).
   A general "is this weight/rule combination safe to make hard" decision procedure for arbitrary
   user requests is not given — the assistant will need to generalize from the L2/L6/L7 examples.
8. **Scoring/interpretation for end users is thin.** Score is explicitly "abstract points... not
   comparable across scenarios" (L9), but the notes don't say how an assistant should phrase this
   limitation to a nurse manager who naturally wants to know "is 449 a good score?" — this needs
   product-level UX language not present in the source notes.
