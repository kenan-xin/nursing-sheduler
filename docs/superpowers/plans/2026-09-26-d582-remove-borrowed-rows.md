# d582: remove roster-level borrowed rows; a temporary nurse is ordinary staff

Confidence: 7.0/10

The revert half is well grounded. A probe on a scratch worktree (`b44f90a`) reverted all ten family commits with olu kept, and every conflict was in a test file. The folded-in 9h6 work and the repair-option reshape lower the score:
- They touch the model-visible command schema (locked tests), the scenario format, the stored-submission parse boundary, and `isSafeOption`.
- The loan shape is new logic.
- Typecheck was never run on the probe (it had no `node_modules`).
- Whether persisted scenario state is read strictly on hydrate is unverified.

**Beads:** `nursing-sheduler-d582` (P1) and `9h6`, folded in as Tasks 7-8. **Related:** `2vtv` (assistant add and Optimize, a later plan).

**User decisions 2026-09-26 (binding):**
- A temporary nurse is an ordinary staff member ("Haseena (Ward 3)"). The roster has no borrowed rows and no `temporary` flag. The assistant adds her to Staff, and the user re-runs Optimize.
- **The borrowed-nurse model:** the manager borrows one nurse from another ward for ONE shift type (AM, PM, Long, Night or any custom type) on ONE date, one time only. So she is pinned to that shift on that date (`set_shift_request` "must") and is off on every other date (`set_off_request` "must"). There is one nurse per short shift-date. A nurse covers several named shift-dates only when the user says so.
- The lending ward's confirmation is asked **in chat before the card**. There is no Preview tick-box.
- Writer version: `roster-file/3`.
- The dropped-row note shows on every load until the next save rewrites the roster.

**Branch:** `wt switch --create fix/d582-remove-borrowed-rows --base develop --no-cd` (repo CLAUDE.md flow). Ship it as one merge. The tree is only consistent again after Task 2.

**Why g1p existed:** the roster-aware assistant plan shipped step 3 as C1: a staff change now, and her roster row after the next run (`plans/2026-09-24-roster-aware-assistant.md:9`, `:4634`). Task 12/C2 (`:4607-4620`) added `roster-file/2` so that one Apply could put her row on the solved roster. With the user's decision, C2 is withdrawn and C1 becomes the design.

---

## 1. What to remove and what to keep, per commit

None of these commits are on `origin/main` (checked with `git merge-base --is-ancestor`). Production never wrote `roster-file/2`.

| Commit | Bead | Action | Why |
|---|---|---|---|
| 081e608 | g1p | **Revert.** Then restore by hand the *stored-document upgrade path*: `upgradeStoredRosterDocument` / `validateStoredRosterDocument` (`lib/roster/schema-version.ts:58-76`), their use in `promote.ts:53,114`, `use-working-roster.ts:71-80` and `roster-context.ts:52`, plus the barrel exports (`index.ts`). | Borrowed rows, `RosterBorrowedRow` (`types.ts:161`), `temporary` on `RosterContextPerson` (`types.ts:99`), `borrowed.ts`, grid badge (`roster-grid.tsx:283-292`), axis plumbing (`roster-viewer.tsx:95-141`), `addPeople`, and XLSX row insert all go. Before g1p, stored rows were validated as-is, so a stored older version failed. Upgrade-on-read is independently correct, and Task 2 needs it for v2→v3. |
| 19515fa | g1p | **Revert.** | This restores C1 `prepare_borrowed_cover`: `add_person` + must-off pins + must-shift pins + the asking nurse's leave or off, and cells only for the sick reason. Task 4 adjusts the loan shape and the copy. The capture and e2e pins go back to `/1`, and Task 2 moves them to `/3`. |
| d2b3ff9 | g1p | **Revert** `peopleCount` and the stale-row refusal, and the prettify borrowed-row test. **Keep (re-add in Task 2):** the tests that read a stored older version through `useWorkingRoster` and `readRosterForAssistant`, restamped for v3. | Without `addPeople` the axis cannot grow, so there is nothing stale to refuse. |
| fd46b3b | 2rp | **Revert.** | Undo only restores borrowed rows. |
| 1a1e95c | d88 | **Revert.** | `withBorrowedPeople` and the ladder reading the borrowed axis exist only for borrowed rows. |
| 46d01d2 | d88 | **Revert.** | `narrowedCounts` in `rule-check.ts` shields a borrowed row from the ward's count rules. An ordinary staff member is under those rules by definition. The "swap onto an existing row through `applyRosterChange`" test only uses a borrowed row. The ordinary-row path is already covered in `use-roster-change-request.test.tsx`. |
| 9a767b3 | 6yn | **Revert.** | `scenarioStaffGroupIds` guards borrowed-row groups against the submission. `add_person` groups are checked by the proposal against the live scenario (olu's premise: "add_person was refused"). |
| f3b2d98 | 6yn | **Revert.** | A test fixture for 6yn. |
| 387f4e3, 01e7b69 | 6iw | **Revert.** | Conditional-format shifting and style copy run only on the borrowed `insertRow`. The finding "ExcelJS 4.4.0 `insertRow` does not shift conditional formats" is worth a `bd remember` note. |
| e930ac6 | olu | **Keep in full.** | `qualifiedGroup` (`requirements.ts:98,354-364,417`) feeds `borrowNeeds` (`swap.ts:194-212`). That is the group the step-3 `add_person` joins, and it is still used by the staff path. |

Revert order, newest first: `46d01d2 01e7b69 f3b2d98 387f4e3 9a767b3 1a1e95c fd46b3b d2b3ff9 19515fa 081e608`. The probe hit these conflicts, all in tests:
- `use-roster-change-request.test.tsx` (46d01d2, 9a767b3, 081e608): take HEAD's import block and drop the borrowed symbols.
- `use-roster-tools.test.tsx` (9a767b3, 1a1e95c): keep olu's tests and drop the borrowed ones.
- `edited-xlsx.test.ts` (d2b3ff9): keep 2871dcd's `it.runIf(DIFF_PYTHON)` gate.

## 2. Compatibility

**Decision: the writer emits `roster-file/3`, whose shape is v1's shape (no `borrowed`).** The reader accepts v1, v2 and v3. A v2 document with borrowed rows loads, drops the rows, and shows a visible note.

- We cannot go back to v1 as the current version. `classifyRosterFileVersion` rejects any version above current as `newer` (`schema-version.ts:170-171`), so every dev v2 file and stored row would fail. The module deliberately forbids best-effort downgrade (`schema-version.ts:10-13`).
- We cannot keep v2 with an optional `borrowed`. That gives one version two shapes, and `validateRosterDocument` enforces exact top-level fields (`validate.ts:70` over `ROSTER_DOCUMENT_FIELDS`, `types.ts:220-230`).
- v3 fits the existing policy: add one migration step and raise the version (`schema-version.ts:79-90`, "bumping the schema now means editing one object").

Migration chain (`ROSTER_FILE_MIGRATIONS`, `schema-version.ts:46-56`):
- `1→2` is kept as is (adds `borrowed: []`).
- New `2→3`: delete `borrowed`, and drop every `edits` entry with `personIdx >= context.people.length`. Those entries are her cells, and the overlay covers the borrowed axis (`validate.ts:177-180`). Filtering keeps the overlay normalized. If `borrowed` is missing or not an array, treat it as empty. If `context.people` is unreadable, leave `edits` alone and let the validator reject the document. Stored reads are not validated (`use-working-roster.ts:74`), so the step must not throw.
- For each dropped row, the step returns `notes`: `"<id> (<description>) was on this roster as a temporary nurse and has been removed. Add <id> to Staff and run Optimize again to put them on the roster."`

Plumbing the note (the smallest seam, no new module):
- `RosterFileMigration.migrate` ok result gets `notes?: readonly string[]` (`schema-version.ts:38-44`). `MigrateResult` ok gets `notes: readonly string[]`, collected at `schema-version.ts:210`.
- `upgradeStoredRosterDocument` returns `{ document, notes }`. It has three callers: `use-working-roster.ts:74,80` and `roster-context.ts:52`. The assistant reads the dropped document and ignores the notes, because the screen shows them.
- `decodeRosterFileBytes` puts `notes` on its ok result (`file.ts:341`, `:368`). `importRosterFileToWorking` / `importRosterBytesToWorking` add `notes` to a `promoted` outcome (`promote.ts:41,67-78`).
- `useWorkingRoster` exposes `upgradeNotes` from the working row only. Candidates are captured with `borrowed: []`, so they never produce a note.
- `roster-section.tsx` renders one `<Callout tone="info" data-testid="roster-upgrade-note">` for `roster.upgradeNotes` plus the last import's notes. It sets import notes in `onImportEmpty` (`roster-section.tsx:162-176`). `WorkingRosterPanel` gets an `onImportNotes` callback, called from `performPromotion` (`working-roster-panel.tsx:83-111`).
- A stored v2 row is rewritten at v3 only by the next autosave. Until then the note shows on each load, which is honest. No write happens on read.

## 3. Step 3 and the repair option against the loan model

The loan shape both paths must produce, per nurse:

```
add_person        {name, groups}
set_shift_request {name, shift S, date D, must}
set_off_request   {name, every other date, must}   # merged into runs
```

By default there is one such nurse per short shift-date. Neither path sets `temporary` after Task 8.

**Cover ladder step 3** (`prepare_borrowed_cover`, the C1 handler restored by reverting 19515fa). It already emits the per-nurse shape above: `add_person`, must-off on every date not needed, and must-shift on each need, plus the asking nurse's leave or off.

**Where it differs:** one nurse covers every need in `ladder.borrow`, and `dates` accepts up to 7 (`use-roster-tools.ts:123`). **Fix:**
- `borrowParameters` gets `sameNurseForAll: z.boolean().optional()`, described as "true ONLY when the user said this one nurse covers all these shifts".
- The handler refuses when `ladder.borrow.length > 1 && !sameNurseForAll`, with the message "One borrowed nurse covers one shift. Ask the user for a nurse for each shift, or whether one nurse covers them all."

**Copy changes** in `buildBorrowView` (`roster-context.ts`, restored ~`:393-419`):
- "Adds X (from) to Staff for Night on 8 Oct only, off on every other date".
- "Run Optimize again to put X on the roster. A new run replaces hand edits made since the last one."
- The swap note stays.

**Hand-off to 2vtv:** the tool's return names the next step with `OPTIMIZE_RUN_TOOL` (`playbook.ts:65`) instead of the literal string. 2vtv owns the offer to run after Apply, the user-confirmed start, and the feasibility summary through `get_optimize_result`. This plan adds no run-lifecycle code.

**Repair option** `borrow_temporary_nurse` (`repair-options.ts:583-695`). No g1p commit touched it, but it differs from the model in four places:

| # | Current | Fix |
|---|---|---|
| a | One nurse spans every short date of her group (`nurses.push({group, dateIds: need.dateIds})`, `:601-611`) | One nurse per short (date, shift) slot, repeated for that slot's gap (`required - available`). |
| b | When no date is short, a `cap_short` gives a whole-period loan with no shift pin (`:596-600`) | Drop it. There is no shift-date, so no borrow is offered and other options cover the gap. |
| c | A date short on more than one shift gets no shift pin (`shortShift` returns `null`, `:627-630`) | One nurse per short shift on that date, each pinned. A finding with no `shiftTypes` offers no borrow (return `null`). |
| d | The pin is skipped when a hard succession rule binds her (`pinnable`, `:624-626`) | Always pin. She is off on both neighbouring days, so a succession cannot fire. Remove `pinnable`. |

The rest stays:
- `narrowedCounts` (`:557-581`). A ward-wide hard minimum would otherwise make a one-shift nurse infeasible.
- `MAX_BORROWED`, which now counts shift-dates.
- The placeholder names.
- The title becomes "Borrow a nurse for Night on 8 Oct" (or "N nurses: …" for more than one).

`isSafeOption`'s `add_person` arm (`:1262-1269`) needs this rework:
- Remove `op.temporary === true` and the `host_question` requirement for groups.
- Add a check that the option has, for that name, exactly one must `set_shift_request` date (or the user-named set) and must-off everywhere else.

## 4. 9h6 folded in (Tasks 7-8)

The confirmation mechanism changes together with the flag, so 9h6 goes last in this plan.

- **Confirmation moves to chat:**
  - `prepare_borrowed_cover` gets `lenderConfirmed: z.boolean()`, described as "true ONLY after the user said in chat that the lending ward, pool or agency confirmed <name> for <shift> on <date>". The host refuses when it is false.
  - The card's `agreement` is `null`, so there is no tick. The `borrowed_staff_arranged` guard goes (`use-roster-tools.ts:784`).
  - The repair option and its playbook entry use `enforcedBy: "chat"` (`repair-options.ts:688`, playbook entry `:261`). The `confirmationQuestion` stays as the question the model asks first, following the existing chat-enforced `soften_hard_request` (`playbook.ts:222`).
  - Remove `borrowed_staff_arranged` and `borrowedStaff()` from `lib/proposal/assumptions.ts` (`:33,45,~250-290`).
- **Remove the flag:**
  - `add_person` / `edit_person` lose `temporary` (`commands.ts:257-265,744-773`; locked model-visible tests), and `operations.ts:1454,1500,1510` change to match.
  - Also: `people-descriptor.ts:39-54`, the People-table badge (`people-table.tsx`), `diff.ts:496`, and scenario `types.ts:143,419`.
  - The producer schema `producer.ts:52` and `canonical.ts:93` stop emitting it.
- **Compatibility:**
  - A scenario import with `temporary` loads and the flag is dropped (`schemas/import.ts:38` stays `nullish`, and `import-scenario.ts:252` stops copying it).
  - A stored roster whose frozen `submission.canonicalYaml` has `temporary: true` must still parse. Accept and drop it at the stored-submission parse boundary in `lib/roster/context.ts`, the same way l1f (3227a24) drops `country`.
  - The backend keeps accepting `Person.temporary` (upstream patch P1, `core/nurse_scheduling/models.py:66`). There is no `core/` change. Retiring P1 is a follow-up bead.

## 5. Tasks (TDD order)

Run from `web/`. Focused test command: `pnpm vitest run <paths>`.

**Task 1: revert the family (green at C1 + v1).**
1. Run `git revert --no-edit` for each commit in §1's order and resolve the conflicts listed there. The result must still pass lint and format checks.
2. Grep gate: `rg -n "RosterBorrowedRow|rosterAxisContext|rosterCurrentDays|addPeople|withBorrowedPeople|narrowedCounts|scenarioStaffGroupIds|checkBorrowedRows|document\.borrowed" .` returns nothing. `rg -n qualifiedGroup lib/roster-viewer` still finds hits (olu kept).
3. Run `pnpm vitest run lib/roster lib/roster-viewer lib/ai/assistant/roster-context.test.ts components/ai/use-roster-tools.test.tsx components/roster-viewer` and `pnpm typecheck`. They must pass. Deleted by the revert: `lib/roster/borrowed.test.ts` and every borrowed case in the suites above.

**Task 2: roster-file/3 with v2 read compatibility (red first).**
1. Tests (new or restored):
   - `schema-version.test.ts`: current is 3; migrations `[1, 2]`; `2→3` drops `borrowed` and borrowed-axis edits and returns a note naming the nurse; `2→3` with `borrowed: []` gives no note; `"roster-file/4"` is `newer` (the old `/3` case moves to `/4`).
   - `file.test.ts`: a v2 file with one borrowed row and one edit on it decodes `ok`, gives v3, keeps the solved-row edits, and carries the note. A v1 file decodes to v3.
   - `promote.test.ts`: the import outcome carries `notes`.
   - `use-working-roster.test.tsx`: stored v1 and v2 rows upgrade on read, and a v2 row with borrowed rows exposes `upgradeNotes` (restored from d2b3ff9).
   - `roster-context.test.ts`: `readRosterForAssistant` upgrades v1 and v2 (restored from d2b3ff9).
   - `validate.test.ts`: `"roster-file/2"` is rejected by the strict validator (`:120` list).
2. Implement per §2:
   - `types.ts:32` becomes `"roster-file/3"`.
   - `schema-version.ts`: the `2→3` step, notes, and the restored `upgradeStoredRosterDocument` / `validateStoredRosterDocument`.
   - `file.ts`: notes on decode.
   - `promote.ts`: `validateStoredRosterDocument` at `:53` and `:114`, notes on import.
   - `use-working-roster.ts` and `roster-context.ts`, plus the `index.ts` exports.
3. Pins: change `/1` to `/3` in `components/optimize/optimize-capture-composition.test.tsx:483`, `e2e/roster-real-ward-assembled.spec.ts:1334`, and `f5-proof-matrix.test.ts`.

**Task 3: the visible note (red first).**
1. Test in `components/roster-viewer/roster-viewer.test.tsx` (or the section's own test): mount the section with a stored v2 working row with a borrowed row. Assert `roster-upgrade-note` names her and the roster renders without her row. Importing a v2 file from the panel shows the same note. No crash.
2. Implement the `roster-section.tsx` Callout and the `WorkingRosterPanel` `onImportNotes` callback (§2).

**Task 4: step 3 matches the loan model, and the 2vtv seam (red first).**
1. `use-roster-tools.test.tsx`:
   - With two needs and no `sameNurseForAll`, the tool refuses and shows no card.
   - With one need, the linked commands are exactly `add_person`, one must `set_shift_request` on that date and shift, and must-off runs over every other date. With `sameNurseForAll`, each named shift-date gets its own pin.
   - The card notes say "Run Optimize again to put … on the roster" and never "roster row appears". The return names `request_optimize_run`.
   - C1 cells: none for a swap, and leave cells only for the sick reason.
2. `roster-context.test.ts`: update the `buildBorrowView` expectations.
3. Implement: `sameNurseForAll` in `borrowParameters` (update the locked key lists in `lib/ai/runtime/model-visible-tools.test.ts`), the refusal, the copy, and `OPTIMIZE_RUN_TOOL`.

**Task 5: repair option matches the loan model (red first).**
1. `repair-options.test.ts`:
   - Two short dates give two nurses, each with one shift pin and off elsewhere.
   - A date short on AM and N gives two nurses.
   - A gap of 2 on one slot gives two nurses.
   - A cap-only shortfall gives no borrow option.
   - A hard succession rule still pins.
   - `isSafeOption` rejects a borrowed nurse with no shift pin, with two unpinned dates, or with a free day.
   - Update the existing borrow cases in `repair-options.test.ts` and `repair-eval.test.ts` that expect multi-date or whole-period loans.
2. Implement §3 table rows a to d and the `isSafeOption` rework.

**Task 7: lending-ward confirmation in chat (9h6, red first).**
1. Tests:
   - `use-roster-tools.test.tsx`: `lenderConfirmed: false` refuses; `true` shows a card with `agreement === null` and Apply enabled.
   - `roster-change-card.test.tsx`: there is no tick for step 3.
   - `assumptions.test.ts`: `add_person` + must-off pins derive no `borrowed_staff_arranged`.
   - `repair-options.test.ts`: the borrow option has `enforcedBy: "chat"`.
   - `playbook` test: the entry is chat-enforced.
2. Implement per §4 (confirmation).
3. The guidance string for step 3 in `find_swap_partners` (`use-roster-tools.ts` ~`:480`) should say: ask the lending ward's confirmation in chat, then call with `lenderConfirmed`.

**Task 8: remove the `temporary` flag (9h6, red first).**
1. Tests:
   - `import-scenario` test: YAML with `temporary: true` imports and the flag is dropped.
   - `lib/roster/context.test.ts`: a stored submission with `temporary: true` parses (next to the l1f case).
   - `operations.test.ts`: the "borrows one RN" case has no flag.
   - `commands` / `model-visible-tools.test.ts`: `add_person` / `edit_person` keys have no `temporary`.
   - People-table test: there is no Temporary badge.
   - `canonical` test: no `temporary` is emitted.
2. Implement per §4 (flag, compatibility).
3. Grep gate: `rg -n "temporary" lib components | rg -v "test|exporter"` shows only the import drop and the stored-submission drop.
4. Check whether persisted scenario state (hot store) is read strictly. If it is, add the same accept-and-drop there.
5. `bd close nursing-sheduler-9h6`. File a bead to retire core patch P1.

**Task 6: docs.**
- Mark Phase C2 / Task 12 withdrawn (user decision 2026-09-26, d582) in `plans/2026-09-24-roster-aware-assistant.md:9,4607-4620,4634` and in open question 11.
- In the spec, update `:53`, `:206-209`, `:239`, `:260`, `:274`: step 3 is staff plus re-run, with no C2.
- Add a line under the roster schema doc comment (`types.ts` header) noting that v2 is read-only history.

Also update `web/lib/capability/help-content.ts:77,340` ("temporary staff") and regenerate `registry.generated.ts`.

**Task 9: verification** (runs after Tasks 7-8; Task 6 is the docs task).
```bash
cd web
pnpm vitest run lib/roster lib/roster-viewer lib/ai/assistant components/ai/use-roster-tools.test.tsx \
  components/ai/roster-change-card.test.tsx components/ai/linked-apply.test.ts components/roster-viewer \
  components/optimize/optimize-capture-composition.test.tsx lib/ai/phase-2-absence.test.ts \
  lib/capability/tools.test.ts lib/ai/runtime/model-visible-tools.test.ts \
  lib/proposal lib/scenario components/people
pnpm typecheck
pnpm lint            # oxlint && ast-grep scan
pnpm test:ast-grep
pnpm format:check    # oxfmt --check
pnpm exec playwright test e2e/roster-real-ward-assembled.spec.ts e2e/app-shell-rebuild.spec.ts
pnpm test            # full suite; the known env failure is dev-launcher.test.ts (needs uvicorn)
```
Finish with `bd close nursing-sheduler-d582 nursing-sheduler-9h6` and `bd remember` the ExcelJS `insertRow` conditional-format finding. Do not push without approval.

---

## Unresolved questions

1. Should the ward's hard count rules stay narrowed away from a borrowed nurse (`narrowedCounts`, repair option only)? The plan keeps it, because a ward-wide minimum of N shifts would otherwise make a one-shift nurse infeasible. Step 3 has no equivalent, so a ward-wide hard minimum can make its re-run infeasible.

## Assumptions

- Only dev-environment users hold v2 data. g1p is not on `origin/main` (verified).
- Stored candidates are always captured with `borrowed: []`, so they never carry a note.
- The assistant may read the dropped document silently, because the roster screen shows the note.
- A new Optimize run replacing hand edits is expected behaviour. The existing Load confirmation guards it.
- A hard succession rule cannot fire on a nurse who is off on both neighbouring days.
- The backend's `Person.temporary` (P1) can stay until a follow-up. The frontend no longer sends it.
