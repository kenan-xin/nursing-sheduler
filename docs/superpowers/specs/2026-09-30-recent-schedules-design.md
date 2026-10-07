# Recent schedules, and a new period from a past schedule

Confidence: 7.1/10

Most of this reuses things that already exist. Old schedules are already kept (every New and Load mints a new envelope and deletes nothing). The table already has an `updatedAt` index. Leases are already per schedule, and there is already a pure transform that moves a schedule to new dates (`applyRangeChange`). The score is lower for four reasons. Roster storage is one global slot today, so P2 changes a storage model that the capture code (about 60 KB, not fully read) depends on. The new-period Apply is a schedule switch, and the current Apply path cannot do a switch. Nobody measured how much space each schedule takes. And two related beads (ymmp, wm5i) are still in progress.

**Bead:** `nursing-sheduler-plq5` (audit finding C-25). Related beads:
- `ymmp`: C-23, clear the roster on Load (in progress).
- `wm5i`: A-02, a banner with Switch for another tab's Load (in progress).
- `qmwy`: BH1 / A-01, a new tab opens the most recently active schedule (merged).

**User rulings (2026-09-29):**
- Keep past schedules.
- Add a Recent schedules list that can reopen them.
- The assistant can use a past schedule. For example: "based on my September schedule, create November." It copies staff, groups and rules. It carries the last days of September's roster into November's history, so the rest look-back works. It carries nothing month-specific, such as requests or leave, unless the user asks.
- Fix the "Start over" copy so it is true.

## 1. What is true today

- **Every New or Load keeps the old schedule.** `switchScenario` (`web/lib/store/authority.ts:1329`) calls `selectOrSwitchScenario` (`web/lib/repository/repository.ts:638`). That call mints a fresh envelope for `new` and `load` targets (`:700-706`). It releases the old lease (`:738-740`) and deletes nothing. The only envelope delete in the code is inside the legacy migration (`web/lib/repository/migration.ts:214`).
- **An envelope** (`ScenarioEnvelopeV3`, `web/lib/repository/types.ts:39-58`) holds the whole scenario, plus `createdAt` and `updatedAt`. It has no name. The table is indexed on `scenarioId, updatedAt` (`web/lib/repository/schema.ts:173`).
- **`latestScenarioId()`** is `orderBy("updatedAt").last()` (`repository.ts:563-566`). A tab with no selection of its own opens that schedule (`authority.ts:666-671`, A-01). `updatedAt` moves on edits, switches and lease acceptance (`repository.ts:425, 719`), so in practice it means "last active".
- **Leases are per schedule** (`WriterLeaseV2`, `types.ts:82-89`). Two tabs can edit two different schedules at once. If another live tab owns the target, this tab opens it read-only (`authority.ts:688-700`).
- **The roster is one global slot.** The key is `"working"` (`web/lib/store/roster-storage.ts:75`), and the candidate pointer and clear epoch are origin-wide (`:89-90`). `clearRosterData` empties the whole `roster` and `snapshot` tables (`:902-903`). New schedule runs that clear first, then the scenario reset (`web/lib/roster/new-schedule-reset.ts:106`). A roster row has no link to a schedule.
- **Assistant data is already per schedule.** These rows are keyed by `scenarioId`: threads (`schema.ts:204`), proposals, receipts, diagnostic searches and optimize bases (`:186`).
- **The Start over copy is false.** The card says "Starting empty removes everything saved in this browser and cannot be undone" (`web/components/shell/new-schedule-button.tsx:147`). The dialog says "This clears your entire current schedule" (`:194`). In fact the schedule stays in IndexedDB, and nothing can open it again.

## 2. Data model

**A schedule is one scenario envelope.** No new table. Three optional fields go on the envelope. Each is written by a metadata-only commit, which moves `recordRevision` but not `documentRevision`, so no Preview goes stale (`types.ts:30-35`). They are not part of the scenario, so they are never exported and never undoable.

| Field | Meaning |
|---|---|
| `title?: string` | The user sets it with Rename. Without it, the list shows the auto-name. |
| `pinned?: boolean` | Pinned schedules are never removed automatically. |
| `derivedFrom?: { scenarioId, title }` | Set by "new period from past schedule". Shown as "Based on September 2025". |

No Dexie version bump is needed. The fields are optional, and nothing indexes them. Old rows read back without them. This is the same approach `candidateSource` took (`types.ts:497-508`).

**Auto-name** = `<ward> · <period>`.
- Ward is `meta.description`, the same name the top bar shows (`web/components/shell/top-bar.tsx:63`). When it is empty, use "Untitled ward".
- Period: for a range (`rangeStart..rangeEnd`) of exactly one calendar month, "November 2025". For any other range, "3 Nov to 30 Nov 2025".
- Two schedules with the same name get the created date after them: "(created 2 Oct)".

**Delete.** One transaction deletes these rows for the `scenarioId`:
- the envelope
- `scenarioCommits`, `historyLinks`, `optimizeBases`
- `assistantProposals`, `assistantReceipts`, `diagnosticSearches`
- `assistantThreads`, `assistantTurns`, `assistantMessages`
- its `tabSelections` rows and its lease row
- from P2 on, its roster and snapshot rows

It then bumps the schedule's assistant fence, the same way `clearAssistantContent` does (`repository.ts:1114-1162`). This needs its own table set. The assistant tables are deliberately left out of `SCENARIO_WRITE_TABLES` (`schema.ts:337`).
- Delete is refused for the schedule this tab has open. The user opens another one first.
- Delete is refused while another tab holds a live lease on that schedule. The message is "Open in another tab".
- A stale tab whose selection points at a deleted schedule falls back to `latestScenarioId()` on its next reread. This fallback path needs a test.

**Limit and removal.** The list keeps up to **30 unpinned schedules**. The list says so: "Keeps your 30 most recent schedules. Pin one to keep it."
- Removal happens only at the creation of a schedule (New, Load, Duplicate, new period).
- Two kinds of schedule are removed first, in this order:
  1. Empty ones that were never edited: an empty scenario, with the document revision still at its value from creation. Every New makes one of these.
  2. The oldest unpinned ones by `updatedAt` that no live tab holds.
- Each removal shows a toast that names the schedule.
- A `QuotaExceededError` on any write already has a detector (`web/lib/optimize/session-transaction.ts:243`). Reuse it, and say: "Browser storage is full. Delete old schedules in Save & Load."
- *Unconfirmed:* the size of each schedule. The commit log with its undo payloads is possibly much bigger than the envelope. P1 measures a real 87-person ward before fixing the number 30.

## 3. Roster per schedule (P2) and C-23

The target is that **each schedule keeps its own roster.**
- Roster keys become `working:<scenarioId>` and `candidate:<scenarioId>:<jobId>`.
- `currentCandidate` becomes per schedule.
- The origin-wide `nextCandidateVersion` counter stays global. It is never reused, and ABA safety depends on that (`types.ts:487-495`).
- The key is out-of-line, so the key format can change without an index change (`schema.ts:191`).
- A capture must record the `scenarioId` it was submitted from. The submission snapshot already carries an `ownerId` (`web/lib/optimize/submission-snapshot.ts:54`). *Unconfirmed:* where in `web/lib/optimize/roster-capture.ts` the key is chosen. That file was not fully read.

What this means for the lifecycle:
- **Load and New stop clearing roster data.** A new identity has no roster, and the old schedule keeps its own. `resetToNewSchedule` then only needs to reset the in-memory capture state for the new schedule. It no longer wipes every table.
- **C-23 is superseded.** ymmp's "clear the roster on Load" is right for P1, while there is one slot: after a Load, the Roster screen must not show the previous ward's roster. P2 removes that clear, because in P2 a clear deletes the roster of another schedule. The user must confirm this change to the ruling (Q1).
- **Migrating the existing `"working"` row.** Give it to the schedule whose `rangeStart..rangeEnd` and person ids match the roster's `context.calendar` and `context.people` (`web/lib/roster/types.ts:130-136`). Pick the newest match. If nothing matches, attach it to `latestScenarioId()`, and mark it "possibly from a different schedule". Never drop it.

## 4. Recent schedules UI

**Where:** a new "Recent schedules" card on Save & Load (`web/components/save-load/save-load-workspace.tsx`), above Start over (`:116`). A top-bar switcher is out of scope.

**Rows** are newest first by `updatedAt`. Each row shows:
- the name, ward and period
- "Last edited 3 days ago"
- a "Has roster" chip (from P2)
- a "Based on September 2025" line for a derived schedule

The open schedule is marked **"Open here"** and has no Open button. A schedule leased by another live tab is marked **"Open in another tab"**.

**Actions:**
- **Open.** Switches this tab to the schedule (`selectOrSwitchScenario` with `target: existing`). Nothing is lost, because the current schedule stays in the list, so there is no confirm step. Undo does not reach back across the switch, which is already true for Load (`web/lib/store/lifecycle.ts:22-24`). A target held by another tab opens read-only with the existing Take over path.
- **Rename.** Writes `title`. Clearing the name brings back the auto-name.
- **Duplicate.** A Load of the same scenario into a new identity, titled "Copy of …". The roster is not copied: a copy is a draft that has not been solved.
- **Pin / Unpin.**
- **Delete.** Confirm dialog: "Delete 'Ward 3 · September 2025'? Its roster and assistant conversation are deleted too. This cannot be undone. To keep a copy, download it first." Delete uses the rules in §2.

**Multi-tab.** Opening from the list is a switch, the same as Load. So another tab that was looking at the old schedule gets the same A-02 banner with Switch (wm5i). The list refreshes on the authority's existing `acquired` broadcast (`authority.ts:709`), and it re-reads on focus, like every other resumption point (`lifecycle.ts:165-172`). A-01 is unchanged: a new tab opens the top row.

**Start over copy (P1).** Card body: "Start a new, empty schedule. Your current schedule stays in Recent schedules below." Confirm dialog title: "Start a new schedule?"
- Keep the list of items this clears (`new-schedule-button.tsx:198-202`), but only while it is true.
- In P1 it says "The saved roster and the last run's result are cleared". P2 drops that line.
- Remove "cannot be undone", because the old schedule can be reopened.
- `web/components/settings/ai-assistant-card.tsx:632` already says "other schedules' conversations are kept". That becomes true and reachable, so no change is needed there.

## 5. Assistant

Three tools. Each one is registered through `useModelVisibleTool` (`web/components/ai/register-model-visible-tool.ts:179`), named in `ASSISTANT_TOOL_NAMES` (`web/lib/capability/tools.ts:14`), and has its schema in `MODEL_VISIBLE_TOOL_SCHEMAS` (`web/components/ai/model-visible-tools.ts`).

1. **`list_recent_schedules`** (no parameters, read-only). Returns the list rows: a short opaque ref, the name, period, ward, whether it has a roster, and whether it is the current schedule. It returns no `scenarioId`.
2. **`get_past_schedule_summary { scheduleRef }`** (read-only). Runs `summarizeScenario` (`web/lib/ai/assistant/scenario-context.ts:94`) over that envelope. From P2 on, it adds a roster summary: each person's shift totals and their last 7 days. It never writes, and it never switches the open schedule.
3. **`prepare_new_period_from_schedule { scheduleRef, rangeStart, rangeEnd, historyDays = 7, keep?: { requests?, leave?, covers? } }`**. Shows a Preview card, and the user presses Apply.

**What it copies.** It builds the target with a pure transform over the past `ScenarioUiState`:
- **Copied as-is:** `meta`, `staff`, `staffGroups`, `shifts`, `shiftGroups`, all rule cards, and `exportLayout`.
- **Moved to the new range:** it runs `applyRangeChange(past, newRange, { importSingaporeHolidays: true })` (`web/lib/dates/range-cascade.ts:44`). That transform removes references to dates that left the range and rebuilds the holiday groups. The Preview lists every rule, date group and per-date staffing override (`requiredNumPeopleOverrides`, `web/lib/scenario/types.ts:236`) that was dropped or narrowed.
- **Not carried by default:** `reqData` (requests and leave) and `temporaryCover`. The `keep` flags carry them only at the user's request. The dates move by whole days to the new range. A date outside the new range is dropped and listed.
- **`staff[].history` is replaced**, as described next.

**How history is derived.** History is right-anchored: the last entry is the day before the new period starts (`web/lib/scenario/person-history.ts:1-3`).
- Take the past schedule's roster from P2, with the user's edits applied: `deriveCurrentDays(solvedDays, edits)` (`web/lib/roster/overlay.ts:193`).
- For each new-staff person whose id is in the roster's `context.people`, take their last `historyDays` cells. Map shift to its `shiftId`, off to `"OFF"`, and leave to `"LEAVE"`. These are the only tokens the core accepts besides shift ids (`core/nurse_scheduling/models.py:773`, `core/nurse_scheduling/constants.py:23-25`).
- Cut at any shift id that no longer exists, using `truncateHistoryAfterUnusable` (`person-history.ts:21`).
- History is carried **only for a new period that starts on the day after the past roster ends**. With a gap, or with no past roster, every history is empty. The Preview says why: "November does not follow straight after September, so no rest history was carried."
- A person with no roster row gets empty history.
- The past schedule's own `history` values are never reused, because they describe the days before September.

**Apply.** It is a schedule switch, not a commit on the current schedule. The existing Apply is fenced on the current schedule's `documentRevision` (`web/lib/proposal/proposal.ts:128-135`, `commitAssistantProposal` at `repository.ts:1182`), and a switch cannot pass that fence. So:
- Preview stores the source's `documentRevision`.
- Apply re-reads the source. If the source changed, Apply refuses: "September changed since this preview. Ask again."
- Otherwise Apply runs `switchScenario` with a new target kind, `derive`. This is `load` plus `derivedFrom`. The past schedule is never written.
- The card says: "Creates 'Ward 3 · November 2025' and opens it. September is kept. This conversation continues in 'Ward 3 · November 2025', and this schedule keeps a copy." Assistant threads are per schedule (`schema.ts:204`). The switch transaction copies the open schedule's active thread onto the new identity, with new message ids and the new schedule's fences. The old thread is kept unchanged (Q3, decision 3 as revised 2026-10-07).
- A Preview, roster change or run card made before Create is set aside on Create. Its Apply is refused anyway, because the old schedule's lease is gone.
- There is no Undo on the receipt. To go back, open September from Recent schedules. To remove November, delete it.

## 6. Privacy

- Anonymise does not apply to local storage. `anonymize.ts` rewrites a copy for export and Optimize only (`web/lib/scenario/anonymize.ts:1-9`). Every kept schedule stays in this browser's IndexedDB with real names, history, requests and leave until it is deleted.
- The Recent schedules card says this in one line: "Schedules are stored only in this browser, with real names. Delete a schedule to remove it."
- When the assistant reads a past schedule, it sends that data to the model provider, exactly like `get_schedule_overview` does for the current one. No new data category is created.

## 7. Migration of hidden schedules

There is nothing to rewrite. Existing envelopes show up in the list with auto-names as soon as P1 ships.
- Empty envelopes that were never edited (left behind by New) are hidden from the list and removed first by the limit (§2).
- On first run, the app removes nothing. Removal starts at the next create. The user sees the whole list first.
- For the roster, see the migration in §3.

## 8. Phases

- **P1: list, reopen, truthful copy.**
  - Build: the envelope fields and the repository calls (`listSchedules`, `renameSchedule`, `pinSchedule`, `deleteSchedule`).
  - Build: the Recent schedules card with Open, Rename, Duplicate, Pin and Delete.
  - Also: the limit and removal policy, the quota message, and the Start over copy.
  - The roster stays one slot, and ymmp's "clear on Load" stays.
  - Tests: delete removes the rows in every table. Delete of a leased or open schedule is refused. A stale selection falls back. The removal order is correct. Measure the size of one schedule.
- **P2: a roster per schedule.**
  - Build: roster rows and pointer keyed by schedule, capture bound to `scenarioId`, and the `"working"` row migration.
  - Load and New stop clearing roster data. Ask the user to confirm the C-23 change first (Q1).
  - Tests: Load B, then open A again, and A shows its own roster. The clear-epoch and ABA proofs stay green.
- **P3: assistant.** It needs P2 for the roster.
  - Build: the three tools, the `derive` switch kind, the Preview card, and the history derivation.
  - Tests: unit tests on the pure transform (the copy set, the dropped list, and history for the contiguous, gap and no-roster cases). Apply refuses a changed source. One end-to-end run of "based on September, create November".

## Open questions

1. **C-23:** in P2, do Load and New stop clearing the roster, because each schedule keeps its own? (This changes the ymmp ruling.)
2. Is **30 unpinned** the right limit? Or do we skip automatic removal, and refuse to create until the user deletes one?
3. After "create November", does the conversation move to November, or stay with September (the current per-schedule threads)?
4. Is **7 days** of history enough? The alternative is the longest shift-sequence rule length minus 1 (whichever is larger).
5. Does pinning also call `navigator.storage.persist()`? Today the app never asks for persistent storage (no search hits). Under storage pressure, the browser can evict the whole site.
6. Does Duplicate copy the roster as well?

## User decisions (2026-09-30)

1. Roster per schedule (P2) is approved. Load and New stop clearing the roster once P2 ships. This replaces the C-23 ruling.
2. Keep up to 30 unpinned schedules. At the limit, the oldest unpinned schedule is removed, and the list says so first. Pinned schedules are never removed.
3. After "create November from September", the conversation moves to November, with a short note that links back to September's conversation. Revised 2026-10-07: the same conversation continues in November, so the user can keep talking. The schedule the chat was on keeps a copy up to that point.
4. History carried into a new period covers the longest look-back that any rule needs, with a minimum of 7 days.
5. Pinning a schedule also asks the browser for persistent storage.
6. Duplicate copies the roster too.
