---
title: "Cold review — C2 accuracy-audit correction (2026-07-23)"
kind: review
---

# Verdict

The correction's central disposition is sound: C2's 418-line legacy endpoint body
describes a `serve.py`/`jobs.py` API absent from both repositories, while the
shipped API is the snake_case durable API. Deferring a full contract rewrite and
leaving its tracking line open is appropriate. Two documentation-consistency
issues remain.

## Findings

### P2 — The audit still calls the overturned C2 block retained history

`spec-accuracy-audit-2026-07-21/index.md:27` says C2's job-response block is
"retained history", and `:57` retains it in the list of "correct as-is" cases.
That directly conflicts with the immediately following overturn at `:59` and the
deferred-material disposition at `:120`. A reader following the systemic-cause
or recommendation sections can still conclude that C2 only needs fencing.

**Fix:** replace the C2 clause in `:27` and remove C2 from `:57`; refer to the
2026-07-23 re-verification instead. Also change the recommendation at `:64`
(`C3/C2 (minor)`) and heading at `:104` ("minor-drift") so they do not classify
C2 as minor.

### P3 — “Only internal deltas” is too broad without a scope qualifier

The seven `server/api/optimize.py` route decorators match exactly across the
repositories (old `:105,141,147,194,200,206,215`; rebuild
`:105,152,184,248,254,260,269`), and `api/sse.py` is byte-identical. But the
sources are not wire-identical in every respect: `api/optimize.py` is +70/-27
lines, `schemas.py` +7/-5, `jobs/models.py` +29/-0, and `app.py` +66/-24 in the
rebuild; for example the rebuild restricts solver submission and adds cursor
errors. The correction is accurate if “identical endpoints” means path/method/
declared status; it must not imply full behavioral parity.

**Fix:** say “the seven optimize routes have identical path/method/declared
status; the implementations differ in documented rebuild-specific protocol and
solver behavior” rather than “only internal deltas.”

### P3 — “Code-first `{code,message}` errors” needs a boundary

The durable application/store failures are structured (`server/app.py:250-267`),
but ordinary malformed submissions still use FastAPI `HTTPException` detail
responses (`server/api/optimize.py:66-80,126-134`) and request-schema validation
is deliberately passed through at `server/app.py:275-285`. The correction must
not promise one envelope for every error.

**Fix:** qualify this as “application/job errors are code-first; submission and
request-schema validation retain FastAPI detail responses.”

## Verified evidence

- Both `serve.py` files are 29 lines and call `create_app()` at line 23; neither
repository has `core/nurse_scheduling/jobs.py`.
- Rebuild `JobResponse` has exactly `id`, `state`, `terminal`, `queue_position`,
`created_at`, `started_at`, `finished_at`, `request`, `result`, `error`,
`controls`, and `links` (`core/nurse_scheduling/server/api/schemas.py:86-112`).
- The frontend consumes that shape and names only `job.*` events
(`web/lib/bff/types.ts:40-90`); it explicitly describes Finish now as replacing
the removed client heartbeat (`web/lib/query/optimize.ts:203-215`).
- C2's legacy body is explicitly incompatible: binding language at
`contracts/c2-http-serve-api/index.md:95-101`; camelCase response at `:281-331`;
`complete`/`error` SSE at `:346-364`; heartbeat watchdog at `:451-460`.
Its first 91 lines already label that body historical, so the correction should
distinguish the stale legacy body from the whole C2 artifact.
