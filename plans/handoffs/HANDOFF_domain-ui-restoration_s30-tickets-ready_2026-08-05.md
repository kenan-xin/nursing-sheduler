# Tier-1 (`s30`) is ticketed and unblocked: 9 tickets, both tech-plan gaps closed, every parent blocker cleared — T1 is startable

**Date:** 2026-08-05
**Status:** IN PROGRESS — planning 100% complete for `s30`; zero implementation started; the last gate (ticket critique) did NOT complete
**Bead(s):** `nursing-sheduler-s30` (primary, `in_progress`), `t34`, `3d4`, `cqr`, `l0o`, `l3m`
**Epic:** Post-parity roadmap — roster viewer (`cjr`, now actively building) → AI assistant (`t34`); Tier-1 (`s30`) in parallel
**Chain:** `domain-ui-restoration` seq `3`
**Parent:** `HANDOFF_domain-ui-restoration_tier1-and-ai-planning_2026-07-28.md`
**Prior chain:** `HANDOFF_domain-ui-restoration_dr4-tie-in_2026-07-24.md` > `HANDOFF_domain-ui-restoration_tier1-and-ai-planning_2026-07-28.md` > this

> **Chain-tag caveat (inherited, still true).** The tag names the parent's original work (domain-UI
> restoration, DR-1–DR-5, complete). Seq 2 and seq 3 are entirely `nursing-sheduler-s30` / `t34`.
> Nothing depends on the tag except handoff discovery, so it was kept for continuity. If you prefer,
> re-tag as `nursing-sheduler-s30` and call the next one seq 1.
>
> **Read the parent for planning archaeology** (how the 28 checks were derived, four critique rounds,
> the AI decision log D1–D30). This handoff is self-sufficient for *implementing* `s30`.

---

## Stale References

Checked against this checkout on 2026-08-05:

- **`plans/tier1-conflict-detector/index.md` — STILL NOT FOUND.** Carried from seq 2, which carried it
  from seq 1. Three handoffs have now flagged the same missing file. Seq 1 said it was drafted and
  "critiqued **NOT ready**", with the finding *"committed-only re-evaluation breaks on quick-paint."*
  **That finding has never been applied to anything.** See Risks — this is the one substantive
  unknown left before T1.
- **`web/components/entity-editor/entity-editor.tsx`** — retired by DR-5 (`5eea189`). Expected.
- **"27 verified conflict classes" / "27 catalogue checks"** — the catalogue is **28** (G7 admitted,
  bead `qbc`, CP-SAT-verified). The `s30` bead's `DESCRIPTION` and `ACCEPTANCE CRITERIA` **still say
  27** in four places. The Traycer artifacts all say 28. Artifacts are right; the bead text is stale.
- **`s30` DESCRIPTION still carries a claim its own NOTES retract.** DESCRIPTION says *"(4) aggregate
  demand vs supply = checks 7/13, EXPLICITLY DROPPED in final pruning"*. NOTES correction #2 says that
  mapping was **wrong** — horizon-wide demand-vs-supply is in *none* of the 28, the Dropped list, or the
  Rejected list; its home is **NEEDS-SOLVER**, and it stays out on the firewall rule, not on a pruning
  result. **A reader of the description alone gets the wrong story.** Worth a `bd update`.
- **Seq 2's "Where We're Going" step 1 (untangle the branch) — obsolete, already done.** See below.
- **Seq 2's "uncommitted `ii7` re-skin stranded on `catalogue-oracle-harness`" — obsolete.** The re-skin
  landed; `DESIGN.md` and `PRODUCT.md` are now tracked files.
- **Seq 2 claimed `ai-assistant/reviews/core-flows-critique/` and `core-flows-critique-2/` exist as
  artifacts.** On disk they are **empty stubs** — 74 bytes and 102 bytes, frontmatter only, mtime
  Jul 28 07:11. The critique *findings* were applied to the flows and the decision log, but the
  critique documents themselves are not recoverable. Do not go looking for them.

## Related Handoffs

- `HANDOFF_web-code-review_frontend-fixes_2026-07-24.md` — separate work stream (frontend review
  backlog, beads `0s7`/`b8z`/`hop`). Reference only, not a chain ancestor.
- `HANDOFF_parity-rebuild_t11-shift-requests_2026-07-18.md` — the `qq0` parity rebuild. Reference only.

## Since Last Handoff

Seq 2 closed on 2026-07-28 with three blockers and six next-steps. **Every environmental blocker it
named has since been cleared by other sessions**, without this thread doing anything:

- **Next-step 1 (untangle the branch) — DONE elsewhere.** `ef38955` (the CP-SAT oracle harness) is now
  an **ancestor of `main`**, `origin/main == main == 2c92c4d`, nothing unpushed. The local
  `catalogue-oracle-harness` branch survives but is fully merged. No PR was needed.
- **The stranded `ii7` re-skin — SHIPPED.** `0f55a95 merge(web): integrate G1 final v2 convergence and
  close the epic (ii7.18, ii7)` landed today. `CLAUDE.md` now reads *"The v2 re-skin has landed: every
  shipped route in `web/` implements Mint Canvas, Warm Ink."* `ii7.9` is no longer `in_progress`.
- **Next-step 5 ("or ship the re-skin instead") — moot.** It shipped. Tier-1 no longer competes with a
  P1 in flight.
- **Next-step 3 (start T1) — still not started.** Unchanged. Now genuinely unobstructed.
- **The roster viewer overtook Tier-1.** Seq 2 said `cjr.1.1` was "claimable now"; a parallel session
  claimed and **closed `cjr.1.1` (B1) and `cjr.1.2` (B2)** today. `cjr.1.3` (B3 BFF proxy) is the only
  open child. Its deliverables are the **uncommitted `core/` changes in your working tree** — see Risks.
- **`bd` grew from 312 issues to 374** (63 open, 8 `in_progress`, 301 closed, 45 ready). None of that
  growth is `s30`.
- **Trajectory:** seq 2 ended with planning complete but the environment tangled. Seq 3 inverts that —
  the environment is clean and `s30` is fully ticketed; what is missing is a *decision to start coding*.
- **One risk seq 2 flagged did NOT materialise:** the Traycer artifacts did not revert again. The
  `tier-1-feasibility-checks` tree is intact (13 files), the decision log still shows D30, the catalogue
  still carries G7.
- **One risk seq 2 flagged DID materialise, differently:** two fresh-agent verification children
  returned **factually wrong claims with `tool_uses: 0`**. See Evidence.

## Reference Documents

- `CLAUDE.md` — beads workflow, agent context profiles (**Conservative is default: do not commit or
  push without explicit authority**), and the **Design Context** section. Note it has been updated: the
  v2 system is now shipped, and **`DESIGN.md` is canon over code** if they drift.
- `DESIGN.md` / `PRODUCT.md` — now **tracked in git**. North Star "Mint Canvas, Warm Ink".
- `docs/T19-upstream-backend-source-manifest.md` — vendored-backend drift policy. **Read before any
  `core/` change.** Currently has +120 uncommitted lines from the `cjr` roster work.
- Traycer artifacts root:
  `/Users/kenan.xin/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/`
- `docs/design_prototype/` — canonical UI reference bundle (visual system only).

## The Goal

**Tier-1 deterministic feasibility checks (`s30`)** warn the user about rule combinations that
*provably* cannot produce a roster — before submit, and again after an infeasible run. Keyless, always
on, pure client-side arithmetic and set logic over data the frontend already holds. No LLM, no BYO key,
no backend, no CP-SAT at runtime. It is the **entire safety net for the majority of users**, because
the AI assistant (`t34`, Tier 2) is off by default and needs a key.

The governing constraint is **zero false positives**. Tier-1's whole value is that a warning is never
wrong; one false alarm costs more trust than a narrow check can earn back. This is why the catalogue
was built by running CP-SAT as an oracle and *cutting* every candidate that came back feasible.

The end state for this thread: `s30` has a brief, a twice-critiqued tech plan, and nine
dependency-ordered tickets with both review gaps closed. **The next thread writes code.**

## Where We Are

- **Branch `main`, clean sync** — `main == origin/main == 2c92c4d`. Nothing unpushed. Seq 2's branch
  tangle is gone.
- **Working tree is DIRTY with another workflow's work** — 8 modified + 4 untracked files, all `core/`
  roster-endpoint deliverables from `cjr.1.1`/`cjr.1.2`. Both beads are **closed** with the reason
  *"integrated locally to main without commit or push."* **Not ours. Do not commit it.**
- **`s30` planning is complete and ticketed.** `artifacts/tier-1-feasibility-checks/`: brief
  (`index.md`, 6.7 KB), `tech-plan/index.md` (**443 lines**), `tech-plan/critique/` (20.7 KB),
  `tech-plan/critique-2/` (24.7 KB), `tickets/index.md` + **9 ticket directories**.
- **Both tech-plan review gaps are closed *in the breakdown*, not deferred:** **G2** (nobody owned the
  index→ref inverse) is settled by **T1**; **G4** (nobody owned the 28 message templates) is settled by
  **T3**. The `tickets/index.md` opens with a table stating exactly that.
- **The ticket-breakdown critique never landed.** The fresh agent was interrupted at the literal moment
  it said *"I have everything I need for a grounded critique. Writing the artifact."*
  `tickets/critique/` **does not exist**. Its transcript is at
  `/private/tmp/claude-502/-Users-kenan-xin-Work-nursing-sheduler/7533389e-.../tasks/a8eb80fd3f391741e.output`
  (448 KB JSONL) if you want its research, but there is **no synthesis**.
- **Two fixes the dead critique surfaced WERE applied** (this session, just now) — T5's oracle-case count
  and T2's shared-fixture sizing. See Files Changed.
- **The catalogue is 28 checks** and every member was CP-SAT-verified. `verified-conflict-catalogue/`
  carries G7 in five places.
- **The oracle harness is committed and on `main`** — `core/tests/catalogue_oracle.py` (6.7 KB) and
  `core/tests/test_catalogue_oracle_g7.py` (11.7 KB), commit `ef38955` dated 2026-07-27.
- **Verified test structure:** `CASES` has **19** `OracleCase` entries (parametrized through
  `test_g7_is_sound`), plus **5** standalone tests (`test_person_group_case_covers_two_people`,
  `test_g7_is_deliberately_low_recall`, and **three premise tests**) = **24 pytest results**. Seq 2's
  "24 cases" was a pytest-result count, not a fixture count.
- **AI assistant (`t34`) planning is complete but its two critique artifacts are empty stubs.** Index,
  decision log (D1–D30, 13.8 KB), and five flows are intact. The reviews are frontmatter only.
- **`s30` is `in_progress` in `bd`, started 2026-07-29, with no child beads.** `cjr` has 8 children for
  B1–B3/F1–F5; `s30` has none mirroring T1–T9. Still an open question from seq 2.
- **`s30` bead text is stale on the check count (27 vs 28)** and carries a retracted mapping in its
  DESCRIPTION that its NOTES correct. Artifacts are canonical; the bead needs a `bd update`.
- **`web` was not run in this thread.** No vitest, no playwright, no `verdict`. Frontend unverified
  since the re-skin landed — though the re-skin's own sessions ran their gates.
- **`core` tests were not re-run in this thread.** Seq 2's numbers (600 passed / 51 skipped / 46.4 s;
  oracle 24 passed / 0.49 s) predate today's four `core` commits and the uncommitted roster work, so
  **treat them as stale baselines**.
- **`python3` on PATH has no pytest** — `/Library/Developer/CommandLineTools/usr/bin/python3` is bare.
  Use the project's pinned interpreter (beads `3kl`/`qq0.27.4` track exactly this).
- **`bd memories` has 35 entries**, including `handoff-2026-07-28-tier1-ai-planning` (seq 2),
  `artifacts-source-of-truth-beads-mirror`, `ai-features-optional-byo-key`,
  `review-verification-discipline-user-standing-reviewers-and-i`. Keyword search for "tier" and
  "oracle" returns nothing — **memories are keyed by topic slug, not content; grep the key list**.
- **Traycer child-agent creation still fails** (`sender agent ... is not local to host`), so the
  agent-selection guide's codex routing is unavailable. Built-in `Agent` subagents were used instead.
- **8 beads `in_progress`**, of which 7 are unrelated to `s30`: `bmw`, `bmw.1`, `lma`, `qq0.27.4`,
  `w0e.1`, `3kl`, `76u`.

## What We Tried (Chronological)

### Chunk A — the ticket breakdown (2026-07-29, after seq 2 was written)

1. **User asked what "Close G2 and G4 in the plan" meant.** It was internal shorthand in seq 2's
   next-steps. Explained: G2 = no module owned the index→ref *inverse* (the tech plan had the forward
   direction covered by `resolution.ts` but nothing produced a ref *from* an index, which every
   deep-link needs); G4 = the plan required `reason` to be "a structured template plus values, never a
   formatted string" but named no owner for the 28 templates.
   **Lesson recorded: write next-steps so they stand alone.**
2. **User's answer: "Break the s30 tech plan into implementation tickets and let the breakdown resolve
   both."** So the gaps were closed *by assignment* rather than by re-editing the plan — G2 → T1,
   G4 → T3 — and `tickets/index.md` states the resolution in a table at the top so it cannot be lost.
3. **Wrote nine tickets, dependency-ordered.** Two sequencing calls are deliberate and load-bearing:
   **T3 runs parallel to T1/T2** (it depends only on the catalogue, not on code), and **T7 precedes T8**
   (the pre-optimize panel is the authoritative surface, so it must exist before inline markers have to
   agree with it — not the reverse).
4. **Tech plan revised to 443 lines** in the same pass (from 387 at seq 2's writing).

### Chunk B — dormant (2026-07-29 → 2026-08-04)

5. **Nothing happened in this thread.** Meanwhile other sessions shipped the `ii7`/G1 v2 convergence,
   merged the oracle harness into `main`, and pushed. `tech-plan/critique/index.md` has an Aug 4 mtime
   with unchanged content — consistent with a Traycer room re-hydrate, not an edit.

### Chunk C — the ticket critique attempt and its verification failures (2026-08-05)

6. **User: "Critique the ticket breakdown with a fresh agent before starting."** Consistent with the
   pattern across all three handoffs — adversarial cold review is the gate before implementation.
7. **The critique agent was dispatched, stopped, and re-dispatched via SendMessage.** It spawned two
   verification children (one `web/`, one `core/`) to ground its claims.
8. **Both children returned wrong claims — and both reported `tool_uses: 0`.**
   - The `web/` child claimed `web/components/home/scenario-summary.ts` **does not exist**. It does —
     6.2 KB, dated 2026-07-23, with `scenario-summary.test.ts` beside it. It is the narrow-slice
     `Pick<ScenarioUiState, …>` + `useMemo` precedent the tech plan cites.
   - The `core/` child cited `preference_types.py:189-190` as the hard `preferredNumPeople` upper
     bound. **Wrong line.** `:189-193` holds the `>=` / `==` pair; the hard upper bound is at **`:196`**,
     sitting under a comment that misleadingly reads *"Add soft constraint for preferred number of
     people if specified"* — only the following `diff` objective term is soft.
9. **Verified both myself and sent the parent a correction**, plus two facts it could safely rely on
   (the exact-equality over-staffing trap; `runGeneration` bumped at `hot-store.ts:125`/`:133`/`:151`),
   and an instruction to mark anything unverifiable as **unverified** rather than inheriting a child's
   claim as fact.
10. **Established what the mis-cited line actually proves** — and it matters for the catalogue:
    `preferredNumPeople` **is** a hard upper bound, so **check 2 (min > max) is sound**; and a bare
    requirement is exact `==`, so it **forbids over-staffing**. Catalogue design-correction #2 stands.
11. **Deliberately held two queued ticket edits** while the critique was reading `tickets/t2` and
    `tickets/t5` — editing artifacts underneath a running critique is exactly what caused confusion when
    the tech plan was edited under its own critique in seq 2.
12. **The critique died before synthesis.** Interrupted one message after *"I have everything I need for
    a grounded critique. Writing the artifact."* No `tickets/critique/index.md` was ever written.
13. **Applied the two held fixes now that the gate is gone** (see Files Changed) — the only two findings
    from the dead critique that were concrete enough to act on without its synthesis.

### Carried from seq 2 — the approaches that produced the plan (do not re-derive)

14. **`leave-guard` was chosen as the architectural template** over inventing a detector, and
    `lib/rules/expansion.ts` was **rejected**: it is fail-open (unknown date tokens are added *"verbatim
    as a concrete date id"*), silently drops unknown shift types, `String()`-coerces keys, returns no
    resolved/unresolved signal, and **has no people resolver at all**. Its header at `:1-15` falsely
    declares itself "the SHARED FOUNDATION consumed by ... the Tier-1 conflict detector" — a stale
    forward-reference that sent seq 2's first tech-plan draft to the wrong module.
15. **The replay carries *findings*, not a scenario snapshot.** Retaining the submitted revision was
    tried and rejected: `session-transaction.ts` does not retain the scenario, and T16q forbids a
    scenario backup. Carrying the finding set (which already exists at submit, stamped with
    `runGeneration`) is equivalent and far cheaper — and it dissolved the `s30` → `cjr.2.2` coupling.
16. **Grouping by participant-set equality**, after transitive-overlap union was tried and rejected.
17. **G7 was admitted only after 22 CP-SAT scenarios returned zero violations** (bead `qbc`).
18. **"Aggregate demand vs supply" was refused twice** and is now recorded under NEEDS-SOLVER so it
    stops resurfacing.

## Key Decisions

- **G2 and G4 are closed by ticket assignment, not by re-editing the tech plan.** T1 owns all three
  index→ref inverses *because it already owns the forward direction and therefore the index space*;
  T3 owns all 28 templates as a content module mirroring `leave-guard/warning-format.ts`. Rejected
  alternative: another tech-plan revision round — the plan had already been critiqued twice, and an
  unowned gap is a *staffing* problem, not a design problem.
- **T7 before T8, deliberately.** The panel is the authoritative snapshot surface, so inline markers must
  be built to agree with it. Rejected the intuitive order (inline first, panel as roll-up) because it
  makes the roll-up follow the markers, and the flow says the panel wins when they disagree.
- **T3 parallel to T1/T2.** Content work gated on the catalogue, not on code. Rejected sequencing it
  after the detector: 28 messages are the long-lead item, and the flow explicitly asks for the hardest
  ~5 to be tested with real schedulers *before* the pattern is trusted.
- **T2 proves the pipeline with exactly one check (G1).** Rejected implementing several: G1 is the
  simplest shape and still exercises the request-cell participant path end to end.
- **The two held ticket edits were applied without the critique's synthesis.** Both were independently
  verified facts (a miscounted fixture set; an under-sized scope bullet), not judgement calls.
- **Child-agent claims are not evidence.** After two `tool_uses: 0` children returned wrong file facts,
  the working rule is: verify a subagent's file/line claim before propagating it, and mark unverifiable
  claims *unverified* rather than inheriting them. This matches the standing memory
  `review-verification-discipline-user-standing-reviewers-and-i`.
- **The uncommitted `core/` roster work stays uncommitted by this thread.** It belongs to closed beads
  `cjr.1.1`/`cjr.1.2`, whose close reason says integrated-without-commit. Rejected committing it "to
  clean the tree" — that would attribute another workflow's deliverable to a Tier-1 commit.
- **Chain tag inherited rather than re-cut.** Discovery via `grep "Chain:.*domain-ui-restoration"`
  matters more than semantic tidiness across a three-handoff chain.

## Evidence & Data

### Environment delta: what seq 2 flagged vs today

| Seq 2 blocker / state | Status on 2026-08-05 | Evidence |
| --- | --- | --- |
| `ef38955` unpushed, no PR | **RESOLVED** | `git merge-base --is-ancestor ef38955 main` → yes; `origin/main..main` empty |
| `ii7` re-skin stranded on harness branch (28 files, +3024/-695) | **RESOLVED — shipped** | `0f55a95 merge(web): integrate G1 final v2 convergence and close the epic`; `DESIGN.md`/`PRODUCT.md` now `git ls-files` tracked |
| Branch = `catalogue-oracle-harness` | Now `main`, merged, clean | `git branch --merged main` lists the harness branch |
| Traycer artifacts may revert | **Did not** | 13 files intact under `tier-1-feasibility-checks/`; D30 present; G7 ×5 in catalogue |
| `plans/tier1-conflict-detector/index.md` missing | **STILL MISSING** | third handoff in a row |
| `web` never run | **Still not run** in this thread | — |
| 6 unrelated beads `in_progress` | Now 7 (`ii7.9` closed, `lma`+`3kl` added) | `bd list --status=in_progress` |
| Issue count 312 / 66 open / 36 ready | **374 / 63 open / 45 ready / 301 closed** | `bd stats` |

### The nine tickets (`artifacts/tier-1-feasibility-checks/tickets/`)

| # | Ticket | Depends on | Resolves | Leaves codebase |
| --- | --- | --- | --- | --- |
| **T1** | Shared resolution module — promote, nested refs, 3 inverses | — | **G2** | Working (pure refactor + additive) |
| **T2** | Conflict model, pipeline, grouping, fixture format (**G1 only**) | T1 | — | Working |
| **T3** | Message content module — 28 structured templates | *catalogue only* | **G4** | Working (content, no wiring) |
| **T4** | Checks: staffing (8) + requests/pins (2) | T2 | — | Working |
| **T5** | Checks: counts / hours (8, incl. G7) | T2 | — | Working |
| **T6** | Checks: successions (7), affinities (2), coverings (1) | T2 + T1 nesting | — | Working |
| **T7** | Pre-optimize panel + global health indicator | T2, T3 | — | Working — **first user-visible surface** |
| **T8** | Author-time inline markers (6 rule surfaces) | T7 | — | Working |
| **T9** | Post-infeasible replay + carried set (`runGeneration`-stamped) | T2, T3 | — | Working |

**Out of scope for every ticket:** any `core/` change · oracle backfill for the other 27 checks (bead
`cqr`) · the `expandDateRange` consolidation (bead `l0o`) · incremental recomputation.

### The 28-check catalogue (what `s30` implements)

Source of truth:
`artifacts/app-prototype-fidelity-audit/flows/rule-conflict-validation/verified-conflict-catalogue/index.md`.
Every member was admitted only after CP-SAT returned `INFEASIBLE`.

| Family | Checks | Count |
| --- | --- | --- |
| **Staffing** | 1 negative exact target · 2 min>max · 3 singleton coeff non-divisible · 4 singleton unit + flat qualified list, target > size · 5 same-day exact demands sum > roster · 6 two all-roster exacts, different totals · 8 `+inf` pins > singleton exact cap · G5 work-pin vs qualification exclusion | 8 |
| **Counts / hours** | 9 `+inf` predicate impossible over `x in [0,n]` · 10 uniform coeff, `T mod c != 0` · 11 two identical unit exacts, different targets · 12 two shifts, minima sum > #dates · 14 pins exceed unit cap · G3 `[ALL,OFF,LEAVE]` count `T != n` · G4 LEAVE-only count with no LEAVE request · **G7 weighted attainable-max** | 8 |
| **Requests / pins** | G1 two incompatible positive pins on one person-day · G6 same state at `+inf` and `-inf` | 2 |
| **Successions** | 15 empty forbidden pattern · 16 full-universe forbidden position · 17 empty required position · 18 two one-day `+inf` requiring distinct states · 19 identical pattern at `+inf`/`-inf` · 20 forbidden state = last history state · 21 succession vs request pin | 7 |
| **Affinities** | 22 `+inf` with empty participating term · 24 identical tuple at `+inf` and `-inf` | 2 |
| **Coverings** | 26 **sole** preceptor hard-zeroed on a pinned preceptee's cell | 1 |
| **Total** | | **28** |

**Dropped** (CP-SAT returned OPTIMAL): 7 weighted member-vs-aggregate · 13 count-vs-aggregate-staffing ·
23 affinity pigeonhole · 25 cross-family affinity/capacity · 27/28 covering packing · G2 (redundant
with 9).

**Rejected — must NOT warn:** raw `required > staff` / `> qualified` (coefficients defeat it) ·
duplicate coverage alone · `X=2` vs `2X=4` · treating `preferred` as soft · covering cycles.

**NEEDS-SOLVER:** horizon-wide aggregate demand vs supply — proposed twice, in none of the three lists,
so it kept resurfacing. Now explicitly recorded so it stops.

### Committed oracle harness — verified structure (corrected this session)

| Item | Value | How verified |
| --- | --- | --- |
| `CASES` parametrized entries | **19** | 24 pytest results minus 5 standalone tests |
| Standalone tests | **5** | `grep -n "^def test_"` → `test_person_group_case_covers_two_people`, `test_g7_is_deliberately_low_recall`, + 3 `test_premise_*` |
| Total pytest results | **24** | seq 2's measured run |
| Runtime | **0.49 s** | seq 2 (stale baseline — not re-run) |
| Files / size | `catalogue_oracle.py` 6.7 KB · `test_catalogue_oracle_g7.py` 11.7 KB | `ls -la` |
| Public surface | `scenario()`, `shift_count()`, `solve()`, `OracleCase`, `assert_sound()`, `max_attainable()`, `HARD`/`FORBID`/`INFEASIBLE`/`SOLVED` | — |
| Governing rule | **Only the sound direction is asserted** (`predicted infeasible ⇒ solver INFEASIBLE`). The converse is never asserted | — |
| Import form | `from tests.catalogue_oracle import ...` (`tests/` is a package) | a bare import fails with `ModuleNotFoundError` |

### G7 oracle sweep (bead `qbc`, closed) — 22 scenarios, `ortools==9.15.6755`

| Group | Cases | Result |
| --- | --- | --- |
| Unit coefficients (reproduces check 9) | 2 | Pass — `T=7 > max_x=6` INFEASIBLE; `T=6` OPTIMAL |
| **Weighted** (the gap G7 closes) | 4 | Pass — `T=19 > 18` INFEASIBLE; boundary `T=18` OPTIMAL |
| Contracted-hours shape (28 days, half-hours) | 2 | Pass — `T=673 > 672` INFEASIBLE; `T=672` OPTIMAL |
| Soundness edges (negative coeff, OFF, multi-pair) | 3 | 2 pass, 1 **rejected at build time** |
| Recall demo (LEAVE inflates bound) | 2 | Pass — confirms deliberate low recall |
| Upper-bound predicates must never fire | 2 | Pass — `x<=T`, `x<T` solved |
| Soft weight must never conflict | 1 | Pass — finite weight 100 solved |
| Adversarial round 2 (dup entries, groups, caps) | 6 | Pass; 1 rejected at build time |
| **Total** | **22** | **0 violations** |

### Subagent verification failures (2026-08-05) — both children

| Child | Claim | Reality | Verified how |
| --- | --- | --- | --- |
| `web/` | `web/components/home/scenario-summary.ts` does not exist | **Exists** — 6.2 KB, 2026-07-23, with `scenario-summary.test.ts` beside it | direct `ls` |
| `core/` | hard `preferredNumPeople` upper bound at `preference_types.py:189-190` | **`:196`**. `:189-193` is the `>=` / `==` pair | read the file |
| both | — | both reported **`tool_uses: 0`** | task metadata |

**What the corrected line proves:** `preferredNumPeople` **is** a hard upper bound → **check 2
(min > max) is sound**; and a bare requirement is exact `==` → **it forbids over-staffing**. The
misleading part is the comment above `:196` reading *"Add soft constraint for preferred number of
people if specified"* — only the following `diff` objective term is soft.

### Critique-round history across the chain

| Artifact | Round | Blocking findings | Outcome |
| --- | --- | --- | --- |
| AI core flows | 1 | 5 | 2 already closed by user decision; 3 fixed. **Artifact is an empty 74-byte stub on disk** |
| AI core flows | 2 | 6 | 3 resolved / 3 created new problems / 4 reworded / 9 unaddressed. **Artifact is a 102-byte stub** |
| Tier-1 tech plan | 1 | 2 | Central claim broken (wrong helper family); perf measured & upheld. **20.7 KB artifact intact** |
| Tier-1 tech plan | 2 | 3 | All in the published contract; fixed in *types*, not prose. **24.7 KB artifact intact** |
| Tier-1 **tickets** | 1 | — | **NEVER SYNTHESISED.** Interrupted mid-write; 2 concrete findings salvaged and applied |

### Performance budget — measured at reference scale (~87 people × 31 days)

| Operation | Cost |
| --- | --- |
| `buildScenarioResolutionContext` | **0.108 ms** |
| `resolvePeople("ALL")` | **3.5 µs** |
| 181 cards × one resolution triple | **0.95 ms** |
| Naive per-check re-resolution | **5.7 ms** |
| Naive per-cell request scan | **9.7 ms** |
| Naive total | **≈ 15.4 ms** — consumes the entire 16 ms frame |

**The budget holds only under a resolve-once invariant.** The tech plan did not originally state it;
critique round 1 found it. Any implementation that re-resolves per check blows the frame.

### Artifact durability audit (2026-08-05)

| Path | Size | mtime | Verdict |
| --- | --- | --- | --- |
| `tier-1-feasibility-checks/index.md` | 6.7 KB | Jul 28 20:03 | intact |
| `tier-1-feasibility-checks/tech-plan/index.md` | 28.0 KB / **443 lines** | Jul 29 12:19 | intact |
| `tech-plan/critique/index.md` | 20.7 KB | **Aug 4 07:43** | intact (mtime = room re-hydrate) |
| `tech-plan/critique-2/index.md` | 24.7 KB | Jul 29 12:19 | intact |
| `tickets/index.md` + 9 tickets | 3.1 KB + ~2.5 KB each | Jul 29 12:19 → edited today | intact |
| `ai-assistant/decisions/index.md` | 13.8 KB, D30 present | Jul 28 20:03 | intact |
| `ai-assistant/reviews/core-flows-critique/index.md` | **74 B** | Jul 28 07:11 | **EMPTY STUB** |
| `ai-assistant/reviews/core-flows-critique-2/index.md` | **102 B** | Jul 28 07:11 | **EMPTY STUB** |
| `ai-assistant/reviews/index.md` | **38 B** | Jul 28 05:30 | **EMPTY STUB** |

Root cause of the seq-2 revert (unchanged, still the standing risk): Traycer stores artifacts in CRDT
**rooms** (`seeds/artifact-room-*.bin`) and **hydrates them onto disk at host start**. Filesystem edits
are durable only if ingested before the next host restart. `host.log` showed two hydrate clusters =
two restarts; `artifactCount: 659`.

### Commits on `main` since seq 2 (all by other sessions, all 2026-08-05 unless noted)

| Hash | Date | Summary |
| --- | --- | --- |
| `ef38955` | 07-27 | `test(core): add reusable CP-SAT oracle harness for the Tier-1 catalogue` — **now merged to main** |
| `0f55a95` | 08-05 | `merge(web): integrate G1 final v2 convergence and close the epic (ii7.18, ii7)` |
| `8202231` | 08-05 | `chore(beads): recover the passive export after the integration race` |
| `224b8eb` | 08-05 | `feat(copy): standardise user-facing copy on UK-English optimisation (wid)` |
| `3fd7f8f` | 08-05 | `test(e2e): bind seeded r1 assertion by uid, not list position` |
| `9db5180` | 08-05 | `close(beads): ii7.10.4 — Rules seed/reload Dexie persistence race` |
| `daa4079` | 08-05 | `test(core): add a 28-day 160-hour SG compliance roster fixture` |
| `1744762` | 08-05 | `test(core): guard the SG compliance roster fixture with a regression test` |
| `b03ddea` | 08-05 | `test(core): add the eight-pattern ward fixture and its compliance guard` |
| `2c92c4d` | 08-05 | `refactor(core): put a senior in charge of each part of the day, not each shift` (HEAD) |

### Per-ticket digest — the trap each ticket names

The tickets live only in Traycer, which has already been proven non-durable. This digest is the
git-durable copy of the parts that are expensive to re-derive. **It is a summary, not a substitute** —
read the ticket artifacts if they are still present.

| Ticket | The trap it names | Why it matters |
| --- | --- | --- |
| **T1** | `shifts[i]` is an **invalid** shift-type inverse — the index space includes `OFF_SID = -1` and `LEAVE_SID = -2` | A naive index reads out of bounds or mis-names the day-states **G3/G4** reason about |
| **T1** | Date ids are **span-compressed**, so an inverse must emit the form current for the *committed* range | Otherwise every deep-link built from a finding points at nothing |
| **T1** | Reuse `lib/cascade/reference-tree.ts` (`RefTree = RefLeaf \| RefTree[]`) for nesting | A second traversal drifts → false positives |
| **T2** | **`uid`, never `index`, in anything published** | An index-based participant makes the *whole* contract index-based; `all` and `groups` inherit it, the panel cannot deep-link, and the carried set becomes persisted indices — which §3 forbids |
| **T2** | Grouping is set **equality**, not overlap | Overlap + transitive closure breaks its own justification (A~B, B~C, but editing A does not clear C) and is monotone the wrong way |
| **T2** | `status` distinguishes *checked* from *unavailable*; there is deliberately **no `not-ready`** | *Setup required* is owned by the shipped `deriveOptimizeReadiness` |
| **T4** | **Coefficients break headcount maths.** `required > staffCount` is **NOT** infeasible | Raw headcount comparison is on the **Rejected** list; checks 4/5 fire only in singleton/unit/explicit-flat-list shapes |
| **T4** | **Staffing and covering are hard at *any* weight** | Unlike requests/successions/counts/affinities — do not treat a finite-weight staffing conflict as soft |
| **T4** | `G6` cannot identify its two sides from `{ person, date }` alone | It names *the same state* at `+inf` and `-inf`; it needs the participant selector |
| **T5** | Check 9 must test the predicate's **satisfiable set**, not raw `0…U` membership | `x <= 2` is satisfiable even when `U = 1` |
| **T5** | G7's premises (coefficients `>= 1`; duplicate entries rejected) are **build-time validations** | The oracle file pins both — **do not duplicate the guards in the detector**; if either is relaxed G7 stops being sound |
| **T5** | Upper-bound predicates (`x <= T`, `x < T`) must **never** fire | Satisfiable at any `T` |
| **T5** | **LEAVE is a fixed input, not a free variable** — unpinned leave is forced to 0 | This is what makes G4 real, and what makes a LEAVE-dominated count unreachable long before the attainable-max bound |
| **T6** | **A forbidden succession forbids the whole conjunction**, not each state it mentions | `require D day1` + `forbid [D,N]` is **feasible** via OFF on day 2. Getting this wrong produces false positives |
| **T6** | Check 20 is the only check that reads `Person.history` — its participant is a **history entry** | The deep-link target is a history position, not a card |
| **T6** | Check 26 is ***sole*-preceptor only** | "No available preceptor" in general is broader than what ships. Coverings have no weight field — always hard |
| **T7** | The health indicator reads **`status` first**, then `groups.length` | An `unavailable` report is not a clean scenario |
| **T7** | **Counts are groups, not findings.** Twelve instances across twelve dates is *one* conflict | Use `groups.length`; `all.length` is never shown to a user |
| **T7** | Submit-time evaluation is a **freshness barrier**, not an independent second opinion | A second opinion could disagree with what the panel just showed |
| **T8** | Typing `12` where `1` is briefly valid must **not** flash a conflict | Inline checking runs only after a **structurally complete edit is committed** |
| **T8** | Consumers subscribe to `byCardUid.get(myUid)`, **not** to the report object | Otherwise one shared evaluation re-renders every screen |
| **T8** | If an inline marker and the panel disagree, that is **a bug, not a UX question** | They read the same report |
| **T9** | Stamp the carried set with **`runGeneration`**; treat a mismatch as not-carried | `resetRun`/`resetRunView`/`resetEphemeral` each clear an **explicit key list**, so a new sibling key would be cleared by *none* of them — scenario A's findings would survive a Load into scenario B |
| **T9** | It is a **carry-forward, not a re-run** — nothing is recomputed on the outcome screen | No second evaluation that could disagree with the panel |
| **T9** | **Cap the carried set** and render a truncated set as explicitly truncated | A truncated list must never read as a complete one |
| **T9** | A replayed conflict is **our** check, offered as the *likely* cause — never the solver's reason | The solver returns `INFEASIBLE` and names nothing. This is what keeps the replay distinct from the prototype's rejected "tightest conflicts" list |

### Behavioral matrix — conflict family × authoring surface (governs T4–T8)

Source: `flows/rule-conflict-validation/behavioral-matrix/index.md`. **Surface-agnostic for replay**: T9
renders each family's existing shared-model card and deep-links to the same targets — no family needs a
distinct post-infeasible presentation, only the framing around the card set changes.

| Family | Home surface | Other participants also marked | Deep-link target(s) |
| --- | --- | --- | --- |
| **Staffing** (1,2,3,4,5,6,8,G5) | Staffing Requirements | Staff / qualified group (4,5 capacity); a Requests **pin** (8, G5) | requirement card(s); request cell |
| **Counts / hours** (9,10,11,12,14,G3,G4,G7) | Shift Counts | a Requests **pin** (14, G4 leave) | count / contracted-hours card; request cell |
| **Requests / pins** (G1,G6) | Requests & Leave matrix | — (both are cells) | the specific person×date **cell(s)** — **both** marked |
| **Successions** (15–21) | Shift Successions | the person's **history** (20); a Requests **pin** (21) | succession card(s); history entry; request cell |
| **Affinities** (22,24) | Affinities | — (**both** affinity cards for 24) | the affinity card(s) |
| **Coverings** (26) | Coverings | the preceptor's hard-zero — a Requests **pin** or qualification | covering card; request cell |

**Three surface roles:** (1) **rule-editor surfaces** host inline markers; (2) **non-rule data surfaces**
(Staff / Shifts / Dates / Groups / history) can create or clear a conflict but get **no per-field red
marker** — re-evaluate, update the global indicator, optionally a one-time dismissible note; (3)
**cross-cutting** — the authoritative pre-optimize panel, the post-infeasible replay, and an always-visible
global health indicator.

**Cross-surface rule:** when participants span two surfaces (staffing rule + request pin), the marker
appears on **both**, sharing one conflict identity, with a back-to-conflicts return path from either.

**Uniform behaviors — defined once in the flow, never re-specified per family:** incomplete field →
ordinary field validation, never a conflict warning · the **panel is authoritative** for the saved-to-submit
revision · stable ordering, "N of M resolved", *this fixed* vs *all fixed*, re-check on commit **without
stealing focus** · always the **Guaranteed-conflict** tier, **fix-first** · neutral "these can't both be
satisfied", grouped by root cause.

**Three empty/error states, per surface:** *Setup required* when prerequisites are unmet (**never** "no
conflicts") · *Checks unavailable* when evaluation errored (**must not** imply a clean scenario) · the
neutral scoped base sentence when nothing was found, with the assistant clause appended **only when AI is
enabled**.

### `7zc` — settled optimize-panel changes, NOT yet implemented

Bead `7zc` is **closed as decided**, but **no code was written**. These are exact, small, and orphaned —
they belong to T9's surface and are the cheapest win adjacent to `s30`:

| Decision | Implementation surface |
| --- | --- |
| **One verb: `Run again`**, submitting the current setup. `Resubmit` **retired** — it promised an exact re-send the code never did, and honouring it needs retention T16q forbids | `run-status-panel.tsx:237` |
| `worker_lost` re-run is **ungated** — retrying identical input is correct there; label only | delete the `workerLost` ternary at `run-status-panel.tsx:167` |
| **No change detection** — accepted residual: an unchanged infeasible re-run burns a run. (User's explicit call: "leave it always primary") | — |
| The **`verdict:` code box is dropped** — `infeasibility_proven` is a hardcoded literal (`runner.py:97`), 1:1 with the heading | delete `run-status-panel.tsx:222-227` |
| **New:** on the *feasible* outcome, surface `user_requested` vs `solver_timeout` in plain language — the only branch where `termination_reason` carries information, and it was never displayed | add a stop-reason line in the success block, ~`run-status-panel.tsx:199` |
| Test updates | `run-status-panel.test.tsx:187` and `:211` |

### Parallel initiatives — state on 2026-08-05

| Initiative | Bead | State | Note |
| --- | --- | --- | --- |
| **Roster viewer** | `cjr` | **Actively building.** `cjr.1.1` (B1 `on_roster` callback) and `cjr.1.2` (B2 roster container) **closed today**; `cjr.1.3` (B3 BFF `/roster` proxy + query client) open and ready | Its deliverables are the uncommitted `core/` files in your tree. Close reason on both: *"integrated locally to main without commit or push"* |
| **AI assistant (Tier 2)** | `t34` | Planning complete, sequenced **behind** `cjr` per DL10-D3 | Index + decision log **D1–D30** + five flows intact; **both critique artifacts are empty stubs** |
| **Tier-2 diagnostician** | `3d4` | `P3`, open, dependency-wired `3d4` → `t34` → `cjr` | **Consumes `s30`'s published conflict model** — T2's contract is cross-initiative, not internal |
| **Elastic re-solve** | `l3m` | `P3`, open, rewritten (was unsat-core) | Serves the AI-off majority; state D2 is their dead end |
| **Oracle backfill** | `cqr` | `P3`, open | The other 27 checks' oracle cases. Explicitly out of scope for T1–T9 |
| **expandDateRange consolidation** | `l0o` | `P3`, open | Five byte-identical copies. Out of scope for T1–T9 |

**AI assistant reversals worth knowing** (they invalidate earlier notes you may find): **D28** made the
turn **exclusive** (scenario read-only during a turn), reversing D23 and dissolving four blocking
findings at once. **D29** dropped pseudonymisation entirely, reversing D16 — which makes **D22 void**:
the Settings copy claiming placeholder substitution must be **removed**, not narrowed.

## Code Analysis

- **`web/lib/scenario/leave-guard/`** — the architectural template T1 promotes. `detector.ts` ("this
  module owns policy"), `resolution.ts` (20 KB), `adapters.ts`, `warning-format.ts`.
  `resolution.ts` exports `Resolution<T> = { resolved: true; values } | { resolved: false }`,
  `TypedMapKey = number | string`, `buildPeopleIndexMap`/`resolvePeopleSelector`,
  `resolveShiftTypeSelector`, `buildDateIndexMap`/`resolveDateSelector`,
  `buildScenarioResolutionContext`, `toTypedKeyRecords`. **Verified free of leave-specific coupling** —
  no `LEAVE_SID`, no count-card shape, **4 call sites**.
- **`resolution.ts`'s two gaps for `s30`** (both are T1 scope): resolvers take **flat selectors only**,
  but successions / affinities / coverings / requirements carry `Nested*RefList` (`Array<T | T[]>`) —
  **~18 of the 28 checks**; and there is **no index→ref inverse** in any domain.
- **T1 trap 1 — `shifts[i]` is an invalid shift-type inverse.** The index space includes reserved
  day-states at `OFF_SID = -1` and `LEAVE_SID = -2`. A naive array index either reads out of bounds or
  mis-names the exact day-states checks **G3 and G4** reason about.
- **T1 trap 2 — date id form.** Ids are span-compressed (`DD` / `MM-DD` / `YYYY-MM-DD`), so the inverse
  must emit the form current for the *committed* range, or every deep-link built from a finding points
  at nothing. Reuse the recursion in `lib/cascade/reference-tree.ts` (`RefTree = RefLeaf | RefTree[]`)
  for nesting — do not write a second traversal.
- **`web/lib/rules/expansion.ts` — DO NOT USE for the detector.** `expandDateRefs` adds unknown tokens
  *"verbatim as a concrete date id"* (fail-open); `expandShiftTypeRefs` silently drops unknowns; both
  `String()`-coerce; neither returns a resolution signal; there is no people resolver.
  **Its header at `:1-15` actively lies**, claiming to be "the SHARED FOUNDATION consumed by ... the
  Tier-1 conflict detector." Fix the comment or the next implementer repeats seq 2's mistake.
- **`web/lib/dates/date-id.ts`** — `generateDateIds` returns span-compressed ids; `generateDateItems`
  returns `{id, iso, description}`. **`expandDateRange`'s canonical replacement is
  `generateDateItems(range).map(i => i.iso)`, NOT `generateDateIds`.** (Bead `l0o`; bead `rf3` tracks
  retiring span-compressed ids entirely.)
- **`web/lib/store/hot-store.ts`** — `runGeneration` is a monotonic counter bumped by **every** reset
  path: `resetRun` (`:125`), `resetRunView` (`:133`), `resetEphemeral` (`:151`), each by exactly 1.
  Built for T16a so "late frames from scenario A's run can never repopulate scenario B's view."
  **T9 stamps the carried finding set with it.**
- **`web/lib/store/scenario-store.ts`** — zundo `temporal`: `limit: 50`, `partialize: pickScenario`,
  `equality: scenarioShallowEqual`. Persist OUTER / temporal INNER. **Each undo entry is a whole-slice
  snapshot.** History is never persisted.
- **`web/lib/optimize/session-transaction.ts`** — key `nurse.optimize.session`. **Provisional** variant
  uses `hasExactKeys`; **active** uses `hasAllowedKeys` and already carries optional `lastCursor`.
  **Does not retain the scenario** — this is why T9 carries findings.
- **`web/lib/scenario/canonical.ts:8,57`** — deliberately strips `uid`: *"neither the projection nor
  this type ever reads a card's `uid`."* Why the detector runs on UI types, and why T2's invariant is
  **`uid`, never `index`, in anything published**.
- **`web/components/home/scenario-summary.ts`** — **exists** (6.2 KB, tested). The narrow-slice
  `Pick<ScenarioUiState, …>` + `useMemo` precedent for subscribing without whole-store reads.
- **`core/nurse_scheduling/preference_types.py`** — `max_x = len(c_ds) * max(coefficients.values())` at
  `:478` is the bound G7 uses. At `:189-193`, `actual_n_people >= requiredNumPeople` when
  `preferredNumPeople` is set, else `== requiredNumPeople`. At **`:196`**,
  `actual_n_people <= preferredNumPeople` — **hard**, despite the comment above it saying "soft".
  Infinity weights with `preferredNumPeople` raise `ValueError`.
- **`core/nurse_scheduling/scheduler.py`** — `offs[(d,p)] + dp_shifts_sum + leaves[(d,p)] == 1`
  unconditionally, in a plain per-day/per-person loop; objective set unconditionally at `:277`; LEAVE
  forced to 0 when unpinned at `:309-314`. **All three underpin G7's soundness** — and note this file
  has uncommitted `cjr` changes right now.
- **`core/nurse_scheduling/server/jobs/runner.py:97`** — `termination_reason="infeasibility_proven"` is
  a **hardcoded literal**. Four values total; only `FEASIBLE` varies (`user_requested` vs
  `solver_timeout`). This is why `7zc` dropped the verdict code box.

## Files Changed

### Source code
- *(none — no application code was written in this thread)*

### Traycer artifacts — edited today
- `artifacts/tier-1-feasibility-checks/tickets/t5-checks-counts-hours/index.md` — corrected the oracle
  reuse note from "24 cases" to **19 parametrized `OracleCase` entries + 5 standalone tests (24 pytest
  results)**, flagged that 3 of the 5 are **premise** tests with no TS counterpart, and pinned the
  verification bullet to "the 19 committed oracle cases".
- `artifacts/tier-1-feasibility-checks/tickets/t2-conflict-model-pipeline/index.md` — resized the shared
  fixture-format bullet: it is **not connective glue**. The committed G7 cases are Python literals, so a
  shared format means designing a serialised representation, porting 19 cases onto it, and writing a
  loader per side. Verification now requires a ported case to prove the port is faithful.

### Traycer artifacts — written 2026-07-29 (chunk A)
- `artifacts/tier-1-feasibility-checks/tickets/index.md` — story artifact: G2/G4 resolution table,
  mermaid dependency graph, nine-ticket table, sequencing rationale, out-of-scope list.
- `artifacts/tier-1-feasibility-checks/tickets/t1…t9/index.md` — nine ticket artifacts.
- `artifacts/tier-1-feasibility-checks/tech-plan/index.md` — revised to **443 lines**.

### Uncommitted in git — NOT THIS THREAD'S WORK (beads `cjr.1.1`/`cjr.1.2`, both closed)
- `core/nurse_scheduling/server/roster_container.py` (**untracked**, ~460 lines) — deterministic roster
  container; the `on_roster` handoff plus XLSX bytes.
- `core/tests/test_roster_container.py`, `core/tests/test_roster_routes.py`,
  `core/tests/test_scheduler_on_roster.py` — **untracked**.
- `core/nurse_scheduling/scheduler.py` (+64), `server/api/optimize.py` (+49),
  `server/jobs/runner.py` (+49/-14), `core/pyproject.toml`, `core/tests/test_runner_termination.py`
  (+155/-8), `docs/T19-upstream-backend-source-manifest.md` (+120).
- `.beads/interactions.jsonl`, `.beads/issues.jsonl` — passive export drift.
- **Total: 8 modified, 4 untracked, +428/-25 on the tracked files.**

## User Feedback & Preferences (REQUIRED)

- **"we want to avoid over-engineering and avoid changing core and backend since we need to pull changes
  from upstream (the old app) form time to time"** — **the single most important standing constraint.**
  It is why every ticket says "any `core/` change" is out of scope, why T1 *promotes an existing module*
  rather than writing a new one, and why the oracle harness was the only `core/` touch in two sessions
  (a test, documented in the T19 manifest).
- **"Critique the ticket breakdown with a fresh agent before starting"** — the third consecutive request
  for adversarial cold review as a gate. He asked for it before ticketing the two-tier decision, before
  the tech plan, twice on the flows, and again here. **Assume any artifact he is about to build from
  wants a fresh-agent pass first.**
- **"what does this mean ?Close G2 and G4 in the plan — the index→ref inverse and an owner for the 28
  message templates"** — he will call out internal shorthand. **Write next-steps so they stand alone.**
- **"Break the s30 tech plan into implementation tickets and let the breakdown resolve both"** — prefers
  moving forward with the gap assigned over another revision round on the same document.
- **"i dont undestand what you are asking"** — on a three-way architecture question framed in jargon
  ("canonical projection", "uid sidecar"). **The codebase had the answer; I should have looked instead of
  asking.** Don't ask the user to adjudicate what a `grep` settles.
- **"Investigate what reverted the artifacts before rewriting anything"** — root cause before redoing
  lost work. Correct call; the cause was systemic (CRDT room hydration).
- **"send them anyway and no disclosure, user is responsible for chossing a llm provider that respects
  privacy"** — D21/D29, deliberate, against recommendation. Descriptions and real IDs go to the LLM
  unmodified, no per-field disclosure.
- **"yes, close session but dont git commit, give me a paste prompt"** — closed seq 2 without committing.
  **He asks explicitly when he wants a commit.** Default is Conservative per `CLAUDE.md`.
- **"lets discuss this ... how do you think we should sequence?"** — wants sequencing arguments made,
  not asserted. Reversed two of my recommendations after the arguments were laid out (turn exclusivity,
  pseudonymisation) — and the turn-exclusivity reversal turned out **better**, dissolving four blocking
  findings at once.
- **"what should i do now to continue building"** — planning fatigue. Two sessions of planning is enough;
  **this thread should produce code.**
- **"we will continue the agentic workflow in another thread"** (today) — hence this handoff.

## Where We're Going

1. **Decide the quick-paint question, then start T1.** Either re-run the ticket critique (it never
   synthesised) or accept the breakdown as-is. The one substantive input it cannot supply is the missing
   `plans/tier1-conflict-detector/index.md` critique finding — resolve that first (step 2). If you skip
   the re-critique, say so explicitly; the breakdown has had **zero** adversarial review.
2. **Settle "committed-only re-evaluation breaks on quick-paint"** — the finding from the lost plan.
   Read `commitPaintGesture` in the Requests matrix and check whether a paint gesture stages in the hot
   store and commits once at pointer-up. **If it does, committed-only evaluation is fine and the finding
   is void — write that down so a fourth handoff stops carrying it.** If it commits per cell, T2's
   re-evaluation scheduling needs a debounce the plan does not specify.
3. **T1 — `tickets/t1-shared-resolution/`.** Promote `leave-guard/resolution.ts` to
   `web/lib/scenario/resolution/`, add nested-ref support via `reference-tree.ts`, add the three
   index→ref inverses. Acceptance: **leave-guard's existing tests pass unchanged** (this is a move, not a
   redesign), round-trip `ref → index → ref` identity including `OFF`/`LEAVE` and numeric-vs-string ids
   (`1` and `"1"` must not collapse), and `{ resolved: false }` still propagates.
4. **T3 in parallel** — the 28 templates depend only on the catalogue. Start with the ~5 hardest
   messages (coefficient maths, LEAVE semantics, forced successions) and test them on a real scheduler
   before writing the other 23 to a pattern that may not survive contact.
5. **Then T2** (model + pipeline + G1 + fixture format — note the resized fixture scope), then T4–T6 in
   parallel, then T7 → T8, with T9 after T2/T3.
6. **Housekeeping, cheap and worth doing:** `bd update nursing-sheduler-s30` to say **28** checks and to
   retract the checks-7/13 line in the DESCRIPTION; file a bead for the misleading `expansion.ts:1-15`
   header; decide whether `s30` gets child beads mirroring T1–T9 (as `cjr` has).
7. **Do not touch the uncommitted `core/` roster work.** It is `cjr.1.1`/`cjr.1.2`, closed, awaiting
   that workflow's own commit.

## Risks & Blockers

- **🔴 The ticket breakdown has had NO adversarial review.** Every prior artifact in this initiative got
  one or two rounds; the tickets got a critique that died one message before writing its synthesis. Two
  concrete findings were salvaged; whatever else it had is in a 448 KB JSONL and nowhere else.
- **🔴 A dirty working tree that is not yours.** 12 files of `cjr` roster work sit uncommitted on `main`
  because `cjr.1.1`/`cjr.1.2` were "integrated locally to main without commit or push." **Any `git add
  -A` from the next thread mis-attributes another workflow's deliverable.** Stage by path only.
- **🟠 `plans/tier1-conflict-detector/index.md` is missing for the third handoff running**, and its
  critique finding has never been applied. Either resolve it or void it in writing.
- **🟠 Traycer artifacts are not durable on disk.** They are a projection of CRDT rooms, rewritten on
  host restart. The AI-assistant critique artifacts are already empty stubs — proof the failure mode is
  real and silent. **Beads are canonical**; mirror any load-bearing decision into `bd` immediately.
- **🟠 Test baselines are stale.** Seq 2's `core` numbers (600 passed / 51 skipped) predate four `core`
  commits and the uncommitted roster work. **Re-baseline before trusting any regression signal** — and
  note `python3` on PATH has no pytest; use the pinned interpreter.
- **`web` has not been run in this thread at all** — no vitest, no playwright, no `verdict`.
- **`lib/rules/expansion.ts:1-15` still actively misleads.** It cost seq 2 a whole tech-plan draft.
- **Traycer child-agent creation fails** (`sender agent ... is not local to host`), so codex routing per
  the agent-selection guide is unavailable; use built-in `Agent` subagents.
- **Subagents have returned confidently wrong file facts with `tool_uses: 0`.** Verify before
  propagating.

## Open Questions

- **Does the quick-paint critique still apply?** Needs `commitPaintGesture` read against committed-only
  re-evaluation. Highest-value unknown before T1.
- **Re-run the ticket critique, or start coding?** The breakdown is the only unreviewed artifact in the
  stack, but two sessions of planning have produced no code.
- **Should `s30` get child beads for T1–T9?** Open since seq 2. `cjr` has 8; `s30` has 0.
- **Is `l3m` (keyless elastic/slack re-solve) worth doing before Tier-2?** It serves the AI-off
  majority — exactly the users Tier-1 exists for — and state D2 is their dead end.
- **Who commits the `cjr` roster work?** It is closed in `bd` but uncommitted in git.

## Quick Start for Next Session

```bash
# Restore context
cd /Users/kenan.xin/Work/nursing-sheduler
bd show nursing-sheduler-s30      # Tier-1 — note: says 27 checks, it is 28
bd ready | head -15

# Confirm the clean baseline seq 3 left behind
git branch --show-current         # main
git log origin/main..main         # expect EMPTY
git status -s                     # expect 12 files of cjr roster work — NOT YOURS

# Planning artifacts (canonical for s30; verify against bead notes if they look thin)
A=/Users/kenan.xin/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts
cat $A/tier-1-feasibility-checks/tickets/index.md            # start here
cat $A/tier-1-feasibility-checks/tickets/t1-shared-resolution/index.md
cat $A/tier-1-feasibility-checks/tech-plan/index.md          # 443 lines
cat $A/app-prototype-fidelity-audit/flows/rule-conflict-validation/verified-conflict-catalogue/index.md

# Key files to read first (then explore adjacent — this list is not exhaustive)
#   web/lib/scenario/leave-guard/resolution.ts     <- T1 promotes this
#   web/lib/scenario/leave-guard/detector.ts       <- the policy-module shape to mirror
#   web/lib/cascade/reference-tree.ts              <- reuse this recursion for nesting
#   web/lib/dates/date-id.ts                       <- span-compressed id trap
#   web/lib/store/hot-store.ts                     <- runGeneration, :125/:133/:151
#   core/tests/test_catalogue_oracle_g7.py         <- the 19 reusable fixtures

# Re-baseline before trusting any regression signal (PATH python3 has no pytest)
cd core && <pinned-python> -m pytest -q

# The dead critique's raw research, if you want it (448 KB JSONL, no synthesis)
#   /private/tmp/claude-502/-Users-kenan-xin-Work-nursing-sheduler/7533389e-d466-4e8c-b6a3-baef23f72029/tasks/a8eb80fd3f391741e.output

# NEXT ACTION
#   Answer the quick-paint question (read commitPaintGesture in the Requests matrix),
#   write the answer down, then start T1: promote leave-guard/resolution.ts to
#   web/lib/scenario/resolution/ with leave-guard's tests passing unchanged.
```

## Session Closed

**Closed at:** 2026-08-05
**Commit:** none — closed **without** committing, per the Conservative agent profile in `CLAUDE.md`
("do not run git commits… unless explicitly asked") and because the working tree holds another
workflow's deliverables.
**Session status:** Handed off to next session

**Uncommitted state the next session inherits:** 8 modified + 4 untracked `core/` files belonging to
closed beads `cjr.1.1` / `cjr.1.2` (roster container + `on_roster` callback), whose close reason reads
*"integrated locally to main without commit or push."* Plus `.beads/*.jsonl` export drift. **Nothing in
this tree was produced by this session** — the only edits made here were to Traycer artifacts (T2, T5)
and this handoff file. Stage by path; never `git add -A`.
