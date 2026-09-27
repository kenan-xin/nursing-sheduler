---
title: "Shift Type Coverings Editor"
kind: spec
status: 1
---

# Shift Type Coverings Editor

## Purpose & Scope

This artifact specifies the **`shift type covering preference editor — the`**
fifth card-list preference editor, mounted at `/shift-type-coverings (tab label`
`8b. Shift Type Coverings, array index 9 — see spec 07). It defines a`
hard-reified staffing rule: whenever any person in `preceptees works one of`
the chosen `shiftTypes on one of the chosen date entries, at least one`
person in `preceptors must also work that shift type. The page is the`
authoring surface for the `shift type covering preference (CON-SEM-07); it`
inherits the shared card-shell, drag-reorder, and undo behavior from the
other card editors (spec 05).

The artifact is **UI-agnostic: it specifies data, behavior, exact strings,**
and the reference-tree save shape. Backend semantics (the hard-OR reification
and the cross-product expansion) are owned by the **C3 — Preference /**
**Constraint Semantics (CON-SEM-07) contract and are referenced, not**
redefined, here. The reference-cascade behavior (rename/delete rewriting the
nested reference trees) is owned by spec 06.

Related behavior owned elsewhere: reference cascades (spec 06), preference
ordering (spec 01 FR-DM-20/21), navigation (spec 07), anonymization (specs 08 and 10).
Shipped editor code (current app): `web/components/coverings/`.

Out of scope: the shared card shell, weight input, `DraggableCardList,`
`CheckboxList, NumberInput, and ToggleButton components (referenced`
where their behavior is observable from this editor; specified in spec 05),
and the persistence / undo-redo layer (see spec 07).

## Functional Requirements

### Page shell

- **FR-CV-01 — Route, title, and tab placement. The page is mounted at**
`/shift-type-coverings. Navigation exposes it as the tab labelled`
`8b. Shift Type Coverings at array index 9; see`
spec 07 for the navigation and keyboard-shortcut changes this introduces.
The page title is `Shift Type Coverings.`
- **FR-CV-02 — Instructions panel. A **`FiHelpCircle help button beside the`
title toggles an instructions panel (`title="Toggle instructions"`).
The 7-bullet instructions array is shown verbatim
in FR-PR-90 (spec 05).
- **FR-CV-03 — Add / Cancel toggle. A **`ToggleButton (Add Shift Type Covering) starts a fresh add draft (form opens, editingIndex=null,`
fields reset to defaults) or cancels an open draft. The form panel is
mounted only while `isFormVisible` is true.

### Data model — form & saved preference

- **FR-CV-06 — Form defaults. **`DEFAULT_WEIGHT = 1;`
all other fields default to `'' / [].`
- **FR-CV-07 — Saved preference shape (`buildPrefFromForm`) drops `date`.** The
form draft tracks a `date` selection, but the builder that assembles the saved
preference on Add/Update omits `date` entirely — the persisted rule carries
`description`, `preceptors`, `preceptees`, `shiftTypes`, `weight`, but **no**
`date`. This is the save-shape quirk referenced by
FR-CV-12; it is `[incidental]`, **not** a parity requirement — and per
[decision log 08](../decision-logs/08-covering-omitted-date-all-dates/index.md)
an omitted `date` now means *all dates*, so the drop is no longer a functional
no-op. Per decision log 06 the UI is free, so a rebuild need not
reproduce the drop and should persist the selection (emitting date ids or
`[ALL]`, per FR-CV-12's binding backend note). A stored/imported rule that
*already* has `date` retains it until the user re-saves.
- **FR-CV-08 — Edit load maps the stored rule back into the form.** Opening an
existing rule for edit restores each field, with `date: rule.date ?? []`
 — so an imported rule's `date` is shown, but per FR-CV-07 a
subsequent Save drops it again.

### Save / load / cancel

- **FR-CV-09 — Save appends or replaces. When **`editingIndex === null the`
rule is appended (`[...shiftTypeCoverings, newPref]); otherwise the`
rule at `editingIndex is replaced (newPrefs[editingIndex] = newPref).`
Either path goes through `updatePreferencesByType(SHIFT_TYPE_COVERING, …), which normalizes (sorts date, preserves nested reference trees)`
and persists one history entry.
- **FR-CV-10 — Cancel hides the form, resets state, restores scroll. A**
Cancel call hides the form, clears all form fields and errors, and —
if we were editing — restores the saved scroll position via
`restoreScrollPosition().`

### Form fields and validation

- **FR-CV-11 — Description field (optional). Free-text input**
`Description (optional) with placeholder`
`e.g., Lil must always be paired with Anna on Day shift. Stored as-is`
(may be empty).
- **FR-CV-12 — Dates (optional, exposed in the UI but not persisted; the**
**label "leave empty for all dates" is misleading under current parity).**
`Dates (leave empty for all dates) is a multi-select CheckboxList`
of date items + groups. The error key is `date. No errors.date is`
ever set in the current implementation; an empty date set is
allowed. The list falls back to a guidance message when no dates are
set up: `No dates available. Please set up dates in the Dates tab first.`
(linking to `/dates).`
`[incidental] — current product bug (not a parity requirement):` the user's
date selection is **not saved on Add/Update under current code** (see FR-CV-07).
The selection is tracked only while the form draft is open; Add/Update drops it
and `resetForm` clears it; a later edit only restores `rule.date` if the stored/
imported rule already has one. Per decision log 06 the **UI is free**, so a
rebuild is **not** required to reproduce this data-losing drop — it MAY (and
should) persist the selection and emit it. What is **binding** is the backend
date semantics below, not the current drop-on-save behavior.
**Binding (backend semantics — updated, see [decision log 08](../decision-logs/08-covering-omitted-date-all-dates/index.md)):**
an **omitted / `None` `date` means all dates** (the covering handler now defaults
to every day, matching the requirement/successions handlers); an explicit
`date: []` means **no dates** (a no-op); `[ALL]` or concrete ids target those
dates — see CON-SEM-07. So the current UI's drop-on-save (omitting `date`) now
yields all-dates coverage rather than a no-op. A rebuild may target all dates by
omitting `date` **or** emitting `[ALL]`, and should still persist an explicit
user date selection when one is made.
- **FR-CV-13 — Preceptors (required, multi-select). **`Preceptors (must cover) * is a multi-select CheckboxList of people items + groups.`
Empty → `At least one preceptor must be selected. The list falls back`
to `No people available. Please set up people in the People tab first.`
when no people are set up (linking to `/people).`
- **FR-CV-14 — Preceptees (required, multi-select). **`Preceptees (must be covered) * is a multi-select CheckboxList of people items + groups.`
Empty → `At least one preceptee must be selected. Same fallback as`
preceptors when no people are set up.
- **FR-CV-15 — Shift types (required, multi-select). **`Shift Types * is`
a multi-select `CheckboxList of shift-type items + groups. Empty → At least one shift type must be selected. The list falls back to`
`No shift types available. Please set up shift types in the Shift Types tab first.`
when no shift types are set up (linking to `/shift-types).`
`. `**Binding (backend): the backend rejects any covering**`selector containingOFF or LEAVE with E26b ("'OFF' and 'LEAVE' are not allowed in shift type covering preferences; covering applies to worked shifts only." — C3 CON-SEM-07). `**Recommended (UI, not required):** a rebuild SHOULD prevent authoring such a rule — either by excluding `OFF`/`LEAVE` (and groups
containing either) from this selector **or** by surfacing the backend error; the
specific UI shape is a design choice, not a parity requirement. `[incidental]`
the current covering selector exposes `OFF` and `LEAVE` with **no exclusion**
(both are auto-generated items), letting a user save a covering card the backend
will reject at solve time; replicating that exposed-but-rejected behavior is not
required.
- **FR-CV-16 — Weight is inert and not exposed.** A covering is always enforced as
a hard OR reification; the solver ignores its weight (EDGE-CV-04, C3 CON-SEM-07).
The rebuilt editor therefore **removes the weight control entirely** and shows a
locked hard-rule note in its place — "This covering is always enforced as a hard
rule … the solver ignores weight for coverings, so there is no soft/hard dial
here" (`web/components/coverings/covering-form.tsx`, `CardEditorHardRuleNote`).
There is no weight input, no weight validation, and no weight error. The saved
shape still carries `weight: 1` — a single stamped constant (`COVERING_WEIGHT`) —
so the persisted/serialized rule is unchanged
.
- **FR-CV-17 — Per-field error clear on edit.** Toggling a selector clears that
field's error key. (There is no weight field, so no weight error to clear — see
FR-CV-16.)

### Card list and operations

- **FR-CV-18 — `DraggableCardList` shell with title**
**`Current Shift Type Coverings`****. Existing rules render as cards in**
the same `DraggableCardList used by the other four card editors.`
- **FR-CV-19 — Card content. Each card shows:**
  - optional description as an `<h4> heading (when rule.description is`
non-empty);
  - `Preceptors: followed by summarizeRefs(rule.preceptors)`
(comma-joined ids, flattened from the nested tree);
  - `Preceptees: followed by summarizeRefs(rule.preceptees);`
  - `Shift types: followed by summarizeRefs(rule.shiftTypes);`
  - `Dates: followed by summarizeRefs(rule.date), or (all) when the`
`rule has no date field;`
  - a red **"Always enforced"** hard-rule badge in place of any weight row (plus a **"Disabled"** badge when the card is turned off, and an **"Advanced (multi-term)"** badge for imported multi-term rules); the card shows **no** `Weight:` row;
`summarizeRefs(ids) flattens the nested reference tree to a single`
comma-joined string; an empty flattened list renders the literal
string `(all).`
- **FR-CV-20 — Empty-state message. When the list is empty:**
`No covering rules yet. Click "Add Shift Type Covering" to get started.`
- **FR-CV-21 — Card operations: Edit, Duplicate, Delete, drag-reorder.**
Reuses the same `DraggableCardList action contract as the other four`
card editors:
  - **Edit loads the rule via **`handleStartEdit (FR-CV-08); saves`
scroll before scrolling to top.
  - **Delete removes the card immediately with no confirmation**
**dialog** (filters by index).
  - **Duplicate calls **`duplicatePreferenceByType<ShiftTypeCoveringPreference>(SHIFT_TYPE_COVERING, index) — deep-clones with copy/copy N label (see spec 05`
FR-PR-13).
  - **Reorder calls **`updatePreferencesByType with the new ordered`
list.
Each of these first calls `dismissEditingDraft() (cancels an open`
add/edit form before the operation runs, losing the unsaved draft).

### Keyboard and dirty-state

- **FR-CV-22 — Enter=save, Escape=cancel under IME guard. While the**
form is visible, a global `keydown listener (window-scoped, attached`
with `addEventListener` and cleaned up when the form closes) handles:
  - `Enter (no Shift/Alt/Ctrl/Meta, not during IME composition per`
`isImeCompositionKeyEvent): validates, then saves.`
  - `Escape: cancels.`
Both call `preventDefault.`
- **FR-CV-23 — Unsaved-edit tab-switch guard. **`useTabSwitchWarning(isFormVisible)`
arms the navigation `confirm() while the form is open (so navigating`
away asks `You have unsaved edits. Leave this page without saving?).`
(Spec 07 FR-ST-31.)
- **FR-CV-24 — Scroll save/restore on edit. **`handleStartEdit calls`
`saveScrollPosition() then window.scrollTo({ top: 0, behavior: 'instant' }). Cancel and save both call restoreScrollPosition()`
when editing. Add does not save/restore scroll.

## Validation Rules & Messages

All messages are **verbatim and produced by **`validateForm`
`; Save blocks persistence if any errors are set.`
Fields marked `* are required.`

| Field | Condition | Message |
| --- | --- | --- |
| preceptors | selection empty | `At least one preceptor must be selected` |
| preceptees | selection empty | `At least one preceptee must be selected` |
| shift_types (error key `shiftTypes)` | selection empty | `At least one shift type must be selected` |
| weight | — | No weight field in the rebuilt editor — a covering is always enforced (FR-CV-16). |
| date | selection empty | (no error — date is optional) |

The covering editor exposes **no** weight field (FR-CV-16), so there is no weight
parsing or validation here. The shared weight-input parser (a finite number or
±Infinity passes; `10abc` → `10` via `parseInt`; strings/NaN invalid) still applies
only to the editors that DO expose a weight — Requirements and Counts — and to
export weight cells (spec 09 FR-EX-05).

## Reference-cascade behavior

The rename and delete cascades cover `SHIFT_TYPE_COVERING` (per spec 06
FR-RI-05/10/11). Concretely:

- **Rename PEOPLE / SHIFT_TYPES / DATES rewrites the matching IDs in**
`preceptors, preceptees, shiftTypes, and date (DATES only) via`
`renameReferenceIds / mapReferenceIdTree on the nested reference`
trees.
- **Delete PEOPLE / SHIFT_TYPES / DATES filters the matching IDs from**
those same fields via `filterReferenceIds / filterReferenceIdTree`
(which also drops emptied inner sub-arrays).
- **Required-field drop: a covering rule whose **`preceptors,`
`preceptees, or shiftTypes collapses to empty after filtering is`
**dropped from the preferences list (second-pass filter, spec 06**
FR-RI-11). Empty `date alone is `**not enough to drop a rule**
(`date is optional).`
- **`applyExportLayoutForIdChange** / ****`**`applyExportLayoutForIdDeletion:**`
no SHIFT_TYPE_COVERING-specific branch is needed — covering
preferences are not part of the export layout (`state.export); the`
export cascade operates generically on the export data shape.

`anonymizeSchedulingStateWithMapping (when the `**Anonymize schedule**
**data toggle is on for Save/Load's anonymized download or for the**
Optimize submit) rewrites `preceptors, preceptees, and shiftTypes`
through `mapReferenceIdTree (the same nested-tree contract used for`
shift-affinity), so person IDs inside the nested arrays are replaced
with `P1, P2, … and reference through the same person-only`
anonymization map.

## Edge Cases & Quirks

- **EDGE-CV-01 — Editor always writes the canonical nested save shape.**
The flat CheckboxList state is wrapped in a single-element outer
array on save (`preceptors: [formData.preceptors], etc.) so the saved`
preference is always exactly one equation. Edit reads via
`flattenIds to restore the flat form. (FR-CV-07/08.)`
- **EDGE-CV-02 — Covering `date` is preserved on edit-load but always**
**dropped on save (current product bug). On edit,**
`date: rule.date ?? [] restores any saved date`
array — this only works for covering rules that were hand-authored or
imported (since the editor itself never saves `date). On Save /`
Update, `buildPrefFromForm does **not include **date regardless of`
the user's selection`, so a user who picks`
specific Dates in the editor loses that selection on Add/Update.
The cascade for the optional `date field is already implemented`
and tested against hand-built state
`. See the wave-3`
follow-up entry in
`decision-logs/02-shift-type-covering-preference/index.md.`
- **EDGE-CV-03 — Card **`(all) rendering. **`**`summarizeRefs(ids) flattens`
the nested reference tree to a comma-joined string; an empty
flattened list renders the literal string `(all). This means a`
covering rule with no `preceptors in the data (which is impossible`
by validation, but defensive) would render `Preceptors: (all).`
- **EDGE-CV-04 — No weight-sign constraint, and `weight` is ignored by**
**the current backend. Unlike Requirements (**`weight ≤ 0 when`
preferred ≠ required) and Counts (`weight ≤ 0 when expression is`
`|x - T|^2), the covering editor accepts any valid weight (finite,`
`+Infinity, -Infinity). The C3 backend `**does not read**
**`preference.weight — every valid weight produces the same hard`**
implication. The instructions panel text (FR-PR-90)
is preserved verbatim for strict UI parity but is semantically
misleading against the current backend. (CON-SEM-07; see FR-PR-86
in spec 05; `behavior-test-catalog/index.md CC-B8.)`
- **EDGE-CV-05 — Delete has no confirmation. Card delete is**
immediate; the `confirm() dialog from spec 07's tab-switch guard`
does not apply here. (Spec 05 EDGE-PR-01.)
- **EDGE-CV-06 — Open-form list ops discard the draft. Duplicate,**
Delete, and drag-reorder all call `dismissEditingDraft() first,`
silently cancelling an open add/edit form before the operation
runs. (Spec 05 EDGE-PR-02.)
- **EDGE-CV-07 — Empty-dependency fallbacks. When the relevant entity**
set is empty, the corresponding `CheckboxList is replaced by a`
guidance message linking to the setup tab verbatim (see FR-CV-12/13/14/15).
- **EDGE-CV-08 — Sort order on save. **`updatePreferencesByType`
normalizes via `normalizePreferencesOrder, which:`
  - sorts the flat `date array by entity order;`
  - preserves the nested `preceptors/preceptees/shiftTypes trees`
(matching the shift-affinity convention);
  - includes `shift type covering in the type order at the trailing`
position (after `shift affinity, spec 01 FR-DM-20).`
- **EDGE-CV-09 — Reference cascade: deleting may drop rules silently;**
**renaming never drops. Deleting a referenced person / shift**
type rewrites the rule and, if any required reference field
(`preceptors/preceptees/shiftTypes) collapses to empty, the`
rule is dropped from `preferences without user notification.`
**Renaming a referenced person / shift type only rewrites the**
matching IDs (via `mapReferenceIdTree); it does not prune the`
reference fields and never drops covering rules — even when no
match is found in a field, the field is left intact.
(Spec 06 FR-RI-10/11.)
- **EDGE-CV-10 — The page itself does not call `useEffect`-style**
**save/restore of the scroll position itself. Save/restore is**
triggered only by the user opening the edit form (save) and by
Cancel/Save while editing (restore). Add does not save/restore.
(Spec 05 FR-PR-07; spec 07 FR-ST-35/36/37.)

## Acceptance Criteria

**AC-CV-01 — Open the form with the Add toggle.**
GIVEN the user is on `/shift-type-coverings,`
WHEN they click the `Add Shift Type Covering toggle,`
THEN the form panel mounts with the title `Add Shift Type Covering, the`
description input (with placeholder
`e.g., Lil must always be paired with Anna on Day shift), the dates`
multi-select (with help text `Dates (leave empty for all dates)), the`
preceptors / preceptees / shift types multi-selects, and a locked
hard-rule note in place of any weight control (FR-CV-16); the submit button reads
`Add.`

**AC-CV-02 — Add a rule with the canonical nested save shape (current**
**behavior drops the selected date).**
GIVEN an empty rule set and a populated `Dates set,`
WHEN the user selects one date, two preceptors (one item + one group),
two preceptees, two shift types (there is no weight control to set), and
clicks `Add,`
THEN `state.preferences contains one new preference of type`
`shift type covering with preceptors: [<selected>] (single-element`
outer array), `preceptees: [<selected>], shiftTypes: [<selected>],`
`weight: 1`. `[incidental]` under **current** code the saved object has **no**
`date` key — the editor silently drops the selected date (FR-CV-07, FR-CV-12,
EDGE-CV-02). The form closes and the new rule appears in the
`Current Shift Type Coverings` list with the `Preceptors:` /
`Preceptees:` / `Shift Types:` fields and an **"Always enforced"** badge (no
`Weight:` row — the stamped `weight: 1` is not displayed). Per decision log 06 the UI
is free: a rebuild is **not** required to reproduce the date-drop and MAY persist
the selection (emitting date ids or `[ALL]`); the only **binding** acceptance is
the backend payload semantics — a covering with an **omitted `date` now applies**
**to all dates** (an explicit `date: []` is a no-op), and `[ALL]` targets all dates
(FR-CV-12, CON-SEM-07, [DL08](../decision-logs/08-covering-omitted-date-all-dates/index.md)).
The date-persistence fix path is tracked in
`decision-logs/02-shift-type-covering-preference/index.md`.

**AC-CV-03 — Empty selectors are rejected with the verbatim messages.**
GIVEN the form is open with no preceptors, preceptees, or shift types
selected (a valid weight is entered),
WHEN the user clicks `Add,`
THEN three errors are set: preceptors `At least one preceptor must be selected, preceptees At least one preceptee must be selected,`
shiftTypes `At least one shift type must be selected; no preference is`
persisted and the form stays open.

**AC-CV-04 — There is no weight field to reject.**
GIVEN the covering form is open,
THEN it exposes **no** weight control — a covering is always enforced as a hard
rule and the solver ignores weight (FR-CV-16, EDGE-CV-04). The saved rule carries
the stamped constant `weight: 1`; there is no weight input, validation, or error.

**AC-CV-05 — Edit a rule restores the flat form state.**
GIVEN an existing rule with `preceptors: [['P1', 'P2']],`
`preceptees: [['P3']], shiftTypes: [['D']], date: ['2026-01-01'],`
`weight: 1,`
WHEN the user clicks Edit on that card,
THEN the form opens with `editingIndex set, the preceptors/preceptees/`
shift_types checkboxes reflect the flattened selections
(`['P1', 'P2'], ['P3'], ['D']), date: ['2026-01-01'], and the`
submit button reads `Update; the saved scroll position is restored`
when Cancel or Update is clicked.

**AC-CV-06 — Delete a rule with no confirmation.**
GIVEN an existing rule,
WHEN the user clicks Delete on that card,
THEN the rule is removed from `state.preferences immediately, with no`
`confirm() dialog; if a form is open it is first cancelled (draft`
discarded).

**AC-CV-07 — Duplicate a rule.**
GIVEN an existing rule with `description: 'A',`
WHEN the user clicks Duplicate on that card,
THEN `state.preferences contains a deep clone of the rule inserted`
immediately after the source, with `description: 'A copy' (per spec 05`
FR-PR-13); if a form is open it is first cancelled.

**AC-CV-08 — Drag-reorder persists the new order.**
GIVEN two existing rules `[A, B],`
WHEN the user drags `B above A and drops it,`
THEN `state.preferences reflects the new order [B, A]; if a form is`
open it is first cancelled.

**AC-CV-09 — Enter=save, Escape=cancel under IME guard.**
GIVEN the form is open with a valid selection and weight,
WHEN the user presses Enter (not during IME composition),
THEN the form validates and saves. WHEN the user presses Escape,
THEN the form cancels.

**AC-CV-10 — Empty-state message.**
GIVEN no covering rules exist,
WHEN the user lands on `/shift-type-coverings,`
THEN the message
`No covering rules yet. Click "Add Shift Type Covering" to get started.`
is shown.

**AC-CV-11 — Renaming a referenced person propagates into the rule.**
GIVEN a rule with `preceptors: [['P1']],`
WHEN the user renames the person `P1 to Alice on the People tab,`
THEN the rule's `preceptors becomes [['Alice']] (rename cascade`
preserves the nested shape).

**AC-CV-12 — Deleting a referenced preceptor drops the rule.**
GIVEN a rule with `preceptors: [['P1']] and other required fields`
non-empty,
WHEN the user deletes the person `P1 on the People tab,`
THEN the rule is removed from `state.preferences (cascade pass-2`
required-field drop).

**AC-CV-13 — Anonymization rewrites person IDs in the separate**
**nested-tree fields.**
GIVEN a rule with `preceptors: [['P1']], preceptees: [['P2']],`
`shiftTypes: [['D']], and the `**Anonymize schedule data toggle**
enabled,
WHEN the YAML is generated and downloaded from Save/Load,
 THEN the YAML `preferences[*] entry has preceptors: [[<anonP1>]] and`
`preceptees: [[<anonP2>]] (each field's nested shape preserved`
independently), the `shiftTypes field's shift-type IDs are not`
rewritten (the people-only anonymization map does not touch shift-type
references unless they collide with anonymized people/group IDs), and
all `description fields are removed when removeDescriptions is on`
(the spec field is named `description, not descriptions).`
(Preceptors, preceptees and shift types are mapped independently; the
anonymization map is built from people items and groups.)

**AC-CV-14 — Tab navigation reaches the editor.**
GIVEN the user is on the Home tab,
WHEN the user presses the digit `9 (no modifier, no input focus),`
THEN the navigation jumps to `/shift-type-coverings (array index 9).`
WHEN the user is on the same tab and presses `9 again, nothing`
changes. WHEN the user clicks the `8b. Shift Type Coverings tab from`
any other tab, the navigation jumps to it. (Spec 07 FR-ST-24/28.)

## Cross-References

- **C3 — Preference / Constraint Semantics (CON-SEM-07) — the**
backend handler `shift_type_covering that reifies the hard OR`
constraint from the editor's saved preference; the cross-product
expansion of preceptor × preceptee × shift-type groups. **The**
**handler does not read ****`preference.weight — the current backend**`
always produces a hard implication, regardless of the saved weight
value (a known drift between the UI copy and the current backend
semantics; see EDGE-CV-04 and `behavior-test-catalog/index.md`
CC-B8). Precondition errors for empty selectors are documented
under the CON-SEM-07 catalog.
- **C1 — YAML Scenario Schema (CON-YAML, preference (g)) — the**
`ShiftTypeCoveringPreference schema, the shift type covering type`
string, the `extra="forbid" policy, and the editor's nested`
reference-tree contract.
- **Spec 01 — Data Model & Entities (FR-DM-20/21) — the inclusion of**
`shift type covering in sortPreferencesByType's typeOrder and the`
per-type normalization rules for the covering fields.
- **Spec 05 — Card Preference Editors (FR-PR-80..90) — the shared**
card-shell behaviors this editor inherits (header, instructions
panel, add toggle, scroll save/restore, delete-no-confirm, duplicate
label, drag-reorder, dispatch-before-draft).
- **Spec 06 — Reference Integrity (FR-RI-05/10/11, CC-B4) — the**
cascade behavior for `preceptors/preceptees/shiftTypes/date`
on rename and delete, including the second-pass required-field drop
for empty rules.
- **Spec 07 — State, History, Persistence & Global Interaction**
**(FR-ST-24, FR-ST-28) — the 13-tab navigation, the digit-key**
shortcuts (with `9 reaching the new tab), and the tab-switch`
unsaved-edit guard.
- **Spec 08 — Save / Load & YAML — the YAML serialization of the**
nested reference trees, the load path's normalization of
`extra="forbid" violations, and the anonymization panel's coverage`
of covering preferences.
- **Spec 10 — Optimize & Export — the inclusion of**
`shift type covering in the YAML submitted to POST /optimize (the`
editor's saved shape is preserved through the optimize payload).
