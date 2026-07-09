---
title: "Decision Log — Rename FreeDay → Non-Work Day (NON-WORKDAY)"
kind: spec
---

# Decision Log — Rename FreeDay → Non-Work Day (`NON-WORKDAY)`

## Context

The concept representing the **union of public holidays and weekends was**
named "FreeDay" (group ID `FREEDAY, constant FREEDAY, helpers`
`isSingaporeFreeday / buildFreedaySet, SINGAPORE_FREEDAY_GROUP_ID,`
description label "Freedays"). In the Singapore context "FreeDay" is
unfamiliar and, worse, risks being read as the Employment Act term
"non-working day", which has a distinct statutory meaning.

The three real input categories in Singapore are **weekdays, weekends, and**
**public holidays (PH). The app collapses these into a pair: **`WORKDAY`
(weekdays minus PH) and the concept being renamed here (weekends ∪ PH).

## Settled decisions

- **New term = "Non-Work Day", group ID ****`NON-WORKDAY`****. Chosen deliberately**
over "Non-Working Day" to avoid confusion with the Singapore legal term.
Defined once, canonically, in spec 02 → "Terminology — Non-Work Day":
*a date that is either a public holiday or a weekend (Sat/Sun) — the union*
*of PH and weekends.*
- **`WORKDAY`**** is unchanged — "workday" is already clear; only the**
complement term is renamed.
- **Clean rename, no migration / no alias. Old saved YAML referencing**
`FREEDAY will no longer resolve; acceptable given the app's active`
breaking-changes development mode and the from-scratch rebuild goal.
- **Group-ID string value is the hyphenated ****`NON-WORKDAY (UI, YAML, backend`**
headers). The **TS/Python constant identifier stays ****`NONWORKDAY (no hyphen —`**
identifiers can't contain one); only its string value is `'NON-WORKDAY'.`
- **Identifier vs. prose vs. label mapping applied consistently:**
  - group-ID string `FREEDAY → NON-WORKDAY; constant identifier FREEDAY → NONWORKDAY (value 'NON-WORKDAY')`
  - `SINGAPORE_FREEDAY_GROUP_ID → SINGAPORE_NONWORKDAY_GROUP_ID (value 'NON-WORKDAY')`
  - `isSingaporeFreeday → isSingaporeNonWorkDay,`
`buildFreedaySet → buildNonWorkDaySet,`
`freedaySet/freedayMembers → nonWorkDaySet/nonWorkDayMembers`
  - display label "Freedays" → "Non-Work Days"; description
"Singapore freedays imported…" → "Singapore non-work days imported…"

## Affected code (both checkouts: worktree + `~/work/nurse-scheduling)`

- `web-frontend/src/hooks/schedulingConstants.ts — NONWORKDAY = 'NON-WORKDAY'.`
- `web-frontend/src/utils/singaporeHolidays.ts — group ID const, classifier,`
builder, return type `'WORKDAY' | 'NON-WORKDAY', group description.`
- `web-frontend/src/hooks/schedulingState.ts — default group id + label.`
- `web-frontend/src/hooks/schedulingExportConfig.ts — OFF-count column`
header `OFF (NON-WORKDAY) and countDates: [NONWORKDAY] (the NONWORKDAY constant, value 'NON-WORKDAY').`
- `web-frontend/src/components/CalendarMonthView.tsx,`
`web-frontend/src/app/dates/page.tsx,`
`web-frontend/src/app/save-and-load/page.tsx,`
`web-frontend/src/utils/randomizeShiftRequests.ts — plus all their tests.`
- `core/tests/test_exporter.py — expectations updated (identifier-safe form).`
- `core/tests/testcases/real/large-ward-with-87-people-2025-11.yaml — the`
reserved `FREEDAY group ID renamed to NON-WORKDAY.`

## Affected specs

- `02-dates-and-calendar/index.md — added "Terminology — Non-Work Day";`
renamed all `FREEDAY/isSingaporeFreeday/label references.`
- `01-data-model-and-entities/index.md — FR-DM-17/AC-DM-04/08 + reserved-note`
updated; short pointer to the spec 02 definition.
- `07, 08, 09, and contracts/c3 — mechanical rename of references.`

## Verification

- Frontend unit suite: **623 passed (**`vitest run).`
- Python core suite: **252 passed (incl. **`test_exporter.py 28,`
large-ward fixture consumers).
- Source typecheck clean for the renamed identifiers.

## Intentional non-changes

- The strings `Freeday shift right (a custom date-group ID) and`
`Freeday can A (a group description) inside the large-ward fixture are`
**that ward's own free-text data, not the reserved concept, and were**
left untouched.
- The retirement is documented in-place (spec 01 FR-DM-17 and the spec 02
terminology note still mention the old `FREEDAY name) so readers of`
legacy YAML understand the mapping.
