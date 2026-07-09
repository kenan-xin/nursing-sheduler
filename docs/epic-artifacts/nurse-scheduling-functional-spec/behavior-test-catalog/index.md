---
title: "Behavior & Test Catalog"
kind: spec
---

# Behavior & Test Catalog

## Purpose & Scope

This artifact is a **UI-agnostic catalog of the behaviors the current test suite**
**guarantees for the **`nurse-scheduling app, plus guidance on which tests can be`
**ported as-is to a rebuild versus re-authored against a new design. It exists**
so a rebuild can be held to **strict parity: the new app (frontend rebuilt, backend**
`core/ unchanged) must pass equivalent checks for every behavior below.`

**Fidelity target: STRICT PARITY. Every behavior statement is a testable assertion**
the current suite makes today. The rebuild is not "done" until an equivalent check
passes for each one.

Feature-area tags reference the domain spec sections (`nurse-scheduling-functional-spec/):`

| Tag | Domain spec section |
| --- | --- |
| DM | 01 Data Model & Entities |
| DC | 02 Dates & Calendar |
| ED | 03 Item/Group Editors |
| SR | 04 Shift Requests Editor |
| PR | 05 Card Preference Editors |
| RI | 06 Reference Integrity |
| CC | **Shift Type Coverings (new preference type — see decision log 02)** |
| ST | 07 State, History & Persistence |
| SL | 08 Save/Load & YAML |
| EX | 09 Export Layout |
| OE | 10 Optimize & Export |
| CON-* | contracts/ (CON-API, CON-EXE, CON-OUT, CON-SEM, CON-YAML) |

**Surveyed sources (all paths relative to repo root**
`/home/kenan/.traycer/worktrees/j3soon__nurse-scheduling/traycer-traycer-silent-raven):`

- E2E harness: `web-frontend/e2e/helpers.ts, web-frontend/e2e/test.ts`
- ~90 Playwright specs: `web-frontend/e2e/*.spec.ts`
- ~60 Vitest/RTL unit + component suites: `web-frontend/src/**/*.test.ts(x)`
(11 page suites `src/app/**/page.test.tsx (~203 cases), 22 component suites`
`src/components/*.test.tsx, utils src/utils/*.test.ts, hooks src/hooks/*.test.ts)`
- Python golden harness: `core/tests/schedule_test_helper.py,`
`core/tests/export_test_helper.py, solver entrypoint`
`core/tests/test_schedule_ortools_cp_sat.py,`
`core/tests/test_export_xlsx_ortools_cp_sat.py (single-backend`
OR-Tools only — PuLP/CBC/cuOpt solver modules and their test
counterparts have been removed from the source tree; do not list them
as current).
- Data-driven fixtures: `core/tests/testcases/{basics,artificial,real}/`
(`*.yaml -> *.csv / *.xlsx / *.prettify.xlsx goldens; *_error.txt substrings)`
- Python targeted tests: `core/tests/test_serve.py, test_cli.py,`
`test_preference_validation.py, test_models_validation.py, test_scheduler.py,`
`test_utils.py, test_export_formatting.py, test_anonymize_scheduling_data.py,`
`solver_test_utils.py`

## Behavior Catalog by Feature Area

Each item is a crisp, UI-agnostic, testable statement. Parenthetical citations point
to the test source(s) that guarantee it today.

### DM — Data Model & Entity Validation

- **DM-B1 A schedule payload requires an "at most one shift per day" preference;**
its absence is rejected with "Missing required preferences".
(`test_models_validation.py::test_model_requires_at_most_one_shift_preference)`
- **DM-B2 Entity IDs (people, shift types, date groups, people groups) must be**
unique within their collection; duplicates are rejected with a
"Duplicated <kind> ID/group" message. (`test_models_validation.py)`
- **DM-B3 Reserved keywords (**`ALL, and day/weekday keywords such as WEEKDAY,`
`MONDAY) cannot be used as an entity ID; using one is rejected with`
"... cannot be one of the reserved values".
(`test_models_validation.py, error-.txt cases in testcases/basics/:`
`*_people_group_keyword_all_error, *_shift_types_group_keyword_all_error,`
`*_dates_group_keyword_{all,monday,weekday}_error)`
- **DM-B4 A date group ID must not itself be in date-identifier format**
(e.g. `2025-01-01); such an ID is rejected with "must not be in the format".`
(`test_models_validation.py::test_model_rejects_invalid_dates_items_and_group_ids)`
- **DM-B5 **`dates.items supplied directly in input is rejected ("dates.items is not`
allowed") — date items are generated from the range, never authored.
(`test_models_validation.py)`
- **DM-B6 A date range with **`endDate before startDate is rejected with`
"enddate must be after or equal to startdate". (`test_models_validation.py)`
- **DM-B7 Weights accept **`0, floats, infinity aliases, and integer shorthand`
suffixes; a floating-point weight where an integer is required is rejected
(`*_weight_floating_point_error), and zero-float weight is accepted.`
(`test_models_validation.py::test_model_accepts_zero_float_weight, frontend`
`numberParsing.test.ts parseWeightValue)`
- **DM-B8 Nested shift-type-requirement groups and **`shiftTypeCoefficients parse into`
the expected internal tuple form (e.g. `[["D","E"]], [("D",2)]).`
(`test_models_validation.py::test_model_accepts_nested_shift_type_requirement_groups)`
- **DM-B9 Unsupported **`apiVersion and unsupported country are each rejected.`
(`test_scheduler.py::test_scheduler_rejects_unsupported_apiVersion,`
`test_scheduler_rejects_unsupported_country). The solver is fixed at`
**`ortools/cp-sat` and is not user-selectable (see C2/C4).`
- **DM-B10 An extra/unknown parameter on a preference or entity is rejected**
(`*_extra_parameter_error).`

### DC — Dates, Calendar & Date-ID Formats

- **DC-B1 Date identifiers use scope-dependent formats: **`DD when the range is within`
one month, `MM-DD when the range spans months within a year, and full YYYY-MM-DD`
when it spans years. (`dateParsing.test.ts, calendar.test.ts "formats date IDs`
according to the configured range scope"; e2e `dates-month-spanning-id-format,`
`dates-cross-year-downstream, dates-range-shrink-format)`
- **DC-B2 Parsing a pure-day date string is rejected when the range's months differ;**
a month-day string is rejected when years differ; unknown formats
("is not in the format") and out-of-range dates ("out of the range") are rejected.
(`test_utils.py::test_parse_dates_*)`
- **DC-B3 Calendar month/day arithmetic is performed in UTC; a month grid includes**
leading blank days; complete months (incl. leap-year February) are recognized.
(`calendar.test.ts)`
- **DC-B4 MM-DD / DD inference derives the year (and month) from the range start;**
invalid input falls back to the current date. (`dateParsing.test.ts)`
- **DC-B5 Multiple date input formats and shorthand dates in one schedule resolve to**
the same generated items. (`testcases/artificial/ortools/ex2_multiple_date_formats,`
`ex2_shorthand_dates)`
- **DC-B6 Shrinking a date range removes date items that fall outside the new range**
and reverts downstream IDs to the narrower format; growing across a boundary widens
the format. (frontend `useSchedulingData.test.ts "undoes and redoes date identifier`
format transitions across month and year boundaries")
- **DC-B7 Singapore-holiday date groups can be imported only for ranges fully inside the**
supported window; import replaces prior generated holiday groups while preserving
unrelated custom groups and manual items; unsupported ranges are ignored; a supported
import is one undoable range change. Holiday entries are English-only (e.g. `Labour Day,`
`National Day); no bilingual (e.g. Chinese) names are emitted. (singaporeHolidays.test.ts, useSchedulingData.test.ts)`

### ED — Item / Group Editors (people, shift types, generic item-group)

- **ED-B1 An entity can be added, edited (inline), and deleted through the editor.**
(`shift-counts, shift-affinities, shift-type-requirements,`
`shift-type-successions + their -edit-delete specs; component InlineEdit.test.tsx,`
`ItemGroupEditorPage.test.tsx)`
- **ED-B2 Duplicating an item or group inserts a copy directly under the source, with**
a unique "copied" description, **without opening the editor; an invalid source index**
yields no copy. (`duplicate-actions, hooks/schedulingEntryDuplication.test.ts)`
- **ED-B3 Item/group mutations dismiss any open add/edit draft before mutating.**
(`duplicate-actions "item group mutations dismiss open add drafts before mutating",`
"preference and export duplicate actions dismiss open add drafts before mutating")
- **ED-B4 Canceling an edit of an existing item/group restores the persisted values on**
reopen; canceling an add form resets draft values on reopen.
(`people-edit-cancel-reset, people-group-edit-cancel-reset,`
`people-add-form-cancel-reset, shift-types-edit-cancel-reset,`
`shift-types-group-edit-cancel-reset, export-formatting-cancel-edit-reset,`
`dates-cancel-edit-reset)`
- **ED-B5 Drag-reorder of items/groups persists across navigation and is one undoable**
step. (`people-reorder-undo-redo, shift-type-successions-drag-reorder,`
`export-formatting-reorder-persistence, DraggableCardList.test.tsx)`
- **ED-B6 Generated date items remain read-only while group controls stay available.**
(`dates-read-only-page)`

### SR — Shift Requests Editor

- **SR-B1 A single click applies one shift request to one cell; multi-click can apply**
multiple shift types to one cell. (`shift-requests-multi-shift-click,`
`shift-requests-quick-add-click)`
- **SR-B2 A drag gesture applies the same request across multiple cells and collapses**
into a single undo step even if a cell is revisited mid-gesture.
(`shift-requests-drag-multiselect, shift-requests-drag-undo-history)`
- **SR-B3 Clear mode clears a single cell on click and clears multiple cells across one**
drag gesture; clear mode stays deterministic after multiple shift types were selected;
clearing multiple selected cells works. (`shift-requests-clear-click,`
`shift-requests-clear-drag, shift-requests-clear-multiple-selected)`
- **SR-B4 Clear-data removes current requests and history summaries and is undo/redoable.**
(`shift-requests-clear-data, shift-requests-clear-data-undo-redo)`
- **SR-B5 History cells: quick-add clear clears one/many history cells (respecting**
padded history columns on shorter rows); a history edit modal updates the saved
people-history summary; grouped shift-type selections are ignored for history quick-add
and leave history unchanged. (`shift-requests-history-*)`
- **SR-B6 Quick-add preference inputs reset after canceling and reopening the mode.**
(`shift-requests-quick-add-reset)`
- **SR-B7 Randomizing concrete-date requests preserves categories and consecutive runs,**
falls back to weekday/weekend groups, requires each date item in exactly one fallback
category, and rejects multi-person/multi-shift requests.
(`randomizeShiftRequests.test.ts)`

### PR — Card Preference Editors & Preference Validation

- **PR-B1 Shift-count preferences reject mismatched expression/target lengths,**
negative or non-numeric targets, empty expression lists, empty `countShiftTypes, and`
invalid weights/expressions for squared-error. (`test_preference_validation.py)`
- **PR-B2 Shift-count **`shiftTypeCoefficients are accepted when covered by the selected`
group/items; invalid coefficients, coefficients for unselected shift types, and
overlapping explicit coefficient `1 are rejected. (test_preference_validation.py,`
frontend `countShiftTypeCoefficients.test.ts, CountShiftTypeCoefficientFields.test.tsx)`
- **PR-B3 Shift-type-requirement coefficients scale effective people and aggregate**
groups; they parse in scalar/list/nested/grouped/top-level forms; duplicate expanded /
nested / aggregate-and-scalar coverage is allowed (logged, not rejected); overlapping
explicit coefficient `1, duplicate expanded coefficients, coefficients for unselected`
types, and coefficients spanning multiple requirement groups are rejected.
(`test_preference_validation.py, test_scheduler.py::*shift_type_requirement*)`
- **PR-B4 Shift-type-requirement **`inf weight is rejected when combined with`
`preferredNumPeople; empty shiftTypes rejected.`
(`test_preference_validation.py)`
- **PR-B5 Shift-type successions reject **`history all combined with group IDs; people`
history referencing invalid shift types (without successions) is rejected; successions
and affinity reject non-list inputs (`*_pattern_not_list_error).`
(`test_preference_validation.py)`
- **PR-B6 Shift preference editor persists mixed manual and infinity values through a**
reopen. (`shift-preference-editor, ShiftPreferenceEditor.test.tsx,`
`WeightInput.test.tsx)`
- **PR-B7 Weight parsing: infinity aliases, integer shorthand suffixes, decimal**
shorthand that resolves to an integer; display labels for infinities/compact values;
color-by-sign/validity; only valid non-positive weights identified.
(`numberParsing.test.ts)`

### CC — Shift Type Coverings (new preference type, 7th in the union)

The `shift type covering preference type (models.SHIFT_TYPE_COVERING = 'shift type covering') is a `**hard staffing constraint: for every date in**
`date and every shift type in shiftTypes, if any person in preceptees`
is assigned to that shift that day, at least one person in `preceptors`
must also be assigned. The frontend exposes it as tab "8b. Shift Type
Coverings" at route `/shift-type-coverings and the backend models /`
handlers / dispatch entry live in `core/nurse_scheduling/models.py:304-323,`
`core/nurse_scheduling/preference_types.py:622-732, and`
`core/nurse_scheduling/preference_types.py:742. The frontend page is`
`web-frontend/src/app/shift-type-coverings/page.tsx.`

- **CC-B1 A covering rule has three required selectors (**`preceptors,`
`preceptees, shiftTypes) plus an optional date and an optional`
`weight (default 1; ±∞ accepted by the parser). `**Important**
**current-parity caveat: **`date is documented in the source code`
comment as `None = ALL (models.py:319) but the `**current handler**
**does not implement that — **`parse_dates(None) / parse_dates([])`
returns an empty iterable (`utils.py:26-29, 69-92) and the`
constraint loop iterates `for d in ds (preference_types.py:677),`
so `date: None / date: [] / omitted date produces `**zero covering**
**constraints rather than "all dates". To target all dates the**
YAML must emit `date: [ALL] (or an explicit list of date ids). The`
frontend editor also never persists `date on Save/Update`
(`page.tsx:155-162). The frontend stores the three required`
selectors as `(string | string[])[] (nested allowed) and the form`
flattens selections into a single-level array on emit
(`types/scheduling.ts:229-237, models.py:304-323).`
- **CC-B2 Form validation rejects empty selectors with three verbatim**
messages: `At least one preceptor must be selected,`
`At least one preceptee must be selected,`
`At least one shift type must be selected; rejects non-numeric /`
non-infinity weights with `Weight must be a valid number, Infinity, or -Infinity. (page.tsx:132-153)`
- **CC-B3 Card list operations: add, edit (form pre-filled, scroll**
saved/restored), duplicate (insert-after with `copy/copy N label),`
delete (no confirm), drag-reorder. Open drafts are dismissed on any
mutation. Empty state: `No covering rules yet. Click "Add Shift Type Covering" to get started. (page.tsx:214-234, 498-507,`
`DraggableCardList.test.tsx)`
- **CC-B4 Reference cascade covers **`SHIFT_TYPE_COVERING. After the`
wave-3 fix, `web-frontend/src/hooks/schedulingReferenceUpdates.ts`
imports `SHIFT_TYPE_COVERING and branches on it in`
`applyPreferencesForIdChange and applyPreferencesForIdDeletion`
(the export-layout cascade functions are unaffected because covering
preferences do not appear in `state.export). Renaming a person or`
shift type referenced in a covering rule rewrites the matching IDs in
the nested `preceptors / preceptees / shiftTypes trees via`
`mapReferenceIdTree; renaming a date rewrites the flat date array.`
Deleting a referenced ID filters the matching IDs out of those same
fields via `filterReferenceIdTree (which prunes emptied sub-arrays).`
A covering rule whose `preceptors, preceptees, or shiftTypes`
collapses to empty after filtering is **dropped in the second-pass**
required-field drop (the `date field is optional and does not count`
toward the drop predicate). Covered by
`web-frontend/src/hooks/schedulingReferenceUpdates.test.ts in the`
`shift type covering cascade describe block.`
- **CC-B5 Normalization sort order includes **`SHIFT_TYPE_COVERING.`
After the wave-3 fix, `sortPreferencesByType in`
`web-frontend/src/hooks/schedulingPreferenceOrdering.ts:112-114 has`
`typeOrder = [AT_MOST_ONE_SHIFT_PER_DAY, SHIFT_TYPE_REQUIREMENT, SHIFT_REQUEST, SHIFT_TYPE_SUCCESSIONS, SHIFT_COUNT, SHIFT_AFFINITY, SHIFT_TYPE_COVERING]. normalizePreferenceOrder adds a`
`shift type covering branch at schedulingPreferenceOrdering.ts:98-110`
that sorts the flat `date array by entity order (preserving`
`undefined when missing) and passes the nested preceptors /`
`preceptees / shiftTypes trees through unchanged (matching the`
shift-affinity convention). Covered by
`web-frontend/src/hooks/schedulingPreferenceOrdering.test.ts.`
- **CC-B6 Anonymization rewrites **`preceptors, preceptees, and`
`shiftTypes via mapReferenceIdTree (the nested reference-tree`
contract), preserving any nested-group structure. People IDs in those
fields are mapped; descriptions are removed when `removeDescriptions is`
  1. (`anonymizeSchedulingState.ts:76-83)`
- **CC-B7 The Pydantic model rejects **`preceptors /`
`preceptees / shiftTypes that are not lists at the YAML/model`
level with Pydantic's standard list-type error
(`Input should be a valid list); the `**handler**
(`preference_types.py:636-641, 670-675) additionally rejects`
empty resolved selectors with three messages (CC-B2 cross-reference).
The verbatim handler messages
`Preceptors must be a list, but got {type},`
`Preceptees must be a list, but got {type},`
`Shift types must be a list, but got {type} are reachable when`
constructing a `ShiftTypeCoveringPreference programmatically`
(not from YAML) with a non-list value, and on empty resolved
selectors. A parity test asserting these exact messages against
a YAML upload with `preceptors: P1 (scalar) will fail at the`
Pydantic layer with a different error.
- **CC-B8 **`weight is accepted but `**not used by the handler — the**
constraint is hard-reified via the implication
`any_preceptee <= at_least_one_preceptor`
(`preference_types.py:701-721). Both +inf and finite weights produce`
identical hard behavior. Re-authored tests should not assert weight
affects solver output.
- **CC-B9 Required-task test references:**
`core/tests/test_shift_type_covering_preference.py (model construction,`
nested preceptors, infinity weight acceptance, non-infinity float
rejection, `extra="forbid" enforcement);`
`web-frontend/src/app/shift-type-coverings/page.test.tsx (form opens,`
weight label rendered exactly once, existing rules render).
- **CC-B10 Round-trip: YAML emitted by **`generateYamlFromState (which`
emits the three selectors as `list[str | list[str]] / list[int | str | list[int | str]]) is re-parseable; the backend _flatten_persons /`
`_flatten_shifts helpers expand nested lists into sorted deduped id`
sets the same way `shift affinity does (CON-SEM-06). Re-authored`
round-trip tests should assert emit → load → emit stability.

### RI — Reference Integrity (rename / delete cascade)

- **RI-B1 Renaming an entity (person, date, shift type, or group) updates every**
downstream reference across all pages and in YAML — including nested preference groups
and scalar reference fields. (`rename-cascade, shift-type-rename-cascade,`
`hooks/schedulingReferenceUpdates.test.ts::applyReferencesForIdChange)`
- **RI-B2 Deleting an entity removes its references downstream, drops rules whose**
required fields become empty, blanks deleted shift-type history slots, removes deleted
shift-type export references and requirement coefficients, and removes references inside
nested affinity groups without dropping still-populated groups.
(`rename-delete-cascade, applyReferencesForIdDeletion,`
`export-layout-entity-cascade)`
- **RI-B3 Rename-then-delete removes the renamed reference from downstream pages.**
(`rename-delete-cascade "renaming then deleting a person...")`
- **RI-B4 Stale preference references are rejected before solving.**
(`test_scheduler.py::test_scheduler_rejects_stale_preference_references_before_solving)`
- **RI-B5 Rename/delete cascades survive a save-load roundtrip and are undo/redoable.**
(`rename-save-load-roundtrip, export-layout references cascade through ... undo, and redo)`

### ST — State, History & Persistence (undo/redo, cross-tab)

- **ST-B1 State is persisted to localStorage under a stable key; computed date items are**
kept out of the stored payload; a getItem/setItem throw is logged but does not crash
(falls back to default / keeps in-memory state). (`useSchedulingData.test.ts)`
- **ST-B2 Undo/redo restore prior scheduling state across page actions, including**
multi-step chains that restore intermediate states; redo history is truncated after a
new mutation following undo. (`undo-redo-shortcuts, undo-redo-depth,`
`useSchedulingData.test.ts)`
- **ST-B3 History mutators support **`replaceLatestHistoryEntry to keep one-step undo`
semantics for compound edits (mixed add+update collapse to one boundary).
(`useSchedulingData.test.ts)`
- **ST-B4 [OUT OF PRODUCT SCOPE — excluded per the brief.] A**
cross-tab storage change (including localStorage cleared elsewhere)
shows a banner; the reload action reloads provider state; unrelated
keys/storage areas are ignored; hydrated state survives consumer
remount. (`useSchedulingData.test.ts) — listed here for`
completeness because the current e2e tests cover it, but a rebuilt
frontend is not required to reproduce this behavior. The same
applies to the `ExternalStorageChangeBanner itself.`
- **ST-B5 **`null qualifiedPeople loaded from storage normalizes to "all people".`
(`useSchedulingData.test.ts)`
- **ST-B6 A tab-switch warning stays active until all active editing hooks/providers**
clean up. (`unsavedEditingState.test.ts)`
- **ST-B7 New-schedule reset returns the app to the default seeded state (clearing**
custom people history and export layout), is undoable from downstream pages, and the
just-created state can be restored from YAML afterward.
(`home-new-schedule, save-load-new-schedule-restore,`
`save-load-reset-restore-downstream)`

### SL — Save / Load & YAML

- **SL-B1 A full YAML upload replaces state wholesale (does not merge): sequential**
uploads replace cleanly, partial/sparse YAML replaces old sections instead of preserving
stale group data, and stale people/shift-type metadata is replaced when loading sparse
sections. (`save-load-sequential-uploads, save-load-partial-state-replacement,`
`editing sparse export YAML replaces old formatting and extra layout entries,`
`useSchedulingData.test.ts)`
- **SL-B2 Uploading the same YAML twice leaves the resulting state/preview stable**
(idempotence). (`save-load-identical-upload-idempotence,`
`uploading the same YAML twice leaves the resulting preview stable)`
- **SL-B3 Upload -> download roundtrip yields the uploaded state; edit -> download**
reflects saved edits; copy/download expose current YAML through real controls.
(`save-load-roundtrip, save-load-upload-download-consistency,`
`save-load-edit-download, save-load-copy-download, rename-save-load-roundtrip)`
- **SL-B4 Invalid/malformed YAML does not corrupt state: the editor recovers and can**
save successfully afterward; download still reflects the original state; a
malformed-then-valid upload restores downstream pages cleanly; the same filename can be
retried after failure. (`save-load-invalid-recovery, save-load-invalid-then-download,`
`save-load-malformed-valid-downstream, save-load-same-file-retry,`
`people-upload-recovery, shift-types-duplicate-rename-recovery)`
- **SL-B5 An uploaded replacement is exactly one undoable state boundary over the**
prior schedule; upload/undo/redo works across route changes; preview/copy/download
follow undo/redo. (`save-load-replacement-undo-redo,`
`save-load-upload-undo-redo-route, save-load-replacement-copy-download-undo-redo,`
`uploaded-state can be undone and redone across route changes)`
- **SL-B6 YAML preview reflects uploaded state after a page refresh; upload waits for**
completion dialogs before downstream state is asserted; editing YAML applies renamed
entities through the real save flow. (`save-load-refresh-after-upload,`
`save-load-upload-completion, save-load-edit-yaml)`
- **SL-B7 A version mismatch on upload shows a warning honoring cancel/continue**
branches. (`save-load-version-warning, VersionWarningBanner.test.tsx,`
`version.test.ts)`
- **SL-B8 People bulk (CSV/list) upload preserves unmentioned existing people at the**
tail in original order, preserves descriptions/history through reorder, recovers from
invalid duplicate lists, and is undo/redoable. (`people-upload-*, csv-upload,`
`restorePeopleIdsInXlsx.test.ts)`
- **SL-B9 YAML round-trip preserves advanced/backend-compatible reference syntax and**
restores `Infinity from storage; import warnings surface for preserved advanced syntax.`
(`useSchedulingData.test.ts, yamlGenerator.test.ts)`
- **SL-B10 Larger schedules ingest and keep downstream pages responsive.**
(`save-load-large-state-smoke, save-load-complex-upload-fixture)`

### EX — Export Layout (formatting rules, extra rows/columns)

- **EX-B1 Export formatting rules can be added, edited, deleted, and reordered through**
the UI; reorder persists after navigation; delete and reorder+edit are undo/redoable
independently. (`export-formatting, export-formatting-delete-undo-redo,`
`export-formatting-reorder-edit-undo-redo, export-formatting-reorder-persistence)`
- **EX-B2 Export formatting rules affect the YAML sent to optimize/export.**
(`export-formatting-optimize-body)`
- **EX-B3 Formatting rules apply to rows, columns, headers, cells, history cells,**
history headers, and off assignments; unequal trimmed history columns are handled.
(`test_export_formatting.py)`
- **EX-B4 Export formatting and extra layout reject stale references (deleted entities).**
(`test_export_formatting.py::test_export_formatting_rejects_stale_references,`
`test_export_extra_layout_rejects_stale_references)`
- **EX-B5 Extra-column coefficients reject overlapping expanded coefficients and**
overlapping explicit coefficient `1; coefficients persist through Save/Load and`
navigation. (`test_export_formatting.py::test_export_extra_column_rejects_*,`
`export-extra-column-coefficients)`
- **EX-B6 Extra rows/columns cascade through entity deletion; a date-ID format change**
removes stale export references. (`export-layout-entity-cascade,`
`date identifier format changes remove stale export layout references,`
`shrinking the date range removes stale date references from export layout state)`
- **EX-B7 Export-layout duplicate actions insert copied entries for every export list.**
(`export layout duplicate actions insert copied entries for every export list)`

### OE — Optimize & Export (backend integration)

- **OE-B1 Optimize submits the current schedule YAML to the backend and renders success**
metadata (score, solver status); the request body reflects **live page edits without**
going through Save/Load edit mode. (`optimize-and-export,`
`optimize-and-export-live-state-body)`
- **OE-B2 The optimize request body reflects YAML-edited state, follows undo/redo of**
upstream edits, and stays on persisted state when an upstream edit is canceled; a no-op
edit does not change the body. (`optimize-and-export-edited-yaml-body,`
`optimize-and-export-undo-redo-body, optimize-and-export-noop-edit-body)`
- **OE-B3 The optimize payload stays free of stale IDs after a delete cascade and**
reflects empty replacement in people history after shift-type deletion.
(`optimize payload stays free of stale IDs after delete cascade,`
`optimize payload reflects empty replacement in people history after shift-type deletion)`
- **OE-B4 Repeated optimize runs submit again after upstream edits and keep a single**
success summary visible. (`optimize-and-export-repeat,`
`optimize-and-export-repeat-after-edit)`
- **OE-B5 Backend errors render without a stale success state; upstream-invalid state**
surfaces backend validation errors; backend phase SSE messages render in the event log.
(`optimize-and-export-error, optimize-and-export-invalid-state,`
`optimize and export renders backend phase SSE messages in the event log)`
- **OE-B6 Modified prettify and timeout options are sent in the request.**
(`optimize-and-export-options)`
- **OE-B7 The flow works against a real local HTTP server, not only route mocking.**
(`optimize-and-export-http-server)`
- **OE-B8 Optionally anonymizing schedule data before submit is toggleable; when on, it**
replaces people item IDs/references (incl. nested affinity references, group IDs) and
removes descriptions before the payload leaves the browser.
(`anonymizeSchedulingState.test.ts, sentrySchedulingState.test.ts,`
helper `disableOptimizeAnonymization)`

### CON — Contracts (backend API / execution / output / YAML semantics)

- **CON-API-B1 Optimize job lifecycle: POST creates a queued job; status is pollable;**
XLSX is downloadable when ready; DELETE removes completed jobs; SSE streams lifecycle,
progress, and phase events (phase before solver progress). (`test_serve.py::TestOptimizeJobs)`
- **CON-API-B2 CORS allows local-development origins on arbitrary ports and rejects**
untrusted origins; root and health endpoints report version/apiVersion/appVersion.
(`test_serve.py::TestServerHealth)`
- **CON-API-B3 Client UUID cookie is reused, replaced when invalid, and normalized;**
heartbeats update client liveness; expired heartbeat cancels/stops jobs (even
non-interruptible solvers); recent heartbeat prevents cancellation.
(`test_serve.py)`
- **CON-EXE-B1 Cancel requests a running job stop; "finish now" returns the best**
available result and interrupts ortools search between solution callbacks; executor
runs one job at a time; queue positions are reported/published; queued jobs cancel
immediately. The solver is fixed at `ortools/cp-sat` (the only backend with
cooperative stop — see C2/C4), so solver-dependent control rejection no longer
applies. (`test_serve.py)`
- **CON-EXE-B2 Input guardrails: reject missing input, both file+yaml, invalid file**
type, oversized YAML/multipart/file, timeout over one hour, non-positive timeout,
full pending queue, unknown update fields; terminal-job update/heartbeat rejected;
oldest retained terminal job pruned; generated-ID collisions retried; scheduler
failure / no-solution / invalid-HTTP / request-validation-error recorded/captured.
(`test_serve.py)`
- **CON-OUT-B1 CLI: prints git version (with fallback when git unavailable); rejects**
missing input file, prettify for CSV output, unsupported output extension,
progress-jsonl without prettify; writes CSV/XLSX/progress-jsonl output honoring
timeout; no-solution exits zero; prints final comments from export comments;
`--show-model-build-stats prints scheduler events. (test_cli.py)`
- **CON-SEM-B1 The scheduler produces a deterministic, unique optimal solution:**
re-running with the prior solution avoided must not reproduce an equal-score solution
(uniqueness assertion). (`schedule_test_helper.py)`
- **CON-SEM-B2 Scheduler semantics for shift-type requirements: nested/scalar/flat**
group counts aggregate across members/shift types; coefficients scale effective people
and can reference a selected group member; flat lists keep independent counts; qualified
people apply to aggregate groups; feasible status + date-group member parsing; unknown
status raises; non-solution statuses return a None tuple. (`test_scheduler.py)`
- **CON-SEM-B3 Solver truth-table semantics for comparison operators**
(EQ/NE/GE/GT/LE/LT) are enforced. (`solver_test_utils.py + solver tests)`
- **CON-YAML-B1 Backend anonymization of YAML updates people references across**
preferences/export/date-group members and removes all descriptions; unparseable YAML is
returned unchanged; malformed people structures still get descriptions stripped.
(`test_anonymize_scheduling_data.py)`
- **CON-YAML-B2 The golden harness proves YAML -> CSV (data) and**
**YAML -> XLSX / prettify.xlsx (fully-styled: value, number_format, font, fill,**
alignment, border, comment, freeze_panes) parity for every fixture, and preserves
expected-error `.txt substring behavior. (schedule_test_helper.py,`
`export_test_helper.py)`

## Test Reuse Classification

Three-way classification. **port-directly = reuse unchanged against the unchanged**
`core/ backend. `**re-author-logic = the behavior is logic/data and testable**
UI-agnostically in the new frontend (port the intent, re-wire to new modules).
**re-author-UI = encodes a UI flow; re-implement as design-agnostic acceptance checks.**

| Current test (source) | Classification | Notes / behaviors covered |
| --- | --- | --- |
| `core/tests/schedule_test_helper.py + test_schedule_ortools_cp_sat.py` | **port-directly** | Data-driven YAML->CSV golden harness; expected-error `.txt substrings; uniqueness assertion. CON-SEM-B1, CON-YAML-B2, DM/PR/DC error cases. The PuLP/CBC/cuOpt counterparts in the historical catalog do not exist in the current source tree and must not be re-authored.` |
| `core/tests/export_test_helper.py + test_export_xlsx_ortools_cp_sat.py` | **port-directly** | YAML->XLSX / prettify.xlsx fully-styled golden harness. CON-YAML-B2, EX-B3. |
| `core/tests/testcases/{basics,artificial}/ fixtures` | **port-directly** | The golden corpus itself; unchanged inputs/goldens. |
| `core/tests/testcases/real/ + tests/real/*` | **port-directly** | Real-world smoke (opt-in, non-`test_-prefixed).` |
| `core/tests/test_models_validation.py` | **port-directly** | DM validation catalog. |
| `core/tests/test_preference_validation.py` | **port-directly** | PR validation catalog. |
| `core/tests/test_export_formatting.py` | **port-directly** | EX rule application + stale-ref/coefficient rejection. |
| `core/tests/test_scheduler.py` | **port-directly** | CON-SEM scheduler semantics. |
| `core/tests/test_utils.py` | **port-directly** | DC parse_dates + parse_sids/pids. |
| `core/tests/test_anonymize_scheduling_data.py` | **port-directly** | CON-YAML-B1 backend anonymization. |
| `core/tests/test_serve.py` | **port-directly** | CON-API / CON-EXE server contract. |
| `core/tests/test_cli.py` | **port-directly** | CON-OUT CLI contract. |
| `core/tests/solver_test_utils.py` | **port-directly** | CON-SEM-B3 operator truth-table helper. |
| `src/hooks/useSchedulingData.test.ts` | **re-author-logic** | ST undo/redo, persistence, cross-tab, YAML load/replace, date-format transitions, Singapore import. |
| `src/hooks/schedulingReferenceUpdates.test.ts` | **re-author-logic** | RI rename/delete cascade (incl. nested groups). |
| `src/hooks/schedulingEntryDuplication.test.ts` | **re-author-logic** | ED-B2 duplicate-with-copied-description. |
| `src/hooks/schedulingDataUpdate.test.ts` | **re-author-logic** | SL full-state replacement (dates/people/shiftTypes). |
| `src/utils/anonymizeSchedulingState.test.ts, sentrySchedulingState.test.ts` | **re-author-logic** | OE-B8 client-side anonymization + reverse mapping. |
| `src/utils/dateParsing.test.ts, calendar.test.ts` | **re-author-logic** | DC date-ID formats, UTC arithmetic, grids. |
| `src/utils/countShiftTypeCoefficients.test.ts` | **re-author-logic** | PR coefficient/overlap rules. |
| `src/utils/numberParsing.test.ts` | **re-author-logic** | PR/DM weight parsing + display/color/validity. |
| `src/utils/yamlGenerator.test.ts` | **re-author-logic** | SL YAML emission (flow style, date replacer). |
| `src/utils/randomizeShiftRequests.test.ts` | **re-author-logic** | SR-B7 randomization invariants. |
| `src/utils/restorePeopleIdsInXlsx.test.ts` | **re-author-logic** | SL-B8 restore people IDs in XLSX header range. |
| `src/utils/singaporeHolidays.test.ts` | **re-author-logic** | DC-B7 holiday windows/classification. |
| `src/utils/version.test.ts` | **re-author-logic** | SL-B7 version compare/fetch semantics. |
| `src/utils/keyboardEvents.test.ts` | **re-author-logic** | IME/composition key detection (feeds SR/undo). |
| `src/utils/unsavedEditingState.test.ts` | **re-author-logic** | ST-B6 tab-switch warning lifecycle. |
| `src/utils/scrolling.test.ts` | **re-author-logic** | scroll save/restore util. |
| `src/components/*.test.tsx (22 suites)` | **re-author-UI** | Widget-level behavior tied to current components (DataTable, InlineEdit, WeightInput, DraggableCardList, ShiftPreferenceEditor, CalendarMonthView, etc.). Port intent to new components. |
| `src/app/**/page.test.tsx (11 suites, ~203 cases)` | **re-author-UI** | Page-level rendering/interaction assertions bound to current routes/DOM. |
| `web-frontend/e2e/*.spec.ts (~90 specs)` | **re-author-UI** | Full user flows; assume current UI selectors/DOM. Re-implement per scenarios below. |
| `web-frontend/e2e/helpers.ts, test.ts` | **re-author-UI (partial reuse)** | `seedSchedulingState, mockOptimizeAndExport, storage-key/worker-namespace conventions and the localStorage schema are reusable `**contracts; Playwright fixture + selectors re-author.** |

## Re-authorable UI Flow Scenarios

The ~90 e2e specs encode user flows against the current UI. Below they are restated as
**design-agnostic acceptance statements grouped by scenario area, so the new suite can**
re-implement them against whatever new UI exists. (No selectors/DOM assumed.)

### Navigation & Shell

- Arrow navigation moves between neighboring tabs and stops at boundaries. (`navigation-arrow-buttons)`
- Global keyboard shortcuts work everywhere but are suppressed while typing in inputs. (`navigation-shortcuts)`
- The UI stays in light mode even when the OS prefers dark. (`light-color-scheme)`
- Floating widgets (build selector, feedback button) never overlap. (`floating-widgets)`

### Dates & Calendar Flows

- Setting a real date range propagates downstream. (`dates-editor-flow, date-range-cascade)`
- Recover from an invalid range, then apply a corrected one. (`dates-invalid-recovery)`
- Edit full-month date-group members via a calendar. (`dates-editor-flow)`
- Generated date items are read-only; group controls remain usable. (`dates-read-only-page)`
- Date-ID format tracks range scope: DD / MM-DD / YYYY-MM-DD; month-spanning uses MM-DD;
cross-year uses full IDs and still supports downstream quick-add; shrinking reverts IDs
and removes stale references (downstream + export). (`dates-month-spanning-id-format,`
`dates-cross-year-downstream, dates-range-shrink-format, date-range-cascade)`
- Date range edits are undo/redoable. (`dates-range-undo-redo)`
- Canceling range edits restores persisted values on reopen. (`dates-cancel-edit-reset)`

### Item / Group Editor Flows (people, shift types, generic)

- Add/edit/delete an entity through the editor. (`people-*, shift-types-*)`
- Duplicate item/group inserts a copy under the source without opening the editor;
duplicating dismisses open drafts first. (`duplicate-actions)`
- Cancel-edit and cancel-add reset to persisted/draft values on reopen.
(`*-edit-cancel-reset, *-group-edit-cancel-reset, people-add-form-cancel-reset)`
- Drag reorder is undo/redoable and persists across navigation. (`people-reorder-undo-redo)`
- Shift-type duplicate-ID validation: recover, cascade corrected names downstream, and
survive a save-load roundtrip. (`shift-types-duplicate-*)`

### Shift Requests Flows

- Click/multi-click apply one/multiple shift types to a cell. (`shift-requests-multi-shift-click, shift-requests-quick-add-click)`
- Drag applies one request across cells as a single undo step (revisiting a cell mid-drag stays one step). (`shift-requests-drag-*)`
- Clear mode (click and drag) clears requests and history cells; respects padded history
columns; stays deterministic after prior multi-type selection; clears multiple selected.
(`shift-requests-clear-*)`
- Clear-data is undo/redoable. (`shift-requests-clear-data-undo-redo)`
- History edit modal updates the saved history summary; grouped shift-type selections are
ignored for history quick-add. (`shift-requests-history-*)`
- Quick-add inputs reset after cancel/reopen. (`shift-requests-quick-add-reset)`

### Card Preference Flows

- Add/edit/delete shift counts, shift affinities, shift-type requirements, shift-type
successions, **shift type coverings through their respective pages.**
(`shift-counts*, shift-affinities*, shift-type-requirements*,`
`shift-type-successions*, `**shift-type-coverings/page.test.tsx)**
- Multiple additions are undo/redoable. (`shift-counts-undo-redo, shift-affinities-undo-redo)`
- Succession pattern reorder is preserved in the saved rule. (`shift-type-successions-drag-reorder)`
- Preference editor persists mixed manual/infinity values through reopen. (`shift-preference-editor)`
- Preference duplicate actions insert copied cards per page and dismiss open drafts. (`duplicate-actions)`
- **Shift type coverings — partial coverage gap: the current**
`shift-type-coverings/page.test.tsx has only three cases (open`
form, single weight label, render existing rules). It does **not**
test empty-selector validation, invalid-weight save blocking, the
save-shape wrap, the nested-tree edit-flatten round-trip, the
selected-date persistence/drop, duplicate, drag-reorder, or delete.
The behaviors the spec asserts (FR-CV-01..22) are **observable from**
**source but not guaranteed by the current page-test suite. A**
parity-suite rebuild must author tests for these specific cases
before treating them as locked. (See `decision-logs/02-shift-type-covering-preference/index.md`
for the wave-3 review note.)

### Reference Integrity Flows

- Rename people/groups/shift-types updates downstream references across pages and in YAML.
(`rename-cascade, shift-type-rename-cascade)`
- Delete cascades remove references, keep people history coherent, and cascade extra
rows/columns. (`rename-delete-cascade, export-layout-entity-cascade)`
- Rename-then-delete removes the renamed reference downstream. (`rename-delete-cascade)`
- Cascades survive save-load and are undo/redoable. (`rename-save-load-roundtrip)`

### State / History Flows

- Undo/redo restores prior state across page actions and multi-step chains. (`undo-redo-*)`
- New-schedule reset returns to default seed, clears custom history/export, is undoable
from downstream, and the created state can be restored from YAML afterward.
(`home-new-schedule, save-load-new-schedule-restore, save-load-reset-restore-downstream)`

### Save / Load & YAML Flows

- Upload replaces state wholesale (sequential, partial/sparse, complex fixtures). (`save-load-sequential-uploads, save-load-partial-state-replacement, save-load-complex-upload-fixture)`
- Same YAML twice is idempotent. (`save-load-identical-upload-idempotence)`
- Upload/edit/copy download roundtrips are consistent. (`save-load-roundtrip, save-load-*-download*, save-load-copy-download)`
- Invalid/malformed YAML recovers cleanly; same-file retry after failure works; download
still reflects original state after an invalid attempt. (`save-load-invalid-*, save-load-malformed-valid-downstream, save-load-same-file-retry)`
- Uploaded replacement is one undoable boundary; undo/redo works across routes and drives
preview/copy/download. (`save-load-replacement-*, save-load-upload-undo-redo-route)`
- Preview reflects state after refresh; upload waits for completion dialogs; YAML edits
apply renamed entities. (`save-load-refresh-after-upload, save-load-upload-completion, save-load-edit-yaml)`
- Version-mismatch warning honors cancel/continue. (`save-load-version-warning)`
- Larger schedules stay responsive. (`save-load-large-state-smoke)`
- People bulk/CSV upload: preserve tail order, descriptions, and history through reorder;
recover from invalid duplicate lists; undo/redoable; downstream shift-type deletion
leaves no stale history IDs. (`people-upload-*, csv-upload)`

### Export Layout Flows

- Formatting rules add/edit/delete/reorder through UI; reorder persists across navigation;
delete and reorder+edit undo/redoable independently. (`export-formatting*)`
- Formatting affects the optimize YAML body. (`export-formatting-optimize-body)`
- Extra-column coefficients persist through save/load + navigation. (`export-extra-column-coefficients)`
- Extra rows/columns cascade through entity deletion; date-format change removes stale refs. (`export-layout-entity-cascade)`
- Editing sparse export YAML replaces old formatting/extra entries. (`save-load-edit-yaml)`
- Export-layout duplicate inserts copies for every list. (`duplicate-actions)`

### Optimize & Export Flows

- Submit current YAML; render success metadata. (`optimize-and-export)`
- Request body reflects live edits / YAML edits / undo-redo / canceled-edit-persisted /
no-op-edit; stays free of stale IDs after delete cascade; reflects emptied history after
shift-type deletion. (`optimize-and-export-*-body, delete-cascade specs)`
- Repeat runs submit again after edits and keep one success summary. (`optimize-and-export-repeat*)`
- Backend errors / invalid upstream / phase SSE render appropriately without stale success.
(`optimize-and-export-error, optimize-and-export-invalid-state, phase SSE spec)`
- Modified prettify/timeout options are sent. (`optimize-and-export-options)`
- Works against a real local HTTP server. (`optimize-and-export-http-server)`
- Anonymize-before-submit toggle controls whether IDs/descriptions are scrubbed. (helper `disableOptimizeAnonymization)`

## Coverage Gaps & Notes

- **No golden testcase exercises a top-level ****`export:`**** block. Verified: **`0 files`
under `core/tests/testcases/ (including real/) contain a top-level export: key.`
Export formatting / extra rows / extra columns are therefore covered **only by**
`test_export_formatting.py (which constructs YAML inline) and by the frontend e2e/unit`
suites — never by the data-driven YAML->CSV/XLSX golden harness. A rebuild that changes
export rendering could pass the golden harness while regressing export layout. Consider
adding golden fixtures with `export: blocks.`
- **XLSX goldens are regenerated, not hand-authored: **`export_test_helper.py writes`
goldens when `WRITE_XLSX_GOLDEN=1. Parity checks are exact on styling (value,`
number_format, font, fill, alignment, border, comment, freeze_panes) — the rebuild must
not alter the backend exporter or every XLSX golden shifts. Keep `core/ unchanged.`
- **`CONTINUE_ON_ERROR = True in `**`schedule_test_helper.py means the harness aggregates`
and reports all failing cases rather than stopping at the first. Preserve this so parity
runs surface the full failing set.
- **Solver-dependent determinism: the uniqueness assertion (re-solve with**
`avoid_solution, equal score = failure) assumes deterministic solver output per fixture.`
The current source tree contains only the OR-Tools CP-SAT solver test entrypoint
(`test_schedule_ortools_cp_sat.py); the prior PuLP/CBC/cuOpt counterparts are no`
longer in the tree. There is no cuOpt XLSX-export golden test (only the OR-Tools
golden) — re-author the test set against the single OR-Tools entrypoint.
- **Infeasible cases (**`*_infeasible.yaml) have .yaml but no .csv/.xlsx golden;`
the schedule harness compares status text and the XLSX harness skips (no table). Keep
this branch.
- **E2E storage contract is load-bearing: specs seed via localStorage key**
`nurse-scheduling-data with shape { state, history:[state], currentHistoryIndex } and`
a worker-namespaced key (`..__worker-N). A rebuild changing the persistence key/shape or`
worker-isolation convention must update `helpers.ts in lockstep, or every seeded spec`
breaks. The `StoredState type in helpers.ts is effectively the frontend persistence`
schema contract.
- **Backend is mocked in most e2e via **`mockOptimizeAndExport (routes /health,`
`/optimize, /optimize/{id}, /optimize/{id}/xlsx, SSE disabled by default); only`
`optimize-and-export-http-server hits a real server. The mock's response shape`
(`jobId, status, score, solverStatus, xlsxReady, links) is a de-facto API`
contract that must match `core/'s real responses (see CON-API-B1).`
- **`api.nursescheduling.org`**** is hard-blocked in the e2e fixture (**`test.ts aborts with`
`blockedbyclient) — tests must never depend on the public backend. Preserve this guard.`
- **Real-world checks are opt-in: **`tests/real/*.py intentionally omit the test_`
prefix so default collection skips them; `testcases/real/ is excluded via`
`EXCLUDED_TESTCASE_DIRS. Keep both exclusions or CI time/nondeterminism regresses.`

## Cross-References

- Domain specs: `nurse-scheduling-functional-spec/{01-data-model-and-entities, 02-dates-and-calendar, 03-item-group-editors, 04-shift-requests-editor, 05-card-preference-editors, 06-reference-integrity, 07-state-history-persistence, 08-save-load-and-yaml, 09-export-layout, 10-optimize-and-export, contracts}/index.md`
- Rebuild brief: `nurse-scheduling-rebuild-brief/index.md`
- Python golden harness: `core/tests/schedule_test_helper.py,`
`core/tests/export_test_helper.py`
- Solver entrypoints: `core/tests/test_schedule_ortools_cp_sat.py,`
`core/tests/test_export_xlsx_ortools_cp_sat.py (single-backend only)`
- Targeted Python tests: `core/tests/test_{serve,cli,preference_validation, models_validation,scheduler,utils,export_formatting,anonymize_scheduling_data}.py,`
`core/tests/solver_test_utils.py`
- Fixture corpus: `core/tests/testcases/{basics,artificial,real}/`
- E2E harness + specs: `web-frontend/e2e/{helpers.ts,test.ts},`
`web-frontend/e2e/*.spec.ts`
- Frontend unit/component/page: `web-frontend/src/{utils,hooks,components,app}/**/*.test.ts(x)`
