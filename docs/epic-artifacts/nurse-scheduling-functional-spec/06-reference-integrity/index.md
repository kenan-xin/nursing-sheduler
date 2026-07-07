---
kind: spec
title: Reference Integrity (Rename & Delete Cascade)
prefix: RI
---

# Reference Integrity (Rename & Delete Cascade)

## Purpose & Scope

The scheduling model has no surrogate keys. Every entity (a date, person, or
shift type — whether an individual item or a named group) is identified only by
its **string ID**, and every place that refers to an entity stores a copy of
that string. There is no numeric row key, foreign key, or opaque handle behind
the string. As a direct consequence, whenever an entity's ID changes the string
must be rewritten in every dependent location, and whenever an entity is deleted
every dependent copy of its string must be reconciled — otherwise dangling or
duplicated references would silently corrupt the model.

This artifact specifies the two cascade operations that keep references
consistent when an entity ID is **renamed** or **deleted**:

- `applyReferencesForIdChange(state, dataType, oldId, newId)` — the rename cascade
  (`schedulingReferenceUpdates.ts:496-506`).
- `applyReferencesForIdDeletion(state, dataType, deletedIds)` — the delete cascade
  (`schedulingReferenceUpdates.ts:508-517`).

Both operate over three dependent surfaces:

1. **People history** — the per-person `history` array of shift-type IDs
   (shift-type IDs only).
2. **Preferences** — reference fields on each of the six editable preference
   types, plus their coefficient ID lists.
3. **Export layout** — formatting rules, extra columns, and extra rows.

Scope also covers the callers that trigger these cascades
(`useSchedulingData.ts`: `updateItem`, `updateGroup`, `deleteItem`,
`deleteGroup`, and the `removedDateIds` path of `updateDateRange`), plus the
recursive `ReferenceIdTree` helpers (`referenceIds.ts`) they rely on, and the
group-membership re-sorting that keeps member lists in item order.

Out of scope: how preferences/export rules are otherwise edited, ordered, or
validated (see the preferences and export artifacts); YAML import normalization
(referenced only where it explains nested reference trees).

`dataType` is one of `DataType.DATES`, `DataType.PEOPLE`, or
`DataType.SHIFT_TYPES` (`types/scheduling.ts`). It selects which field on each
dependent record is affected, because a given field only ever references one
entity kind.

---

## Functional Requirements

### Reference model & tree helpers

**FR-RI-01 — String IDs are the only reference; no surrogate keys.**
An entity is referenced solely by a copy of its string ID. `Item.id`,
`Group.id`, `history[]` entries, every preference reference field, coefficient
tuple IDs, and export layout ID arrays all store bare strings. Renames therefore
**rewrite the string everywhere**; deletes must **remove or neutralize** every
stored copy. There is no indirection that would let a reference survive an ID
change automatically.

 **FR-RI-02 — Cascade helpers accept recursive `ReferenceIdTree`,
but the normal frontend preference interfaces and the backend covering
model are not recursive.**
A reference field's **cascade representation** is
`string | ReferenceIdTree[]` — a leaf string or an arbitrarily nested
array of such trees (`referenceIds.ts:20`). The cascade helpers
`mapReferenceIdTree` / `filterReferenceIdTree` recurse over this
structure to preserve advanced imported shapes. The normal frontend
preference interfaces are mostly flat arrays
(`web-frontend/src/types/scheduling.ts:171-236`); the covering
`preceptors` / `preceptees` / `shiftTypes` fields are typed as one
nested level deep (`(string | string[])[]`); the backend covering model
mirrors that one-level depth (`core/nurse_scheduling/models.py:319-323`).
The covering editor's helpers (`flattenIds` at
`page.tsx:543-553`, `summarizeIds` at `:555-557`) flatten only one
level. Nested arrays arise only from advanced backend syntax preserved
on import (`hasNestedReferenceIds`, `referenceIds.ts:22-24`;
`useSchedulingData.ts:835-840`) and the cascade handlers preserve them
through the rename/filter. The rename and filter primitives recurse over
this structure:
- `mapReferenceIdTree(value, mapId)` recursively maps each leaf string
  (`referenceIds.ts:26-33`).
- `filterReferenceIdTree(value, keepId)` recursively rebuilds the tree: for an
  array it filters children, **dropping any array child that became empty**
  (`item.length > 0`) and dropping any leaf child that fails `keepId`; for a
  leaf it returns the string if kept, otherwise the empty array `[]`
  (`referenceIds.ts:35-44`).
- `renameReferenceIds` = map replacing `oldId -> newId`
  (`schedulingReferenceUpdates.ts:24-25`); `filterReferenceIds` = filter keeping
  IDs **not** in the deleted set (`schedulingReferenceUpdates.ts:27-28`).

### Rename cascade

**FR-RI-03 — Rename runs three sub-passes in fixed order.**
`applyReferencesForIdChange` applies, in order: people-history rename ->
preference rename -> export-layout rename, threading the result of each into the
next (`schedulingReferenceUpdates.ts:496-506`).

**FR-RI-04 — People `history` is rewritten only for shift-type renames.**
`applyPeopleHistoryForIdChange` returns state unchanged unless
`dataType === SHIFT_TYPES` (`schedulingReferenceUpdates.ts:36`). For shift-type
renames, every person's `history` array is mapped, replacing each entry equal to
`oldId` with `newId`; a missing/undefined `history` becomes `[]`
(`schedulingReferenceUpdates.ts:41-45`). Renaming a date or person never touches
`history`.

**FR-RI-05 — Preference reference fields are renamed per type via a
dataType->field map.**
`applyPreferencesForIdChange` (`schedulingReferenceUpdates.ts:69-161`) rewrites
one field per preference type, chosen by `dataType`:

| Preference type | DATES field | PEOPLE field | SHIFT_TYPES field |
|---|---|---|---|
| `shift type requirement` | `date` | `qualifiedPeople` | `shiftType` |
| `shift request` | `date` | `person` | `shiftType` |
| `shift type successions` | `date` | `person` | `pattern` |
| `shift count` | `countDates` | `person` | `countShiftTypes` |
| `shift affinity` | `[date]` | `[people1, people2]` | `[shiftTypes]` |
| `shift type covering` | `date` | `[preceptors, preceptees]` | `shiftTypes` |

For the four single-field types the chosen field is passed through
`renameReferenceIds` (`schedulingReferenceUpdates.ts:108-145`). For the
multi-field types (`shift affinity`, `shift type covering`) every field name in
the list is renamed through the same helper, recursing into nested reference
trees (`schedulingReferenceUpdates.ts:146-156` for affinity; `:163-191` for
covering). An `at most one shift per day` preference has no reference fields
and is returned unchanged (`schedulingReferenceUpdates.ts:158`).

**FR-RI-06 — Coefficient ID lists are renamed only for shift-type renames.**
When `dataType === SHIFT_TYPES`, coefficient tuples `[id, coefficient]` have
their `id` element renamed while the coefficient value is preserved: on
`shift type requirement.shiftTypeCoefficients`
(`schedulingReferenceUpdates.ts:114-119`) and on
`shift count.countShiftTypeCoefficients`
(`schedulingReferenceUpdates.ts:139-144`). These lists are untouched for date or
person renames.

**FR-RI-07 — Export layout is renamed across formatting, extra columns, and
extra rows.**
`applyExportLayoutForIdChange` (`schedulingReferenceUpdates.ts:438-494`) is a
no-op when `state.export` is absent (`:447-449`). Otherwise it renames IDs by
`dataType`:
- **formatting** rules: `people` for PEOPLE (rules that have `people`), `dates`
  for DATES, `shiftTypes` for SHIFT_TYPES (`:455-466`).
- **extraColumns**: `countDates` for DATES; for SHIFT_TYPES both
  `countShiftTypes` and each `countShiftTypeCoefficients` tuple ID (`:467-482`).
- **extraRows**: `countPeople` for PEOPLE; `countShiftTypes` for SHIFT_TYPES
  (`:483-491`).
Rename passes never drop rules or entries — they only rewrite strings.

`shift type covering` preferences are not part of the export layout (the editor
only renders them in the card list and never sets any `state.export` fields),
so no SHIFT_TYPE_COVERING-specific branch is needed here.

### Delete cascade

**FR-RI-08 — Delete runs three sub-passes in fixed order.**
`applyReferencesForIdDeletion` applies, in order: people-history deletion ->
preference deletion -> export-layout deletion, threading each result forward
(`schedulingReferenceUpdates.ts:508-517`). Each sub-pass returns state unchanged
when `deletedIds` is empty (`:54`, `:213-215`, `:370-372`).

**FR-RI-09 — Deleted shift-type IDs in `history` become empty positional slots,
not removed.**
`applyPeopleHistoryForIdDeletion` acts only for `dataType === SHIFT_TYPES` with a
non-empty deletion set (`schedulingReferenceUpdates.ts:54`). Each `history` entry
whose value is a deleted shift-type ID is replaced with the empty string `''`;
all other entries and the **array length/positions are preserved**
(`schedulingReferenceUpdates.ts:63`). History is positional (index = periods
before the schedule start), so a deleted shift type leaves a blank slot rather
than shifting later entries.

**FR-RI-10 — Preference deletion pass 1 filters IDs out of reference fields and
coefficient lists.**
`applyPreferencesForIdDeletion` first maps every preference
(`schedulingReferenceUpdates.ts:236-326`), using the same dataType->field map as
FR-RI-05, passing each affected field through `filterReferenceIds` (which prunes
deleted leaves and empties collapsed sub-arrays per FR-RI-02). For
`dataType === SHIFT_TYPES`, coefficient tuples whose ID is deleted are filtered
out of `shiftTypeCoefficients` (`:245-249`) and `countShiftTypeCoefficients`
(`:269-273`). `shift affinity` filters each of its listed array fields
(`:275-285`); `shift type covering` filters `date` (when present) and every
nested field in its `[preceptors, preceptees]` / `shiftTypes` map (`:287-315`).
`at most one shift per day` is returned unchanged (`:317`).

**FR-RI-11 — Preference deletion pass 2 drops preferences whose required fields
became empty.**
After filtering, a second pass removes any preference that lost a required field
(`schedulingReferenceUpdates.ts:330-359`). A field counts as empty when its
`.length === 0` (a fully pruned tree collapses to `[]`). Required-field sets:

| Preference type | Required fields (all must be non-empty to survive) |
|---|---|
| `shift type requirement` | `date`, `qualifiedPeople`, `shiftType` |
| `shift request` | `person`, `date`, `shiftType` |
| `shift type successions` | `person`, `date`, `pattern` |
| `shift count` | `person`, `countDates`, `countShiftTypes` |
| `shift affinity` | `date`, `people1`, `people2`, `shiftTypes` |
| `shift type covering` | `preceptors`, `preceptees`, `shiftTypes` (`date` is optional) |
| `at most one shift per day` | (none — **always retained**) |

Any preference type not matched by the guards returns `true` and is retained
(`schedulingReferenceUpdates.ts:282`); `at most one shift per day` has no
reference fields and therefore always survives.

**FR-RI-12 — Export layout deletion filters IDs and drops emptied rules.**
`applyExportLayoutForIdDeletion` (`schedulingReferenceUpdates.ts:367-436`) is a
no-op with no deletions (`:370-372`) or absent `state.export` (`:377-379`).
Otherwise, per `dataType`:
- **formatting**: filter `people` (PEOPLE) / `dates` (DATES) / `shiftTypes`
  (SHIFT_TYPES) that are present on the rule (`:386-397`), then **drop any rule
  where a present `people`, `dates`, or `shiftTypes` array is now empty**
  (`:398-403`) — all reference arrays present on a rule are checked, not only the
  one for the current `dataType`.
- **extraColumns**: filter `countDates` (DATES) or `countShiftTypes` +
  `countShiftTypeCoefficients` (SHIFT_TYPES) (`:405-419`), then drop any rule
  where `countDates` **or** `countShiftTypes` is empty (`:420`).
- **extraRows**: filter `countPeople` (PEOPLE) or `countShiftTypes`
  (SHIFT_TYPES) (`:422-430`), then drop any rule where `countPeople` **or**
  `countShiftTypes` is empty (`:431`).

`shift type covering` preferences do not appear in `state.export`; the export
layout cascade therefore has no SHIFT_TYPE_COVERING-specific branch. The cascade
is generic over the export data shape and unaffected by the addition of the
new preference type.

### Cascade triggers

**FR-RI-13 — Item and group edits trigger the rename cascade.**
`updateItem` (`useSchedulingData.ts:388-450`) and `updateGroup`
(`:452-501`) apply the data change (`applyDataUpdate`) and then
`applyReferencesForIdChange(nextState, dataType, oldId, newId)` in the same state
update. Because references are plain strings (FR-RI-01), **renaming a group ID
cascades identically to renaming an item ID** — any preference/export/history
reference matching that string is rewritten.

**FR-RI-14 — Item and group deletes trigger the delete cascade.**
`deleteItem` (`useSchedulingData.ts:503-525`) and `deleteGroup` (`:527-544`)
apply the data change and then
`applyReferencesForIdDeletion(nextState, dataType, [id])`. `deleteItem` also
removes the ID from every group's `members` (`:514-517`); `deleteGroup` removes
the group from `groups` (`:537`).

**FR-RI-15 — Date-range changes delete references for dropped dates.**
`updateDateRange` (`useSchedulingData.ts:161-204`) computes `currentDateIds` from
the old range and `newDateIds` from the new range (via `_generateDateItems`),
then `removedDateIds` = current IDs absent from the new set (`:163-175`). It
filters `removedDateIds` out of each date group's `members` (`:184-187`) and then
calls `applyReferencesForIdDeletion(nextState, DataType.DATES, removedDateIds)`
(`:202`). Dates that remain in range are untouched; auto-generated date items are
regenerated from the new range.

**FR-RI-16 — Group membership is re-sorted into item order on rename/add.**
When a rename changes group membership, the new member list is rebuilt by
filtering `updatedItems` in their canonical order and mapping to IDs, so members
always follow item order (`useSchedulingData.ts:429-431`; also `addItem`
`:255-257`, `addGroup` `:287-289`, `updateGroup` `:473-477`, `reorderItems`
`:574-579`). A length mismatch between intended and sorted members aborts that
group's update and logs `ERROR_SHOULD_NOT_HAPPEN` (`:433-436`).

---

## Validation Rules & Messages

The cascade functions themselves perform no user-facing validation. The
triggering callers enforce guard conditions before mutating; each logs to the
console (developer diagnostics, not UI messages) and returns without changing
state.

| Rule | Where | Effect / Message |
|---|---|---|
| New ID is a reserved keyword | `updateItem` `:399-402`, `updateGroup` `:457-461`, `deleteItem` `:505-508`, `deleteGroup` `:529-532` | Abort; log `Cannot ... - it is a reserved keyword. <ERROR_SHOULD_NOT_HAPPEN>` |
| Renaming an auto-generated (derived) date item | `updateItem` `:393-396` | Abort; log `Cannot rename derived date item ID "<oldId>" to "<newId>". <ERROR_SHOULD_NOT_HAPPEN>` |
| Group to update not found | `updateGroup` `:463-467` | Abort; log `Group with ID <oldId> not found. <ERROR_SHOULD_NOT_HAPPEN>` |
| Member list length mismatch after re-sort | `updateItem` `:430-433`, `updateGroup` `:476-479`, `addItem` `:255-258`, `addGroup` `:288-291` | Skip that group / abort; log length-mismatch `<ERROR_SHOULD_NOT_HAPPEN>` |

The cascade transformations do not raise validation errors or surface messages;
they silently rewrite/prune references.

---

## Edge Cases & Quirks

- **Rename-then-delete of a person is a full removal; a deleted shift type in
  history is a positional blank.** Person and date references are *filtered out*
  of preferences/export (FR-RI-10/11/12), so a person with no remaining
  references simply disappears from those records. A deleted **shift-type** ID
  that appears in a person's `history` is instead replaced by `''`, preserving
  the array index (FR-RI-09). This asymmetry is intentional: history is
  positional and must keep its length.
- **Empty-array pruning collapses nested trees.** In a nested reference tree,
  deleting every leaf of a sub-array removes that whole sub-array (its parent's
  `filter` drops zero-length children), and a fully emptied top-level field
  collapses to `[]`, whose `.length === 0` then triggers the pass-2 preference
  drop or the export rule drop (`referenceIds.ts:42-43`).
- **`at most one shift per day` is indestructible by cascades.** It has no
  reference fields, so it is never rewritten and never dropped (FR-RI-05,
  FR-RI-10, FR-RI-11).
- **Export deletion checks all present reference arrays on a rule, not just the
  edited `dataType`.** A `cell` formatting rule carries `people`, `dates`, and
  `shiftTypes`; deleting a shift type empties `shiftTypes` and the rule is
  dropped even though `people`/`dates` were the arrays touched by other data
  types (`applyExportLayoutForIdDeletion` in
  `schedulingReferenceUpdates.ts:367-436`, formatting drop at
  `:398-405`, extraColumns drop at `:406-422`, extraRows drop at
  `:423-433`). Likewise an extra column is dropped if either
  `countDates` or `countShiftTypes` empties, and an extra row if either
  `countPeople` or `countShiftTypes` empties.
- **Coefficient lists follow shift types only.** Coefficient tuple IDs are
  renamed/filtered exclusively when `dataType === SHIFT_TYPES`; renaming or
  deleting a person or date never disturbs coefficient tuples (FR-RI-06,
  FR-RI-10).
- **Rename never validates the target's existence.** A rename simply rewrites
  every matching string to `newId`; if `newId` collides with another existing
  ID the two become merged references (no de-duplication is performed by the
  cascade).
- **Coefficient rename can produce duplicate/mismatched tuples.** Renaming a
  shift-type ID rewrites coefficient tuple IDs without merging duplicates, so if
  `oldId` and an existing tuple ID converge, both tuples persist.
- **Group IDs share the reference namespace with item IDs.** Because references
  are bare strings, a group ID used as a reference (e.g. `ALL`, a people group,
  a date group) is renamed/deleted by the same cascade path as an item ID
  (FR-RI-13/14). There is no separate item-vs-group reference space.
- **Absent export config short-circuits.** Both export cascades no-op when
  `state.export` is undefined (`:303-305`, `:371-373`); export layout is
  otherwise lazily generated elsewhere.
- **`updateDateRange` uses generated IDs, not stored items.** Removed date IDs
  are derived by regenerating date items from the old and new ranges and
  diffing, not by inspecting `dates.items` (`useSchedulingData.ts:162-174`).

---

## Acceptance Criteria

**AC-RI-01 — Shift-type rename rewrites history.**
GIVEN a person whose `history` contains shift-type ID `"D"`,
WHEN `applyReferencesForIdChange(state, SHIFT_TYPES, "D", "Day")` runs,
THEN every `history` entry equal to `"D"` becomes `"Day"` and all other entries
and the array length are unchanged.

**AC-RI-02 — Person/date rename leaves history untouched.**
GIVEN any state,
WHEN the rename cascade runs with `dataType` of PEOPLE or DATES,
THEN no person's `history` array is modified.

**AC-RI-03 — Preference field rename by type.**
GIVEN a `shift count` preference with `countShiftTypes` containing `"N"` and a
`countShiftTypeCoefficients` tuple `["N", 2]`,
WHEN `applyReferencesForIdChange(state, SHIFT_TYPES, "N", "Night")` runs,
THEN `countShiftTypes` contains `"Night"` in place of `"N"` and the tuple becomes
`["Night", 2]` (coefficient preserved).

**AC-RI-04 — Affinity rename covers both people fields.**
GIVEN a `shift affinity` preference with `"P1"` in `people1` and in `people2`,
WHEN the rename cascade runs with PEOPLE, `oldId="P1"`, `newId="Pat"`,
THEN both `people1` and `people2` have `"P1"` replaced by `"Pat"`.

**AC-RI-05 — `at most one shift per day` unaffected by rename.**
GIVEN an `at most one shift per day` preference,
WHEN any rename cascade runs,
THEN that preference is returned byte-for-byte identical.

**AC-RI-06 — Deleted shift type becomes a blank history slot.**
GIVEN a person with `history = ["A", "D", "A"]`,
WHEN `applyReferencesForIdDeletion(state, SHIFT_TYPES, ["D"])` runs,
THEN `history === ["A", "", "A"]` (length preserved, position 1 blanked).

**AC-RI-07 — Deleting a reference thins a preference field.**
GIVEN a `shift type requirement` with `qualifiedPeople = ["P1", "P2"]`,
WHEN the delete cascade runs with PEOPLE, `deletedIds=["P1"]`,
THEN `qualifiedPeople === ["P2"]` and the preference is retained (still non-empty
required fields).

**AC-RI-08 — Deleting the last required reference drops the preference.**
GIVEN a `shift request` whose `shiftType = ["N"]` (single value),
WHEN the delete cascade runs with SHIFT_TYPES, `deletedIds=["N"]`,
THEN `shiftType` collapses to empty and the entire `shift request` preference is
removed from `preferences`.

**AC-RI-09 — `at most one shift per day` survives any deletion.**
GIVEN an `at most one shift per day` preference,
WHEN any delete cascade runs,
THEN that preference remains in `preferences`.

**AC-RI-10 — Nested reference sub-array is pruned when emptied.**
GIVEN a preference field `[["A", "B"], ["C"]]`,
WHEN the delete cascade removes both `"A"` and `"B"`,
THEN the field becomes `[["C"]]` (the emptied inner array is dropped).

**AC-RI-11 — Export cell rule dropped when one reference array empties.**
GIVEN a `cell` formatting rule with `shiftTypes = ["N"]`, plus non-empty
`people` and `dates`,
WHEN the delete cascade runs with SHIFT_TYPES, `deletedIds=["N"]`,
THEN the rule is removed from `export.formatting`.

**AC-RI-12 — Extra column dropped when countShiftTypes empties.**
GIVEN an extra column with `countShiftTypes = ["N"]` and non-empty `countDates`,
WHEN the delete cascade runs with SHIFT_TYPES, `deletedIds=["N"]`,
THEN the column is removed and any matching `countShiftTypeCoefficients` tuple is
also filtered out.

**AC-RI-13 — Rename of a group ID cascades like an item ID.**
GIVEN a preference field that references the group ID `"TeamA"`,
WHEN `updateGroup` renames `"TeamA"` to `"TeamB"`,
THEN the preference field now references `"TeamB"`.

**AC-RI-14 — Date-range shrink removes out-of-range date references.**
GIVEN a date `"31"` referenced by a preference and range currently covering it,
WHEN `updateDateRange` sets a new range that excludes `"31"`,
THEN `"31"` is removed from date group members and filtered out of every
preference/export reference; preferences left with an empty required date field
are dropped.

**AC-RI-15 — Reserved-keyword or derived-date rename is refused.**
GIVEN an attempt to rename an auto-generated date item, or to rename/delete to a
reserved keyword,
WHEN the corresponding `updateItem`/`updateGroup`/`deleteItem`/`deleteGroup`
runs,
THEN state is unchanged and a `<ERROR_SHOULD_NOT_HAPPEN>` diagnostic is logged;
no cascade runs.

**AC-RI-16 — Empty deletion set is a no-op.**
GIVEN `deletedIds = []`,
WHEN `applyReferencesForIdDeletion` runs,
THEN state is returned unchanged (all three sub-passes short-circuit).

**AC-RI-17 — Group members stay in item order after rename.**
GIVEN a group whose members reference an item being renamed,
WHEN `updateItem` renames the item,
THEN the group's `members` list contains the new ID positioned according to the
item ordering (re-sorted, not appended).

---

## Cross-References

- Preference field shapes and the six editable preference types (excluding
  the always-present `at most one shift per day`, which has no reference
  fields):
  `web-frontend/src/types/scheduling.ts:151-236` — see the Preferences artifact.
- Export layout shapes (`ExportFormatting`, `ExportExtraColumn`,
  `ExportExtraRow`): `web-frontend/src/types/scheduling.ts:52-113` — see the
  Export Layout artifact.
- Auto-generated date items and range regeneration (`_generateDateItems`,
  `addAutoGeneratedToState`): `web-frontend/src/hooks/schedulingGeneratedData.ts`
  — see the Dates artifact.
- Reserved keywords (`isReservedKeyword`, `ALL`):
  `web-frontend/src/utils/keywords.ts`.
- YAML import normalization that can introduce nested reference trees:
  `web-frontend/src/hooks/useSchedulingData.ts:771-970` (`loadFromYaml`) — see
  the Import/Export artifact.
- History persistence wrapping every mutation (`updateState`, `addToHistory`):
  `web-frontend/src/hooks/useSchedulingData.ts:81-91`,
  `web-frontend/src/hooks/schedulingHistory.ts`.

### Source files

- `web-frontend/src/hooks/schedulingReferenceUpdates.ts` (full cascade logic).
- `web-frontend/src/hooks/useSchedulingData.ts:160-203` (`updateDateRange`),
  `:385-541` (`updateItem`/`updateGroup`/`deleteItem`/`deleteGroup`).
- `web-frontend/src/hooks/schedulingDataUpdate.ts` (`applyDataUpdate`).
- `web-frontend/src/utils/referenceIds.ts` (`ReferenceIdTree` helpers).
