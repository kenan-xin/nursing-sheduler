# Temporary cover nurse: a first-class concept

Confidence: 7.2/10

The solver side is well grounded. Core already renders OFF as a blank Excel cell (`core/nurse_scheduling/exporter.py:471-481`, asserted at `:504`). The compile step emits only existing preference shapes. So `core/` needs no change. Three things lower the score. The pending-row path is new UI logic that reuses g1p code the d582 plan meant to revert. Two decisions below are mine, not the user's: where cover lives in the Workspace file, and dropping (not converting) old `temporary: true` staff. The raw Optimize download can still show her extra-column counts (Q1).

**Beads:** `nursing-sheduler-d582` (this spec, which supersedes the intent of the plan `plans/2026-09-26-d582-remove-borrowed-rows.md`), `9h6` (superseded), `2vtv` (the offer to re-run Optimize).

**Binding user decisions (2026-09-26, d582 notes):**
- She is EXTERNAL. She comes from another ward for specific date+shift slots, one time only, and never belongs to this ward.
- She has her own **Temporary cover** section on the Staff screen: name, from-ward, skill group, and one or more date+shift slots. The assistant fills the same form.
- She is staffing only. She counts toward staffing requirements by her skill group. No ward rule touches her (counts, fairness, sequences, preferences, everyone-scoped rules). Her shift is fixed, and Optimize never moves it.
- On the roster and in Excel she is a row with only her shift(s) filled. Every other day is BLANK, never OFF.
- When she is added to a solved roster, her row appears at once and the app offers to re-run Optimize. The assistant runs it only after the user confirms (2vtv).
- Core stays unchanged and close to upstream v1. The web compiles her into ordinary solver input.

---

## 1. Data model and scenario file

**Store.** Add one slice to `ScenarioStateShared` (`web/lib/scenario/types.ts:614`):

```ts
export interface UiTemporaryCover {
  _k?: string;               // React key, F2-only
  name: string;              // unique in the person namespace (staff ids, cover names, group ids)
  fromWard: string;          // free text, non-empty: "Ward 3", "Relief pool", "Agency"
  group?: GroupId;           // her skill group; absent = counts only where a shift is open to ALL
  slots: { date: IsoDate; shiftType: ShiftTypeRef }[];  // >=1, at most one per date, worked shifts only
}
// ScenarioStateShared.temporaryCover: UiTemporaryCover[]
```

- She is **not** in `staff`, so the Staff table, groups, Requests matrix, rules pickers and ALL never list her.
- `createEmptyScenarioUiState` (`canonical.ts:355`) gets `temporaryCover: []`. The persistence validator (`lib/store/persistence.ts`, next to `:277`) accepts a missing slice as `[]`. The fingerprint projection (`lib/store/fingerprint.ts`) includes it, so a cover change marks the scenario dirty and the roster stale.
- Cascades (`lib/cascade/rename.ts`, `delete.ts`):
  - Renaming a shift type or group follows into `slots[].shiftType` and `group`.
  - Deleting a shift type drops the slots that use it. A cover left with no slots is removed.
  - Deleting her group clears `group`.
  - A name collision raises the existing `RenameCollisionError`.

**Workspace file (Save/Load).** Add an optional top-level `temporaryCover` to Workspace V1. An empty list is omitted. Files without cover stay byte-identical.

```yaml
temporaryCover:
  - name: Haseena
    fromWard: Ward 3
    group: RN
    slots:
      - { date: 2026-10-14, shiftType: N }
```

- **TS:** add it to the V1 schema, `buildWorkspaceDocument` (`workspace.ts:608`) and the hydration bridge.
- **Python** (`core/nurse_scheduling/server/workspace.py:156`, `WorkspaceSchedulingDataV1`, `extra="forbid"`): accept the field. `convert_workspace_to_strict` (`:542`) rejects a non-empty list with a located issue at `temporaryCover`. The message is "compile temporary cover in the app before submitting". The web never submits it (see §2), so the compile logic is not duplicated in Python. Differential fixtures with cover are TS-only.
- The version stays `workspaceVersion: 1`, because the change is additive. An older build rejects a file that has cover, loudly. That is acceptable (Q5).

**Strict YAML export** (`prepare-export.ts:105`) is solver input, so it emits the **compiled** document (§2).

**Migration of old data:**
- **`temporary: true` staff.** The flag shipped to `origin/main` (e220807), so production files carry it. Import (`import-scenario.ts:252`, `schemas/import.ts:38`), Workspace hydration and persisted state accept and drop it. She stays ordinary staff with the pins she already has, so solver behaviour is unchanged (the solver never read the flag). `collectImportWarnings` (`prepare-scenario-load.ts:229`) adds one note per person: "X was marked Temporary. Temporary nurses now live under Temporary cover on the Staff screen. If X covers specific shifts, move X there." Nothing is auto-converted (Q6).
- **Stored roster submissions** whose frozen `canonicalYaml` has `temporary: true`: accept and drop the field at the stored-submission parse boundary (`lib/roster/context.ts`), the same way l1f drops `country`.
- **Roster files and stored rows at `roster-file/2`:** see §4.

## 2. Compile step (web, at submission)

One pure function in a new `web/lib/scenario/temporary-cover.ts`:

```ts
compileTemporaryCover(state: ScenarioUiState): ScenarioUiState   // identity when no in-period cover
toSolverDocument(state) = toCanonicalScenarioDocument(compileTemporaryCover(state))
```

It works at the UI-state level, so every consumer that must "see" her gets her by calling it, with no second projection. Examples are `findStaffingShortfalls(state)` (`lib/rules/shortfalls.ts:313`) and the canonical projection.

**Call sites switch to `toSolverDocument`:**
- the Optimize submit (`components/optimize/optimize-and-export-screen.tsx:478`)
- the AI diagnostic rerun (`lib/ai/diagnostic/diagnostic-orchestrator.ts:333`)
- the strict export (`prepare-export.ts:105`)
- the static shortfall analysis

Save/Workspace, the fingerprint and the assistant's scenario context keep the **authored** form. `projectScenarioDocument` itself does not change.

For each cover `c` with at least one slot inside `rangeStart..rangeEnd`:

| Output | How | Why it holds |
|---|---|---|
| Person | Add `{ id: c.name }` to `staff` (no description, no history). | An ordinary `Person` (`models.py:57`). |
| Skill group | Add `c.name` to `members` of group `c.group`. | Requirements and `skillMix` that name the group count her. `ALL` qualifiers count her anyway. |
| Fixed shift | One `reqData` cell per in-period slot: `{kind: "request", person, date, shiftType, weight: Infinity}`. | A hard shift request. Optimize cannot move it. |
| Absent elsewhere | One `{kind: "off", person, date, weight: Infinity}` per other date in the period. | The one-state-per-day constraint (`scheduler.py:362`) plus a hard OFF means she works nothing else. |
| Excluded from rules | In every **non-staffing** selector, `ALL` becomes `W` = a generated group of every non-cover person. Any group whose expansion contains a cover nurse becomes its generated twin (the same members, flattened, minus cover). | "No ward rule touches her." |

**Staffing selectors are left as authored (she counts):**
- requirement `qualifiedPeople` and `skillMix[].people`
- `export.extraRows[].countPeople`

`skillMix` needs `qualifiedPeople` to stay `ALL` (`models.py:401`). That is one more reason not to rewrite requirements.

**Non-staffing selectors (rewritten):**
- count `person`, succession `person`, affinity `people1/people2`, covering `preceptors/preceptees`
- authored `reqData.person`
- `export.formatting[].people` (row, people-header, history and cell rules)

Rewriting the formatting rules keeps OFF-request or request-satisfied cell rules from styling or annotating her row. Generated group ids are `"<G> (ward staff)"` and `"Ward staff"`, suffixed ` 2`, ` 3`… until unique. Twins keep nested affinity structure intact, because a group ref is replaced by a group ref and never by an inline list.

**Out of period.** Slots outside the range are skipped. A cover with no in-period slot is not compiled at all, so she is not a person for that run. The entry is **kept**, not deleted (§5).

**Validation** (producer issues, located at `temporaryCover.<i>...`, blocking Optimize like any other issue):
- the name is unique in the person namespace
- `fromWard` is non-empty
- the group exists
- each slot's shift type exists and is a worked shift (not OFF, LEAVE or ALL)
- no two slots share a date

**Identity rules** (tested as properties):
- With no in-period cover, `toSolverDocument(s)` deep-equals `toCanonicalScenarioDocument(s)`, so a ward without cover submits identical bytes.
- Anonymization (`prepare-optimize-submission.ts:171`) treats her as one more person, and the reverse map covers her.

**Results mapping.** She comes back as an ordinary solved person. Her `solvedDays` row is `shift` on her slots and `off` elsewhere (`scheduler.py:162-172`). What makes her "cover" on the roster is metadata captured at submit:
- `buildStagedSubmission` (`lib/optimize/submission-snapshot.ts:91`) gets an optional `cover` field: the in-period entries as `{id, fromWard, group?, slots: [{iso, shiftId}]}`. Old snapshot rows read as `[]`.
- `assembleRosterDocument` copies it into the roster document's `cover` (§4).

**Blank, not OFF.** Core can express it without change:
- The workbook writes `""` for OFF (`exporter.py:471-481`, asserted at `:504`).
- The roster payload says `{"kind": "off"}` (`scheduler.py:170`), and the web chooses how to display it (`OFF_DISPLAY = ""`, `lib/roster/day-state.ts:12`).

The only leak is `export.extraColumns`. They have no `people` field. Under prettify they render on every person row (`exporter.py:370`). An OFF-count column then prints a number on her row. The web blanks those cells (§4). The raw Optimize-screen download is core bytes and is not post-processed (Q1). If Q1 asks for a fix, the least-core-change fix is also in the web: run the same blanking in `restorePeopleIdsInXlsx` (`lib/optimize/restore-people-ids-in-xlsx.ts:309`). No core patch is needed.

## 3. Staff screen: the "Temporary cover" section

This is a third card below Staff groups on `/people` (`components/people/people-table.tsx`). It copies the prototype's section pattern (`docs/design_prototype/source/ScreenStaff.dc.html:116-135`): an L1 `Surface` on `--r-card`, a header band with the title, a one-line `--ink2` description and a secondary pill `+ Cover`, then the body. The table is square (DESIGN.md §5 Radius).

- **Header:** "Temporary cover". The description reads "Nurses from another ward for specific shifts. They count toward staffing only. Ward rules do not apply to them."
- **Row** (a real `<table>`: Nurse / From / Group / Shifts / Actions):
  - The name has avatar initials.
  - "From" shows `fromWard` in `--ink2`.
  - The group is a chip.
  - Shifts are palette chips (`shift-chip.tsx` builder) labelled `Night · 14 Oct`.
  - Actions are Edit and Delete. There is no Duplicate and no drag-reorder.
- **Inline editor** (same pattern and `Sel` single-selection as staff rows):
  - Fields: name `Input`, from-ward `Input`, group select (with "None"), and a slot list. Each slot is a native `<input type="date">` bounded to the period, plus a shift select (worked shifts only).
  - "+ Add shift" adds a slot, and each slot has a remove button.
  - Save is one `scenarioCommands.mutate` (one undo entry). Validation messages come from §2, shown inline.
- **Out-of-period slot:** its chip is muted with the tip "Outside this schedule's dates (1-28 Oct). Not used." A cover with only such slots shows a `NOT IN THIS PERIOD` badge (neutral tier). Nothing is auto-deleted.
- **Empty state:** the dashed `∅` pattern. The title is "No temporary cover". The text is "Add a nurse from another ward for the shifts they will work."
- **After Save or Delete while a working roster exists:** a `Callout tone="info"` reads "Haseena is on the roster for Night on 14 Oct. Run Optimize again so the rest of the roster plans around her." Its `Run Optimize` button opens the Optimize screen. It does not start a run.
- The `Temporary (borrowed or agency)` switch and the `Temporary` badge on staff rows are removed (`people-table.tsx:612-617`, `:789-852`).

## 4. Roster viewer, roster file and Excel

**`roster-file/3`.** The shape is v2's minus `borrowed`, plus `cover`:

```ts
readonly cover: readonly RosterCover[];   // solver-seen cover, captured at submit
interface RosterCover { id: PersonId; fromWard: string; group?: string;
                        slots: readonly { iso: IsoDate; shiftId: ShiftTypeId }[] }
```

`validateRosterDocument` requires, for each entry:
- `id` is in `context.people`, once
- the slot isos are in `calendar`
- the slot shift ids are known
- her `solvedDays` row equals the slot-derived row (shift on slots, off elsewhere)
- **no `edits` entry** touches her row

**Reading older versions.** The reader accepts v1, v2 and v3, and the writer writes v3. Reuse the d582 plan's §2 unchanged:
- The `2→3` migration deletes `borrowed`, drops edits on the borrowed axis, and returns a note per dropped row.
- `upgradeStoredRosterDocument` returns notes, and a `roster-upgrade-note` Callout shows them until the next save.
- The new step also adds `cover: []`. A v1 or v2 roster has no cover metadata. A person solved from an old flagged scenario is ordinary staff.

**Pending cover (added after the solve, before a re-run).** These rows are **derived, never stored**:

```ts
pendingCoverRows(document, liveCover): RosterCover[]
```

It returns the live `temporaryCover` entries whose name is not in `context.people`. It filters slots to the roster's calendar and shift ids, and keeps entries with at least one slot. The Staff form or the assistant saves her, and her row appears at once. Delete her, and the row goes. No cross-store write and no roster autosave revision are needed. The roster JSON file does not carry pending rows (Q2).

**Axis and lenses** (reusing the g1p axis helpers, renamed):
- `rosterAxisContext`: the people axis is `context.people` then the pending rows. Pending cells are `off` except on slots. Every row gets `cover?: {fromWard}` from `document.cover` or the pending entry.
- **Grid** (`roster-grid.tsx`):
  - The cover name cell shows the name plus `fromWard` in `--ink3` ("Haseena · Ward 3"). This replaces the `temporary` badge at `:282`.
  - Her `off` cells render **empty**: no chip and no `·` rest glyph (`:657`).
  - Her cells are read-only, with the tip "Temporary cover. Change it on Staff."
  - A pending row has a neutral `NOT OPTIMIZED YET` badge.
- **Staffing** (`requirements.ts`, `coverage.ts`, day lens): solver-seen cover is already in the submission's groups. Pending rows join via `withBorrowedPeople` → `withCoverPeople(document, pending)` (`requirements.ts:275`, keyed by `group`).
- **Rule model / tallies** (`rule-check.ts`, `tallies.ts`): skip every cover row. Solver-seen cover is already outside the rules, because the submission's non-staffing selectors were compiled to twins. The skip also covers pending rows, and it replaces d88's `narrowedCounts`.
- **Change banner:** a callout shows while pending rows exist. It reads "Haseena was added after this roster was optimized. Run Optimize again so the rest of the roster plans around her." It has `Run Optimize`, and the assistant offers the same (2vtv). A new run replaces hand edits, and the existing Load confirmation guards that.

**Edited XLSX** (`lib/roster/edited-xlsx.ts`). Any cover row forces the ExcelJS path, past the no-edit short-circuit at `:145`.
- Pending rows are inserted after the last person row. Keep the 6iw insert, `copyRowStyle`, and conditional-format shifting (`:209-226`, `:316-396`).
- On every cover row:
  - column 1 is `"<name> (<fromWard>)"`
  - day cells are the shift id on slots and `""` elsewhere
  - `extraColumns` cells are blanked
- Solver-seen rows already have blank days in the frozen workbook. Only the label and the extra columns change.

## 5. When the period no longer includes her dates

- Changing `rangeStart..rangeEnd` never edits `temporaryCover`.
- Compile skips out-of-period slots. A cover with no in-period slot is not a person in the run (§2).
- The Staff section mutes those slots and badges the entry (§3). The user deletes it by hand.
- `pendingCoverRows` filters to the roster's own calendar, so an old roster never shows a cover whose dates it does not contain.
- A solved roster keeps its `cover` metadata whatever the scenario later does.

## 6. Assistant

**New commands** (`lib/proposal/commands.ts`, model-visible, locked-schema tests):
- `add_temporary_cover {name, fromWard, group?, slots: [{date, shiftType}]}`
- `remove_temporary_cover {name}`

Their operations call the same pure write as the Staff form's Save, with the same §2 validation. So "the assistant fills the same form" means one write path. `diff.ts` renders "Adds Haseena (Ward 3) as temporary cover: Night 14 Oct".

`add_person` / `edit_person` lose `temporary` (`commands.ts:259,265,753-775` and `operations.ts:1454,1500,1510`).

**Cover ladder step 3** (`prepare_borrowed_cover`, `components/ai/use-roster-tools.ts:688`). `borrowParameters` (`:123`) changes:
- `source` becomes `fromWard: string` ("the ward, pool or agency lending the nurse, as the user said it").
- Add `lenderConfirmed: z.boolean()` ("true ONLY after the user said in chat that <fromWard> confirmed <name> for <shift> on <date>").
- Add `sameNurseForAll: z.boolean().optional()`.

The handler behaves as follows:
- If `lenderConfirmed` is false, it refuses.
- If `ladder.borrow.length > 1 && !sameNurseForAll`, it refuses with "One temporary nurse covers one shift. Ask for a nurse per shift, or whether one nurse covers them all."
- It emits `add_temporary_cover` (slots = `ladder.borrow`, group = the need's `skillGroup`) plus the asking nurse's leave or off request, as today.
- It emits no `add_person`, no pins and no roster cells for her. Her row is derived (§4).
- The `borrowed_staff_arranged` lookup (`:784`) and the 6yn `scenarioStaffGroupIds` guard go. Form validation (group exists) replaces the guard.
- Its return names `OPTIMIZE_RUN_TOOL` (`lib/ai/assistant/playbook.ts:65`) as the next step. 2vtv owns the confirmed run.

The authority statement (`scenario-context.ts:125`) says step 3 asks the lending ward's confirmation **in chat** first. The scenario context JSON shows `temporaryCover` in authored form.

**Repair option `borrow_temporary_nurse`** (`lib/ai/assistant/repair-options.ts:583-695`):
- It emits one `add_temporary_cover` per short (date, shift) slot, repeated for that slot's gap. The name placeholder is "Borrowed nurse n" (`placeholderNames`), `fromWard` is "Another ward", and the group is the need's group.
- The whole-period `cap_short` loan is dropped: with no shift-date, no borrow is offered.
- Removed: `narrowedCounts`, `pinnable`, `shortShift`'s null case, and `temporary: true`. Compile makes all of them unnecessary.
- `enforcedBy: "chat"`, with the same `confirmationQuestion`. `needsFromUser` asks for the name and the lending ward.
- The `isSafeOption` `add_person` arm (`:1262-1269`) becomes an `add_temporary_cover` arm: slots in period, known worked shifts, one per date.

**Removed from the proposal layer:** `borrowed_staff_arranged` and `borrowedStaff()` (`lib/proposal/assumptions.ts:33,45,~250-290`), plus the `staff` undo copy for "the added temporary nurse" (`components/ai/linked-apply.ts:39`).

## 7. What is removed, kept and reshaped

| Item | Fate |
|---|---|
| The `temporary` flag in types, producer (`producer.ts:52`) and projection (`canonical.ts:93`) | Removed. Accept-and-drop on read (§1). |
| `writeTemporary`, the Staff table switch and badge, `diff.ts:496`, help copy (`lib/capability/help-content.ts`) | Removed. |
| g1p `borrowed` field, `RosterBorrowedRow`, `checkBorrowedRows`, `withBorrowedRows`, the overlay on the borrowed axis, `RosterContextPerson.temporary` (081e608) | Removed. `cover` + derived pending rows replace them. |
| d2b3ff9 stale-row refusal, fd46b3b undo of borrowed rows, 9a767b3 group guard | Removed. Pending rows are derived, so nothing needs refusing or undoing. |
| `rosterAxisContext`, `withBorrowedPeople`, the 1a1e95c ladder axis counting, the 6iw insert and CF shifting, olu `qualifiedGroup` | **Kept and renamed** to cover terms. The d582 plan's revert list is **not** executed as written. |
| 46d01d2 `narrowedCounts` in `rule-check.ts` | Replaced by "the rule model skips cover rows". |
| d582 plan §2 (roster-file/3, the v2 read, notes plumbing) | Reused, plus `cover: []` in the migration. |
| `core/` | No change. Retiring upstream patch P1 (`Person.temporary`, `models.py:66`) is a follow-up bead, once no stored strict YAML needs it. |

## 8. Testing strategy

All layers follow the repo's library-first rule: no parsers and no source reads in tests.

- **Compile (Vitest, pure):**
  - Table-driven per selector kind. `ALL` and a group with her become twins.
  - Requirements and `skillMix` stay untouched. Nested affinity keeps its shape.
  - An id collision gets a suffix. Out-of-period slots are skipped.
  - Property: no in-period cover means `toSolverDocument` deep-equals `toCanonicalScenarioDocument`.
  - Property: every compiled document passes `validateScenario`.
- **Solver truth (the real backend, existing assembled e2e pattern `e2e/roster-real-ward-assembled.spec.ts`):**
  - A small ward is short one RN on Night 14 Oct. With Haseena covering it, the solve is feasible.
  - Her row has N on 14 Oct and blank cells elsewhere.
  - A hard ward-wide `x >= 16` count rule does not bind her.
  - The workbook row has only her shift.
- **Roster (Vitest):**
  - validation of `cover`, including rejecting edits on her row and a mismatched solved row
  - `2→3` migration with notes, and v1→v3
  - `pendingCoverRows` filtering
  - grid: an empty cell (no `·`), the read-only tip, the `NOT OPTIMIZED YET` badge
  - requirement and coverage counts including pending rows
  - the rule model and tallies skipping cover
- **Edited XLSX** (the existing ExcelJS suite, with the `DIFF_PYTHON` gate where it applies):
  - A pending row is inserted with its style. CF ranges shift.
  - The label is `"Haseena (Ward 3)"`. Day cells are `""`. Extra-column cells are blank.
- **Scenario I/O:**
  - Workspace round-trip with and without cover. With no cover, the file is byte-identical.
  - Python `workspace.py` rejects a non-empty `temporaryCover` with a located issue (pytest).
  - Old `temporary: true` loads with a warning and the flag is dropped, on import, Workspace, persisted state and stored submission.
  - Cascades: rename and delete of a shift type or group.
- **Staff UI** (Testing Library): each add, edit or delete is one undo step. Also test the inline validation messages, the out-of-period badge, and the callout with a working roster present. A Playwright visual baseline for the new section follows the existing components baselines.
- **Assistant:**
  - the locked schemas for `add_temporary_cover` and `remove_temporary_cover` and the new `borrowParameters` keys
  - `prepare_borrowed_cover` refusals (`lenderConfirmed` false, several needs without `sameNurseForAll`)
  - the emitted commands
  - repair-option cases: per-slot nurses, gap of 2, no cap-only loan, `isSafeOption`
  - updating the existing `repair-eval.test.ts` expectations

---

## Unresolved questions

1. **Raw Optimize download.** Under prettify it shows her extra-column counts, for example an OFF-count column. Accept that, or also blank them in `restorePeopleIdsInXlsx`? That path runs only for anonymized runs today (unconfirmed). Plain runs then need a new pass.
2. **Pending rows in the shared roster JSON file.** They are derived from the live scenario and are not saved into the file. Is that acceptable, given that a re-run is the expected next step?
3. **"The assistant fills the same form."** I read this as the same data and the same write path, shown on a Preview card. Did the user mean Apply opens the Staff form prefilled?
4. **Skill group optional?** With no group, she counts only on shifts open to ALL.
5. **Workspace format.** Additive `temporaryCover` under `workspaceVersion: 1`, or a bump to 2?
6. **Old `temporary: true` staff.** Drop the flag with a note (chosen), or auto-convert a person whose pins match the old C1 shape exactly?
7. **Submission format drift.** The genie sync spec (`2026-09-25-v1-genie-sync-design.md:18`) says the web submits Workspace V1. The code submits strict canonical YAML (`optimize-and-export-screen.tsx:478`). Suppose the W-plans switch to Workspace submission. Compile must still run in the web first, because `workspace.py` rejects cover.

## Assumptions

- A cover nurse works at most one slot per date, and slots are worked shifts only (not LEAVE, OFF or ALL).
- She counts in `export.extraRows` daily counts (staffing), but not in formatting rules or per-person extra columns.
- Excel shows her as `"<name> (<fromWard>)"` only in the edited export. The raw core workbook shows the plain id.
- Twin-group ids appearing in the submitted YAML and in roster rule messages are acceptable ("RN (ward staff)").
- A pending row does not change `solvedBaselineId`, because it is not stored.
- Hand edits are lost on re-run, as today. The existing Load confirmation covers it.
- The g1p family is on `origin/develop`, not on `origin/main` (per `git merge-base`). The `temporary` flag is on `origin/main`.
