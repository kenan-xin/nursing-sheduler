---
title: "08 — Covering: omitted date = all dates (handler bug fix)"
kind: spec
---

# Decision 08 — Covering omitted `date` means all dates

Corrects a shipped-backend bug in the `shift type covering` handler and
re-baselines the covering `date` semantics across the corpus. Applied in
`core/nurse_scheduling/preference_types.py` on `feature/genie`.

## The bug

The `ShiftTypeCoveringPreference` model documents `date: … = None  # None = ALL`,
and the sibling **shift-type-requirement** and **shift-type-successions**
handlers treat an omitted `date` as *all dates* (`ds = range(ctx.n_days)` when
`preference.date is None`). The **covering** handler did **not** — it called
`utils.parse_dates(preference.date, …)` unconditionally, and `parse_dates(None)`
returns `[]`, so an omitted date made the whole rule a **silent no-op**.

Because the current covering editor **drops `date` on save** (spec 05 FR-PR-84 /
spec 11 FR-CV-12), *every* covering rule authored in the current UI was a no-op —
the feature never constrained anything unless the YAML was hand-edited to add a
date. This contradicted the model docstring, the sibling handlers, and the UI
label "leave empty for all dates."

## The fix

The covering handler now mirrors the requirement/successions handlers:

```python
ds = range(ctx.n_days)
if preference.date is not None:
    ds = utils.parse_dates(preference.date, ctx.map_did_d, ctx.dates.range)
```

## Settled semantics (binding)

| `date` value | Meaning |
| --- | --- |
| **omitted / `None`** | **all dates** (the rule constrains every day) — *changed* |
| `[ALL]` (or concrete date ids) | those dates — unchanged |
| **`[]` (explicit empty list)** | **no dates** — the rule is a no-op (`parse_dates([]) == []`) — unchanged |

The only change is the omitted/`None` case (no-op → all dates). Explicit `date: []`
stays a no-op, matching the sibling handlers (the `is not None` guard).

## Impact

- **Current app:** UI-authored coverings (which omit `date`) now actually apply,
across all dates, instead of doing nothing.
- **Rebuild:** a covering with no `date` = all-dates coverage; the frontend may
emit an omitted `date` **or** `[ALL]` for all-dates (both work), and should
still persist an explicit user date selection when one is made.

## Supersedes

The "omitted/absent `date` = zero constraints / not all dates" claim wherever it
appears: **C3 CON-SEM-07**, **C1** (§ covering row, V20 caveat, YAML example),
**spec 05 FR-PR-84 / FR-PR-88-context**, **spec 11 FR-CV-12 / §save-shape**, and
the **behavior catalog** CC covering row. (C3 :168 and C1 :376 already said
`None = ALL`; this resolves the contradiction in that direction.)

## Verification

Full `core/` suite: **267 passed** (incl. two new scheduler-integration tests in
`test_shift_type_covering_preference.py` asserting omitted-date = all-dates).

**Regression scan (nothing relied on the old no-op):** a repo-wide scan found
**no** covering rule in any scenario testcase, example, or saved YAML
(`core/tests/testcases/` = 0 coverings; the 87-person real ward has none).
Pre-change, no test ran a covering through the solver — the covering test file
was model-validation-only, and `test_leave_daystate.py`'s covering is a
`pytest.raises` reserved-type rejection (errors before solving). So no golden
test, example, or fixture depended on the no-op. Residual risk is limited to
**user-authored scenarios outside the repo** (saved YAML / browser localStorage):
a date-less covering there was a silent no-op and will now activate across all
dates — which is the behavior the author intended when they created it, not a
regression.

## Out of scope

- The `date: []` no-op edge (unchanged) and any change to `parse_dates`.
- Frontend persistence of the date selection (still a good rebuild UX per
FR-PR-84 / decision log 02) — orthogonal to this backend fix.
