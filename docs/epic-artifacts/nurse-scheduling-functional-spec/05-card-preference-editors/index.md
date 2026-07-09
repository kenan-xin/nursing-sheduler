---
title: "Card Preference Editors (Requirements, Successions, Counts, Affinities, Coverings)"
kind: spec
status: 1
---

# Card Preference Editors (Requirements, Successions, Counts, Affinities, Coverings)

## Purpose & Scope

This artifact specifies the five **card-list preference editors that let a user**
author scheduling preferences as an ordered list of cards, each backed by an
add/edit form. All five share a common shell — a page header with a help toggle
and a single "Add …" toggle button, an optional instructions panel, an inline
add/edit form, and a draggable list of existing cards — but differ in their
fields, defaults, validation, and weight semantics.

The five editors are:

| Editor | Route | Preference `type` | Cross-ref |
| --- | --- | --- | --- |
| Shift Type Requirements | `/shift-type-requirements` | `shift type requirement` | CON-SEM |
| Shift Type Successions | `/shift-type-successions` | `shift type s`uccessions | CON-SEM |
| Shift Counts | `/shift-counts` | `shift count` | CON-SEM |
| Shift Affinities | `/shift-affinities` | `shift affinity` | CON-SEM |
| Shift Type Coverings | `/shift-type-coverings` | `shift type covering` | CON-SEM, Spec 11 |

`shift type covering is the `**hard-reified editor in this set: the saved**
preference encodes a Boolean OR constraint that the solver must satisfy — a
preceptee may not work a covered shift type on a covered date without a
preceptor also working. Unlike the other four card editors (whose semantics
are weighted soft preferences — see C3), the covering preference is
**always a hard implication in the current backend**
(`core/nurse_scheduling/preference_types.py:622-633, :701-721). The`
`weight field is accepted for schema compatibility, validated, stored,`
and displayed, but the current backend **does not read**
**`preference.weight — every valid weight (finite number, `**`+Infinity,`
`-Infinity) produces the same hard implication. The instructions panel`
copy in the editor ("Use 1 (default) for a soft preference or +Infinity
(∞) for a hard require...") is **semantically misleading against the**
current backend; the verbatim string is preserved for strict parity, but
a rebuilder should treat it as a known-bug quirk. (See
`behavior-test-catalog/index.md CC-B8 and the wave-3 follow-up entry in`
`decision-logs/02-shift-type-covering-preference/index.md.)`

Source files:

- `web-frontend/src/app/shift-type-requirements/page.tsx`
- `web-frontend/src/app/shift-type-successions/page.tsx`
- `web-frontend/src/app/shift-counts/page.tsx`
- `web-frontend/src/app/shift-affinities/page.tsx`
- `web-frontend/src/app/shift-type-coverings/page.tsx`
- `web-frontend/src/components/CountShiftTypeCoefficientFields.tsx`
- `web-frontend/src/utils/countShiftTypeCoefficients.ts`
- `web-frontend/src/components/WeightInput.tsx`
- `web-frontend/src/utils/numberParsing.ts`
- `web-frontend/src/components/DraggableCardList.tsx`
- `web-frontend/src/components/RemovableTag.tsx`
- `web-frontend/src/components/NumberInput.tsx`

This artifact is **UI-agnostic: it defines behavior, data, and exact strings,**
not visual styling. Backend meaning of each field (weight math, group/keyword
resolution, hard-vs-soft constraints) is fixed by the **C3 — Preference /**
**Constraint Semantics (CON-SEM) contract and is referenced, not redefined, here.**

Out of scope: the *At Most One Shift Per Day and Shift Requests editors*
(covered elsewhere), the CheckboxList primitive internals, and the persistence /
undo-redo layer (`useSchedulingData), which is referenced only where its`
behavior is observable from these editors (duplicate, reorder, canonical
ordering). The covering editor is also covered in detail in spec 11 (Shift
Type Coverings Editor).

## Functional Requirements

### FR-PR — Shared editor shell (all five editors)

- **FR-PR-01 — Header and add toggle. Each editor shows a page title**
(`Shift Type Requirements, Shift Type Successions, Shift Counts,`
`Shift Affinities) and a single toggle button labeled respectively`
`Add Requirement, Add Succession, Add Shift Count, Add Shift Affinity.`
Toggling the button open starts a fresh add draft (reset form, no editing
index); toggling it closed cancels the current draft.
(requirements page:502-513; successions:341-352; counts:365-376; affinities:264-275)
- **FR-PR-02 — Instructions panel. A help toggle beside the title shows/hides**
an instructions panel (`title="Toggle instructions"). Instructions are a`
static bulleted list, verbatim per editor:
  - **Requirements (requirements page:221-230):**
    1. `Define requirements for specific shift types (e.g., "Night shifts need 3 senior nurses")`
    2. `Select one shift type or group that this requirement applies to`
    3. `Set the required number of people for each instance of the shift type`
    4. `Optionally specify which people or groups are qualified for this requirement`
    5. `Optionally set a preferred number of people when extra staffing is useful`
    6. `Optionally specify specific dates this requirement applies to`
    7. `Set weight only when the preferred number of people differs from the required number`
    8. `Navigate using the tabs or keyboard shortcuts (1, 2, etc.) to continue setup`
  - **Successions (successions:76-83):**
    1. `Define shift type succession preferences (e.g., "Forbid Evening -> Day succession")`
    2. `Select one or more people or groups this preference applies to`
    3. `Define the pattern of shift types in succession (minimum 2 shift types required)`
    4. `Specify specific dates this succession applies to`
    5. `Set positive weight to encourage successions and negative weight to discourage them`
    6. `Navigate using the tabs or keyboard shortcuts (1, 2, etc.) to continue setup`
  - **Counts (counts:103-112):**
    1. `Set up shift count rules for people (e.g., "Working shifts should be close to the average")`
    2. `Select one or more people that this constraint applies to`
    3. `Select which dates to count shifts for`
    4. `Select which shift types to count`
    5. `Choose a mathematical expression to evaluate (e.g., 'x >= T' means count should be at least the target)`
    6. `Set the numeric target value`
    7. `Set positive weight to encourage constraint matches and negative weight to discourage them`
    8. `Navigate using the tabs or keyboard shortcuts (1, 2, etc.) to continue setup`
  - **Affinities (affinities:75-83):**
    1. `Define shift affinity preferences to encourage or discourage people working together`
    2. `Select the dates when this affinity rule applies`
    3. `Select the first group of people (People 1)`
    4. `Select the second group of people (People 2)`
    5. `Select which shift types this affinity applies to`
    6. `Set positive weight to encourage working together and negative weight to discourage it`
    7. `Navigate using the tabs or keyboard shortcuts (1, 2, etc.) to continue setup`
- **FR-PR-03 — Add vs Edit form heading & submit label. The inline form**
heading reads `Add New <Entity> when adding and Edit <Entity> when editing;`
the submit button reads `Add when adding and Update when editing. Entity`
names: `Requirement, Succession, Shift Count, Shift Affinity.`
(requirements:569-571,849; successions:370-372,602; counts:394-395,649; affinities:293-294,491)
- **FR-PR-04 — Description field (optional, all editors). Every editor has a**
free-text `Description (optional) field with placeholder text per editor:`
Requirements `e.g., Night shifts need senior nurses; Successions`
`e.g., Forbid Evening -> Day succession; Counts`
`e.g., Working shifts should be close to the average; Affinities`
`e.g., Encourage newcomers and seniors to work together.`
Description is stored as-is (may be empty).
(requirements:576-585; successions:377-386; counts:401-410; affinities:300-309)
- **FR-PR-05 — Keyboard submit/cancel while form open. While the form is**
visible, a global key handler is active: `Enter (except during IME`
composition) triggers Save; `Escape triggers Cancel. Both call`
`preventDefault.`
The **first four editors (Requirements, Successions, Counts,**
Affinities) save on `Enter regardless of whether Shift/Alt/`
`Ctrl/Meta is held. The `**covering editor additionally gates on**
no modifier — `Enter with Shift/Alt/Ctrl/Meta does `**not**
save (`page.tsx:199). Both use the isImeCompositionKeyEvent guard`
(`isComposing or keyCode === 229) to skip IME composition.`
(requirements:402-419; successions:190-207; counts:269-286;
affinities:197-214; coverings:192-212; spec 11 FR-CV-22.)
- **FR-PR-06 — Unsaved-edit tab-switch guard. While the form is visible, a**
tab-switch warning is armed (`useTabSwitchWarning(isFormVisible)) so the user`
is warned before navigating away with an open draft.
(requirements:219; successions:74; counts:100; affinities:73)
- **FR-PR-07 — Edit scroll behavior. Starting an edit saves the current scroll**
position and scrolls to top instantly; a successful Save or a Cancel while
editing restores the saved scroll position. Starting an add does not
save/restore scroll. (requirements:275-277,391-394; and equivalents in each page)
- **FR-PR-08 — Cancel discards draft. Cancel hides the form and resets the form**
to defaults without persisting; it never mutates the stored list.
(requirements:280-288; successions:119-127; counts:158-166; affinities:121-129)
- **FR-PR-09 — Save creates or replaces. On Save, the form is validated**
(FR-PR-1x per editor); if invalid, nothing is persisted and errors are shown.
If valid: when editing, the card at the editing index is **replaced; when**
adding, the new card is **appended to the end of the list. Then the form**
closes and resets. (requirements:373-395; successions:161-183; counts:240-262; affinities:168-190)
- **FR-PR-10 — Card list & empty state. Existing cards render in a**
`DraggableCardList with a title (Current Requirements, Current Successions,`
`Current Shift Counts, Current Shift Affinities, Current Shift Type Coverings).`
When the list is empty, the editor shows its empty message verbatim:
  - `No requirements defined yet. Click "Add Requirement" to get started.`
  - `No successions defined yet. Click "Add Succession" to get started.`
  - `No shift counts defined yet. Click "Add Shift Count" to get started.`
  - `No shift affinities defined yet. Click "Add Shift Affinity" to get started.`
  - `No covering rules yet. Click "Add Shift Type Covering" to get started.`
(requirements:860-862; successions:613-615; counts:660-662; affinities:503-504;
coverings:502; DraggableCardList:97-100)
- **FR-PR-11 — Per-card operations. Each card exposes three (Requirements/**
Successions/Counts/Affinities all pass `onDuplicate) actions:`
`Edit, Duplicate, Delete.`
  - **Edit loads the card into the form (FR-PR-07).**
  - **Delete removes the card immediately with no confirmation dialog**
(`items.filter((_, i) => i !== index)).`
  - **Duplicate inserts a deep clone immediately after the source card**
(see FR-PR-13).
Any of these three, and Reorder, first calls `dismissEditingDraft() — if a`
form is open it is cancelled (draft discarded) before the operation runs.
(DraggableCardList:124-148; requirements:421-441; successions:209-229; counts:288-308; affinities:216-236)
- **FR-PR-12 — Drag reorder of cards. The card list is drag-reorderable. Drop**
position is decided by the pointer's vertical position relative to the hovered
card's midpoint (drop above vs below), and the dragged item is spliced to the
computed insertion index (adjusted when moving downward). Reorder replaces the
full ordered list. If `onReorder were missing the drop logs an error and`
no-ops (not reachable in these editors, which always pass it).
(DraggableCardList:59-89)
- **FR-PR-13 — Duplicate label & insert-after. Duplicate deep-clones the source**
card (`structuredClone), inserts it at index + 1, and derives a new`
description via `getUniqueCopyLabel: the trimmed source description has any`
trailing ` copy/ copy N suffix (case-insensitive) stripped and  copy`
appended; if that label already exists among descriptions, ` 2,  3, …`
is appended until unique. An empty/undefined source description yields
`Copy (then Copy 2, …). (schedulingEntryDuplication.ts:34-46; duplicateLabels.ts:20-43)`
- **FR-PR-14 — Empty-dependency guidance. Any selector whose underlying entity**
list is empty renders a guidance message instead of the picker, linking to the
setup tab, verbatim: `No shift types available. Please set up shift types in the Shift Types tab first.; No people available. Please set up people in the People tab first.; No dates available. Please set up dates in the Dates tab first. (requirements:593-600,740-747,779-786; successions:394-401,432-439,543-550; counts:418-425,457-464,496-503; affinities:318-325,357-364,395-402,433-440)`
- **FR-PR-15 — Weight display on cards. Card weight is rendered via**
`getWeightWithPositivePrefix: positive finite weights get a leading +,`
numbers are locale-formatted with thousands separators, `Infinity`
renders as `+∞, -Infinity renders as -∞, a non-numeric (string)`
weight renders `Error, and a null weight renders Error (dev).`
(numberParsing.ts:89-98; requirements:891; successions:653; counts:681;
affinities:532; coverings:533)

### FR-PR — Weight input (shared `WeightInput; used by all five)`

- **FR-PR-16 — Weight text parsing. The weight field is a text input parsed by**
`parseWeightValue on each change: case-insensitive infinity/inf/∞ →`
`Infinity; -infinity/-inf/-∞ → -Infinity; a numeric string with a`
`k/m/b/t suffix (×1e3/1e6/1e9/1e12) is multiplied and, when the result`
is an integer, rounded to that integer (otherwise the raw string is kept);
otherwise `parseInt is applied and, on NaN, the raw string is kept`
(an invalid/string value that fails validation later). (numberParsing.ts:23-60; WeightInput:41-43)
- **FR-PR-17 — Infinity buttons. The weight control provides **`+∞ and -∞`
buttons that set the value to `Infinity / -Infinity directly.`
(WeightInput:86-103)
- **FR-PR-18 — Weight placeholder text. Weight placeholders are editor-specific:**
Requirements/Successions/Counts use `e.g., -1, -10, ∞; Affinities uses`
`e.g., 1, 10, ∞. Default WeightInput label is Weight (priority).`
(requirements:822; successions:585; counts:632; affinities:474; WeightInput:37-39)

### FR-PR — Shift Type Requirements (`/shift-type-requirements)`

- **FR-PR-20 — Form defaults. Add-form defaults: **`description='',`
`shift_type=[], shift_type_coefficients=[], required_num_people=1,`
`qualified_people=[], preferred_num_people=undefined, date=[],`
`weight=-1. (requirements:208-217,232-242)`
- **FR-PR-21 — Single-select shift type (radio). The **`Shift Types * selector`
is single-select via radio inputs (`inputType="radio",`
`inputName="shift-type-requirement-shift-type"). Selecting an option`
**replaces the selection with exactly that one id (**`[id]), and re-syncs the`
coefficient rows to that single selection. Options exclude the `OFF item and`
exclude any group whose members include `OFF.`
(requirements:443-456,458-471,602-609)
- **FR-PR-22 — Required number of people. **`Required Number of People * is a`
numeric input (`min="0") storing an integer or ''. On change: empty → '';`
otherwise `parseInt (guarded so an exact 0 is kept, not treated as`
falsy). Additionally, if the newly parsed required value equals the current
preferred value — or the current preferred value is `'' — preferred is reset`
to `undefined. Stored to backend as requiredNumPeople.`
(requirements:625-647; CON-SEM)
- **FR-PR-23 — Preferred number of people (optional, coupled to required).**
`Preferred Number of People (optional) is a numeric input (min="1"). Its`
displayed value falls back to the required value when preferred is unset
(`formData.preferred_num_people ?? formData.required_num_people). On change:`
empty → `''; a value parsing to NaN keeps the previous preferred; a value`
**equal to the current required normalizes to **`undefined; otherwise the`
parsed integer is stored. Placeholder:
`Will automatically be set to required number of people if left empty.`
(requirements:662-688)
- **FR-PR-24 — Weight visibility tied to preferred≠required. Weight is only**
meaningful when the preferred number differs from the required number
(`preferredNumPeopleDiffersFromRequired: preferred is defined, non-empty, and`
not equal to required). When true, the shared `WeightInput is shown and used.`
When false, no weight input is shown; instead the label `Weight (priority) is`
shown above disabled italic text:
`Weight is not needed when the preferred number of people equals the required number.`
(requirements:75-79,473,813-833)
- **FR-PR-25 — Weight forced when unused. On build, when preferred does not**
differ from required, the saved `preferredNumPeople is undefined and the`
saved `weight is forced to -1 regardless of the field's value; when it does`
differ, the entered preferred and weight are saved. (requirements:353-371)
- **FR-PR-26 — Qualified people stored as explicit ****`[ALL]`****. **`Qualified People *`
is a multi-select over people items + groups. When editing a stored
requirement whose `qualifiedPeople is null/undefined, the form normalizes`
it to `[ALL]; saving [ALL] back is intentional (backend treats null as`
all-people, per CON-SEM). (requirements:69-73,263-267,749-763)
- **FR-PR-27 — Dates multi-select. **`Dates * is a multi-select over date items +`
groups; stored as `date: string[]. (requirements:774-804)`
- **FR-PR-28 — Coverage warnings banner. Above the form, a warning banner is**
shown whenever there are undefined and/or duplicate (date, shift type) pairs
across all requirements. See FR-PR-40..42 for computation and exact copy.
(requirements:527-563)
- **FR-PR-29 — Card content. Each requirement card shows (when present):**
optional description as a heading; `Shift Types: (comma-joined ids);`
`Coefficients: as [id, coefficient] pairs comma-joined (only when`
`shiftTypeCoefficients present); Required: <n> with  (Preferred: <n>)`
appended when `preferredNumPeople is truthy; Weight: <value> (only when`
`preferredNumPeople is defined and differs from requiredNumPeople);`
`Qualified: (comma-joined); Dates: (comma-joined).`
(requirements:867-908)

### FR-PR — Shift Type Successions (`/shift-type-successions)`

- **FR-PR-30 — Form defaults. Add-form defaults: **`description='', person=[],`
`pattern=[], date=[], weight=-1. (successions:64-70,85-95)`
- **FR-PR-31 — People multi-select. **`People * is a multi-select over people`
items + groups; stored as `person: string[]. (successions:390-425)`
- **FR-PR-32 — Ordered pattern by appending. **`Shift Type Pattern * (click to add shift types) presents every shift type item and group (including OFF and`
`ALL) as clickable buttons; clicking one `**appends its id to the pattern.**
**Duplicates are allowed and order is significant (the pattern is an ordered**
sequence, e.g. `Evening → Day). (successions:427-457,241-247)`
- **FR-PR-33 — Pattern reorder & remove. When the pattern is non-empty a**
`Pattern Order: (drag to reorder) display renders each entry as a`
draggable `RemovableTag. Each tag has an × remove button`
(`title="Remove \"<id>\"") that removes that single position; drag-and-drop`
between inter-tag gaps reorders positions (gap-based insertion with
before/after decided by pointer vs element midpoint).
(successions:459-526,249-323; RemovableTag:105-116)
- **FR-PR-34 — Card content. Each succession card shows: optional description**
heading; `People: (comma-joined); Pattern: as chips joined by →`
arrows in order; `Weight: (via getWeightWithPositivePrefix); Dates:`
(comma-joined, only when non-empty). (successions:620-663)

### FR-PR — Shift Counts (`/shift-counts)`

- **FR-PR-50 — Form defaults. Add-form defaults: **`description='', person=[],`
`count_dates=[], count_shift_types=[], count_shift_type_coefficients=[],`
`expression='x >= T', target=0, weight=-1. (counts:89-98,114-124)`
- **FR-PR-51 — People / dates / shift-type multi-selects. **`People *,`
`Count Dates *, and Count Shift Types * are each multi-selects over the`
corresponding items + groups (shift-type list includes `OFF and ALL).`
Stored as `person, countDates, countShiftTypes.`
(counts:413-527)
- **FR-PR-52 — Expression select. **`Expression * is a dropdown over`
`SUPPORTED_EXPRESSIONS, in order: |x - T|^2, x >= T, x <= T, x > T,`
`x < T, x = T. Stored as expression. (counts:557-584; scheduling.ts:158)`
- **FR-PR-53 — Target value. **`Target Value * is a numeric input`
(`min="0" step="1", placeholder e.g., 5). On change: empty → ''; a value`
that is an integer is stored as a number; a non-integer numeric string is kept
as the raw string (fails validation). Stored as `target.`
(counts:586-621)
- **FR-PR-54 — Canonical shift-type ordering on save. On build, **`countShiftTypes`
is submitted as the user's selection but is re-sorted to canonical entry order
for coefficient validation, and `updatePreferencesByType normalizes`
`countShiftTypes and countShiftTypeCoefficients to canonical entry order.`
(counts:218-238)
- **FR-PR-55 — Card content. Each shift-count card shows: optional description**
heading; `People: (comma-joined); Expression: rendered as the expression`
string with `T textually replaced by the target value, in a monospace code`
span; `Weight:; Count Dates: (comma-joined); Count Shift Types:`
(comma-joined); `Coefficients: as [id, coefficient] pairs (only when`
present). (counts:667-699)

### FR-PR — Shift Affinities (`/shift-affinities)`

- **FR-PR-60 — Form defaults. Add-form defaults: **`description='', date=[],`
`people1=[], people2=[], shift_types=[], weight=1. Note weight defaults`
to `+1 here (encourage), unlike the -1 default of the other three editors.`
(affinities:64-71,85-95)
- **FR-PR-61 — Four multi-selects. **`Dates * (date items+groups),`
`People 1 * and People 2 * (people items+groups), and Shift Types *`
(shift-type items+groups, including `OFF/ALL) are each multi-selects.`
Stored as `date, people1, people2, shiftTypes. (affinities:312-464)`
- **FR-PR-62 — Card content. Each affinity card shows: optional description**
heading; `Dates:, People 1:, People 2:, Shift Types: (each`
comma-joined); `Weight: (via getWeightWithPositivePrefix). (affinities:509-536)`

### FR-PR — Shift Type Coverings (`/shift-type-coverings)`

The covering editor is the **only hard-reified card editor in the set. Its**
stored preference encodes a Boolean OR constraint that the solver must
satisfy — a preceptee may not work a covered shift type on a covered date
without a preceptor also working that shift type. The `weight field is`
accepted for shape compatibility and validated, but the **current**
**backend does not read ****`preference.weight — every valid weight produces`**
the same hard implication (CON-SEM-07; see FR-PR-86 for the full note on
the misleading instructions-panel copy). The editor does not enforce
any weight-sign or non-positive constraint.

- **FR-PR-80 — Form defaults. Add-form defaults: **`description='',`
`date=[], preceptors=[], preceptees=[], shift_types=[], weight=1.`
(coverings:46, 65-72)
- **FR-PR-81 — Preceptors multi-select (required). **`Preceptors (must cover) *`
is a multi-select over people items + groups. Stored as
`preceptors: (string | string[])[] — the editor wraps the user's selection`
in an outer single-element array on save: `preceptors: [selected]`
(page.tsx:158). The nested form is the canonical representation: top-level
element = one equation; inner list = the OR alternative group of people.
(coverings:355-379, 158)
- **FR-PR-82 — Preceptees multi-select (required). **`Preceptees (must be covered) * is a multi-select over people items + groups. Stored as`
`preceptees: (string | string[])[] in the same nested form as`
`preceptors. (coverings:391-417, 159)`
- **FR-PR-83 — Shift types multi-select (required). **`Shift Types * is a`
multi-select over shift-type items + groups (no `OFF exclusion in the`
editor). Stored as `shiftTypes: (string | string[])[] in the same nested`
form. (coverings:430-455, 160)
- **FR-PR-84 — Dates multi-select (optional, exposed in the UI but not**
**persisted — current product bug, AND the current backend treats**
**empty/missing as no dates anyway). **`Dates (leave empty for all dates) is a multi-select over date items + groups. The label is`
misleading: under current strict parity, **empty/missing ****`date`**** does**
**NOT mean "all dates" — it produces zero covering constraints**
(see C3 CON-SEM-07). The schema is `date?: string[] (the field is`
**optional).    The current editor does not include ****`date`**** in**
** ****`buildPrefFromForm`**** regardless of whether the user picked dates —**
 the selection is tracked only while the current form draft remains
 open; Add/Update drops it, and `resetForm clears it; a later edit`
 only restores `rule.date if the existing stored/imported rule`
 already has one
 (`page.tsx:86-94, 122-129, 180-181).`
 (coverings:155-162.) **Under strict parity, do not implement the**
** "fix ****`buildPrefFromForm`**** to include ****`date`****" path; the future-fix**
 snippet (`...(formData.date.length > 0 ? { date: formData.date } : {}))`
 is described as a non-parity follow-up in
 `decision-logs/02-shift-type-covering-preference/index.md.`
 (coverings:312-348.)
- **FR-PR-85 — Hard-reified save shape. The save shape is the only place where**
the editor wraps the user's flat `CheckboxList selections in a single`
outer-element nested array:
    ```ts
    preceptors: [formData.preceptors],
    preceptees: [formData.preceptees],
    shiftTypes: [formData.shift_types],
    ```
  i.e. one equation per rule. This is the canonical representation consumed
  by the backend C3 handler, which expands the cross-product
  (preceptor-group × preceptee-group × shift-type-group) and reifies the
  hard OR. (coverings:155-162; CON-SEM-07)
- **FR-PR-86 — Weight parsing and semantics. Weight is parsed with the**
shared `WeightInput and isValidWeightValue: valid values are finite`
numbers, `+Infinity, and -Infinity. Default is 1. Unlike`
Requirements/Counts, the editor does **not enforce a sign or**
non-positive constraint — the covering semantics accept any valid
weight. **The current backend (****`core/nurse_scheduling/preference_types.py:622-633, :701-721`****) does not read ****`preference.weight`**** at all — every valid**
weight produces the same hard implication
`any_preceptee <= at_least_one_preceptor. The weight field is`
accepted for schema compatibility, validated, stored, and displayed,
but the solver treats every covering preference as hard. The
instructions panel copy in the editor ("Use 1 (default) for a soft
preference or +Infinity (∞) for a hard require...") is
semantically misleading against the current backend; the verbatim
string is preserved here for strict parity, but a rebuilder should
treat the UI copy as a known-bug quirk. (coverings:147-149, 31;
numberParsing.ts:131-141; CON-SEM-07; see
`behavior-test-catalog/index.md:278-283 CC-B8.)`
- **FR-PR-87 — Reference cascade parity. The reference-cascade handlers**
(`applyReferencesForIdChange / applyPreferencesForIdDeletion in`
`schedulingReferenceUpdates.ts) rewrite/filter the nested preceptors,`
`preceptees, and shiftTypes trees for PEOPLE and SHIFT_TYPES renames/`
deletions, and the flat `date array for DATES renames/deletions. A`
covering rule whose `preceptors, preceptees, or shiftTypes empties`
after filtering is **dropped; emptying only **`date keeps the rule`
(date is optional). See spec 06 for full cascade detail. (coverings is
exercised by `schedulingReferenceUpdates.test.ts:327-477 in the`
`shift type covering cascade describe block.)`
- **FR-PR-88 — Card content. Each covering card shows: optional description**
heading; `Preceptors: (comma-joined ids, flattened from the nested tree);`
`Preceptees: (comma-joined); Shift Types: (comma-joined); Dates:`
(comma-joined, only when non-empty); `Weight: (via`
`getWeightWithPositivePrefix). The helper summarizeIds`
(`page.tsx:555-557) flattens the nested reference tree to a single`
comma-joined string. When an id list is empty after flattening, the
rendered label is the literal string `(all). (coverings:507-535)`
- **FR-PR-89 — Editor parity with other card editors. The covering editor**
reuses the same shared shell behaviors (FR-PR-01..FR-PR-15): page title
`Shift Type Coverings; instructions panel (7 items — see below);`
`Add Shift Type Covering toggle button; Update button label when`
editing, `Add when adding (coverings:490); Description (optional)`
field with placeholder `e.g., Lil must always be paired with Anna on Day shift (coverings:306); global Enter=save / Escape=cancel under the`
`isComposing || keyCode 229 IME guard (coverings:192-212);`
`useTabSwitchWarning(isFormVisible) (coverings:74); scroll save/restore`
on edit (coverings:118, 128); empty-state message
`No covering rules yet. Click "Add Shift Type Covering" to get started.`
(coverings:502); card operations Edit / Duplicate / Delete
(no-confirm) / drag-reorder; `dismissEditingDraft() before any card`
mutation (coverings:214-218, 220-234). The duplicate label, insert-after
semantics, and `getUniqueCopyLabel rules (FR-PR-13) are inherited from`
the shared `duplicatePreferenceByType helper.`
- **FR-PR-90 — Covering editor instructions panel. The 7 bullet items**
shown verbatim in the instructions panel (coverings:76-84):
  1. `Define a shift type covering rule to enforce that whenever someone in Preceptees works the chosen shift, at least one person in Preceptors also works it.`
  2. `Pick the Dates this rule applies to. Leave empty to apply to all dates.`
  3. `Select Preceptors — these are the senior staff who must cover (e.g. supervising nurses).`
  4. `Select Preceptees — these are the people who must be covered (e.g. students, mentees).`
  5. `Select the Shift Types this rule applies to (e.g. Day shift).`
  6. `Set the Weight. Use 1 (default) for a soft preference or +Infinity (∞) for a hard require the solver cannot violate.`
  7. `Use Edit / Duplicate / Delete on a saved rule to manage it. Drag cards to reorder.`

### FR-PR — Shared shift-type coefficient sub-editor (`CountShiftTypeCoefficientFields)`

Used by **Requirements (label **`Shift Type) and `**Counts (label**
`Count Shift Type). Backend meaning per CON-SEM.`

- **FR-PR-70 — One numeric input per eligible shift type. The sub-editor renders**
a `<label> Coefficients heading and, for each `*eligible shift-type id, a*
numeric input (`min="1" step="1"). Eligible ids`
(`getCoefficientShiftTypeIds) are: every shift-type `**item whose id is in the**
expanded selection, plus every shift-type **group that is non-empty and whose**
members are all in the expanded selection. Inputs are rendered in canonical
entry order. (CountShiftTypeCoefficientFields:40-96; countShiftTypeCoefficients.ts:44-61)
- **FR-PR-71 — Empty state. When no coefficient-eligible shift type is selected,**
the sub-editor shows italic text `Coefficients are not needed when no <singular-label> is selected. where <singular-label> is the lowercased label`
(`shift type for Requirements, count shift type for Counts).`
(CountShiftTypeCoefficientFields:49-63)
- **FR-PR-72 — Per-input parse/clamp. On input change: empty → **`'' (kept blank);`
a `NaN parse keeps the raw string; otherwise Math.max(1, parsedInt) — i.e.`
values below 1 are clamped up to 1. Editing one input rewrites the paired list
for the eligible ids, preserving other ids' values.
(CountShiftTypeCoefficientFields:74-84; countShiftTypeCoefficients.ts:76-86)
- **FR-PR-73 — Selection ↔ coefficient sync. Toggling the shift-type selection**
re-syncs coefficient pairs to the currently eligible ids
(`syncCoefficientPairs), dropping pairs no longer eligible and adding blank`
pairs for newly eligible ids. (requirements:443-456; counts:310-334; countShiftTypeCoefficients.ts:63-74)
- **FR-PR-74 — Blank coefficients dropped on save; only saved when non-empty.**
On build, blank (`'') coefficient pairs are dropped; the coefficient array is`
attached to the saved preference **only when at least one pair remains**
(`shiftTypeCoefficients / countShiftTypeCoefficients).`
(requirements:353-371; counts:218-238; countShiftTypeCoefficients.ts:130-138)

## Validation Rules & Messages

All messages below are **verbatim. Fields marked **`* are required. On Save,`
`validateForm collects all errors, sets them, and blocks persistence if any`
exist. Editing a field clears its own error (and, for shift-type toggles that
feed coefficients, also clears the coefficient errors).

### Weight helpers (shared, `numberParsing.ts)`

- `isValidWeightValue: a value is valid iff it is a number that is finite OR`
exactly `Infinity/-Infinity; any string (parse failure) is invalid.`
(numberParsing.ts:131-141)
- `isValidNumberValue: valid iff number and finite (no infinities).`
(numberParsing.ts:147-153)
- `isWeightNonPositive: number and <= 0. (numberParsing.ts:143-145)`

### Shift Type Requirements

| Field | Condition | Message |
| --- | --- | --- |
| shift_type | selection empty | `At least one shift type must be selected` |
| shift_type | > 1 selected AND no coefficient/overlap error | `Select exactly one shift type or group` |
| required_num_people | `'' (blank)` | `Required number of people must be a valid number` |
| required_num_people | not a valid finite number | `Required number of people must be a valid number` |
| required_num_people | number `< 0` | `Required number of people must be at least 0` |
| preferred_num_people | present, non-empty, not a valid number | `Preferred number of people must be a valid number` |
| preferred_num_people | number `< 1` | `Preferred number of people must be at least 1` |
| preferred_num_people | number `< required (required is a number)` | `Preferred number of people must be greater than required number of people` |
| qualified_people | selection empty | `At least one person must be selected` |
| date | selection empty | `At least one date must be selected` |
| weight | only when preferred≠required AND weight invalid | `Weight must be a valid number, Infinity, or -Infinity` |
| weight | only when preferred≠required AND number `> 0` | `Weight must be 0 or less (including -Infinity)` |
| coefficients | (see coefficient table below) | — |

(requirements:290-351)

### Shift Type Successions

| Field | Condition | Message |
| --- | --- | --- |
| person | selection empty | `At least one person must be selected` |
| pattern | fewer than 2 entries | `At least 2 shift types must be selected for a succession pattern` |
| date | selection empty | `At least one date must be selected` |
| weight | invalid | `Weight must be a valid number, Infinity, or -Infinity` |

(successions:129-150)

### Shift Counts

| Field | Condition | Message |
| --- | --- | --- |
| person | selection empty | `At least one person must be selected` |
| count_dates | selection empty | `At least one date must be selected` |
| count_shift_types | selection empty | `At least one shift type must be selected` |
| expression | not one of `SUPPORTED_EXPRESSIONS` | `Please select a valid expression` |
| target | not an integer `>= 0` | `Target must be a non-negative integer` |
| weight | invalid | `Weight must be a valid number, Infinity, or -Infinity` |
| weight | expression is `\|x - T\|^2 AND weight not non-positive` | `Weight must be non-positive for shift count with "\|x - T\|^2"` |
| coefficients | (see coefficient table below) | — |

(counts:168-216)

### Shift Affinities

| Field | Condition | Message |
| --- | --- | --- |
| date | selection empty | `At least one date must be selected` |
| people1 | selection empty | `At least one person must be selected for People 1` |
| people2 | selection empty | `At least one person must be selected for People 2` |
| shift_types (error key `shiftTypes)` | selection empty | `At least one shift type must be selected` |
| weight | invalid | `Weight must be a valid number, Infinity, or -Infinity` |

(affinities:131-156)

### Shift Type Coverings

| Field | Condition | Message |
| --- | --- | --- |
| preceptors | selection empty | `At least one preceptor must be selected` |
| preceptees | selection empty | `At least one preceptee must be selected` |
| shift_types (error key `shiftTypes)` | selection empty | `At least one shift type must be selected` |
| weight | invalid (string / NaN) | `Weight must be a valid number, Infinity, or -Infinity` |
| date | selection empty | (no error — date is optional) |

(coverings:132-153)

### Shift-type coefficients (shared; Requirements & Counts)

| Condition | Message |
| --- | --- |
| a non-blank coefficient is not an integer `>= 1` | `Coefficient for <shiftTypeId> must be an integer of at least 1 (per offending id; multiple joined by newline)` |
| two selected coefficient sources expand to a shared shift type | `Shift type coefficients overlap: <sourceA>, <sourceB> include <sharedShiftTypeId>` |

Per-id integer errors take precedence: if any per-id error exists, the overlap
check result is not surfaced (and, in Requirements, the "select exactly one"
error is also suppressed while coefficient errors exist).
(countShiftTypeCoefficients.ts:108-139; requirements:297-311; counts:184-195)

### Coverage warnings (Requirements only) — see FR-PR-40..42

## Edge Cases & Quirks

- **EDGE-PR-01 — Delete has no confirmation. Delete removes a card immediately;**
there is no confirm dialog and no undo prompt at the editor level. (DraggableCardList:141-147)
- **EDGE-PR-02 — Any list op discards an open draft. Duplicate, Delete, and**
Reorder each call `dismissEditingDraft(), silently cancelling any open`
add/edit form (its unsaved changes are lost) before executing.
(requirements:421-441)
- **EDGE-PR-03 — Requirements weight is forced, not just hidden. When**
preferred equals required (or preferred is unset), the saved weight is `-1`
and saved `preferredNumPeople is undefined, even if the user previously`
typed another weight while preferred differed. (requirements:353-371)
- **EDGE-PR-04 — Required-change auto-normalizes preferred. Typing a required**
value that equals the current preferred (or when preferred is `'') resets`
preferred to `undefined, which in turn hides the weight input. (requirements:637-646)`
- **EDGE-PR-05 — Preferred equal to required normalizes to undefined. Typing a**
preferred value equal to required stores `undefined (not the number), so it is`
treated as "no distinct preference." (requirements:677-679)
- **EDGE-PR-06 — Affinity default weight is +1. Affinities default to encourage**
(`weight=1); the other three editors default to discourage (weight=-1).`
(affinities:71; requirements:216; successions:69; counts:97)
- **EDGE-PR-07 — Requirements shift-type options exclude OFF. The requirement**
single-select excludes the `OFF item and any group that contains OFF;`
Successions, Counts, and Affinities shift-type pickers include `OFF (and`
`ALL). (requirements:458-471 vs successions:445, counts:505-515, affinities:442-452)`
- **EDGE-PR-08 — Pattern allows duplicates and reserved ids. The succession**
pattern may repeat the same shift type and may include `OFF/ALL; order is`
significant. Minimum length is 2. (successions:445-455,136-138)
- **EDGE-PR-09 — Weight k/m/b/t suffix rounding. A weight like **`1.5k →`
`1500; a suffix result that is not an integer is left as the raw string and`
fails weight validation. `parseInt fallback means e.g. 10abc parses to 10.`
(numberParsing.ts:31-59)
- **EDGE-PR-10 — Coefficient clamp vs validation. Sub-input typing parses**
with `Number.parseInt(value, 10) and clamps < 1 up to 1 live`
(`Math.max(1, …)), so decimal numeric strings such as 1.5, 2.9,`
or `0.5 are silently truncated/rounded to 1/2/1 before`
validation. The per-id integer validation message
`Coefficient for <shiftTypeId> must be an integer of at least 1`
fires only for values that remain invalid **after the parse/clamp**
(e.g. raw strings from `NaN parsing such as abc). Blank input`
is always allowed and dropped.
(CountShiftTypeCoefficientFields:74-84;
countShiftTypeCoefficients.ts:116-124)
- **EDGE-PR-11 — Group coefficient eligibility is all-or-nothing. A shift-type**
group appears as a coefficient input only when it is non-empty and *every*
member is within the expanded selection; otherwise only individual member items
appear. Overlap between a group and its members is caught by the overlap error.
(countShiftTypeCoefficients.ts:57-59,88-105)
- **EDGE-PR-12 — Number inputs blur on wheel. All numeric inputs**
(`NumberInput) blur on wheel scroll by default, preventing accidental value`
changes from scrolling. (NumberInput.tsx:26-45)
- **EDGE-PR-13 — Weight card display errors. A weight that somehow remained a**
string renders `Error on the card; a null weight renders Error (dev) and`
logs to console. (numberParsing.ts:89-98)
- **EDGE-PR-14 — Coverage warning date labelling. For undefined pairs, when the**
set of missing concrete dates for a shift type exactly equals a date group's
expanded members, the group id is shown; otherwise the concrete date ids are
listed comma-separated. (requirements:97-109,178-181)
- **EDGE-PR-15 — Covering default weight is +1. Coverings default to encourage**
(`weight=1); Requirements/Successions/Counts default to discourage`
(`weight=-1); Affinities default to encourage (weight=1).`
(coverings:46; requirements:216; successions:69; counts:97; affinities:71)
- **EDGE-PR-16 — Covering save shape is wrapped once. The editor writes**
`preceptors: [formData.preceptors] (a single outer element containing the`
flat user selection) — the form's flat shape is *not the persisted shape.*
Editing a rule re-reads via `flattenIds(rule.preceptors) so the user`
re-sees the flat form. (coverings:158, 109)
- **EDGE-PR-17 — Covering ****`date`**** is preserved on edit-load but always**
**dropped on save (current product bug). On edit, **`date: rule.date ?? []`
restores the saved date array (coverings:108); on save, `buildPrefFromForm`
does **not include **`date regardless of the user's selection`
(coverings:155-162). So the editor's date selector currently exists
in the UI but has no effect on the persisted object — a user picking
 Dates in the editor loses the selection on Add/Update. **Under the**
** current C3 backend, omitted/null/empty covering ****`date`**** is a**
** no-op (zero covering constraints), not "all dates" — see spec 11**
 FR-CV-12 and C3 CON-SEM-07. So even if the editor were fixed to
 persist selected dates, the current backend would still treat an
 empty selection as no constraints. To target "all dates" the
 frontend must emit `date: [ALL] explicitly. `**Under strict parity,**
** do not implement the "fix ****`buildPrefFromForm`**** to include ****`date`****" path;**
 the future-fix snippet is described as a non-parity follow-up in
 `decision-logs/02-shift-type-covering-preference/index.md. See`
 FR-CV-07/12, EDGE-CV-02 in spec 11.
- **EDGE-PR-18 — Covering cascade drops emptied rules (delete only;**
**rename never drops). Deleting a referenced person / shift**
type filters the nested reference trees via `filterReferenceIds;`
if any of `preceptors, preceptees, or shiftTypes collapses to`
empty, the entire covering rule is dropped in the second-pass
required-field check. **Renaming a referenced person / shift type**
recursively rewrites matching IDs via `mapReferenceIdTree /`
`renameReferenceIds and `**never drops covering rules — even**
when no match is found in a field, the field is left intact. Empty
`date alone is `**not enough to drop a rule. (schedulingReferenceUpdates.ts**
rename at `:163-193, delete at :298-325, drop at :352-356;`
see spec 06 for the full cascade rule.)
- **EDGE-PR-19 — Covering card ****`(all)`**** rendering. The card helper**
`summarizeIds flattens a nested tree and joins ids with , ; an empty`
flattened list renders the literal string `(all). (coverings:555-557)`

### Coverage warning computation (Requirements) — FR-PR-40..42

- **FR-PR-40 — Concrete-pair coverage. Coverage is computed over all**
requirements by expanding each requirement's `date and shiftType selections`
(frontend groups → members; the `OFF shift type is excluded from staffing).`
Each concrete `(date, shiftType) pair is keyed by its JSON tuple. The first`
requirement to cover a pair "owns" it. (requirements:111-160)
- **FR-PR-41 — Undefined staffing warning. For each staffed shift-type item,**
any concrete date not covered by any requirement is collected; shift types with
at least one missing date are listed. The banner header is `Requirement coverage warnings. The undefined section text is:`
`Undefined staffing requirements: <N> date/shift type pairs have no requirement, so the solver may assign an arbitrary number of people. followed`
by a bulleted list of `<shiftTypeId>: <datesLabel> (see EDGE-PR-14).`
(requirements:527-546,162-188)
- **FR-PR-42 — Duplicate staffing warning. When a pair is covered more than**
once, a duplicate entry `<dateId> / <shiftTypeId> (requirements <i> and <j>)`
(1-based indices) is recorded. The duplicate section text is:
`Duplicate staffing requirements: <M> date/shift type pairs are covered by more than one requirement. The solver will apply all matching requirements.`
followed by a bulleted list showing **the first 5 duplicate entries, then a**
single `... bullet if there are more than 5.`
(requirements:149-160,547-561; `warningExamplesLimit = 5)`

## Acceptance Criteria

UI-agnostic; each is observable regardless of presentation.

- **AC-PR-01 Opening the add form for any editor yields a blank draft with that**
editor's documented defaults (FR-PR-20/30/50/60), and closing it discards the
draft with no change to the stored list.
- **AC-PR-02 Saving a valid add appends exactly one card to the end of the list;**
saving a valid edit replaces the card at the edited position and preserves list
length and order.
- **AC-PR-03 Deleting a card removes exactly that card with no confirmation**
prompt; remaining cards keep their relative order.
- **AC-PR-04 Duplicating a card inserts a deep copy immediately after the source**
card, with a description derived per FR-PR-13 (`" copy", then " copy 2",`
…, or `Copy/Copy 2 when the source has no description), and leaves all other`
cards unchanged.
- **AC-PR-05 Dragging a card to a new position produces the list order implied**
by drop-above/drop-below relative to the target card's midpoint.
- **AC-PR-06 Every validation condition in the Validation tables blocks Save and**
surfaces the corresponding verbatim message; correcting a field clears its
message.
- **AC-PR-07 (Requirements) The shift-type selector accepts at most one id**
(radio). Selecting an option replaces any prior selection; validation rejects an
empty selection with `At least one shift type must be selected.`
- **AC-PR-08 (Requirements) When preferred equals required (or preferred is**
unset), no functional weight input is available and the saved preference has
`preferredNumPeople undefined and weight -1; when preferred differs, the`
entered weight must be `<= 0 (including -Infinity) or Save is blocked with`
`Weight must be 0 or less (including -Infinity).`
- **AC-PR-09 (Requirements) A stored requirement with no qualified-people scope**
loads into the form as `[ALL], and saving preserves an explicit [ALL].`
- **AC-PR-10 (Requirements) With overlapping or missing **`(date, shift type)`
coverage across requirements, the coverage banner appears with the exact
undefined/duplicate copy of FR-PR-41/42, listing at most the first 5 duplicate
examples followed by `... when more exist.`
- **AC-PR-11 (Successions) The pattern is an ordered, duplicate-allowing**
sequence built by appending; a pattern with fewer than 2 entries is rejected
with `At least 2 shift types must be selected for a succession pattern; removing`
and drag-reordering pattern entries produce the expected order.
- **AC-PR-12 (Counts) The expression dropdown offers exactly **`|x - T|^2,`
`x >= T, x <= T, x > T, x < T, x = T; target rejects non-integer or`
negative values with `Target must be a non-negative integer; with |x - T|^2`
a positive weight is rejected with the verbatim non-positive message.
- **AC-PR-13 (Affinities) All four scopes (dates, People 1, People 2, shift**
types) are required, each with its verbatim message; the default weight is `+1.`
- **AC-PR-14 (Coefficients) A coefficient input appears per eligible shift type**
only; blank inputs are dropped on save and the coefficient array is attached
only when at least one value remains; a non-blank value below 1 is clamped to 1
live and decimal numeric strings are truncated to their integer prefix
via `Number.parseInt (so 1.5 → 1, 2.9 → 2); values that remain`
invalid after the parse/clamp (e.g. raw `NaN strings) are rejected`
with `Coefficient for <id> must be an integer of at least 1;`
overlapping sources are rejected with the verbatim overlap message.
- **AC-PR-15 With an open draft, invoking Duplicate/Delete/Reorder discards the**
draft before applying the operation.
- **AC-PR-16 When an underlying entity list (people/dates/shift types) is empty,**
the corresponding selector shows the verbatim setup-guidance message instead of
a picker.

## Cross-References

- **C3 — Preference / Constraint Semantics (CON-SEM) — backend meaning of every**
field written by these editors: weight math (positive = encourage, negative =
discourage, `±Infinity = hard constraint), the six shift-count expressions,`
shift-type coefficient semantics, `requiredNumPeople/preferredNumPeople`
interplay, `qualifiedPeople/date null-vs-ALL resolution, and`
group/keyword expansion (`OFF, ALL). The covering editor's hard-OR`
reification is captured in CON-SEM-07 — **note that the current**
**`shift_type_covering`**** handler does not read ****`preference.weight,`**
so the covering constraint is always hard regardless of the saved
weight (see FR-PR-86 and `behavior-test-catalog/index.md CC-B8). See`
`../contracts/index.md.`
- **C1 — YAML Scenario Schema (CON-YAML) — the persisted/exported field names**
and key ordering these editors produce (`shiftType, shiftTypeCoefficients,`
`qualifiedPeople, countShiftTypes, countShiftTypeCoefficients, people1,`
`people2, shiftTypes, preceptors, preceptees, etc.).`
- **Spec 06 — Reference Integrity (RI) — the rename/delete cascade for**
preference reference fields and coefficient IDs; the covering editor's
nested `preceptors/preceptees/shiftTypes trees and optional date`
field participate in the cascade and required-field drop.
- **Spec 11 — Shift Type Coverings Editor — focused parity spec for the**
covering editor's hard-reified semantics, reference-tree save shape, and
page-level UX behavior; cited for parity-bar rigor but not strictly required
(this artifact plus the page tests already give parity coverage).
- **Sibling editor artifacts — the shared card-shell, weight input, coefficient**
sub-editor, and `DraggableCardList behaviors described here are reused by the`
other preference editors (At Most One Shift Per Day, Shift Requests); see their
artifacts for editor-specific fields.
