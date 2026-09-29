---
title: "Reference Integrity (Rename & Delete Cascade)"
kind: spec
---

# Reference Integrity (Rename & Delete Cascade)

## Purpose & Scope

The scheduling model has no surrogate keys. Every entity (a date, person, or
shift type — whether an individual item or a named group) is identified only by
its **ID (a string, or a number where the data model allows it — see spec 01
FR-DM-07a), and every place that refers to an entity stores a copy of** that
ID. There is no row key, foreign key, or opaque handle behind the ID. As a
direct consequence, whenever an entity's ID changes the ID must be rewritten
in every dependent location, and whenever an entity is deleted every dependent
copy of its ID must be reconciled — otherwise dangling or
duplicated references would silently corrupt the model.

This artifact specifies the two cascade operations that keep references
consistent when an entity ID is **renamed or deleted:**

- `applyReferencesForIdChange(state, dataType, oldId, newId) — the rename cascade`.
- `applyReferencesForIdDeletion(state, dataType, deletedIds) — the delete cascade`.

Both operate over three dependent surfaces:

1. **People history — the per-person **`history array of shift-type IDs`
(shift-type IDs only).
2. **Preferences — reference fields on each of the six editable preference**
types, plus their coefficient ID lists.
3. **Export layout — formatting rules, extra columns, and extra rows.**

Scope also covers the actions that trigger these cascades (rename item,
rename group, delete item, delete group, and dates removed by a date-range
change), plus the recursive reference-tree helpers they rely on, and how
group member lists keep their order.

Out of scope: how preferences/export rules are otherwise edited, ordered, or
validated (see the preferences and export artifacts); YAML import normalization
(referenced only where it explains nested reference trees).

`dataType is one of DataType.DATES, DataType.PEOPLE, or`
`DataType.SHIFT_TYPES. It selects which field on each`
dependent record is affected, because a given field only ever references one
entity kind.

## Functional Requirements

### Reference model & tree helpers

**FR-RI-01 — IDs are the only reference; no surrogate keys.**
An entity is referenced solely by a copy of its ID. Item IDs, group IDs,
history entries, every preference reference field, coefficient tuple IDs, and
export layout ID arrays all store the ID itself. An ID is a string or, where
spec 01 FR-DM-07a allows it, a number. Matching is exact: `1` and `"1"` are
different IDs and never collide. Renames therefore **rewrite the ID
everywhere; deletes must remove or neutralize every** stored copy. There is no indirection that would let a reference survive an ID
change automatically.

 **FR-RI-02 — Cascade helpers accept recursive `ReferenceIdTree`,**
**but the normal frontend preference interfaces and the backend covering**
**model are not recursive.**
A reference field's **cascade representation is**
`leaf | tree[]` — a leaf ID (string or number) or an arbitrarily nested
array of such trees. The cascade helpers
`mapReferenceIdTree / filterReferenceIdTree` recurse over this
structure to preserve advanced imported shapes. The normal frontend
preference interfaces are mostly flat arrays
`; the covering`
`preceptors / preceptees / shiftTypes fields are typed as one`
nested level deep (`(string | string[])[]); the backend covering model`
mirrors that one-level depth`.`
The covering editor's display helpers flatten only one level. Nested arrays
arise only from advanced backend syntax preserved on import, and the cascade
handlers preserve them through the rename/filter. The rename and filter primitives recurse over
this structure:

- `mapReferenceIdTree(value, mapId) recursively maps each leaf string`.
- `filterReferenceIdTree(value, keepId) recursively rebuilds the tree: for an`
array it filters children, **dropping any array child that became empty**
(`item.length > 0) and dropping any leaf child that fails keepId; for a`
leaf it returns the string if kept, otherwise the empty array `[]`.
- `renameReferenceIds = map replacing oldId -> newId`
`; filterReferenceIds = filter keeping`
IDs **not in the deleted set.**

### Rename cascade

**FR-RI-03 — Rename runs three sub-passes in fixed order.**
`applyReferencesForIdChange applies, in order: people-history rename ->`
preference rename -> export-layout rename, threading the result of each into the
next`.`

**FR-RI-04 — People `history` is rewritten only for shift-type renames.**
`applyPeopleHistoryForIdChange returns state unchanged unless`
`dataType === SHIFT_TYPES. For shift-type`
renames, every person's `history array is mapped, replacing each entry equal to`
`oldId with newId; a missing/undefined history becomes []`
`. Renaming a date or person never touches`
`history.`

**FR-RI-05 — Preference reference fields are renamed per type via a**
**dataType->field map.**
`applyPreferencesForIdChange rewrites`
one field per preference type, chosen by `dataType:`

| Preference type | DATES field | PEOPLE field | SHIFT_TYPES field |
| --- | --- | --- | --- |
| `shift type requirement` | `date` | `qualifiedPeople` | `shiftType` |
| `shift request` | `date` | `person` | `shiftType` |
| `shift type successions` | `date` | `person` | `pattern` |
| `shift count` | `countDates` | `person` | `countShiftTypes` |
| `shift affinity` | `[date]` | `[people1, people2]` | `[shiftTypes]` |
| `shift type covering` | `date` | `[preceptors, preceptees]` | `shiftTypes` |

For the four single-field types the chosen field is passed through
`renameReferenceIds. For the`
multi-field types (`shift affinity, shift type covering) every field name in`
the list is renamed through the same helper, recursing into nested reference
trees. An `at most one shift per day preference has no reference fields`
and is returned unchanged`.`

**FR-RI-06 — Coefficient ID lists are renamed only for shift-type renames.**
When `dataType === SHIFT_TYPES, coefficient tuples [id, coefficient] have`
their `id element renamed while the coefficient value is preserved: on`
`shift type requirement.shiftTypeCoefficients`
` and on`
`shift count.countShiftTypeCoefficients`
`. These lists are untouched for date or`
person renames.

**FR-RI-07 — Export layout is renamed across formatting, extra columns, and**
**extra rows.**
`applyExportLayoutForIdChange is a`
no-op when `state.export is absent. Otherwise it renames IDs by`
`dataType:`

- **formatting rules: **`people for PEOPLE (rules that have people), dates`
for DATES, `shiftTypes for SHIFT_TYPES.`
- **extraColumns: **`countDates for DATES; for SHIFT_TYPES both`
`countShiftTypes and each countShiftTypeCoefficients tuple ID.`
- **extraRows: **`countPeople for PEOPLE; countShiftTypes for SHIFT_TYPES`.
Rename passes never drop rules or entries — they only rewrite strings.

`shift type covering preferences are not part of the export layout (the editor`
only renders them in the card list and never sets any `state.export fields),`
so no SHIFT_TYPE_COVERING-specific branch is needed here.

### Delete cascade

**FR-RI-08 — Delete runs three sub-passes in fixed order.**
`applyReferencesForIdDeletion applies, in order: people-history deletion ->`
preference deletion -> export-layout deletion, threading each result forward
`. Each sub-pass returns state unchanged`
when `deletedIds is empty.`

**FR-RI-09 — Deleted shift-type IDs in `history` become empty positional slots,**
**not removed.**
`applyPeopleHistoryForIdDeletion acts only for dataType === SHIFT_TYPES with a`
non-empty deletion set`. Each history entry`
whose value is a deleted shift-type ID is replaced with the empty string `'';`
all other entries and the **array length/positions are preserved**
`. History is positional (index = periods`
before the schedule start), so a deleted shift type leaves a blank slot rather
than shifting later entries.

**FR-RI-10 — Preference deletion pass 1 filters IDs out of reference fields and**
**coefficient lists.**
`applyPreferencesForIdDeletion first maps every preference`
`, using the same dataType->field map as`
FR-RI-05, passing each affected field through `filterReferenceIds (which prunes`
deleted leaves and empties collapsed sub-arrays per FR-RI-02). For
`dataType === SHIFT_TYPES, coefficient tuples whose ID is deleted are filtered`
out of `shiftTypeCoefficients and countShiftTypeCoefficients`
`. shift affinity filters each of its listed array fields`
`; shift type covering filters date (when present) and every`
nested field in its `[preceptors, preceptees] / shiftTypes map.`
`at most one shift per day is returned unchanged.`

**FR-RI-11 — Preference deletion pass 2 drops preferences whose required fields**
**became empty.**
After filtering, a second pass removes any preference that lost a required field
`. A field counts as empty when its`
`.length === 0 (a fully pruned tree collapses to []). Required-field sets:`

| Preference type | Required fields (all must be non-empty to survive) |
| --- | --- |
| `shift type requirement` | `date, qualifiedPeople, shiftType` |
| `shift request` | `person, date, shiftType` |
| `shift type successions` | `person, date, pattern` |
| `shift count` | `person, countDates, countShiftTypes` |
| `shift affinity` | `date, people1, people2, shiftTypes` |
| `shift type covering` | `preceptors, preceptees, shiftTypes (date is optional)` |
| `at most one shift per day` | (none — **always retained)** |

A `shift type successions` preference is also dropped when pruning removes any
whole step from its `pattern` (every id in that step was deleted). A shortened
pattern is a different rule (`[N, D]` "no Night then Day" would become `[N]`
"never Night"), so the cascade never shortens a pattern. A step that only loses
some of its alternatives (`[[N, D]]` to `[[D]]`) keeps its position and survives.

Any preference type not matched by the guards returns `true and is retained`
`; at most one shift per day has no`
reference fields and therefore always survives.

**FR-RI-12 — Export layout deletion filters IDs and drops emptied rules.**
`applyExportLayoutForIdDeletion is a`
no-op with no deletions` or absent state.export.`
Otherwise, per `dataType:`

- **formatting: filter **`people (PEOPLE) / dates (DATES) / shiftTypes`
(SHIFT_TYPES) that are present on the rule`, then `**drop any rule**
**where a present `people`, `dates`, or `shiftTypes` array is now empty**
` — all reference arrays present on a rule are checked, not only the`
one for the current `dataType.`
- **extraColumns: filter **`countDates (DATES) or countShiftTypes +`
`countShiftTypeCoefficients (SHIFT_TYPES), then drop any rule`
where `countDates **or **countShiftTypes is empty.`
- **extraRows: filter **`countPeople (PEOPLE) or countShiftTypes`
(SHIFT_TYPES)`, then drop any rule where countPeople `**or**
`countShiftTypes is empty.`

`shift type covering preferences do not appear in state.export; the export`
layout cascade therefore has no SHIFT_TYPE_COVERING-specific branch. The cascade
is generic over the export data shape and unaffected by the addition of the
new preference type.

### Cascade triggers

**FR-RI-13 — Item and group edits trigger the rename cascade.**
`updateItem and updateGroup`
` apply the data change (applyDataUpdate) and then`
`applyReferencesForIdChange(nextState, dataType, oldId, newId) in the same state`
update. Because references are plain strings (FR-RI-01), **renaming a group ID**
**cascades identically to renaming an item ID — any preference/export/history**
reference matching that string is rewritten.

**FR-RI-14 — Item and group deletes trigger the delete cascade.**
`deleteItem and deleteGroup`
apply the data change and then
`applyReferencesForIdDeletion(nextState, dataType, [id]). deleteItem also`
removes the ID from every group's `members; deleteGroup removes`
the group from `groups.`

**FR-RI-15 — Date-range changes delete references for dropped dates.**
`updateDateRange computes currentDateIds from`
the old range and `newDateIds from the new range (via _generateDateItems),`
then `removedDateIds = current IDs absent from the new set. It`
filters `removedDateIds out of each date group's members and then`
calls `applyReferencesForIdDeletion(nextState, DataType.DATES, removedDateIds)`
`. Dates that remain in range are untouched; auto-generated date items are`
regenerated from the new range.

**FR-RI-16 — Group membership is edited in place on rename; order is preserved, not re-sorted.**
A rename rewrites each matching member id where it already sits in the group's
`members` list, preserving the existing member order (the cascade maps each
reference leaf in place). A delete filters the removed id out, leaving the
surviving members in their prior order. Members are **not** re-derived into item/canonical
order — the pre-rebuild re-sort-to-item-order behavior is gone (decision log 06:
the shipped store behavior is adopted). There is no length-mismatch abort path.

**FR-RI-17 — Nested ordered group references cascade without reordering definitions**
**(DL09 target).** When a group member names an earlier-defined group, renaming that group
rewrites the member reference and deleting it prunes the member reference in every later
group. Item rename/delete likewise reaches items inside nested groups. The cascade must
preserve the group-list definition order because forward references remain invalid. If
pruning empties a group, normal empty-group validation applies; the cascade must not
silently flatten or substitute its former concrete expansion. WT0 owns this store-level
repair for every domain that permits nested groups.

### Option C — leave & durations in the cascade (extends this spec)

<user_quoted_section>Sanctioned extension for the contracted-hours feature. Decisions:decision log 05;capability: spec 12 FR-CH-50.</user_quoted_section>

- **FR-RI-40 — `LEAVE` is never a cascade target. Like **`OFF/ALL, LEAVE`
is a reserved, non-user-created day-state (spec 01 FR-DM-26), so it cannot be
renamed or deleted and never participates in the rename/delete cascade **as a**
**target. A user cannot create a shift type named **`LEAVE, so no user entity`
ever collides with it.
- **FR-RI-41 — `LEAVE` is protected on ALL reference surfaces, not just leave**
**requests.** The protection is **structural, not a guard inside the cascade**
**helper.** Because `LEAVE` is reserved, a user cannot rename or delete it —
`deleteItem`/`deleteGroup` (and rename) abort on reserved IDs at the mutation
entry (reserved-keyword guard), so
`LEAVE` never enters a cascade's `deletedIds`/renamed set. As a result, a
rename/delete of some *other* (unrelated worked) shift type MUST leave `LEAVE`
untouched on every surface — exactly as `OFF`/`ALL` are left untouched. (Note the
cascade helpers themselves have no reserved-keyword guard; a *direct* call passing `["LEAVE"]` as a deleted
id would prune it, but no user-triggered path can produce that.) This applies
**everywhere `LEAVE` can appear:**
  - `shift request.shiftType: LEAVE (a leave pin — spec 04 FR-SR-46);`
  - `shift count.countShiftTypes containing LEAVE, and its`
`countShiftTypeCoefficients tuple keyed by LEAVE;`
  - export `extraColumns / extraRows count selectors and their coefficient`
tuples containing `LEAVE;`
  - export cell-formatting `shiftTypes selectors containing LEAVE;`
  - person `history containing LEAVE.`
In all of these, a shift-type **rename leaves **`LEAVE untouched, and a`
shift-type **delete does not treat **`LEAVE as a dangling id to prune. Only`
the co-located **person / date / worked-shift-type references in those same**
structures cascade normally (rename rewrites, delete filters, empty-required
drop). Since `OFF` and `LEAVE` are both reserved and non-targetable, the same
mutation-entry guard that keeps `OFF` out of cascades already covers `LEAVE`;
a rebuild must preserve that non-targetable property for both.
- **FR-RI-42 — `durationMinutes` travels with its shift type. **`durationMinutes`
(spec 01 FR-DM-28) is an item property, not a cross-entity reference. On a
shift-type **rename it is preserved on the renamed item (like**
`description); on `**delete it is removed with the item. It introduces no**
new reference edges and no cascade of its own. Coefficients that were
auto-filled from it are plain `[id, int] pairs and cascade exactly as`
existing coefficient pairs do (their `id element renames, value preserved).`
- **FR-RI-43 — Marked Contracted Hours preserve cascades but do not auto-repair**
**dynamic coverage.** A rename or deletion continues to rewrite/prune
`countShiftTypes` and `countShiftTypeCoefficients` through FR-RI-03/06/10/13/14;
the `hoursContract` marker does not disable those identity/reference cascades.
Adding or duplicating a Shift Type, changing group membership, or changing working
time does not rewrite saved selectors, coefficients, or targets. A date-range shrink
still prunes removed `countDates` through FR-RI-15. If any required date remains, its
target(s) stay byte-exact; if none remains, FR-RI-11 deletes the preference. Neither
path rescales. Because groups
and `ALL` remain dynamic selectors, those changes trigger revalidation and may leave a
marked count invalid until explicit Refresh or editing restores exact coefficient
coverage. This validation consequence is not a cascade mutation.
The complete marked lifecycle is:
  | Operation | Required effect |
  | --- | --- |
  | Shift Type/group rename | Rewrite direct and nested group selectors plus coefficient ids; preserve values and definition order. |
  | Shift Type/group delete | Prune identities and coefficients; apply normal empty-required-rule behavior. |
  | Shift Type item duplicate | Preserve the existing group-copy behavior; do not synthesize coefficients; revalidate and require Refresh. |
  | Group duplicate | Add an unreferenced group; existing contracts do not change. |
  | Preference duplicate | Deep-copy the marked rule and marker. |
  | Date-range shrink | Prune removed dates. Preserve target(s) exactly when dates remain; delete the preference per FR-RI-11 when none remain. Either result is one global history transition. |
  | Membership, working-time, or new-item edit | No coefficient/target repair; revalidate only. |

## Validation Rules & Messages

The cascade functions themselves perform no user-facing validation. The
triggering callers enforce guard conditions before mutating. A rename-collision or
reserved-keyword target throws a structured `RenameCollisionError` (state
untouched) that the editor catches and surfaces as an **error toast** carrying the
error's message — not an inline
field error; the remaining derived-date / not-found guards are developer console
diagnostics that return without changing state.

| Rule | Where | Effect / Message |
| --- | --- | --- |
| New ID is a reserved keyword (or a duplicate/non-string target) | rename cascade (`web/lib/cascade`) | Throw `RenameCollisionError` with a `reason` field (`reserved` / `duplicate-item` / `duplicate-group` / `non-string-id`); state untouched. The editor catches it and shows an **error toast** with the message (not an inline field error). No console `ERROR_SHOULD_NOT_HAPPEN` diagnostic. |
| Renaming an auto-generated (derived) date item | rename item | Abort; log `Cannot rename derived date item ID "<oldId>" to "<newId>". <ERROR_SHOULD_NOT_HAPPEN>` |
| Group to update not found | rename group | Abort; log `Group with ID <oldId> not found. <ERROR_SHOULD_NOT_HAPPEN>` |
| Member list length mismatch after re-sort | add/rename item or group | Skip that group / abort; log length-mismatch `<ERROR_SHOULD_NOT_HAPPEN>` |

The cascade transformations do not raise validation errors or surface messages;
they silently rewrite/prune references.

## Edge Cases & Quirks

- **Rename-then-delete of a person is a full removal; a deleted shift type in**
**history is a positional blank. Person and date references are ***filtered out*
of preferences/export (FR-RI-10/11/12), so a person with no remaining
references simply disappears from those records. A deleted **shift-type ID**
that appears in a person's `history is instead replaced by '', preserving`
the array index (FR-RI-09). This asymmetry is intentional: history is
positional and must keep its length.
- **Empty-array pruning collapses nested trees. In a nested reference tree,**
deleting every leaf of a sub-array removes that whole sub-array (its parent's
`filter drops zero-length children), and a fully emptied top-level field`
collapses to `[], whose.length === 0 then triggers the pass-2 preference`
drop or the export rule drop`.`
- **`at most one shift per day** is indestructible by cascades. It has no**`**
reference fields, so it is never rewritten and never dropped (FR-RI-05,
FR-RI-10, FR-RI-11).
- **Export deletion checks all present reference arrays on a rule, not just the**
**edited **`dataType. A **`**`cell formatting rule carries people, dates, and`
`shiftTypes; deleting a shift type empties shiftTypes and the rule is`
dropped even though `people/dates were the arrays touched by other data`
types. Likewise an extra column is dropped if either
`countDates or countShiftTypes empties, and an extra row if either`
`countPeople or countShiftTypes empties.`
- **Coefficient lists follow shift types only. Coefficient tuple IDs are**
renamed/filtered exclusively when `dataType === SHIFT_TYPES; renaming or`
deleting a person or date never disturbs coefficient tuples (FR-RI-06,
FR-RI-10).
- **Rename rejects a colliding target atomically — it never merges.** Before any
string is rewritten, the cascade checks `newId` against the domain's existing
item and group ids (by exact identity, so `1` and `"1"` never falsely collide)
and the reserved keywords; a collision throws `RenameCollisionError` (carrying a
`reason` of `duplicate-item`, `duplicate-group`, `reserved`, or `non-string-id`)
and leaves state untouched. The pre-rebuild silent-merge-on-collision behavior is
gone (design review finding #5: reject, never merge; `web/lib/cascade`).
- **A user rename can no longer converge coefficient tuples.** Because a rename
onto an existing shift-type id is rejected before any rewrite (above), the old
path where `oldId` and an existing coefficient tuple id merged into
duplicate/mismatched tuples is unreachable through the UI.
- **Group IDs share the reference namespace with item IDs. Because references**
are plain IDs (exact-match, string or number), a group ID used as a reference (e.g. `ALL, a people group,`
a date group) is renamed/deleted by the same cascade path as an item ID
(FR-RI-13/14). There is no separate item-vs-group reference space.
- **Absent export config short-circuits. Both export cascades no-op when**
`state.export is undefined; export layout is`
otherwise lazily generated elsewhere.
- **`updateDateRange** uses generated IDs, not stored items. Removed date IDs**`**
are derived by regenerating date items from the old and new ranges and
diffing, not by inspecting `dates.items.`

## Acceptance Criteria

**AC-RI-01 — Shift-type rename rewrites history.**
GIVEN a person whose `history contains shift-type ID "D",`
WHEN `applyReferencesForIdChange(state, SHIFT_TYPES, "D", "Day") runs,`
THEN every `history entry equal to "D" becomes "Day" and all other entries`
and the array length are unchanged.

**AC-RI-02 — Person/date rename leaves history untouched.**
GIVEN any state,
WHEN the rename cascade runs with `dataType of PEOPLE or DATES,`
THEN no person's `history array is modified.`

**AC-RI-03 — Preference field rename by type.**
GIVEN a `shift count preference with countShiftTypes containing "N" and a`
`countShiftTypeCoefficients tuple ["N", 2],`
WHEN `applyReferencesForIdChange(state, SHIFT_TYPES, "N", "Night") runs,`
THEN `countShiftTypes contains "Night" in place of "N" and the tuple becomes`
`["Night", 2] (coefficient preserved).`

**AC-RI-04 — Affinity rename covers both people fields.**
GIVEN a `shift affinity preference with "P1" in people1 and in people2,`
WHEN the rename cascade runs with PEOPLE, `oldId="P1", newId="Pat",`
THEN both `people1 and people2 have "P1" replaced by "Pat".`

**AC-RI-05 — `at most one shift per day` unaffected by rename.**
GIVEN an `at most one shift per day preference,`
WHEN any rename cascade runs,
THEN that preference is returned byte-for-byte identical.

**AC-RI-06 — Deleted shift type becomes a blank history slot.**
GIVEN a person with `history = ["A", "D", "A"],`
WHEN `applyReferencesForIdDeletion(state, SHIFT_TYPES, ["D"]) runs,`
THEN `history === ["A", "", "A"] (length preserved, position 1 blanked).`

**AC-RI-07 — Deleting a reference thins a preference field.**
GIVEN a `shift type requirement with qualifiedPeople = ["P1", "P2"],`
WHEN the delete cascade runs with PEOPLE, `deletedIds=["P1"],`
THEN `qualifiedPeople === ["P2"] and the preference is retained (still non-empty`
required fields).

**AC-RI-08 — Deleting the last required reference drops the preference.**
GIVEN a `shift request whose shiftType = ["N"] (single value),`
WHEN the delete cascade runs with SHIFT_TYPES, `deletedIds=["N"],`
THEN `shiftType collapses to empty and the entire shift request preference is`
removed from `preferences.`

**AC-RI-09 — `at most one shift per day` survives any deletion.**
GIVEN an `at most one shift per day preference,`
WHEN any delete cascade runs,
THEN that preference remains in `preferences.`

**AC-RI-10 — Nested reference sub-array is pruned when emptied.**
GIVEN a preference field `[["A", "B"], ["C"]],`
WHEN the delete cascade removes both `"A" and "B",`
THEN the field becomes `[["C"]] (the emptied inner array is dropped).`

**AC-RI-11 — Export cell rule dropped when one reference array empties.**
GIVEN a `cell formatting rule with shiftTypes = ["N"], plus non-empty`
`people and dates,`
WHEN the delete cascade runs with SHIFT_TYPES, `deletedIds=["N"],`
THEN the rule is removed from `export.formatting.`

**AC-RI-12 — Extra column dropped when countShiftTypes empties.**
GIVEN an extra column with `countShiftTypes = ["N"] and non-empty countDates,`
WHEN the delete cascade runs with SHIFT_TYPES, `deletedIds=["N"],`
THEN the column is removed and any matching `countShiftTypeCoefficients tuple is`
also filtered out.

**AC-RI-13 — Rename of a group ID cascades like an item ID.**
GIVEN a preference field that references the group ID `"TeamA",`
WHEN `updateGroup renames "TeamA" to "TeamB",`
THEN the preference field now references `"TeamB".`

**AC-RI-14 — Date-range shrink removes out-of-range date references.**
GIVEN a date `"31" referenced by a preference and range currently covering it,`
WHEN `updateDateRange sets a new range that excludes "31",`
THEN `"31" is removed from date group members and filtered out of every`
preference/export reference; preferences left with an empty required date field
are dropped.

**AC-RI-15 — Reserved-keyword or derived-date rename is refused.**
GIVEN an attempt to rename an auto-generated date item, or to rename/delete to a
reserved keyword,
WHEN the corresponding `updateItem/updateGroup/deleteItem/deleteGroup`
runs,
THEN state is unchanged and a `<ERROR_SHOULD_NOT_HAPPEN> diagnostic is logged;`
no cascade runs.

**AC-RI-16 — Empty deletion set is a no-op.**
GIVEN `deletedIds = [],`
WHEN `applyReferencesForIdDeletion runs,`
THEN state is returned unchanged (all three sub-passes short-circuit).

**AC-RI-17 — Group members keep their position after rename.**
GIVEN a group whose `members` are `["P1", "P2"]` and `P1` is being renamed to `PX`,
WHEN the rename runs,
THEN the group's `members` list is `["PX", "P2"]` — the id is rewritten in place at
its existing position; member order is preserved and never re-sorted to item order.

**AC-RI-18 — Contracted Hours separate identity cascades from derived repair.**
GIVEN a marked count that references a worked Shift Type or group,
WHEN that id is renamed or deleted,
THEN the existing selector/coefficient cascade runs normally; BUT WHEN membership,
working time, or a new worked Shift Type changes the selector's current expansion,
THEN stored coefficients and target remain unchanged and validation reports any exact
coverage mismatch until explicit Refresh/edit.

**AC-RI-19 — Nested group identities remain resolvable.**
GIVEN later group `B` references earlier group `A`,
WHEN `A` or an item reachable through `A` is renamed/deleted,
THEN `B.members` is rewritten/pruned in the same committed transition, group definition
order is unchanged, and both generic and marked selectors using `B` remain either valid
or fail the normal explicit empty/unresolved validation—never a stale unknown id.

**AC-RI-20 — Date shrink distinguishes survival from deletion.**
GIVEN a marked count whose `countDates` partially overlap dates removed by a range shrink,
WHEN at least one selected date remains, THEN the rule survives with target(s) byte-exact;
WHEN no selected date remains, THEN FR-RI-11 deletes the entire rule. Each outcome is one
global history transition, and one Undo restores the complete preceding state.

## Cross-References

- Preference field shapes and the six editable preference types (excluding
the always-present `at most one shift per day, which has no reference`
fields): see spec 01 and the preference editor specs (03, 04, 05, 11).
- Export layout shapes (formatting rules, extra columns, extra rows): see
spec 09.
- Auto-generated date items and range regeneration: see spec 02.
- Reserved keywords (`ALL`, `OFF`, `LEAVE`): see spec 01.
- YAML import that can introduce nested reference trees: see spec 08.
- History wrapping every mutation: see spec 07.
- Shipped cascade code (current app): `web/lib/cascade/` (`renameEntity`,
`deleteEntity`).
