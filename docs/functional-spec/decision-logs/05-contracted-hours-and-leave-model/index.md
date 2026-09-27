---
title: "Decision Log — Contracted Hours, First-Class Leave (Option C), Shift Durations (Option B)"
kind: spec
---

# Decision Log — Contracted Hours + First-Class Leave + Shift Durations

Records the settled decisions for the new **monthly contracted-hours**
requirement (from `prototype/) and the leave-model + ergonomics work it`
triggered. Grounded by the review of the `prototype/` contracted-hours use case
and the de-risking evidence at
[option-c-derisk-findings](../../../option-c-derisk-findings/index.md).

<user_quoted_section>Partially superseded by decision log 06.This log captured the full spec-12 design. The rebuild re-baselines to theshipped Python backend as the binding contract, so several decisions hereare NOT shipped and must not be built for parity: the top-levelleaveTypes container and a backend creditMinutes store (backend hasneither; extra="forbid" rejects leaveTypes), configurable / multi-type /half-day leave, and the unit-toggle integer-safety ergonomics. The pre-PydanticLV-to-LEAVE migration is removed entirely (non-issue — see the struckMigration section below). The shipped model is the single reserved LEAVEsentinel + durationMinutes + a frontend LEAVE_CREDIT_MINUTES auto-fillconstant. Entries below are retained as design history; where they conflictwith decision log 06, decision log 06 governs.</user_quoted_section>

## Context

The `prototype/ folder defines a monthly contracted-hours use case: each nurse`
works **exactly 160h in a 28-day month, where a day is one of three states**
that count differently — **worked shift (real length), paid leave**
(credited 8h), **weekly rest / OFF (0h, ≥2 per week). Verified: the use case**
is already solvable on the current engine via the `shift count + coefficient`
trick, but only through an expert-only workaround with real footguns.

Two problems drove the decisions below:

1. **Ergonomics — coefficients are unitless, re-typed per preference, in**
half-hour units; nothing records "LD = 12.5h".
2. **Safety — with leave modeled as an ordinary shift type, the solver can**
*invent leave to game the hour total, count leave toward coverage, or*
*fail to honor intended leave. All three depend on user discipline, not*
the engine.

## Settled decisions

### Scope — workflow + Option B + Option C

- **Document the contracted-hours workflow as a supported use case (the**
worked/leave/rest model, hours targeting, the arithmetic-closure
requirement, the footguns).
- **Option B (ergonomics): add an optional `durationMinutes field to`**
shift types + an **"auto-fill coefficients from durations" control + a**
half-hour/hour unit toggle in the coefficient sub-editor.
- **Option C (leave model): promote paid leave to a first-class day-state**
(see below). Chosen over B-alone because only C makes the three safety
invariants *structural rather than user-discipline.*

### Leave model — first-class peer day-state (Option C)

- **Leave is a reserved, always-present day-state, peer to worked and **`OFF.`
Modeled exactly the *way *`OFF is: `**auto-provided, never user-created**
(users do not make a leave "shift type"). Confirmed reading.
- **Canonical id = `LEAVE (uppercase reserved keyword, consistent with the`**
existing `OFF and ALL keywords). Display label "Leave". This is the single`
internal id everywhere — schema, engine, references, UI id.
- **Day-state constraint becomes three-way:**
`offs[(d,p)] + Σ_s shifts[(d,s,p)] + Σ_lt leaves[(d,lt,p)] == 1 — exactly one`
of worked / leave / off per (day, person).
- **Leave is user-fixed input. The solver may never assign, invent, or**
move leave; it only appears where a request/import places it. (INV1)
- **Leave never counts toward coverage (like **`OFF). Someone must cover for`
an absent nurse. (INV2)
- **Intended leave is always honored — a fixed leave day forces worked/off to**
0 that day. (INV3)
- **One built-in `LEAVE` type this pass, credited at a fixed 8h. Not**
user-editable; no per-scenario credit configuration.
**[SUPERSEDED by DL06 — NOT shipped]** the original design put this in a
`leaveTypes` container with a single reserved entry (`creditMinutes: 480`); the
shipped model has **no** `leaveTypes`/`creditMinutes` — the 8h lives in a
frontend `LEAVE_CREDIT_MINUTES = 480` auto-fill constant only.

### Leave hours credit — coefficient-sourced, no formula change

- **The shift-count formula is UNCHANGED. **`x = Σ coefficient[type] × assignment is the same formula that exists today; leave adds one more`
selectable keyword, not a new term shape.
- **`LEAVE` is selectable in `countShiftTypes` the way `OFF` is — a**
non-shift-type day-state keyword, not a worked shift. But **not via `OFF`'s**
**single-sentinel mechanism (the structural note below forbids cloning it):**
C3 must define `countShiftTypes resolution as a `**typed day-state selector**
— worked-shift ids/groups expand to worked shift variables, `OFF maps to the`
off-variable, `LEAVE maps to the leave variable(s). LEAVE is a reserved`
keyword, **never a `shiftTypes.items` id, so it never collides with a shift**
index. (This is the precise contract the re-review asked for; "like `OFF"`
means *selectable as a day-state.)* **[Correction — DL06]** the typed-selector
resolution above (LEAVE → the leave variable via `_day_state_expr`) matches the
shipped engine, but the "not a second sentinel" advice does **not**: the shipped
model *does* use a second sentinel, `LEAVE_sid = -2` (`constants.py:25-26`).
- **Leave's hours are a coefficient in **`countShiftTypeCoefficients keyed by`
the reserved `LEAVE keyword (as OFF may carry one) — `**not a separate**
credit term in the formula. This reverses an earlier draft that described
leave credit as a non-coefficient term (which the critique correctly flagged
as a formula change).
- **[SUPERSEDED by DL06 — NOT shipped]** the original design made
`leaveTypes.creditMinutes` (480 = 8h) the canonical, fixed store. **Shipped:**
there is no such backend store; the 8h lives in the frontend
`LEAVE_CREDIT_MINUTES` constant. Auto-fill populates the `LEAVE` coefficient
from it, exactly as `durationMinutes` populates worked-shift coefficients.
Symmetric: `durationMinutes` → worked coefficient, `LEAVE_CREDIT_MINUTES` →
`LEAVE` coefficient, both via the same auto-fill control.
- **"8h" is the default, not a lock (resolving the re-review's C). The solve**
reads the `LEAVE coefficient like every other coefficient (it does not read`
`creditMinutes at solve time). Auto-fill sets that coefficient to 8h by`
default; a user may hand-edit it, exactly as they may hand-edit a worked-shift
or `OFF coefficient — that `*is the escape hatch, not a special case.*
"Keep it simple / leave = 8h" means the frontend `LEAVE_CREDIT_MINUTES` default
is a fixed 8h and there is **no leave-type configuration UI; it does not mean**
the per-count coefficient is locked. This keeps `LEAVE` consistent with
`OFF`/worked coefficients (no special-casing) and consistent with the
"coefficients are the source of truth for the solve" rule. Configurable leave
credit and a leave-type editor remain backlog.

### Parity stance — deliberate, scoped parity-break

- Option C **breaks strict behavioral parity on purpose — it changes the YAML**
model (leave leaves the shift-type space). This is the **first sanctioned**
**engine/contract change; the rest of the rebuild stays parity-bound.**
- Option B (`durationMinutes) is `**additive — optional field, existing YAML**
stays valid, no `apiVersion bump for it.`

### ~~Migration~~ — REMOVED (superseded by decision log 06)

<user_quoted_section>Superseded. The LV-to-LEAVE migration below was theoriginally-considered backward-compat design. It is removed as arequirement (decision log 06): the rebuild is from scratch, the backendmoves as-is, and the shipped model uses the LEAVE keyword directly — thereis no legacy LV data to migrate. The detail below is retained only as ahistorical record of the rejected approach; it is NOT to be implemented.</user_quoted_section>

- **Existing files must still load and behave correctly; nothing breaks**
**silently. (Chosen over a hard version-bump and over deprecate-with-warning,**
because the latter would preserve the very footgun C exists to remove.)
- **Migration runs on the raw YAML mapping BEFORE Pydantic validation. The**
current loader does `NurseSchedulingData(**data) immediately, and every model`
is `extra="forbid" — so a legacy shift type carrying a paidLeave/isLeave`
marker would be *rejected unless the migration pass rewrites the raw dict*
first. The migration step (a) detects leave shift types, (b) moves them into a
`leaveTypes section as the single LEAVE type, (c) rewrites every reference,`
(d) strips the marker fields, then hands a clean dict to Pydantic.
- **Recognition rule (marker-first, reserved-id fallback): a shift type is**
recognized as leave if it (1) carries a leave **marker set to boolean**
`true (paidLeave: true or isLeave: true) — the primary signal — `**or**
(2) has the reserved id **`LV and is `not explicitly opted out — the**
historical-convention fallback. Marker semantics:
  - **`true → leave.`**
  - **absent (no marker key) → not a signal; the **`LV-id fallback still`
applies (so a plain `id: LV with no marker migrates to LEAVE).`
  - **`false → an `explicit opt-out: the shift type is ***not leave, and it*
**suppresses the `LV` fallback even for **`id: LV. Rationale: if an author`
wrote `paidLeave: false, honor it — id: LV, paidLeave: false stays a`
worked shift. (This is the resolution of the earlier ambiguity; it makes
AC-CH-10a correct — `false does not become LEAVE.)`
  - **conflicting markers (**`paidLeave: true + isLeave: false) → a`
**migration error, not a guess.**
Everything else stays a worked shift type.
- **At most one recognized legacy leave shift type per file (re-review D).**
One built-in `LEAVE type this pass. If a file has `**two or more distinct**
shift types recognized as leave, migration **errors with a targeted message**
(multi-type leave is deferred), *unless they are provably identical and can*
be safely deduped into one `LEAVE. This prevents two leave-ish types silently`
collapsing into conflicting `LEAVE coefficients in the same count.`
- **Reference-rewrite matrix (critique blocker #1). Recognizing leave is not**
enough — every place the old leave id was referenced must be rewritten, or the
file breaks (`parse_sids unknown-id) or silently loses behavior:`
  | Legacy reference to the old leave id | Migrated result |
  | --- | --- |
  | `shift request.shiftType: LV (pin)` | leave request targeting `LEAVE for that person/date` |
  | `shift count.countShiftTypes: [… LV …]` | rewrite id `LV → LEAVE (stays a keyword in the same list); its coefficient rewrites LV → LEAVE too` |
  | `shift count.countShiftTypeCoefficients: [[LV, n] …]` | rewrite id to `[[LEAVE, n] …] (leave's coefficient stays valid, like OFF's)` |
  | `shift type requirement.shiftType containing LV` | **rejected with a targeted migration error — leave cannot satisfy coverage (parallels the current **`OFF-forbidden check)` |
  | `shift type covering selectors containing LV` | **rejected — same reason** |
  | `shiftTypes.groups[*].members containing LV` | **context-aware, to preserve behavior (re-review B): for a group used in a **`shift count / export-count selector, rewrite that selector to `*(the group minus `LV`) ***plus explicit `LEAVE, so the hours count still includes leave; for a group used in a coverage selector (`**`shift type requirement / covering), drop LV from the expansion (leave can't cover) — and if that empties the group there, error. Never silently drop LV from a group feeding a count, which would drop leave hours.` |
  | `person.history: [… LV …]` | rewrite `LV → LEAVE (history may hold leave, per below)` |
  | export count / conditional-formatting selectors containing `LV` | rewrite `LV → LEAVE; leave is renderable in export (see below)` |
- The test fixtures use **no leave-type shift today, so in practice the compat**
path rarely fires; it exists for real-world saved files. The prototype's own
`hours_via_coefficients.yaml is the canonical migration test case (its LV`
references span requests, counts, and coefficients).

### `ALL and selector semantics under three states (critique high #5)`

- **`ALL` expands to worked shift types only — it excludes both **`OFF and`
`LEAVE. (Matches today's ALL = real-shift-types-only; verified.)`
- The engine's current `ALL-branch shortcuts that mean "not OFF"`
(`shift_request: ALL → negate(offs), succession/affinity ALL) must be`
**rewritten to mean "any worked shift", not "not off" — otherwise after the**
third state they would wrongly include leave. Concretely: `shift_request: ALL`
becomes `Σ worked_shifts == 1; succession/affinity ALL matches any worked`
shift, never leave and never off.
- Targeting leave in a request/succession/affinity uses the explicit `LEAVE`
keyword, never the `ALL shortcut.`

### Auto-fill scope (critique medium #6)

- **Auto-fill-from-durations applies only to `shift count` and export-count**
**coefficients, where a coefficient represents hours. It is disabled for**
**`shift type requirement, whose coefficients are staffing multipliers — a`**
duration-scaled requirement coefficient would silently turn "1 nurse required"
into "25 required." Spec 05's shared coefficient component must gate auto-fill
per consumer.

### Coverage rejection wording (critique medium #9)

- Leave and `OFF in a coverage selector (shift type requirement,`
`shift type covering) are `**forbidden / rejected with a validation error —**
not silently ignored — matching the current `OFF-in-requirement hard error.`

### Export rendering of leave (critique medium #10)

- Even though the hours-report export column is deferred, the **base roster**
**export must render a leave day distinctly (the "Leave" label), not as a**
blank cell — otherwise leave is indistinguishable from `OFF, violating the`
day-state model. The exporter gains a leave branch alongside its `OFF branch.`

### History — leave allowed

- Pre-period person **history may contain a leave-type entry (a nurse on**
leave before the scheduling window). The history validation gains a
leave-type branch alongside the existing worked-shift / `OFF cases.`

### Export — durations authoring-only

- **`durationMinutes` is authoring metadata only — it feeds auto-fill; the**
solver does not read it, and it does **not appear in the exported roster.**
- A **worked-hours / leave accounting column in the export (so a ward can**
verify the 160h contract by eye) is a **backlog item, deferred with the**
hours-report.

### Deferred to backlog (explicitly not this pass)

- **The whole leave-configuration story, which includes:**
  - **Configurable leave credit (per-scenario, editable — not the fixed 8h).**
  - **Half-day / multiple leave types (e.g. Full-Day 8h + Half-Day 4h, or**
Annual / Sick / Unpaid), each with its own credit. *This is the concrete*
*"leave can be a half day (4h)" need — captured here for later; this pass*
*ships a single fixed-8h `LEAVE`.*
  - **A Leave Types editor UI surface (would let a user define/configure leave**
types). Not designed this pass; Claude Design has no Leave-editor to draw.
- Hours / leave accounting columns in the exported roster (the base roster does
still render the leave day distinctly — that is in scope).
- **Bulk leave-calendar import (whole-year, all-staff) — the manual**
Shift-Requests path covers leave entry this pass.

## Rejected options & why

| Option | Rejected because |
| --- | --- |
| **Option A (use as-is)** | Leaves all three footguns live; delivers nothing. |
| **Option B alone** | Fixes ergonomics but leave stays a shift type — the invented-leave / coverage-leak / unhonored-leave footguns remain user-discipline, not structural. User explicitly does not want the footgun. |
| **Leave as a single OFF-style shift-type row (reading B of "auto type")** | Would keep leave in the shift-type space — effectively B, walks back the C decision and re-opens the footgun. |
| **Migration by hard version-bump (`alpha`→`beta`)** | Breaks every existing file until manually migrated; user chose backward-compat. |
| **Migration by deprecate-with-warning** | Preserves the footgun for old files (leave-as-shift-type still assignable); contradicts the safety goal. |
| **Configurable / multi-type leave now** | A real need was surfaced (half-day 4h vs full-day 8h), but the user chose to **keep it simple this pass (single fixed-8h `LEAVE) and defer the configuration story. `[SUPERSEDED by DL06]** the original note claimed "engine already supports multi-type (per-type indices), extends additively" — that is **false** against the shipped model, which uses a single `LEAVE_sid=-2` sentinel and one `leaves[(d,p)]` var (`constants.py:25-26`, `scheduler.py:188-201`), no per-type index. Multi-type leave would require backend data-shape + model changes, not a purely additive extension`.` |

## Engine viability (de-risked before committing)

The three-state model was proven on a standalone CP-SAT spike before this
decision: solves the prototype scenario optimally, **same solve time as the**
**2-state model at up to 100 nurses, hours story survives, all three invariants**
structural, and **zero existing tests break (no test uses a leave shift type).**
Full evidence: [option-c-derisk-findings.](../../../option-c-derisk-findings/index.md)

## Structural design notes (for the implementer, from the audit)

<user_quoted_section>[SUPERSEDED by DL06 — describes the deferred multi-type design, NOT theshipped model.] Do not implement the per-type indexing below for parity.</user_quoted_section>

- **~~Leave is multi-capable; do not clone the `OFF` single-sentinel pattern~~**
**[NOT shipped].** The original audit advised modeling leave on **per-type**
**indices** (`map_lid_lt`) + an aggregate `LEAVE` keyword (modeled on `ALL`,
not on `OFF`'s `OFF_sid = -1`), for additive sub-types later. **The shipped**
**model does the opposite** — it *does* clone the single-sentinel pattern:
`LEAVE_sid = -2` with one `leaves[(d,p)]` var (`constants.py:25-26`,
`scheduler.py:88-93,192-201`). Multi-type leave is deferred (DL06); a rebuild
must match the shipped single sentinel.
- **The load-bearing engine edit is the day-state constraint at**
`scheduler.py:197. Reference shape: prototype/three_state_spike.py:96-102.`

## Affected specs (to be drafted next)

- **New capability spec — contracted-hours use case + leave model + Option B**
ergonomics (see sibling artifact `12-contracted-hours-and-leave).`
- **C1 (YAML schema) —** `durationMinutes` optional field on shift types;
leave-request shape; `LEAVE` as a reserved selector keyword. (The originally
listed `leaveTypes` section is **deferred** and the migration/recognition note
is **removed** — DL06.)
- **C3 (semantics) — three-state day-state; leave-credit in shift count;**
leave branches in shift request / succession / affinity; leave-forbidden in
requirement / covering; leave never in coverage; history leave branch.
- **Spec 01 (data model) — leave as a reserved auto day-state; history.**
- **Spec 05 (card editors) — **`durationMinutes + auto-fill + unit toggle.`
- **Spec 04 (shift requests) — leave selectable/pinnable; distinguish**
worked-shift vs leave requests.
- **Spec 06 (reference integrity) — leave-type reference cascade.**

## Addendum (2026-07-14) — `hoursContract` marker & uncredited-leave guard

<user_quoted_section>Authoring-flow supersession (DL09 D13). This addendum remains authoritativefor the marker, guard trigger, and safety outcomes. Its checkbox/marking mechanismis historical current-app context only. The planned authoring flow instead offersseparate Add Shift Count and Add Contracted Hours actions on the same surface;the latter writes the same solver-inert marker and shared Shift Count encoding. Rawfields remain available under Advanced, and conversion is explicit with a preview.</user_quoted_section>

Records the settled decisions for the net-new **`hoursContract` marker** and the
**uncredited-leave guard**, built and validated in the current codebase and folded
into the rebuild spec (§12 FR-CH-25–28 / AC-CH-20–22; C1 §3.3e, §7.1, CON-YAML-25;
C3 CON-SEM-05; C5 CON-OUT-54a). The **canonical, mechanism-level decision log with**
**full rationale (D1–D8, and the options rejected) lives at**
`leave-daystate-contract/guard-decision-log`; this addendum is the rebuild-corpus
summary.

- **Warning, never error (D1).** The guard is non-blocking. Leave, the hours count,
and the marker are all independently optional (contract C3); a hard requirement to
count leave would break the legitimate "pin leave for coverage only, no hours
contract" configuration.
- **Trigger = explicit `hoursContract` marker (D2).** The guard fires only when a
count is **explicitly marked** as an hours contract yet omits `LEAVE` while
covering a leave-pinned nurse. This **superseded an `x = T`-over-worked-shifts**
**heuristic**, which an adversarial critique proved is *not* an hours-contract
signature — it false-positives exact non-hours quotas (`target: 0`, "seniors don't
work junior shifts") and false-negates soft `|x - T|^2` targets. An explicit marker
is deterministic and expression-agnostic.
- **Marker shape (D5).** `hoursContract: { unit: "half-hour" | "hour" }` on the
shift count. Presence = "this is an hours contract"; `unit` = the coefficient unit.
Small **backend change**: added to `ShiftCountPreference` as **accepted-and-ignored**
(strict nested `HoursContractMetadata`, `extra="forbid"`), mirroring
`ShiftType.durationMinutes`. So this is **not** frontend-only; C1 documents it as
shipped conformance (CON-YAML-25).
- **Presence-only scope (D3).** The guard checks that `LEAVE` is *present* in the
count, not that its coefficient value is arithmetically "correct." A value check
would require a canonical backend leave-credit concept, which the shipped model
deliberately does **not** have (the solve reads the coefficient; there is no credit
store) — so policing the value is out.
- **Fix + single controlled unit (D6/D8).** The one-click fix adds `LEAVE` via a
targeted upsert (preserving existing coefficients) and credits it in the count's
`hoursContract.unit`, shown read-only. That unit is the **single** owner for a
marked count — marking or changing it converts coefficients+target atomically or
**blocks** on a non-whole result, so a marked count is never mixed-unit.
- **Forward-only, no migration (D7).** The guard fires only on a count already
marked. `hoursContract` is net-new with **no pre-marker legacy corpus** (the marker
had no adopters before this addition — it was unshipped until commit `7764e80`, and
the one 160h artifact is updated directly), so no import-time heuristic
migration is built. Accepted residual: a new unmarked hours count gets no warning;
a "mark as hours contract?" discovery nudge is backlog.
- **Placement = frontend-primary (D4).** Computed client-side; the backend has no
user-facing warning channel, so raw-YAML / API authors get no warning (backlog).
- **Rebuild stance — capability, not mechanism.** Per decision log 06 the rebuild
UI is free. The force-gated declaration + atomic convert-or-block UX is the
**validated reference**, not binding. The execution lesson (it took several fixup
rounds and was judged heavier than a warning needs) is recorded so the rebuild can
prefer the **lighter alternative**: derive the `LEAVE` credit from a worked shift's
`durationMinutes` instead of a user-declared unit (§12 FR-CH-28).

### Rejected (this addendum)

| Option | Why rejected |
| --- | --- |
| `x = T`-heuristic trigger | Not an hours-contract signature — false-positives `target: 0` quotas, false-negates `\|x - T\|^2` |
| Any-count-presence trigger | Breaks optionality — flags coverage-only / non-hours configs |
| Hard error | Breaks optionality (D1) |
| Backend coefficient/value validation | Needs a canonical leave-credit concept the shipped model rejects |
| Import-time migration to auto-mark legacy counts | No legacy corpus; would resurrect the rejected heuristic (D7) |
