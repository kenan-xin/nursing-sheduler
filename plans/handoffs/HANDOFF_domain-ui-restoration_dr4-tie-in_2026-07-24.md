# Domain-UI restoration (People→Staff, Shift Types→Shifts) — DR-1→DR-4 shipped to main; DR-4 needs review sign-off + e2e before close

**Date:** 2026-07-24
**Status:** IN PROGRESS — DR-1/DR-H/NAV-1/DR-2/DR-3 done & closed; **DR-4 code committed & unit-green but NOT reviewed and NOT e2e-validated for the staffing flow**
**Bead(s):** `nursing-sheduler-bmw.4.4` (DR-4, IN_PROGRESS — the open item); `nursing-sheduler-4s8` (new P3 chore, open); parent epic bead `nursing-sheduler-bmw`
**Epic:** Traycer epic `8b2235d5-8943-4f6d-a61e-3b671836217a` — artifact track `app-prototype-fidelity-audit` ("Post-parity: App↔prototype fidelity polish")
**Chain:** `domain-ui-restoration` seq `1`
**Parent:** `none — first in chain`
**Prior chain:** none — first in chain

## Related Handoffs

Separate work streams on the SAME repo/epic — reference only, NOT chain parents:
- `plans/handoffs/HANDOFF_web-code-review_frontend-fixes_2026-07-24.md` — web frontend code-review epic (5 P0/P1 + 8 P2 fixes). Predecessor session; this domain-UI work builds on that committed base.
- `plans/handoffs/HANDOFF_parity-rebuild_t11-shift-requests_2026-07-18.md` — the earlier parity rebuild (T11 shift-requests matrix).

## Reference Documents

- `CLAUDE.md` — project conventions; **beads (`bd`) for ALL task tracking** (no TodoWrite/markdown TODOs); conservative git profile (no commit/push without explicit user auth).
- **Traycer artifacts** live OUTSIDE git at `/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/app-prototype-fidelity-audit/` — they sync via Traycer, not the git push. Key ones:
  - `plans/domain-ui-restoration/index.md` — the governing tech plan (9/10 after 4 cold passes; the DR-4 write-path invariants live here).
  - `tickets/dr-1..dr-5`, `dr-h-requirement-helpers`, `nav-label-override` — implementation tickets.
  - `reviews/dr-2-dr-3-execution-review/index.md` — DR-2/DR-3 sign-off (both "Well Implemented").
  - `decisions/path-to-feasibility-two-tier/index.md`, `decisions/nav-labels-and-domain-ui/index.md`.
  - `flows/rule-conflict-validation/index.md` + `verified-conflict-catalogue/index.md` (27 classes) + `behavioral-matrix/index.md`.
  - `plans/tier1-conflict-detector/index.md` — critiqued **NOT ready** (see Open Questions).
  - `briefs/ai-infeasibility-diagnostician/index.md` — Tier-2 placeholder (brief LATER).

> ⚠️ **Path discrepancy:** bead descriptions and some artifacts reference macOS paths (`/Users/kenan.xin/…`) because the prior session ran on a Mac. **This machine is Linux — real paths are `/home/kenan/…`.** Translate when following any embedded path.

## The Goal

Restore full prototype fidelity for the two domain-entity screens of the nurse-scheduling web app (`web/`, Next.js 16 + React 19 + Zustand): replace the generic 1521-line `EntityEditor` monolith with **bespoke screens** for People (now "Staff") and Shift Types (now "Shifts"), each sharing a pure data core rather than a configurable engine. Alongside, the session planned two adjacent initiatives — a **two-tier path-to-feasibility** (Tier-1 deterministic conflict detection, Tier-2 optional AI diagnostician) and made all **AI features opt-in / BYO-key / client-side-direct**. The north-star, stated repeatedly by the user: *make the app as user-friendly as possible with a low learning curve while staying maximally flexible.* End state: DR-1→DR-5 land the bespoke screens; the conflict-detector and AI diagnostician follow as separate tracks.

## Where We Are

- **Everything is committed and pushed to `main`.** HEAD = `2a51819` "feat(web): domain-UI restoration (People/Shift Types) + nav terminology + shift-card tooltips" — 56 files, +6351/−1735. Working tree is **clean**. `feat/domain-ui-restoration` branch also on remote (redundant, safe to delete).
- Pre-push gate was green: **typecheck clean, full vitest 2464 passed / 0 failed**. (Earlier mid-session: full vitest 2439, full e2e 271 all green.)
- **DR-1 (GroupsSection)** — extracted `web/components/entity-editor/groups-section.tsx` (+ test). Consumed by both bespoke screens via config props (Staff vs Shift). CLOSED (`bmw.4.1`-track).
- **DR-H (rule helpers foundation)** — `web/lib/rules/{expansion.ts, scope.ts, requirements.ts}`: `requirementsForShiftType`, `isAllScope`, `isAllDates`, `expandShiftTypeRefs`/`expandDateRefs`/`flattenShiftTypeRefs`. CLOSED (`bmw.4.6`).
- **NAV-1 (display-only nav label override)** — `nav-config.ts`/`home-guided.tsx`/`top-bar.tsx` + `web/lib/optimize/optimize-readiness.ts` linkLabel. Labels: People→**Staff**, Shift Types→**Shifts**, Shift Requests→**Requests & Leave**. Routes/data-keys/`data-*` testids UNCHANGED. CLOSED.
- **DR-2 (Staff table)** — `web/components/people/people-table.tsx` (bespoke `PeopleTable`) + `web/components/people/upload-dialog.tsx` (extracted from `entity-editor.tsx`, behavior-identical) + `people-table.test.tsx` (16 cases) + `e2e/people.spec.ts` (21 cases). `app/(app)/people/page.tsx` renders `<PeopleTable/>`. Reviewed "Well Implemented", CLOSED (`bmw.4.2`).
- **DR-3 (Shifts grid)** — `web/components/shift-types/shift-type-grid.tsx` (bespoke `ShiftTypeGrid`, presentation-only) + `shift-type-grid.test.tsx` + `e2e/shift-types.spec.ts` (6 cases). Reserved OFF/LEAVE render as locked AUTO cards. Reviewed "Well Implemented", CLOSED (`bmw.4.3`).
- **DR-4 (staffing-requirement tie-in)** — the load-bearing, risk-carrying ticket. Implemented by **codex (`gpt-5.6-sol`, high reasoning)** because the Anthropic session limit was hit. Landed: `web/components/shift-types/save-shift-card.ts` (`saveShiftTypeCard`, `resolveStaffingCardState`, stale/validation errors); `ShiftDraft` extended with `required`/`preferred`; the read card + edit form render the 3-state Min/Preferred region. **`bmw.4.4` is still IN_PROGRESS — not review-signed-off, not e2e-run since DR-4 landed.**
- **Terminology consistency pass** — scope = **"screen names only"** (user's explicit choice). Fixed cross-screen references, self-titles (`requests-editor` `<h1>Shift Requests</h1>`→"Requests & Leave"; affinities-editor→"Affinities"), Home stat card ("Shift Types"→"Shifts"), + 2 e2e assertions. Domain **nouns** ("shift type", "people") and spec-verbatim validation messages LEFT INTACT.
- **Tooltips + design fidelity** (implemented by me directly, after codex failed to receive its prompt twice) — new `web/components/ui/info-tip.tsx` (accessible ⓘ, hover + keyboard focus), 5 prototype tooltips (Name, Time on floor, Rest, Min. nurses, Preferred), working-time section relaid out (Time on floor / Rest groups), and the truncated `WORKING · AUTO` "= 8h − …" readout fixed (`working-time-fields.tsx:~156` `truncate` class). 143 unit tests green after.
- **Numeric-code validation** (DR-4 refinement) — a new/changed numbers-only shift code (e.g. `1`, `07`) is now **forbidden** with an inline error ("Shift codes need at least one letter (like AM or N2)…"). Existing numeric-coded shifts stay editable. New test covers block + recovery.
- **Read-only staffing copy rewrite** — now states *what sets it* / *why locked (plain, no solver jargon)* / *how to change it* (edit the group rule, or detach the shift). Applies to both card + edit form via `save-shift-card.ts`.
- **Infra:** `.mise.toml` (node `24.14.0`, python `3.12.13`), `.python-version` (3.12.13), `docker/validate_origin.py` Python-3.10+ guard, `web/lib/query/optimize.test.tsx` Uint8Array-body fix, `.github/workflows/ci.yml` (jdx/mise-action; `checks` + `e2e` jobs). All in the commit.

## What We Tried (Chronological)

1. **Tech-plan the domain-UI restoration** (`/traycer-tech-plan`). Grounded via subagents: EntityEditor is a 1521-line monolith with a pure-data descriptor (no render seams); only People + Shift Types use it; Dates already forked. Locked (AskUserQuestion): bespoke screens sharing the core (NOT a configurable engine); full inline edit of the requirement tie-in. → `plans/domain-ui-restoration/index.md`.
2. **Multiple critique rounds** (Claude + codex `gpt-5.6-sol` at high/xhigh). Each found real P1s: destructive update path, stale-write guard, `isAllScope` predicate bug (`["ALL"] !== "ALL"`), reserved OFF/LEAVE, rename cascade ordering, numeric IDs, group expansion. All folded into the plan across rounds.
3. **Solver-semantics correction** — I first told the user "stricter minimum binds", then re-verified `core/nurse_scheduling/preference_types.py:~185-193`: no-preferred requirements are **EXACT equality** (`actual == required`), group rules are **aggregate sum** → overlapping rules routinely make the model **INFEASIBLE**. This reversed the group-scoped decision to **read-only + link** (with a plain-language reason).
4. **Ticket breakdown** (`/traycer-ticket-breakdown`) → DR-1..DR-5 + DR-H + NAV-1. Reviewed via codex twice; added DR-H split.
5. **Rule-conflict-validation flow** (`/traycer-core-flows`) — 4 research agents + verifier + xhigh red-team (ran CP-SAT) → **27 verified zero-false-positive conflict classes**. Built the flow, catalogue, behavioral matrix. User directive: only keep guaranteed classes, drop anything that could false-positive and confuse users.
6. **AI features made optional** (`/traycer-revise-requirements`) — opt-in, single "AI features" toggle + at least one BYO LLM key (OpenRouter/Anthropic/OpenAI), **client-side direct** (keys local, calls bypass our backend). Propagated through decision/flows/brief. Use Vercel AI SDK + AI Elements (elements.ai-sdk.dev).
7. **Tier-1 conflict-detector tech-plan** (`/traycer-tech-plan`) — drafted `plans/tier1-conflict-detector/index.md`. Critique found the "committed-only re-evaluation" insight BREAKS on the Requests matrix quick-paint (commits per-gesture via `setReqData`). Flagged NOT ready for ticketing.
8. **Executed DR-1/DR-H/NAV-1** (3 parallel subagents) — all green. Consolidated gate passed after installing the Playwright chromium browser.
9. **Fixed 2 pre-existing test failures** — (a) `validate_origin.py` PEP-604 `str | None` crashed at import on Python 3.9.6 host; (b) `optimize.test.tsx` passed a jsdom Blob to undici Response (`.stream()` missing). User chose to **strictly require Python 3.10+** (drop the `from __future__` shim, add a runtime guard). Pinned 3.12.13 via mise; fixed the test with a `Uint8Array` body.
10. **Executed DR-2 + DR-3** — 2 parallel subagents, accidentally interrupted then resumed. Both landed. **Integration defect:** they raced on the shared `e2e/people-shift-types.spec.ts`; cases had already migrated to new `people.spec.ts`/`shift-types.spec.ts` and `shift-types/page.tsx` renders the new grid, so the leftover file tested the retired path — **deleted it** (no coverage lost).
11. **Terminology audit** (user-reported "there is no People tab" bug) — codex full audit + my grep/read cross-check. User chose **"screen names only"** scope. Applied; 2 e2e assertions moved with the copy.
12. **Playwright e2e run** — 269/271, then both failures fixed & verified: `app-shell.spec.ts:394` (DR-2 fallout — test drove retired `add-item-toggle`/`add-item-form`; repointed to `people-add`/`people-edit-row-__new__`), `rules.spec.ts:87` (pre-existing test-gesture bug — `AdjustPanel` commits on blur/Enter, `.fill()` never triggered it; added `.press("Enter")`). Filed bead `4s8` to document the convention.
13. **DR-4 dispatch** — Claude/Opus implementer hit the account-wide Anthropic session limit (reset 9:50pm SGT) after only reading files (tree verified clean). Re-dispatched to codex (OpenAI provider) with write access + full handoff. Codex landed the DR-4 logic.
14. **User feedback iterations on the card** — uppercase code display (codex folded in `uppercase` on read-card), missing Min/Preferred confusion (was leftover test data — reset fixed it), numeric-code validation (chose forbid + inline error), read-only "why + how" copy, missing tooltips + truncated WORKING readout. Tooltips/CSS implemented by me directly (codex wasn't receiving its background prompt).
15. **Commit + push** — user authorized "commit and push everything, merge into main". Feature branch → merged fast-forward into main → pushed (`0c72928..2a51819`). `bd dolt push` synced the beads DB.

## Key Decisions

- **Bespoke screens sharing a pure core**, not a presentation-configurable EntityEditor — the descriptor has no render seams; a configurable engine would be more complex than two focused screens.
- **read-only + link (with plain-language reason)** for staffing set by group/skill/date/multi-shift rules — because the solver treats no-preferred requirements as exact equality and group rules as aggregate, so authoring a per-shift number beside such a rule creates a silent contradiction → infeasible roster. Rejected: letting users edit anyway (would need to define what "edit from card" means for a group rule — deferred as a real design decision).
- **Terminology = "screen names only"** — rejected migrating body nouns and rejected rewriting spec-verbatim validation messages, because the rest of the app still uses those nouns and "shift type" is a genuine domain term (template vs instance). Codex's full noun-migration list is on record if wanted later.
- **Numeric-only shift codes forbidden** (inline error) — rejected "allow but warn" so the confusing numeric read-only staffing state never appears.
- **AI features optional / opt-in / BYO-key / client-side-direct** — Tier-1 static conflict validation is deterministic/no-key/always-on and NEVER depends on AI; Tier-2 AI diagnostician only exists when enabled. UI copy promising "the assistant will diagnose it" must be conditional on AI being on.
- **Python strictly 3.10+** (pinned 3.12.13 via mise) — rejected the `from __future__ import annotations` compatibility shim in favor of a hard guard.
- **DR-4 via codex** — rejected waiting for the Anthropic limit reset or re-dispatching another Claude agent (same account-wide limit); codex (different provider) is the established fallback pattern in this repo. Kept myself as independent reviewer since DR-4 is the highest-risk ticket.
- **Display-only nav label override** — routes, data keys, and `data-*` testids stay stable; only visible labels change, so no navigation/test churn.

## Evidence & Data

| Milestone | Bead | Status | Key gate |
|---|---|---|---|
| DR-1 GroupsSection | bmw.4.1-track | CLOSED | in commit |
| DR-H rule helpers | bmw.4.6 | CLOSED | in commit |
| NAV-1 nav labels | — | CLOSED | in commit |
| DR-2 Staff table | bmw.4.2 | CLOSED | reviewed "Well Implemented" |
| DR-3 Shifts grid | bmw.4.3 | CLOSED | reviewed "Well Implemented" |
| **DR-4 staffing tie-in** | **bmw.4.4** | **IN_PROGRESS** | **unit-green, NOT reviewed/e2e'd** |
| AdjustPanel e2e convention | 4s8 | OPEN (P3 chore) | preventive doc |

| Verification | Result |
|---|---|
| Pre-push full vitest | **2464 passed / 0 failed** |
| Mid-session full vitest | 2439 passed, 76 skipped, 0 failed |
| Full e2e (Playwright) | 271 green (269 + 2 fixed) |
| DR-4 shift-types unit | 34 passed (incl. new numeric-code test) |
| Tooltip/CSS pass unit | 143 passed (shift-types + entity-editor) |
| Terminology pass unit | 469 passed |
| Verified conflict classes | 27 (zero false positives, CP-SAT-checked) |

- **Commit:** `2a51819` on `main`, pushed `0c72928..2a51819`, 56 files, +6351/−1735.
- **Remote:** `git@github.com:kenan-xin/nursing-sheduler.git`.
- `entity-editor.tsx` shrank ~573 lines (GroupsSection + UploadDialog both extracted) — sliding toward DR-5 retirement.
- e2e: `people.spec.ts` = 21 tests; `shift-types.spec.ts` = 6; `people-shift-types.spec.ts` **deleted** (stale race duplicate).

**Beads snapshot (this machine, `bd stats`):** 251 total — 38 open, 5 in-progress, 10 blocked, 206 closed, 28 ready to work.

| In-progress bead | P | Note |
|---|---|---|
| `nursing-sheduler-bmw` | P2 | parent epic: Post-parity fidelity polish |
| `nursing-sheduler-bmw.1` | P2 | Fidelity Batch 1 (cheap wins) — still open |
| `nursing-sheduler-bmw.4.4` | P2 | **DR-4 — the active thread** |
| `nursing-sheduler-qq0.27.4` | P2 | T19 hygiene: restore Python format gate |
| `nursing-sheduler-76u` | P3 | functional-spec minor-drift accuracy |

DR-4 dependency chain (from `bd show bmw.4.4`): depends on ✓`bmw.4.6` (DR-H) + ✓`bmw.4.3` (DR-3); blocks ○`bmw.4.5` (DR-5 retire EntityEditor).

## Code Analysis

- **`saveShiftTypeCard` (`web/components/shift-types/save-shift-card.ts`)** — atomic `mutateScenario(updater)` on LIVE state (one undo entry). Order is load-bearing: reject reserved (`isDayStateSelector`) → numeric-id gate → **rename FIRST** then resolve baseline + patch using the **post-rename id** → identity-token stale guard that **ABORTS** (not rebases) → update starts from `requirementToForm(existing)` overriding only `requiredNumPeople`/`preferredNumPeople`; create starts from `emptyRequirementForm()` + `shiftType:[id]`, `qualifiedPeople:["ALL"]`, `date:["ALL"]`, `weight:-50` → `validateRequirementForm` → `buildRequirementCard` → commit in same updater.
- **`resolveStaffingCardState`** — returns `editable` iff no requirement OR a DIRECT-SIMPLE, `isAllScope(qualifiedPeople)` && `isAllDates(date)`, non-disabled baseline exists; otherwise read-only + reason + link; nothing for reserved/numeric.
- **`requirementsForShiftType(state, id): RequirementMatch[]`** (`web/lib/rules/requirements.ts`) — active reqs covering a shift, group-EXPANDED, classified DIRECT-SIMPLE | GROUP-DERIVED | MULTI-TARGET, with `index` + `coveredShiftTypes`.
- **`isAllScope(ref)`** (`scope.ts`) — handles absent/null/`"ALL"`/`["ALL"]`/`["ALL",x]`, case-folded; `[]` is NOT all-scope.
- **`AdjustPanel`** (`web/components/guided-rules/rule-row.tsx`) — commits a quick-field edit only on blur/Enter (`onChange` updates a local draft) so an adjust is a single zundo entry. Playwright `.fill()` alone won't persist (see bead `4s8`).
- **EDGE-PR-03** — when preferred stops exceeding required, `buildRequirementCard` drops preferred + forces `weight:-1`; this is an INTENDED invariant (fires identically on the Requirements screen) — must be shown, not hidden.
- **Solver contract** (`core/nurse_scheduling/preference_types.py:~185-193`) — no-preferred requirement = exact equality; group rule = aggregate; overlaps → INFEASIBLE.
- **`UploadDialog`** (`web/components/people/upload-dialog.tsx`) — extracted behavior-identical from entity-editor: same `reorderByUpload` core op, 1000-row cap, `#`-comment-line skip, reserved/duplicate/group-collision rejection, identical-upload no-op. Kept generic over `<TItem>` so `EntityEditor` (still used transitionally) compiles unchanged; testids `upload-dialog`/`upload-file-input` preserved.
- **`GroupsSection` config props** — Staff: `{ showMemberSearch: true, pane "MEMBERS", count "N members", heading "Staff groups" }`; Shift: `{ showMemberSearch: false, selectedPaneLabel "IN GROUP", selectedTestKey "in-group", formatCount "N TYPES", heading "Shift groups" }`. Neither consumer had to modify the component (no gaps found).
- **DR-3 → DR-4 seams** (in `shift-type-grid.tsx`) — the edit draft is a single `ShiftDraft` object; the commit is isolated in `commitShiftDraft()` (marked "DR-4 SEAM"); both the read card and edit form carry explicit `{/* DR-4: staffing region */}` slots (before actions / before Save). Stale-guard + one-commit/one-undo mirror EntityEditor exactly.
- **Drag reorder** — identity carried via React state (not `DataTransfer`) so native drag survives Playwright synthetic events; drag + Up/Down both gated by `!query && !editing`. Up/Down buttons remain the keyboard fallback.
- **`name → UiPerson.id` + description preservation** (PeopleTable) — inline Nurse-cell input maps to `UiPerson.id`; on Save the rename cascade runs only when the name actually changed, and `description`/`history`/typed identity are never overwritten from the table.

## Prototype / Design Source

The bespoke card is measured against `docs/design_prototype/ScreenShifts.dc.html`. Exact tooltip copy folded into `InfoTip` (Code and Working have NO tooltip, matching the prototype):
- **Name** — "The code rules, groups and the roster refer to. Renaming it here updates every reference automatically."
- **Time on floor** — clock-times / half-hour / rest explanation.
- **Rest** — unpaid-break; "Working = clock span − rest" explanation.
- **Min. nurses** — "sets the shift's staffing requirement over all dates… editing here updates that one rule."
- **Preferred** — soft-target-above-minimum explanation.

The design-fidelity gap that remains partially open: the card was NOT originally built tightly against this prototype (missing tooltips + truncated WORKING readout were both symptoms). DR-4 review should include a fidelity check.

## The 3-State Min/Preferred Staffing Machine (DR-4 — review against this)

The staffing region resolves on **"does an EDITABLE baseline exist?"**, NOT on rule count. The three states:

1. **No controls** — reserved OFF/LEAVE (AUTO lock, never a raw disabled control) or a numeric-only shift id. Numeric id shows "Give this shift a text code to set staffing here" (staffing selectors are string-only).
2. **EDITABLE** (Min/Preferred inputs) — iff a DIRECT-SIMPLE, `isAllScope(qualifiedPeople)` && `isAllDates(date)`, non-disabled baseline exists, OR no coverage at all (first Min typed creates the baseline for all nurses on every date). Disabled baseline ⇒ treat as no coverage; duplicate baselines ⇒ edit first in array order.
3. **READ-ONLY + reason + `GuardedLink` to `/shift-type-requirements`** — iff no editable baseline AND covered only by group/qualified/date-scoped/multi-target rules. Alongside an editable baseline, other rules render as read-only context chips (`<group> only`, `+N date variants`) + deep-link. Copy now states what sets it, why it's locked (plain, no solver jargon), and how to unlock (edit the group rule, or detach the shift from the group).

Policies: render `—` for "no requirement" (distinct from a real `0`); no delete affordance on the card; on-card error surface for validation / rename-collision; EDGE-PR-03 collapse is made visible (not hidden).

## Codex Fallback Pattern (for the next session)

When the Anthropic account-wide session limit hits, the established fallback in this repo is direct `codex exec` (OpenAI provider): `codex exec --model gpt-5.6-sol --sandbox workspace-write --skip-git-repo-check -c model_reasoning_effort="high"`. Caveats seen this session: the Traycer child-agent path was blocked ("sender not local to host"); the codex *rescue-wrapper* silently drops detached jobs (use direct `codex exec`); and a couple of background `codex exec` runs never received their `"$(cat)"` prompt (exited reading stdin) — verify the run actually started before relying on it. For anything the model is actively editing, do NOT edit the same file concurrently (DR-4 and the uppercase fix collided on `shift-type-grid.tsx` this way).

## Files Changed

All under commit `2a51819`. Grouped:

### Source — bespoke screens
- `web/components/people/people-table.tsx` — bespoke Staff table (new)
- `web/components/people/upload-dialog.tsx` — UploadDialog extracted from entity-editor (new)
- `web/components/shift-types/shift-type-grid.tsx` — bespoke Shifts card-grid + DR-4 staffing region (new)
- `web/components/shift-types/save-shift-card.ts` — DR-4 atomic controller + state resolver (new)
- `web/components/entity-editor/groups-section.tsx` — DR-1 shared groups (new)
- `web/components/entity-editor/entity-editor.tsx` — shrank ~573 lines (extractions)
- `web/components/shift-types/shift-types-descriptor.ts` — labels → Shift/Shifts
- `web/components/people/people-descriptor.ts` — **still "People"** (deliberate; no longer user-facing; DR-5 territory)
- `web/lib/rules/{expansion.ts, scope.ts, requirements.ts}` — DR-H helpers (new)
- `web/components/ui/info-tip.tsx` — accessible tooltip (new)
- `web/components/shell/working-time-fields.tsx` — relayout + truncation fix (~line 156)
- `web/components/nav/nav-config.ts`, `home-guided.tsx`, `top-bar.tsx` — NAV-1 labels
- `web/lib/optimize/optimize-readiness.ts` — NAV-1 linkLabel amend
- rule-editor forms (affinities-editor, requests-editor, successions/coverings/counts) — terminology screen-name fixes

### Tests
- `web/components/people/people-table.test.tsx`, `web/components/shift-types/shift-type-grid.test.tsx`, `web/components/shift-types/save-shift-card.test.ts`
- `web/e2e/people.spec.ts` (new 21), `web/e2e/shift-types.spec.ts` (new 6 + staffing), `web/e2e/people-shift-types.spec.ts` **deleted**
- `web/e2e/app-shell.spec.ts` (T08h repointed), `web/e2e/rules.spec.ts` (Enter gesture), `web/e2e/requirements.spec.ts` + `web/e2e/shift-requests.spec.ts` (assertion updates)
- `web/lib/query/optimize.test.tsx` — Uint8Array body fix

### Config / infra
- `.mise.toml` (node 24.14.0, python 3.12.13), `.python-version` (3.12.13)
- `docker/validate_origin.py` — Python 3.10+ runtime guard
- `.github/workflows/ci.yml` — mise-action; `checks` + `e2e` jobs
- `.beads/*.jsonl` — beads export (bmw.4.2/4.3 closed, 4.4 in-progress, new 4s8)

## User Feedback & Preferences (VOICE)

- **North star (repeated):** "make it as user friendly as possible with low learning curve while still being maximum flexible."
- "**read-only + link, but from user perspective, they must know why it is read-only**" — drove the plain-language reason on locked staffing.
- "AI features should be made optional… settings for user to add their own LLM api key for openrouter, anthropic, openai etc and a toggle."
- "use the AI SDK for AI features if relevant and https://elements.ai-sdk.dev/ for chat UIs."
- "**we will only keep guaranteed ones, removing those that have risk of false positives that can confuse user**" (conflict classes).
- "please explain to me clearly what is the issue first in an easy-to-understand way before I can make a decision" — user wants plain-English explanations before decisions (used AskUserQuestion repeatedly).
- "the code should be displayed as capital letter" → uppercase read-card code (display-only).
- "if numeric only code is not allowed, there should be validation in frontend… please add it" → chose **forbid + inline error**.
- "when it is covered by a group rule… how can we let user know the reason this is not editable and let them know how to make it editable again" → the what/why/how copy rewrite.
- "we are also missing the tooltips" → InfoTip + 5 prototype tooltips.
- Terminology cleanup scope choice: **"Screen names only (done)"**.
- "**commit and push everything, we will continue in another machine**" then "**[merge] everything merged into main**" → authorized the git operations (otherwise conservative git).

## Where We're Going

1. **DR-4 sign-off (`bmw.4.4`) — the single open thread.** Review the DR-4 changeset (codex-authored, highest-risk) through product + technical lenses against the plan's write-path invariants + test matrix; run the **consolidated gate incl. Playwright e2e for the new staffing flow** (hasn't run since DR-4 landed) under mise Python 3.12; then flip the ticket to done + `bd close bmw.4.4`. Consider `/traycer-review`.
2. **Minor polish:** tooltip bubble is left-anchored — may reach the card edge on the right-column Preferred field. Refine anchoring if it clips.
3. **DR-5** (`bmw.4.5`) — retire `entity-editor.tsx` (now thin after GroupsSection + UploadDialog extractions) and flip the `people-descriptor` label. Unblocked once DR-4 closes.
4. **Tier-1 conflict-detector** — revise `plans/tier1-conflict-detector/index.md` against its critique (committed-only re-evaluation breaks on quick-paint) BEFORE ticketing.
5. **AI infeasibility-diagnostician (Tier-2)** — brief later via `/traycer-epic-brief` (placeholder exists).

## Risks & Blockers

- **DR-4 is committed but unverified beyond unit tests** — no independent review, no e2e for the staffing flow since it landed, and it was written autonomously by codex on the epic's highest-risk ticket (solver-exactness semantics). Treat as unproven until reviewed.
- **Python:** the full vitest suite + `validate_origin.py` require Python 3.10+ — **use mise's 3.12.13** (`mise install`); a bare `python3` on an old host crashes.
- **Traycer artifacts are outside git** — they sync via Traycer, not the push; if they're missing on this machine, they need Traycer sync.
- **Path discrepancy** — beads/artifacts embed macOS `/Users/kenan.xin/…` paths; this machine is `/home/kenan/…`.
- **Environment churn:** the prior session had woz MCP tools drop in/out and hit an Anthropic account-wide session limit; codex was the fallback. Watch for the same.

## Open Questions

- Tier-1 conflict-detector: how to re-evaluate given the Requests matrix commits per quick-paint gesture (the "committed-only" trigger design is invalidated) — needs a revised trigger model before ticketing.
- Whether to eventually expand card-level staffing editing into group/skill/date-scoped cases (a real infeasibility-tradeoff design decision the user paused on).

## Quick Start for Next Session

```bash
# Restore context
bd show nursing-sheduler-bmw.4.4      # the open DR-4 ticket
bd show nursing-sheduler-4s8          # AdjustPanel e2e convention (P3)
bd ready                              # available work

# Reference docs (Traycer artifacts — Linux paths)
# /home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/app-prototype-fidelity-audit/
#   plans/domain-ui-restoration/index.md          <- DR-4 write-path invariants
#   tickets/dr-4-requirement-tie-in/index.md      <- DR-4 acceptance + test matrix

# Key files to read first (DR-4 review)
# web/components/shift-types/save-shift-card.ts          (atomic controller + resolveStaffingCardState)
# web/components/shift-types/shift-type-grid.tsx         (staffing region UI)
# web/lib/rules/requirements.ts                          (requirementsForShiftType classification)
# web/components/shift-types/save-shift-card.test.ts     (controller coverage)

# Verify current state (use mise Python 3.12 on PATH)
mise install
cd web && pnpm install
pnpm -C web typecheck && pnpm -C web exec vitest run
# then the e2e the staffing flow still needs:
pnpm -C web exec playwright test shift-types.spec.ts

# Next action
# Review DR-4 (bmw.4.4) product + technical lenses + run e2e for the staffing flow,
# then close the bead. It is the ONLY open thread in the domain-UI track.
```

## Session Closed
**Closed at:** 2026-07-24
**Commit:** the `session: domain-ui-restoration handoff` commit on `main` (handoff + beads sync; **not pushed** — run `git push` to sync)
**Session status:** Handed off to next session
