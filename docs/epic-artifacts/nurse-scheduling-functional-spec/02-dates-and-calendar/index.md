---
title: "Dates & Calendar"
kind: spec
---

# Dates & Calendar

## Purpose & Scope

This artifact specifies the behavior of the Dates management domain (Tab "1. Dates") of the nurse-scheduling frontend. It covers: setting a scheduling date range (start/end), automatic generation of read-only per-day date items from that range, the date-ID format that varies with the range span, auto-generated date groups (weekday name groups plus `WEEKDAY/WEEKEND/ALL), calendar-based and list-based member selection for date groups, importing Singapore public holidays into editable WORKDAY/NON-WORKDAY/PH date groups (English-only holiday names fetched live from data.gov.sg with an IndexedDB cache), and the cascade that runs when the range changes (stripping removed date IDs from groups and downstream references).`

Scope is behavioral and data/state oriented. Visual layout (Tailwind classes, colors, iconography) is provided only as non-binding reference. The authoritative source is `web-frontend/src/app/dates/page.tsx and its collaborators: web-frontend/src/components/CalendarMonthView.tsx, web-frontend/src/components/DateGroupMemberSelector.tsx, web-frontend/src/components/DateRangeCalendarPicker.tsx, web-frontend/src/utils/calendar.ts, web-frontend/src/utils/dateParsing.ts, web-frontend/src/utils/singaporeHolidays.ts, web-frontend/src/utils/singaporeHolidaysStorage.ts, web-frontend/src/hooks/useSingaporeHolidays.ts, web-frontend/src/utils/keywords.ts, web-frontend/src/hooks/schedulingGeneratedData.ts, web-frontend/src/hooks/useSchedulingData.ts.`

Out of scope (cross-referenced): the generic Item/Group editor behavior (add/duplicate/rename/reorder groups, double-click editing, reserved keyword rules) is shared with People and Shift Types and is specified in the item-group-editor spec; the downstream reference-deletion cascade internals are specified in spec 06 (Preferences & references); the network IDB runtime and `idb-keyval library are external infrastructure concerns documented by the storage module's exported key.`

All date computations use **UTC consistently: parsing, day-of-week derivation, ID formatting, and display all pass **`timeZone: 'UTC' or use getUTC* accessors. This spec preserves that behavior exactly.`

## Terminology — Non-Work Day

**Non-Work Day (group ID **`NON-WORKDAY) means a date that is `**either a public holiday or a weekend (Saturday or Sunday) — i.e. the union of public holidays and weekends. Its complement is Workday (group ID **`WORKDAY): a weekday (Mon–Fri) that is not a public holiday. In Singapore terms the three input categories are `*weekdays, weekends, and public holidays (PH); the app collapses them into the pair *`WORKDAY (weekdays minus PH) and NON-WORKDAY (weekends ∪ PH), and additionally exposes a `**`PH group (public holidays only — a subset of `**`NON-WORKDAY, excluding non-holiday weekends).`

<user_quoted_section>"Non-Work Day" is a deliberately app-specific label. It is not the Singapore Employment Act term "non-working day" (which has a distinct statutory meaning) and must not be conflated with it. This concept was formerly named "FreeDay"/FREEDAY; that name has been fully retired in favor of the hyphenated group-ID string NON-WORKDAY. WORKDAY is unchanged.
ID value vs. code identifier: the group-ID string value is the hyphenated NON-WORKDAY (what appears in the UI, YAML, and the backend, e.g. the export header OFF (NON-WORKDAY)). The corresponding TS/Python constant identifier stays NONWORKDAY / SINGAPORE_NONWORKDAY_GROUP_ID (a hyphen is illegal in an identifier). Do not rename those identifiers.</user_quoted_section>

## Functional Requirements

### Date range editing lifecycle

**FR-DC-01 — Enter/exit date-range editing mode. The page exposes a toggle button labelled **`Set Date Range (web-frontend/src/app/dates/page.tsx:451). Toggling it calls handleStartEditingDateRange (page.tsx:157-174): if the page is already in Mode.DATE_RANGE_EDITING it cancels (delegates to handleCancel); otherwise it enters Mode.DATE_RANGE_EDITING, seeds the editable draft from the current committed range (dateData.range.startDate / endDate) when a range exists, sets shouldImportSingaporeHolidays to true, sets activeCalendarEndpoint to 'start', and clears errors.`

**FR-DC-02 — Draft state is isolated from committed state. Edits during editing mutate a local **`draft: DateRange (page.tsx:62-65, initial { startDate: undefined, endDate: undefined }) and never touch persisted state until the user confirms. Cancel (handleCancel, page.tsx:176-188) exits to Mode.NORMAL and resets draft back to the committed range, resets shouldImportSingaporeHolidays to true, activeCalendarEndpoint to 'start', and clears errors.`

**FR-DC-03 — Unsaved-edits warning. While in **`Mode.DATE_RANGE_EDITING, useTabSwitchWarning(mode === Mode.DATE_RANGE_EDITING) is active (page.tsx:88) so navigating away warns about unsaved edits (see item-group-editor / navigation spec).`

**FR-DC-04 — Confirm/save. The confirm button is labelled by the conditional **`{dateData.range ? 'Update' : 'Apply'} (page.tsx:413). In practice, dateData.range is a permanently-present object — SchedulingState.dates.range is a required (non-optional) field seeded as { startDate: undefined, endDate: undefined } (schedulingState.ts:73-89) and never absent at runtime — so the button **always reads ****Update, even for a brand-new state with no range ever set. The **Apply branch is effectively dead code under normal state. Clicking it runs handleSave (page.tsx:144-155): it validates (FR-DC-20); if valid it calls`

```
updateDateRange({ startDate, endDate }, {
  importSingaporeHolidays: shouldImportSingaporeHolidays && isSingaporeHolidayImportSupported,
  singaporeHolidayEntries: singaporeHolidays.entries,
})
```

and returns to `Mode.NORMAL. If invalid, errors are shown and the range is not committed. singaporeHolidayEntries is **always passed (the full entries array from the hook), regardless of effective checked state — the gating happens inside **updateDateRange.`

**FR-DC-05 — Two synchronized range-input surfaces. During editing the range can be set either via two native **`type="date" inputs (Start Date * / End Date *, page.tsx:243-299) or via the DateRangeCalendarPicker (page.tsx:390-398). Both write to the same draft. Editing a native input clears that field's error and updates the corresponding endpoint (page.tsx:251-253, 279-282); the calendar's onChange writes the whole DateRange and clears both startDate/endDate errors (page.tsx:393-396).`

**FR-DC-06 — Active endpoint tracking. **`activeCalendarEndpoint: 'start' | 'end' (page.tsx:67) tracks which endpoint the user is targeting. Focusing the start input sets it to 'start', focusing the end input sets 'end' (page.tsx:255, 284). The calendar reports endpoint changes via onActiveEndpointChange (FR-DC-13). This state drives only the highlighted-input affordance and is non-binding visually.`

**FR-DC-07 — Duration / selected-day count. When the committed range has both endpoints, the read view shows **`Duration: {N} days where N = ceil((endMs - startMs) / 86_400_000) + 1 (page.tsx:223-225). During editing, when both draft endpoints are set, a live-region line shows ${selectedDayCount} day${selectedDayCount === 1 ? '' : 's'} selected (page.tsx:301-304) — note the trailing word selected. The committed view never singularizes and never shows selected; the editing live count does.`

**FR-DC-08 — Committed-range read display. Outside editing mode, the current range is displayed with **`Start Date: and End Date: values formatted toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) (e.g. Wednesday, July 1, 2026), or - when the corresponding endpoint is absent (page.tsx:194-228).`

### Date item auto-generation

**FR-DC-09 — Items are derived from the range, never hand-authored. The Dates page renders the shared editor with **`itemsReadOnly={true} (page.tsx:426). Per-day date items are auto-generated from the committed range by _generateDateItems(startDate, endDate) (web-frontend/src/hooks/schedulingGeneratedData.ts:26-60), invoked through _generateAutoGeneratedItems → addAutoGeneratedToState (schedulingGeneratedData.ts:62-83, 118-137), which runs on every state update (useSchedulingData.ts:86). Generated items carry isAutoGenerated: true (schedulingGeneratedData.ts:71). Renaming a derived (auto-generated) date item is rejected: updateItem logs and returns for DataType.DATES items with isAutoGenerated true (useSchedulingData.ts:393-396).`

**FR-DC-10 — Item iteration and description format. **`_generateDateItems iterates day-by-day from startDate through endDate inclusive, advancing with date.setUTCDate(date.getUTCDate() + 1) (schedulingGeneratedData.ts:33). Each item's description is ${dayName}, ${formattedDate} where dayName = toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) and formattedDate = toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) — e.g. Wednesday, Jul 1, 2026 (schedulingGeneratedData.ts:35-56).`

**FR-DC-11 — Date-ID format varies by range span. The item **`id is derived from the ISO date string YYYY-MM-DD per the range span (schedulingGeneratedData.ts:30-51; equivalently getDateIdForRange in web-frontend/src/utils/calendar.ts:71-85):`

- **Same month (**`startDate and endDate share UTC year AND UTC month): id = DD (dateStr.slice(-2)), e.g. 01.`
- **Same year, different month (share UTC year only): **`id = MM-DD (dateStr.slice(5)), e.g. 07-01.`
- **Cross-year: **`id = full YYYY-MM-DD (dateStr), e.g. 2026-07-01.`
`_generateDateItems computes sameYear/sameMonth once up front; getDateIdForRange computes the same per-date and returns the bare ISO string when either endpoint is missing.`

**FR-DC-12 — ID ↔ Date round-trip. Date IDs are parsed back to **`Date by dateStrToDate(dateStr, dateRange) (web-frontend/src/utils/dateParsing.ts:23-49): a YYYY-MM-DD id parses directly; a MM-DD id infers the year from dateRange.startDate (UTC); a DD id infers both month and year from dateRange.startDate (UTC). If dateRange.startDate is undefined it logs an error and returns new Date() (with ERROR_SHOULD_NOT_HAPPEN); an unrecognized string does likewise. This parser backs weekday-group membership and the imported Singapore WORKDAY/NON-WORKDAY classification (via buildSingaporeHolidayGroups → dateStrToDate(item.id, dateRange), singaporeHolidays.ts:248).`

### Date range calendar picker (DateRangeCalendarPicker)

**FR-DC-13 — Click and drag selection. **`DateRangeCalendarPicker (web-frontend/src/components/DateRangeCalendarPicker.tsx) renders a single month grid and supports two interaction modes resolved on mouse-up (handleCalendarDateMouseUp, DateRangeCalendarPicker.tsx:118-139):`

- **Drag (mouse-down on a date, move to a different date, release): sets the range to the min/max of anchor and release date via **`setRangeFromDates (order-normalized, DateRangeCalendarPicker.tsx:87-91), clears the click anchor, and reports active endpoint 'start'.`
- **Two-click: first click (no prior click anchor) sets **`startDate = endDate = clickedDate, stores it as clickAnchorDate, and reports endpoint 'end'. A second click ≥ the anchor commits { startDate: anchor, endDate: clicked } and reports 'start'; a second click < the anchor restarts with { startDate: clicked, endDate: undefined }, keeps clicked as the new anchor, and reports 'end'.`

**FR-DC-14 — Live preview highlight. While dragging or after the first click, a **`previewRange is derived from anchor + current hover date (DateRangeCalendarPicker.tsx:71-85); endpoints and interior days of the preview and of the committed value are highlighted distinctly (endpoint vs. middle vs. selected). Preview state is reset on mouse-up, on grid mouse-leave (onGridMouseLeave={resetDragState}), and on global mouse-up (useMouseDragLifecycle, CalendarMonthView.tsx:122-134). Text selection is suppressed during drag (disableTextSelection sets user-select: none, cleared on reset).`

**FR-DC-15 — "Use full month" shortcut. The picker footer shows a button labelled **``Use full ${suggestedMonthLabel}` where suggestedMonthLabel = formatMonthYear(calendarMonth) (e.g. Use full July 2026) (DateRangeCalendarPicker.tsx:70, 181-189). Clicking it (handleUseSuggestedMonth, DateRangeCalendarPicker.tsx:141-149) sets the draft range to the first through last UTC day of the currently viewed month (startOfMonth/endOfMonth), clears the click anchor and hover, and reports endpoint 'start'.`

**FR-DC-16 — Picker month navigation is unbounded. In the range picker the month navigation is created with only **`initialMonth: value.startDate ?? new Date() and no min/max (DateRangeCalendarPicker.tsx:52-57), so previous/next month navigation is never disabled here (contrast FR-DC-19).`

### Calendar month rendering (shared)

**FR-DC-17 — Month grid construction. **`getCalendarMonthDates(month) (web-frontend/src/utils/calendar.ts:44-52) returns leading undefined blanks equal to the UTC weekday index of the month's first day (firstDay.getUTCDay(), Sunday=0), followed by one UTC Date per day of the month. Weekday header labels are ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] (WEEKDAY_LABELS, calendar.ts:22). Blank cells render as aria-hidden spacers (CalendarMonthView.tsx:186-189). Each day button label shows date.getUTCDate() (CalendarMonthView.tsx:87).`

**FR-DC-18 — Day category styling (reference, uses Singapore entries). **`getCalendarDayCategoryClassName(date, entries) (CalendarMonthView.tsx:27-44) takes the Singapore entries and classifies each day by getSingaporeDayType(date, entries) combined with UTC weekend (getUTCDay() === 0 || === 6): Singapore NON-WORKDAY on a non-weekend, WORKDAY on a weekend, plain weekend, and plain weekday each get distinct Tailwind class strings. The function is called from DateGroupMemberSelector.tsx:197 for non-selected selectable days. Visual styling is non-binding reference; the day-type computation itself is binding (FR-DC-32).`

**FR-DC-19 — Bounded navigation for member-selection calendar. **`useCalendarMonthNavigation (CalendarMonthView.tsx:98-120) clamps the active month between optional minimumMonth/maximumMonth (each normalized to start-of-month). isPreviousMonthDisabled is true when the active month equals the minimum month; isNextMonthDisabled true when it equals the maximum month. The member-selection calendar passes minimumMonth: dateRange.startDate, maximumMonth: dateRange.endDate (DateGroupMemberSelector.tsx:57-61), so the user cannot page outside the scheduling range. Navigation buttons carry aria-label Previous month / Next month (CalendarMonthView.tsx:162, 173).`

### Validation and warnings

**FR-DC-20 — Save-time validation. **`validateForm (page.tsx:125-142) builds errors: startDate required, endDate required, and end-after-start check. See Validation Rules table for the exact messages and conditions. Save proceeds only when errors is empty.`

**FR-DC-21 — Non-blocking review warnings. While editing, a **`warnings map (page.tsx:90-101) is computed (only in Mode.DATE_RANGE_EDITING). Warnings are advisory only — they never block save. The only warning is the full-month check (VR-DC-04); the prior Labour Day advisory has been removed because the live dataset includes Labour Day. When warnings is non-empty it renders in a Review section (page.tsx:308-322).`

### Holiday data lifecycle (fetch + cache + hook)

**FR-DC-22 — Live fetch from data.gov.sg public-holidays dataset. Singapore public holidays are fetched at runtime from**

```
https://data.gov.sg/api/action/datastore_search?resource_id=${SINGAPORE_HOLIDAYS_DATASET_ID}&limit=200
```

where `SINGAPORE_HOLIDAYS_DATASET_ID = 'd_8ef23381f9417e4d4254ee8b4dcdb176' (web-frontend/src/utils/singaporeHolidays.ts:32-34). The dataset is the Singapore Ministry of Manpower consolidated public-holidays record. fetchSingaporeHolidays() (singaporeHolidays.ts:104-134) calls globalThis.fetch against this URL.`

**FR-DC-23 — **`(Observed) suffix parsed into isObserved: boolean. Each API record has a **`**`holiday string. The private constant OBSERVED_SUFFIX = ' (Observed)' (singaporeHolidays.ts:35) is detected via String.prototype.endsWith; on match, the suffix is removed from name and isObserved is set to true. Otherwise isObserved is false (singaporeHolidays.ts:69-78). Asserted by singaporeHolidays.test.ts:80-97. Example: API holiday: 'Vesak Day (Observed)' → { date: '2026-06-01', name: 'Vesak Day', isObserved: true }. The literal (Observed) substring therefore never appears in any UI surface.`

**FR-DC-24 — Entry shape **`{ date, name, isObserved }. **`**`SingaporeHolidayEntry (singaporeHolidays.ts:37-41) has exactly three fields: date: string (ISO YYYY-MM-DD), name: string (official English holiday name — e.g. Labour Day, Chinese New Year, Hari Raya Puasa, Vesak Day, Deepavali, National Day, New Year's Day), and isObserved: boolean. There is **no Chinese / bilingual / second-language column. **name values come from the upstream dataset verbatim (including any Unicode curly quotes, e.g. New Year's Day).`

**FR-DC-25 — In-memory cache + request coalescing + retry. **`fetchSingaporeHolidays maintains a module-level cache cache: { entries: SingaporeHolidayEntry[] | null; inflight: Promise<…> | null } (singaporeHolidays.ts:55-63). On a successful fetch the cache is populated and the in-flight promise is cleared (singaporeHolidays.ts:117-123). Concurrent callers share the same inflight Promise (coalesced into a single network call; asserted by singaporeHolidays.test.ts:111-124). On HTTP error or network throw the in-flight promise is cleared (singaporeHolidays.ts:130-133) so a subsequent call can retry (asserted by singaporeHolidays.test.ts:126-138). After success, entries are written to IndexedDB best-effort (void writeStoredSingaporeHolidays(...).catch(...), singaporeHolidays.ts:121-123); a persistence failure does not break the in-memory result.`

**FR-DC-26 — HTTP error surface. A non-OK response (**`response.ok === false) throws new Error('Failed to fetch Singapore public holidays: HTTP ${response.status}') (singaporeHolidays.ts:114-116). A malformed payload (missing success: true or missing result) throws new Error('Unexpected data.gov.sg response: missing success flag or result') (singaporeHolidays.ts:70-72). Both errors propagate to the hook as error: string (the Error.message).`

**FR-DC-27 — IndexedDB persistent cache (****`singapore-holidays:v1*). **`***`loadSingaporeHolidaysFromIdb (singaporeHolidays.ts:89-102) reads via idb-keyval from key SINGAPORE_HOLIDAYS_STORAGE_KEY = 'singapore-holidays:v1' (singaporeHolidaysStorage.ts:31). The value is typed StoredSingaporeHolidays = { entries: SingaporeHolidayEntry[]; fetchedAt: number } (singaporeHolidaysStorage.ts:24-27). Read errors (private mode, disabled IDB, test environment) are swallowed and treated as null (singaporeHolidays.ts:96-101). writeStoredSingaporeHolidays (singaporeHolidaysStorage.ts:41-43) and clearStoredSingaporeHolidays (:45-47) round out the API. The :v1 suffix is the backwards-incompatible-versioning convention: bumping the suffix discards stale entries on read (singaporeHolidaysStorage.ts:29-30).`

**FR-DC-28 — React hook ****`useSingaporeHolidays`**** with ****`loading | ready | error`**** state machine. The hook (**`web-frontend/src/hooks/useSingaporeHolidays.ts:48-100) returns`

```
{ status: 'loading' | 'ready' | 'error'; entries: SingaporeHolidayEntry[]; error: string | null; refetch: () => Promise<void> }
```

- **Initial status: **`'loading' when getCachedSingaporeHolidays() returns null; 'ready' when a cached entries array is already present (useSingaporeHolidays.ts:40-46).`
- **On mount: (1) async-load IDB seed via **`loadSingaporeHolidaysFromIdb; if non-null, set entries and flip status to 'ready'. (2) call fetchSingaporeHolidays to attempt a network refresh; however, when the in-memory cache (cache.entries) is already populated, fetchSingaporeHolidays returns the cached entries without calling fetch (singaporeHolidays.ts:104-110). The on-mount call therefore does **not perform a true stale-while-revalidate network fetch when the module-level cache is warm — it is a stale-only display of the in-memory cache until the cache is cleared or invalidated. A **refetch() callback re-runs the same path and is also not cache-busting.`
- **Network refresh failure does NOT clear the (possibly stale) IDB-backed entries from state — it sets **`error and flips status to 'error' **only if there was no cached data; otherwise status stays **'ready' and the cached entries remain visible (useSingaporeHolidays.ts:62-71). The refetch callback re-runs load() (:54-72) and resolves to void.`

**FR-DC-29 — Derived supported window from min/max of fetched entries. **`getSupportedRange(entries) (singaporeHolidays.ts:141-152) computes { start, end } as the lexicographic min/max of entry dates. getSingaporeHolidaySupportLabel(entries) (singaporeHolidays.ts:154-160) returns ${start} to ${end}when entries are non-empty, or the literal 'no data loaded' when empty.**The supported window is purely data-driven from the dataset — there are no hardcoded **SINGAPORE_HOLIDAY_SUPPORTED_START/END constants and no fixed 2023-01-01..2026-12-31 window. As the dataset grows or shrinks over time, the supported window updates automatically.`

**FR-DC-30 — ****`isSingaporeHolidayRangeSupported(dateRange, entries)`**** (3-arg). (**`singaporeHolidays.ts:162-179) Returns true iff both endpoints are present, the entries list is non-empty, and the YYYY-MM-DD start/end of dateRange lie within the entries' min/max (lexicographic string comparison of ISO date keys). Returns false when entries are empty (asserted by singaporeHolidays.test.ts:175-177) or when either endpoint is missing.`

**FR-DC-31 — ****`getSingaporeHolidayEntriesInRange(dateRange, entries)`**** (3-arg). (**`singaporeHolidays.ts:221-229) Returns entries whose date lies within [formatDate(startDate), formatDate(endDate)] (lexicographic). Returns [] when either endpoint is missing or entries are empty. Asserted by singaporeHolidays.test.ts:376-391.`

**FR-DC-32 — ****`isSingaporeNonWorkDay(date, entries)`**** (2-arg) with weekend fallback. (**`singaporeHolidays.ts:185-195) Returns true iff either the date's ISO key is in the non-work day set built from entries.map(e => e.date) OR the date's UTC weekday is 0 (Sun) or 6 (Sat). Empty entries → always false. Both actual holidays and their (Observed) substitutes are in the non-work day set (asserted by singaporeHolidays.test.ts:206-211).`

**FR-DC-33 — **`getSingaporeDayType(date, entries) (2-arg) with undefined-out-of-range. (**`**`singaporeHolidays.ts:197-210) Returns 'WORKDAY' | 'NON-WORKDAY' only when date lies within the entries' min/max range and entries are non-empty. Returns undefined outside the range (asserted by singaporeHolidays.test.ts:246-248) or when entries are empty (:242-244).`

**FR-DC-34 — ****`buildSingaporeHolidayGroups(items, dateRange, entries)`**** (3-arg). (**`singaporeHolidays.ts:235-283) Returns [] when the range is unset, entries are empty, or the range is outside the supported window (asserted by singaporeHolidays.test.ts:261-278). Otherwise iterates each item and returns exactly three groups (a date item may belong to more than one — every public holiday is also a non-work day):`

- `id: SINGAPORE_WORKDAY_GROUP_ID = 'WORKDAY', description: 'Singapore workdays (weekdays excluding public holidays) imported from the data.gov.sg public holidays dataset', members = item IDs that are neither a public holiday nor a weekend.`
- `id: SINGAPORE_NONWORKDAY_GROUP_ID = 'NON-WORKDAY', description: 'Singapore non-work days (public holidays and weekends) imported from the data.gov.sg public holidays dataset', members = item IDs that are a public holiday OR a weekend (classified via isSingaporeNonWorkDay).`
- `id: SINGAPORE_PH_GROUP_ID = 'PH', description: 'Singapore public holidays imported from the data.gov.sg public holidays dataset', members = item IDs whose date is in the imported public-holiday set (both actual and "(Observed)" substitute days). Weekends that are NOT gazetted holidays are excluded from PH. PH is a subset of NON-WORKDAY.`

The weekend fallback inside `isSingaporeNonWorkDay ensures plain weekend items are correctly classified as NON-WORKDAY even when they are not in the public-holiday set (asserted by singaporeHolidays.test.ts:279-365).`

### Auto-generated date groups (independent of import)

**FR-DC-35 — Auto-generated date groups. **`_generateAutoGeneratedGroups(DataType.DATES, items, dateRange) (schedulingGeneratedData.ts:85-96) always produces, from AUTO_GENERATED_GROUPS[DataType.DATES] (web-frontend/src/utils/keywords.ts:63-141), the following read-only groups, each with isAutoGenerated: true:`

- `ALL — Group containing all dates — all date item IDs.`
- `WEEKDAY — Group containing all weekdays — dates whose getUTCDay() is 1–5.`
- `WEEKEND — Group containing all weekends — dates whose getUTCDay() is 0 or 6.`
- `SUNDAY/MONDAY/TUESDAY/WEDNESDAY/THURSDAY/FRIDAY/SATURDAY — Group containing all {Weekday}s — dates whose getUTCDay() equals 0/1/2/3/4/5/6 respectively.`

**FR-DC-36 — Weekday-group membership is empty without a range. Every weekday-derived generator (including **`WEEKDAY/WEEKEND) returns [] unless dateRange && dateRange.startDate is truthy (keywords.ts:72-138). Membership is computed via dateStrToDate(item.id, dateRange).getUTCDay(), i.e. UTC weekday, so the classification matches the ID round-trip in FR-DC-12. ALL maps every item regardless of range.`

### Imported Singapore holiday groups on save

**FR-DC-37 — Effective checked state for the import checkbox. The Dates page derives **`isSingaporeHolidayImportSupported = useMemo(() => isHolidaysReady && isSingaporeHolidayRangeSupported(draft, singaporeHolidays.entries), [draft, isHolidaysReady, singaporeHolidays.entries]) (page.tsx:84-87). The checkbox's checked attribute is shouldImportSingaporeHolidays && isSingaporeHolidayImportSupported and disabled is !isSingaporeHolidayImportSupported (page.tsx:329-332). Even if the user toggled it on, moving to an unsupported range disables it and treats it as off at save; toggling then re-enabling on a supported range restores the user's intent.`

**FR-DC-38 — Import control renders five distinct states. The control section (**`page.tsx:324-387) renders one of the following based on useSingaporeHolidays status + range support + entry count:`

- **Loading (**`status === 'loading'): grey text Loading Singapore public holidays… (:342); checkbox disabled.`
- **Error (**`status === 'error'): red text ${singaporeHolidays.error ?? 'Failed to load Singapore holidays.'} plus a Retry button that calls refetch() (:344-356); checkbox disabled.`
- **Ready, range unsupported: amber text **`Available only when the selected date range stays within ${singaporeHolidaySupportLabel}. — the label is the dynamic getSingaporeHolidaySupportLabel(entries) output, e.g. 2026-01-01 to 2026-12-31 or no data loaded (:357-361); checkbox disabled.`
- **Ready, range supported, no entries: grey text **`No holiday changes in the selected range. (:362-364); checkbox enabled (effective checked = true).`
- **Ready, range supported, with entries: an open **`<details> disclosure whose summary reads ${N} holiday change (singular when N === 1) / ${N} holiday changes (:365-369); each entry is rendered as a card whose header is ${entry.date} (${formatHolidayWeekday(entry.date)}) (where formatHolidayWeekday is the local dates/page.tsx:78-80 helper using toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })), with a badge OBSERVED if entry.isObserved, otherwise NON-WORKDAY, and below it the entry.name string (:371-381).`

**FR-DC-39 — Helper text under the checkbox. When the checkbox is interactive (range supported), the section shows the helper paragraph**

```
Saving with this enabled will create or overwrite normal editable Singapore holiday date groups once, including WORKDAY, NON-WORKDAY, and PH.
```

(`page.tsx:339).`

**FR-DC-40 — Imported groups are normal editable groups. The **`WORKDAY/NON-WORKDAY/PH groups produced by import are ordinary (not isAutoGenerated) — the user may subsequently edit or delete them; they are created/overwritten only at save time when import is effective, and are not regenerated on every state change (unlike FR-DC-35 groups). replaceDateGroups (schedulingGeneratedData.ts:148-158, useSchedulingData.ts:188-192) replaces any existing groups with the same id (case-insensitive via id.toLowerCase() match), so a user group named workday (any case) would be replaced by the imported WORKDAY.`

**FR-DC-41 — Range-change cascade. **`updateDateRange({ startDate, endDate }, options) (useSchedulingData.ts:161-204) computes the old and new generated date-ID sets via _generateDateItems (empty set when a range is absent), derives removedDateIds as old-minus-new, then in a single updateState:`

1. Filters every existing date group's `members to drop removedDateIds.`
2. If `options.importSingaporeHolidays === true AND isSingaporeHolidayRangeSupported(dateRange, options.singaporeHolidayEntries ?? []) (:179-181), replaces WORKDAY/NON-WORKDAY groups via replaceDateGroups(newGroups, buildSingaporeHolidayGroups(generatedDateItems, dateRange, singaporeEntries)) (:191-192).`
3. Sets `dates.range to the new range (items are re-derived automatically, FR-DC-09).`
4. Calls `applyReferencesForIdDeletion(nextState, DataType.DATES, removedDateIds) to purge removed date IDs from preferences, export config, etc.`

The downstream deletion mechanics are specified in spec 06. Because IDs are span-dependent (FR-DC-11), a change that alters the span (e.g. same-month → cross-month) re-keys all date IDs, so effectively the full old ID set is treated as removed.

### Group member selection (DateGroupMemberSelector)

**FR-DC-42 — Calendar/List view toggle. **`DateGroupMemberSelector (web-frontend/src/components/DateGroupMemberSelector.tsx) offers a Calendar view / List view toggle (DateGroupMemberSelector.tsx:151-170). The selected view persists in local component state view (default 'calendar', DateGroupMemberSelector.tsx:50) for the lifetime of the selector; the toggle uses aria-pressed to indicate the active option.`

**FR-DC-43 — Fallback when no range. If either range endpoint is missing, the selector renders a plain **`CheckboxList of all items labelled Members and skips the calendar entirely (DateGroupMemberSelector.tsx:95-104).`

**FR-DC-44 — Generated vs. other items. With a valid range, the selector computes **`generatedIds by iterating the range in UTC and collecting getDateIdForRange(date, dateRange) for each day (DateGroupMemberSelector.tsx:74-93). Items are partitioned: generatedItems (id in generatedIds) and otherItems (id not in generatedIds) (DateGroupMemberSelector.tsx:109-110). List view shows only generatedItems (label ""); calendar view shows the month grid. In both views, if otherItems.length > 0, an additional CheckboxList labelled Other dates is shown (DateGroupMemberSelector.tsx:211-218).`

**FR-DC-45 — Calendar day selectability. In calendar view, each day resolves **`getSelectableId(date) (DateGroupMemberSelector.tsx:112-120): a day is selectable only when its ISO key is within [startDateKey, endDateKey] (string compare) AND a matching item id exists (itemById.has(id)). Selectable days show aria-label equal to the date id and toggle membership; non-selectable days are disabled, styled as unavailable, and given aria-label Unavailable ${date.toISOString().split('T')[0]} (e.g. Unavailable 2026-07-31) with aria-pressed undefined (DateGroupMemberSelector.tsx:182-200). Selected selectable days set aria-pressed true.`

**FR-DC-46 — Drag-select membership. Calendar member selection supports click and drag-toggle (**`DateGroupMemberSelector.tsx:122-147). Mouse-down on a selectable day records it as the pending id. On mouse-enter of a different selectable day, the first drag transition toggles the original mouse-down id and then the entered id, and each further entered day toggles once (tracked via lastEnteredIdRef). If no drag occurred, mouse-up toggles the single clicked id. Drag state resets on mouse-up, grid mouse-leave (onGridMouseLeave={resetDragState}), and global mouse-up; text selection is disabled during drag and restored on reset (DateGroupMemberSelector.tsx:66-71). Keyboard Enter/Space on a day button call preventDefault (no activation) (CalendarMonthView.tsx:73-77).`

**FR-DC-47 — Singapore entries plumbed into day-classification. The selector calls **`useSingaporeHolidays() once (DateGroupMemberSelector.tsx:51) and passes singaporeEntries to getCalendarDayCategoryClassName(date, singaporeEntries) for non-selected selectable days (DateGroupMemberSelector.tsx:197). This is what makes the calendar tile colors reflect the live Singapore dataset (Singapore NON-WORKDAY shading on weekdays, plain weekend styling otherwise).`

## Validation Rules & Messages

| ID | Field / key | Condition (verbatim) | Message (verbatim) | Type | Source |
| --- | --- | --- | --- | --- | --- |
| VR-DC-01 | `errors.startDate` | `!draft.startDate` | `Start date is required` | Blocking (prevents save) | `page.tsx:128-130` |
| VR-DC-02 | `errors.endDate (required)` | `!draft.endDate` | `End date is required` | Blocking | `page.tsx:132-134` |
| VR-DC-03 | `errors.endDate (order)` | `draft.startDate && draft.endDate && draft.startDate > draft.endDate` | `End date must be after start date` | Blocking | `page.tsx:136-138` |
| VR-DC-04 | `warnings.dateRange` | editing AND `!isFullCalendarMonth(draft)` | `Selected dates do not represent a full month (first day to last day of the same month)` | Advisory (non-blocking) | `page.tsx:96-98` |
| VR-DC-05 | import loading hint | `useSingaporeHolidays().status === 'loading'` | `Loading Singapore public holidays…` | Informational | `page.tsx:341-343` |
| VR-DC-06 | import error hint | `useSingaporeHolidays().status === 'error'` | `${error ?? 'Failed to load Singapore holidays.'} (followed by a Retry button)` | Informational + control | `page.tsx:344-356` |
| VR-DC-07 | import unsupported hint | `useSingaporeHolidays().status === 'ready' AND !isSingaporeHolidayRangeSupported(draft, entries)` | `Available only when the selected date range stays within ${getSingaporeHolidaySupportLabel(entries)}. (label is dynamic; example 2026-01-01 to 2026-12-31 or no data loaded)` | Informational | `page.tsx:357-361` |
| VR-DC-08 | import no-change hint | ready AND range supported AND `getSingaporeHolidayEntriesInRange(draft, entries).length === 0` | `No holiday changes in the selected range.` | Informational | `page.tsx:362-364` |

Notes:

- `isFullCalendarMonth(draft) (calendar.ts:54-64) is true only when startDate.getUTCDate() === 1 and endDate equals the UTC last day of startDate's month.`
- The supported-range label in VR-DC-07 is **dynamic (**`getSingaporeHolidaySupportLabel(entries)). It is **not a hardcoded **2023-01-01 to 2026-12-31. The label updates automatically as the upstream dataset's min/max changes.`
- Field errors are cleared eagerly: editing a native input clears its own error (`page.tsx:252, 281); the calendar onChange clears both date errors (page.tsx:395).`
- The original Labour-Day advisory (`includesUnimportedSingaporeLaborDay + warnings.laborDay) has been removed because the live MOM dataset includes Labour Day (2026-05-01, etc.) — the advisory would never fire in practice.`

## Edge Cases & Quirks

- **UTC everywhere. All weekday, ID, and display computations use UTC. Native **`type="date" values are converted with toISOString().split('T')[0] and new Date(dateStr) (page.tsx:71-77), which interpret the value as UTC midnight; this keeps the ID/display consistent regardless of the user's local timezone.`
- **`>** vs >= in order validation. VR-DC-03 uses strict **`**`startDate > endDate, so a single-day range (start === end) is valid and yields exactly one date item and Duration: 1 days (the read view does not special-case the plural; only the editing-mode live count does — FR-DC-07).`
- **Duration string is not singularized in the committed read view. **`Duration: {N} days always uses days even when N === 1 (page.tsx:224).`
- **Span-dependent IDs re-key on span change. Editing the range from a same-month span to a cross-month or cross-year span changes every item id format (**`DD → MM-DD → YYYY-MM-DD). The cascade (FR-DC-41) then strips the old-format IDs from groups/references, so manual group memberships referencing old-format IDs are dropped.`
- **Import checkbox auto-unchecks on unsupported range. The effective checked value is **`shouldImportSingaporeHolidays && isSingaporeHolidayImportSupported; even if the user checked it, moving to an unsupported range disables it and treats it as off at save (page.tsx:329-332, useSchedulingData.ts:179-181).`
- **Support check is string comparison. **`isSingaporeHolidayRangeSupported compares ISO date-key strings, not Date objects (singaporeHolidays.ts:176-178), relying on lexical ordering of YYYY-MM-DD.`
- **No badge for ordinary workdays/weekends. Singapore public holidays are all NON-WORKDAY-class; there is no concept of a "Singapore workday holiday" (unlike Taiwan's 補行上班). The change-list badge is therefore either **`NON-WORKDAY (actual holiday) or OBSERVED (substitute day); plain workdays and plain weekends have no badge and never appear in the change list because getSingaporeHolidayEntriesInRange filters by date match (not by category deviation).`
- **`OBSERVED** badge suppresses the suffix in display. The dataset's literal **`**` (Observed) suffix is stripped from entry.name at parse time (FR-DC-23); the badge label OBSERVED is the only place that information surfaces in the UI.`
- **Imported groups overwrite by case-insensitive id. **`replaceDateGroups matches on id.toLowerCase() (schedulingGeneratedData.ts:153-155), so a user group named workday (any case) would be replaced by the imported WORKDAY.`
- **Concurrent fetch coalescing + retry-after-failure. Concurrent calls to **`fetchSingaporeHolidays share one network request; after a failure the in-flight promise is cleared so the next call retries fresh (FR-DC-25; asserted by singaporeHolidays.test.ts:111-138).`
- **Hook keeps stale IDB entries on network failure. A network refresh failure does NOT clear the IDB-backed entries from state — it sets **`error and only flips status to 'error' if there was no cached data (FR-DC-28; asserted by useSingaporeHolidays.test.ts:79-103). The user therefore sees the last-known-good data while the error indicator is shown.`
- **Best-effort IndexedDB persistence. A failure to write to IndexedDB does not affect the in-memory result (**`singaporeHolidays.ts:121-123); a failure to read from IndexedDB is swallowed and treated as null (:96-101). Storage key versioning uses the :v1 suffix (FR-DC-27).`
- **Member-selection calendar cannot page outside range; picker can. The two calendars differ: the member selector clamps navigation to the range (FR-DC-19), the range picker does not (FR-DC-16).**
- **`Other dates** bucket. Dates in a group whose IDs are not in the currently generated set (e.g. left over from a previous range or advanced imported IDs) still appear under **`**`Other dates so they remain visible and toggleable (DateGroupMemberSelector.tsx:211-218).`
- **Keyboard on calendar days is inert. **`Enter/Space are prevented (CalendarMonthView.tsx:73-77); day selection is mouse-driven only.`
- **Empty-range weekday groups. Without a committed range, all weekday-derived groups (including **`WEEKDAY/WEEKEND) are empty; only ALL is populated (from any items present) (FR-DC-36).`

## Acceptance Criteria

- **AC-DC-01 — Setting a valid range with **`startDate < endDate and confirming commits the range and returns to normal mode; the read view shows both endpoints formatted as Weekday, Month D, YYYY and Duration: N days where N is the inclusive day count. (FR-DC-04, FR-DC-07, FR-DC-08)`
- **AC-DC-02 — Confirming with a missing start date produces error **`Start date is required and does not commit; with a missing end date produces End date is required; with start > end produces End date must be after start date. (VR-DC-01..03)`
- **AC-DC-03 — A committed range produces exactly one read-only date item per calendar day from start through end inclusive, each with description **`Weekday, Mon D, YYYY (e.g. Wednesday, Jul 1, 2026) and isAutoGenerated true. (FR-DC-09, FR-DC-10)`
- **AC-DC-04 — For a range wholly within one month, item IDs are two-digit **`DD; for a range within one year spanning months, IDs are MM-DD; for a cross-year range, IDs are YYYY-MM-DD. (FR-DC-11)`
- **AC-DC-05 — Attempting to rename an auto-generated date item has no effect on state. (FR-DC-09)**
- **AC-DC-06 — With a committed range, the auto-generated date groups always include **`ALL, WEEKDAY, WEEKEND, and the seven single-weekday groups; WEEKDAY contains exactly the dates whose UTC weekday is Monday–Friday and WEEKEND those that are Saturday/Sunday; ALL contains every date. (FR-DC-35, FR-DC-36)`
- **AC-DC-07 — Without a committed range, **`WEEKDAY/WEEKEND and single-weekday groups have no members. (FR-DC-36, FR-DC-43)`
- **AC-DC-08 — On first page load the hook starts in **`status: 'loading' and the import control renders the loading hint Loading Singapore public holidays… and is disabled. The hook then either (a) flips to status: 'ready' with the parsed entries (success path), or (b) flips to status: 'error' and renders ${error} plus a working Retry button if the network failed AND no cached entries exist. (FR-DC-22, FR-DC-25, FR-DC-26, FR-DC-28, VR-DC-05/06)`
- **AC-DC-09 — When the hook is in **`status: 'ready' and the draft range is outside the entries' derived min/max, the import control is disabled and the hint reads Available only when the selected date range stays within ${start} to ${end}. (the label is dynamic, e.g. 2026-01-01 to 2026-12-31 or no data loaded). Moving the range inside the window re-enables the control. (FR-DC-29, FR-DC-37, VR-DC-07)`
- **AC-DC-10 — When the hook is in **`status: 'ready' and the draft range is supported and there are matching entries, the change disclosure opens by default and lists each entry as ${date} (${shortWeekday}) with badge NON-WORKDAY for actual holidays and OBSERVED for substitute days, plus the entry.name below. (FR-DC-23, FR-DC-31, FR-DC-38)`
- **AC-DC-11 — Saving with import enabled and supported passes **`updateDateRange({ startDate, endDate }, { importSingaporeHolidays: true, singaporeHolidayEntries: <full entries array> }) and creates/overwrites exactly three editable groups WORKDAY, NON-WORKDAY, and PH (with their fixed descriptions Singapore workdays (weekdays excluding public holidays) imported from the data.gov.sg public holidays dataset / Singapore non-work days (public holidays and weekends) imported from the data.gov.sg public holidays dataset / Singapore public holidays imported from the data.gov.sg public holidays dataset), classifying each date via isSingaporeNonWorkDay (in-set OR UTC weekend) for NON-WORKDAY and via the public-holiday set for PH, replacing any same-named (case-insensitive) groups. (FR-DC-04, FR-DC-34, FR-DC-40, FR-DC-41)`
- **AC-DC-12 — When the range is not a full calendar month, the review shows **`Selected dates do not represent a full month (first day to last day of the same month); it never blocks saving. (VR-DC-04)`
- **AC-DC-13 — With no range set, the member selector shows a single **`Members checkbox list and no calendar. (FR-DC-43)`
- **AC-DC-14 — In calendar member view, days outside the range (or with no matching item) are disabled with **`aria-label Unavailable YYYY-MM-DD; in-range days toggle membership on click and via drag across contiguous days. The non-selected day color comes from getCalendarDayCategoryClassName(date, singaporeEntries). (FR-DC-18, FR-DC-45, FR-DC-46, FR-DC-47)`
- **AC-DC-15 — In the member-selection calendar, previous/next month navigation is disabled at the range's first/last month respectively; the range-picker calendar has no such bound. (FR-DC-19, FR-DC-16)**
- **AC-DC-16 — The Calendar/List toggle persists the chosen view within the selector; List view shows only generated dates while an **`Other dates list appears whenever the group has members outside the generated set. (FR-DC-42, FR-DC-44)`
- **AC-DC-17 — Clicking **`Use full {Month YYYY} sets the draft range to the full UTC month currently shown. (FR-DC-15)`
- **AC-DC-18 — Committing a new range removes IDs no longer generated from all date-group memberships and purges them from downstream references, while re-deriving the date items from the new range. (FR-DC-41)**
- **AC-DC-19 — **`fetchSingaporeHolidays returns the same in-memory entries on repeated concurrent calls within one session (no duplicate network requests); after a failure, a subsequent call performs a fresh network fetch. The cache is populated only after a successful fetch, and the persisted IndexedDB copy (singapore-holidays:v1) is written best-effort on success. (FR-DC-25, FR-DC-27)`

## Cross-References

- **Item/Group editor shared behavior (read-only items flag, add/duplicate/rename/reorder groups, double-click editing, reserved-keyword rejection, **`CheckboxList): see the item-group-editor spec. This domain sets itemsReadOnly={true} and supplies a custom renderGroupMemberSelector (page.tsx:441-448).`
- **Downstream reference cascade (**`applyReferencesForIdDeletion effect on preferences and export config when date IDs are removed): see spec `**06 (Preferences & references).**
- **Reserved keywords (**`ALL, WEEKDAY, WEEKEND, weekday names, plus imported WORKDAY/NON-WORKDAY/PH semantics): see web-frontend/src/utils/keywords.ts and the item-group-editor spec.`
- **Export layout consumes **`dates.groups (generateExportLayoutConfig(..., prevState.dates.groups), useSchedulingData.ts:714): see the export spec.`
- **Undo/redo & history apply to date-range changes like any other state mutation (**`updateState → addToHistory, useSchedulingData.ts:81-91): see the history/persistence spec.`
- **Live Singapore dataset source (data.gov.sg MOM consolidated public-holidays record, resource ID **`d_8ef23381f9417e4d4254ee8b4dcdb176, limit 200): see SINGAPORE_HOLIDAYS_API_URL and SINGAPORE_HOLIDAYS_DATASET_ID in web-frontend/src/utils/singaporeHolidays.ts:32-34. Network access is required to populate the cache; without network (or in test environments where globalThis.fetch is mocked) the hook remains in loading or transitions to error.`
- **Backend ****`country`**** precondition (**`None or "SG", else ValueError): see spec **C3 (preference/constraint semantics) and **core/nurse_scheduling/scheduler.py:108-109. The supported import window is purely a frontend concern (driven by the dataset, not the backend).`
