---
kind: spec
title: "Shift Requests Editor"
---

# Shift Requests Editor

## Purpose & Scope

The Shift Requests editor (Tab "5. Shift Requests") is the most complex editor in the
app. It presents a person × date matrix where each cell aggregates the shift-type
weight preferences for one (person, date) pair, plus a set of history columns capturing
each person's recently-assigned shift types. It supports three interaction paths:

- **Normal mode** — click a cell to open a per-(person, date) preference editor, or click
  a history slot to open a history editor.
- **Quick Add mode** — select shift types + a weight, then click/drag over cells to apply,
  remove, or clear preferences and history in bulk.
- **CSV upload** — bulk-load a person × date preference matrix, or a per-person history
  shorthand.

This artifact specifies the **data/state rules** governing cell values, sign, opacity,
the delta engine, validation, and all user-facing messages. Colors are cited only as
non-binding reference. Source of truth:
`web-frontend/src/app/shift-requests/page.tsx`,
`web-frontend/src/components/ShiftPreferenceEditor.tsx`,
`web-frontend/src/components/WeightInput.tsx`,
`web-frontend/src/components/CheckboxList.tsx`,
`web-frontend/src/utils/numberParsing.ts`.

Underlying data type: `ShiftRequestPreference` = `{ type: SHIFT_REQUEST, person: string[],
date: string[], shiftType: string[], weight: number }`. **Editor-created and
modal-edited** shift requests have single-element `person` and
single-element `shiftType`. **Imported YAML** may also carry backend-
compatible `shift request` preferences with `person.length > 1` or
`shiftType.length > 1`; the importer preserves them with an "advanced
backend reference syntax" warning and the matrix/editor reads only
index `0` (`useSchedulingData.ts:909-915`, `shift-requests/page.tsx:877-880`).
`date` may hold multiple individual date IDs (compacted, see FR-SR-24) but
each preference references exactly one date-group or a set of individual
dates — never a mix.

## Functional Requirements

### Required-data gate

- **FR-SR-01** — The editor renders its main content only when **all** of the following
  hold (`hasRequiredData`, page.tsx:1390): a date range with both `startDate` and
  `endDate` is set, `dateData.items.length > 0`, `peopleData.items.length > 0`, and at
  least one shift type exists (`shiftTypeData.items.length > 0 || shiftTypeData.groups.length > 0`).
- **FR-SR-02** — When the gate is not satisfied, exactly one guidance message is shown,
  chosen in this priority order (page.tsx:1569-1593):
  1. If date range start/end is missing **or** `dateData.items.length === 0`: prompt to
     set up dates first, linking to the Dates tab (`/dates`).
  2. Else if `peopleData.items.length === 0`: prompt to set up people first, linking to
     the People tab (`/people`).
  3. Else (no shift types): prompt to set up shift types first, linking to the Shift
     Types tab (`/shift-types`).
  Exact strings are in the Validation table.

### Matrix structure (as data)

- **FR-SR-03** — **Rows** are the concatenation `[...peopleData.groups, ...peopleData.items]`
  (`getCombinedPeopleEntries`, page.tsx:751): people **groups** first, then individual
  people. A person row's leading label is `"{personIndex}. {id}"` where `personIndex` is
  the 1-based index of the person within `peopleData.items` (page.tsx:1780,1795); a group
  row's label is just its `id`. A row also shows the entry's `description` when present.
- **FR-SR-04** — **Columns** in order: (1) a sticky "People" label column; (2) history
  columns; (3) date columns being `[...dateData.groups, ...dateData.items]`
  (`getCombinedDateEntries`, page.tsx:747) — date **groups** first, then individual dates.
- **FR-SR-05** — **History column count** = `max(0, ...each person's history length) + 1`
  (`historyColumnsCount`, page.tsx:735). There is always exactly one extra column beyond
  the longest history row (for appending a newer entry).
- **FR-SR-06** — History columns are labeled/titled `H-{historyColumnsCount - index}` for
  rendered index `0..count-1` (page.tsx:1317,1320). Thus the leftmost history column is
  the highest H-number and the rightmost (`H-1`) is adjacent to the date columns.
- **FR-SR-07** — For a person with a shorter history, cells align to the **right**: the
  value at rendered `columnIndex` is `''` when `columnIndex < offset`, else
  `history[columnIndex - offset]`, where `offset = historyColumnsCount - history.length`
  (`getHistoryValue`, page.tsx:1244). **Note: `history[0]` is the **newest** entry
  (the most recent prior assignment), not the oldest.** `addPersonHistory` prepends
  new entries with `[shiftTypeId, ...person.history!]` (`useSchedulingData.ts:606`),
  so the array is in newest-first order. The UI labels the **highest H-number** under
  `history[0]` (newest) and the **lowest H-number** under the trailing entry
  (oldest); see `page.tsx:1816-1834`. The summary list (FR-SR-40) iterates
  `person.history` left-to-right, which is also newest-to-oldest.
- **FR-SR-08** — Only history cells with `index >= offset - 1` are clickable/interactive
  (`isClickable`, page.tsx:1819): the actual history entries plus exactly one empty
  padding cell to their left. Cells further left render blank and inert.
- **FR-SR-09** — People **group** rows have no history; all their history cells render an
  em-dash placeholder and are inert (page.tsx:1804-1812).
- **FR-SR-10** — A date column is treated as a **weekend** when its date item resolves
  (via `dateStrToDate`) to `getUTCDay()` 0 (Sunday) or 6 (Saturday) (`isWeekend`,
  page.tsx:864). Weekend styling is reference-only (purple tint on header and on empty
  cells). Date **groups** are never weekend-styled.

### Preference-cell aggregate value

- **FR-SR-11** — A cell's preference set is all preferences with `person[0] === personId`
  and `date.includes(dateId)` (`getShiftPreferences`, page.tsx:877). An empty set renders
  a blank cell (no aggregate) (page.tsx:1002).
- **FR-SR-12** — Preferences in a cell are sorted (`getPreferenceDisplay`, page.tsx:1005):
  primary by descending magnitude `|weight|`; ties broken by descending signed `weight`
  (positive before negative); further ties by ascending index within `getAllShiftTypes()`
  = `[...shiftTypeData.items, ...shiftTypeData.groups]` (page.tsx:741).
- **FR-SR-13** — Display count rule (page.tsx:1879): if the cell has **≤ 3** preferences,
  show all of them; otherwise show the top **2** and append a `+{remainingCount} more`
  line, where `remainingCount = total - 2`.
- **FR-SR-14** — Each shown preference renders as `"{shiftType} ({label})"` where `label`
  = `getWeightDisplayLabel(weight)` (e.g., `Day (+5)`) (page.tsx:1888).

### Preference-cell aggregate sign & opacity

- **FR-SR-15** — Aggregate **sign state** (page.tsx:1031): `all-positive` when every
  preference weight `> 0`; `all-negative` when every weight `< 0`; otherwise `mixed`.
  Reference colors: all-positive → green (`rgba(74,222,128,α)` / `text-green-800`);
  all-negative → red (`rgba(248,113,113,α)` / `text-red-800`); mixed → yellow
  (`rgba(250,204,21,α)` / `text-yellow-800`).
- **FR-SR-16** — **Opacity/intensity** α is `ratio = max(0.05, log2(maxWeight) / log2(1_000_000))`
  (page.tsx:1023-1028), where `globalMaxWeight = 1_000_000` and
  `maxWeight = min(1_000_000, max(over preferences of |weight| if finite else 1_000_000))`.
  Infinite-weight preferences are treated as magnitude 1,000,000; α is floored at 0.05.

### Normal-mode editing

- **FR-SR-17** — In normal mode (not Quick Add), clicking a preference cell opens the
  per-(person, date) **Shift Preference Editor** modal (`handleCellClick` →
  `openEditor`, page.tsx:1185,1053). The onClick handler is gated on `!isAddMode`
  (page.tsx:1873).
- **FR-SR-18** — In normal mode, clicking a clickable history cell opens the **History
  Editor** modal (`handleHistoryCellClick` → `openHistoryEditor`, page.tsx:1292; onClick
  gated on `isClickable && !isAddMode`, page.tsx:1829).
- **FR-SR-19** — The History Editor modal (page.tsx:2069-2117) titles "Edit History -
  {personId}" and "Position H-{historyColumnsCount - historyIndex}". Its only control is a
  `<select>` whose options are `-- Clear --` (value `""`) followed by one option per
  `shiftTypeData.items` entry rendered as `"{id} - {description}"` (page.tsx:2098-2103).
  Note history options come from **items only** (no shift-type groups). Changing the
  select immediately calls `handleSaveHistory` and closes the modal; a Cancel button also
  closes it. On save (page.tsx:1266): if `historyIndex < offset` and a non-empty type is
  chosen, append a new history entry (`addPersonHistory`); if a non-empty type at a real
  position, update that position (`updatePersonHistory` with type); if `-- Clear --` at a
  real position, **truncate history through that position** — the
  implementation calls `updatePersonHistory(personId, position, undefined)` which
  sets `newHistory = person.history!.slice(position + 1)`
  (`useSchedulingData.ts:636-639`). The selected entry and every **newer**
  entry in the newest-first array are dropped, and only older entries
  after the cleared position remain. (This matches the "drag to
  clear" semantic at FR-SR-33.) Selecting `-- Clear --` at a padding
  position does nothing.
- **FR-SR-20** — The "Current People History" summary's Edit button opens the History
  Editor targeting `historyColumnsCount - person.history.length` (the leftmost real
  history slot) (page.tsx:2020).

### Shift Preference Editor modal

- **FR-SR-21** — The modal (`ShiftPreferenceEditor.tsx`) titles "Shift Preference Matrix"
  and shows the Person and Date IDs. It renders a "Weight Scale Guide" info box and one
  table row per shift type (from `getAllShiftTypes()`, items then groups), each with: the
  shift-type id, its description (or "No description" when absent), a `WeightInput`, and a
  Status chip. The Status chip shows `—` when the weight is `0`, else
  `getWeightDisplayLabel(weight)` (ShiftPreferenceEditor.tsx:238).
- **FR-SR-22** — Editor state (`draftPreferences`) starts from `initialPreferences`
  (existing cell preferences). `getWeight` returns `0` for any shift type not in the
  draft. Setting a weight to `0` **removes** that shift type's preference; a non-zero
  weight adds or updates it (`handleWeightChange`, ShiftPreferenceEditor.tsx:52-74). An
  "Active Preferences Summary" lists non-neutral entries (numeric weights, sorted
  descending) when at least one exists.
- **FR-SR-23** — Modal buttons: **Clear All** empties the draft (all shift types → weight
  0); **Cancel** discards the draft and closes; **Save Preferences** validates then saves.
  Keyboard: `Enter` saves (unless an IME composition is active), `Escape` cancels
  (ShiftPreferenceEditor.tsx:110-117). **Save is blocked (silently, no persisted change
  and modal stays open) if any draft weight is invalid**; the guard string is `"Weight
  must be a valid number, Infinity, or -Infinity"` (ShiftPreferenceEditor.tsx:87,95).
  Saving replaces the cell's preferences via the delta engine with `clearFirst = true`
  (full replacement) (page.tsx:1069, 980-997).

### Delta engine (computeNewShiftPreferences)

- **FR-SR-24** — `computeNewShiftPreferences` (page.tsx:886-977) applies a list of
  `{personId, dateId, deltaPreferences, clearFirst?}` updates. For each update: it reads
  the current per-(person, date) preferences; if `clearFirst`, it starts from empty; it
  then applies each `{shiftTypeId, weight}` delta where **weight 0 removes** an existing
  shift-type preference (and a 0-weight new entry is skipped), and non-zero adds/updates.
  The `dateId` is stripped from every existing preference for that person, then rebuilt.
- **FR-SR-25** — **Compaction rule**: when the target `dateId` is an individual date item,
  the engine reuses an existing preference for the same `person` + `shiftType` + `weight`
  whose `date` array contains only date items, pushing `dateId` into that preference's
  `date[]` (page.tsx:955-963). This compacts equal individual-date requests into one
  preference with a multi-date `date[]`. When the target is a **date group**, no such
  reuse occurs — every date-group request is kept as its **own separate** preference so
  overlapping targets (e.g., ALL / WEEKDAY / WEEKEND) can stack independently
  (page.tsx:884-885,955).
- **FR-SR-26** — Preferences whose `date[]` becomes empty are dropped from the result
  (page.tsx:976).

### Quick Add mode

- **FR-SR-27** — Quick Add mode is toggled by the "Quick Add Preference" button
  (page.tsx:1541). Entering it resets the add form (`shiftTypes: []`, `weight: 0`) and
  clears errors. `Escape` exits Quick Add mode (page.tsx:1376). While active, normal-mode
  cell/history onClick handlers are disabled; edits are driven by mouse
  down/enter/up gestures.
- **FR-SR-28** — The add form has a shift-type multi-select (`CheckboxList` over
  `getAllShiftTypes()`) and a weight input (parsed via `parseWeightValue`, with `+∞`/`-∞`
  buttons). Selecting shift types clears any `shiftTypes` error; editing weight clears any
  `weight` error.
- **FR-SR-29** — A single **status line** communicates the current gesture effect; it has
  exactly four variants selected by `getQuickAddStatus` (page.tsx:381-407), rendered
  verbatim (see Validation table): (a) no shift types selected → clear mode; (b) invalid
  weight → error; (c) weight is 0 → removal mode; (d) otherwise → apply mode (interpolates
  the selected shift types and `getWeightDisplayLabel(weight)`).
- **FR-SR-30** — **Gesture mechanics** (page.tsx:1073-1156): mouse-down on a cell starts a
  drag, records the cell type (PREFERENCE vs HISTORY), clears the visited set and pending
  history-clear map, and snapshots `historyColumnsCount`. In Quick Add mode, the initial
  cell is applied immediately on mouse-down; each newly entered cell of the **same** cell
  type is applied on mouse-enter. A per-gesture visited set keyed
  `"{cellType}:{personId}:{identifier}"` ensures **each cell is applied at most once per
  gesture** even if re-entered. Every application after the first in a gesture sets
  `replaceLatestHistoryEntry = true` so the whole drag collapses into one undo/history
  step. Global mouse-up ends the gesture and re-enables text selection.
- **FR-SR-31** — Quick Add **preference** application (`applyPreferenceCellEdit`,
  page.tsx:1158): with no shift types selected, it clears the (person, date) cell
  (`clearFirst = true`, empty deltas); otherwise it validates the weight and applies one
  delta per selected shift type at that weight (`clearFirst = false`, additive/merge). A
  weight of 0 removes those shift types from the cell (per FR-SR-24).
- **FR-SR-32** — Quick Add **history** application (`applyHistoryCellEdit`, page.tsx:1193):
  with a single shift type selected, targeting a padding position (`historyIndex < offset`)
  appends a new history entry, and targeting a real position updates it. **Setting history
  to a shift-type group is rejected** — if the selected type is not in `shiftTypeData.items`,
  the operation is skipped with a console warning `"Cannot set history to a shift type
  group."` (no user-facing message). **Selecting more than one shift type** sets the error
  `"Cannot set history to multiple shift types."` and aborts (page.tsx:1217-1222).
- **FR-SR-33** — Quick Add history **clear** (no shift types selected) is **deferred to
  mouse-up**: each hovered clear target is accumulated into a per-person map keyed by the
  deepest position (`Math.max`), and `flushPendingHistoryClearDrag` applies them on
  mouse-up (page.tsx:129-141,1092-1120). This avoids column shifting under the pointer
  when clearing a slot shortens the longest history row mid-drag. Only the first flushed
  clear per gesture is a fresh history step; the rest use `replaceLatestHistoryEntry`.

### CSV uploads (Quick Add mode only)

- **FR-SR-34** — Two upload controls appear only in Quick Add mode (page.tsx:1606-1631):
  **"Upload People History (shorthand)"** and **"Upload Shift Requests"**. Accepted file
  types: `.csv`, `.txt`. The Shift Requests button is **disabled** when the current weight
  is invalid (`!isValidWeightValue(addFormData.weight)`); its tooltip then reads `"Weight
  must be a valid number, Infinity, or -Infinity"`, otherwise `"Upload a CSV file with
  shift preferences (people x (dates + 1) matrix)"`. The People History tooltip is
  `"Upload a CSV file with people history (name, shift type, repetition count)"`.
- **FR-SR-35** — Both uploads parse the file by splitting on newlines (trimming, dropping
  blank lines) then splitting each line on commas and trimming cells (page.tsx:665-666).
  Empty file content triggers `"No content found in the uploaded file."`. Any thrown error
  triggers a per-file catch message (see Validation table).
- **FR-SR-36** — **Shift-requests CSV** validation (`validateShiftRequestCsvData`,
  page.tsx:409): first the current add-form weight must be valid; the CSV must have exactly
  `peopleData.items.length` rows; each row must have `dateData.items.length + 1` columns
  (first column = person ID, remaining = one cell per date item, in order); person IDs
  must be valid, unique, and complete; non-empty cells must contain a shift type in
  `getAllShiftTypes()` (**items or groups**). Each non-empty cell yields a
  `{personId, dateId, shiftType}` where `dateId = dateData.items[column-1].id`. All
  messages are verbatim in the Validation table. On success the deltas (all at the
  add-form weight) are grouped per (person, date) and applied through the delta engine
  (`clearFirst` unset → additive), then a success alert reports the count.
- **FR-SR-37** — **People-history CSV** validation (`validatePeopleHistoryCsvData`,
  page.tsx:536): the CSV must have exactly `peopleData.items.length` rows (no header) and
  each row exactly 3 columns (`name, shift type, repetition count`); person IDs must be
  valid, unique, and complete; a non-empty shift type must exist in **`shiftTypeData.items`
  only**; an empty shift type is allowed and yields repetition 0 (clears that person's
  history). The repetition count is parsed with `parseInt(repetitionStr)`
  (`page.tsx:584-604`): only NaN and negative parsed values are rejected. This means
  decimal or partially-numeric input such as `2.5` or `2abc` is **truncated to `2`**
  rather than rejected, and `10` parses correctly. On success, each person's
  history is set to `repetitionCount` copies of the shift type and bulk-applied via
  `reorderItems` (page.tsx:614-651). Messages verbatim in the Validation table.

### Clear Data buttons

- **FR-SR-38** — Six Clear buttons (page.tsx:1698-1755), each guarded by a `confirm()`
  dialog (exact texts in Validation table) and no-oping if declined:
  - **Clear All People History** — sets every person's `history` to `[]`.
  - **Clear All Requests** — sets all shift-request preferences to `[]`.
  - **Clear Person Individual-to-Individual Date Requests** — removes preferences whose
    person is an individual **and** every date is an individual date item.
  - **Clear People Group-to-Individual Date Requests** — person is a group **and** every
    date is an individual date item.
  - **Clear Person Individual-to-Group Dates Requests** — person is an individual **and**
    any date is a date group.
  - **Clear People Group-to-Group Dates Requests** — person is a group **and** any date is
    a date group.

### Read-only summaries

- **FR-SR-39** — **"Current Shift Requests"** lists each `ShiftRequestPreference` (Person,
  Date joined by `", "`, Shift Type, and Weight) with the weight shown signed (`+` prefix
  when positive) and a neutral/wants/avoid caption (page.tsx:1912-1971). Empty state: `"No
  shift requests defined yet. Click on any cell in the matrix above to add preferences."`
- **FR-SR-40** — **"Current People History"** lists each person with a non-empty history,
  showing entries as `H-{position}` where `position = person.history.length - index`.
  Since `history[0]` is the newest entry (newest-first storage per FR-SR-07), this
  renders `history[0]` as the **highest H-number** (matching the matrix header
  `H-{historyColumnsCount - index}`) and the last/oldest entry as `H-1`
  (`page.tsx:2002-2009`). Empty state (shown when every person's history is empty):
  `"No history entries defined yet. Click on any history cell in the matrix above to add
  entries."`

### Weight parsing & display

- **FR-SR-41** — `parseWeightValue` (numberParsing.ts:23): case-insensitive `infinity` /
  `inf` / `∞` → `Infinity`; `-infinity` / `-inf` / `-∞` → `-Infinity`; a numeric value with
  suffix `k`/`m`/`b`/`t` (×1e3/1e6/1e9/1e12) resolves to a rounded integer **only when the
  product is an integer**, otherwise the raw string is kept (invalid); otherwise `parseInt`
  (invalid input kept as the raw string). Note `parseInt` truncates decimals (e.g. "1.5" →
  1) and non-numeric input stays a string.
- **FR-SR-42** — `isValidWeightValue` (numberParsing.ts:131): strings are invalid; a number
  is valid if finite or exactly `±Infinity`.
- **FR-SR-43** — `getWeightDisplayLabel` (numberParsing.ts:100): `Infinity` → `+∞`,
  `-Infinity` → `-∞`, `0` → `0`, otherwise a `+`-prefixed (for positives) abbreviation
  using `k`/`m`/`b`/`t` when evenly divisible (one decimal place when divisible by the
  unit/10).
- **FR-SR-44** — `WeightInput` (WeightInput.tsx) is a free-text field (parsed on change via
  `parseWeightValue`) with `+∞` and `-∞` quick-set buttons. Default placeholder
  `"e.g., -1, -10k, ∞"`, default label `"Weight (priority)"`; the editor uses compact mode
  with an empty label. The Quick Add page's own weight fields use placeholders
  `"Enter weight (positive for preference, negative for avoidance, or Infinity/-Infinity)"`
  (main) and `"±#"` (sticky compact bar).

### CheckboxList selection contract

- **FR-SR-45** — The shift-type multi-select (`CheckboxList.tsx`) supports drag-select: a
  plain click toggles one checkbox on mouse-up; once the pointer leaves the initial
  checkbox the gesture becomes drag mode (toggling the initial checkbox as it leaves, then
  toggling each checkbox on mouse-enter, including re-toggling on re-entry). Native
  `onChange` is suppressed for checkboxes so all toggles follow the mouse-gesture rules; a
  global mouse-up ends the gesture.

## Validation Rules & Messages

All messages below are verbatim. Placeholders in `{...}` are interpolated at runtime.

| ID | Trigger / Condition | Message (verbatim) | Surface |
|----|--------------------|--------------------|---------|
| VR-SR-01 | Required-data gate fails: no date range or no date items | `Please set up your dates first by visiting the Dates tab.` (with "Dates" linking to `/dates`) | Inline notice |
| VR-SR-02 | Gate fails: no people | `Please set up your people first by visiting the People tab.` (with "People" linking to `/people`) | Inline notice |
| VR-SR-03 | Gate fails: no shift types | `Please set up your shift types first by visiting the Shift Types tab.` (with "Shift Types" linking to `/shift-types`) | Inline notice |
| VR-SR-04 | Quick Add status: no shift types selected | `Drag over cells to clear existing requests or history. Empty cells will not change.` | Status line (warning) |
| VR-SR-05 | Quick Add status: invalid weight | `Enter a valid weight before dragging over cells to apply preferences.` | Status line (error) |
| VR-SR-06 | Quick Add status: weight is 0 | `Drag over cells to remove {shiftTypes joined by ", "}. Empty cells without it will not change.` | Status line (warning) |
| VR-SR-07 | Quick Add status: valid non-zero weight | `Drag over cells to apply {shiftTypes joined by ", "} with weight {getWeightDisplayLabel(weight)}.` | Status line (neutral) |
| VR-SR-08 | Quick Add: >1 shift type selected while setting a history cell | `Cannot set history to multiple shift types.` | `errors.shiftTypes` under selector |
| VR-SR-09 | Quick Add: selected shift type is a group while setting history | `Cannot set history to a shift type group.` | console.warn only (no UI message) |
| VR-SR-10 | Add-form weight invalid (form validation / CSV precheck) | `Weight must be a valid number, Infinity, or -Infinity` | `errors.weight` (form) |
| VR-SR-11 | Shift-requests CSV: weight invalid | `Weight must be a valid number, Infinity, or -Infinity.` | alert (via `CSV validation failed: {error}`) |
| VR-SR-12 | Shift-requests CSV: wrong row count | `CSV should have {peopleCount} rows (1 header + {peopleCount} people), but has {actual} rows.` | alert |
| VR-SR-13 | Shift-requests CSV: wrong column count in a row | `Row {i+1} should have {dateCount+1} columns (dates), but has {actual} columns.` | alert |
| VR-SR-14 | Shift-requests CSV: invalid person ID | `Row {i+1} has invalid person ID "{personId}". Valid person IDs: {list}` | alert |
| VR-SR-15 | Shift-requests CSV: duplicate person ID | `Duplicate person ID "{personId}" found at row {i+1}. Person was already seen at row {prevRow+1}.` | alert |
| VR-SR-16 | Shift-requests CSV: missing person | `Missing person "{id}" in CSV data. All people must be included.` | alert |
| VR-SR-17 | Shift-requests CSV: invalid shift type in a cell | `Invalid shift type "{cellValue}" at row {r+1}, column {c+1}. Valid shift types: {list}` (valid = items + groups) | alert |
| VR-SR-18 | Shift-requests CSV: success | `Successfully processed CSV file with {count} shift preferences!` | alert |
| VR-SR-19 | Shift-requests CSV: valid but no data | `No valid shift preferences found in CSV file.` | alert |
| VR-SR-20 | Shift-requests CSV: parse/throw | `Error processing shift-requests CSV file. Please check the file format.` | alert |
| VR-SR-21 | People-history CSV: wrong row count | `CSV should have {peopleCount} rows (one per person), but has {actual} rows.` | alert |
| VR-SR-22 | People-history CSV: wrong column count | `Row {i+1} should have 3 columns (name, shift type, repetition count), but has {actual} columns.` | alert |
| VR-SR-23 | People-history CSV: invalid person ID | `Row {i+1} has invalid person ID "{personId}". Valid person IDs: {list}` | alert |
| VR-SR-24 | People-history CSV: duplicate person ID | `Duplicate person ID "{personId}" found at row {i+1}. Person was already seen at row {prevRow+1}.` | alert |
| VR-SR-25 | People-history CSV: missing person | `Missing person "{id}" in CSV data. All people must be included.` | alert |
| VR-SR-26 | People-history CSV: invalid shift type | `Invalid shift type "{shiftTypeId}" at row {i+1}. Valid shift types: {list}` (valid = items only) | alert |
| VR-SR-27 | People-history CSV: invalid repetition count | `Invalid repetition count '{repetitionStr}' for person '{personId}' at row {i+1}. Must be a non-negative integer.` | alert |
| VR-SR-28 | People-history CSV: success | `Successfully processed {count} shift type entries from people history CSV!` | alert |
| VR-SR-29 | People-history CSV: valid but no data | `No valid entries found in the people history CSV file.` | alert |
| VR-SR-30 | People-history CSV: parse/throw | `Error processing people-history CSV file. Please check the file format.` | alert |
| VR-SR-31 | Any upload: empty content | `No content found in the uploaded file.` | alert |
| VR-SR-32 | Any upload: generic validation-failure prefix | `CSV validation failed: {error}` | alert |
| VR-SR-33 | Confirm: Clear All People History | `Are you sure you want to clear all people history?` | confirm() |
| VR-SR-34 | Confirm: Clear All Requests | `Are you sure you want to clear ALL shift requests?` | confirm() |
| VR-SR-35 | Confirm: Clear Person Individual-to-Individual Date Requests | `Are you sure you want to clear all requests between individual people and individual dates?` | confirm() |
| VR-SR-36 | Confirm: Clear People Group-to-Individual Date Requests | `Are you sure you want to clear all requests between people groups and individual dates?` | confirm() |
| VR-SR-37 | Confirm: Clear Person Individual-to-Group Dates Requests | `Are you sure you want to clear all requests between individual people and date groups?` | confirm() |
| VR-SR-38 | Confirm: Clear People Group-to-Group Dates Requests | `Are you sure you want to clear all requests between people groups and date groups?` | confirm() |
| VR-SR-39 | Editor save with invalid weight | Blocked silently; guard string `Weight must be a valid number, Infinity, or -Infinity` (not rendered) | Save no-op |
| VR-SR-40 | "Current Shift Requests" empty | `No shift requests defined yet. Click on any cell in the matrix above to add preferences.` | Inline empty state |
| VR-SR-41 | "Current People History" empty | `No history entries defined yet. Click on any history cell in the matrix above to add entries.` | Inline empty state |

## Edge Cases & Quirks

- **QK-SR-01** — The shift-requests CSV row-count message reads "1 header + N people" but
  the code expects **exactly N rows with no header row** (`expectedPeopleCount + 0`); the
  first data row is a person row, not a header (page.tsx:423-424). This wording is a known
  quirk to preserve verbatim.
- **QK-SR-02** — Shift-requests CSV cells accept shift-type **groups** as valid values
  (`getAllShiftTypes`), but people-history CSV accepts **only items** (`shiftTypeData.items`).
- **QK-SR-03** — History cannot be set to a shift-type group in Quick Add: the attempt is
  silently skipped (console warning only), unlike the multi-select case which shows a UI
  error.
- **QK-SR-04** — Editor weight validation collects errors into a local object that is never
  written to state, so an invalid weight blocks Save with **no visible error message** —
  the modal simply stays open.
- **QK-SR-05** — History clear via drag is deferred to mouse-up and coalesced per person to
  the deepest cleared position (clearing a later slot also removes earlier ones), because
  clearing shortens the longest history row and would shift columns mid-drag.
- **QK-SR-06** — Individual-date requests with identical person/shiftType/weight are
  compacted into one preference's multi-value `date[]`; **date-group** requests are always
  kept as separate preferences so overlapping targets (ALL/WEEKDAY/WEEKEND) stack.
- **QK-SR-07** — `parseWeightValue` uses `parseInt`, so decimal input like `1.5` truncates
  to `1`; suffix input like `1.5k` (→1500) is accepted only because the product is an
  integer, whereas a non-integer suffix product is retained as an invalid string.
- **QK-SR-08** — Infinite weights are clamped to magnitude 1,000,000 for opacity so a cell
  containing `+∞` renders at full (α≈1) intensity, not beyond.
- **QK-SR-09** — A cell with a mix of positive and negative preferences is `mixed`
  (reference yellow); a cell is only green/red when **all** its preferences share one sign.
- **QK-SR-10** — Each cell is applied at most once per drag gesture (visited set), but the
  `CheckboxList` shift-type selector re-toggles on re-entry, so dragging back over a
  checkbox flips it again.
- **QK-SR-11** — In Quick Add mode, a single click still applies (via mouse-down), because
  the normal-mode onClick handlers are disabled while `isAddMode` is true.
- **QK-SR-12** — Quick Add preference apply with selected shift types is **additive/merge**
  (`clearFirst = false`): existing preferences for other shift types on that cell are
  preserved; only the selected types are set/removed. Clearing (no shift types) and the
  modal Save are full replacements (`clearFirst = true`).

## Acceptance Criteria

- **AC-SR-01** — Given the date range, date items, ≥1 person, and ≥1 shift type are all
  present, the matrix renders; if any is missing, exactly one guidance notice appears per
  the FR-SR-02 priority (dates → people → shift types) with the correct target link.
- **AC-SR-02** — The matrix row order is people groups then individual people; the column
  order is the People label column, then history columns (H-{n} leftmost, H-1
  rightmost — i.e. the highest H-number is on the left and the lowest on the right),
  then date groups followed by individual dates. The `history[]` array is
  in newest-first order (per FR-SR-07): `history[0]` is the **newest** entry and
  renders under the highest H-number occupied by that person (e.g. `H-{history.length}`
  for a person with a full history); the trailing `H-1` column holds the
  **oldest** entry.
- **AC-SR-03** — The history column count equals the longest person history length plus 1,
  and a person shorter than that renders right-aligned entries with blank left padding and
  exactly one interactive empty slot to the left of their entries.
- **AC-SR-04** — A preference cell shows all preferences when it has ≤3, else the top 2
  plus a `+N more` line, ordered by descending magnitude, then descending signed weight,
  then shift-type order; each entry reads `{shiftType} ({weight label})`.
- **AC-SR-05** — A cell whose preferences are all positive resolves to the positive sign
  state, all negative to negative, and any mix to mixed; the opacity equals
  `max(0.05, log2(clampedMax)/log2(1_000_000))` with infinite weights clamped to 1,000,000.
- **AC-SR-06** — In normal mode, activating a preference cell opens the per-(person, date)
  editor and activating a clickable history cell opens the history editor; in Quick Add
  mode those direct-open actions do not fire.
- **AC-SR-07** — The history editor offers `-- Clear --` plus one option per shift-type
  **item**; choosing a type at a padding slot appends, at a real slot updates, and
  `-- Clear --` at a real slot **truncates history through that position** (the
  selected entry and every newer entry in the newest-first array are dropped,
  matching `updatePersonHistory` with no type);
  `-- Clear --` at a padding slot is a no-op.
- **AC-SR-08** — The Shift Preference Editor initializes from the cell's current
  preferences, treats weight 0 as removal, blocks Save on any invalid weight (modal stays
  open, no change persisted), and on valid Save fully replaces the cell's preferences.
- **AC-SR-09** — Quick Add shows exactly one of the four status variants matching
  (no-types / invalid-weight / zero-weight / valid). Edits are blocked only when the
  weight is invalid **and** at least one shift type is selected (the apply-remove path);
  when **no** shift types are selected (clear mode), an invalid weight input does **not**
  block the clear gesture (the page calls `applyPreferenceCellEdit` directly without weight
  validation — see `page.tsx:381-390, 1158-1169`).
- **AC-SR-10** — In Quick Add, a drag applies each visited cell at most once; applying
  selected shift types merges with existing cell preferences (weight 0 removes), and
  selecting no shift types clears the whole cell; history-clear drags apply on mouse-up.
- **AC-SR-11** — Setting a history cell in Quick Add with two or more shift types selected
  produces the `Cannot set history to multiple shift types.` error and makes no change;
  selecting a shift-type group makes no change (warning only).
- **AC-SR-12** — Uploading a shift-requests CSV enforces exact row/column counts, valid
  unique complete person IDs, and valid shift types (items or groups), emitting each listed
  message verbatim; a valid file applies all cells at the current add-form weight and
  reports the processed count.
- **AC-SR-13** — Uploading a people-history CSV enforces N rows × 3 columns, valid unique
  complete person IDs, item-only shift types, and a non-negative parsed repetition count,
  emitting each listed message verbatim; a valid file rebuilds each person's history as N
  copies of the shift type (empty type clears). **Repetition counts are parsed with
  `parseInt` — `2.5` and `2abc` are accepted and truncated to `2`; only NaN and negative
  values are rejected.**
- **AC-SR-14** — Each of the six Clear buttons prompts with its exact confirmation string
  and, when confirmed, removes precisely the targeted category (all history / all requests
  / the four person-scope × date-scope combinations); declining leaves data unchanged.
- **AC-SR-15** — Equal individual-date requests (same person/shiftType/weight) are stored
  as a single preference with a combined `date[]`; date-group requests remain separate
  preferences; preferences with an empty `date[]` are removed.
- **AC-SR-16** — Weight parsing accepts `∞`/`inf`/`infinity` (and negatives) and
  `k/m/b/t` suffixes (integer products only), rejects other non-numeric strings, and
  display labels abbreviate large values and render `±∞` for infinities.
- **AC-SR-17** — The read-only summaries list current requests (Person, comma-joined dates,
  Shift Type, signed Weight) and per-person histories (the `history[]` array is
  in newest-first order per FR-SR-07, so `history[0]` is the newest and renders
  as `H-{person.history.length}`; the trailing entry renders as `H-1` and is
  the oldest), each with its exact empty-state string when nothing is defined.

## Cross-References

- **Dates editor / date groups** — provides `dateData.range`, `dateData.items`, and
  `dateData.groups` used for date columns, weekend detection, and the date-scope Clear
  operations. (`/dates`)
- **People editor / people groups** — provides `peopleData.items` and `peopleData.groups`
  used for rows, person labels, history storage, and the person-scope Clear operations.
  (`/people`)
- **Shift Types editor / shift-type groups** — provides `shiftTypeData.items` and
  `shiftTypeData.groups`; groups are valid preference/matrix values but excluded from
  history. (`/shift-types`)
- **Shared weight parsing** — `web-frontend/src/utils/numberParsing.ts`
  (`parseWeightValue`, `isValidWeightValue`, `getWeightDisplayLabel`, `getWeightColor`) is
  reused by other weight-bearing editors.
- **Shared components** — `WeightInput`, `CheckboxList` (drag-select contract),
  `ShiftPreferenceEditor`, `UploadButton`, `ToggleButton`.
- **Scheduling data hook** — `useSchedulingData` (`getPreferencesByType`,
  `updatePreferencesByType`, `addPersonHistory`, `updatePersonHistory`, `reorderItems`)
  and the `replaceLatestHistoryEntry` option that coalesces drag edits into single
  undo/history steps.
- **Spec 01 — Data Model & Entities (FR-DM-20/21)** — preferences are grouped by
  the fixed type order `[at most one shift per day, shift type requirement, shift
  request, shift type successions, shift count, shift affinity, shift type covering]`
  in `sortPreferencesByType`; per-preference ID fields are sorted by canonical
  entity order. The shift-requests matrix sorts requests within the request
  group by person → shift type → weight. `shift type covering` is *not* rendered
  in the matrix (it is a card-list editor on its own tab — see spec 11) and is
  excluded from cell aggregates.
