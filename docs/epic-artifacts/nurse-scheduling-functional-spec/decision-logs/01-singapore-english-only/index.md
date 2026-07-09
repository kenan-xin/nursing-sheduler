---
title: "Decision Log — Holiday locale: Singapore, English-only"
kind: spec
---

# Decision Log — Holiday locale: Singapore, English-only

## Context

The original frontend shipped with a Taiwan public-holiday import feature (file
`web-frontend/src/utils/taiwanHolidays.ts) and a bilingual display of holiday`
names (English + Chinese). The initial functional-requirements spec preserved
that behavior verbatim under strict behavioral parity.

The user has redirected the rebuild to a Singapore, English-only locale.

## Settled decisions

- **Holiday locale = Singapore. All references to Taiwan (**`Taiwan, TW,`
`taiwan, taiwanHolidays.ts, TAIWAN_HOLIDAY_*, TAIWAN_*_GROUP_ID) are`
renamed to Singapore (`Singapore, SG, singapore, singaporeHolidays.ts,`
`SINGAPORE_HOLIDAY_*, SINGAPORE_*_GROUP_ID).`
- **Backend ****`country`**** field. The Python core's **`country precondition`
(`scheduler.py:109-110) accepts None or "TW". The target for the new`
build is `None or "SG"; the "TW" literal is removed from the contract`
specs.
- **English-only holiday names. Each Singapore holiday entry carries exactly**
one `reason string — the official English name (e.g. New Year's Day,`
`Labour Day, National Day). No bilingual/Chinese names are emitted. The`
source column for `reason is removed; no second-language column is added.`
- **Supported import range. Originally kept at **`2023-01-01 to`
`2026-12-31 (matching the window the Taiwan spec used). `**Superseded**
**by a later change: the supported range is now data-driven —**
derived from the min/max dates of the loaded `data.gov.sg dataset`
via `getSupportedRange(entries) and the`
`getSingaporeHolidaySupportLabel(entries) formatter`
(`singaporeHolidays.ts:141-160); the displayed label updates`
automatically as the dataset grows. There is no longer a hardcoded
`2023-01-01–2026-12-31 constant in the codebase; see spec 02`
FR-DC-29. The legacy `2023-01-01 to 2026-12-31 example is preserved`
here as a historical note only.
- **Labor Day spelling. Singapore's official spelling is **`Labour Day`
(British English). Validation message and examples updated accordingly.

## Affected artifacts

- `nurse-scheduling-functional-spec/02-dates-and-calendar/index.md —`
**rewritten end-to-end against the live-fetch + IndexedDB architecture**
(FR-DC-22..34 added; FR-DC-35..41 cover auto-generated groups, effective
checkbox state, and the import-control state machine; FR-DC-42..47 cover
group member selection). The validation table was renumbered (VR-DC-05/06
are now loading/error; VR-DC-07 is the dynamic-label unsupported hint;
VR-DC-08 is the no-change hint). The Labour Day advisory (VR-DC-05 in the
old numbering) was removed because the live MOM dataset includes Labour Day.
Acceptance criteria updated to AC-DC-08..19 to reflect hook status,
dynamic range label, and the 3-arg group-construction signature.
- `nurse-scheduling-functional-spec/08-save-load-and-yaml/index.md`
- `nurse-scheduling-functional-spec/behavior-test-catalog/index.md`
- `nurse-scheduling-functional-spec/index.md (parent story table)`
- `nurse-scheduling-functional-spec/contracts/c3-preference-constraint-semantics/index.md`
— added `CON-SEM-00 — Top-level input preconditions to formally document`
the `country in {None, "SG"} precondition, and an explicit note that`
**the supported holiday-import window is a frontend concern only (no**
hardcoded `2023-01-01–2026-12-31 window anywhere in the backend).`
- `nurse-scheduling-functional-spec/contracts/c4-solvers-cli-execution/index.md`
- `nurse-scheduling-rebuild-brief/index.md`

## Singapore source files added during the migration

These files are referenced by spec 02 and are part of the new architecture:

- `web-frontend/src/utils/singaporeHolidays.ts — entry parsing, in-memory`
cache, fetch + coalescing + retry, support-range derivation, classifier,
and group construction.
- `web-frontend/src/utils/singaporeHolidaysStorage.ts — IndexedDB persistence`
via `idb-keyval, key singapore-holidays:v1 (versioned for`
backwards-incompatible shape changes).
- `web-frontend/src/hooks/useSingaporeHolidays.ts — React hook with`
`loading | ready | error state machine, stale-while-revalidate (IDB seed`
→ network verify), exposes `refetch.`
- `web-frontend/src/components/CalendarMonthView.tsx — getCalendarDayCategoryClassName`
updated to take `entries: SingaporeHolidayEntry[] instead of no-arg.`
- `web-frontend/src/components/DateGroupMemberSelector.tsx — calls`
`useSingaporeHolidays() and passes entries to the day classifier.`

## Backend change

- `core/nurse_scheduling/scheduler.py:108-109 — country precondition`
updated from `"TW" to "SG". (Source change, not just spec.)`

## Out of scope (this decision)

- Existing Python source code under `core/ (besides the country literal)`
is not modified — only the contract spec is updated to declare the new
target. Backend code changes are tracked separately.
- The existing `core/tests/testcases/real/large-ward-with-87-people-2025-11.yaml`
fixture uses Traditional-Chinese descriptions in some group descriptions;
those fixtures will be re-authored against the new locale when testcases are
regenerated.
- All other locale-specific text (UI strings, error messages, validation
messages) was already English in the current codebase and requires no change.
