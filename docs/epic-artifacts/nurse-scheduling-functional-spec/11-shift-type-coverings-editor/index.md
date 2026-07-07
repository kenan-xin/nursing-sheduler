---
kind: spec
title: "Shift Type Coverings Editor"
prefix: CV
status: 1
---

# Shift Type Coverings Editor

## Purpose & Scope

This artifact specifies the **`shift type covering`** preference editor — the
fifth card-list preference editor, mounted at `/shift-type-coverings` (tab label
`8b. Shift Type Coverings`, array index 9 — see spec 07). It defines a
hard-reified staffing rule: whenever any person in `preceptees` works one of
the chosen `shiftTypes` on one of the chosen `date` entries, at least one
person in `preceptors` must also work that shift type. The page is the
authoring surface for the `shift type covering` preference (CON-SEM-07); it
inherits the shared card-shell, drag-reorder, and undo behavior from the
other card editors (spec 05).

The artifact is **UI-agnostic**: it specifies data, behavior, exact strings,
and the reference-tree save shape. Backend semantics (the hard-OR reification
and the cross-product expansion) are owned by the **C3 — Preference /
Constraint Semantics (CON-SEM-07)** contract and are referenced, not
redefined, here. The reference-cascade behavior (rename/delete rewriting the
nested reference trees) is owned by spec 06.

Source files:
- `web-frontend/src/app/shift-type-coverings/page.tsx` (557 lines).
- `web-frontend/src/app/shift-type-coverings/page.test.tsx`.
- `web-frontend/src/hooks/schedulingReferenceUpdates.ts` (cascade handlers,
  extended for `SHIFT_TYPE_COVERING` per CC-B4 / spec 06).
- `web-frontend/src/hooks/schedulingPreferenceOrdering.ts`
  (`sortPreferencesByType` + `normalizePreferenceOrder` extended for
  `SHIFT_TYPE_COVERING` per CC-B5 / spec 01 FR-DM-20/21).
- `web-frontend/src/types/scheduling.ts:157, 229-237, 247`
  (`SHIFT_TYPE_COVERING` constant, `ShiftTypeCoveringPreference` interface,
  added to the `Preference` union).
- `web-frontend/src/components/Navigation.tsx:37` (the new tab).
- `web-frontend/src/utils/anonymizeSchedulingState.ts:25, 76-83`
  (anonymization of `preceptors`/`preceptees`/`shiftTypes` via
  `mapReferenceIdTree`).

Out of scope: the shared card shell, weight input, `DraggableCardList`,
`CheckboxList`, `NumberInput`, and `ToggleButton` components (referenced
where their behavior is observable from this editor; specified in spec 05),
and the persistence / undo-redo layer (`useSchedulingData` — see spec 07).

---

## Functional Requirements

### Page shell

- **FR-CV-01 — Route, title, and tab placement.** The page is mounted at
  `/shift-type-coverings`. Navigation exposes it as the tab labelled
  `8b. Shift Type Coverings` at array index 9 (`Navigation.tsx:37`); see
  spec 07 for the navigation and keyboard-shortcut changes this introduces.
  The page title is `Shift Type Coverings` (`page.tsx:250`).

- **FR-CV-02 — Instructions panel.** A `FiHelpCircle` help button beside the
  title toggles an instructions panel (`title="Toggle instructions"`,
  `page.tsx:255-258`). The 7-bullet instructions array is shown verbatim
  in FR-PR-90 (spec 05).

- **FR-CV-03 — Add / Cancel toggle.** A `ToggleButton` (`Add Shift Type
  Covering`) starts a fresh add draft (form opens, `editingIndex=null`,
  fields reset to defaults) or cancels an open draft. The form panel is
  mounted only while `isFormVisible` is true. (page.tsx:262-273,
  `:286-495`)

### Data model — form & saved preference

- **FR-CV-04 — Saved preference shape.** The `shift type covering`
  preference is typed as `ShiftTypeCoveringPreference`
  (`scheduling.ts:229-237`):
  ```ts
  {
    type: 'shift type covering',
    description?: string,
    date?: string[],                          // optional; omitted when empty
    preceptors: (string | string[])[],        // nested reference tree
    preceptees: (string | string[])[],        // nested reference tree
    shiftTypes: (string | string[])[],        // nested reference tree
    weight: number,
  }
  ```
  The nested `(string | string[])[]` form follows the existing
  shift-affinity convention: a top-level element is one equation; an inner
  array is the OR-alternative group of ids. The schema permits both flat
  and nested forms at this level (`ReferenceIdTree`), but **the current
  editor and its helpers are only one level deep**: `flattenIds`
  (`page.tsx:543-553`) does not recurse, and `buildPrefFromForm` writes
  exactly one outer element wrapping the flat `CheckboxList` selections.
  The backend `ShiftTypeCoveringPreference` type is also only one nested
  level deep (`models.py:319-323`). Deeper-than-one-level imported
  shapes (e.g. `preceptors: [[['P1', 'P2']]]`) are **not editor-safe**:
  edit-load via `flattenIds` would only see the top level, and saving
  would replace the deeper tree with the editor's one-element wrap. The
  cascade helpers (`schedulingReferenceUpdates.ts:20,163-193,298-325`)
  are recursive and would correctly rename/delete inside deeper trees,
  but the page UI would silently rewrite them. Treat deeper imported
  shapes as out of UI parity — the cascade keeps them semantically
  correct, but the editor does not preserve them.

- **FR-CV-05 — Form state shape (transient).** While the form is open,
  `formData` (`page.tsx:37-44, 65-72`) holds the in-progress rule in flat
  form:
  ```ts
  {
    description: string,
    date: string[],
    preceptors: string[],      // flat CheckboxList state
    preceptees: string[],      // flat CheckboxList state
    shift_types: string[],     // flat CheckboxList state (snake_case on the form)
    weight: number | string,
  }
  ```
  Note the form uses `shift_types` (snake_case) as the local field name
  while the saved preference uses `shiftTypes` (camelCase); the error-key
  translation in `handleArrayFieldToggle` (`page.tsx:236-237`) maps the
  snake_case form field to the camelCase error key.

- **FR-CV-06 — Form defaults.** `DEFAULT_WEIGHT = 1` (`page.tsx:46`);
  all other fields default to `''` / `[]`. (`page.tsx:65-72`)

### Save / load / cancel

- **FR-CV-07 — `buildPrefFromForm` wraps each flat field in a single-element
  outer array and never persists `date` (CURRENT PRODUCT BUG).** This is
  the canonical save shape — the editor always writes exactly one
  equation per rule:
  ```ts
  {
    type: SHIFT_TYPE_COVERING,
    description: formData.description,
    preceptors: [formData.preceptors],
    preceptees: [formData.preceptees],
    shiftTypes: [formData.shift_types],
    weight: formData.weight as number,
  }
  ```
  `date` is **never** included in the saved object — not when the user
  has not picked any dates, and not when they have. The form tracks
  `formData.date` (`page.tsx:65-72`) and the user can pick dates in the
  UI (`page.tsx:312-348`), but `buildPrefFromForm` does not copy the
  field into the persisted object (`page.tsx:155-162`). The card
  display (FR-CV-19) only renders the `Dates:` row when the underlying
  data already has `rule.date`, so cards saved by this editor never
  show a `Dates:` row.
  This is a **current product bug**: a user selecting Dates in the
  covering editor loses that selection on Add/Update. The cascade for
  the optional `date` field is still implemented and unit-tested against
  hand-built state (`schedulingReferenceUpdates.test.ts`), so any
  hand-authored or imported covering preferences with a `date` field
  will rename/delete correctly. Tracked as a follow-up fix; see
  `decision-logs/02-shift-type-covering-preference/index.md`.

- **FR-CV-08 — `handleStartEdit` flattens nested trees back to flat form
  state.** When loading an existing rule for editing, the nested
  `preceptors`/`preceptees`/`shiftTypes` are flattened via
  `flattenIds` (`page.tsx:543-553`):
  ```ts
  preceptors: flattenIds(rule.preceptors),
  preceptees: flattenIds(rule.preceptees),
  shift_types: flattenIds(rule.shiftTypes),
  ```
  and `date: rule.date ?? []`. (`page.tsx:104-115`)

- **FR-CV-09 — Save appends or replaces.** When `editingIndex === null` the
  rule is appended (`[...shiftTypeCoverings, newPref]`); otherwise the
  rule at `editingIndex` is replaced (`newPrefs[editingIndex] = newPref`).
  Either path goes through `updatePreferencesByType(SHIFT_TYPE_COVERING,
  …)`, which normalizes (sorts `date`, preserves nested reference trees)
  and persists one history entry. (`page.tsx:164-185`)

- **FR-CV-10 — Cancel hides the form, resets state, restores scroll.** A
  Cancel call hides the form, clears all form fields and errors, and —
  if we were editing — restores the saved scroll position via
  `restoreScrollPosition()` (`page.tsx:122-130, 86-97`).

### Form fields and validation

- **FR-CV-11 — Description field (optional).** Free-text input
  `Description (optional)` with placeholder
  `e.g., Lil must always be paired with Anna on Day shift`. Stored as-is
  (may be empty). (`page.tsx:296-308`)

- **FR-CV-12 — Dates (optional, exposed in the UI but not persisted; the
  label "leave empty for all dates" is misleading under current parity).**
  `Dates (leave empty for all dates)` is a multi-select `CheckboxList`
  of date items + groups. The error key is `date`. No `errors.date` is
  ever set in the current implementation; an empty date set is
  allowed. The list falls back to a guidance message when no dates are
  set up: `No dates available. Please set up dates in the Dates tab first.`
  (linking to `/dates`). (`page.tsx:312-348`)
  **Strict-parity caveat (current product bug)**: the user's
  selection is **not** saved on Add/Update under current code
  (see FR-CV-07). The selection is tracked only while the current
  form draft remains open; Add/Update drops it, and `resetForm`
  clears it; a later edit only restores `rule.date` if the existing
  stored/imported rule already has one. The future-fix path
  (`buildPrefFromForm` adding `date` when non-empty) is described in
  decision log 02 as a separate non-parity follow-up — **do not
  implement it under strict parity**, since the spec is documenting
  current code.
  **Important caveat (backend semantics)**: even when `date` is
  present, the **current backend** treats `date: []` (or absent) as
  **no dates / no constraints** rather than "all dates" — see
  CON-SEM-07 `date` semantics. To target "all dates" the YAML must
  emit `date: [ALL]` explicitly.

- **FR-CV-13 — Preceptors (required, multi-select).** `Preceptors (must
  cover) *` is a multi-select `CheckboxList` of people items + groups.
  Empty → `At least one preceptor must be selected`. The list falls back
  to `No people available. Please set up people in the People tab first.`
  when no people are set up (linking to `/people`).
  (`page.tsx:351-386`)

- **FR-CV-14 — Preceptees (required, multi-select).** `Preceptees (must be
  covered) *` is a multi-select `CheckboxList` of people items + groups.
  Empty → `At least one preceptee must be selected`. Same fallback as
  preceptors when no people are set up. (`page.tsx:388-423`)

- **FR-CV-15 — Shift types (required, multi-select).** `Shift Types *` is
  a multi-select `CheckboxList` of shift-type items + groups (no
  exclusion of `OFF` here). Empty → `At least one shift type must be
  selected`. The list falls back to
  `No shift types available. Please set up shift types in the Shift Types tab first.`
  when no shift types are set up (linking to `/shift-types`).
  (`page.tsx:426-462`)

- **FR-CV-16 — Weight (required, valid).** Weight is rendered via the
  shared `WeightInput` with placeholder `e.g., 1, 10, ∞`. The
  validity check is `isValidWeightValue`: a value is valid iff it is a
  finite `number` OR exactly `Infinity`/`-Infinity`. Invalid →
  `Weight must be a valid number, Infinity, or -Infinity`. **Unlike**
  the Requirements / Counts editors, the covering editor does **not**
  enforce a sign or non-positive constraint — any valid weight is
  accepted. The default is `1`. (`page.tsx:147-149, 464-473`)

- **FR-CV-17 — Per-field error clear on edit.** `handleArrayFieldToggle`
  clears the corresponding error key on each toggle
  (`page.tsx:236-244`); `WeightInput`'s `onChange` clears the `weight`
  error.

### Card list and operations

- **FR-CV-18 — `DraggableCardList` shell with title
  `Current Shift Type Coverings`.** Existing rules render as cards in
  the same `DraggableCardList` used by the other four card editors.
  (`page.tsx:499-537`)

- **FR-CV-19 — Card content.** Each card shows:
  - optional description as an `<h4>` heading (when `rule.description` is
    non-empty);
  - `Preceptors:` followed by `summarizeIds(rule.preceptors)`
    (comma-joined ids, flattened from the nested tree);
  - `Preceptees:` followed by `summarizeIds(rule.preceptees)`;
  - `Shift Types:` followed by `summarizeIds(rule.shiftTypes)`;
  - `Dates:` followed by `rule.date.join(', ')` (only when
    `rule.date && rule.date.length > 0`);
  - `Weight:` followed by `getWeightWithPositivePrefix(rule.weight)`.

  `summarizeIds(ids)` flattens the nested reference tree to a single
  comma-joined string; an empty flattened list renders the literal
  string `(all)`. (`page.tsx:507-535, 555-557`)

- **FR-CV-20 — Empty-state message.** When the list is empty:
  `No covering rules yet. Click "Add Shift Type Covering" to get
  started.` (DraggableCardList's `emptyMessage` prop,
  `page.tsx:502`)

- **FR-CV-21 — Card operations: Edit, Duplicate, Delete, drag-reorder.**
  Reuses the same `DraggableCardList` action contract as the other four
  card editors:
  - **Edit** loads the rule via `handleStartEdit` (FR-CV-08); saves
    scroll before scrolling to top.
  - **Delete** removes the card immediately with **no confirmation
    dialog** (`handleDelete` filters by index, `page.tsx:220-224`).
  - **Duplicate** calls `duplicatePreferenceByType<ShiftTypeCoveringPreference>(SHIFT_TYPE_COVERING,
    index)` — deep-clones with `copy`/`copy N` label (see spec 05
    FR-PR-13). (`page.tsx:226-229`)
  - **Reorder** calls `updatePreferencesByType` with the new ordered
    list (`handleReorder`, `page.tsx:231-234`).
  Each of these first calls `dismissEditingDraft()` (cancels an open
  add/edit form before the operation runs, losing the unsaved draft).
  (`page.tsx:214-218`)

### Keyboard and dirty-state

- **FR-CV-22 — Enter=save, Escape=cancel under IME guard.** While the
  form is visible, a global `keydown` listener (window-scoped, attached
  with `addEventListener` and cleaned up via the effect's return,
  `page.tsx:192-212`) handles:
  - `Enter` (no Shift/Alt/Ctrl/Meta, not during IME composition per
    `isImeCompositionKeyEvent`): validates, then saves.
  - `Escape`: cancels.
  Both call `preventDefault`.

- **FR-CV-23 — Unsaved-edit tab-switch guard.** `useTabSwitchWarning(isFormVisible)`
  arms the navigation `confirm()` while the form is open (so navigating
  away asks `You have unsaved edits. Leave this page without saving?`).
  (`page.tsx:74`; spec 07 FR-ST-31.)

- **FR-CV-24 — Scroll save/restore on edit.** `handleStartEdit` calls
  `saveScrollPosition()` then `window.scrollTo({ top: 0, behavior:
  'instant' })`. Cancel and save both call `restoreScrollPosition()`
  when editing. Add does not save/restore scroll.
  (`page.tsx:117-119, 127-129, 183-184`)

---

## Validation Rules & Messages

All messages are **verbatim** and produced by `validateForm`
(`page.tsx:132-153`); Save blocks persistence if any errors are set.
Fields marked `*` are required.

| Field | Condition | Message |
|---|---|---|
| preceptors | selection empty | `At least one preceptor must be selected` |
| preceptees | selection empty | `At least one preceptee must be selected` |
| shift_types (error key `shiftTypes`) | selection empty | `At least one shift type must be selected` |
| weight | invalid (string / NaN) | `Weight must be a valid number, Infinity, or -Infinity` |
| date | selection empty | (no error — date is optional) |

A non-empty weight that is `+Infinity`, `-Infinity`, or a finite
number passes; values like `10abc` are accepted (parsed as `10` by
`parseInt`); values that resolve to a string after parsing (e.g.
`abc`) or to `NaN` are invalid. See FR-CV-16 and the weight-input
parser caveat in spec 09 FR-EX-05 for the full algorithm.

---

## Reference-cascade behavior

The rename and delete cascade handlers in
`schedulingReferenceUpdates.ts` are extended for `SHIFT_TYPE_COVERING`
(per spec 06 FR-RI-05/10/11). Concretely:

- **Rename PEOPLE / SHIFT_TYPES / DATES** rewrites the matching IDs in
  `preceptors`, `preceptees`, `shiftTypes`, and `date` (DATES only) via
  `renameReferenceIds` / `mapReferenceIdTree` on the nested reference
  trees. (`schedulingReferenceUpdates.ts:163-193` for rename, `:298-325`
  for delete; required-field drop at `:352-356`.)
- **Delete PEOPLE / SHIFT_TYPES / DATES** filters the matching IDs from
  those same fields via `filterReferenceIds` / `filterReferenceIdTree`
  (which also drops emptied inner sub-arrays).
- **Required-field drop**: a covering rule whose `preceptors`,
  `preceptees`, or `shiftTypes` collapses to empty after filtering is
  **dropped** from the preferences list (second-pass filter, spec 06
  FR-RI-11). Empty `date` alone is **not** enough to drop a rule
  (`date` is optional).
- **`applyExportLayoutForIdChange` / `applyExportLayoutForIdDeletion`**:
  no SHIFT_TYPE_COVERING-specific branch is needed — covering
  preferences are not part of the export layout (`state.export`); the
  export cascade operates generically on the export data shape.

`anonymizeSchedulingStateWithMapping` (when the **Anonymize schedule
data** toggle is on for Save/Load's anonymized download or for the
Optimize submit) rewrites `preceptors`, `preceptees`, and `shiftTypes`
through `mapReferenceIdTree` (the same nested-tree contract used for
shift-affinity), so person IDs inside the nested arrays are replaced
with `P1, P2, …` and reference through the same person-only
anonymization map. (`anonymizeSchedulingState.ts:25, 76-83`)

---

## Edge Cases & Quirks

- **EDGE-CV-01 — Editor always writes the canonical nested save shape.**
  The flat CheckboxList state is wrapped in a single-element outer
  array on save (`preceptors: [formData.preceptors]`, etc.) so the saved
  preference is always exactly one equation. Edit reads via
  `flattenIds` to restore the flat form. (FR-CV-07/08.)

- **EDGE-CV-02 — Covering `date` is preserved on edit-load but **always**
  dropped on save (current product bug).** On edit,
  `date: rule.date ?? []` (`page.tsx:108`) restores any saved `date`
  array — this only works for covering rules that were hand-authored or
  imported (since the editor itself never saves `date`). On Save /
  Update, `buildPrefFromForm` does **not** include `date` regardless of
  the user's selection (`page.tsx:155-162`), so a user who picks
  specific Dates in the editor loses that selection on Add/Update.
  The cascade for the optional `date` field is already implemented
  and tested against hand-built state
  (`schedulingReferenceUpdates.test.ts:362-444`). See the wave-3
  follow-up entry in
  `decision-logs/02-shift-type-covering-preference/index.md`.

- **EDGE-CV-03 — Card `(all)` rendering.** `summarizeIds(ids)` flattens
  the nested reference tree to a comma-joined string; an empty
  flattened list renders the literal string `(all)`. This means a
  covering rule with no `preceptors` in the data (which is impossible
  by validation, but defensive) would render `Preceptors: (all)`.
  (`page.tsx:555-557`)

- **EDGE-CV-04 — No weight-sign constraint, and `weight` is ignored by
  the current backend.** Unlike Requirements (`weight ≤ 0` when
  preferred ≠ required) and Counts (`weight ≤ 0` when expression is
  `|x - T|^2`), the covering editor accepts any valid weight (finite,
  `+Infinity`, `-Infinity`). The C3 backend **does not read
  `preference.weight`** — every valid weight produces the same hard
  implication. The instructions panel text (FR-PR-90 / `page.tsx:76-84`)
  is preserved verbatim for strict UI parity but is semantically
  misleading against the current backend. (CON-SEM-07; see FR-PR-86
  in spec 05; `behavior-test-catalog/index.md` CC-B8.)

- **EDGE-CV-05 — Delete has no confirmation.** Card delete is
  immediate; the `confirm()` dialog from spec 07's tab-switch guard
  does not apply here. (Spec 05 EDGE-PR-01.)

- **EDGE-CV-06 — Open-form list ops discard the draft.** Duplicate,
  Delete, and drag-reorder all call `dismissEditingDraft()` first,
  silently cancelling an open add/edit form before the operation
  runs. (Spec 05 EDGE-PR-02.)

- **EDGE-CV-07 — Empty-dependency fallbacks.** When the relevant entity
  set is empty, the corresponding `CheckboxList` is replaced by a
  guidance message linking to the setup tab verbatim (see FR-CV-12/13/14/15).

- **EDGE-CV-08 — Sort order on save.** `updatePreferencesByType`
  normalizes via `normalizePreferencesOrder`, which:
  - sorts the flat `date` array by entity order;
  - preserves the nested `preceptors`/`preceptees`/`shiftTypes` trees
    (matching the shift-affinity convention);
  - includes `shift type covering` in the type order at the trailing
    position (after `shift affinity`, spec 01 FR-DM-20).

- **EDGE-CV-09 — Reference cascade: deleting may drop rules silently;
  renaming never drops.** **Deleting** a referenced person / shift
  type rewrites the rule and, if any required reference field
  (`preceptors`/`preceptees`/`shiftTypes`) collapses to empty, the
  rule is dropped from `preferences` without user notification.
  **Renaming** a referenced person / shift type only rewrites the
  matching IDs (via `mapReferenceIdTree`); it does not prune the
  reference fields and never drops covering rules — even when no
  match is found in a field, the field is left intact.
  (Spec 06 FR-RI-10/11; `schedulingReferenceUpdates.ts:163-193` rename,
  `:298-356` delete.)

- **EDGE-CV-10 — The page itself does not call `useEffect`-style
  save/restore of the scroll position itself.** Save/restore is
  triggered only by the user opening the edit form (save) and by
  Cancel/Save while editing (restore). Add does not save/restore.
  (Spec 05 FR-PR-07; spec 07 FR-ST-35/36/37.)

---

## Acceptance Criteria

**AC-CV-01 — Open the form with the Add toggle.**
GIVEN the user is on `/shift-type-coverings`,
WHEN they click the `Add Shift Type Covering` toggle,
THEN the form panel mounts with the title `Add Shift Type Covering`, the
description input (with placeholder
`e.g., Lil must always be paired with Anna on Day shift`), the dates
multi-select (with help text `Dates (leave empty for all dates)`), the
preceptors / preceptees / shift types multi-selects, and the weight
input (with placeholder `e.g., 1, 10, ∞`); the submit button reads
`Add`.

**AC-CV-02 — Add a rule with the canonical nested save shape (current
behavior drops the selected date).**
GIVEN an empty rule set and a populated `Dates` set,
WHEN the user selects one date, two preceptors (one item + one group),
two preceptees, two shift types, leaves the default weight (`1`), and
clicks `Add`,
THEN `state.preferences` contains one new preference of type
`shift type covering` with `preceptors: [<selected>]` (single-element
outer array), `preceptees: [<selected>]`, `shiftTypes: [<selected>]`,
`weight: 1`, and **no `date` key** (the editor's current product bug
silently drops the selected date — see FR-CV-07, FR-CV-12, EDGE-CV-02).
The form closes and the new rule appears in the
`Current Shift Type Coverings` list with the three `Preceptors:` /
`Preceptees:` / `Shift Types:` rows, **no `Dates:` row** (since the
saved object has no `date`), and `Weight: +1`. **Under strict parity,
do not implement the "fix `buildPrefFromForm` to include `date`"
path**; the future-fix path is a non-parity follow-up described in
`decision-logs/02-shift-type-covering-preference/index.md`.

**AC-CV-03 — Empty selectors are rejected with the verbatim messages.**
GIVEN the form is open with no preceptors, preceptees, or shift types
selected (a valid weight is entered),
WHEN the user clicks `Add`,
THEN three errors are set: preceptors `At least one preceptor must be
selected`, preceptees `At least one preceptee must be selected`,
shiftTypes `At least one shift type must be selected`; no preference is
persisted and the form stays open.

**AC-CV-04 — Invalid weight is rejected with the verbatim message.**
GIVEN a valid selection of preceptors, preceptees, and shift types, and a
non-empty weight that is a string (e.g. `abc`),
WHEN the user clicks `Add`,
THEN the weight error is set to
`Weight must be a valid number, Infinity, or -Infinity`; no preference
is persisted.

**AC-CV-05 — Edit a rule restores the flat form state.**
GIVEN an existing rule with `preceptors: [['P1', 'P2']]`,
`preceptees: [['P3']]`, `shiftTypes: [['D']]`, `date: ['2026-01-01']`,
`weight: 1`,
WHEN the user clicks Edit on that card,
THEN the form opens with `editingIndex` set, the preceptors/preceptees/
shift_types checkboxes reflect the flattened selections
(`['P1', 'P2']`, `['P3']`, `['D']`), `date: ['2026-01-01']`, and the
submit button reads `Update`; the saved scroll position is restored
when Cancel or Update is clicked.

**AC-CV-06 — Delete a rule with no confirmation.**
GIVEN an existing rule,
WHEN the user clicks Delete on that card,
THEN the rule is removed from `state.preferences` immediately, with no
`confirm()` dialog; if a form is open it is first cancelled (draft
discarded).

**AC-CV-07 — Duplicate a rule.**
GIVEN an existing rule with `description: 'A'`,
WHEN the user clicks Duplicate on that card,
THEN `state.preferences` contains a deep clone of the rule inserted
immediately after the source, with `description: 'A copy'` (per spec 05
FR-PR-13); if a form is open it is first cancelled.

**AC-CV-08 — Drag-reorder persists the new order.**
GIVEN two existing rules `[A, B]`,
WHEN the user drags `B` above `A` and drops it,
THEN `state.preferences` reflects the new order `[B, A]`; if a form is
open it is first cancelled.

**AC-CV-09 — Enter=save, Escape=cancel under IME guard.**
GIVEN the form is open with a valid selection and weight,
WHEN the user presses Enter (not during IME composition),
THEN the form validates and saves. WHEN the user presses Escape,
THEN the form cancels.

**AC-CV-10 — Empty-state message.**
GIVEN no covering rules exist,
WHEN the user lands on `/shift-type-coverings`,
THEN the message
`No covering rules yet. Click "Add Shift Type Covering" to get started.`
is shown.

**AC-CV-11 — Renaming a referenced person propagates into the rule.**
GIVEN a rule with `preceptors: [['P1']]`,
WHEN the user renames the person `P1` to `Alice` on the People tab,
THEN the rule's `preceptors` becomes `[['Alice']]` (rename cascade
preserves the nested shape).

**AC-CV-12 — Deleting a referenced preceptor drops the rule.**
GIVEN a rule with `preceptors: [['P1']]` and other required fields
non-empty,
WHEN the user deletes the person `P1` on the People tab,
THEN the rule is removed from `state.preferences` (cascade pass-2
required-field drop).

**AC-CV-13 — Anonymization rewrites person IDs in the separate
nested-tree fields.**
GIVEN a rule with `preceptors: [['P1']]`, `preceptees: [['P2']]`,
`shiftTypes: [['D']]`, and the **Anonymize schedule data** toggle
enabled,
WHEN the YAML is generated and downloaded from Save/Load,
 THEN the YAML `preferences[*]` entry has `preceptors: [[<anonP1>]]` and
`preceptees: [[<anonP2>]]` (each field's nested shape preserved
independently), the `shiftTypes` field's shift-type IDs are not
rewritten (the people-only anonymization map does not touch shift-type
references unless they collide with anonymized people/group IDs), and
all `description` fields are removed when `removeDescriptions` is on
(the spec field is named `description`, not `descriptions`).
(`anonymizeSchedulingState.ts:76-82` maps `preceptors`, `preceptees`,
and `shiftTypes` independently via `mapReferenceIdTree`; the
anonymization map is built from people items/groups
`anonymizeSchedulingState.ts:114-121`.)

**AC-CV-14 — Tab navigation reaches the editor.**
GIVEN the user is on the Home tab,
WHEN the user presses the digit `9` (no modifier, no input focus),
THEN the navigation jumps to `/shift-type-coverings` (array index 9).
WHEN the user is on the same tab and presses `9` again, nothing
changes. WHEN the user clicks the `8b. Shift Type Coverings` tab from
any other tab, the navigation jumps to it. (Spec 07 FR-ST-24/28.)

---

## Cross-References

- **C3 — Preference / Constraint Semantics (CON-SEM-07)** — the
  backend handler `shift_type_covering` that reifies the hard OR
  constraint from the editor's saved preference; the cross-product
  expansion of preceptor × preceptee × shift-type groups. **The
  handler does not read `preference.weight`** — the current backend
  always produces a hard implication, regardless of the saved weight
  value (a known drift between the UI copy and the current backend
  semantics; see EDGE-CV-04 and `behavior-test-catalog/index.md`
  CC-B8). Precondition errors for empty selectors are documented
  under the CON-SEM-07 catalog.
- **C1 — YAML Scenario Schema (CON-YAML, preference (g))** — the
  `ShiftTypeCoveringPreference` schema, the `shift type covering` type
  string, the `extra="forbid"` policy, and the editor's nested
  reference-tree contract.
- **Spec 01 — Data Model & Entities (FR-DM-20/21)** — the inclusion of
  `shift type covering` in `sortPreferencesByType`'s typeOrder and the
  per-type normalization rules for the covering fields.
- **Spec 05 — Card Preference Editors (FR-PR-80..90)** — the shared
  card-shell behaviors this editor inherits (header, instructions
  panel, add toggle, scroll save/restore, delete-no-confirm, duplicate
  label, drag-reorder, dispatch-before-draft).
- **Spec 06 — Reference Integrity (FR-RI-05/10/11, CC-B4)** — the
  cascade behavior for `preceptors`/`preceptees`/`shiftTypes`/`date`
  on rename and delete, including the second-pass required-field drop
  for empty rules.
- **Spec 07 — State, History, Persistence & Global Interaction
  (FR-ST-24, FR-ST-28)** — the 13-tab navigation, the digit-key
  shortcuts (with `9` reaching the new tab), and the tab-switch
  unsaved-edit guard.
- **Spec 08 — Save / Load & YAML** — the YAML serialization of the
  nested reference trees, the load path's normalization of
  `extra="forbid"` violations, and the anonymization panel's coverage
  of covering preferences.
- **Spec 10 — Optimize & Export** — the inclusion of
  `shift type covering` in the YAML submitted to `POST /optimize` (the
  editor's saved shape is preserved through the optimize payload).
