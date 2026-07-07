---
kind: spec
title: Export Layout
domain: Export Layout editor (experimental)
prefix: EX
sources:
  - web-frontend/src/app/export-layout/page.tsx
  - web-frontend/src/hooks/schedulingExportConfig.ts
  - web-frontend/src/hooks/schedulingPreferenceOrdering.ts
  - web-frontend/src/types/scheduling.ts
  - web-frontend/src/utils/numberParsing.ts
  - web-frontend/src/utils/countShiftTypeCoefficients.ts
  - web-frontend/src/hooks/schedulingConstants.ts
  - web-frontend/src/utils/keywords.ts
  - web-frontend/src/hooks/useSchedulingData.ts
---

# Export Layout

## Purpose & Scope

The Export Layout editor ("Tab 9. Export Layout", route `/export-layout`) lets the
user author an **ExportConfig** that controls how the prettified XLSX export is
rendered. The config is a structured data object with three independently ordered
sections (`scheduling.ts:109-113`):

- `formatting?: ExportFormatting[]` — style rules and cell annotations.
- `extraColumns?: ExportExtraColumn[]` — per-person count summary columns.
- `extraRows?: ExportExtraRow[]` — per-date count summary rows.

The page is explicitly marked **experimental**. When no export config has been
authored yet, an effective default config is generated on the fly by
`generateExportLayoutConfig(...)` from the current shift types and date groups
(`useSchedulingData.ts:972-973`); this generated config is what the editor and the
exporter both operate on until the user explicitly persists edits.

This spec describes the config **data** and the editor **rules/behavior**
UI-agnostically. Default color values are documented as required functional output
(they are emitted into the persisted config and the exported workbook), but no
specific visual layout of the editor is prescribed. The downstream rendering
semantics of these config values are owned by the Exporter Output contract
(cross-reference C5), not by this document.

Scope boundaries:
- In scope: the ExportConfig data model, the generated default layout, the
  add/edit form, its validation, clear/regenerate operations, duplication,
  reordering, and ordering normalization applied on every mutation and import.
- Out of scope: how the exporter interprets these rules to paint XLSX cells,
  evaluate `when` conditions, or compute counts (C5); the underlying person/date/
  shift-type entity definitions; and the coefficient-field UI internals shared with
  the Shift Count preference editor.

---

## Functional Requirements

### Data model

**FR-EX-01 — ExportConfig shape.** The export config is `{ formatting?,
extraColumns?, extraRows? }`; all three keys are optional arrays
(`scheduling.ts:109-113`). The editor reads them defensively as
`effectiveExportData.formatting || []`, `.extraColumns || []`, `.extraRows || []`
(`page.tsx:192-194`).

**FR-EX-02 — Formatting rule union & types.** A formatting rule is one of the
`ExportFormatting` union members keyed by `type: ExportFormattingType`, where the
type is exactly one of `'cell' | 'row' | 'column' | 'people header' | 'date header'
| 'history' | 'history header'` (`scheduling.ts:21-28,84-88`). All rules share the
optional base style fields `description`, `backgroundColor`, `bottomBorderColor`,
`rightBorderColor`, `fontColor` (`scheduling.ts:52-58`). The Type `<select>` in the
form lists them in this exact order: `people header`, `row`, `date header`,
`column`, `history header`, `history`, `cell` (`page.tsx:1266-1272`).

**FR-EX-02a — Description key presence rule (current behavior).** For
**style rules** (`formatting` entries), the `description` key is
**omitted** when blank — the form strips an empty description before
saving (`page.tsx:542-548`). For **count rules** (`extraColumns` /
`extraRows` entries), the `description` key is **always present**, even
when blank — the form writes `description: ''` (e.g. `page.tsx:611-675`,
`:700-746`); the generated default layout also emits
`description: ''` (`schedulingExportConfig.ts:90-103`, `:112-126`,
`:137-151`, `:225-247`). A rebuilder that omits blank `description`
for count rules will diverge from current strict-parity output.

**FR-EX-03 — Per-type target fields.** Each formatting type carries specific
targets (`scheduling.ts:60-82`, mirrored by the form helpers `page.tsx:119-125`):

| Type | Target fields present | Uses people | Uses dates | Uses shift types |
|---|---|---|---|---|
| `row` | `people: string[]` | yes | no | no |
| `people header` | `people: string[]` | yes | no | no |
| `history` | `people: string[]` | yes | no | no |
| `column` | `dates: string[]` | no | yes | no |
| `date header` | `dates: string[]` | no | yes | no |
| `history header` | (none) | no | no | no |
| `cell` | `people[]`, `dates[]`, `shiftTypes[]`, plus `appendText?`, `note?`, `when?` | yes | yes | yes |

`styleUsesPeople` = type in {`row`, `people header`, `history`, `cell`};
`styleUsesDates` = type in {`column`, `date header`, `cell`}; `styleUsesShiftTypes`
= type == `cell` (`page.tsx:119-125`). The form renders the People / Dates / Shift
Types checkbox groups accordingly (`page.tsx:957-995`).

**FR-EX-04 — Cell rule annotations.** Only `cell` rules may carry annotations:
`appendText?: string` and `note?: { text: string }` (`scheduling.ts:74-82`). The
Append Text and Note Text inputs are rendered only when
`draft.kind === 'style' && draft.type === 'cell'` (`page.tsx:997-1000`). On save,
`appendText` is written only if non-empty and `note` is written as `{ text:
noteText }` only if the trimmed note text is non-empty (`page.tsx:554-555`).

**FR-EX-05 — Cell rule `when` condition.** Only `cell` rules may carry a `when`
condition (`scheduling.ts:81`; form gating `page.tsx:1035-1038`). The condition is
`when: { preference: ExportPreferenceCondition }` where
`ExportPreferenceCondition.types` is fixed to the literal `['shift request']`
(`scheduling.ts:37-42`). The condition supports three optional narrowing fields,
all under `when.preference`:
- `requestShape?: ExportRequestShape[]` — zero or more of
  `'person-item-to-date-item'`, `'people-group-to-date-item'`,
  `'person-item-to-date-group'`, `'people-group-to-date-group'`, `'ALL'`
  (`scheduling.ts:30-35`). The editor offers these via `REQUEST_SHAPE_OPTIONS`,
  whose ids/descriptions are: `ALL`="All request shapes",
  `person-item-to-date-item`="Person item to date item",
  `people-group-to-date-item`="People group to date item",
  `person-item-to-date-group`="Person item to date group",
  `people-group-to-date-group`="People group to date group"
  (`page.tsx:111-117`).
- `satisfied?: boolean` — chosen via a Satisfied `<select>` with options `Any`
  (value `""`), `true`, `false` (`page.tsx:1050-1059`).
- `weightRange?: [number, number]` — an inclusive `[min, max]` numeric pair
  (`scheduling.ts:41`), entered as "Minimum Weight (inclusive)" (placeholder
  `-Infinity`) and "Maximum Weight (inclusive)" (placeholder `Infinity`)
  (`page.tsx:1074-1095`). **Parser caveat**: the two range inputs share
  the same `parseWeightValue` helper used elsewhere
  (`utils/numberParsing.ts:23-60`). The full algorithm:
  - Try infinity aliases: `infinity`/`inf`/`∞` (case-insensitive) →
    `Infinity`; `-infinity`/`-inf`/`-∞` → `-Infinity`.
  - Try full-string suffix regex `^([+-]?\d+(?:\.\d+)?)([kmbt])$`; on match,
    multiply the numeric prefix by the multiplier (`k`×1e3, `m`×1e6,
    `b`×1e9, `t`×1e12). The multiplied result must be an **integer** or
    the input is invalid. Examples: `2.5k` → `2500` valid; `1.5k7` → `1`
    valid (regex mismatch, falls through to `parseInt`); `2.5e3` → `2` valid
    (regex mismatch, falls through); a non-numeric string such as `abc` is
    invalid (regex mismatch, `parseInt` returns `NaN`).
  - Otherwise `parseInt(inputValue)` — accepts leading integer prefixes
    and truncates at the first non-digit / decimal point. Examples:
    `1.5` → `1`; `2.7k` → `2` (suffix doesn't match the suffix regex;
    falls through; parsed as integer `2`); `10abc` → `10`; `abc` →
    `NaN` (raw string, invalid).
  - The built export stores a `[number, number]` tuple of whatever the
    parser produced, so the YAML `weightRange` may contain truncated
    integers and infinities — a rebuilder should mirror the parser
    quirk to maintain YAML byte-equality.

**FR-EX-06 — `when` presence rule.** On save, the `when` object is emitted only
when at least one condition input is set: `hasCondition = requestShape.length > 0
|| satisfied !== '' || (weightRangeMin or weightRangeMax non-blank)`
(`page.tsx:511`). When present, `when.preference` always includes
`types: ['shift request']` and includes `requestShape`, `satisfied`, `weightRange`
only when respectively provided (`page.tsx:559-568`). `satisfied` is stored as a
boolean derived from `draft.satisfied === 'true'` (`page.tsx:564`). Leaving all
`when` inputs empty means "match all selected cells" (`page.tsx:1044-1046`).

**FR-EX-07 — ExportExtraColumn shape (per-person counts).** An extra column is
`{ description?, rightBorderColor?, type: 'count', header, countShiftTypes:
string[], countShiftTypeCoefficients?: ShiftCountTypeCoefficient[], countDates:
string[] }` (`scheduling.ts:90-98`). Semantically it produces a per-person summary
count over the selected `countShiftTypes` accumulated across the selected
`countDates`; `countShiftTypeCoefficients` optionally weights each counted shift
type. `ShiftCountTypeCoefficient` is the tuple `[string, number]`
(`scheduling.ts:159`). Only `rightBorderColor` (not the other border/background
fields) is offered for extra columns (`page.tsx:1306-1309`).

**FR-EX-08 — ExportExtraRow shape (per-date counts).** An extra row is
`{ description?, bottomBorderColor?, type: 'count', header, countShiftTypes:
string[], countPeople: string[] }` (`scheduling.ts:100-107`). Semantically it
produces a per-date summary count over the selected `countShiftTypes` accumulated
across the selected `countPeople`. Extra rows have **no** coefficient field and
offer only `bottomBorderColor` (`page.tsx:1306-1309`, `saveExtraRow`
`page.tsx:700-747`).

**FR-EX-09 — Coefficient pairs (extra columns only).** The coefficient editor is
rendered only for `draft.kind === 'extra column'` (`page.tsx:937-955`). Coefficient
pairs are kept in sync with the selected count shift types via
`syncCoefficientPairs`, which expands groups to members and reduces the selectable
set to the fully-covered items/groups (`countShiftTypeCoefficients.ts:44-74`).
Toggling a count shift type re-syncs the coefficient pairs (`page.tsx:894-918`). On
save, coefficients are validated and only non-blank entries are persisted; the
`countShiftTypeCoefficients` key is written only when at least one coefficient
remains (`page.tsx:646-676`).

### Color fields

**FR-EX-10 — Color value format & storage.** Every color field
(`backgroundColor`, `bottomBorderColor`, `rightBorderColor`, `fontColor`) must be a
6-digit hex string matching `/^#[0-9a-fA-F]{6}$/` when non-empty
(`page.tsx:110,304-310`). On save, color inputs are `.trim().toLowerCase()`-ed
before validation and storage, so persisted colors are always lowercase
(`page.tsx:505-508,614,703`). Each color field is written into the rule only when
non-empty (`page.tsx:542-548`). An empty color field is valid and means "no
override" (`validateColor` returns null for empty, `page.tsx:305`).

**FR-EX-11 — Color picker display derivation.** The read-only picker text is
derived by `getPickerDisplay` (`page.tsx:151-169`): when the field is empty it
shows `Default` in `#4b5563`; when the field is a valid `#RRGGBB` it shows the hex
value with black (`#111827`) or near-white (`#f9fafb`) text chosen by relative
luminance `(0.299·r + 0.587·g + 0.114·b)/255 > 0.6`; when the field is non-empty
but not a valid hex it shows the literal text `(Invalid)` in red `#b91c1c`. The
color `<input type=color>` value falls back to `#ffffff` for invalid/empty input.

### Effective config resolution & default generation

**FR-EX-12 — Effective config fallback.** When `state.export` is undefined, the
effective config used by the editor is `generateExportLayoutConfig(shiftTypes,
dates.groups)` (`useSchedulingData.ts:972-973`); the same fallback is applied
inside `updateExportFormatting`/`ExtraColumns`/`ExtraRows` and the duplicate helpers
(`useSchedulingData.ts:714,724,734,748,756,764`).

**FR-EX-13 — Default generated formatting rules.** `generateExportLayoutConfig`
(`schedulingExportConfig.ts:131-255`) produces `formatting` in this exact order.
**Each generated rule includes a `description` key, even when empty** (per
FR-EX-02a for generated defaults):

1. `cell` — description `"Show requested shift request target"`,
   `appendText: " [{shiftType}]"`, `people: [ALL]`, `dates: [ALL]`,
   `shiftTypes: [ALL, OFF]`, `when.preference = { types: ['shift request'],
   requestShape: ['person-item-to-date-item'], weightRange: [-Infinity, Infinity] }`
   (`schedulingExportConfig.ts:159-173`).
2. `cell` — description `"Mark unsatisfied shift requests"`,
   `appendText: " [X]"`, `fontColor: '#c00000'`, `note.text = "Weight of unmet
   single-style request: {totalAbsWeight}"`, `people: [ALL]`, `dates: [ALL]`,
   `shiftTypes: [ALL, OFF]`, `when.preference = { types: ['shift request'],
   requestShape: ['person-item-to-date-item'], satisfied: false, weightRange:
   [-Infinity, Infinity] }` (`schedulingExportConfig.ts:174-193`).
3. `history header` — description `""`, `backgroundColor: '#fefce8'`
   (`schedulingExportConfig.ts:194-198`).
4. `history` — description `""`, `people: [ALL]`, `backgroundColor: '#fefce8'`
   (`schedulingExportConfig.ts:199-204`).
5. `column` — description `""`, `dates: [SATURDAY, SUNDAY]`,
   `backgroundColor: '#dbeafe'` (`schedulingExportConfig.ts:205-210`).
6. `column` — description `""`, `dates: [SATURDAY]`,
   `rightBorderColor: '#9ca3af'` (`schedulingExportConfig.ts:211-216`).
7. (only when a `FREEDAY` date group exists) `column` — description `""`,
   `dates: [FREEDAY]`, `backgroundColor: '#dcfce7'`
   (`schedulingExportConfig.ts:217-222`).

`ALL`, `OFF`, `WEEKDAY`, `WEEKEND`, `SATURDAY`, `SUNDAY` are reserved keyword ids
(`keywords.ts:23-33`); `WORKDAY`/`FREEDAY` are the workday/freeday group ids
(`schedulingConstants.ts:28-29`).

**FR-EX-14 — Default generated extra columns.** `extraColumns` are generated in
this order (`schedulingExportConfig.ts:224-250`):

1. `OFF (Total)` — `countShiftTypes: [OFF]`, `countDates: [ALL]`,
   `rightBorderColor: '#000000'` (`DEFAULT_SEPARATOR_COLOR`,
   `schedulingConstants.ts:30`).
2. `OFF (WORKDAY)` — present only when a `WORKDAY` date group exists;
   `countShiftTypes: [OFF]`, `countDates: [WORKDAY]`
   (`schedulingExportConfig.ts:137-144`).
3. `OFF (FREEDAY)` — present only when a `FREEDAY` date group exists;
   `countShiftTypes: [OFF]`, `countDates: [FREEDAY]`
   (`schedulingExportConfig.ts:145-151`).
   The last of the (WORKDAY, FREEDAY) columns, if any, gets
   `rightBorderColor: '#000000'` (`schedulingExportConfig.ts:153-155`).
4. `OFF (Weekday)` — `countShiftTypes: [OFF]`, `countDates: [WEEKDAY]`
   (`schedulingExportConfig.ts:234-240`).
5. `OFF (Weekend)` — `countShiftTypes: [OFF]`, `countDates: [WEEKEND]`,
   `rightBorderColor: '#000000'` (`schedulingExportConfig.ts:241-248`).
6. Per-shift-type / per-group count columns from
   `generateShiftTypeCountExtraColumns` (`schedulingExportConfig.ts:85-106,249`):
   for each non-auto-generated shift-type **item** (via `filterAutoGenerated`,
   `keywords.ts:153-155`, which excludes the auto `OFF` item), header
   `"{id} Count"`, `countShiftTypes: [id]`, `countDates: [ALL]`; the **last item**
   gets `rightBorderColor: '#000000'`. Then for each non-auto-generated shift-type
   **group**, header `"{id} Count"`, `countShiftTypes: [id]`, `countDates: [ALL]`
   (no border).

**FR-EX-15 — Default generated extra rows.** `extraRows` are generated only from
`generateShiftTypeCountExtraRows` (`schedulingExportConfig.ts:108-129,251-253`):
for each non-auto-generated shift-type **item**, header `"{id} Count"`,
`countShiftTypes: [id]`, `countPeople: [ALL]`; the **last item** gets
`bottomBorderColor: '#000000'`. Then for each non-auto-generated shift-type
**group**, header `"{id} Count"`, `countShiftTypes: [id]`, `countPeople: [ALL]`
(no border). The default `extraRows` contain **no** OFF/Total/Weekday/Weekend rows
(those exist only for extra columns).

### Editing operations

**FR-EX-16 — Add / edit form.** A single form (toggled by "Add Export Rule",
`page.tsx:1116`) authors all three kinds. A "Rule Kind" `<select>` chooses `Style`
(value `style`), `Extra Column` (value `extra column`), or `Extra Row` (value
`extra row`) (`page.tsx:1242-1245`). Switching Rule Kind resets errors and clears
all target arrays (`page.tsx:1226-1239`); switching a style rule's Type resets
errors and clears `people`/`dates`/`shiftTypes` (`page.tsx:1254-1262`). The form
title and primary button read "Add Export Rule"/"Add" when creating and "Edit
Export Rule"/"Update" when editing (`page.tsx:1206-1208,1385`).

**FR-EX-17 — Save routing & cross-section moves.** `handleSave` routes to
`saveStyleRule` / `saveExtraColumn` / `saveExtraRow` by `draft.kind`
(`page.tsx:771-785`). When editing an entry into the same section, the entry is
replaced in place; when editing changes the rule's section (e.g. a style rule saved
as an extra column), the original entry is removed from its old section and the new
entry is appended to the target section, then the whole config is written via
`updateExportConfig({...effectiveExportData, formatting, extraColumns, extraRows})`
(`page.tsx:589-608,678-698,749-769`). New (non-edit) entries are appended to the
end of their section.

**FR-EX-18 — Edit prefill.** `handleStartEditStyle` reconstructs the draft from a
formatting rule, including `when` fields; if `when.preference.weightRange` exists
but is not a length-2 array it seeds `weightRangeMin`/`Max` empty and pre-sets the
error "Weight Range must contain exactly two values" (`page.tsx:349-381`).
`handleStartEditExtraColumn` re-syncs coefficient pairs on load
(`page.tsx:383-404`); `handleStartEditExtraRow` loads header, count shift types,
count people, bottom border (`page.tsx:406-422`). Starting an edit saves and resets
scroll position to top (`page.tsx:379-380,402-403,420-421`).

**FR-EX-19 — Duplicate.** Each section supports per-entry duplicate via
`duplicateExportFormatting` / `duplicateExportExtraColumn` /
`duplicateExportExtraRow`, which copy the entry (with a copied description) and
re-persist through the section update path (`useSchedulingData.ts:747-769`,
`page.tsx:251-264`). Duplicating first dismisses any in-progress edit
(`page.tsx:251-253`).

**FR-EX-20 — Delete & reorder.** Each section (`DraggableCardList`) supports delete
and drag reorder; both dismiss any in-progress draft and re-persist the section
(`page.tsx:236-279,1394-1566`). Reordering is meaningful because "Rules are
evaluated in order within each section" (instructions, `page.tsx:301`).

**FR-EX-21 — Clear operations.** The Clear Data panel exposes five operations, each
guarded by a `confirm()` dialog with the exact string shown (`page.tsx:196-228`):

| Button label | `confirm()` message (verbatim) | Effect |
|---|---|---|
| Clear All | `Are you sure you want to clear ALL export layout entries?` | `updateExportConfig({ formatting: [], extraColumns: [], extraRows: [] })` |
| Clear All and Regenerate | `Are you sure you want to clear ALL export layout entries and regenerate them?` | `updateExportConfig(undefined)` (reverts to generated default) |
| Clear Style Rules | `Are you sure you want to clear all export style rules?` | `updateExportFormatting([])` |
| Clear Extra Columns | `Are you sure you want to clear all export extra columns?` | `updateExportExtraColumns([])` |
| Clear Extra Rows | `Are you sure you want to clear all export extra rows?` | `updateExportExtraRows([])` |

"Clear All" persists an empty-but-defined config (so the generated default is NOT
reused), whereas "Clear All and Regenerate" sets `state.export = undefined`, which
makes the effective config fall back to `generateExportLayoutConfig` again
(FR-EX-12).

**FR-EX-22 — Ordering normalization on every mutation.** Every persist path
normalizes id ordering against the current entity order:
`updateExportFormatting` → `normalizeExportFormattingOrder`,
`updateExportExtraColumns` → `normalizeExportExtraColumnsOrder`,
`updateExportExtraRows` → `normalizeExportExtraRowsOrder`, and `updateExportConfig`
→ `normalizeExportConfigOrder` (`useSchedulingData.ts:710-745`). Normalization
sorts each rule's `people`, `dates`, `shiftTypes` (formatting), its `countShiftTypes`
/ `countShiftTypeCoefficients` / `countDates` (columns), and `countShiftTypes` /
`countPeople` (rows) by the ordered entity entries, preserving coefficient pairing
(`schedulingExportConfig.ts:26-82`). The same normalization is applied to
`state.export` on YAML import (`useSchedulingData.ts:961`). Undefined sections pass
through unchanged (`schedulingExportConfig.ts:27,49,62,74-75`).

**FR-EX-23 — Keyboard & unsaved-edit guarding.** While the form is open, Enter
triggers Save (unless an IME composition is active) and Escape triggers Cancel
(`page.tsx:787-804`). An open form registers an unsaved-editing tab-switch warning
via `useTabSwitchWarning(isFormVisible)` (`page.tsx:190`). Cancel/Save restore the
saved scroll position when an edit was in progress (`page.tsx:424-431,780-784`).

**FR-EX-24 — Instructions & experimental warning.** A help toggle reveals six
instruction lines (`page.tsx:295-302`): "Create export style rules and extra count
columns or rows for prettified XLSX output", "Style rules change cell appearance;
extra columns add per-person count summaries", "Extra rows add per-date count
summaries", "Extra columns count selected shift types over selected dates", "Use
#RRGGBB for color values", "Rules are evaluated in order within each section". A
persistent amber banner reads verbatim: "This page is experimental. Only modify
export layout entries if you know exactly what you're doing." (`page.tsx:1128-1135`).

---

## Validation Rules & Messages

All messages below are verbatim. `renderErrorMessages` splits multi-line error
strings on `\n` and renders each line separately (`page.tsx:312-325`).

### Style rule (`saveStyleRule`, `page.tsx:503-609`)

| Condition | Field | Message (verbatim) |
|---|---|---|
| People target required (types using people) and none selected | people | `Select at least one people` |
| Selected people include an id not in the option set | people | `Selected people are invalid for this rule type` |
| Dates target required and none selected | dates | `Select at least one date` |
| Selected dates include an unknown id | dates | `Selected dates are invalid for this rule type` |
| Shift types target required (cell) and none selected | shiftTypes | `Select at least one shift type` |
| Selected shift types include an unknown id | shiftTypes | `Selected shift types are invalid for this rule type` |
| `backgroundColor` non-empty and not `#RRGGBB` | backgroundColor | `Background Color must be a valid hex color in #RRGGBB format` |
| `bottomBorderColor` invalid | bottomBorderColor | `Bottom Border Color must be a valid hex color in #RRGGBB format` |
| `rightBorderColor` invalid | rightBorderColor | `Right Border Color must be a valid hex color in #RRGGBB format` |
| `fontColor` invalid | fontColor | `Font Color must be a valid hex color in #RRGGBB format` |
| No style AND no annotation field set (all of bg/bottom/right/font/appendText/noteText empty) | styleFields | `At least one style or annotation field is required` |
| Weight range: min blank while max set | weightRangeMin | `Weight Range minimum is required when maximum is set` |
| Weight range: max blank while min set | weightRangeMax | `Weight Range maximum is required when minimum is set` |
| Min not a valid number/Infinity/-Infinity | weightRangeMin | `Minimum Weight must be a valid number, Infinity, or -Infinity` |
| Max not a valid number/Infinity/-Infinity | weightRangeMax | `Maximum Weight must be a valid number, Infinity, or -Infinity` |
| Min > Max | weightRangeMin & weightRangeMax | `Weight Range minimum must be less than or equal to maximum` |
| (Edit prefill) existing `weightRange` present but not length 2 | weightRangeMin | `Weight Range must contain exactly two values` |

Notes: the "Select at least one …" / "invalid …" messages come from
`getSelectedOptionsError` (`page.tsx:440-456`); the label is lowercased into the
message. Target validation only runs for the target types the current formatting
type uses (`addStyleTargetErrors`, `page.tsx:458-471`). Weight parsing uses
`parseWeightValue` + `isValidWeightValue`, accepting finite numbers, `Infinity`,
`-Infinity`, the aliases `inf`/`-inf`/`∞`/`-∞`, and k/m/b/t suffixes that resolve
to integers (`numberParsing.ts:23-60,131-141`). A blank weight range (both empty)
is valid and omits `weightRange` (`page.tsx:476-478`).

### Extra column (`saveExtraColumn`, `page.tsx:611-698`)

| Condition | Field | Message (verbatim) |
|---|---|---|
| Header blank after trim | header | `Column header is required` |
| `rightBorderColor` invalid | rightBorderColor | `Right Border Color must be a valid hex color in #RRGGBB format` |
| No count shift types selected | countShiftTypes | `Select at least one shift type to count` |
| Selected count shift types include unknown id | countShiftTypes | `Selected shift types are invalid for this extra column` |
| No count dates selected | countDates | `Select at least one date target to count over` |
| Selected count dates include unknown id | countDates | `Selected dates are invalid for this extra column` |
| A coefficient is set but not an integer ≥ 1 | countShiftTypeCoefficients (per id) | `Coefficient for {shiftTypeId} must be an integer of at least 1` |
| Two coefficient sources cover the same expanded shift type | countShiftTypeCoefficients | `Shift type coefficients overlap: {id1}, {id2} include {expandedId}` |

Coefficient validation is skipped entirely when `countShiftTypes` already has an
error (`page.tsx:647`). Per-id coefficient errors are joined with `\n` into
`countShiftTypeCoefficients` and also kept by id in
`countShiftTypeCoefficientsById`; the overlap error is only surfaced when there are
no per-id errors (`page.tsx:646-661`, `countShiftTypeCoefficients.ts:108-139`).
Blank coefficients are allowed and dropped from the persisted array
(`countShiftTypeCoefficients.ts:116-133`).

### Extra row (`saveExtraRow`, `page.tsx:700-769`)

| Condition | Field | Message (verbatim) |
|---|---|---|
| Header blank after trim | header | `Row header is required` |
| `bottomBorderColor` invalid | bottomBorderColor | `Bottom Border Color must be a valid hex color in #RRGGBB format` |
| No count shift types selected | countShiftTypes | `Select at least one shift type to count` |
| Selected count shift types include unknown id | countShiftTypes | `Selected shift types are invalid for this extra row` |
| No count people selected | countPeople | `Select at least one people target to count over` |
| Selected count people include unknown id | countPeople | `Selected people are invalid for this extra row` |

Any save that produces errors calls `setErrors(nextErrors)` and returns `false`
without persisting (`page.tsx:537-540,663-666,735-738`).

---

## Edge Cases & Quirks

- **`when`/annotations are cell-only.** `appendText`, `note`, and `when` fields only
  exist on `cell` rules; the form hides them for other types
  (`page.tsx:997-1000,1035-1038`) and `saveStyleRule` only writes them in the
  `draft.type === 'cell'` branch (`page.tsx:550-569`). Non-cell rules built through
  the `column`/`date header`, `history header`, or `people`-based branches never
  receive these fields (`page.tsx:570-587`).
- **`hasCondition` uses `weightRangeMin`/`Max`, but `weightRange` is emitted only if
  parsed valid.** If a user sets a satisfied/shape but leaves an incomplete weight
  range, the incomplete-range error still blocks save (`page.tsx:479-483,511`).
- **Colors are silently lowercased.** `#C00000` typed by hand becomes `#c00000` in
  storage; case is not preserved (`page.tsx:505-508`). The default rule already uses
  lowercase `#c00000` (`schedulingExportConfig.ts:178`).
- **`(Invalid)` is display-only.** A non-hex color string shows `(Invalid)` in the
  picker (`page.tsx:155-156`) but is only rejected at save time by `validateColor`;
  an empty string is always accepted and simply omitted.
- **Effective vs persisted config.** Until the user saves any edit or runs a clear
  op, `state.export` may be `undefined` and the editor shows the generated default
  (FR-EX-12). "Clear All" and "Clear All and Regenerate" differ precisely here:
  the former persists empty arrays; the latter sets `undefined` so the default
  regenerates (`page.tsx:196-210`).
- **`OFF` handling in shift-type options.** The shift-type picker deliberately omits
  a manual `OFF` entry because `OFF` is an auto-generated item
  (`page.tsx:289-293`); `filterAutoGenerated` likewise excludes `OFF` from the
  generated per-shift-type count columns/rows (`keywords.ts:37-46,153-155`).
- **WORKDAY/FREEDAY/FREEDAY-column conditionals.** The `OFF (WORKDAY)` and
  `OFF (FREEDAY)` columns and the `FREEDAY` background column appear in the default
  layout only when the corresponding date group exists
  (`schedulingExportConfig.ts:135-155,217-222`).
- **Separator borders are positional.** The `#000000` separator border is attached
  to the *last* item of a generated run (last WORKDAY/FREEDAY column, last
  per-shift-type item column, last per-shift-type item row), so re-ordering shift
  types via normalization can move which entry carries the separator
  (`schedulingExportConfig.ts:96,119,153-155,231,247`).
- **Ordering normalization runs unconditionally.** Even a no-op save re-sorts target
  ids to entity order; imported configs are normalized on load
  (`useSchedulingData.ts:961`). Coefficient pairs are re-sorted by their first id
  while keeping the pairing (`schedulingExportConfig.ts:56`).
- **Coefficient set can shrink to nothing.** `syncCoefficientPairs` only keeps
  fully-covered items/groups; if the selection covers no complete group/item the
  coefficient list becomes empty and no coefficients are persisted
  (`countShiftTypeCoefficients.ts:44-74`).
- **Group description copy on duplicate.** Duplicates copy the description (with a
  "copied" suffix via `duplicateEntryWithCopiedDescription`) and re-persist through
  normalization (`useSchedulingData.ts:747-769`).

---

## Acceptance Criteria

- **AC-EX-01.** Given no export config has been persisted, the effective config
  equals `generateExportLayoutConfig(currentShiftTypes, currentDateGroups)`,
  including the seven ordered default formatting rules (or six when no FREEDAY
  group), the default extra columns beginning with `OFF (Total)`, and default extra
  rows containing only per-shift-type/group count rows.
- **AC-EX-02.** Given a saved cell rule with `appendText`, `note`, and a `when`
  condition, when the type is changed to a non-cell type and re-saved, then the
  persisted rule contains none of `appendText`, `note`, `when`.
- **AC-EX-03.** Given any color field set to a value not matching `#RRGGBB`, when
  the user attempts to save, then the save is rejected with the field-specific
  "… must be a valid hex color in #RRGGBB format" message and nothing is persisted.
- **AC-EX-04.** Given a color entered in uppercase hex, when the rule is saved, then
  the persisted value is the lowercase form of that hex.
- **AC-EX-05.** Given a style rule with no style field and no annotation field set,
  when the user attempts to save, then the save is rejected with "At least one style
  or annotation field is required".
- **AC-EX-06.** Given a weight-range minimum greater than its maximum, when saving a
  cell rule, then both weight fields report "Weight Range minimum must be less than
  or equal to maximum" and the rule is not persisted; given only one of min/max
  provided, the corresponding "… is required when …" message is shown.
- **AC-EX-07.** Given a valid cell rule with only `satisfied=false` chosen in
  `when`, when saved, then `when.preference` equals `{ types: ['shift request'],
  satisfied: false }` with no `requestShape` or `weightRange` keys.
- **AC-EX-08.** Given an extra column with a blank header, or zero count shift
  types, or zero count dates, when saving, then the respective verbatim required
  message is shown and nothing is persisted.
- **AC-EX-09.** Given an extra column coefficient entered as a
  non-number (e.g. `abc`), when saving, then
  `Coefficient for {id} must be an integer of at least 1` is shown for
  that shift type. Given `0` or `2.5`, when saving, the value is
  silently clamped to `1` or truncated to `2` respectively
  (`Number.parseInt` + `Math.max(1, …)`) — no validation error fires
  for these inputs. Given two coefficient sources that overlap on an
  expanded shift type, then
  `Shift type coefficients overlap: {id1}, {id2} include {expandedId}` is
  shown.
- **AC-EX-10.** Given a valid extra column with all coefficients blank, when saved,
  then the persisted rule omits `countShiftTypeCoefficients` entirely.
- **AC-EX-11.** Given an extra row, when saved, then the persisted rule contains
  `countShiftTypes` and `countPeople` but never a coefficient field or a
  `rightBorderColor`.
- **AC-EX-12.** Given "Clear All", when confirmed, then the persisted config is
  `{ formatting: [], extraColumns: [], extraRows: [] }` and the default layout is
  NOT re-shown; given "Clear All and Regenerate", when confirmed, then the config
  reverts to the generated default.
- **AC-EX-13.** Given each clear operation, when triggered, then a confirmation
  prompt with the exact wording in FR-EX-21 is shown, and declining it makes no
  change.
- **AC-EX-14.** Given any save, duplicate, delete, reorder, or import, then every
  affected rule's target id arrays (and coefficient pairs) are re-ordered to match
  the current entity order before being persisted.
- **AC-EX-15.** Given the form is open, when Enter is pressed (no IME composition),
  the current entry is saved; when Escape is pressed, editing is cancelled; and an
  open form triggers the unsaved-changes tab-switch warning.
- **AC-EX-16.** The page always displays the experimental warning "This page is
  experimental. Only modify export layout entries if you know exactly what you're
  doing."

---

## Cross-References

- **C5 — Exporter Output contract.** This spec defines the ExportConfig **data**
  and editor behavior only. The runtime meaning of every field — how `formatting`
  rules paint XLSX cells/rows/columns/headers, how a `cell` rule's `when` condition
  matches shift-request preferences (`types`, `requestShape`, `satisfied`,
  `weightRange`), how `appendText`/`note` and the `{shiftType}`/`{totalAbsWeight}`
  placeholders are substituted, and how `extraColumns`/`extraRows` counts (with
  coefficients) are computed and rendered — is owned by the Exporter Output
  contract. The default colors, separator borders, and count headers documented
  here are the required inputs to that contract.
- **Shift Requests spec.** `ExportRequestShape` and the `when.preference.types =
  ['shift request']` condition tie directly to the shift-request preference model;
  weight-range parsing shares `parseWeightValue`/`isValidWeightValue`
  (`numberParsing.ts`) with the shift-request weight inputs.
- **Shift Count preference spec.** The extra-column coefficient editor reuses
  `CountShiftTypeCoefficientFields`, `syncCoefficientPairs`, and
  `validateCoefficientPairs` (`countShiftTypeCoefficients.ts`) shared with the Shift
  Count preference; the `ShiftCountTypeCoefficient` tuple type is shared
  (`scheduling.ts:159`).
- **Entity ordering / People / Dates / Shift Types specs.** Ordering normalization
  (`schedulingExportConfig.ts`, via `entityOrdering` utilities) and the reserved
  keyword ids `ALL`, `OFF`, `WEEKDAY`, `WEEKEND`, `SATURDAY`, `SUNDAY`, `WORKDAY`,
  `FREEDAY` (`keywords.ts`, `schedulingConstants.ts`) are defined by those specs.
- **Import / Export (YAML) spec.** `state.export` is normalized on YAML import
  (`useSchedulingData.ts:961`) and persisted as part of the scheduling state.
