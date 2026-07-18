# HANDOFF — Parity rebuild: T11 Shift Requests matrix (next), T17 + qq0.22 shipped

**Chain:** parity-rebuild · **Seq:** 1 · **Parent:** none (first handoff in chain)
**Date:** 2026-07-18 · **Auto:** false
**Epic:** `8b2235d5-8943-4f6d-a61e-3b671836217a` — "Parity rebuild — frontend + vendored backend" (bead epic `nursing-sheduler-qq0`)
**Primary beads:** `nursing-sheduler-qq0.11` (T11 — next, planned not executed), `nursing-sheduler-qq0.17` (T17 — DONE, closed), `nursing-sheduler-qq0.22` (DONE, closed)
**Repo:** `/home/kenan/work/nursing-sheduler` · **Branch:** `main` (clean, all pushed to `origin/main`, HEAD `edf2658`)
**Orchestration:** Traycer Epic Mode. Artifacts under `/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/`.

---

## Goal

Continue the **parity rebuild of the nurse-scheduling frontend** (`web/`, Next.js 16 + React 19), milestone by milestone, against the vendored Python backend (binding contract). This session shipped **T17 (Save/Load & YAML + anonymize)** and **qq0.22 (dirty nav warning)**, then **planned T11 (Shift Requests matrix)**. The immediate next action is executing (or first cold-critiquing) the just-drafted T11 tech-plan.

---

## Where We Are (status)

| Work | State |
|---|---|
| **T17** (qq0.17.1–.8) Save/Load & YAML + anonymize | ✅ DONE, cold-reviewed, fixed, committed + **pushed** (`e3ea49c`, `4d70c67`, `f08b62a`) |
| **qq0.22** dirty nav/unload warning re-enable | ✅ DONE, committed + **pushed** (`edf2658`) |
| **qq0.17.9** T17 cold-review fixes | ✅ closed (folded into T17 commit) |
| **T11** (qq0.11) Shift Requests matrix | 📋 **Tech-plan DRAFTED, NOT executed.** Bead open, not claimed. |
| **qq0.23** uncredited-leave guard | 📋 folded INTO T11 scope (per plan) |
| Next milestones | T16 (qq0.16 Optimize&Export), T14 (qq0.14 Rules Guided), T15 (qq0.15 Export Layout) — all open P2, unblocked |

**Tree is clean, everything pushed.** No uncommitted work. `bd list --status in_progress` = none.

---

## THE NEXT ACTION

**Execute T11**, or first cold-critique its plan (recommended — the paint-store rework is load-bearing). The T11 tech-plan is at:
`.traycer/epics/8b2235d5-.../artifacts/rebuild-tech-plan/tickets/t11-shift-requests-matrix/index.md` (kind: ticket, status 0).

Suggested first message next session (paste):
> Read plans/handoffs/HANDOFF_parity-rebuild_t11-shift-requests_2026-07-18.md (seq 1, chain parity-rebuild) and continue. Cold-critique the T11 tech-plan, then execute T11 as one ticket — lead with the paint-store set-per-cell rework.

---

## T11 tech-plan — the just-drafted next work (READ THE ARTIFACT)

**Reframe:** T11 is the matrix UI on an **already-built store** (`reqData` + atomic paint protocol), with **ONE store seam to extend**.

**7 settled decisions (confirmed with user):**
1. A person×date coordinate = **day-state (leave XOR off) OR a *set* of worked-shift prefs** (one `{shiftType,weight}` per type). `reqData: UiRequestCell[]` already models this — **data model unchanged**. Confirmed against OLD app `web-frontend/src/components/ShiftPreferenceEditor.tsx` (edits `{shiftTypeId,weight}[]`, weight 0 removes) + spec 04 FR-SR-11.
2. **Option A — extend the paint gesture to set-per-cell** (the one foundation seam). Widen staging key `person×date` → `person×date×selector` (selector = `shiftType` | `DAY_STATE` sentinel). Not a rewrite; M2a-1-style tested store change.
3. **Additive paint** — painting a target-set adds/updates only those shift types (weight 0 removes); day-state replaces the set (XOR); no target selected = erase coordinate. Still **exactly one `setReqData`/gesture** → one zundo entry → one persist revision.
4. Two modes (prototype-pinned): **Edit cells** (click → per-cell modal) / **Quick paint** (preset chips + weight, drag).
5. History columns author `person.history` (newest-first), NOT `reqData`. Layout FR-SR-04..07.
6. **`qq0.23` folded in** — non-blocking uncredited-leave warning + one-click "Add LEAVE @ coeff 16"; detector over C3-expanded selectors of a MARKED contracted-hours count; unresolved selector → suppress.
7. **One ticket** (user chose — no sub-split). Delta compaction (FR-SR-24) stays T05's concern.

**Load-bearing mechanism (do NOT re-invent):** set-per-cell additive paint — stage deltas keyed by person×date×selector during drag (hot store), reconcile at commit (day-state XOR request-set; additive request deltas; weight 0 removes; no-target erases), single `setReqData`. Mermaid diagram is in the artifact.

**Key existing code T11 builds on / changes:**
- `web/lib/store/paint.ts` — `commitPaintGesture(scenario, hot)` (currently collapses by `paintCellKey(person,date)` → SINGLE value; **THIS is what the rework extends**).
- `web/lib/store/hot-store.ts` — `beginPaint`/`stagePaintCell`/`cancelPaint`, `paint: Map<PaintCellKey, StagedPaintCell>|null`.
- `web/lib/store/types.ts` — `PaintCellKey = JSON.stringify([person,date])` (~84), `StagedPaintCell = UiRequestCell|null` (~77). **These widen.**
- `web/lib/scenario/types.ts` ~555–582 — `UiRequestCell = UiLeaveRequestCell | UiOffRequestCell | UiShiftRequestCell` (kind-tagged), `reqData: UiRequestCell[]` (~607). `person.history: ShiftType[]`.
- `web/lib/scenario/canonical.ts` ~231 — reqData→shift-request projection (leave→LEAVE/LEAVE_PIN_WEIGHT, off→OFF/weight, request→shiftType/weight); `isDayStateSelector` guard.
- `web/app/(app)/shift-requests/page.tsx` — currently a `PlaceholderScreen` stub (build the matrix here).
- Prototype: `docs/design_prototype/ScreenRequests.dc.html` (STEP 5 · Requests & Leave; two-mode toolbar, quick-paint panel, legend, matrix, "Current shift requests" table FR-SR-39).
- Spec: `.traycer/.../nurse-scheduling-functional-spec/04-shift-requests-editor/index.md` (FR-SR-01..39). OLD app source of truth: `/home/kenan/work/nurse-scheduling/web-frontend/src/app/shift-requests/page.tsx`.

---

## Standing directives / user preferences (ALL in `bd remember`, 18 memories)

Run `bd prime` next session — it dumps these. Critical ones:

- **`t17-implementer-harness`** — 3-TIER implementer routing (applies to traycer-execute generally): SIMPLE → MiniMax‑M3 on opencode harness, provider **`minimax-cn-coding-plan:MiniMax-M3`**, reasoningEffort `thinking` (the minimaxi.com token plan; prefixes `minimax-coding-plan` and `minimax` FAIL "invalid api key"/wrong endpoint). NORMAL/medium → **Sonnet 5**. COMPLEX/risky → **Opus @ medium effort** (launch as Traycer claude child agent to set effort; the in-process Agent tool can't set effort).
- **`t17-batched-cold-review`** — was T17-specific (batch cold review at end). For T11: default cadence unless user says otherwise.
- **`code-review-via-traycer-review`** — route ALL code reviews through a COLD/fresh agent (not inline self-review). Keep alignment/intent call inline; code-quality pass goes to a fresh agent.
- **`codex-review-effort-policy`** — codex cold reviews: NEVER max effort. Default MEDIUM (codex `gpt-5.6-terra`), escalate to HIGH if it struggles. codex/sol when complex.
- **`beads-commit-sync-workflow`** — do NOT manually `bd export`. The repo has beads git hooks (`core.hooksPath=.beads/hooks`; pre-commit runs `bd hooks run pre-commit`) that regenerate `issues.jsonl` on commit. Commit beads jsonl in the SAME commit via `git add -A` (path-scoped `git add web/` EXCLUDES .beads → forces separate chore commit). NO separate chore(beads) commits.
- **`design-prototype-reference`** — always refer to `docs/design_prototype/Screen*.dc.html` when building UI (prototype fidelity is first-class).
- **Artifacts are source of truth; beads mirror them.** Update bead status/close to mirror ticket-artifact status (0/1/2). Keep jsonl synced (via hook).
- **Commit policy:** conservative — commit only when user explicitly asks; branch stays `main` (matches M2a/T17 flow); push only when asked (separate step).
- **Playwright is part of the gate for UI milestones** — do NOT defer it (see T17 gap below).

---

## What we did this session (chronological, with specifics)

### T17 — Save/Load & YAML + anonymize (8 tickets, all committed in `e3ea49c`)
Broke down into 8 sub-tickets under `t17-save-load-yaml-anonymize/`, executed via parallel waves:
- **qq0.17.1** (MiniMax‑M3) `web/lib/scenario/app-version.ts` `currentAppVersion()` (reads `NEXT_PUBLIC_APP_VERSION`, tolerates unset→"unknown"); `serializeScenario` stamps it LAST via extracted `serializeCanonicalDocument`. TRAP AVOIDED: did NOT touch `toCanonicalScenarioDocument` (feeds dirty-fingerprint hash via `fingerprint.ts` → would cause spurious-dirty on app upgrade).
- **qq0.17.2** (Sonnet 5) `web/lib/scenario/prepare-export.ts` — `prepareExport`/`prepareAnonymizedExport` (validate-before-write; anonymised clones+scatters+toggle-filtered id-map+re-validates); extracted `serializeCanonicalDocument` shared core in `serialize.ts`.
- **qq0.17.3** (Opus) scatter in `web/lib/scenario/anonymize.ts` — `scatterShiftRequests(doc, rng)` + `getMissingPreferredScatterDateGroups`; FR-SL-37/38 + V16–V20, injected RNG, no-mutation-on-error.
- **qq0.17.6** (Opus) `web/lib/scenario/prepare-scenario-load.ts` — `projectImportTarget` (pure, deterministic, NO crypto.randomUUID; generalized canonical projection via new `projectScenarioDocument(ProjectableScenario)`, `toCanonicalScenarioDocument` kept as thin delegating wrapper), `prepareScenarioLoad`, `classifyImportVersion`.
- **qq0.17.4** (Sonnet 5) Save screen `app/(app)/save-and-load/page.tsx` + `components/save-load/` (scenario-file-card, scenario-yaml-preview, scenario-file-export core, scenario-issues-list). Download calls `markSaved`; Copy/anonymised-download do NOT (type-level guarantee).
- **qq0.17.5** (Sonnet 5) anonymise-card (3 toggles DL10 D2, no 4th, V20 warning).
- **qq0.17.7** (Sonnet 5) load-controls + upload-modal + version-confirm-modal + import-warnings-banner + load-controls-core. Fixed vitest jsdom infra (per-file `// @vitest-environment jsdom` docblock + `vitest.setup.ts` + testing-library devDeps).
- **qq0.17.8** (Sonnet 5) Edit-YAML mode; extracted `use-scenario-import.ts` hook; **found+fixed a latent zustand-v5 infinite-render bug** (`useScenarioStore(pickScenario)` unmemoized → "Maximum update depth") — fixed with `useShallow` across all 4 save-load store consumers + render smoke tests.
- **Cold review** (codex `gpt-5.6-terra` medium): FIX-FIRST, 3 majors + 1 minor → **qq0.17.9** fixed all: V20 warning surfaced, drag/drop extension validation, clipboard-fail no false "Copied!", verbatim FR-SL-19 strings.

### qq0.22 — dirty nav/unload warning (committed `edf2658`)
`web/components/shell/use-guarded-navigation.ts` — `navigate()` + `useDirtyBeforeUnload` now fire on `draftOpen || selectIsDirty(useScenarioStore.getState())` (was draft-only per qq0.21; T17 wired markSaved so dirty can clear). Updated `e2e/app-shell.spec.ts` to re-enabled behavior + dirty→nav→Save→nav-clean flow.

### T11 — planned (this session's final work)
Tech-plan drafted (above). User confirmed Option A + additive paint + qq0.23-in-scope + one ticket.

---

## What we TRIED / gotchas (expensive to rediscover)

- **MiniMax provider saga (COST 2 failed agent launches):** `opencode` harness MiniMax‑M3 provider prefix. FAILED with "invalid api key": `minimax-coding-plan:MiniMax-M3`, then `minimax:MiniMax-M3` (both route to minimax.io — WRONG endpoint). CORRECT: **`minimax-cn-coding-plan:MiniMax-M3`** (minimaxi.com token plan). Also: only MiniMax‑**M3** exposes `reasoningEffort: thinking` in opencode (M2 has no thinking param) — that's why M3 not M2.
- **T17 e2e GAP (my error):** I marked T17 "gate-green" running vitest + build but **NOT Playwright** — deferred it then never ran it; the cold review used vitest. T17's authored e2e specs were never executed. Running Playwright for qq0.22 surfaced **8 real T17-introduced failures**: (a) duplicate `persistence-badge` testid (T17 added a 2nd PersistenceBadge in YAML preview header alongside the T08 auto-save one → strict-mode) — fixed by scoping selectors to `auto-save-status` section; (b) 7 save-load spec crashes — `VALID_SCENARIO_PATCH.exportLayout` omitted `extraColumns`/`extraRows`, and `computeScenarioSummary` (sidebar, every page) reads `.length` on all three → tree crash → `__nsStore` wiped. Fixed by completing the fixtures. Committed in `f08b62a`. **LESSON: run full Playwright as part of the gate for UI milestones.**
- **Inline Playwright flakiness:** `playwright.config.ts` has `reuseExistingServer: !CI` + webServer `pnpm build && pnpm start`. Stale `next-server` on port :3000 from prior runs causes the suite to reuse a hung server → wholesale timeouts (untouched specs like `successions` fail). FIX: `pkill -f next-server` (do NOT kill `playwright_chromiumdev_profile` chrome — that's the user's browser). Delegating the full Playwright run to a fresh agent worked reliably (188/188). The `instrumentation.subprocess.test.ts` failure is a KNOWN pre-existing flake (bead `r0l`, hardcoded ports 34571/34572) — always exclude from gate assessment.
- **Edit/Write tool intermittent "No active Claude turn for tool permission"** hit several sub-agents mid-run; they fell back to Bash heredocs/python. Content was fine.
- **The render-loop bug is a codebase-wide pattern risk:** `useScenarioStore(pickScenario)` without `useShallow` loops under zustand v5. Grep confirmed all 4 save-load consumers fixed + no other occurrences. Watch for it in T11 (matrix reads scenario heavily).

---

## Execution loop that worked (repeat for T11)

1. Break down (if needed) → 2. Implement via tiered agent (MiniMax‑M3/Sonnet/Opus per difficulty) with PRECISE handoff (file:line anchors + traps) → 3. Inline alignment check (mine) → 4. Integrate shared files myself (barrel `web/lib/scenario/index.ts`, `page.tsx` mount — orchestrator owns shared files so parallel agents don't clobber; agents import icons directly from `react-icons/fa6`, NOT `icons.tsx`) → 5. Full gate (tsc + vitest + oxlint/oxfmt + build + **Playwright**) → 6. Cold review (fresh codex/terra medium) → batch-fix → 7. Commit `git add -A` (beads ride along) → 8. Close bead + mirror artifact status → 9. Push when asked.
- **Parallelize file-disjoint tickets** in waves; orchestrator owns shared-file integration. Give each agent explicit disjoint scope + "don't touch the barrel/icons.tsx/page.tsx" as needed.

---

## Gates (current baseline, all green on `main`)

- `pnpm exec tsc --noEmit` → 0 errors
- `pnpm exec vitest run` → **825 passed**, 17 skipped, 1 failed (`instrumentation.subprocess.test.ts` — known flake `r0l`)
- `pnpm exec oxlint app components lib e2e` → clean
- `pnpm exec oxfmt --check` → clean
- `pnpm build` → OK (`/save-and-load` prerenders static)
- `pnpm exec playwright test` → **188 passed / 0 failed** (kill stale `next-server` first)

Run gates from `web/`. Package manager is **pnpm**.

---

## Open questions / decisions deferred to execution

- T11 paint-staging exact key shape (person×date×shiftType vs a per-coordinate set object) — implementation-level, spec 04 governs.
- T11 group-row / date-group-column paint semantics (expand-to-members vs display-only) — spec 04 FR-SR-08/09, resolve during impl.
- T11 CSV format details — spec 04 §CSV.
- After T11: which milestone next (T16 Optimize&Export is the capstone/highest-risk; T14/T15 more self-contained). Earlier the user delegated ordering to me by dependency.

---

## Key file map (T17 shipped — for reference/regression context)

- `web/lib/scenario/`: `app-version.ts`, `serialize.ts` (`serializeCanonicalDocument`+`serializeScenario`), `canonical.ts` (`projectScenarioDocument`+`toCanonicalScenarioDocument` wrapper), `prepare-export.ts`, `prepare-scenario-load.ts`, `anonymize.ts` (+scatter), `index.ts` (barrel — orchestrator-owned).
- `web/components/save-load/`: scenario-file-card, scenario-yaml-preview, anonymise-card, load-controls(+core), upload-modal, version-confirm-modal, import-warnings-banner, use-scenario-import, scenario-issues-list, scenario-file-export, anonymise-export.
- `web/app/(app)/save-and-load/page.tsx` — the Save/Load screen.
- `web/components/shell/use-guarded-navigation.ts` — qq0.22 dirty guard.
- `web/e2e/`: save-load.spec.ts, save-load-edit-yaml.spec.ts, save-load-import.spec.ts, app-shell.spec.ts, app-shell-rebuild.spec.ts.
- Store: `web/lib/store/` — `scenario-store.ts` (`selectIsDirty`, `markSaved`, `mutateScenario`, `setReqData`), `hot-store.ts`, `paint.ts`, `fingerprint.ts` (`pickScenario`), `lifecycle.ts` (`loadScenario`, private `hydrateImportTarget`), `index.ts` barrel. Test bridge: `components/shell/test-bridge.tsx` exposes `window.__nsStore` (`.scenario`, `.isDirty()`, `.markSaved`).

---

## Traycer artifact locations

- Rebuild tech-plan (architecture spec): `.../artifacts/rebuild-tech-plan/index.md` (§3 BFF/SSE, §4 two-store+paint gesture, §5 TanStack, §6 gates).
- Tickets: `.../artifacts/rebuild-tech-plan/tickets/t01..t18/`. **T11 plan: `t11-shift-requests-matrix/index.md`** (drafted this session). T17: `t17-save-load-yaml-anonymize/` (+ `critique/` + `cold-review-2026-07-18/`).
- Functional spec: `.../artifacts/nurse-scheduling-functional-spec/` (spec 04 = shift requests; spec 08 = save/load; spec 12 = contracted hours; decision-logs/).
- Decision logs referenced: DL05, DL06 (backend binding), DL09 (half-hour), DL10 (design review), DL11 (versioning).

---

## T11 paint-store rework — concrete seam sketch (the load-bearing part)

Current (`web/lib/store/types.ts` + `paint.ts`):
```ts
// types.ts
export type PaintCellKey = string;                 // JSON.stringify([person, date])
export type StagedPaintCell = UiRequestCell | null; // null = erase; ONE value per coordinate
export function paintCellKey(person, date): PaintCellKey { return JSON.stringify([person, date]); }
// paint.ts commitPaintGesture: builds byCoordinate = Map(reqData keyed person×date), applies staged, setReqData([...values])
```
Rework target (Option A, additive set-per-cell):
- Staging key widens to include a **selector**: `person×date×(shiftType | DAY_STATE)`. A painted request-target stages `{kind:'request', shiftType, weight}` under that shiftType's key; a painted day-state stages `{kind:'leave'|'off',...}` under a `DAY_STATE` sentinel key AND marks the coordinate day-state (which must drop request prefs at commit); no-target paint marks the coordinate for erase.
- `commitPaintGesture` reconciliation per crossed coordinate: **INVARIANT day-state XOR request-set.** If a day-state was staged → coordinate becomes exactly that one leave/off cell. Else apply request deltas additively onto existing request cells at the coordinate (weight 0 removes that shiftType; other shiftTypes untouched). Erase → drop all cells at the coordinate.
- STILL exactly one `setReqData(nextReqData)` per gesture → one zundo entry → one persist revision. Keep `beginPaint`/`cancelPaint` and the Load/New `resetHotEphemeral` reset intact.
- Build as a PURE, tested lib extension FIRST (M2a-1 pattern), then the matrix UI consumes it. Existing `paint`/`commitPaintGesture` tests must be updated, not broken.

**Watch:** `reqData` can legitimately hold multiple `request` cells at one person×date (one per shiftType) — the canonical projection (`canonical.ts` ~231) already emits one shift-request preference per cell, so NO projection change is needed. Only the paint staging/commit changes.

## Spec 04 matrix details (FR-SR reference — grounds the UI)

- FR-SR-01/02: required-data gate — render matrix only if range+dates+people+≥1 shiftType; else one prioritized guidance msg (dates→people→shiftTypes) linking to that tab.
- FR-SR-03: rows = `[...peopleGroups, ...people]` (groups first). Person label `"{1-based index}. {id}"`; group label `{id}`; show description when present.
- FR-SR-04: columns = `[People sticky label][history H-n…][dateGroups…][dateItems…]` (date groups before individual dates).
- FR-SR-05/06/07: history column count = `max(person.history.length) + 1` (one spare to append); right-aligned per person (`offset = count - history.length`); `history[0]` = NEWEST (prepend on add); labels `H-{count - index}` (leftmost = highest H-number, rightmost `H-1` adjacent to dates).
- FR-SR-09: people-GROUP rows have NO history cells.
- FR-SR-10: weekend styling on individual date columns only; date groups never weekend-styled.
- FR-SR-11: a cell's preference set = all `reqData` with `person[0]===personId` + matching date. FR-SR-12: sorted by `[...shiftTypeItems, ...shiftTypeGroups]`. FR-SR-13: ≤3 shown else summarized. FR-SR-14: render `"{shiftType} ({label})"`. FR-SR-15: aggregate sign color. FR-SR-16: opacity α = `max(0.05, log2(maxWeight)/log2(1_000_000))`.
- FR-SR-39: derived read-only searchable "Current shift requests" table (Person·Date·Shift·Weight·Intent).
- Imported multi-`person`/multi-`shiftType` prefs: preserved with "advanced backend reference syntax" warning; matrix reads index 0 only (read-only display, NOT authored). Editor-created prefs are single-person/single-shiftType.

## qq0.23 detector spec (folded into T11)

- Non-blocking, frontend-primary warning (FR-CH-26/26a, AC-CH-21, DL05 addendum, DL09 D11).
- Fires ONLY when a **marked** contracted-hours count (`tag: contracted_hours`) covers a person who has a LEAVE pin on a covered date, but the count's coefficient coverage OMITS `LEAVE`.
- Detector runs over **C3-expanded selectors** (uses the shared `validateContractedHoursContract` / expand helper from qq0.12.5, `web/lib/scenario/schemas/contracted-hours.ts`).
- Unresolved selector → SUPPRESS (no false positive).
- UI: banner naming affected people + one-click "Add LEAVE @ coeff 16" (16 half-hours = the default paid-leave credit, DL09).
- T17 already ships the IMPORT-path warn-fence for this (import of a marked contract omitting LEAVE while covering a leave-pinned person); qq0.23 is the real editor-time guard, now buildable because T11 makes the LEAVE pin authorable.

## T17 commit contents (pushed to origin/main)

- `e3ea49c` feat(web): Save/Load & YAML + anonymize (T17, qq0.17.1-.9) — all 8 tickets + cold-review fixes + render-loop fix (one commit; files intermingled so per-ticket split wasn't clean).
- `4d70c67` chore(beads): sync T17 breakdown + closures (this was BEFORE learning the git add -A workflow; future = same-commit).
- `f08b62a` test(web): green the never-run T17 Save/Load e2e specs (fixture completeness + badge-scope).
- `edf2658` feat(web): re-enable whole-scenario dirty nav/unload warning (qq0.22) — includes .beads via git add -A.

## Environment notes

- `NEXT_PUBLIC_APP_VERSION` unset in `pnpm dev` → `currentAppVersion()` returns "unknown" (by design; T01 Docker build wires it from root `VERSION`=0.1.0 via `APP_VERSION` arg). `playwright.config.ts` pins it to "0.1.0".
- Additional working dirs: `/home/kenan/work/nurse-scheduling` (the OLD/original app — source of truth for parity; `web-frontend/src/` has old React components, `core/` old backend), `/home/kenan/.traycer`.
- Model in use this session: Opus 4.8 (1M context). Skills: Traycer Epic Mode (traycer-tech-plan, traycer-ticket-breakdown, traycer-execute, traycer-artifact-critique, traycer-review, traycer-changeset-walkthrough) + superpowers.
