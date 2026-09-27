---
title: "Spec Accuracy Audit — load-bearing sections vs shipped code (2026-07-21)"
kind: review
---

# Spec Accuracy Audit — load-bearing sections

**Purpose:** verify the functional spec matches the *shipped* code (DL06: shipped app is the contract) before moving the spec into `/docs`. Six load-bearing units audited.

**Method:** one fact-finding agent per unit reported candidate drift with @line evidence; each finding was then independently re-checked by an adversarial agent instructed to *refute* it. Only findings that survived land below. 43 agents, ~2.58M tokens. **37 candidate findings → 27 confirmed, 10 refuted.**

## Verdicts (corrected by the adversarial pass)

| Unit | Verify verdict | Confirmed | Real state | Action |
| --- | --- | --- | --- | --- |
| **08 Save-Load & YAML** | material-drift | 7 material · 4 minor | **Describes the pre-rebuild app.** Wrong YAML schema, dead file/function names, obsolete `alert()` strings | **Near-rewrite from `web/`** |
| **10 Optimize & Export** | material-drift | 3 material · 3 minor | Durable-protocol core is accurate; two behaviors inverted + stale C2 cross-ref | Targeted fixes |
| **12 Contracted Hours / Leave** | material-drift | 1 material · 1 minor | *Effectively minor* — operative reqs are correct; one wrong constant name/value in the narrative | Constant rename |
| **C1 YAML Schema** | material-drift | 2 material · 1 minor | Not drift so much as **TARGET-vs-shipped labeling** (DL09/WT1 pending) confusing readers | Relabel/split target text |
| **C2 HTTP Serve API** | ~~material-drift · 0 material · 2 minor · "largely accurate" · 7/9 refuted~~ **OVERTURNED 2026-07-23** | material-drift | **superseded** | **See Resolution status below.** Re-verification overturned this row: C2 is **materially superseded** by the current `server/api/` backend, not "2 minor." Full rewrite deferred. |
| **C3 Constraint Semantics** | minor-drift | 1 material · 2 minor | Mostly accurate; one over-claim + stale line refs | Minor fixes |

## The systemic cause

The confirmed drift isn't random. Section 08 cites `app/save-and-load/page.tsx`, `yamlGenerator.ts`, `useSchedulingData.ts` — files that exist only in the **old `web-frontend/` prototype**, not the rebuilt `web/`. The spec was largely written against the *pre-rebuild* app and never re-grounded after the rebuild. Expect the same pattern in the unaudited sections (01–07, 09, 11, C4, C5, behavior catalog).

Compounding it: each section interleaves three kinds of text — **binding** (current), **retained historical/parity** (old app, deliberately kept), and **TARGET/pending** (DL09/WT1 not yet shipped). That layering is unmarked enough that even the audit agents misclassified it — which is why 10 findings were initially refuted (e.g. FR-OE-53 is explicitly marked superseded). **Note (2026-07-23):** the C2 refutations here were later **overturned** — C2's job-response block is *binding* contract text, not retained history; C2 is materially superseded. See the Resolution status table. **Before any section moves to `/docs`, this three-way layering must be resolved** — strip or clearly fence the historical/target text so the doc states only what ships.

## Confirmed material findings

### 08 Save-Load & YAML — describes the old app

- **08-1** Emitted YAML is **Workspace V1** (`workspaceVersion` first, keeps disabled records + `guidedRules`), not the `apiVersion…appVersion` scenario schema the whole section + Appendix specify. `web/lib/scenario/workspace.ts:139-156`.
- **08-2** Serializer is the `yaml` npm lib (`stringify`, `{version:"1.2"}`) over a Zod-validated doc — **not** the js-yaml `CustomDump`/`isLeafArray`/`!format` mechanism the spec details. `web/lib/scenario/serialize.ts:8`.
- **08-3** Download filenames are static `scenario.yaml` / `scenario-anonymised.yaml` (no `nurse-scheduling` prefix, no date), blob type `text/yaml` not `application/x-yaml`.
- **08-5** Version gate is a React `ConfirmDialog` modal, not `window.confirm()`; `getVersionWarning` and the "Do you want to continue…" strings don't exist. Only the 3-case classification survives.
- **08-6** Load **always** confirms replacement into a non-empty workspace (DL12) — spec implies confirm only on version mismatch.
- **08-7** Upload/import/anonymise feedback moved from `alert()` to sonner toasts + inline issues list; the V2–V5/V19 alert strings are gone.
- **08-8** Whole import-normalization section (FR-SL-21…31: `loadFromYaml`, `convertIdsToString`, `useSchedulingData.ts`) describes functions that no longer exist; import runs through `importScenarioValue` + canonical projection + Zod.

### 10 Optimize & Export

- **10-1** Post-download DELETE is **not** fire-and-forget — it's an awaited, gating cleanup with retry/abandon/confirmation that blocks the next run. `use-optimize-terminal.ts:219-266`.
- **10-2** ID restoration **fails closed** (throws on any non-string/unmapped cell or layout mismatch), not the spec's "leave unmapped cells as-is". `restore-people-ids-in-xlsx.ts`.
- **10-3** C2 cross-reference still lists removed camelCase job fields (`xlsxReady`, `clientHeartbeatExpired`, …) and old SSE names; wire contract is snake_case. `web/lib/bff/types.ts:40-91`.

### 12 · C1 · C3

- **12-1** Spec names a nonexistent constant `LEAVE_CREDIT_MINUTES = 480`; shipped is `LEAVE_CREDIT_HALF_HOURS = 16`. *(Adversarial nuance: the spec's operative coefficient reqs already say 16, so downstream behavior isn't wrong — only the narrative names the wrong symbol/value.)*
- **C1-1 / C1-2** `hoursContract` marker and several sections are labeled **TARGET (DL09/WT1)** but read as shipped; must be fenced as pending, not current.
- **C3-1** "full validation error catalog with exact messages" is claimed complete but isn't — the shipped catalog has entries the spec omits.

*(Minor confirmed findings — copy-timeout 1500 vs 2000 ms, toggle labels missing "people", heading "Current state · YAML", filename fallback `${jobId}.xlsx`, reworded backend-unavailable string, `>3600` timeout rejection, `git describe` appVersion detail, `parse_sids` line refs — are recorded in the raw audit output.)*

## Refuted (do NOT act on — these are correct as-is)

08-11, 10-5, ~~C2-1…7 (overturned 2026-07-23 — see note below)~~, C3-2. Mostly cases where the spec's *retained historical* or *sibling-artifact-covered* text (FR-SL-02b, DL12, FR-OE-53-superseded) was mistaken for drift. **C2 was the exception** — its refutations were overturned: the job-response block is *binding* contract text, not retained historical.

<user_quoted_section>C2-1…7 overturned (2026-07-23): the refutations rested on treating C2's job-response block as "retained historical," but C2 declares itself the binding contract and documents a backend that no longer exists in either repo. C2 is materially superseded by the current server/api/ backend — see the Resolution status table.</user_quoted_section>

## Recommendation

1. **Do not move any section to `/docs` yet.** 08, 10, 12 need correction first; the historical/target layering needs resolving spec-wide.
2. **Fix order:** 08 (rewrite from `web/`) → 10 (targeted) → 12 (rename constant) → C1 (fence TARGET text) → C3 (minor). **C2 is *not* minor** — materially superseded (re-verified 2026-07-23); full rewrite deferred to the `/docs` pass, tracked in T12.
3. **Audit the remaining sections** (01–07, 09, 11, C4, C5, behavior catalog) — same old-app-drift pattern is likely.
4. Corrections route through Traycer (`revise-requirements`) so decision logs stay consistent, *then* publish the corrected section to `/docs`.

## Post-audit correction (2026-07-21): Guided Rules load semantics

A claim made during review — that a legacy load leaves the Rules screen empty — was **wrong**. Corrected against `web/components/guided-rules/` (`registry.ts`, `builtins.ts`):

- **The Rules screen is a live *projection* of the constraint library, not a curated catalog.** `projectGuidedRules` emits one rule row per constraint card of all five kinds (requirements, successions, counts, affinities, coverings), plus the built-in structural rows from `projectBuiltinRules` (today just the locked "At most one shift per day"). Every constraint that exists shows as a rule.
- **`GuidedRulePin` is an optional cosmetic *overlay*, not a gate.** When present it overrides one row's category / title / quick-fields; its absence never hides the row.
- **Legacy import (no `workspaceVersion`) sets `guidedRulePins: []`** — so the Rules screen still fully populates from the imported constraints; only custom pin *overlays* aren't restored. Old files never had overlays, so nothing is lost. **Workspace V1 import** additionally restores the `guidedRules` overlays.

**Implications for the rewrite:**

- **08 (load section)** must state: an imported scenario/legacy file fully populates the Rules screen (rules derive from the constraints); pin overlays are restored only from Workspace V1's `guidedRules`.
- **Coverage gap:** the Guided Rules projection model (constraints → rules; pins as overlays; built-ins) is documented in **no** functional-spec section — it was built under tech-plan T14. The rewrite should add a short Guided-Rules behavior note/section, not just patch 08.

## Revised 08 rewrite plan (post-critique, 2026-07-22)

The rewrite plan was cold-critiqued (`rewrite-plan-critique-2026-07-22`). Verdict: revision required. The altitude direction (behavior + contracts, no code citations) was confirmed correct (G3). All findings have been folded into the revised plan below.

### Critique closures

| Finding | Resolution |
| --- | --- |
| **B1** C1 stale as legacy authority | 08 becomes self-contained for both Workspace V1 + legacy/scenario format contracts. C1 cross-ref demoted to "see also"; C1 staleness tracked as a separate accuracy-audit follow-up. |
| **B2** Dual-format load hides different gates | 08 gains a dispatch matrix: discriminator × accepted state × blocking conditions × warning channel × restored metadata. |
| **B3** 07/08 Guided Rules split has no ownership | 07 owns projection invariants; 08 owns load mapping (legacy → no pins, full rule projection; Workspace → validated pins restored). Cross-link via stable requirement IDs. |
| **D1** "Always emits Workspace V1" exception | Scoped to user-authored backup actions (Download, Copy, Edit-preview, anonymised Download). Sample loader is a deliberately-generated strict fixture. Export gate = duplicate workspace IDs, not solver readiness. |
| **D2** Replacement/version/history as prose | Replaced with a decision table: workspace state (empty/non-empty) × version (match/non-match/missing/dirty), with undoable-replacement and backup-freshness postconditions. |
| **D3** Drop-list risks dropping observable import outcomes | New outcomes-only legacy-import subsection: canonicalization that succeeds, advanced syntax preserved with non-blocking warnings (categories named), blocking structural failures, no-state-change-on-reject. Includes corrected 08-9 (preceptors DO get warning). |
| **D4** Serializer outsourced entirely | Wire invariants kept in 08: YAML 1.2, no-alias, deterministic document order, one trailing newline, value-preserving parse by Python contract. Decision log linked for rationale. Byte-identical/leaf-array/tag-machinery claims retired. |
| **G1** Cross-refs need local summaries | 08 owns a one-line summary of each referenced rule (backup freshness, uncredited-LEAVE fence, start-over) so /docs readers don't need Traycer-local paths. |
| **G2** Audit closure demonstrability | Audit-closure checklist appended to the draft: one destination requirement per finding 08-1..12. 08-11 treated as "retain sibling ownership + link." |
| **G3** Altitude needs acceptance evidence | Each removed code anchor replaced with a Given/When/Then contract. Minimum: Workspace Download→Load losslessness; legacy load no-pin-but-full-rule projection; replacement cancellation; anonymised export preserving metadata while never mutating live state. |

### User decision (2026-07-22)

Make 08 self-contained for both formats now; revise C1 separately later.

## Resolution status — targeted fixes (2026-07-22; C2 re-classified **material** 2026-07-23)

*Beads mirror: `nursing-sheduler-76u` (in-progress); carry-forward residuals in child `nursing-sheduler-76u.1`. Artifact is source of truth.*

Direction confirmed with the user: **fix-spec** for all, grounded in DL06 (shipped
**backend** is the contract; **UI is free**) + verification against shipped `web/`
code. The audits' "shipped **app** is the contract" phrasing over-generalized DL06;
corrected here.

| Finding | Status | Correction |
| --- | --- | --- |
| 10-1 post-download DELETE (fire-and-forget → awaited/gating) | ✅ done | FR-OE-72 + AC-OE-22 now state the awaited, retry/abandon cleanup phase that gates the next run (verified via `cleanupPhase`/`onRetryCleanup`/`onAbandonCleanup`). |
| 10-2 ID restore (leave-as-is → fail-closed) | ✅ done | FR-OE-69, restore edge bullet, AC-OE-23 now state `XlsxRestorationError` fail-closed (verified `web/lib/optimize/restore-people-ids-in-xlsx.ts`). |
| 10-3 C2 cross-ref camelCase → snake_case | ✅ done | Section 10's C2 job-response cross-ref rewritten to the snake_case wire shape. |
| 12-1 `LEAVE_CREDIT_MINUTES=480` → `LEAVE_CREDIT_HALF_HOURS=16` | ✅ done | All occurrences corrected — body (FR-CH-02/13/40, AC-CH-05) and the fence `<user_quoted_section>` (per user sign-off 2026-07-22) — verified `web/components/counts/half-hour-codec.ts`. (The DEFERRED `leaveTypes.creditMinutes: 480` in FR-CH-40 is the never-built backend field and stays as-is.) |
| C3-1 "full" validation-error catalog over-claim | ✅ done | Scope bullet now states the catalog is a documented load-bearing subset, not exhaustive. C3 stale line-refs left for the `/docs` rewrite. |
| C2 — **materially superseded** (was "2 minor") | ⏸ deferred · re-verified 2026-07-23 | **Correction:** there are no "2 minor" findings. The *0 material · 2 minor · 7/9 refuted* verdict rested on the refuters treating C2's binding job-response block as "retained historical." Re-verification: C2 documents an obsolete camelCase `serve.py`+`jobs.py` backend (`jobId`/`xlsxReady`, heartbeat, `X-Schedule-*` headers) that exists in **neither** the old app nor the rebuild (`jobs.py` deleted; `serve.py` is a shim in both). The shipped backend is the modern snake_case `core/nurse_scheduling/server/api/` FastAPI — vendored near-verbatim (**seven route declarations identical** — path/method/status; `sse.py` byte-identical; with rebuild-specific behavioral deltas — event-cursor SSE, CP-SAT-only submission, added `/health`) and already consumed by `web/lib/bff/types.ts`. Needs a **full rewrite against `server/api/`**, deferred to the T19-aligned `/docs` pass; tracked in [tickets/T12](../tickets/t12-audit-carryforward-citation-altitude/index.md). |

Deferred citation/altitude residuals for 10/12/C2/C3 (and 06-4 → the 01 rewrite) are
carried forward in [tickets/T12](../tickets/t12-audit-carryforward-citation-altitude/index.md).
