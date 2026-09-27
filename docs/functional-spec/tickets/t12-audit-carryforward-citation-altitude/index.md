---
title: "Carry-forward from accuracy audits: strip old-app citations in minor-fixed sections + fold 06-4 numeric-ids into the 01 rewrite"
kind: ticket
status: 0
---

# Audit carry-forward — citation/altitude strip + 06-4 into 01

**Source:** [spec-accuracy-audit-2026-07-21](../../spec-accuracy-audit-2026-07-21/index.md),
[spec-accuracy-audit-remaining-2026-07-22](../../spec-accuracy-audit-remaining-2026-07-22/index.md),
and the 2026-07-22 cold review of the minor-drift corrections.

**Why this exists:** the minor-drift sections (06, 10, 11, 12, C2, C3) received
*targeted behavioral corrections* (fix-spec, grounded in DL06 + shipped `web/`
code). Those corrections are accurate, but each section **still carries old-app**
**implementation citations** — `web-frontend/src/...`, `useSchedulingData.ts`,
`schedulingReferenceUpdates.ts`, `page.tsx:nnn`, `serve.py`/`jobs.py` line refs —
plus a few stale helper names. That directly violates the story index's altitude
rule (*"Do not cite implementation files, functions, or line numbers"*) and is the
same three-way-layering the audits said must be resolved **before any section moves**
**to `/docs`**. This ticket makes that residual explicit so it is not lost.

**Beads mirror:** `nursing-sheduler-76u.1` (child of `nursing-sheduler-76u`, the minor-drift resolution parent). Artifact is source of truth; the bead mirrors it.

**Disposition:** NOT a behavioral fix and NOT blocking. Each item is resolved when
its section is rewritten at the settled 08 altitude (behavior + contracts, no code
citations, Given/When/Then) and/or at the `/docs` move. 06-4 is a genuine content
correction owned by the **01** data-model rewrite.

## 06-4 — numeric ids (content correction, owned by the 01 rewrite)

Not mere citation drift. Spec 06 still asserts **"all references are bare strings"**
(FR-RI-01/04/13 and the "Group IDs share the reference namespace … bare strings"
edge bullet). Shipped reality: `PersonId = number | string`; references may be
numeric; the rename-collision check uses **exact identity**, so `1` and `"1"` are
distinct and never falsely collide (T18; verified `web/lib/cascade/domain.ts`,
`reference-tree.ts`). The **01** material rewrite must state the numeric-or-string
identity model, and spec 06 must be updated to say references may be numeric (drop
the bare-strings absolute). Cross-cuts spec 01 finding 01-4.

## Citation / altitude residuals per section (strip at rewrite / `/docs`)

| Section | Residual to strip or correct |
| --- | --- |
| **06** | FR-RI-01..15, "Cross-References," and "Source files" cite `schedulingReferenceUpdates.ts` / `useSchedulingData.ts` / `referenceIds.ts` / `web-frontend/src/...`. Shipped equivalents: `renameEntity` / `deleteEntity` in `web/lib/cascade/`. Describe behavior only. |
| **10** | FR-OE-54/68 and the error table still use camelCase job fields (`xlsxReady`, …) and `page.tsx:nnn` refs, while the (corrected) C2 cross-ref is snake_case — align the rest. Bare `restorePeopleIdsInXlsx.ts` → drop the code ref (behavior stated in the corrected FR-OE-69). |
| **11** | FR-CV-19 names `summarizeIds`; shipped helper is `summarizeRefs` (`web/components/coverings/covering-card-list.tsx`). Field label "Shift types" vs the artifact's "Shift Types:". Strip `page.tsx:nnn` refs throughout. |
| **12** | `page.tsx` / `useSchedulingData.ts` refs; keep the corrected `LEAVE_CREDIT_HALF_HOURS = 16` fact. |
| **C2** | **Materially superseded — not "minor" (re-verified 2026-07-23).** C2 documents an obsolete camelCase `serve.py`+`jobs.py` backend (`jobId`/`status`/`xlsxReady`, client heartbeat, `X-Schedule-*` headers, SSE `complete`/`error`) that exists in **neither** the old app (`nurse-scheduling`) nor the rebuild (`nursing-sheduler`). The real shipped backend is the modern upstream FastAPI at `core/nurse_scheduling/server/api/` — native to the old app and vendored near-verbatim into the rebuild (identical **seven route declarations** — path/method/status — with rebuild-specific behavioral deltas: an event-cursor SSE model, CP-SAT-only submission, and an added `/health`; `sse.py` byte-identical, snake_case `JobResponse`: `id`/`state`/`terminal`/`result.outcome`/`controls`/`links`, `job.*` SSE, no heartbeat, code-first `{code,message}` errors **for application/job failures** — malformed input still returns FastAPI `detail`/`RequestValidationError`). The frontend already codes against it (`web/lib/bff/types.ts`, `web/lib/query/optimize.ts`). Needs a **full rewrite against `server/api/`**, not a fence-the-historical-block edit — deferred to the T19-aligned `/docs` material pass. |
| **C3** | Stale backend line refs (`scheduler.py`, `jobs.py`, `constants.py`); the catalog completeness caveat is already added. Strip refs at rewrite. |

## C2 re-verification (2026-07-23) — supersedes the "2 minor" line

The 2026-07-21 audit scored C2 *0 material · 2 minor · 7/9 refuted, "largely*
*accurate"* — resting on the adversarial refuters treating C2's job-response block
as **deliberately retained historical**. Re-verification against shipped code
overturns that:

- C2 declares itself the **binding** contract (*"the Python backend is NOT being*
*rebuilt … the frontend MUST call this API exactly as documented"*), yet the
backend it documents (`serve.py`+`jobs.py`, camelCase) is gone from both repos —
`jobs.py` is deleted and `serve.py` is a thin `create_app()` shim in each
(29 lines, ~6 functional).
- The shipped contract is the snake_case `core/nurse_scheduling/server/api/`
backend, **vendored near-verbatim** from the old app into the rebuild
(**the seven route declarations are identical** — path/method/status;
`api/sse.py` byte-identical). The deltas are mostly internal — e.g.
`solver_capabilities.solver_supports_finish_now` → `jobs.models.solver_supports_stop`,
a refined `cancellable` derivation, and added `canonical.py`/`event_cursor.py`/
`workspace.py`/`scheduling_input.py` — but not purely cosmetic: the rebuild adds
an event-cursor SSE model, CP-SAT-only submission, and a `/health` route, so this
is near-verbatim in *shape*, not full behavioral/wire identity.
- So there are **no "2 minor findings"** to pin. C2 is materially superseded and
needs a full rewrite against `server/api/` (the contract already captured in
`web/lib/bff/types.ts`). Folded into the T19-aligned material/`/docs` rewrite;
**not** closed as "fixed."
