# Tier-1 feasibility checks + AI assistant: full planning stack (brief → flows → tech plan → 9 tickets), 2 adversarial critique rounds each

**Date:** 2026-07-28
**Status:** IN PROGRESS — planning complete for both initiatives; zero implementation started
**Bead(s):** `nursing-sheduler-s30` (primary), `t34`, `3d4`, `cqr`, `l0o`, `l3m`, `qbc` (closed), `7zc` (closed)
**Epic:** Post-parity roadmap — roster viewer (`cjr`) → AI assistant (`t34`); Tier-1 (`s30`) parallel
**Chain:** `domain-ui-restoration` seq `2`
**Parent:** `HANDOFF_domain-ui-restoration_dr4-tie-in_2026-07-24.md`
**Prior chain:** `HANDOFF_domain-ui-restoration_dr4-tie-in_2026-07-24.md` > this

> **Chain-tag caveat.** The tag is inherited from the parent, whose primary work was domain-UI
> restoration (DR-1–DR-5, now complete). This session worked *only* the parent's parked side-threads
> — next-steps 4 (Tier-1) and 5 (Tier-2 AI brief). Different beads entirely. If the next session
> prefers, re-tag to `nursing-sheduler-s30, nursing-sheduler-t34` and treat this as seq 1 of a new
> chain. Nothing depends on the tag except handoff discovery.

---

## Stale References

Identifiers from the parent handoff not found in this checkout:

- `plans/tier1-conflict-detector/index.md` — **NOT FOUND.** Parent says it was drafted and
  "critiqued **NOT ready**". See Blockers — this is the single most important stale ref.
- `web/components/entity-editor/entity-editor.tsx` — retired by DR-5 (commit `5eea189`), expected.
- **"27 verified conflict classes"** — now **28**. `G7` was admitted this session (bead `qbc`).
  Any artifact or bead still saying 27 is stale.
- Parent's Linux paths (`/home/kenan/…`) — this machine is macOS (`/Users/kenan.xin/…`). The parent
  flagged the mirror-image problem; it has flipped back.

## Since Last Handoff

- Parent's next-steps **1–3 (DR-4 sign-off, tooltip polish, DR-5)** were completed in an intervening
  session — `5eea189 refactor(entity-editor): retire the generic EntityEditor shell (DR-5)` is in the
  log. This session did not touch them.
- Parent's next-step **4 (Tier-1 conflict-detector)** — done, but **not as planned**. The parent said
  "revise `plans/tier1-conflict-detector/index.md` against its critique BEFORE ticketing." That file
  is absent from this machine, so a **new** tech plan was written from scratch in Traycer artifacts.
  The prior critique's finding was never incorporated. See Blockers.
- Parent's next-step **5 (Tier-2 AI brief)** — substantially exceeded. Instead of a placeholder brief,
  the session produced a full initiative: index, decision log (30 decisions), and five core flows.
- **Trajectory shift:** the parent treated Tier-1 and AI as two parked items. This session split them
  into genuinely independent initiatives — Tier-1 (`s30`) has *no* dependencies and ships in parallel;
  the AI assistant (`t34`) stays sequenced behind the roster viewer (`cjr`).
- **A risk the parent flagged materialised:** "Environment churn: woz MCP tools drop in/out." They
  dropped twice this session (one auth failure requiring `/woz login`, one server disconnect).

## Reference Documents

- `CLAUDE.md` — project conventions, beads workflow, **Design Context** section (DESIGN.md is canon
  ahead of code; `web/` still runs the retired v1 system).
- `DESIGN.md` / `PRODUCT.md` — design system, North Star "Mint Canvas, Warm Ink" (uncommitted).
- `docs/T19-upstream-backend-source-manifest.md` — vendored-backend drift policy. **Read before any
  `core/` change.**
- Traycer artifacts root: `/Users/kenan.xin/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/`

## The Goal

Two post-parity initiatives needed to move from "planned" to "buildable". **Tier-1 deterministic
feasibility checks** (`s30`) warn users about rule combinations that provably cannot produce a roster
— keyless, always-on, no backend, no AI. **The AI assistant** (`t34`) is an optional, off-by-default
conversational panel that can do anything the UI can do, plus diagnose an infeasible run (Tier-2).

The session's end state: both have complete planning stacks that survived adversarial critique, and
Tier-1 is broken into nine dependency-ordered implementation tickets. **No code was written except a
committed CP-SAT test harness.**

The governing constraint throughout: **zero false positives**. Tier-1's entire value is that a
warning is never wrong. One false alarm costs more trust than a narrow check can earn back.

## Where We Are

- **Branch `catalogue-oracle-harness`**, one commit ahead of main: `ef38955 test(core): add reusable
  CP-SAT oracle harness for the Tier-1 catalogue`. **Not pushed. No PR.**
- **Uncommitted v2 re-skin work is stranded on that branch** — `web/app/globals.css`,
  `theme-script.tsx`, `theme-store.ts`, `design-system/page.tsx`, `design-system.test.ts`,
  `e2e/design-system.spec.ts`, plus untracked `DESIGN.md`, `PRODUCT.md`, `.impeccable/`,
  `docs/design_explorations/`. Diffstat: **28 files, +3024/-695**. This belongs to epic `ii7`, not to
  the harness branch. **Untangle before doing anything else.**
- **Tier-1 (`s30`) planning is complete**: epic brief, tech plan (387 lines, revised twice), nine
  tickets. Bead is unblocked and ready.
- **AI assistant (`t34`) planning is complete**: initiative index, decision log (**D1–D30**), five core
  flows. Two critique rounds applied.
- **The catalogue grew 27 → 28.** `G7` (weighted attainable-max) was investigated, CP-SAT-verified
  across 22 scenarios, and admitted. Bead `qbc` closed.
- **Test state:** `core` suite **600 passed / 51 skipped** (46.4 s). New oracle tests **24 passed in
  0.49 s**. `ruff check` + `ruff format --check` clean on `core/tests/`.
- **`web` was never run this session.** No frontend code changed; no vitest/playwright run.
- **Beads created:** `s30` (Tier-1, P2), `qbc` (closed — G7 investigation), `7zc` (closed — optimize
  panel), `cqr` (oracle backfill, P3), `l0o` (expandDateRange consolidation, P3).
- **Beads rewritten:** `l3m` retitled from unsat-core to **keyless elastic/slack re-solve**; `t34`'s
  design note corrected (it wrongly required a backend contract); `3d4` given the run-slot decision.
- **Dependency wired:** `3d4` → `t34` → `cjr`. Previously `3d4` was unblocked while `t34` was blocked
  — the two AI beads disagreed about sequencing.
- **Traycer artifacts silently reverted mid-session**, losing several turns of edits. Root cause found
  (see Evidence). All content was recoverable from beads.
- **6 beads sit `in_progress` and untouched by this session**: `ii7.9`, `bmw`, `bmw.1`, `qq0.27.4`,
  `w0e.1`, `76u`. 312 issues total; 66 open, 30 blocked, 36 ready.

## What We Tried (Chronological)

### Chunk 1 — sequencing and the Tier-1 split (early)

1. **DL10-D3 sequencing question.** User asked whether the AI assistant lands before or after the
   roster viewer, arguing the viewer will need AI too. Investigated both initiatives' readiness:
   `cjr` had brief + core-flows + critique + tech plan + tickets + **8 child beads**; `t34` had
   **zero artifacts**. Recommended roster-first. **Result: DL10-D3 upheld**, with one amendment — a
   reserved-panel-width constraint recorded on `cjr.2` so the Grid lens isn't retrofitted later.
2. **Discovered the premise was cheaper than it looked.** The roster viewer's core-flows say the
   working roster is *"self-contained and decoupled"*, its edits are *"never blocked"* (no validation
   to share), and it carries its **own** undo. So "the viewer needs AI too" costs ~5 additive tools,
   not rework. Recorded.
3. **Split Tier-1 out as its own initiative** (`s30`). Rationale: AI is off by default and needs a
   key, so for the majority who never enable it, Tier-1 is the *entire* safety net — it must never
   depend on the optional tier. Also has no dependencies, so it can start immediately.

### Chunk 2 — the two-tier decision, the flow, and the G7 oracle (mid)

4. **Found the "empty stub" claim was false.** Carryover context said
   `decisions/path-to-feasibility-two-tier` and `briefs/ai-infeasibility-diagnostician` were empty
   stubs. Both were substantial (6.0 KB / 5.0 KB). The task was a **revision**, not a fresh write.
5. **Caught a bad scope claim before it shipped.** Recent ortools research proposed "four cheap
   checks" for Tier-1. Mapped each against the catalogue: (1) pairwise pin scan = already `G1`/`G6`/
   check 26; (2) per-date coverage = checks 4/5 in singleton form, **general form is on the Rejected
   must-NOT-warn list**; (3) contracted hours = checks 9/12; (4) **aggregate demand vs supply = cut
   in final pruning because CP-SAT returned OPTIMAL**. Building (4) would have re-admitted a measured
   false-positive class.
6. **Revised the two-tier decision** — Tier-1 now runs on *both* sides of the run; Tier-2 abandons the
   unsat core for elastic re-solve; fix verification became propose-first/verify-on-request.
7. **Revised `rule-conflict-validation`** — added the post-infeasible replay as a **third surface**,
   with state D (D1 findings / D2 nothing-found).
8. **Cold critique #1** (fresh agent) found the replay spec was wrong: it required retaining the
   submitted revision, which `session-transaction.ts` doesn't do and T16q forbids. **Its better idea:
   carry the findings, not the input.** Adopted — dissolved the `cjr` coupling entirely.
9. **7zc investigation** ("Try again" re-deriving from live store). **Verdict: spec gap, not a bug** —
   and I rejected part of the critique. `run-status-panel.tsx:18` documents the behaviour, and the
   panel copy says *"Loosen a hard rule and try again"*, so picking up changes is the *point*. Real
   gap was narrower: unconditional offering, plus `Resubmit` promising an exact re-send it never did.
10. **`qbc` — the G7 oracle investigation.** Built a CP-SAT harness from scratch and ran **22
    scenarios** through the real `nurse_scheduling.schedule()`. **Zero violations.** Two build-time
    validations discovered along the way (coefficients ≥ 1; duplicate coefficient entries rejected)
    that G7's soundness depends on. Admitted as check 28.
11. **Committed the harness** — `core/tests/catalogue_oracle.py` + `test_catalogue_oracle_g7.py`,
    documented in the T19 manifest. Measured **0.49 s**, so it belongs in the ordinary test run, not
    alongside the slow probe in `core/scripts/`.

### Chunk 3 — AI assistant flows, two critiques, and the artifact revert (mid-late)

12. **Drafted the AI assistant initiative** — index, decision log (D1–D20), five flows.
13. **Cold critique #1 of the flows** found: the privacy flow contradicted itself (required *and*
    disclaimed prose name-scanning); undo dies on reload so "persistent change list with one Undo"
    over-promised; Tier-2 had no *Inconclusive* state; and the Settings copy was **factually false**.
14. **User reversed two of my recommendations.** Descriptions sent unmodified with no disclosure
    (D21); later, pseudonymisation dropped entirely (D29). Both on the stated rationale that provider
    choice is the user's responsibility.
15. **Cold critique #2 of the flows** — six blocking findings. Its diagnosis of *me* was the valuable
    part: *"every finding about the plan's inputs was fixed properly; every finding about its
    published output contract was answered with a paragraph describing the problem."*
16. **The artifact revert incident.** Four AI-assistant artifacts silently reverted to their original
    drafts, losing D21–D27 and every flow edit. Investigated rather than blindly rewriting.
17. **Root cause found** — Traycer stores artifacts in **CRDT "rooms"** (`seeds/artifact-room-*.bin`)
    and **hydrates them onto disk on host start**. `host.log`: `epic seed hydrate ... roomKind:
    'artifact'`. Five markdown files were rewritten in the *same second* (15:11:33) as the room seeds.
    Filesystem edits are only durable if ingested before the next host restart.

### Chunk 4 — Tier-1 brief, tech plan, two critiques, tickets (late)

18. **Tier-1 epic brief** — standalone initiative dir, linking downstream artifacts in place so no
    inbound links break.
19. **Tech plan, governed by one decision: mirror `lib/scenario/leave-guard/`** — an existing shipped
    detector with the same shape (pure policy module + fail-closed resolution + adapters).
20. **Cold critique #1 of the tech plan — broke its central claim.** The plan cited
    `lib/rules/expansion.ts`, which is **fail-open** (unknown tokens added *"verbatim as a concrete
    date id"*), has no resolved/unresolved signal, `String()`-coerces keys, and **has no people
    resolver at all**. Meanwhile `leave-guard/resolution.ts` already *is* the fail-closed context.
    **The misleading source: `expansion.ts:1-15` declares itself "the SHARED FOUNDATION consumed by
    ... the Tier-1 conflict detector."** A stale forward-reference sent the plan to the wrong module.
21. **That critique also measured performance** rather than speculating: context build **0.108 ms**,
    `resolvePeople("ALL")` **3.5 µs**, 181 cards × resolution triple **≈ 0.95 ms**. Budget holds — but
    only under a **resolve-once invariant** the plan never stated (naive per-check re-resolution
    5.7 ms + per-cell scan 9.7 ms ≈ 15.4 ms, consuming the whole frame).
22. **Cold critique #2 of the tech plan — three more blockers**, all in the published contract. The
    carried set *couldn't legally exist* (§3 forbade persisted indices; §6 persisted them). Transitive
    grouping *falsified its own justification*. "Already generic" was half-right.
23. **Fixed the design, not the prose** this time — participants carry `uid`; grouping by set
    **equality**; `status` two values; resolution gaps priced.
24. **Nine tickets** (T1–T9), with G2 resolved by T1 and G4 by T3.

## Key Decisions

- **DL10-D3 upheld: roster viewer before AI assistant.** Rejected reordering — `cjr` is shovel-ready
  with 8 child beads; `t34`'s largest piece (lifting form invariants into a shared action layer) is an
  unplanned refactor of shipped, well-tested editor code.
- **Tier-1 is its own initiative with no dependencies.** Rejected keeping it inside the AI work — a
  keyless, always-on feature must not ship on an optional feature's schedule.
- **Tier-1 replay carries *findings*, not a scenario snapshot.** Rejected retaining the submitted
  revision (T16q forbids a scenario backup; would have coupled `s30` to `cjr.2.2`).
- **Catalogue stays at 28 and every addition clears the CP-SAT oracle bar.** Rejected adding
  "aggregate demand vs supply" — measured false-positive class, now recorded under NEEDS-SOLVER so it
  stops being re-proposed (it has been proposed twice).
- **Mirror `leave-guard`, and promote its `resolution.ts` to shared.** Rejected `lib/rules/expansion.ts`
  (fail-open) and rejected writing a second expansion (drift → false positives).
- **Grouping by participant-set EQUALITY.** Rejected transitive-overlap union: broad `ALL`-selector
  cards are participation hubs, so the count would trend to **1 exactly when the scenario has the most
  problems**, rendering the flow's own wireframe ("2 conflicts") as "1 conflict".
- **AI: the turn is exclusive** (scenario read-only during a turn). Chosen over concurrent editing,
  because a snapshot restore would silently revert the user's own edits. **This reversed D23** and
  dissolved the inverse-operation requirement entirely.
- **AI: pseudonymisation dropped (D29), descriptions sent unmodified (D21), no per-field disclosure.**
  User's call, against my recommendation. Consequence enforced: **D22 is void — the Settings copy
  claiming placeholder substitution must be *removed*, not narrowed.**
- **`l3m` rewritten, not closed.** Its mechanism (unsat core) is superseded; its *purpose* isn't —
  state D2 is the default AI-off user's dead end, and elastic re-solve is the only keyless answer.
- **Tier-2 check refused only while a solve is *executing*** — not on the retained job record or the
  browser recovery slot. An infeasible run holds the recovery slot but occupies no worker, so Tier 2
  stays reachable exactly when it's needed.

## Evidence & Data

### G7 oracle sweep (bead `qbc`) — 22 scenarios, `ortools==9.15.6755`

| Group | Cases | Result |
|---|---|---|
| Unit coefficients (reproduces check 9) | 2 | Pass — `T=7 > max_x=6` INFEASIBLE; `T=6` OPTIMAL |
| **Weighted** (the gap G7 closes) | 4 | Pass — `T=19 > 18` INFEASIBLE; boundary `T=18` OPTIMAL |
| Contracted-hours shape (28 days, half-hours) | 2 | Pass — `T=673 > 672` INFEASIBLE; `T=672` OPTIMAL |
| Soundness edges (negative coeff, OFF, multi-pair) | 3 | 2 pass, 1 **rejected at build time** |
| Recall demo (LEAVE inflates bound) | 2 | Pass — confirms deliberate low recall |
| Upper-bound predicates must never fire | 2 | Pass — `x<=T`, `x<T` solved |
| Soft weight must never conflict | 1 | Pass — finite weight 100 solved |
| Adversarial round 2 (dup entries, groups, caps) | 6 | Pass; 1 rejected at build time |
| **Total** | **22** | **0 violations** |

### Performance — measured by critique agent at reference scale (~87 people × 31 days)

| Operation | Cost |
|---|---|
| `buildScenarioResolutionContext` | **0.108 ms** |
| `resolvePeople("ALL")` | **3.5 µs** |
| 181 cards × one resolution triple | **0.95 ms** |
| Naive per-check re-resolution | **5.7 ms** |
| Naive per-cell request scan | **9.7 ms** |
| Naive total (both) | **≈ 15.4 ms** — consumes the entire 16 ms frame |

### Critique rounds — outcomes

| Artifact | Round | Blocking | Verdict |
|---|---|---|---|
| AI core flows | 1 | 5 | 2 already closed by user decision; 3 fixed |
| AI core flows | 2 | 6 | 3 resolved / 3 created new problems / 4 reworded / 9 unaddressed |
| Tier-1 tech plan | 1 | 2 | Central claim broken (wrong helper family); perf measured & upheld |
| Tier-1 tech plan | 2 | 3 | All in the published contract; fixed in types |

### Test + gate results

| Gate | Result |
|---|---|
| `pytest core/tests/test_catalogue_oracle_g7.py` | **24 passed, 0.49 s** |
| `pytest` (full `core`) | **600 passed, 51 skipped, 46.41 s** |
| `ruff check` / `ruff format --check` on `core/tests/` | clean |
| `web` suites | **not run this session** |

### Artifact revert — forensic timeline

| Time | Event |
|---|---|
| Jul 27 21:29 / 22:19 | Original flow drafts written |
| Jul 28 ~15:09 | `host/pid.json`, `cli/desktop-reconcile.json` rewritten — host restart |
| **Jul 28 15:11:33** | **7 `artifact-room-*.bin` seeds AND 5 markdown files written in the same second** |
| Jul 28 15:25 | Only that turn's edit survived |

`host.log`: `[09:57:37] host RPC listening` → `[09:58:01] epic seed hydrate roomKind:'root' seedBytes:105137934` → `[09:58:50] epic seed hydrate (slow artifact room) roomKind:'artifact'` (×7). **Two hydrate clusters = two host restarts.** `artifactCount: 659`.

### AI assistant decision log — D1–D30 (reversals matter)

| ID | Decision | Note |
|---|---|---|
| D7/D8 | Apply immediately; one turn = one undo entry | D8 now *literally* true via D28 |
| D9 | Deletes **and cascading renames** ask first | Reason restated to **blast radius** (D30 added renames) |
| D14 | Invariants lift into a shared action layer | **Largest work item in `t34`** |
| D16 | People/group identifiers pseudonymised | **REVERSED by D29** |
| D21 | Descriptions sent unmodified, no disclosure | User directive |
| D22 | Settings copy says "IDs", never "names" | **VOID** — must be removed entirely (D29) |
| D23 | Turn undo reverses operations, not snapshot | **REVERSED by D28** |
| D24 | No launcher at all while AI is off | Onboarding-discoverability cost accepted |
| D25 | Undo session-scoped; change list is not | History never persisted |
| D26 | Tier-2 check refused during an executing solve | Backend capacity only |
| D27 | Check never writes the submission record | Would corrupt run recovery |
| D28 | **The turn is exclusive** (scenario read-only) | Dissolved 4 blocking findings at once |
| D29 | **Pseudonymisation dropped** — real IDs sent | Reverses D16 |

### Commits this session

| Hash | Summary |
|---|---|
| `ef38955` | `test(core): add reusable CP-SAT oracle harness for the Tier-1 catalogue` (+552 lines, 3 files) |

### The 28-check catalogue (what `s30` implements)

Source of truth: `flows/rule-conflict-validation/verified-conflict-catalogue/index.md`. Every member
was admitted only after CP-SAT returned `INFEASIBLE`; candidates that solved were cut.

| Family | Checks | Count |
|---|---|---|
| **Staffing** | 1 negative exact target · 2 min>max · 3 singleton coeff non-divisible · 4 singleton unit + flat qualified list, target > size · 5 same-day exact demands sum > roster · 6 two all-roster exacts, different totals · 8 `+∞` pins > singleton exact cap · G5 work-pin vs qualification exclusion | 8 |
| **Counts / hours** | 9 `+∞` predicate impossible over `x∈[0,n]` · 10 uniform coeff, `T mod c ≠ 0` · 11 two identical unit exacts, different targets · 12 two shifts, minima sum > #dates · 14 pins exceed unit cap · G3 `[ALL,OFF,LEAVE]` count `T ≠ n` · G4 LEAVE-only count with no LEAVE request · **G7 weighted attainable-max** | 8 |
| **Requests / pins** | G1 two incompatible positive pins on one person-day · G6 same state at `+∞` and `−∞` | 2 |
| **Successions** | 15 empty forbidden pattern · 16 full-universe forbidden position · 17 empty required position · 18 two one-day `+∞` requiring distinct states · 19 identical pattern at `+∞`/`−∞` · 20 forbidden state = last history state · 21 succession vs request pin | 7 |
| **Affinities** | 22 `+∞` with empty participating term · 24 identical tuple at `+∞` and `−∞` | 2 |
| **Coverings** | 26 sole preceptor hard-zeroed on a pinned preceptee's cell | 1 |
| **Total** | | **28** |

**Deliberately dropped** (CP-SAT returned OPTIMAL): 7 weighted member-vs-aggregate · 13 count-vs-
aggregate-staffing · 23 affinity pigeonhole · 25 cross-family affinity/capacity · 27/28 covering
packing · G2 (redundant with 9).

**Rejected — must NOT warn:** raw `required > staff` / `> qualified` (coefficients defeat it) ·
duplicate coverage alone · `X=2` vs `2X=4` · treating `preferred` as soft · covering cycles.

**NEEDS-SOLVER** (added this session): horizon-wide aggregate demand vs supply — proposed twice, in
neither v1 nor Dropped nor Rejected, so it kept resurfacing. Now explicitly recorded.

### Tier-1 ticket set (T1–T9)

| # | Ticket | Depends on | Resolves |
|---|---|---|---|
| T1 | Shared resolution module: promote, nested refs, 3 inverses | — | **G2** |
| T2 | Conflict model, pipeline, grouping, fixture format (one check: G1) | T1 | — |
| T3 | Message content module — 28 structured templates | *catalogue only* | **G4** |
| T4 | Checks: staffing (8) + requests/pins (2) | T2 | — |
| T5 | Checks: counts / hours (8, incl. G7) | T2 | — |
| T6 | Checks: successions (7), affinities (2), coverings (1) | T2 + T1 nesting | — |
| T7 | Pre-optimize panel + global health indicator | T2, T3 | — |
| T8 | Author-time inline markers (6 rule surfaces) | T7 | — |
| T9 | Post-infeasible replay + carried set (`runGeneration`-stamped) | T2, T3 | — |

**T3 runs parallel to T1/T2** (content, not code). **T7 precedes T8 deliberately** — the panel is
authoritative, so it must exist before inline markers have to agree with it.

### AI assistant — five core flows

| Flow | Covers |
|---|---|
| `enablement-and-setup` | Three-state gate (Off / Intending / Ready), new Settings screen, provider choice, Test connection incl. the *unreachable* state |
| `panel-and-turn-lifecycle` | Panel, turn, **exclusive read-only turn**, approvals, failure modes, three verified hazards |
| `guided-setup-conversation` | Conversational ward modelling; boundary against Guided mode |
| `tier-2-feasibility` | Diagnosis, propose-first fixes, per-fix verification, run-slot rules |
| `privacy-and-data-boundary` | What leaves the browser (now: everything, unmodified) |

### `7zc` — optimize panel decisions (bead closed)

| Item | Settled |
|---|---|
| Re-run verb | **One verb: `Run again`**, submits current setup. `Resubmit` **retired** — it promised an exact re-send the code never did, and honouring it needs retention T16q forbids |
| worker_lost | **Ungated** — retrying identical input is correct there; label only |
| Change detection | **None** — accepted residual: an unchanged infeasible re-run burns a run |
| `verdict:` code box | **Dropped** — `infeasibility_proven` is a hardcoded literal (`runner.py:97`), 1:1 with the heading |
| Feasible outcome | **New**: surface `user_requested` vs `solver_timeout` in plain language — the only branch where `termination_reason` varies, and it was never displayed |

Implementation surface (not yet done): `run-status-panel.tsx:167` (delete the `workerLost` ternary),
`:237`, `:222-227` (delete verdict block), success block (~`:199`, add stop-reason line), and
`run-status-panel.test.tsx:187/211`.

### Parallel initiative — roster viewer (`cjr`), untouched but ready

`cjr.1.1` (B1 scheduler `on_roster` callback) is claimable now. Full stack exists: brief, core-flows,
critique, tech plan, tickets B1–B3 + F1–F5, **8 child beads created**. Higher post-parity priority
than AI. One constraint added this session: `cjr.2` must reserve for the assistant panel's docked
width so the Grid lens isn't retrofitted.

## Code Analysis

- **`web/lib/scenario/leave-guard/`** — the architectural template. `resolution.ts` (20 KB) exports
  `Resolution<T> = { resolved: true; values } | { resolved: false }`, `TypedMapKey = number | string`,
  `buildPeopleIndexMap`/`resolvePeopleSelector`, `resolveShiftTypeSelector`,
  `buildDateIndexMap`/`resolveDateSelector`, `buildScenarioResolutionContext`, `toTypedKeyRecords`.
  **Verified free of leave-specific coupling** — no `LEAVE_SID`, no count-card shape, 4 call sites.
- **`resolution.ts` gaps for s30:** resolvers take **flat selectors only**, but successions/affinities/
  coverings/requirements carry `Nested*RefList` (`Array<T|T[]>`) — **~18 of 28 checks**. And there is
  **no index→shift-type inverse**; `shifts[i]` is invalid because the index space includes
  `OFF_SID = -1` and `LEAVE_SID = -2`.
- **`web/lib/rules/expansion.ts`** — **do not use for the detector.** `expandDateRefs` adds unknown
  tokens *"verbatim as a concrete date id"*; `expandShiftTypeRefs` silently drops unknowns; both
  `String()`-coerce. Its header (`:1-15`) wrongly claims to be the Tier-1 foundation.
- **`web/lib/store/scenario-store.ts`** — zundo `temporal` config: `limit: 50`, `partialize:
  pickScenario`, `equality: scenarioShallowEqual`. Persist OUTER / temporal INNER. **Each undo entry
  is a whole-slice snapshot.** History never persisted.
- **`web/lib/store/hot-store.ts`** — `runGeneration` is a monotonic counter bumped by **every** reset
  path (`resetRun`/`resetRunView`/`resetEphemeral`), built for T16a so "late frames from scenario A's
  run can never repopulate scenario B's view". **Use it to stamp the carried finding set.**
- **`web/lib/optimize/session-transaction.ts`** — key `nurse.optimize.session`. **Provisional** variant
  uses `hasExactKeys`; **active** uses `hasAllowedKeys` and already carries optional `lastCursor`.
  Does **not** retain the scenario.
- **`web/lib/scenario/canonical.ts:8,57`** — deliberately strips `uid`: *"neither the projection nor
  this type ever reads a card's `uid`"*. Why the detector runs on UI types.
- **`web/lib/dates/date-id.ts`** — `generateDateIds` returns **span-compressed ids** (`DD`/`MM-DD`/
  `YYYY-MM-DD`); `generateDateItems` returns `{id, iso, description}`. **`expandDateRange`'s canonical
  replacement is `generateDateItems(range).map(i => i.iso)`, NOT `generateDateIds`.**
- **`core/nurse_scheduling/scheduler.py`** — `offs + dp_shifts_sum + leaves == 1` is unconditional;
  `at most one shift per day` is a **required** preference (loader rejects without it). Both underpin
  G7's soundness. Objective set unconditionally at `:277`.
- **`core/nurse_scheduling/server/jobs/runner.py:97`** — `termination_reason="infeasibility_proven"` is
  a **hardcoded literal**. Values: `optimality_proven`, `user_requested`, `solver_timeout`,
  `infeasibility_proven`. Only **FEASIBLE** carries information (`user_requested` vs `solver_timeout`).
- **`docker/compose.yml`** — *"Redis makes multiple workers safe; worker count is a measured capacity
  setting, not a correctness requirement."* One worker is a **default, not an invariant**.

## Files Changed

### Source code
- *(none — no application code was written this session)*

### Tests (committed, `ef38955`)
- `core/tests/catalogue_oracle.py` (167 lines) — reusable CP-SAT oracle harness: `scenario()` builder,
  `shift_count()`, `solve()`, `OracleCase`, `assert_sound()`, `max_attainable()`. **Asserts only the
  sound direction.**
- `core/tests/test_catalogue_oracle_g7.py` (247 lines) — 19 G7 cases via `@pytest.mark.parametrize`,
  a low-recall demonstration, and **three premise tests** (coefficients ≥ 1, duplicate coefficients
  rejected, one-shift-per-day mandatory).

### Docs (committed)
- `docs/T19-upstream-backend-source-manifest.md` — new "Net-new catalogue-oracle test modules" section
  (+26 lines) recording why this lives in `tests/` not `scripts/`.

### Traycer artifacts (outside git — see Blockers)
- `artifacts/tier-1-feasibility-checks/` — **new**: `index.md` (brief), `tech-plan/index.md` (387
  lines), `tech-plan/critique/`, `tech-plan/critique-2/`, `tickets/index.md` + **9 ticket dirs**.
- `artifacts/ai-assistant/` — **new**: `index.md`, `decisions/index.md` (D1–D30), `flows/index.md` +
  5 flows, `reviews/core-flows-critique/`, `reviews/core-flows-critique-2/`.
- `artifacts/app-prototype-fidelity-audit/` — **revised**: `decisions/path-to-feasibility-two-tier/`,
  `decisions/prototype-backend-capability/` (amended), `flows/rule-conflict-validation/` (+ catalogue
  → 28 checks, + behavioral matrix), `flows/optimize-run-outcome/`, `briefs/ai-infeasibility-diagnostician/`.

## User Feedback & Preferences (REQUIRED)

- **"lets discuss this, the roster viewer will going to need this ai feature as well, how do you think
  we should sequence?"** — wanted the sequencing argued, not asserted.
- **"we want to avoid over-engineering and avoid changing core and backend since we need to pull
  changes from upstream (the old app) form time to time"** — **the single most important standing
  constraint.** Drove: mirror an existing module rather than invent; no `core/` changes; reuse over
  abstraction.
- **"i dont undestand what you are asking"** — on a three-way architecture question framed in jargon
  ("canonical projection", "uid sidecar"). **Lesson: the codebase already had the answer; I should
  have looked instead of asking.** Re-framing plainly + investigating resolved it in minutes.
- **"send them anyway and no disclosure, user is responsible for chossing a llm provider that respects
  privacy"** — D21. Deliberate, against recommendation.
- Chose **"Suspend history and block editing during a turn"** over the recommended option — which
  turned out *better*, dissolving four blocking findings.
- Chose **"Send real IDs instead and drop pseudonymisation"** — D29, reversing D16.
- Chose **"Leave it always primary, no change detection"** for the infeasible re-run — accepted a
  wasted run over added machinery.
- **"what should i do now to continue building"** — signalled planning fatigue. Recommended finishing
  the in-flight re-skin over opening new work.
- **"Investigate what reverted the artifacts before rewriting anything"** — explicitly preferred root
  cause over redoing lost work. Correct call; the cause was systemic.
- **"what does this mean ?"** — on shorthand ("Close G2 and G4"). Wants next-steps written so they
  stand alone, not internal jargon.
- Repeatedly asked for **fresh-agent critique before ticketing**. Values adversarial review as a gate.

## Where We're Going

1. **Untangle the branch** — push `ef38955`, open the PR, move the uncommitted `ii7` re-skin work onto
   its own branch. It is stranded on a test-harness branch.
2. **Resolve the missing prior Tier-1 plan** (see Blockers) — recover
   `plans/tier1-conflict-detector/index.md` from the other machine, or explicitly decide the new plan
   supersedes it. **Its critique finding ("committed-only re-evaluation breaks on quick-paint") has
   never been addressed.**
3. **Start T1** (`tickets/t1-shared-resolution/`) — promote `leave-guard/resolution.ts`, add nested-ref
   support, add the three index→ref inverses. Foundation for everything else.
4. **T3 in parallel** — the 28 message templates depend only on the catalogue, not on code.
5. **Or ship the re-skin instead** — `ii7` is P1 with work in flight; Tier-1 is P2.
6. Optionally: create bd child beads mirroring T1–T9 under `s30`.

## Risks & Blockers

- **🔴 The prior Tier-1 tech plan is missing and its critique was never applied.** Parent handoff:
  *"revise `plans/tier1-conflict-detector/index.md` against its critique (committed-only re-evaluation
  breaks on quick-paint) BEFORE ticketing."* That file is absent here; a **new** plan was written
  without it. **Quick-paint stages in the hot store and commits once at pointer-up, so committed-only
  evaluation may be fine — but this was never verified against the original argument.** Highest-value
  thing to resolve before T1.
- **🔴 Traycer artifacts are not durable on disk.** They are a projection of CRDT rooms and are
  rewritten on host restart. Every artifact written this session may vanish. **All decisions are
  mirrored in bead notes** (`s30`, `t34`, `3d4`) — treat beads as canonical. Verify in the Traycer UI
  that the decision log shows **D1–D30**; if it stops at D20, the room never ingested the rebuild.
- **Uncommitted re-skin work sits on `catalogue-oracle-harness`** (28 files, +3024/-695). Will follow
  across checkouts and tangle two unrelated tracks.
- **`web` was never run.** No vitest/playwright this session; frontend state unverified.
- **`lib/rules/expansion.ts:1-15` actively misleads** — it claims to be the Tier-1 foundation. It sent
  this session's plan to the wrong module. Fix the comment or the next implementer repeats it.
- **Environment churn** — woz MCP dropped twice (one auth error needing `/woz login`, one disconnect).
  Traycer child-agent creation failed all session (`sender agent ... is not local to host`), so the
  agent-selection guide's codex/`gpt-5.6-sol` routing was unavailable; built-in agents used instead.
- **6 unrelated beads sit `in_progress`** and were untouched — `ii7.9`, `bmw`, `bmw.1`, `qq0.27.4`,
  `w0e.1`, `76u`.

## Open Questions

- **Does the missing prior plan's "quick-paint" critique still apply?** Needs the original file or a
  fresh analysis of `commitPaintGesture` against committed-only re-evaluation.
- **Did the Traycer rooms ingest the rebuilt artifacts?** Only the Traycer UI can confirm.
- **Two round-1 tech-plan findings remain unaddressed** beyond the tickets: G2's index→ref *direction*
  asymmetry, and whether T3's 28 templates need a controlled glossary module of their own.
- **Should `s30` get bd child beads** mirroring T1–T9, as `cjr` has for B1–B3/F1–F5?
- **Is `l3m` (elastic re-solve) worth doing** before Tier-2, given it serves the AI-off majority?

## Quick Start for Next Session

```bash
# Restore context
cd /Users/kenan.xin/Work/nursing-sheduler
bd show nursing-sheduler-s30     # Tier-1 — all decisions + critique findings in notes
bd show nursing-sheduler-t34     # AI assistant — D1–D30 rationale
bd ready | head -15

# Branch state (IMPORTANT — untangle first)
git branch --show-current        # catalogue-oracle-harness
git status -s                    # uncommitted ii7 re-skin work stranded here
git log origin/main..HEAD        # ef38955 unpushed

# Planning artifacts (may have reverted — verify against bead notes)
ls /Users/kenan.xin/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/tier-1-feasibility-checks/
ls /Users/kenan.xin/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/ai-assistant/

# Key files to read first
# web/lib/scenario/leave-guard/resolution.ts   <- the module T1 promotes
# web/lib/scenario/leave-guard/detector.ts     <- the architectural template
# web/lib/scenario/leave-guard/adapters.ts     <- the identity-join pattern
# core/tests/catalogue_oracle.py               <- the committed oracle bar
# web/lib/store/hot-store.ts                   <- runGeneration (T9 depends on it)

# Verify current state
cd core && ./.venv/bin/python -m pytest tests/test_catalogue_oracle_g7.py -q   # expect 24 passed

# Next action
# Push ef38955 + open PR, THEN move the uncommitted re-skin work off this branch.
# Before starting T1: resolve the missing plans/tier1-conflict-detector/index.md
# and its unapplied "committed-only re-evaluation breaks on quick-paint" critique.
```

---

## Session Closed

**Closed at:** 2026-07-28 22:45 +08
**Commit:** none — closed **without** committing (user directive)
**HEAD:** `ef38955` (the oracle harness, from earlier this session — **unpushed**)
**Session status:** Handed off to next session

⚠️ **The working tree is dirty — 68 changed/untracked paths.** Nothing from this session's planning
work is committed, and the `ii7` v2 re-skin work is uncommitted **on the `catalogue-oracle-harness`
branch**, where it does not belong. Another session (or a branch switch) will see this state and the
re-skin changes will follow across checkouts. Untangling that is the first action, before any new work.

This handoff file is itself uncommitted.
