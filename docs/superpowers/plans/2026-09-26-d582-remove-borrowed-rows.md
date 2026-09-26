# d582: remove roster-level borrowed rows; a temporary nurse is ordinary staff

Confidence: 7.8/10

A probe on a scratch worktree (`HEAD` = `b44f90a`) reverted all ten family commits in reverse order with olu kept. Every conflict was in a test file (import lists, plus one `it.runIf` gate from 2871dcd), and the result has no borrowed-row symbols left. Three things lower the score. Typecheck and tests were not run on the probe, because the worktree had no `node_modules`. The migration-note plumbing to the screen is new code. The olu tests next to the reverted d88/6yn tests were not re-run.

**Bead:** `nursing-sheduler-d582` (P1). **Related:** `2vtv` (assistant add and Optimize, a later plan), `9h6` (drop the `temporary` flag). **User decision 2026-09-26 (binding):** a temporary nurse is an ordinary staff member ("Haseena (Ward 3)"). The roster has no borrowed rows and no `temporary` flag. The assistant adds her to Staff, and the user re-runs Optimize.

**Branch:** `wt switch --create fix/d582-remove-borrowed-rows --base develop --no-cd` (repo CLAUDE.md flow). Ship it as one merge. The tree is only consistent again after Task 2.

**Why g1p existed:** the roster-aware assistant plan shipped step 3 as C1: a staff change now, and her roster row after the next run (`plans/2026-09-24-roster-aware-assistant.md:9`, `:4634`). Task 12/C2 (`:4607-4620`) added `roster-file/2` so that one Apply could put her row on the solved roster. With the user's decision, C2 is withdrawn and C1 becomes the design.

---

## 1. What to remove and what to keep, per commit

None of these commits are on `origin/main` (checked with `git merge-base --is-ancestor`). Production never wrote `roster-file/2`.

| Commit | Bead | Action | Why |
|---|---|---|---|
| 081e608 | g1p | **Revert.** Then restore by hand the *stored-document upgrade path*: `upgradeStoredRosterDocument` / `validateStoredRosterDocument` (`lib/roster/schema-version.ts:58-76`), their use in `promote.ts:53,114`, `use-working-roster.ts:71-80` and `roster-context.ts:52`, plus the barrel exports (`index.ts`). | Borrowed rows, `RosterBorrowedRow` (`types.ts:161`), `temporary` on `RosterContextPerson` (`types.ts:99`), `borrowed.ts`, grid badge (`roster-grid.tsx:283-292`), axis plumbing (`roster-viewer.tsx:95-141`), `addPeople`, and XLSX row insert all go. Before g1p, stored rows were validated as-is, so a stored older version failed. Upgrade-on-read is independently correct, and Task 2 needs it for v2→v3. |
| 19515fa | g1p | **Revert.** | This restores C1 `prepare_borrowed_cover`: `add_person` + must-off pins + must-shift pins + the asking nurse's leave or off, and cells only for the sick reason. Task 3 adjusts the copy. The capture and e2e pins go back to `/1`, and Task 2 moves them to `/3`. |
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

## 3. Step 3 and the repair option

- **Cover ladder step 3** (`prepare_borrowed_cover`) returns to C1 after the revert: one linked proposal of shipped ops, Apply by the user only (the restored 19515fa^ handler). Copy changes in `buildBorrowView` (`roster-context.ts`, restored at ~`:393-419`):
  - `"Adds X (from) as temporary staff…"` becomes `"Adds X (from) to Staff, off on every other date…"`.
  - `"X's roster row appears after the next run."` becomes `"Run Optimize again to put X on the roster. A new run replaces hand edits made since the last one."`
  - The swap note stays.
- **Hand-off to 2vtv:** the tool's return string names the next step with the `OPTIMIZE_RUN_TOOL` constant (`playbook.ts:65`) instead of the literal `request_optimize_run`. 2vtv owns everything after Apply: the offer to run, the user-confirmed start, and the feasibility summary through `get_optimize_result`. d582 adds no run-lifecycle code.
- **Repair option** `borrow_temporary_nurse` (`repair-options.ts:583-695`) already takes the staff path (`add_person` + must-off pins, a scenario proposal, then `request_optimize_run`, `playbook.ts:153`). No g1p commit touched it, so d582 leaves it unchanged. Its `temporary: true` belongs to 9h6.

## 4. 9h6: keep it separate, right after d582

- 9h6 changes a different contract: the scenario staff schema and file format (accept and drop `temporary: true`, the l1f pattern, 3227a24), the model-visible `add_person` / `edit_person` schema (`lib/proposal/commands.ts:257-265,744-773`, locked by `model-visible-tools.test.ts`), the `borrowed_staff_arranged` derivation (`assumptions.ts:~250-285`), the repair-option loan checks (`repair-options.ts:~1100-1270`), and the People-table badge.
- d582 is a roster-format and step-3 change that is complete on its own. Folding the two together doubles the review surface and mixes two compat stories.
- The only coupling is that step 3 still sends `temporary: true`. `borrowed_staff_arranged` also fires on hard off pins in the same change (`assumptions.ts` `loaned`), so 9h6 can drop the flag without breaking step 3's agreement tick, unless 9h6 also removes the host question (open question 3).

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

**Task 4: step-3 copy and the 2vtv seam (red first).**
1. `use-roster-tools.test.tsx`: the step-3 card notes contain "Run Optimize again to put … on the roster" and "to Staff", and never "roster row appears". The tool return names `request_optimize_run`. There are no `request.cells` for the swap reason, and only the leave cells for the sick reason (C1 behaviour).
2. `roster-context.test.ts`: update the `buildBorrowView` expectations.
3. Implement the `buildBorrowView` copy and the `OPTIMIZE_RUN_TOOL` constant in the `prepare_borrowed_cover` return.

**Task 5: docs.**
- Mark Phase C2 / Task 12 withdrawn (user decision 2026-09-26, d582) in `plans/2026-09-24-roster-aware-assistant.md:9,4607-4620,4634` and in open question 11.
- In the spec, update `:53`, `:206-209`, `:239`, `:260`, `:274`: step 3 is staff plus re-run, with no C2.
- Add a line under the roster schema doc comment (`types.ts` header) noting that v2 is read-only history.

**Task 6: verification.**
```bash
cd web
pnpm vitest run lib/roster lib/roster-viewer lib/ai/assistant components/ai/use-roster-tools.test.tsx \
  components/ai/roster-change-card.test.tsx components/ai/linked-apply.test.ts components/roster-viewer \
  components/optimize/optimize-capture-composition.test.tsx lib/ai/phase-2-absence.test.ts \
  lib/capability/tools.test.ts lib/ai/runtime/model-visible-tools.test.ts
pnpm typecheck
pnpm lint            # oxlint && ast-grep scan
pnpm test:ast-grep
pnpm format:check    # oxfmt --check
pnpm exec playwright test e2e/roster-real-ward-assembled.spec.ts
pnpm test            # full suite; the known env failure is dev-launcher.test.ts (needs uvicorn)
```
Finish with `bd close nursing-sheduler-d582` and `bd remember` the ExcelJS `insertRow` conditional-format finding. Do not push without approval.

---

## Unresolved questions

1. Writer version: is `roster-file/3` (recommended) acceptable, rather than any v2 or v1 reuse?
2. Should the note keep showing on every load until the next autosave rewrites the stored row, or should it show once per session?
3. For 9h6: does the step-3 card keep its host tick (`borrowed_staff_arranged`, from the must-off pins), or does the loan confirmation move fully to chat?
4. Should step 3 keep pinning her off on every other date and on the needed shift (the loan shape), or add her as plain staff and let Optimize place her freely?

## Assumptions

- Only dev-environment users hold v2 data. g1p is not on `origin/main` (verified).
- Stored candidates are always captured with `borrowed: []`, so they never carry a note.
- The assistant may read the dropped document silently, because the roster screen shows the note.
- A new Optimize run replacing hand edits is expected behaviour. The existing Load confirmation guards it.
