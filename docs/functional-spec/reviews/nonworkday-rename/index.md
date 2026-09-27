---
title: "Review — FreeDay → Non-Work Day rename (code + specs)"
kind: review
---

# Review — FreeDay → Non-Work Day rename

<user_quoted_section>Superseded note (post-review change): after this review, the group-IDstring value was hyphenated from NONWORKDAY to NON-WORKDAY (theTS/Python constant identifier stays NONWORKDAY). References below to theNONWORKDAY id value therefore now read NON-WORKDAY in the current code andspecs; the review's conclusions otherwise still hold. See decision log 03.</user_quoted_section>

**Scope: the **`FreeDay→Non-Work Day (FREEDAY→NONWORKDAY) rename across`
both code checkouts and both spec copies, hunting for missed references or
inconsistencies. Reviewed cold by a fresh agent (the rename was authored in the
originating session). No files were modified during review.

**Verdict: PASS — no defects found. The rename is clean and internally**
consistent. All findings below are either verified-correct or intentional.

## Verified

| Check | Result |
| --- | --- |
| Stray `free[ _]?day in shipping source (web-frontend/src, core/nurse_scheduling), both checkouts` | **None** |
| Old symbols removed, new ones defined+used (`SINGAPORE_NONWORKDAY_GROUP_ID, isSingaporeNonWorkDay, buildPublicHolidaySet, nonWorkDayMembers, const NONWORKDAY) — no dangling imports` | **Consistent** |
| Two code checkouts identical for the 4 renamed files (byte-for-byte) | **Identical** |
| Spec source vs synced copy (`diff -rq whole tree)` | **Identical** |
| Human label reads `Non-Work Days (never NonWorkDays); identifiers valid (no spaces/hyphens); Python test fn names valid (..._workday_nonworkday_headers, not non-work day)` | **Correct** |
| `keywords.ts reserved set = OFF, ALL, WEEKDAY, WEEKEND, MON…SUN — NONWORKDAY/WORKDAY correctly NOT reserved; no leftover FREEDAY entry` | **Correct** |
| Export: `schedulingExportConfig.ts emits OFF (NONWORKDAY) / countDates: [NONWORKDAY]; test_exporter.py expects the same` | **Matching** |
| Spec prose — no stray "Freedays"/"freeday" beyond the intentional retirement notes | **Clean** |

## Intentional non-changes (confirmed as the only residuals)

- `core/tests/testcases/real/large-ward-with-87-people-2025-11.yaml:14 (Freeday shift right, a custom date-group ID) and :323 (Freeday can A, a description) — that ward's own free-text data, deliberately preserved.`
- Retirement notes in `01-data-model-and-entities/index.md:85 and 02-dates-and-calendar/index.md:22, plus decision-logs/03-nonworkday-rename — intentionally reference the old FREEDAY name to document the mapping.`

## Informational (not a defect)

- `core/.pytest_cache/.../nodeids still lists pre-rename test names. It is a`
gitignored/generated cache that self-heals on the next `pytest run — no`
shipping impact. Clearing it would make a repo-wide `grep freeday fully`
empty, but it is not required.

## Verification basis

- Frontend unit suite: 623 passed. Python core suite: 252 passed (exporter 28).
- Cold agent: gpt-class reviewer, read-only, findings confirmed against cited lines.
