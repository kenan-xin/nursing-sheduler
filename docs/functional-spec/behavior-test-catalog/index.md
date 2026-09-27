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

**Fidelity target (re-baselined — see [decision log 06](../decision-logs/06-rebaseline-to-shipped-backend/index.md)).**
The **binding** parity gate is behavior backed by the shipped backend: data
shapes, validations, exact **backend** strings, and solver/exporter output
(the `core/` tests port directly). Behavior that is purely current-frontend
**presentation** — light-mode enforcement, floating-widget layout, cross-tab
banners, keyboard mappings, tab structure/labels — is `[incidental]`: kept as
reference, NOT a required gate; a rebuild may use any equivalent UI. Rows below
tagged out-of-scope/`[incidental]` (e.g. `ST-B4`, and the Navigation & Shell UI
flows) are explicitly non-binding. (See open ticket t05 — catalog scope leakage.)

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
`test_utils.py, test_export_formatting.py,`
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
**`ortools/cp-sat and is not user-selectable (see C2/C4).``
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
handlers / dispatch entry live in `core/nurse_scheduling/models.py:321-345,`
`core/nurse_scheduling/preference_types.py:622-732, and`
`core/nurse_scheduling/preference_types.py:742. The frontend page is`
`web-frontend/src/app/shift-type-coverings/page.tsx.`

- **CC-B1 A covering rule has three required selectors (**`preceptors,`
`preceptees, shiftTypes) plus an optional date and an optional`
`weight (default 1; ±∞ accepted by the parser). `**Important**
**current-parity caveat: **`date is documented in the source code`
comment as `None = ALL` (models.py:319), and the handler **now implements**
**that** ([DL08](../decision-logs/08-covering-omitted-date-all-dates/index.md)):
an **omitted/`None` `date` = all dates** (`ds = range(ctx.n_days)` when
`preference.date is None`, matching the requirement/successions handlers,
preference_types.py:672-680). An explicit **`date: []` = no dates** (a no-op,
`parse_dates([]) == []`); `[ALL]` or concrete ids target those dates. The
frontend editor also never persists `date on Save/Update`
(`page.tsx:155-162). The frontend stores the three required`
selectors as `(string | string[])[] (nested allowed) and the form`
flattens selections into a single-level array on emit
(`types/scheduling.ts:229-237, models.py:321-345).`
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
- **CC-B7** The Pydantic model rejects `preceptors` / `preceptees` / `shiftTypes` that are not lists at the YAML/model level with Pydantic's standard list-type error (`Input should be a valid list`). The `shift_type_covering` handler (preference_types.py, def at :662) enforces two further, SEPARATE checks with DISTINCT message sets:
  1. Non-list input (isinstance guard, BEFORE flattening, preference_types.py:676-681) — reachable only when constructing a `ShiftTypeCoveringPreference` programmatically (not from YAML) with a non-list value:
    - `Preceptors must be a list, but got {type}` (677)
    - `Preceptees must be a list, but got {type}` (679)
    - `Shift types must be a list, but got {type}` (681)
  2. Empty RESOLVED selectors (after `_flatten_persons` / `_flatten_shifts`, preference_types.py:710-715) — fires when a selector resolves to zero valid ids/groups:
    - `Preceptors list must contain at least one valid person or group.` (711)
    - `Preceptees list must contain at least one valid person or group.` (713)
    - `Shift types list must contain at least one valid shift type.` (715)
These backend strings are the binding parity layer. They are NOT the same as CC-B2's FRONTEND form-validation strings (`At least one preceptor must be selected`, etc., page.tsx:135-145), which are a third, separate set. A parity test asserting the exact backend messages against a YAML upload with `preceptors: P1` (scalar) will fail at the Pydantic layer with `Input should be a valid list`; a parity test for the empty-selector path must assert the :711/713/715 strings, not the "must be a list" strings.
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
DL09 exception: an open Shift Count draft intercepts Ctrl/Cmd-Z/Y for local Refresh
history or consumes it; global history resumes only after Update/Cancel (CH-B21).
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

<user_quoted_section>Scope note (decision log 07):the OE rows below are all about job submission / results / errors / options /anonymize and remain binding. Server-management (multi-candidate list,add/edit/remove/reorder/reset, auto-selection) is out of scope — the backendURL is a single env var (NEXT_PUBLIC_BACKEND_API_URL); only a read-onlyonline/offline + version status remains. No parity behavior here covers servermanagement, and none should be added.</user_quoted_section>

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
(`anonymizeSchedulingState.test.ts, helper disableOptimizeAnonymization).`
**In scope:** the client-side anonymize transform + reverse mapping.

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
immediately. The solver is fixed at `ortools/cp-sat (the only backend with`
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
- **CON-YAML-B2 The golden harness proves YAML -> CSV (data) and**
**YAML -> XLSX / prettify.xlsx (fully-styled: value, number_format, font, fill,**
alignment, border, comment, freeze_panes) parity for every fixture, and preserves
expected-error `.txt substring behavior. (schedule_test_helper.py,`
`export_test_helper.py)`

### CH — Contracted Hours & First-Class Leave (new; Option C)

<user_quoted_section>New behavior area for the contracted-hours / first-class-leave feature(spec 12). These map toAC-CH-01..11 and the C1 §7 / C3 CON-SEM-08 / C5 CON-OUT-50..54 contracts.Coverage status: these are new and largely UN-covered by the current testsuite (no existing test references a leave day-state — see decision log 05 /the blast-radius audit). Treat every CH-B entry as re-author (new test towrite) unless it maps to a listed core fixture. The prototypethree_state_spike.py / verify_hours.py are the reference oracles.</user_quoted_section>

**[Correction — coverage status is stale].** The quoted claim ("no existing
test references a leave day-state") predates the shipped LEAVE work. The backend
now ships **`core/tests/test_leave_daystate.py`**, which directly exercises INV1/
INV2/INV3, leave rendering, leave hour credit, reserved-id rejection, requirement/
covering rejection, and ALL-excludes-LEAVE — plus frontend unit tests
`web-frontend/src/utils/keywords.test.ts` and `.../countShiftTypeCoefficients.test.ts`
cover `LEAVE_CREDIT_MINUTES` and duration auto-fill. Port `test_leave_daystate.py`
**directly** with the rest of `core/tests` (port-directly) — it is the strongest
existing parity guard for the shipped [parity] rows below — rather than treating
CH as prototype-oracle-only new work.

**Parity vs. aspirational (decision log 06).** Each CH-B row is tagged
**[parity]** — behavior the shipped backend/frontend already implements, so the
test MUST pass against today's code — or **[aspirational]** — behavior from the
spec-12 vision that is **not** shipped (the test cannot pass today and MUST NOT
be written into the parity gate; it is parked until the feature is built). A
mixed row splits its clauses explicitly. Do not let an aspirational test masquerade
as parity: writing it green would pressure the rebuild to build unbuilt features.
The compound tag **[parity; re-author]** (see CH-B14/15) is orthogonal on the reuse
axis: the behavior is **binding parity** (the rebuild MUST provide the capability),
but because it is frontend and UI-free (decision log 06), its test cannot be ported
from `core/` and must be **re-authored** against the new UI — the capability is
gated, the specific interaction is not.

- **CH-B1 [parity] — Three-state exclusivity. For every solved (person, date) exactly**
one of worked / `LEAVE / OFF holds (off + Σworked + Σleave == 1).`
Maps AC-CH-01, C3 CON-SEM-08. Oracle: `three_state_spike.py.`
- **CH-B2 [parity] — No solver-invented leave (INV1). In any solution a person is on**
leave only where a leave request pinned it; the solver never adds leave.
Maps AC-CH-02.
- **CH-B3 [parity] — Leave excluded from coverage (INV2). A **`shift type requirement`
is satisfied only by worked-shift nurses; a leave/off nurse never counts;
`LEAVE/OFF in a coverage selector is rejected with a validation error.`
Maps AC-CH-03, C3 CON-SEM-08, C1 §7.3/CON-YAML-23.
- **CH-B4 [parity] — Intended leave honored (INV3). Every pinned leave day appears as**
leave; never replaced by a worked shift or `OFF; weight on a LEAVE request`
has no effect. Maps AC-CH-04, spec 04 FR-SR-47, C3 CON-SEM-08.
- **CH-B5 [parity] — Hours total via coefficient. Each nurse's**
(worked-shift + leave) coefficient-weighted sum equals the target. The solve
reads **only** the per-type `countShiftTypeCoefficients` — never
`durationMinutes` directly; the test must set worked-shift coefficients (and the
`LEAVE` coefficient, 8h default) explicitly. `OFF` adds 0; the shift-count
formula is unchanged. Maps AC-CH-05, spec 12 FR-CH-13/20/33a, C3 CON-SEM-05/08.
Oracle: `verify_hours.py` (recomputes hours independently).
- **CH-B6 [parity] — Weekly-rest floor. ≥N **`OFF per person per week. Maps AC-CH-06.`
- **CH-B7 [parity] — `durationMinutes` optional & inert. A shift type without it**
behaves as today; with it, solves and exports are byte-identical (duration
never reaches the solver, never rendered). Maps AC-CH-07, spec 12 FR-CH-31.
- **CH-B8 [product; re-author] — Fixed-grid derivation.** Contracted Hours accepts only
grid-valid working time, derives `durationMinutes / 30` exactly, derives default LEAVE
as `16`, and never rounds. No marked unit selector exists. Off-grid UI/import values
and minute/hour marked units fail clearly. Generic unmarked count behavior remains
unchanged. Maps AC-CH-07..09, spec 12 FR-CH-30..33, DL09 D1/D2/D7.
- **~~CH-B9 — Migration (pre-Pydantic, marker + `LV` fallback)~~ REMOVED.**
There is no legacy `LV` data to migrate — the rebuild uses the `LEAVE`
keyword directly, so no migration test is required. The corresponding
requirement (spec 12 FR-CH-43, AC-CH-10a..10e) is struck and the decision
log 05 migration section is superseded/historical; see decision log 06.
- **CH-B10 [parity] — History may be `LEAVE`. Maps AC-CH-11, C1 §7.3/CON-YAML-23.**
- **CH-B11 [parity] — Base roster renders leave distinctly. A leave cell exports as**
"Leave", not blank/`OFF; off-cell sanity invariant holds for three states;`
extra col/row + cell-formatting count `LEAVE. Maps spec 12 FR-CH-45,`
C5 CON-OUT-50..54.
- **CH-B12 [parity] — Reference integrity for `LEAVE`. Rename/delete of unrelated**
entities never rewrites or drops `LEAVE on any surface (requests, count`
selectors/coefficients, export, history); `durationMinutes travels with its`
shift-type item. Maps spec 06 FR-RI-40..42.
- **CH-B13 [product; re-author] — Strict metadata + solver inertness.** The marker
accepts exactly `{unit:"half-hour", policy:"exact"|"range"}` with a matching hard
payload. Unknown keys, unit drift, and policy/payload mismatch fail. A solve with vs
without the metadata remains semantically identical
when the raw solver fields are the same. Maps AC-CH-20/22, C1 CON-YAML-25, C3
CON-SEM-05. Backend and frontend round-trip tests are both required.
- **CH-B14 [parity; re-author] — Uncredited-leave guard (frontend, non-blocking).** A count
**marked** as an hours contract that does not credit concrete `LEAVE` while covering a leave-pinned nurse (expanded
people/dates overlap; a request shift-type group containing `LEAVE` counts as a pin)
surfaces a non-blocking warning naming her + a remediation path; **no** warning when
unmarked, `LEAVE` credited directly, selectors don't overlap, or a
selector is **unresolved** (suppress); the solve is never blocked. Maps AC-CH-21,
spec 12 FR-CH-26/26a. `[re-author]` — capability, UI-free (decision log 06); the
detector logic is oracled by `leaveCreditWarning.test.ts` (frontend).
- **CH-B15 [product; re-author] — Dynamic selectors + explicit coverage and Refresh.**
Guided group/`ALL` selectors persist unchanged and expand with existing backend
semantics. Exact explicit coefficient coverage is required for the current concrete
expansion. Membership/new-shift changes do not silently rewrite selectors,
coefficients, or targets, but can invalidate coverage. Refresh over the current draft
previews added/removed/changed/unchanged rows; Confirm replaces local draft state with
one local undo and Cancel Preview changes nothing. Cancel Edit preserves stored bytes;
Update is one global history step. Nested item/group rename/delete cascades remain active
without reordering group definitions. An explicit coefficient
without duration remains valid; missing coverage blocks external boundaries. Maps
AC-CH-09b/22 and
DL09 D3/D5/D6.
- **CH-B21 [product; re-author] — Editor shortcuts protect local drafts.** While either
Shift Count editor is open, Ctrl/Cmd-Z/Y routes to local Refresh undo/redo when available
and otherwise is consumed. Global history resumes after Cancel/Update; Update followed by
global Undo restores the prior stored rule. Maps AC-CH-09c and WT6.
- **CH-B22 [product; re-author] — Date shrink has two outcomes.** Partial removal keeps
the surviving rule's target(s) byte-exact. Removing every required `countDates` deletes
the preference per FR-RI-11; one Undo restores it. Neither path rescales. Maps AC-RI-20
and WT5.
- **CH-B23 [product; re-author] — Working-time conversions are explicit and canonical.**
Bare→clock requires user-entered start/end and confirms atomically; clock→bare retains
paid duration; Clear removes all four fields; Cancel preserves the former shape. Explicit
zero rest is accepted on input but serialized as omission. Maps DL09 D7 and WT3/WT4.
- **CH-B16 [product; re-author] — Separate generic/guided entry paths share one**
**encoding.** Add Shift Count opens and saves an unmarked generic rule. Add Contracted
Hours opens hard Exact/Allowed Range and saves `type: shift count` plus fixed-half-hour
metadata. Reopen dispatches by marker; both remain in one list. No checkbox, unit
selector, strength slider, or marked Custom state appears. Solver details can override
coefficients/target; marked expression/weight remain locked. Conversion is explicit,
previewed, atomic, cancellable, and undoable; there is no migration path. Maps AC-CH-23, AC-PR-12a, spec 12
FR-CH-25a–25c, spec 05 FR-PR-56/57, DL09 D3–D6.
- **CH-B19 [product; re-author] — One validator, every external boundary.** The same
marked-rule validator gates editor commit, imported state replacement, plain/copy/
anonymized YAML downloads, normal and anonymized Optimize, and direct serializer
callers. Invalid local drafts remain recoverable; existing-XLSX re-download and generic scalar/
array counts are unaffected. Maps FR-CH-34 and WT7.
- **CH-B20 [product; re-author] — Clean replacement has negative evidence.** Old
hour/minute marked documents fail without silent unmarking; no unit picker/conversion,
compatibility loader, localStorage upgrade, or legacy fixture remains. Bare
grid-valid `durationMinutes` remains accepted as a target working-time shape. Maps
FR-CH-43, DL09, WT1/WT3.
- **CH-B17 [product; re-author] — Hard policy encoding.** Exact serializes
`x = T`/scalar target/`+∞`; Range serializes the two inclusive comparisons, ordered
target pair, and `+∞`. End-to-end scheduling keeps every person inside the hard
contract or reports infeasible; no finite objective term is added.
- **CH-B18 [product; re-author] — Conversion and cancellation lifecycle.** Generic →
guided preserves coefficients and previews hard-field replacements; guided →
generic removes only metadata. Confirm is one undo step; Cancel preserves bytes and list
position. Imported invalid marked shapes fail without partial state replacement.

## Test Reuse Classification

Three-way classification. **port-directly = reuse unchanged where the target backend**
**contract is unchanged.** DL09's marker/grid/report-name changes require updating their
owned tests/fixtures rather than blindly porting old inputs. **re-author-logic = the behavior is logic/data and testable**
UI-agnostically in the new frontend (port the intent, re-wire to new modules).
**re-author-UI = encodes a UI flow; re-implement as design-agnostic acceptance checks.**

| Current test (source) | Classification | Notes / behaviors covered |
| --- | --- | --- |
| `core/tests/schedule_test_helper.py + test_schedule_ortools_cp_sat.py` | **port-directly** | Data-driven YAML->CSV golden harness; expected-error `.txt substrings; uniqueness assertion. CON-SEM-B1, CON-YAML-B2, DM/PR/DC error cases. The PuLP/CBC/cuOpt counterparts in the historical catalog do not exist in the current source tree and must not be re-authored.` |
| `core/tests/export_test_helper.py + test_export_xlsx_ortools_cp_sat.py` | **port-directly** | YAML->XLSX / prettify.xlsx fully-styled golden harness. CON-YAML-B2, EX-B3. |
| `core/tests/testcases/{basics,artificial}/ fixtures` | **port/update selectively** | Preserve unrelated goldens; directly update any Contracted Hours/working-time fixture that violates the clean fixed-half-hour/grid schema. No runtime migration fixture is required. |
| `core/tests/testcases/real/ + tests/real/*` | **port-directly** | Real-world smoke (opt-in, non-`test_-prefixed).` |
| `core/tests/test_models_validation.py` | **port-directly** | DM validation catalog. |
| `core/tests/test_preference_validation.py` | **port-directly** | PR validation catalog. |
| `core/tests/test_export_formatting.py` | **port-directly** | EX rule application + stale-ref/coefficient rejection. |
| `core/tests/test_scheduler.py` | **port-directly** | CON-SEM scheduler semantics. |
| `core/tests/test_utils.py` | **port-directly** | DC parse_dates + parse_sids/pids. |
| `core/tests/test_serve.py` | **port-directly** | CON-API / CON-EXE server contract. |
| `core/tests/test_cli.py` | **port-directly** | CON-OUT CLI contract. |
| `core/tests/solver_test_utils.py` | **port-directly** | CON-SEM-B3 operator truth-table helper. |
| `core/tests/test_leave_daystate.py` | **port-directly** | CH parity guard against the unchanged core backend: three-state exclusivity (INV1/INV2/INV3 — off + Σworked + Σleave == 1, no solver-invented leave, intended leave honored), leave hour credit via coefficient, reserved LEAVE_sid rejection as a user shift type, LEAVE/OFF forbidden in shift-type requirement + covering, and ALL-succession excludes LEAVE. Backs CH-B1..B5, CH-B10. See the CH-intro correction ("Port test_leave_daystate.py directly with the rest of core/tests"). |
| `core/tests/test_shift_type_covering_preference.py` | **port-directly** | CC model construction/validation against core: basic construction, description support, nested preceptor lists, +inf weight acceptance, non-infinity float rejection, and extra="forbid" enforcement. Named in CC-B9 as a required-task test reference. |
| `src/hooks/useSchedulingData.test.ts` | **re-author-logic** | ST undo/redo, persistence, YAML load/replace, date-format transitions, Singapore import. (The cross-tab storage-banner portion maps to ST-B4, which is out of product scope — do not carry it into the parity gate.) |
| `src/hooks/schedulingReferenceUpdates.test.ts` | **re-author-logic** | RI rename/delete cascade (incl. nested groups). |
| `src/hooks/schedulingEntryDuplication.test.ts` | **re-author-logic** | ED-B2 duplicate-with-copied-description. |
| `src/hooks/schedulingDataUpdate.test.ts` | **re-author-logic** | SL full-state replacement (dates/people/shiftTypes). |
| `src/utils/anonymizeSchedulingState.test.ts` | **re-author-logic** | OE-B8 client-side anonymization + reverse mapping (the anonymize transform, FR-SL-39). |
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

These are current-frontend **presentation** flows, tagged `[incidental]` — kept
as reference, not a binding parity gate (decision log 06); a rebuild may realize
navigation however its design lands.

- `[incidental]` Arrow navigation moves between neighboring tabs and stops at boundaries. (`navigation-arrow-buttons)`
- `[incidental]` Global keyboard shortcuts work everywhere but are suppressed while typing in inputs. (`navigation-shortcuts)`
- `[incidental]` The UI stays in light mode even when the OS prefers dark. (`light-color-scheme)`

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

- **No golden testcase exercises a top-level **`export: block. Verified: **`**`0 files`
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
- **`api.nursescheduling.org** is hard-blocked in the e2e fixture (**`**`test.ts aborts with`
`blockedbyclient) — tests must never depend on the public backend. Preserve this guard.`
(Per [DL07](../decision-logs/07-backend-url-via-env/index.md) the production URL is
no longer a built-in candidate; the tests now point at a `NEXT_PUBLIC_BACKEND_API_URL`
backend, but keep the public-backend block as a safety net.)
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
- Targeted Python tests: `core/tests/test_{serve,cli,preference_validation, models_validation,scheduler,utils,export_formatting}.py,`
`core/tests/solver_test_utils.py`
- Fixture corpus: `core/tests/testcases/{basics,artificial,real}/`
- E2E harness + specs: `web-frontend/e2e/{helpers.ts,test.ts},`
`web-frontend/e2e/*.spec.ts`
- Frontend unit/component/page: `web-frontend/src/{utils,hooks,components,app}/**/*.test.ts(x)`
