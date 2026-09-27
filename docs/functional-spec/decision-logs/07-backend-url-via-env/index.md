---
title: "07 — Backend URL via env config; multi-server selector removed"
kind: spec
---

# Decision 07 — Backend URL via environment config

Supersedes the **server-management** portion of spec 10 (*Optimize & Export*).
Framed in the [Backend-URL-via-env epic brief](../../../backend-url-via-env-brief/index.md).

## Settled decisions

1. **The backend URL is supplied by environment config**, not chosen in the UI.
 A single `NEXT_PUBLIC_BACKEND_API_URL` (build-time, default
 `http://localhost:8000`) replaces the hardcoded candidate list
 (`serverSelection.ts` `BACKEND_API_CANDIDATES`).
2. **The multi-server selector UI is removed** — the server list, add / edit /
 remove URL, **Check all**, **Reset**, the **Auto** row, the localStorage
 persistence of servers, and the auto-select + offline-fallback logic.
3. **A single-URL status indicator is kept** — the "Server: Online/Offline"
 badge and the API/Frontend/Backend version line, computed from one health
 check against the configured URL.
4. **This reduces the rebuild's parity contract.** Server-management is no longer
 a capability the rebuild must reproduce. Spec 10 FR-OE-01..29 (backend
 selection / health-management surface) is superseded; the design handover and
 behavior catalog drop the capability.
5. **Applied immediately in the current branch** (`feature/genie`). For this
 change, by explicit user direction, the standing "freeze the current app / no
 spec edits during design" ground rule is overridden.

## What stays binding

- The HTTP API contract itself (C2) is **unchanged** — job submission, SSE
progress, cancel/finish-now, xlsx download, DELETE, status semantics.
- The health/version response shape (`status`, `version`, `apiVersion`,
`appVersion`) still backs the status indicator.
- Run options (Prettify / Anonymize / Timeout) and the whole live-result / export
flow are untouched.

## Out of scope

- Runtime (post-build) backend switching — `NEXT_PUBLIC_` is fixed per build.
- Multi-backend / multi-tenant selection.
- Any change to the Python backend or the HTTP API.
