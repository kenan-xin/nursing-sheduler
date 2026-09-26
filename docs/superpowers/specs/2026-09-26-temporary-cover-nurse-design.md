# Temporary cover nurse: a staffing credit, not a solver person

Confidence: 7.6/10

The model is small, and every piece rests on read code. The solver counts per requirement equation (`core/nurse_scheduling/preference_types.py:81-124`). A per-date count already exists (`requiredNumPeopleOverrides`, `:79-82`). All web staffing reads go through a few seams: `requiredOn` (`web/lib/rules/shortfalls.ts:265`), `buildEquations` (`web/lib/roster-viewer/requirements.ts:302`) and the Excel restoration boundary (`web/lib/optimize/restore-people-ids-in-xlsx.ts:227-270`). Three things lower the score:
- A per-date override is per **card**, not per equation (`preference_types.py:82`). Multi-shift cards therefore need a split at submission (F1).
- Skill-mix floors and `preferredNumPeople` have no per-date form, so a cover cannot lower them (F1, F2, open question).
- The un-decrement ledger for solved rosters (§4) is new bookkeeping.

**Beads:** `nursing-sheduler-d582` is this spec. It supersedes the plan `plans/2026-09-26-d582-remove-borrowed-rows.md` and every earlier version of this file. Related: `9h6` (superseded), `2vtv` (the offer to re-run Optimize), `iwo` (Apply opens the changed screen).

**Binding user decisions (d582 notes, memories `temporary-nurse-concept` and `assistant-apply-navigates`):**
- A temporary cover is **not** a solver person. A cover entry is a name (for example "Haseena (Ward 3)"), a date, a shift type, and optional staff groups.
- A cover lowers that date's staffing requirement for that shift by one, through the per-date exception mechanism, and carries her name.
- The roster viewer and every Excel export show one display row per cover name. Only her shift(s) are filled. Her per-person summary cells are blank.
- The Staff screen has a "Temporary cover" section. The assistant's Apply opens it and fills the form in view.
- The `temporary` flag and the g1p borrowed rows go, with no migration.
- Staff groups are arbitrary. There is no "skill group" concept.
- After a cover change on a solved roster, the app offers to re-run Optimize (2vtv).

---

## 1. Data model

**Store.** Add one slice to `ScenarioStateShared` (`web/lib/scenario/types.ts:614`). Each entry is one shift:

```ts
export interface UiTemporaryCover {
  _k?: string;          // React key, F2-only
  name: string;         // display label, e.g. "Haseena (Ward 3)"; not a person id
  date: IsoDate;
  shiftType: ShiftTypeRef;   // a worked shift type id
  groups: GroupId[];    // existing staff groups she counts as; may be empty
}
// ScenarioStateShared.temporaryCover: UiTemporaryCover[]
```

- Entries that share a `name` are one person: one display row, with several shifts.
- She is not in `staff`, so no staff list, picker, rule or ALL ever contains her. She is never in the solver document.
- `createEmptyScenarioUiState` (`canonical.ts:355`) gets `temporaryCover: []`. The persistence validator (`lib/store/persistence.ts`) requires the slice. The fingerprint (`lib/store/fingerprint.ts`) includes it, so a cover change marks the scenario dirty and the roster stale.
- **Workspace file:** an optional top-level `temporaryCover` list under `workspaceVersion: 1`. An empty list is omitted. This is the least-risk choice. Files without cover stay byte-identical and load in every build. Only a file with cover fails in an older build, and it fails loudly on the unknown field. The Python half (`core/nurse_scheduling/server/workspace.py:156`) accepts the field. `convert_workspace_to_strict` (`:542`) rejects a non-empty list with a located issue at `temporaryCover`, because the decrement is a web step (§2).
- **Strict YAML export** (`prepare-export.ts:105`) is solver input, so it carries the decremented counts (§2).

## 2. The decrement: stored apart, applied when read

Covers are **never written** into a card's `requiredNumPeopleOverrides`. The stored card holds only hand-written exceptions. One pure module, `web/lib/scenario/temporary-cover.ts`, applies the covers wherever a staffing count is read:

```ts
coverCredit(equation, iso, covers, groupsContaining): number   // sum of her coefficients, eligible covers only
wardNeed(count, credit) = Math.max(0, count - credit)
withCoverOverrides(state): ScenarioUiState   // derived, never stored or saved
```

`withCoverOverrides` writes, per card and covered date, `wardNeed(requiredOn(card, iso), credit)` as a derived override. It merges with any hand override on that date and drops any result equal to the rule's own count. That is the existing normalization in `2026-09-24-per-date-staffing-override.md`.

**Why stored apart (F3):**
- Removing a cover restores the count exactly, because nothing was overwritten.
- A hand edit to the same exception composes. A hand "2 on 14 Oct" with one cover means the ward supplies 1.
- A renamed or deleted card or shift type, and a period change, cannot leave a stale exception behind. `dropUncoveredOverrides` (`shortfalls.ts:283`) stays hand-only.

**Which cards a cover lowers.** Take a cover with date `d`, shift `s` and groups `G`. It lowers exactly the requirement equations that count her as a person. The rule mirrors `preference_types.py:83-120`:
1. The card is enabled, and `d` is one of its resolved dates (`requirementDateIsos`, `shortfalls.ts:252`).
2. One of its top-level shift selectors expands to a set containing `s` (`preference_types.py:83`). That selector's equation is the one she counts in.
3. She is eligible (`:104-109`). One of these holds:
   - `qualifiedPeople` is absent or `ALL`.
   - One of its refs is a group in `G`, or a group that contains a group in `G` (group closure via `lib/rules/expansion.ts:119`).

   A person-id ref never matches her.
4. Her credit is the card's coefficient for `s`, default 1 (`:120`). For a plain card that is "by one".

**Where it is applied:**
- the Optimize submit (`optimize-and-export-screen.tsx:478`)
- the AI diagnostic rerun (`diagnostic-orchestrator.ts:333`)
- the strict export (`prepare-export.ts:105`)
- the static shortfall check (`findStaffingShortfalls`, `shortfalls.ts:313`)
- Preview and diff (`lib/proposal/diff.ts:249,270`)
- the repair options (`repair-options.ts:752,1039,1151,1197`)

Each site calls `toCanonicalScenarioDocument(withCoverOverrides(state))` or reads `requiredOn` on the derived state. Save, the fingerprint and the Requirements editor keep the authored state.

The code submits strict canonical YAML (`optimize-and-export-screen.tsx:478` → `prepareOptimizeSubmission`). The genie sync spec line that says "The web submits Workspace V1" (`2026-09-25-v1-genie-sync-design.md:18`) is stale. Correct it at the next edit of that spec.

With no cover, `withCoverOverrides(state)` returns `state` itself, so the submitted bytes do not change.

## 3. Foot-guns

Each item gives a decision and the test that pins it.

**F1. Overlapping cards, groups, skill mix and shift-type groups.**
- *Decision:*
  - Every equation she counts in (§2 rule) is lowered, and no other.
  - An all-staff card is lowered for any cover. A card with `qualifiedPeople: RN` is lowered only for a cover in RN. A non-member lowers only open cards.
  - An aggregate selector is one equation. Examples are `[[AM, PM]]` and a shift-type group "Day" = AM+PM. A cover on AM or PM lowers it.
  - Several top-level selectors (`[AM, PM]`) make two equations. One per-date override applies to every equation on that date (`preference_types.py:82`). So an override cannot lower one shift only.
  - For such a card, `withCoverOverrides` splits it at submission into one card per selector with identical fields. It does this only for a card that a cover touches. The split is solver-equivalent, because each selector is already its own equation and its own preferred-count objective (`:83-152`). Authored state is untouched.
  - **Skill-mix entries are not lowered.** They have no per-date form, and adding one is a core change. A cover in the mix group does not satisfy the floor. The form and the Preview say: "Haseena is in RN, but this rule's RN skill mix still needs 1 RN from the ward." See the open question.
  - A card can restrict a shift to a group she is not in. Then the form warns: "Under <rule>, only RN work N. Haseena is not in RN." She still counts for the open cards.
- *Tests* (`temporary-cover.test.ts`, table-driven):
  - `lowers the all-staff card for a cover with no groups`
  - `lowers a qualifiedPeople card only for a member`
  - `lowers an aggregate shift-group card for either member shift`
  - `splits a multi-selector card and lowers only the covered shift`
  - `leaves skill-mix floors untouched`
  - `nested group membership counts`
  - plus one real-solver case: `split card is solver-equivalent` (pytest over the two YAMLs: the same status and objective)

**F2. Soft and preferred counts.**
- *Decision:* a requirement's `requiredNumPeople` is always hard (`preference_types.py:121-124`). The cover lowers it. With `preferredNumPeople` set, that number is the floor. `preferredNumPeople` is card-wide and has no per-date form, so it is **not** lowered. On that date the solver still aims for `preferred` ward staff as a soft target. The Preview line says so: "Haseena lowers the minimum. The preferred number stays 4." Per-person soft rules (shift counts with finite weight) never involve her, because she is not a person.
- *Tests:* `lowers the floor and keeps preferredNumPeople`, and `never produces an override above preferredNumPeople`.

**F3. Drift.**
- *Decision:* stored apart and applied on read (§2). A cover that no longer resolves is **flagged, never silently dropped**. That covers a date outside the period, a deleted shift type, a deleted group in `groups`, or no enabled card that she counts in. A flagged cover lowers nothing. The Staff row shows a warning badge with the reason, and Optimize preflight lists it as a non-blocking warning. Renames follow through the cascade (`lib/cascade/rename.ts`). Deletes do not remove covers.
- *Tests:* `removing a cover restores the exact hand-written count`, `hand override and cover compose`, `renamed shift type follows into the cover`, `deleted shift type flags the cover`, `out-of-period cover is flagged and lowers nothing`, `no-card cover is flagged`.

**F4. Several covers on one slot, and covers past the requirement.**
- *Decision:* credits add up. The ward need is clamped at 0 (`wardNeed`). A clamp shows a warning on the form and in the Preview: "N on 14 Oct needs 2 from <rule>. 3 covers are booked, so 1 is extra." The Preview shows the count going to 0, never below.
- *Tests:* `two covers lower by two`, `clamps at zero with an extra-cover warning`, `a requirement already at 0 stays 0 and warns`.

**F5. Every coverage consumer counts her.**
- *Decision:* every staffing reader compares ward staff against `wardNeed` and shows covers alongside ("2/2 from the ward · +1 cover"). The readers:
  - solver input, static shortfalls, Preview and diff, repair options (§2)
  - roster viewer coverage and the per-cell check (`requirements.ts:302`, `coverage.ts`)
  - roster rule-check (`rule-check.ts`, `checkRosterChange`)
  - the swap ladder (`swap.ts` `borrowNeeds`)
  - the assistant's roster summaries (`roster-context.ts`)
  - Excel count rows (§5)

  I searched `web/components` and `web/lib` and found no other staffing reader. Any future reader uses `wardNeed`. On the roster, solved covers are already in the submitted counts, and pending covers apply through the same `coverCredit` (§4).
- *Tests:* one per reader, each named `<reader> counts a temporary cover`, plus the property `no slot with a matching cover reads short`.

**F6. Excel restoration and re-import.**
- *Decision:* her display rows are **appended after the last used row** of the schedule sheet. That is after Status and any extra count rows. A blank separator and a label row "Temporary cover" come first. The rows are never inserted into the people window `[3, 3 + peopleCount)` or before Score/Status. Restoration asserts that boundary and reads column A only inside it (`restore-people-ids-in-xlsx.ts:227-270`). The edited export keeps the same boundary (`edited-xlsx.ts:31-34`). Restoration runs **before** the append. With rows appended below, no insert or conditional-format shifting is needed.
- *Tests:* `restoration of an exported workbook with cover rows reads exactly peopleCount people`, `Score/Status stay adjacent to the people window`, `cover rows are below the extra count rows`.

**F7. Assistant awareness, cancel and no-show.**
- *Decision:* `temporaryCover` appears in the scenario context JSON (`scenario-context.ts:37`) and in the roster context. The host refuses a proposal that repeats an existing name, date and shift. The message is "Haseena (Ward 3) already covers N on 14 Oct." A cancel or no-show is `remove_temporary_cover {name, date, shiftType}`. Its Apply opens Staff and deletes the row in view. The assistant then offers re-Optimize (2vtv), because the slot is now short.
- *Tests:* `context lists covers`, `duplicate cover refused`, `remove_temporary_cover Apply deletes in the form`, `after removal the assistant offers Optimize`.

**F8. The roster after a solve.**
- *Decision:* adding or removing a cover changes the coverage display at once (§4). Solved assignments stay as they are until a re-run. The change banner offers `Run Optimize`, and a new run replaces hand edits (the existing Load dialog guards that).
- *Tests:* `adding a cover after the solve fills the short slot at once`, `removing a solved cover makes the slot read short at once`, `assignments do not change without a run`.

## 4. Roster viewer and roster file

**Roster file.** `origin/main` writes `roster-file/1`. The develop-only `/2` with `borrowed` is dropped with no compatibility. `roster-file/2` is redefined as v1 plus `cover`:

```ts
readonly cover: {
  readonly entries: readonly { name: string; iso: IsoDate; shiftId: ShiftTypeId; groups: readonly string[] }[];
  readonly decrements: readonly [prefIdx: number, iso: IsoDate, by: number][];  // applied at submission
};
```

- The writer writes `/2`. The reader accepts `/1` (the existing `1→2` step at `lib/roster/schema-version.ts:46-56` now adds an empty `cover`) and `/2`.
- A develop-era `/2` with `borrowed` fails exact-field validation (`validate.ts:70`), and that is accepted.
- The entries and decrements come from the staged submission (`buildStagedSubmission`, `lib/optimize/submission-snapshot.ts:91`), computed by the same `withCoverOverrides` run that built the YAML. So the roster knows exactly what the solve already subtracted.

**Coverage on the roster.** For each equation and date:
- authored count = submitted count + solved decrement
- ward need = `wardNeed(authored count, credit(live covers))`

Live covers are the current scenario's covers on the roster's calendar. So a cover added after the solve lowers the need at once, and a solved cover later removed raises it at once (F8). The decrement ledger removes the clamp ambiguity: the submitted count alone cannot tell 0 from "clamped to 0".

**Display rows.** These form a separate band below the staff rows in the same grid (`roster-grid.tsx`), headed "Temporary cover". They are not on the person axis: no `personIdx`, no edits, no rule check, no tallies, no swaps.
- A row is one cover name.
- Cells show her shift chip on her dates. Every other cell is empty: no chip and no `·` rest glyph (`roster-grid.tsx:657`).
- A cover in the live scenario but not in `cover.entries` has a neutral `NOT OPTIMIZED YET` badge. A solved cover since removed from the scenario shows struck through, with `REMOVED`, until the next run.
- The tip is "Temporary cover. Change it on Staff."

## 5. Excel exports

The same helper runs on the **raw Optimize download** and on the **edited roster export**:
- **Raw:** `applyPeopleIdRestoration` (`restore-people-ids-in-xlsx.ts:365`) returns plain runs byte-for-byte today (`:369`). It gains the covers from the staged submission. The bypass now needs a plain run **and** no cover. Otherwise it restores ids (anonymized runs only), then appends.
- **Edited:** `edited-xlsx.ts`. Any cover forces the ExcelJS path past the no-edit short-circuit (`:145`).
- **Rows:** as F6. Column A is the cover name. Day cells hold her shift id on her dates and `""` elsewhere. History and summary (extra-column) cells are `""`. The style is copied from the last person row (`copyRowStyle`, kept from 6iw).
- **Count rows** (`export.extraRows`, `exporter.py:526-532`) count solver people only. The helper adds her credit to a count row's date cell under two conditions. Its `countShiftTypes` contains her shift. Its `countPeople` is `ALL` or contains one of her groups. This covers F5 for Excel.

## 6. Staff screen: the "Temporary cover" section

This is a third card below Staff groups on `/people` (`components/people/people-table.tsx`). It follows the prototype's section pattern (`docs/design_prototype/source/ScreenStaff.dc.html:116-135`). The pattern is an L1 `Surface` with a header band. The band holds the title, a one-line `--ink2` description and a secondary pill `+ Cover`. A square table follows (DESIGN.md §5).

- **Header:** "Temporary cover". The description reads "Nurses from another ward for single shifts. Each one lowers that shift's staffing need by one."
- **Table:** Name / Shift / Date / Groups / Effect / Actions, one row per entry, sorted by date.
  - "Effect" reads "N on 14 Oct: 3 → 2 (All nurses)", or the F1–F4 warning badge.
  - The actions are Edit and Delete.
- **Inline editor:**
  - Fields: a name `Input` and a native `<input type="date">` bounded to the period.
  - A shift select offers worked shifts only. The group toggle chips are the ones ward staff rows use, with none selected by default.
  - Under the chips, one line in `--ink3`: "She counts on rules open to everyone, and on rules for a group she is in."
  - Save is one `scenarioCommands.mutate` (one undo entry).
  - Validation: a non-empty name, a date, a worked shift, groups that exist, and no duplicate name+date. The same name on one date with two shifts is also refused ("one shift a day").
- **Empty state:** the dashed `∅` pattern. The title is "No temporary cover". The text is "Add a nurse from another ward for a shift they will work."
- **Working roster present:** after Save or Delete, a `Callout tone="info"` reads "Night on 14 Oct now needs 2 from the ward. Run Optimize again so the roster plans around Haseena." The `Run Optimize` button opens Optimize and does not start a run.
- **Requirements screen:** a card's "Exceptions" field lists cover effects read-only, apart from hand exceptions: `14 Oct: 2 · Haseena (Ward 3) covering`, with a link to Staff.
- The `Temporary (borrowed or agency)` switch and badge on staff rows are removed (`people-table.tsx:612-617`, `:789-852`).

## 7. Assistant

**Apply is visible (iwo rule).** On Apply:
1. The app opens `/people` through the change-highlight routing (`lib/change-highlight/plan.ts`, scope `staff-list`).
2. It opens the Temporary cover editor prefilled from the command (`origin: "assistant"`), and the fields fill in view. With `prefers-reduced-motion`, they fill at once.
3. It presses the editor's own Save, so there is one write path.
4. The new row takes the change highlight, and `aria-live` announces it.

If validation fails, the editor stays open with the error and nothing is written. A linked proposal walks its screens in `SCREEN_ORDER`, for example Staff (cover) then Requests (the asking nurse's leave).

**Commands** (`lib/proposal/commands.ts`, locked schemas):
- `add_temporary_cover {name, date, shiftType, groups}`
- `remove_temporary_cover {name, date, shiftType}`

`add_person` / `edit_person` lose `temporary` (`commands.ts:259,265,753-775`, `operations.ts:1454,1500,1510`).

**Preview, diff and receipts.** `diff.ts` compares effective counts: `requiredOn` over `withCoverOverrides(before)` against `(after)`.
- Add: "Adds temporary cover Haseena (Ward 3): Night, 14 Oct." with "N on 14 Oct: exactly 3 → 2 (All nurses)", plus any F1, F2 or F4 note.
- Remove: the reverse line.
- The Apply notice (`components/ai/linked-apply.ts:39`) says "Added temporary cover Haseena (Ward 3)."
- The undo copy says "Undo removes the cover and puts Night on 14 Oct back to 3."

**Cover ladder step 3** (`prepare_borrowed_cover`, `components/ai/use-roster-tools.ts:688`, `borrowParameters` `:123`):
- `source` becomes the ward text inside `name` ("Haseena (Ward 3)"). The description asks the model to write the name as the user said it, with the lending ward in brackets.
- Add `lenderConfirmed: z.boolean()`: true only after the user said in chat that the lending ward agreed. False refuses.
- The handler emits one `add_temporary_cover` per `ladder.borrow` need. Its `groups` are the user's `groups`, plus the group the short rule names (olu `qualifiedGroup`, the code field `skillGroup`). It also emits the asking nurse's leave or off request, as today.
- It emits no person, no pins and no roster cells.
- Its return names `OPTIMIZE_RUN_TOOL` (`playbook.ts:65`) as the next step. 2vtv owns the run, after the user says yes.
- `scenario-context.ts:125` says to ask in chat first whether the lending ward agreed.

**Repair option `borrow_temporary_nurse`** (`repair-options.ts:583-695`):
- It emits one `add_temporary_cover` per short (date, shift), repeated for the gap. The name is `"Borrowed nurse n (another ward)"`, and `groups` holds the short rule's named group.
- It is not offered for a skill-mix shortfall (F1) or a cap-only shortfall.
- `enforcedBy: "chat"`. `needsFromUser` asks for the name and the lending ward.
- `isSafeOption` gets an `add_temporary_cover` arm: in period, a worked shift, known groups, and at least one card she counts in.
- Removed: `narrowedCounts`, `pinnable`, the whole-period loan, and `temporary: true`.

**Removed from the proposal layer:** `borrowed_staff_arranged` and `borrowedStaff()` (`lib/proposal/assumptions.ts:33,45,~250-290`).

## 8. Removed and kept

| Commit / item | Fate |
|---|---|
| `temporary` flag (e220807 and its users: `types.ts:143,419`, `schemas/import.ts:38`, `producer.ts:52`, `canonical.ts:93`, `import-scenario.ts:252`, `persistence.ts:277`, `people-descriptor.ts`, `people-table.tsx`, `diff.ts:496`, `help-content.ts`) | Removed, no migration. |
| 081e608 g1p: the `borrowed` field, `RosterBorrowedRow`, `borrowed.ts` and its axis helpers | Removed. |
| 081e608 g1p: `addPeople`, the grid badge and the viewer axis plumbing | Removed. |
| 081e608 g1p: the borrowed paths in `change-request.ts` and `use-roster-editing.ts`, and `withBorrowedPeople` | Removed. |
| 081e608: `upgradeStoredRosterDocument` / `validateStoredRosterDocument` and their callers | Kept, because v1 stored rosters still upgrade. |
| 19515fa g1p (step-3 card writes a roster row) | Removed. Step 3 is rewritten (§7). |
| d2b3ff9 g1p stale-row refusal and `peopleCount` | Removed. Its stored-older-version read tests are kept, restamped. |
| fd46b3b 2rp (undo of borrowed rows) | Removed. |
| 1a1e95c d88 (ladder reads the borrowed axis) | Removed. The ladder reads `wardNeed`. |
| 46d01d2 d88 (`narrowedCounts` in `rule-check.ts`) | Removed. She is never a person. |
| 9a767b3, f3b2d98 6yn (group guard) | Removed. Form validation checks that groups exist. |
| 387f4e3, 01e7b69 6iw (`insertRow`, conditional-format shifting) | Removed, because rows are appended below (F6). `copyRowStyle` is kept. |
| e930ac6 olu (`qualifiedGroup`) | Kept. It prefills her groups. |
| `repair-options.ts` `narrowedCounts`, `pinnable`, the whole-period loan, and `assumptions.ts` `borrowed_staff_arranged` | Removed. |
| `core/` | No change. Retiring upstream patch P1 (`Person.temporary`, `models.py:66`) is a follow-up bead. |

## 9. Other tests

The foot-gun tests are named in §3. All tests follow the library-first rule.
- **Real solver** (pytest plus the assembled e2e pattern `e2e/roster-real-ward-assembled.spec.ts`): a ward one short on N 14 Oct is INFEASIBLE, and FEASIBLE with one cover. Her display row shows N on 14 Oct only.
- **Identity:** no cover means `withCoverOverrides(s) === s` and byte-identical YAML and XLSX.
- **Scenario I/O:** Workspace round-trip with and without cover. Python `workspace.py` rejects a non-empty list with a located issue.
- **Staff UI** (Testing Library): add, edit and delete are one undo step each. Also test the Effect column, the warning badges, and the callout.
- **Assistant:** locked schemas, the `lenderConfirmed` refusal, and the Apply flow (route, prefilled editor, one undo entry, highlight, `aria-live`, a stale Preview writes nothing). Also the repair-option cases and the updated `repair-eval.test.ts` expectations.

---

## Unresolved questions

1. **Skill mix.** A cover in RN does not satisfy an RN skill-mix floor, because skill-mix entries have no per-date form (F1). Accept that, or add a follow-up for an additive per-date `skillMixOverrides` in core, on the same pattern as `requiredNumPeopleOverrides`?

## Assumptions

- A cover name works at most one shift per date.
- A preferred count (F2) staying as a soft target on her date is acceptable.
- Her display rows sit below the count rows in Excel, not next to the staff rows. That is the price of never touching the restoration boundary.
- Splitting a multi-selector card at submission is acceptable. It shows as separate rules in diagnostics for that run only.
