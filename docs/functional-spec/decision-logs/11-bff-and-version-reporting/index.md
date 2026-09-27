---
title: "DL11 — BFF Supersedes DL07 + Narrow DL06 Version-Reporting Adaptation"
kind: spec
---

# DL11 — BFF Supersession of DL07 + Version-Reporting Adaptation

Two governance-level decisions settled during the rebuild tech-plan + its
critique (2026-07-16). Both touch prior decision logs, so they are recorded here
for traceability. Full technical context:
[rebuild-tech-plan](../../../rebuild-tech-plan/index.md).

## D1 — Backend URL: DL07 superseded by a same-origin BFF

**Decision.** The frontend no longer calls the backend browser-direct via
`NEXT_PUBLIC_BACKEND_API_URL`. Instead, Next.js acts as a **same-origin BFF/proxy**:
the browser calls `/api/*` on the Next origin; Next forwards server-side to a
**private `BACKEND_API_URL`** inside the Docker network. `NEXT_PUBLIC_BACKEND_API_URL`
is **retired**.

**This supersedes [DL07](../07-backend-url-via-env/index.md)** (not merely refines
it): the settled mechanism changes from a browser-visible **build-time** URL to a
private **runtime** server-side URL, which also changes the threat boundary and
deployment topology.

**What is preserved from DL07's intent:** no server-management UI; the UI shows
only a **read-only online/offline + version status**, now sourced via an
`/api/health` passthrough.

**Why.** C2 constrains browser-direct access hard — a CORS allow-list
(`localhost` / `*.nursescheduling.org` only), an HttpOnly credentialed cookie, and
cross-origin SSE. A same-origin BFF dissolves the *browser* CORS problem and keeps
provider secrets server-side. (It does not dissolve C2 itself — the BFF owes an
explicit per-endpoint translation contract; see the tech-plan §3.)

**Consequences to specify (in the tech-plan, not here):** dev/non-Compose default
URL, allowed URL schemes, startup validation, and that runtime container
reconfiguration (not rebuild) now sets the URL.

## D2 — Version reporting: narrow DL06 adaptation (git removed)

**Decision.** The rebuild abandons the upstream `j3soon/nurse-scheduling` repo and
**does not use git** for versioning. `serve.py`'s version function is modified to
source `appVersion` from an **`APP_VERSION` environment variable**, falling back to
a **bundled `VERSION` file**, then `"v0.0.0-unknown"` — replacing
`git describe --tags`.

- A single **`VERSION` file at the monorepo root** is the source of truth.
- A build wrapper (Makefile/CI) reads and validates `VERSION` once and feeds it to
**both** images as `build.args.APP_VERSION` (a Dockerfile `ARG` cannot default from
a build-context file), so backend and frontend are **stamped from the same value** —
which is what makes the FR-OE-29 version-mismatch check meaningful. See tech-plan §2.

**Scope of the change against [DL06](../06-rebaseline-to-shipped-backend/index.md):**
this is a **narrow, recorded adaptation** — **version reporting only**. It does
**not** change data shapes, validation, exact error strings, the API contract, the
YAML schema, constraint semantics, or the solver. The backend remains binding in
every other respect. The git dependency (and the old Dockerfile's `git describe`
dirty-check) is removed.

**Why an adaptation is unavoidable:** `serve.py` computes `appVersion` *only* via
`git describe`; with no git and no `.git` in the vendored image it would always
return `v0.0.0-unknown`, making the FR-OE-29 mismatch surface non-functional. A
`VERSION`/build-arg alone is inert unless `serve.py` reads it — hence the source
change.

## Cross-references

- Supersedes DL07; adapts DL06 (version reporting only).
- Critique findings resolved: #7 (version), #10 (DL07 supersession) —
[rebuild-tech-plan/critique](../../../rebuild-tech-plan/critique/index.md).
