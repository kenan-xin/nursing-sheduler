# Deploy runbook — nurse-scheduler

Private base topology plus exactly one ingress overlay (tech-plan §3, DL11 D1).
The base runs three **private** services — `web` (Next.js BFF), `backend`
(FastAPI) and `redis` — with **no host-published port**. An overlay chooses how the
outside world reaches `web`; `backend` and `redis` are never published.

```
                 ┌─ direct overlay ──▶ 127.0.0.1:3000 ─┐
browser ─────────┤                                      ├─▶ web:3000 ─▶ backend:8000 ─▶ redis:6379
                 └─ cloudflare overlay ─▶ cloudflared ──┘        (private)     (private)     (private)
```

Reachability is enforced by **segmented networks**, not convention. The only
permitted service edges are `cloudflared→web` (`ingress`), `web→backend` (`app`)
and `backend→redis` (`data`). cloudflared cannot reach `backend` or `redis`; `web`
cannot reach `redis`. A dashboard route mistake or a connector compromise is
therefore contained to `web:3000`.

> **Startup order ≠ runtime routing.** `depends_on: service_healthy` only orders
> container startup. Compose does **not** re-route or drop traffic when a
> dependency later becomes unhealthy. When Redis fails, `backend` `/ready` and
> `/health` return a bounded **503** (fail closed), but `web`/`cloudflared` keep
> running and can still forward to the backend. The runtime guarantee that
> business requests are not forwarded to an unready backend is a **BFF
> readiness check owned by the revised T06 ticket**, not this Compose topology.

- `make up` → base + `compose.direct.yml`: publishes **only** `web` at
  `${WEB_BIND_ADDRESS:-127.0.0.1}:${WEB_PORT:-3000}`. Needs `PUBLIC_ORIGIN`; needs
  **no** Cloudflare credential.
- `make up-cloudflare` → base + `compose.cloudflare.yml`: adds **only**
  `cloudflared` and publishes nothing. Needs an **HTTPS** `PUBLIC_ORIGIN` and the
  tunnel token secret.

## Prerequisites

- Docker + Docker Compose v2.
- Root `VERSION` file present and non-empty (single source of truth for the
  version stamp).
- For Cloudflare mode: a **named** Cloudflare tunnel (quick `trycloudflare.com`
  tunnels do **not** support SSE, which the optimize stream needs — T16).

## One-time setup

```bash
cp docker/.env.example docker/.env      # then fill in the values
```

`docker/.env` (git-ignored):

| Var | Meaning |
| --- | --- |
| `PUBLIC_ORIGIN` | Trusted public scheme+host driving the cookie `Secure` rule (T06). Direct: `http://localhost:3000`; Cloudflare: `https://<host>`. |
| `WEB_BIND_ADDRESS` | Direct overlay bind. `127.0.0.1` (default, loopback only) or `0.0.0.0` (LAN — configure your firewall deliberately). |
| `WEB_PORT` | Direct overlay host port (default `3000`). |

### Cloudflare tunnel token (secret file, not env)

The named-tunnel token is consumed from a **Docker secret file**, so it never
lands in `docker inspect`'s env. Create it before `make up-cloudflare`:

```bash
mkdir -p docker/secrets && chmod 700 docker/secrets
printf '%s' '<your-named-tunnel-token>' > docker/secrets/cloudflare-tunnel-token
chmod 600 docker/secrets/cloudflare-tunnel-token
```

`docker/secrets/` is git-ignored. The overlay mounts the file as a Docker secret
and cloudflared reads it via `--token-file`, so the token never lands in
`docker inspect`. Full Cloudflare setup (domain, tunnel, published route,
firewall, rotation) lives in `docs/production-deployment-cloudflare.md`.

### Cloudflare named-tunnel origin (dashboard side)

The tunnel's **public-hostname origin must point at `http://web:3000`**. This
mapping lives in the Cloudflare dashboard / tunnel config, **not** in this repo. A
token-only `tunnel run` does not by itself prove the origin was changed — verify it
after deploy.

## Build & run

```bash
make build            # reads+validates VERSION once, stamps BOTH images (APP_VERSION)

make up               # base + direct overlay (publishes web only)
make down
make logs

make up-cloudflare    # base + cloudflare overlay (adds cloudflared)
make down-cloudflare
make logs-cloudflare
```

`make build` **fails loudly** if `VERSION` is missing/empty — there is no silent
`v0.0.0-dev` fallback. The version is fed to both images as the `APP_VERSION` build
arg; a Dockerfile `ARG` cannot read the build-context `VERSION` file, so the build
wrapper feeds it in.

- **web**: `APP_VERSION` → `NEXT_PUBLIC_APP_VERSION` **before** `pnpm build`
  (compiled into the client bundle; a runtime env cannot change a built bundle).
- **backend**: `APP_VERSION` → runtime `ENV` + bundled `VERSION` file, read by
  `serve.py` (replaces the removed `git describe`, DL11 D2).

Result: `NEXT_PUBLIC_APP_VERSION` (client) and `/api/health.appVersion` (backend)
are stamped from the **same** value, so the version mismatch check is meaningful.

`make up` guards `PUBLIC_ORIGIN` (non-empty). `make up-cloudflare` additionally
requires it to be **HTTPS** and requires the tunnel secret file to be non-empty.

## Redis job store

The backend runs with `JOB_BACKEND=redis`, `JOB_REDIS_URL=redis://redis:6379/0`
and a versioned key prefix (`JOB_REDIS_KEY_PREFIX=nurse_scheduling:jobs:v0` — bump
the trailing schema version on any incompatible job-record change). Redis is
pinned by digest (`redis:8.8.0-alpine@sha256:9d317178…`), persists to the named
`redis-data` volume with default RDB snapshots, and answers a `redis-cli ping`
healthcheck. The backend `depends_on` a **healthy** Redis, exposes `/ready`
(fail-closed when Redis/worker/maintenance is down) as its healthcheck, and runs
**one** Uvicorn worker initially. Jobs are temporary computation state — a snapshot
lost to an abrupt crash is acceptable; AOF/managed Redis is deferred (tech-plan §2).

## Supervised optimization execution

Each claimed optimization runs in **one spawned, process-tree-supervised child**,
not in the worker thread. The lease-owning worker is the only Redis/JobStore
client; the child only computes.

```
backend (uvicorn, 1 worker) ─ lease-owning worker ─▶ spawned executor child ─▶ CP-SAT + descendants
        │  events/results/failures/cancellations (worker-ID + observed-deadline fenced)
        ▼
      Redis JobStore
```

- **CP-SAT only.** The only accepted solver is `ortools/cp-sat`. The browser sends
  no solver field, and the backend accepts only a missing/default or exact
  `ortools/cp-sat` selector before a job is created. This is a deliberate product
  boundary: upstream now exposes a multi-solver selector and PuLP, but the rebuild
  does **not** import them. See `docs/T19-upstream-backend-source-manifest.md`
  (U31 section).
- **Timeout grace.** The solver gets its requested native timeout. A watchdog is
  armed from child launch through terminal delivery and force-terminates the child
  tree after `timeout + OPTIMIZE_TIMEOUT_GRACE_SECONDS` (default **90s**, positive
  and finite). A native feasible timeout completes as `result.outcome="feasible"`
  with `result.termination_reason="solver_timeout"`. A forced watchdog kill fails
  the job with `error.code="process_timeout"` and no artifact.
- **Cancel (forced).** Cancelling a running job is server-enforced: it kills the
  child tree when needed, **discards** any buffered result/artifact, and settles as
  `cancelled`.
- **Finish now (cooperative).** Finish-now asks CP-SAT to return its current
  feasible incumbent, which completes with `termination_reason="user_requested"`.
  If no incumbent exists yet, it still produces a structured failure — never a
  guaranteed roster.
- **Worker shutdown / lease loss ≠ cancellation.** On ordinary shutdown or a lost
  claim, the worker aborts the child and **writes nothing**; the maintenance loop
  later owns the `worker_lost` transition after the lease expires. Every event,
  result, failure, and cancellation commit carries the worker identity and passes
  the owner/revision/observed-deadline lease fence (T19).
- Retained legacy jobs may still report `limit_or_stop`; clients accept it during
  the retention window. Running execution is still not checkpointed or
  auto-restarted.

`OPTIMIZE_TIMEOUT_GRACE_SECONDS` is read by the backend at startup
(`server/config.py`) and defaults to 90s. The base `compose.yml` forwards
`${OPTIMIZE_TIMEOUT_GRACE_SECONDS:-90}` to the backend, so it needs no setup; to
change the grace for a deployment, set it in `docker/.env` (see `.env.example`).
The private one-worker topology is unchanged.

## Non-streaming deploy gates

Run them all reproducibly (no `docker/.env` needed — this path does not start
cloudflared and passes its own throwaway `PUBLIC_ORIGIN`; all checks run over the
internal network so it publishes no host port and cannot clash with other stacks):

```bash
make verify-deploy      # docker/verify-deploy.sh — exits non-zero on any failure
```

It builds+starts the **private base** and asserts each gate, then tears down
(including the throwaway Redis volume):

| Gate | Assertion |
| --- | --- |
| origin matrix | `docker/validate_origin.py` accepts/rejects the exact-origin fixture set for direct + Cloudflare modes |
| base privacy | `web`, `backend`, `redis` all have **no** host port |
| network segmentation | only `ingress→web`, `app(web)→backend`, `data(backend)→redis` reach; `web✗redis`, `ingress✗backend`, `ingress✗redis` |
| redis health / non-root | `redis-cli ping` → PONG; redis process runs non-root |
| backend readiness | `/ready` reports `ready` |
| web health | `/api/health` returns backend JSON incl. `appVersion` |
| version equality | backend `appVersion` == stamped `VERSION` == `NEXT_PUBLIC_APP_VERSION` in the client bundle |
| non-root | web and backend both run as **uid 1000** |
| one worker | backend CMD retains `--workers 1` |
| restart persistence | a queued job survives a **backend** restart and a **redis container replacement** — the container ID changes, the named volume reattaches, and the job survives |
| replay | `Last-Event-ID` reconnect replays only events **after** the cursor |
| worker loss | a **SIGKILLed** claim-holding worker becomes retained `worker_lost` (test-only 3s lease) |
| redis outage (fail closed) | with Redis stopped, backend `/ready` + `/health` return **503** and the BFF `/api/health` returns a bounded 502/503 (not a hang or 2xx) |
| deliberate mismatch | a web image stamped differently makes the equality assertion **fail** as expected |

The persistence, replay and worker-loss gates run `docker/deploy_gate_driver.py`
inside a throwaway backend-image container against the private Redis, under its own
`GATE_PREFIX` namespace, so they never touch the live backend's job keys. The
network-segmentation gate probes TCP reachability from throwaway containers pinned
to each individual network. Cleanup removes this run's PID-scoped web/backend
images (pinned Redis/cloudflared images are shared and kept).

The `redis outage` gate proves only that the stack **fails closed with a bounded
response** — it does **not** prove business requests stop reaching the backend.
That runtime-readiness gating is the revised **T06 BFF** ticket's responsibility.

The **production named-tunnel streaming smoke test** (SSE first-byte, keepalive,
disconnect closes upstream) is **T16**, not this runbook.

## Public diagnostic (opt-in profile)

The one-shot public diagnostic (`nurse_scheduling.server.diagnostic`) exercises a
running deployment through **one configured API contract** — the private backend
paths internally, or the same-origin BFF `/api/*` paths for a public deployment
(see `DIAGNOSTIC_API_PATH_MODE` below): it samples `/info`, submits the real
87-person scenario, proves cross-request job visibility, measures running
concurrency against the expected value, drives queue transitions
(cancel + finish-now), and cleans up every job it created. It writes a timestamped
JSON report and exits `0` (pass), `1` (definite failure), or `2` (inconclusive).

It is wired into the **base topology as a `diagnostic` Compose profile**, so it
**never** starts with `make up`, `make up-cloudflare`, or `make verify-deploy` —
only an explicit `--profile diagnostic` (i.e. `make diagnostic`) runs it. The
service is a bounded one-shot (`restart: "no"`), publishes **no host port**, and
joins **only the `app` network**, so — exactly like `web` — it can reach `backend`
but **not** `redis` (segmentation is preserved).

```bash
make diagnostic          # Redis-backed backend (default) — starts backend+redis, runs once
make diagnostic-memory   # memory-backed backend (compose.memory.yml overlay)
make diagnostic-report   # copy JSON reports from the named volume to docker/diagnostic-reports/
make down                # tear down the backend/redis the diagnostic started
```

By default it diagnoses the **internal** `backend` on the **private backend
contract** (`DIAGNOSTIC_TARGET_URL` defaults to `http://backend:8000`,
`DIAGNOSTIC_API_PATH_MODE=backend`, i.e. unprefixed `/info` + `/optimize/**`).

A public/direct/Cloudflare deployment publishes **only** the same-origin `web` BFF,
whose routes live under `/api/*` (there is no public backend). To diagnose a real
external deployment, point at its absolute public origin (no path/credentials),
**select the BFF contract with `DIAGNOSTIC_API_PATH_MODE=bff`**, and skip starting
the local backend:

```bash
DIAGNOSTIC_TARGET_URL=https://your-host DIAGNOSTIC_API_PATH_MODE=bff \
  make diagnostic EXTRA_ARGS=--no-deps
```

Every request — `/info`, submit, poll, SSE events, cancel, finish-now, and the
cleanup delete — is then routed through one path builder under the selected prefix,
so no endpoint is special-cased and the two contracts never mix.

Knobs (compose defaults, overridable via `docker/.env` or inline env):

| Var | Default | Meaning |
| --- | --- | --- |
| `DIAGNOSTIC_TARGET_URL` | `http://backend:8000` | Absolute origin to diagnose |
| `DIAGNOSTIC_API_PATH_MODE` | `backend` | `backend` (private, unprefixed) or `bff` (public same-origin `/api/*`) |
| `DIAGNOSTIC_EXPECTED_CONCURRENCY` | `1` | Expected running jobs (one-worker deployment) |
| `DIAGNOSTIC_MAX_JOBS` | `8` | Submission upper bound (rebuild pending capacity) |
| `DIAGNOSTIC_INFO_SAMPLES` | `100` | `/info` samples over fresh connections |
| `DIAGNOSTIC_WORKFLOW_TIMEOUT_SECONDS` | `600` | Overall workflow bound |
| `DIAGNOSTIC_JOB_TIMEOUT_SECONDS` | `3600` | Per-job solver timeout (== backend max) |

### Reports (named volume + extraction)

Reports persist to the project-scoped `diagnostic-reports` **named volume**. It
survives `docker compose down` but is removed by `down -v`. The image prepares
`/reports` for its non-root user, so a normal run needs no `--user` override;
`make diagnostic-report` uses the host user only to write the bind-mounted
destination and copies reports out to `docker/diagnostic-reports/` (git-ignored).

### Interpreting results

Results are **observational**. Different app versions, deployment IDs, job backends,
or job store IDs behind one URL are configuration failures; cross-request job
visibility is the definitive shared-store check. Public routing and unrelated users
can hide instances or make capacity/timing checks inconclusive without proving a
defect. A memory store uses the process instance ID; a Redis store persists a UUID,
so equal IDs are evidence, not proof, of sharing.

### Deviations from upstream

- **No Git clone.** Upstream's diagnostic ran from an image that `git clone`d the
  `dev` branch. `Dockerfile.diagnostic` builds from **local vendored source** with a
  selective copy (app package + the single scenario asset), like `Dockerfile.backend`.
  It is **version-stamped identically** to the backend — `APP_VERSION` build arg →
  `ENV` + `/app/VERSION` (root `VERSION`), so `get_app_version()` reports the deployed
  version with no Git at build or runtime. `make diagnostic-version-check` gates this.
- **Base profile, not bundled public topology.** Upstream bundled the diagnostic with
  its public API + Cloudflare topology and defaulted the target to its public host.
  Here it is an opt-in profile on the private base, defaulting to the internal
  backend; the base + direct/Cloudflare overlays are untouched.
- **`expected_concurrency` 1 (upstream 3), `max_jobs` 8 (upstream 128)** — matched to
  the one-worker deployment and `JOB_MAX_PENDING=8`.
- **`/info` + retained `/health`.** Upstream replaced `/health` with `/ready`/`/info`
  in its Docker healthchecks. The rebuild's healthchecks keep `/ready` (backend) and
  `/api/health` (web) unchanged; `/info` coverage is provided by the diagnostic and
  by core U30a tests, with `/health` retained for compatibility.
- **No public API healthcheck script.** Upstream's `test_public_healthcheck.sh`
  probes a **public** `/ready`; it does not apply because the rebuild **never**
  publishes the backend — only `web` is public (via the direct/Cloudflare overlay).
  The public surface is the `web` BFF's `/api/health`, already covered by
  `make verify-deploy` and the manual T16 streaming smoke.

## Backend image is a lean production runtime (app package only)

The runtime image ships **only** the app package — `Dockerfile.backend` does a
selective `COPY core/nurse_scheduling/ ./nurse_scheduling/`, so `core/tests/` and
the vendored caches never enter the image (`ls /app/core` → `nurse_scheduling`,
`requirements.txt`). The app runs from source via uvicorn (no `pip install .`), and
`serve.py` reads its version from `APP_VERSION` → `/app/VERSION` (not from
`pyproject.toml`/metadata), so no test tree or project metadata is needed at
runtime. `deploy_gate_driver.py` therefore imports only `nurse_scheduling.server`.

The authoritative backend gate (§6 item 1: `pytest` + `ruff` on `core/`) runs on
the **host / CI**. If an in-image test run is ever wanted, add a **dedicated test
stage** that COPYs `core/tests/` + the root `prototype/` fixtures — do not add them
to the runtime stage.

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
