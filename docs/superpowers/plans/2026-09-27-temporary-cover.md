# d582 temporary cover Implementation Plan

Confidence: 7.1/10

Every seam here comes from code I read:
- the requirement emission order (`canonical.ts:134-165`)
- `requiredOn` and `requirementDateIsos` (`shortfalls.ts:248-264`)
- `RequirementEquation.preferenceIndex` (`requirements.ts:70-125`)
- the borrowed-row insert and the 6iw helpers (`edited-xlsx.ts:145-396`)
- the download restore seam (`use-optimize-terminal.ts:310`)
- the repair-fixture precedent (`repair-eval.test.ts:143` → `core/tests/test_assistant_repair_fixtures.py`)

Four things lower the score:
- Reverting the g1p family while keeping 6iw has not been probed. The earlier probe (`b44f90a`) reverted all ten commits.
- The Apply-fills-the-form handshake (Task 17) is new. It has only the roster change-request handshake to copy (`lib/roster/change-request.ts`, `components/ai/linked-apply.ts`).
- The raw-download cover rows need new data carried through the durable optimize session (`session-transaction.ts:100-110,190-200`). I have not checked whether its schema version must change.
- Readers keyed on authored cards cannot see split cards, so they use a per-card credit function instead of the split state (see Assumptions).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A temporary cover nurse ("Haseena (Ward 3)", one date, one shift, optional staff groups) lowers that shift's staffing need on that date. She is a display row on the roster and in Excel, never a solver person. The `temporary` flag and the g1p borrowed rows go.

**Architecture:** One pure module, `web/lib/scenario/temporary-cover.ts`, holds all the arithmetic. It computes the per-equation credit, the ward need, the submission-time derived state (per-date overrides, plus shift and date splits), a decrement ledger and per-cover status. Covers are stored apart in `ScenarioUiState.temporaryCover` and applied on read. The authored cards never hold them. These consume the module: the solver input, every staffing reader, the roster file (`roster-file/2` with `cover`), the Excel exports, the Staff screen and the assistant.

**Tech Stack:** TypeScript, Next.js, Zustand, Zod, Vitest and Testing Library, Playwright, ExcelJS 4.4.0, Python 3.12, pytest, OR-Tools CP-SAT (unchanged), Oxlint, ast-grep, oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-26-temporary-cover-nurse-design.md` (commit `f0c15db`, binding). The bead is `nursing-sheduler-d582` (its notes are binding). Out of scope: the Excel importer (bead `nursing-sheduler-ufc3`). Only the provenance-table writer is built here. This plan supersedes `docs/superpowers/plans/2026-09-26-d582-remove-borrowed-rows.md`, which is deleted in the commit that adds this file.

## Global Constraints

- **Branches (repo CLAUDE.md).** Integration branch: `feat/d582-temporary-cover` from `develop`. From `/home/kenan/work/nursing-sheduler` run `wt switch --create feat/d582-temporary-cover --base develop --no-cd`. Its worktree is `/home/kenan/work/nursing-sheduler.feat-d582-temporary-cover`, written `$INT` below. A parallel task runs in its own child worktree: `wt switch --create feat/d582-t<N> --base feat/d582-temporary-cover --no-cd`, which lives at `/home/kenan/work/nursing-sheduler.feat-d582-t<N>` (`$WT`). Merge each child back into the integration branch one at a time, and re-run that task's verification after each merge. A sequential task runs in `$INT` directly (`$WT = $INT`).
- **Develop stays green.** Merge Phase A (Tasks 1-2) into `develop` on its own once it passes. Merge the rest as one merge after Task 20.
- **Shell.** Shell state does not persist between blocks. Every block starts with `cd "$WT/web"` or `cd "$WT/core"`, with `$WT` spelled out as an absolute path. Never pipe a test run into `tail` or `grep` for a pass/fail decision.
- **The web gate, run by every task before its commit** (from `$WT/web`):
  ```bash
  pnpm vitest run <the task's focused files>
  pnpm typecheck
  pnpm lint            # oxlint && ast-grep scan
  pnpm format:check    # oxfmt --check
  ```
  If a task touches `web/sgconfig.yml` or `web/rules/`, also run `pnpm test:ast-grep`.
- **Core gate** (tasks that touch `core/`): `cd "$WT/core" && PYTHONPATH=. python3 -m pytest -q <files> && ruff check . && ruff format --check .`
- **Library-first testing (repo CLAUDE.md).** No hand-written parsers. No `node:fs` in tests. Solver-equivalence fixtures are written by Vitest `toMatchFileSnapshot`, following `repair-eval.test.ts:143`, and read by pytest, following `test_assistant_repair_fixtures.py`.
- **`core/` solver code does not change.** `Person.temporary` (patch P1, `models.py:66`) stays. Filing its retirement is a Task 20 step. Only `core/nurse_scheduling/server/workspace.py` and new tests change.
- **Identity.** With no cover, `applyCovers(s).state === s`. Every YAML, workspace, roster file and XLSX byte is then unchanged. Every wiring task pins this.
- **Commits.** Use `bd` for tracking. Commit messages are short and conventional, with `(d582)`. Do not push. Pushing and merging to `develop` need the user's approval.
- **UI copy** is the spec's text verbatim (§3, §6, §7). The design follows DESIGN.md "Mint Canvas, Warm Ink" (L1 `Surface`, square tables, pill buttons).

## Review Focus

- **Task 1:** reverting `081e608` keeps the 6iw helpers (moved to `lib/roster/xlsx-rows.ts` with their tests), the olu `qualifiedGroup` and the stored-document upgrade path. The grep gate must be empty.
- **Task 5:** the split cards are solver-equivalent. The ledger's `pref` equals `buildEquations(toCanonicalScenarioDocument(derived))[k].preferenceIndex`. With no cover the state is identical (`===`).
- **Task 6:** the pytest fixtures give the same status and objective for the split pairs, and INFEASIBLE → feasible for the RN cover.
- **Task 11:** roster coverage is `wardNeed(submitted + decrement, liveCredit)`. Adding a cover after the solve lowers the need at once. Removing a solved cover raises it at once.
- **Tasks 13-14:** restoration runs before the insert and never on an exported workbook. A plain run with no cover is still a byte-identical bypass.
- **Task 17:** a stale Preview writes nothing. Validation failure leaves the editor open. Save is one `scenarioCommands.mutate`.

## Interfaces fixed by this plan (every task uses these names)

```ts
// web/lib/scenario/types.ts (Task 3)
export interface UiTemporaryCover {
  _k?: string;
  name: string;              // display label, not a person id
  date: IsoDate;
  shiftType: ShiftTypeRef;   // a worked shift type id
  groups: GroupId[];         // may be empty
}
// ScenarioStateShared.temporaryCover: UiTemporaryCover[]

// web/lib/scenario/temporary-cover.ts (Task 5)
export type GroupClosure = (groupId: string) => ReadonlySet<string>; // the group plus every group that contains it
export function groupClosureOf(groups: readonly { id: string | number; members: readonly (string | number)[] }[]): GroupClosure;
export interface CoverTarget {                 // one requirement equation, card- or document-derived
  readonly shiftIds: readonly string[];
  readonly coefficients: readonly number[];    // parallel to shiftIds, default 1
  readonly qualifiedGroups: ReadonlySet<string> | null; // group ids named by qualifiedPeople; null = absent/ALL
}
export function coverCounts(target: CoverTarget, cover: Pick<UiTemporaryCover, "shiftType" | "groups">, closure: GroupClosure): boolean;
export function coverCredit(target: CoverTarget, iso: string, covers: readonly UiTemporaryCover[], closure: GroupClosure): number;
export function mixCredit(target: CoverTarget, mixGroup: string, iso: string, covers: readonly UiTemporaryCover[], closure: GroupClosure): number;
export const wardNeed = (count: number, credit: number): number => Math.max(0, count - credit);
export interface CoverDecrement {
  readonly pref: number;       // index into the SUBMITTED document.preferences (after splits)
  readonly iso: string;
  readonly required: number;   // count - wardNeed(count, credit): what the solve subtracted
  readonly preferred?: number;
  readonly mix?: readonly (readonly [entryIdx: number, by: number])[];
}
export interface CoverApplication { readonly state: ScenarioUiState; readonly decrements: readonly CoverDecrement[] }
export function applyCovers(state: ScenarioUiState): CoverApplication;   // solver form (splits); identity when no cover
export function withCoverOverrides(state: ScenarioUiState): ScenarioUiState; // = applyCovers(state).state
export function cardTargets(state: ScenarioUiState, card: RequirementCard): CoverTarget[]; // one per top-level selector
export function cardNeedOn(state: ScenarioUiState, card: RequirementCard, iso: string, shiftId?: string):
  { required: number; preferred?: number; mix: number[]; credit: number; extra: number }; // authored-card readers
export type CoverFlag = "out-of-period" | "unknown-shift" | "unknown-group" | "no-card";
export interface CoverEffect { readonly cardUid: string; readonly label: string; readonly iso: string; readonly shiftId: string; readonly before: number; readonly after: number }
export interface CoverStatus {
  readonly index: number;                      // into state.temporaryCover
  readonly flag: CoverFlag | null;             // non-null: lowers nothing
  readonly effects: readonly CoverEffect[];
  readonly extra: number;                      // covers past the requirement on this slot (F4)
  readonly restrictedBy: readonly { cardUid: string; label: string; group: string }[]; // F1 warning
}
export function coverStatuses(state: ScenarioUiState): CoverStatus[];

// web/lib/roster/types.ts (Task 11)
export const ROSTER_DOCUMENT_SCHEMA_VERSION = "roster-file/2";
export interface RosterCoverEntry { readonly name: string; readonly iso: string; readonly shiftId: ShiftTypeId; readonly groups: readonly string[] }
export interface RosterCover { readonly entries: readonly RosterCoverEntry[]; readonly decrements: readonly CoverDecrement[] }
// RosterDocument.cover: RosterCover

// web/lib/roster/cover-sheet.ts (Task 13)
export interface CoverSheetPlan {
  readonly rows: readonly { readonly name: string; readonly cells: readonly string[] }[]; // cells per date index
  readonly countCredits: readonly { readonly header: string; readonly byDate: readonly number[] }[];
  readonly entries: readonly RosterCoverEntry[];   // written to the provenance table
}
export function buildCoverSheetPlan(document: CanonicalScenarioDocument, entries: readonly RosterCoverEntry[]): CoverSheetPlan | null; // null when no entries
export function applyCoverSheet(workbook: ExcelJS.Workbook, plan: CoverSheetPlan, layout: { lastPersonRow: number; dateColumns: readonly number[] }): void;

// web/lib/proposal/commands.ts (Task 16)
| { type: "add_temporary_cover"; name: string; date: string; shiftType: string; groups: string[] }
| { type: "remove_temporary_cover"; name: string; date: string; shiftType: string }
```

## Parallel groups

| Group | Tasks | Mode |
|---|---|---|
| A | 1 → 2 | Sequential in `$INT`. Merge to `develop` after Task 2. |
| B | 3 | Sequential (the type and slice every later task reads). |
| C | 4 ∥ 5 | Parallel worktrees. Disjoint files (`workspace.*`, `core/.../workspace.py` vs `temporary-cover.*`). |
| D | 6 ∥ 7 ∥ 8 ∥ 9 ∥ 15 | Parallel after Task 5. Disjoint files: optimize/diagnostic/export · `shortfalls.ts`+`diff.ts` · `repair-options.ts` readers · `requirements.ts`+`coverage.ts` · `components/people`+`components/requirements`. |
| E | 10 | After 9 (`rule-check.ts`, `swap.ts`, `roster-context.ts`). |
| F | 11 → (12 ∥ 13) → 14 | 11 after 6 and 10. Then 12 (viewer band) and 13 (edited export) in parallel. 14 after 13. |
| G | 16 → 17 → 18, with 19 ∥ 17/18 | 16 after 7. 17 after 15 and 16. 18 after 10 and 17. 19 after 8 and 16, parallel with 17 and 18 (disjoint: `repair-options.ts`+`playbook.ts` vs `use-roster-tools.ts`+`roster-context.ts`+`assumptions.ts`). |
| H | 20 | Last. |

---

### Task 1: Revert the g1p borrowed-row family (keep 6iw helpers, olu and the stored upgrade path)

**Files:**
- Revert commits, newest first: `46d01d2 f3b2d98 9a767b3 1a1e95c fd46b3b d2b3ff9 19515fa 081e608`. Do **not** revert `387f4e3`, `01e7b69` (6iw) or `e930ac6` (olu).
- Create: `web/lib/roster/xlsx-rows.ts`, `web/lib/roster/xlsx-rows.test.ts`
- Modify (conflict resolution, hand restore): `web/lib/roster/edited-xlsx.ts`, `web/lib/roster/edited-xlsx.test.ts`, `web/lib/roster/schema-version.ts`, `web/lib/roster/promote.ts`, `web/components/roster-viewer/use-working-roster.ts`, `web/lib/ai/assistant/roster-context.ts`, `web/lib/roster/index.ts`
- Test conflicts, per the superseded plan's probe: `use-roster-change-request.test.tsx` (take HEAD's imports and drop the borrowed symbols), `use-roster-tools.test.tsx` (keep olu's tests and drop the borrowed ones)

**Interfaces:**
- Consumes: the 6iw private helpers `copyRowStyle`, `conditionalFormats`, `shiftConditionalFormatsForInsert`, `shiftRangeRef` (`edited-xlsx.ts:316-396`).
- Produces: `insertStyledRows(sheet: ExcelJS.Worksheet, beforeRow: number, count: number): void` in `xlsx-rows.ts`. It inserts `count` empty rows at `beforeRow`, copies the style of row `beforeRow - 1` onto each, and shifts conditional-format ranges. `upgradeStoredRosterDocument` and `validateStoredRosterDocument` are kept, and `ROSTER_FILE_MIGRATIONS` becomes `[]`. `ROSTER_DOCUMENT_SCHEMA_VERSION` goes back to `"roster-file/1"`, as the revert gives it. `patchFrozenXlsxWithEdits` has no `borrowed` input.

- [ ] **Step 1: Create the integration worktree.**
  ```bash
  cd /home/kenan/work/nursing-sheduler && wt switch --create feat/d582-temporary-cover --base develop --no-cd
  ```
- [ ] **Step 2: Revert.** In `$INT`, run `git revert --no-edit <sha>` for each commit in the order above. When `081e608` conflicts in `edited-xlsx.ts`, take the revert: remove the `borrowed` input, `borrowedDays` and block 2b. Then move the four 6iw helpers into `xlsx-rows.ts` behind `insertStyledRows`, so no private function is left unused (oxlint). Restore `upgradeStoredRosterDocument` and `validateStoredRosterDocument`, their callers (`promote.ts`, `use-working-roster.ts`, `roster-context.ts`) and the barrel exports, with an empty migration list. Finish with one `git commit --amend` on the last revert, or a follow-up commit `fix(roster): keep 6iw row insert and stored upgrade after g1p revert (d582)`.
- [ ] **Step 3: Failing test first for the moved helper.** Re-point the 6iw tests (`387f4e3`, `01e7b69`) from the borrowed insert to `insertStyledRows` in `xlsx-rows.test.ts`: `copies the neighbouring row style and height`, `shifts CF ranges at or below the insert`, `leaves CF ranges above the insert and whole-column refs alone`, `inserts two rows`. Run them red (before the move) and green (after).
- [ ] **Step 4: Grep gate** (from `$INT/web`). This must print nothing:
  ```bash
  rg -n "RosterBorrowedRow|rosterAxisContext|rosterCurrentDays|addPeople|withBorrowedPeople|withBorrowedRows|narrowedCounts|scenarioStaffGroupIds|checkBorrowedRows|document\.borrowed|borrowed:" lib components e2e
  ```
  Then `rg -n qualifiedGroup lib/roster-viewer` must still find hits.
- [ ] **Step 5: Verify.**
  ```bash
  cd /home/kenan/work/nursing-sheduler.feat-d582-temporary-cover/web
  pnpm vitest run lib/roster lib/roster-viewer lib/ai/assistant/roster-context.test.ts components/ai/use-roster-tools.test.tsx components/roster-viewer components/optimize/optimize-capture-composition.test.tsx
  pnpm typecheck && pnpm lint && pnpm format:check
  pnpm exec playwright test e2e/roster-viewer.spec.ts
  ```
- [ ] **Step 6: Commit** (if Step 2 used a follow-up commit, amend it). Message: `revert(roster): remove g1p borrowed rows; keep 6iw insert, olu, stored upgrade (d582)`.

### Task 2: Remove the `temporary` flag

**Files:**
- Modify, scenario: `web/lib/scenario/types.ts:143,419`, `schemas/import.ts:38`, `schemas/producer.ts:52`, `canonical.ts:93`, `import-scenario.ts:252`, `web/lib/store/persistence.ts:277`.
- Modify, Staff UI: `web/components/people/people-descriptor.ts`, `people-table.tsx:612-617,789-852`.
- Modify, proposals: `web/lib/proposal/commands.ts:259,265,753-775`, `operations.ts:1454,1500,1510`, `diff.ts:496`.
- Modify, `web/lib/proposal/assumptions.ts:245-270`: drop the `temporary` trigger. Keep the hard-off `loaned` trigger.
- Modify, assistant: `web/components/ai/use-roster-tools.ts:737`, `web/lib/ai/assistant/repair-options.ts:643,1105,1265`, `playbook.ts:22,267`.
- Modify, help: `web/lib/capability/help-content.ts`, then regenerate `registry.generated.ts`.
- Test, scenario: `web/lib/scenario/canonical.test.ts`, `import-scenario.test.ts`, `workspace.test.ts`, `differential/differential.test.ts`.
- Test, the rest: `web/lib/proposal/operations.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`, `web/components/people/people-table.test.tsx`, `people-v2-roles.test.tsx`, `web/lib/ai/assistant/repair-options.test.ts`, `repair-eval.test.ts`.

**Interfaces:** Consumes Task 1's tree. Produces the `add_person {name, groups}` and `edit_person {personId, name, groups}` commands (locked schemas), and `UiPerson` with no `temporary`. The repair option and step 3 still emit C1 (`add_person` plus must pins), now without the flag. Tasks 18 and 19 replace both.

- [ ] **Step 1: Failing tests.**
  - `model-visible-tools.test.ts`: the `add_person` / `edit_person` key lists have no `temporary`.
  - `canonical.test.ts`: `emits no temporary field`.
  - `people-table.test.tsx`: `has no Temporary switch or badge`.
  - `repair-options.test.ts`: the borrow option's `add_person` has no `temporary`, and `isSafeOption` accepts it without the flag.
  - Delete the `temporary` round-trip cases from e220807 (`import-scenario.test.ts`, `workspace.test.ts`, `differential.test.ts`).
  - Run `pnpm vitest run <those files>`. Expect failures.
- [ ] **Step 2: Implement** the removal across the files above. `isSafeOption`'s `add_person` arm drops `op.temporary === true` and keeps its other checks. `borrowedStaff()` keys on hard days off only. Run `pnpm capability:generate`.
- [ ] **Step 3: Grep gate.** `rg -n "temporary" lib components -g '!*.test.*'` shows only the step-3 and repair copy strings ("temporary nurse") and nothing typed.
- [ ] **Step 4: Verify.**
  ```bash
  cd /home/kenan/work/nursing-sheduler.feat-d582-temporary-cover/web
  pnpm vitest run lib/scenario lib/proposal lib/store/persistence.test.ts lib/ai components/people components/ai lib/capability
  pnpm typecheck && pnpm lint && pnpm format:check
  pnpm exec playwright test e2e/people.spec.ts e2e/assistant-proposal-apply.spec.ts
  ```
- [ ] **Step 5: Commit** `refactor(staff): remove the temporary flag, no migration (d582)`. Ask the user before merging Phase A into `develop`.

### Task 3: The `temporaryCover` slice

**Files:**
- Modify `web/lib/scenario/types.ts`: add `UiTemporaryCover` and `ScenarioStateShared.temporaryCover`.
- Modify `web/lib/scenario/canonical.ts:357`: `createEmptyScenarioUiState` gets `temporaryCover: []`. The projection ignores the slice.
- Modify `web/lib/store/fingerprint.ts:19`: `SCENARIO_KEYS` gets `"temporaryCover"`.
- Modify `web/lib/store/persistence.ts`: raise `SCENARIO_PERSIST_VERSION` from 6 to 7. The `< 7` step adds `temporaryCover: []`. Add a validator for the slice.
- Modify `web/lib/cascade/rename.ts`: a shift-type or staff-group rename follows into covers. Deletes leave covers alone.
- Modify `web/lib/scenario/test-fixtures.ts`.
- Test: `web/lib/store/persistence.test.ts`, `web/lib/store/fingerprint` tests (next to the existing ones), `web/lib/cascade/cascade.test.ts`, `web/lib/scenario/canonical.test.ts`

**Interfaces:** Produces `UiTemporaryCover` and `state.temporaryCover`. Consumes nothing new.

- [ ] **Step 1: Failing tests.**
  - `persistence.test.ts`: `v6 state migrates with an empty temporaryCover`, `rejects a cover with a non-string name`, `round-trips covers`.
  - fingerprint: `a cover change changes the fingerprint`.
  - `cascade.test.ts`: `renamed shift type follows into the cover`, `renamed group follows into the cover`, `deleted shift type leaves the cover in place`.
  - `canonical.test.ts`: `covers never reach the canonical document`.
- [ ] **Step 2: Implement.** A missing slice defaults only through the migration. The validator requires the slice, per spec §1.
- [ ] **Step 3: Verify.** `pnpm vitest run lib/store lib/cascade lib/scenario/canonical.test.ts`, then the web gate.
- [ ] **Step 4: Commit** `feat(scenario): temporaryCover slice, persist v7, rename cascade (d582)`.

### Task 4: Workspace file I/O (parallel with Task 5)

**Files:**
- Modify `web/lib/scenario/workspace.ts`: the zod schema (`:174`), `buildWorkspaceDocument` (`:608`) and the import mapping into state.
  - Add an optional top-level `temporaryCover` list of `{name, date, shiftType, groups}`. Omit it when it is empty.
  - `projectWorkspaceToStrict` (`:472`) rejects a non-empty list with an issue at `["temporaryCover"]`, as Python does.
- Modify `core/nurse_scheduling/server/workspace.py:156`: add `WorkspaceSchedulingDataV1.temporaryCover: list[WorkspaceTemporaryCover] = Field(default_factory=list)`.
  - `WorkspaceTemporaryCover` has `extra="forbid"` and the fields `name: str, date: date, shiftType: str | int, groups: list[str | int] = []`.
  - In `convert_workspace_to_strict` (`:542`), a non-empty list raises the located issue `temporaryCover`. The message is "Temporary cover is applied by the web app. Submit the strict document it produces."
- Test: `web/lib/scenario/workspace.test.ts`, `web/lib/scenario/differential/workspace-differential.test.ts`, `core/tests/test_workspace_temporary_cover.py` (new)

**Interfaces:** Consumes `UiTemporaryCover` (Task 3). Produces nothing new for later tasks.

- [ ] **Step 1: Failing tests.**
  - Web: `serializes no temporaryCover key when empty (bytes unchanged)`, `round-trips covers through the workspace`, `strict projection rejects a non-empty cover at temporaryCover`.
  - Python: `test_accepts_temporary_cover_field`, `test_strict_conversion_rejects_non_empty_cover_with_located_issue`, `test_empty_cover_converts_unchanged`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify.**
  ```bash
  cd "$WT/core" && PYTHONPATH=. python3 -m pytest -q tests/test_workspace_temporary_cover.py tests/test_server_scheduling_input.py && ruff check . && ruff format --check .
  cd "$WT/web" && pnpm vitest run lib/scenario/workspace.test.ts && RUN_DIFFERENTIAL=1 pnpm vitest run lib/scenario/differential/workspace-differential.test.ts
  ```
  Then run the web gate and `pnpm exec playwright test e2e/save-load.spec.ts e2e/save-load-import.spec.ts`.
- [ ] **Step 4: Commit** `feat(workspace): optional temporaryCover in Workspace V1, strict rejects it (d582)`.

### Task 5: The pure `temporary-cover.ts` module and its table tests (parallel with Task 4)

**Files:**
- Create: `web/lib/scenario/temporary-cover.ts`, `web/lib/scenario/temporary-cover.test.ts`
- Modify: `web/lib/scenario/index.ts` (barrel)

**Interfaces:**
- Consumes: `requiredOn`, `requirementDateIsos` (`lib/rules/shortfalls.ts`), `flattenShiftTypeRefs`, `expandShiftTypeRefs` (`lib/rules/expansion.ts`), and the `RequirementCard` fields (`types.ts:472-484`).
- Produces: everything in "Interfaces fixed by this plan" under `temporary-cover.ts`.

Rules to implement (spec §2, F1-F4):
- **Eligibility.** A cover counts in an equation only if all of these hold:
  - The card is enabled.
  - The cover's date is one of the card's resolved dates.
  - The selector's expanded shift set contains the cover's shift.
  - `qualifiedGroups === null`, or `closure(g)` meets `qualifiedGroups` for some `g` in her groups.

  A person-id ref never matches. Her credit is the coefficient of her shift (default 1).
- **`applyCovers` order:**
  1. Keep only covers with `flag === null`.
  2. Per-shift split. Only for a multi-selector card that a cover touches: replace it in place with one card per selector, with identical fields and `uid` `${uid}#s${i}`.
  3. Per-date override. Write `wardNeed(requiredOn(card, iso), credit)` into `requiredNumPeopleOverrides`, merged with any hand override on that date. Drop an entry equal to `requiredNumPeople`.
  4. Date split. Do this only for a card whose skill mix or `preferredNumPeople` a cover changes. Insert a date copy right after the card:
     - `uid` `${uid}#d${iso}` and `date: [iso]`
     - the count set to the ward need
     - `preferredNumPeople` set to `max(floor, preferred - credit)`
     - credited mix entries lowered, and 0-entries dropped

     The original's `date` becomes the explicit list of its other resolved ISO dates. Its hand override on `iso` moves into the copy as the copy's base count.
  5. Ledger. `pref = 1 + index among enabled requirement cards of the derived state`. That matches `mapPreferences` (`canonical.ts:134-165`): the backend-required max-one-shift preference comes first, then the requirements.
- **Identity.** With no cover or no effective cover, return the input object and `decrements: []`.
- **`coverStatuses` flags:**
  - `out-of-period`: the date is not in `[rangeStart, rangeEnd]`.
  - `unknown-shift`: the shift is not a worked shift type.
  - `unknown-group`: a group in `groups` is not in `staffGroups`.
  - `no-card`: no enabled card counts her.
  - `extra` counts covers past zero on a slot. `restrictedBy` lists cards that cover her shift on her date but are restricted to a group she is not in.

- [ ] **Step 1: Failing table tests** (`temporary-cover.test.ts`, one `it.each` table per concern, names from spec F1-F4):
  - F1: `lowers the all-staff card for a cover with no groups`, `lowers a qualifiedPeople card only for a member`, `lowers an aggregate shift-group card for either member shift`, `splits a multi-selector card and lowers only the covered shift`, `RN cover satisfies 'at least 1 RN'`, `non-RN cover does not lower the RN skill mix`, `two RN covers lower 'at least 2 RN' to 0 and drop the entry`, `date split leaves every other date's equations unchanged`, `nested group membership counts`, `person-id qualifiedPeople never counts her`, `coefficient 2 credits 2`.
  - F2: `lowers floor and preferred on the cover date only`, `preferred never drops below the floor`.
  - F3: `removing a cover restores the exact hand-written count`, `hand override and cover compose`, `deleted shift type flags the cover`, `out-of-period cover is flagged and lowers nothing`, `no-card cover is flagged`, `unknown group flags the cover`.
  - F4: `two covers lower by two`, `clamps at zero with an extra-cover warning`, `a requirement already at 0 stays 0 and warns`.
  - Identity: `no cover returns the same state object`, and `ledger pref matches buildEquations preferenceIndex` (project the derived state with `toCanonicalScenarioDocument` and run `buildEquations` from `lib/roster-viewer/requirements.ts`).
  - `cardNeedOn` agrees with `applyCovers`: `cardNeedOn and the solver form agree on every slot` (a property over the table fixtures).
- [ ] **Step 2: Implement** to green. Keep it one file. There is no class, only the functions listed above.
- [ ] **Step 3: Verify.** `pnpm vitest run lib/scenario/temporary-cover.test.ts`, then the web gate.
- [ ] **Step 4: Commit** `feat(scenario): temporary-cover credit, ward need and submission splits (d582)`.

### Task 6: Solver input wiring and solver-equivalence proof

**Files:**
- Modify `web/components/optimize/optimize-and-export-screen.tsx:479`: submit `toCanonicalScenarioDocument(withCoverOverrides(useScenarioStore.getState()))`. Add a non-blocking preflight warning that lists each flagged cover from `coverStatuses`.
- Modify `web/lib/ai/diagnostic/diagnostic-orchestrator.ts:333` and `web/lib/scenario/prepare-export.ts:105` the same way.
- Create: `web/lib/scenario/temporary-cover.fixtures.test.ts` (writes YAML with `toMatchFileSnapshot` into `core/tests/fixtures/temporary_cover/`), `core/tests/test_temporary_cover_equivalence.py`
- Test: `web/lib/scenario/prepare-export.test.ts`, `web/components/optimize/optimize-capture-composition.test.tsx`, `web/lib/ai/diagnostic/diagnostic-orchestrator.test.ts`

**Interfaces:** Consumes `withCoverOverrides` and `coverStatuses` (Task 5). Produces the submitted strict YAML with covers applied. `OptimizeSubmitInput` is unchanged here. Task 11 adds `cover`.

- [ ] **Step 1: Failing web tests.**
  - `prepare-export.test.ts`: `strict export carries the decremented count`, `no cover gives byte-identical YAML`.
  - `diagnostic-orchestrator.test.ts`: `diagnostic rerun submits the covered counts`.
  - Composition test: `Optimize submits withCoverOverrides`, and `preflight lists a flagged cover without blocking`.
- [ ] **Step 2: Failing fixture test.** `temporary-cover.fixtures.test.ts` builds small wards in code: 3-4 nurses and 3 days, like `test_requirement_overrides.py:9-35`. It writes each pair with `stableYaml`. That helper is local to `repair-eval.test.ts`, so move it to `lib/scenario/test-fixtures.ts` first. The pairs:
  - `shift_split.before/after`: a `[AM, PM]` card, split with no cover.
  - `date_split.before/after`: an RN skill-mix card, split by date with no cover.
  - `rn_cover.before/after`: an RN-short night, then the same night with one RN cover.
  - The two split pairs need a split with no credit. Export `splitCardsForCover(state, touched)` from `temporary-cover.ts` for them. `applyCovers` calls the same function.
- [ ] **Step 3: Failing pytest** (`test_temporary_cover_equivalence.py`, following `test_assistant_repair_fixtures.py`):
  - `test_the_harness_wrote_every_case`
  - `test_shift_split_is_solver_equivalent` and `test_date_split_is_solver_equivalent_with_no_cover`: same status and same objective, `scheduler.schedule(..., timeout=30)`
  - `test_rn_cover_makes_an_rn_short_night_feasible`: before `INFEASIBLE`, after in `{FEASIBLE, OPTIMAL}`
- [ ] **Step 4: Implement** the three call sites and the preflight warning. Regenerate the fixtures with `pnpm vitest run lib/scenario/temporary-cover.fixtures -u`.
- [ ] **Step 5: Verify.**
  ```bash
  cd "$WT/web" && pnpm vitest run lib/scenario/temporary-cover.fixtures.test.ts lib/scenario/prepare-export.test.ts lib/ai/diagnostic components/optimize/optimize-capture-composition.test.tsx
  cd "$WT/core" && PYTHONPATH=. python3 -m pytest -q tests/test_temporary_cover_equivalence.py && ruff check . && ruff format --check .
  ```
  Then run the web gate and `pnpm exec playwright test e2e/optimize-screen.spec.ts`.
- [ ] **Step 6: Commit** `feat(optimize): submit covered counts; split pairs proven solver-equivalent (d582)`.

### Task 7: Static shortfalls and Preview/diff read the ward need

**Files:**
- Modify: `web/lib/rules/shortfalls.ts` (`findStaffingShortfalls` `:313` and `newRuleClash` compare against `cardNeedOn` and report `credit`), `web/lib/proposal/diff.ts:249,270` (effective counts: `requiredOn` over `withCoverOverrides(before)` vs `(after)`, keyed by authored uid through `cardNeedOn`)
- Test: `web/lib/rules/shortfalls.test.ts`, `web/lib/proposal/diff.test.ts`

**Interfaces:** Consumes `cardNeedOn`. Produces `StaffingFinding.coverCredit?: number` (so a finding can show "+1 cover"), and a diff line `"<shift> on <d MMM>: exactly N → M (<label>)"` for a cover-only change.

- [ ] **Step 1: Failing tests.**
  - `findStaffingShortfalls counts a temporary cover`
  - Property: `no slot with a matching cover reads short` (every fixture ward, one cover per short slot)
  - `diff shows the effective count change for a cover`
  - `diff never shows a count below 0`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run lib/rules lib/proposal/diff.test.ts`, then the web gate. **Step 4: Commit** `feat(rules): shortfalls and Preview count temporary cover (d582)`.

### Task 8: Repair-option readers

**Files:** Modify `web/lib/ai/assistant/repair-options.ts:752,1039,1151,1197` (read `cardNeedOn(...).required` instead of `requiredOn`). Test in `web/lib/ai/assistant/repair-options.test.ts`.

**Interfaces:** Consumes `cardNeedOn`. The borrow option itself is left for Task 19.

- [ ] **Step 1: Failing tests.** `repair options count a temporary cover` (a covered slot offers no repair), and `run-one-short lowers from the ward need, not the authored count` (`:1197`).
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run lib/ai/assistant/repair-options.test.ts lib/ai/assistant/repair-eval.test.ts`, then the web gate. **Step 4: Commit** `feat(assistant): repair options read the ward need (d582)`.

### Task 9: Roster requirement model and coverage

**Files:**
- Modify `web/lib/roster-viewer/requirements.ts`:
  - `RequirementEquation` gains `qualifiedGroupIds: ReadonlySet<string> | null` and `coverByDate: ReadonlyMap<number, number>`. `RequirementMixFloor` gains `groupId: string | null`.
  - `deriveRequirementModel(submission, cover?: { decrements: readonly CoverDecrement[]; live: readonly UiTemporaryCover[] })` adds each decrement back. Then it subtracts the live credit from `requiredByDate`, `preferred` and `skillMix`.
- Modify `web/lib/roster-viewer/coverage.ts`: the per-cell label reads "2/2 from the ward · +1 cover".
- Test: `web/lib/roster-viewer/requirements.test.ts`, `web/lib/roster-viewer/coverage.test.ts`

**Interfaces:** Consumes `coverCredit`, `mixCredit`, `groupClosureOf` and `CoverDecrement`. Produces `deriveRequirementModel(submission, cover?)`. Callers pass `undefined` until Task 11 wires in the roster's `cover` and the live scenario covers.

- [ ] **Step 1: Failing tests.**
  - `requirement model counts a temporary cover`, `coverage counts a temporary cover`
  - `authored count = submitted + decrement`, `a live cover added after the solve lowers the need at once`, `a solved cover removed from the scenario raises the need at once`
  - `clamped-to-0 submission reads the true authored count through the ledger`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run lib/roster-viewer`, then the web gate. **Step 4: Commit** `feat(roster-viewer): requirement model adds back the ledger and applies live covers (d582)`.

### Task 10: Rule check, swap ladder and assistant roster summaries

**Files:**
- Modify `web/lib/roster-viewer/rule-check.ts`: `buildRuleModel` and `checkRosterChange` take the same `cover?` and pass it to `deriveRequirementModel`.
- Modify `web/lib/roster-viewer/swap.ts`: add `SwapContext.cover?`. `borrowNeeds` (`:195`) asks for a borrow only where `wardNeed` is still short.
- Modify `web/lib/ai/assistant/roster-context.ts`: summaries say "+N cover".
- Test: `rule-check.test.ts`, `swap.test.ts`, `roster-context.test.ts`.

**Interfaces:** Consumes Task 9's `deriveRequirementModel(submission, cover?)`. Produces `cover?: { decrements; live }` on `CheckOptions` and `SwapContext`.

- [ ] **Step 1: Failing tests.** `checkRosterChange counts a temporary cover`, `borrowNeeds counts a temporary cover` (a covered slot needs no borrow), `roster summary counts a temporary cover`.
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run lib/roster-viewer lib/ai/assistant/roster-context.test.ts components/ai/use-roster-tools.test.tsx`, then the web gate. **Step 4: Commit** `feat(roster): rule check, swap ladder and summaries count temporary cover (d582)`.

### Task 11: `roster-file/2` with `cover`, staged from the submission

**Files:**
- Modify `web/lib/roster/types.ts`: the version string, `RosterCoverEntry`, `RosterCover`, `RosterDocument.cover` and `ROSTER_DOCUMENT_FIELDS`.
- Modify `web/lib/roster/schema-version.ts`: the migration `1 → 2` adds `cover: {entries: [], decrements: []}`.
- Modify `web/lib/roster/validate.ts` (check `cover`) and `web/lib/roster/assemble.ts` (`AssembleRosterInput.cover: RosterCover`).
- Modify `web/lib/optimize/submission-snapshot.ts`: add `StagedSubmissionSnapshot.cover: RosterCover`. `isStagedSubmission` still checks the payload. A snapshot with no `cover` reads as empty.
- Modify `web/lib/optimize/use-optimize-run.ts:439-452,765`: the `stageSnapshot` input gains `cover`.
- Modify `web/components/optimize/optimize-and-export-screen.tsx:479`: call `applyCovers` once, then pass `document` and `cover` together.
- Modify `web/lib/optimize/roster-candidate-builder.ts:53`.
- Modify the callers of `deriveRequirementModel`, `buildRuleModel` and `SwapContext`. They now pass `{ decrements: document.cover.decrements, live: scenario.temporaryCover }`.
- Test: `web/lib/roster/schema-version.test.ts`, `web/lib/roster/file.test.ts`, `web/lib/roster/validate.test.ts`, `web/lib/roster/assemble.test.ts`, `web/lib/optimize/submission-snapshot.test.ts`, `web/components/optimize/optimize-capture-composition.test.tsx`, `web/lib/roster/f5-proof-matrix.test.ts`, and the `/1` → `/2` pins in `web/e2e/roster-real-ward-assembled.spec.ts`

**Interfaces:** Consumes `applyCovers` (Task 5) and Tasks 9-10's `cover?` parameters. Produces `RosterDocument.cover`. `entries` map the scenario covers (`date → iso`, `shiftType → shiftId`). `decrements` are `applyCovers(state).decrements` from the same run that built the YAML.

- [ ] **Step 1: Failing tests.**
  - `current is roster-file/2`, `1→2 adds an empty cover`, `a develop-era /2 with borrowed fails exact-field validation`, `roster-file/3 is newer`
  - `file round-trips cover exactly`, `assembled roster carries the staged cover`
  - `the staged cover comes from the same applyCovers run as the YAML` (composition test)
  - `no cover stages an empty cover and identical YAML`
- [ ] **Step 2: Implement.** Replace every `/1` pin with `/2`.
- [ ] **Step 3: Verify.**
  ```bash
  cd "$WT/web" && pnpm vitest run lib/roster lib/optimize components/optimize components/roster-viewer lib/roster-viewer
  pnpm typecheck && pnpm lint && pnpm format:check
  pnpm exec playwright test e2e/roster-viewer.spec.ts e2e/optimize-assembled-stream.spec.ts
  ```
- [ ] **Step 4: Commit** `feat(roster): roster-file/2 carries cover entries and the decrement ledger (d582)`.

### Task 12: Roster viewer "Temporary cover" band (parallel with Task 13)

**Files:**
- Modify `web/components/roster-viewer/roster-grid.tsx`. Add a band below the staff rows, headed "Temporary cover":
  - one row per cover name, with her shift chip on her dates
  - every other cell empty: no chip and no `·` rest glyph
  - no `personIdx`, no edit, no drag and no tallies
- Modify `web/components/roster-viewer/roster-viewer.tsx`: build the rows from `document.cover.entries` ∪ the live scenario covers.
- Test: `web/components/roster-viewer/roster-viewer.test.tsx`.

**Interfaces:** Consumes `RosterDocument.cover` and `state.temporaryCover`. Produces a pure `coverBandRows(entries, live, calendar): { name; cells: (ShiftTypeId | null)[]; status: "solved" | "not-optimized" | "removed" }[]`, exported from `lib/roster-viewer/cover-band.ts` with its own test.

- [ ] **Step 1: Failing tests.**
  - `band shows her shift on her date only and no rest glyph elsewhere`
  - `a live cover missing from the solve shows NOT OPTIMIZED YET`
  - `a solved cover removed from the scenario is struck through with REMOVED`
  - `band cells are not editable or draggable`
  - `tip reads "Temporary cover. Change it on Staff."`
  - F8: `adding a cover after the solve fills the short slot at once`, `removing a solved cover makes the slot read short at once`, `assignments do not change without a run`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run components/roster-viewer lib/roster-viewer`, the web gate, and `pnpm exec playwright test e2e/roster-viewer.spec.ts`. **Step 4: Commit** `feat(roster-viewer): temporary cover band (d582)`.

### Task 13: Excel cover rows, count credit and provenance table, on the edited export (parallel with Task 12)

**Files:**
- Create: `web/lib/roster/cover-sheet.ts`, `web/lib/roster/cover-sheet.test.ts`
- Modify `web/lib/roster/edited-xlsx.ts`: add `EditedXlsxPatchInput.cover?: CoverSheetPlan | null`. The no-edit short-circuit (`:147`) also requires no cover. The order is: patch edits by `coordinateMap`, then `applyCoverSheet`, then the provenance sheet.
- Modify `web/components/roster-viewer/roster-actions.tsx:94`: build the plan from `submission.canonicalYaml` and `document.cover.entries`.
- Test: `web/lib/roster/edited-xlsx.test.ts`

**Interfaces:**
- Consumes: `insertStyledRows` (Task 1), `parseSubmissionDocument` (`lib/roster/context.ts:74`), `groupClosureOf` (Task 5).
- Produces: `buildCoverSheetPlan` and `applyCoverSheet`.
- Behaviour:
  - Rows go directly under the last person row. Column A holds the name. Date cells hold her shift id or `""`. History and extra-column cells are `""`.
  - Find each count row by its `header` text in column A, below the `Status` row. On her date, it gets `+1` only if both hold:
    - its `countShiftTypes` has her shift
    - its `countPeople` is `ALL` or holds one of her groups (through the closure)
  - The "Roster provenance" sheet gains a "Temporary cover" table with columns Name / Date / Shift type / Groups (`JSON.stringify(groups)`). The edited export always writes the sheet. The raw download writes it only with covers (Task 14).

- [ ] **Step 1: Failing tests** (ExcelJS round-trip on the c5 golden in `lib/optimize/__fixtures__/c5`):
  - `cover rows sit under the staff rows and Score/Status move down`, `her summary cells are blank`
  - `count row adds her on her date only when the shift and people match`
  - `provenance lists name, ISO date, shift id and groups JSON`
  - `CF ranges shift with the inserted rows`
  - `edits are patched by coordinateMap before the insert`
  - `no cover and no edit returns the frozen bytes`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run lib/roster/cover-sheet.test.ts lib/roster/edited-xlsx.test.ts lib/roster/xlsx-rows.test.ts components/roster-viewer`, then the web gate. **Step 4: Commit** `feat(export): cover rows, count credit and provenance table in the edited export (d582)`.

### Task 14: Raw Optimize download writes cover rows

**Files:**
- Modify `web/lib/optimize/restore-people-ids-in-xlsx.ts:349-372`:
  - Add `PeopleIdRestorationInput.cover: CoverSheetPlan | null`.
  - The bypass requires `!anonymized && cover === null`.
  - Else: restore ids first (anonymized runs only). Then call `applyCoverSheet` with `lastPersonRow = 2 + peopleCount`. Derive the date columns the way `assemble.ts` derives `coordinateMap`.
- Modify `web/lib/optimize/session-transaction.ts:100-110,190-200,467-534,667`: carry `coverSheet: CoverSheetPlan | null` next to `peopleCount`, in the equality check and the durable validator too. If the durable record is checked field by field, raise the session schema version.
- Modify `web/lib/optimize/use-optimize-run.ts:755,803,914` and `web/lib/optimize/use-optimize-terminal.ts:310-314`.
- Test: `web/lib/optimize/restore-people-ids-in-xlsx.test.ts`, `web/lib/optimize/use-optimize-terminal.test.tsx`, `web/lib/optimize/session-transaction.test.ts`

**Interfaces:** Consumes Task 13. Produces the raw download with cover. The frozen workbook for the roster (`frozenXlsx`) is still captured without cover rows (spec F6).

- [ ] **Step 1: Failing tests.**
  - `plain run with no cover is a byte-identical bypass`
  - `restoration runs before the insert` (anonymized plus cover: the people window is asserted on the core bytes)
  - `restoration never runs on an exported workbook`
  - `raw download with cover writes rows and provenance`
  - `frozenXlsx is captured without cover rows`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run lib/optimize components/optimize`, the web gate, and `pnpm exec playwright test e2e/optimize-assembled-stream.spec.ts e2e/optimize-durable-stream.spec.ts`. **Step 4: Commit** `feat(optimize): raw download writes cover rows after id restoration (d582)`.

### Task 15: Staff screen "Temporary cover" section (parallel in Group D)

**Files:**
- Create: `web/components/people/temporary-cover-section.tsx`, `web/components/people/temporary-cover-section.test.tsx`
- Modify `web/components/people/people-table.tsx`: render the section as the third card, below Staff groups.
- Modify `web/components/requirements/requirement-card-list.tsx`: the Exceptions field lists cover effects read-only, with a link to Staff. Example: `14 Oct: 2 · Haseena (Ward 3) covering`.
- Modify `web/lib/capability/help-content.ts`: one entry. Regenerate the registry.

**Interfaces:**
- Consumes: `coverStatuses`, `scenarioCommands.mutate` (`lib/store/commands.ts:46`), and the staff-group toggle chips the staff rows use.
- Produces: an editor with `data-testid="temporary-cover-editor"`, fields `name`, `date` (native `<input type="date">` bounded to the period), `shiftType` (worked shifts only) and the group chips. Each row carries `data-change-key="cover:<name>|<date>|<shiftType>"`. Task 17 relies on these.
- Validation: a non-empty name, a date, a worked shift, groups that exist, no duplicate name+date. The same name on one date with a second shift is refused ("one shift a day").
- After Save or Delete, with a working roster present: `Callout tone="info"`, "Night on 14 Oct now needs 2 from the ward. Run Optimize again so the roster plans around Haseena." Its `Run Optimize` button opens Optimize and does not start a run.

- [ ] **Step 1: Failing tests (Testing Library).**
  - `add, edit and delete are one undo step each`
  - `Effect reads "N on 14 Oct: 3 → 2 (All nurses)"`, `flagged cover shows its warning badge`, `clamp shows the extra-cover warning`, `restricted card shows "Under <rule>, only RN work N. Haseena is not in RN."`
  - `refuses a duplicate name and date`, `refuses a second shift for one name on one date`
  - `empty state reads "No temporary cover"`
  - `callout appears after Save when a roster exists and Run Optimize does not start a run`
  - `Requirements Exceptions lists cover effects read-only`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run components/people components/requirements lib/capability`, the web gate, and `pnpm exec playwright test e2e/people.spec.ts e2e/requirements.spec.ts e2e/v2-visual-system.spec.ts`. **Step 4: Commit** `feat(staff): Temporary cover section on the Staff screen (d582)`.

### Task 16: Assistant commands `add_temporary_cover` / `remove_temporary_cover`

**Files:**
- Modify `web/lib/proposal/commands.ts`: the union, the zod schema and `ASSISTANT_COMMAND_TYPES`.
- Modify `web/lib/proposal/operations.ts`: the `applyAssistantCommand` arms. The host refuses a repeat of name, date and shift with "Haseena (Ward 3) already covers N on 14 Oct."
- Modify `web/lib/proposal/diff.ts`. Scope `staff-list`, key `cover:<name>|<date>|<shiftType>`. The lines:
  - add: "Adds temporary cover Haseena (Ward 3): Night, 14 Oct.", then "N on 14 Oct: exactly 3 → 2 (All nurses)", then any F1, F2 or F4 note
  - remove: the reverse
- Modify `web/lib/change-highlight/plan.ts`: add the noun `["cover:", "temporary cover", "temporary covers"]`.
- Modify `web/lib/ai/assistant/scenario-context.ts:37` (add `temporaryCover` to the context JSON) and `web/components/ai/model-visible-tools.ts`.
- Test: next to each file, plus `web/lib/ai/runtime/model-visible-tools.test.ts` (locked key lists).

**Interfaces:** Consumes `coverStatuses` and `cardNeedOn`. Produces the two commands. They use the Staff form's validation, `validateCover(state, entry, editingIndex?)` in `temporary-cover.ts`. Tasks 15 and 16 both need it. The first of the two to land adds it, and the other imports it.

- [ ] **Step 1: Failing tests.** `context lists covers`, `duplicate cover refused`, `add diff line and effect`, `remove diff line`, `locked schema keys for add/remove_temporary_cover`, `undo copy says "Undo removes the cover and puts Night on 14 Oct back to 3."`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run lib/proposal lib/change-highlight lib/ai/assistant/scenario-context.test.ts lib/ai/runtime`, then the web gate. **Step 4: Commit** `feat(assistant): add/remove_temporary_cover commands (d582)`.

### Task 17: Apply opens Staff and fills the form in view

**Files:**
- Create: `web/lib/scenario/cover-edit-request.ts` (a screen handshake modelled on `lib/roster/change-request.ts`: `requestCoverEdit(request)`, `awaitCoverEditOutcome(): Promise<"applied" | "rejected" | "expired">`, and a Zustand pending slot)
- Modify `web/components/people/temporary-cover-section.tsx`. It reads a pending request and then:
  1. opens the editor with `origin: "assistant"`
  2. fills the fields one by one (all at once with `prefers-reduced-motion`)
  3. presses its own Save and resolves the outcome
  4. calls `showChangeHighlight` and posts an `aria-live` message
- Modify `web/components/ai/linked-apply.ts`. Cover commands go through the handshake:
  1. Check that the proposal still matches the scenario revision.
  2. Open `staff-list`.
  3. Send the request and wait for the outcome.

  Other linked commands, such as the asking nurse's leave, still apply through `applyProposal`. The screens are walked in `SCREEN_ORDER`.
- Modify the notice text at `web/components/ai/linked-apply.ts:39`: "Added temporary cover Haseena (Ward 3)."
- Test: `web/components/ai/linked-apply.test.ts`, `web/components/people/temporary-cover-section.test.tsx`, `web/lib/scenario/cover-edit-request.test.ts`

**Interfaces:** Consumes Tasks 15-16. Produces `CoverEditRequest = { kind: "add"; entry: UiTemporaryCover } | { kind: "remove"; name: string; date: string; shiftType: string }`.

- [ ] **Step 1: Failing tests.**
  - `Apply routes to /people and opens the prefilled editor`, `Save writes one undo entry`, `the new row is highlighted and announced`
  - `a validation failure leaves the editor open and writes nothing`, `a stale Preview writes nothing`
  - `remove_temporary_cover Apply deletes in the form`
  - `a linked cover + leave proposal walks Staff then Requests`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run components/ai components/people lib/scenario/cover-edit-request.test.ts`, the web gate, and `pnpm exec playwright test e2e/assistant-proposal-apply.spec.ts`. **Step 4: Commit** `feat(assistant): cover Apply fills the Staff form in view (d582)`.

### Task 18: Cover ladder step 3 emits `add_temporary_cover`

**Files:**
- Modify `web/components/ai/use-roster-tools.ts`, `borrowParameters` (`:122`):
  - Drop `source`.
  - Describe `name` as "the nurse's name as the user said it, with the lending ward in brackets, for example Haseena (Ward 3)".
  - Add `lenderConfirmed: z.boolean()`. False refuses.
- Modify the `prepare_borrowed_cover` handler in the same file:
  - Emit one `add_temporary_cover` per `ladder.borrow` need. Its `groups` are the user's groups ∪ `skillGroup`.
  - Emit the asking nurse's leave or off request, as today.
  - Emit no person, no pins and no roster cells.
  - Name `OPTIMIZE_RUN_TOOL` in the return.
  - Remove the `borrowed_staff_arranged` guard (`:784`).
- Modify `web/lib/ai/assistant/roster-context.ts`: the `buildBorrowView` copy.
- Modify `web/lib/ai/assistant/scenario-context.ts:125`: ask in chat first whether the lending ward agreed.
- Modify `web/lib/proposal/assumptions.ts`: remove `borrowed_staff_arranged` and `borrowedStaff()`.
- Modify `web/components/ai/model-visible-tools.ts` and `web/components/ai/assistant-conversation.tsx:137` ("Preparing a temporary cover…").
- Modify `web/lib/ai/assistant/store.ts:97`: the `record: "staff"` label names the cover.
- Test: `use-roster-tools.test.tsx`, `roster-context.test.ts`, `assumptions.test.ts`, `model-visible-tools.test.ts`, `roster-change-card.test.tsx`.

**Interfaces:** Consumes `add_temporary_cover` (Task 16) and the handshake (Task 17). Produces the step-3 card.

- [ ] **Step 1: Failing tests.**
  - `lenderConfirmed false refuses and shows no card`
  - `one need emits exactly one add_temporary_cover with the skill group and the asking nurse's request`
  - `two needs emit two covers`
  - `no add_person, pins or roster cells`
  - `return names request_optimize_run`
  - `no borrowed_staff_arranged assumption is derived`
  - `after removal the assistant offers Optimize`
- [ ] **Step 2: Implement.** **Step 3: Verify:** `pnpm vitest run components/ai lib/ai lib/proposal`, the web gate, and `pnpm exec playwright test e2e/ai-assistant-chat-ui.spec.ts`. **Step 4: Commit** `feat(assistant): step 3 books a temporary cover (d582)`.

### Task 19: Repair option `borrow_temporary_nurse` emits covers (parallel with Tasks 17-18)

**Files:**
- Modify: `web/lib/ai/assistant/repair-options.ts:557-695,1262-1269`:
  - The option emits one `add_temporary_cover` per short (date, shift), repeated for the gap. The name is `"Borrowed nurse n (another ward)"`. `groups` holds the short rule's named group, or, for a skill-mix shortfall, the short entry's group.
  - It is not offered for a cap-only shortfall.
  - `enforcedBy: "chat"`. `needsFromUser` asks for the name and the lending ward.
  - Remove `narrowedCounts`, `pinnable`, the whole-period loan and the `add_person` loan.
  - `isSafeOption` gets an `add_temporary_cover` arm: in period, a worked shift, known groups, and `coverStatuses` shows no flag.
- Modify: `web/lib/ai/assistant/playbook.ts:22,261-267` (the entry is chat-enforced and names the cover).
- Test: `repair-options.test.ts` and the `playbook` tests.
- Test: `repair-eval.test.ts`. Update the expectations, then regenerate the fixtures with `-u`.
- Test: `core/tests/test_assistant_repair_fixtures.py`. The case list does not change, and each `after` must still be feasible.

- [ ] **Step 1: Failing tests.**
  - `two short slots give two covers`, `a gap of 2 gives two covers on one slot`, `skill-mix shortfall cover carries the entry's group`
  - `cap-only shortfall offers no borrow`
  - `isSafeOption rejects a flagged cover`
  - `borrow option is chat-enforced`
- [ ] **Step 2: Implement.** **Step 3: Verify.**
  ```bash
  cd "$WT/web" && pnpm vitest run lib/ai/assistant -u && pnpm vitest run lib/ai/assistant
  cd "$WT/core" && PYTHONPATH=. python3 -m pytest -q tests/test_assistant_repair_fixtures.py
  ```
  Then run the web gate. **Step 4: Commit** `feat(assistant): borrow repair option books temporary covers (d582)`.

### Task 20: Real-solver e2e and final verification

**Files:** Create `web/e2e/temporary-cover-real-ward.spec.ts`, following `e2e/roster-real-ward-assembled.spec.ts` (the production route and the real backend).

- [ ] **Step 1: Failing e2e.**
  - `a ward one short on N 14 Oct is INFEASIBLE`
  - `with one cover it solves, and her band row shows N on 14 Oct only`
  - `the Excel download has her row under the staff rows and a provenance cover table`
  - `the roster file round-trips cover`
- [ ] **Step 2: Make it pass.** Fix only what the e2e exposes, and name the owning task in the commit.
- [ ] **Step 3: Full verification.**
  ```bash
  cd /home/kenan/work/nursing-sheduler.feat-d582-temporary-cover/web
  pnpm test                 # known env failure: dev-launcher.test.ts needs uvicorn
  RUN_DIFFERENTIAL=1 pnpm test:differential
  pnpm typecheck && pnpm lint && pnpm test:ast-grep && pnpm format:check
  pnpm exec playwright test e2e/temporary-cover-real-ward.spec.ts e2e/roster-real-ward-assembled.spec.ts e2e/roster-viewer.spec.ts e2e/people.spec.ts e2e/assistant-proposal-apply.spec.ts e2e/app-shell-rebuild.spec.ts
  cd ../core && PYTHONPATH=. python3 -m pytest -q && ruff check . && ruff format --check .
  ```
  Identity gate: `rg -n "temporary: true|borrowed" lib components -g '!*.test.*'` shows only copy strings.
- [ ] **Step 4: Commit** `test(e2e): temporary cover on a real ward (d582)`.
- [ ] **Step 5: Beads.** `bd close nursing-sheduler-d582`. File a bead "retire core patch P1 (Person.temporary)". Run `bd remember` for "ExcelJS 4.4.0 insertRow does not shift conditional formats. Use insertStyledRows in lib/roster/xlsx-rows.ts.". Correct the stale line in `2026-09-25-v1-genie-sync-design.md:18` ("The web submits Workspace V1") at its next edit, as the spec asks. Ask the user before merging to `develop`.

---

## Unresolved questions

1. **Durable session schema (Task 14).** Adding `coverSheet` to the optimize session record: does it need an `OPTIMIZE_SESSION_SCHEMA_VERSION` bump? I did not read the record validator. If the validator checks each field, Task 14 bumps the version.
2. **Stale-Preview check for a form-driven Apply (Task 17).** Before the handoff to the form, the plan checks the proposal against the current scenario revision. `assistantProposalCommands.apply` does this check internally today. Task 17 must export that check, or add a dry-run mode. Which do you prefer?
3. **Solver-equivalence location.** You asked for pytest. The plan uses pytest over YAML pairs that Vitest writes (the existing repair-fixture pattern), not the differential oracle, so CI runs it without `RUN_DIFFERENTIAL`. Agree?

## Assumptions

- Readers keyed on authored cards (shortfalls, diff, repair options, the Staff Effect column) use `cardNeedOn`, not the split state. Split cards get derived uids (`#s<i>`, `#d<iso>`) that authored lookups cannot find. A property test pins that `cardNeedOn` and `applyCovers` agree on every slot. This is a mechanism choice inside spec §2 and F5, not a behaviour change.
- The optimize submission anonymizes people only (`groups: false`, `prepare-optimize-submission.ts:10`), so cover group ids match the submitted document's group ids on the roster.
- Phase A can merge to `develop` alone. Between Phase A and Task 11, `develop` writes `roster-file/1`, and a dev-stored `/2` row with `borrowed` reads as `newer`. That is accepted: no compatibility (spec §4).
- A persisted local scenario with a stray `temporary` key on staff still hydrates. Once the type check is gone, the validator ignores unknown staff keys (`persistence.ts:265-280`).
- Count rows exist only in prettified workbooks (`exporter.py:526`). With no count rows, the count-row credit does nothing.
- Task 16 or Task 15 owns `validateCover`, whichever lands first. The other imports it.
