# Deploy runbook — nurse-scheduler

Topology (ingress): **Cloudflare named tunnel → `web` (Next.js) → `backend` (FastAPI)**.
Only `web` is published to the host; `backend` is internal to the compose network
and reachable exclusively through the Next BFF (`/api/*`). See tech-plan §2 and
DL11 D1.

```
browser ──▶ cloudflared (named tunnel) ──▶ web:3000 ──▶ backend:8000
                                            (published)   (internal only)
```

## Prerequisites

- Docker + Docker Compose v2.
- A **named** Cloudflare tunnel (quick `trycloudflare.com` tunnels do **not**
  support SSE, which the optimize stream needs — T16).
- Root `VERSION` file present and non-empty (single source of truth for the
  version stamp).

## One-time setup

```bash
cp docker/.env.example docker/.env      # then fill in the values
```

`docker/.env` (git-ignored):

| Var | Meaning |
| --- | --- |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token for the named tunnel (Zero Trust → Networks → Tunnels). |
| `PUBLIC_ORIGIN` | Trusted public scheme+host driving the cookie `Secure` rule (consumed by T06). Prod: `https://<host>`; local HTTP: `http://localhost:3000`. |

### Cloudflare named-tunnel origin (dashboard side)

The tunnel's **public-hostname origin must point at `http://web:3000`** (not the
old `backend:8000`). This mapping lives in the Cloudflare dashboard / tunnel
config, **not** in this repo. A token-only `tunnel run` does not by itself prove
the origin was changed — verify it after deploy.

## Build & run

```bash
make build      # reads+validates VERSION once, stamps BOTH images (APP_VERSION)
make up         # docker compose up -d (backend, web, cloudflared)
make down
make logs
```

`make build` **fails loudly** if `VERSION` is missing/empty — there is no silent
`v0.0.0-dev` fallback. The version is fed to both images as the
`APP_VERSION` build arg; a Dockerfile `ARG` cannot read the build-context
`VERSION` file, so the build wrapper feeds it in.

- **web**: `APP_VERSION` → `NEXT_PUBLIC_APP_VERSION` **before** `pnpm build`
  (compiled into the client bundle; a runtime env cannot change a built bundle).
- **backend**: `APP_VERSION` → runtime `ENV` + bundled `VERSION` file, read by
  `serve.py` (replaces the removed `git describe`, DL11 D2).

Result: `NEXT_PUBLIC_APP_VERSION` (client) and `/api/health.appVersion` (backend)
are stamped from the **same** value, so the FR-OE-29 mismatch check is meaningful.

## Non-streaming deploy gates

Run them all reproducibly (no `docker/.env` needed — this path does not start
cloudflared):

```bash
make verify-deploy      # docker/verify-deploy.sh — exits non-zero on any failure
```

It builds+starts backend+web and asserts each gate, then tears down:

| Gate | Assertion |
| --- | --- |
| health passthrough | `/api/health` returns backend JSON incl. `appVersion` |
| version equality | backend `appVersion` == stamped `VERSION` == `NEXT_PUBLIC_APP_VERSION` in the client bundle (raw stamped values) |
| backend internal-only | backend has **no** host port mapping |
| non-root | web and backend both run as **uid 1000** |
| solver isolation | backend CMD retains `--workers 1` |
| deliberate mismatch | a web image stamped differently makes the equality assertion **fail** as expected |

Manual spot-checks (equivalent to the script's assertions):

```bash
curl -fsS http://localhost:3000/api/health              # → {... "appVersion":"<ver>"}
docker ps --format '{{.Names}}\t{{.Ports}}'             # backend: 8000/tcp, no 0.0.0.0: mapping
docker exec docker-web-1 id; docker exec docker-backend-1 id   # uid=1000 both
```

> **Version comparison note.** The home-page badge renders `v<ver>` — the leading
> `v` is presentational. Equality is on the **raw stamped values**: the client
> `NEXT_PUBLIC_APP_VERSION` and `/api/health.appVersion` are both `<ver>` (no `v`).

The **production named-tunnel streaming smoke test** (SSE first-byte, keepalive,
disconnect closes upstream) is **T16**, not this runbook.

## Backend image is a lean production runtime (app package only)

The runtime image ships **only** the app package — `Dockerfile.backend` does a
selective `COPY core/nurse_scheduling/ ./nurse_scheduling/`, so `core/tests/` and
the vendored caches never enter the image (`ls /app/core` → `nurse_scheduling`,
`requirements.txt`). The app runs from source via uvicorn (no `pip install .`), and
`serve.py` reads its version from `APP_VERSION` → `/app/VERSION` (not from
`pyproject.toml`/metadata), so no test tree or project metadata is needed at
runtime.

The authoritative backend gate (§6 item 1: `pytest` + `ruff` on `core/`) runs on
the **host / CI**, where the full **334**-test suite is green and ruff is clean.
If an in-image test run is ever wanted, add a **dedicated test stage** that COPYs
`core/tests/` + the root `prototype/` fixtures — do not add them to the runtime
stage.

## Local development (outside Docker)

```bash
cd web
pnpm install     # Node 24 (.nvmrc); pnpm pinned via package.json packageManager
pnpm dev         # BACKEND_API_URL defaults to http://localhost:8000
```

The pnpm version is pinned by the **`packageManager`** field in `web/package.json`
(corepack enforces it — the package-manager analogue of `.nvmrc`). Node is pinned
via `web/.nvmrc` + `engines`.

> On a fresh `pnpm install`, pnpm may note skipped build scripts for `sharp` /
> `lefthook`; this is expected — they are declared under `allowBuilds` in
> `web/pnpm-workspace.yaml` (sharp uses prebuilt binaries; lefthook's binary ships
> via platform packages), so nothing needs to build.

## Git hooks (lefthook + beads)

`beads` owns `core.hooksPath` (`.beads/hooks`), so lefthook cannot install its own
hook. Instead, `.beads/hooks/pre-commit` invokes lefthook **after** the
beads-managed section (both run). Lefthook runs `oxlint` + `oxfmt --check` on
staged `web/` code files (config: repo-root `lefthook.yml`); markdown / sql / json
are never linted or format-checked. If beads ever regenerates its hook, re-append
the lefthook block (it lives outside beads' markers, so this should not happen on
a normal beads update).
