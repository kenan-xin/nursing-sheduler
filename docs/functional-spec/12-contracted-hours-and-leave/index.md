---
title: "Contracted Hours, Paid Leave & Shift Durations"
kind: spec
status: 0
---

# Contracted Hours, Paid Leave & Shift Durations

Spec for the **monthly contracted-hours use case, the first-class paid-leave**
**day-state it relies on, and the shift-duration ergonomics that make hours**
**targeting usable.** Read alongside the shipped-vs-deferred fence below: the
**first-class three-state LEAVE day-state and `durationMinutes` are already**
**shipped and are binding parity** (verified live in `core/` — decision log 06;
index.md:53), **not** beyond-parity capability. What genuinely **extends beyond**
**strict parity is only the contracted-hours *targeting workflow / UX*** —
assembling hours-as-a-count with auto-filled coefficients — which the current
app supports only via an expert workaround; that workflow, plus the
**[DEFERRED]** items in the fence, is the future-facing part of this spec.

Governing decisions: see
[decision-logs/05-contracted-hours-and-leave-model.](../decision-logs/05-contracted-hours-and-leave-model/index.md)
Engine viability + blast radius: see
[option-c-derisk-findings.](../../option-c-derisk-findings/index.md)

This artifact is **UI-agnostic — it defines behavior, data, and capability,**
not visual layout. Backend meaning is fixed by contracts C1 (schema) and C3
(semantics), extended here and referenced, not redefined.

<user_quoted_section>Shipped-vs-deferred fence (decision log 06). The Python backend moves tothe rebuild as-is and is the binding contract, so this spec splits in two:
Shipped (binding parity): the three-state day-state model (singlereserved LEAVE sentinel LEAVE_sid=-2, a single leaves[(d,p)] var,off + Σworked + leaves == 1); LEAVE selectable in countShiftTypeswith a hand-editable coefficient (8h default); the LEAVE request pin;durationMinutes as an optional authoring-only field; history LEAVE; andthe "Leave" roster render. All verified live in core/ and, wherefrontend-authored, in the frontend (C1/C3/C5).[DEFERRED] (future — NOT shipped; do not build for parity): a top-levelleaveTypes container and a backend creditMinutes store — the backend hasneither and extra="forbid" rejects leaveTypes; configurable /multi-type / half-day leave and a Leave Types editor; and the unit-toggleinteger-safety ergonomics (blocking hour mode for non-whole-hourdurations, re-deriving coefficients on a unit switch, preserving hand-editedcoefficients). The shipped coefficient component instead rounds(Math.round, floored at 1), overwrites on re-auto-fill, and never blocks.The 8h default that IS shipped comes from a frontend auto-fill constant(LEAVE_CREDIT_HALF_HOURS = 16 half-hours = 8h), not a backend leaveTypes.creditMinutes.
Requirements below carrying [DEFERRED] are future-only; everything else isshipped-binding.</user_quoted_section>

<user_quoted_section>Update (2026-07-14) — hoursContract marker + uncredited-leave guard folded in.Since the fence above was written, the contracted-hours workflow gained anexplicit hoursContract marker on a shift count plus a non-blockinguncredited-leave guard, built and validated in the current codebase and nowpart of the binding backend baseline (C1 §7.1 / CON-YAML-25). Two consequencesfor the fence: (1) hoursContract is shipped — solver-inert, exactly likedurationMinutes; and (2) the "unit-toggle integer-safety … [DEFERRED]"item is now partially shipped — a scoped unit-safety exists for a markedcount (FR-CH-27), while the general-count version stays deferred (FR-CH-33reconciliation). New requirements FR-CH-25–28 and criteria AC-CH-20–22below. Per decision log 06 the rebuild UI is free, so these are stated ascapabilities, not a required mechanism. Governing decisions: decision log 05("hoursContract &amp; uncredited-leave guard") and the current-codebase guarddecision log (leave-daystate-contract/guard-decision-log).</user_quoted_section>

<user_quoted_section>Authoring-flow revision — DL09. The rebuild/current target no longer asksauthors to check a box inside a generic count. The Shift Counts surface has twoexplicit creation actions — Add Shift Count and Add Contracted Hours — andkeeps both in the same ordered rules list. Contracted Hours is a guided authoringshortcut over the existing shift count backend encoding, identified on reopen bythe same solver-inert marker. It uses one fixed half-hour unit and hard Exact orAllowed range policies. Solver details may override coefficients and targets;expression and weight remain locked while the marker exists. This entry-path splitis settled product behavior; visual layout remains free under decision log 06.</user_quoted_section>

## Purpose & the use case

A ward schedules against a **monthly working-hours contract instead of a**
shift count: e.g. every nurse works **exactly 160h** or within an approved hard
**150–170h range per 28-day month. Three**
day-states count differently toward that total:

| Day state | Paid? | Counts toward contracted hours? | Who decides |
| --- | --- | --- | --- |
| **Worked shift (variable length)** | yes | yes — its real length | solver |
| **Paid leave (**`LEAVE, displayed "Leave")` | yes | yes — a credited amount (8h by default) | **user (fixed input)** |
| **Weekly rest (**`OFF)` | no | no — 0h (≥2/week for safety) | solver |

The defining tension: **worked shifts and OFF are the solver's to assign; leave**
**is a fact the user gives. Someone must cover for an absent (leave or off)**
nurse, so neither leave nor OFF may satisfy staffing coverage.

## Concepts

### CH — Day-state model (three-way)

- **FR-CH-01 — Three peer day-states. Every (person, date) resolves to**
**exactly one of: a worked shift, a paid-leave day, or an OFF (rest) day.**
Formally the backend enforces
`off + Σ worked_shifts + leaves == 1` per (day, person), with a single
`leaves[(d,p)]` var (C3; supersedes the prior two-state `off + Σ worked == 1`).
- **FR-CH-02 — Leave is a reserved, always-present day-state. Like **`OFF,`
paid leave is **built in and auto-provided — the user never creates it as a**
shift type. There is **one built-in leave type this release, canonical id**
`LEAVE` (uppercase reserved keyword, consistent with `OFF`/`ALL`), display
label "Leave". Its 8h default comes from a **frontend** auto-fill constant
(`LEAVE_CREDIT_HALF_HOURS = 16` half-hours = 8h) — **not** a backend field; the
per-count `LEAVE` coefficient is what the solve actually reads and may be
hand-edited (FR-CH-13).
**[DEFERRED]** configurable credit, half-day/multiple leave types, and a
Leave Types editor are a documented future extension — see Out of scope.
- **FR-CH-03 — Worked shift types are the only user-defined roster entries.**
The Shift Types tab defines worked shifts only. `OFF and LEAVE are reserved`
auto entities, not user-authored, not deletable, not renamable.

### CH — Leave semantics (the three invariants)

- **FR-CH-10 — Leave is user-fixed input (never solver-assigned). The solver**
may not invent, add, or move leave. A leave day appears **only where a**
user places it (a shift request pinning `LEAVE, or — future — an imported`
leave calendar). Structurally guaranteed: leave variables are fixed before
solve. *(INV1)*
- **FR-CH-11 — Leave never counts toward coverage. A nurse on leave does not**
satisfy any `shift type requirement or shift type covering; the ward must`
be staffed by other (worked-shift) nurses. Leave is excluded from coverage
the same way `OFF already is. `*(INV2)*
- **FR-CH-12 — Intended leave is always honored. A requested leave day is**
guaranteed in the solution — the day-state `== 1 rule forces worked and off`
to 0 that day. The solver cannot substitute a shift or an OFF for an intended
leave. *(INV3)*
- **FR-CH-13 — Leave contributes credited hours (via the shift-count**
**mechanism). A leave day adds credited hours (8h by default) to the**
contracted-hours total — distinct from a worked shift's real length and from
OFF's 0h. **Mechanically this is a coefficient, not a new formula term:**
`LEAVE is selectable in countShiftTypes as a day-state keyword (the way`
`OFF is — see FR-CH-20 for the typed-selector contract), and its hours come`
from its coefficient in `countShiftTypeCoefficients (keyed by the reserved`
`LEAVE` keyword). The 8h default comes from a **frontend** auto-fill constant
(`LEAVE_CREDIT_HALF_HOURS = 16` half-hours = 8h) — there is **[DEFERRED]** no backend
`leaveTypes.creditMinutes` store; auto-fill sets the `LEAVE` coefficient from
it (FR-CH-32). **"8h" is the default, not a lock: the solve reads the**
coefficient (FR-CH-34), so a hand-edited `LEAVE` coefficient wins — exactly as
for `OFF`/worked coefficients (no special-casing). There is no leave-config UI
this pass, but that does not freeze the per-count coefficient. The shift-count
formula is unchanged.

<user_quoted_section>These three invariants are the reason for the first-class model. Under theold leave-as-shift-type workaround, each depended on the user remembering anextra rule; here they hold by construction. See the decision log for thefootguns this removes.</user_quoted_section>

### CH — Contracted-hours targeting (workflow)

- **FR-CH-20 — Hours as a shift-count target, using the existing formula. The**
monthly contract is a `shift count whose value equals a target. The count`
reuses today's formula unchanged — `x = Σ coefficient[type] × assignment over`
selected dates × selected types — with worked shift types selected in
`countShiftTypes (coefficients = their durationMinutes-derived hours) and`
**`LEAVE` also selected in `countShiftTypes (coefficient = its 8h credit).`**
Contracted Hours uses either hard equality or two hard inclusive range comparisons;
soft targets remain available only through a generic Shift Count. (The shipped model uses the `LEAVE` keyword directly — there is no
`LV`-to-`LEAVE` migration; see FR-CH-43.)
**Typed-selector contract (C3, resolving re-review A): **`countShiftTypes is a`
**mixed day-state selector, not a flat shift-index list — worked**
shifts/groups expand to worked shift variables, `OFF resolves to the`
off-variable, and `LEAVE resolves to the leave variable(s). LEAVE is a`
reserved keyword and **never a `shiftTypes.items` id, so it does not collide**
with a shift index. It IS implemented as a second reserved sentinel —
`LEAVE_sid = -2`, cloning the `OFF_sid = -1` single-sentinel pattern
(`constants.py:24-26`; `scheduler.py:92-93` maps `OFF → [OFF_sid]` then
`LEAVE → [LEAVE_sid]`) — and resolves to the `leaves[(d,p)]` variable via
`_day_state_expr`, exactly as `OFF` resolves to
`offs[(d,p)]`. C3 must specify this typed day-state resolution — worked
ids/groups → worked shift vars, `OFF` → off var, `LEAVE` → leave var — which is
precisely what "treat `LEAVE` like `OFF`" means at the day-state level (per
DL05:96-99 / DL06).
- **FR-CH-21 — OFF excluded, LEAVE included, by explicit selection. Rest days**
contribute 0h: `OFF is simply not listed in countShiftTypes for the hours`
count. `LEAVE `*is listed, so its 8h credit counts. *`ALL expands to worked`
shift types **only — it excludes both **`OFF and LEAVE; each is included`
only by being named explicitly (C3).
- **FR-CH-22 — Weekly-rest floor. ≥N **`OFF days per person per week is a`
`shift count of OFF ≥ N per week (N=2 in the reference scenario). OFF is`
solver-chosen subject to this floor.
- **FR-CH-23 — Coverage is worked-only; leave/OFF forbidden in coverage.**
Per-date staffing (`shift type requirement) and shift type covering count`
only worked shifts. `LEAVE and OFF in a coverage selector are`
**forbidden — rejected with a validation error (not silently ignored),**
matching the current `OFF-in-requirement hard error (C3).`
- **FR-CH-24 — Feasibility is arithmetic-bound. An exact-hours contract is**
only satisfiable when the numbers close: for each nurse,
`worked_hours + credit × leave_days == target, with rest days filling the`
remaining calendar at 0h. This is a **property of coverage vs. team size and**
**shift lengths, independent of the leave model — larger teams need coverage**
scaled up, not a model change. An over-constrained scenario returns no
solution (relax a hard constraint or adjust staffing).

### CH — Contracted Hours entry, marker & the uncredited-leave guard

Added 2026-07-14 — folds the current-codebase `hoursContract` + guard work into
the spec (decision log 05, "hoursContract & uncredited-leave guard"). The backend
shape is binding (C1/C3/C5); the authoring UX is a **capability**, not a required
mechanism — the rebuild UI is free (decision log 06).

- **FR-CH-25 — Separate creation paths, shared backend encoding.** The Shift Counts
surface offers **Add Shift Count** and **Add Contracted Hours** as distinct entry
actions. Add Shift Count opens the generic count editor. Add Contracted Hours opens
the guided hours editor and persists the ordinary `type: shift count` payload plus
strict `hoursContract` metadata whose unit is always `"half-hour"`. There is no
checkbox or unit selector. The marker is solver-inert (C1 CON-YAML-25, C3 CON-SEM-05)
and lets the application reopen the guided editor, arm the guard, and recover the hard
policy without heuristics.
- **FR-CH-25a — Hard Exact and Allowed Range policies.** Contracted Hours offers only:
  - **Exact:** `expression: "x = T"`, scalar target, `weight: +∞`;
  - **Allowed range:** `expression: ["x >= T", "x <= T"]`, ordered target pair,
`weight: +∞`.
A 160h Exact contract stores `320`; 150–170h stores `[300, 340]`. Both are hard
feasibility requirements. There is no Flexible/soft mode, strength control,
squared-error expression, or marked Custom state.
- **FR-CH-25b — Guided controls and Solver details & overrides.** The guided editor
owns hours/bounds, selected shifts, derived half-hour coefficients, LEAVE assistance,
and working-time feedback. Group/`ALL` selectors persist unchanged and retain the
backend's existing dynamic expansion semantics; the editor shows their current concrete
expansion and coefficient coverage. **Solver details & overrides** may edit raw coefficients and raw
target/bounds. Expression and weight are visible but locked; editing them requires
explicit conversion to a generic Shift Count. Both entry types share one ordered list
and marker-based reopen.
- **FR-CH-25c — Explicit, atomic conversion.** Generic → Contracted Hours requires a
chosen hard policy and a field-level preview. Existing coefficients are preserved as
manual overrides unless the author explicitly derives them. Contracted Hours → generic
removes only the marker. Confirm is one undoable replacement; Cancel preserves the
stored entry and list position exactly. Conversion is never inferred.
- **FR-CH-26 — Uncredited-leave guard (non-blocking capability).** When a count
**marked** as an hours contract covers a person **pinned on `LEAVE`** but that count
does **not** credit `LEAVE` (resolution in FR-CH-26a), the UI must **make the miss**
**visible without blocking** — a non-blocking warning identifying the affected
people — and must offer a **direct way to credit the leave** in the contract's unit.
This guards the FR-CH-13 / AC-CH-05 footgun: leave pinned but not credited silently
forces the nurse to work the full target *on top of* her leave. The guard **never**
**blocks a solve**; leave, the hours count, and the marker are all independently
optional (D1, decision log 05). *The binding requirement is "visible, non-blocking,*
*with a remediation path"; the specific realization (inline advisory + list badge +*
*one-click "Add LEAVE") is reference only — FR-CH-28.*
- **FR-CH-26a — Trigger resolution (expanded dynamic selectors; unresolved ⇒ suppress).**
"Credits `LEAVE`", "covers", and "leave-pinned" are evaluated over selectors
**expanded under C3 semantics**, not raw strings:
  - a marked count **credits leave** iff its currently expanded `countShiftTypes`
contains concrete `LEAVE`; `ALL` expands to worked Shift Types only, while a saved
group containing `LEAVE` credits leave;
  - a person is **leave-pinned for the count** iff a `LEAVE` shift request's expanded
person and date selectors overlap the count's expanded people and dates, where
the request's shift-type selector expands to `LEAVE` (a group containing `LEAVE`
counts as a leave pin);
  - if any selector on either side **cannot be resolved**, that pairing is
**suppressed** (no warning) rather than guessed — the guard never manufactures a
false positive from an unresolved selector.
Matches the validated detector (guard-decision-log D2 / decision log 05).
- **FR-CH-27 — Fixed half-hour unit, dynamic selectors, explicit coverage and Refresh.**
Every marked count stores its authored selectors, explicit concrete coefficient pairs,
and target(s) as half-hour integers. Metadata contains only `{unit, policy}`. At every
validation boundary, the coefficient ids must equal the current concrete expansion of
the saved selectors: no missing ids, extra ids, duplicate ids, or implicit backend
default of `1`. `ALL` and groups keep their existing dynamic backend meaning. A new
Shift Type or group-membership edit may therefore make a marked contract invalid, but
does not silently rewrite it. **Refresh from Shift Types** operates on the current editor
draft, previews added/removed/changed/unchanged rows, and Confirm atomically repairs the
coverage and overwrites derivable rows in local draft state. One local undo restores the
pre-Refresh draft; Cancel Edit restores the stored rule; final Update is one global undo
step. While the editor is open, Ctrl/Cmd-Z/Y routes to local Refresh history or is
consumed when no local step exists; global history cannot move beneath the draft.
Non-derivable covered rows retain their existing values. Stored target(s) remain authoritative current-window totals and
never auto-rescale. No unit conversion, provenance, or migration exists.
- **FR-CH-28 — Mechanism freedom inside the settled entry structure.** The separate
Add Shift Count / Add Contracted Hours entry paths, shared list, marker-based reopen,
and Solver details & overrides in FR-CH-25/25b are settled. Within that structure, decision
log 06 still frees layout and remediation details: the guard may be inline or
elsewhere, and leave credit may be a direct action or another low-friction repair.
The earlier checkbox, unit declaration/picker, convert-or-block unit flow, and mutating
nested “Advanced” section are historical references, not target mechanisms. The global
Guided/Advanced switch remains non-mutating; a marked entry remains policy-locked until
explicitly converted to generic.

### CH — Shift durations & coefficient ergonomics (Option B)

- **FR-CH-30 — Optional working time on a 30-minute grid.** A worked Shift Type accepts
either bare positive grid-valid `durationMinutes`, or paired `startTime`/`endTime` plus
absent rest (=0) or positive grid-valid rest and a required matching `durationMinutes`.
Start/end are `HH:00` or `HH:30`; positive rest is a multiple of 30 and less than the
span. Explicit zero rest is accepted on input but canonically omitted from persisted state.
Partial clock/rest combinations, equal times, disagreement, and rounding are rejected.
An earlier end means overnight.
- **FR-CH-31 — Authoring-only. `durationMinutes` and the working-time fields**
**are authoring metadata:** the solver reads none of them and they do **not**
**appear in the exported roster.** Their job is to drive coefficient auto-fill /
derivation (FR-CH-32; DL09). They round-trip through save/load/YAML like any
shift-type field. *(A worked-hours accounting column in the export is a*
*documented future extension.)*
- **FR-CH-32 — Exact half-hour derivation and explicit refresh.** On creation and on
confirmed Refresh, Contracted Hours expands the current draft selectors and derives each
concrete worked coefficient as `durationMinutes / 30` and LEAVE as `16`. Refresh adds
newly covered rows, removes rows no longer reachable from the draft selectors, previews
before/after values, and overwrites only derivable covered rows. It never rounds or runs
automatically. Requirement
coefficients remain staffing multipliers and never use this derivation.
- **FR-CH-33 — One marked unit; generic counts remain generic.** A marked Contracted
Hours entry has no unit toggle and accepts only `hoursContract.unit: "half-hour"`.
Hour/minute marked imports are invalid and are not reconciled. Ordinary unmarked Shift
Counts keep their existing generic coefficient behavior and do not acquire an hours
unit merely because their numbers resemble one.
- **FR-CH-33a — Current-window targets and grid validation.** Guided values are
authored as totals for the selected dates, in 30-minute steps, and stored as half-hour
integers. Date/selector changes retain the stored total for a surviving rule; there is no
weekly proration or automatic rescaling. If a date-range shrink removes every required
`countDates` value, the reference cascade deletes the preference instead of retaining an
empty-scope target. Exact stores a scalar; Range stores `[minimum, maximum]` with
minimum ≤ maximum.
- **FR-CH-34 — Solver fields remain authoritative and explicitly complete.** The solver
reads coefficients, expression, target, and weight only. Working-time fields affect them
only through creation or confirmed Refresh. A currently expanded shift without working
time remains valid when it has an explicit positive integer coefficient. Missing,
duplicate, or extra coefficient coverage blocks editor commit and every external
scenario Save/Copy/download, Optimize submission (normal and anonymized), and export
serialization through one shared validator; invalid local drafts remain recoverable.

## Data & schema (extends C1)

- **FR-CH-40 — ~~`leaveTypes` section~~ [DEFERRED — NOT shipped].** The
originally-designed top-level `leaveTypes` container (sibling to `shiftTypes`,
holding `{ id: LEAVE, creditMinutes: 480 }`) **does not exist** in the shipped
schema — `NurseSchedulingData` has no such field and `extra="forbid"` rejects
it (C1 §7.2). The shipped model uses the reserved `LEAVE` keyword directly and
the 8h default lives in the frontend `LEAVE_CREDIT_HALF_HOURS` constant (16
half-hours), not in YAML. A configurable/multi-type `leaveTypes` container is a future extension.
- **FR-CH-41 — Leave request shape. A paid-leave day is authored as a request**
targeting **`LEAVE for a person on given dates (hard). The request path`**
**distinguishes a worked-shift request from a leave request so the backend**
fixes the correct variable (`leaves, not shifts). LEAVE is a reserved`
keyword in the request's shift-type selector, alongside `OFF.`
- **FR-CH-42 — `durationMinutes` field.** Optional solver-inert integer on a worked
Shift Type; the target schema requires it to be positive, divisible by 30, and
consistent with durable clock/rest fields when those are present (C1 CON-YAML-22/26).
- **FR-CH-43 — No compatibility migration.** The product has no users or saved data.
The fixed-half-hour `{unit,policy}` schema and grid validators replace the pre-release
shape directly; repository fixtures are edited, development storage may be cleared, and
hour/minute marked imports are rejected. The unrelated historical `LV` migration also
remains removed (decision log 06).
- **FR-CH-44 — History may contain leave. A person's pre-period history entry**
may be `LEAVE (in addition to a worked-shift id or OFF); history validation`
gains a leave branch.
- **FR-CH-45 — Base roster export renders leave distinctly. Although the**
hours-report export column is deferred, a leave day **must render as "Leave"**
**in the exported roster, distinct from a blank/**`OFF cell — otherwise leave`
is indistinguishable from OFF. The exporter gains a leave branch alongside its
`OFF branch. (C5.)`

## Reference cascade (extends spec 06)

- **FR-CH-50 — Leave is reserved, so not renamable/deletable. The single**
built-in `LEAVE (like OFF) is not a user entity, so it never participates`
in rename/delete cascades as a *target. References to *`LEAVE in`
preferences (leave requests) follow the same reference-integrity rules as
other preference references when the *people or dates they cite change.*

## Acceptance criteria

UI-agnostic; observable regardless of presentation.

- **AC-CH-01 — Three-state exclusivity. For any solved (person, date), exactly**
one of worked / leave / off holds; never two, never zero.
- **AC-CH-02 — No invented leave. In any solution, a person is on leave only**
on dates the user pinned leave; the solver never adds leave elsewhere. *(INV1)*
- **AC-CH-03 — Leave excluded from coverage. A per-date staffing requirement**
is satisfied only by worked-shift nurses; a nurse on leave (or off) that date
does not count toward it, and the solver staffs the requirement with others.
*(INV2)*
- **AC-CH-04 — Intended leave honored. Every pinned leave day appears in the**
solution as leave; no pinned leave is replaced by a worked shift or OFF.
*(INV3)*
- **AC-CH-05 — Hours total.** With Exact, each nurse's worked + credited-leave
half-hour sum equals the target. With Allowed Range, that sum is inclusively between
the hard minimum and maximum. OFF adds 0.
A leave day credits whatever the `LEAVE` coefficient in the count is —
**8h by default (auto-filled from the frontend `LEAVE_CREDIT_HALF_HOURS = 16` half-hours),**
and a hand-edited `LEAVE` coefficient is what the solve uses.
- **AC-CH-06 — Weekly rest floor. Each nurse has ≥N OFF days each week.**
- **AC-CH-07 — Duration is optional, grid-valid, and inert.** A present working time
is positive and divisible by 30; invalid UI/import values are rejected without
rounding. With vs without valid authoring metadata, solver semantics and exports are
unchanged.
- **AC-CH-08 — Half-hour derivation.** A selected 8h shift derives coefficient `16`,
8h30m derives `17`, and default LEAVE derives `16`. Requirement coefficients never
auto-fill from duration.
- **AC-CH-09a — No marked unit selection or reconciliation.** A new marked entry emits
only `unit: "half-hour"`; minute/hour marked imports fail clearly. No unit control is
shown.
- **AC-CH-09b — Saved coefficients change only by explicit action.** Working-time and
group-membership changes do not rewrite saved selectors or coefficients. They do
recompute current expansion and may invalidate coefficient coverage until Refresh.
Existing identity/reference cascades still rename or prune affected references; they are
not disabled. Refresh shows a preview; Confirm repairs coverage and updates derivable
rows as one local-draft undo step, while Cancel Edit preserves stored values exactly and
Update creates one global history step.
- **AC-CH-09c — Draft shortcuts cannot move global history.** While either Shift Count
editor is open, Ctrl/Cmd-Z/Y routes to local Refresh undo/redo when available and is
otherwise consumed. After Cancel/Update closes the editor, global undo/redo resumes;
Update followed by global Undo restores the complete prior stored rule.
- **AC-CH-10 — Clean replacement, no migration.** Repository fixtures use the target
schema. Hour/minute marked imports fail; no legacy conversion or persisted-state upgrade
code exists. Historical `LV` migration criteria remain removed.
- **AC-CH-11 — History leave. A person history containing **`LEAVE loads and`
validates.
- **AC-CH-20 — Marker is solver-inert.** A scenario solved with vs. without
`hoursContract` on a count yields an identical result (same status, objective, and
solution); the marker changes nothing the solver sees. *(Backed by C1 CON-YAML-25 /*
*C3 CON-SEM-05; verified in the current codebase's `test_hours_contract_field.py`.)*
- **AC-CH-21 — Guard fires on the footgun, only when marked, over expanded contract**
**selectors.** Given a leave-pinned nurse and a count **marked** as an hours contract
that covers her (people/dates overlapping under C3 expansion) but does **not** credit
`LEAVE` in its currently expanded `countShiftTypes`, the UI raises a non-blocking warning
naming her. **No** warning when: the count is **unmarked**; `LEAVE` is credited
directly; the leave pin and count selectors don't
overlap; or a selector on either side is **unresolved** (suppress — never
false-warn). A leave request whose shift-type selector is a **group containing**
**`LEAVE`** counts as a leave pin. In no case is the solve blocked. (FR-CH-26/26a.)
- **AC-CH-22 — Minimal metadata, dynamic selectors, and explicit coverage round-trip.**
A marked count round-trips `{unit:"half-hour", policy}`, its authored selectors,
explicit concrete coefficients, and current-window target(s) without reconstruction.
The selectors keep the backend's dynamic group/`ALL` behavior. Their current expansion
must exactly match the coefficient ids; membership/Shift Type changes may expose a
fixable invalid state but never silently repair coefficients. Confirmed Refresh is the
only coefficient re-derivation and coverage-repair path.
- **AC-CH-23 — Separate entry paths preserve guidance and generic raw power.** From the
Shift Counts surface, Add Shift Count opens a generic rule with no `hoursContract`;
Add Contracted Hours opens Exact/Allowed Range and saves the same `type: shift count`
plus fixed half-hour metadata. Solver details may edit coefficients and target(s), but
expression/weight stay hard and locked while marked. No checkbox, unit selector,
strength control, or marked Custom mode appears. Conversion is explicit, previewed,
atomic, cancellable, and undoable.

## Out of scope (backlog — see decision log)

- **The leave-configuration story: configurable leave credit (not the fixed**
8h); **half-day / multiple leave types (e.g. Full-Day 8h + Half-Day 4h —**
the "leave can be a half day (4h)" need, captured for later); and a
**Leave Types editor UI surface. This pass ships a single fixed-8h **`LEAVE.`
- Worked-hours / leave accounting columns in the exported roster (the base
roster *does render the leave day distinctly — that is in scope, FR-CH-45).*
- Bulk leave-calendar import (whole-year, all-staff); manual Shift-Requests
entry covers leave this pass.
- **Uncredited-leave guard coverage limits (decision log 05, D4/D7; DL09 D13).**
The guard is a **frontend** affordance only — raw-YAML / API authors get no warning
(a backend warning channel is backlog). Add Contracted Hours writes the marker
automatically, so the guided path cannot forget to arm the guard. A manually authored
generic/YAML shift count that happens to encode hours remains intentionally unclassified
and receives no hours-specific warning; the system does not guess from its expression.

## Cross-references

- **C1 — YAML Scenario Schema — **`leaveTypes section (deferred),`
durationMinutes field, leave-request shape. (LV migration removed — decision log 06.)
- **C3 — Preference / Constraint Semantics — three-state day-state; leave**
credit in shift count; leave branches in shift request / succession /
affinity; leave forbidden in requirement / covering; leave excluded from
coverage; history leave branch.
- **Spec 01 — Data Model — leave/OFF as reserved auto day-states; history.**
- **Spec 04 — Shift Requests — pinning leave; worked-vs-leave request**
distinction.
- **Spec 05 — Card Preference Editors — **`durationMinutes, auto-fill, unit`
toggle in the coefficient sub-editor.
- **Spec 06 — Reference Integrity — leave reference handling.**
- **Design prototype** (kept in the Traycer workspace, not in this repo): a
runnable reference scenario (`hours_via_coefficients.yaml`), an independent
verifier, and a three-state spike that served as the engine reference.
